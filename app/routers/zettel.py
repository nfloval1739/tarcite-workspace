"""Evidence-anchored zettelkasten routes.

Modelled on ``app/routers/projects.py``: ``APIRouter(tags=[...])`` with no
prefix, ``Dict[str, Any]`` bodies, ``-> Dict`` returns, manual ``HTTPException``.
"""

from __future__ import annotations

import io
import json
import logging
import threading
import uuid
import zipfile
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from app.repositories import zettel
from app.repositories.annotations import get_annotation

logger = logging.getLogger(__name__)
router = APIRouter(tags=["zettel"])

# ── Background recompute job registry ────────────────────────────────────────

_jobs: Dict[str, Dict[str, Any]] = {}
_jobs_lock = threading.Lock()


def _run_recompute_job(job_id: str, kinds: List[str]) -> None:
    try:
        report = zettel.recompute_all(kinds)
        with _jobs_lock:
            _jobs[job_id] = {"status": "completed", "report": report}
    except Exception as exc:
        logger.error("Zettel recompute job %s failed: %s", job_id, exc)
        with _jobs_lock:
            _jobs[job_id] = {"status": "failed", "error": str(exc)}


# ── Notes ───────────────────────────────────────────────────────────────────


@router.get("/api/zettel/notes")
def list_notes_route(item_key: Optional[str] = None, tag: Optional[str] = None, q: Optional[str] = None) -> Dict:
    return {"notes": zettel.list_notes(item_key=item_key, tag=tag, q=q)}


