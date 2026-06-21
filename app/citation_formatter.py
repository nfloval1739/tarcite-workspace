"""
APA 7 citation formatter.

Generates both inline citations and full references from Zotero item metadata.
Handles the most common Zotero item types: journalArticle, book, bookSection,
conferencePaper, thesis, report, webpage, and a generic fallback.

Note: This is a hand-rolled APA 7 formatter.  If higher accuracy is needed in
the future, replace the _format_* functions with a citeproc-py / csl-json pipeline
(the public surface of this module does not need to change).
"""

import json
import logging
from typing import Any, Dict, List

from app.crossref import normalize_doi

logger = logging.getLogger(__name__)


# ── Creator helpers ───────────────────────────────────────────────────────────

def parse_creators(creators_raw: Any) -> List[Dict]:
    """Coerce stored creators value to a plain Python list."""
    if isinstance(creators_raw, str):
        try:
            return json.loads(creators_raw)
        except (json.JSONDecodeError, TypeError):
            return []
    if isinstance(creators_raw, list):
        return creators_raw
    return []


def _authors_only(creators: List[Dict]) -> List[Dict]:
    """Return only author-type creators; fall back to all creators if none found."""
    authors = [
        c for c in creators
        if c.get("creatorType", "author") in ("author", "creator")
    ]
    return authors if authors else creators


# ── Inline citation ───────────────────────────────────────────────────────────

def format_author_inline(creators: List[Dict]) -> str:
    """
    Return the author portion of an APA 7 inline citation.
      1 author  → Smith
      2 authors → Smith & Jones
      3+        → Smith et al.
    """
    authors = _authors_only(creators)
    if not authors:
        return "Unknown Author"

    def last(c: Dict) -> str:
        return c.get("lastName") or c.get("name") or "Unknown"

    if len(authors) == 1:
        return last(authors[0])
    if len(authors) == 2:
        return f"{last(authors[0])} & {last(authors[1])}"
    return f"{last(authors[0])} et al."


def format_inline_citation(item: Dict[str, Any]) -> str:
    """Return a formatted APA 7 inline citation: (Author, Year)."""
    creators = parse_creators(item.get("creators", []))
    author_str = format_author_inline(creators)
    year = item.get("year", "") or "n.d."
    return f"({author_str}, {year})"


# ── Full reference ────────────────────────────────────────────────────────────

def format_full_reference(item: Dict[str, Any]) -> str:
    """Return a formatted APA 7 full reference for *item*."""
    creators = parse_creators(item.get("creators", []))
    author_str = _format_author_block(creators)
    year = item.get("year", "") or "n.d."
    title = (item.get("title") or "Untitled").strip()
    item_type = item.get("item_type", "journalArticle")

    dispatch = {
        "journalArticle": _fmt_journal,
        "book": _fmt_book,
        "bookSection": _fmt_book_section,
        "conferencePaper": _fmt_conference,
        "thesis": _fmt_thesis,
        "report": _fmt_report,
        "webpage": _fmt_webpage,
        "preprint": _fmt_journal,        # treat like journal
        "magazineArticle": _fmt_journal,
        "newspaperArticle": _fmt_journal,
    }

    formatter = dispatch.get(item_type, _fmt_generic)
    return formatter(author_str, year, title, item)


def _format_author_block(creators: List[Dict]) -> str:
    """
    APA 7 author block for the full reference:
      Last, F. M., Last, F. M., & Last, F. M. (year).
    With 21+ authors, lists first 19, "...", then final author.
    """
    authors = _authors_only(creators)
    if not authors:
        return "Unknown Author."

    formatted: List[str] = []
    for c in authors:
        last = c.get("lastName") or c.get("name") or ""
        first = c.get("firstName") or ""
        if first:
            # Abbreviate each name component to initials
            initials = " ".join(f"{n[0]}." for n in first.split() if n)
            formatted.append(f"{last}, {initials}" if last else initials)
        elif last:
            formatted.append(last)

    if not formatted:
        return "Unknown Author."

    def _ensure_trailing_period(s: str) -> str:
        return s if s.endswith(".") else s + "."

    if len(formatted) == 1:
        return _ensure_trailing_period(formatted[0])
    if len(formatted) <= 20:
        return ", ".join(formatted[:-1]) + f", & {_ensure_trailing_period(formatted[-1])}"
    # 21+ authors
    return ", ".join(formatted[:19]) + f", . . . {_ensure_trailing_period(formatted[-1])}"


