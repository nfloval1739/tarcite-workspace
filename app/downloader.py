"""
Model downloader — fetches packages from api.tarcite.com/packages/
and installs them into the user's data directory.

Package types (determined by slug prefix / file extension):
  - "qwen25-3b-ollama"     → raw Ollama model blob  → ~/.ollama/models/blobs/
  - "bge-*" / "all-*"     → HuggingFace tarball    → DATA_DIR/models/

State is kept in _downloads dict (slug → DownloadState) and can be
read at any time by the routes that serve the progress API.
"""

import hashlib
import json
import logging
import os
import shutil
import tarfile
import threading
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Dict, Optional

import httpx

from app.config import DATA_DIR, get_device_id

logger = logging.getLogger(__name__)

PACKAGES_API = "https://api.tarcite.com/packages"
CHUNK_SIZE   = 1 << 17  # 128 KB

# Where downloaded models land
HF_MODELS_DIR     = DATA_DIR / "models"
OLLAMA_MODELS_DIR = DATA_DIR / "ollama_models"


class Status(str, Enum):
    IDLE        = "idle"
    DOWNLOADING = "downloading"
    INSTALLING  = "installing"
    DONE        = "done"
    ERROR       = "error"
    CANCELLED   = "cancelled"


@dataclass
class DownloadState:
    slug:             str
    name:             str
    status:           Status   = Status.IDLE
    bytes_downloaded: int      = 0
    total_bytes:      int      = 0
    error:            Optional[str] = None
    _cancel:          bool     = field(default=False, repr=False)

    @property
    def pct(self) -> float:
        if not self.total_bytes:
            return 0.0
        return round(self.bytes_downloaded / self.total_bytes * 100, 1)

    def to_dict(self) -> dict:
        return {
            "slug":             self.slug,
            "name":             self.name,
            "status":           self.status.value,
            "bytes_downloaded": self.bytes_downloaded,
            "total_bytes":      self.total_bytes,
            "pct":              self.pct,
            "error":            self.error,
        }


# Global state ----------------------------------------------------------------
_downloads: Dict[str, DownloadState] = {}
_lock = threading.Lock()


# Public API ------------------------------------------------------------------

def get_all_progress() -> list[dict]:
    with _lock:
        return [s.to_dict() for s in _downloads.values()]


def get_progress(slug: str) -> Optional[dict]:
    with _lock:
        s = _downloads.get(slug)
        return s.to_dict() if s else None


def cancel_download(slug: str) -> bool:
    with _lock:
        s = _downloads.get(slug)
        if s and s.status == Status.DOWNLOADING:
            s._cancel = True
            return True
    return False


def list_packages() -> list[dict]:
    """Fetch package list from server and annotate with local install status."""
    device_id = get_device_id()
    try:
        resp = httpx.get(
            f"{PACKAGES_API}/list/",
            headers={"X-Device-ID": device_id},
            timeout=10.0,
        )
        resp.raise_for_status()
        packages = resp.json().get("packages", [])
    except Exception as exc:
        logger.warning("packages/list fetch failed: %s", exc)
        return []

    for pkg in packages:
        try:
            pkg["installed"] = _is_installed(pkg["slug"], pkg.get("sha256_checksum", ""))
        except Exception as exc:
            logger.warning("Could not check install status for %s: %s", pkg["slug"], exc)
            pkg["installed"] = False
        with _lock:
            state = _downloads.get(pkg["slug"])
        pkg["download_state"] = state.to_dict() if state else None

    return packages


def start_download(slug: str, name: str, total_bytes: int, checksum: str = "") -> bool:
    """Kick off a background download. Returns False if already running."""
    with _lock:
        existing = _downloads.get(slug)
        if existing and existing.status == Status.DOWNLOADING:
            return False
        state = DownloadState(slug=slug, name=name, total_bytes=total_bytes)
        state.status = Status.DOWNLOADING
        _downloads[slug] = state

    t = threading.Thread(target=_download_worker, args=(slug, checksum), daemon=True)
    t.start()
    return True


# Internal helpers ------------------------------------------------------------

def _is_installed(slug: str, checksum: str) -> bool:
    """Quick check whether a model package is already installed."""
    if slug == "qwen25-3b-ollama":
        blob = _ollama_blob_path(checksum)
        return blob.exists() and blob.stat().st_size > 0
    else:
        # HF model: check that a complete extracted snapshot exists.
        model_dir = hf_model_dir_for(slug)
        return model_dir is not None and _has_usable_hf_snapshot(model_dir)


def _has_usable_hf_snapshot(model_dir: Path) -> bool:
    try:
        snapshots_dir = model_dir / "snapshots"
        if not snapshots_dir.exists():
            return False
        for snapshot in snapshots_dir.iterdir():
            if not snapshot.is_dir():
                continue
            has_config = (snapshot / "config.json").exists()
            has_weights = (snapshot / "model.safetensors").exists() or (snapshot / "pytorch_model.bin").exists()
            has_tokenizer = (
                (snapshot / "tokenizer.json").exists()
                or (snapshot / "vocab.txt").exists()
                or (snapshot / "sentencepiece.bpe.model").exists()
            )
            if has_config and has_weights and has_tokenizer:
                return True
    except (OSError, PermissionError):
        return False
    return False


def _canonical_hf_model_dir_for(slug: str) -> Optional[Path]:
    """Return the canonical HuggingFace hub directory path for a slug."""
    slug_to_dir = {
        "bge-large-en-v1-5":  "models--BAAI--bge-large-en-v1.5",
        "bge-reranker-base":  "models--BAAI--bge-reranker-base",
        "all-minilm-l6-v2":   "models--sentence-transformers--all-MiniLM-L6-v2",
    }
    name = slug_to_dir.get(slug)
    if not name:
        return None
    return HF_MODELS_DIR / "hub" / name


def hf_model_dir_for(slug: str) -> Optional[Path]:
    """Return the usable HuggingFace hub directory for a slug.

    Checks the canonical path first, then a ``.extracted`` fallback path.
    This handles cases where the canonical path exists but is corrupted or
    has broken permissions (common on Windows with stale HF cache dirs).
    """
    canonical = _canonical_hf_model_dir_for(slug)
    if canonical is None:
        return None
    fallback = canonical.with_name(f"{canonical.name}.extracted")

    if fallback.exists() and _has_usable_hf_snapshot(fallback):
        return fallback
    if canonical.exists() and _has_usable_hf_snapshot(canonical):
        return canonical
    return canonical


