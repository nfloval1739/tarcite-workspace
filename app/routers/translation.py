"""Offline translation package and translation routes."""

from typing import Any, Dict

from fastapi import APIRouter, HTTPException

router = APIRouter(tags=["translation"])


@router.get("/api/translation/packages")
async def translation_packages_route() -> Dict:
    from app.translation import list_translation_packages

    return list_translation_packages()


@router.post("/api/translation/packages/{slug}/download")
async def translation_start_download_route(slug: str) -> Dict:
    from app.translation import get_progress, start_download

    try:
        started = start_download(slug)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {"started": started, "slug": slug, "state": get_progress(slug)}


@router.get("/api/translation/progress")
async def translation_progress_route() -> Dict:
    from app.translation import get_all_progress

    return {"downloads": get_all_progress()}


@router.post("/api/translation/packages/{slug}/cancel")
async def translation_cancel_download_route(slug: str) -> Dict:
    from app.translation import cancel_download

    return {"cancelled": cancel_download(slug), "slug": slug}


@router.post("/api/translation/translate")
async def translate_selection_route(body: Dict[str, Any]) -> Dict:
    from app.translation import translate_text

    try:
        translated = translate_text(
            body.get("text", ""),
            body.get("source_language", "en"),
            body.get("target_language", "id"),
        )
        return {
            "translation": translated,
            "source_language": body.get("source_language", "en"),
            "target_language": body.get("target_language", "id"),
        }
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
