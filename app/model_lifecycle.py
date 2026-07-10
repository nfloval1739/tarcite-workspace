"""Idle unloader for the heavyweight ML models.

The embedding model (~1.3 GB for bge-large) and the cross-encoder reranker
stay resident once loaded. On memory-constrained machines that resident weight
pushes other processes into swap, which costs sustained CPU/SSD activity long
after the models were last used. This module frees them after a configurable
idle period (Settings/env: ``model_idle_unload_minutes``, 0 = never); the next
search or sync simply reloads on demand.

Model owners (app.embeddings, app.reranker) call :func:`touch` on every use,
passing an unload callback. One daemon thread sweeps the registry once a
minute and fires the callbacks for entries past the idle cutoff, then releases
the MPS/CUDA allocator cache so the memory actually returns to the OS.
"""

import gc
import logging
import threading
import time

logger = logging.getLogger(__name__)

_CHECK_INTERVAL_SECONDS = 60.0

_lock = threading.Lock()
_entries: dict = {}  # name -> (last_used_monotonic, unload_callback)
_reaper_started = False


def touch(name: str, unload) -> None:
    """Record that model *name* was just used; *unload* frees it when idle."""
    global _reaper_started
    with _lock:
        _entries[name] = (time.monotonic(), unload)
        if not _reaper_started:
            _reaper_started = True
            threading.Thread(
                target=_reaper_loop, name="model-idle-reaper", daemon=True
            ).start()


def _reaper_loop() -> None:
    while True:
        time.sleep(_CHECK_INTERVAL_SECONDS)
        try:
            _sweep()
        except Exception as exc:  # noqa: BLE001 - the reaper must never die
            logger.warning("Model idle sweep failed: %s", exc)


def _sweep() -> None:
    from app.config import config

    idle_minutes = getattr(config, "model_idle_unload_minutes", 20)
    if idle_minutes <= 0:
        return
    cutoff = time.monotonic() - idle_minutes * 60

    expired = []
    with _lock:
        for name, (last_used, unload) in list(_entries.items()):
            if last_used < cutoff:
                del _entries[name]
                expired.append((name, unload))

    if not expired:
        return
    for name, unload in expired:
        try:
            unload()
            logger.info("Unloaded idle model after %d min: %s", idle_minutes, name)
        except Exception as exc:  # noqa: BLE001 - keep sweeping the rest
            logger.warning("Could not unload idle model %s: %s", name, exc)
    gc.collect()
    _release_accelerator_cache()


def _release_accelerator_cache() -> None:
    try:
        import torch

        if torch.backends.mps.is_available():
            torch.mps.empty_cache()
        elif torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:  # noqa: BLE001 - cache release is best-effort
        pass
