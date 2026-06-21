"""Settings, AI profile, and directory picker routes."""

import asyncio
import logging
import os
import platform
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import APIRouter, Request

from app.config import config, get_device_id, get_settings, save_settings
from app.local_scanner import test_directory
from app.schemas import (
    AddDirectoryRequest,
    AddProfileRequest,
    DirectoryTestRequest,
    RemoveDirectoryRequest,
    RemoveProfileRequest,
    SetActiveProfileRequest,
    SettingsUpdate,
    TestAIRequest,
    UpdateProfileRequest,
)

logger = logging.getLogger(__name__)
router = APIRouter(tags=["settings"])


@router.get("/api/settings")
def get_settings_route() -> Dict:
    settings = get_settings()
    masked = dict(settings)
    for key_field in ("ai_api_key",):
        raw = masked.get(key_field, "")
        if raw and len(raw) > 8:
            masked[key_field] = raw[:4] + "***" + raw[-4:]
        elif raw:
            masked[key_field] = "***"
    return masked


@router.post("/api/settings")
def update_settings_route(body: SettingsUpdate) -> Dict:
    current = get_settings()

    def _resolve_key(new_val: str, current_val: str) -> str:
        return current_val if "***" in new_val else new_val

    fields_set = body.model_fields_set
    suggestion_temperature = (
        body.suggestion_temperature
        if "suggestion_temperature" in fields_set
        else current.get("suggestion_temperature", 0.1)
    )
    chat_temperature = (
        body.chat_temperature
        if "chat_temperature" in fields_set
        else current.get("chat_temperature", 0.3)
    )
    suggestion_top_k = (
        body.suggestion_top_k
        if "suggestion_top_k" in fields_set
        else current.get("suggestion_top_k", 50)
    )

    new_settings = {
        "reference_dirs": body.reference_dirs if body.reference_dirs else current.get("reference_dirs", []),
        "ai_api_base_url": body.ai_api_base_url or current.get("ai_api_base_url", "https://api.openai.com/v1"),
        "ai_model": body.ai_model or current.get("ai_model", "qwen2.5:3b"),
        "embedding_model": body.embedding_model,
        "reranker_model": body.reranker_model,
        "crossref_mailto": (body.crossref_mailto or "") if "crossref_mailto" in fields_set else current.get("crossref_mailto", ""),
        "crossref_timeout_seconds": body.crossref_timeout_seconds if body.crossref_timeout_seconds is not None else current.get("crossref_timeout_seconds", 5),
        "embedding_provider": current.get("embedding_provider", "local"),
        "ai_api_key": _resolve_key(body.ai_api_key, current.get("ai_api_key", "")),
        "suggestion_temperature": suggestion_temperature,
        "suggestion_top_k": suggestion_top_k,
        "chat_temperature": chat_temperature,
        "ai_profiles": current.get("ai_profiles", []),
        "active_profile": current.get("active_profile", ""),
        "mcp_enabled": body.mcp_enabled if "mcp_enabled" in fields_set else current.get("mcp_enabled", True),
    }

    save_settings(new_settings)
    config.reload()
    return {"status": "saved", "message": "Settings saved successfully."}


