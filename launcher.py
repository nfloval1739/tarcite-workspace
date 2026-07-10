"""
Entry point for the packaged TarCite Workspace app.
Starts Ollama + FastAPI server, then opens a native pywebview window.
"""

import multiprocessing
import os
import ssl
import sys
import threading
import time
import traceback
import urllib.request
from pathlib import Path


def get_user_data_dir() -> Path:
    if sys.platform == "darwin":
        app_support = Path.home() / "Library" / "Application Support"
        base = app_support / "TarCiteWorkspace"
        legacy_base = app_support / "CitationWorkspace"
    elif sys.platform == "win32":
        appdata = Path(os.environ.get("APPDATA", str(Path.home())))
        base = appdata / "TarCiteWorkspace"
        legacy_base = appdata / "CitationWorkspace"
    else:
        base = Path.home() / ".citation-workspace"
        legacy_base = base
    if not base.exists() and legacy_base.exists():
        base = legacy_base
    base.mkdir(parents=True, exist_ok=True)
    return base


def get_bundle_dir() -> Path:
    if hasattr(sys, "_MEIPASS"):
        return Path(sys._MEIPASS)
    return Path(__file__).parent


def setup_environment():
    bundle_dir = get_bundle_dir()
    user_data = get_user_data_dir()

    os.environ.setdefault("ANONYMIZED_TELEMETRY", "False")
    os.environ.setdefault("CHROMA_ANONYMIZED_TELEMETRY", "False")

    models_dir = bundle_dir / "models"
    if models_dir.exists():
        os.environ.setdefault("HF_HOME", str(models_dir))
        os.environ.setdefault("SENTENCE_TRANSFORMERS_HOME", str(models_dir / "sentence_transformers"))
        os.environ.setdefault("TRANSFORMERS_CACHE", str(models_dir / "hub"))
        os.environ.setdefault("HF_DATASETS_CACHE", str(models_dir / "datasets"))

    ollama_models_dir = bundle_dir / "ollama_models"
    if ollama_models_dir.exists():
        os.environ.setdefault("OLLAMA_MODELS", str(ollama_models_dir))
    # Minimal build: no bundled ollama_models → OLLAMA_MODELS stays unset so
    # the system Ollama (if installed) uses its default ~/.ollama/models directory,
    # which is also where _install_ollama_blob writes for minimal installs.

    # For minimal builds: point HF loaders at user's previously-downloaded models
    user_models = user_data / "data" / "models"
    if not models_dir.exists() and user_models.exists():
        os.environ.setdefault("HF_HOME", str(user_models))
        os.environ.setdefault("SENTENCE_TRANSFORMERS_HOME", str(user_models / "sentence_transformers"))
        os.environ.setdefault("TRANSFORMERS_CACHE", str(user_models / "hub"))
        os.environ.setdefault("HF_DATASETS_CACHE", str(user_models / "datasets"))

    os.environ["CITATION_DATA_DIR"] = str(user_data / "data")


def _get_log_file() -> Path:
    log_dir = get_user_data_dir() / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    return log_dir / "launcher.log"


def _log(message: str) -> None:
    try:
        ts = time.strftime("%Y-%m-%d %H:%M:%S")
        with _get_log_file().open("a", encoding="utf-8") as f:
            f.write(f"{ts} {message}\n")
    except Exception:
        pass


# ── Ollama ────────────────────────────────────────────────────────────────────
# Lifecycle lives in app.ollama_manager (shared with on-demand starts from
# ai_client). At launch, Ollama is only started when the active AI profile
# actually points at local Ollama; remote profiles skip it entirely and the
# manager starts it on demand if the user switches to a local profile later.

_tray_icon = None


