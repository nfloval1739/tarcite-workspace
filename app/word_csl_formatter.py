"""
CSL-style citation formatter for Word connector.

Supports APA 7, Harvard, IEEE, Chicago, MLA, and Vancouver styles.
Produces both inline citations and full bibliography entries from
Zotero-compatible item metadata.
"""

import json
import logging
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

SUPPORTED_STYLES = [
    "apa7", "apa6", "harvard", "ieee", "chicago", "mla", "vancouver",
    "nature", "acs", "ama", "elsevierharvard", "springerauthordate",
]


def parse_creators(creators_raw: Any) -> List[Dict]:
    if isinstance(creators_raw, str):
        try:
            return json.loads(creators_raw)
        except (json.JSONDecodeError, TypeError):
            return []
    if isinstance(creators_raw, list):
        return creators_raw
    return []


def _authors_only(creators: List[Dict]) -> List[Dict]:
    authors = [
        c for c in creators
        if c.get("creatorType", "author") in ("author", "creator")
    ]
    return authors if authors else creators


def _last_name(c: Dict) -> str:
    return (c.get("lastName") or c.get("name") or "Unknown").strip()


def _first_name(c: Dict) -> str:
    return (c.get("firstName") or "").strip()


def _initials(first: str) -> str:
    if not first:
        return ""
    return " ".join(f"{n[0]}." for n in first.split() if n)


def _clean_year(item: Dict) -> str:
    year = item.get("year", "") or ""
    if year and year.isdigit():
        return year
    date = item.get("date", "") or ""
    if date:
        import re
        m = re.search(r"(\d{4})", date)
        if m:
            return m.group(1)
    return "n.d."


def _clean_title(item: Dict) -> str:
    return (item.get("title") or "Untitled").strip()


def _clean_doi(item: Dict) -> str:
    doi = (item.get("doi") or "").strip()
    if doi.startswith("https://doi.org/"):
        doi = doi[len("https://doi.org/"):]
    if doi.startswith("http://dx.doi.org/"):
        doi = doi[len("http://dx.doi.org/"):]
    return doi


def _url_or_doi(item: Dict) -> str:
    doi = _clean_doi(item)
    if doi:
        return f"https://doi.org/{doi}"
    url = (item.get("url") or "").strip()
    return url


def _locator_text(style: str, locator: str = "", locator_type: str = "page") -> str:
    locator = str(locator or "").strip()
    if not locator:
        return ""

    style = style.lower().replace("-", "")
    locator_type = (locator_type or "page").lower()
    if locator_type == "page":
        page_label = "pp." if any(ch in locator for ch in ("-", ",")) else "p."
        if style in ("apa7", "harvard"):
            return f", {page_label} {locator}"
        if style in ("chicago", "mla"):
            return f" {locator}" if style == "mla" else f", {locator}"
        return f" {locator}"

    labels = {
        "chapter": "chap.",
        "section": "sec.",
        "paragraph": "para.",
    }
    label = labels.get(locator_type, locator_type)
    if style in ("apa7", "harvard"):
        return f", {label} {locator}"
    if style == "chicago":
        return f", {label} {locator}"
    if style == "mla":
        return f" {label} {locator}"
    return f" {label} {locator}"


# ── APA 7 ─────────────────────────────────────────────────────────────────────

def _apa_author_inline(authors: List[Dict]) -> str:
    if not authors:
        return "Unknown Author"
    if len(authors) == 1:
        return _last_name(authors[0])
    if len(authors) == 2:
        return f"{_last_name(authors[0])} & {_last_name(authors[1])}"
    return f"{_last_name(authors[0])} et al."


def _apa_author_block(authors: List[Dict]) -> str:
    if not authors:
        return "Unknown Author."
    formatted = []
    for c in authors:
        last = _last_name(c)
        first = _first_name(c)
        if first:
            formatted.append(f"{last}, {_initials(first)}")
        elif last:
            formatted.append(last)
    if not formatted:
        return "Unknown Author."
    if len(formatted) == 1:
        return formatted[0] + "."
    if len(formatted) <= 20:
        last_author = formatted[-1]
        if not last_author.endswith("."):
            last_author += "."
        return ", ".join(formatted[:-1]) + f", & {last_author}"
    last_author = formatted[-1]
    if not last_author.endswith("."):
        last_author += "."
    return ", ".join(formatted[:19]) + f", . . . {last_author}"


