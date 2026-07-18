"""
AI API client for citation suggestion.
"""

import json
import logging
import re
from typing import Any, Callable, Dict, List, Optional

from openai import OpenAI

from app.config import config, get_device_id
from app.prompts import SYSTEM_PROMPT, build_user_prompt

logger = logging.getLogger(__name__)


class QuotaExceededError(Exception):
    def __init__(self, message: str, buy_url: str = ""):
        super().__init__(message)
        self.buy_url = buy_url


_HYDE_SYSTEM = """\
You are an academic research assistant. Given a paragraph from a research paper, \
generate a hypothetical passage (2-4 sentences) that a cited source might contain \
to support the paragraph's claims. Write in formal academic English. \
Focus on key concepts, findings, or methods that would be relevant. \
Return ONLY the hypothetical passage text — no labels, no markdown, no explanation."""


def generate_hypothetical_passage(paragraph: str) -> Optional[str]:
    client = _get_client()
    try:
        response = _create_chat_completion(
            client,
            model=config.ai_model,
            messages=[
                {"role": "system", "content": _HYDE_SYSTEM},
                {"role": "user", "content": f"Generate a hypothetical cited passage for this paragraph:\n\n{paragraph}"},
            ],
            temperature=0.3,
            max_tokens=300,
        )
        content = response.choices[0].message.content or ""
        content = content.strip()
        if content.startswith('"') and content.endswith('"'):
            content = content[1:-1]
        return content if len(content) > 20 else None
    except Exception as exc:
        logger.warning("HyDE generation error: %s", exc)
        return None


def _is_managed_api(url: str) -> bool:
    return "api.tarcite.com" in url


def _is_local_ollama(url: str) -> bool:
    return "localhost" in url or "127.0.0.1" in url


def _get_client() -> OpenAI:
    cfg = config
    base_url = cfg.ai_api_base_url or ""
    is_managed = _is_managed_api(base_url)

    is_local = _is_local_ollama(base_url)
    if is_local:
        # Ollama starts lazily (launch only starts it for local profiles); if
        # the user switched to a local profile mid-session, bring it up now.
        # Fast path when already running: a single local socket check.
        try:
            from app.ollama_manager import ensure_running
            ensure_running()
        except Exception as exc:
            logger.warning("Could not ensure Ollama is running: %s", exc)
    if not cfg.ai_api_key and not is_managed and not is_local:
        raise ValueError(
            "AI API key is not configured. Go to Settings and enter your API key."
        )

    kwargs: Dict[str, Any] = {"api_key": cfg.ai_api_key or "lm-studio"}
    if base_url and base_url != "https://api.openai.com/v1":
        kwargs["base_url"] = base_url.rstrip("/")
    if is_managed:
        kwargs["default_headers"] = {
            "X-Device-ID": get_device_id(),
            "User-Agent": "TarCiteWorkspace/1.0",
            "Accept-Encoding": "identity",
        }

    return OpenAI(**kwargs)


def _create_chat_completion(client: OpenAI, **kwargs: Any):
    try:
        return client.chat.completions.create(**kwargs)
    except Exception as exc:
        err_str = str(exc)
        if "429" in err_str or "daily_limit_reached" in err_str:
            import json as _json
            try:
                body_start = err_str.index("{")
                body_end = err_str.rindex("}") + 1
                err_body = _json.loads(err_str[body_start:body_end])
                msg = err_body.get("message", "Daily limit reached. Buy credits for unlimited access.")
                buy_url = err_body.get("buy_url", "")
            except (ValueError, KeyError):
                msg = "Daily limit reached. Buy credits for unlimited access."
                buy_url = ""
            raise QuotaExceededError(msg, buy_url) from exc
        base_url = config.ai_api_base_url or ""
        if _is_local_ollama(base_url):
            err_lower = err_str.lower()
            if any(k in err_lower for k in ("connection", "refused", "connect error", "cannot connect")):
                raise RuntimeError(
                    "Local AI model is not running. Please download Qwen 2.5 3B from "
                    "Settings first, or switch to a TarCite provider (online)."
                ) from exc
            if "404" in err_str or "model not found" in err_lower or "not found" in err_lower:
                model = config.ai_model or "qwen2.5:3b"
                raise RuntimeError(
                    f"Local AI model '{model}' is not downloaded in Ollama. Please download it from "
                    "Settings first, or switch to a TarCite provider (online)."
                ) from exc
        raise


