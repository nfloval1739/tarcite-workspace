"""
ChromaDB vector store management and embedding creation.

Supports two embedding modes controlled by config.embedding_provider:
  - "local"  → sentence-transformers (free, offline, recommended)
  - "api"    → OpenAI-compatible embeddings API
"""

import logging
import os
import shutil
import threading
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

import chromadb
from chromadb.config import Settings

from app.config import DATA_DIR, config

logger = logging.getLogger(__name__)

COLLECTION_NAME = "local_library"
EMBED_BATCH_SIZE = 64

_local_model = None
_local_model_name: str = ""
_chroma_lock = threading.Lock()
_chroma_client: Optional[chromadb.ClientAPI] = None
_chroma_client_path: str = ""
_collection_cache: Dict[str, chromadb.Collection] = {}

_BGE_QUERY_PREFIX = "Represent this sentence for searching relevant passages: "
_MODELS_WITH_QUERY_PREFIX: set = {
    "BAAI/bge-large-en-v1.5",
    "BAAI/bge-base-en-v1.5",
    "BAAI/bge-small-en-v1.5",
}

_LOCAL_HF_MODEL_DIRS = {
    "all-MiniLM-L6-v2": "models--sentence-transformers--all-MiniLM-L6-v2",
    "sentence-transformers/all-MiniLM-L6-v2": "models--sentence-transformers--all-MiniLM-L6-v2",
    "BAAI/bge-large-en-v1.5": "models--BAAI--bge-large-en-v1.5",
}

# Absolute ceiling for any single HNSW sidecar (.bin). A healthy local research
# index is well under this; 16 GiB still allows ~4M chunks of 1024-dim float32.
_DEFAULT_CHROMA_MAX_SIDE_CAR_BYTES = 16 * 1024 * 1024 * 1024

# Flag set when get_chroma_client() quarantines a corrupt index, so startup can
# auto-rebuild vectors from the surviving FTS chunks.
_chroma_index_was_quarantined = False


def _max_chroma_sidecar_bytes() -> int:
    raw = os.getenv("CHROMA_INDEX_MAX_FILE_BYTES", "")
    if not raw:
        return _DEFAULT_CHROMA_MAX_SIDE_CAR_BYTES
    try:
        return max(1024 * 1024 * 1024, int(raw))
    except ValueError:
        return _DEFAULT_CHROMA_MAX_SIDE_CAR_BYTES


def _find_corrupt_chroma_sidecars(path: Path) -> list:
    """Return HNSW sidecar files that look corrupt.

    Two signals: (1) any .bin over the absolute ceiling; (2) a link_lists.bin
    grossly larger than its sibling data_level0.bin — the signature of the
    real-world corruption that ballooned link_lists.bin to terabytes while
    data_level0.bin stayed normal-sized.
    """
    max_bytes = _max_chroma_sidecar_bytes()
    suspicious: list = []
    for candidate in path.rglob("*.bin"):
        try:
            size = candidate.stat().st_size
        except OSError:
            continue
        if size > max_bytes:
            suspicious.append(candidate)
            continue
        if candidate.name == "link_lists.bin":
            data_level0 = candidate.with_name("data_level0.bin")
            try:
                base = data_level0.stat().st_size
            except OSError:
                base = 0
            # link_lists is normally a fraction of data_level0; flag a gross inversion.
            if size > 1024 * 1024 * 1024 and (base == 0 or size > 4 * base):
                suspicious.append(candidate)
    return suspicious


def _quarantine_suspicious_chroma_index(chroma_path: str) -> None:
    """Avoid loading obviously corrupted HNSW sidecar files.

    A damaged Chroma HNSW index can segfault inside chromadb_rust_bindings
    before Python can catch an exception. The SQLite app database is stored
    separately, so quarantining this folder preserves library metadata while
    allowing Chroma to rebuild an empty vector store.
    """
    global _chroma_index_was_quarantined
    path = Path(chroma_path)
    if not path.exists():
        return

    suspicious = _find_corrupt_chroma_sidecars(path)
    if not suspicious:
        return

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    quarantine = path.with_name(f"{path.name}.corrupt-{stamp}")
    counter = 1
    while quarantine.exists():
        quarantine = path.with_name(f"{path.name}.corrupt-{stamp}-{counter}")
        counter += 1

    logger.error(
        "Quarantining suspicious Chroma index at %s before startup; suspicious files: %s",
        path,
        ", ".join(str(p) for p in suspicious[:5]),
    )
    shutil.move(str(path), str(quarantine))
    _chroma_index_was_quarantined = True