def _apa_journal(item: Dict, author: str, year: str, title: str) -> str:
    pub = (item.get("publication_title") or "").strip()
    volume = (item.get("volume") or "").strip()
    issue = (item.get("issue") or "").strip()
    pages = (item.get("pages") or "").strip()
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
    link = _url_or_doi(item)
    if link:
        ref += f" {link}"
    return ref


def _apa_book(item: Dict, author: str, year: str, title: str) -> str:
    edition = (item.get("edition") or "").strip()
    publisher = (item.get("publisher") or "").strip()
    ref = f"{author} ({year}). *{title}*"
    if edition:
        ref += f" ({edition} ed.)"
    ref += "."
    if publisher:
        ref += f" {publisher}."
    link = _url_or_doi(item)
    if link:
        ref += f" {link}"
    return ref


def _apa_book_section(item: Dict, author: str, year: str, title: str) -> str:
    pub_title = (item.get("publication_title") or "").strip()
    pages = (item.get("pages") or "").strip()
    publisher = (item.get("publisher") or "").strip()
    ref = f"{author} ({year}). {title}."
    if pub_title:
        page_str = f" (pp. {pages})" if pages else ""
        ref += f" In *{pub_title}*{page_str}."
    if publisher:
        ref += f" {publisher}."
    link = _url_or_doi(item)
    if link:
        ref += f" {link}"
    return ref


def _apa_conference(item: Dict, author: str, year: str, title: str) -> str:
    pub = (item.get("publication_title") or "").strip()
    pages = (item.get("pages") or "").strip()
    ref = f"{author} ({year}). {title}."
    if pub:
        ref += f" In *{pub}*"
        if pages:
            ref += f" (pp. {pages})"
        ref += "."
    link = _url_or_doi(item)
    if link:
        ref += f" {link}"
    return ref


def _apa_thesis(item: Dict, author: str, year: str, title: str) -> str:
    publisher = (item.get("publisher") or "").strip()
    extra = (item.get("extra") or "").strip()
    thesis_type = "Doctoral dissertation"
    if extra and "master" in extra.lower():
        thesis_type = "Master's thesis"
    ref = f"{author} ({year}). *{title}* [{thesis_type}"
    if publisher:
        ref += f", {publisher}"
    ref += "]."
    link = _url_or_doi(item)
    if link:
        ref += f" {link}"
    return ref


def _apa_report(item: Dict, author: str, year: str, title: str) -> str:
    publisher = (item.get("publisher") or "").strip()
    ref = f"{author} ({year}). *{title}*."
    if publisher:
        ref += f" {publisher}."
    link = _url_or_doi(item)
    if link:
        ref += f" {link}"
    return ref


def _apa_webpage(item: Dict, author: str, year: str, title: str) -> str:
    site = (item.get("publication_title") or "").strip()
    ref = f"{author} ({year}). {title}."
    if site:
        ref += f" *{site}*."
    link = _url_or_doi(item)
    if link:
        ref += f" {link}"
    return ref


def _apa_generic(item: Dict, author: str, year: str, title: str) -> str:
    pub = (item.get("publication_title") or "").strip()
    ref = f"{author} ({year}). {title}."
    if pub:
        ref += f" *{pub}*."
    link = _url_or_doi(item)
    if link:
        ref += f" {link}"
    return ref


def apa7_inline(item: Dict, locator: str = "", locator_type: str = "page", prefix: str = "", suffix: str = "", suppress_author: bool = False) -> str:
    creators = parse_creators(item.get("creators", []))
    authors = _authors_only(creators)
    year = _clean_year(item)
    if suppress_author:
        inner = f"{year}"
    else:
        inner = f"{_apa_author_inline(authors)}, {year}"
    inner += _locator_text("apa7", locator, locator_type)
    parts = []
    if prefix:
        parts.append(prefix)
    parts.append(f"({inner})")
    if suffix:
        parts[-1] = parts[-1] + suffix
    return " ".join(parts)


def apa7_reference(item: Dict) -> str:
    creators = parse_creators(item.get("creators", []))
    authors = _authors_only(creators)
    author = _apa_author_block(authors)
    year = _clean_year(item)
    title = _clean_title(item)
    item_type = item.get("item_type", "journalArticle")
    dispatch = {
        "journalArticle": _apa_journal,
        "book": _apa_book,
        "bookSection": _apa_book_section,
        "conferencePaper": _apa_conference,
        "thesis": _apa_thesis,
        "report": _apa_report,
        "webpage": _apa_webpage,
        "preprint": _apa_journal,
        "magazineArticle": _apa_journal,
        "newspaperArticle": _apa_journal,
    }
    formatter = dispatch.get(item_type, _apa_generic)
    return formatter(item, author, year, title)


