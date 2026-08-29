"""Evidence-anchored zettelkasten persistence.

Atomic notes (Markdown bodies) optionally anchored to a PDF annotation, typed
note-to-note links, and a cache of computed links (shared evidence / semantic /
contradiction). The SQLite database is the source of truth; every mutation also
writes a real ``.md`` file on disk (YAML frontmatter + body) so the notes folder
interop with Obsidian. External edits made in Obsidian are ingested on the next
launch via :func:`reconcile_zettel_disk` (last-writer-wins on conflict).

Module-level functions, ``with get_connection() as conn:`` — see
``app/repositories/core.py`` and ``app/repositories/projects.py``.
"""

from __future__ import annotations

import json
import logging
import re
import unicodedata
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import yaml

from app.config import config
from app.repositories.core import get_connection

logger = logging.getLogger(__name__)

# ── Constants ───────────────────────────────────────────────────────────────

NOTES_COLLECTION_NAME = "tarcite_notes"

ALLOWED_LINK_TYPES = {
    "supports",
    "contradicts",
    "extends",
    "refines",
    "questions",
    "exemplifies",
}

# Computed-link origins → the link_type written into zettel_links alongside them.
COMPUTED_ORIGIN_TO_TYPE = {
    "shared_evidence": "supports",
    "shared_theme": "extends",
    "semantic": "extends",
    "contradiction": "contradicts",
}

PATCHABLE_NOTE_FIELDS = {
    "title",
    "body_md",
    "anchor_annotation_id",
    "anchor_item_key",
    "anchor_page_index",
    "anchor_quote",
    "tags_json",
    "aliases_json",
}


# ── Slug + disk helpers ─────────────────────────────────────────────────────


def _slugify(text: str, max_len: int = 60) -> str:
    """Filesystem-safe slug for a note title (ASCII, dashed)."""
    text = unicodedata.normalize("NFKD", text or "")
    text = text.encode("ascii", "ignore").decode("ascii")
    text = re.sub(r"[^\w\s-]", "", text).strip().lower()
    text = re.sub(r"[-\s_]+", "-", text)
    text = text.strip("-")
    return (text or "untitled")[:max_len] or "untitled"


def _notes_dir() -> Path:
    """The on-disk notes directory, created on demand."""
    path = Path(config.notes_dir)
    path.mkdir(parents=True, exist_ok=True)
    return path


def _note_file_path(note_id: int, title: str) -> str:
    """Relative path (from NOTES_DIR) for a note's ``.md`` file."""
    return f"{_slugify(title)}-{note_id}.md"


def _abs_note_path(file_path: str) -> Path:
    return _notes_dir() / file_path


def _frontmatter(doc: Dict[str, Any]) -> str:
    """Render YAML frontmatter for a note (Obsidian-friendly)."""
    meta: Dict[str, Any] = {
        "note_id": doc["note_id"],
        "title": doc.get("title") or "Untitled",
        "aliases": _loads_list(doc.get("aliases_json")),
        "tags": _loads_list(doc.get("tags_json")),
    }
    if doc.get("anchor_annotation_id"):
        meta["anchor_annotation_id"] = doc["anchor_annotation_id"]
    if doc.get("anchor_item_key"):
        meta["anchor_item_key"] = doc["anchor_item_key"]
    if doc.get("anchor_page_index") is not None:
        meta["anchor_page_index"] = doc["anchor_page_index"]
    if doc.get("anchor_quote"):
        meta["anchor_quote"] = doc["anchor_quote"]
    return yaml.safe_dump(meta, sort_keys=False, allow_unicode=True, width=1000)


def _sync_note_to_disk(doc: Dict[str, Any]) -> None:
    """Write (or overwrite) the ``.md`` file for a note from its DB row."""
    try:
        file_path = doc.get("file_path") or _note_file_path(
            doc["note_id"], doc.get("title") or "Untitled"
        )
        content = f"---\n{_frontmatter(doc)}---\n\n{doc.get('body_md') or ''}\n"
        _abs_note_path(file_path).write_text(content, encoding="utf-8")
    except OSError as exc:
        logger.warning("Could not sync note %s to disk: %s", doc.get("note_id"), exc)


def _parse_md_file(path: Path) -> Optional[Dict[str, Any]]:
    """Parse a ``.md`` file's YAML frontmatter + body. Returns None on failure."""
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return None
    if not raw.startswith("---"):
        # No frontmatter: treat the whole file as a body with a title from the
        # filename.
        title = path.stem
        return {"title": title, "body_md": raw.strip(), "tags": [], "aliases": []}

    parts = raw.split("---", 2)
    if len(parts) < 3:
        return None
    try:
        meta = yaml.safe_load(parts[1]) or {}
    except yaml.YAMLError:
        meta = {}
    body = parts[2].lstrip("\n")
    return {
        "title": str(meta.get("title") or path.stem),
        "body_md": body,
        "tags": list(meta.get("tags") or []),
        "aliases": list(meta.get("aliases") or []),
        "anchor_annotation_id": meta.get("anchor_annotation_id"),
        "anchor_item_key": meta.get("anchor_item_key"),
        "anchor_page_index": meta.get("anchor_page_index"),
        "anchor_quote": meta.get("anchor_quote") or "",
    }


def _loads_list(raw: Any) -> List[str]:
    if isinstance(raw, list):
        return [str(x) for x in raw]
    if isinstance(raw, str) and raw:
        try:
            parsed = json.loads(raw)
            return [str(x) for x in parsed] if isinstance(parsed, list) else []
        except (json.JSONDecodeError, TypeError):
            return []
    return []


def _coerce_list(val: Any) -> List[str]:
    """Normalise a tags/aliases value from the API into a list of strings.

    Accepts a list, a JSON-encoded string (``'["a","b"]'``), or ``None``.
    Used by ``create_note``/``patch_note`` so the frontend may send either a
    list or a JSON string without being double-encoded on storage.
    """
    if isinstance(val, list):
        return [str(x) for x in val]
    if isinstance(val, str) and val:
        try:
            parsed = json.loads(val)
            return [str(x) for x in parsed] if isinstance(parsed, list) else []
        except (json.JSONDecodeError, TypeError):
            return []
    return []


# ── Anchor resolution ────────────────────────────────────────────────────────


