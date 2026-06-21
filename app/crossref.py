"""
Crossref metadata lookup.

Used as an authoritative metadata source when a scanned PDF contains a DOI.
The caller should treat failures as non-fatal and keep local PDF extraction as
the fallback path.
"""

import html
import json
import logging
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

CROSSREF_BASE_URL = "https://api.crossref.org/works"
DEFAULT_CROSSREF_TIMEOUT_SECONDS = 8.0


def normalize_doi(raw: str) -> str:
    """Return a clean DOI without URL prefixes or surrounding punctuation."""
    doi = (raw or "").strip()
    if not doi:
        return ""
    doi = re.sub(r"(?i)^https?://(?:dx\.)?doi\.org/", "", doi)
    doi = re.sub(r"(?i)^doi:\s*", "", doi)
    doi = doi.strip().strip(".,;:()[]{}<>")
    return doi


def fetch_crossref_metadata(doi: str) -> Optional[Dict[str, Any]]:
    doi = normalize_doi(doi)
    if not doi:
        return None

    query = {}
    mailto = _mailto()
    if mailto:
        query["mailto"] = mailto

    url = f"{CROSSREF_BASE_URL}/{urllib.parse.quote(doi, safe='')}"
    if query:
        url += "?" + urllib.parse.urlencode(query)

    headers = {
        "Accept": "application/json",
        "User-Agent": _user_agent(mailto),
    }
    request = urllib.request.Request(url, headers=headers)

    try:
        with urllib.request.urlopen(request, timeout=_timeout_seconds()) as response:
            if response.status != 200:
                logger.info("Crossref lookup for DOI %s returned HTTP %s", doi, response.status)
                return None
            payload = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as exc:
        logger.info("Crossref lookup failed for DOI %s: %s", doi, exc)
        return None

    message = payload.get("message", {})
    if not isinstance(message, dict):
        return None

    metadata = _message_to_item_metadata(message)
    metadata["doi"] = normalize_doi(metadata.get("doi", doi)) or doi
    return metadata


def fetch_crossref_references(doi: str) -> Optional[List[Dict[str, Any]]]:
    """Return Crossref deposited references for a DOI, if available."""
    message = fetch_crossref_work_message(doi)
    if not message:
        return None
    references = message.get("reference", [])
    return references if isinstance(references, list) else []


def fetch_crossref_work_message(doi: str) -> Optional[Dict[str, Any]]:
    doi = normalize_doi(doi)
    if not doi:
        return None

    query = {}
    mailto = _mailto()
    if mailto:
        query["mailto"] = mailto

    url = f"{CROSSREF_BASE_URL}/{urllib.parse.quote(doi, safe='')}"
    if query:
        url += "?" + urllib.parse.urlencode(query)

    headers = {
        "Accept": "application/json",
        "User-Agent": _user_agent(mailto),
    }
    request = urllib.request.Request(url, headers=headers)

    try:
        with urllib.request.urlopen(request, timeout=_timeout_seconds()) as response:
            if response.status != 200:
                logger.info("Crossref lookup for DOI %s returned HTTP %s", doi, response.status)
                return None
            payload = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as exc:
        logger.info("Crossref lookup failed for DOI %s: %s", doi, exc)
        return None

    message = payload.get("message", {})
    return message if isinstance(message, dict) else None


def merge_crossref_metadata(item: Dict[str, Any], crossref: Dict[str, Any]) -> Dict[str, Any]:
    """
    Merge Crossref fields into an item.

    Crossref wins for bibliographic fields when it has a value. Local PDF
    extraction still supplies file_path, full_text, collection data, and any
    fields Crossref did not provide.
    """
    merged = dict(item)
    for key, value in crossref.items():
        if value in ("", None, [], {}):
            continue
        if key == "creators":
            if isinstance(value, list):
                merged[key] = json.dumps(value)
            elif isinstance(value, str):
                merged[key] = value
            continue
        merged[key] = value
    return merged


def _user_agent(mailto: str) -> str:
    base = "TarCiteWorkspace/2.0"
    return f"{base} (mailto:{mailto})" if mailto else base