# ── Harvard ───────────────────────────────────────────────────────────────────

def _harvard_author_inline(authors: List[Dict]) -> str:
    if not authors:
        return "Unknown Author"
    if len(authors) == 1:
        return _last_name(authors[0])
    if len(authors) == 2:
        return f"{_last_name(authors[0])} and {_last_name(authors[1])}"
    return f"{_last_name(authors[0])} et al."


def _harvard_author_block(authors: List[Dict]) -> str:
    if not authors:
        return "Unknown Author"
    formatted = []
    for c in authors:
        last = _last_name(c)
        first = _first_name(c)
        if first:
            formatted.append(f"{last}, {_initials(first)}")
        elif last:
            formatted.append(last)
    if not formatted:
        return "Unknown Author"
    if len(formatted) == 1:
        return formatted[0]
    if len(formatted) == 2:
        return f"{formatted[0]} and {formatted[1]}"
    return ", ".join(formatted[:-1]) + f" and {formatted[-1]}"


def _harvard_journal(item: Dict, author: str, year: str, title: str) -> str:
    pub = (item.get("publication_title") or "").strip()
    volume = (item.get("volume") or "").strip()
    issue = (item.get("issue") or "").strip()
    pages = (item.get("pages") or "").strip()
    ref = f"{author} ({year}) {title}."
    if pub:
        ref += f" *{pub}*"
        if volume:
            ref += f", {volume}"
            if issue:
                ref += f"({issue})"
        if pages:
            ref += f", pp. {pages}"
        ref += "."
    link = _url_or_doi(item)
    if link:
        ref += f" Available at: {link}"
    return ref


def _harvard_book(item: Dict, author: str, year: str, title: str) -> str:
    edition = (item.get("edition") or "").strip()
    publisher = (item.get("publisher") or "").strip()
    place = (item.get("place") or "").strip()
    ref = f"{author} ({year}) *{title}*"
    if edition:
        ref += f". {edition} edn"
    ref += "."
    if place and publisher:
        ref += f" {place}: {publisher}."
    elif publisher:
        ref += f" {publisher}."
    link = _url_or_doi(item)
    if link:
        ref += f" Available at: {link}"
    return ref


def _harvard_generic(item: Dict, author: str, year: str, title: str) -> str:
    pub = (item.get("publication_title") or "").strip()
    publisher = (item.get("publisher") or "").strip()
    ref = f"{author} ({year}) {title}."
    if pub:
        ref += f" *{pub}*."
    if publisher:
        ref += f" {publisher}."
    link = _url_or_doi(item)
    if link:
        ref += f" Available at: {link}"
    return ref


def harvard_inline(item: Dict, locator: str = "", locator_type: str = "page", prefix: str = "", suffix: str = "", suppress_author: bool = False) -> str:
    creators = parse_creators(item.get("creators", []))
    authors = _authors_only(creators)
    year = _clean_year(item)
    if suppress_author:
        inner = f"{year}"
    else:
        inner = f"{_harvard_author_inline(authors)}, {year}"
    inner += _locator_text("harvard", locator, locator_type)
    parts = []
    if prefix:
        parts.append(prefix)
    parts.append(f"({inner})")
    if suffix:
        parts[-1] = parts[-1] + suffix
    return " ".join(parts)


def harvard_reference(item: Dict) -> str:
    creators = parse_creators(item.get("creators", []))
    authors = _authors_only(creators)
    author = _harvard_author_block(authors)
    year = _clean_year(item)
    title = _clean_title(item)
    item_type = item.get("item_type", "journalArticle")
    if item_type == "book":
        return _harvard_book(item, author, year, title)
    if item_type == "journalArticle":
        return _harvard_journal(item, author, year, title)
    return _harvard_generic(item, author, year, title)


# ── IEEE ──────────────────────────────────────────────────────────────────────

def _ieee_author_block(authors: List[Dict]) -> str:
    if not authors:
        return "Unknown Author"
    formatted = []
    for c in authors:
        last = _last_name(c)
        first = _first_name(c)
        if first:
            formatted.append(f"{_initials(first)} {last}")
        elif last:
            formatted.append(last)
    if not formatted:
        return "Unknown Author"
    if len(formatted) == 1:
        return formatted[0]
    if len(formatted) == 2:
        return f"{formatted[0]} and {formatted[1]}"
    return ", ".join(formatted[:-1]) + f", and {formatted[-1]}"


