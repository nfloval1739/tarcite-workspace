"""Crossref citation-count refresh helpers."""

import logging
import time
from typing import Any, Dict

from app.database import get_items_for_citation_count_refresh, update_item_citation_count

logger = logging.getLogger(__name__)


def refresh_crossref_counts_for_sources(
    sources: list[Dict[str, Any]],
    delay_seconds: float = 0.0,
) -> list[Dict[str, Any]]:
    from app.crossref import fetch_crossref_metadata

    refreshed: list[Dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for source in sources:
        item_key = source.get("item_key", "")
        doi = (source.get("doi") or "").strip()
        if not item_key or not doi:
            continue
        identity = (item_key, doi.lower())
        if identity in seen:
            continue
        seen.add(identity)
        if delay_seconds > 0 and seen:
            time.sleep(delay_seconds)
        try:
            metadata = fetch_crossref_metadata(doi)
            if not metadata:
                continue
            count = int(metadata.get("citation_count") or 0)
            updated_at = metadata.get("citation_count_updated_at", "")
            update_item_citation_count(item_key, count, updated_at)
            refreshed.append({
                "item_key": item_key,
                "citation_count": count,
                "citation_count_updated_at": updated_at,
            })
        except Exception as exc:
            logger.info("Crossref citation count refresh failed for %s: %s", doi, exc)
    return refreshed


def refresh_crossref_counts_for_library() -> None:
    try:
        items = get_items_for_citation_count_refresh()
    except Exception as exc:
        logger.info("Could not load items for citation count refresh: %s", exc)
        return
    if not items:
        return

    logger.info("Refreshing Crossref citation counts for %d DOI item(s)", len(items))
    sources = [{"item_key": item.get("item_key", ""), "doi": item.get("doi", "")} for item in items]
    refreshed = refresh_crossref_counts_for_sources(sources, delay_seconds=1.5)
    logger.info("Refreshed Crossref citation counts for %d item(s)", len(refreshed))
