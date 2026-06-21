import re
import sqlite3
from typing import Any, Dict, List, Optional

from app.repositories.core import get_connection


def create_project(data: Dict[str, Any]) -> int:
    with get_connection() as conn:
        cursor = conn.execute(
            """INSERT INTO projects
               (name, project_type, research_question, objective, status, notes, note_connections)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                (data.get("name") or "Untitled Project").strip(),
                data.get("project_type") or "project",
                data.get("research_question") or "",
                data.get("objective") or "",
                data.get("status") or "active",
                data.get("notes") or "",
                data.get("note_connections") or "[]",
            ),
        )
        return cursor.lastrowid


def update_project(project_id: int, data: Dict[str, Any]) -> bool:
    with get_connection() as conn:
        cursor = conn.execute(
            """UPDATE projects
               SET name = ?, project_type = ?, research_question = ?,
                   objective = ?, status = ?, notes = ?, note_connections = ?,
                   updated_at = CURRENT_TIMESTAMP
               WHERE project_id = ?""",
            (
                (data.get("name") or "Untitled Project").strip(),
                data.get("project_type") or "project",
                data.get("research_question") or "",
                data.get("objective") or "",
                data.get("status") or "active",
                data.get("notes") or "",
                data.get("note_connections") or "[]",
                project_id,
            ),
        )
        return cursor.rowcount > 0


def patch_project(project_id: int, data: Dict[str, Any]) -> bool:
    allowed = {
        "name": lambda v: (v or "Untitled Project").strip(),
        "project_type": lambda v: v or "project",
        "research_question": lambda v: v or "",
        "objective": lambda v: v or "",
        "status": lambda v: v or "active",
        "notes": lambda v: v or "",
        "note_connections": lambda v: v or "[]",
    }
    updates = []
    values = []
    for key, normalize in allowed.items():
        if key not in data:
            continue
        updates.append(f"{key} = ?")
        values.append(normalize(data.get(key)))

    if not updates:
        return get_project(project_id) is not None

    values.append(project_id)
    with get_connection() as conn:
        cursor = conn.execute(
            f"""UPDATE projects
                SET {', '.join(updates)}, updated_at = CURRENT_TIMESTAMP
                WHERE project_id = ?""",
            tuple(values),
        )
        return cursor.rowcount > 0


def delete_project(project_id: int) -> bool:
    with get_connection() as conn:
        cursor = conn.execute("DELETE FROM projects WHERE project_id = ?", (project_id,))
        return cursor.rowcount > 0


def list_projects() -> List[Dict]:
    with get_connection() as conn:
        rows = conn.execute(
            """SELECT p.*,
                      COUNT(DISTINCT pi.item_key) AS source_count,
                      COUNT(DISTINCT pa.annotation_id) AS pinned_annotation_count,
                      COUNT(DISTINCT a.annotation_id) AS total_annotation_count
               FROM projects p
               LEFT JOIN project_items pi ON pi.project_id = p.project_id
               LEFT JOIN annotations a ON a.item_key = pi.item_key
               LEFT JOIN project_annotations pa ON pa.project_id = p.project_id
               GROUP BY p.project_id
               ORDER BY p.updated_at DESC, p.created_at DESC"""
        ).fetchall()
        return [dict(r) for r in rows]


def get_project(project_id: int) -> Optional[Dict]:
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM projects WHERE project_id = ?", (project_id,)).fetchone()
        return dict(row) if row else None


def add_item_to_project(project_id: int, item_key: str, reading_status: str = "", note: str = "") -> None:
    with get_connection() as conn:
        conn.execute(
            """INSERT OR IGNORE INTO project_items
               (project_id, item_key, reading_status, note)
               VALUES (?, ?, ?, ?)""",
            (project_id, item_key, reading_status, note),
        )
        conn.execute(
            "UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE project_id = ?",
            (project_id,),
        )


def remove_item_from_project(project_id: int, item_key: str) -> bool:
    with get_connection() as conn:
        cursor = conn.execute(
            "DELETE FROM project_items WHERE project_id = ? AND item_key = ?",
            (project_id, item_key),
        )
        conn.execute(
            """DELETE FROM project_annotations
               WHERE project_id = ?
                 AND annotation_id IN (SELECT annotation_id FROM annotations WHERE item_key = ?)""",
            (project_id, item_key),
        )
        conn.execute(
            "UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE project_id = ?",
            (project_id,),
        )
        return cursor.rowcount > 0


def add_annotation_to_project(project_id: int, annotation_id: int, role: str = "") -> None:
    with get_connection() as conn:
        item_row = conn.execute(
            "SELECT item_key FROM annotations WHERE annotation_id = ?",
            (annotation_id,),
        ).fetchone()
        if item_row:
            conn.execute(
                "INSERT OR IGNORE INTO project_items (project_id, item_key) VALUES (?, ?)",
                (project_id, item_row["item_key"]),
            )
        conn.execute(
            """INSERT OR IGNORE INTO project_annotations
               (project_id, annotation_id, role)
               VALUES (?, ?, ?)""",
            (project_id, annotation_id, role),
        )
        conn.execute(
            "UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE project_id = ?",
            (project_id,),
        )


def remove_annotation_from_project(project_id: int, annotation_id: int) -> bool:
    with get_connection() as conn:
        cursor = conn.execute(
            "DELETE FROM project_annotations WHERE project_id = ? AND annotation_id = ?",
            (project_id, annotation_id),
        )
        conn.execute(
            "UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE project_id = ?",
            (project_id,),
        )
        return cursor.rowcount > 0


def add_theme_root_to_project(project_id: int, tag_id: int, include_descendants: bool = True) -> None:
    with get_connection() as conn:
        conn.execute(
            """INSERT OR REPLACE INTO project_theme_roots
               (project_id, tag_id, include_descendants)
               VALUES (?, ?, ?)""",
            (project_id, tag_id, 1 if include_descendants else 0),
        )
        conn.execute(
            "UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE project_id = ?",
            (project_id,),
        )


def remove_theme_root_from_project(project_id: int, tag_id: int) -> bool:
    with get_connection() as conn:
        cursor = conn.execute(
            "DELETE FROM project_theme_roots WHERE project_id = ? AND tag_id = ?",
            (project_id, tag_id),
        )
        conn.execute(
            "UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE project_id = ?",
            (project_id,),
        )
        return cursor.rowcount > 0


def _build_theme_tree_from_rows(rows: List[sqlite3.Row]) -> List[Dict]:
    nodes = {
        r["tag_id"]: {
            "tag_id": r["tag_id"],
            "name": r["name"],
            "color": r["color"],
            "parent_id": r["parent_id"],
            "description": r["description"] if "description" in r.keys() else "",
            "inclusion_criteria": r["inclusion_criteria"] if "inclusion_criteria" in r.keys() else "",
            "exclusion_criteria": r["exclusion_criteria"] if "exclusion_criteria" in r.keys() else "",
            "children": [],
        }
        for r in rows
    }
    roots: List[Dict] = []
    for node in nodes.values():
        parent_id = node.get("parent_id")
        if parent_id and parent_id in nodes:
            nodes[parent_id]["children"].append(node)
        else:
            roots.append(node)

    def sort_node(n: Dict) -> Dict:
        n["children"].sort(key=lambda c: c["name"].lower())
        for child in n["children"]:
            sort_node(child)
        return n

    roots.sort(key=lambda c: c["name"].lower())
    return [sort_node(r) for r in roots]


def _descendant_tag_ids(conn: sqlite3.Connection, root_id: int) -> List[int]:
    rows = conn.execute(
        """WITH RECURSIVE theme_tree(tag_id) AS (
               SELECT tag_id FROM tags WHERE tag_id = ?
               UNION ALL
               SELECT t.tag_id FROM tags t
               JOIN theme_tree tt ON t.parent_id = tt.tag_id
           )
           SELECT tag_id FROM theme_tree""",
        (root_id,),
    ).fetchall()
    return [r["tag_id"] for r in rows]


def get_project_theme_roots(project_id: int) -> List[Dict]:
    with get_connection() as conn:
        roots = conn.execute(
            """SELECT ptr.project_id, ptr.tag_id, ptr.include_descendants, ptr.sort_order,
                      t.name, t.color, t.parent_id
               FROM project_theme_roots ptr
               JOIN tags t ON t.tag_id = ptr.tag_id
               WHERE ptr.project_id = ? AND t.tag_type = 'theme'
               ORDER BY ptr.sort_order, t.name""",
            (project_id,),
        ).fetchall()
        result = []
        for root in roots:
            root_dict = dict(root)
            tag_ids = _descendant_tag_ids(conn, root["tag_id"]) if root["include_descendants"] else [root["tag_id"]]
            placeholders = ",".join("?" for _ in tag_ids)
            rows = conn.execute(
                f"""SELECT tag_id, name, color, parent_id,
                           description, inclusion_criteria, exclusion_criteria
                    FROM tags
                    WHERE tag_id IN ({placeholders}) AND tag_type = 'theme'
                    ORDER BY parent_id NULLS FIRST, name""",
                tag_ids,
            ).fetchall() if tag_ids else []
            root_dict["theme_count"] = len(rows)
            root_dict["tree"] = _build_theme_tree_from_rows(rows)
            result.append(root_dict)
        return result


def get_project_codebook_tag_ids(conn: sqlite3.Connection, project_id: Optional[int]) -> Optional[set]:
    if not project_id:
        return None
    roots = conn.execute(
        "SELECT tag_id, include_descendants FROM project_theme_roots WHERE project_id = ?",
        (project_id,),
    ).fetchall()
    if not roots:
        return None
    tag_ids = set()
    for root in roots:
        if root["include_descendants"]:
            tag_ids.update(_descendant_tag_ids(conn, root["tag_id"]))
        else:
            tag_ids.add(root["tag_id"])
    return tag_ids


def get_projects_for_item(item_key: str) -> List[Dict]:
    with get_connection() as conn:
        rows = conn.execute(
            """SELECT p.project_id, p.name, p.project_type, p.status
               FROM projects p
               JOIN project_items pi ON pi.project_id = p.project_id
               WHERE pi.item_key = ?
               ORDER BY p.name""",
            (item_key,),
        ).fetchall()
        return [dict(r) for r in rows]


def get_project_detail(project_id: int) -> Optional[Dict]:
    with get_connection() as conn:
        project_row = conn.execute("SELECT * FROM projects WHERE project_id = ?", (project_id,)).fetchone()
        if not project_row:
            return None
        project = dict(project_row)

        item_rows = conn.execute(
            """SELECT i.*, pi.reading_status, pi.note AS project_note, pi.added_at AS project_added_at,
                      COUNT(a.annotation_id) AS annotation_count
               FROM project_items pi
               JOIN items i ON i.item_key = pi.item_key
               LEFT JOIN annotations a ON a.item_key = i.item_key
               WHERE pi.project_id = ?
               GROUP BY i.item_key
               ORDER BY pi.added_at DESC""",
            (project_id,),
        ).fetchall()
        project["items"] = [dict(r) for r in item_rows]

        ann_rows = conn.execute(
            """SELECT a.*, i.title AS item_title, i.year AS item_year,
                      CASE WHEN pa.annotation_id IS NULL THEN 0 ELSE 1 END AS pinned_to_project
               FROM project_items pi
               JOIN annotations a ON a.item_key = pi.item_key
               LEFT JOIN project_annotations pa
                    ON pa.project_id = pi.project_id AND pa.annotation_id = a.annotation_id
               LEFT JOIN items i ON i.item_key = a.item_key
               WHERE pi.project_id = ?
               ORDER BY pinned_to_project DESC, a.updated_at DESC, a.created_at DESC""",
            (project_id,),
        ).fetchall()
        annotation_ids = [row["annotation_id"] for row in ann_rows]
        tags_by_annotation: Dict[int, List[Dict]] = {}
        if annotation_ids:
            placeholders = ",".join("?" for _ in annotation_ids)
            tag_rows = conn.execute(
                f"""SELECT at.annotation_id, t.tag_id, t.name, t.color, t.parent_id
                    FROM annotation_tags at
                    JOIN tags t ON t.tag_id = at.tag_id
                    WHERE at.annotation_id IN ({placeholders}) AND t.tag_type = 'theme'
                    ORDER BY t.name""",
                annotation_ids,
            ).fetchall()
            for tag_row in tag_rows:
                tags_by_annotation.setdefault(tag_row["annotation_id"], []).append({
                    "tag_id": tag_row["tag_id"],
                    "name": tag_row["name"],
                    "color": tag_row["color"],
                    "parent_id": tag_row["parent_id"],
                })
        annotations = []
        for row in ann_rows:
            annotation = dict(row)
            annotation["tags"] = tags_by_annotation.get(annotation["annotation_id"], [])
            annotations.append(annotation)
        project["annotations"] = annotations

        theme_rows = conn.execute(
            """SELECT t.tag_id, t.name, t.color, COUNT(*) AS count
               FROM project_items pi
               JOIN annotations a ON a.item_key = pi.item_key
               JOIN annotation_tags at ON at.annotation_id = a.annotation_id
               JOIN tags t ON t.tag_id = at.tag_id
               WHERE pi.project_id = ? AND t.tag_type = 'theme'
               GROUP BY t.tag_id
               ORDER BY count DESC, t.name
               LIMIT 20""",
            (project_id,),
        ).fetchall()
        project["top_themes"] = [dict(r) for r in theme_rows]
        project["theme_roots"] = get_project_theme_roots(project_id)
        return project


def _tokenize_for_coding(text: str) -> set:
    stop = {
        "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of",
        "with", "by", "from", "as", "is", "was", "are", "were", "be", "been", "that",
        "this", "these", "those", "it", "its", "they", "their", "we", "our", "can",
        "also", "into", "about", "than", "then", "there", "where", "which", "what",
    }
    return {
        tok for tok in re.findall(r"[a-zA-Z][a-zA-Z0-9_-]{2,}", (text or "").lower())
        if tok not in stop
    }


def suggest_themes_for_annotation(annotation_id: int, project_id: Optional[int] = None, limit: int = 6) -> List[Dict]:
    """Suggest theme tags using transparent local similarity signals."""
    with get_connection() as conn:
        ann = conn.execute(
            "SELECT annotation_id, item_key, quote, comment FROM annotations WHERE annotation_id = ?",
            (annotation_id,),
        ).fetchone()
        if not ann:
            return []
        ann_text = f"{ann['quote'] or ''} {ann['comment'] or ''}".strip()
        ann_tokens = _tokenize_for_coding(ann_text)
        existing = {
            r["tag_id"] for r in conn.execute(
                "SELECT tag_id FROM annotation_tags WHERE annotation_id = ?",
                (annotation_id,),
            ).fetchall()
        }

        codebook_tag_ids = get_project_codebook_tag_ids(conn, project_id)
        if codebook_tag_ids:
            placeholders = ",".join("?" for _ in codebook_tag_ids)
            theme_rows = conn.execute(
                f"SELECT * FROM tags WHERE tag_type = 'theme' AND tag_id IN ({placeholders}) ORDER BY name",
                list(codebook_tag_ids),
            ).fetchall()
        else:
            theme_rows = conn.execute(
                "SELECT * FROM tags WHERE tag_type = 'theme' ORDER BY name"
            ).fetchall()

        suggestions = []
        for tag in theme_rows:
            tag_id = tag["tag_id"]
            if tag_id in existing:
                continue
            coded_rows = conn.execute(
                """SELECT a.quote, a.comment
                   FROM annotations a
                   JOIN annotation_tags at ON at.annotation_id = a.annotation_id
                   WHERE at.tag_id = ?
                   ORDER BY a.updated_at DESC, a.created_at DESC
                   LIMIT 25""",
                (tag_id,),
            ).fetchall()
            codebook_text = " ".join([
                tag["name"] or "",
                tag["description"] if "description" in tag.keys() else "",
                tag["inclusion_criteria"] if "inclusion_criteria" in tag.keys() else "",
                tag["exclusion_criteria"] if "exclusion_criteria" in tag.keys() else "",
            ])
            evidence_text = " ".join(f"{r['quote'] or ''} {r['comment'] or ''}" for r in coded_rows)
            theme_tokens = _tokenize_for_coding(f"{codebook_text} {evidence_text}")
            if not ann_tokens or not theme_tokens:
                continue
            overlap = ann_tokens & theme_tokens
            if not overlap:
                continue
            union = ann_tokens | theme_tokens
            jaccard = len(overlap) / max(1, len(union))
            example_boost = min(len(coded_rows), 10) * 0.015
            name_boost = len(ann_tokens & _tokenize_for_coding(tag["name"] or "")) * 0.08
            confidence = min(0.96, 0.34 + jaccard * 1.8 + example_boost + name_boost)
            suggestions.append({
                "tag_id": tag_id,
                "name": tag["name"],
                "color": tag["color"] or "#3b82f6",
                "confidence": round(confidence, 3),
                "confidence_percent": int(round(confidence * 100)),
                "matched_terms": sorted(overlap)[:8],
                "example_count": len(coded_rows),
                "reason": (
                    f"Matches {len(overlap)} term(s)"
                    + (f" and {len(coded_rows)} previous coded example(s)" if coded_rows else "")
                ),
            })

        suggestions.sort(key=lambda s: (s["confidence"], s["example_count"]), reverse=True)
        return suggestions[:max(1, min(limit, 20))]


def auto_code_annotation(annotation_id: int, project_id: Optional[int] = None, min_confidence: float = 0.85) -> Dict:
    suggestions = suggest_themes_for_annotation(annotation_id, project_id=project_id, limit=10)
    accepted = [s for s in suggestions if s["confidence"] >= min_confidence]
    if not accepted:
        return {"applied": [], "suggestions": suggestions}

    with get_connection() as conn:
        for s in accepted:
            conn.execute(
                "INSERT OR IGNORE INTO annotation_tags (annotation_id, tag_id) VALUES (?, ?)",
                (annotation_id, s["tag_id"]),
            )
    return {"applied": accepted, "suggestions": suggestions}
