"""Library sync routes and background sync state."""

import logging
import threading
from typing import Any, Dict, Optional

from fastapi import APIRouter

from app.schemas import SyncRequest

logger = logging.getLogger(__name__)
router = APIRouter(tags=["sync"])

_sync_lock = threading.Lock()
_sync_state: Dict[str, Any] = {
    "running": False,
    "step": "",
    "detail": "",
    "result": None,
}


def _run_sync(force_resync: bool, dir_path: Optional[str] = None) -> None:
    from app.sync import sync_library

    def progress_cb(step: str, detail: str = "") -> None:
        _sync_state["step"] = step
        _sync_state["detail"] = detail

    try:
        result = sync_library(force_resync=force_resync, progress_callback=progress_cb, dir_path=dir_path)
        _sync_state["result"] = result
    except Exception as exc:
        logger.error("Sync thread error: %s", exc)
        _sync_state["result"] = {"status": "error", "error": str(exc)}
    finally:
        _sync_state["running"] = False


@router.post("/api/sync")
async def sync_route(body: SyncRequest) -> Dict:
    with _sync_lock:
        if _sync_state["running"]:
            return {"status": "already_running", "message": "Scan is already in progress."}
        _sync_state.update({"running": True, "step": "Starting\u2026", "detail": "", "result": None})

    thread = threading.Thread(
        target=_run_sync,
        args=(body.force_resync, body.dir_path),
        daemon=True,
    )
    thread.start()
    return {"status": "started", "message": "Directory scan started in background."}


@router.get("/api/sync/status")
def sync_status_route() -> Dict:
    return dict(_sync_state)


def _run_repair() -> None:
    from app.sync import fill_chromadb_gaps

    def progress_cb(step: str, detail: str = "") -> None:
        _sync_state["step"] = step
        _sync_state["detail"] = detail

    try:
        result = fill_chromadb_gaps(progress_callback=progress_cb)
        _sync_state["result"] = result
    except Exception as exc:
        logger.error("Repair thread error: %s", exc)
        _sync_state["result"] = {"status": "error", "error": str(exc)}
    finally:
        _sync_state["running"] = False


@router.post("/api/library/repair-index")
async def repair_index_route() -> Dict:
    """Rebuild ChromaDB vectors for items present in FTS but missing from the
    vector store — from cached text, without re-reading any PDF."""
    with _sync_lock:
        if _sync_state["running"]:
            return {"status": "already_running", "message": "A sync or repair is already in progress."}
        _sync_state.update({"running": True, "step": "Repairing vector index…", "detail": "", "result": None})

    thread = threading.Thread(target=_run_repair, daemon=True)
    thread.start()
    return {"status": "started", "message": "Vector index repair started in background."}


@router.get("/api/library/text-failures")
def text_failures_route() -> Dict:
    """Items whose PDF text extraction crashed/timed out, for UI surfacing."""
    from app.database import get_text_failed_items
    items = get_text_failed_items()
    return {"count": len(items), "items": items}
