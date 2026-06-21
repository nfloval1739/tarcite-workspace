"""Item detail, activity, notes, metadata, and deletion routes."""

import logging
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException

from app.database import (
    delete_item,
    get_item_keywords,
    get_item_notes,
    get_item_v2,
    patch_item_notes,
    record_item_open,
    set_item_favorite,
    set_item_reading_status,
    update_item_metadata,
)

logger = logging.getLogger(__name__)
router = APIRouter(tags=["items"])


@router.get("/api/items/{item_key}")
def item_detail_route(item_key: str) -> Dict:
    item = get_item_v2(item_key)
    if not item:
        raise HTTPException(status_code=404, detail="Item not found.")
    return item


@router.post("/api/items/{item_key}/activity/open")
def item_open_activity_route(item_key: str) -> Dict:
    activity = record_item_open(item_key)
    if activity is None:
        raise HTTPException(status_code=404, detail="Item not found.")
    return {"status": "updated", "item_key": item_key, "activity": activity}


@router.post("/api/items/{item_key}/favorite")
def item_favorite_route(item_key: str, body: Dict[str, Any]) -> Dict:
    activity = set_item_favorite(item_key, bool(body.get("favorite")))
    if activity is None:
        raise HTTPException(status_code=404, detail="Item not found.")
    return {"status": "updated", "item_key": item_key, "activity": activity}


@router.patch("/api/items/{item_key}/reading-status")
def item_reading_status_route(item_key: str, body: Dict[str, Any]) -> Dict:
    status = body.get("reading_status", "")
    activity = set_item_reading_status(item_key, status)
    if activity is None:
        raise HTTPException(status_code=404, detail="Item not found or invalid status.")
    return {"status": "updated", "item_key": item_key, "activity": activity}


@router.get("/api/items/{item_key}/keywords")
def item_keywords_route(item_key: str) -> Dict:
    return {"keywords": get_item_keywords(item_key)}


@router.get("/api/items/{item_key}/notes")
def item_notes_route(item_key: str) -> Dict:
    notes = get_item_notes(item_key)
    if notes is None:
        raise HTTPException(status_code=404, detail="Item not found.")
    return notes


@router.patch("/api/items/{item_key}/notes")
def update_item_notes_route(item_key: str, body: Dict[str, Any]) -> Dict:
    if not get_item_v2(item_key):
        raise HTTPException(status_code=404, detail="Item not found.")
    if not patch_item_notes(item_key, body):
        raise HTTPException(status_code=404, detail="Item not found.")
    return {"status": "updated", **(get_item_notes(item_key) or {"item_key": item_key})}


@router.patch("/api/items/{item_key}/metadata")
def update_item_metadata_route(item_key: str, body: Dict[str, Any]) -> Dict:
    item = get_item_v2(item_key)
    if not item:
        raise HTTPException(status_code=404, detail="Item not found.")
    update_item_metadata(item_key, body)
    updated = get_item_v2(item_key) or {"item_key": item_key}
    return {"status": "updated", "item_key": item_key, "item": updated}


@router.post("/api/items/{item_key}/metadata/refetch-crossref")
def refetch_item_crossref_metadata_route(item_key: str, body: Optional[Dict[str, Any]] = None) -> Dict:
    item = get_item_v2(item_key)
    if not item:
        raise HTTPException(status_code=404, detail="Item not found.")

    doi = ((body or {}).get("doi") or item.get("doi") or "").strip()
    if not doi:
        raise HTTPException(status_code=400, detail="DOI is required before Crossref refetch.")

    from app.crossref import fetch_crossref_metadata

    metadata = fetch_crossref_metadata(doi)
    if not metadata:
        raise HTTPException(status_code=404, detail="No Crossref metadata found for this DOI.")

    update_item_metadata(item_key, metadata)
    updated = get_item_v2(item_key) or {"item_key": item_key}
    return {"status": "updated", "item_key": item_key, "item": updated}


@router.delete("/api/items/{item_key}")
def delete_item_route(item_key: str, delete_file: bool = False) -> Dict:
    item = get_item_v2(item_key)
    if not item:
        raise HTTPException(status_code=404, detail="Item not found.")

    file_paths = []
    for file_info in item.get("files", []):
        file_path = file_info.get("file_path", "")
        if file_path:
            file_paths.append(file_path)
    if item.get("file_path") and item["file_path"] not in file_paths:
        file_paths.append(item["file_path"])

    deleted_files = []
    if delete_file:
        existing_paths = []
        for raw_path in file_paths:
            file_path = Path(raw_path)
            if not file_path.exists():
                continue
            if not file_path.is_file():
                raise HTTPException(status_code=400, detail=f"Not a regular file: {raw_path}")
            existing_paths.append((raw_path, file_path))

        for raw_path, file_path in existing_paths:
            try:
                file_path.unlink()
                deleted_files.append(raw_path)
            except OSError as exc:
                raise HTTPException(status_code=500, detail=f"Could not delete file '{raw_path}': {exc}")

    result = delete_item(item_key)
    if not result.get("deleted"):
        raise HTTPException(status_code=404, detail="Item not found.")

    try:
        from app.embeddings import delete_item_chunks, get_chroma_client, get_or_create_collection

        client = get_chroma_client()
        collection = get_or_create_collection(client)
        delete_item_chunks(collection, item_key)
    except Exception as exc:
        logger.warning("Could not clean up ChromaDB for deleted item %s: %s", item_key, exc)

    return {
        "status": "deleted",
        "item_key": item_key,
        "deleted_file": delete_file,
        "deleted_files": deleted_files,
    }