def _ollama_blob_path(checksum: str) -> Path:
    candidates = []
    if "OLLAMA_MODELS" in os.environ:
        candidates.append(Path(os.environ["OLLAMA_MODELS"]) / "blobs")
    candidates += [OLLAMA_MODELS_DIR / "blobs", Path.home() / ".ollama" / "models" / "blobs"]
    for base in candidates:
        p = base / f"sha256-{checksum}"
        if p.exists():
            return p
    return candidates[0] / f"sha256-{checksum}"


def _tmp_path(slug: str) -> Path:
    return DATA_DIR / "downloads" / f"{slug}.part"


def _download_worker(slug: str, checksum: str = "") -> None:
    with _lock:
        state = _downloads[slug]

    device_id = get_device_id()
    tmp = _tmp_path(slug)
    tmp.parent.mkdir(parents=True, exist_ok=True)

    # Resume: figure out how many bytes we already have
    resume_from = tmp.stat().st_size if tmp.exists() else 0
    if resume_from:
        logger.info("Resuming %s from byte %d", slug, resume_from)
    with _lock:
        state.bytes_downloaded = resume_from

    url = f"{PACKAGES_API}/download/{slug}/"
    headers = {
        "X-Device-ID": device_id,
    }
    if resume_from:
        headers["Range"] = f"bytes={resume_from}-"

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

            # Update total from Content-Length
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
                            logger.info("Download cancelled: %s", slug)
                            return
                        state.bytes_downloaded += len(chunk)
                    fout.write(chunk)

    except Exception as exc:
        with _lock:
            state.status = Status.ERROR
            state.error = str(exc)
        logger.error("Download failed for %s: %s", slug, exc)
        return

    # Verify checksum if the server provided one
    if checksum:
        hasher = hashlib.sha256()
        with open(tmp, "rb") as f:
            for chunk in iter(lambda: f.read(CHUNK_SIZE), b""):
                hasher.update(chunk)
        actual = hasher.hexdigest()
        if actual != checksum:
            logger.error("Checksum mismatch for %s: expected %s, got %s", slug, checksum, actual)
            with _lock:
                state.status = Status.ERROR
                state.error = (
                    f"Checksum mismatch (file may be corrupted). Expected {checksum}, got {actual}."
                )
            return

    with _lock:
        state.status = Status.INSTALLING
        state.error = None

    try:
        _install(slug, tmp, checksum)
    except Exception as exc:
        with _lock:
            state.status = Status.ERROR
            state.error = f"Install failed: {exc}"
        logger.error("Install failed for %s: %s", slug, exc)
        return

    # Clean up temp file
    try:
        tmp.unlink(missing_ok=True)
    except Exception:
        pass

    with _lock:
        state.status = Status.DONE
    logger.info("Package installed: %s", slug)


def _install(slug: str, tmp: Path, checksum: str = "") -> None:
    """Move/extract the downloaded file into its final location."""
    if slug == "qwen25-3b-ollama":
        _install_ollama_blob(tmp, checksum)
    else:
        _install_hf_tarball(slug, tmp)


