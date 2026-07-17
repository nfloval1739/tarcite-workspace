"""Citation chat route."""

import json
import logging
import re
import secrets
from typing import Any, Callable, Dict, List

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


_CHAT_TOOLS: List[Dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "add_quote_highlight",
            "description": (
                "Create a quote-only highlight on the currently open PDF. The quote MUST be copied "
                "verbatim from the document text in this prompt — the viewer will auto-anchor it to "
                "the matching location on the PDF when the item is next opened. Returns annotation_id."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "quote": {
                        "type": "string",
                        "description": "Verbatim passage from the PDF. Copy the supporting text exactly as it appears in the document text above.",
                    },
                    "comment": {
                        "type": "string",
                        "description": "Optional short comment / pointer label shown alongside the highlight.",
                    },
                    "annotation_type": {
                        "type": "string",
                        "enum": ["highlight", "underline"],
                        "description": "Visual style. Use 'highlight' by default.",
                    },
                },
                "required": ["quote"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "add_note_pointer_with_ink",
            "description": (
                "Add an ink-linked pointer to the item's @note panel, linked to a highlight created by "
                "add_quote_highlight. The pointer becomes a dot in the @note with a line drawn to the "
                "highlight's location on the PDF. By default (replace_existing=false) a NEW pointer block "
                "is appended. Set replace_existing=true when the pointer_text already exists in the @note "
                "(e.g. the user asked to 'link' or 'connect' existing summary points to the PDF) — this "
                "converts the existing @note text block into an ink-linked pointer IN PLACE, avoiding duplicates."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "pointer_text": {
                        "type": "string",
                        "description": "The pointer / observation text. When replace_existing=true, this must match the text of an existing @note block so it can be converted in place.",
                    },
                    "annotation_id": {
                        "type": "integer",
                        "description": "The annotation_id returned by add_quote_highlight for the supporting quote this pointer links to.",
                    },
                    "target_label": {
                        "type": "string",
                        "description": "Optional short label for the linked PDF location (e.g. first 40-60 chars of the quote).",
                    },
                    "replace_existing": {
                        "type": "boolean",
                        "description": "true = search the existing @note for a block whose text matches pointer_text and replace it with the ink-linked pointer in place (use when the user wants to LINK existing @note content). false = append a new pointer block (default, use when creating brand-new pointers).",
                    },
                },
                "required": ["pointer_text", "annotation_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write_item_notes",
            "description": (
                "Write structured content directly into the item's @note panel (the dedicated 'Notes' "
                "tab shown alongside the PDF, NOT the chat reply bubble). Use this when the user asks "
                "to 'create an @note', 'make a study @note', 'write a summary in the @note', or "
                "otherwise wants content saved into the per-item @note editor. Content can be plain "
                "text or basic HTML (p, ul, li, strong, em, br). Use mode='append' to add to existing "
                "@note content, or mode='replace' to overwrite it."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "content": {
                        "type": "string",
                        "description": "The @note content. Plain text is fine; line breaks become <br>. Basic HTML (p, ul, li, strong, em, br, h1-h3) is also accepted.",
                    },
                    "mode": {
                        "type": "string",
                        "enum": ["append", "replace"],
                        "description": "append = add to existing @note content (default); replace = overwrite existing @note content.",
                    },
                    "heading": {
                        "type": "string",
                        "description": "Optional heading text to precede the appended @note content (e.g. 'Study @note: ...').",
                    },
                },
                "required": ["content"],
            },
        },
    },
]


_NOTES_ALLOWED_TAGS = {
    "p", "br", "strong", "em", "b", "i", "u", "ul", "ol", "li",
    "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "hr", "span", "div",
}
_NOTES_ALLOWED_ATTRS = {"style", "class"}