def _is_html_response(text: str) -> bool:
    return text.strip().startswith("<!DOCTYPE") or text.strip().startswith("<html")


def _extract_json(content: str) -> Dict:
    content = content.strip()

    # Strip reasoning blocks (DeepSeek, etc.)
    content = re.sub(r"<think>[\s\S]*?</think>", "", content)
    content = re.sub(r"<think>[\s\S]*?</think>", "", content)
    content = re.sub(r"<thinking>[\s\S]*?</thinking>", "", content)

    # Strip markdown code fences
    fence_match = re.search(r"```(?:json)?\s*([\s\S]+?)\s*```", content)
    if fence_match:
        content = fence_match.group(1)

    # Find the outermost JSON object
    start = content.find("{")
    if start == -1:
        return json.loads(content)

    depth = 0
    end = -1
    in_string = False
    escape = False
    for i in range(start, len(content)):
        ch = content[i]
        if escape:
            escape = False
            continue
        if ch == "\\":
            escape = True
            continue
        if ch == '"' and not escape:
            in_string = not in_string
            continue
        if in_string:
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                end = i + 1
                break

    if end > 0:
        content = content[start:end]
    else:
        # Truncated JSON — try to close it
        content = content[start:]
        content = _repair_json(content)

    return json.loads(content)


def _repair_json(text: str) -> str:
    """Attempt to repair truncated JSON by closing open strings and braces."""
    stack = []
    in_string = False
    escape = False
    for ch in text:
        if escape:
            escape = False
            continue
        if ch == "\\":
            escape = True
            continue
        if ch == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if ch == "{":
            stack.append("}")
        elif ch == "[":
            stack.append("]")
        elif ch == "}":
            if stack and stack[-1] == "}":
                stack.pop()
        elif ch == "]":
            if stack and stack[-1] == "]":
                stack.pop()

    result = text
    if in_string:
        result = result.rstrip("\\") + '"'
    while stack:
        result += stack.pop()
    return result


def suggest_citations(
    paragraph: str,
    retrieved_sources: List[Dict[str, Any]],
) -> Dict[str, Any]:
    empty_result: Dict[str, Any] = {"suggestions": [], "warnings": []}

    if not retrieved_sources:
        empty_result["warnings"].append(
            "No relevant sources found in your local library for this paragraph."
        )
        return empty_result

    client = _get_client()
    user_prompt = build_user_prompt(paragraph, retrieved_sources)

    content = ""
    try:
        temp = config.suggestion_temperature
        try:
            response = _create_chat_completion(
                client,
                model=config.ai_model,
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": user_prompt},
                ],
                response_format={"type": "json_object"},
                temperature=temp,
                max_tokens=4096,
            )
        except Exception:
            response = _create_chat_completion(
                client,
                model=config.ai_model,
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": user_prompt},
                ],
                temperature=temp,
                max_tokens=4096,
            )

        content = response.choices[0].message.content or ""
        reasoning = (
            getattr(response.choices[0].message, "reasoning_content", "")
            or getattr(response.choices[0].message, "reasoning", "")
            or ""
        )

        if not content and reasoning:
            logger.info("Model returned reasoning_content but empty content. Using reasoning as content.")
            content = reasoning

        if not content:
            raise ValueError("AI returned empty response")

        if _is_html_response(content):
            raise ValueError(
                "The AI API returned an HTML page instead of a JSON response. "
                "This usually means the API Base URL is wrong or the API key is invalid. "
                "Please check your AI API settings (URL, key, and model name)."
            )

        try:
            result = _extract_json(content)
        except json.JSONDecodeError as exc:
            logger.warning("First JSON parse failed: %s", exc)
            logger.warning("Raw response (first 300 chars): %s", content[:300])
            logger.info("Retrying with stricter JSON-only prompt...")
            retry_response = _create_chat_completion(
                client,
                model=config.ai_model,
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT + "\n\nIMPORTANT: Return ONLY valid JSON. Do NOT use reasoning tags, markdown, or any prose outside the JSON."},
                    {"role": "user", "content": user_prompt},
                ],
                temperature=temp,
                max_tokens=4096,
            )
            retry_content = retry_response.choices[0].message.content or ""
            retry_reasoning = (
                getattr(retry_response.choices[0].message, "reasoning_content", "")
                or getattr(retry_response.choices[0].message, "reasoning", "")
                or ""
            )
            if not retry_content and retry_reasoning:
                logger.info("Retry: using reasoning_content as content")
                retry_content = retry_reasoning
            if not retry_content:
                raise ValueError("AI returned empty response on retry")
            logger.info("Retry response (first 300 chars): %s", retry_content[:300])
            result = _extract_json(retry_content)

    except json.JSONDecodeError as exc:
        logger.error("AI returned invalid JSON: %s", exc)
        logger.error("Raw AI response (first 800 chars): %s", content[:800])
        empty_result["warnings"].append(
            f"AI response could not be parsed as JSON. "
            f"This can happen with reasoning models that spend too many tokens thinking. "
            f"Try switching to a non-reasoning model like Qwen. Error: {exc}"
        )
        return empty_result
    except Exception as exc:
        logger.error("AI API error: %s", exc)
        raise

    result.setdefault("suggestions", [])
    result.setdefault("warnings", [])

    valid_keys = {s["item_key"] for s in retrieved_sources}
    validated: List[Dict] = []

    for suggestion in result["suggestions"]:
        key = suggestion.get("item_key", "")
        if key in valid_keys:
            validated.append(suggestion)
        else:
            warn = (
                f"AI suggested a citation not in the retrieved source list "
                f"(key: '{key}') — removed to prevent hallucination."
            )
            logger.warning(warn)
            result["warnings"].append(warn)

    result["suggestions"] = validated
    return result


