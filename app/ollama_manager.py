"""Lifecycle management for the bundled Ollama server.

Historically the launcher started Ollama at every app launch, even when the
active AI profile is a remote API and no local inference will happen. Ollama
is now started lazily:

* at launch, only when the active profile actually points at local Ollama
  (same stale-instance sweep + fresh start as before);
* on demand, when an AI request targets local Ollama and nothing is serving
  the port yet (e.g. the user switched to a local profile mid-session).

Used by both the packaged launcher and dev mode; all functions are safe to
call when no Ollama binary is bundled (they just report unavailability).
"""

import logging
import os
import signal
import socket
import subprocess
import sys
import threading
import time
import traceback
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

OLLAMA_HOST = "127.0.0.1"
OLLAMA_PORT = 11434

_lock = threading.Lock()
_proc: Optional[subprocess.Popen] = None


def url_is_local_ollama(url: str) -> bool:
    u = (url or "").lower()
    return f"127.0.0.1:{OLLAMA_PORT}" in u or f"localhost:{OLLAMA_PORT}" in u


def active_profile_is_local() -> bool:
    from app.config import config

    return url_is_local_ollama(config.ai_api_base_url)


def is_running(timeout: float = 0.5) -> bool:
    try:
        with socket.create_connection((OLLAMA_HOST, OLLAMA_PORT), timeout=timeout):
            return True
    except OSError:
        return False


def _bundle_dir() -> Path:
    if hasattr(sys, "_MEIPASS"):
        return Path(sys._MEIPASS)
    return Path(__file__).resolve().parent.parent


def find_binary() -> Optional[Path]:
    name = "ollama.exe" if sys.platform == "win32" else "ollama"
    candidates = [_bundle_dir() / "ollama" / name]
    if not (getattr(sys, "frozen", False) or hasattr(sys, "_MEIPASS")):
        repo = Path(__file__).resolve().parent.parent
        candidates += [
            repo / "packaging" / "ollama_mac" / name,
            repo / "packaging" / "ollama" / name,
        ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    import shutil

    which = shutil.which(name)
    return Path(which) if which else None


def kill_stale() -> None:
    """Terminate any Ollama already on the port before we start ours.

    Without this, a stale process from a previous app version (or a system
    install) keeps running with the wrong OLLAMA_MODELS path and our bundled
    models are never visible."""
    if sys.platform == "win32":
        return
    try:
        result = subprocess.run(
            ["lsof", "-ti", f"tcp:{OLLAMA_PORT}"], capture_output=True, text=True
        )
        for pid_str in result.stdout.strip().split():
            if not pid_str.isdigit():
                continue
            pid = int(pid_str)
            try:
                comm = subprocess.run(
                    ["ps", "-p", str(pid), "-o", "comm="],
                    capture_output=True, text=True,
                ).stdout.strip()
                if "ollama" in comm.lower():
                    os.kill(pid, signal.SIGTERM)
                    logger.info("Terminated stale Ollama PID %d (%s)", pid, comm)
            except Exception:  # noqa: BLE001 - best-effort per PID
                pass
        if result.stdout.strip():
            time.sleep(1.0)
    except Exception:  # noqa: BLE001 - sweep is best-effort
        pass


def ensure_running(replace_stale: bool = False, wait_seconds: float = 15.0) -> bool:
    """Make sure an Ollama server is reachable; start the bundled one if not.

    With ``replace_stale`` (launch path), any instance already on the port is
    killed first so ours runs with the correct OLLAMA_MODELS. Without it
    (on-demand path), an existing server is accepted as-is."""
    global _proc
    if not replace_stale and is_running():
        return True
    with _lock:
        if replace_stale:
            kill_stale()
        elif is_running():
            return True

        binary = find_binary()
        if binary is None:
            logger.info("Ollama binary not found; local LLM unavailable")
            return False

        env = os.environ.copy()
        env.setdefault("OLLAMA_HOST", f"{OLLAMA_HOST}:{OLLAMA_PORT}")
        env.setdefault("OLLAMA_ORIGINS", "*")
        try:
            _proc = subprocess.Popen(
                [str(binary), "serve"], env=env,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            logger.info(
                "Started Ollama from %s (OLLAMA_MODELS=%s)",
                binary, env.get("OLLAMA_MODELS", "default"),
            )
        except Exception:  # noqa: BLE001 - report and carry on without local LLM
            logger.warning("Failed to start Ollama:\n%s", traceback.format_exc())
            return False

    deadline = time.time() + wait_seconds
    while time.time() < deadline:
        if is_running():
            return True
        time.sleep(0.3)
    return False


def stop() -> None:
    """Stop the Ollama instance we started (no-op for external instances)."""
    global _proc
    with _lock:
        proc, _proc = _proc, None
    if proc is not None:
        try:
            proc.terminate()
            proc.wait(timeout=5)
        except Exception:  # noqa: BLE001 - it may already be gone
            pass
