"""
Mendeley Reference Manager local library importer (macOS).

Data layout on macOS:
  ~/Library/Application Support/Mendeley Reference Manager/
    mrm/databases/{account-uuid}.db   — SQLite FTS (documents + files)
    userfiles/{file-uuid}.pdf         — flat PDF store
    IndexedDB/file__0.indexeddb.leveldb/  — LevelDB (collections + doc JSON)

The SQLite DB only has FTS tables; collection membership lives in
IndexedDB (LevelDB binary). We extract:
  - All document metadata + file UUIDs from SQLite (reliable)
  - Structured author data from LevelDB document JSON (best-effort)
  - User collection names from LevelDB JSON blob (best-effort)
  - Collection→document membership is NOT available locally; all docs
    are imported flat into one destination folder.
"""

import json
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


# ── Detection ────────────────────────────────────────────────────────────────

def detect_mendeley() -> Optional[str]:
    """Return the path to the first Mendeley SQLite DB found, or None."""
    # macOS path
    base = Path.home() / "Library" / "Application Support" / "Mendeley Reference Manager" / "mrm" / "databases"
    if base.exists():
        dbs = sorted(base.glob("*.db"))
        if dbs:
            return str(dbs[0])

    # Windows fallback (LOCALAPPDATA)
    local = Path.home() / "AppData" / "Local" / "Mendeley Reference Manager" / "mrm" / "databases"
    if local.exists():
        dbs = sorted(local.glob("*.db"))
        if dbs:
            return str(dbs[0])

    return None