def _ieee_journal(item: Dict, author: str, year: str, title: str) -> str:
    pub = (item.get("publication_title") or "").strip()
    volume = (item.get("volume") or "").strip()
    issue = (item.get("issue") or "").strip()
    pages = (item.get("pages") or "").strip()
    ref = f"{author}, \"{title},\" *{pub}*"
    parts = []
    if volume:
        parts.append(f"vol. {volume}")
    if issue:
        parts.append(f"no. {issue}")
    if pages:
        parts.append(f"pp. {pages}")
    if parts:
        ref += ", " + ", ".join(parts)
    ref += f", {year}."
    link = _url_or_doi(item)
    if link:
        ref += f" doi: {_clean_doi(item)}." if _clean_doi(item) else f" Available: {link}"
    return ref


def _ieee_book(item: Dict, author: str, year: str, title: str) -> str:
    edition = (item.get("edition") or "").strip()
    publisher = (item.get("publisher") or "").strip()
    place = (item.get("place") or "").strip()
    ref = f"{author}, *{title}*"
    if edition:
        ref += f", {edition} ed."
    ref += "."
    if place and publisher:
        ref += f" {place}: {publisher}, {year}."
    elif publisher:
        ref += f" {publisher}, {year}."
    else:
        ref += f" {year}."
    link = _url_or_doi(item)
    if link:
        ref += f" Available: {link}"
    return ref


def _ieee_generic(item: Dict, author: str, year: str, title: str) -> str:
    pub = (item.get("publication_title") or "").strip()
    publisher = (item.get("publisher") or "").strip()
    ref = f"{author}, \"{title}\""
    if pub:
        ref += f", *{pub}*"
    ref += f", {year}."
    if publisher:
        ref += f" {publisher}."
    link = _url_or_doi(item)
    if link:
        ref += f" Available: {link}"
    return ref


def ieee_inline(index: int) -> str:
    return f"[{index}]"


def ieee_reference(item: Dict) -> str:
    creators = parse_creators(item.get("creators", []))
    authors = _authors_only(creators)
    author = _ieee_author_block(authors)
    year = _clean_year(item)
    title = _clean_title(item)
    item_type = item.get("item_type", "journalArticle")
    if item_type == "book":
        return _ieee_book(item, author, year, title)
    if item_type == "journalArticle":
        return _ieee_journal(item, author, year, title)
    return _ieee_generic(item, author, year, title)


# ── Chicago (Notes-Bibliography) ──────────────────────────────────────────────

def _chicago_author_block(authors: List[Dict]) -> str:
    if not authors:
        return "Unknown Author"
    formatted = []
    for c in authors:
        last = _last_name(c)
        first = _first_name(c)
        if first:
            formatted.append(f"{last}, {first}")
        elif last:
            formatted.append(last)
    if not formatted:
        return "Unknown Author"
    if len(formatted) == 1:
        return formatted[0]
    if len(formatted) == 2:
        return f"{formatted[0]} and {formatted[1]}"
    return ", ".join(formatted[:-1]) + f", and {formatted[-1]}"


def _chicago_author_block_first_inverted(authors: List[Dict]) -> str:
    if not authors:
        return "Unknown Author"
    formatted = []
    for i, c in enumerate(authors):
        last = _last_name(c)
        first = _first_name(c)
        if i == 0:
            if first:
                formatted.append(f"{last}, {first}")
            elif last:
                formatted.append(last)
        else:
            if first:
                formatted.append(f"{first} {last}")
            elif last:
                formatted.append(last)
    if not formatted:
        return "Unknown Author"
    if len(formatted) == 1:
        return formatted[0]
    if len(formatted) == 2:
        return f"{formatted[0]} and {formatted[1]}"
    return ", ".join(formatted[:-1]) + f", and {formatted[-1]}"


def _chicago_journal(item: Dict, author: str, year: str, title: str) -> str:
    pub = (item.get("publication_title") or "").strip()
    volume = (item.get("volume") or "").strip()
    issue = (item.get("issue") or "").strip()
    pages = (item.get("pages") or "").strip()
    ref = f"{author}. \"{title}.\" *{pub}*"
    parts = []
    if volume:
        if issue:
            parts.append(f"{volume}, no. {issue}")
        else:
            parts.append(str(volume))
    if parts:
        ref += " " + " (" + ", ".join(parts) + ")" if False else f" {parts[0]}"
    if pages:
        ref += f" ({year}): {pages}"
    else:
        ref += f" ({year})"
    ref += "."
    link = _url_or_doi(item)
    if link:
        ref += f" {link}"
    return ref


