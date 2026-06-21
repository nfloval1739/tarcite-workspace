"""Library health checks for maintenance workflows."""

import json
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

from app.config import config
from app.repositories.core import get_connection


HEALTH_UNINDEXED_EXTENSIONS = {".pdf"}


def _normalize_doi(value: str) -> str:
    doi = (value or "").strip().lower()
    doi = re.sub(r"^https?://(?:dx\.)?doi\.org/", "", doi)
    return doi.strip()


def _normalize_title(value: str) -> str:
    text = (value or "").lower()
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _first_author(creators_raw: Any) -> str:
    try:
        creators = json.loads(creators_raw) if isinstance(creators_raw, str) else creators_raw
    except Exception:
        creators = []
    if not creators:
        return ""
    creator = creators[0] if isinstance(creators, list) else {}
    if isinstance(creator, dict):
        name = creator.get("lastName") or creator.get("last_name") or creator.get("name") or creator.get("creator") or ""
        if not name:
            first = creator.get("firstName") or creator.get("first_name") or ""
            last = creator.get("lastName") or creator.get("last_name") or ""
            name = f"{first} {last}".strip()
        return re.sub(r"[^a-z0-9]+", "", name.lower())
    return re.sub(r"[^a-z0-9]+", "", str(creator).lower())


def _item_summary(row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "item_key": row.get("item_key", ""),
        "title": row.get("title", "") or "Untitled",
        "year": row.get("year", "") or "",
        "doi": row.get("doi", "") or "",
        "creators": row.get("creators", "") or "",
        "file_path": row.get("file_path", "") or "",
        "source_dir": row.get("source_dir", "") or "",
        "synced_at": row.get("synced_at", "") or "",
    }


