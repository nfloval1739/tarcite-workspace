"""
TarCite Workspace — MCP (Model Context Protocol) server.

Exposes the local research library (hybrid retrieval, citation suggestion, CSL
formatting, metadata) as MCP tools so any MCP-compatible client can use the
user's private PDF library as a grounded, fully-local knowledge source.

Two transports share this one definition:

* stdio        — `python -m app.mcp_server`  (local MCP clients).
                 Nothing touches the network.
* streamable   — mounted at `/mcp` on the existing FastAPI app (see app/main.py),
  HTTP           reachable at http(s)://<host>/mcp for HTTP-capable clients.

Everything runs in-process against the same SQLite + ChromaDB stores the app
already uses — no HTTP hop, no extra server. The retrieval / citation tools are
read-only; the metadata- and annotation-editing tools (`update_item_metadata`,
`set_item_notes`, `set_item_favorite`, `set_item_reading_status`,
`list_annotations`, `add_annotation`, `update_annotation`,
`delete_annotation`, `set_annotation_tags`, `import_annotations`,
`list_tags`, `create_tag`) mutate the library and are write-capable.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional

import anyio
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings


def _build_transport_security() -> TransportSecuritySettings:
    """Keep DNS-rebinding protection on (the /mcp endpoint is unauthenticated),
    but allow the app's own hostname in addition to localhost. Without this,
    FastMCP's localhost-only default rejects clients connecting via the friendly
    host (e.g. https://tarcite.workspace/mcp) with HTTP 421 'Invalid Host header'.
    """
    try:
        from app.config import config

        display = (config.app_display_host or "").strip()
    except Exception:
        display = ""

    allowed_hosts = ["127.0.0.1:*", "localhost:*", "[::1]:*"]
    allowed_origins = [
        "http://127.0.0.1:*", "http://localhost:*", "http://[::1]:*",
        "https://127.0.0.1:*", "https://localhost:*",
    ]
    if display:
        # Host header arrives without a port when served on 443; cover :port too.
        allowed_hosts += [display, f"{display}:*"]
        allowed_origins += [f"https://{display}", f"https://{display}:*"]

    return TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=allowed_hosts,
        allowed_origins=allowed_origins,
    )


logger = logging.getLogger(__name__)

# stateless_http + json_response keep the HTTP transport simple to embed in the
# existing server: every call is an independent request/response with no
# long-lived SSE session to manage. streamable_http_path="/mcp" makes FastMCP
# build a single Route at exactly "/mcp"; app/main.py registers that route
# directly on the main app (no sub-app Mount), so POST /mcp is served in one hop
# with no trailing-slash redirect.
mcp = FastMCP(
    "TarCite Workspace",
    instructions=(
        "Tools for searching and citing the user's local academic library "
        "(PDFs, metadata, annotations). Use `search_library` to find passages "
        "relevant to a topic or claim, `suggest_citations` to get AI-ranked "
        "citations for a paragraph being written, and `format_citation` / "
        "`format_bibliography` to render references in a chosen style "
        "(apa7, harvard, ieee, chicago, mla, vancouver, …)."
    ),
    stateless_http=True,
    json_response=True,
    streamable_http_path="/mcp",
    transport_security=_build_transport_security(),
)


# ── helpers ─────────────────────────────────────────────────────────────────


async def _to_thread(fn, *args, **kwargs):
    """Run a blocking (SQLite / ChromaDB / model) call off the event loop.

    Keeps the shared Uvicorn loop responsive when this server is mounted on the
    running app, and is harmless under the stdio transport.
    """
    if kwargs:
        from functools import partial

        fn = partial(fn, **kwargs)
    return await anyio.to_thread.run_sync(fn, *args)


def _creators_list(item: Dict[str, Any]) -> List[Dict]:
    """Parse the `creators` column (JSON string or list) into dicts."""
    from app.citation_formatter import parse_creators

    return parse_creators(item.get("creators", "[]"))


def _compact_source(source: Dict[str, Any], max_chunks: int = 3) -> Dict[str, Any]:
    """Trim a retrieval candidate into a compact, LLM-friendly record."""
    from app.citation_formatter import (
        format_author_inline,
        format_full_reference,
        format_inline_citation,
    )

    creators = _creators_list(source)
    chunks = []
    for chunk in (source.get("chunks") or [])[:max_chunks]:
        text = (chunk.get("chunk_text") or "").strip()
        if not text:
            continue
        chunks.append(
            {
                "text": text[:800],
                "source_type": (chunk.get("metadata") or {}).get("source_type", ""),
                "similarity": round(chunk.get("similarity", 0.0) or 0.0, 4),
            }
        )

    return {
        "item_key": source.get("item_key", ""),
        "title": source.get("title", ""),
        "authors": format_author_inline(creators),
        "year": source.get("year", ""),
        "item_type": source.get("item_type", ""),
        "publication": source.get("publication_title", ""),
        "doi": source.get("doi", ""),
        "inline_citation": format_inline_citation(source),
        "full_reference": format_full_reference(source),
        "relevance": round(source.get("rerank_score", source.get("best_similarity", 0.0)) or 0.0, 4),
        "evidence": chunks,
        # best_evidence is the engine's pre-computed support text and falls back
        # to the abstract for title-only matches, so this is never empty.
        "best_evidence": (source.get("best_evidence") or "")[:1000],
        "abstract": (source.get("abstract") or "")[:600],
        "citation_count": source.get("citation_count", 0) or 0,
    }


# ── tools ───────────────────────────────────────────────────────────────────


@mcp.tool()
async def search_library(
    query: str,
    top_k: int = 10,
    collection_key: Optional[str] = None,
    source_dir: Optional[str] = None,
) -> Dict[str, Any]:
    """Search the user's local library for passages relevant to a topic, claim,
    or research question, using hybrid retrieval (vector + BM25 + title) with
    cross-encoder reranking and MMR diversity. Returns the most relevant papers
    with supporting evidence snippets and ready-to-use citations.

    Use this to ground answers in the user's own sources instead of guessing.

    Args:
        query: Topic, question, or claim to find supporting sources for.
        top_k: Number of papers to return (1–50). Default 10.
        collection_key: Optional collection/folder key to restrict the search.
        source_dir: Optional reference directory path to restrict the search.
    """
    query = (query or "").strip()
    if not query:
        return {"status": "error", "message": "query cannot be empty", "results": []}

    top_k = max(1, min(int(top_k or 10), 50))

    from app.config import config
    from app.retrieval import search_and_retrieve

    try:
        results = await _to_thread(
            search_and_retrieve,
            paragraph=query,
            top_k=top_k,
            collection_key=collection_key,
            source_dir=source_dir,
            reranker_model=config.reranker_model,
            use_hyde=False,
            use_mmr=True,
        )
    except Exception as exc:  # retrieval depends on the vector index being healthy
        logger.exception("search_library failed")
        return {"status": "error", "message": f"Search failed: {exc}", "results": []}

    return {
        "status": "ok",
        "query": query,
        "count": len(results),
        "results": [_compact_source(source) for source in results],
    }


@mcp.tool()
async def suggest_citations(
    paragraph: str,
    top_k: int = 10,
    collection_key: Optional[str] = None,
    source_dir: Optional[str] = None,
) -> Dict[str, Any]:
    """Given a paragraph the user is writing, suggest which sources from their
    local library to cite. Runs the full citation engine: hybrid retrieval +
    rerank, then an LLM evaluates each candidate for genuine support and returns
    a reason, evidence points, and a confidence level per suggestion.

    Note: this calls the configured language model and may take several seconds.
    Requires the paragraph to be at least ~20 characters.

    Args:
        paragraph: The academic paragraph to find citations for.
        top_k: Candidate pool size after reranking (1–100). Default 10.
        collection_key: Optional collection/folder key to restrict the search.
        source_dir: Optional reference directory path to restrict the search.
    """
    paragraph = (paragraph or "").strip()
    if len(paragraph) < 20:
        return {
            "status": "error",
            "message": "paragraph must be at least 20 characters",
            "suggestions": [],
        }

    top_k = max(1, min(int(top_k or 10), 100))

    from app.ai_client import QuotaExceededError
    from app.ai_client import suggest_citations as suggest_citations_ai
    from app.citation_formatter import (
        format_author_inline,
        format_full_reference,
        format_inline_citation,
    )
    from app.config import config
    from app.retrieval import search_and_retrieve

    try:
        retrieved = await _to_thread(
            search_and_retrieve,
            paragraph=paragraph,
            top_k=top_k,
            collection_key=collection_key,
            source_dir=source_dir,
            reranker_model=config.reranker_model,
            use_hyde=True,
            use_mmr=True,
        )
    except Exception as exc:
        logger.exception("suggest_citations retrieval failed")
        return {"status": "error", "message": f"Search failed: {exc}", "suggestions": []}

    if not retrieved:
        return {
            "status": "no_results",
            "message": "No relevant sources found in the local library.",
            "suggestions": [],
        }

    ai_sources = []
    for source in retrieved:
        ai_sources.append(
            {
                **source,
                "inline_citation": format_inline_citation(source),
                "full_reference": format_full_reference(source),
                "creators_formatted": format_author_inline(_creators_list(source)),
            }
        )

    try:
        ai_result = await _to_thread(suggest_citations_ai, paragraph, ai_sources)
    except QuotaExceededError as exc:
        return {
            "status": "quota_exceeded",
            "message": str(exc),
            "suggestions": [],
        }
    except Exception as exc:
        logger.exception("suggest_citations AI evaluation failed")
        return {"status": "error", "message": f"AI evaluation failed: {exc}", "suggestions": []}

    source_map = {source["item_key"]: source for source in ai_sources}
    suggestions = []
    for suggestion in ai_result.get("suggestions", []):
        source = source_map.get(suggestion.get("item_key", ""), {})
        suggestions.append(
            {
                "item_key": suggestion.get("item_key", ""),
                "title": source.get("title", ""),
                "inline_citation": source.get("inline_citation", ""),
                "full_reference": source.get("full_reference", ""),
                "reason": suggestion.get("reason", ""),
                "evidence_points": suggestion.get("evidence_points", []),
                "confidence": suggestion.get("confidence", "Low"),
                "doi": source.get("doi", ""),
            }
        )

    return {
        "status": "ok",
        "paragraph": paragraph,
        "count": len(suggestions),
        "suggestions": suggestions,
        "warnings": ai_result.get("warnings", []),
    }


@mcp.tool()
async def get_item(item_key: str, include_fulltext: bool = False) -> Dict[str, Any]:
    """Fetch full metadata for a single library item by its item_key, including
    authors, tags, files, and collections. Optionally include the extracted
    full text of the document.

    Args:
        item_key: The item_key returned by search_library / search_metadata.
        include_fulltext: If true, also return the extracted full text (may be large).
    """
    from app.database import get_fulltext_for_item, get_item_v2

    item = await _to_thread(get_item_v2, item_key)
    if not item:
        return {"status": "not_found", "item_key": item_key}

    result = {
        "status": "ok",
        "item_key": item_key,
        "title": item.get("title", ""),
        "year": item.get("year", ""),
        "item_type": item.get("item_type", ""),
        "publication_title": item.get("publication_title", ""),
        "doi": item.get("doi", ""),
        "url": item.get("url", ""),
        "abstract": item.get("abstract", ""),
        "creators": item.get("creators_list", []),
        "tags": item.get("tags_list", []),
        "collections": [c.get("name", "") for c in item.get("collections", [])],
        "file_path": (item.get("files") or [{}])[0].get("file_path", "") if item.get("files") else item.get("file_path", ""),
        "citation_count": item.get("citation_count", 0) or 0,
    }

    if include_fulltext:
        rows = await _to_thread(get_fulltext_for_item, item_key)
        result["fulltext"] = rows[0].get("content", "") if rows else ""
        result["total_pages"] = rows[0].get("total_pages", 0) if rows else 0

    return result


@mcp.tool()
async def search_metadata(query: str, limit: int = 15) -> Dict[str, Any]:
    """Fast keyword lookup over library item metadata (title, authors, year,
    filename). Cheaper than search_library — use it to resolve a known paper to
    its item_key, not for semantic/topic search.

    Args:
        query: Keywords, author name, title fragment, or year.
        limit: Maximum number of items to return (1–50). Default 15.
    """
    from app.citation_formatter import (
        format_author_inline,
        format_full_reference,
        format_inline_citation,
    )
    from app.database import search_items

    query = (query or "").strip()
    if not query:
        return {"status": "error", "message": "query cannot be empty", "items": []}

    limit = max(1, min(int(limit or 15), 50))
    items = await _to_thread(search_items, query, limit)

    out = []
    for item in items:
        out.append(
            {
                "item_key": item.get("item_key", ""),
                "title": item.get("title", ""),
                "authors": format_author_inline(_creators_list(item)),
                "year": item.get("year", ""),
                "item_type": item.get("item_type", ""),
                "inline_citation": format_inline_citation(item),
                "full_reference": format_full_reference(item),
            }
        )
    return {"status": "ok", "count": len(out), "items": out}


@mcp.tool()
async def format_citation(
    item_key: str,
    style: str = "apa7",
    locator: str = "",
    locator_type: str = "page",
) -> Dict[str, Any]:
    """Render a correctly-formatted in-text citation and full reference for a
    library item in the requested style.

    Args:
        item_key: The item_key of the library item.
        style: Citation style — one of apa7, apa6, harvard, ieee, chicago, mla,
            vancouver, nature, acs, ama, elsevierharvard, springerauthordate.
        locator: Optional locator value, e.g. a page number ("23").
        locator_type: Locator type, e.g. "page" or "chapter". Default "page".
    """
    from app.database import get_item
    from app.word_csl_formatter import (
        SUPPORTED_STYLES,
        format_inline_citation,
        format_reference,
    )

    style = (style or "apa7").lower().replace("-", "")
    item = await _to_thread(get_item, item_key)
    if not item:
        return {"status": "not_found", "item_key": item_key}

    inline = await _to_thread(
        format_inline_citation, item, style, locator, locator_type
    )
    reference = await _to_thread(format_reference, item, style)
    return {
        "status": "ok",
        "item_key": item_key,
        "style": style,
        "supported_styles": SUPPORTED_STYLES,
        "inline_citation": inline,
        "reference": reference,
    }


@mcp.tool()
async def format_bibliography(
    item_keys: List[str], style: str = "apa7"
) -> Dict[str, Any]:
    """Render a formatted reference list (bibliography) for several library
    items in the requested style.

    Args:
        item_keys: List of item_keys to include.
        style: Citation style (apa7, harvard, ieee, chicago, mla, vancouver, …).
    """
    from app.database import get_item
    from app.word_csl_formatter import SUPPORTED_STYLES, format_bibliography as _format_bib

    style = (style or "apa7").lower().replace("-", "")
    if not item_keys:
        return {"status": "error", "message": "item_keys cannot be empty", "bibliography": ""}

    items = []
    missing = []
    for key in item_keys:
        item = await _to_thread(get_item, key)
        if item:
            items.append(item)
        else:
            missing.append(key)

    if not items:
        return {"status": "not_found", "missing": missing, "bibliography": ""}

    bibliography = await _to_thread(_format_bib, items, style)
    return {
        "status": "ok",
        "style": style,
        "supported_styles": SUPPORTED_STYLES,
        "count": len(items),
        "missing": missing,
        "bibliography": bibliography,
    }


@mcp.tool()
async def list_collections() -> Dict[str, Any]:
    """List the collections (folders) in the user's library, with their keys
    that can be passed as `collection_key` to search_library / suggest_citations.
    """
    from app.database import get_collections

    collections = await _to_thread(get_collections)
    out = [
        {
            "collection_key": c.get("collection_key", c.get("key", "")),
            "name": c.get("name", ""),
        }
        for c in collections
    ]
    return {"status": "ok", "count": len(out), "collections": out}


@mcp.tool()
async def library_stats() -> Dict[str, Any]:
    """Return high-level statistics about the local library: number of items,
    collections, indexed text chunks, and the last sync time. Useful to confirm
    the library is populated before searching.
    """
    from app.database import get_collection_count, get_item_count, get_last_sync
    from app.embeddings import get_collection_stats

    item_count = await _to_thread(get_item_count)
    collection_count = await _to_thread(get_collection_count)
    last_sync = await _to_thread(get_last_sync)
    try:
        chunk_count = (await _to_thread(get_collection_stats)).get("total_chunks", 0)
    except Exception:
        chunk_count = 0

    return {
        "status": "ok",
        "item_count": item_count,
        "collection_count": collection_count,
        "chunk_count": chunk_count,
        "last_sync": dict(last_sync) if last_sync else None,
    }


# ── write tools: metadata ───────────────────────────────────────────────────


@mcp.tool()
async def update_item_metadata(
    item_key: str,
    title: Optional[str] = None,
    year: Optional[str] = None,
    item_type: Optional[str] = None,
    publication_title: Optional[str] = None,
    doi: Optional[str] = None,
    url: Optional[str] = None,
    abstract: Optional[str] = None,
    volume: Optional[str] = None,
    issue: Optional[str] = None,
    pages: Optional[str] = None,
    publisher: Optional[str] = None,
    place: Optional[str] = None,
    edition: Optional[str] = None,
    isbn: Optional[str] = None,
    issn: Optional[str] = None,
    extra: Optional[str] = None,
    creators: Optional[List[Dict[str, str]]] = None,
) -> Dict[str, Any]:
    """Edit the bibliographic metadata of a library item. Only the fields you
    pass are changed; omitted fields are left untouched.

    Use `search_metadata` first to resolve a paper to its `item_key`, then call
    this to correct typos, fill in missing fields, or fix the author list.

    Args:
        item_key: The item_key of the library item to edit.
        title: Article/book title.
        year: Publication year (e.g. "2024").
        item_type: One of the app's item types (e.g. "journal_article",
            "book", "book_section", "conference_paper", "thesis", "report",
            "webpage"). Unknown values are stored verbatim.
        publication_title: Journal, book series, or conference name.
        doi: DOI, with or without the leading "https://doi.org/".
        url: A canonical URL for the item.
        abstract: Abstract / summary text.
        volume / issue / pages / publisher / place / edition / isbn / issn:
            other bibliographic fields.
        extra: Free-text "extra" field (Zotero-style).
        creators: Full replacement author list. Each entry is a dict with
            ``firstName`` and ``lastName`` (for a person) or ``name`` (for an
            organisation), and optional ``creatorType`` (default "author").
            Passing ``[]`` clears the author list. Order is preserved.
    """
    from app.database import get_item_v2, update_item_metadata

    item = await _to_thread(get_item_v2, item_key)
    if not item:
        return {"status": "not_found", "item_key": item_key}

    updates: Dict[str, Any] = {}
    for field in (
        "title", "year", "item_type", "publication_title", "doi", "url",
        "abstract", "volume", "issue", "pages", "publisher", "place",
        "edition", "isbn", "issn", "extra",
    ):
        value = locals()[field]
        if value is not None:
            updates[field] = str(value)
    if creators is not None:
        updates["creators"] = creators

    if not updates:
        return {"status": "noop", "item_key": item_key, "item": item}

    await _to_thread(update_item_metadata, item_key, updates)
    refreshed = await _to_thread(get_item_v2, item_key) or {"item_key": item_key}
    return {"status": "updated", "item_key": item_key, "item": refreshed}


@mcp.tool()
async def set_item_notes(
    item_key: str,
    notes: Optional[str] = None,
    note_connections: Optional[str] = None,
) -> Dict[str, Any]:
    """Set or clear the free-text notes (and optional note-connections JSON)
    attached to a library item. Pass only the fields you want to change.

    Args:
        item_key: The item_key of the library item.
        notes: The notes text. Pass "" to clear the notes.
        note_connections: JSON string of structured note connections
            (see app's notes schema). Pass "[]" to clear.
    """
    from app.database import get_item_notes, get_item_v2, patch_item_notes

    if not await _to_thread(get_item_v2, item_key):
        return {"status": "not_found", "item_key": item_key}

    data: Dict[str, Any] = {}
    if notes is not None:
        data["notes"] = notes
    if note_connections is not None:
        data["note_connections"] = note_connections
    if not data:
        return {"status": "noop", "item_key": item_key, **(await _to_thread(get_item_notes, item_key) or {"item_key": item_key})}

    await _to_thread(patch_item_notes, item_key, data)
    return {"status": "updated", "item_key": item_key, **(await _to_thread(get_item_notes, item_key) or {"item_key": item_key})}


@mcp.tool()
async def set_item_favorite(item_key: str, favorite: bool) -> Dict[str, Any]:
    """Mark a library item as a favourite, or clear the favourite flag.

    Args:
        item_key: The item_key of the library item.
        favorite: True to favourite, False to unfavourite.
    """
    from app.database import set_item_favorite as _set_favorite

    activity = await _to_thread(_set_favorite, item_key, bool(favorite))
    if activity is None:
        return {"status": "not_found", "item_key": item_key}
    return {"status": "updated", "item_key": item_key, "activity": activity}


@mcp.tool()
async def set_item_reading_status(item_key: str, status: str) -> Dict[str, Any]:
    """Set the reading status of a library item.

    Args:
        item_key: The item_key of the library item.
        status: One of "" (not started), "reading", or "read".
    """
    from app.database import set_item_reading_status as _set_status

    status = (status or "").strip()
    if status not in ("", "reading", "read"):
        return {"status": "error", "message": "status must be one of '', 'reading', 'read'", "item_key": item_key}

    activity = await _to_thread(_set_status, item_key, status)
    if activity is None:
        return {"status": "not_found", "item_key": item_key}
    return {"status": "updated", "item_key": item_key, "activity": activity}


# ── write tools: annotations ────────────────────────────────────────────────


@mcp.tool()
async def list_annotations(item_key: str) -> Dict[str, Any]:
    """List all annotations (highlights, notes, ink) on a library item, with
    their tags, page, quote, and comment. Use this to see what's already on a
    paper before adding or editing annotations.

    Args:
        item_key: The item_key of the library item.
    """
    from app.database import get_annotations_for_item, get_item_v2

    if not await _to_thread(get_item_v2, item_key):
        return {"status": "not_found", "item_key": item_key, "annotations": []}

    annotations = await _to_thread(get_annotations_for_item, item_key)
    out = []
    for a in annotations:
        out.append(
            {
                "annotation_id": a.get("annotation_id"),
                "item_key": a.get("item_key", ""),
                "page_index": a.get("page_index", 0),
                "annotation_type": a.get("annotation_type", ""),
                "color": a.get("color", ""),
                "quote": a.get("quote", ""),
                "comment": a.get("comment", ""),
                "sentiment": a.get("sentiment"),
                "geometry_json": a.get("geometry_json", "{}"),
                "source_chunk_id": a.get("source_chunk_id", ""),
                "created_at": a.get("created_at", ""),
                "updated_at": a.get("updated_at", ""),
                "tags": [
                    {"tag_id": t.get("tag_id"), "name": t.get("name", ""), "color": t.get("color", "")}
                    for t in (a.get("tags") or [])
                ],
            }
        )
    return {"status": "ok", "item_key": item_key, "count": len(out), "annotations": out}


@mcp.tool()
async def add_annotation(
    item_key: str,
    annotation_type: str,
    page_index: int = 0,
    quote: str = "",
    comment: str = "",
    color: str = "",
    geometry_json: str = "{}",
    sentiment: Optional[str] = None,
    tags: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """Add a new annotation (highlight, note, or ink) to a library item, with
    an optional comment and theme tags. Returns the created annotation id.

    This writes a TarCite-side annotation record; it does not draw into the PDF
    file on disk. You normally cannot supply on-page geometry from outside the
    app — instead, make `quote` a VERBATIM passage from the PDF text: the next
    time the PDF is opened in the app's viewer, the annotation is auto-anchored
    (the quote is located in the PDF, the highlight rectangles are computed and
    stored, and `page_index` is corrected if it was wrong). A paraphrased or
    heavily edited quote cannot be located and will stay page-level only.

    Args:
        item_key: The item_key of the library item to annotate.
        annotation_type: One of "highlight", "note", "ink", "underline",
            "strikeout", or "text". Other short strings are stored verbatim.
        page_index: Zero-based PDF page number to attach the annotation to.
            A best guess is fine — auto-anchoring corrects it when the quote
            is found on a different page.
        quote: The quoted passage text, copied verbatim from the PDF (used
            for display and for locating the highlight on the page).
        comment: A comment / note attached to the annotation.
        color: Hex colour string (e.g. "#FFEB3B") or "" for default.
        geometry_json: JSON string of the on-page geometry (rects / points),
            as produced by the app's PDF viewer. Default "{}" — leave it
            empty to let the viewer auto-anchor from `quote`.
        sentiment: Optional free-text sentiment label (e.g. "positive",
            "critical"). Pass None to omit.
        tags: Optional list of theme-tag names to apply. New tag names are
            created automatically.
    """
    from app.database import create_annotation, get_annotation, get_item_v2, set_annotation_tags
    from app.repositories.annotations import create_tag

    if not await _to_thread(get_item_v2, item_key):
        return {"status": "not_found", "item_key": item_key}

    annotation_type = (annotation_type or "highlight").strip() or "highlight"
    data = {
        "item_key": item_key,
        "file_id": None,
        "page_index": int(page_index or 0),
        "annotation_type": annotation_type,
        "color": color or "",
        "quote": quote or "",
        "comment": comment or "",
        "geometry_json": geometry_json or "{}",
        "source_chunk_id": "",
        "sentiment": sentiment,
    }
    annotation_id = await _to_thread(create_annotation, data)

    if tags:
        tag_ids = []
        for name in tags:
            name = (name or "").strip()
            if not name:
                continue
            tag_ids.append(await _to_thread(create_tag, name))
        tag_ids = [t for t in tag_ids if t]
        if tag_ids:
            await _to_thread(set_annotation_tags, annotation_id, tag_ids)

    annotation = await _to_thread(get_annotation, annotation_id)
    return {"status": "created", "annotation_id": annotation_id, "annotation": annotation}


@mcp.tool()
async def update_annotation(
    annotation_id: int,
    annotation_type: Optional[str] = None,
    quote: Optional[str] = None,
    comment: Optional[str] = None,
    color: Optional[str] = None,
    page_index: Optional[int] = None,
    geometry_json: Optional[str] = None,
    sentiment: Optional[str] = None,
) -> Dict[str, Any]:
    """Edit an existing annotation's type, quoted text, comment, colour,
    page, geometry, or sentiment. Omitted fields are left unchanged. Use
    `set_annotation_tags` to change tags, and `list_annotations` to find the
    `annotation_id`.

    Args:
        annotation_id: The id of the annotation to edit.
        annotation_type: New annotation type (e.g. "highlight", "note").
        quote: New quoted passage text. If you change the quote, also pass
            geometry_json="{}" so the viewer re-anchors the highlight to the
            new text on next open.
        comment: New comment / note text. Pass "" to clear.
        color: New hex colour (e.g. "#FFEB3B") or "" for default.
        page_index: New zero-based page number.
        geometry_json: New on-page geometry JSON string ("{}" to let the
            viewer re-anchor from the quote).
        sentiment: New sentiment label, or None / "" to clear.
    """
    from app.database import get_annotation, update_annotation as _update_annotation

    existing = await _to_thread(get_annotation, annotation_id)
    if not existing:
        return {"status": "not_found", "annotation_id": annotation_id}

    data: Dict[str, Any] = {
        "annotation_type": annotation_type if annotation_type is not None else existing.get("annotation_type", "highlight"),
        "color": color if color is not None else existing.get("color", ""),
        "quote": quote if quote is not None else existing.get("quote", ""),
        "comment": comment if comment is not None else existing.get("comment", ""),
        "page_index": int(page_index) if page_index is not None else None,
        "geometry_json": geometry_json if geometry_json is not None else existing.get("geometry_json", "{}"),
        "sentiment": sentiment if sentiment is not None else existing.get("sentiment"),
    }
    await _to_thread(_update_annotation, annotation_id, data)
    annotation = await _to_thread(get_annotation, annotation_id)
    return {"status": "updated", "annotation_id": annotation_id, "annotation": annotation}


@mcp.tool()
async def delete_annotation(annotation_id: int) -> Dict[str, Any]:
    """Permanently delete an annotation (and its tag links).

    Args:
        annotation_id: The id of the annotation to delete.
    """
    from app.database import delete_annotation as _delete_annotation, get_annotation

    existing = await _to_thread(get_annotation, annotation_id)
    if not existing:
        return {"status": "not_found", "annotation_id": annotation_id}

    await _to_thread(_delete_annotation, annotation_id)
    return {"status": "deleted", "annotation_id": annotation_id, "item_key": existing.get("item_key", "")}


@mcp.tool()
async def set_annotation_tags(
    annotation_id: int,
    tags: List[str],
) -> Dict[str, Any]:
    """Replace the set of theme tags on an annotation. New tag names are
    created automatically; pass an empty list to clear all tags.

    Args:
        annotation_id: The id of the annotation to retag.
        tags: List of theme-tag names to apply (replaces the current set).
    """
    from app.database import get_annotation, get_tags_for_annotation, set_annotation_tags as _set_tags
    from app.repositories.annotations import create_tag

    existing = await _to_thread(get_annotation, annotation_id)
    if not existing:
        return {"status": "not_found", "annotation_id": annotation_id}

    tag_ids = []
    for name in tags or []:
        name = (name or "").strip()
        if not name:
            continue
        tag_ids.append(await _to_thread(create_tag, name))
    tag_ids = [t for t in tag_ids if t]

    await _to_thread(_set_tags, annotation_id, tag_ids)
    applied = await _to_thread(get_tags_for_annotation, annotation_id)
    return {
        "status": "updated",
        "annotation_id": annotation_id,
        "item_key": existing.get("item_key", ""),
        "tags": [{"tag_id": t.get("tag_id"), "name": t.get("name", ""), "color": t.get("color", "")} for t in applied],
    }


@mcp.tool()
async def import_annotations(item_key: str) -> Dict[str, Any]:
    """Import annotations embedded in the item's PDF file (highlights, notes,
    marks drawn in an external reader) into the TarCite library. Idempotent:
    re-running skips annotations already imported.

    Args:
        item_key: The item_key of the library item whose PDF should be scanned.
    """
    from app.database import get_item_v2, import_item_annotations

    if not await _to_thread(get_item_v2, item_key):
        return {"status": "not_found", "item_key": item_key}

    result = await _to_thread(import_item_annotations, item_key)
    if result.get("error"):
        return {"status": "error", "item_key": item_key, "message": result["error"], **result}
    return {"status": "ok", "item_key": item_key, **result}


# ── write tools: tags ───────────────────────────────────────────────────────


@mcp.tool()
async def list_tags() -> Dict[str, Any]:
    """List all theme tags in the library, with their colour, parent tag, and
    how many annotations / sources use each. Use this to discover tag names
    you can pass to `set_annotation_tags` or `add_annotation`."""
    from app.database import get_all_tags

    tags = await _to_thread(get_all_tags)
    out = [
        {
            "tag_id": t.get("tag_id"),
            "name": t.get("name", ""),
            "color": t.get("color", ""),
            "parent_id": t.get("parent_id"),
            "description": t.get("description", ""),
            "inclusion_criteria": t.get("inclusion_criteria", ""),
            "exclusion_criteria": t.get("exclusion_criteria", ""),
            "annotation_count": t.get("annotation_count", 0),
            "source_count": t.get("source_count", 0),
        }
        for t in tags
    ]
    return {"status": "ok", "count": len(out), "tags": out}


@mcp.tool()
async def create_tag(
    name: str,
    color: str = "",
    parent_id: Optional[int] = None,
) -> Dict[str, Any]:
    """Create a new theme tag (or return the existing tag id if the name
    already exists, case-insensitively). Theme tags are used to code
    annotations.

    Args:
        name: Tag name (required).
        color: Hex colour string (e.g. "#FFEB3B"). Default "".
        parent_id: Optional parent tag_id to nest this tag under.
    """
    from app.repositories.annotations import create_tag as _create_tag

    name = (name or "").strip()
    if not name:
        return {"status": "error", "message": "name cannot be empty"}

    tag_id = await _to_thread(_create_tag, name, color or "", parent_id)
    return {"status": "created", "tag_id": tag_id, "name": name}


# ── stdio entry point ───────────────────────────────────────────────────────


def main() -> None:
    """Run the MCP server over stdio (for local MCP clients).

    When the desktop app is already running, forward the session to its /mcp
    HTTP endpoint instead of loading a second SQLite/Chroma/torch stack in this
    process (see app.mcp_proxy). Standalone serving is the fallback, and can be
    forced with MCP_STDIO_NO_PROXY=1.
    """
    import os as _os

    logging.basicConfig(level=logging.INFO)

    from app.mcp_proxy import (
        ProxyUnavailableError,
        detect_running_app_mcp_url,
        run_stdio_proxy,
        start_orphan_watchdog,
    )

    start_orphan_watchdog()

    no_proxy = _os.getenv("MCP_STDIO_NO_PROXY", "").strip().lower() in ("1", "true", "yes", "on")
    if not no_proxy:
        url = detect_running_app_mcp_url()
        if url:
            try:
                run_stdio_proxy(url)
                return  # client disconnected cleanly
            except ProxyUnavailableError as exc:
                logging.getLogger(__name__).info(
                    "MCP proxy could not connect (%s); serving standalone", exc
                )
            except Exception:
                # Mid-session failure: the client's session state is tied to
                # the proxy, so exit and let the client respawn us fresh.
                logging.getLogger(__name__).exception("MCP stdio proxy ended")
                return

    mcp.run()


if __name__ == "__main__":
    main()
