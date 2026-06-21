"""Zotero and Mendeley import routes."""

import asyncio
import json
import threading
from pathlib import Path
from typing import Any, AsyncGenerator, Dict

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from app.config import config, get_settings, save_settings

router = APIRouter(tags=["imports"])

_zotero_import_state: Dict[str, Any] = {"running": False, "step": "", "detail": "", "result": None}
_zotero_import_lock = threading.Lock()
_mendeley_import_state: Dict[str, Any] = {"running": False, "step": "", "detail": "", "result": None}
_mendeley_import_lock = threading.Lock()


def _sse(data: dict) -> str:
    return f"data: {json.dumps(data)}\n\n"


@router.get("/api/zotero/detect")
def zotero_detect_route() -> Dict:
    from app.zotero_importer import detect_zotero, get_zotero_preview

    db_path = detect_zotero()
    if not db_path:
        return {"found": False}
    try:
        preview = get_zotero_preview(db_path)
        return {"found": True, "db_path": db_path, **preview}
    except Exception as exc:
        return {"found": True, "db_path": db_path, "error": str(exc)}


@router.post("/api/zotero/import")
async def zotero_import_route(body: Dict[str, Any]) -> StreamingResponse:
    db_path = body.get("db_path", "")
    dest_path = body.get("dest_path", "")
    label = body.get("label", "My Library")

    if not db_path or not dest_path:
        raise HTTPException(status_code=400, detail="db_path and dest_path are required.")

    with _zotero_import_lock:
        if _zotero_import_state["running"]:
            raise HTTPException(status_code=409, detail="Import already running.")
        _zotero_import_state.update({"running": True, "step": "Starting\u2026", "detail": "", "result": None})

    async def event_stream() -> AsyncGenerator[str, None]:
        from app.zotero_importer import import_zotero_library

        loop = asyncio.get_event_loop()
        queue: asyncio.Queue = asyncio.Queue()

        def progress_cb(step: str, detail: str = "") -> None:
            _zotero_import_state["step"] = step
            _zotero_import_state["detail"] = detail
            loop.call_soon_threadsafe(queue.put_nowait, {"type": "progress", "step": step, "detail": detail})

        def run_import() -> None:
            try:
                result = import_zotero_library(db_path, dest_path, progress_callback=progress_cb)
                _zotero_import_state["result"] = result
                loop.call_soon_threadsafe(queue.put_nowait, {"type": "done", **result})
            except Exception as exc:
                err = str(exc)
                _zotero_import_state["result"] = {"status": "error", "error": err}
                loop.call_soon_threadsafe(queue.put_nowait, {"type": "error", "error": err})
            finally:
                _zotero_import_state["running"] = False

        thread = threading.Thread(target=run_import, daemon=True)
        thread.start()

        while True:
            msg = await queue.get()
            yield _sse(msg)
            if msg.get("type") in ("done", "error"):
                if msg.get("type") == "done" and msg.get("status") == "success":
                    dest = msg.get("destination", dest_path)
                    norm = str(Path(dest).expanduser().resolve())
                    current = get_settings()
                    dirs = current.get("reference_dirs", [])
                    already = any(str(Path(d["path"]).expanduser().resolve()) == norm for d in dirs)
                    if not already:
                        dirs.append({"path": dest, "label": label})
                        current["reference_dirs"] = dirs
                        save_settings(current)
                        config.reload()
                break

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.get("/api/mendeley/detect")
def mendeley_detect_route() -> Dict:
    from app.mendeley_importer import detect_mendeley, get_mendeley_preview

    db_path = detect_mendeley()
    if not db_path:
        return {"found": False}
    try:
        preview = get_mendeley_preview(db_path)
        return {"found": True, "db_path": db_path, **preview}
    except Exception as exc:
        return {"found": True, "db_path": db_path, "error": str(exc)}


@router.post("/api/mendeley/import")
async def mendeley_import_route(body: Dict[str, Any]) -> StreamingResponse:
    db_path = body.get("db_path", "")
    dest_path = body.get("dest_path", "")
    label = body.get("label", "Mendeley Library")

    if not db_path or not dest_path:
        raise HTTPException(status_code=400, detail="db_path and dest_path are required.")

    with _mendeley_import_lock:
        if _mendeley_import_state["running"]:
            raise HTTPException(status_code=409, detail="Import already running.")
        _mendeley_import_state.update({"running": True, "step": "Starting\u2026", "detail": "", "result": None})

    async def event_stream() -> AsyncGenerator[str, None]:
        from app.mendeley_importer import import_mendeley_library

        loop = asyncio.get_event_loop()
        queue: asyncio.Queue = asyncio.Queue()

        def progress_cb(step: str, detail: str = "") -> None:
            _mendeley_import_state["step"] = step
            _mendeley_import_state["detail"] = detail
            loop.call_soon_threadsafe(queue.put_nowait, {"type": "progress", "step": step, "detail": detail})

        def run_import() -> None:
            try:
                result = import_mendeley_library(db_path, dest_path, progress_callback=progress_cb)
                _mendeley_import_state["result"] = result
                loop.call_soon_threadsafe(queue.put_nowait, {"type": "done", **result})
            except Exception as exc:
                err = str(exc)
                _mendeley_import_state["result"] = {"status": "error", "error": err}
                loop.call_soon_threadsafe(queue.put_nowait, {"type": "error", "error": err})
            finally:
                _mendeley_import_state["running"] = False

        thread = threading.Thread(target=run_import, daemon=True)
        thread.start()

        while True:
            msg = await queue.get()
            yield _sse(msg)
            if msg.get("type") in ("done", "error"):
                if msg.get("type") == "done":
                    dest = msg.get("destination", dest_path)
                    norm = str(Path(dest).expanduser().resolve())
                    current = get_settings()
                    dirs = current.get("reference_dirs", [])
                    already = any(str(Path(d["path"]).expanduser().resolve()) == norm for d in dirs)
                    if not already:
                        dirs.append({"path": dest, "label": label})
                        current["reference_dirs"] = dirs
                        save_settings(current)
                        config.reload()
                break

    return StreamingResponse(event_stream(), media_type="text/event-stream")