def _chicago_book(item: Dict, author: str, year: str, title: str) -> str:
    edition = (item.get("edition") or "").strip()
    publisher = (item.get("publisher") or "").strip()
    place = (item.get("place") or "").strip()
    ref = f"{author}. *{title}*"
    if edition:
        ref += f". {edition} ed."
    ref += "."
    if place and publisher:
        ref += f" {place}: {publisher}, {year}."
    elif publisher:
        ref += f" {publisher}, {year}."
    else:
        ref += f" {year}."
    link = _url_or_doi(item)
    if link:
        ref += f" {link}"
    return ref


def _chicago_generic(item: Dict, author: str, year: str, title: str) -> str:
    pub = (item.get("publication_title") or "").strip()
    publisher = (item.get("publisher") or "").strip()
    ref = f"{author}. \"{title}.\""
    if pub:
        ref += f" *{pub}*"
    ref += f" ({year})."
    if publisher:
        ref += f" {publisher}."
    link = _url_or_doi(item)
    if link:
        ref += f" {link}"
    return ref


def chicago_inline(item: Dict, locator: str = "", locator_type: str = "page", prefix: str = "", suffix: str = "", suppress_author: bool = False) -> str:
    creators = parse_creators(item.get("creators", []))
    authors = _authors_only(creators)
    if suppress_author:
        title = _clean_title(item)
        short_title = title[:50] + "..." if len(title) > 50 else title
        inner = f"\"{short_title}\""
    else:
        if len(authors) == 1:
            inner = _last_name(authors[0])
        elif len(authors) == 2:
            inner = f"{_last_name(authors[0])} and {_last_name(authors[1])}"
        else:
            inner = f"{_last_name(authors[0])} et al."
    inner += _locator_text("chicago", locator, locator_type)
    parts = []
    if prefix:
        parts.append(prefix)
    parts.append(inner)
    if suffix:
        parts[-1] = parts[-1] + suffix
    return " ".join(parts)


def chicago_reference(item: Dict) -> str:
    creators = parse_creators(item.get("creators", []))
    authors = _authors_only(creators)
    author = _chicago_author_block_first_inverted(authors)
    year = _clean_year(item)
    title = _clean_title(item)
    item_type = item.get("item_type", "journalArticle")
    if item_type == "book":
        return _chicago_book(item, author, year, title)
    if item_type == "journalArticle":
        return _chicago_journal(item, author, year, title)
    return _chicago_generic(item, author, year, title)


# ── MLA 9 ─────────────────────────────────────────────────────────────────────

def _mla_author_inline(authors: List[Dict]) -> str:
    if not authors:
        return "Unknown Author"
    if len(authors) == 1:
        return _last_name(authors[0])
    if len(authors) == 2:
        return f"{_last_name(authors[0])} and {_last_name(authors[1])}"
    return f"{_last_name(authors[0])} et al."


def _mla_author_block(authors: List[Dict]) -> str:
    if not authors:
        return "Unknown Author."
    formatted = []
    for i, c in enumerate(authors):
        last = _last_name(c)
        first = _first_name(c)
        if i == 0:
            if first:
                formatted.append(f"{last}, {first}")
            elif last:
                formatted.append(last)
        else:
            if first:
                formatted.append(f"{first} {last}")
            elif last:
                formatted.append(last)
    if not formatted:
        return "Unknown Author."
    if len(formatted) == 1:
        return formatted[0] + "."
    if len(formatted) == 2:
        return f"{formatted[0]}, and {formatted[1]}."
    return f"{formatted[0]}, et al."


def _mla_journal(item: Dict, author: str, year: str, title: str) -> str:
    pub = (item.get("publication_title") or "").strip()
    volume = (item.get("volume") or "").strip()
    issue = (item.get("issue") or "").strip()
    pages = (item.get("pages") or "").strip()
    ref = f"{author} \"{title}.\" *{pub}*"
    parts = []
    if volume:
        parts.append(f"vol. {volume}")
    if issue:
        parts.append(f"no. {issue}")
    if pages:
        parts.append(f"pp. {pages}")
    if parts:
        ref += ", " + ", ".join(parts) + ","
    ref += f" {year},"
    link = _url_or_doi(item)
    if link:
        ref += f" {link}."
    else:
        ref += "."
    return ref