@router.get("/api/mcp/status")
def mcp_status_route(request: Request) -> Dict:
    """Report MCP server state for the Settings UI: whether it's enabled (saved
    preference), whether the /mcp HTTP endpoint is live in this process, and the
    connection details for both transports."""
    import sys

    active = bool(getattr(request.app.state, "mcp_active", False))
    scheme = "https" if config.use_https else "http"
    host = config.app_display_host or config.app_host
    port = config.app_external_port
    netloc = host if (scheme == "https" and port == 443) else f"{host}:{port}"

    # The stdio command is computed live from the running process, so it is
    # always correct for wherever the app is actually installed (never a stored
    # path). Frozen (packaged) builds run the app binary with --mcp-stdio;
    # running from source uses the active interpreter with `-m app.mcp_server`.
    frozen = bool(getattr(sys, "frozen", False) or hasattr(sys, "_MEIPASS"))
    if frozen:
        stdio = {"command": sys.executable, "args": ["--mcp-stdio"]}
    else:
        stdio = {
            "command": sys.executable,
            "args": ["-m", "app.mcp_server"],
            "cwd": str(Path(__file__).resolve().parents[2]),
        }

    return {
        "enabled": config.mcp_enabled,
        "active": active,
        # The live endpoint only changes on restart, so flag when they differ.
        "restart_required": config.mcp_enabled != active,
        "frozen": frozen,
        "http_url": f"{scheme}://{netloc}/mcp",
        "local_http_url": f"{scheme}://127.0.0.1:{config.app_port}/mcp",
        "stdio": stdio,
        "tools": [
            "search_library", "suggest_citations", "get_item", "search_metadata",
            "format_citation", "format_bibliography", "list_collections", "library_stats",
        ],
    }


@router.post("/api/settings/add-directory")
def add_directory_route(body: AddDirectoryRequest) -> Dict:
    current = get_settings()
    dirs = current.get("reference_dirs", [])
    norm_path = str(Path(body.dir_path).expanduser().resolve())

    for directory in dirs:
        if str(Path(directory["path"]).expanduser().resolve()) == norm_path:
            return {"status": "error", "message": "This directory is already added."}

    dirs.append({"path": body.dir_path, "label": body.label})
    current["reference_dirs"] = dirs
    save_settings(current)
    config.reload()
    return {"status": "saved", "message": "Directory added.", "reference_dirs": dirs}


@router.post("/api/settings/remove-directory")
def remove_directory_route(body: RemoveDirectoryRequest) -> Dict:
    current = get_settings()
    dirs = current.get("reference_dirs", [])
    norm_path = str(Path(body.dir_path).expanduser().resolve())
    new_dirs = [d for d in dirs if str(Path(d["path"]).expanduser().resolve()) != norm_path]

    if len(new_dirs) == len(dirs):
        return {"status": "error", "message": "Directory not found in settings."}

    if body.delete_items:
        from app.database import delete_items_for_dir
        from app.embeddings import delete_item_chunks, get_chroma_client, get_or_create_collection

        old_keys = delete_items_for_dir(norm_path)
        if old_keys:
            try:
                client = get_chroma_client()
                collection = get_or_create_collection(client)
                for item_key in old_keys:
                    delete_item_chunks(collection, item_key)
            except Exception as exc:
                logger.warning("Could not clean up ChromaDB for removed dir: %s", exc)

    current["reference_dirs"] = new_dirs
    save_settings(current)
    config.reload()
    return {"status": "saved", "message": "Directory removed.", "reference_dirs": new_dirs}


@router.get("/api/directories")
def list_directories() -> Dict:
    current = get_settings()
    return {"directories": current.get("reference_dirs", [])}


@router.get("/api/directories/{dir_path:path}/subfolders")
def list_subfolders(dir_path: str) -> Dict:
    from app.local_scanner import get_subfolders_recursive

    target = Path(dir_path).expanduser().resolve()
    if not target.exists() or not target.is_dir():
        return {"folders": []}
    folders = get_subfolders_recursive(target)
    return {
        "folders": [
            {
                # collection_key is required by the Add File modal to pre-select the
                # folder the user is currently viewing; the scanner computes it the
                # same way sync does (md5 of the absolute path).
                "collection_key": f["collection_key"],
                "name": f["name"],
                "path": f["path"],
                "rel_path": f["rel_path"],
                "depth": f["depth"],
            }
            for f in folders
        ]
    }


@router.post("/api/settings/profiles/add")
def add_profile_route(body: AddProfileRequest) -> Dict:
    current = get_settings()
    profiles = current.get("ai_profiles", [])
    for profile in profiles:
        if profile["name"] == body.profile.name:
            return {"status": "error", "message": f"Profile '{body.profile.name}' already exists."}
    profiles.append(body.profile.model_dump())
    current["ai_profiles"] = profiles
    if len(profiles) == 1:
        current["active_profile"] = body.profile.name
    save_settings(current)
    config.reload()
    return {"status": "saved", "message": "Profile added.", "profiles": profiles, "active_profile": current.get("active_profile", "")}