@router.post("/api/zettel/notes")
def create_note_route(body: Dict[str, Any]) -> Dict:
    title = (body.get("title") or "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="Note title is required.")
    anchor_id = body.get("anchor_annotation_id")
    if anchor_id is not None and not get_annotation(int(anchor_id)):
        raise HTTPException(status_code=404, detail="Anchor annotation not found.")
    data = dict(body)
    if anchor_id is not None:
        data["anchor_annotation_id"] = int(anchor_id)
    note_id = zettel.create_note(data)
    return {"status": "created", "note_id": note_id, "note": zettel.get_note(note_id)}


@router.get("/api/zettel/notes/{note_id}")
def get_note_route(note_id: int) -> Dict:
    note = zettel.get_note(note_id)
    if not note:
        raise HTTPException(status_code=404, detail="Note not found.")
    # Attach links + evidence so the frontend's single detail call has
    # everything the Editor / Backlinks / Evidence sections need.
    note["links"] = zettel.list_links_for_note(note_id)
    note["evidence"] = zettel.get_evidence(note_id)
    return {"note": note}


@router.patch("/api/zettel/notes/{note_id}")
def patch_note_route(note_id: int, body: Dict[str, Any]) -> Dict:
    if not zettel.get_note(note_id):
        raise HTTPException(status_code=404, detail="Note not found.")
    if "anchor_annotation_id" in body and body["anchor_annotation_id"] is not None:
        if not get_annotation(int(body["anchor_annotation_id"])):
            raise HTTPException(status_code=404, detail="Anchor annotation not found.")
    note = zettel.patch_note(note_id, body)
    if not note:
        raise HTTPException(status_code=404, detail="Note not found.")
    return {"status": "updated", "note": note}


@router.delete("/api/zettel/notes/{note_id}")
def delete_note_route(note_id: int) -> Dict:
    if not zettel.delete_note(note_id):
        raise HTTPException(status_code=404, detail="Note not found.")
    return {"status": "deleted", "note_id": note_id}


# ── Links ───────────────────────────────────────────────────────────────────


@router.post("/api/zettel/notes/{note_id}/links")
def create_link_route(note_id: int, body: Dict[str, Any]) -> Dict:
    if not zettel.get_note(note_id):
        raise HTTPException(status_code=404, detail="Note not found.")
    target_id = body.get("target_note_id")
    if not target_id or not zettel.get_note(int(target_id)):
        raise HTTPException(status_code=404, detail="Target note not found.")
    data = dict(body)
    data["source_note_id"] = note_id
    data["target_note_id"] = int(target_id)
    link_id = zettel.create_link(data)
    if link_id is None:
        raise HTTPException(status_code=400, detail="Invalid link (bad type, self-link, or duplicate).")
    return {"status": "created", "link_id": link_id}


@router.delete("/api/zettel/links/{link_id}")
def delete_link_route(link_id: int) -> Dict:
    if not zettel.delete_link(link_id):
        raise HTTPException(status_code=404, detail="Link not found.")
    return {"status": "deleted", "link_id": link_id}


@router.get("/api/zettel/notes/{note_id}/links")
def list_links_route(note_id: int) -> Dict:
    if not zettel.get_note(note_id):
        raise HTTPException(status_code=404, detail="Note not found.")
    return zettel.list_links_for_note(note_id)


@router.get("/api/zettel/notes/{note_id}/backlinks")
def backlinks_route(note_id: int) -> Dict:
    if not zettel.get_note(note_id):
        raise HTTPException(status_code=404, detail="Note not found.")
    return {"backlinks": zettel.get_backlinks(note_id)}


@router.get("/api/zettel/notes/{note_id}/evidence")
def evidence_route(note_id: int) -> Dict:
    if not zettel.get_note(note_id):
        raise HTTPException(status_code=404, detail="Note not found.")
    evidence = zettel.get_evidence(note_id)
    if not evidence:
        raise HTTPException(status_code=404, detail="Note is not anchored to an annotation.")
    return {"evidence": evidence}


# ── Graph + recompute ───────────────────────────────────────────────────────


# ── Graph + recompute + analytics ───────────────────────────────────────────


@router.get("/api/zettel/graph")
def graph_route(
    item_key: Optional[str] = None,
    scope: Optional[str] = None,
    center_id: Optional[int] = None,
    depth: int = 1,
) -> Dict:
    return zettel.get_graph_data(
        item_key=item_key, scope=scope, center_id=center_id, depth=depth
    )


@router.get("/api/zettel/analytics")
def analytics_route(item_key: Optional[str] = None) -> Dict:
    return zettel.get_graph_analytics(item_key=item_key)


@router.post("/api/zettel/recompute")
def recompute_route(body: Dict[str, Any] = None) -> Dict:
    body = body or {}
    kinds = body.get("kinds") or ["shared_evidence", "semantic", "contradiction"]
    valid = {"shared_evidence", "shared_theme", "semantic", "contradiction"}
    kinds = [k for k in kinds if k in valid] or ["shared_evidence"]

    # shared_evidence is cheap pure SQL — run synchronously so the caller sees
    # the result immediately. semantic/contradiction are heavier (embeddings/LLM)
    # so they run in a background thread; return 202 with a job id.
    report: Dict[str, int] = {}
    background_kinds: List[str] = []
    if "shared_evidence" in kinds or "shared_theme" in kinds:
        report["shared_evidence"] = zettel.recompute_shared_evidence()
    if "semantic" in kinds:
        background_kinds.append("semantic")
    if "contradiction" in kinds:
        background_kinds.append("contradiction")

    if not background_kinds:
        return {"status": "completed", "report": report}

    job_id = str(uuid.uuid4())
    with _jobs_lock:
        _jobs[job_id] = {"status": "running", "report": report}
    threading.Thread(
        target=_run_recompute_job, args=(job_id, background_kinds), daemon=True
    ).start()
    return {"status": "accepted", "job_id": job_id, "report": report}


@router.get("/api/zettel/recompute/{job_id}")
def recompute_status_route(job_id: str) -> Dict:
    with _jobs_lock:
        job = _jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")
    return job


# ── Export ───────────────────────────────────────────────────────────────────


@router.get("/api/zettel/export")
def export_route(format: str = "mdzip", item_key: Optional[str] = None) -> Any:
    if format == "mdzip":
        return _export_mdzip()
    if format == "html":
        html_content = zettel.export_standalone_html(item_key=item_key)
        return StreamingResponse(
            io.BytesIO(html_content.encode("utf-8")),
            media_type="text/html",
            headers={"Content-Disposition": "attachment; filename=tarcite-graph.html"},
        )
    raise HTTPException(status_code=400, detail=f"Unknown export format: {format}")


def _export_mdzip() -> StreamingResponse:
    """Bundle every note's ``.md`` file into a zip archive (server-side)."""
    from pathlib import Path

    from app.config import config

    notes = zettel.list_notes()
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for note in notes:
            fp = note.get("file_path") or f"note-{note['note_id']}.md"
            content = f"---\n{json.dumps({'note_id': note['note_id'], 'title': note.get('title')}, ensure_ascii=False)}\n---\n\n{note.get('body_md') or ''}\n"
            if note.get("file_path"):
                p = Path(config.notes_dir) / fp
                try:
                    content = p.read_text(encoding="utf-8")
                except OSError:
                    pass
            zf.writestr(fp, content)
    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": "attachment; filename=tarcite-notes.zip"},
    )