def _start_ollama() -> None:
    try:
        from app.ollama_manager import active_profile_is_local, ensure_running

        if not active_profile_is_local():
            _log("Ollama not started (active AI profile is remote); will start on demand")
            return
        ready = ensure_running(replace_stale=True)
        _log(f"Ollama startup: {'ready' if ready else 'unavailable'}")
    except Exception:
        _log("Failed to start Ollama:\n" + traceback.format_exc())


def _stop_ollama() -> None:
    try:
        from app.ollama_manager import stop

        stop()
    except Exception:
        pass


# ── FastAPI server ────────────────────────────────────────────────────────────

def _run_server(host: str, port: int, ssl_cert: str = "", ssl_key: str = "") -> None:
    import uvicorn
    kwargs = dict(app="app.main:app", host=host, port=port,
                  log_level="warning", loop="asyncio")
    if ssl_cert and ssl_key:
        kwargs["ssl_certfile"] = ssl_cert
        kwargs["ssl_keyfile"] = ssl_key
    _log(f"Starting FastAPI on {host}:{port} https={bool(ssl_cert and ssl_key)}")
    try:
        uvicorn.run(**kwargs)
    except BaseException:
        _log("FastAPI server stopped with an error:\n" + traceback.format_exc())
        raise


def _wait_for_server(host: str, port: int, timeout: float = 30.0) -> bool:
    import socket
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection((host, port), timeout=1):
                return True
        except OSError:
            time.sleep(0.3)
    return False


def _url_is_ready(url: str, timeout: float = 2.0) -> bool:
    ctx = ssl._create_unverified_context() if url.startswith("https://") else None
    try:
        with urllib.request.urlopen(url, timeout=timeout, context=ctx) as response:
            return 200 <= response.status < 500
    except Exception:
        return False


def _candidate_urls(config) -> list[str]:
    urls: list[str] = []
    if config.use_https:
        external_port = getattr(config, "app_external_port", 443)
        external_port_part = "" if external_port == 443 else f":{external_port}"
        urls.append(f"https://{config.app_display_host}{external_port_part}")
        urls.append(f"https://127.0.0.1:{config.app_port}")
    urls.append(f"http://{config.app_host}:{config.app_port}")

    deduped: list[str] = []
    for url in urls:
        if url not in deduped:
            deduped.append(url)
    return deduped


def _wait_for_any_server(config, timeout: float = 90.0) -> str | None:
    urls = _candidate_urls(config)
    deadline = time.time() + timeout
    while time.time() < deadline:
        for url in urls:
            if _url_is_ready(url):
                _log(f"Server is ready at {url}")
                return url
        time.sleep(0.3)
    _log(f"Timed out waiting for server. Tried: {', '.join(urls)}")
    return None


# ── Menu bar status item ──────────────────────────────────────────────────────

def _build_tray_image():
    from PIL import Image

    for name in ("TarCite_logo_250.png", "TarCite_logo.png", "android-chrome-512x512.png"):
        icon_path = get_bundle_dir() / "app" / "static" / "logo" / name
        if icon_path.exists():
            logo = Image.open(icon_path).convert("RGBA")
            bg = Image.new("RGBA", logo.size, (0, 22, 65, 255))
            bg.alpha_composite(logo)
            return bg.resize((64, 64), Image.LANCZOS)

    return Image.new("RGBA", (64, 64), (0, 22, 65, 255))


def _start_menu_bar_icon(window, get_ready_url) -> None:
    global _tray_icon
    try:
        import pystray

        def open_window(_icon=None, _item=None):
            try:
                if hasattr(window, "show"):
                    window.show()
                if hasattr(window, "restore"):
                    window.restore()
                ready_url = get_ready_url()
                if ready_url:
                    window.load_url(ready_url)
            except Exception:
                _log("Could not open window from menu bar:\n" + traceback.format_exc())

        def quit_app(icon=None, _item=None):
            try:
                if icon:
                    icon.stop()
            except Exception:
                pass
            try:
                if hasattr(window, "destroy"):
                    window.destroy()
            except Exception:
                pass
            _stop_ollama()
            _mark_clean_shutdown()
            os._exit(0)

        menu = pystray.Menu(
            pystray.MenuItem("Open TarCite Workspace", open_window, default=True),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Quit TarCite Workspace", quit_app),
        )
        _tray_icon = pystray.Icon(
            "TarCiteWorkspace",
            _build_tray_image(),
            "TarCite Workspace",
            menu,
        )
        _tray_icon.run_detached()
        _log("Menu bar status item started")
    except Exception:
        _log("Could not start menu bar status item:\n" + traceback.format_exc())


