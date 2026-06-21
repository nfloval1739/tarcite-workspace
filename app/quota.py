"""AI quota fallback helpers."""

import logging
from typing import Dict

from app.ai_client import QuotaExceededError
from app.config import config, get_settings, save_settings

logger = logging.getLogger(__name__)


def _find_fallback_profile() -> Dict | None:
    """Return the next profile in the fallback chain based on the active config."""
    settings = get_settings()
    profiles = settings.get("ai_profiles", [])
    base = config.ai_api_base_url or ""
    model = config.ai_model or ""

    if "api.tarcite.com" in base and model == "premium":
        for profile in profiles:
            if "api.tarcite.com" in (profile.get("ai_api_base_url") or "") and profile.get("ai_model") == "default":
                return profile

    if "api.tarcite.com" in base:
        for profile in profiles:
            profile_base = profile.get("ai_api_base_url") or ""
            if "localhost" in profile_base or "127.0.0.1" in profile_base:
                return profile

    return None


def _apply_profile_to_config(profile: Dict) -> None:
    config.ai_api_base_url = profile.get("ai_api_base_url", config.ai_api_base_url)
    config.ai_api_key = profile.get("ai_api_key", config.ai_api_key)
    config.ai_model = profile.get("ai_model", config.ai_model)
    config.active_profile = profile.get("name", config.active_profile)
    config.provider_label = profile.get("provider_label", config.provider_label)
    config.suggestion_temperature = float(profile.get("suggestion_temperature", config.suggestion_temperature))
    config.chat_temperature = float(profile.get("chat_temperature", config.chat_temperature))
    config.suggestion_top_k = int(profile.get("suggestion_top_k", config.suggestion_top_k))
    logger.info("Quota fallback: switched to profile '%s' (model=%s)", profile.get("name"), profile.get("ai_model"))
    try:
        settings = get_settings()
        settings["active_profile"] = profile.get("name", "")
        save_settings(settings)
    except Exception as exc:
        logger.warning("Could not persist fallback profile to settings: %s", exc)


def call_with_quota_fallback(fn, *args):
    """Call fn(*args), retrying with the next fallback profile on QuotaExceededError."""
    notifications = []
    for _ in range(3):
        fallback = _find_fallback_profile()
        if not fallback:
            raise QuotaExceededError("All fallback profiles exhausted.")
        notifications.append(
            f"Quota reached \u2014 automatically switched to '{fallback['name']}'."
        )
        _apply_profile_to_config(fallback)
        try:
            return fn(*args), notifications
        except QuotaExceededError:
            continue
    raise QuotaExceededError("All fallback profiles exhausted.")
