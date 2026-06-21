"""Annotation routes."""

from typing import Any, Dict

from fastapi import APIRouter, HTTPException

from app.database import (
    create_annotation,
    delete_annotation as delete_annotation_db,
    get_all_annotations_for_synthesis,
    get_annotations_for_item,
    get_tags_for_annotation,
    import_item_annotations,
    set_annotation_tags,
    update_annotation,
)

router = APIRouter(tags=["annotations"])


@router.get("/api/items/{item_key}/annotations")
def item_annotations_route(item_key: str) -> Dict:
    return {"annotations": get_annotations_for_item(item_key)}


@router.post("/api/items/{item_key}/annotations")
def create_annotation_route(item_key: str, body: Dict[str, Any]) -> Dict:
    body["item_key"] = item_key
    body.setdefault("file_id", None)
    body.setdefault("page_index", 0)
    body.setdefault("color", "")
    body.setdefault("quote", "")
    body.setdefault("comment", "")
    body.setdefault("geometry_json", "{}")
    body.setdefault("source_chunk_id", "")
    body.setdefault("sentiment", None)
    if "annotation_type" not in body:
        raise HTTPException(status_code=400, detail="annotation_type is required.")
    annotation_id = create_annotation(body)
    return {"status": "created", "annotation_id": annotation_id}


@router.patch("/api/annotations/{annotation_id}")
def update_annotation_route(annotation_id: int, body: Dict[str, Any]) -> Dict:
    body.setdefault("annotation_type", "highlight")
    body.setdefault("color", "")
    body.setdefault("quote", "")
    body.setdefault("comment", "")
    body.setdefault("geometry_json", "{}")
    body["annotation_id"] = annotation_id
    update_annotation(annotation_id, body)
    return {"status": "updated", "annotation_id": annotation_id}


@router.delete("/api/annotations/{annotation_id}")
def delete_annotation_route(annotation_id: int) -> Dict:
    if not delete_annotation_db(annotation_id):
        raise HTTPException(status_code=404, detail="Annotation not found.")
    return {"status": "deleted", "annotation_id": annotation_id}


@router.post("/api/items/{item_key}/import-annotations")
def import_annotations_route(item_key: str) -> Dict:
    result = import_item_annotations(item_key)
    if result.get("error"):
        raise HTTPException(status_code=400, detail=result["error"])
    return result


@router.get("/api/annotations")
def all_annotations_route() -> Dict:
    return {"annotations": get_all_annotations_for_synthesis()}


@router.put("/api/annotations/{annotation_id}/tags")
def set_annotation_tags_route(annotation_id: int, body: Dict[str, Any]) -> Dict:
    tag_ids = body.get("tag_ids", [])
    if not isinstance(tag_ids, list):
        raise HTTPException(status_code=400, detail="tag_ids must be a list.")
    set_annotation_tags(annotation_id, [int(t) for t in tag_ids])
    return {"status": "updated", "annotation_id": annotation_id, "tags": get_tags_for_annotation(annotation_id)}