def chroma_index_was_quarantined() -> bool:
    """True if a corrupt index was quarantined this session (consume-once)."""
    global _chroma_index_was_quarantined
    was = _chroma_index_was_quarantined
    _chroma_index_was_quarantined = False
    return was


def force_quarantine_chroma_index(reason: str = "") -> bool:
    """Move the current Chroma index aside (used when a health probe finds it
    unreadable). Resets cached client/collection so the next access rebuilds
    an empty store. Returns True if an index was moved."""
    global _chroma_client, _chroma_client_path, _chroma_index_was_quarantined
    path = Path(config.chroma_path)
    if not path.exists():
        return False
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    quarantine = path.with_name(f"{path.name}.corrupt-{stamp}")
    counter = 1
    while quarantine.exists():
        quarantine = path.with_name(f"{path.name}.corrupt-{stamp}-{counter}")
        counter += 1
    logger.error("Quarantining unreadable Chroma index at %s (%s)", path, reason or "health probe failed")
    shutil.move(str(path), str(quarantine))
    with _chroma_lock:
        _chroma_client = None
        _chroma_client_path = None
        _collection_cache.clear()
    _chroma_index_was_quarantined = True
    return True


def _meta_path():
    from pathlib import Path
    return Path(config.chroma_path).parent / "embedding_meta.json"

def get_embedding_meta() -> dict:
    p = _meta_path()
    if p.exists():
        try:
            import json as _json
            return _json.loads(p.read_text())
        except Exception:
            pass
    return {}

def save_embedding_meta(model_name: str) -> None:
    import json as _json
    from datetime import datetime
    _meta_path().write_text(_json.dumps({
        "model": model_name,
        "updated_at": datetime.now().isoformat(),
    }))

def embedding_model_changed() -> bool:
    stored = get_embedding_meta().get("model", "")
    return bool(stored) and stored != config.embedding_model


def get_index_model() -> str:
    return get_embedding_meta().get("model", "") or "all-MiniLM-L6-v2"


def get_chroma_client() -> chromadb.ClientAPI:
    global _chroma_client, _chroma_client_path
    _quarantine_suspicious_chroma_index(config.chroma_path)
    os.makedirs(config.chroma_path, exist_ok=True)
    with _chroma_lock:
        if _chroma_client is None or _chroma_client_path != config.chroma_path:
            _chroma_client = chromadb.PersistentClient(
                path=config.chroma_path,
                settings=Settings(anonymized_telemetry=False),
            )
            _chroma_client_path = config.chroma_path
            _collection_cache.clear()
        return _chroma_client


def get_or_create_collection(client: chromadb.ClientAPI) -> chromadb.Collection:
    with _chroma_lock:
        cached = _collection_cache.get(COLLECTION_NAME)
        if cached is not None:
            return cached
        collection = client.get_or_create_collection(
            name=COLLECTION_NAME,
            metadata={"hnsw:space": "cosine"},
        )
        _collection_cache[COLLECTION_NAME] = collection
        return collection


def reset_collection(client: chromadb.ClientAPI) -> chromadb.Collection:
    try:
        client.delete_collection(COLLECTION_NAME)
        logger.info("Deleted ChromaDB collection '%s'", COLLECTION_NAME)
    except Exception:
        pass
    with _chroma_lock:
        _collection_cache.pop(COLLECTION_NAME, None)
    return get_or_create_collection(client)


