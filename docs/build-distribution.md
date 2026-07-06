# TarCite Workspace — Distribution Build Guide (Windows)

This document explains how to build the distributable Windows installer.

> The app also runs from source on other operating systems (see the README), but this
> repository only maintains **Windows** packaging.

---

## Overview

TarCite Workspace is packaged using **PyInstaller**, which bundles the Python app, all
dependencies, the embedding models, and the bundled Ollama server (with qwen2.5:3b) into a
self-contained package. **Inno Setup** then wraps it into an installer.

| Output | Tool |
|---|---|
| `TarCiteWorkspace-Setup.exe` | PyInstaller + Inno Setup |

The full package includes everything the user needs — no internet connection required
after install:
- The FastAPI web app
- Bundled Ollama server binary
- qwen2.5:3b model (~1.9 GB)
- Embedding models: BAAI/bge-large-en-v1.5 + BAAI/bge-reranker-base (~1.7 GB)
- Word add-in files

A **minimal** variant (~200 MB) ships without the bundled models; they download on first run.

---

## Prerequisites

- **Python 3.12** — from [python.org](https://python.org) (tick "Add Python to PATH")
- **Visual C++ Build Tools** — [visualstudio.microsoft.com](https://visualstudio.microsoft.com/visual-cpp-build-tools/), workload "Desktop development with C++"
- **Inno Setup 6+** — from [jrsoftware.org/isinfo.php](https://jrsoftware.org/isinfo.php), must be on PATH as `iscc`
- **A Python virtual environment** at `venv\` in the project root

---

## Build

All steps run from the **project root** in a Command Prompt or PowerShell window.

### Step 1 — Activate the virtual environment

```bat
venv\Scripts\activate
```

### Step 2 — Run the build script

```bat
packaging\build_windows.bat
```

The script runs these steps automatically:

1. Installs build dependencies
2. Skips ML model download if `packaging\models\` already exists
3. Downloads the Ollama binary and copies qwen2.5:3b model blobs if not already present
4. Runs PyInstaller → produces `dist\TarCiteWorkspace\`
5. Runs Inno Setup (`iscc`) → produces `dist\TarCiteWorkspace-Setup.exe`

For the minimal installer:

```bat
set BUILD_VARIANT=minimal
packaging\build_windows.bat
```

### Build output

```
dist\TarCiteWorkspace-Setup.exe    ← distribute this file
dist\TarCiteWorkspace\             ← intermediate folder (not distributed)
```

---

## Code Signing

Unsigned installers trigger a SmartScreen "Unknown publisher" warning on first install.

GitHub Actions signs the Windows installer when a Windows code-signing certificate is
provided as repository secrets. The certificate is not stored in the repo.

Required repository secrets:

| Secret | Value |
|---|---|
| `WINDOWS_CODESIGN_PFX_BASE64` | Base64-encoded `.pfx` code-signing certificate |
| `WINDOWS_CODESIGN_PFX_PASSWORD` | Password for the `.pfx` certificate |

On macOS, copy the base64 certificate value with:

```bash
base64 -i certificate.pfx | tr -d '\n' | pbcopy
```

Then add both secrets in GitHub: **Settings → Secrets and variables → Actions**.

The workflow signs `dist\TarCiteWorkspace_minimal-Setup.exe` before uploading it to the
`windows-latest` release. If the secrets are missing, the workflow still builds and
uploads the installer, but it remains unsigned.

If you build locally and have your own code-signing certificate:

```bat
signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 ^
    /n "<Your Certificate Subject>" ^
    dist\TarCiteWorkspace-Setup.exe
```

---

## First-time setup: downloading the assets

The ML models and Ollama binary only need to be downloaded once. After the first build
they are cached in `packaging\` and skipped on subsequent builds.

| Asset | Location after download | Size |
|---|---|---|
| Embedding + reranker models | `packaging\models\` | ~1.5 GB |
| Ollama binary | `packaging\ollama_win\` | ~130 MB |
| qwen2.5:3b model blobs | `packaging\ollama_models\` | ~1.9 GB |

To download them manually (if the build script skips them incorrectly):

- ML models: `python packaging\download_models.py`
- Ollama + qwen2.5:3b: `packaging\download_ollama.bat`

The Ollama download script checks `%USERPROFILE%\.ollama\models\` first and copies the
blobs locally instead of pulling from the internet, so if you already have qwen2.5:3b
installed in Ollama, it will not re-download.

---

## What is bundled vs what stays on the user's machine

**Bundled inside the package (same for every user):**
- App code, web UI, Word add-in files
- CSL citation styles
- Ollama server binary + qwen2.5:3b model
- Embedding and reranker models

**Created fresh on each user's machine (never bundled):**
- SQLite citation database
- ChromaDB vector store
- `settings.json` (AI profiles, reference directories, API keys)
- SSL certificate for `https://tarcite.workspace`
- Device ID

User data lives at `%APPDATA%\TarCiteWorkspace\`. Updates never overwrite user data, and
uninstalling the app leaves the library intact.

---

## Troubleshooting

**PyInstaller fails with `ModuleNotFoundError`**
A hidden import is missing from `citation.spec`. Add the module name to the `all_hidden`
list in the spec and rebuild.

**App opens but Ollama doesn't start**
Check that `packaging\ollama_win\ollama.exe` exists. If the binary is missing, re-run
`packaging\download_ollama.bat`. Also check that `packaging\ollama_models\manifests\`
exists and contains the qwen2.5 manifest.

**Installer is large**
The full installer (~3–4 GB) is expected — it includes the qwen2.5:3b model. Use the
minimal variant if you want a small installer that downloads models on first run.

---

## Rebuilding after a code change

If you change app code only (no model or dependency changes), re-run
`packaging\build_windows.bat` — PyInstaller rebuilds the app and the model download steps
are skipped automatically.

If you update Python dependencies (`requirements.txt`), reinstall them, check whether any
new packages need hidden imports added to `citation.spec`, then rebuild.
