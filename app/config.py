"""
Configuration management.
Settings are stored in data/settings.json (preferred) with .env as fallback.
API keys are never exposed to the frontend.
"""

import json
import logging
import os
from pathlib import Path

from dotenv import load_dotenv

logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).parent.parent

# When running as a PyInstaller bundle, CITATION_DATA_DIR points to a
# user-writable location so data persists across app updates.
if os.environ.get("CITATION_DATA_DIR"):
    DATA_DIR = Path(os.environ["CITATION_DATA_DIR"])
else:
    DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)

ENV_FILE = BASE_DIR / ".env"
SETTINGS_FILE = DATA_DIR / "settings.json"

# .env is a dev convenience; bundled builds configure via the settings UI
if ENV_FILE.exists():
    load_dotenv(ENV_FILE)


DEFAULT_EMBEDDING_MODEL = "BAAI/bge-large-en-v1.5"
DEFAULT_RERANKER_MODEL = "BAAI/bge-reranker-base"
LEGACY_DEFAULT_RERANKER_MODEL = "cross-encoder/ms-marco-MiniLM-L-6-v2"


STANDARD_AI_PROFILES = [
    {
        "name": "Local (qwen2.5:3b)",
        "provider_label": "Local",
        "ai_api_base_url": "http://localhost:11434/v1",
        "ai_api_key": "ollama",
        "ai_model": "qwen2.5:3b",
        "suggestion_temperature": 0.1,
        "chat_temperature": 0.3,
        "suggestion_top_k": 10,
    },
    {
        "name": "TarCite (Default)",
        "provider_label": "TarCite",
        "ai_api_base_url": "https://api.tarcite.com/v1",
        "ai_api_key": "",
        "ai_model": "default",
        "suggestion_temperature": 0.1,
        "chat_temperature": 0.3,
        "suggestion_top_k": 40,
    },
    {
        "name": "TarCite (Premium)",
        "provider_label": "TarCite",
        "ai_api_base_url": "https://api.tarcite.com/v1",
        "ai_api_key": "",
        "ai_model": "premium",
        "suggestion_temperature": 0.05,
        "chat_temperature": 0.3,
        "suggestion_top_k": 15,
    },
]


def get_device_id() -> str:
    """Return a persistent install UUID."""
    device_id_file = DATA_DIR / "device_id.txt"
    if device_id_file.exists():
        return device_id_file.read_text().strip()
    import uuid as _uuid
    device_id = str(_uuid.uuid4())
    device_id_file.write_text(device_id)
    return device_id


_TARCITE_HEADERS = {
    "Content-Type": "application/json",
    "User-Agent": "TarCiteWorkspace/1.0",
}


def _register_device(device_id: str) -> None:
    """Best-effort registration with api.tarcite.com (non-blocking on error)."""
    try:
        import httpx as _httpx
        _httpx.post(
            "https://api.tarcite.com/register",
            json={"device_id": device_id},
            headers=_TARCITE_HEADERS,
            timeout=8.0,
        )
    except Exception as exc:
        logger.warning("Device registration with api.tarcite.com failed (non-fatal): %s", exc)


def _migrate_single_dir(settings: dict) -> dict:
    migrated = False
    if "reference_dirs" not in settings and settings.get("references_dir"):
        settings["reference_dirs"] = [
            {"path": settings["references_dir"], "label": ""}
        ]
        migrated = True
    elif "reference_dirs" not in settings:
        settings["reference_dirs"] = []
        migrated = True

    if not settings.get("embedding_model"):
        settings["embedding_model"] = DEFAULT_EMBEDDING_MODEL
        migrated = True
    if (
        not settings.get("reranker_model")
        or settings.get("reranker_model") == LEGACY_DEFAULT_RERANKER_MODEL
    ):
        settings["reranker_model"] = DEFAULT_RERANKER_MODEL
        migrated = True

    if "ai_profiles" not in settings:
        settings["ai_profiles"] = []
        if settings.get("ai_api_key"):
            settings["ai_profiles"].append({
                "name": "Default",
                "provider_label": "",
                "ai_api_base_url": settings.get("ai_api_base_url", "https://api.openai.com/v1"),
                "ai_api_key": settings.get("ai_api_key", ""),
                "ai_model": settings.get("ai_model", "qwen2.5:3b"),
                "suggestion_temperature": settings.get("suggestion_temperature", 0.1),
                "chat_temperature": settings.get("chat_temperature", 0.3),
                "suggestion_top_k": settings.get("suggestion_top_k", 50),
            })
            settings["active_profile"] = "Default"
        else:
            # Fresh install — three profiles pre-configured
            settings["ai_profiles"] = [dict(profile) for profile in STANDARD_AI_PROFILES]
            settings["active_profile"] = "Local (qwen2.5:3b)"
        migrated = True

    # Ensure the three standard profiles exist and carry the tuned suggestion defaults.
    profiles = settings.get("ai_profiles", [])
    existing_by_name = {p.get("name"): p for p in profiles}
    for profile in STANDARD_AI_PROFILES:
        existing = existing_by_name.get(profile["name"])
        if existing is None:
            profiles.append(dict(profile))
            migrated = True
            continue
        for key in ("suggestion_temperature", "suggestion_top_k"):
            if existing.get(key) != profile[key]:
                existing[key] = profile[key]
                migrated = True
    settings["ai_profiles"] = profiles

    return settings, migrated


