"""Crash-isolated ChromaDB health probe.

A corrupt HNSW index can segfault inside chromadb_rust_bindings the moment it is
read — uncatchable from Python. The size-based guard in :mod:`app.embeddings`
catches the known "ballooned link_lists.bin" corruption, but not every form
(e.g. bad internal offsets at normal file sizes). So before the app relies on
the vector store we open and touch it inside a **subprocess**: if that worker
dies on a native signal, the parent quarantines the index and rebuilds from FTS.

Mirrors :mod:`app.pdf_extract`'s frozen/dev re-invocation pattern.
"""

import logging
import os
import subprocess
import sys
from pathlib import Path

logger = logging.getLogger(__name__)

WORKER_ARG = "--__chroma_health_worker__"

_REPO_ROOT = Path(__file__).resolve().parent.parent
_DEFAULT_TIMEOUT = float(os.getenv("CHROMA_HEALTHCHECK_TIMEOUT", "90"))


def _probe() -> None:
    """Touch the vector store enough to fault a corrupt HNSW index. Worker only."""
    from app.embeddings import get_chroma_client, get_or_create_collection

    client = get_chroma_client()
    collection = get_or_create_collection(client)
    collection.count()
    collection.get(include=[], limit=5)


def run_worker() -> int:
    try:
        _probe()
    except Exception as exc:  # noqa: BLE001 - clean failure still means unhealthy
        sys.stderr.write(f"chroma health probe failed: {exc}\n")
        return 5
    return 0


def maybe_run_worker(argv) -> bool:
    if len(argv) >= 2 and argv[1] == WORKER_ARG:
        os._exit(run_worker())
    return False


def _worker_command():
    if getattr(sys, "frozen", False) or hasattr(sys, "_MEIPASS"):
        return [sys.executable, WORKER_ARG], None
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join(
        [str(_REPO_ROOT), env.get("PYTHONPATH", "")]
    ).strip(os.pathsep)
    return [sys.executable, "-m", "app.index_health", WORKER_ARG], env


def chroma_index_is_healthy(timeout: float = _DEFAULT_TIMEOUT) -> bool:
    """Return True if the vector index opens and reads in an isolated subprocess.
    A native crash (negative return code) or clean error means unhealthy."""
    cmd, env = _worker_command()
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=timeout, env=env, check=False)
    except subprocess.TimeoutExpired:
        logger.warning("Chroma health probe timed out after %ss — treating as unhealthy", timeout)
        return False
    except Exception as exc:  # noqa: BLE001
        logger.warning("Chroma health probe could not run (%s) — assuming healthy", exc)
        return True  # don't quarantine just because we failed to spawn the probe
    if proc.returncode == 0:
        return True
    detail = (
        f"native crash (signal {-proc.returncode})"
        if proc.returncode < 0
        else proc.stderr.decode("utf-8", errors="replace").strip()[:200]
    )
    logger.error("Chroma health probe reported unhealthy index: %s", detail)
    return False


if __name__ == "__main__":
    os._exit(run_worker())