def get_collection_stats() -> Dict[str, Any]:
    try:
        client = get_chroma_client()
        col = get_or_create_collection(client)
        return {"total_chunks": col.count()}
    except Exception as exc:
        logger.error("ChromaDB stats error: %s", exc)
        return {"total_chunks": 0}


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
    """Use app-downloaded HF snapshots when present, avoiding network lookups.

    Only checks the app's own models directory — not the system HuggingFace cache.
    Models in _LOCAL_HF_MODEL_DIRS must be downloaded via the app's Settings page;
    loading them from ~/.cache/huggingface can fail in the packaged environment.
    """
    cache_dir_name = _LOCAL_HF_MODEL_DIRS.get(model_name)
    if not cache_dir_name:
        return model_name

    for suffix in ["", ".extracted"]:
        model_dir = DATA_DIR / "models" / "hub" / f"{cache_dir_name}{suffix}"
        snapshots_dir = model_dir / "snapshots"
        try:
            if not snapshots_dir.exists():
                continue
            snapshots = sorted(
                [p for p in snapshots_dir.iterdir() if _is_usable_sentence_transformer_snapshot(p)],
                key=lambda p: p.stat().st_mtime,
                reverse=True,
            )
            if snapshots:
                return str(snapshots[0])
        except (OSError, PermissionError):
            continue

    return model_name


def _is_usable_sentence_transformer_snapshot(snapshot: Path) -> bool:
    try:
        has_config = (snapshot / "config.json").exists()
        has_weights = (snapshot / "model.safetensors").exists() or (snapshot / "pytorch_model.bin").exists()
        has_tokenizer = (
            (snapshot / "tokenizer.json").exists()
            or (snapshot / "vocab.txt").exists()
            or (snapshot / "sentencepiece.bpe.model").exists()
        )
        has_sentence_transformer_meta = (
            (snapshot / "modules.json").exists()
            or (snapshot / "sentence_bert_config.json").exists()
        )
        return has_config and has_weights and has_tokenizer and has_sentence_transformer_meta
    except (OSError, PermissionError):
        return False


def get_loaded_embedding_model_name() -> str:
    return _local_model_name or config.embedding_model or "all-MiniLM-L6-v2"


def ensure_embedding_model_ready() -> None:
    if config.embedding_provider != "api":
        _get_local_model()


def _get_local_model():
    global _local_model, _local_model_name
    model_name = config.embedding_model or "all-MiniLM-L6-v2"
    resolved_model = _resolve_local_hf_snapshot(model_name)
    if resolved_model == model_name and model_name in _LOCAL_HF_MODEL_DIRS:
        raise RuntimeError(
            f"Embedding model '{model_name}' is not installed completely. "
            "Open Settings, download or repair the selected embedding model, then run Sync again."
        )

    if _local_model is None or _local_model_name != model_name:
        from sentence_transformers import SentenceTransformer
        device = _get_device()
        logger.info("Loading local embedding model: %s (resolved=%s, device=%s)", model_name, resolved_model, device)
        _local_model = SentenceTransformer(resolved_model, device=device)
        _local_model_name = model_name
        logger.info("Local embedding model ready (dim=%d)", _local_model.get_sentence_embedding_dimension())
    return _local_model


def _get_openai_client():
    from openai import OpenAI
    cfg = config
    kwargs: Dict[str, Any] = {"api_key": cfg.ai_api_key}
    if cfg.ai_api_base_url and cfg.ai_api_base_url not in ("https://api.openai.com/v1", ""):
        kwargs["base_url"] = cfg.ai_api_base_url
    return OpenAI(**kwargs)


def _embed_with_model(text: str, model_name: str, is_query: bool = False) -> List[float]:
    original = config.embedding_model
    swapped = model_name != original
    if swapped:
        config.embedding_model = model_name
    try:
        result = create_embeddings_batch([text], is_query=is_query)[0]
    finally:
        if swapped:
            config.embedding_model = original
    return result


def create_embedding(text: str, is_query: bool = False) -> List[float]:
    return create_embeddings_batch([text], is_query=is_query)[0]


def create_embeddings_batch(texts: List[str], is_query: bool = False) -> List[List[float]]:
    if not texts:
        return []

    if config.embedding_provider == "api":
        client = _get_openai_client()
        resp = client.embeddings.create(model=config.embedding_model, input=texts)
        return [item.embedding for item in resp.data]
    else:
        model = _get_local_model()
        model_name = config.embedding_model

        if is_query and model_name in _MODELS_WITH_QUERY_PREFIX:
            prefixed = [_BGE_QUERY_PREFIX + t for t in texts]
            vectors = model.encode(prefixed, batch_size=EMBED_BATCH_SIZE,
                                   show_progress_bar=False, normalize_embeddings=True)
        else:
            vectors = model.encode(texts, batch_size=EMBED_BATCH_SIZE,
                                   show_progress_bar=False, normalize_embeddings=True)

        return [v.tolist() for v in vectors]


