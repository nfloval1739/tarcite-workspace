"""Benchmark bge-large embedding throughput across device/precision/batch."""
import os, sys, time, sqlite3, statistics

INSTALL = os.path.expanduser("~/Library/Application Support/CitationWorkspace/data")
os.environ["CITATION_DATA_DIR"] = INSTALL
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

import torch
from app.embeddings import _resolve_local_hf_snapshot
from sentence_transformers import SentenceTransformer

# Pull ~600 real chunk texts (variable length, representative of the workload)
d = sqlite3.connect(os.path.join(INSTALL, "local_citation.sqlite"))
texts = [r[0] for r in d.execute(
    "SELECT chunk_text FROM chunks_fts WHERE chunk_text != '' LIMIT 600")]
print(f"sample chunks: {len(texts)}  avg_len={statistics.mean(len(t) for t in texts):.0f} chars")

resolved = _resolve_local_hf_snapshot("BAAI/bge-large-en-v1.5")


def bench(device, batch, half=False, warmup=True, n=384):
    m = SentenceTransformer(resolved, device=device)
    if half:
        m = m.half()
    sub = texts[:n]
    if warmup:
        m.encode(sub[:64], batch_size=batch, normalize_embeddings=True, show_progress_bar=False)
    t = time.time()
    m.encode(sub, batch_size=batch, normalize_embeddings=True, show_progress_bar=False)
    dt = time.time() - t
    del m
    return n / dt, dt


configs = [
    ("mps", 64, False),
    ("mps", 64, True),
    ("mps", 128, True),
    ("mps", 256, True),
    ("cpu", 64, False),
    ("cpu", 128, False),
]
print(f"{'config':22s} {'chunks/s':>10s} {'sec/384':>8s}")
for dev, bs, hf in configs:
    if dev == "mps" and not torch.backends.mps.is_available():
        continue
    try:
        cps, dt = bench(dev, bs, hf)
        tag = f"{dev} b{bs}{' fp16' if hf else ' fp32'}"
        print(f"{tag:22s} {cps:10.1f} {dt:8.1f}")
    except Exception as e:
        print(f"{dev} b{bs} {'fp16' if hf else 'fp32'}: ERROR {e}")
