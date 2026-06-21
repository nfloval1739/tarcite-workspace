"""
Local CSL rendering adapter.

Uses bundled CSL XML files and citeproc-py. The public formatter keeps the
existing hand-written implementation as a fallback, so missing dependencies or
style edge cases do not break Word insertion.
"""

import html
import logging
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

from app.citation_formatter import parse_creators

logger = logging.getLogger(__name__)

CSL_DIR = Path(__file__).parent / "csl" / "styles"

CSL_STYLE_MAP: Dict[str, str] = {
    "apa7": "apa.csl",
    "apa6": "apa-6th-edition.csl",
    "harvard": "harvard-cite-them-right.csl",
    "ieee": "ieee.csl",
    "chicago": "chicago-author-date.csl",
    "mla": "modern-language-association.csl",
    "vancouver": "springer-vancouver.csl",
    "nature": "nature.csl",
    "acs": "american-chemical-society.csl",
    "ama": "american-medical-association.csl",
    "elsevier-harvard": "elsevier-harvard.csl",
    "elsevierharvard": "elsevier-harvard.csl",
    "springer-author-date": "springer-basic-author-date.csl",
    "springerauthordate": "springer-basic-author-date.csl",
}

NUMERIC_CSL_STYLES = {"ieee", "vancouver", "nature", "acs", "ama"}


def normalize_style(style: str) -> str:
    return (style or "apa7").lower().replace("_", "-").strip()


def has_csl_style(style: str) -> bool:
    key = normalize_style(style)
    filename = CSL_STYLE_MAP.get(key) or CSL_STYLE_MAP.get(key.replace("-", ""))
    return bool(filename and (CSL_DIR / filename).exists())


def style_path(style: str) -> Path:
    key = normalize_style(style)
    filename = CSL_STYLE_MAP.get(key) or CSL_STYLE_MAP.get(key.replace("-", ""))
    if not filename:
        raise ValueError(f"Unsupported CSL style: {style}")
    path = CSL_DIR / filename
    if not path.exists():
        raise FileNotFoundError(path)
    return path


def is_numeric_style(style: str) -> bool:
    key = normalize_style(style)
    return key in NUMERIC_CSL_STYLES


def _item_type(item_type: str) -> str:
    mapping = {
        "journalArticle": "article-journal",
        "magazineArticle": "article-magazine",
        "newspaperArticle": "article-newspaper",
        "book": "book",
        "bookSection": "chapter",
        "conferencePaper": "paper-conference",
        "thesis": "thesis",
        "report": "report",
        "webpage": "webpage",
        "preprint": "article",
    }
    return mapping.get(item_type or "", "article-journal")


def _names(creators_raw: Any, creator_type: str = "author") -> List[Dict[str, str]]:
    names = []
    for creator in parse_creators(creators_raw):
        ctype = creator.get("creatorType", creator.get("creator_type", "author"))
        if ctype != creator_type:
            continue
        family = creator.get("lastName") or creator.get("last_name") or creator.get("name") or ""
        given = creator.get("firstName") or creator.get("first_name") or ""
        if family or given:
            names.append({"family": family, "given": given})
    return names


def _date_parts(year: str) -> Optional[Dict[str, List[List[int]]]]:
    value = str(year or "")
    match = re.search(r"\b(1[5-9]\d{2}|20\d{2})\b", value)
    if not match:
        return None
    return {"date-parts": [[int(match.group(1))]]}


def to_csl_json(item: Dict[str, Any]) -> Dict[str, Any]:
    item_id = str(item.get("item_key") or item.get("id") or "")
    csl: Dict[str, Any] = {
        "id": item_id,
        "type": _item_type(item.get("item_type", "")),
        "title": item.get("title") or "Untitled",
    }

    authors = _names(item.get("creators", []), "author")
    editors = _names(item.get("creators", []), "editor")
    if authors:
        csl["author"] = authors
    if editors:
        csl["editor"] = editors

    issued = _date_parts(item.get("year", ""))
    if issued:
        csl["issued"] = issued

    field_map = {
        "publication_title": "container-title",
        "volume": "volume",
        "issue": "issue",
        "pages": "page",
        "publisher": "publisher",
        "place": "publisher-place",
        "edition": "edition",
        "isbn": "ISBN",
        "issn": "ISSN",
        "doi": "DOI",
        "url": "URL",
        "abstract": "abstract",
    }
    for local_key, csl_key in field_map.items():
        value = item.get(local_key)
        if value:
            csl[csl_key] = str(value)

    doi = csl.get("DOI", "")
    if doi.startswith("https://doi.org/"):
        csl["DOI"] = doi[len("https://doi.org/"):]
    elif doi.startswith("http://dx.doi.org/"):
        csl["DOI"] = doi[len("http://dx.doi.org/"):]

    return csl


