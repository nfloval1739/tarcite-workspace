"""Recover the packaged-app vector index, fast.

Strategy:
1. IMPORT verbatim any chunk whose exact text was already embedded in the dev
   store (same text -> identical bge vector, regardless of path/item_key).
2. RE-EMBED only the chunks that aren't available in dev, in saturated batches.

No PDF is ever opened, so the MuPDF crash cannot trigger. chromadb versions
match (1.5.9), so reading the dev index is format-safe.
"""
import os
import sys
import time

INSTALL = os.path.expanduser("~/Library/Application Support/CitationWorkspace/data")
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEV = os.path.join(REPO, "data")

os.environ["CITATION_DATA_DIR"] = INSTALL
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("CHROMA_ANONYMIZED_TELEMETRY", "False")

import sqlite3
import chromadb
from chromadb.config import Settings

from app.embeddings import (
    ensure_embedding_model_ready,
    create_embeddings_batch,
    get_chroma_client,
    get_or_create_collection,
    get_loaded_embedding_model_name,
    save_embedding_meta,
    EMBED_BATCH_SIZE,
)
from app.database import get_items_batch


def log(msg):
    print(f"[recover] {msg}", flush=True)


def load_dev_text_to_vec():
    """Map exact chunk text -> embedding from the dev Chroma store."""
    path = os.path.join(DEV, "chroma")
    if not os.path.exists(path):
        log("no dev chroma store found — will re-embed everything")
        return {}
    cl = chromadb.PersistentClient(path=path, settings=Settings(anonymized_telemetry=False))
    col = cl.get_or_create_collection("local_library", metadata={"hnsw:space": "cosine"})
    total = col.count()
    text2vec = {}
    off = 0
    while off < total:
        b = col.get(include=["documents", "embeddings"], limit=5000, offset=off)
        docs = b.get("documents")
        embs = b.get("embeddings")
        if docs is None or embs is None:
            off += 5000
            continue
        for d, e in zip(docs, embs):
            if d and e is not None and d not in text2vec:
                text2vec[d] = list(e)
        off += 5000
    log(f"dev store provides {len(text2vec)} reusable chunk embeddings")
    return text2vec


def main():
    log(f"install: {INSTALL}")
    ensure_embedding_model_ready()
    text2vec = load_dev_text_to_vec()

    di = sqlite3.connect(os.path.join(INSTALL, "local_citation.sqlite"))
    di.row_factory = sqlite3.Row
    items = set(r[0] for r in di.execute("SELECT item_key FROM items"))
    fts = set(r[0] for r in di.execute("SELECT DISTINCT item_key FROM chunks_fts"))

    collection = get_or_create_collection(get_chroma_client())
    embedded = set()
    n = collection.count(); off = 0
    while off < n:
        b = collection.get(include=["metadatas"], limit=5000, offset=off)
        for m in b.get("metadatas", []):
            if m and m.get("item_key"):
                embedded.add(m["item_key"])
        off += 5000

    missing = list((items & fts) - embedded)
    log(f"items: {len(items)} | already embedded: {len(embedded)} | to recover: {len(missing)}")
    if not missing:
        log("nothing to do")
        return

    meta_map = get_items_batch(missing)

    # Pass 1: gather chunks per item; collect texts that must be re-embedded.
    per_item = {}          # item_key -> list[(text, source_type)]
    to_embed_texts = []    # unique texts needing embedding
    seen_to_embed = set()
    imported_chunks = 0
    for k in missing:
        rows = di.execute(
            "SELECT chunk_text, source_type FROM chunks_fts WHERE item_key=?", (k,)
        ).fetchall()
        chunks = [(r["chunk_text"], r["source_type"]) for r in rows if r["chunk_text"]]
        if not chunks:
            continue
        per_item[k] = chunks
        for text, _ in chunks:
            if text in text2vec:
                imported_chunks += 1
            elif text not in seen_to_embed:
                seen_to_embed.add(text)
                to_embed_texts.append(text)
    log(f"reusing {imported_chunks} chunks from dev; re-embedding {len(to_embed_texts)} new chunks")

    # Pass 2: embed the new texts in saturated batches.
    t0 = time.time()
    for i in range(0, len(to_embed_texts), EMBED_BATCH_SIZE):
        batch = to_embed_texts[i:i + EMBED_BATCH_SIZE]
        vecs = create_embeddings_batch(batch)
        for text, vec in zip(batch, vecs):
            text2vec[text] = vec
        done = min(i + EMBED_BATCH_SIZE, len(to_embed_texts))
        if i // EMBED_BATCH_SIZE % 10 == 0 or done == len(to_embed_texts):
            rate = done / max(0.1, time.time() - t0)
            log(f"embedded {done}/{len(to_embed_texts)} new chunks ({rate:.0f}/s)")

    # Pass 3: upsert all chunks per item with correct ids + metadata.
    added_items = 0
    for k, chunks in per_item.items():
        meta = meta_map.get(k, {})
        ids, embs, docs, metas = [], [], [], []
        for idx, (text, source_type) in enumerate(chunks):
            vec = text2vec.get(text)
            if vec is None:
                continue
            ids.append(f"{k}__{source_type}__{idx}")
            embs.append(vec)
            docs.append(text)
            metas.append({
                "item_key": k,
                "title": (meta.get("title") or "")[:500],
                "year": meta.get("year") or "",
                "creators": (meta.get("creators") or "")[:500],
                "publication_title": (meta.get("publication_title") or "")[:300],
                "collection_keys": meta.get("collection_keys") or "",
                "source_dir": meta.get("source_dir") or "",
                "source_type": source_type,
                "chunk_index": idx,
                "page_number": 0,
            })
        if ids:
            collection.upsert(ids=ids, embeddings=embs, documents=docs, metadatas=metas)
            added_items += 1
        if added_items % 50 == 0:
            log(f"wrote {added_items}/{len(per_item)} items")

    save_embedding_meta(get_loaded_embedding_model_name())
    log(f"DONE: recovered {added_items} items "
        f"({imported_chunks} chunks imported from dev, {len(to_embed_texts)} re-embedded)")


if __name__ == "__main__":
    main()
