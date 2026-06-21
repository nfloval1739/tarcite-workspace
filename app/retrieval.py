"""
Hybrid retrieval pipeline:

  Stage 1 — Coarse retrieval (parallel)
    A. Vector search  : ChromaDB cosine similarity
    B. BM25 keyword   : SQLite FTS5 full-text search
    C. Title search   : SQLite LIKE on item titles (weighted 2x in RRF)

  Stage 2 — Merge
    Reciprocal Rank Fusion (RRF) of all ranked lists

  Stage 3 — Group by paper
    Chunks → grouped by item_key → best 6 chunks per paper → SQLite metadata

  Stage 4 — Cross-encoder rerank

  Stage 5 — MMR diversity selection

  Stage 6 — Return top_k candidates for LLM
"""

import json
import logging
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, List, Optional

from app.database import get_item, get_items_batch, search_fts, search_titles, get_fts_chunk_count
from app.embeddings import get_chroma_client, get_or_create_collection, query_collection
from app.reranker import rerank, DEFAULT_RERANKER

logger = logging.getLogger(__name__)

DISTANCE_THRESHOLD = 0.85
MAX_CHUNKS_PER_SOURCE = 6
RRF_K = 60
TITLE_RRF_WEIGHT = 2.0


def _fetch_size(top_k: int) -> int:
    return max(60, top_k * MAX_CHUNKS_PER_SOURCE + 30)


def _rrf_score(ranked_lists: List[List[str]], weights: Optional[List[float]] = None) -> Dict[str, float]:
    scores: Dict[str, float] = {}
    for idx, ranked in enumerate(ranked_lists):
        w = (weights[idx] if weights else 1.0)
        for rank, item_id in enumerate(ranked):
            scores[item_id] = scores.get(item_id, 0.0) + w / (RRF_K + rank + 1)
    return scores


def _run_vector_search(collection, paragraph, fetch_size, collection_key, source_dir=None):
    if collection.count() == 0:
        logger.warning("ChromaDB is empty — please scan your references directory first.")
        return [], []
    raw = query_collection(
        collection=collection,
        query_text=paragraph,
        n_results=fetch_size,
        collection_key=collection_key,
        source_dir=source_dir,
    )
    ids = raw.get("ids", [[]])[0]
    documents = raw.get("documents", [[]])[0]
    metadatas = raw.get("metadatas", [[]])[0]
    distances = raw.get("distances", [[]])[0]

    chunks = []
    rank_order = []
    for cid, doc, meta, dist in zip(ids, documents, metadatas, distances):
        if dist > DISTANCE_THRESHOLD:
            continue
        chunks.append({
            "chunk_id": cid,
            "chunk_text": doc,
            "metadata": meta,
            "distance": dist,
            "similarity": round(1.0 - dist, 4),
            "item_key": meta.get("item_key", ""),
        })
        rank_order.append(cid)
    return chunks, rank_order


_BM25_STOPWORDS = {
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with",
    "by", "from", "as", "is", "was", "are", "were", "be", "been", "have", "has", "had",
    "do", "does", "did", "will", "would", "could", "should", "may", "might", "this",
    "that", "these", "those", "it", "its", "they", "their", "there", "then", "than",
    "when", "where", "which", "who", "what", "how", "not", "also", "based", "using",
    "used", "well", "widely", "widely", "pure", "rests", "basis", "approach", "study",
}


def _extract_bm25_terms(paragraph: str) -> str:
    """Extract meaningful search terms from a paragraph for FTS5 BM25 query.

    Keeps short acronyms (2-3 chars like SPI, WMO) that the generic regex drops,
    while stripping common prose words that produce irrelevant matches.
    """
    import re
    # Keep: acronyms (2+ uppercase), regular words (3+ chars)
    acronyms = re.findall(r'\b[A-Z]{2,}\b', paragraph)
    words = re.findall(r'\b[a-zA-Z]{3,}\b', paragraph)
    terms = []
    seen: set = set()
    for w in acronyms + words:
        low = w.lower()
        if low not in _BM25_STOPWORDS and low not in seen:
            seen.add(low)
            terms.append(low)
        if len(terms) >= 20:
            break
    return " OR ".join(terms) if terms else paragraph


def _run_bm25_search(paragraph, fetch_size):
    fts_populated = get_fts_chunk_count() > 0
    if not fts_populated:
        logger.info("FTS5 index empty — running vector-only retrieval")
        return [], []
    fts_query = _extract_bm25_terms(paragraph)
    fts_results = search_fts(fts_query, limit=fetch_size)
    chunks = []
    rank_order = []
    for row in fts_results:
        cid = row.get("chunk_id", "")
        chunks.append({
            "chunk_id": cid,
            "chunk_text": row["chunk_text"],
            "metadata": {"source_type": row.get("source_type", "abstract")},
            "distance": 0.5,
            "similarity": 0.5,
            "item_key": row.get("item_key", ""),
            "bm25_rank": row.get("rank", 0),
        })
        rank_order.append(cid)
    return chunks, rank_order