def _float_env(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


def get_settings() -> dict:
    if SETTINGS_FILE.exists():
        try:
            with open(SETTINGS_FILE, encoding="utf-8") as f:
                s = json.load(f)
            s, migrated = _migrate_single_dir(s)
            if migrated:
                save_settings(s)
            return s
        except (json.JSONDecodeError, OSError) as e:
            logger.warning(f"Could not read settings.json: {e}")

    s, _ = _migrate_single_dir({
        "references_dir": os.getenv("REFERENCES_DIR", ""),
        "ai_api_base_url": os.getenv("AI_API_BASE_URL", "http://localhost:11434/v1"),
        "ai_api_key": os.getenv("AI_API_KEY", ""),
        "ai_model": os.getenv("AI_MODEL", "qwen2.5:3b"),
        "suggestion_temperature": float(os.getenv("SUGGESTION_TEMPERATURE", "0.1")),
        "suggestion_top_k": int(os.getenv("SUGGESTION_TOP_K", "10")),
        "chat_temperature": float(os.getenv("CHAT_TEMPERATURE", "0.3")),
        "embedding_provider": os.getenv("EMBEDDING_PROVIDER", "local"),
        "embedding_model": os.getenv("EMBEDDING_MODEL", DEFAULT_EMBEDDING_MODEL),
        "reranker_model": os.getenv("RERANKER_MODEL", DEFAULT_RERANKER_MODEL),
        "crossref_mailto": os.getenv("CROSSREF_MAILTO", "info@tarcite.com"),
        "crossref_timeout_seconds": _float_env("CROSSREF_TIMEOUT_SECONDS", 5),
    })
    return s


def save_settings(settings: dict) -> None:
    with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
        json.dump(settings, f, indent=2)
    logger.info("Settings saved to %s", SETTINGS_FILE)


class Config:
    def __init__(self) -> None:
        self._load()

    def _load(self) -> None:
        s = get_settings()
        self.reference_dirs: list = s.get("reference_dirs", [])
        self.references_dir: str = s.get("references_dir", "")

        profiles = s.get("ai_profiles", [])
        active = s.get("active_profile", "")
        self.active_profile: str = active
        active_profile = None
        for p in profiles:
            if p.get("name") == active:
                active_profile = p
                break

        if active_profile:
            self.ai_api_base_url: str = active_profile.get("ai_api_base_url", "https://api.openai.com/v1")
            self.ai_api_key: str = active_profile.get("ai_api_key", "")
            self.ai_model: str = active_profile.get("ai_model", "qwen2.5:3b")
            self.provider_label: str = active_profile.get("provider_label", "")
            self.suggestion_temperature: float = float(active_profile.get("suggestion_temperature", 0.1))
            self.chat_temperature: float = float(active_profile.get("chat_temperature", 0.3))
            self.suggestion_top_k: int = int(active_profile.get("suggestion_top_k", 50))
        else:
            self.ai_api_base_url: str = s.get("ai_api_base_url", "https://api.openai.com/v1")
            self.ai_api_key: str = s.get("ai_api_key", "")
            self.ai_model: str = s.get("ai_model", "qwen2.5:3b")
            self.provider_label: str = s.get("provider_label", "")
            self.suggestion_temperature: float = float(s.get("suggestion_temperature", 0.1))
            self.chat_temperature: float = float(s.get("chat_temperature", 0.3))
            self.suggestion_top_k: int = int(s.get("suggestion_top_k", 50))

        self.embedding_provider: str = s.get("embedding_provider", "local")
        self.embedding_model: str = s.get("embedding_model", DEFAULT_EMBEDDING_MODEL)
        self.reranker_model: str = s.get("reranker_model", DEFAULT_RERANKER_MODEL)

        # Thermal/efficiency controls. preload_models=off defers the heavy
        # embedding+reranker load from launch to first use; idle unload frees
        # the model weights (and MPS/CUDA cache) after N minutes without a
        # search or sync (0 = keep loaded forever).
        _preload_env = os.getenv("PRELOAD_MODELS")
        if _preload_env is not None:
            self.preload_models: bool = _preload_env.strip().lower() in ("1", "true", "yes", "on")
        else:
            self.preload_models = bool(s.get("preload_models", False))
        try:
            self.model_idle_unload_minutes: int = max(0, int(
                os.getenv("MODEL_IDLE_UNLOAD_MINUTES") or s.get("model_idle_unload_minutes", 20)
            ))
        except (TypeError, ValueError):
            self.model_idle_unload_minutes = 20
        self.crossref_mailto: str = s.get("crossref_mailto", "info@tarcite.com") or "info@tarcite.com"
        try:
            self.crossref_timeout_seconds: float = max(1.0, float(s.get("crossref_timeout_seconds", 5)))
        except (TypeError, ValueError):
            self.crossref_timeout_seconds = 5.0

        self.db_path: str = str(DATA_DIR / "local_citation.sqlite")
        self.chroma_path: str = str(DATA_DIR / "chroma")

        # Zettelkasten notes live as real .md files on disk (Obsidian interop).
        # An explicit ``notes_dir`` setting wins; otherwise notes nest under the
        # first configured reference directory, and finally fall back to the data
        # dir so the feature still works with no library configured.
        _notes_dir = s.get("notes_dir", "")
        if _notes_dir:
            self.notes_dir: str = str(Path(_notes_dir).expanduser())
        else:
            # reference_dirs entries are {"path", "label"} dicts; nest notes
            # under the first configured reference directory, else the data dir.
            _first_ref = ""
            if self.reference_dirs:
                _first_ref = self.reference_dirs[0].get("path", "") if isinstance(
                    self.reference_dirs[0], dict
                ) else str(self.reference_dirs[0])
            self.notes_dir = str(Path(_first_ref) / "notes") if _first_ref else str(DATA_DIR / "notes")
        # Recompute computed links (semantic/contradiction) on startup. Off by
        # default: contradiction calls the LLM, which costs tokens on launch.
        self.zettel_auto_recompute: bool = bool(s.get("zettel_auto_recompute", False))

        self.app_host: str = os.getenv("APP_HOST", "127.0.0.1")
        self.app_port: int = int(os.getenv("APP_PORT", "4443"))
        # MCP server: expose the local library as MCP tools at /mcp. Controlled
        # from Settings (persisted in settings.json, default on). The MCP_ENABLED
        # env var, when set, overrides the saved preference (ops kill-switch).
        _mcp_env = os.getenv("MCP_ENABLED")
        if _mcp_env is not None:
            self.mcp_enabled: bool = _mcp_env.strip().lower() not in ("0", "false", "no", "off")
        else:
            self.mcp_enabled = bool(s.get("mcp_enabled", True))
        self.app_display_host: str = os.getenv("APP_DISPLAY_HOST", "tarcite.workspace")
        # External port: HTTPS always uses 443 (pfctl forwards 443→app_port on macOS)
        # so browsers and the Word add-in always see https://tarcite.workspace (no :port)
        self.app_external_port: int = 443 if os.path.exists(
            os.path.join(str(Path.home()), ".citation-workspace", "citation-workspace-local.pem")
        ) else self.app_port

        home = str(Path.home())
        self.ssl_cert: str = os.path.join(home, ".citation-workspace", "citation-workspace-local.pem")
        self.ssl_key: str = os.path.join(home, ".citation-workspace", "citation-workspace-local-key.pem")
        self.use_https: bool = os.path.exists(self.ssl_cert) and os.path.exists(self.ssl_key)

    def reload(self) -> None:
        self._load()

    @property
    def ai_configured(self) -> bool:
        url = self.ai_api_base_url or ""
        if "api.tarcite.com" in url:
            return True
        return bool(self.ai_api_key)


config = Config()