def _clean_rendered(value: Any) -> str:
    text = str(value or "")
    text = re.sub(r"</?(?:i|b|em|strong)>", "", text)
    text = re.sub(r"<[^>]+>", "", text)
    text = html.unescape(text)
    text = re.sub(r"\s+([,.;:)])", r"\1", text)
    text = re.sub(r"(\()\s+", r"\1", text)
    text = re.sub(r",(?=\S)", ", ", text)
    text = re.sub(r";(?=\S)", "; ", text)
    text = re.sub(r"^(\(?\d+\)?\.?)(?=\S)", r"\1 ", text)
    text = re.sub(r"^(\[\d+\])(?=\S)", r"\1 ", text)
    text = re.sub(r"^(\d+)\s+\.", r"\1.", text)
    text = re.sub(r"([a-z])and\s+([A-Z])", r"\1 and \2", text)
    text = re.sub(r"(?<=[A-Za-z)])(?=\d{4}\b)", " ", text)
    text = re.sub(r"(?<!\s)&", " &", text)
    text = re.sub(r"&(?=\S)", "& ", text)
    text = re.sub(r"(?<=[a-z)])\.(?=[A-Z])", ". ", text)
    text = re.sub(r"\.(?=https?://)", ". ", text)
    text = re.sub(r"(?<=[a-zA-Z0-9)])(?=https?://)", " ", text)
    text = text.replace("::", ":")
    text = re.sub(r"\.\.(?=\s|$)", ".", text)
    text = re.sub(r"\s{2,}", " ", text)
    return text.strip()


def _citation_item(cite_item: Dict[str, Any]):
    from citeproc import CitationItem

    item_key = cite_item.get("item_key") or cite_item.get("item", {}).get("item_key")
    kwargs: Dict[str, Any] = {}
    if cite_item.get("locator"):
        kwargs["locator"] = str(cite_item.get("locator"))
        kwargs["label"] = cite_item.get("locator_type") or "page"
    if cite_item.get("prefix"):
        kwargs["prefix"] = cite_item.get("prefix")
    if cite_item.get("suffix"):
        kwargs["suffix"] = cite_item.get("suffix")
    return CitationItem(str(item_key), **kwargs)


def render_inline(items_with_meta: List[Dict[str, Any]], style: str) -> str:
    from citeproc import Citation, CitationStylesBibliography, CitationStylesStyle, formatter
    from citeproc.source.json import CiteProcJSON

    source_items = [to_csl_json(entry["item"]) for entry in items_with_meta]
    source = CiteProcJSON(source_items)
    csl_style = CitationStylesStyle(str(style_path(style)), validate=False)
    bibliography = CitationStylesBibliography(csl_style, source, formatter.html)
    citation = Citation([_citation_item({**entry, "item_key": entry["item"]["item_key"]}) for entry in items_with_meta])
    bibliography.register(citation)
    return _clean_rendered(bibliography.cite(citation, lambda _key: None))


def render_reference(item: Dict[str, Any], style: str) -> str:
    return render_bibliography([item], style)


def render_bibliography(items: List[Dict[str, Any]], style: str) -> str:
    from citeproc import Citation, CitationItem, CitationStylesBibliography, CitationStylesStyle, formatter
    from citeproc.source.json import CiteProcJSON

    source_items = [to_csl_json(item) for item in items if item.get("item_key")]
    if not source_items:
        return ""
    source = CiteProcJSON(source_items)
    csl_style = CitationStylesStyle(str(style_path(style)), validate=False)
    bibliography = CitationStylesBibliography(csl_style, source, formatter.html)
    for item in source_items:
        bibliography.register(Citation([CitationItem(str(item["id"]))]))
    return "\n".join(_clean_rendered(entry) for entry in bibliography.bibliography())
