"""Crash-isolated PDF text extraction.

MuPDF (PyMuPDF/fitz) can abort the whole process with a native SIGABRT/SIGSEGV
on a malformed PDF or under memory pressure — a failure that Python's
``try/except`` cannot catch. To keep the app alive during library sync, all PDF
text extraction is delegated to an isolated **worker process**. If that worker
is killed by a native signal, only the worker dies; the caller observes the
failure and skips the offending file instead of crashing.

The worker is a single long-lived batch process, not one spawn per file: in the
PyInstaller bundle each spawn re-runs the frozen bootloader (seconds of CPU per
file), which used to dominate large scans. The batch worker receives file paths
over stdin and answers with a length-prefixed protocol on stdout::

    parent → worker:  <pdf_path>\n
    worker → parent:  OK <payload_bytes>\n<payload>   on success
                      ERR <reason>\n                  on a clean failure

Crash isolation is preserved: a native MuPDF abort kills only the worker; the
parent sees EOF, records the failure for the in-flight file, and starts a fresh
worker for the next one. The worker is also recycled every
``_MAX_JOBS_PER_WORKER`` files as insurance against MuPDF memory leaks, and is
shut down when a sync finishes so no extra process lingers.

Two invocation paths keep this working in both dev and the PyInstaller bundle:

* **Frozen app**: ``sys.executable`` is the bundled binary, so we re-launch it
  with :data:`BATCH_ARG`. ``launcher.py`` short-circuits into the worker loop
  before any heavy startup happens.
* **Dev**: ``sys.executable`` is ``python``; we run ``python -m app.pdf_extract``.
"""

import logging
import os
import subprocess
import sys
import threading
from pathlib import Path
from typing import Optional, Tuple

logger = logging.getLogger(__name__)

# argv sentinels used to re-enter the frozen binary in worker mode.
# WORKER_ARG (single file) is kept for backwards compatibility; BATCH_ARG is
# the long-lived stdin/stdout worker used by the app.
WORKER_ARG = "--__pdf_extract_worker__"
BATCH_ARG = "--__pdf_extract_batch__"

_REPO_ROOT = Path(__file__).resolve().parent.parent
_DEFAULT_TIMEOUT = float(os.getenv("PDF_EXTRACT_TIMEOUT", "180"))

# Recycle the worker after this many files: bounds any MuPDF memory growth
# while keeping process-spawn overhead negligible (1 spawn per N files).
_MAX_JOBS_PER_WORKER = int(os.getenv("PDF_EXTRACT_JOBS_PER_WORKER", "50"))


def _extract_text(pdf_path: str) -> str:
    """Actual extraction — only ever runs inside the isolated worker process."""
    import fitz  # imported lazily so the parent never loads MuPDF in-process

    doc = fitz.open(pdf_path)
    try:
        return "".join(page.get_text() + "\n" for page in doc)
    finally:
        doc.close()


# ── Worker side ───────────────────────────────────────────────────────────────

def run_worker(pdf_path: str) -> int:
    """Legacy single-file worker: write extracted text to stdout, return an
    exit code. Exit codes: 0 = success, 4 = clean Python-level failure."""
    try:
        text = _extract_text(pdf_path)
    except Exception as exc:  # noqa: BLE001 - report any clean failure to parent
        sys.stderr.write(f"pdf-extract failed: {exc}\n")
        return 4
    sys.stdout.buffer.write(text.encode("utf-8", errors="replace"))
    sys.stdout.buffer.flush()
    return 0


def run_batch_worker() -> int:
    """Long-lived worker loop: one path per stdin line, one framed response per
    file. Exits on stdin EOF (parent shut down or died). A native MuPDF abort
    terminates this process mid-job; the parent handles the missing response."""
    stdin = sys.stdin.buffer
    stdout = sys.stdout.buffer
    while True:
        line = stdin.readline()
        if not line:
            return 0
        pdf_path = line.decode("utf-8", errors="replace").strip()
        if not pdf_path:
            continue
        try:
            payload = _extract_text(pdf_path).encode("utf-8", errors="replace")
        except Exception as exc:  # noqa: BLE001 - clean failure, keep serving
            reason = " ".join(str(exc).split())[:300] or "extraction failed"
            stdout.write(f"ERR {reason}\n".encode("utf-8", errors="replace"))
            stdout.flush()
            continue
        stdout.write(f"OK {len(payload)}\n".encode("ascii"))
        stdout.write(payload)
        stdout.flush()


def maybe_run_worker(argv) -> bool:
    """Called at the very top of the entrypoint. Returns True if it handled
    worker mode (caller should then exit immediately)."""
    if len(argv) >= 2 and argv[1] == BATCH_ARG:
        os._exit(run_batch_worker())  # os._exit: skip atexit/cleanup in worker
    if len(argv) >= 3 and argv[1] == WORKER_ARG:
        os._exit(run_worker(argv[2]))
    return False