def check_single_relevance(paragraph: str, source: Dict[str, Any]) -> Dict[str, Any]:
    evidence = ""
    if source.get("chunks"):
        evidence = source["chunks"][0]["chunk_text"][:600]
    elif source.get("abstract"):
        evidence = source["abstract"][:600]

    prompt = f"""Evaluate whether this source supports the paragraph. Be honest — if the fit is weak, say so.

PARAGRAPH:
{paragraph}

SOURCE:
  Key      : {source['item_key']}
  Title    : {source.get('title', '')}
  Authors  : {source.get('creators_formatted', '')}
  Year     : {source.get('year', 'n.d.')}
  Citation : {source.get('inline_citation', '')}
  Evidence : {evidence if evidence else 'No text available for this item.'}

Respond in this exact JSON:
{{
  "relevant": true or false,
  "confidence": "High" or "Medium" or "Low",
  "reason": "1–2 sentences explaining relevance or why it does not fit",
  "evidence_snippet": "the most relevant passage (max 200 chars, empty string if not relevant)",
  "inline_citation": {json.dumps(source.get('inline_citation', ''))},
  "full_reference": {json.dumps(source.get('full_reference', ''))},
  "item_key": {json.dumps(source['item_key'])},
  "title": {json.dumps(source.get('title', ''))},
  "source_type": "abstract"
}}"""

    client = _get_client()
    try:
        try:
            response = _create_chat_completion(
                client,
                model=config.ai_model,
                messages=[
                    {"role": "system", "content": "You are an academic citation assistant. Evaluate source relevance honestly. Return only valid JSON."},
                    {"role": "user", "content": prompt},
                ],
                response_format={"type": "json_object"},
                temperature=0.1,
                max_tokens=600,
            )
        except Exception:
            response = _create_chat_completion(
                client,
                model=config.ai_model,
                messages=[
                    {"role": "system", "content": "You are an academic citation assistant. Evaluate source relevance honestly. Return only valid JSON."},
                    {"role": "user", "content": prompt},
                ],
                temperature=0.1,
                max_tokens=600,
            )
        return _extract_json(response.choices[0].message.content or "{}")
    except Exception as exc:
        logger.error("check_single_relevance error: %s", exc)
        raise


