"""
Word connector API endpoints.

Provides the local API that the Word add-in task pane calls to:
- Check connection status
- Search the local library
- Get item details
- Format citations
- Format bibliographies
- Validate citations in a document
- Process DOCX files with {cite:item_key} markers
- Manage connector installation
"""

import logging
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException

from app.config import config
from app.citation_formatter import (
    format_author_inline,
    format_full_reference,
    format_inline_citation,
    parse_creators,
)
from app.database import get_item, get_item_v2, search_items, get_all_items
from app.schemas import (
    WordCitationItem,
    WordFormatCitationRequest,
    WordFormatCitationResponse,
    WordFormatBibliographyRequest,
    WordFormatBibliographyResponse,
    WordValidateCitationsRequest,
    WordValidateCitationsResponse,
    WordSyncCitationsRequest,
    WordSyncCitationsResponse,
    WordDocxProcessRequest,
    WordDocxProcessResponse,
)
from app.word_csl_formatter import (
    format_inline_citation as csl_format_inline,
    format_inline_citations as csl_format_inline_multi,
    format_reference as csl_format_reference,
    format_bibliography as csl_format_bibliography,
    SUPPORTED_STYLES,
)
from app.word_connector_db import (
    init_word_tables,
    upsert_document,
    get_document,
    update_document_style,
    get_citations_for_document,
    bulk_upsert_citations,
    get_citation,
    update_citation,
    delete_citation,
    get_document_citation_count,
)
from app.word_connector_installer import (
    get_connector_status,
    install_connector,
    uninstall_connector,
    repair_connector,
    open_word,
)
from app.word_docx_scanner import (
    process_docx,
    get_item_lookup,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/word", tags=["word-connector"])


@router.on_event("startup")
def _init_word_db():
    init_word_tables()


# ── Status ────────────────────────────────────────────────────────────────────

@router.get("/status")
def word_status() -> Dict[str, Any]:
    status = get_connector_status(
        config.app_host,
        config.app_port,
        config.app_display_host,
        config.app_external_port,
    )
    status["app_port"] = config.app_port
    status["app_host"] = config.app_host
    status["status"] = "ok"
    return status


# ── Search ────────────────────────────────────────────────────────────────────

@router.get("/search")
def word_search(q: str = "", source_dir: str = "", limit: int = 20) -> Dict[str, Any]:
    if not q.strip():
        return {"items": []}

    items = search_items(q.strip(), limit=limit * 2)

    results = []
    for item in items:
        if source_dir and item.get("source_dir", "") != source_dir:
            continue

        creators = parse_creators(item.get("creators", []))
        results.append({
            "item_key": item["item_key"],
            "title": item.get("title", ""),
            "year": item.get("year", ""),
            "creators_formatted": format_author_inline(creators),
            "inline_citation": format_inline_citation(item),
            "full_reference": format_full_reference(item),
            "item_type": item.get("item_type", ""),
            "publication_title": item.get("publication_title", ""),
            "source_dir": item.get("source_dir", ""),
        })

        if len(results) >= limit:
            break

    return {"items": results}


# ── Item Details ──────────────────────────────────────────────────────────────

@router.get("/items/{item_key}")
def word_item_detail(item_key: str) -> Dict[str, Any]:
    item = get_item_v2(item_key)
    if not item:
        item = get_item(item_key)
    if not item:
        raise HTTPException(status_code=404, detail="Item not found.")

    creators = parse_creators(item.get("creators", []))
    return {
        "item_key": item["item_key"],
        "title": item.get("title", ""),
        "year": item.get("year", ""),
        "creators_formatted": format_author_inline(creators),
        "inline_citation": format_inline_citation(item),
        "full_reference": format_full_reference(item),
        "item_type": item.get("item_type", ""),
        "publication_title": item.get("publication_title", ""),
        "doi": item.get("doi", ""),
        "url": item.get("url", ""),
        "abstract": (item.get("abstract") or "")[:500],
        "source_dir": item.get("source_dir", ""),
    }


# ── Format Citation ──────────────────────────────────────────────────────────

@router.post("/format-citation")
def word_format_citation(body: WordFormatCitationRequest) -> WordFormatCitationResponse:
    style = body.style.lower().replace("-", "")
    if style not in SUPPORTED_STYLES:
        style = "apa7"

    citation_data = {"items": [], "style": style, "citation_format": body.citation_format}
    items_with_meta = []

    for cite_item in body.items:
        item = get_item(cite_item.item_key)
        if not item:
            continue
        items_with_meta.append({
            "item": item,
            "locator": cite_item.locator,
            "locator_type": cite_item.locator_type,
            "prefix": cite_item.prefix,
            "suffix": cite_item.suffix,
            "suppress_author": cite_item.suppress_author,
        })
        citation_data["items"].append({
            "item_key": cite_item.item_key,
            "locator": cite_item.locator,
            "locator_type": cite_item.locator_type,
            "prefix": cite_item.prefix,
            "suffix": cite_item.suffix,
            "suppress_author": cite_item.suppress_author,
        })

    if not items_with_meta:
        formatted_text = ""
    elif len(items_with_meta) == 1:
        entry = items_with_meta[0]
        if body.citation_format == "narrative":
            formatted_text = csl_format_inline_multi(items_with_meta, style=style, citation_format="narrative")
        else:
            idx = 1 if style in ("ieee", "vancouver") else None
            formatted_text = csl_format_inline(
                entry["item"], style=style,
                locator=entry["locator"], locator_type=entry["locator_type"], prefix=entry["prefix"],
                suffix=entry["suffix"], suppress_author=entry["suppress_author"],
                ieee_index=idx, vancouver_index=idx,
            )
    else:
        formatted_text = csl_format_inline_multi(items_with_meta, style=style, citation_format=body.citation_format)

    if body.doc_id:
        upsert_document(body.doc_id, style=style)

    return WordFormatCitationResponse(
        formatted_text=formatted_text,
        citation_data=citation_data,
    )


# ── Format Bibliography ──────────────────────────────────────────────────────

@router.post("/format-bibliography")
def word_format_bibliography(body: WordFormatBibliographyRequest) -> WordFormatBibliographyResponse:
    style = body.style.lower().replace("-", "")
    if style not in SUPPORTED_STYLES:
        style = "apa7"

    seen = set()
    items = []
    entries = []

    for cite_item in body.items:
        if cite_item.item_key in seen:
            continue
        seen.add(cite_item.item_key)

        item = get_item(cite_item.item_key)
        if not item:
            continue

        ref = csl_format_reference(item, style=style)
        entries.append({
            "item_key": cite_item.item_key,
            "reference": ref,
        })
        items.append(item)

    bibliography = csl_format_bibliography(items, style=style)

    if body.doc_id:
        upsert_document(body.doc_id, style=style)

    return WordFormatBibliographyResponse(
        bibliography=bibliography,
        entries=entries,
    )


# ── Validate Citations ───────────────────────────────────────────────────────

@router.post("/validate-citations")
def word_validate_citations(body: WordValidateCitationsRequest) -> WordValidateCitationsResponse:
    valid = []
    missing = []
    warnings = []

    for citation in body.citations:
        items = citation.get("items", [])
        all_found = True
        for cite_item in items:
            item_key = cite_item.get("item_key", "")
            item = get_item(item_key)
            if not item:
                all_found = False
                missing.append({
                    "citation_id": citation.get("citation_id", ""),
                    "item_key": item_key,
                    "message": f"Item '{item_key}' not found in local library.",
                })
                warnings.append(f"Missing item: {item_key}")

        if all_found:
            valid.append(citation)

    return WordValidateCitationsResponse(
        valid=valid,
        missing=missing,
        warnings=warnings,
    )


# ── Sync Citations ───────────────────────────────────────────────────────────

@router.post("/sync-citations")
def word_sync_citations(body: WordSyncCitationsRequest) -> WordSyncCitationsResponse:
    try:
        upsert_document(body.doc_id, style=body.style)
        bulk_upsert_citations(body.doc_id, body.citations)
        count = get_document_citation_count(body.doc_id)
        return WordSyncCitationsResponse(
            status="success",
            message=f"Synced {count} citation(s).",
            citation_count=count,
        )
    except Exception as exc:
        logger.error("Sync citations error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


# ── DOCX Processing ──────────────────────────────────────────────────────────

@router.post("/process-docx")
def word_process_docx(body: WordDocxProcessRequest) -> WordDocxProcessResponse:
    docx_path = Path(body.docx_path)
    if not docx_path.exists():
        raise HTTPException(status_code=404, detail="DOCX file not found.")

    output_path = body.output_path
    if not output_path:
        output_path = str(docx_path.parent / f"{docx_path.stem}_cited{docx_path.suffix}")

    item_lookup = get_item_lookup(body.source_dirs if body.source_dirs else None)

    result = process_docx(
        str(docx_path),
        output_path,
        item_lookup,
        body.style,
    )

    return WordDocxProcessResponse(
        status=result["status"],
        message=result["message"],
        markers_found=result.get("markers_found", 0),
        resolved=result.get("resolved", 0),
        warnings=result.get("warnings", []),
        output_path=result.get("output_path", ""),
    )


# ── Connector Installation ───────────────────────────────────────────────────

@router.get("/connector/status")
def word_connector_status() -> Dict[str, Any]:
    return get_connector_status(
        config.app_host,
        config.app_port,
        config.app_display_host,
        config.app_external_port,
    )


@router.post("/connector/install")
def word_connector_install() -> Dict[str, Any]:
    return install_connector(config.app_host, config.app_port)


@router.post("/connector/uninstall")
def word_connector_uninstall() -> Dict[str, Any]:
    return uninstall_connector()


@router.post("/connector/repair")
def word_connector_repair() -> Dict[str, Any]:
    return repair_connector(config.app_host, config.app_port)


@router.post("/connector/open-word")
def word_connector_open_word() -> Dict[str, Any]:
    return open_word()
