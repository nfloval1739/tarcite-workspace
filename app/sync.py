"""
Sync orchestration: scans local directory for PDFs and bibliography exports, writes to SQLite,
chunks text, creates embeddings, and populates ChromaDB.

Supports syncing individual directories without affecting items from
other directories. Each item is tagged with its source_dir.
"""

import hashlib
import json
import logging
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from app.config import config
from app.database import (
    clear_all_fts,
    delete_fts_for_item,
    get_all_items_date_modified,
    get_all_fts_item_keys,
    get_fts_chunks_for_item,
    get_config,
    get_fts_chunk_count,
    get_items_batch,
    index_chunk_fts,
    log_sync,
    merge_duplicate_item_into,
    set_config,
    upsert_collection,
    upsert_item,
    save_fulltext,
    set_text_status,
    get_fulltext_for_item,
    get_item_keys_for_dir,
    delete_items_for_dir,
)
from app.local_scanner import scan_directory
from app.pdf_extract import safe_extract_pdf_fulltext
from app.chunking import prepare_item_chunks
from app.perf import log_duration
from app.embeddings import (
    add_chunks_to_collection,
    delete_item_chunks,
    embedding_model_changed,
    ensure_embedding_model_ready,
    get_chroma_client,
    get_or_create_collection,
    get_loaded_embedding_model_name,
    reset_collection,
    save_embedding_meta,
)

logger = logging.getLogger(__name__)

ProgressCallback = Optional[Callable[[str, str], None]]