def _notes_content_to_html(content: str) -> str:
    """Render model-supplied @note content as safe HTML for the @note editor.

    Accepts either pre-formatted HTML (if it contains any tag we allow) or plain
    text (in which case newlines become <br> and the whole thing is wrapped in <p>).
    Disallowed tags are escaped so the model cannot inject scripts or arbitrary styles.
    """
    import html as _html

    raw = content.strip()
    if not raw:
        return ""

    has_tag = re.search(r"<\w+", raw)
    if has_tag:
        from html.parser import HTMLParser

        class _Sanitizer(HTMLParser):
            def __init__(self):
                super().__init__()
                self.out: list[str] = []
                self.skip_depth = 0

            def handle_starttag(self, tag, attrs):
                if self.skip_depth:
                    self.skip_depth += 1
                    return
                tag_l = tag.lower()
                if tag_l not in _NOTES_ALLOWED_TAGS:
                    self.skip_depth = 1
                    return
                attr_str = ""
                for key, val in attrs:
                    if key.lower() in _NOTES_ALLOWED_ATTRS and val:
                        safe = _html.escape(val, quote=True)
                        attr_str += f' {key.lower()}="{safe}"'
                self.out.append(f"<{tag_l}{attr_str}>")

            def handle_endtag(self, tag):
                if self.skip_depth:
                    self.skip_depth -= 1
                    return
                tag_l = tag.lower()
                if tag_l in _NOTES_ALLOWED_TAGS and tag_l != "br" and tag_l != "hr":
                    self.out.append(f"</{tag_l}>")

            def handle_startendtag(self, tag, attrs):
                if self.skip_depth:
                    return
                tag_l = tag.lower()
                if tag_l in _NOTES_ALLOWED_TAGS and tag_l in {"br", "hr"}:
                    self.out.append(f"<{tag_l}/>")

            def handle_data(self, data):
                if self.skip_depth:
                    return
                self.out.append(_html.escape(data, quote=False))

        parser = _Sanitizer()
        parser.feed(raw)
        return "".join(parser.out)

    plain = _html.escape(raw, quote=False)
    paragraphs = [p for p in re.split(r"\n\s*\n", plain) if p.strip()]
    if len(paragraphs) <= 1:
        return f"<p>{plain.replace(chr(10), '<br>')}</p>"
    return "".join(f"<p>{p.replace(chr(10), '<br>')}</p>" for p in paragraphs)


def _find_block_end(html_content: str, tag: str, search_from: int):
    """Find the closing tag that matches the block opened just before search_from.

    Depth-counts same-tag open/close pairs from search_from so nested blocks of
    the same tag name (contentEditable frequently nests <div> inside <div> on
    Enter) resolve to their own matching close tag, not the first same-name
    close tag encountered — which a naive non-greedy backreference regex would
    pick, corrupting the surrounding HTML on replace.
    """
    tag_re = re.compile(rf"</?{tag}\b[^>]*>", re.IGNORECASE)
    depth = 1
    for m in tag_re.finditer(html_content, search_from):
        if m.group(0).startswith("</"):
            depth -= 1
            if depth == 0:
                return m
        else:
            depth += 1
    return None


def _line_segments(html_content: str, start: int, end: int):
    """Split html_content[start:end] into spans on top-level <br> boundaries."""
    br_re = re.compile(r"<br\s*/?>", re.IGNORECASE)
    spans = []
    pos = start
    for m in br_re.finditer(html_content, start, end):
        spans.append((pos, m.start()))
        pos = m.end()
    spans.append((pos, end))
    return spans