def add_chunks_to_collection(
    collection: chromadb.Collection,
    chunks: List[Dict[str, Any]],
    item_metadata: Dict[str, Any],
) -> int:
    if not chunks:
        return 0

    added = 0

    for batch_start in range(0, len(chunks), EMBED_BATCH_SIZE):
        batch = chunks[batch_start : batch_start + EMBED_BATCH_SIZE]
        texts = [c["chunk_text"] for c in batch]

        try:
            embeddings = create_embeddings_batch(texts)
        except Exception as exc:
            logger.error(
                "Embedding error for item %s (batch %d): %s",
                item_metadata.get("item_key"),
                batch_start,
                exc,
            )
            continue

        ids: List[str] = []
        metadatas: List[Dict] = []

        item_key = item_metadata.get("item_key", "")
        title = (item_metadata.get("title") or "")[:500]
        year = item_metadata.get("year") or ""
        creators = (item_metadata.get("creators") or "")[:500]
        pub_title = (item_metadata.get("publication_title") or "")[:300]
        col_keys = (item_metadata.get("collection_keys") or "")
        source_dir = (item_metadata.get("source_dir") or "")

        for i, chunk in enumerate(batch):
            chunk_id = f"{item_key}__{chunk['source_type']}__{batch_start + i}"
            ids.append(chunk_id)
            metadatas.append(
                {
                    "item_key": item_key,
                    "title": title,
                    "year": year,
                    "creators": creators,
                    "publication_title": pub_title,
                    "collection_keys": col_keys,
                    "source_dir": source_dir,
                    "source_type": chunk["source_type"],
                    "chunk_index": chunk["chunk_index"],
                    "page_number": chunk.get("page_number") or 0,
                }
            )

        try:
            collection.upsert(
                ids=ids,
                embeddings=embeddings,
                documents=texts,
                metadatas=metadatas,
            )
            added += len(batch)
        except Exception as exc:
            logger.error("ChromaDB upsert error for item %s: %s", item_key, exc)

    return added


def delete_item_chunks(collection: chromadb.Collection, item_key: str) -> None:
    try:
        collection.delete(where={"item_key": item_key})
    except Exception as exc:
        logger.warning("Could not delete chunks for %s: %s", item_key, exc)


def query_collection(
    collection: chromadb.Collection,
    query_text: str,
    n_results: int = 40,
    collection_key: Optional[str] = None,
    source_dir: Optional[str] = None,
) -> Dict[str, Any]:
    if collection.count() == 0:
        return {"ids": [[]], "documents": [[]], "metadatas": [[]], "distances": [[]]}

    fetch_n = min(n_results * 4 if (collection_key or source_dir) else n_results * 2, collection.count())

    index_model = get_index_model()
    query_embedding = _embed_with_model(query_text, model_name=index_model, is_query=True)

    chroma_where = None
    if source_dir:
        chroma_where = {"source_dir": source_dir}

    raw = collection.query(
        query_embeddings=[query_embedding],
        n_results=fetch_n,
        include=["documents", "metadatas", "distances"],
        where=chroma_where,
    )

    if not collection_key and not source_dir:
        return raw

    ids_f, docs_f, metas_f, dists_f = [], [], [], []
    for cid, doc, meta, dist in zip(
        raw["ids"][0], raw["documents"][0], raw["metadatas"][0], raw["distances"][0]
    ):
        if collection_key and collection_key not in (meta.get("collection_keys") or ""):
            continue
        if source_dir and source_dir != (meta.get("source_dir") or ""):
            continue
        ids_f.append(cid)
        docs_f.append(doc)
        metas_f.append(meta)
        dists_f.append(dist)

    return {
        "ids": [ids_f],
        "documents": [docs_f],
        "metadatas": [metas_f],
        "distances": [dists_f],
    }
