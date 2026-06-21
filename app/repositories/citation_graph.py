"""Persistent citation graph extraction and map queries."""

import json
import re
from difflib import SequenceMatcher
from typing import Any, Dict, List, Optional, Tuple

from app.crossref import fetch_crossref_references, normalize_doi
from app.repositories.core import get_connection


_DOI_RE = re.compile(r"\b10\.\d{4,9}/[^\s\"'<>]+", re.IGNORECASE)
_REFERENCE_HEADING_RE = re.compile(
    r"(?im)^\s*(references|bibliography|works\s+cited|literature\s+cited)\s*$"
)
_REFERENCE_STOP_RE = re.compile(
    r"(?im)^\s*(appendix|appendices|supplementary|supporting\s+information|acknowledg(e)?ments?)\s*$"
)


def _normalize_title(value: str) -> str:
    text = (value or "").lower()
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _first_author_from_creators(raw: Any) -> str:
    try:
        creators = json.loads(raw) if isinstance(raw, str) else raw
    except Exception:
        creators = []
    if not isinstance(creators, list) or not creators:
        return ""
    creator = creators[0] if isinstance(creators[0], dict) else {}
    name = (
        creator.get("lastName")
        or creator.get("last_name")
        or creator.get("family")
        or creator.get("name")
        or ""
    )
    return re.sub(r"[^a-z0-9]+", "", str(name).lower())


def _first_author_display(raw: Any) -> str:
    try:
        creators = json.loads(raw) if isinstance(raw, str) else (raw or [])
    except Exception:
        creators = []
    if not isinstance(creators, list) or not creators:
        return ""
    creator = creators[0] if isinstance(creators[0], dict) else {}
    name = (
        creator.get("lastName")
        or creator.get("last_name")
        or creator.get("family")
        or creator.get("name")
        or ""
    )
    return str(name).strip()


def _extract_doi(reference: Dict[str, Any]) -> str:
    direct = normalize_doi(str(reference.get("DOI") or reference.get("doi") or ""))
    if direct:
        return direct.lower()
    raw = str(reference.get("unstructured") or reference.get("key") or "")
    match = _DOI_RE.search(raw)
    return normalize_doi(match.group(0)).lower() if match else ""


def _extract_year(reference: Dict[str, Any]) -> str:
    year = str(reference.get("year") or "").strip()
    if year:
        return year[:4]
    raw = str(reference.get("unstructured") or "")
    match = re.search(r"\b(19|20)\d{2}\b", raw)
    return match.group(0) if match else ""


def _extract_title(reference: Dict[str, Any]) -> str:
    for key in ("article-title", "volume-title", "series-title"):
        value = str(reference.get(key) or "").strip()
        if value:
            return re.sub(r"\s+", " ", value)
    return ""


def _extract_author(reference: Dict[str, Any]) -> str:
    author = str(reference.get("author") or "").strip()
    if author:
        return author
    raw = str(reference.get("unstructured") or "")
    return raw.split(".", 1)[0][:120].strip() if raw else ""


def _raw_reference(reference: Dict[str, Any]) -> str:
    if reference.get("unstructured"):
        return str(reference.get("unstructured") or "")
    return json.dumps(reference, ensure_ascii=False)


def _reference_from_parsed_row(row: Dict[str, Any]) -> Dict[str, Any]:
    ref: Dict[str, Any] = {
        "DOI": row.get("cited_doi") or "",
        "article-title": row.get("cited_title") or "",
        "year": row.get("cited_year") or "",
        "author": row.get("cited_author") or "",
        "unstructured": row.get("raw_reference") or "",
    }
    return {k: v for k, v in ref.items() if v}


def list_graph_source_items(source_dir: str = "") -> List[Dict[str, Any]]:
    with get_connection() as conn:
        params: List[Any] = []
        where = """WHERE (
            COALESCE(i.doi, '') != ''
            OR LOWER(COALESCE(i.file_path, '')) LIKE '%.pdf'
            OR EXISTS (
                SELECT 1 FROM files f
                WHERE f.item_key = i.item_key
                  AND LOWER(COALESCE(f.file_path, '')) LIKE '%.pdf'
            )
        )"""
        if source_dir:
            where += " AND i.source_dir = ?"
            params.append(source_dir)
        rows = conn.execute(
            f"""SELECT i.item_key, i.title, i.year, i.doi, i.creators, i.source_dir, i.citation_count, i.file_path
                FROM items i
                {where}
                ORDER BY COALESCE(i.year, ''), COALESCE(i.title, '')""",
            params,
        ).fetchall()
        return [dict(row) for row in rows]


