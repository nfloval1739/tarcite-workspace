"""
Text chunking for Zotero item content.

Strategy: sentence-aware splitting with configurable size and overlap.
Zotero notes are HTML — we strip tags before chunking.
"""

import re
import logging
from html.parser import HTMLParser
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

CHUNK_SIZE = 900       # target characters per chunk
CHUNK_OVERLAP = 200    # overlap between consecutive chunks
MIN_CHUNK_LEN = 60     # discard chunks shorter than this


# ── HTML → plain text ─────────────────────────────────────────────────────────

class _HTMLStripper(HTMLParser):
    """Minimal HTML-to-text converter for Zotero note content."""

    _BLOCK_TAGS = frozenset(
        {"p", "div", "br", "li", "h1", "h2", "h3", "h4", "h5", "h6",
         "blockquote", "pre", "tr", "td", "th"}
    )
    _SKIP_TAGS = frozenset({"script", "style"})

    def __init__(self) -> None:
        super().__init__()
        self._parts: List[str] = []
        self._skip: bool = False

    def handle_starttag(self, tag: str, attrs: list) -> None:
        if tag in self._SKIP_TAGS:
            self._skip = True
        if tag in self._BLOCK_TAGS:
            self._parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in self._SKIP_TAGS:
            self._skip = False

    def handle_data(self, data: str) -> None:
        if not self._skip:
            self._parts.append(data)

    def get_text(self) -> str:
        text = "".join(self._parts)
        # Collapse runs of whitespace / blank lines
        text = re.sub(r"[ \t]+", " ", text)
        text = re.sub(r"\n{3,}", "\n\n", text)
        return text.strip()


def extract_html_text(html: str) -> str:
    """Strip HTML tags and return clean plain text."""
    if not html:
        return ""
    try:
        stripper = _HTMLStripper()
        stripper.feed(html)
        return stripper.get_text()
    except Exception:
        # Regex fallback
        text = re.sub(r"<[^>]+>", " ", html)
        return re.sub(r"\s+", " ", text).strip()


# ── Sentence splitting ────────────────────────────────────────────────────────

def _split_sentences(text: str) -> List[str]:
    """
    Split text into sentences on .!? followed by whitespace.
    Keeps sentences intact so chunks don't cut mid-sentence.
    """
    parts = re.split(r"(?<=[.!?])\s+", text)
    return [s.strip() for s in parts if s.strip()]


# ── Chunking ──────────────────────────────────────────────────────────────────

def create_chunks(
    text: str,
    chunk_size: int = CHUNK_SIZE,
    overlap: int = CHUNK_OVERLAP,
) -> List[str]:
    """
    Split *text* into overlapping chunks of ~chunk_size characters.

    Returns an empty list if the text is too short to be useful.
    """
    text = text.strip()
    if len(text) < MIN_CHUNK_LEN:
        return []

    # Short texts fit in a single chunk — no splitting needed
    if len(text) <= chunk_size:
        return [text]

    sentences = _split_sentences(text)
    if not sentences:
        return []

    chunks: List[str] = []
    current: List[str] = []
    current_len = 0

    for sent in sentences:
        sent_len = len(sent)

        if current_len + sent_len > chunk_size and current:
            # Flush current chunk
            chunk_text = " ".join(current).strip()
            if len(chunk_text) >= MIN_CHUNK_LEN:
                chunks.append(chunk_text)

            # Build overlap tail from the end of current
            overlap_sents: List[str] = []
            overlap_len = 0
            for prev in reversed(current):
                if overlap_len + len(prev) <= overlap:
                    overlap_sents.insert(0, prev)
                    overlap_len += len(prev)
                else:
                    break
            current = overlap_sents
            current_len = overlap_len

        current.append(sent)
        current_len += sent_len

    # Final chunk
    if current:
        chunk_text = " ".join(current).strip()
        if len(chunk_text) >= MIN_CHUNK_LEN:
            chunks.append(chunk_text)

    return chunks


# ── Per-item chunk preparation ────────────────────────────────────────────────

def prepare_item_chunks(
    item: Dict[str, Any],
    notes: Optional[List[Dict]] = None,
    fulltexts: Optional[List[Dict]] = None,
) -> List[Dict[str, Any]]:
    """
    Produce a list of chunk dicts for a single Zotero item.

    Each chunk dict has:
      item_key, source_type, chunk_text, chunk_index, page_number
    """
    item_key = item.get("item_key", "")
    result: List[Dict[str, Any]] = []

    def _add_chunks(text: str, source_type: str, page_number: Optional[int] = None) -> None:
        for idx, chunk_text in enumerate(create_chunks(text)):
            result.append(
                {
                    "item_key": item_key,
                    "source_type": source_type,
                    "chunk_text": chunk_text,
                    "chunk_index": idx,
                    "page_number": page_number,
                }
            )

    # Abstract
    abstract = item.get("abstract", "")
    if abstract:
        _add_chunks(abstract, "abstract")

    # Notes (HTML → plain text)
    for note in notes or []:
        note_text = extract_html_text(note.get("note_text", ""))
        if note_text:
            _add_chunks(note_text, "note")

    # Indexed full text
    for ft in fulltexts or []:
        content = ft.get("content", "")
        if content:
            _add_chunks(content, "fulltext")

    return result