def _mark_clean_shutdown() -> None:
    """Record a clean exit so the next launch can skip the crash-recovery
    Chroma probe (a full frozen-binary re-spawn)."""
    try:
        from app.index_health import mark_clean_shutdown

        mark_clean_shutdown()
    except Exception:
        _log("Could not write clean-shutdown marker:\n" + traceback.format_exc())


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    multiprocessing.freeze_support()

    # Crash-isolated workers: when re-invoked in a worker mode, do only that and
    # exit, before any heavy startup. Keeps native MuPDF/Chroma aborts out of the
    # main app process.
    from app.pdf_extract import maybe_run_worker as _maybe_pdf_worker
    from app.index_health import maybe_run_worker as _maybe_chroma_worker
    _maybe_pdf_worker(sys.argv)
    _maybe_chroma_worker(sys.argv)

    # MCP stdio mode: serve the local library as MCP tools over stdin/stdout and
    # exit. This is the entry point an MCP client (Claude Desktop, etc.) launches.
    # Works for both the frozen app binary and `python launcher.py --mcp-stdio`,
    # so the command is correct wherever the app is installed.
    if "--mcp-stdio" in sys.argv:
        setup_environment()
        from app.mcp_server import main as _mcp_stdio_main
        _mcp_stdio_main()
        return

    setup_environment()
    _log("Launcher starting")

    from app.config import config

    # Start Ollama in background — non-blocking, app works even if it's slow
    threading.Thread(target=_start_ollama, daemon=True).start()

    # Start FastAPI server in background
    server_args = (config.app_host, config.app_port)
    server_kwargs = {}
    if config.use_https:
        server_kwargs = dict(ssl_cert=config.ssl_cert, ssl_key=config.ssl_key)
    threading.Thread(
        target=_run_server, args=server_args, kwargs=server_kwargs, daemon=True
    ).start()

    import webview

    LOADING_HTML = """<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>TarCite Workspace</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    background: #071521; color: #c8d8e8;
    font-family: -apple-system, sans-serif;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    height: 100vh; gap: 20px;
  }
  .logo { width: 80px; height: 80px; border-radius: 18px; }
  .spinner {
    width: 32px; height: 32px;
    border: 3px solid #1a3a5c;
    border-top-color: #4a90d9;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  p { font-size: 15px; opacity: 0.6; }
</style>
</head>
<body>
  <div class="spinner"></div>
  <p>Starting TarCite Workspace…</p>
</body>
</html>"""

    window = webview.create_window(
        "TarCite Workspace",
        html=LOADING_HTML,
        width=1440,
        height=900,
        min_size=(900, 600),
        text_select=True,
    )
    ready_url_holder = {"url": ""}

    def navigate_when_ready():
        ready_url = _wait_for_any_server(config, timeout=90)
        if ready_url:
            ready_url_holder["url"] = ready_url
            window.load_url(ready_url)

    threading.Thread(target=navigate_when_ready, daemon=True).start()
    _start_menu_bar_icon(window, lambda: ready_url_holder["url"])

    webview.start()

    # Window closed: stop Ollama (it used to linger until the next launch's
    # stale-process sweep), record a clean exit, and end the process rather
    # than leaving a headless server + tray thread behind.
    _stop_ollama()
    _mark_clean_shutdown()
    os._exit(0)


if __name__ == "__main__":
    main()