def _mla_book(item: Dict, author: str, year: str, title: str) -> str:
    edition = (item.get("edition") or "").strip()
    publisher = (item.get("publisher") or "").strip()
    ref = f"{author} *{title}*"
    if edition:
        ref += f". {edition} ed."
    ref += ","
    if publisher:
        ref += f" {publisher}, {year}."
    else:
        ref += f" {year}."
    link = _url_or_doi(item)
    if link:
        ref += f" {link}"
    return ref


def _mla_generic(item: Dict, author: str, year: str, title: str) -> str:
    pub = (item.get("publication_title") or "").strip()
    publisher = (item.get("publisher") or "").strip()
    ref = f"{author} \"{title}.\""
    if pub:
        ref += f" *{pub}*"
    ref += f" {year}."
    if publisher:
        ref += f" {publisher}."
    link = _url_or_doi(item)
    if link:
        ref += f" {link}"
    return ref


def mla_inline(item: Dict, locator: str = "", locator_type: str = "page", prefix: str = "", suffix: str = "", suppress_author: bool = False) -> str:
    creators = parse_creators(item.get("creators", []))
    authors = _authors_only(creators)
    if suppress_author:
        title = _clean_title(item)
        short_title = title[:50] + "..." if len(title) > 50 else title
        inner = f"\"{short_title}\""
    else:
        inner = _mla_author_inline(authors)
    inner += _locator_text("mla", locator, locator_type)
    parts = []
    if prefix:
        parts.append(prefix)
    parts.append(f"({inner})")
    if suffix:
        parts[-1] = parts[-1] + suffix
    return " ".join(parts)


def mla_reference(item: Dict) -> str:
    creators = parse_creators(item.get("creators", []))
    authors = _authors_only(creators)
    author = _mla_author_block(authors)
    year = _clean_year(item)
    title = _clean_title(item)
    item_type = item.get("item_type", "journalArticle")
    if item_type == "book":
        return _mla_book(item, author, year, title)
    if item_type == "journalArticle":
        return _mla_journal(item, author, year, title)
    return _mla_generic(item, author, year, title)


# ── Vancouver ─────────────────────────────────────────────────────────────────

def _vancouver_author_block(authors: List[Dict]) -> str:
    if not authors:
        return "Unknown Author."
    formatted = []
    for c in authors:
        last = _last_name(c)
        first = _first_name(c)
        if first:
            initials = "".join(n[0] for n in first.split() if n)
            formatted.append(f"{last} {initials}")
        elif last:
            formatted.append(last)
    if not formatted:
        return "Unknown Author."
    if len(formatted) <= 6:
        return ", ".join(formatted) + "."
    return ", ".join(formatted[:3]) + ", et al."


def _vancouver_journal(item: Dict, author: str, year: str, title: str) -> str:
    pub = (item.get("publication_title") or "").strip()
    date_str = (item.get("date") or "").strip()
    volume = (item.get("volume") or "").strip()
    issue = (item.get("issue") or "").strip()
    pages = (item.get("pages") or "").strip()
    ref = f"{author} {title}. *{pub}*."
    if date_str:
        ref += f" {date_str}"
    else:
        ref += f" {year}"
    if volume:
        ref += f";{volume}"
        if issue:
            ref += f"({issue})"
    if pages:
        ref += f":{pages}"
    ref += "."
    link = _url_or_doi(item)
    if link:
        ref += f" Available from: {link}"
    return ref


def _vancouver_book(item: Dict, author: str, year: str, title: str) -> str:
    edition = (item.get("edition") or "").strip()
    publisher = (item.get("publisher") or "").strip()
    place = (item.get("place") or "").strip()
    ref = f"{author} {title}."
    if edition:
        ref += f" {edition} ed."
    if place and publisher:
        ref += f" {place}: {publisher}; {year}."
    elif publisher:
        ref += f" {publisher}; {year}."
    else:
        ref += f" {year}."
    link = _url_or_doi(item)
    if link:
        ref += f" Available from: {link}"
    return ref


def _vancouver_generic(item: Dict, author: str, year: str, title: str) -> str:
    pub = (item.get("publication_title") or "").strip()
    publisher = (item.get("publisher") or "").strip()
    ref = f"{author} {title}."
    if pub:
        ref += f" *{pub}*."
    if publisher:
        ref += f" {publisher}; {year}."
    else:
        ref += f" {year}."
    link = _url_or_doi(item)
    if link:
        ref += f" Available from: {link}"
    return ref


def vancouver_inline(index: int) -> str:
    return f"({index})"