_CHAT_SYSTEM = """\
You are an academic citation assistant helping a researcher explore their citation results.

You have been given:
  1. The paragraph the researcher wants to cite
  2. All candidate sources retrieved from their local library (with evidence and full text where available)
  3. The citation suggestions the AI made

You can help with:
  - Explaining why a source was or wasn't suggested
  - Reading and evaluating a specific source from the library
  - Comparing sources and which best supports a specific claim
  - Analysing a particular source more deeply using its full text
  - Advice on strengthening the citation for this paragraph
  - Identifying gaps in the available literature

When [SYSTEM CONTEXT FOR AI] notes appear in the user message, use that information
to find and evaluate the requested source — the full text is already included in the
candidate list above.

Rules:
  - Only discuss sources from the provided candidate list.
  - Use only files, extracted text, paragraph context, candidates, and suggestions supplied by this app.
  - Treat outside knowledge, web knowledge, and memory about papers as unavailable.
  - If the app-provided sources do not contain enough evidence, say that the local app context is insufficient.
  - Do not invent citations or authors.
  - If a source was explicitly noted as NOT FOUND in the library, say so clearly.
  - Be direct and academically precise.
  - IMPORTANT: Do NOT use markdown formatting (no **bold**, no *italic*, no # headers,
    no bullet dashes). Write in plain prose only. Use plain text like "Source:" not bold.
  - Do NOT include source-number, line-reference, or web-style bracket markers
    in the answer. If a source is
    useful, name it naturally by title, author, or inline citation.\
"""

_CHAT_STANDALONE_SYSTEM = """\
You are a research assistant embedded in a local academic citation app.
The app has already extracted and embedded text from the user's documents into this system prompt.
You have full read access to any document shown under "=== OPEN PDF DOCUMENT ===" or "OTHER LIBRARY SOURCES".
Do NOT say you cannot access a PDF or file — the text is right here in this context.
If a user asks "can you read this PDF?" or "what does this document say?", read the embedded text and answer directly.

You can help with:
  - Summarizing or explaining the open document or any library source
  - Answering questions about specific sections, methods, results, or claims
  - Comparing sources, finding relevant passages, or identifying gaps
  - Normal conversation and app-use guidance

Rules:
  - The embedded document text in this prompt IS the PDF. Read it and answer from it.
  - Do not claim you cannot access files — the content is already provided here.
  - Only discuss sources present in this context; do not invent citations or findings.
  - If the context truly lacks enough information, say "The extracted text does not cover that."
  - Do NOT include source-number, line-reference, or web-style bracket markers
    in the answer. If a source is
    useful, name it naturally by title, author, or inline citation.
  - Be direct and concise.\
"""


