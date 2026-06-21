# TarCite Workspace — Distribution Build Guide

This document explains how to build the distributable packages for macOS and Windows.

---

## Overview

TarCite Workspace is packaged using **PyInstaller**, which bundles the Python app, all dependencies, the embedding models, and the bundled Ollama server (with qwen2.5:3b) into a single self-contained package.

| Platform | Output | Tool |
|---|---|---|
| macOS | `TarCiteWorkspace-mac.dmg` | PyInstaller + create-dmg |
| Windows | `TarCiteWorkspace-Setup.exe` | PyInstaller + Inno Setup |

The final package includes everything the user needs — no internet connection required after install:
- The FastAPI web app
- Bundled Ollama server binary
- qwen2.5:3b model (~1.9 GB)
- Embedding models: BAAI/bge-large-en-v1.5 + BAAI/bge-reranker-base (~1.7 GB)
- Word add-in files

---

## Prerequisites

### macOS

Install these before building:

- **Python 3.12** — via Anaconda or Homebrew
- **Homebrew** — [brew.sh](https://brew.sh)
- **create-dmg** — `brew install create-dmg`
- **Xcode Command Line Tools** — `xcode-select --install`
- **A Python virtual environment** at `venv/` in the project root (run `python3 -m venv venv && source venv/bin/activate && pip install -r requirements.txt`)

### Windows

- **Python 3.12** — from [python.org](https://python.org)
- **Inno Setup 6+** — from [jrsoftware.org/isinfo.php](https://jrsoftware.org/isinfo.php), must be on PATH as `iscc`
- **A Python virtual environment** at `venv\` in the project root

### Code Signing (macOS only)

You need a **Developer ID Application** certificate from Apple in your login keychain.

For PT. DIGITAL ENGINERING INDONESIA, the certificate is already installed on the build Mac. If you ever need to reinstall it:

1. Open the `.cer` file from `developerID_application.cer` in the project root
2. Double-click it — Keychain Access will import it automatically
3. Confirm it appears as: `Developer ID Application: PT. DIGITAL ENGINERING INDONESIA (8XBP4MRL6L)`

---

## macOS Build

All steps run from the **project root** directory.

### Step 1 — Activate the virtual environment

```
source venv/bin/activate
```

### Step 2 — Run the build script

```
bash packaging/build_mac.sh
```

The script runs these steps automatically:

1. Installs build dependencies (PyInstaller, pystray, Pillow)
2. Skips ML model download if `packaging/models/` already exists
3. Skips Ollama download if `packaging/ollama_mac/ollama` already exists
4. Generates the `.icns` icon file from `app/static/logo/TarCite_logo.png`
5. Runs PyInstaller using `citation.spec` → produces `dist/TarCiteWorkspace.app`
6. Code-signs the app bundle with the Developer ID Application certificate
7. Creates `dist/TarCiteWorkspace-mac.dmg` using create-dmg
8. Signs the DMG

### Step 3 — Notarize the DMG

Notarization submits the DMG to Apple's servers for malware scanning. It is required for Gatekeeper to accept the app without warnings on other Macs.

Set your credentials in the terminal (do not store these in any file):

```
export APPLE_ID="info@dei.co.id"
export APPLE_APP_PASSWORD="xxxx-xxxx-xxxx-xxxx"
```

Generate the app-specific password at [appleid.apple.com](https://appleid.apple.com) → Sign-In and Security → App-Specific Passwords. Create a new one named "TarCite Build" each time.

Then submit:

```
xcrun notarytool submit dist/TarCiteWorkspace-mac.dmg \
    --apple-id "$APPLE_ID" \
    --team-id "8XBP4MRL6L" \
    --password "$APPLE_APP_PASSWORD" \
    --wait
```

Upload takes several minutes depending on connection speed (the DMG is ~3 GB). Once you see `status: Accepted`, staple the ticket:

```
xcrun stapler staple dist/TarCiteWorkspace-mac.dmg
```

The DMG is now fully notarized and ready to distribute.

### Build output

```
dist/TarCiteWorkspace-mac.dmg    ← distribute this file (~3 GB)
dist/TarCiteWorkspace.app        ← intermediate app bundle (not distributed)
```

---

## Windows Build

All steps run from the **project root** directory in a Command Prompt or PowerShell window.

### Step 1 — Activate the virtual environment

```
venv\Scripts\activate
```

### Step 2 — Run the build script

```
packaging\build_windows.bat
```

The script runs these steps automatically:

1. Installs build dependencies
2. Skips ML model download if `packaging\models\` already exists
3. Downloads Ollama binary and copies qwen2.5:3b model blobs if not already present
4. Runs PyInstaller → produces `dist\TarCiteWorkspace\`
5. Runs Inno Setup (`iscc`) → produces `dist\TarCiteWorkspace-Setup.exe`

### Code Signing (Windows)

Windows code signing is not yet configured. Without it, SmartScreen will show an "Unknown publisher" warning on first install. This is acceptable for beta distribution.

To add signing when you have an EV code signing certificate:

```
signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 ^
    /n "Naufal Naufal" ^
    dist\TarCiteWorkspace-Setup.exe
```

### Build output

```
dist\TarCiteWorkspace-Setup.exe    ← distribute this file
dist\TarCiteWorkspace\             ← intermediate folder (not distributed)
```

---

## First-time setup: downloading the assets

The ML models and Ollama binary only need to be downloaded once. After the first build they are cached in `packaging/` and skipped on subsequent builds.

| Asset | Location after download | Size |
|---|---|---|
| Embedding + reranker models | `packaging/models/` | ~1.5 GB |
| Ollama binary | `packaging/ollama_mac/` (macOS), `packaging/ollama_win/` (Windows), `packaging/ollama_linux/` (Linux) | ~130 MB |
| qwen2.5:3b model blobs | `packaging/ollama_models/` | ~1.9 GB |

To download them manually (if the build script skips them incorrectly):

- ML models: `python packaging/download_models.py`
- Ollama + qwen2.5:3b: `bash packaging/download_ollama.sh` (macOS) or `packaging\download_ollama.bat` (Windows)

The Ollama download script checks `~/.ollama/models/` first and copies the blobs locally instead of pulling from the internet, so if you already have qwen2.5:3b installed in Ollama, it will not re-download.

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

User data lives at:
- macOS: `~/Library/Application Support/TarCiteWorkspace/`
- Windows: `%APPDATA%\TarCiteWorkspace\`

This means updates never overwrite user data, and uninstalling the app leaves the library intact.

---

## Troubleshooting

**PyInstaller fails with `ModuleNotFoundError`**
A hidden import is missing from `citation.spec`. Add the module name to the `all_hidden` list in the spec and rebuild.

**`codesign: no identity found`**
The Developer ID Application certificate is not in the keychain. Re-import `developerID_application.cer` from the project root by double-clicking it in Finder.

**Notarization returns `status: Invalid`**
Run `xcrun notarytool log <submission-id> --apple-id info@dei.co.id --team-id 8XBP4MRL6L --password <password>` to see the detailed rejection reason. Common causes are unsigned binaries inside the bundle or a missing entitlements plist.

**App opens but Ollama doesn't start**
Check that `packaging/ollama_mac/ollama` exists and is executable. If the binary is missing, re-run `bash packaging/download_ollama.sh`. Also check that `packaging/ollama_models/manifests/` exists and contains the qwen2.5 manifest.

**DMG is too large**
The ~3 GB size is expected — it includes the full qwen2.5:3b model. Do not try to strip the model blobs; the app will fail at runtime without them.

---

## Rebuilding after a code change

If you change app code only (no model or dependency changes):

1. `source venv/bin/activate`
2. `bash packaging/build_mac.sh` — PyInstaller will rebuild the app bundle; model download steps will be skipped automatically
3. Notarize the new DMG

If you update Python dependencies (`requirements.txt`):

1. `pip install -r requirements.txt`
2. Check if any new packages need hidden imports added to `citation.spec`
3. Rebuild as above

---

*Last updated: May 2026*
