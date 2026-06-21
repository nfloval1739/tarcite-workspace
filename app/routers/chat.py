"""Citation chat route."""

import json
import logging
import re
from typing import Any, Dict

from fastapi import APIRouter, HTTPException

from app.ai_client import QuotaExceededError, chat_about_citations
from app.citation_formatter import (
    format_author_inline,
    format_full_reference,
    format_inline_citation,
    parse_creators,
)
from app.config import config, get_settings
from app.quota import call_with_quota_fallback
from app.schemas import ChatRequest

logger = logging.getLogger(__name__)
router = APIRouter(tags=["chat"])


def _fetch_full_text(item_key: str) -> str:
    from app.database import get_fulltext_for_item, get_item

    item = get_item(item_key)
    if not item:
        return ""
    parts = []
    if item.get("abstract"):
        parts.append(f"[ABSTRACT]\n{item['abstract']}")
    for fulltext in get_fulltext_for_item(item_key):
        content = fulltext.get("content", "")
        if content:
            parts.append(f"[FULLTEXT]\n{content}")
    return "\n\n".join(parts)[:10000]


_QUOTE_RE = re.compile(u'(?:\"|“|”)([^\"\u201c\u201d]{10,})(?:\"|“|”)')


def _locate_in_fulltext(content: str, query: str) -> str | None:
    """Locate a quoted passage in raw fulltext using flexible anchor matching.

    Returns a context window around the found passage, or None if not found.
    Uses a regex that tolerates punctuation, commas, and short linking words
    between anchors — handles real PDF line-break and comma artifacts.
    """
    content_lower = content.lower()

    quoted_passages = _QUOTE_RE.findall(query)
    for passage in quoted_passages:
        key_words = re.findall(r'[a-zA-Z]{4,}', passage)
        if len(key_words) < 2:
            continue

        # Slide a 3-anchor window; allow up to 40 chars between each anchor
        window = min(3, len(key_words))
        for i in range(len(key_words) - window + 1):
            anchors = [re.escape(w.lower()) for w in key_words[i:i + window]]
            pattern = r'[\s\S]{0,40}'.join(anchors)
            m = re.search(pattern, content_lower)
            if m:
                pos = m.start()
                start = max(0, pos - 800)
                end = min(len(content), pos + 3000)
                prefix = "..." if start > 0 else ""
                return f"[FULLTEXT]\n{prefix}{content[start:end]}"

    return None


def _fetch_relevant_chunks(item_key: str, query: str) -> str:
    """Retrieve relevant passages from a document using FTS + neighbor expansion.

    Priority for quoted-sentence questions:
      1. Locate the exact passage in raw fulltext via flexible anchor matching
      2. Fall back to FTS chunk search (may miss split-chunk sentences)
      3. Fall back to raw fulltext beginning if document has no indexed chunks
    """
    from app.database import (
        get_fulltext_for_item,
        get_item,
        get_neighbor_chunks,
        search_chunks_for_item,
    )

    item = get_item(item_key)
    if not item:
        return ""

    preamble = ""
    if item.get("abstract"):
        preamble = f"[ABSTRACT]\n{item['abstract'][:800]}\n\n"

    has_quoted = bool(_QUOTE_RE.search(query))

    # For quoted passages: scan raw fulltext first — most precise, handles
    # split-chunk sentences and common PDF extraction artifacts (commas, line breaks)
    if has_quoted:
        for fulltext in get_fulltext_for_item(item_key):
            content = fulltext.get("content", "")
            if content:
                excerpt = _locate_in_fulltext(content, query)
                if excerpt is not None:
                    return (preamble + excerpt)[:10000]

    # General question (or quoted passage not found in fulltext): use FTS chunks
    matched = search_chunks_for_item(item_key, query, limit=10)

    if not matched:
        # No indexed chunks — return fulltext beginning
        for fulltext in get_fulltext_for_item(item_key):
            content = fulltext.get("content", "")
            if content:
                return (preamble + f"[FULLTEXT]\n{content}")[:10000]
        return preamble.strip()

    matched_ids = [c["chunk_id"] for c in matched]
    expanded = get_neighbor_chunks(item_key, matched_ids, window=2 if has_quoted else 1)

    seen: set = set()
    passages: list = []
    for chunk in expanded:
        cid = chunk["chunk_id"]
        if cid in seen:
            continue
        seen.add(cid)
        passages.append(chunk["chunk_text"])

    body = "\n\n".join(passages)
    return (preamble + f"[RELEVANT PASSAGES]\n{body}")[:10000]


