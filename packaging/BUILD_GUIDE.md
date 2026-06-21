# TarCite Workspace — Build Guide

All commands are run from the **project root** (the folder containing `citation.spec`).

---

## macOS — DMG Build

### Dependencies (one-time setup)

```bash
# 1. Homebrew (if not installed)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# 2. create-dmg (for packaging the .app into a DMG)
brew install create-dmg

# 3. Python build deps
pip install -r packaging/requirements-build.txt
```

A valid **Developer ID Application** certificate must be installed in your login keychain for code-signing. Notarization also requires an app-specific password from [appleid.apple.com](https://appleid.apple.com) → Security.

### Build commands

**Full build** — PyInstaller + bundled models/Ollama + signed DMG (~3–4 GB):
```bash
bash packaging/build_mac.sh
```
Output: `dist/TarCiteWorkspace-mac.dmg`

**Full build + minimal DMG in one go:**
```bash
MINIMAL=1 bash packaging/build_mac.sh
```
Output: `dist/TarCiteWorkspace-mac.dmg` + `dist/TarCiteWorkspace_minimal-mac.dmg`

**Minimal DMG only** — reuses existing `dist/TarCiteWorkspace.app`, strips models, re-signs:
```bash
bash packaging/build_minimal_only.sh
```
Output: `dist/TarCiteWorkspace_minimal-mac.dmg`

**With notarization** (for public distribution):
```bash
export APPLE_ID="nfloval.mh@gmail.com"
export APPLE_APP_PASSWORD="xxxx-xxxx-xxxx-xxxx"   # app-specific password
bash packaging/build_mac.sh
```

---

## Windows — EXE Installer Build

### Dependencies (one-time setup)

1. **Python 3.11+** — [python.org/downloads](https://www.python.org/downloads/)
   - During install, tick **"Add Python to PATH"**

2. **Visual C++ Build Tools** — required by some Python packages:
   - Download [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
   - Select workload: **"Desktop development with C++"**

3. **Inno Setup 6+** — creates the `.exe` installer:
   - Download from [jrsoftware.org/isinfo.php](https://jrsoftware.org/isinfo.php)
   - Install with default options (adds `iscc` to PATH)

4. **Python build deps** — run in Command Prompt from the project root:
   ```bat
   pip install -r requirements.txt
   pip install -r packaging\requirements-build.txt
   ```

### Build commands

**Full build** — PyInstaller + bundled models/Ollama + signed installer (~3–4 GB):
```bat
packaging\build_windows.bat
```
Output: `dist\TarCiteWorkspace-Setup.exe`

**Minimal build** — no bundled models, smaller installer:
```bat
set BUILD_VARIANT=minimal
packaging\build_windows.bat
```
Output: `dist\TarCiteWorkspace_minimal-Setup.exe`

**Signed build** (requires code signing certificate installed):
```bat
set SIGNTOOL=1
packaging\build_windows.bat
```
Output: signed `dist\TarCiteWorkspace-Setup.exe`

---

## Platform-specific build assets

To prevent macOS, Windows, and Linux binaries from contaminating each other, Ollama binaries are stored in platform-specific folders:

| Platform | Ollama binary folder |
|----------|---------------------|
| macOS | `packaging/ollama_mac/` |
| Windows | `packaging/ollama_win/` |
| Linux | `packaging/ollama_linux/` |

Shared assets (ML models, Ollama model blobs) stay in their original locations:
- `packaging/models/` — HuggingFace embedding/reranker models
- `packaging/ollama_models/` — qwen2.5:3b model blobs

## Version number

Version is defined in these files — update all when bumping:

| File | Field |
|------|-------|
| `app/templates/index.html` | splash + settings panel |
| `word-addin/taskpane.html` | Word add-in splash |
| `packaging/build_minimal_only.sh` | `APP_VERSION` |
| `packaging/setup.iss` | `MyAppVersion` + `MyAppDisplayVersion` |
| `citation.spec` | `APP_VERSION` + `APP_VERSION_STR` (Windows) + `CFBundleVersion` (macOS) |