def sync_library(
    force_resync: bool = False,
    progress_callback: ProgressCallback = None,
    dir_path: Optional[str] = None,
) -> Dict[str, Any]:
    def progress(step: str, detail: str = "") -> None:
        logger.info("Sync | %s %s", step, detail)
        if progress_callback:
            progress_callback(step, detail)

    if dir_path:
        target_dir = dir_path
        source_dir = str(Path(dir_path).expanduser().resolve())
    elif config.reference_dirs:
        target_dir = config.reference_dirs[0].get("path", "")
        source_dir = str(Path(target_dir).expanduser().resolve()) if target_dir else ""
    elif config.references_dir:
        target_dir = config.references_dir
        source_dir = str(Path(target_dir).expanduser().resolve())
    else:
        return {
            "status": "error",
            "error": "No references directory configured. Please add one in Settings.",
        }

    if not target_dir:
        return {
            "status": "error",
            "error": "No references directory configured.",
        }

    errors: List[str] = []
    items_synced = 0
    items_skipped = 0
    chunks_created = 0
    collections_synced = 0

    chroma_client = get_chroma_client()
    try:
        ensure_embedding_model_ready()
    except Exception as exc:
        err = str(exc)
        errors.append(err)
        logger.error("Embedding model is not ready: %s", err)
        log_sync(0, 0, errors, source_dir=source_dir)
        return {"status": "error", "items_synced": 0, "chunks_created": 0, "errors": errors}

    if embedding_model_changed():
        progress("Embedding model changed — resetting vector index and FTS…")
        collection = reset_collection(chroma_client)
        clear_all_fts()
        force_resync = True
    elif force_resync:
        progress(f"Force resync for directory — clearing items from: {source_dir}")
        old_keys = get_item_keys_for_dir(source_dir)
        collection = get_or_create_collection(chroma_client)
        for old_key in old_keys:
            delete_item_chunks(collection, old_key)
        delete_items_for_dir(source_dir)
    else:
        collection = get_or_create_collection(chroma_client)

    existing_date_modified = get_all_items_date_modified()
    with log_duration(logger, "read ChromaDB indexed item keys", threshold_ms=500):
        indexed_vector_keys = _get_indexed_vector_item_keys(collection)

    progress("Scanning references directory…")
    try:
        with log_duration(logger, f"scan_directory {source_dir}", threshold_ms=500):
            items, folders = scan_directory(
                target_dir,
                progress_callback=progress,
            )
    except Exception as exc:
        err = f"Directory scan error: {exc}"
        errors.append(err)
        logger.error(err)
        log_sync(0, 0, errors, source_dir=source_dir)
        return {"status": "error", "items_synced": 0, "chunks_created": 0, "errors": errors}

    progress(f"Syncing {len(folders)} folders…")
    scanned_paths = set()
    for folder in folders:
        folder["source_dir"] = source_dir
        upsert_collection(folder)
        fp = folder.get("path", folder.get("local_path", ""))
        if fp:
            scanned_paths.add(str(Path(fp).resolve()))
    collections_synced = len(folders)

    if scanned_paths:
        _cleanup_stale_collections(source_dir, scanned_paths)

    total = len(items)
    if total == 0:
        log_sync(0, 0, errors, source_dir=source_dir)
        return {
            "status": "success",
            "mode": "full",
            "items_synced": 0,
            "items_skipped": 0,
            "chunks_created": 0,
            "collections_synced": collections_synced,
            "errors": [],
            "source_dir": source_dir,
        }

    progress(f"Processing {total} reference item(s)…")

    for idx, item_data in enumerate(items, start=1):
        item_key = item_data.get("item_key", "")
        if not item_key:
            continue

        try:
            new_date_modified = item_data.get("date_modified", "")
            merged_reference_keys = item_data.pop("_merged_reference_item_keys", [])

            item_data["source_dir"] = source_dir
            stored_date = existing_date_modified.get(item_key, "")
            has_vector_chunks = item_key in indexed_vector_keys
            skip_indexing = (
                not force_resync
                and stored_date == new_date_modified
                and bool(stored_date)
                and has_vector_chunks
            )

            if skip_indexing and not merged_reference_keys:
                items_synced += 1
                items_skipped += 1
                if idx % 5 == 0 or idx == total:
                    title_short = (item_data.get("title") or "")[:55]
                    progress(f"Item {idx}/{total}", title_short)
                continue

            upsert_item(item_data)
            items_synced += 1
            for duplicate_key in merged_reference_keys:
                try:
                    delete_item_chunks(collection, duplicate_key)
                    indexed_vector_keys.discard(duplicate_key)
                    merge_duplicate_item_into(duplicate_key, item_key)
                except Exception as exc:
                    errors.append(f"Could not merge duplicate metadata item {duplicate_key}: {exc}")

            if idx % 5 == 0 or idx == total:
                title_short = (item_data.get("title") or "")[:55]
                progress(f"Item {idx}/{total}", title_short)

            if skip_indexing:
                items_skipped += 1
                continue

            full_text = item_data.pop("full_text", "")
            # scan_directory uses extract_text=False for PDFs to keep RAM low;
            # resolve text now, only for items that actually need re-embedding.
            file_path = item_data.get("file_path", "")
            is_pdf = bool(file_path) and file_path.lower().endswith(".pdf")
            if not full_text and is_pdf:
                # When the file is unchanged (only the vector index was lost),
                # reuse cached text — no PDF reopen, so no risk of a MuPDF crash.
                file_unchanged = bool(stored_date) and stored_date == new_date_modified
                if file_unchanged:
                    cached = get_fulltext_for_item(item_key)
                    if cached and cached[0].get("content"):
                        full_text = cached[0]["content"]
                if not full_text:
                    # Extract in an isolated subprocess: a malformed PDF that
                    # aborts MuPDF kills only the worker, not the app.
                    full_text, extract_err = safe_extract_pdf_fulltext(file_path)
                    if extract_err:
                        set_text_status(item_key, "failed", extract_err)
                        errors.append(f"Text extraction failed for {item_key}: {extract_err}")
                    else:
                        set_text_status(item_key, "ok", "")
            if full_text:
                save_fulltext(item_key, full_text, total_pages=0)

            fulltexts_for_chunking = [{"content": full_text}] if full_text else []

            chunks = prepare_item_chunks(
                item=item_data,
                notes=[],
                fulltexts=fulltexts_for_chunking,
            )

            if not chunks:
                continue

            delete_item_chunks(collection, item_key)
            delete_fts_for_item(item_key)

            for chunk in chunks:
                chunk_id = f"{item_key}__{chunk['source_type']}__{chunk['chunk_index']}"
                try:
                    index_chunk_fts(
                        chunk_text=chunk["chunk_text"],
                        item_key=item_key,
                        chunk_id=chunk_id,
                        source_type=chunk["source_type"],
                    )
                except Exception:
                    pass

            item_meta = {
                "item_key": item_key,
                "title": item_data.get("title", ""),
                "year": item_data.get("year", ""),
                "creators": item_data.get("creators", "[]"),
                "publication_title": item_data.get("publication_title", ""),
                "collection_keys": item_data.get("collection_keys", "[]"),
                "source_dir": source_dir,
            }
            added = add_chunks_to_collection(collection, chunks, item_meta)
            chunks_created += added
            if added:
                indexed_vector_keys.add(item_key)
            elif chunks:
                errors.append(
                    f"Vector indexing failed for {item_key}; BM25 chunks were created but embeddings were not stored."
                )

        except Exception as exc:
            err = f"Error on item {item_key}: {exc}"
            errors.append(err)
            logger.error(err)

    log_sync(items_synced, chunks_created, errors, source_dir=source_dir)
    if chunks_created or _collection_count(collection):
        save_embedding_meta(get_loaded_embedding_model_name())

    progress("Sync complete!")
    logger.info(
        "Sync done: %d processed, %d skipped, %d chunks created (dir=%s)",
        items_synced, items_skipped, chunks_created, source_dir,
    )

    status = "success" if not errors else "completed_with_errors"
    return {
        "status": status,
        "mode": "full",
        "items_synced": items_synced,
        "items_skipped": items_skipped,
        "collections_synced": collections_synced,
        "chunks_created": chunks_created,
        "errors": errors[:20],
        "source_dir": source_dir,
    }