def _all_local_items() -> List[Dict[str, Any]]:
    with get_connection() as conn:
        rows = conn.execute(
            """SELECT item_key, title, year, doi, creators, source_dir, citation_count, file_path
               FROM items"""
        ).fetchall()
        return [dict(row) for row in rows]


def build_match_index() -> Dict[str, Any]:
    items = _all_local_items()
    doi_index: Dict[str, Dict[str, Any]] = {}
    title_items: List[Dict[str, Any]] = []
    by_key: Dict[str, Dict[str, Any]] = {}
    for item in items:
        by_key[item["item_key"]] = item
        doi = normalize_doi(item.get("doi") or "").lower()
        if doi and doi not in doi_index:
            doi_index[doi] = item
        title_norm = _normalize_title(item.get("title") or "")
        if title_norm:
            title_items.append({
                **item,
                "_title_norm": title_norm,
                "_first_author_norm": _first_author_from_creators(item.get("creators")),
            })
    return {"doi": doi_index, "titles": title_items, "by_key": by_key}


def match_reference_to_local_item(
    reference: Dict[str, Any],
    source_item_key: str,
    match_index: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    doi = _extract_doi(reference)
    if doi:
        item = match_index["doi"].get(doi)
        if item and item["item_key"] != source_item_key:
            return {"item": item, "method": "doi", "confidence": 0.99}

    title = _extract_title(reference)
    title_norm = _normalize_title(title)
    raw = _raw_reference(reference)
    raw_norm = _normalize_title(raw)

    year = _extract_year(reference)
    author_norm = re.sub(r"[^a-z0-9]+", "", _extract_author(reference).lower())
    best: Optional[Tuple[float, Dict[str, Any]]] = None

    if title_norm and len(title_norm) >= 16:
        for item in match_index["titles"]:
            if item["item_key"] == source_item_key:
                continue
            item_year = str(item.get("year") or "").strip()[:4]
            if year and item_year and year != item_year:
                continue
            ratio = SequenceMatcher(None, title_norm, item["_title_norm"]).ratio()
            if ratio < 0.94:
                continue
            if author_norm and item["_first_author_norm"] and item["_first_author_norm"] not in author_norm:
                # With no DOI, keep title-only matches very strict.
                if ratio < 0.985:
                    continue
            if not best or ratio > best[0]:
                best = (ratio, item)

    if best:
        return {"item": best[1], "method": "title_year", "confidence": min(0.97, best[0])}

    if raw_norm:
        best_contains: Optional[Tuple[float, Dict[str, Any]]] = None
        for item in match_index["titles"]:
            if item["item_key"] == source_item_key:
                continue
            item_title = item["_title_norm"]
            if len(item_title) < 24 or len(item_title.split()) < 4:
                continue
            item_year = str(item.get("year") or "").strip()[:4]
            if year and item_year and year != item_year:
                continue
            if item_title in raw_norm:
                confidence = 0.94 if year and item_year else 0.90
                if author_norm and item["_first_author_norm"] and item["_first_author_norm"] in author_norm:
                    confidence += 0.02
                if not best_contains or confidence > best_contains[0]:
                    best_contains = (min(0.96, confidence), item)
        if best_contains:
            return {"item": best_contains[1], "method": "raw_title", "confidence": best_contains[0]}
    return None


def create_graph_job(job_id: str, source_dir: str, total_items: int) -> None:
    with get_connection() as conn:
        conn.execute(
            """INSERT INTO citation_graph_jobs
               (job_id, source_dir, status, total_items, processed_items)
               VALUES (?, ?, 'running', ?, 0)""",
            (job_id, source_dir or "", total_items),
        )


def update_graph_job(job_id: str, processed: int, references_found: int, edges_created: int) -> None:
    with get_connection() as conn:
        conn.execute(
            """UPDATE citation_graph_jobs
               SET processed_items = ?, references_found = ?, edges_created = ?
               WHERE job_id = ?""",
            (processed, references_found, edges_created, job_id),
        )


def finish_graph_job(job_id: str, status: str = "completed", error: str = "") -> None:
    with get_connection() as conn:
        conn.execute(
            """UPDATE citation_graph_jobs
               SET status = ?, error = ?, finished_at = CURRENT_TIMESTAMP
               WHERE job_id = ?""",
            (status, error, job_id),
        )


def get_latest_graph_job(source_dir: str = "") -> Optional[Dict[str, Any]]:
    with get_connection() as conn:
        row = conn.execute(
            """SELECT * FROM citation_graph_jobs
               WHERE source_dir = ?
               ORDER BY started_at DESC
               LIMIT 1""",
            (source_dir or "",),
        ).fetchone()
        return dict(row) if row else None


def get_graph_status(source_dir: str = "") -> Dict[str, Any]:
    latest = get_latest_graph_job(source_dir)
    with get_connection() as conn:
        params: List[Any] = []
        item_where = """WHERE (
            COALESCE(i.doi, '') != ''
            OR LOWER(COALESCE(i.file_path, '')) LIKE '%.pdf'
            OR EXISTS (
                SELECT 1 FROM files f
                WHERE f.item_key = i.item_key
                  AND LOWER(COALESCE(f.file_path, '')) LIKE '%.pdf'
            )
        )"""
        if source_dir:
            item_where += " AND i.source_dir = ?"
            params.append(source_dir)
        total_items = conn.execute(f"SELECT COUNT(*) FROM items i {item_where}", params).fetchone()[0]

        if source_dir:
            indexed_count = conn.execute(
                "SELECT COUNT(*) FROM citation_graph_item_status WHERE source_dir = ? AND status IN ('completed', 'no_references', 'no_doi', 'error')",
                (source_dir,),
            ).fetchone()[0]
            edge_count = conn.execute(
                "SELECT COUNT(*) FROM citation_edges e WHERE e.source_dir = ?",
                (source_dir,),
            ).fetchone()[0]
        else:
            indexed_count = conn.execute(
                "SELECT COUNT(*) FROM citation_graph_item_status WHERE status IN ('completed', 'no_references', 'no_doi', 'error')"
            ).fetchone()[0]
            edge_count = conn.execute("SELECT COUNT(*) FROM citation_edges").fetchone()[0]

    status = "not_indexed"
    if latest and latest.get("status") == "running":
        status = "indexing"
    elif latest and latest.get("status") == "error":
        status = "error"
    elif indexed_count > 0 or edge_count > 0:
        status = "stale" if indexed_count < total_items else "ready"
    return {
        "status": status,
        "latest_job": latest,
        "source_dir": source_dir or "",
        "total_items": total_items,
        "indexed_items": indexed_count,
        "edge_count": edge_count,
    }


def _store_references(
    conn,
    item_key: str,
    references: List[Dict[str, Any]],
    provider: str,
    start_index: int = 0,
) -> int:
    stored = 0
    for offset, reference in enumerate(references):
        parsed = {
            "source_item_key": item_key,
            "ref_index": start_index + offset,
            "raw_reference": _raw_reference(reference),
            "cited_doi": _extract_doi(reference),
            "cited_title": _extract_title(reference),
            "cited_year": _extract_year(reference),
            "cited_author": _extract_author(reference),
            "provider": provider,
            "confidence": 0.0,
        }
        conn.execute(
            """INSERT INTO parsed_references
               (source_item_key, ref_index, raw_reference, cited_doi, cited_title,
                cited_year, cited_author, provider, confidence)
               VALUES (:source_item_key, :ref_index, :raw_reference, :cited_doi,
                       :cited_title, :cited_year, :cited_author, :provider, :confidence)""",
            parsed,
        )
        stored += 1
    return stored


def _rematch_item_references(item: Dict[str, Any], match_index: Dict[str, Any]) -> Dict[str, int]:
    item_key = item["item_key"]
    source_dir = item.get("source_dir") or ""
    with get_connection() as conn:
        conn.execute("DELETE FROM citation_edges WHERE source_item_key = ?", (item_key,))
        rows = conn.execute(
            """SELECT * FROM parsed_references
               WHERE source_item_key = ?
               ORDER BY ref_index, reference_id""",
            (item_key,),
        ).fetchall()
        edges = 0
        providers = set()
        for row in rows:
            row_dict = dict(row)
            providers.add(row_dict.get("provider") or "")
            reference = _reference_from_parsed_row(row_dict)
            match = match_reference_to_local_item(reference, item_key, match_index)
            confidence = float(match["confidence"]) if match else 0.0
            conn.execute(
                "UPDATE parsed_references SET confidence = ? WHERE reference_id = ?",
                (confidence, row_dict["reference_id"]),
            )
            if match:
                conn.execute(
                    """INSERT OR IGNORE INTO citation_edges
                       (source_item_key, target_item_key, reference_id, source_dir,
                        match_method, confidence, provider)
                       VALUES (?, ?, ?, ?, ?, ?, ?)""",
                    (
                        item_key,
                        match["item"]["item_key"],
                        row_dict["reference_id"],
                        source_dir,
                        match["method"],
                        match["confidence"],
                        row_dict.get("provider") or "cached",
                    ),
                )
                edges += 1
        provider_label = ",".join(sorted(p for p in providers if p)) or "cached"
        status = "completed" if rows else "no_references"
        conn.execute(
            """INSERT OR REPLACE INTO citation_graph_item_status
               (item_key, source_dir, provider, status, reference_count, matched_count, last_indexed_at, error)
               VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, '')""",
            (item_key, source_dir, provider_label, status, len(rows), edges),
        )
    return {"references": len(rows), "edges": edges}


def _cached_reference_count(item_key: str) -> int:
    with get_connection() as conn:
        return conn.execute(
            "SELECT COUNT(*) FROM parsed_references WHERE source_item_key = ?",
            (item_key,),
        ).fetchone()[0]


def _has_provider_refs(item_key: str, provider: str) -> bool:
    with get_connection() as conn:
        return conn.execute(
            "SELECT 1 FROM parsed_references WHERE source_item_key = ? AND provider = ? LIMIT 1",
            (item_key, provider),
        ).fetchone() is not None


def _item_graph_status(item_key: str) -> Optional[Dict[str, Any]]:
    with get_connection() as conn:
        row = conn.execute(
            "SELECT * FROM citation_graph_item_status WHERE item_key = ?",
            (item_key,),
        ).fetchone()
        return dict(row) if row else None


def _fulltext_for_item(item_key: str) -> str:
    with get_connection() as conn:
        page_rows = conn.execute(
            """SELECT text FROM fulltext_pages
               WHERE item_key = ?
               ORDER BY page_index""",
            (item_key,),
        ).fetchall()
        if page_rows:
            return "\n".join(row["text"] or "" for row in page_rows)
        row = conn.execute(
            "SELECT content FROM item_fulltext WHERE item_key = ? ORDER BY id DESC LIMIT 1",
            (item_key,),
        ).fetchone()
        return row["content"] if row and row["content"] else ""


def _extract_reference_section(text: str) -> str:
    if not text:
        return ""
    matches = list(_REFERENCE_HEADING_RE.finditer(text))
    if not matches:
        return ""
    midpoint = len(text) * 0.45
    match = next((m for m in reversed(matches) if m.start() >= midpoint), matches[-1])
    section = text[match.end():]
    stop = _REFERENCE_STOP_RE.search(section)
    if stop and stop.start() > 500:
        section = section[:stop.start()]
    return section[:80000]


def _split_reference_entries(section: str) -> List[str]:
    lines = [re.sub(r"\s+", " ", line).strip() for line in section.splitlines()]
    lines = [line for line in lines if line]
    entries: List[str] = []
    current: List[str] = []

    def starts_reference(line: str) -> bool:
        if re.match(r"^(\[\d+\]|\d{1,3}[\).])\s+", line):
            return True
        if re.match(r"^[A-Z][A-Za-z'\-]+,\s+[A-Z]", line) and re.search(r"\b(19|20)\d{2}\b", line[:180]):
            return True
        return False

    for line in lines:
        if starts_reference(line) and current and len(" ".join(current)) >= 45:
            entries.append(" ".join(current).strip())
            current = [line]
        else:
            current.append(line)
    if current:
        entries.append(" ".join(current).strip())

    if len(entries) <= 3:
        blob = "\n".join(lines)
        parts = re.split(r"(?=\n?(?:\[\d+\]|\d{1,3}[\).])\s+)", blob)
        entries = [re.sub(r"\s+", " ", p).strip() for p in parts if len(p.strip()) >= 45]

    cleaned = []
    seen = set()
    for entry in entries:
        entry = re.sub(r"^\s*(\[\d+\]|\d{1,3}[\).])\s*", "", entry).strip()
        if len(entry) < 45:
            continue
        key = entry[:180].lower()
        if key in seen:
            continue
        seen.add(key)
        cleaned.append(entry)
        if len(cleaned) >= 300:
            break
    return cleaned


def extract_pdf_reference_entries(item_key: str) -> List[Dict[str, Any]]:
    text = _fulltext_for_item(item_key)
    section = _extract_reference_section(text)
    if not section:
        return []
    references = []
    for entry in _split_reference_entries(section):
        references.append({
            "unstructured": entry,
            "DOI": _extract_doi({"unstructured": entry}),
            "year": _extract_year({"unstructured": entry}),
            "author": _extract_author({"unstructured": entry}),
        })
    return references


def index_item_references(
    item: Dict[str, Any],
    match_index: Dict[str, Any],
    force_fetch: bool = False,
) -> Dict[str, int]:
    item_key = item["item_key"]
    source_dir = item.get("source_dir") or ""
    doi = normalize_doi(item.get("doi") or "")

    cached_count = _cached_reference_count(item_key)
    if cached_count and not force_fetch:
        result = _rematch_item_references(item, match_index)
        if result["edges"] == 0 and not _has_provider_refs(item_key, "pdf_references"):
            pdf_refs = extract_pdf_reference_entries(item_key)
            if pdf_refs:
                with get_connection() as conn:
                    start_index = conn.execute(
                        "SELECT COUNT(*) FROM parsed_references WHERE source_item_key = ?",
                        (item_key,),
                    ).fetchone()[0]
                    _store_references(conn, item_key, pdf_refs, "pdf_references", start_index)
                result = _rematch_item_references(item, match_index)
        return result

    existing_status = _item_graph_status(item_key)
    if (
        existing_status
        and not force_fetch
        and existing_status.get("status") == "no_references"
        and "pdf_references" in (existing_status.get("provider") or "")
    ):
        return {"references": 0, "edges": 0}

    with get_connection() as conn:
        if force_fetch:
            conn.execute("DELETE FROM citation_edges WHERE source_item_key = ?", (item_key,))
            conn.execute("DELETE FROM parsed_references WHERE source_item_key = ?", (item_key,))

    references: List[Dict[str, Any]] = []
    if doi:
        references = fetch_crossref_references(doi) or []
        if references:
            with get_connection() as conn:
                _store_references(conn, item_key, references, "crossref", 0)

    result = _rematch_item_references(item, match_index)

    pdf_attempted = False
    if (not references or len(references) < 5 or result["edges"] == 0) and not _has_provider_refs(item_key, "pdf_references"):
        pdf_attempted = True
        pdf_refs = extract_pdf_reference_entries(item_key)
        if pdf_refs:
            with get_connection() as conn:
                start_index = conn.execute(
                    "SELECT COUNT(*) FROM parsed_references WHERE source_item_key = ?",
                    (item_key,),
                ).fetchone()[0]
                _store_references(conn, item_key, pdf_refs, "pdf_references", start_index)
            result = _rematch_item_references(item, match_index)

    if result["references"] == 0:
        provider = "crossref,pdf_references" if doi and pdf_attempted else ("crossref" if doi else "pdf_references")
        with get_connection() as conn:
            conn.execute(
                """INSERT OR REPLACE INTO citation_graph_item_status
                   (item_key, source_dir, provider, status, reference_count, matched_count, last_indexed_at, error)
                   VALUES (?, ?, ?, 'no_references', 0, 0, CURRENT_TIMESTAMP, '')""",
                (item_key, source_dir, provider),
            )
    return result


def get_citation_graph_map(
    source_dir: str = "",
    include_outside: bool = True,
    min_confidence: float = 0.85,
    limit: int = 500,
) -> Dict[str, Any]:
    params: List[Any] = [min_confidence]
    where = "WHERE e.confidence >= ?"
    if source_dir:
        where += " AND e.source_dir = ?"
        params.append(source_dir)

    with get_connection() as conn:
        edge_rows = conn.execute(
            f"""SELECT e.*, 
                       s.title AS source_title, s.year AS source_year, s.citation_count AS source_citation_count, s.source_dir AS source_source_dir,
                       t.title AS target_title, t.year AS target_year, t.citation_count AS target_citation_count, t.source_dir AS target_source_dir
                FROM citation_edges e
                JOIN items s ON s.item_key = e.source_item_key
                JOIN items t ON t.item_key = e.target_item_key
                {where}
                ORDER BY e.confidence DESC, e.created_at DESC
                LIMIT ?""",
            (*params, max(1, min(int(limit) * 4, 4000))),
        ).fetchall()

    raw_edges = [dict(row) for row in edge_rows]
    if source_dir and not include_outside:
        raw_edges = [row for row in raw_edges if row.get("target_source_dir") == source_dir]

    node_keys = set()
    for edge in raw_edges:
        node_keys.add(edge["source_item_key"])
        node_keys.add(edge["target_item_key"])

    with get_connection() as conn:
        # Always include all indexed papers from the selected directory so the
        # graph is never empty when "Other Directory" is unchecked — papers
        # still appear as nodes even if they have no same-directory edges.
        if source_dir:
            dir_rows = conn.execute(
                """SELECT i.item_key FROM items i
                   WHERE i.source_dir = ?
                     AND EXISTS (
                         SELECT 1 FROM citation_graph_item_status s
                         WHERE s.item_key = i.item_key
                     )""",
                (source_dir,),
            ).fetchall()
            for r in dir_rows:
                node_keys.add(r["item_key"])

        if not node_keys:
            return {"nodes": [], "edges": [], "summary": {"node_count": 0, "edge_count": 0}}

        placeholders = ",".join("?" for _ in node_keys)
        rows = conn.execute(
            f"""SELECT i.item_key, i.title, i.year, i.creators, i.doi, i.source_dir,
                       i.citation_count, COALESCE(ia.reading_status, '') AS reading_status
                FROM items i
                LEFT JOIN item_activity ia ON ia.item_key = i.item_key
                WHERE i.item_key IN ({placeholders})""",
            tuple(node_keys),
        ).fetchall()
        items = {row["item_key"]: dict(row) for row in rows}

    indegree: Dict[str, int] = {}
    outdegree: Dict[str, int] = {}
    pair_counts: Dict[Tuple[str, str], Dict[str, Any]] = {}
    for edge in raw_edges:
        pair = (edge["source_item_key"], edge["target_item_key"])
        current = pair_counts.get(pair)
        if not current:
            current = {
                "source": pair[0],
                "target": pair[1],
                "weight": 0,
                "confidence": 0.0,
                "match_method": edge.get("match_method", ""),
                "provider": edge.get("provider", "crossref"),
            }
            pair_counts[pair] = current
        current["weight"] += 1
        current["confidence"] = max(current["confidence"], float(edge.get("confidence") or 0))
        indegree[pair[1]] = indegree.get(pair[1], 0) + 1
        outdegree[pair[0]] = outdegree.get(pair[0], 0) + 1

    nodes = []
    for key, item in items.items():
        in_selected = not source_dir or item.get("source_dir") == source_dir
        nodes.append({
            "item_key": key,
            "title": item.get("title") or "Untitled",
            "year": _safe_year(item.get("year")),
            "citation_count": _safe_int(item.get("citation_count")),
            "local_cited_by": indegree.get(key, 0),
            "local_references": outdegree.get(key, 0),
            "degree": indegree.get(key, 0) + outdegree.get(key, 0),
            "source_dir": item.get("source_dir") or "",
            "in_selected_dir": in_selected,
            "reading_status": item.get("reading_status") or "",
            "doi": item.get("doi") or "",
            "first_author": _first_author_display(item.get("creators")),
        })
    nodes.sort(key=lambda n: (not n["in_selected_dir"], -(n["local_cited_by"]), n["year"] or 9999, n["title"]))
    nodes = nodes[: max(1, min(int(limit), 1000))]
    allowed = {node["item_key"] for node in nodes}
    edges = [edge for edge in pair_counts.values() if edge["source"] in allowed and edge["target"] in allowed]

    return {
        "nodes": nodes,
        "edges": edges,
        "summary": {
            "node_count": len(nodes),
            "edge_count": len(edges),
            "source_dir": source_dir or "",
            "include_outside": include_outside,
            "min_confidence": min_confidence,
        },
    }


def _safe_int(value: Any) -> int:
    try:
        return int(value or 0)
    except Exception:
        return 0


def _safe_year(value: Any) -> int:
    match = re.search(r"\b(19|20)\d{2}\b", str(value or ""))
    return int(match.group(0)) if match else 0
