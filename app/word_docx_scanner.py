"""
DOCX fallback scanner for Word connector.

Processes .docx files containing temporary citation markers like {cite:item_key}
and replaces them with formatted citations plus a bibliography.

This provides a usable workflow before the full Word add-in is mature.
"""

import logging
import re
import uuid
import zipfile
from io import BytesIO
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

CITE_PATTERN = re.compile(r"\{cite:([^\}]+)\}")


def scan_docx_for_markers(docx_path: str) -> List[Dict[str, str]]:
    markers = []
    try:
        with zipfile.ZipFile(docx_path, "r") as zf:
            if "word/document.xml" not in zf.namelist():
                return markers
            xml_content = zf.read("word/document.xml").decode("utf-8")
            for match in CITE_PATTERN.finditer(xml_content):
                item_key = match.group(1).strip()
                markers.append({
                    "item_key": item_key,
                    "raw_marker": match.group(0),
                })
    except Exception as exc:
        logger.error("Error scanning DOCX for markers: %s", exc)
    return markers


def _resolve_markers(
    markers: List[Dict[str, str]],
    item_lookup: Dict[str, Dict],
    style: str = "apa7",
) -> Tuple[List[Dict], List[str]]:
    from app.word_csl_formatter import format_inline_citation, format_reference

    resolved = []
    warnings = []
    seen_keys = {}

    for marker in markers:
        item_key = marker["item_key"]
        item = item_lookup.get(item_key)
        if not item:
            warnings.append(f"Item key '{item_key}' not found in local library.")
            resolved.append({
                "item_key": item_key,
                "raw_marker": marker["raw_marker"],
                "formatted": f"[MISSING: {item_key}]",
                "reference": None,
            })
            continue

        if item_key in seen_keys:
            index = seen_keys[item_key]
        else:
            index = len(seen_keys) + 1
            seen_keys[item_key] = index

        inline = format_inline_citation(
            item, style=style,
            ieee_index=index,
            vancouver_index=index,
        )
        ref = format_reference(item, style=style)

        resolved.append({
            "item_key": item_key,
            "raw_marker": marker["raw_marker"],
            "formatted": inline,
            "reference": ref,
            "index": index,
        })

    return resolved, warnings


def _build_bibliography(resolved: List[Dict], style: str = "apa7") -> str:
    from app.word_csl_formatter import format_bibliography

    seen = set()
    items = []
    for r in resolved:
        if r["item_key"] not in seen and r.get("reference"):
            seen.add(r["item_key"])
            items.append({"_ref": r["reference"]})

    if not items:
        return ""

    if style in ("ieee", "vancouver"):
        lines = []
        for r in resolved:
            if r.get("reference") and r["item_key"] not in {x["item_key"] for x in items if x.get("item_key") == r["item_key"]}:
                pass
        for i, r in enumerate(resolved):
            if r.get("reference"):
                if r["item_key"] in seen:
                    lines.append(f"[{r.get('index', i+1)}] {r['reference']}")
                    seen.discard(r["item_key"])
        return "\n".join(lines)

    unique_items = []
    seen2 = set()
    for r in resolved:
        if r["item_key"] not in seen2 and r.get("reference"):
            seen2.add(r["item_key"])
            unique_items.append(r["reference"])

    if style in ("apa7", "harvard", "chicago", "mla"):
        unique_items.sort(key=lambda x: x.lower())

    return "\n".join(unique_items)


def process_docx(
    docx_path: str,
    output_path: str,
    item_lookup: Dict[str, Dict],
    style: str = "apa7",
) -> Dict[str, Any]:
    markers = scan_docx_for_markers(docx_path)
    if not markers:
        return {
            "status": "no_markers",
            "message": "No citation markers found in document.",
            "markers_found": 0,
        }

    resolved, warnings = _resolve_markers(markers, item_lookup, style)
    bibliography = _build_bibliography(resolved, style)

    try:
        with zipfile.ZipFile(docx_path, "r") as zf:
            xml_content = zf.read("word/document.xml").decode("utf-8")

        for r in resolved:
            xml_content = xml_content.replace(r["raw_marker"], r["formatted"])

        if bibliography:
            bib_heading = '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>References</w:t></w:r></w:p>'
            bib_lines = bibliography.split("\n")
            bib_entries = []
            for line in bib_lines:
                escaped = line.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                bib_entries.append(f'<w:p><w:r><w:t xml:space="preserve">{escaped}</w:t></w:r></w:p>')
            xml_content = xml_content.replace("</w:body>", bib_heading + "".join(bib_entries) + "</w:body>")

        with zipfile.ZipFile(docx_path, "r") as zf:
            with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as out_zf:
                for item in zf.infolist():
                    if item.filename == "word/document.xml":
                        out_zf.writestr(item, xml_content.encode("utf-8"))
                    else:
                        out_zf.writestr(item, zf.read(item.filename))

        return {
            "status": "success",
            "message": f"Processed {len(markers)} citation marker(s).",
            "markers_found": len(markers),
            "resolved": len([r for r in resolved if r.get("reference")]),
            "warnings": warnings,
            "output_path": output_path,
        }
    except Exception as exc:
        logger.error("Error processing DOCX: %s", exc)
        return {
            "status": "error",
            "message": f"Error processing document: {exc}",
            "markers_found": len(markers),
        }


def get_item_lookup(source_dirs: Optional[List[str]] = None) -> Dict[str, Dict]:
    from app.database import get_all_items
    from app.citation_formatter import parse_creators

    items = get_all_items()
    lookup = {}
    for item in items:
        if source_dirs:
            item_dir = item.get("source_dir", "")
            if item_dir not in source_dirs:
                continue
        item["creators_list"] = parse_creators(item.get("creators", []))
        lookup[item["item_key"]] = item
    return lookup