# ── Type-specific formatters ──────────────────────────────────────────────────

def _fmt_journal(author: str, year: str, title: str, item: Dict) -> str:
    pub = item.get("publication_title", "")
    volume = item.get("volume", "")
    issue = item.get("issue", "")
    pages = item.get("pages", "")
    doi = item.get("doi", "")

    ref = f"{author} ({year}). {title}."
    if pub:
        ref += f" *{pub}*"
        if volume:
            ref += f", *{volume}*"
            if issue:
                ref += f"({issue})"
        if pages:
            ref += f", {pages}"
        ref += "."
    if doi:
        doi_clean = normalize_doi(doi)
        ref += f" https://doi.org/{doi_clean}"
    elif item.get("url"):
        ref += f" {item['url']}"
    return ref


def _fmt_book(author: str, year: str, title: str, item: Dict) -> str:
    edition = item.get("edition", "")
    publisher = item.get("publisher", "")
    doi = item.get("doi", "")

    ref = f"{author} ({year}). *{title}*"
    if edition:
        ref += f" ({edition} ed.)"
    ref += "."
    if publisher:
        ref += f" {publisher}."
    if doi:
        doi_clean = normalize_doi(doi)
        ref += f" https://doi.org/{doi_clean}"
    elif item.get("url"):
        ref += f" {item['url']}"
    return ref


def _fmt_book_section(author: str, year: str, title: str, item: Dict) -> str:
    pub_title = item.get("publication_title", "")
    pages = item.get("pages", "")
    publisher = item.get("publisher", "")

    ref = f"{author} ({year}). {title}."
    if pub_title:
        page_str = f" (pp. {pages})" if pages else ""
        ref += f" In *{pub_title}*{page_str}."
    if publisher:
        ref += f" {publisher}."
    if item.get("doi"):
        doi_clean = normalize_doi(item["doi"])
        ref += f" https://doi.org/{doi_clean}"
    elif item.get("url"):
        ref += f" {item['url']}"
    return ref


def _fmt_conference(author: str, year: str, title: str, item: Dict) -> str:
    pub = item.get("publication_title", "")
    pages = item.get("pages", "")
    doi = item.get("doi", "")

    ref = f"{author} ({year}). {title}."
    if pub:
        ref += f" In *{pub}*"
        if pages:
            ref += f" (pp. {pages})"
        ref += "."
    if doi:
        doi_clean = normalize_doi(doi)
        ref += f" https://doi.org/{doi_clean}"
    elif item.get("url"):
        ref += f" {item['url']}"
    return ref


def _fmt_thesis(author: str, year: str, title: str, item: Dict) -> str:
    publisher = item.get("publisher", "")  # institution
    extra = item.get("extra", "")

    # Try to extract thesis type from extra field
    thesis_type = "Doctoral dissertation"
    if extra and "master" in extra.lower():
        thesis_type = "Master's thesis"

    ref = f"{author} ({year}). *{title}* [{thesis_type}"
    if publisher:
        ref += f", {publisher}"
    ref += "]."
    if item.get("url"):
        ref += f" {item['url']}"
    return ref


def _fmt_report(author: str, year: str, title: str, item: Dict) -> str:
    publisher = item.get("publisher", "")

    ref = f"{author} ({year}). *{title}*."
    if publisher:
        ref += f" {publisher}."
    if item.get("url"):
        ref += f" {item['url']}"
    return ref


def _fmt_webpage(author: str, year: str, title: str, item: Dict) -> str:
    site = item.get("publication_title", "")

    ref = f"{author} ({year}). {title}."
    if site:
        ref += f" *{site}*."
    if item.get("url"):
        ref += f" {item['url']}"
    return ref


def _fmt_generic(author: str, year: str, title: str, item: Dict) -> str:
    pub = item.get("publication_title", "")
    doi = item.get("doi", "")

    ref = f"{author} ({year}). {title}."
    if pub:
        ref += f" *{pub}*."
    if doi:
        doi_clean = normalize_doi(doi)
        ref += f" https://doi.org/{doi_clean}"
    elif item.get("url"):
        ref += f" {item['url']}"
    return ref