def _mailto() -> str:
    try:
        from app.config import config
        return (config.crossref_mailto or "").strip()
    except Exception:
        return os.getenv("CROSSREF_MAILTO", "").strip()


def _timeout_seconds() -> float:
    try:
        from app.config import config
        return max(1.0, float(config.crossref_timeout_seconds))
    except Exception:
        pass
    try:
        return max(1.0, float(os.getenv("CROSSREF_TIMEOUT_SECONDS", DEFAULT_CROSSREF_TIMEOUT_SECONDS)))
    except (TypeError, ValueError):
        return DEFAULT_CROSSREF_TIMEOUT_SECONDS


def _message_to_item_metadata(message: Dict[str, Any]) -> Dict[str, Any]:
    title = _clean_text(_first(message.get("title")))
    container = _clean_text(_first(message.get("container-title")))
    abstract = _clean_abstract(message.get("abstract", ""))

    return {
        "title": title,
        "creators": _authors(message.get("author", [])),
        "year": _year(message),
        "item_type": _map_crossref_type(message.get("type", "")),
        "publication_title": container,
        "doi": normalize_doi(message.get("DOI", "")),
        "url": message.get("URL", "") or _resource_url(message),
        "abstract": abstract,
        "volume": _clean_text(message.get("volume", "")),
        "issue": _clean_text(message.get("issue", "")),
        "pages": _clean_text(message.get("page", "")),
        "publisher": _clean_text(message.get("publisher", "")),
        "edition": "",
        "isbn": _join_ids(message.get("ISBN", [])),
        "issn": _join_ids(message.get("ISSN", [])),
        "citation_count": _int_or_zero(message.get("is-referenced-by-count")),
        "citation_count_updated_at": datetime.now(timezone.utc).isoformat(),
    }


def _first(value: Any) -> str:
    if isinstance(value, list):
        return str(value[0]) if value else ""
    return str(value or "")


def _clean_text(value: Any) -> str:
    text = html.unescape(str(value or ""))
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _clean_abstract(value: Any) -> str:
    text = _clean_text(value)
    return text[:2000] if text else ""


def _authors(authors_raw: Any) -> List[Dict[str, str]]:
    if not isinstance(authors_raw, list):
        return []

    creators: List[Dict[str, str]] = []
    for author in authors_raw:
        if not isinstance(author, dict):
            continue
        family = _clean_text(author.get("family", ""))
        given = _clean_text(author.get("given", ""))
        name = _clean_text(author.get("name", ""))
        if family or given:
            creators.append({
                "creatorType": "author",
                "lastName": family,
                "firstName": given,
                "name": "",
            })
        elif name:
            creators.append({
                "creatorType": "author",
                "lastName": "",
                "firstName": "",
                "name": name,
            })
    return creators


def _year(message: Dict[str, Any]) -> str:
    for key in ("published-print", "published-online", "published", "issued", "created"):
        year = _year_from_date_parts(message.get(key))
        if year:
            return year
    return ""


def _year_from_date_parts(value: Any) -> str:
    if not isinstance(value, dict):
        return ""
    parts = value.get("date-parts", [])
    if not parts or not isinstance(parts, list) or not isinstance(parts[0], list):
        return ""
    if not parts[0]:
        return ""
    year = parts[0][0]
    return str(year) if isinstance(year, int) else ""


def _map_crossref_type(crossref_type: str) -> str:
    mapping = {
        "journal-article": "journalArticle",
        "proceedings-article": "conferencePaper",
        "book": "book",
        "monograph": "book",
        "book-chapter": "bookSection",
        "book-section": "bookSection",
        "posted-content": "preprint",
        "report": "report",
        "dissertation": "thesis",
        "webpage": "webpage",
    }
    return mapping.get(crossref_type, "journalArticle")


def _join_ids(value: Any) -> str:
    if isinstance(value, list):
        return ", ".join(str(v) for v in value if v)
    return str(value or "")


def _int_or_zero(value: Any) -> int:
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return 0


def _resource_url(message: Dict[str, Any]) -> str:
    resource = message.get("resource")
    if isinstance(resource, dict):
        primary = resource.get("primary")
        if isinstance(primary, dict):
            return primary.get("URL", "") or ""
    return ""
