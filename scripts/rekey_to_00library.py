"""
Re-key dev vectors from ~/Zotero/storage/ paths → /Volumes/NaufalLeeds/00_LIBRARY/ paths.

What it does:
  1. Finds each PDF in 00_LIBRARY and matches it to a dev SQLite item by filename.
  2. For matched items: transfers all ChromaDB chunks to the new item_key (no re-embedding).
  3. Updates SQLite file_path + item_key to the 00_LIBRARY path.
  4. Reports the small number of files that couldn't be matched (need fresh embedding after sync).

Run from the citation-workspace root:
    python scripts/rekey_to_00library.py

Output: modifies data/local_citation.sqlite and data/chroma IN PLACE.
        A backup is created first at data/local_citation.sqlite.bak
"""

import hashlib
import shutil
import sqlite3
import sys
from pathlib import Path
from typing import Dict, Optional

import chromadb
from chromadb.config import Settings

# ── Paths ──────────────────────────────────────────────────────────────────────
WORKSPACE = Path(__file__).parent.parent
DATA_DIR = WORKSPACE / "data"
SQLITE_PATH = DATA_DIR / "local_citation.sqlite"
CHROMA_PATH = DATA_DIR / "chroma"
LIBRARY_ROOT = Path("/Volumes/NaufalLeeds/00_LIBRARY")
COLLECTION_NAME = "local_library"


def item_key_for(path: str) -> str:
    return hashlib.md5(path.encode()).hexdigest()[:12]


def backup_sqlite():
    bak = SQLITE_PATH.with_suffix(".sqlite.bak")
    shutil.copy2(SQLITE_PATH, bak)
    print(f"  Backup: {bak}")


def build_filename_index(conn: sqlite3.Connection) -> Dict[str, dict]:
    """Return {filename_lower: row} for all Zotero/storage items in SQLite."""
    rows = conn.execute(
        "SELECT item_key, file_path, source_dir FROM items "
        "WHERE file_path LIKE '%Zotero/storage%' AND file_path LIKE '%.pdf'"
    ).fetchall()
    index: Dict[str, dict] = {}
    for row in rows:
        fname = Path(row[1]).name.lower()
        # Keep first match (duplicates in Zotero storage are rare)
        if fname not in index:
            index[fname] = {"item_key": row[0], "file_path": row[1], "source_dir": row[2]}
    return index


def migrate_chroma_chunks(collection, old_key: str, new_key: str, new_file_path: str) -> int:
    """Copy all chunks from old_key to new_key with updated metadata, then delete old."""
    results = collection.get(where={"item_key": old_key}, include=["embeddings", "documents", "metadatas"])
    if not results["ids"]:
        return 0

    new_ids = []
    new_embeddings = []
    new_documents = []
    new_metadatas = []

    for i, old_id in enumerate(results["ids"]):
        # Replace old_key with new_key in the chunk ID
        new_id = old_id.replace(old_key, new_key, 1)
        meta = dict(results["metadatas"][i])
        meta["item_key"] = new_key
        meta["file_path"] = new_file_path
        meta["source_dir"] = str(Path(new_file_path).parent)

        new_ids.append(new_id)
        new_embeddings.append(results["embeddings"][i])
        new_documents.append(results["documents"][i])
        new_metadatas.append(meta)

    collection.upsert(
        ids=new_ids,
        embeddings=new_embeddings,
        documents=new_documents,
        metadatas=new_metadatas,
    )
    collection.delete(where={"item_key": old_key})
    return len(new_ids)


def main():
    print("=== Re-key dev vectors: Zotero/storage → 00_LIBRARY ===\n")

    if not LIBRARY_ROOT.exists():
        print(f"ERROR: {LIBRARY_ROOT} not found. Is the drive mounted?")
        sys.exit(1)

    print("Step 1 — Backing up SQLite…")
    backup_sqlite()

    print("Step 2 — Scanning 00_LIBRARY for PDFs…")
    lib_pdfs = sorted(LIBRARY_ROOT.rglob("*.pdf"))
    print(f"  Found {len(lib_pdfs)} PDFs in 00_LIBRARY")

    print("Step 3 — Loading dev SQLite filename index…")
    conn = sqlite3.connect(str(SQLITE_PATH))
    conn.row_factory = sqlite3.Row
    filename_index = build_filename_index(conn)
    print(f"  Indexed {len(filename_index)} Zotero/storage items from dev SQLite")

    print("Step 4 — Opening ChromaDB…")
    client = chromadb.PersistentClient(
        path=str(CHROMA_PATH),
        settings=Settings(anonymized_telemetry=False),
    )
    collection = client.get_or_create_collection(COLLECTION_NAME)
    print(f"  ChromaDB collection has {collection.count()} chunks")

    print("\nStep 5 — Re-keying matched items…")
    matched = 0
    skipped_no_match = []
    skipped_already_done = []
    total_chunks_moved = 0

    for lib_path in lib_pdfs:
        fname_lower = lib_path.name.lower()
        new_path = str(lib_path)
        new_key = item_key_for(new_path)

        # Already re-keyed in a previous run?
        existing = conn.execute(
            "SELECT item_key FROM items WHERE item_key = ?", (new_key,)
        ).fetchone()
        if existing:
            skipped_already_done.append(lib_path.name)
            continue

        dev_item = filename_index.get(fname_lower)
        if not dev_item:
            skipped_no_match.append(lib_path.name)
            continue

        old_key = dev_item["item_key"]
        old_path = dev_item["file_path"]

        # Migrate chroma chunks
        chunks_moved = migrate_chroma_chunks(collection, old_key, new_key, new_path)

        # Update SQLite
        conn.execute(
            "UPDATE items SET item_key = ?, file_path = ?, source_dir = ? WHERE item_key = ?",
            (new_key, new_path, str(lib_path.parent), old_key),
        )
        conn.commit()

        matched += 1
        total_chunks_moved += chunks_moved
        if matched % 50 == 0:
            print(f"  … {matched} items re-keyed")

    conn.close()

    print(f"\n=== Done ===")
    print(f"  Re-keyed:          {matched} items ({total_chunks_moved} chunks moved, no re-embedding)")
    print(f"  Already done:      {len(skipped_already_done)} items (previous run)")
    print(f"  No match (new):    {len(skipped_no_match)} items → will be embedded on next sync")
    if skipped_no_match:
        print("  New files needing embedding:")
        for f in skipped_no_match:
            print(f"    - {f}")

    print("\nNext steps:")
    print("  1. Copy data/ to ~/Library/Application Support/CitationWorkspace/data/")
    print("  2. In TarCite installed app: Settings → add /Volumes/NaufalLeeds/00_LIBRARY as Library Folder")
    print("  3. Run Sync — only the new files above will be embedded")


if __name__ == "__main__":
    main()