def _dedupe_groups(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    grouped: Dict[Tuple[str, str], List[Dict[str, Any]]] = {}

    for item in items:
        doi = _normalize_doi(item.get("doi", ""))
        title = _normalize_title(item.get("title", ""))
        year = str(item.get("year") or "").strip()
        first_author = _first_author(item.get("creators", ""))

        keys: List[Tuple[str, str]] = []
        if doi:
            keys.append(("doi", doi))
        if title and year:
            keys.append(("title_year", f"{title}|{year}"))
        if title and first_author:
            keys.append(("title_author", f"{title}|{first_author}"))

        for key in keys:
            grouped.setdefault(key, []).append(item)

    seen_sets: Set[Tuple[str, ...]] = set()
    groups: List[Dict[str, Any]] = []
    for (match_type, match_value), matches in grouped.items():
        unique = {item["item_key"]: item for item in matches}
        if len(unique) < 2:
            continue
        keys = tuple(sorted(unique))
        if keys in seen_sets:
            continue
        seen_sets.add(keys)
        groups.append({
            "match_type": match_type,
            "match_value": match_value,
            "items": [_item_summary(item) for item in unique.values()],
        })

    groups.sort(key=lambda group: (-len(group["items"]), group["match_type"]))
    return groups


def _configured_dirs() -> List[Dict[str, str]]:
    dirs = []
    for entry in config.reference_dirs:
        path = entry.get("path") or ""
        if not path:
            continue
        try:
            normalized = str(Path(path).expanduser().resolve())
        except Exception:
            normalized = path
        dirs.append({
            "path": path,
            "label": entry.get("label", "") or Path(path).name or path,
            "normalized_path": normalized,
        })
    return dirs


def _source_dir_for_path(path: Path, dirs: List[Dict[str, str]]) -> str:
    try:
        resolved = path.expanduser().resolve()
    except Exception:
        resolved = path
    resolved_str = str(resolved)
    for directory in dirs:
        root = directory["normalized_path"]
        if resolved_str == root or resolved_str.startswith(root + "/") or resolved_str.startswith(root + "\\"):
            return root
    return ""


def _indexed_file_paths(rows: List[Dict[str, Any]]) -> Set[str]:
    paths = set()
    for row in rows:
        for key in ("file_path",):
            raw = row.get(key) or ""
            if not raw:
                continue
            try:
                paths.add(str(Path(raw).expanduser().resolve()))
            except Exception:
                paths.add(raw)
    return paths


def scan_library_health(max_unindexed_files: int = 500) -> Dict[str, Any]:
    """Compare library metadata, file paths, and text indexes."""
    dirs = _configured_dirs()
    with get_connection() as conn:
        item_rows = [dict(row) for row in conn.execute(
            """SELECT item_key, title, year, doi, creators, file_path, source_dir, synced_at
               FROM items
               ORDER BY COALESCE(title, ''), COALESCE(year, '')"""
        ).fetchall()]
        file_rows = [dict(row) for row in conn.execute(
            """SELECT f.item_key, f.file_path, f.file_name, f.file_ext, f.source_dir,
                      i.title, i.year, i.doi, i.creators, i.synced_at
               FROM files f
               LEFT JOIN items i ON i.item_key = f.item_key
               ORDER BY f.file_path"""
        ).fetchall()]
        no_index_rows = [dict(row) for row in conn.execute(
            """SELECT i.item_key, i.title, i.year, i.doi, i.creators, i.file_path, i.source_dir, i.synced_at,
                      COUNT(DISTINCT c.chunk_id) AS chunk_count,
                      COUNT(DISTINCT fts.rowid) AS fts_count
               FROM items i
               LEFT JOIN chunks c ON c.item_key = i.item_key
               LEFT JOIN chunks_fts fts ON fts.item_key = i.item_key
               WHERE LOWER(COALESCE(i.file_path, '')) LIKE '%.pdf'
               GROUP BY i.item_key
               HAVING chunk_count = 0 OR fts_count = 0
               ORDER BY i.synced_at DESC"""
        ).fetchall()]

    duplicates = _dedupe_groups(item_rows)

    all_file_refs = []
    seen_ref_keys = set()
    for row in item_rows:
        if row.get("file_path"):
            key = (row["item_key"], row["file_path"])
            if key not in seen_ref_keys:
                seen_ref_keys.add(key)
                all_file_refs.append({**row, "record_type": "item"})
    for row in file_rows:
        if row.get("file_path"):
            key = (row["item_key"], row["file_path"])
            if key not in seen_ref_keys:
                seen_ref_keys.add(key)
                all_file_refs.append({**row, "record_type": "file"})

    broken_paths = []
    for row in all_file_refs:
        raw_path = row.get("file_path") or ""
        if not raw_path:
            continue
        try:
            exists = Path(raw_path).expanduser().exists()
        except Exception:
            exists = False
        if not exists:
            broken_paths.append({
                **_item_summary(row),
                "record_type": row.get("record_type", ""),
                "file_name": row.get("file_name", "") or Path(raw_path).name,
                "file_ext": row.get("file_ext", "") or Path(raw_path).suffix.lstrip("."),
            })

    indexed_paths = _indexed_file_paths(item_rows) | _indexed_file_paths(file_rows)
    unindexed_files = []
    skipped_scan_dirs = []
    for directory in dirs:
        root = Path(directory["normalized_path"])
        if not root.exists() or not root.is_dir():
            skipped_scan_dirs.append(directory)
            continue
        try:
            candidates = [
                path for path in root.rglob("*")
                if path.is_file()
                and not path.name.startswith(".")
                and path.suffix.lower() in HEALTH_UNINDEXED_EXTENSIONS
            ]
        except Exception:
            skipped_scan_dirs.append(directory)
            continue
        for path in candidates:
            try:
                resolved = str(path.resolve())
            except Exception:
                resolved = str(path)
            if resolved in indexed_paths:
                continue
            unindexed_files.append({
                "file_path": resolved,
                "file_name": path.name,
                "file_ext": path.suffix.lstrip(".").lower(),
                "source_dir": directory["normalized_path"],
                "reason": "not_in_library",
            })
            if len(unindexed_files) >= max_unindexed_files:
                break
        if len(unindexed_files) >= max_unindexed_files:
            break

    indexed_without_chunks = []
    for row in no_index_rows:
        item = _item_summary(row)
        item.update({
            "file_name": Path(item.get("file_path", "")).name,
            "file_ext": Path(item.get("file_path", "")).suffix.lstrip(".").lower(),
            "chunk_count": row.get("chunk_count", 0) or 0,
            "fts_count": row.get("fts_count", 0) or 0,
            "reason": "missing_text_index",
        })
        indexed_without_chunks.append(item)

    summary = {
        "duplicate_groups": len(duplicates),
        "duplicate_items": sum(len(group["items"]) for group in duplicates),
        "broken_paths": len(broken_paths),
        "unindexed_files": len(unindexed_files),
        "indexed_without_chunks": len(indexed_without_chunks),
        "skipped_scan_dirs": len(skipped_scan_dirs),
    }
    summary["total_issues"] = (
        summary["duplicate_groups"]
        + summary["broken_paths"]
        + summary["unindexed_files"]
        + summary["indexed_without_chunks"]
    )

    return {
        "summary": summary,
        "duplicates": duplicates,
        "broken_paths": broken_paths,
        "unindexed_files": unindexed_files,
        "indexed_without_chunks": indexed_without_chunks,
        "skipped_scan_dirs": skipped_scan_dirs,
        "directories": dirs,
    }


def source_dir_for_file_path(file_path: str) -> Optional[str]:
    path = Path(file_path).expanduser()
    source_dir = _source_dir_for_path(path, _configured_dirs())
    return source_dir or None