def _plain_norm(html_fragment: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", html_fragment)).strip()


def _replace_text_block_in_notes_html(html_content: str, target_text: str, anchor_html: str) -> str | None:
    """Find the first line or block whose stripped text matches target_text and
    splice anchor_html in its place, leaving the surrounding tags untouched.

    Searches <p>, <div>, <li>, <h1>-<h6> elements at the granularity of a single
    <br>-separated line within them — write_item_notes renders a plain-text
    bulleted summary (lines with no blank line between them) as one <p> with
    <br> between points, so matching only whole blocks would never find an
    individual bullet and would silently duplicate it via the append fallback
    instead of linking it in place. A block with no <br> has exactly one segment
    spanning its whole content, so this also covers a plain whole-block match
    without needing to special-case it, and — because only the segment's span is
    replaced, never the enclosing tag — an <li> stays an <li>, a <h2> stays a
    <h2>, etc. Returns the modified HTML, or None if no match was found.
    """
    # Defense-in-depth: strip any HTML the model echoed into target_text (e.g.
    # copying "<p><strong>Research Focus:</strong> ..." verbatim from having seen
    # raw markup somewhere) so it still matches the plain-text block content below.
    target_norm = _plain_norm(target_text)
    open_re = re.compile(r"<(p|div|li|h[1-6])\b[^>]*>", re.IGNORECASE)
    for om in open_re.finditer(html_content):
        tag = om.group(1).lower()
        close_m = _find_block_end(html_content, tag, om.end())
        if close_m is None:
            continue
        for seg_start, seg_end in _line_segments(html_content, om.end(), close_m.start()):
            if _plain_norm(html_content[seg_start:seg_end]) == target_norm:
                return html_content[:seg_start] + anchor_html + html_content[seg_end:]
    return None


_QUOTE_NORMALIZE_MAP = str.maketrans({
    "‘": "'", "’": "'", "“": '"', "”": '"',
    "–": "-", "—": "-", " ": " ",
})


def _normalize_for_match(text: str) -> str:
    return re.sub(r"\s+", " ", text.translate(_QUOTE_NORMALIZE_MAP)).strip().lower()


def _quote_appears_in_text(quote: str, full_text: str) -> bool:
    """Loose verbatim check for a model-supplied quote against the document text.

    Not a fuzzy matcher — just normalises whitespace/quote/dash variants and does
    a substring test, enough to catch obviously hallucinated or paraphrased quotes
    before they become a DB row that can never anchor on the PDF. Fails open (True)
    when there's no full_text to check against, so items without extracted text
    don't lose highlight functionality entirely.
    """
    if not full_text:
        return True
    return _normalize_for_match(quote) in _normalize_for_match(full_text)


def _build_tool_executor(
    item_key: str, collected: Dict[str, List], full_text: str = ""
) -> Callable[[str, Dict[str, Any]], Dict[str, Any]]:
    """Return a tool-execution closure that mutates `collected` in place.

    `collected` keys: "annotations" (list of dicts with annotation_id/quote),
    "connections" (list of conn dicts ready for the frontend), "notes_html_appends"
    (list of HTML strings to append into the @note content),
    "notes_rewritten" (list of dicts recording write_item_notes calls).

    `full_text` is the current item's extracted document text, used to verify
    add_quote_highlight quotes are real before writing them to the DB.
    """
    def _executor(name: str, args: Dict[str, Any]) -> Dict[str, Any]:
        from app.repositories.annotations import create_annotation, get_annotation
        from app.database import get_item_notes, patch_item_notes

        if name == "add_quote_highlight":
            quote = (args.get("quote") or "").strip()
            if not quote:
                return {"error": "quote is required"}
            if not _quote_appears_in_text(quote, full_text):
                return {
                    "error": (
                        "quote not found verbatim in the document text provided above — "
                        "copy the exact passage from the DOCUMENT TEXT section (do not "
                        "paraphrase or summarise) and try again"
                    )
                }
            quote_norm = _normalize_for_match(quote)
            for existing in collected["annotations"]:
                if _normalize_for_match(existing["quote"]) == quote_norm:
                    # Same quote already highlighted earlier this turn (models can
                    # re-attempt a call after an unrelated failure elsewhere and
                    # forget it already succeeded) — reuse it instead of creating a
                    # near-duplicate annotation and burning another tool-call round.
                    # The message is deliberately directive: a plain "ok" here was
                    # observed not stopping the model from calling this again with
                    # the same quote 1-2 more times before moving on.
                    return {
                        "annotation_id": existing["annotation_id"],
                        "ok": True,
                        "reused_existing": True,
                        "note": (
                            f"You already highlighted this exact passage as annotation_id "
                            f"{existing['annotation_id']} — do not call add_quote_highlight for it "
                            f"again. Use annotation_id {existing['annotation_id']} directly with "
                            f"add_note_pointer_with_ink, then move on to the next distinct point."
                        ),
                    }
            ann_type = (args.get("annotation_type") or "highlight").strip() or "highlight"
            if ann_type not in {"highlight", "underline"}:
                ann_type = "highlight"
            comment = (args.get("comment") or "").strip()
            data = {
                "item_key": item_key,
                "file_id": None,
                "page_index": 0,
                "annotation_type": ann_type,
                "color": "",
                "quote": quote,
                "comment": comment,
                "geometry_json": "{}",
                "source_chunk_id": "",
            }
            annotation_id = create_annotation(data)
            collected["annotations"].append({
                "annotation_id": annotation_id,
                "item_key": item_key,
                "quote": quote,
                "comment": comment,
                "annotation_type": ann_type,
                "page_index": 0,
                "geometry_json": "{}",
            })
            return {"annotation_id": annotation_id, "ok": True}

        if name == "add_note_pointer_with_ink":
            pointer_text = (args.get("pointer_text") or "").strip()
            if not pointer_text:
                return {"error": "pointer_text is required"}
            try:
                annotation_id = int(args.get("annotation_id"))
            except (TypeError, ValueError):
                return {"error": "annotation_id must be an integer"}
            existing_ann = get_annotation(annotation_id)
            if not existing_ann or existing_ann.get("item_key") != item_key:
                return {
                    "error": (
                        f"annotation_id {annotation_id} does not belong to this item — "
                        "call add_quote_highlight first and use the annotation_id it returns"
                    )
                }
            target_label = (args.get("target_label") or "").strip() or f"Annotation {annotation_id}"
            conn_id = "ink-chat-" + secrets.token_hex(6)
            conn = {
                "id": conn_id,
                "targetType": "annotation",
                "targetId": str(annotation_id),
                "targetLabel": target_label[:80],
                "targetSection": "item",
            }
            safe_text = (
                pointer_text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                .replace('"', "&quot;")
            )
            anchor_html = (
                f'<span class="ink-anchor" data-conn-id="{conn_id}" '
                f'style="display:inline-block;width:10px;height:10px;'
                f'background:var(--accent,#2d6fd4);border-radius:50%;'
                f'margin-right:6px;vertical-align:middle;" contenteditable="false">&#9679;</span>'
                f'{safe_text}'
            )
            replacement_block = f"<p>{anchor_html}</p>"
            replace_existing = bool(args.get("replace_existing", False))

            current = get_item_notes(item_key) or {"notes": "", "note_connections": "[]"}
            existing_notes = current.get("notes", "") or ""
            try:
                connections = json.loads(current.get("note_connections") or "[]")
                if not isinstance(connections, list):
                    connections = []
            except Exception:
                connections = []
            connections.append(conn)

            did_replace = False
            if replace_existing:
                replaced = _replace_text_block_in_notes_html(existing_notes, pointer_text, anchor_html)
                if replaced is not None:
                    new_notes = replaced
                    did_replace = True
                    collected["notes_html_appends"].append("__REPLACE__")
                else:
                    new_notes = (existing_notes.rstrip() + replacement_block)
                    collected["notes_html_appends"].append(replacement_block)
            else:
                new_notes = (existing_notes.rstrip() + replacement_block)
                collected["notes_html_appends"].append(replacement_block)

            patch_item_notes(item_key, {
                "notes": new_notes,
                "note_connections": json.dumps(connections),
            })
            collected["connections"].append(conn)
            result = {
                "connection_id": conn_id,
                "ok": True,
                "annotation_id": annotation_id,
                "replaced_existing": did_replace,
            }
            if replace_existing and not did_replace:
                result["note"] = (
                    "no existing @note block matched pointer_text verbatim — appended as a "
                    "new pointer instead of replacing in place; tell the user it was added, "
                    "not linked to existing text"
                )
            return result

        if name == "write_item_notes":
            content = (args.get("content") or "").strip()
            if not content:
                return {"error": "content is required"}
            mode = (args.get("mode") or "append").strip().lower()
            if mode not in {"append", "replace"}:
                mode = "append"
            heading = (args.get("heading") or "").strip()
            html = _notes_content_to_html(content)
            if heading:
                heading_esc = (
                    heading.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                    .replace('"', "&quot;")
                )
                html = f"<h3>{heading_esc}</h3>{html}"
            current = get_item_notes(item_key) or {"notes": "", "note_connections": "[]"}
            existing_notes = current.get("notes", "") or ""
            patch_data: Dict[str, Any] = {}
            backed_up = False
            if mode == "replace":
                new_notes = html
                if existing_notes.strip():
                    # Safety net: mode='replace' overwrites the whole @note panel and this
                    # app has no note version history — keep a single last-known-good
                    # snapshot recoverable via GET /api/items/{key}/notes (notes_backup).
                    patch_data["notes_backup"] = existing_notes
                    backed_up = True
            else:
                new_notes = (existing_notes.rstrip() + "\n" + html)
            patch_data["notes"] = new_notes
            patch_item_notes(item_key, patch_data)
            collected.setdefault("notes_rewritten", []).append({
                "mode": mode,
                "heading": heading,
                "preview": html[:200],
            })
            collected.setdefault("notes_html_appends", [])
            if not collected.get("notes_html_appends"):
                collected["notes_html_appends"] = []
            if mode == "replace":
                collected["notes_html_appends"].append("__REPLACE__" + html)
            else:
                collected["notes_html_appends"].append(html)
            return {"ok": True, "mode": mode, "chars_written": len(new_notes), "previous_notes_backed_up": backed_up}

        return {"error": f"unknown tool: {name}"}

    return _executor


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

    tools_enabled = (
        body.allow_tools
        and body.enable_ink_links
        and bool(body.current_item_key)
    )
    current_item_full_text = _fetch_full_text(body.current_item_key) if tools_enabled else ""
    collected: Dict[str, List] = {"annotations": [], "connections": [], "notes_html_appends": []}
    tool_executor = (
        _build_tool_executor(body.current_item_key, collected, current_item_full_text)
        if tools_enabled else None
    )
    chat_tools = _CHAT_TOOLS if tools_enabled else None

    existing_notes_str = ""
    if tools_enabled and body.current_item_key:
        from app.database import get_item_notes
        notes_data = get_item_notes(body.current_item_key)
        if notes_data and notes_data.get("notes"):
            existing_notes_str = notes_data["notes"]

    try:
        reply = chat_about_citations(
            message=augmented_message,
            paragraph=body.paragraph or "",
            candidates=enriched_candidates,
            suggestions=body.suggestions or [],
            history=[history.model_dump() for history in body.history],
            tools=chat_tools,
            tool_executor=tool_executor,
            existing_notes=existing_notes_str,
        )
        response: Dict[str, Any] = {"reply": reply}
        if tools_enabled and (collected["annotations"] or collected["connections"] or collected.get("notes_rewritten")):
            response["created_annotations"] = collected["annotations"]
            response["created_connections"] = collected["connections"]
            response["notes_html_append"] = "".join(collected["notes_html_appends"])
            if collected.get("notes_rewritten"):
                response["notes_rewritten"] = collected["notes_rewritten"]
        return response
    except QuotaExceededError:
        try:
            collected.clear()
            collected.update({"annotations": [], "connections": [], "notes_html_appends": []})
            fallback_executor = (
                _build_tool_executor(body.current_item_key, collected, current_item_full_text)
                if tools_enabled else None
            )
            reply, notifications = call_with_quota_fallback(
                chat_about_citations,
                augmented_message,
                body.paragraph or "",
                enriched_candidates,
                body.suggestions or [],
                [history.model_dump() for history in body.history],
                chat_tools,
                fallback_executor,
                existing_notes_str,
            )
            notice = " | ".join(notifications)
            fallback_resp: Dict[str, Any] = {"reply": f"[{notice}]\n\n{reply}", "switched_to_profile": config.active_profile}
            if tools_enabled and (collected["annotations"] or collected["connections"] or collected.get("notes_rewritten")):
                fallback_resp["created_annotations"] = collected["annotations"]
                fallback_resp["created_connections"] = collected["connections"]
                fallback_resp["notes_html_append"] = "".join(collected["notes_html_appends"])
                if collected.get("notes_rewritten"):
                    fallback_resp["notes_rewritten"] = collected["notes_rewritten"]
            return fallback_resp
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
