"""Tag routes."""

from typing import Any, Dict

from fastapi import APIRouter, HTTPException

from app.database import create_tag, delete_tag as delete_tag_db, get_all_tags, update_tag as update_tag_db

router = APIRouter(tags=["tags"])


@router.get("/api/tags")
def tags_route() -> Dict:
    return {"tags": get_all_tags()}


@router.post("/api/tags")
def create_tag_route(body: Dict[str, Any]) -> Dict:
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name is required.")
    color = body.get("color", "")
    parent_id = body.get("parent_id") or None
    tag_id = create_tag(name, color, parent_id)
    return {"status": "created", "tag_id": tag_id}


@router.patch("/api/tags/{tag_id}")
def update_tag_route(tag_id: int, body: Dict[str, Any]) -> Dict:
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name is required.")
    color = body.get("color", "")
    parent_id = body.get("parent_id") or None
    update_tag_db(tag_id, name, color, parent_id)
    return {"status": "updated", "tag_id": tag_id}


@router.delete("/api/tags/{tag_id}")
def delete_tag_route(tag_id: int) -> Dict:
    if not delete_tag_db(tag_id):
        raise HTTPException(status_code=404, detail="Tag not found.")
    return {"status": "deleted", "tag_id": tag_id}