def _run_title_search(paragraph):
    title_keys = search_titles(paragraph, limit=50)
    return title_keys


def _mmr_select(
    candidates: List[Dict[str, Any]],
    top_n: int,
    lambda_param: float = 0.7,
) -> List[Dict[str, Any]]:
    if not candidates:
        return candidates

    from app.embeddings import create_embeddings_batch
    import numpy as np

    texts = []
    for c in candidates:
        evidence = (c.get("best_evidence") or c.get("abstract") or c.get("title") or "")[:500]
        texts.append(evidence)

    try:
        embeddings = create_embeddings_batch(texts)
        emb_matrix = np.array(embeddings)
        norms = np.linalg.norm(emb_matrix, axis=1, keepdims=True)
        norms = np.where(norms == 0, 1, norms)
        emb_matrix = emb_matrix / norms
    except Exception as exc:
        logger.warning("MMR embedding failed, returning reranked order: %s", exc)
        return candidates[:top_n]

    rerank_scores = np.array([c.get("rerank_score", c.get("best_rrf_score", 0.0)) for c in candidates])
    if rerank_scores.max() > rerank_scores.min():
        norm_scores = (rerank_scores - rerank_scores.min()) / (rerank_scores.max() - rerank_scores.min())
    else:
        norm_scores = np.ones(len(candidates))

    selected_indices: List[int] = []
    remaining = set(range(len(candidates)))

    for _ in range(min(top_n, len(candidates))):
        best_idx = -1
        best_score = float("-inf")

        for idx in remaining:
            relevance = norm_scores[idx]

            if selected_indices:
                sims = emb_matrix[idx] @ emb_matrix[selected_indices].T
                diversity_penalty = float(np.max(sims))
            else:
                diversity_penalty = 0.0

            mmr_score = lambda_param * relevance - (1 - lambda_param) * diversity_penalty

            if mmr_score > best_score:
                best_score = mmr_score
                best_idx = idx

        if best_idx == -1:
            break
        selected_indices.append(best_idx)
        remaining.discard(best_idx)

    return [candidates[i] for i in selected_indices]