_CHAT_TOOL_SYSTEM_SUFFIX = (
    "\n\nYou have tools available:\n"
    "  - write_item_notes: write structured content directly into the item's @note panel (the dedicated 'Notes' "
    "tab shown alongside the open PDF — NOT this chat reply). Use this whenever the user asks to 'create an "
    "@note', 'make a study @note', 'write a summary in the @note', 'add to the @note', or otherwise wants "
    "content saved into the per-item @note editor. Pass content as plain text (newlines OK) or basic HTML "
    "(p, ul, li, strong, em, h1-h3). Use mode='append' to add to existing @note content (default) or "
    "mode='replace' to overwrite.\n"
    "  - add_quote_highlight: create a quote-only highlight on the open PDF. Pass a VERBATIM quote from the "
    "document text above (must match the PDF text exactly) plus an optional comment. Only pass color, sentiment, "
    "or tags when the user actually asks for them (e.g. 'purple', 'negative sentiment', '#changed') — leave them "
    "out otherwise, do not invent values. color is a hex string (e.g. '#dda0dd' for purple); sentiment is a short "
    "free-text label (e.g. 'negative', 'critical'); tags is a list of tag/code names (e.g. ['changed'] for "
    "'#changed') — these become real, structured tags, not text stuffed into the comment. Returns annotation_id.\n"
    "  - add_note_pointer_with_ink: add an ink-linked pointer to the item's @note panel, linked to a highlight "
    "created by add_quote_highlight. The pointer becomes a dot in the @note with a line drawn to the "
    "highlight's location on the PDF. ONLY call this when the user's own request actually mentions notes, "
    "pointers, links, or ink connections (e.g. 'add ink connection', 'link this to the note', 'add pointers'). "
    "A plain 'highlight/underline/annotate/tag/sentiment X' request, with no mention of notes or connections, "
    "does NOT want a note pointer — the highlight alone is the complete, correct result; calling this anyway "
    "modifies the @note panel the user never asked to touch. IMPORTANT: when you do call it, set "
    "replace_existing=true when the pointer_text already exists in the @note (e.g. the user asked to 'link', "
    "'connect', or 'add ink connection to' existing summary points) — this converts the existing @note text "
    "block into an ink-linked pointer IN PLACE without duplicating it. Use replace_existing=false (default) "
    "only when creating brand-new pointers.\n"
    "Terminology: '@note' always refers to the per-item Notes panel content — the dedicated editor alongside the "
    "PDF. It does NOT mean this chat reply, an annotation comment, or any other text. When the user says 'note' "
    "or 'notes', they most likely mean the @note panel.\n"
    "When the user's request DOES ask for pointers / links / ink connections to the open document, work ONE "
    "POINT AT A TIME: call add_quote_highlight for that point, then IMMEDIATELY call add_note_pointer_with_ink "
    "for the SAME point using the annotation_id you just got back, BEFORE highlighting the next point. You have "
    "a limited number of tool-call turns per reply — if you highlight several points first and only add "
    "pointers afterward, you can run out of turns with highlights created but zero pointers linked, which is "
    "worse than fully finishing fewer points. Always complete the highlight+pointer pair for one point before "
    "starting the next — but only when pointers were actually requested in the first place. "
    "If the EXISTING @NOTE CONTENT section above shows that the pointer_text is already present in the @note, "
    "you MUST set replace_existing=true to avoid duplicating it. Always copy the supporting quote VERBATIM from "
    "the document text; never paraphrase. When the user asks to 'create an @note' or 'write in the @note', use "
    "write_item_notes INSTEAD of just typing the content into the chat reply — the user wants the content saved "
    "into the @note panel, not echoed back. After tool calls, write only a brief plain-text confirmation (one "
    "or two lines) of what you created; do NOT repeat the @note content itself back to the user.\n"
    "Default rule: unless an exact number is stated, an annotate/highlight/underline/tag request means every "
    "distinct matching passage, not just one — regardless of phrasing."
)


