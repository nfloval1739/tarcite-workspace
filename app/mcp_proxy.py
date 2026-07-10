"""stdio → streamable-HTTP proxy for the MCP server.

Every MCP client session that launches ``--mcp-stdio`` gets a complete second
copy of the app: its own SQLite/ChromaDB handles and, on the first search, a
private ~1.3 GB embedding model — duplicating what the running desktop app
already holds in memory (measured: ~860 MB resident per Claude session).

When the desktop app is running, this proxy forwards the whole stdio session
to its ``/mcp`` streamable-HTTP endpoint instead: identical tools, one model
stack, near-zero footprint per client. Standalone in-process serving remains
the fallback when the app is closed.

The tarcite MCP surface is tools-only, so the proxy forwards ``tools/list``
and ``tools/call`` (results pass through as-is, preserving structured content
and error flags) and advertises only the tools capability.
"""

import logging
import os
import sys
import threading
import time
from typing import Optional

logger = logging.getLogger(__name__)


class ProxyUnavailableError(RuntimeError):
    """Raised when the running app's /mcp endpoint cannot be reached *before*
    any stdio traffic has been served — the caller may still fall back to the
    standalone stdio server. Failures after serving starts must NOT fall back
    (the client's session state would be inconsistent); they end the process
    and the client simply respawns."""


def detect_running_app_mcp_url(timeout: float = 2.0) -> Optional[str]:
    """Return the running desktop app's local /mcp URL, or None.

    Probes the configured port first, then the app defaults — the environment
    that spawned this stdio process (e.g. a dev .env with APP_PORT=443) does
    not necessarily match the port the desktop app actually listens on."""
    try:
        import httpx

        from app.config import config

        scheme = "https" if config.use_https else "http"
        ports = list(dict.fromkeys([config.app_port, 4443, 443]))
    except Exception:  # noqa: BLE001 - config unavailable → no proxy
        return None

    for port in ports:
        base = f"{scheme}://127.0.0.1:{port}"
        try:
            # verify=False: the app serves a local mkcert-style certificate and
            # we only ever talk to 127.0.0.1.
            resp = httpx.get(f"{base}/api/mcp/status", timeout=timeout, verify=False)
            if resp.status_code != 200:
                continue
            data = resp.json()
            if not data.get("active"):
                continue
            return data.get("local_http_url") or f"{base}/mcp"
        except Exception:  # noqa: BLE001 - try the next candidate port
            continue
    return None


def start_orphan_watchdog(poll_seconds: float = 30.0) -> None:
    """Exit when the MCP client that spawned us is gone. Stdio EOF normally
    ends the server, but orphaned ``--mcp-stdio`` processes from dead client
    sessions have been observed lingering for days — this is the backstop."""
    if sys.platform == "win32":
        return  # getppid semantics differ; rely on stdio EOF there

    def _watch() -> None:
        while True:
            try:
                if os.getppid() == 1:
                    os._exit(0)
            except Exception:  # noqa: BLE001 - never take the server down
                return
            time.sleep(poll_seconds)

    threading.Thread(target=_watch, name="mcp-orphan-watchdog", daemon=True).start()


def run_stdio_proxy(url: str) -> None:
    """Serve MCP over stdio, forwarding every request to *url*.

    Raises :class:`ProxyUnavailableError` if the backend cannot be connected
    before stdio serving begins; returns normally when the client disconnects.
    """
    import anyio

    anyio.run(_serve_proxy, url)


async def _serve_proxy(url: str) -> None:
    import httpx
    import mcp.types as types
    from mcp import ClientSession
    from mcp.client.streamable_http import streamablehttp_client
    from mcp.server.lowlevel import Server
    from mcp.server.stdio import stdio_server

    def _local_client_factory(headers=None, timeout=None, auth=None) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            headers=headers, timeout=timeout, auth=auth,
            verify=False, follow_redirects=True,
        )

    try:
        backend_cm = streamablehttp_client(
            url,
            timeout=120,          # generous per-request budget: a cold search
            sse_read_timeout=86400,  # reloads models in the app (~10-30 s)
            httpx_client_factory=_local_client_factory,
        )
        read_stream, write_stream, _ = await backend_cm.__aenter__()
    except Exception as exc:  # noqa: BLE001 - connect phase: fallback allowed
        raise ProxyUnavailableError(str(exc)) from exc

    try:
        async with ClientSession(read_stream, write_stream) as backend:
            try:
                init = await backend.initialize()
            except Exception as exc:  # noqa: BLE001 - still pre-serve
                raise ProxyUnavailableError(str(exc)) from exc

            proxy = Server(init.serverInfo.name, instructions=init.instructions)

            @proxy.list_tools()
            async def _list_tools() -> list:
                result = await backend.list_tools()
                return result.tools

            # validate_input=False: the app validates; double-validation would
            # only add a failure mode if schemas ever drift mid-session.
            @proxy.call_tool(validate_input=False)
            async def _call_tool(name: str, arguments: dict) -> types.CallToolResult:
                return await backend.call_tool(name, arguments or {})

            logger.info("MCP stdio proxying to %s (%s)", url, init.serverInfo.name)
            async with stdio_server() as (stdio_read, stdio_write):
                await proxy.run(
                    stdio_read, stdio_write, proxy.create_initialization_options()
                )
    finally:
        try:
            await backend_cm.__aexit__(None, None, None)
        except Exception:  # noqa: BLE001 - backend may already be gone
            pass