def search_and_retrieve(
    paragraph: str,
    top_k: int = 50,
    collection_key: Optional[str] = None,
    source_dir: Optional[str] = None,
    reranker_model: str = DEFAULT_RERANKER,
    use_hyde: bool = False,
    use_mmr: bool = True,
    mmr_lambda: float = 0.7,
) -> List[Dict[str, Any]]:
    from app.config import config

    chroma_client = get_chroma_client()
    collection = get_or_create_collection(chroma_client)

    fetch_size = _fetch_size(top_k)

    with ThreadPoolExecutor(max_workers=3) as pool:
        bm25_future = pool.submit(
            _run_bm25_search, paragraph, fetch_size,
        )
        title_future = pool.submit(
            _run_title_search, paragraph,
        )

        vector_query = paragraph
        if use_hyde:
            try:
                from app.ai_client import generate_hypothetical_passage
                vector_query = generate_hypothetical_passage(paragraph) or paragraph
                logger.info("HyDE: using hypothetical passage for vector search")
            except Exception as exc:
                logger.warning("HyDE generation failed, falling back to raw paragraph: %s", exc)

        vector_future = pool.submit(
            _run_vector_search, collection, vector_query, fetch_size, collection_key, source_dir,
        )
        vector_chunks, vector_rank_order = vector_future.result()
        bm25_chunks, bm25_rank_order = bm25_future.result()
        title_keys = title_future.result()

    title_rank_order = [f"title__{k}" for k in title_keys]

    ranked_lists = []
    rrf_weights = []
    if vector_rank_order:
        ranked_lists.append(vector_rank_order)
        rrf_weights.append(1.0)
    if bm25_rank_order:
        ranked_lists.append(bm25_rank_order)
        rrf_weights.append(1.0)
    if title_rank_order:
        ranked_lists.append(title_rank_order)
        rrf_weights.append(TITLE_RRF_WEIGHT)

    if not ranked_lists:
        return []

    rrf_scores = _rrf_score(ranked_lists, weights=rrf_weights)

    chunk_lookup: Dict[str, Dict] = {}
    for c in vector_chunks:
        chunk_lookup[c["chunk_id"]] = c
    for c in bm25_chunks:
        if c["chunk_id"] not in chunk_lookup:
            chunk_lookup[c["chunk_id"]] = c

    title_boost_items: Dict[str, float] = {}
    for rank, item_key in enumerate(title_keys):
        title_boost_items[item_key] = 1.0 / (RRF_K + rank + 1) * TITLE_RRF_WEIGHT

    sorted_chunk_ids = sorted(rrf_scores.keys(), key=lambda x: rrf_scores[x], reverse=True)

    paper_chunks: Dict[str, List[Dict]] = {}

    for cid in sorted_chunk_ids:
        chunk = chunk_lookup.get(cid)
        if not chunk:
            continue
        item_key = chunk.get("item_key", "")
        if not item_key:
            continue
        paper_chunks.setdefault(item_key, []).append({
            **chunk,
            "rrf_score": rrf_scores.get(cid, 0.0),
        })

    for item_key, boost_score in title_boost_items.items():
        if item_key not in paper_chunks:
            paper_chunks[item_key] = [{
                "chunk_id": f"title__{item_key}",
                "chunk_text": "",
                "metadata": {"source_type": "title_match"},
                "distance": 0.3,
                "similarity": 0.7,
                "item_key": item_key,
                "rrf_score": boost_score,
                "title_boost": True,
            }]

    candidates: List[Dict[str, Any]] = []

    unique_keys = list(paper_chunks.keys())
    items_batch = get_items_batch(unique_keys)

    for item_key, chunks in paper_chunks.items():
        chunks.sort(key=lambda c: c["rrf_score"], reverse=True)
        best_chunks = chunks[:MAX_CHUNKS_PER_SOURCE]

        item_db = items_batch.get(item_key)
        if not item_db:
            logger.warning("Item %s in index but not in SQLite — skipping.", item_key)
            continue

        if collection_key:
            col_keys = item_db.get("collection_keys", "[]")
            if collection_key not in col_keys:
                continue

        if source_dir:
            if (item_db.get("source_dir") or "") != source_dir:
                continue

        creators_raw = item_db.get("creators", "[]")
        try:
            creators = json.loads(creators_raw) if isinstance(creators_raw, str) else (creators_raw or [])
        except (json.JSONDecodeError, TypeError):
            creators = []

        has_text_chunks = any(c.get("chunk_text") for c in best_chunks)
        if has_text_chunks:
            best_evidence = "\n\n".join(c["chunk_text"] for c in best_chunks if c.get("chunk_text"))[:1000]
        else:
            best_evidence = item_db.get("abstract", "")[:1000]

        best_similarity = best_chunks[0].get("similarity", 0.0)
        best_rrf = best_chunks[0].get("rrf_score", 0.0)

        candidates.append({
            "item_key":          item_key,
            "title":             item_db.get("title", ""),
            "creators":          creators,
            "year":              item_db.get("year", ""),
            "item_type":         item_db.get("item_type", ""),
            "publication_title": item_db.get("publication_title", ""),
            "doi":               item_db.get("doi", ""),
            "url":               item_db.get("url", ""),
            "abstract":          item_db.get("abstract", ""),
            "volume":            item_db.get("volume", ""),
            "issue":             item_db.get("issue", ""),
            "pages":             item_db.get("pages", ""),
            "publisher":         item_db.get("publisher", ""),
            "place":             item_db.get("place", ""),
            "isbn":              item_db.get("isbn", ""),
            "issn":              item_db.get("issn", ""),
            "extra":             item_db.get("extra", ""),
            "citation_count":    item_db.get("citation_count", 0) or 0,
            "citation_count_updated_at": item_db.get("citation_count_updated_at", ""),
            "file_path":         item_db.get("file_path", ""),
            "source_dir":        item_db.get("source_dir", ""),
            "chunks":            best_chunks,
            "best_evidence":     best_evidence,
            "best_similarity":   best_similarity,
            "best_rrf_score":    best_rrf,
            "best_source_type":  best_chunks[0]["metadata"].get("source_type", "abstract"),
        })

    logger.info(
        "Retrieval: %d vector chunks + %d BM25 chunks + %d title matches → %d unique papers before rerank",
        len(vector_chunks), len(bm25_chunks), len(title_keys), len(candidates),
    )

    pre_rerank = sorted(candidates, key=lambda c: c["best_rrf_score"], reverse=True)[:max(top_k * 2, 30)]
    reranked = rerank(
        paragraph=paragraph,
        candidates=pre_rerank,
        model_name=reranker_model,
        top_n=top_k,
    )

    if use_mmr and len(reranked) > 1:
        reranked = _mmr_select(reranked, top_k, mmr_lambda)

    logger.info("Final candidates after rerank%s: %d", " + MMR" if use_mmr else "", len(reranked))
    return reranked
