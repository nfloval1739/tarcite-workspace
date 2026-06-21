"""Library browsing and statistics routes."""

import logging
from pathlib import Path
from typing import Dict

from fastapi import APIRouter

from app.config import config
from app.database import (
    get_collection_count,
    get_collections,
    get_item_count,
    get_last_sync,
    get_library_items,
    get_library_tree,
)
from app.embeddings import get_collection_stats
from app.perf import log_duration

logger = logging.getLogger(__name__)
router = APIRouter(tags=["library"])


@router.get("/api/collections")
def collections_route() -> Dict:
    return {"collections": get_collections()}


@router.get("/api/library/stats")
def library_stats_route() -> Dict:
    from app.database import get_fts_chunk_count, get_item_count_for_dir, get_last_sync_for_dir
    from app.embeddings import embedding_model_changed, get_index_model

    last = get_last_sync()
    index_model = get_index_model()
    model_changed = embedding_model_changed()

    dir_stats = []
    for directory in config.reference_dirs:
        display_path = directory.get("path", "")
        normalized = str(Path(display_path).expanduser().resolve()) if display_path else ""
        item_count = get_item_count_for_dir(normalized) if normalized else 0
        last_sync = get_last_sync_for_dir(normalized) if normalized else None
        dir_stats.append({
            "path": display_path,
            "label": directory.get("label", ""),
            "normalized_path": normalized,
            "item_count": item_count,
            "last_sync": dict(last_sync) if last_sync else None,
        })

    return {
        "item_count": get_item_count(),
        "collection_count": get_collection_count(),
        "chunk_count": get_collection_stats().get("total_chunks", 0),
        "fts_chunk_count": get_fts_chunk_count(),
        "last_sync": dict(last) if last else None,
        "indexed_embedding_model": index_model,
        "configured_embedding_model": config.embedding_model,
        "model_changed": model_changed,
        "directories": dir_stats,
    }


@router.get("/api/library/tree")
def library_tree_route() -> Dict:
    from app.database import get_last_sync_for_dir

    tree_by_dir = {node["source_dir"]: node for node in get_library_tree()}
    result = []
    for directory in config.reference_dirs:
        display_path = directory.get("path", "")
        normalized = str(Path(display_path).expanduser().resolve()) if display_path else ""
        node = tree_by_dir.get(normalized, {"source_dir": normalized, "item_count": 0, "collections": []})
        last_sync = get_last_sync_for_dir(normalized) if normalized else None
        result.append({
            **node,
            "path": display_path,
            "label": directory.get("label", ""),
            "normalized_path": normalized,
            "last_sync": dict(last_sync) if last_sync else None,
        })
    return {"tree": result}


@router.get("/api/library/related")
def library_related_route(item_key: str, source_dir: str = "", limit: int = 15) -> Dict:
    """Return library items ranked by embedding similarity to the given item."""
    from app.database import get_fts_chunks_for_item
    from app.embeddings import get_chroma_client, get_or_create_collection, query_collection

    chunks = get_fts_chunks_for_item(item_key)
    if not chunks:
        return {"items": []}

    # Use first 3 chunks as a representative query for this document
    query_text = " ".join(c["chunk_text"] for c in chunks[:3])[:2000]

    try:
        client = get_chroma_client()
        collection = get_or_create_collection(client)
        results = query_collection(
            collection,
            query_text,
            n_results=80,
            source_dir=source_dir or None,
        )
    except Exception as exc:
        logger.warning("Related items query failed for %s: %s", item_key, exc)
        return {"items": []}

    # Group chunks by item_key, keep the best (highest) similarity score per item
    best: Dict[str, Dict] = {}
    for meta, dist in zip(results["metadatas"][0], results["distances"][0]):
        key = meta.get("item_key", "")
        if not key or key == item_key:
            continue
        score = round(max(0.0, 1.0 - float(dist)), 3)
        if key not in best or score > best[key]["score"]:
            best[key] = {
                "item_key": key,
                "score": score,
                "title": meta.get("title", "") or "Untitled",
                "year": meta.get("year", "") or "",
                "creators": meta.get("creators", "") or "",
            }

    ranked = sorted(best.values(), key=lambda x: x["score"], reverse=True)[:limit]
    return {"items": ranked}


@router.get("/api/library/items")
def library_items_route(
    source_dir: str = "",
    collection_key: str = "",
    q: str = "",
    sort_by: str = "title",
    sort_order: str = "asc",
    limit: int = 100,
    offset: int = 0,
    activity: str = "",
) -> Dict:
    with log_duration(
        logger,
        f"library_items limit={limit} offset={offset} query={bool(q)} collection={bool(collection_key)}",
        threshold_ms=100,
    ):
        return get_library_items(
            source_dir=source_dir,
            collection_key=collection_key,
            query=q,
            sort_by=sort_by,
            sort_order=sort_order,
            limit=limit,
            offset=offset,
            activity_filter=activity,
        )
