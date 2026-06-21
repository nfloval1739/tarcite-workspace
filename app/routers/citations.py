"""Citation suggestion streaming route."""

import asyncio
import json
import logging
import time
import uuid
from typing import Any, AsyncGenerator, Dict

from fastapi import APIRouter
from fastapi.responses import StreamingResponse

from app.ai_client import QuotaExceededError
from app.ai_client import suggest_citations as suggest_citations_ai
from app.citation_counts import refresh_crossref_counts_for_sources
from app.citation_formatter import (
    format_author_inline,
    format_full_reference,
    format_inline_citation,
    parse_creators,
)
from app.config import config
from app.database import add_suggestion_result, create_suggestion_run
from app.perf import log_duration
from app.quota import call_with_quota_fallback
from app.retrieval import search_and_retrieve
from app.schemas import CitationRequest

logger = logging.getLogger(__name__)
router = APIRouter(tags=["citations"])


def _sse(data: dict) -> str:
    return f"data: {json.dumps(data)}\n\n"


@router.post("/api/suggest-citations/stream")
async def suggest_citations_stream(body: CitationRequest) -> StreamingResponse:
    paragraph = body.paragraph.strip()
    run_id = str(uuid.uuid4())[:12]
    start_time = time.time()

    async def generate() -> AsyncGenerator[str, None]:
        if not paragraph:
            yield _sse({"type": "error", "message": "Paragraph cannot be empty."})
            return

        yield _sse({"type": "progress", "step": "Embedding paragraph\u2026", "pct": 8})

        try:
            with log_duration(logger, "suggest_citations retrieval", threshold_ms=500):
                retrieved = await asyncio.to_thread(
                    search_and_retrieve,
                    paragraph=paragraph,
                    top_k=body.top_k if body.top_k != 50 else config.suggestion_top_k,
                    collection_key=body.collection_key,
                    source_dir=body.source_dir,
                    reranker_model=config.reranker_model,
                    use_hyde=True,
                    use_mmr=True,
                )
        except Exception as exc:
            logger.error("Retrieval error: %s", exc)
            yield _sse({"type": "error", "message": f"Search error: {exc}"})
            return

        n_found = len(retrieved)
        yield _sse({"type": "progress", "step": f"Retrieved & reranked {n_found} candidates", "pct": 60})

        if not retrieved:
            yield _sse({"type": "result", "data": {
                "status": "no_results", "paragraph": paragraph,
                "suggestions": [], "candidates": [], "warnings": [
                    "No relevant sources found. Make sure your references directory is scanned."
                ],
            }})
            return

        yield _sse({"type": "progress", "step": "Formatting citations\u2026", "pct": 68})

        ai_sources = []
        for source in retrieved:
            inline = format_inline_citation(source)
            full_reference = format_full_reference(source)
            creators_formatted = format_author_inline(parse_creators(source.get("creators", [])))
            ai_sources.append({
                **source,
                "inline_citation": inline,
                "full_reference": full_reference,
                "creators_formatted": creators_formatted,
            })

        yield _sse({
            "type": "progress",
            "step": f"AI evaluating {n_found} candidates\u2026",
            "pct": 74,
        })

        fallback_notifications: list = []
        try:
            with log_duration(logger, "suggest_citations AI evaluation", threshold_ms=500):
                ai_result = await asyncio.to_thread(suggest_citations_ai, paragraph, ai_sources)
        except QuotaExceededError:
            try:
                with log_duration(logger, "suggest_citations AI fallback", threshold_ms=500):
                    ai_result, fallback_notifications = await asyncio.to_thread(
                        call_with_quota_fallback,
                        suggest_citations_ai,
                        paragraph,
                        ai_sources,
                    )
            except QuotaExceededError as exc:
                yield _sse({"type": "error", "message": str(exc), "buy_url": exc.buy_url, "quota_exceeded": True})
                return
            except Exception as exc:
                logger.error("AI error after fallback: %s", exc)
                yield _sse({"type": "error", "message": f"AI API error: {exc}"})
                return
        except Exception as exc:
            logger.error("AI error: %s", exc)
            yield _sse({"type": "error", "message": f"AI API error: {exc}"})
            return

        if fallback_notifications:
            yield _sse({"type": "profile_switched", "profile": config.active_profile})
            for notification in reversed(fallback_notifications):
                ai_result.setdefault("warnings", []).insert(0, notification)

        yield _sse({"type": "progress", "step": "Building response\u2026", "pct": 96})

        source_map = {source["item_key"]: source for source in ai_sources}
        suggestions = []
        for suggestion in ai_result.get("suggestions", []):
            key = suggestion.get("item_key", "")
            source = source_map.get(key, {})
            ai_evidence = suggestion.get("evidence_points", [])
            if not ai_evidence:
                old_snippet = suggestion.get("evidence_snippet", "")
                if old_snippet:
                    ai_evidence = [old_snippet]
            suggestions.append({
                "inline_citation": source.get("inline_citation", ""),
                "full_reference": source.get("full_reference", ""),
                "reason": suggestion.get("reason", ""),
                "evidence_points": ai_evidence,
                "evidence_coverage": suggestion.get("evidence_coverage", "single_point"),
                "confidence": suggestion.get("confidence", "Low"),
                "item_key": key,
                "title": source.get("title", ""),
                "source_type": suggestion.get("source_type", source.get("best_source_type", "abstract")),
                "matched_chunks": len(source.get("chunks", [])),
                "source_dir": source.get("source_dir", ""),
                "doi": source.get("doi", ""),
                "citation_count": source.get("citation_count", 0) or 0,
                "citation_count_updated_at": source.get("citation_count_updated_at", ""),
            })

        candidates = [{
            "item_key": source["item_key"],
            "title": source.get("title", ""),
            "year": source.get("year", ""),
            "creators_formatted": source.get("creators_formatted", ""),
            "inline_citation": source.get("inline_citation", ""),
            "full_reference": source.get("full_reference", ""),
            "best_evidence": (source["chunks"][0]["chunk_text"][:300] if source.get("chunks") else ""),
            "source_type": source.get("best_source_type", "abstract"),
            "similarity": round(source.get("best_similarity", 0.0), 4),
            "source_dir": source.get("source_dir", ""),
            "doi": source.get("doi", ""),
            "citation_count": source.get("citation_count", 0) or 0,
            "citation_count_updated_at": source.get("citation_count_updated_at", ""),
        } for source in ai_sources]

        elapsed = time.time() - start_time

        try:
            slim_candidates = [
                {
                    "item_key": source["item_key"],
                    "title": source.get("title", ""),
                    "creators_formatted": source.get("creators_formatted", ""),
                    "year": source.get("year", ""),
                    "inline_citation": source.get("inline_citation", ""),
                    "full_reference": source.get("full_reference", ""),
                    "best_evidence": (source.get("best_evidence") or "")[:2000],
                    "chunks": [
                        {
                            "chunk_text": chunk["chunk_text"][:800],
                            "source_type": chunk["metadata"].get("source_type", ""),
                            "similarity": round(chunk.get("similarity", 0.0), 4),
                        }
                        for chunk in source.get("chunks", [])[:6]
                    ],
                    "best_similarity": round(source.get("best_similarity", 0.0), 4),
                    "rerank_score": round(source.get("rerank_score", 0.0), 4),
                    "source_type": source.get("best_source_type", "abstract"),
                }
                for source in ai_sources
            ]
            create_suggestion_run({
                "run_id": run_id,
                "title": paragraph[:80],
                "paragraph": paragraph,
                "active_profile": config.active_profile if hasattr(config, "active_profile") else "",
                "ai_model": config.ai_model,
                "source_dir": body.source_dir or "",
                "collection_key": body.collection_key or "",
                "top_k": body.top_k,
                "citation_style": body.citation_style,
                "status": "completed",
                "elapsed_seconds": round(elapsed, 2),
                "warnings_json": json.dumps(ai_result.get("warnings", [])),
                "temperature": config.suggestion_temperature,
                "candidates_json": json.dumps(slim_candidates),
            })
            for position, suggestion in enumerate(suggestions):
                add_suggestion_result({
                    "run_id": run_id,
                    "item_key": suggestion["item_key"],
                    "inline_citation": suggestion["inline_citation"],
                    "full_reference": suggestion["full_reference"],
                    "reason": suggestion["reason"],
                    "evidence_points_json": json.dumps(suggestion["evidence_points"]),
                    "evidence_coverage": suggestion["evidence_coverage"],
                    "confidence": suggestion["confidence"],
                    "source_type": suggestion["source_type"],
                    "citation_count": suggestion.get("citation_count", 0) or 0,
                    "position": position,
                })
        except Exception as exc:
            logger.warning("Could not save suggestion run: %s", exc)

        yield _sse({"type": "result", "data": {
            "status": "success",
            "paragraph": paragraph,
            "suggestions": suggestions,
            "warnings": ai_result.get("warnings", []),
            "candidates": candidates,
            "run_id": run_id,
        }})

        suggested_sources = [source_map.get(suggestion.get("item_key", ""), {}) for suggestion in suggestions]
        suggested_sources = [source for source in suggested_sources if source]
        if suggested_sources:
            refreshed_counts = await asyncio.to_thread(refresh_crossref_counts_for_sources, suggested_sources)
            if refreshed_counts:
                yield _sse({"type": "citation_counts", "counts": refreshed_counts})

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
