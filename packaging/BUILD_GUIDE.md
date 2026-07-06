# TarCite Workspace — Build Guide (Windows)

All commands are run from the **project root** (the folder containing `citation.spec`).

> This repository builds the **Windows** installer. The app also runs from source on
> other operating systems (see the README), but only Windows packaging is maintained here.

---

## Windows — EXE Installer Build

### Dependencies (one-time setup)

1. **Python 3.12** — [python.org/downloads](https://www.python.org/downloads/)
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

**Full build** — PyInstaller + bundled models/Ollama + installer (~3–4 GB):
```bat
packaging\build_windows.bat
```
Output: `dist\TarCiteWorkspace-Setup.exe`

**Minimal build** — no bundled models, smaller installer (models download on first run):
```bat
set BUILD_VARIANT=minimal
packaging\build_windows.bat
```
Output: `dist\TarCiteWorkspace_minimal-Setup.exe`

**Signed local build** (requires a Windows code-signing certificate installed locally):
```bat
set SIGNTOOL=1
packaging\build_windows.bat
```
Output: signed `dist\TarCiteWorkspace-Setup.exe`

**Signed GitHub Actions build**:

The Windows workflow signs `dist\TarCiteWorkspace_minimal-Setup.exe` automatically when
these repository secrets are configured:

| Secret | Value |
|------|-------|
| `WINDOWS_CODESIGN_PFX_BASE64` | Base64-encoded `.pfx` code-signing certificate |
| `WINDOWS_CODESIGN_PFX_PASSWORD` | Password for the `.pfx` certificate |

On macOS, copy the certificate secret with:

```bash
base64 -i certificate.pfx | tr -d '\n' | pbcopy
```

Then add both secrets in GitHub: **Settings → Secrets and variables → Actions**.

---

## Build assets

The Ollama binary lives in a platform-specific folder so binaries don't contaminate
each other:

| Platform | Ollama binary folder |
|----------|---------------------|
| Windows | `packaging/ollama_win/` |

Shared assets:
- `packaging/models/` — HuggingFace embedding/reranker models
- `packaging/ollama_models/` — qwen2.5:3b model blobs

## Version number

Version is defined in these files — update all when bumping:

| File | Field |
|------|-------|
| `app/templates/index.html` | splash + settings panel |
| `word-addin/taskpane.html` | Word add-in splash |
| `packaging/setup.iss` | `MyAppVersion` + `MyAppDisplayVersion` |
| `citation.spec` | `APP_VERSION` + `APP_VERSION_STR` |