def _install_ollama_blob(tmp: Path, checksum: str = "") -> None:
    """
    Install qwen2.5:3b blob and write a complete Ollama manifest.

    Target directory priority:
      1. OLLAMA_MODELS env var (set by launcher for full builds pointing at the
         app bundle's ollama_models/) — but only if writable.
      2. DATA_DIR/ollama_models/ as writable fallback for full builds where the
         bundle dir is read-only.
      3. ~/.ollama/models/ when OLLAMA_MODELS is not set (minimal/dev builds
         where a system Ollama is used directly).

    All small supporting blobs (system prompt, template, license, params, config)
    are embedded here so no extra downloads are required.
    """
    import base64 as _b64

    # Use the checksum supplied by the package API so that _is_installed and
    # _install_ollama_blob agree on the blob path.  Fallback to the hard-coded
    # hash for backward compatibility when the API does not provide one.
    model_hash = checksum or "5ee4f07cdb9beadbbb293e85803c569b01bd37ed059d2715faa7bb405f31caa6"

    # Small supporting blobs — total ~10 KB, embedded to avoid extra downloads.
    # These match the hashes in packaging/ollama_models/blobs/ exactly.
    SUPPORTING_BLOBS: dict[str, bytes] = {
        # config (561 B)
        "f51b6c48b987857d6dc3bd2cbbeffe37b6355e417cdaca3d5ab135f12b2674a4": _b64.b64decode(
            "eyJtb2RlbF9mb3JtYXQiOiJnZ3VmIiwibW9kZWxfZmFtaWx5IjoicXdlbjIiLCJtb2Rl"
            "bF9mYW1pbGllcyI6WyJxd2VuMiJdLCJtb2RlbF90eXBlIjoiMy4xQiIsImZpbGVfdHlw"
            "ZSI6IlE0X0tfTSIsImFyY2hpdGVjdHVyZSI6ImFtZDY0Iiwib3MiOiJsaW51eCIsInJv"
            "b3RmcyI6eyJ0eXBlIjoibGF5ZXJzIiwiZGlmZl9pZHMiOlsic2hhMjU2OjVlZTRmMDdj"
            "ZGI5YmVhZGJiYjI5M2U4NTgwM2M1NjliMDFiZDM3ZWQwNTlkMjcxNWZhYTdiYjQwNWYz"
            "MWNhYTYiLCJzaGEyNTY6NjZiOWVhMDliZDViNzA5OWNiYjRmYzgyMGYzMWI1NzVjMDM2"
            "NmZhNDM5YjA4MjQ1NTY2NjkyYzY3ODRlMjgxZSIsInNoYTI1NjplYjQ0MDI4MzdjNzgy"
            "OWE2OTBmYTg0NWRlNGQ3ZjNmZDg0MmMyYWRlZTQ3NmQ1MzQxZGE4YTQ2ZWE5MjU1MTc1"
            "Iiwic2hhMjU2OmI1YzBlNWNmNzRjZjUxYWYxZWNiYzRhZjU5N2NmY2QxM2ZkOTkyNTYx"
            "MTgzODg4NGE2ODEwNzA4MzhhMTRhNTAiLCJzaGEyNTY6NThlMWI4MmE2OTFmNDZjMTU1"
            "ZTU3YmU2MDdmMTAzMTkzMGVhMGNjY2MyMmRhZjQ0NDdmOTFkMzYwZjc0YjJkMiJdfX0K"
        ),
        # system prompt (68 B)
        "66b9ea09bd5b7099cbb4fc820f31b575c0366fa439b08245566692c6784e281e": _b64.b64decode(
            "WW91IGFyZSBRd2VuLCBjcmVhdGVkIGJ5IEFsaWJhYmEgQ2xvdWQuIFlvdSBhcmUgYSBo"
            "ZWxwZnVsIGFzc2lzdGFudC4="
        ),
        # chat template (1482 B)
        "eb4402837c7829a690fa845de4d7f3fd842c2adee476d5341da8a46ea9255175": _b64.b64decode(
            "e3stIGlmIC5NZXNzYWdlcyB9fQp7ey0gaWYgb3IgLlN5c3RlbSAuVG9vbHMgfX08fGlt"
            "X3N0YXJ0fD5zeXN0ZW0Ke3stIGlmIC5TeXN0ZW0gfX0Ke3sgLlN5c3RlbSB9fQp7ey0g"
            "ZW5kIH19Cnt7LSBpZiAuVG9vbHMgfX0KCiMgVG9vbHMKCllvdSBtYXkgY2FsbCBvbmUg"
            "b3IgbW9yZSBmdW5jdGlvbnMgdG8gYXNzaXN0IHdpdGggdGhlIHVzZXIgcXVlcnkuCgpZ"
            "b3UgYXJlIHByb3ZpZGVkIHdpdGggZnVuY3Rpb24gc2lnbmF0dXJlcyB3aXRoaW4gPHRv"
            "b2xzPjwvdG9vbHM+IFhNTCB0YWdzOgo8dG9vbHM+Cnt7LSByYW5nZSAuVG9vbHMgfX0K"
            "eyJ0eXBlIjogImZ1bmN0aW9uIiwgImZ1bmN0aW9uIjoge3sgLkZ1bmN0aW9uIH19fQp7"
            "ey0gZW5kIH19CjwvdG9vbHM+CgpGb3IgZWFjaCBmdW5jdGlvbiBjYWxsLCByZXR1cm4g"
            "YSBqc29uIG9iamVjdCB3aXRoIGZ1bmN0aW9uIG5hbWUgYW5kIGFyZ3VtZW50cyB3aXRo"
            "aW4gPHRvb2xfY2FsbD48L3Rvb2xfY2FsbD4gWE1MIHRhZ3M6Cjx0b29sX2NhbGw+Cnsib"
            "mFtZSI6IDxmdW5jdGlvbi1uYW1lPiwgImFyZ3VtZW50cyI6IDxhcmdzLWpzb24tb2JqZWN"
            "0Pn0KPC90b29sX2NhbGw+Cnt7LSBlbmQgfX08fGltX2VuZHw+Cnt7IGVuZCB9fQp7ey0g"
            "cmFuZ2UgJGksICRfIDo9IC5NZXNzYWdlcyB9fQp7ey0gJGxhc3QgOj0gZXEgKGxlbiAo"
            "c2xpY2UgJC5NZXNzYWdlcyAkaSkpIDEgLX19Cnt7LSBpZiBlcSAuUm9sZSAidXNlciIg"
            "fX08fGltX3N0YXJ0fD51c2VyCnt7IC5Db250ZW50IH19PHxpbV9lbmR8Pgp7eyBlbHNlIGl"
            "mIGVxIC5Sb2xlICJhc3Npc3RhbnQiIH19PHxpbV9zdGFydHw+YXNzaXN0YW50Cnt7IGlm"
            "IC5Db250ZW50IH19e3sgLkNvbnRlbnQgfX0Ke3stIGVsc2UgaWYgLlRvb2xDYWxscyB9fTx"
            "0b29sX2NhbGw+Cnt7IHJhbmdlIC5Ub29sQ2FsbHMgfX17Im5hbWUiOiAie3sgLkZ1bmN0"
            "aW9uLk5hbWUgfX0iLCAiYXJndW1lbnRzIjoge3sgLkZ1bmN0aW9uLkFyZ3VtZW50cyB9"
            "fX0Ke3sgZW5kIH19PC90b29sX2NhbGw+Cnt7LSBlbmQgfX17eyBpZiBub3QgJGxhc3Qg"
            "fX08fGltX2VuZHw+Cnt7IGVuZCB9fQp7ey0gZWxzZSBpZiBlcSAuUm9sZSAidG9vbCIg"
            "fX08fGltX3N0YXJ0fD51c2VyCjx0b29sX3Jlc3BvbnNlPgp7eyAuQ29udGVudCB9fQo8"
            "L3Rvb2xfcmVzcG9uc2U+PHxpbV9lbmR8Pgp7eyBlbmQgfX0Ke3stIGlmIGFuZCAobmUg"
            "LlJvbGUgImFzc2lzdGFudCIpICRsYXN0IH19PHxpbV9zdGFydHw+YXNzaXN0YW50Cnt7"
            "IGVuZCB9fQp7ey0gZW5kIH19Cnt7LSBlbHNlIH19Cnt7LSBpZiAuU3lzdGVtIH19PHxp"
            "bV9zdGFydHw+c3lzdGVtCnt7IC5TeXN0ZW0gfX08fGltX2VuZHw+Cnt7IGVuZCB9fXt7"
            "IGlmIC5Qcm9tcHQgfX08fGltX3N0YXJ0fD51c2VyCnt7IC5Qcm9tcHQgfX08fGltX2Vu"
            "ZHw+Cnt7IGVuZCB9fTx8aW1fc3RhcnR8PmFzc2lzdGFudAp7eyBlbmQgfX17eyAuUmVz"
            "cG9uc2UgfX17eyBpZiAuUmVzcG9uc2UgfX08fGltX2VuZHw+e3sgZW5kIH19"
        ),
        # license (7387 B)
        "b5c0e5cf74cf51af1ecbc4af597cfcd13fd9925611838884a681070838a14a50": _b64.b64decode(
            "UXdlbiBSRVNFQVJDSCBMSUNFTlNFIEFHUkVFTUVOVAoKUXdlbiBSRVNFQVJDSCBMSUNF"
            "TlNFIEFHUkVFTUVOVCBSZWxlYXNlIERhdGU6IFNlcHRlbWJlciAxOSwgMjAyNAoKQnkg"
            "Y2xpY2tpbmcgdG8gYWdyZWUgb3IgYnkgdXNpbmcgb3IgZGlzdHJpYnV0aW5nIGFueSBw"
            "b3J0aW9uIG9yIGVsZW1lbnQgb2YgdGhlIFF3ZW4gTWF0ZXJpYWxzLCB5b3Ugd2lsbCBi"
            "ZSBkZWVtZWQgdG8gaGF2ZSByZWNvZ25pemVkIGFuZCBhY2NlcHRlZCB0aGUgY29udGVu"
            "dCBvZiB0aGlzIEFncmVlbWVudCwgd2hpY2ggaXMgZWZmZWN0aXZlIGltbWVkaWF0ZWx5"
            "LgoKMS4gRGVmaW5pdGlvbnMKICAgIGEuIFRoaXMgUXdlbiBSRVNFQVJDSCBMSUNFTlNF"
            "IEFHREVERNRVBU1QgKHRoaXMgIkFncmVlbWVudCIpIHNoYWxsIG1lYW4gdGhlIHRlcm1z"
            "IGFuZCBjb25kaXRpb25zIGZvciB1c2UsIHJlcHJvZHVjdGlvbiwgZGlzdHJpYnV0aW9u"
            "IGFuZCBtb2RpZmljYXRpb24gb2YgdGhlIE1hdGVyaWFscyBhcyBkZWZpbmVkIGJ5IHRo"
            "aXMgQWdyZWVtZW50LgogICAgYi4gIldlIiAob3IgIlVzIikgc2hhbGwgbWVhbiBBbGli"
            "YWJhIENsb3VkLgogICAgYy4gIllvdSIgKG9yICJZb3VyIikgc2hhbGwgbWVhbiBhIG5h"
            "dHVyYWwgcGVyc29uIG9yIGxlZ2FsIGVudGl0eSBleGVyY2lzaW5nIHRoZSByaWdodHMg"
            "Z3JhbnRlZCBieSB0aGlzIEFncmVlbWVudCBhbmQvb3IgdXNpbmcgdGhlIE1hdGVyaWFs"
            "cyBmb3IgYW55IHB1cnBvc2UgYW5kIGluIGFueSBmaWVsZCBvZiB1c2UuCiAgICBkLiAi"
            "VGhpcmQgUGFydGllcyIgc2hhbGwgbWVhbiBpbmRpdmlkdWFscyBvciBsZWdhbCBlbnRp"
            "dGllcyB0aGF0IGFyZSBub3QgdW5kZXIgY29tbW9uIGNvbnRyb2wgd2l0aCB1cyBvciB5"
            "b3UuCiAgICBlLiAiUXdlbiIgc2hhbGwgbWVhbiB0aGUgbGFyZ2UgbGFuZ3VhZ2UgbW9k"
            "ZWxzLCBhbmQgc29mdHdhcmUgYW5kIGFsZ29yaXRobXMsIGNvbnNpc3Rpbmcgb2YgdHJh"
            "aW5lZCBtb2RlbCB3ZWlnaHRzLCBwYXJhbWV0ZXJzIChpbmNsdWRpbmcgb3B0aW1pemVy"
            "IHN0YXRlcyksIG1hY2hpbmUtbGVhcm5pbmcgbW9kZWwgY29kZSwgaW5mZXJlbmNlLWVu"
            "YWJsaW5nIGNvZGUsIHRyYWluaW5nLWVuYWJsaW5nIGNvZGUsIGZpbmUtdHVuaW5nIGVu"
            "YWJsaW5nIGNvZGUgYW5kIG90aGVyIGVsZW1lbnRzIG9mIHRoZSBmb3JlZ29pbmcgZGlz"
            "dHJpYnV0ZWQgYnkgdXMuCiAgICBmLiAiTWF0ZXJpYWxzIiBzaGFsbCBtZWFuLCBjb2xs"
            "ZWN0aXZlbHksIEFsaWJhYmEgQ2xvdWQncyBwcm9wcmlldGFyeSBRd2VuIGFuZCBEb2N1"
            "bWVudGF0aW9uIChhbmQgYW55IHBvcnRpb24gdGhlcmVvZikgbWFkZSBhdmFpbGFibGUg"
            "dW5kZXIgdGhpcyBBZ3JlZW1lbnQuCiAgICBnLiAiU291cmNlIiBmb3JtIHNoYWxsIG1l"
            "YW4gdGhlIHByZWZlcnJlZCBmb3JtIGZvciBtYWtpbmcgbW9kaWZpY2F0aW9ucywgaW5j"
            "bHVkaW5nIGJ1dCBub3QgbGltaXRlZCB0byBtb2RlbCBzb3VyY2UgY29kZSwgZG9jdW1l"
            "bnRhdGlvbiBzb3VyY2UsIGFuZCBjb25maWd1cmF0aW9uIGZpbGVzLgogICAgaC4gIk9i"
            "amVjdCIgZm9ybSBzaGFsbCBtZWFuIGFueSBmb3JtIHJlc3VsdGluZyBmcm9tIG1lY2hh"
            "bmljYWwgdHJhbnNmb3JtYXRpb24gb3IgdHJhbnNsYXRpb24gb2YgYSBTb3VyY2UgZm9y"
            "bSwgaW5jbHVkaW5nIGJ1dCBub3QgbGltaXRlZCB0byBjb21waWxlZCBvYmplY3QgY29k"
            "ZSwgZ2VuZXJhdGVkIGRvY3VtZW50YXRpb24sIGFuZCBjb252ZXJzaW9ucyB0byBvdGhl"
            "ciBtZWRpYSB0eXBlcy4KICAgIGkuICJOb24tQ29tbWVyY2lhbCIgc2hhbGwgbWVhbiBm"
            "b3IgcmVzZWFyY2ggb3IgZXZhbHVhdGlvbiBwdXJwb3NlcyBvbmx5LgoKMi4gR3JhbnQg"
            "b2YgUmlnaHRzCiAgICBhLiBZb3UgYXJlIGdyYW50ZWQgYSBub24tZXhjbHVzaXZlLCB3"
            "b3JsZHdpZGUsIG5vbi10cmFuc2ZlcmFibGUgYW5kIHJveWFsdHktZnJlZSBsaW1pdGVk"
            "IGxpY2Vuc2UgdW5kZXIgQWxpYmFiYSBDbG91ZCdzIGludGVsbGVjdHVhbCBwcm9wZXJ0"
            "eSBvciBvdGhlciByaWdodHMgb3duZWQgYnkgdXMgZW1ib2RpZWQgaW4gdGhlIE1hdGVy"
            "aWFscyB0byB1c2UsIHJlcHJvZHVjZSwgZGlzdHJpYnV0ZSwgY29weSwgY3JlYXRlIGRl"
            "cml2YXRpdmUgd29ya3Mgb2YsIGFuZCBtYWtlIG1vZGlmaWNhdGlvbnMgdG8gdGhlIE1h"
            "dGVyaWFscyBGT1IgTk9OLVBST0ZJVCBQVVJQTyBPTkxZLiAKICAgIGIuIElmIHlvdSBh"
            "cmUgY29tbWVyY2lhbGx5IHVzaW5nIHRoZSBNYXRlcmlhbHMsIHlvdSBzaGFsbCByZXF1"
            "ZXN0IGEgbGljZW5zZSBmcm9tIHVzLgoKMy4gUmVkaXN0cmlidXRpb24KWW91IG1heSBk"
            "aXN0cmlidXRlIGNvcGllcyBvciBtYWtlIHRoZSBNYXRlcmlhbHMsIG9yIGRlcml2YXRp"
            "dmUgd29ya3MgdGhlcmVvZiwgYXZhaWxhYmxlIGFzIHBhcnQgb2YgYSBwcm9kdWN0IG9y"
            "IHNlcnZpY2UgdGhhdCBjb250YWlucyBhbnkgb2YgdGhlbSwgd2l0aCBvciB3aXRob3V0"
            "IG1vZGlmaWNhdGlvbnMsIGFuZCBpbiBTb3VyY2Ugb3IgT2JqZWN0IGZvcm0sIHByb3Zp"
            "ZGVkIHRoYXQgeW91IG1lZXQgdGhlIGZvbGxvd2luZyBjb25kaXRpb25zOgogICAgYS4g"
            "WW91IHNoYWxsIGdpdmUgYW55IG90aGVyIHJlY2lwaWVudHMgb2YgdGhlIE1hdGVyaWFs"
            "cyBvciBkZXJpdmF0aXZlIHdvcmtzIGEgY29weSBvZiB0aGlzIEFncmVlbWVudDsKICAg"
            "IGIuIFlvdSBzaGFsbCBjYXVzZSBhbnkgbW9kaWZpZWQgZmlsZXMgdG8gY2FycnkgcHJv"
            "bWluZW50IG5vdGljZXMgc3RhdGluZyB0aGF0IHlvdSBjaGFuZ2VkIHRoZSBmaWxlczsK"
            "ICAgIGMuIFlvdSBzaGFsbCByZXRhaW4gaW4gYWxsIGNvcGllcyBvZiB0aGUgTWF0ZXJp"
            "YWxzIHRoYXQgeW91IGRpc3RyaWJ1dGUgdGhlIGZvbGxvd2luZyBhdHRyaWJ1dGlvbiBu"
            "b3RpY2VzIHdpdGhpbiBhICJOb3RpY2UiIHRleHQgZmlsZSBkaXN0cmlidXRlZCBhcyBh"
            "IHBhcnQgb2Ygc3VjaCBjb3BpZXM6ICJRd2VuIGlzIGxpY2Vuc2VkIHVuZGVyIHRoZSBR"
            "d2VuIFJFU0VBUkNIIExJQ0VOU0UgQUdSRUVNRU5ULCBDb3B5cmlnaHQgKGMpIEFsaWJh"
            "YmEgQ2xvdWQuIEFsbCBSaWdodHMgUmVzZXJ2ZWQuIjsgYW5kCiAgICBkLiBZb3UgbWF5"
            "IGFkZCB5b3VyIG93biBjb3B5cmlnaHQgc3RhdGVtZW50IHRvIHlvdXIgbW9kaWZpY2F0"
            "aW9ucyBhbmQgbWF5IHByb3ZpZGUgYWRkaXRpb25hbCBvciBkaWZmZXJlbnQgbGljZW5z"
            "ZSB0ZXJtcyBhbmQgY29uZGl0aW9ucyBmb3IgdXNlLCByZXByb2R1Y3Rpb24sIG9yIGRp"
            "c3RyaWJ1dGlvbiBvZiB5b3VyIG1vZGlmaWNhdGlvbnMsIG9yIGZvciBhbnkgc3VjaCBk"
            "ZXJpdmF0aXZlIHdvcmtzIGFzIGEgd2hvbGUsIHByb3ZpZGVkIHlvdXIgdXNlLCByZXBy"
            "b2R1Y3Rpb24sIGFuZCBkaXN0cmlidXRpb24gb2YgdGhlIHdvcmsgb3RoZXJpd3NlIGNv"
            "bXBsaWVzIHdpdGggdGhlIHRlcm1zIGFuZCBjb25kaXRpb25zIG9mIHRoaXMgQWdyZWVt"
            "ZW50LgoKNC4gUnVsZXMgb2YgdXNlCiAgICBhLiBUaGUgTWF0ZXJpYWxzIG1heSBiZSBz"
            "dWJqZWN0IHRvIGV4cG9ydCBjb250cm9scyBvciBpbiByZXN0cmljdGlvbnMgaW4gQ2hp"
            "bmEsIHRoZSBVbml0ZWQgU3RhdGVzIG9yIG90aGVyIGNvdW50cmllcyBvciByZWdpb25z"
            "LiBZb3Ugc2hhbGwgY29tcGx5IHdpdGggYXBwbGljYWJsZSBsYXdzIGFuZCByZWd1bGF0"
            "aW9ucyBpbiB5b3VyIHVzZSBvZiB0aGUgTWF0ZXJpYWxzLgogICAgYi4gSWYgeW91IHVz"
            "ZSB0aGUgTWF0ZXJpYWxzIG9yIGFueSBvdXRwdXRzIG9yIHJlc3VsdHMgdGhlcmVmcm9t"
            "IHRvIGNyZWF0ZSwgdHJhaW4sIGZpbmUtdHVuZSwgb3IgaW1wcm92ZSBhbiBBSSBtb2Rl"
            "bCB0aGF0IGlzIGRpc3RyaWJ1dGVkIG9yIG1hZGUgYXZhaWxhYmxlLCB5b3Ugc2hhbGwg"
            "cHJvbWluZW50bHkgZGlzcGxheSDigJxCdWlsdCB3aXRoIFF3ZW7igJ0gb3Ig4oCcSW1w"
            "cm92ZWQgdXNpbmcgUXdlbuKAnSBpbiB0aGUgcmVsYXRlZCBwcm9kdWN0IGRvY3VtZW50"
            "YXRpb24uCgo1LiBJbnRlbGxlY3R1YWwgUHJvcGVydHkKICAgIGEuIFdlIHJldGFpbiBv"
            "d25lcnNoaXAgb2YgYWxsIGludGVsbGVjdHVhbCBwcm9wZXJ0eSByaWdodHMgaW4gYW5k"
            "IHRvIHRoZSBNYXRlcmlhbHMgYW5kIGRlcml2YXRpdmVzIG1hZGUgYnkgb3IgZm9yIHVz"
            "LiBDb25kaXRpb25lZCB1cG9uIGNvbXBsaWFuY2Ugd2l0aCB0aGUgdGVybXMgYW5kIGNv"
            "bmRpdGlvbnMgb2YgdGhpcyBBZ3JlZW1lbnQsIHdpdGggcmVzcGVjdCB0byBhbnkgZGVy"
            "aXZhdGl2ZSB3b3JrcyBhbmQgbW9kaWZpY2F0aW9ucyBvZiB0aGUgTWF0ZXJpYWxzIHRo"
            "YXQgYXJlIG1hZGUgYnkgeW91LCB5b3UgYXJlIGFuZCB3aWxsIGJlIHRoZSBvd25lciBv"
            "ZiBzdWNoIGRlcml2YXRpdmUgd29ya3MgYW5kIG1vZGlmaWNhdGlvbnMuCiAgICBiLiBOb"
            "yB0cmFkZW1hcmsgbGljZW5zZSBpcyBncmFudGVkIHRvIHVzZSB0aGUgdHJhZGUgbmFt"
            "ZXMsIHRyYWRlbWFya3MsIHNlcnZpY2UgbWFya3MsIG9yIHByb2R1Y3QgbmFtZXMgb2Yg"
            "dXMsIGV4Y2VwdCBhcyByZXF1aXJlZCB0byBmdWxmaWxsIG5vdGljZSByZXF1aXJlbWVu"
            "dHMgdW5kZXIgdGhpcyBBZ3JlZW1lbnQgb3IgYXMgcmVxdWlyZWQgZm9yIHJlYXNvbmFi"
            "bGUgYW5kIGN1c3RvbWFyeSB1c2UgaW4gZGVzY3JpYmluZyBhbmQgcmVkaXN0cmlidXRp"
            "bmcgdGhlIE1hdGVyaWFscy4KICAgIGMuIElmIHlvdSBjb21tZW5jZSBhIGxhd3N1aXQg"
            "b3Igb3RoZXIgcHJvY2VlZGluZ3MgKGluY2x1ZGluZyBhIGNyb3NzLWNsYWltIG9yIGNv"
            "dW50ZXJjbGFpbSBpbiBhIGxhd3N1aXQpIGFnYWluc3QgdXMgb3IgYW55IGVudGl0eSBh"
            "bGxlZ2luZyB0aGF0IHRoZSBNYXRlcmlhbHMgb3IgYW55IG91dHB1dCB0aGVyZWZyb20s"
            "IG9yIGFueSBwYXJ0IG9mIHRoZSBmb3JlZ29pbmcsIGluZnJpbmdlIGFueSBpbnRlbGxl"
            "Y3R1YWwgcHJvcGVydHkgb3Igb3RoZXIgcmlnaHQgb3duZWQgb3IgbGljZW5zYWJsZSBi"
            "eSB5b3UsIHRoZW4gYWxsIGxpY2Vuc2VzIGdyYW50ZWQgdG8geW91IHVuZGVyIHRoaXMg"
            "QWdyZWVtZW50IHNoYWxsIHRlcm1pbmF0ZSBhcyBvZiB0aGUgZGF0ZSBzdWNoIGxhd3N1"
            "aXQgb3Igb3RoZXIgcHJvY2VlZGluZyBpcyBjb21tZW5jZWQgb3IgYnJvdWdodC4KCjYu"
            "IERpc2NsYWltZXIgb2YgV2FycmFudHkgYW5kIExpbWl0YXRpb24gb2YgTGlhYmlsaXR5"
            "CiAgICBhLiBXZSBhcmUgbm90IG9ibGlnYXRlZCB0byBzdXBwb3J0LCB1cGRhdGUsIHBy"
            "b3ZpZGUgdHJhaW5pbmcgZm9yLCBvciBkZXZlbG9wIGFueSBmdXJ0aGVyIHZlcnNpb24g"
            "b2YgdGhlIFF3ZW4gTWF0ZXJpYWxzIG9yIHRvIGdyYW50IGFueSBsaWNlbnNlIHRoZXJl"
            "dG8uCiAgICBiLiBUSEUgTUFURVJJQUxTIEFSRSBQUk9WSURFRCAiQVMgSVMiIFdJVEhP"
            "VVQIQU5ZIEVYUFJFU1MgT1IgSU1QTElFRCBXQVJSQU5UWSBPRiBBTlkgS0lORCBJTkNM"
            "VURJR1cgV0FSUkFOVElFUyBPRiBNRVJDSEFOVEFCSUxJVFksIE5PTklORlJJTkdFTUVO"
            "VCwgT1IgRklUTkVTUyBGT1IgQSBQQVJUSUNVTEFSIFBVUlBPU0UuIFdFIE1BS0UgTk8g"
            "V0FSUkFOVFkgQU5EIEFTU1VNRSBOTyBSRVNQT05TSUJJTElUWSBGT1IgVEhFIFNBRkVU"
            "WSBPUCBTVEFCSU1JVFkgT0YgVEhFIE1BVEVSSUFMUyBBTkQgQU5ZIE9VVFBVVCBUSEVY"
            "RUJST00uCiAgICBjLiBJTiBOTyBFVkVOVCBTSEFMTCBXRSBCRSBMSUFCTEUgVE8gWU9V"
            "IEZPUiBBTlkgREFNQUdFUywgSU5DTFVESU5HLCBCVVQgTk9UIExJTUlURUQgVE8gQU5Z"
            "IERJUkVDVCwgT1IgSU5ESVJFQ1QsIFNQRUNJQUwgT1IgQ09OU0VRVUVOVElBTCBEQU1B"
            "R0VTIEFSSVNJTkcgRlJPTSBZT1VSIFVTRSBPUiBJTkFCSUxJVFkgVE8gVVNFIFRIRSBN"
            "QVRSSUFMSU9SIEFOWSBPVVRQVVQgT0YgSVQsIE5PIE1BVFRFUiBIT1cgSVTigJlTIENB"
            "VVNFRC4KICAgIGQuIFlvdSB3aWxsIGRlZmVuZCwgaW5kZW1uaWZ5IGFuZCBob2xkIGhh"
            "cm1sZXNzIHVzIGZyb20gYW5kIGFnYWluc3QgYW55IGNsYWltIGJ5IGFueSB0aGlyZCBw"
            "YXJ0eSBhcmlzaW5nIG91dCBvZiBvciByZWxhdGVkIHRvIHlvdXIgdXNlIG9yIGRpc3Ry"
            "aWJ1dGlvbiBvZiB0aGUgTWF0ZXJpYWxzLgoKNy4gU3Vydml2YWwgYW5kIFRlcm1pbmF0"
            "aW9uLgogICAgYS4gVGhlIHRlcm0gb2YgdGhpcyBBZ3JlZW1lbnQgc2hhbGwgY29tbWVu"
            "Y2UgdXBvbiB5b3VyIGFjY2VwdGFuY2Ugb2YgdGhpcyBBZ3JlZW1lbnQgb3IgYWNjZXNz"
            "IHRvIHRoZSBNYXRlcmlhbHMgYW5kIHdpbGwgY29udGludWUgaW4gZnVsbCBmb3JjZSBh"
            "bmQgZWZmZWN0IHVudGlsIHRlcm1pbmF0ZWQgaW4gYWNjb3JkYW5jZSB3aXRoIHRoZSB0"
            "ZXJtcyBhbmQgY29uZGl0aW9ucyBoZXJlaW4uCiAgICBiLiBXZSBtYXkgdGVybWluYXRl"
            "IHRoaXMgQWdyZWVtZW50IGlmIHlvdSBicmVhY2ggYW55IG9mIHRoZSB0ZXJtcyBvciBj"
            "b25kaXRpb25zIG9mIHRoaXMgQWdyZWVtZW50LiBVcG9uIHRlcm1pbmF0aW9uIG9mIHRo"
            "aXMgQWdyZWVtZW50LCB5b3UgbXVzdCBkZWxldGUgYW5kIGNlYXNlIHVzZSBvZiB0aGUg"
            "TWF0ZXJpYWxzLiBTZWN0aW9ucyA2IGFuZCA4IHNoYWxsIHN1cnZpdmUgdGhlIHRlcm1p"
            "bmF0aW9uIG9mIHRoaXMgQWdyZWVtZW50LgoKOC4gR292ZXJuaW5nIExhdyBhbmQgSnVy"
            "aXNkaWN0aW9uLgogICAgYS4gVGhpcyBBZ3JlZW1lbnQgYW5kIGFueSBkaXNwdXRlIGFy"
            "aXNpbmcgb3V0IG9mIG9yIHJlbGF0aW5nIHRvIGl0IHdpbGwgYmUgZ292ZXJuZWQgYnkg"
            "dGhlIGxhd3Mgb2YgQ2hpbmEsIHdpdGhvdXQgcmVnYXJkIHRvIGNvbmZsaWN0IG9mIGxh"
            "dyBwcmluY2lwbGVzLCBhbmQgdGhlIFVOIENvbnZlbnRpb24gb24gQ29udHJhY3RzIGZv"
            "ciB0aGUgSW50ZXJuYXRpb25hbCBTYWxlIG9mIEdvb2RzIGRvZXMgbm90IGFwcGx5IHRv"
            "IHRoaXMgQWdyZWVtZW50LgogICAgYi4gVGhlIFBlb3BsZSdzIENvdXJ0cyBpbiBIYW5n"
            "emhvdSBDaXR5IHNoYWxsIGhhdmUgZXhjbHVzaXZlIGp1cmlzZGljdGlvbiBvdmVyIGFu"
            "eSBkaXNwdXRlIGFyaXNpbmcgb3V0IG9mIHRoaXMgQWdyZWVtZW50LgoKOS4gT3RoZXIg"
            "VGVybXMgYW5kIENvbmRpdGlvbnMuCiAgICBhLiBBbnkgYXJyYW5nZW1lbnRzLCB1bmRl"
            "cnN0YW5kaW5ncywgb3IgYWdyZWVtZW50cyByZWdhcmRpbmcgdGhlIE1hdGVyaWFsIG5v"
            "dCBzdGF0ZWQgaGVyZWluIGFyZSBzZXBhcmF0ZSBmcm9tIGFuZCBpbmRlcGVuZGVudCBv"
            "ZiB0aGUgdGVybXMgYW5kIGNvbmRpdGlvbnMgb2YgdGhpcyBBZ3JlZW1lbnQuIFlvdSBz"
            "aGFsbCByZXF1ZXN0IGEgc2VwYXJhdGUgbGljZW5zZSBmcm9tIHVzLCBpZiB5b3UgdXNl"
            "IHRoZSBNYXRlcmlhbHMgaW4gd2F5cyBub3QgZXhwcmVzc2x5IGFncmVlZCB0byBpbiB0"
            "aGlzIEFncmVlbWVudC4gCiAgICBiLiBXZSBzaGFsbCBub3QgYmUgYm91bmQgYnkgYW55"
            "IGFkZGl0aW9uYWwgb3IgZGlmZmVyZW50IHRlcm1zIG9yIGNvbmRpdGlvbnMgY29tbXVu"
            "aWNhdGVkIGJ5IHlvdSB1bmxlc3MgZXhwcmVzc2x5IGFncmVlZC4="
        ),
        # generation params (18 B)
        "58e1b82a691f46c155e57be607f1031930ea0cccc22daf4447f91d360f74b2d2": _b64.b64decode(
            "eyJudW1fY3R4IjoxNjM4NH0K"
        ),
    }

    # Determine where to write — must match where Ollama is reading from.
    #
    # Full build:  OLLAMA_MODELS = bundle_dir/ollama_models/ (read-only after signing)
    #              → fall back to DATA_DIR/ollama_models/ and update the env var
    # Minimal/dev: OLLAMA_MODELS not set → use ~/.ollama/models/ (system Ollama default)
    preferred = (
        Path(os.environ["OLLAMA_MODELS"])
        if "OLLAMA_MODELS" in os.environ
        else Path.home() / ".ollama" / "models"
    )
    # Test write-ability
    target = preferred
    try:
        preferred.mkdir(parents=True, exist_ok=True)
        _probe = preferred / ".write_probe"
        _probe.touch()
        _probe.unlink()
    except (PermissionError, OSError):
        target = OLLAMA_MODELS_DIR
        os.environ["OLLAMA_MODELS"] = str(target)
        logger.warning(
            "OLLAMA_MODELS (%s) is read-only; falling back to %s", preferred, target
        )

    blobs_dir = target / "blobs"
    blobs_dir.mkdir(parents=True, exist_ok=True)

    # Place the main 1.9 GB model blob
    dest = blobs_dir / f"sha256-{model_hash}"
    if dest.exists():
        dest.unlink(missing_ok=True)
    shutil.move(str(tmp), str(dest))
    logger.info("Ollama model blob placed at %s", dest)

    # Write all small supporting blobs (only if not already present)
    for hash_hex, data in SUPPORTING_BLOBS.items():
        blob_path = blobs_dir / f"sha256-{hash_hex}"
        if not blob_path.exists():
            blob_path.write_bytes(data)

    # Write the complete manifest (matches packaging/ollama_models/manifests/...)
    manifest_dir = target / "manifests" / "registry.ollama.ai" / "library" / "qwen2.5"
    manifest_dir.mkdir(parents=True, exist_ok=True)
    manifest = {
        "schemaVersion": 2,
        "mediaType": "application/vnd.docker.distribution.manifest.v2+json",
        "config": {
            "mediaType": "application/vnd.docker.container.image.v1+json",
            "digest": "sha256:f51b6c48b987857d6dc3bd2cbbeffe37b6355e417cdaca3d5ab135f12b2674a4",
            "size": 561,
        },
        "layers": [
            {
                "mediaType": "application/vnd.ollama.image.model",
                "digest": f"sha256:{model_hash}",
                "size": 1929903008,
            },
            {
                "mediaType": "application/vnd.ollama.image.system",
                "digest": "sha256:66b9ea09bd5b7099cbb4fc820f31b575c0366fa439b08245566692c6784e281e",
                "size": 68,
            },
            {
                "mediaType": "application/vnd.ollama.image.template",
                "digest": "sha256:eb4402837c7829a690fa845de4d7f3fd842c2adee476d5341da8a46ea9255175",
                "size": 1482,
            },
            {
                "mediaType": "application/vnd.ollama.image.license",
                "digest": "sha256:b5c0e5cf74cf51af1ecbc4af597cfcd13fd9925611838884a681070838a14a50",
                "size": 7387,
            },
            {
                "mediaType": "application/vnd.ollama.image.params",
                "digest": "sha256:58e1b82a691f46c155e57be607f1031930ea0cccc22daf4447f91d360f74b2d2",
                "size": 18,
            },
        ],
    }
    (manifest_dir / "3b").write_text(json.dumps(manifest))
    logger.info("Ollama manifest written at %s (target=%s)", manifest_dir / "3b", target)


