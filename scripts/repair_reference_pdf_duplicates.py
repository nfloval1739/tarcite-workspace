#!/usr/bin/env python3
"""Merge bibliography-only duplicate items into matching PDF items for one source dir."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.database import merge_duplicate_item_into, save_fulltext, upsert_item
from app.local_scanner import scan_directory


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source_dir", help="Library/source directory to scan and repair")
    args = parser.parse_args()

    items, _ = scan_directory(args.source_dir)
    matched_items = 0
    repaired = []

    for item in items:
        duplicate_keys = item.pop("_merged_reference_item_keys", [])
        if not duplicate_keys:
            continue

        matched_items += 1
        full_text = item.get("full_text", "")
        item["source_dir"] = args.source_dir
        upsert_item(item)
        if full_text:
            save_fulltext(item["item_key"], full_text, total_pages=0)

        for duplicate_key in duplicate_keys:
            if merge_duplicate_item_into(duplicate_key, item["item_key"]):
                repaired.append((duplicate_key, item["item_key"], item.get("title", "")))

    print({"matched_items": matched_items, "repaired_duplicates": len(repaired)})
    for duplicate_key, item_key, title in repaired[:50]:
        print(f"{duplicate_key} -> {item_key} | {title}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