@router.post("/api/settings/profiles/update")
def update_profile_route(body: UpdateProfileRequest) -> Dict:
    current = get_settings()
    profiles = current.get("ai_profiles", [])
    found = False
    for i, profile in enumerate(profiles):
        if profile["name"] == body.old_name:
            profiles[i] = body.profile.model_dump()
            found = True
            break
    if not found:
        return {"status": "error", "message": f"Profile '{body.old_name}' not found."}
    current["ai_profiles"] = profiles
    if current.get("active_profile") == body.old_name:
        current["active_profile"] = body.profile.name
    save_settings(current)
    config.reload()
    return {"status": "saved", "message": "Profile updated.", "profiles": profiles, "active_profile": current.get("active_profile", "")}


@router.post("/api/settings/profiles/remove")
def remove_profile_route(body: RemoveProfileRequest) -> Dict:
    current = get_settings()
    profiles = current.get("ai_profiles", [])
    new_profiles = [p for p in profiles if p["name"] != body.name]
    if len(new_profiles) == len(profiles):
        return {"status": "error", "message": f"Profile '{body.name}' not found."}
    current["ai_profiles"] = new_profiles
    if current.get("active_profile") == body.name:
        current["active_profile"] = new_profiles[0]["name"] if new_profiles else ""
    save_settings(current)
    config.reload()
    return {"status": "saved", "message": "Profile removed.", "profiles": new_profiles, "active_profile": current.get("active_profile", "")}


@router.post("/api/settings/profiles/activate")
def activate_profile_route(body: SetActiveProfileRequest) -> Dict:
    current = get_settings()
    profiles = current.get("ai_profiles", [])
    found = any(p["name"] == body.name for p in profiles)
    if not found:
        return {"status": "error", "message": f"Profile '{body.name}' not found."}
    current["active_profile"] = body.name
    save_settings(current)
    config.reload()
    return {"status": "saved", "message": "Profile activated.", "active_profile": body.name}


@router.post("/api/settings/test-directory")
def test_directory_route(body: DirectoryTestRequest) -> Dict:
    return test_directory(body.dir_path)


