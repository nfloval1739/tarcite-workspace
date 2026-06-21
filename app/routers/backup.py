"""Workspace backup and restore routes."""

import logging
from typing import Dict

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import StreamingResponse

from app.backup import (
    create_workspace_backup,
    get_workspace_backup_status,
    restore_workspace_backup,
)
from app.database import init_db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/backup", tags=["backup"])


@router.get("/status")
def backup_status_route() -> Dict:
    return get_workspace_backup_status()


@router.get("/export")
def backup_export_route(request: Request):
    buf, filename, _ = create_workspace_backup(request.app.version)
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/restore")
async def backup_restore_route(request: Request, file: UploadFile = File(...)) -> Dict:
    if not file.filename or not file.filename.lower().endswith(".zip"):
        raise HTTPException(status_code=400, detail="Choose a TarCite workspace backup .zip file.")
    try:
        raw = await file.read()
        result = restore_workspace_backup(raw, request.app.version)
        init_db()
        return result
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Workspace restore failed")
        raise HTTPException(status_code=500, detail=f"Restore failed: {exc}") from exc