def _html_to_plain_text(html_content: str) -> str:
    """Render @note HTML as plain text for the prompt.

    The @note panel stores content as HTML, but showing that raw markup to the
    model invites it to copy literal tags (e.g. "<p><strong>Research Focus:</strong>
    ...") into pointer_text when asked to link existing content — which then never
    matches anything, since matching is done against the panel's plain text.
    """
    import html as _html

    text = re.sub(r"(?i)<br\s*/?>", "\n", html_content)
    text = re.sub(r"(?i)</(p|div|li|h[1-6])>", "\n", text)
    text = re.sub(r"<[^>]+>", "", text)
    text = _html.unescape(text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def chat_about_citations(
    message: str,
    paragraph: str,
    candidates: List[Dict[str, Any]],
    suggestions: List[Dict[str, Any]],
    history: List[Dict[str, str]],
    tools: Optional[List[Dict[str, Any]]] = None,
    tool_executor: Optional[Callable[[str, Dict[str, Any]], Dict[str, Any]]] = None,
    existing_notes: str = "",
) -> str:
    has_paragraph = bool(paragraph)
    has_suggestions = bool(suggestions)
    standalone = not has_paragraph or not has_suggestions

    # Separate the currently-open document from other library sources so it
    # gets a prominent dedicated section — small local models read top-down and
    # may miss context buried inside a generic list.
    current_doc = next((c for c in candidates if c.get("is_current_doc")), None)
    other_candidates = [c for c in candidates if not c.get("is_current_doc")]

    current_doc_section = ""
    if current_doc:
        ev = current_doc.get("best_evidence", "")
        current_doc_section = (
            f"\n\n=== OPEN PDF DOCUMENT ===\n"
            f"Title: {current_doc.get('title', '(untitled)')}\n"
            f"Citation: {current_doc.get('inline_citation', '')}\n"
            f"The full text of this document is embedded below. When the user says "
            f"'this PDF', 'this paper', or 'the open document', they mean this document.\n"
            + (f"--- DOCUMENT TEXT ---\n{ev}\n--- END OF DOCUMENT ---" if ev
               else "(No extracted text available for this document.)")
        )

    existing_note_section = ""
    if existing_notes:
        existing_note_section = (
            f"\n\n=== EXISTING @NOTE CONTENT ===\n"
            f"The item's @note panel currently contains the following content, shown here as plain text (the "
            f"panel actually stores it as HTML — do NOT include HTML tags like <p> or <strong> in pointer_text, "
            f"copy only the plain text shown below). Use this to understand what the user has already written, "
            f"avoid duplicating it, and build on it when asked to add or append. Do NOT repeat this content back "
            f"to the user unless they ask.\n"
            f"--- @NOTE CONTENT ---\n{_html_to_plain_text(existing_notes)[:6000]}\n--- END @NOTE CONTENT ---"
        )

    cand_lines = ""
    for i, c in enumerate(other_candidates[:14], 1):
        cand_lines += f"\n[{i}] {c.get('inline_citation', '')} | {c.get('title', '')[:70]}"
        ev = c.get("best_evidence", "")
        if ev:
            cand_lines += f"\n    Evidence: {ev[:8000]}"
        fts_chunks = c.get("fts_chunks", [])
        for chunk in fts_chunks[:3]:
            cand_lines += f"\n    Excerpt: {chunk[:600]}"

    sug_lines = ""
    for s in suggestions:
        sug_lines += f"\n  - {s.get('inline_citation', '')} (confidence: {s.get('confidence', '')})"

    other_sources_label = f"\n\nOTHER LIBRARY SOURCES ({len(other_candidates)} found):{cand_lines if cand_lines else ' None.'}"

    if standalone:
        system = (
            _CHAT_STANDALONE_SYSTEM
            + current_doc_section
            + existing_note_section
            + other_sources_label
        )
    else:
        system = (
            _CHAT_SYSTEM
            + current_doc_section
            + existing_note_section
            + f"\n\nPARAGRAPH:\n{paragraph}"
            + f"\n\nCANDIDATE SOURCES ({len(other_candidates)} retrieved):{cand_lines if cand_lines else ' None.'}"
            + f"\n\nSUGGESTIONS MADE:{sug_lines if sug_lines else ' None.'}"
        )

    tools_enabled = bool(tools) and callable(tool_executor)
    if tools_enabled:
        system += _CHAT_TOOL_SYSTEM_SUFFIX

    messages: List[Dict[str, Any]] = [{"role": "system", "content": system}]
    for h in history[-8:]:
        messages.append({"role": h["role"], "content": h["content"]})
    messages.append({"role": "user", "content": message})

    client = _get_client()
    completion_kwargs: Dict[str, Any] = {
        "model": config.ai_model,
        "messages": messages,
        "temperature": config.chat_temperature,
        # Tool-enabled turns can need to emit many tool calls (each with a verbatim
        # quote) in one completion; 2000 is comfortable for prose but a batch of
        # highlight+pointer calls can get cut off mid-generation well before that
        # normally would matter for plain chat.
        "max_tokens": 4096 if tools_enabled else 2000,
    }
    if tools_enabled:
        completion_kwargs["tools"] = tools
        completion_kwargs["tool_choice"] = "auto"

    tool_call_count = 0
    try:
        for _ in range(6):
            response = _create_chat_completion(client, **completion_kwargs)
            choice = response.choices[0]
            msg = choice.message
            tool_calls = getattr(msg, "tool_calls", None)
            if not tools_enabled or not tool_calls:
                raw = (msg.content or "").strip()
                if not raw and tools_enabled and getattr(choice, "finish_reason", None) == "length":
                    # Truncated mid-generation (often mid-tool-call) rather than a
                    # genuine "nothing more to do" — msg.content/tool_calls both come
                    # back empty either way, so without this check it's silently
                    # indistinguishable from a normal empty-content finish.
                    logger.warning("Chat completion truncated by max_tokens while tools were enabled")
                    raw = (
                        "My response got cut off before I could finish — that's usually because "
                        "there were too many actions to fit in one reply. Try asking for fewer at "
                        "once (e.g. a few points at a time) and I'll pick up from there."
                    )
                return _clean_chat_response(_deduplicate_chat_response(raw))
            tool_call_count += len(tool_calls)

            # Append the assistant tool_call message exactly as returned so the
            # OpenAI API accepts the follow-up tool messages on the next round.
            assistant_msg: Dict[str, Any] = {"role": "assistant", "content": msg.content or ""}
            try:
                assistant_msg["tool_calls"] = [
                    {
                        "id": tc.id,
                        "type": "function",
                        "function": {
                            "name": tc.function.name,
                            "arguments": tc.function.arguments or "{}",
                        },
                    }
                    for tc in tool_calls
                ]
            except Exception:
                assistant_msg["tool_calls"] = [
                    {
                        "id": tc.get("id", ""),
                        "type": "function",
                        "function": {
                            "name": tc["function"]["name"],
                            "arguments": tc["function"].get("arguments", "{}") or "{}",
                        },
                    }
                    for tc in tool_calls
                ]
            messages.append(assistant_msg)

            for tc in tool_calls:
                try:
                    name = tc.function.name
                    try:
                        args = json.loads(tc.function.arguments or "{}")
                    except Exception:
                        args = {}
                    logger.info("Chat tool call: %s args=%s", name, args)
                    result = tool_executor(name, args)
                except Exception as exc:
                    logger.warning("Chat tool execution failed: %s", exc)
                    result = {"error": str(exc)}
                messages.append({
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": json.dumps(result)[:4000],
                })
            # Loop continues: model either requests more tools or finishes.
        # Tool-call budget exhausted while the model still wanted to act — every
        # round up to here had tool_calls, so tool_call_count reflects real DB
        # writes the user won't otherwise be told about (msg.content is often
        # empty on a pure tool-call turn).
        raw = (msg.content or "").strip()
        if not raw:
            raw = (
                f"Done — completed {tool_call_count} action(s) on this item, but hit the "
                "tool-call limit before I could reply. Check the Notes panel and PDF for "
                "the changes, and ask again if anything's left to do."
            )
        return _clean_chat_response(_deduplicate_chat_response(raw))
    except Exception as exc:
        logger.error("chat_about_citations error: %s", exc)
        raise


def _clean_chat_response(text: str) -> str:
    if not text:
        return text

    cleaned = text
    # Remove model-generated source and line citation artifacts.
    cleaned = re.sub(r"【\s*\d+\s*†\s*L?\d+(?:\s*[-–]\s*L?\d+)?\s*】", "", cleaned)
    # Remove malformed/truncated variants that can appear after narrow UI wrapping.
    cleaned = re.sub(r"【\s*\d+\s*†\s*L?\d+(?:\s*[-–]\s*L?\d+)?", "", cleaned)
    cleaned = re.sub(r"\s+([,.;:!?])", r"\1", cleaned)
    cleaned = re.sub(r"[ \t]{2,}", " ", cleaned)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


def _deduplicate_chat_response(text: str) -> str:
    if not text:
        return text

    paragraphs = text.split("\n\n")
    if len(paragraphs) < 4:
        return text

    def _normalize(s: str) -> str:
        return re.sub(r"[\*\#_\-\`]", "", s).lower().strip()

    norm_paragraphs = [_normalize(p) for p in paragraphs]

    best_split = -1
    for split_point in range(2, len(paragraphs) - 1):
        first_block = " ".join(norm_paragraphs[:split_point])
        second_block = " ".join(norm_paragraphs[split_point:])

        first_words = first_block.split()[:12]
        second_words = second_block.split()[:12]

        if len(first_words) >= 6 and len(second_words) >= 6:
            overlap = sum(1 for a, b in zip(first_words, second_words) if a == b)
            if overlap >= 6:
                best_split = split_point
                break

    if best_split > 0:
        logger.info("Chat response duplicated at paragraph %d — keeping second copy", best_split)
        return "\n\n".join(paragraphs[best_split:])

    half = len(paragraphs) // 2
    first_half = " ".join(norm_paragraphs[:half])
    second_half = " ".join(norm_paragraphs[half:])

    first_words = first_half.split()[:20]
    second_words = second_half.split()[:20]

    if len(first_words) >= 8 and len(second_words) >= 8:
        overlap = sum(1 for a, b in zip(first_words, second_words) if a == b)
        if overlap >= 8:
            logger.info("Chat response duplicated at midpoint — keeping second copy")
            return "\n\n".join(paragraphs[half:])

    return text