def _resolve_anchor(conn, annotation_id: Optional[int]) -> Optional[Dict[str, Any]]:
    """Denormalise anchor fields from the annotations table so the evidence
    panel survives later annotation deletion. Returns None if not found."""
    if not annotation_id:
        return None
    row = conn.execute(
        "SELECT annotation_id, item_key, page_index, quote FROM annotations WHERE annotation_id = ?",
        (annotation_id,),
    ).fetchone()
    if not row:
        return None
    return dict(row)


def _apply_anchor(note: Dict[str, Any], conn) -> None:
    """If an anchor_annotation_id is set, fill the denormalised anchor fields."""
    ann_id = note.get("anchor_annotation_id")
    if ann_id:
        anchor = _resolve_anchor(conn, ann_id)
        if anchor:
            note["anchor_item_key"] = anchor["item_key"]
            note["anchor_page_index"] = anchor["page_index"]
            note["anchor_quote"] = anchor["quote"] or ""
        # If the annotation is missing we keep whatever the caller supplied.


# ── Note CRUD ───────────────────────────────────────────────────────────────


def create_note(data: Dict[str, Any]) -> int:
    title = (data.get("title") or "Untitled").strip() or "Untitled"
    body_md = data.get("body_md") or ""
    # Accept either a list (tags/aliases) or a JSON string (tags_json/aliases_json);
    # normalise so storage is always a JSON array.
    tags_json = json.dumps(
        _coerce_list(data.get("tags", data.get("tags_json"))), ensure_ascii=False
    )
    aliases_json = json.dumps(
        _coerce_list(data.get("aliases", data.get("aliases_json"))), ensure_ascii=False
    )
    source = data.get("source") or "manual"
    anchor_annotation_id = data.get("anchor_annotation_id")

    with get_connection() as conn:
        note: Dict[str, Any] = {
            "title": title,
            "body_md": body_md,
            "anchor_annotation_id": anchor_annotation_id,
            "tags_json": tags_json,
            "aliases_json": aliases_json,
            "source": source,
        }
        _apply_anchor(note, conn)
        cursor = conn.execute(
            """INSERT INTO zettel_notes
               (title, body_md, anchor_annotation_id, anchor_item_key,
                anchor_page_index, anchor_quote, tags_json, aliases_json,
                file_path, source)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?)""",
            (
                note["title"],
                note["body_md"],
                note["anchor_annotation_id"],
                note.get("anchor_item_key"),
                note.get("anchor_page_index"),
                note.get("anchor_quote", ""),
                note["tags_json"],
                note["aliases_json"],
                note["source"],
            ),
        )
        note_id = cursor.lastrowid
        file_path = _note_file_path(note_id, title)
        conn.execute("UPDATE zettel_notes SET file_path = ? WHERE note_id = ?", (file_path, note_id))
        note["note_id"] = note_id
        note["file_path"] = file_path

    _sync_note_to_disk(note)
    _try_upsert_note_embedding(note_id, title, body_md)
    return note_id


def get_note(note_id: int) -> Optional[Dict[str, Any]]:
    with get_connection() as conn:
        row = conn.execute(
            """SELECT n.*, i.title AS item_title, i.year AS item_year
                 FROM zettel_notes n
                 LEFT JOIN items i ON i.item_key = n.anchor_item_key
                WHERE n.note_id = ?""",
            (note_id,),
        ).fetchone()
        if not row:
            return None
        return _row_to_note(row)


def list_notes(
    item_key: Optional[str] = None,
    tag: Optional[str] = None,
    q: Optional[str] = None,
) -> List[Dict[str, Any]]:
    # link_count is what the sidebar calls a note "linked" or "unlinked" by, and
    # what the Orphans filter selects on. Only manual links count: a semantic or
    # contradiction suggestion is the machine's guess, not a connection the user
    # has actually made, so a note carrying only those is still an orphan.
    sql = """SELECT n.*, i.title AS item_title, i.year AS item_year,
                    (SELECT COUNT(*) FROM zettel_links l
                      WHERE l.origin = 'manual'
                        AND (l.source_note_id = n.note_id OR l.target_note_id = n.note_id)
                    ) AS link_count
               FROM zettel_notes n
               LEFT JOIN items i ON i.item_key = n.anchor_item_key"""
    where: List[str] = []
    params: List[Any] = []
    if item_key:
        where.append("n.anchor_item_key = ?")
        params.append(item_key)
    if tag:
        # Free-text zettel tags live in tags_json; substring match is enough.
        where.append("n.tags_json LIKE ?")
        params.append(f'%"{tag}"%')
    if q:
        where.append("(n.title LIKE ? OR n.body_md LIKE ?)")
        params.extend([f"%{q}%", f"%{q}%"])
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY n.updated_at DESC"
    with get_connection() as conn:
        rows = conn.execute(sql, params).fetchall()
        return [_row_to_note(r) for r in rows]


