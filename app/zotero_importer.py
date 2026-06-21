"""
Zotero local library importer.
Reads ~/Zotero/zotero.sqlite (read-only) and converts the virtual collection
structure into a real folder hierarchy, copying PDFs in place and exporting
metadata as .ris files so the existing scanner can index them.
"""

import logging
import re
import shutil
import sqlite3
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger(__name__)

ProgressCallback = Optional[Callable[[str, str], None]]

_SAFE_NAME_RE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def _safe_name(name: str) -> str:
    name = _SAFE_NAME_RE.sub("_", name or "Untitled").strip(". ")
    return name[:120] or "Untitled"


def detect_zotero() -> Optional[str]:
    candidates = [
        Path.home() / "Zotero" / "zotero.sqlite",
        Path.home() / "Documents" / "Zotero" / "zotero.sqlite",
        Path("/Applications/Zotero.app/Contents/Resources/zotero.sqlite"),
    ]
    for p in candidates:
        if p.exists():
            return str(p)
    return None


def _open_zotero(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def _build_col_paths(conn: sqlite3.Connection) -> Dict[int, str]:
    """Return {collectionID: "Parent > Child > Grandchild"} with safe names."""
    cols = conn.execute(
        "SELECT collectionID, collectionName, parentCollectionID FROM collections"
    ).fetchall()
    col_map = {c["collectionID"]: dict(c) for c in cols}

    paths: Dict[int, str] = {}

    def _path(cid: int) -> str:
        if cid in paths:
            return paths[cid]
        row = col_map.get(cid)
        if not row:
            return ""
        name = _safe_name(row["collectionName"])
        parent = row["parentCollectionID"]
        if parent:
            parent_path = _path(parent)
            result = f"{parent_path}/{name}" if parent_path else name
        else:
            result = name
        paths[cid] = result
        return result

    for cid in col_map:
        _path(cid)

    return paths


def get_zotero_preview(db_path: str) -> Dict[str, Any]:
    """Return collection tree and total PDF count for the import preview UI."""
    conn = _open_zotero(db_path)

    total = conn.execute(
        "SELECT COUNT(*) FROM itemAttachments WHERE contentType='application/pdf' AND path LIKE 'storage:%'"
    ).fetchone()[0]

    cols = conn.execute(
        "SELECT collectionID, collectionName, parentCollectionID FROM collections ORDER BY collectionName"
    ).fetchall()

    counts_rows = conn.execute(
        """SELECT ci.collectionID, COUNT(DISTINCT ia.itemID) as n
           FROM collectionItems ci
           JOIN itemAttachments ia ON ia.parentItemID = ci.itemID
           WHERE ia.contentType='application/pdf' AND ia.path LIKE 'storage:%'
           GROUP BY ci.collectionID"""
    ).fetchall()
    count_map = {r["collectionID"]: r["n"] for r in counts_rows}

    conn.close()

    col_map: Dict[int, Dict] = {}
    for c in cols:
        col_map[c["collectionID"]] = {
            "id": c["collectionID"],
            "name": c["collectionName"],
            "parent_id": c["parentCollectionID"],
            "pdf_count": count_map.get(c["collectionID"], 0),
            "children": [],
        }

    roots: List[Dict] = []
    for col in col_map.values():
        pid = col["parent_id"]
        if pid and pid in col_map:
            col_map[pid]["children"].append(col)
        else:
            roots.append(col)

    roots.sort(key=lambda c: c["name"].lower())

    return {"total_pdfs": total, "collections": roots}


def _build_ris_entry(item: Dict, creators: List[Dict]) -> str:
    type_map = {
        "journalArticle": "JOUR",
        "book": "BOOK",
        "bookSection": "CHAP",
        "conferencePaper": "CPAPER",
        "thesis": "THES",
        "report": "RPRT",
        "webpage": "ELEC",
    }
    ris_type = type_map.get(item.get("item_type", ""), "JOUR")
    lines = [f"TY  - {ris_type}"]

    if item.get("title"):
        lines.append(f"TI  - {item['title']}")
    for cr in creators:
        last = cr.get("lastName", "")
        first = cr.get("firstName", "")
        name = f"{last}, {first}" if first else last
        if name.strip():
            lines.append(f"AU  - {name}")
    if item.get("date"):
        year = re.search(r"\b(19|20)\d{2}\b", item["date"] or "")
        if year:
            lines.append(f"PY  - {year.group()}")
    if item.get("journal"):
        lines.append(f"JO  - {item['journal']}")
    if item.get("volume"):
        lines.append(f"VL  - {item['volume']}")
    if item.get("issue"):
        lines.append(f"IS  - {item['issue']}")
    if item.get("pages"):
        lines.append(f"SP  - {item['pages']}")
    if item.get("doi"):
        lines.append(f"DO  - {item['doi']}")
    if item.get("url"):
        lines.append(f"UR  - {item['url']}")
    if item.get("abstract"):
        abstract = item["abstract"].replace("\n", " ")
        lines.append(f"AB  - {abstract}")
    lines.append("ER  - ")
    return "\n".join(lines)


def import_zotero_library(
    db_path: str,
    dest_path: str,
    progress_callback: ProgressCallback = None,
) -> Dict[str, Any]:
    def progress(step: str, detail: str = "") -> None:
        logger.info("Zotero import | %s %s", step, detail)
        if progress_callback:
            progress_callback(step, detail)

    zotero_storage = Path(db_path).parent / "storage"
    dest = Path(dest_path).expanduser().resolve()
    dest.mkdir(parents=True, exist_ok=True)

    conn = _open_zotero(db_path)
    col_paths = _build_col_paths(conn)

    progress("Reading Zotero library…")

    items = conn.execute(
        """SELECT i.itemID, i.key, it.typeName,
                  MAX(CASE WHEN f.fieldName='title' THEN idv.value END) as title,
                  MAX(CASE WHEN f.fieldName='DOI' THEN idv.value END) as doi,
                  MAX(CASE WHEN f.fieldName='date' THEN idv.value END) as date,
                  MAX(CASE WHEN f.fieldName='publicationTitle' THEN idv.value END) as journal,
                  MAX(CASE WHEN f.fieldName='volume' THEN idv.value END) as volume,
                  MAX(CASE WHEN f.fieldName='issue' THEN idv.value END) as issue,
                  MAX(CASE WHEN f.fieldName='pages' THEN idv.value END) as pages,
                  MAX(CASE WHEN f.fieldName='abstractNote' THEN idv.value END) as abstract,
                  MAX(CASE WHEN f.fieldName='url' THEN idv.value END) as url
           FROM items i
           JOIN itemTypes it ON i.itemTypeID = it.itemTypeID
           LEFT JOIN itemData id ON i.itemID = id.itemID
           LEFT JOIN itemDataValues idv ON id.valueID = idv.valueID
           LEFT JOIN fields f ON id.fieldID = f.fieldID
           WHERE it.typeName NOT IN ('attachment', 'annotation', 'note')
           GROUP BY i.itemID"""
    ).fetchall()

    attachments = conn.execute(
        """SELECT ia.parentItemID, i.key, ia.path
           FROM itemAttachments ia
           JOIN items i ON ia.itemID = i.itemID
           WHERE ia.contentType='application/pdf' AND ia.path LIKE 'storage:%'"""
    ).fetchall()
    att_map: Dict[int, List[Dict]] = {}
    for a in attachments:
        att_map.setdefault(a["parentItemID"], []).append({"key": a["key"], "path": a["path"]})

    creators_rows = conn.execute(
        """SELECT ic.itemID, c.firstName, c.lastName, ct.creatorType, ic.orderIndex
           FROM itemCreators ic
           JOIN creators c ON ic.creatorID = c.creatorID
           JOIN creatorTypes ct ON ic.creatorTypeID = ct.creatorTypeID
           ORDER BY ic.itemID, ic.orderIndex"""
    ).fetchall()
    creators_map: Dict[int, List[Dict]] = {}
    for cr in creators_rows:
        creators_map.setdefault(cr["itemID"], []).append({
            "creatorType": cr["creatorType"],
            "lastName": cr["lastName"] or "",
            "firstName": cr["firstName"] or "",
        })

    col_items = conn.execute("SELECT collectionID, itemID FROM collectionItems").fetchall()
    item_cols: Dict[int, List[int]] = {}
    for ci in col_items:
        item_cols.setdefault(ci["itemID"], []).append(ci["collectionID"])

    conn.close()

    total = len(items)
    copied = 0
    skipped = 0
    errors: List[str] = []

    ris_per_folder: Dict[str, List[str]] = {}

    progress(f"Importing {total} items…")

    for idx, row in enumerate(items, start=1):
        item_id = row["itemID"]

        if idx % 20 == 0 or idx == total:
            progress(f"Processing {idx}/{total}", (row["title"] or "")[:50])

        col_ids = item_cols.get(item_id, [])
        if col_ids:
            folders = [col_paths[cid] for cid in col_ids if cid in col_paths]
            folders = [f for f in folders if f]
        else:
            folders = []

        if not folders:
            folders = ["Unfiled"]

        item_dict = dict(row)
        item_dict["item_type"] = row["typeName"]
        creators = creators_map.get(item_id, [])
        ris_entry = _build_ris_entry(item_dict, creators)

        for folder_rel in folders:
            ris_per_folder.setdefault(folder_rel, []).append(ris_entry)

        for att in att_map.get(item_id, []):
            filename = att["path"].replace("storage:", "", 1)
            src = zotero_storage / att["key"] / filename
            if not src.exists():
                skipped += 1
                continue

            for folder_rel in folders:
                folder_abs = dest / folder_rel
                try:
                    folder_abs.mkdir(parents=True, exist_ok=True)
                    dest_file = folder_abs / src.name
                    if not dest_file.exists():
                        shutil.copy2(str(src), str(dest_file))
                    copied += 1
                except Exception as exc:
                    err = f"Copy error {src.name}: {exc}"
                    errors.append(err)
                    logger.warning(err)

    progress("Writing metadata files…")
    for folder_rel, entries in ris_per_folder.items():
        folder_abs = dest / folder_rel
        try:
            folder_abs.mkdir(parents=True, exist_ok=True)
            ris_file = folder_abs / "_references.ris"
            ris_file.write_text("\n\n".join(entries), encoding="utf-8")
        except Exception as exc:
            errors.append(f"RIS write error {folder_rel}: {exc}")

    progress("Import complete!")
    logger.info(
        "Zotero import done: %d copied, %d skipped, %d errors → %s",
        copied, skipped, len(errors), dest,
    )

    return {
        "status": "success" if not errors else "completed_with_errors",
        "copied": copied,
        "skipped": skipped,
        "errors": errors[:20],
        "destination": str(dest),
    }