def _open_mendeley(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def _mrm_root(db_path: str) -> Path:
    """Return the Mendeley Reference Manager root dir from a db_path."""
    # db_path = .../Mendeley Reference Manager/mrm/databases/{uuid}.db
    return Path(db_path).parent.parent.parent


# ── LevelDB helpers (string-extraction, no binary parsing) ───────────────────

def _read_leveldb_log(db_path: str) -> str:
    """Read all numeric .log files from the IndexedDB LevelDB as text."""
    leveldb_dir = _mrm_root(db_path) / "IndexedDB" / "file__0.indexeddb.leveldb"
    if not leveldb_dir.exists():
        return ""
    parts: List[str] = []
    for log_file in sorted(leveldb_dir.glob("*.log"), key=lambda p: p.stem):
        if not log_file.stem.isdigit():
            continue
        try:
            parts.append(log_file.read_bytes().decode("utf-8", errors="replace"))
        except Exception as exc:
            logger.debug("Skip LevelDB log %s: %s", log_file, exc)
    return "\n".join(parts)


def _extract_collections(leveldb_text: str) -> List[Dict[str, str]]:
    """Extract user-created collection names from the LevelDB text dump."""
    m = re.search(
        r'\{"smart":\[.*?\],"user":(\[.*?\]),"groups":\[',
        leveldb_text,
        re.DOTALL,
    )
    if not m:
        return []
    try:
        user_cols = json.loads(m.group(1))
        return [
            {"id": c.get("id", ""), "name": c.get("name", "Unnamed")}
            for c in user_cols
            if c.get("id") and c.get("name")
        ]
    except Exception:
        return []


def _extract_authors_for_docs(leveldb_text: str, doc_uuids: List[str]) -> Dict[str, List[str]]:
    """
    Best-effort extraction of structured authors from LevelDB document JSON.
    Returns {doc_uuid: ["Last, First", ...]}
    """
    result: Dict[str, List[str]] = {}
    for doc_uuid in doc_uuids:
        pos = leveldb_text.find(doc_uuid)
        while pos >= 0:
            window = leveldb_text[max(0, pos - 3000) : pos + 3000]
            m = re.search(r'"authors"\s*:\s*\[([^\]]*)\]', window, re.DOTALL)
            if m:
                try:
                    authors = json.loads("[" + m.group(1) + "]")
                    formatted: List[str] = []
                    for a in authors:
                        last = (a.get("last_name") or "").strip()
                        first = (a.get("first_name") or "").strip()
                        if last and first:
                            formatted.append(f"{last}, {first}")
                        elif last:
                            formatted.append(last)
                        elif first:
                            formatted.append(first)
                    if formatted:
                        result[doc_uuid] = formatted
                        break
                except Exception:
                    pass
            # try next occurrence
            next_pos = leveldb_text.find(doc_uuid, pos + 1)
            if next_pos <= pos:
                break
            pos = next_pos
    return result


# ── Preview ───────────────────────────────────────────────────────────────────

def get_mendeley_preview(db_path: str) -> Dict[str, Any]:
    """Return summary counts and collection list for the import preview UI."""
    conn = _open_mendeley(db_path)
    total_docs = conn.execute("SELECT count(*) FROM documents_fts_content").fetchone()[0]
    total_pdfs = conn.execute("SELECT count(*) FROM files_fts_content").fetchone()[0]
    conn.close()

    leveldb_text = _read_leveldb_log(db_path)
    collections = _extract_collections(leveldb_text)

    return {
        "total_docs": total_docs,
        "total_pdfs": total_pdfs,
        "collections": collections,
    }


# ── RIS builder ───────────────────────────────────────────────────────────────

def _extract_doi(identifiers: str) -> str:
    if not identifiers:
        return ""
    # URL form: https://doi.org/10.xxxx/...
    m = re.search(r"https?://doi\.org/([^\s]+)", identifiers)
    if m:
        return m.group(1)
    # Raw form: token starting with 10.
    for token in identifiers.split():
        if token.startswith("10."):
            return token
    return ""


def _build_ris_entry(
    doc_uuid: str,
    title: str,
    authors: List[str],
    year: str,
    journal: str,
    abstract: str,
    doi: str,
    volume: str = "",
    issue: str = "",
    pages: str = "",
) -> str:
    lines = ["TY  - JOUR"]
    if title:
        lines.append(f"TI  - {title}")
    for au in authors:
        lines.append(f"AU  - {au}")
    if year:
        lines.append(f"PY  - {year}")
    if journal:
        lines.append(f"JO  - {journal}")
    if volume:
        lines.append(f"VL  - {volume}")
    if issue:
        lines.append(f"IS  - {issue}")
    if pages:
        lines.append(f"SP  - {pages}")
    if doi:
        lines.append(f"DO  - {doi}")
    if abstract:
        lines.append(f"AB  - {abstract.replace(chr(10), ' ')}")
    lines.append(f"AN  - mendeley:{doc_uuid}")
    lines.append("ER  - ")
    return "\n".join(lines)


# ── Import ────────────────────────────────────────────────────────────────────

def import_mendeley_library(
    db_path: str,
    dest_path: str,
    progress_callback: ProgressCallback = None,
) -> Dict[str, Any]:
    def progress(step: str, detail: str = "") -> None:
        logger.info("Mendeley import | %s %s", step, detail)
        if progress_callback:
            progress_callback(step, detail)

    mrm_root = _mrm_root(db_path)
    userfiles_dir = mrm_root / "userfiles"
    dest = Path(dest_path).expanduser().resolve()
    dest.mkdir(parents=True, exist_ok=True)

    # ── 1. Read SQLite FTS ───────────────────────────────────────────────────
    progress("Reading Mendeley library…")
    conn = _open_mendeley(db_path)

    docs = conn.execute(
        "SELECT id, c0, c1, c2, c3, c4, c5, c6, c7, c8 FROM documents_fts_content"
    ).fetchall()
    # c0=doc_uuid  c1=title  c2=authors(fts)  c3=journal  c4=year(float)
    # c5=abstract  c8=identifiers(doi etc.)

    files = conn.execute("SELECT c0, c1 FROM files_fts_content").fetchall()
    # c0=file_uuid  c1=doc_uuid
    conn.close()

    # doc_uuid → file_uuid
    file_for_doc: Dict[str, str] = {str(r["c1"]): str(r["c0"]) for r in files if r["c1"]}

    # ── 2. Best-effort author extraction from LevelDB ────────────────────────
    progress("Reading author details…")
    doc_uuids = [str(r["c0"]) for r in docs if r["c0"]]
    try:
        leveldb_text = _read_leveldb_log(db_path)
        authors_map = _extract_authors_for_docs(leveldb_text, doc_uuids)
    except Exception as exc:
        logger.warning("LevelDB author extraction failed: %s", exc)
        authors_map = {}

    # ── 3. Process each document ─────────────────────────────────────────────
    total = len(docs)
    copied = 0
    skipped = 0
    errors: List[str] = []
    ris_entries: List[str] = []

    progress(f"Importing {total} documents…")

    for idx, row in enumerate(docs, start=1):
        if idx % 25 == 0 or idx == total:
            progress(f"Processing {idx}/{total}", (row["c1"] or "")[:60])

        doc_uuid = str(row["c0"] or "")
        title = str(row["c1"] or "").strip()
        year_raw = str(row["c4"] or "").strip()
        journal = str(row["c3"] or "").strip()
        abstract = str(row["c5"] or "").strip()
        identifiers = str(row["c8"] or "").strip()

        # Year: stored as float "2017.0"
        try:
            year = str(int(float(year_raw))) if year_raw else ""
        except ValueError:
            year = year_raw

        doi = _extract_doi(identifiers)

        # Authors: prefer structured (LevelDB), fall back to FTS string split
        if doc_uuid in authors_map:
            authors = authors_map[doc_uuid]
        else:
            # FTS stores "First1 Last1 First2 Last2" — emit as single AU line
            fts_authors = str(row["c2"] or "").strip()
            authors = [fts_authors] if fts_authors else []

        ris = _build_ris_entry(
            doc_uuid=doc_uuid,
            title=title,
            authors=authors,
            year=year,
            journal=journal,
            abstract=abstract,
            doi=doi,
        )
        ris_entries.append(ris)

        # Copy PDF if available locally
        file_uuid = file_for_doc.get(doc_uuid)
        if file_uuid:
            pdf_src = userfiles_dir / f"{file_uuid}.pdf"
            if pdf_src.exists():
                safe_title = _safe_name(title or doc_uuid)
                pdf_dest = dest / f"{safe_title}.pdf"
                counter = 1
                while pdf_dest.exists():
                    pdf_dest = dest / f"{safe_title}_{counter}.pdf"
                    counter += 1
                try:
                    shutil.copy2(str(pdf_src), str(pdf_dest))
                    copied += 1
                except Exception as exc:
                    err = f"Copy error {pdf_src.name}: {exc}"
                    errors.append(err)
                    logger.warning(err)
            else:
                skipped += 1

    # ── 4. Write RIS metadata ────────────────────────────────────────────────
    progress("Writing metadata file…")
    ris_file = dest / "_references.ris"
    try:
        ris_file.write_text("\n\n".join(ris_entries), encoding="utf-8")
    except Exception as exc:
        errors.append(f"RIS write error: {exc}")

    progress("Import complete!")
    logger.info(
        "Mendeley import done: %d docs, %d PDFs copied, %d skipped, %d errors → %s",
        total, copied, skipped, len(errors), dest,
    )

    return {
        "status": "success" if not errors else "completed_with_errors",
        "total_docs": total,
        "copied": copied,
        "skipped": skipped,
        "errors": errors[:20],
        "destination": str(dest),
    }
