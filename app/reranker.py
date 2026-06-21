"""
Cross-encoder reranker for the second stage of hybrid retrieval.

A cross-encoder scores (query, document) pairs jointly — far more accurate
than bi-encoder cosine similarity because it attends to both texts at once.
Used after the coarse vector + BM25 retrieval to reorder candidates before
sending to the LLM.

Default model: BAAI/bge-reranker-base
  - ~278 MB
  - Higher accuracy than the MiniLM reranker

Alternative: cross-encoder/ms-marco-MiniLM-L-6-v2 (~66 MB, faster CPU inference)
"""

import logging
from pathlib import Path
from typing import Any, Dict, List

from app.config import DATA_DIR

logger = logging.getLogger(__name__)

_reranker_cache: Dict[str, Any] = {}   # model_name → CrossEncoder instance

DEFAULT_RERANKER = "BAAI/bge-reranker-base"

_LOCAL_RERANKER_DIRS = {
    "BAAI/bge-reranker-base": "models--BAAI--bge-reranker-base",
}


def _get_device() -> str:
    try:
        import torch
        if torch.backends.mps.is_available():
            return "mps"
        if torch.cuda.is_available():
            return "cuda"
    except Exception:
        pass
    return "cpu"


def _resolve_local_hf_snapshot(model_name: str) -> str:
    cache_dir_name = _LOCAL_RERANKER_DIRS.get(model_name)
    if not cache_dir_name:
        return model_name

    for base in [DATA_DIR / "models" / "hub", Path.home() / ".cache" / "huggingface" / "hub"]:
        for suffix in ["", ".extracted"]:
            snapshots_dir = base / f"{cache_dir_name}{suffix}" / "snapshots"
            try:
                if not snapshots_dir.exists():
                    continue
                snapshots = sorted(
                    [
                        p for p in snapshots_dir.iterdir()
                        if (p / "config.json").exists()
                        and ((p / "model.safetensors").exists() or (p / "pytorch_model.bin").exists())
                    ],
                    key=lambda p: p.stat().st_mtime,
                    reverse=True,
                )
                if snapshots:
                    return str(snapshots[0])
            except (OSError, PermissionError):
                continue

    return model_name


def _get_reranker(model_name: str):
    if not model_name or model_name.lower() == "none":
        return None
    if model_name not in _reranker_cache:
        from sentence_transformers import CrossEncoder
        device = _get_device()
        resolved_model = _resolve_local_hf_snapshot(model_name)
        logger.info("Loading reranker model: %s (resolved=%s, device=%s)", model_name, resolved_model, device)
        _reranker_cache[model_name] = CrossEncoder(resolved_model, device=device)
        logger.info("Reranker ready")
    return _reranker_cache[model_name]


def rerank(
    paragraph: str,
    candidates: List[Dict[str, Any]],
    model_name: str = DEFAULT_RERANKER,
    top_n: int = 20,
) -> List[Dict[str, Any]]:
    """
    Rerank *candidates* using a cross-encoder.

    Each candidate needs a 'best_evidence' field (the text to score against
    the paragraph). Returns at most *top_n* candidates sorted by rerank score.

    If model_name is 'none' or empty, returns candidates unchanged.
    """
    reranker = _get_reranker(model_name)

    if reranker is None or not candidates:
        return candidates[:top_n]

    # Build (query, passage) pairs — use up to 1024 chars of evidence
    pairs = [
        (paragraph, (c.get("best_evidence") or c.get("abstract") or "")[:1024])
        for c in candidates
    ]

    try:
        scores = reranker.predict(pairs, show_progress_bar=False)
        for i, cand in enumerate(candidates):
            cand["rerank_score"] = float(scores[i])
        candidates.sort(key=lambda c: c.get("rerank_score", 0.0), reverse=True)
        logger.info("Reranked %d candidates", len(candidates))
    except Exception as exc:
        logger.error("Reranker error: %s", exc)
        # Degrade gracefully — return original order

    return candidates[:top_n]
