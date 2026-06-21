"""Library health routes."""

import logging
import time
from pathlib import Path
from typing import Any, Dict

from fastapi import APIRouter, BackgroundTasks, HTTPException

from app.database import merge_duplicate_item_into, update_item_file_path, update_items_file_paths_prefix
from app.repositories.library_health import scan_library_health, source_dir_for_file_path

logger = logging.getLogger(__name__)
router = APIRouter(tags=["library-health"])
_health_cache: Dict[str, Any] = {}
_health_cache_at = 0.0
_HEALTH_CACHE_TTL_SECONDS = 300


def _load_health(force: bool = False) -> Dict[str, Any]:
    global _health_cache, _health_cache_at
    now = time.time()
    if not force and _health_cache and now - _health_cache_at < _HEALTH_CACHE_TTL_SECONDS:
        return _health_cache
    data = scan_library_health()
    data["cached_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now))
    _health_cache = data
    _health_cache_at = now
    return data


def _clear_health_cache() -> None:
    global _health_cache, _health_cache_at
    _health_cache = {}
    _health_cache_at = 0.0


@router.get("/api/library/health")
def library_health_route() -> Dict[str, Any]:
    return _load_health(force=False)


@router.post("/api/library/health/scan")
def library_health_scan_route() -> Dict[str, Any]:
    return _load_health(force=True)


@router.post("/api/library/duplicates/merge")
def merge_library_duplicate_route(body: Dict[str, Any]) -> Dict[str, Any]:
    source_item_key = (body.get("source_item_key") or "").strip()
    target_item_key = (body.get("target_item_key") or "").strip()
    if not source_item_key or not target_item_key:
        raise HTTPException(status_code=400, detail="source_item_key and target_item_key are required.")
    if source_item_key == target_item_key:
        raise HTTPException(status_code=400, detail="Choose two different records to merge.")
    if not merge_duplicate_item_into(source_item_key, target_item_key):
        raise HTTPException(status_code=404, detail="Could not merge duplicate records.")
    try:
        from app.embeddings import delete_item_chunks, get_chroma_client, get_or_create_collection

        client = get_chroma_client()
        collection = get_or_create_collection(client)
        delete_item_chunks(collection, source_item_key)
    except Exception as exc:
        logger.warning("Could not clean up ChromaDB for merged duplicate %s: %s", source_item_key, exc)
    _clear_health_cache()
    return {"status": "merged", "source_item_key": source_item_key, "target_item_key": target_item_key}


@router.post("/api/library/files/repair-path")
def repair_library_file_path_route(body: Dict[str, Any]) -> Dict[str, Any]:
    item_key = (body.get("item_key") or "").strip()
    old_path = (body.get("old_path") or "").strip()
    new_path = (body.get("new_path") or "").strip()
    old_prefix = (body.get("old_prefix") or "").strip()
    new_prefix = (body.get("new_prefix") or "").strip()

    if old_prefix or new_prefix:
        if not old_prefix or not new_prefix:
            raise HTTPException(status_code=400, detail="Both old_prefix and new_prefix are required.")
        target = Path(new_prefix).expanduser()
        if not target.exists():
            raise HTTPException(status_code=404, detail=f"New folder not found: {new_prefix}")
        updated = update_items_file_paths_prefix(old_prefix, str(target.resolve()))
        _clear_health_cache()
        return {"status": "updated", "updated": updated, "old_prefix": old_prefix, "new_prefix": str(target.resolve())}

    if not item_key or not old_path or not new_path:
        raise HTTPException(status_code=400, detail="item_key, old_path, and new_path are required.")
    target = Path(new_path).expanduser()
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail=f"Replacement file not found: {new_path}")
    update_item_file_path(item_key, old_path, str(target.resolve()))
    _clear_health_cache()
    return {"status": "updated", "item_key": item_key, "old_path": old_path, "new_path": str(target.resolve())}


def _index_file(file_path: str, source_dir: str) -> None:
    from app.sync import sync_single_file

    try:
        sync_single_file(file_path, source_dir)
    except Exception as exc:
        logger.error("Health index-file error for %s: %s", file_path, exc)


@router.post("/api/library/files/index")
def index_library_file_route(body: Dict[str, Any], background_tasks: BackgroundTasks) -> Dict[str, Any]:
    file_path = (body.get("file_path") or "").strip()
    if not file_path:
        raise HTTPException(status_code=400, detail="file_path is required.")
    target = Path(file_path).expanduser()
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail=f"File not found: {file_path}")
    resolved = str(target.resolve())
    source_dir = (body.get("source_dir") or source_dir_for_file_path(resolved) or "").strip()
    if not source_dir:
        raise HTTPException(status_code=400, detail="File is not inside a configured library directory.")
    background_tasks.add_task(_index_file, resolved, source_dir)
    _clear_health_cache()
    return {"status": "started", "file_path": resolved, "source_dir": source_dir}