def patch_note(note_id: int, data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    updates: List[str] = []
    values: List[Any] = []
    for key in PATCHABLE_NOTE_FIELDS:
        if key not in data:
            continue
        val = data[key]
        if key in ("tags_json", "aliases_json"):
            val = json.dumps(_coerce_list(val), ensure_ascii=False)
        elif key == "title":
            val = (val or "Untitled").strip() or "Untitled"
        elif key == "body_md":
            val = val or ""
        updates.append(f"{key} = ?")
        values.append(val)

    with get_connection() as conn:
        existing = conn.execute(
            "SELECT * FROM zettel_notes WHERE note_id = ?", (note_id,)
        ).fetchone()
        if not existing:
            return None
        existing = dict(existing)
        old_file_path = existing.get("file_path") or ""

        # If the anchor changed, re-resolve the denormalised fields.
        if "anchor_annotation_id" in data:
            anchor = _resolve_anchor(conn, data["anchor_annotation_id"])
            if anchor:
                updates.extend(
                    ["anchor_item_key = ?", "anchor_page_index = ?", "anchor_quote = ?"]
                )
                values.extend([anchor["item_key"], anchor["page_index"], anchor["quote"] or ""])
            else:
                updates.extend(
                    ["anchor_item_key = ?", "anchor_page_index = ?", "anchor_quote = ?"]
                )
                values.extend([None, None, ""])

        # Title change → new file_path.
        new_file_path = old_file_path
        if "title" in data:
            new_file_path = _note_file_path(note_id, (data["title"] or "Untitled").strip() or "Untitled")
            updates.append("file_path = ?")
            values.append(new_file_path)

        if updates:
            updates.append("updated_at = CURRENT_TIMESTAMP")
            values.append(note_id)
            conn.execute(
                f"UPDATE zettel_notes SET {', '.join(updates)} WHERE note_id = ?",
                values,
            )
        row = conn.execute(
            """SELECT n.*, i.title AS item_title, i.year AS item_year
                 FROM zettel_notes n
                 LEFT JOIN items i ON i.item_key = n.anchor_item_key
                WHERE n.note_id = ?""",
            (note_id,),
        ).fetchone()
        if not row:
            return None
        note = _row_to_note(row)

    _sync_note_to_disk(note)
    if new_file_path and new_file_path != old_file_path and old_file_path:
        try:
            _abs_note_path(old_file_path).unlink(missing_ok=True)
        except OSError:
            pass
    if "body_md" in data or "title" in data:
        _try_upsert_note_embedding(note_id, note.get("title") or "Untitled", note.get("body_md") or "")
    return note


def delete_note(note_id: int) -> bool:
    with get_connection() as conn:
        row = conn.execute(
            "SELECT file_path FROM zettel_notes WHERE note_id = ?", (note_id,)
        ).fetchone()
        if not row:
            return False
        file_path = row["file_path"] or ""
        cursor = conn.execute("DELETE FROM zettel_notes WHERE note_id = ?", (note_id,))
        deleted = cursor.rowcount > 0
    if deleted and file_path:
        try:
            _abs_note_path(file_path).unlink(missing_ok=True)
        except OSError:
            pass
    _try_delete_note_embedding(note_id)
    return deleted


def _row_to_note(row) -> Dict[str, Any]:
    note = dict(row)
    note["tags"] = _loads_list(note.get("tags_json"))
    note["aliases"] = _loads_list(note.get("aliases_json"))
    return note


# ── Link CRUD ───────────────────────────────────────────────────────────────


def create_link(data: Dict[str, Any]) -> Optional[int]:
    source = data.get("source_note_id")
    target = data.get("target_note_id")
    if not source or not target or source == target:
        return None
    link_type = data.get("link_type") or "extends"
    if link_type not in ALLOWED_LINK_TYPES:
        return None
    origin = data.get("origin") or "manual"
    weight = float(data.get("weight") or 1.0)
    rationale = data.get("rationale") or ""
    with get_connection() as conn:
        cursor = conn.execute(
            """INSERT OR IGNORE INTO zettel_links
               (source_note_id, target_note_id, link_type, origin, weight, rationale)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (source, target, link_type, origin, weight, rationale),
        )
        if cursor.rowcount <= 0:
            return None
        return cursor.lastrowid


def delete_link(link_id: int) -> bool:
    with get_connection() as conn:
        cursor = conn.execute("DELETE FROM zettel_links WHERE link_id = ?", (link_id,))
        return cursor.rowcount > 0


def list_links_for_note(note_id: int) -> Dict[str, List[Dict[str, Any]]]:
    with get_connection() as conn:
        out_rows = conn.execute(
            """SELECT l.*, t.title AS target_title
                 FROM zettel_links l
                 JOIN zettel_notes t ON t.note_id = l.target_note_id
                WHERE l.source_note_id = ?
                ORDER BY l.created_at""",
            (note_id,),
        ).fetchall()
        in_rows = conn.execute(
            """SELECT l.*, s.title AS source_title
                 FROM zettel_links l
                 JOIN zettel_notes s ON s.note_id = l.source_note_id
                WHERE l.target_note_id = ?
                ORDER BY l.created_at""",
            (note_id,),
        ).fetchall()
    return {
        "outgoing": [dict(r) for r in out_rows],
        "incoming": [dict(r) for r in in_rows],
    }


# ── Backlinks / evidence ────────────────────────────────────────────────────


def get_backlinks(note_id: int) -> List[Dict[str, Any]]:
    """Incoming links (other notes that link to this one), with source titles."""
    with get_connection() as conn:
        rows = conn.execute(
            """SELECT l.*, s.title AS source_title, s.anchor_item_key AS source_item_key
                 FROM zettel_links l
                 JOIN zettel_notes s ON s.note_id = l.source_note_id
                WHERE l.target_note_id = ?
                ORDER BY l.origin, l.created_at""",
            (note_id,),
        ).fetchall()
        return [dict(r) for r in rows]


def get_evidence(note_id: int) -> Optional[Dict[str, Any]]:
    """The anchored annotation + item metadata for a note, or None if unanchored."""
    with get_connection() as conn:
        note = conn.execute(
            "SELECT anchor_annotation_id, anchor_item_key FROM zettel_notes WHERE note_id = ?",
            (note_id,),
        ).fetchone()
        if not note or not note["anchor_annotation_id"]:
            return None
        ann = conn.execute(
            """SELECT a.*, i.title AS item_title, i.year AS item_year, i.item_key
                 FROM annotations a
                 LEFT JOIN items i ON i.item_key = a.item_key
                WHERE a.annotation_id = ?""",
            (note["anchor_annotation_id"],),
        ).fetchone()
        if not ann:
            return None
        result = dict(ann)
        # Attach the theme tags on the annotation.
        tag_rows = conn.execute(
            """SELECT t.tag_id, t.name, t.color
                 FROM annotation_tags at JOIN tags t ON t.tag_id = at.tag_id
                WHERE at.annotation_id = ?""",
            (note["anchor_annotation_id"],),
        ).fetchall()
        result["tags"] = [dict(t) for t in tag_rows]
        return result


# ── Graph ───────────────────────────────────────────────────────────────────


# ── Graph Analytics & Community Detection ───────────────────────────────────

COMMUNITY_COLORS = [
    "#38bdf8",  # Sky Blue
    "#a855f7",  # Purple
    "#34d399",  # Emerald
    "#f59e0b",  # Amber
    "#ec4899",  # Pink
    "#6366f1",  # Indigo
    "#14b8a6",  # Teal
    "#f97316",  # Orange
]


def _detect_communities(node_ids: List[int], edges: List[Dict[str, Any]]) -> Dict[int, int]:
    """Label propagation community detection on the notes graph."""
    if not node_ids:
        return {}
    labels = {nid: i for i, nid in enumerate(node_ids)}
    adj: Dict[int, List[int]] = {nid: [] for nid in node_ids}
    for e in edges:
        s, t = e["source"], e["target"]
        if s in adj and t in adj:
            adj[s].append(t)
            adj[t].append(s)

    for _ in range(25):
        changed = False
        for nid in sorted(adj.keys(), key=lambda x: len(adj[x]), reverse=True):
            neighbors = adj[nid]
            if not neighbors:
                continue
            counts: Dict[int, int] = {}
            for nb in neighbors:
                lbl = labels[nb]
                counts[lbl] = counts.get(lbl, 0) + 1
            max_count = max(counts.values())
            best_labels = [l for l, c in counts.items() if c == max_count]
            new_label = min(best_labels)
            if labels[nid] != new_label:
                labels[nid] = new_label
                changed = True
        if not changed:
            break

    unique_labels = sorted(set(labels.values()))
    label_map = {old: new for new, old in enumerate(unique_labels)}
    return {nid: label_map[lbl] for nid, lbl in labels.items()}


def _compute_betweenness_centrality(node_ids: List[int], edges: List[Dict[str, Any]]) -> Dict[int, float]:
    """Brandes algorithm for shortest-path betweenness centrality."""
    if not node_ids:
        return {}
    adj: Dict[int, List[int]] = {nid: [] for nid in node_ids}
    for e in edges:
        s, t = e["source"], e["target"]
        if s in adj and t in adj:
            adj[s].append(t)
            adj[t].append(s)

    import collections
    betweenness = {nid: 0.0 for nid in node_ids}
    for s in node_ids:
        S = []
        P: Dict[int, List[int]] = {w: [] for w in node_ids}
        sigma = {w: 0 for w in node_ids}
        sigma[s] = 1
        d = {w: -1 for w in node_ids}
        d[s] = 0
        Q = collections.deque([s])
        while Q:
            v = Q.popleft()
            S.append(v)
            for w in adj[v]:
                if d[w] < 0:
                    Q.append(w)
                    d[w] = d[v] + 1
                if d[w] == d[v] + 1:
                    sigma[w] += sigma[v]
                    P[w].append(v)
        delta = {w: 0.0 for w in node_ids}
        while S:
            w = S.pop()
            for v in P[w]:
                delta[v] += (sigma[v] / (sigma[w] or 1)) * (1.0 + delta[w])
            if w != s:
                betweenness[w] += delta[w]

    n = len(node_ids)
    scale = 1.0 / max(1, (n - 1) * (n - 2)) if n > 2 else 1.0
    return {nid: round(score * scale, 4) for nid, score in betweenness.items()}


def get_graph_data(
    item_key: Optional[str] = None,
    scope: Optional[str] = None,
    center_id: Optional[int] = None,
    depth: int = 1,
) -> Dict[str, Any]:
    """Return enriched ``{nodes, edges, communities}`` for the zettel graph.

    Nodes carry degree, community ID & color, year, tags, evidence anchors,
    and betweenness centrality.
    """
    import collections
    with get_connection() as conn:
        if item_key:
            note_rows = conn.execute(
                """SELECT zn.note_id, zn.title, zn.tags_json, zn.aliases_json,
                          zn.anchor_annotation_id, zn.anchor_item_key, zn.anchor_quote,
                          zn.anchor_page_index, i.year as item_year, i.title as item_title
                     FROM zettel_notes zn
                     LEFT JOIN items i ON i.item_key = zn.anchor_item_key
                    WHERE zn.anchor_item_key = ?""",
                (item_key,),
            ).fetchall()
        else:
            note_rows = conn.execute(
                """SELECT zn.note_id, zn.title, zn.tags_json, zn.aliases_json,
                          zn.anchor_annotation_id, zn.anchor_item_key, zn.anchor_quote,
                          zn.anchor_page_index, i.year as item_year, i.title as item_title
                     FROM zettel_notes zn
                     LEFT JOIN items i ON i.item_key = zn.anchor_item_key"""
            ).fetchall()

        note_ids = [r["note_id"] for r in note_rows]
        if not note_ids:
            return {"nodes": [], "edges": [], "communities": []}

        placeholders = ",".join("?" for _ in note_ids)
        link_rows = conn.execute(
            f"""SELECT source_note_id, target_note_id, link_type, origin, weight, rationale
                  FROM zettel_links
                 WHERE source_note_id IN ({placeholders}) AND target_note_id IN ({placeholders})""",
            (*note_ids, *note_ids),
        ).fetchall()

    degree: Dict[int, int] = collections.Counter()
    in_degree: Dict[int, int] = collections.Counter()
    out_degree: Dict[int, int] = collections.Counter()
    for r in link_rows:
        s, t = r["source_note_id"], r["target_note_id"]
        degree[s] += 1
        degree[t] += 1
        out_degree[s] += 1
        in_degree[t] += 1

    edges = [
        {
            "source": r["source_note_id"],
            "target": r["target_note_id"],
            "link_type": r["link_type"],
            "origin": r["origin"],
            "weight": r["weight"],
            "rationale": r["rationale"],
        }
        for r in link_rows
    ]

    # Detect communities & betweenness
    community_assignment = _detect_communities(note_ids, edges)
    betweenness_scores = _compute_betweenness_centrality(note_ids, edges)

    # Compute community names from top tags
    community_tags: Dict[int, List[str]] = collections.defaultdict(list)
    for r in note_rows:
        cid = community_assignment.get(r["note_id"], 0)
        try:
            community_tags[cid].extend(json.loads(r["tags_json"] or "[]"))
        except (json.JSONDecodeError, TypeError):
            pass

    community_names: Dict[int, str] = {}
    for cid, tlist in community_tags.items():
        tc = collections.Counter(tlist).most_common(2)
        if tc:
            community_names[cid] = " & ".join(t[0].replace("-", " ").title() for t in tc)
        else:
            community_names[cid] = f"Cluster {cid + 1}"

    nodes = []
    for r in note_rows:
        nid = r["note_id"]
        cid = community_assignment.get(nid, 0)
        nodes.append({
            "id": nid,
            "name": r["title"],
            "count": degree.get(nid, 0),
            "in_degree": in_degree.get(nid, 0),
            "out_degree": out_degree.get(nid, 0),
            "anchored": bool(r["anchor_annotation_id"]),
            "year": r["item_year"],
            "tags": _loads_list(r["tags_json"]),
            "aliases": _loads_list(r["aliases_json"]),
            "anchor_quote": r["anchor_quote"] or "",
            "anchor_item_title": r["item_title"] or "",
            "community_id": cid,
            "community_name": community_names.get(cid, f"Cluster {cid + 1}"),
            "community_color": COMMUNITY_COLORS[cid % len(COMMUNITY_COLORS)],
            "betweenness": betweenness_scores.get(nid, 0.0),
        })

    # Optional local sub-graph filter
    if scope == "local" and center_id is not None:
        visited = {center_id: 0}
        queue = collections.deque([(center_id, 0)])
        adj = collections.defaultdict(list)
        for e in edges:
            adj[e["source"]].append(e["target"])
            adj[e["target"]].append(e["source"])
        while queue:
            curr, d = queue.popleft()
            if d < depth:
                for nb in adj[curr]:
                    if nb not in visited or visited[nb] > d + 1:
                        visited[nb] = d + 1
                        queue.append((nb, d + 1))
        sub_node_ids = set(visited.keys())
        nodes = [n for n in nodes if n["id"] in sub_node_ids]
        for n in nodes:
            n["depth"] = visited.get(n["id"], 0)
        edges = [e for e in edges if e["source"] in sub_node_ids and e["target"] in sub_node_ids]

    communities_summary = []
    for cid, cname in sorted(community_names.items()):
        cmembers = [n for n in nodes if n.get("community_id") == cid]
        if cmembers:
            communities_summary.append({
                "id": cid,
                "name": cname,
                "color": COMMUNITY_COLORS[cid % len(COMMUNITY_COLORS)],
                "count": len(cmembers),
            })

    return {"nodes": nodes, "edges": edges, "communities": communities_summary}


def get_graph_analytics(item_key: Optional[str] = None) -> Dict[str, Any]:
    """Calculate comprehensive topological graph metrics and knowledge hubs."""
    import collections
    graph = get_graph_data(item_key=item_key)
    nodes = graph["nodes"]
    edges = graph["edges"]
    n = len(nodes)
    e = len(edges)

    possible_edges = n * (n - 1) if n > 1 else 1
    density = round(e / possible_edges, 4) if n > 1 else 0.0
    avg_degree = round((2 * e) / n, 2) if n > 0 else 0.0

    # Sort hubs and bridges
    hubs = sorted(nodes, key=lambda x: x["count"], reverse=True)[:5]
    bridges = sorted(nodes, key=lambda x: x.get("betweenness", 0.0), reverse=True)[:5]
    isolated = [node for node in nodes if node["count"] <= 1]

    # Link distribution
    link_type_counts = collections.Counter(edge["link_type"] for edge in edges)
    origin_counts = collections.Counter(edge["origin"] for edge in edges)

    # Timeline distribution
    years = [node["year"] for node in nodes if node.get("year")]
    year_counts = collections.Counter(years)
    timeline = [{"year": yr, "count": count} for yr, count in sorted(year_counts.items())]

    return {
        "summary": {
            "node_count": n,
            "edge_count": e,
            "density": density,
            "avg_degree": avg_degree,
            "community_count": len(graph.get("communities", [])),
            "isolated_count": len(isolated),
        },
        "hubs": [{"id": h["id"], "name": h["name"], "degree": h["count"], "community": h.get("community_name")} for h in hubs],
        "bridges": [{"id": b["id"], "name": b["name"], "betweenness": b.get("betweenness", 0.0), "degree": b["count"], "community": b.get("community_name")} for b in bridges],
        "isolated": [{"id": iso["id"], "name": iso["name"]} for iso in isolated],
        "communities": graph.get("communities", []),
        "link_types": dict(link_type_counts),
        "link_origins": dict(origin_counts),
        "timeline": timeline,
    }


def export_standalone_html(item_key: Optional[str] = None) -> str:
    """Generate a self-contained, responsive HTML file with embedded interactive graph."""
    graph_data = get_graph_data(item_key=item_key)
    analytics_data = get_graph_analytics(item_key=item_key)
    data_json = json.dumps({"graph": graph_data, "analytics": analytics_data}, ensure_ascii=False)

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>TarCite Knowledge Graph Export</title>
    <style>
        * {{ box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }}
        body {{ background: #080f1e; color: #f8fafc; overflow: hidden; width: 100vw; height: 100vh; display: flex; flex-direction: column; }}
        header {{ display: flex; justify-content: space-between; align-items: center; padding: 12px 20px; background: rgba(15, 23, 42, 0.85); backdrop-filter: blur(12px); border-bottom: 1px solid rgba(255,255,255,0.1); }}
        h1 {{ font-size: 16px; font-weight: 700; display: flex; align-items: center; gap: 8px; }}
        .hud-controls {{ display: flex; gap: 8px; align-items: center; }}
        .hud-btn {{ background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.15); color: #fff; padding: 5px 10px; border-radius: 6px; font-size: 12px; cursor: pointer; }}
        .hud-btn:hover {{ background: rgba(255,255,255,0.2); }}
        #canvas-wrap {{ flex: 1; position: relative; width: 100%; height: 100%; }}
        canvas {{ width: 100%; height: 100%; display: block; }}
        #tooltip {{ position: absolute; pointer-events: none; display: none; padding: 10px 12px; background: rgba(15,23,42,0.9); backdrop-filter: blur(12px); border: 1px solid rgba(255,255,255,0.15); border-radius: 8px; font-size: 12px; max-width: 260px; box-shadow: 0 8px 24px rgba(0,0,0,0.5); }}
    </style>
</head>
<body>
    <header>
        <h1>TarCite Knowledge Graph</h1>
        <div class="hud-controls">
            <button class="hud-btn" onclick="zoomFit()">Center View</button>
            <button class="hud-btn" onclick="reheat()">Reorganise</button>
        </div>
    </header>
    <div id="canvas-wrap">
        <canvas id="graph-canvas"></canvas>
        <div id="tooltip"></div>
    </div>
    <script>
        const DATA = {data_json};
        const canvas = document.getElementById('graph-canvas');
        const ctx = canvas.getContext('2d');
        let W = window.innerWidth, H = window.innerHeight - 50;
        canvas.width = W * window.devicePixelRatio; canvas.height = H * window.devicePixelRatio;
        ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
        
        let nodes = DATA.graph.nodes.map(n => ({{ ...n, r: 6, x: W/2 + (Math.random()-0.5)*W*0.4, y: H/2 + (Math.random()-0.5)*H*0.4, vx:0, vy:0 }}));
        let edges = DATA.graph.edges;
        let tr = {{ scale: 1, tx: 0, ty: 0 }};
        let hovered = null, dragging = null, panning = false, panStart = null;
        let alpha = 1.0;

        function draw() {{
            ctx.clearRect(0, 0, W, H);
            ctx.save();
            ctx.translate(tr.tx, tr.ty); ctx.scale(tr.scale, tr.scale);
            
            // Draw edges
            const idx = {{}}; nodes.forEach((n,i) => idx[n.id] = i);
            edges.forEach(e => {{
                const na = nodes[idx[e.source]], nb = nodes[idx[e.target]];
                if (!na || !nb) return;
                ctx.beginPath();
                ctx.moveTo(na.x, na.y); ctx.lineTo(nb.x, nb.y);
                ctx.strokeStyle = e.link_type === 'contradicts' ? 'rgba(248,113,113,0.7)' : 'rgba(148,163,184,0.35)';
                ctx.lineWidth = 1;
                ctx.stroke();
            }});
            
            // Draw nodes
            nodes.forEach(n => {{
                ctx.beginPath();
                ctx.arc(n.x, n.y, n.r, 0, Math.PI*2);
                ctx.fillStyle = n.community_color || '#60a5fa';
                ctx.shadowColor = n.community_color || '#60a5fa';
                ctx.shadowBlur = 6; ctx.fill(); ctx.shadowBlur = 0;
                ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 0.8; ctx.stroke();
                
                ctx.font = '500 8.5px sans-serif';
                ctx.fillStyle = 'rgba(226,232,240,0.85)';
                ctx.textAlign = 'center'; ctx.fillText(n.name.length > 22 ? n.name.slice(0,20)+'…' : n.name, n.x, n.y + n.r + 4);
            }});
            ctx.restore();
        }}
        
        function step() {{
            if (alpha > 0.005) {{
                const idx = {{}}; nodes.forEach((n,i) => idx[n.id] = i);
                for (let i=0; i<nodes.length; i++) for (let j=i+1; j<nodes.length; j++) {{
                    const dx = nodes[j].x - nodes[i].x, dy = nodes[j].y - nodes[i].y;
                    const d = Math.sqrt(dx*dx+dy*dy) || 1;
                    const f = (1600 / (d*d + 80)) * alpha;
                    nodes[i].vx -= dx/d*f; nodes[i].vy -= dy/d*f;
                    nodes[j].vx += dx/d*f; nodes[j].vy += dy/d*f;
                }}
                edges.forEach(e => {{
                    const a = nodes[idx[e.source]], b = nodes[idx[e.target]];
                    if (!a || !b) return;
                    const dx = b.x - a.x, dy = b.y - a.y;
                    const d = Math.sqrt(dx*dx+dy*dy) || 1;
                    const f = (d - 75) * 0.05 * alpha;
                    a.vx += dx/d*f; a.vy += dy/d*f; b.vx -= dx/d*f; b.vy -= dy/d*f;
                }});
                nodes.forEach(n => {{
                    n.vx += (W/2 - n.x)*0.008*alpha; n.vy += (H/2 - n.y)*0.008*alpha;
                    if (dragging !== n) {{ n.x += n.vx; n.y += n.vy; n.vx *= 0.78; n.vy *= 0.78; }}
                }});
                alpha *= 0.985;
            }}
            draw();
            requestAnimationFrame(step);
        }}
        
        function zoomFit() {{ tr = {{ scale: 1, tx: 0, ty: 0 }}; }}
        function reheat() {{ alpha = 1.0; }}
        window.addEventListener('resize', () => {{
            W = window.innerWidth; H = window.innerHeight - 50;
            canvas.width = W * window.devicePixelRatio; canvas.height = H * window.devicePixelRatio;
            ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
        }});
        requestAnimationFrame(step);
    </script>
</body>
</html>"""


# ── Computed links ──────────────────────────────────────────────────────────


def _clear_computed(conn, origin: str) -> None:
    conn.execute("DELETE FROM zettel_links WHERE origin = ?", (origin,))
    conn.execute("DELETE FROM zettel_computed_links WHERE kind = ?", (origin,))


def _upsert_computed_link(
    conn,
    note_a: int,
    note_b: int,
    origin: str,
    score: float,
    rationale: str = "",
    annotation_id_shared: Optional[int] = None,
) -> None:
    """Insert a computed link into both zettel_links and the cache (idempotent)."""
    a, b = (note_a, note_b) if note_a < note_b else (note_b, note_a)
    link_type = COMPUTED_ORIGIN_TO_TYPE.get(origin, "extends")
    conn.execute(
        """INSERT OR IGNORE INTO zettel_links
           (source_note_id, target_note_id, link_type, origin, weight, rationale)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (a, b, link_type, origin, score, rationale),
    )
    conn.execute(
        """INSERT OR REPLACE INTO zettel_computed_links
           (note_id_a, note_id_b, kind, score, rationale, annotation_id_shared)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (a, b, origin, score, rationale, annotation_id_shared),
    )


def recompute_shared_evidence() -> int:
    """Pure-SQL computed links: notes sharing the same anchor annotation
    (``shared_evidence``) and notes whose anchors share a theme tag
    (``shared_theme``). Returns links upserted."""
    with get_connection() as conn:
        _clear_computed(conn, "shared_evidence")
        _clear_computed(conn, "shared_theme")

        # Same-anchor pairs.
        same_anchor = conn.execute(
            """SELECT a.note_id AS a, b.note_id AS b, a.anchor_annotation_id AS ann
                 FROM zettel_notes a
                 JOIN zettel_notes b ON b.anchor_annotation_id = a.anchor_annotation_id
                WHERE a.anchor_annotation_id IS NOT NULL
                  AND a.note_id < b.note_id"""
        ).fetchall()
        added = 0
        for r in same_anchor:
            _upsert_computed_link(
                conn, r["a"], r["b"], "shared_evidence", 1.0,
                rationale="Shares the same source annotation.",
                annotation_id_shared=r["ann"],
            )
            added += 1

        # Shared-theme pairs: anchors that carry at least one common theme tag.
        shared_theme = conn.execute(
            """SELECT DISTINCT a.note_id AS a, b.note_id AS b, t.tag_id AS tag_id, t.name AS tag_name
                 FROM zettel_notes a
                 JOIN zettel_notes b ON b.note_id > a.note_id
                 JOIN annotation_tags at_a ON at_a.annotation_id = a.anchor_annotation_id
                 JOIN annotation_tags at_b ON at_b.annotation_id = b.anchor_annotation_id
                 JOIN tags t ON t.tag_id = at_a.tag_id AND t.tag_id = at_b.tag_id
                WHERE a.anchor_annotation_id IS NOT NULL
                  AND b.anchor_annotation_id IS NOT NULL"""
        ).fetchall()
        seen: set = set()
        for r in shared_theme:
            key = (r["a"], r["b"])
            if key in seen:
                continue
            seen.add(key)
            _upsert_computed_link(
                conn, r["a"], r["b"], "shared_theme", 0.8,
                rationale=f"Anchors share the theme “{r['tag_name']}”.",
            )
            added += 1
    return added


def _get_notes_collection():
    """Lazily get/create the separate ``tarcite_notes`` Chroma collection.

    Returns None if Chroma is unavailable (quarantine / not installed) so the
    semantic recompute degrades gracefully without touching the item store.
    """
    try:
        from app.embeddings import get_chroma_client
        client = get_chroma_client()
        return client.get_or_create_collection(
            name=NOTES_COLLECTION_NAME,
            metadata={"hnsw:space": "cosine"},
        )
    except Exception as exc:
        logger.warning("tarcite_notes collection unavailable: %s", exc)
        return None


def _try_upsert_note_embedding(note_id: int, title: str, body: str) -> None:
    """Best-effort embedding upsert for a single note (called on create/update)."""
    text = (title + "\n\n" + (body or "")).strip()
    if not text:
        return
    collection = _get_notes_collection()
    if collection is None:
        return
    try:
        from app.embeddings import ensure_embedding_model_ready, create_embeddings_batch
        ensure_embedding_model_ready()
        vec = create_embeddings_batch([text])[0]
        collection.upsert(
            ids=[f"note-{note_id}"],
            embeddings=[vec],
            documents=[text],
            metadatas=[{"note_id": note_id}],
        )
    except Exception as exc:
        logger.warning("Note embedding upsert failed for note %s: %s", note_id, exc)


def _try_delete_note_embedding(note_id: int) -> None:
    collection = _get_notes_collection()
    if collection is None:
        return
    try:
        collection.delete(ids=[f"note-{note_id}"])
    except Exception:
        pass


def recompute_semantic_links(threshold: float = 0.75) -> int:
    """Embed all note bodies into ``tarcite_notes`` and upsert ``semantic`` links
    for cosine similarity above ``threshold``. Returns links upserted, or -1 if
    the vector store is unavailable."""
    collection = _get_notes_collection()
    if collection is None:
        return -1
    try:
        from app.embeddings import ensure_embedding_model_ready, create_embeddings_batch
        ensure_embedding_model_ready()
    except Exception as exc:
        logger.warning("Embedding model not ready for semantic recompute: %s", exc)
        return -1

    with get_connection() as conn:
        rows = conn.execute("SELECT note_id, title, body_md FROM zettel_notes").fetchall()
    if not rows:
        with get_connection() as conn:
            _clear_computed(conn, "semantic")
        return 0

    texts = [f"{r['title']}\n\n{r['body_md'] or ''}".strip() for r in rows]
    ids = [r["note_id"] for r in rows]
    try:
        embeddings = create_embeddings_batch(texts)
    except Exception as exc:
        logger.warning("Semantic embedding failed: %s", exc)
        return -1

    # Upsert all notes into the collection.
    collection.upsert(
        ids=[f"note-{i}" for i in ids],
        embeddings=embeddings,
        documents=texts,
        metadatas=[{"note_id": i} for i in ids],
    )

    n_results = min(len(ids) + 1, 11)
    added = 0
    seen: set = set()
    for idx, note_id in enumerate(ids):
        try:
            res = collection.query(
                query_embeddings=[embeddings[idx]],
                n_results=n_results,
                include=["distances", "metadatas"],
            )
        except Exception as exc:
            logger.warning("Semantic query failed for note %s: %s", note_id, exc)
            continue
        result_ids = res.get("ids", [[]])[0]
        distances = res.get("distances", [[]])[0]
        for other_id_raw, dist in zip(result_ids, distances):
            other_id = int(other_id_raw.replace("note-", ""))
            if other_id == note_id:
                continue
            similarity = 1.0 - float(dist)
            if similarity < threshold:
                continue
            a, b = (note_id, other_id) if note_id < other_id else (other_id, note_id)
            if (a, b) in seen:
                continue
            seen.add((a, b))
            with get_connection() as conn:
                _upsert_computed_link(
                    conn, a, b, "semantic", similarity,
                    rationale=f"Semantic similarity {similarity:.2f}.",
                )
            added += 1

    # Remove any cached semantic links that no longer qualify.
    with get_connection() as conn:
        conn.execute(
            "DELETE FROM zettel_links WHERE origin = 'semantic' AND weight < ?",
            (threshold,),
        )
        conn.execute(
            "DELETE FROM zettel_computed_links WHERE kind = 'semantic' AND score < ?",
            (threshold,),
        )
    return added


def recompute_contradiction_links(max_pairs: int = 50) -> int:
    """LLM-detected contradiction between anchored, semantically-similar notes.

    Candidates are semantic-neighbour pairs (similarity > 0.6) that both carry an
    anchor; capped at ``max_pairs`` to bound LLM cost. Returns links upserted,
    or -1 if the LLM is unavailable."""
    try:
        from app.ai_client import check_note_pair_contradiction  # noqa: F401
    except ImportError:
        logger.info("Contradiction recompute skipped: ai_client.check_note_pair_contradiction unavailable")
        return -1

    with get_connection() as conn:
        # Candidate pairs: cached semantic links above 0.6 where both notes are anchored.
        pairs = conn.execute(
            """SELECT c.note_id_a AS a, c.note_id_b AS b, c.score
                 FROM zettel_computed_links c
                 JOIN zettel_notes na ON na.note_id = c.note_id_a
                 JOIN zettel_notes nb ON nb.note_id = c.note_id_b
                WHERE c.kind = 'semantic' AND c.score >= 0.6
                  AND na.anchor_annotation_id IS NOT NULL
                  AND nb.anchor_annotation_id IS NOT NULL
                ORDER BY c.score DESC
                LIMIT ?""",
            (max_pairs,),
        ).fetchall()
        if not pairs:
            _clear_computed(conn, "contradiction")
            return 0
        _clear_computed(conn, "contradiction")
        note_cache: Dict[int, Dict[str, Any]] = {}
        for p in pairs:
            for nid in (p["a"], p["b"]):
                if nid not in note_cache:
                    row = conn.execute(
                        "SELECT note_id, title, body_md FROM zettel_notes WHERE note_id = ?",
                        (nid,),
                    ).fetchone()
                    note_cache[nid] = dict(row) if row else {}

    from app.ai_client import check_note_pair_contradiction

    added = 0
    for p in pairs:
        na = note_cache.get(p["a"])
        nb = note_cache.get(p["b"])
        if not na or not nb:
            continue
        try:
            verdict = check_note_pair_contradiction(na, nb)
        except Exception as exc:
            logger.warning("Contradiction check failed for %s/%s: %s", p["a"], p["b"], exc)
            continue
        if not verdict or not verdict.get("contradicts"):
            continue
        with get_connection() as conn:
            _upsert_computed_link(
                conn, p["a"], p["b"], "contradiction", float(verdict.get("confidence") or 0.7),
                rationale=verdict.get("rationale") or "LLM-detected contradiction.",
            )
        added += 1
    return added


def recompute_all(kinds: Optional[List[str]] = None) -> Dict[str, int]:
    """Run one or more recompute passes. Returns a {kind: count} report."""
    requested = set(kinds or ["shared_evidence", "semantic", "contradiction"])
    report: Dict[str, int] = {}
    if "shared_evidence" in requested or "shared_theme" in requested:
        report["shared_evidence"] = recompute_shared_evidence()
    if "semantic" in requested:
        report["semantic"] = recompute_semantic_links()
    if "contradiction" in requested:
        report["contradiction"] = recompute_contradiction_links()
    return report


# ── Disk reconcile (self-heal, model on reconcile_item_collections) ─────────


def reconcile_zettel_disk() -> Dict[str, int]:
    """Reconcile the on-disk ``.md`` files with the ``zettel_notes`` table.

    - For every DB row: ensure the ``.md`` file exists; rewrite from DB if missing.
    - For every ``.md`` on disk with no DB row: parse frontmatter and insert.
    - If a file's mtime is newer than the row's ``updated_at`` AND the body
      differs, prefer the disk edit (lets Obsidian edits be ingested on launch).

    Idempotent and add-only on the DB side. Skips ``.obsidian/``.
    """
    stats = {"db_to_disk": 0, "disk_to_db": 0, "disk_preferred": 0}
    notes_dir = _notes_dir()

    with get_connection() as conn:
        rows = conn.execute(
            "SELECT note_id, title, body_md, file_path, updated_at FROM zettel_notes"
        ).fetchall()
        by_path = {r["file_path"]: dict(r) for r in rows if r["file_path"]}
        db_titles = {r["note_id"]: r["title"] for r in rows}

        # 1. DB → disk: rewrite any missing files from the DB row.
        for r in rows:
            fp = r["file_path"] or _note_file_path(r["note_id"], r["title"])
            abs_path = notes_dir / fp
            if not abs_path.exists():
                _sync_note_to_disk(dict(r))
                stats["db_to_disk"] += 1
                if not r["file_path"]:
                    conn.execute(
                        "UPDATE zettel_notes SET file_path = ? WHERE note_id = ?",
                        (fp, r["note_id"]),
                    )

        # 2. disk → DB: import stray .md files not represented in the DB.
        existing_paths = set(by_path.keys())
        on_disk: List[Path] = []
        for p in notes_dir.glob("*.md"):
            if p.name.startswith("."):
                continue
            if p.name in existing_paths:
                continue
            on_disk.append(p)

    # Parse + insert outside the read transaction (each insert opens its own).
    for p in on_disk:
        parsed = _parse_md_file(p)
        if parsed is None:
            continue
        try:
            with get_connection() as conn:
                cursor = conn.execute(
                    """INSERT INTO zettel_notes
                       (title, body_md, anchor_annotation_id, anchor_item_key,
                        anchor_page_index, anchor_quote, tags_json, aliases_json,
                        file_path, source)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'imported')""",
                    (
                        parsed["title"],
                        parsed["body_md"],
                        parsed.get("anchor_annotation_id"),
                        parsed.get("anchor_item_key"),
                        parsed.get("anchor_page_index"),
                        parsed.get("anchor_quote") or "",
                        json.dumps(parsed.get("tags") or [], ensure_ascii=False),
                        json.dumps(parsed.get("aliases") or [], ensure_ascii=False),
                        p.name,
                    ),
                )
                stats["disk_to_db"] += 1
                logger.info("Imported zettel note from disk: %s (note_id=%s)", p.name, cursor.lastrowid)
        except Exception as exc:
            logger.warning("Could not import zettel note %s: %s", p, exc)

    # 3. disk-preferred: files newer than updated_at with a differing body.
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT note_id, title, body_md, file_path, updated_at FROM zettel_notes WHERE file_path != ''"
        ).fetchall()
        for r in rows:
            abs_path = notes_dir / r["file_path"]
            if not abs_path.exists():
                continue
            try:
                mtime = abs_path.stat().st_mtime
            except OSError:
                continue
            # Compare mtime against updated_at string heuristically (disk wins if newer).
            parsed = _parse_md_file(abs_path)
            if parsed is None:
                continue
            if parsed["body_md"] == (r["body_md"] or ""):
                continue
            # Only prefer disk when the file was modified after the DB row.
            import datetime as _dt
            try:
                db_updated = _dt.datetime.fromisoformat(str(r["updated_at"]).replace(" ", "T"))
            except (ValueError, TypeError):
                db_updated = _dt.datetime.utcnow()
            if _dt.datetime.fromtimestamp(mtime) <= db_updated:
                continue
            conn.execute(
                "UPDATE zettel_notes SET body_md = ?, title = ?, updated_at = CURRENT_TIMESTAMP WHERE note_id = ?",
                (parsed["body_md"], parsed["title"], r["note_id"]),
            )
            stats["disk_preferred"] += 1
            logger.info("Ingested Obsidian edit for note %s from %s", r["note_id"], r["file_path"])

    if any(stats.values()):
        logger.info("Zettel disk reconcile: %s", stats)
    return stats