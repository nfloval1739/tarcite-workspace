"""
FastAPI application — routes and startup.
Workspace version: 3-pane citation research workspace.

All heavy/blocking operations run in thread-pool executors.
"""

import logging
import threading
import time
from pathlib import Path
from typing import Any, Dict

from fastapi import BackgroundTasks, FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from app.config import config, get_device_id
from app.database import (
    init_db,
    backfill_source_dirs,
    is_source_dir_backfilled,
    reconcile_item_collections,
)
from app.citation_counts import refresh_crossref_counts_for_library
from app.word_connector_api import router as word_router
from app.routers.annotations import router as annotations_router
from app.routers.backup import router as backup_router
from app.routers.billing import router as billing_router
from app.routers.chat import router as chat_router
from app.routers.citations import router as citations_router
from app.routers.citation_graph import router as citation_graph_router
from app.routers.content import router as content_router
from app.routers.export import router as export_router
from app.routers.files import router as files_router
from app.routers.history import router as history_router
from app.routers.imports import router as imports_router
from app.routers.items import router as items_router
from app.routers.library import router as library_router
from app.routers.library_health import router as library_health_router
from app.routers.packages import router as packages_router
from app.routers.projects import router as projects_router
from app.routers.relevance import router as relevance_router
from app.routers.search import router as search_router
from app.routers.settings import router as settings_router
from app.routers.sync import router as sync_router
from app.routers.tags import router as tags_router
from app.routers.translation import router as translation_router

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)
SLOW_API_THRESHOLD_MS = 500.0

BASE_DIR = Path(__file__).parent
STATIC_DIR = BASE_DIR / "static"
TEMPLATES_DIR = BASE_DIR / "templates"
WORD_ADDIN_DIR = BASE_DIR.parent / "word-addin"

app = FastAPI(title="TarCite Workspace", version="0.2.36")

@app.middleware("http")
async def _no_cache_static(request: Request, call_next):
    started_at = time.perf_counter()
    response = await call_next(request)
    elapsed_ms = (time.perf_counter() - started_at) * 1000

    if request.url.path.startswith("/api/"):
        response.headers["X-Process-Time-Ms"] = f"{elapsed_ms:.1f}"
        if elapsed_ms >= SLOW_API_THRESHOLD_MS:
            logger.info(
                "Perf | %s %s -> %s took %.1f ms",
                request.method,
                request.url.path,
                response.status_code,
                elapsed_ms,
            )

    if request.url.path.startswith("/static/") and request.url.path.endswith((".js", ".css")):
        response.headers["Cache-Control"] = "no-cache, must-revalidate"
        response.headers["Pragma"] = "no-cache"
    return response

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
app.mount("/word-addin", StaticFiles(directory=str(WORD_ADDIN_DIR)), name="word-addin")
templates = Jinja2Templates(directory=str(TEMPLATES_DIR))
app.include_router(word_router)
app.include_router(settings_router)
app.include_router(library_router)
app.include_router(library_health_router)
app.include_router(backup_router)
app.include_router(sync_router)
app.include_router(citation_graph_router)
app.include_router(items_router)
app.include_router(annotations_router)
app.include_router(tags_router)
app.include_router(projects_router)
app.include_router(history_router)
app.include_router(files_router)
app.include_router(export_router)
app.include_router(packages_router)
app.include_router(translation_router)
app.include_router(billing_router)
app.include_router(imports_router)
app.include_router(content_router)
app.include_router(search_router)
app.include_router(relevance_router)
app.include_router(citations_router)
app.include_router(chat_router)


# ── MCP server (Option B: streamable-HTTP at /mcp) ──────────────────────────────
# Exposes the local library as MCP tools at http(s)://<host>/mcp for HTTP-capable
# clients, sharing this process's SQLite + ChromaDB. Fully guarded: if the `mcp`
# package is unavailable or wiring fails, the rest of the app is unaffected.
#
# We register FastMCP's own Route directly on the main app (rather than mounting a
# sub-app) so POST /mcp is served in a single hop with no trailing-slash redirect.
# Starlette does not propagate lifespans to embedded apps, so the streamable
# session manager is started/stopped via dedicated startup/shutdown handlers.
from app.config import config as _app_config

_mcp_enabled = False
if not _app_config.mcp_enabled:
    logger.info("MCP endpoint disabled (Settings → MCP Server, or MCP_ENABLED env)")
