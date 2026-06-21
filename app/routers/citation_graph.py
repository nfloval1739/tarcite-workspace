"""Citation graph background indexing and map routes."""

import logging
import threading
import time
import uuid
from typing import Any, Dict

from fastapi import APIRouter, HTTPException

from app.repositories.citation_graph import (
    build_match_index,
    create_graph_job,
    finish_graph_job,
    get_citation_graph_map,
    get_graph_status,
    index_item_references,
    list_graph_source_items,
    update_graph_job,
)

logger = logging.getLogger(__name__)
router = APIRouter(tags=["citation-graph"])

_graph_lock = threading.Lock()
_graph_cancel = threading.Event()
_graph_state: Dict[str, Any] = {
    "running": False,
    "job_id": "",
    "source_dir": "",
    "processed_items": 0,
    "total_items": 0,
    "references_found": 0,
    "edges_created": 0,
    "step": "",
    "error": "",
}


def _run_graph_build(job_id: str, source_dir: str) -> None:
    references_found = 0
    edges_created = 0
    processed = 0
    try:
        items = list_graph_source_items(source_dir)
        _graph_state.update({"total_items": len(items), "step": "Building local match index"})
        match_index = build_match_index()

        for item in items:
            if _graph_cancel.is_set():
                finish_graph_job(job_id, "cancelled")
                _graph_state["step"] = "Cancelled"
                return

            _graph_state["step"] = f"Fetching references for {item.get('title') or item['item_key']}"
            try:
                result = index_item_references(item, match_index)
                references_found += int(result.get("references") or 0)
                edges_created += int(result.get("edges") or 0)
            except Exception as exc:
                logger.warning("Citation graph indexing failed for %s: %s", item.get("item_key"), exc)

            processed += 1
            _graph_state.update({
                "processed_items": processed,
                "references_found": references_found,
                "edges_created": edges_created,
            })
            update_graph_job(job_id, processed, references_found, edges_created)
            time.sleep(0.25)

        finish_graph_job(job_id, "completed")
        _graph_state["step"] = "Ready"
    except Exception as exc:
        logger.error("Citation graph build failed: %s", exc)
        _graph_state["error"] = str(exc)
        finish_graph_job(job_id, "error", str(exc))
    finally:
        _graph_state["running"] = False
        _graph_cancel.clear()


@router.get("/api/citation-graph/status")
def citation_graph_status_route(source_dir: str = "") -> Dict[str, Any]:
    status = get_graph_status(source_dir)
    if _graph_state.get("running") and (_graph_state.get("source_dir") or "") == (source_dir or ""):
        status["status"] = "indexing"
        status["running_job"] = dict(_graph_state)
    return status


@router.post("/api/citation-graph/build")
def citation_graph_build_route(body: Dict[str, Any]) -> Dict[str, Any]:
    source_dir = (body.get("source_dir") or "").strip()
    with _graph_lock:
        if _graph_state.get("running"):
            return {"status": "already_running", "running_job": dict(_graph_state)}
        items = list_graph_source_items(source_dir)
        if not items:
            raise HTTPException(status_code=400, detail="No DOI-bearing library items found for this scope.")
        job_id = str(uuid.uuid4())[:12]
        create_graph_job(job_id, source_dir, len(items))
        _graph_cancel.clear()
        _graph_state.update({
            "running": True,
            "job_id": job_id,
            "source_dir": source_dir,
            "processed_items": 0,
            "total_items": len(items),
            "references_found": 0,
            "edges_created": 0,
            "step": "Starting citation graph build",
            "error": "",
        })
        thread = threading.Thread(target=_run_graph_build, args=(job_id, source_dir), daemon=True)
        thread.start()
    return {"status": "started", "job_id": job_id, "total_items": len(items), "source_dir": source_dir}


@router.post("/api/citation-graph/cancel")
def citation_graph_cancel_route() -> Dict[str, Any]:
    if not _graph_state.get("running"):
        return {"status": "not_running"}
    _graph_cancel.set()
    return {"status": "cancelling", "job_id": _graph_state.get("job_id", "")}


@router.get("/api/citation-graph/map")
def citation_graph_map_route(
    source_dir: str = "",
    include_outside: bool = True,
    min_confidence: float = 0.85,
    limit: int = 500,
) -> Dict[str, Any]:
    return get_citation_graph_map(
        source_dir=source_dir,
        include_outside=include_outside,
        min_confidence=max(0.0, min(float(min_confidence), 1.0)),
        limit=max(1, min(int(limit), 1000)),
    )