@router.post("/api/settings/test-ai")
def test_ai_route(body: TestAIRequest) -> Dict:
    current = get_settings()

    def _resolve_key(new_val: str, current_val: str) -> str:
        return current_val if "***" in new_val else new_val

    api_key = _resolve_key(body.ai_api_key, current.get("ai_api_key", ""))
    if not api_key or "***" in api_key:
        profiles = current.get("ai_profiles", [])
        active = current.get("active_profile", "")
        for profile in profiles:
            if profile.get("name") == active:
                api_key = profile.get("ai_api_key", "")
                break

    base = body.ai_api_base_url.strip().rstrip("/")
    is_managed = "api.tarcite.com" in base

    if not api_key and not is_managed:
        return {"status": "error", "message": "API Key is required."}
    if not body.ai_model:
        return {"status": "error", "message": "Model name is required."}

    try:
        import re as _re
        from openai import OpenAI

        is_local = "localhost" in base or "127.0.0.1" in base
        timeout = 120.0 if is_local else 15.0
        kwargs: Dict[str, Any] = {"api_key": api_key or "free-tier", "timeout": timeout}
        if base and base != "https://api.openai.com/v1":
            kwargs["base_url"] = base
        if is_managed:
            kwargs["default_headers"] = {
                "X-Device-ID": get_device_id(),
                "User-Agent": "TarCiteWorkspace/1.0",
                "Accept-Encoding": "identity",
            }

        logger.info("Test AI: model=%s, base_url=%s", body.ai_model, base)
        client = OpenAI(**kwargs)

        create_kwargs: Dict[str, Any] = dict(
            model=body.ai_model,
            messages=[{"role": "user", "content": "Say hello in 3 words."}],
            temperature=0.1,
            max_tokens=200,
        )
        if is_local:
            create_kwargs["extra_body"] = {"think": False}

        response = client.chat.completions.create(**create_kwargs)
        choice = response.choices[0]
        msg = choice.message
        content = (getattr(msg, "content", "") or "").strip()
        reasoning = (getattr(msg, "reasoning_content", "") or getattr(msg, "thinking", "") or "").strip()
        finish = choice.finish_reason or "unknown"
        visible = _re.sub(r"<think>[\s\S]*?</think>", "", content).strip()

        logger.info(
            "Test AI: model=%s, finish=%s, content_len=%d, reasoning_len=%d",
            body.ai_model,
            finish,
            len(content),
            len(reasoning),
        )

        if visible or reasoning or content:
            return {"status": "ok", "message": f"Connection successful. Model '{body.ai_model}' responded correctly."}
        return {"status": "error", "message": f"Model returned empty content (finish_reason: {finish}). Try a different model."}
    except Exception as exc:
        err_msg = str(exc)
        logger.error("Test AI error: %s", exc, exc_info=True)
        if "401" in err_msg or "Unauthorized" in err_msg or "invalid_api_key" in err_msg.lower():
            return {"status": "error", "message": "Invalid API Key. Please check your key."}
        if "404" in err_msg or "not_found" in err_msg.lower() or "model_not_found" in err_msg.lower():
            return {"status": "error", "message": f"Model '{body.ai_model}' not found. Check the model name."}
        if "403" in err_msg or "Forbidden" in err_msg:
            return {"status": "error", "message": "Access denied. Check API key permissions or quota."}
        if "Connection" in err_msg or "timeout" in err_msg.lower() or "refused" in err_msg.lower():
            return {"status": "error", "message": f"Cannot reach API server. Check the Base URL: {base}"}
        return {"status": "error", "message": f"Error: {err_msg[:300]}"}


@router.post("/api/settings/browse")
def browse_directory_route() -> Dict:
    home = str(Path.home())
    common_dirs = [home]
    for directory in ["Documents", "Desktop", "Downloads"]:
        path = os.path.join(home, directory)
        if os.path.isdir(path):
            common_dirs.append(path)
    return {"home": home, "suggestions": common_dirs}


@router.get("/api/browse-folder")
async def browse_folder_route(start: str = "") -> Dict:
    """Open a native OS folder picker dialog and return the chosen path."""
    system = platform.system()
    start_path = start or str(Path.home())

    async def _run(*cmd: str) -> Optional[str]:
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            try:
                stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=120)
                if proc.returncode != 0:
                    return None
                return stdout.decode().strip() or None
            except asyncio.TimeoutError:
                proc.kill()
                return None
        except FileNotFoundError:
            return None

    try:
        if system == "Darwin":
            script = (
                f'set startFolder to POSIX file "{start_path}"\n'
                f'POSIX path of (choose folder default location startFolder)'
            )
            path = await _run("osascript", "-e", script)
            if not path:
                return {"cancelled": True, "path": None}
            return {"cancelled": False, "path": path.rstrip("/")}

        if system == "Windows":
            script = (
                "Add-Type -AssemblyName System.Windows.Forms;"
                "$d = New-Object System.Windows.Forms.FolderBrowserDialog;"
                f"$d.SelectedPath = '{start_path}';"
                "$d.ShowNewFolderButton = $true;"
                "if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath } else { '' }"
            )
            path = await _run("powershell", "-NoProfile", "-Command", script)
            return {"cancelled": not path, "path": path or None}

        path = await _run("zenity", "--file-selection", "--directory", f"--filename={start_path}/")
        if path is None:
            path = await _run("kdialog", "--getexistingdirectory", start_path)
        if path is None:
            return {"cancelled": True, "path": None, "error": "No folder picker found (install zenity or kdialog)"}
        return {"cancelled": False, "path": path}

    except Exception as exc:
        logger.error("browse_folder error: %s", exc)
        return {"cancelled": True, "path": None, "error": str(exc)}
