"""
Offline translation support.

Argos models are installed one language direction at a time. The app can list
available packages from the Argos index, download only the requested pair, and
translate selected preview text without sending it to a remote API.
"""

from __future__ import annotations

import logging
import os
import threading
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import httpx

from app.config import DATA_DIR

logger = logging.getLogger(__name__)


def _quiet_argos_loggers() -> None:
    logging.getLogger("argostranslate").setLevel(logging.WARNING)
    logging.getLogger("argostranslate.utils").setLevel(logging.WARNING)
    logging.getLogger("stanza").setLevel(logging.WARNING)


_quiet_argos_loggers()

ARGOS_INDEX_URL = "https://raw.githubusercontent.com/argosopentech/argospm-index/main/index.json"
CHUNK_SIZE = 1 << 17
TRANSLATION_DIR = DATA_DIR / "translation"
TRANSLATION_DOWNLOAD_DIR = TRANSLATION_DIR / "downloads"

# Keep Argos package/config/cache data inside the app data directory. This makes
# packaged builds local-first and avoids writing to user home locations that may
# be sandboxed in tests or app bundles.
os.environ.setdefault("XDG_DATA_HOME", str(TRANSLATION_DIR / "xdg-data"))
os.environ.setdefault("XDG_CONFIG_HOME", str(TRANSLATION_DIR / "xdg-config"))
os.environ.setdefault("XDG_CACHE_HOME", str(TRANSLATION_DIR / "xdg-cache"))
os.environ.setdefault("ARGOS_DEVICE_TYPE", "cpu")

FALLBACK_PACKAGES = [
    {
        "package_version": "1.9",
        "argos_version": "1.9.0",
        "from_code": "en",
        "from_name": "English",
        "to_code": "id",
        "to_name": "Indonesian",
        "links": ["https://argos-net.com/v1/translate-en_id-1_9.argosmodel"],
        "code": "translate-en_id",
    },
    {
        "package_version": "1.9",
        "argos_version": "1.9.0",
        "from_code": "id",
        "from_name": "Indonesian",
        "to_code": "en",
        "to_name": "English",
        "links": ["https://argos-net.com/v1/translate-id_en-1_9.argosmodel"],
        "code": "translate-id_en",
    },
]


class Status(str, Enum):
    IDLE = "idle"
    DOWNLOADING = "downloading"
    INSTALLING = "installing"
    DONE = "done"
    ERROR = "error"
    CANCELLED = "cancelled"


@dataclass
class TranslationDownloadState:
    slug: str
    name: str
    status: Status = Status.IDLE
    bytes_downloaded: int = 0
    total_bytes: int = 0
    error: Optional[str] = None
    _cancel: bool = field(default=False, repr=False)

    @property
    def pct(self) -> float:
        if not self.total_bytes:
            return 0.0
        return round(self.bytes_downloaded / self.total_bytes * 100, 1)

    def to_dict(self) -> Dict:
        return {
            "slug": self.slug,
            "name": self.name,
            "status": self.status.value,
            "bytes_downloaded": self.bytes_downloaded,
            "total_bytes": self.total_bytes,
            "pct": self.pct,
            "error": self.error,
        }


_downloads: Dict[str, TranslationDownloadState] = {}
_lock = threading.Lock()

# Translation runs in FastAPI's threadpool now (see routers/translation.py), so
# several selections could otherwise be translated at once — each one a
# CTranslate2 model doing CPU-bound work across every core.  One at a time keeps
# a burst of clicks from turning into a thermal event.
_translate_lock = threading.Lock()


def _argos_available() -> bool:
    try:
        import argostranslate.package  # noqa: F401
        import argostranslate.translate  # noqa: F401
        _quiet_argos_loggers()
        return True
    except Exception:
        return False


def _slug_for(pkg: Dict) -> str:
    return f"{pkg.get('from_code', '')}_{pkg.get('to_code', '')}_{pkg.get('package_version', '')}".replace(".", "_")


def _package_name(pkg: Dict) -> str:
    return f"{pkg.get('from_name', pkg.get('from_code'))} -> {pkg.get('to_name', pkg.get('to_code'))}"


def _tmp_path(slug: str) -> Path:
    return TRANSLATION_DOWNLOAD_DIR / f"{slug}.part"


def _model_path(slug: str) -> Path:
    return TRANSLATION_DOWNLOAD_DIR / f"{slug}.argosmodel"


