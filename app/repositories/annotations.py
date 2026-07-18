"""Annotation and tag persistence."""

from pathlib import Path
from typing import Any, Dict, List, Optional

from app.repositories.core import get_connection


def _tags_by_annotation_ids(conn, annotation_ids: List[int]) -> Dict[int, List[Dict]]:
    if not annotation_ids:
        return {}
    placeholders = ",".join("?" for _ in annotation_ids)
    rows = conn.execute(
        f"""SELECT at.annotation_id, t.tag_id, t.name, t.color
            FROM annotation_tags at
            JOIN tags t ON t.tag_id = at.tag_id
            WHERE at.annotation_id IN ({placeholders})
            ORDER BY t.name""",
        annotation_ids,
    ).fetchall()
    tags_by_annotation: Dict[int, List[Dict]] = {}
    for row in rows:
        tags_by_annotation.setdefault(row["annotation_id"], []).append({
            "tag_id": row["tag_id"],
            "name": row["name"],
            "color": row["color"],
        })
    return tags_by_annotation


def get_annotation(annotation_id: int) -> Optional[Dict]:
    """Return a single annotation with its tags, or None if it does not exist."""
    with get_connection() as conn:
        row = conn.execute(
            "SELECT * FROM annotations WHERE annotation_id = ?",
            (annotation_id,),
        ).fetchone()
        if not row:
            return None
        annotation = dict(row)
        annotation["tags"] = _tags_by_annotation_ids(conn, [annotation_id]).get(annotation_id, [])
        return annotation


def get_annotations_for_item(item_key: str) -> List[Dict]:
    with get_connection() as conn:
        rows = conn.execute(
            """SELECT * FROM annotations
               WHERE item_key = ?
               ORDER BY page_index, created_at""",
            (item_key,),
        ).fetchall()
        tags_by_annotation = _tags_by_annotation_ids(conn, [row["annotation_id"] for row in rows])
        results = []
        for row in rows:
            annotation = dict(row)
            annotation["tags"] = tags_by_annotation.get(annotation["annotation_id"], [])
            results.append(annotation)
        return results


def get_all_annotations_for_synthesis() -> List[Dict]:
    """Return all annotations across all items, enriched with item title and tags."""
    with get_connection() as conn:
        rows = conn.execute(
            """SELECT a.*, i.title as item_title, i.year as item_year
               FROM annotations a
               LEFT JOIN items i ON i.item_key = a.item_key
               ORDER BY a.item_key, a.page_index, a.created_at"""
        ).fetchall()
        tags_by_annotation = _tags_by_annotation_ids(conn, [row["annotation_id"] for row in rows])
        results = []
        for row in rows:
            annotation = dict(row)
            annotation["tags"] = tags_by_annotation.get(annotation["annotation_id"], [])
            results.append(annotation)
        return results


def get_all_tags() -> List[Dict]:
    with get_connection() as conn:
        rows = conn.execute(
            """SELECT t.tag_id, t.name, t.color, t.parent_id,
                      t.description, t.inclusion_criteria, t.exclusion_criteria,
                      COUNT(at.annotation_id)          AS annotation_count,
                      COUNT(DISTINCT a.item_key)        AS source_count
               FROM tags t
               LEFT JOIN annotation_tags at ON at.tag_id = t.tag_id
               LEFT JOIN annotations a      ON a.annotation_id = at.annotation_id
               WHERE t.tag_type = 'theme'
               GROUP BY t.tag_id
               ORDER BY t.parent_id NULLS FIRST, t.name"""
        ).fetchall()
        return [dict(row) for row in rows]


def create_tag(name: str, color: str = "", parent_id: Optional[int] = None, tag_type: str = "theme") -> int:
    normalized = name.lower().strip()
    with get_connection() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO tags (name, normalized_name, color, parent_id, tag_type) VALUES (?, ?, ?, ?, ?)",
            (name.strip(), normalized, color, parent_id, tag_type),
        )
        row = conn.execute(
            "SELECT tag_id FROM tags WHERE normalized_name = ?",
            (normalized,),
        ).fetchone()
        return row["tag_id"] if row else 0


def update_tag(tag_id: int, name: str, color: str, parent_id: Optional[int] = None) -> None:
    normalized = name.lower().strip()
    with get_connection() as conn:
        conn.execute(
            "UPDATE tags SET name = ?, normalized_name = ?, color = ?, parent_id = ? WHERE tag_id = ?",
            (name.strip(), normalized, color, parent_id, tag_id),
        )


def delete_tag(tag_id: int) -> bool:
    with get_connection() as conn:
        cursor = conn.execute("DELETE FROM tags WHERE tag_id = ?", (tag_id,))
        return cursor.rowcount > 0


def get_item_keywords(item_key: str) -> List[str]:
    """Return metadata keyword tags for a library item (tag_type='keyword')."""
    with get_connection() as conn:
        rows = conn.execute(
            """SELECT t.name FROM tags t
               JOIN item_tags it ON it.tag_id = t.tag_id
               WHERE it.item_key = ? AND t.tag_type = 'keyword'
               ORDER BY t.name""",
            (item_key,),
        ).fetchall()
        return [row["name"] for row in rows]