else:
    try:
        from app.mcp_server import mcp as _mcp_server

        _mcp_http_app = _mcp_server.streamable_http_app()  # builds the session manager
        # Splice FastMCP's route(s) (a single Route at "/mcp") into the main app.
        app.router.routes.extend(_mcp_http_app.routes)
        _mcp_enabled = True
    except Exception as exc:  # pragma: no cover - optional feature
        logger.warning("MCP endpoint not registered: %s", exc)

# Live state for the Settings UI (/api/mcp/status): whether /mcp is active now.
app.state.mcp_active = _mcp_enabled


if _mcp_enabled:
    import contextlib as _contextlib

    @app.on_event("startup")
    async def _start_mcp_session_manager() -> None:
        stack = _contextlib.AsyncExitStack()
        await stack.enter_async_context(_mcp_server.session_manager.run())
        app.state._mcp_stack = stack
        logger.info("MCP endpoint ready at /mcp")

    @app.on_event("shutdown")
    async def _stop_mcp_session_manager() -> None:
        stack = getattr(app.state, "_mcp_stack", None)
        if stack is not None:
            await stack.aclose()


@app.on_event("startup")
def on_startup() -> None:
    init_db()
    _run_backfill_if_needed()
    try:
        reconcile_item_collections()  # self-heal folder membership drift
    except Exception as exc:
        logger.warning("item_collections reconcile failed: %s", exc)
    # Eager preload burns ~1 min of CPU per launch loading bge-large + the
    # reranker; default off — models load lazily on first search/sync instead.
    if config.preload_models:
        threading.Thread(target=_preload_models, daemon=True).start()
    threading.Thread(target=_register_ciwork_device, daemon=True).start()
    threading.Thread(target=refresh_crossref_counts_for_library, daemon=True).start()
    threading.Thread(target=_auto_heal_vectors, daemon=True).start()
    logger.info("TarCite Workspace ready at http%s://%s:%s", "s" if config.use_https else "", config.app_host, config.app_port)


@app.on_event("shutdown")
def _record_clean_shutdown() -> None:
    from app.index_health import mark_clean_shutdown

    mark_clean_shutdown()


def _auto_heal_vectors() -> None:
    """Self-repair the vector store on startup. First a crash-isolated health
    probe (catches corruption that segfaults on read); then the size-based guard
    inside get_chroma_client. If either quarantines the index, rebuild it from
    surviving FTS chunks (no PDF reads) so the library heals silently."""
    try:
        from app.embeddings import (
            get_chroma_client,
            chroma_index_was_quarantined,
            force_quarantine_chroma_index,
        )
        from app.index_health import chroma_index_is_healthy, consume_clean_shutdown_marker

        # The subprocess probe is a full frozen-binary re-spawn; only pay for
        # it when the previous session did not exit cleanly (crash/power loss —
        # the only realistic sources of read-segfault corruption).
        if not consume_clean_shutdown_marker() and not chroma_index_is_healthy():
            force_quarantine_chroma_index("startup health probe failed")

        get_chroma_client()  # triggers the size-based corruption guard
        if not chroma_index_was_quarantined():
            return

        logger.warning("Vector index was quarantined — auto-rebuilding from FTS…")
        from app.sync import fill_chromadb_gaps
        result = fill_chromadb_gaps()
        logger.warning("Vector auto-heal complete: %s", result)
    except Exception as exc:
        logger.error("Vector auto-heal failed: %s", exc)


def _register_ciwork_device() -> None:
    from app.config import _register_device
    device_id = get_device_id()
    _register_device(device_id)
    logger.info("TarCite device ready: %s", device_id)


def _run_backfill_if_needed() -> None:
    if is_source_dir_backfilled():
        return
    dir_paths = [d.get("path", "") for d in config.reference_dirs if d.get("path")]
    if not dir_paths:
        return
    try:
        updated = backfill_source_dirs(dir_paths)
        if updated > 0:
            logger.info("Backfilled source_dir for %d existing items", updated)
    except Exception as exc:
        logger.warning("Source_dir backfill failed: %s", exc)


def _preload_models() -> None:
    try:
        from app.embeddings import _get_local_model
        _get_local_model()
        logger.info("Embedding model preloaded")
    except Exception as exc:
        logger.warning("Could not preload embedding model: %s", exc)
    try:
        from app.reranker import _get_reranker
        _get_reranker(config.reranker_model)
        logger.info("Reranker model preloaded")
    except Exception as exc:
        logger.warning("Could not preload reranker model: %s", exc)


# ── Frontend ──────────────────────────────────────────────────────────────────


@app.get("/", response_class=HTMLResponse)
async def root(request: Request) -> HTMLResponse:
    return templates.TemplateResponse(request, "index.html")