def _head_size(url: str) -> int:
    try:
        with httpx.Client(follow_redirects=True, timeout=10.0) as client:
            resp = client.head(url)
            if resp.status_code >= 400:
                return 0
            return int(resp.headers.get("Content-Length") or 0)
    except Exception:
        return 0


def _fetch_index() -> List[Dict]:
    try:
        resp = httpx.get(ARGOS_INDEX_URL, timeout=10.0, follow_redirects=True)
        resp.raise_for_status()
        data = resp.json()
        return data if isinstance(data, list) else FALLBACK_PACKAGES
    except Exception as exc:
        logger.warning("Argos package index fetch failed: %s", exc)
        return FALLBACK_PACKAGES


def get_installed_pairs() -> set[Tuple[str, str]]:
    if not _argos_available():
        return set()
    try:
        import argostranslate.translate
        _quiet_argos_loggers()

        pairs: set[Tuple[str, str]] = set()
        for lang in argostranslate.translate.get_installed_languages():
            translations = list(getattr(lang, "translations_to", []) or [])
            translations.extend(getattr(lang, "translations_from", []) or [])
            for translation in translations:
                from_lang = getattr(translation, "from_lang", None)
                to_lang = getattr(translation, "to_lang", None)
                from_code = getattr(from_lang, "code", "")
                to_code = getattr(to_lang, "code", "")
                if from_code and to_code and from_code != to_code:
                    pairs.add((from_code, to_code))
        return pairs
    except Exception as exc:
        logger.warning("Could not inspect installed Argos packages: %s", exc)
        return set()


def list_translation_packages() -> Dict:
    installed_pairs = get_installed_pairs()
    packages = []
    for pkg in _fetch_index():
        link = (pkg.get("links") or [""])[0]
        if not link:
            continue
        slug = _slug_for(pkg)
        with _lock:
            state = _downloads.get(slug)
        packages.append({
            "slug": slug,
            "name": _package_name(pkg),
            "from_code": pkg.get("from_code", ""),
            "from_name": pkg.get("from_name", ""),
            "to_code": pkg.get("to_code", ""),
            "to_name": pkg.get("to_name", ""),
            "package_version": pkg.get("package_version", ""),
            "url": link,
            "file_size_bytes": _head_size(link) if pkg.get("from_code") == "en" and pkg.get("to_code") == "id" else 0,
            "installed": (pkg.get("from_code"), pkg.get("to_code")) in installed_pairs,
            "download_state": state.to_dict() if state else None,
        })
    packages.sort(key=lambda p: (p["from_name"], p["to_name"], p["package_version"]))
    return {
        "available": _argos_available(),
        "packages": packages,
        "installed_pairs": [{"from_code": a, "to_code": b} for a, b in sorted(installed_pairs)],
    }


def _find_package(slug: str) -> Optional[Dict]:
    for pkg in _fetch_index():
        if _slug_for(pkg) == slug:
            return pkg
    return None


def get_all_progress() -> List[Dict]:
    with _lock:
        return [s.to_dict() for s in _downloads.values()]


def get_progress(slug: str) -> Optional[Dict]:
    with _lock:
        state = _downloads.get(slug)
        return state.to_dict() if state else None


def cancel_download(slug: str) -> bool:
    with _lock:
        state = _downloads.get(slug)
        if state and state.status == Status.DOWNLOADING:
            state._cancel = True
            return True
    return False


def start_download(slug: str) -> bool:
    if not _argos_available():
        raise RuntimeError("Argos Translate is not installed. Install the Python dependency first.")

    pkg = _find_package(slug)
    if not pkg:
        raise KeyError("Translation package not found.")

    url = (pkg.get("links") or [""])[0]
    if not url:
        raise RuntimeError("Translation package has no download URL.")

    name = _package_name(pkg)
    total = _head_size(url)
    with _lock:
        existing = _downloads.get(slug)
        if existing and existing.status == Status.DOWNLOADING:
            return False
        state = TranslationDownloadState(slug=slug, name=name, status=Status.DOWNLOADING, total_bytes=total)
        _downloads[slug] = state

    thread = threading.Thread(target=_download_worker, args=(slug, url), daemon=True)
    thread.start()
    return True


