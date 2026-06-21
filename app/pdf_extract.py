"""Crash-isolated PDF text extraction.

MuPDF (PyMuPDF/fitz) can abort the whole process with a native SIGABRT/SIGSEGV
on a malformed PDF or under memory pressure — a failure that Python's
``try/except`` cannot catch. To keep the app alive during library sync, all PDF
text extraction is delegated to a short-lived **subprocess**. If that worker is
killed by a native signal, only the worker dies; the caller observes a non-zero
return code and skips the offending file instead of crashing.

Two invocation paths keep this working in both dev and the PyInstaller bundle:

* **Frozen app**: ``sys.executable`` is the bundled binary, so we re-launch it
  with :data:`WORKER_ARG`. ``launcher.py`` short-circuits into :func:`run_worker`
  before any heavy startup happens.
* **Dev**: ``sys.executable`` is ``python``; we run ``python -m app.pdf_extract``.
"""

import logging
import os
import subprocess
import sys
from pathlib import Path
from typing import Tuple

logger = logging.getLogger(__name__)

# argv sentinel used to re-enter the frozen binary in worker mode
WORKER_ARG = "--__pdf_extract_worker__"

_REPO_ROOT = Path(__file__).resolve().parent.parent
_DEFAULT_TIMEOUT = float(os.getenv("PDF_EXTRACT_TIMEOUT", "180"))


def _extract_text(pdf_path: str) -> str:
    """Actual extraction — only ever runs inside the isolated worker process."""
    import fitz  # imported lazily so the parent never loads MuPDF in-process

    doc = fitz.open(pdf_path)
    try:
        return "".join(page.get_text() + "\n" for page in doc)
    finally:
        doc.close()


def run_worker(pdf_path: str) -> int:
    """Worker entrypoint: write extracted text to stdout, return an exit code.

    Exit codes: 0 = success, 4 = clean Python-level failure (caught). A native
    MuPDF abort never reaches here — the OS terminates the process with a signal,
    which the parent sees as a negative return code.
    """
    try:
        text = _extract_text(pdf_path)
    except Exception as exc:  # noqa: BLE001 - report any clean failure to parent
        sys.stderr.write(f"pdf-extract failed: {exc}\n")
        return 4
    sys.stdout.buffer.write(text.encode("utf-8", errors="replace"))
    sys.stdout.buffer.flush()
    return 0


def maybe_run_worker(argv) -> bool:
    """Called at the very top of the entrypoint. Returns True if it handled
    worker mode (caller should then exit immediately)."""
    if len(argv) >= 3 and argv[1] == WORKER_ARG:
        os._exit(run_worker(argv[2]))  # os._exit: skip atexit/cleanup in worker
    return False


def _worker_command(pdf_path: str):
    if getattr(sys, "frozen", False) or hasattr(sys, "_MEIPASS"):
        return [sys.executable, WORKER_ARG, pdf_path], None
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join(
        [str(_REPO_ROOT), env.get("PYTHONPATH", "")]
    ).strip(os.pathsep)
    return [sys.executable, "-m", "app.pdf_extract", pdf_path], env


def safe_extract_pdf_fulltext(
    pdf_path, timeout: float = _DEFAULT_TIMEOUT
) -> Tuple[str, str]:
    """Extract full text from a PDF in an isolated subprocess.

    Returns ``(text, error)``. On success ``error`` is empty. On any failure
    (native crash, timeout, clean error) ``text`` is empty and ``error`` carries
    a short reason — the caller should flag the item and continue.
    """
    path = str(pdf_path)
    cmd, env = _worker_command(path)
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            timeout=timeout,
            env=env,
            check=False,
        )
    except subprocess.TimeoutExpired:
        logger.warning("PDF extraction timed out (%ss): %s", timeout, path)
        return "", f"timeout after {timeout}s"
    except Exception as exc:  # noqa: BLE001 - subprocess spawn failure
        logger.warning("PDF extraction subprocess error for %s: %s", path, exc)
        return "", f"worker spawn error: {exc}"

    if proc.returncode == 0:
        return proc.stdout.decode("utf-8", errors="replace"), ""

    if proc.returncode < 0:
        reason = f"native crash (signal {-proc.returncode})"
    else:
        stderr = proc.stderr.decode("utf-8", errors="replace").strip()
        reason = stderr.splitlines()[-1] if stderr else f"exit {proc.returncode}"
    logger.warning("PDF extraction failed for %s: %s", path, reason)
    return "", reason


if __name__ == "__main__":
    os._exit(run_worker(sys.argv[1]) if len(sys.argv) > 1 else 2)
