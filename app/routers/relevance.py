"""Single-source relevance check route."""

import json
import logging
from typing import Dict

from fastapi import APIRouter, HTTPException

from app.ai_client import QuotaExceededError
from app.citation_formatter import (
    format_author_inline,
    format_full_reference,
    format_inline_citation,
    parse_creators,
)
from app.quota import call_with_quota_fallback
from app.schemas import CheckRelevanceRequest

logger = logging.getLogger(__name__)
router = APIRouter(tags=["relevance"])


@router.post("/api/check-relevance")
def check_relevance_route(body: CheckRelevanceRequest) -> Dict:
    from app.ai_client import check_single_relevance
    from app.database import get_fulltext_for_item, get_item

    item = get_item(body.item_key)
    if not item:
        raise HTTPException(status_code=404, detail="Item not found. Please scan your references directory.")

    creators = parse_creators(item.get("creators", "[]"))
    source = {
        **item,
        "creators": creators,
        "inline_citation": format_inline_citation(item),
        "full_reference": format_full_reference(item),
        "creators_formatted": format_author_inline(creators),
        "chunks": [],
        "best_source_type": "abstract",
    }

    text_parts = []
    abstract = item.get("abstract", "")
    if abstract:
        text_parts.append(("abstract", abstract))

    for fulltext in get_fulltext_for_item(body.item_key):
        content = fulltext.get("content", "")
        if content:
            text_parts.append(("fulltext", content))

    if text_parts:
        combined = ""
        for source_type, text in text_parts:
            combined += f"[{source_type.upper()}]\n{text}\n\n"
            if len(combined) > 8000:
                break
        source["chunks"] = [{
            "chunk_text": combined[:8000],
            "metadata": {"source_type": text_parts[0][0]},
            "similarity": 0.0,
        }]
        source["best_source_type"] = text_parts[0][0]
        source["abstract"] = combined[:1200]

    try:
        return check_single_relevance(body.paragraph, source)
    except QuotaExceededError:
        try:
            result, notifications = call_with_quota_fallback(check_single_relevance, body.paragraph, source)
            result["fallback_notifications"] = notifications
            return result
        except QuotaExceededError as exc:
            raise HTTPException(
                status_code=429,
                detail=json.dumps({
                    "error": "daily_limit_reached",
                    "message": str(exc),
                    "buy_url": exc.buy_url,
                }),
            )
    except Exception as exc:
        logger.error("check_relevance error: %s", exc)
        raise HTTPException(status_code=500, detail=f"AI error: {exc}")
