"""Small runtime timing helpers for local performance diagnostics."""

import logging
import time
from contextlib import contextmanager
from typing import Iterator


@contextmanager
def log_duration(
    logger: logging.Logger,
    label: str,
    *,
    threshold_ms: float = 250.0,
    level: int = logging.INFO,
) -> Iterator[None]:
    """Log elapsed time for operations that exceed a threshold."""
    start = time.perf_counter()
    try:
        yield
    finally:
        elapsed_ms = (time.perf_counter() - start) * 1000
        if elapsed_ms >= threshold_ms:
            logger.log(level, "Perf | %s took %.1f ms", label, elapsed_ms)