def vancouver_reference(item: Dict) -> str:
    creators = parse_creators(item.get("creators", []))
    authors = _authors_only(creators)
    author = _vancouver_author_block(authors)
    year = _clean_year(item)
    title = _clean_title(item)
    item_type = item.get("item_type", "journalArticle")
    if item_type == "book":
        return _vancouver_book(item, author, year, title)
    if item_type == "journalArticle":
        return _vancouver_journal(item, author, year, title)
    return _vancouver_generic(item, author, year, title)


# ── Public API ────────────────────────────────────────────────────────────────

def format_inline_citation(
    item: Dict,
    style: str = "apa7",
    locator: str = "",
    locator_type: str = "page",
    prefix: str = "",
    suffix: str = "",
    suppress_author: bool = False,
    ieee_index: Optional[int] = None,
    vancouver_index: Optional[int] = None,
) -> str:
    style = style.lower().replace("-", "")
    try:
        from app.csl_engine import has_csl_style, is_numeric_style, render_inline
        if has_csl_style(style) and not is_numeric_style(style):
            return render_inline([{
                "item": item,
                "locator": locator,
                "locator_type": locator_type,
                "prefix": prefix,
                "suffix": suffix,
                "suppress_author": suppress_author,
            }], style)
    except Exception as exc:
        logger.debug("CSL inline fallback for style=%s: %s", style, exc)

    if style == "apa7":
        return apa7_inline(item, locator, locator_type, prefix, suffix, suppress_author)
    if style == "harvard":
        return harvard_inline(item, locator, locator_type, prefix, suffix, suppress_author)
    if style == "ieee":
        idx = ieee_index if ieee_index is not None else 1
        parts = []
        if prefix:
            parts.append(prefix)
        parts.append(ieee_inline(idx))
        if suffix:
            parts[-1] = parts[-1] + suffix
        return " ".join(parts)
    if style == "chicago":
        return chicago_inline(item, locator, locator_type, prefix, suffix, suppress_author)
    if style == "mla":
        return mla_inline(item, locator, locator_type, prefix, suffix, suppress_author)
    if style == "vancouver":
        idx = vancouver_index if vancouver_index is not None else 1
        parts = []
        if prefix:
            parts.append(prefix)
        parts.append(vancouver_inline(idx))
        if suffix:
            parts[-1] = parts[-1] + suffix
        return " ".join(parts)
    return apa7_inline(item, locator, locator_type, prefix, suffix, suppress_author)


def format_inline_citations(
    items: List[Dict],
    style: str = "apa7",
    citation_format: str = "parenthetical",
) -> str:
    """Format multiple citations together.
    Parenthetical: (Author1, 2020; Author2, 2021)
    Narrative: Author1 (2020) and Author2 (2021)
    """
    if not items:
        return ""
    if len(items) == 1:
        entry = items[0]
        if citation_format == "narrative":
            return format_narrative_citation(entry["item"], style=style,
                locator=entry.get("locator", ""), locator_type=entry.get("locator_type", "page"),
                suffix=entry.get("suffix", ""))
        return format_inline_citation(entry["item"], style=style,
            locator=entry.get("locator", ""), locator_type=entry.get("locator_type", "page"),
            prefix=entry.get("prefix", ""),
            suffix=entry.get("suffix", ""), suppress_author=entry.get("suppress_author", False))

    style = style.lower().replace("-", "")

    if style in ("ieee", "vancouver"):
        parts = []
        for i, entry in enumerate(items):
            idx = i + 1
            parts.append(format_inline_citation(entry["item"], style=style, ieee_index=idx, vancouver_index=idx))
        if style == "ieee":
            return ", ".join(parts)
        return "".join(parts)

    if citation_format != "narrative":
        try:
            from app.csl_engine import has_csl_style, is_numeric_style, render_inline
            if has_csl_style(style) and not is_numeric_style(style):
                return render_inline(items, style)
        except Exception as exc:
            logger.debug("CSL multi-inline fallback for style=%s: %s", style, exc)

    if citation_format == "narrative":
        parts = []
        for i, entry in enumerate(items):
            item = entry["item"]
            creators = parse_creators(item.get("creators", []))
            authors = _authors_only(creators)
            year = _clean_year(item)
            locator = entry.get("locator", "")
            locator_type = entry.get("locator_type", "page")
            suffix = entry.get("suffix", "")

            if style == "apa7":
                author_part = _apa_author_inline(authors)
            elif style == "harvard":
                author_part = _harvard_author_inline(authors)
            elif style == "chicago":
                if len(authors) == 1:
                    author_part = _last_name(authors[0])
                elif len(authors) == 2:
                    author_part = f"{_last_name(authors[0])} and {_last_name(authors[1])}"
                else:
                    author_part = f"{_last_name(authors[0])} et al."
            elif style == "mla":
                author_part = _mla_author_inline(authors)
            else:
                author_part = _apa_author_inline(authors)

            year_part = f"({year}"
            year_part += _locator_text(style, locator, locator_type)
            year_part += ")"
            if suffix:
                year_part += suffix

            parts.append(f"{author_part} {year_part}")

        if len(parts) == 2:
            return f"{parts[0]} and {parts[1]}"
        if len(parts) > 2:
            return ", ".join(parts[:-1]) + f", and {parts[-1]}"
        return parts[0]

    parts = []
    for entry in items:
        item = entry["item"]
        locator = entry.get("locator", "")
        locator_type = entry.get("locator_type", "page")
        prefix = entry.get("prefix", "")
        suffix = entry.get("suffix", "")
        suppress_author = entry.get("suppress_author", False)

        creators = parse_creators(item.get("creators", []))
        authors = _authors_only(creators)
        year = _clean_year(item)

        if suppress_author:
            inner = year
        elif style == "apa7":
            inner = f"{_apa_author_inline(authors)}, {year}"
        elif style == "harvard":
            inner = f"{_harvard_author_inline(authors)}, {year}"
        elif style == "chicago":
            if len(authors) == 1:
                inner = _last_name(authors[0])
            elif len(authors) == 2:
                inner = f"{_last_name(authors[0])} and {_last_name(authors[1])}"
            else:
                inner = f"{_last_name(authors[0])} et al."
        elif style == "mla":
            inner = _mla_author_inline(authors)
        else:
            inner = f"{_apa_author_inline(authors)}, {year}"

        inner += _locator_text(style, locator, locator_type)

        if prefix:
            inner = f"{prefix} {inner}"
        if suffix:
            inner = f"{inner}{suffix}"
        parts.append(inner)

    combined = "; ".join(parts)
    combined = f"({combined})"

    return combined