def _enrich_candidate_from_db(item) -> Dict:
    creators = parse_creators(item.get("creators", "[]"))
    full_text = _fetch_full_text(item["item_key"])
    return {
        "item_key": item["item_key"],
        "title": item.get("title", ""),
        "year": item.get("year", ""),
        "creators_formatted": format_author_inline(creators),
        "inline_citation": format_inline_citation(item),
        "full_reference": format_full_reference(item),
        "best_evidence": full_text[:8000],
        "source_type": "fulltext" if "[FULLTEXT]" in full_text else "abstract",
        "similarity": 0.0,
        "full_text_loaded": True,
    }


@router.post("/api/chat")
def chat_route(body: ChatRequest) -> Dict:
    from app.database import get_item, search_fts, search_items

    original_model = config.ai_model
    original_temp = config.chat_temperature

    if body.profile_override:
        settings = get_settings()
        profiles = settings.get("ai_profiles", [])
        matched = next((p for p in profiles if p.get("name") == body.profile_override), None)
        if matched:
            config.ai_api_base_url = matched.get("ai_api_base_url", config.ai_api_base_url)
            config.ai_api_key = matched.get("ai_api_key", config.ai_api_key)
            config.ai_model = matched.get("ai_model", config.ai_model)
            config.chat_temperature = float(matched.get("chat_temperature", config.chat_temperature))
            logger.info("Chat using profile override: %s (model=%s)", body.profile_override, config.ai_model)

    if body.model_override:
        config.ai_model = body.model_override
        logger.info("Chat using model override: %s", body.model_override)

    enriched_candidates = [dict(candidate) for candidate in body.candidates]
    existing_keys = {candidate.get("item_key", "") for candidate in enriched_candidates}
    library_notes: list[str] = []

    for suggestion in body.suggestions or []:
        key = suggestion.get("item_key", "")
        if not key:
            continue
        if key in existing_keys:
            for i, candidate in enumerate(enriched_candidates):
                if candidate.get("item_key") == key and not candidate.get("full_text_loaded"):
                    full_text = _fetch_full_text(key)
                    if full_text:
                        enriched_candidates[i]["best_evidence"] = full_text[:8000]
                        enriched_candidates[i]["full_text_loaded"] = True
            continue

        item = get_item(key)
        if item:
            enriched_candidates.append(_enrich_candidate_from_db(item))
            existing_keys.add(key)
            library_notes.append(
                f"NOTE:Suggested source '{item.get('title', '')}' "
                f"({format_inline_citation(item)}) was loaded from the local library with full text."
            )
        else:
            library_notes.append(
                f"NOTE:A suggested source with item key '{key}' was not found in the local library."
            )

    if body.current_item_key:
        current_key = body.current_item_key
        use_chunks = bool(body.restrict_to_document)
        if current_key in existing_keys:
            for i, candidate in enumerate(enriched_candidates):
                if candidate.get("item_key") == current_key:
                    if not candidate.get("full_text_loaded"):
                        context = (
                            _fetch_relevant_chunks(current_key, body.message)
                            if use_chunks
                            else _fetch_full_text(current_key)
                        )
                        if context:
                            enriched_candidates[i]["best_evidence"] = context
                            enriched_candidates[i]["full_text_loaded"] = True
                    enriched_candidates[i]["is_current_doc"] = True
        else:
            current_item = get_item(current_key)
            if current_item:
                if use_chunks:
                    creators = parse_creators(current_item.get("creators", "[]"))
                    context = _fetch_relevant_chunks(current_key, body.message)
                    candidate = {
                        "item_key": current_key,
                        "title": current_item.get("title", ""),
                        "year": current_item.get("year", ""),
                        "creators_formatted": format_author_inline(creators),
                        "inline_citation": format_inline_citation(current_item),
                        "full_reference": format_full_reference(current_item),
                        "best_evidence": context,
                        "source_type": "fulltext",
                        "similarity": 0.0,
                        "full_text_loaded": True,
                    }
                else:
                    candidate = _enrich_candidate_from_db(current_item)
                candidate["is_current_doc"] = True
                enriched_candidates.insert(0, candidate)
                existing_keys.add(current_key)
            else:
                library_notes.append(
                    f"NOTE:The user has item key '{current_key}' open, but it was not found in the local library."
                )

    has_context = bool(body.paragraph and enriched_candidates)

    author_year_mentions = re.findall(
        r'\b([A-Za-záéíóúãõâêîôûçñàüä][a-záéíóúãõâêîôûçñàüä]+(?:\s+et\s+al\.?)?)'
        r'[\s,]*[\(\[]?(\d{4})[\)\]]?',
        body.message,
        flags=re.UNICODE,
    )

    stopwords = {
        "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
        "of", "with", "by", "from", "as", "is", "was", "are", "were", "be",
        "been", "being", "have", "has", "had", "do", "does", "did", "will",
        "would", "could", "should", "may", "might", "this", "that", "these",
        "those", "it", "its", "they", "their", "there", "then", "than", "when",
        "where", "which", "who", "what", "how", "not", "about", "see", "me",
        "my", "can", "tell", "talk", "talking", "say", "saying", "know",
        "find", "get", "give", "show", "look", "let", "please", "also",
        "just", "like", "want", "need", "think", "make", "much", "many",
    }

    def _extract_search_terms(msg: str) -> list:
        tokens = re.findall(r"[a-zA-Z0-9]{3,}", msg)
        return [token for token in tokens if token.lower() not in stopwords and not token.isdigit()]

    def _requires_local_evidence(msg: str) -> bool:
        lowered = msg.lower().strip()
        if not lowered:
            return False
        simple_chat = {
            "hi", "hello", "hey", "halo", "hai", "thanks", "thank you",
            "ok", "okay", "yes", "no", "good morning", "good afternoon",
            "good evening",
        }
        if lowered in simple_chat:
            return False

        evidence_keywords = {
            "paper", "papers", "article", "articles", "source", "sources",
            "citation", "citations", "reference", "references", "author",
            "authors", "study", "studies", "literature", "pdf", "library",
            "find", "search", "summarize", "summary", "compare", "evidence",
            "method", "methods", "result", "results", "doi", "year",
            "abstract", "full text", "claim", "support",
        }
        question_keywords = {
            "what", "who", "when", "where", "why", "how", "which",
            "explain", "tell me", "give me", "show me",
        }
        return any(keyword in lowered for keyword in evidence_keywords) or any(keyword in lowered for keyword in question_keywords)

    if body.restrict_to_document:
        author_year_mentions = []

    for author, year in author_year_mentions:
        hits = search_items(f"{author} {year}", limit=5)
        if not hits:
            hits = [hit for hit in search_items(author, limit=15) if hit.get("year") == year]
        if not hits:
            hits = search_items(author, limit=5)

        if hits:
            for hit in hits[:3]:
                key = hit["item_key"]
                if key in existing_keys:
                    for i, candidate in enumerate(enriched_candidates):
                        if candidate.get("item_key") == key and not candidate.get("full_text_loaded"):
                            enriched_candidates[i]["best_evidence"] = _fetch_full_text(key)
                            enriched_candidates[i]["full_text_loaded"] = True
                else:
                    enriched_candidates.append(_enrich_candidate_from_db(hit))
                    existing_keys.add(key)
                    library_notes.append(
                        f"NOTE:User asked about '{author} {year}'. "
                        f"Found in local library: '{hit.get('title', '')}' "
                        f"({format_inline_citation(hit)}). Full text included above."
                    )
        else:
            library_notes.append(
                f"NOTE:User asked about '{author} {year}' but this item was NOT found "
                f"in the local library."
            )

    if not body.restrict_to_document:
        msg_lower = body.message.lower()
        for i, candidate in enumerate(enriched_candidates):
            if candidate.get("full_text_loaded"):
                continue
            title_words = [word for word in candidate.get("title", "").lower().split() if len(word) > 5]
            if any(word in msg_lower for word in title_words):
                full_text = _fetch_full_text(candidate["item_key"])
                if full_text:
                    enriched_candidates[i]["best_evidence"] = full_text
                    enriched_candidates[i]["full_text_loaded"] = True

    if not body.restrict_to_document and not has_context:
        search_terms = _extract_search_terms(body.message)
        for term in search_terms[:6]:
            hits = search_items(term, limit=5)
            for hit in hits:
                key = hit["item_key"]
                if key not in existing_keys:
                    enriched_candidates.append(_enrich_candidate_from_db(hit))
                    existing_keys.add(key)

        fts_results = search_fts(body.message, limit=10)
        fts_by_item: Dict[str, list] = {}
        for result in fts_results:
            fts_by_item.setdefault(result["item_key"], []).append(result.get("chunk_text", "")[:800])

        for key, chunks in fts_by_item.items():
            if key in existing_keys:
                for i, candidate in enumerate(enriched_candidates):
                    if candidate["item_key"] == key:
                        enriched_candidates[i].setdefault("fts_chunks", [])
                        enriched_candidates[i]["fts_chunks"].extend(chunks[:3])
                        if not candidate.get("full_text_loaded"):
                            enriched_candidates[i]["best_evidence"] = _fetch_full_text(key)
                            enriched_candidates[i]["full_text_loaded"] = True
                continue
            item = get_item(key)
            if item:
                enriched_candidates.append(_enrich_candidate_from_db(item))
                enriched_candidates[-1]["fts_chunks"] = chunks[:3]
                existing_keys.add(key)

        library_notes.append(
            "NOTE:No citation results are active. The user is browsing the library directly. "
            "Search the candidate sources above to answer their question using full text."
        )

    greetings = {
        "hi", "hello", "hey", "halo", "hai", "howdy", "greetings",
        "good morning", "good afternoon", "good evening",
    }
    if body.message.lower().strip() in greetings:
        return {"reply": "Hello! I'm your citation assistant. Open a document, run a citation search, or ask me about any source in your library."}

    if not enriched_candidates and _requires_local_evidence(body.message):
        return {
            "reply": (
                "I could not find relevant sources inside the app's indexed local library for that question. "
                "I can only use files, paragraph context, candidates, and citation suggestions from this app."
            )
        }

    if body.restrict_to_document and body.current_item_key:
        library_notes.insert(0,
            "NOTE:The user is chatting in document-scope mode. "
            "Answer questions using ONLY the content of the currently open document above. "
            "Do not reference or suggest other library items."
        )

    augmented_message = body.message
    if library_notes:
        augmented_message += "\n\n[SYSTEM CONTEXT FOR AI]\n" + "\n".join(library_notes)

    try:
        reply = chat_about_citations(
            message=augmented_message,
            paragraph=body.paragraph or "",
            candidates=enriched_candidates,
            suggestions=body.suggestions or [],
            history=[history.model_dump() for history in body.history],
        )
        return {"reply": reply}
    except QuotaExceededError:
        try:
            reply, notifications = call_with_quota_fallback(
                chat_about_citations,
                augmented_message,
                body.paragraph or "",
                enriched_candidates,
                body.suggestions or [],
                [history.model_dump() for history in body.history],
            )
            notice = " | ".join(notifications)
            return {"reply": f"[{notice}]\n\n{reply}", "switched_to_profile": config.active_profile}
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
        logger.error("Chat error: %s", exc)
        raise HTTPException(status_code=500, detail=f"AI error: {exc}")
    finally:
        if body.profile_override or body.model_override:
            config.ai_model = original_model
            config.chat_temperature = original_temp
            if body.profile_override:
                config.reload()
