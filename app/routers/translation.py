"""Offline translation package and translation routes.

Handlers that block — CPU-bound translation, or network calls to the Argos
package index — are deliberately plain `def` rather than `async def`.  FastAPI
dispatches sync handlers to a threadpool, whereas an `async def` handler runs
*on* the single event loop: while it blocks, uvicorn never returns to accept()
and every other request in the app stalls behind it.  That is not theoretical —
one translation froze the whole server for ~30 seconds, so saving an annotation
in the viewer failed with ERR_TIMED_OUT until the translation finished.
Only the handlers that just read in-memory state stay async.
"""

import logging
from typing import Any, Dict

from fastapi import APIRouter, HTTPException

logger = logging.getLogger(__name__)

router = APIRouter(tags=["translation"])


@router.get("/api/translation/packages")
def translation_packages_route() -> Dict:
    # Fetches the Argos package index over the network (10s timeout).
    from app.translation import list_translation_packages

    return list_translation_packages()


@router.post("/api/translation/packages/{slug}/download")
def translation_start_download_route(slug: str) -> Dict:
    # start_download() issues a blocking HEAD request before spawning its thread.
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
def translate_selection_route(body: Dict[str, Any]) -> Dict:
    from app.translation import translate_text

    source = body.get("source_language", "en")
    target = body.get("target_language", "id")

    try:
        translated = translate_text(body.get("text", ""), source, target)
    except ValueError as exc:
        # Nothing selected, or a selection past the 5000-character limit.
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        # A missing language pack is a fixable state, not a malformed request —
        # answering 400 made it look like the app had sent something invalid.
        raise HTTPException(
            status_code=409,
            detail=f"{exc} Install it under Settings → Translation.",
        ) from exc
    except Exception as exc:
        logger.exception("Translation failed (%s → %s)", source, target)
        raise HTTPException(status_code=500, detail=f"Translation failed: {exc}") from exc

    return {
        "translation": translated,
        "source_language": source,
        "target_language": target,
    }