def _install_hf_tarball(slug: str, tmp: Path) -> None:
    """Extract a HuggingFace model tarball into DATA_DIR/models/hub/."""
    hub_dir = HF_MODELS_DIR / "hub"
    hub_dir.mkdir(parents=True, exist_ok=True)

    canonical_dir = _canonical_hf_model_dir_for(slug)
    if canonical_dir is None:
        raise RuntimeError(f"Unknown HF model slug: {slug}")

    # Extract to a staging directory first so a broken/corrupted existing
    # directory cannot block the install (common on Windows when HF cache
    # symlinks become unreadable reparse points).
    staging = hub_dir / f"{canonical_dir.name}.staging"
    if staging.exists():
        shutil.rmtree(staging, ignore_errors=True)

    logger.info("Extracting %s → %s", tmp.name, staging)
    try:
        with tarfile.open(tmp, "r:gz") as tf:
            tf.extractall(staging)
    except tarfile.ReadError as exc:
        raise RuntimeError(f"Downloaded file is not a valid gzip tarball: {exc}") from exc
    except Exception as exc:
        raise RuntimeError(f"Extraction failed: {exc}") from exc

    # The tarball has a top-level directory; find the actual model dir inside staging.
    extracted_model_dir = staging / canonical_dir.name
    if not extracted_model_dir.exists():
        for child in staging.iterdir():
            if child.is_dir():
                extracted_model_dir = child
                break

    if not extracted_model_dir.exists() or not _has_usable_hf_snapshot(extracted_model_dir):
        raise RuntimeError("Downloaded model package did not contain a usable HuggingFace snapshot.")

    # Try to move the extracted model to its canonical location.
    final_dir = canonical_dir
    fallback_dir = canonical_dir.with_name(f"{canonical_dir.name}.extracted")
    try:
        if final_dir.exists():
            shutil.rmtree(final_dir, ignore_errors=True)
        shutil.move(str(extracted_model_dir), str(final_dir))
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)
    except Exception as exc:
        logger.warning("Could not move extracted model to %s: %s. Using fallback location.", final_dir, exc)
        if fallback_dir.exists():
            shutil.rmtree(fallback_dir, ignore_errors=True)
        try:
            shutil.move(str(extracted_model_dir), str(fallback_dir))
            if staging.exists():
                shutil.rmtree(staging, ignore_errors=True)
            final_dir = fallback_dir
        except Exception as exc2:
            logger.error("Could not move to fallback either: %s", exc2)
            final_dir = extracted_model_dir

    # Set env vars so sentence_transformers finds the models
    os.environ["HF_HOME"] = str(HF_MODELS_DIR)
    os.environ["SENTENCE_TRANSFORMERS_HOME"] = str(HF_MODELS_DIR / "sentence_transformers")
    os.environ["TRANSFORMERS_CACHE"] = str(HF_MODELS_DIR / "hub")
    logger.info("HF model extracted; final_dir=%s HF_HOME=%s", final_dir, HF_MODELS_DIR)
