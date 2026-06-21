"""Project and thesis workspace routes."""

from typing import Any, Dict

from fastapi import APIRouter, HTTPException

from app.database import (
    add_annotation_to_project,
    add_item_to_project,
    add_theme_root_to_project,
    auto_code_annotation,
    create_project,
    delete_project as delete_project_db,
    get_item,
    get_project,
    get_project_detail,
    get_project_theme_roots,
    get_projects_for_item,
    get_tags_for_annotation,
    list_projects,
    patch_project as patch_project_db,
    remove_annotation_from_project,
    remove_item_from_project,
    remove_theme_root_from_project,
    suggest_themes_for_annotation,
)

router = APIRouter(tags=["projects"])


@router.get("/api/projects")
def projects_route() -> Dict:
    return {"projects": list_projects()}


@router.post("/api/projects")
def create_project_route(body: Dict[str, Any]) -> Dict:
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Project name is required.")
    project_id = create_project(body)
    return {"status": "created", "project_id": project_id, "project": get_project(project_id)}


@router.get("/api/projects/{project_id}")
def project_detail_route(project_id: int) -> Dict:
    project = get_project_detail(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found.")
    return {"project": project}


@router.patch("/api/projects/{project_id}")
def update_project_route(project_id: int, body: Dict[str, Any]) -> Dict:
    if not get_project(project_id):
        raise HTTPException(status_code=404, detail="Project not found.")
    if not patch_project_db(project_id, body):
        raise HTTPException(status_code=404, detail="Project not found.")
    return {"status": "updated", "project": get_project(project_id)}


@router.delete("/api/projects/{project_id}")
def delete_project_route(project_id: int) -> Dict:
    if not delete_project_db(project_id):
        raise HTTPException(status_code=404, detail="Project not found.")
    return {"status": "deleted", "project_id": project_id}


@router.post("/api/projects/{project_id}/items")
def add_project_item_route(project_id: int, body: Dict[str, Any]) -> Dict:
    if not get_project(project_id):
        raise HTTPException(status_code=404, detail="Project not found.")
    item_key = body.get("item_key") or ""
    if not item_key:
        raise HTTPException(status_code=400, detail="item_key is required.")
    if not get_item(item_key):
        raise HTTPException(status_code=404, detail="Item not found.")
    add_item_to_project(
        project_id,
        item_key,
        reading_status=body.get("reading_status") or "",
        note=body.get("note") or "",
    )
    return {"status": "added", "project_id": project_id, "item_key": item_key}


@router.delete("/api/projects/{project_id}/items/{item_key}")
def remove_project_item_route(project_id: int, item_key: str) -> Dict:
    if not remove_item_from_project(project_id, item_key):
        raise HTTPException(status_code=404, detail="Project item not found.")
    return {"status": "removed", "project_id": project_id, "item_key": item_key}


@router.post("/api/projects/{project_id}/annotations")
def add_project_annotation_route(project_id: int, body: Dict[str, Any]) -> Dict:
    if not get_project(project_id):
        raise HTTPException(status_code=404, detail="Project not found.")
    annotation_id = body.get("annotation_id")
    if not annotation_id:
        raise HTTPException(status_code=400, detail="annotation_id is required.")
    add_annotation_to_project(project_id, int(annotation_id), role=body.get("role") or "")
    return {"status": "added", "project_id": project_id, "annotation_id": int(annotation_id)}


@router.delete("/api/projects/{project_id}/annotations/{annotation_id}")
def remove_project_annotation_route(project_id: int, annotation_id: int) -> Dict:
    if not remove_annotation_from_project(project_id, annotation_id):
        raise HTTPException(status_code=404, detail="Project annotation not found.")
    return {"status": "removed", "project_id": project_id, "annotation_id": annotation_id}


@router.get("/api/projects/{project_id}/theme-roots")
def project_theme_roots_route(project_id: int) -> Dict:
    if not get_project(project_id):
        raise HTTPException(status_code=404, detail="Project not found.")
    return {"theme_roots": get_project_theme_roots(project_id)}


@router.post("/api/projects/{project_id}/theme-roots")
def add_project_theme_root_route(project_id: int, body: Dict[str, Any]) -> Dict:
    if not get_project(project_id):
        raise HTTPException(status_code=404, detail="Project not found.")
    tag_id = body.get("tag_id")
    if not tag_id:
        raise HTTPException(status_code=400, detail="tag_id is required.")
    add_theme_root_to_project(
        project_id,
        int(tag_id),
        include_descendants=bool(body.get("include_descendants", True)),
    )
    return {"status": "added", "project_id": project_id, "tag_id": int(tag_id), "theme_roots": get_project_theme_roots(project_id)}


@router.delete("/api/projects/{project_id}/theme-roots/{tag_id}")
def remove_project_theme_root_route(project_id: int, tag_id: int) -> Dict:
    if not remove_theme_root_from_project(project_id, tag_id):
        raise HTTPException(status_code=404, detail="Project theme root not found.")
    return {"status": "removed", "project_id": project_id, "tag_id": tag_id, "theme_roots": get_project_theme_roots(project_id)}


@router.get("/api/items/{item_key}/projects")
def item_projects_route(item_key: str) -> Dict:
    return {"projects": get_projects_for_item(item_key)}


@router.post("/api/annotations/{annotation_id}/theme-suggestions")
def annotation_theme_suggestions_route(annotation_id: int, body: Dict[str, Any]) -> Dict:
    project_id = body.get("project_id")
    limit = int(body.get("limit") or 6)
    return {
        "annotation_id": annotation_id,
        "suggestions": suggest_themes_for_annotation(
            annotation_id,
            project_id=int(project_id) if project_id else None,
            limit=limit,
        ),
    }


@router.post("/api/annotations/{annotation_id}/auto-code")
def annotation_auto_code_route(annotation_id: int, body: Dict[str, Any]) -> Dict:
    project_id = body.get("project_id")
    min_confidence = float(body.get("min_confidence") or 0.85)
    result = auto_code_annotation(
        annotation_id,
        project_id=int(project_id) if project_id else None,
        min_confidence=min_confidence,
    )
    result["annotation_id"] = annotation_id
    result["tags"] = get_tags_for_annotation(annotation_id)
    return result