def _download_worker(slug: str, url: str) -> None:
    TRANSLATION_DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
    tmp = _tmp_path(slug)
    resume_from = tmp.stat().st_size if tmp.exists() else 0

    with _lock:
        state = _downloads[slug]
        state.bytes_downloaded = resume_from

    headers = {"Range": f"bytes={resume_from}-"} if resume_from else {}
    try:
        with httpx.stream("GET", url, headers=headers, timeout=None, follow_redirects=True) as resp:
            if resp.status_code not in (200, 206):
                raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:200]}")

            # If we asked for a Range but the server returned 200, it is sending
            # the full file from byte 0.  Appending that to an existing partial
            # file would corrupt it, so restart fresh.
            if resp.status_code == 200 and resume_from:
                logger.warning(
                    "Server ignored Range header for %s; restarting download from byte 0", slug
                )
                resume_from = 0
                with _lock:
                    state.bytes_downloaded = 0

            content_length = resp.headers.get("Content-Length")
            if content_length:
                with _lock:
                    state.total_bytes = resume_from + int(content_length)

            mode = "ab" if resume_from else "wb"
            with open(tmp, mode) as fout:
                for chunk in resp.iter_bytes(CHUNK_SIZE):
                    with _lock:
                        if state._cancel:
                            state.status = Status.CANCELLED
                            return
                        state.bytes_downloaded += len(chunk)
                    fout.write(chunk)
    except Exception as exc:
        with _lock:
            state.status = Status.ERROR
            state.error = str(exc)
        logger.error("Translation package download failed for %s: %s", slug, exc)
        return

    with _lock:
        state.status = Status.INSTALLING
        state.error = None

    try:
        final_path = _model_path(slug)
        # On Windows Path.replace() raises FileExistsError when the destination
        # already exists.  Remove it first so the rename always succeeds.
        if final_path.exists():
            final_path.unlink(missing_ok=True)
        tmp.replace(final_path)
        install_package(final_path)
    except Exception as exc:
        with _lock:
            state.status = Status.ERROR
            state.error = f"Install failed: {exc}"
        logger.error("Translation package install failed for %s: %s", slug, exc)
        return

    with _lock:
        state.status = Status.DONE


def install_package(model_path: Path) -> None:
    if not _argos_available():
        raise RuntimeError("Argos Translate is not installed.")
    import argostranslate.package
    _quiet_argos_loggers()

    argostranslate.package.install_from_path(str(model_path))


_stanza_configured = False


def _configure_stanza_offline() -> None:
    """Stop Stanza re-downloading its resource index on every translation.

    Argos builds its sentence splitter with
    ``stanza.Pipeline(dir=<package>/stanza, ...)`` but leaves Stanza's default
    ``download_method=DOWNLOAD_RESOURCES``, so constructing the pipeline fetches
    ``resources_<version>.json`` from raw.githubusercontent.com — even though
    every language package already ships that exact file locally.  When GitHub
    rate-limits the request the translation dies with
    "429 Client Error: Too Many Requests", surfacing in the viewer as a failed
    translation, and an offline-first app has no business needing the network to
    split sentences at all.

    ``REUSE_RESOURCES`` uses the bundled file when it is there and only falls
    back to downloading if it is genuinely missing.
    """
    global _stanza_configured
    if _stanza_configured:
        return
    _stanza_configured = True

    try:
        import stanza
        from stanza.pipeline.core import DownloadMethod
    except Exception:  # stanza absent — Argos falls back to its own splitter
        return

    original = stanza.Pipeline
    if getattr(original, "_tarcite_offline_default", False):
        return

    def pipeline_preferring_local_resources(*args, **kwargs):
        kwargs.setdefault("download_method", DownloadMethod.REUSE_RESOURCES)
        return original(*args, **kwargs)

    pipeline_preferring_local_resources._tarcite_offline_default = True
    stanza.Pipeline = pipeline_preferring_local_resources


def translate_text(text: str, source_code: str, target_code: str) -> str:
    text = (text or "").strip()
    if not text:
        raise ValueError("No text selected.")
    if len(text) > 5000:
        raise ValueError("Selected text is too long. Select 5000 characters or fewer.")
    if not _argos_available():
        raise RuntimeError("Argos Translate is not installed.")

    import argostranslate.translate
    _quiet_argos_loggers()
    _configure_stanza_offline()

    source_code = (source_code or "en").strip()
    target_code = (target_code or "id").strip()
    installed = get_installed_pairs()
    if (source_code, target_code) in installed:
        with _translate_lock:
            return argostranslate.translate.translate(text, source_code, target_code)
    if source_code != "en" and target_code != "en" and (source_code, "en") in installed and ("en", target_code) in installed:
        with _translate_lock:
            pivot = argostranslate.translate.translate(text, source_code, "en")
            return argostranslate.translate.translate(pivot, "en", target_code)
    raise RuntimeError(f"Offline translation model {source_code} -> {target_code} is not installed.")