def _get_indexed_vector_item_keys(collection) -> set:
    # Paginate to avoid SQLite "too many variables" error on large collections.
    keys: set = set()
    limit = 5000
    offset = 0
    try:
        while True:
            result = collection.get(include=["metadatas"], limit=limit, offset=offset)
            batch = result.get("metadatas", [])
            if not batch:
                break
            for m in batch:
                if m and m.get("item_key"):
                    keys.add(m["item_key"])
            if len(batch) < limit:
                break
            offset += limit
    except Exception as exc:
        logger.warning("Could not read ChromaDB indexed keys: %s", exc)
    return keys


def _cleanup_stale_collections(source_dir: str, scanned_paths: set) -> None:
    from app.database import get_connection
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT collection_key, local_path, name FROM collections_v2 WHERE source_dir = ? AND collection_key != 'root'",
            (source_dir,),
        ).fetchall()
        for row in rows:
            lp = row["local_path"] or ""
            if lp:
                resolved = str(Path(lp).resolve())
                if resolved in scanned_paths or lp in scanned_paths:
                    continue
            else:
                matches_scan = False
                for sp in scanned_paths:
                    if Path(sp).name == row["name"]:
                        matches_scan = True
                        break
                if matches_scan:
                    continue
            ck = row["collection_key"]
            conn.execute("DELETE FROM item_collections WHERE collection_key = ?", (ck,))
            conn.execute("DELETE FROM collections_v2 WHERE collection_key = ?", (ck,))
            conn.execute("DELETE FROM collections WHERE collection_key = ?", (ck,))
            logger.info("Cleaned up stale collection: %s (%s)", ck, lp or row["name"])


def fill_chromadb_gaps(progress_callback: ProgressCallback = None) -> Dict[str, Any]:
    """Embed items that are in FTS but missing from ChromaDB, without touching already-indexed items."""
    def progress(step: str, detail: str = "") -> None:
        logger.info("FillGaps | %s %s", step, detail)
        if progress_callback:
            progress_callback(step, detail)

    chroma_client = get_chroma_client()
    collection = get_or_create_collection(chroma_client)
    ensure_embedding_model_ready()

    fts_keys = get_all_fts_item_keys()
    if not fts_keys:
        progress("No FTS chunks found — nothing to fill.")
        return {"filled": 0, "chunks_added": 0}

    # Find which item_keys are already in ChromaDB (paginated to avoid SQLite variable limit)
    indexed_keys = _get_indexed_vector_item_keys(collection)

    missing_keys = [k for k in fts_keys if k not in indexed_keys]
    total = len(missing_keys)

    if total == 0:
        progress("ChromaDB already in sync — no gaps found.")
        return {"filled": 0, "chunks_added": 0}

    progress(f"Found {total} items missing from ChromaDB — embedding now…")

    items_meta = get_items_batch(missing_keys)
    filled = 0
    chunks_added = 0

    for idx, item_key in enumerate(missing_keys, 1):
        item = items_meta.get(item_key)
        if not item:
            continue

        fts_chunks = get_fts_chunks_for_item(item_key)
        if not fts_chunks:
            continue

        chunks = [
            {
                "chunk_text":  c["chunk_text"],
                "source_type": c["source_type"],
                "chunk_index": i,
            }
            for i, c in enumerate(fts_chunks)
        ]

        item_meta = {
            "item_key":         item_key,
            "title":            item.get("title", ""),
            "year":             item.get("year", ""),
            "creators":         item.get("creators", "[]"),
            "publication_title": item.get("publication_title", ""),
            "collection_keys":  item.get("collection_keys", "[]"),
            "source_dir":       item.get("source_dir", ""),
        }

        try:
            added = add_chunks_to_collection(collection, chunks, item_meta)
            chunks_added += added
            filled += 1
        except Exception as exc:
            logger.warning("FillGaps: failed to embed %s: %s", item_key, exc)

        if idx % 20 == 0 or idx == total:
            progress(f"Embedded {idx}/{total}", f"{chunks_added} chunks added")

    if chunks_added or _collection_count(collection):
        save_embedding_meta(get_loaded_embedding_model_name())
    progress(f"Done — {filled} items embedded, {chunks_added} chunks added to ChromaDB.")
    return {"filled": filled, "chunks_added": chunks_added}


