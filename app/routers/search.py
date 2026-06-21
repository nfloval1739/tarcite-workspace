"""Library search and model listing routes."""

from typing import Dict

from fastapi import APIRouter

from app.citation_formatter import (
    format_author_inline,
    format_full_reference,
    format_inline_citation,
    parse_creators,
)
from app.config import get_settings

router = APIRouter(tags=["search"])


@router.get("/api/quick-search")
def quick_search_route(q: str = "", limit: int = 5) -> Dict:
    """Global palette search across library items, annotations, projects, and tags."""
    from app.database import (
        get_all_tags,
        list_projects,
        search_items,
    )
    from app.repositories.core import get_connection as _ann_conn

    q = q.strip()
    if len(q) < 2:
        return {"items": [], "annotations": [], "projects": [], "tags": []}

    ql = q.lower()

    # Library items
    items_raw = search_items(q, limit=limit)
    items = [
        {
            "item_key": it["item_key"],
            "title": it.get("title", ""),
            "year": it.get("year", ""),
            "item_type": it.get("item_type", ""),
        }
        for it in items_raw
    ]

    # Annotations — direct SQL search for speed
    try:
        with _ann_conn() as conn:
            rows = conn.execute(
                """SELECT a.annotation_id, a.item_key, a.annotation_type,
                          a.page_index, a.quote, a.note,
                          i.title AS item_title
                   FROM annotations a
                   LEFT JOIN items i ON i.item_key = a.item_key
                   WHERE LOWER(a.quote) LIKE :q OR LOWER(a.note) LIKE :q
                   LIMIT :lim""",
                {"q": f"%{ql}%", "lim": limit},
            ).fetchall()
        annotations = []
        for row in rows:
            snippet = row["quote"] or row["note"] or ""
            if len(snippet) > 130:
                idx = snippet.lower().find(ql)
                start = max(0, idx - 45)
                snippet = ("…" if start > 0 else "") + snippet[start : start + 130] + "…"
            annotations.append(
                {
                    "annotation_id": row["annotation_id"],
                    "item_key": row["item_key"],
                    "item_title": row["item_title"] or "",
                    "page_index": row["page_index"] or 0,
                    "annotation_type": row["annotation_type"] or "highlight",
                    "snippet": snippet,
                }
            )
    except Exception:
        annotations = []

    # Projects
    all_projects = list_projects()
    projects = []
    for p in all_projects:
        haystack = " ".join(
            [p.get("name") or "", p.get("research_question") or "", p.get("objective") or ""]
        ).lower()
        if ql in haystack:
            projects.append(
                {
                    "project_id": p["project_id"],
                    "name": p.get("name", ""),
                    "project_type": p.get("project_type", ""),
                    "source_count": p.get("source_count", 0),
                }
            )
            if len(projects) >= limit:
                break

    # Tags/themes
    all_tags = get_all_tags()
    tags = []
    for t in all_tags:
        if ql in (t.get("name") or "").lower():
            tags.append(
                {
                    "tag_id": t["tag_id"],
                    "name": t.get("name", ""),
                    "color": t.get("color", ""),
                    "annotation_count": t.get("annotation_count", 0),
                }
            )
            if len(tags) >= limit:
                break

    return {"items": items, "annotations": annotations, "projects": projects, "tags": tags}


@router.get("/api/search-library")
def search_library_route(q: str = "", limit: int = 15) -> Dict:
    from app.database import search_items

    if not q.strip():
        return {"items": []}
    items = search_items(q.strip(), limit=limit)
    results = []
    for item in items:
        creators = parse_creators(item.get("creators", "[]"))
        results.append({
            "item_key": item["item_key"],
            "title": item.get("title", ""),
            "year": item.get("year", ""),
            "creators_formatted": format_author_inline(creators),
            "inline_citation": format_inline_citation(item),
            "full_reference": format_full_reference(item),
            "item_type": item.get("item_type", ""),
            "publication_title": item.get("publication_title", ""),
            "abstract": (item.get("abstract") or "")[:300],
        })
    return {"items": results}


@router.get("/api/models")
def get_models_route() -> Dict:
    settings = get_settings()
    profiles = settings.get("ai_profiles", [])
    active = settings.get("active_profile", "")
    models = []
    for profile in profiles:
        models.append({
            "name": profile.get("name", ""),
            "provider_label": profile.get("provider_label", ""),
            "ai_model": profile.get("ai_model", ""),
            "ai_api_base_url": profile.get("ai_api_base_url", ""),
            "is_active": profile.get("name", "") == active,
        })
    return {"models": models, "active_profile": active}