def get_tags_for_annotation(annotation_id: int) -> List[Dict]:
    with get_connection() as conn:
        rows = conn.execute(
            """SELECT t.tag_id, t.name, t.color, t.parent_id FROM tags t
               JOIN annotation_tags at ON at.tag_id = t.tag_id
               WHERE at.annotation_id = ? AND t.tag_type = 'theme'
               ORDER BY t.name""",
            (annotation_id,),
        ).fetchall()
        return [dict(row) for row in rows]


def set_annotation_tags(annotation_id: int, tag_ids: List[int]) -> None:
    with get_connection() as conn:
        conn.execute(
            "DELETE FROM annotation_tags WHERE annotation_id = ?",
            (annotation_id,),
        )
        for tag_id in tag_ids:
            conn.execute(
                "INSERT OR IGNORE INTO annotation_tags (annotation_id, tag_id) VALUES (?, ?)",
                (annotation_id, tag_id),
            )


def create_annotation(data: Dict[str, Any]) -> int:
    with get_connection() as conn:
        conn.execute("PRAGMA foreign_keys=OFF")
        cursor = conn.execute(
            """INSERT INTO annotations
               (item_key, file_id, page_index, annotation_type, color, quote, comment, geometry_json, source_chunk_id, sentiment)
               VALUES (:item_key, :file_id, :page_index, :annotation_type, :color, :quote, :comment, :geometry_json, :source_chunk_id, :sentiment)""",
            {**data, "sentiment": data.get("sentiment")},
        )
        conn.execute("PRAGMA foreign_keys=ON")
        return cursor.lastrowid


def import_item_annotations(item_key: str) -> Dict[str, Any]:
    """
    Import annotations embedded in the item's PDF file into the annotations table.
    Skips any annotation whose source_chunk_id hash already exists (idempotent).
    """
    from app.database import get_item_v2
    from app.local_scanner import extract_pdf_annotations

    item = get_item_v2(item_key)
    if not item:
        return {"imported": 0, "skipped": 0, "total_in_pdf": 0, "error": "Item not found"}

    files = item.get("files") or []
    primary = next((file_info for file_info in files if file_info.get("is_primary")), files[0] if files else None)
    file_path_str = (primary or {}).get("file_path") or item.get("file_path")
    file_id = (primary or {}).get("file_id")

    if not file_path_str:
        return {"imported": 0, "skipped": 0, "total_in_pdf": 0, "error": "No file path stored"}

    file_path = Path(file_path_str)
    if file_path.suffix.lower() != ".pdf":
        return {"imported": 0, "skipped": 0, "total_in_pdf": 0, "error": "Not a PDF file"}
    if not file_path.exists():
        return {"imported": 0, "skipped": 0, "total_in_pdf": 0, "error": f"File not found on disk: {file_path.name}"}

    annotations = extract_pdf_annotations(file_path)
    total = len(annotations)
    if total == 0:
        return {"imported": 0, "skipped": 0, "total_in_pdf": 0, "error": None}

    imported = 0
    skipped = 0

    with get_connection() as conn:
        existing = {
            row[0]
            for row in conn.execute(
                "SELECT source_chunk_id FROM annotations WHERE item_key = ? AND source_chunk_id LIKE 'imported:%'",
                (item_key,),
            ).fetchall()
        }

        for annotation in annotations:
            if annotation["source_chunk_id"] in existing:
                skipped += 1
                continue
            conn.execute("PRAGMA foreign_keys=OFF")
            conn.execute(
                """INSERT INTO annotations
                   (item_key, file_id, page_index, annotation_type, color, quote, comment,
                    geometry_json, source_chunk_id, sentiment)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    item_key, file_id,
                    annotation["page_index"], annotation["annotation_type"],
                    annotation["color"], annotation["quote"], annotation["comment"],
                    annotation["geometry_json"], annotation["source_chunk_id"], annotation["sentiment"],
                ),
            )
            conn.execute("PRAGMA foreign_keys=ON")
            imported += 1

    return {"imported": imported, "skipped": skipped, "total_in_pdf": total, "error": None}


def mark_annotation_hidden_from_list(annotation_id: int) -> None:
    """Flag an annotation as hidden from the Annotations tab list.

    Used when a chat-created highlight becomes the target of an ink connection:
    the highlight itself, and the ink line pointing to it, still need to exist
    and render — only its row in the Annotations list is suppressed, since the
    user asked for an ink connection, not a highlight.
    """
    with get_connection() as conn:
        conn.execute(
            "UPDATE annotations SET hidden_from_list = 1 WHERE annotation_id = ?",
            (annotation_id,),
        )


def update_annotation(annotation_id: int, data: Dict[str, Any]) -> None:
    with get_connection() as conn:
        conn.execute(
            """UPDATE annotations
               SET annotation_type = :annotation_type,
                   color = :color,
                   quote = :quote,
                   comment = :comment,
                   page_index = COALESCE(:page_index, page_index),
                   geometry_json = :geometry_json,
                   sentiment = :sentiment,
                   updated_at = CURRENT_TIMESTAMP
               WHERE annotation_id = :annotation_id""",
            {
                **data,
                "annotation_id": annotation_id,
                "page_index": data.get("page_index"),
                "sentiment": data.get("sentiment"),
            },
        )


def delete_annotation(annotation_id: int) -> bool:
    with get_connection() as conn:
        cursor = conn.execute(
            "DELETE FROM annotations WHERE annotation_id = ?",
            (annotation_id,),
        )
        return cursor.rowcount > 0