def sync_single_file(file_path: str, source_dir: str) -> Dict[str, Any]:
    """Index one newly uploaded file without rescanning the whole directory."""
    from app.local_scanner import (
        PDF_EXTENSIONS, BIBLIOGRAPHY_EXTENSIONS,
        TEXT_EXTENSIONS, MARKDOWN_EXTENSIONS, CSV_EXTENSIONS, WORD_EXTENSIONS, IMAGE_EXTENSIONS,
        extract_pdf_metadata, extract_reference_metadata,
        extract_txt_metadata, extract_md_metadata, extract_csv_metadata, extract_docx_metadata,
        extract_image_metadata,
    )

    fp = Path(file_path).expanduser().resolve()
    root = Path(source_dir).expanduser().resolve()
    try:
        ensure_embedding_model_ready()
    except Exception as exc:
        err = str(exc)
        logger.error("Embedding model is not ready: %s", err)
        log_sync(0, 0, [err], source_dir=str(root))
        return {"status": "error", "items_synced": 0, "chunks_created": 0, "errors": [err]}

    if not fp.exists():
        return {"status": "error", "error": f"File not found: {file_path}"}

    suffix = fp.suffix.lower()
    if suffix in PDF_EXTENSIONS:
        items = [extract_pdf_metadata(fp)]
    elif suffix in IMAGE_EXTENSIONS:
        items = [extract_image_metadata(fp)]
    elif suffix in TEXT_EXTENSIONS:
        items = [extract_txt_metadata(fp)]
    elif suffix in MARKDOWN_EXTENSIONS:
        items = [extract_md_metadata(fp)]
    elif suffix in CSV_EXTENSIONS:
        items = [extract_csv_metadata(fp)]
    elif suffix in WORD_EXTENSIONS:
        items = [extract_docx_metadata(fp)]
    elif suffix in BIBLIOGRAPHY_EXTENSIONS:
        items = extract_reference_metadata(fp)
    else:
        return {"status": "error", "error": f"Unsupported file type: {suffix}"}

    # Determine which collection (subfolder) this file belongs to
    parent = fp.parent
    col_keys = []
    while str(parent) != str(root) and str(parent).startswith(str(root)):
        col_key = hashlib.md5(str(parent).encode()).hexdigest()[:12]
        col_keys.append(col_key)
        upsert_collection({
            "collection_key": col_key,
            "name": parent.name,
            "parent_key": hashlib.md5(str(parent.parent).encode()).hexdigest()[:12]
                          if str(parent.parent) != str(root) else "",
            "source_dir": str(root),
            "path": str(parent),
        })
        parent = parent.parent
    if not col_keys:
        col_keys = ["root"]

    chroma_client = get_chroma_client()
    collection = get_or_create_collection(chroma_client)

    chunks_created = 0
    errors: List[str] = []

    for item_data in items:
        item_key = item_data.get("item_key", "")
        if not item_key:
            continue

        item_data["source_dir"] = str(root)
        item_data["collection_keys"] = json.dumps(col_keys)

        try:
            upsert_item(item_data)

            full_text = item_data.pop("full_text", "")
            if full_text:
                save_fulltext(item_key, full_text, total_pages=0)

            fulltexts_for_chunking = [{"content": full_text}] if full_text else []
            chunks = prepare_item_chunks(item=item_data, notes=[], fulltexts=fulltexts_for_chunking)

            if chunks:
                delete_item_chunks(collection, item_key)
                delete_fts_for_item(item_key)
                for chunk in chunks:
                    chunk_id = f"{item_key}__{chunk['source_type']}__{chunk['chunk_index']}"
                    try:
                        index_chunk_fts(
                            chunk_text=chunk["chunk_text"],
                            item_key=item_key,
                            chunk_id=chunk_id,
                            source_type=chunk["source_type"],
                        )
                    except Exception:
                        pass
                item_meta = {
                    "item_key": item_key,
                    "title": item_data.get("title", ""),
                    "year": item_data.get("year", ""),
                    "creators": item_data.get("creators", "[]"),
                    "publication_title": item_data.get("publication_title", ""),
                    "collection_keys": json.dumps(col_keys),
                    "source_dir": str(root),
                }
                chunks_created += add_chunks_to_collection(collection, chunks, item_meta)

        except Exception as exc:
            err = f"Error indexing {fp.name}: {exc}"
            errors.append(err)
            logger.error(err)

    log_sync(len(items), chunks_created, errors, source_dir=str(root))
    if chunks_created or _collection_count(collection):
        save_embedding_meta(get_loaded_embedding_model_name())

    logger.info("Single file sync done: %s → %d chunks", fp.name, chunks_created)
    return {
        "status": "success" if not errors else "completed_with_errors",
        "items_synced": len(items),
        "chunks_created": chunks_created,
        "errors": errors,
        "source_dir": str(root),
    }


def _collection_count(collection) -> int:
    try:
        return int(collection.count())
    except Exception:
        return 0