# ── Parent side ───────────────────────────────────────────────────────────────

def _worker_command():
    if getattr(sys, "frozen", False) or hasattr(sys, "_MEIPASS"):
        return [sys.executable, BATCH_ARG], None
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join(
        [str(_REPO_ROOT), env.get("PYTHONPATH", "")]
    ).strip(os.pathsep)
    return [sys.executable, "-m", "app.pdf_extract", BATCH_ARG], env


class _BatchExtractor:
    """Owns the batch worker process and speaks its framed stdio protocol."""

    def __init__(self) -> None:
        self._proc: Optional[subprocess.Popen] = None
        self._jobs_done = 0
        self._lock = threading.Lock()

    def _ensure_worker(self) -> subprocess.Popen:
        if self._proc is not None and self._proc.poll() is None:
            if self._jobs_done < _MAX_JOBS_PER_WORKER:
                return self._proc
            self._stop(graceful=True)
        cmd, env = _worker_command()
        self._proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=env,
        )
        self._jobs_done = 0
        return self._proc

    def _stop(self, graceful: bool = False) -> None:
        proc, self._proc = self._proc, None
        if proc is None:
            return
        try:
            if graceful and proc.poll() is None:
                proc.stdin.close()  # EOF → worker exits its loop
                try:
                    proc.wait(timeout=3)
                    return
                except subprocess.TimeoutExpired:
                    pass
            proc.kill()
            proc.wait(timeout=3)
        except Exception:  # noqa: BLE001 - best-effort cleanup
            pass

    def _read_response(self, proc: subprocess.Popen):
        header = proc.stdout.readline()
        if not header:
            return None  # EOF: worker crashed or was killed
        header_text = header.decode("utf-8", errors="replace").strip()
        if header_text.startswith("OK "):
            try:
                length = int(header_text[3:])
            except ValueError:
                return ("err", f"malformed worker response: {header_text[:80]}")
            payload = proc.stdout.read(length) if length else b""
            if payload is None or len(payload) < length:
                return None  # worker died mid-payload
            return ("ok", payload.decode("utf-8", errors="replace"))
        if header_text.startswith("ERR "):
            return ("err", header_text[4:])
        return ("err", f"malformed worker response: {header_text[:80]}")

    def extract(self, pdf_path: str, timeout: float) -> Tuple[str, str]:
        with self._lock:
            try:
                proc = self._ensure_worker()
                proc.stdin.write(pdf_path.encode("utf-8", errors="replace") + b"\n")
                proc.stdin.flush()
            except Exception as exc:  # noqa: BLE001 - spawn/pipe failure
                self._stop()
                logger.warning("PDF extraction worker error for %s: %s", pdf_path, exc)
                return "", f"worker spawn error: {exc}"

            result_box: list = []
            reader = threading.Thread(
                target=lambda: result_box.append(self._read_response(proc)),
                daemon=True,
            )
            reader.start()
            reader.join(timeout)

            if reader.is_alive():
                # Hung or too slow: kill the worker (unblocks the reader via EOF).
                self._stop()
                reader.join(5)
                logger.warning("PDF extraction timed out (%ss): %s", timeout, pdf_path)
                return "", f"timeout after {timeout}s"

            response = result_box[0] if result_box else None
            if response is None:
                returncode = proc.poll()
                self._stop()
                reason = (
                    f"native crash (signal {-returncode})"
                    if returncode is not None and returncode < 0
                    else f"worker exited (code {returncode})"
                )
                logger.warning("PDF extraction failed for %s: %s", pdf_path, reason)
                return "", reason

            self._jobs_done += 1
            status, value = response
            if status == "ok":
                return value, ""
            logger.warning("PDF extraction failed for %s: %s", pdf_path, value)
            return "", value

    def shutdown(self) -> None:
        with self._lock:
            self._stop(graceful=True)


_extractor = _BatchExtractor()


def safe_extract_pdf_fulltext(
    pdf_path, timeout: float = _DEFAULT_TIMEOUT
) -> Tuple[str, str]:
    """Extract full text from a PDF in the isolated worker process.

    Returns ``(text, error)``. On success ``error`` is empty. On any failure
    (native crash, timeout, clean error) ``text`` is empty and ``error`` carries
    a short reason — the caller should flag the item and continue.
    """
    return _extractor.extract(str(pdf_path), timeout)


def shutdown_pdf_worker() -> None:
    """Stop the batch worker (called when a sync finishes) so no extra process
    outlives the work."""
    _extractor.shutdown()


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == BATCH_ARG:
        os._exit(run_batch_worker())
    os._exit(run_worker(sys.argv[1]) if len(sys.argv) > 1 else 2)