def format_narrative_citation(
    item: Dict,
    style: str = "apa7",
    locator: str = "",
    locator_type: str = "page",
    suffix: str = "",
) -> str:
    """Format a single citation in narrative form: Author (Year)."""
    style = style.lower().replace("-", "")
    creators = parse_creators(item.get("creators", []))
    authors = _authors_only(creators)
    year = _clean_year(item)

    if style == "apa7":
        author_part = _apa_author_inline(authors)
    elif style == "harvard":
        author_part = _harvard_author_inline(authors)
    elif style == "chicago":
        if len(authors) == 1:
            author_part = _last_name(authors[0])
        elif len(authors) == 2:
            author_part = f"{_last_name(authors[0])} and {_last_name(authors[1])}"
        else:
            author_part = f"{_last_name(authors[0])} et al."
    elif style == "mla":
        author_part = _mla_author_inline(authors)
    else:
        author_part = _apa_author_inline(authors)

    year_part = f"({year}"
    year_part += _locator_text(style, locator, locator_type)
    year_part += ")"
    if suffix:
        year_part += suffix

    return f"{author_part} {year_part}"


def format_reference(item: Dict, style: str = "apa7") -> str:
    style = style.lower().replace("-", "")
    try:
        from app.csl_engine import has_csl_style, render_reference
        if has_csl_style(style):
            return render_reference(item, style)
    except Exception as exc:
        logger.debug("CSL reference fallback for style=%s: %s", style, exc)

    if style == "apa7":
        return apa7_reference(item).replace("*", "")
    if style == "harvard":
        return harvard_reference(item).replace("*", "")
    if style == "ieee":
        return ieee_reference(item).replace("*", "")
    if style == "chicago":
        return chicago_reference(item).replace("*", "")
    if style == "mla":
        return mla_reference(item).replace("*", "")
    if style == "vancouver":
        return vancouver_reference(item).replace("*", "")
    return apa7_reference(item).replace("*", "")


def format_bibliography(items: List[Dict], style: str = "apa7") -> str:
    style = style.lower().replace("-", "")
    try:
        from app.csl_engine import has_csl_style, render_bibliography
        if has_csl_style(style):
            return render_bibliography(items, style)
    except Exception as exc:
        logger.debug("CSL bibliography fallback for style=%s: %s", style, exc)

    entries = []
    for item in items:
        ref = format_reference(item, style)
        ref = ref.replace("*", "")
        entries.append(ref)
    if style in ("apa7", "harvard", "chicago", "mla"):
        entries.sort(key=lambda e: e.lower())
    return "\n".join(entries)
