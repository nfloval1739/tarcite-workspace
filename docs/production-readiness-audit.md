# Production Readiness Audit

Date: 2026-05-12

Scope: audit whether TarCite Workspace can currently be installed as a standalone app by normal macOS and Windows users, without manual dependency installation.

## Short Answer

The app is not yet standalone production-ready for general macOS and Windows users.

The current project is a working local/developer-style app with helpful setup scripts, but it still depends on system tools, Python package installation, runtime model downloads, local certificate trust, and Office add-in sideloading behavior. A non-technical user may not be able to install and run it reliably on a clean machine.

## Current Strengths

- The app already runs locally through FastAPI and serves the web UI and Word add-in files.
- macOS and Windows setup scripts exist for starting the local server.
- The scripts create or use a local HTTPS certificate for Word add-in compatibility.
- There is in-app logic for installing, repairing, and uninstalling the Word connector manifest.
- The Word add-in manifest and taskpane are served from the local app.
- The web app and add-in now use vendored icon assets rather than external icon CDNs.

## Main Findings

### 1. Not fully standalone

The app still assumes users have system-level dependencies available.

macOS currently assumes:

- `python3`
- `pip`
- `venv`
- `openssl`
- `lsof`
- admin password access for trusting the certificate

Windows currently assumes:

- `python`
- `pip`
- `venv`
- OpenSSL in `PATH`
- admin permission for certificate trust

The Windows setup script explicitly tells users to install OpenSSL or Git for Windows if OpenSSL is missing. That means the current installer flow is not dependency-free.

### 2. Python dependencies are installed at setup time

The app installs dependencies from `requirements.txt` during setup. This requires:

- internet access
- compatible Python version
- compatible wheels for the user's operating system and CPU architecture
- enough disk space and install time for large packages

Important heavy dependencies include:

- `chromadb`
- `sentence-transformers`
- `PyMuPDF`
- `uvicorn[standard]`

This is acceptable for a developer install, but not ideal for a production end-user installer.

### 3. AI models may download at runtime

The default local embedding and reranker models are loaded by the app after startup. If the models are not already cached, they may be downloaded on first use or startup.

Current defaults include:

- `BAAI/bge-large-en-v1.5`
- `cross-encoder/ms-marco-MiniLM-L-6-v2`

This can fail on offline machines, slow connections, locked-down enterprise machines, or systems where Torch/model dependencies are incompatible.

### 4. Word add-in installation is not fully part of the setup scripts

The double-click setup scripts start the local app and handle certificate setup, but they do not fully install the Word add-in manifest by themselves.

The app has connector installation endpoints and platform-specific installer logic, but the user still needs to trigger that flow from the running app. For production, add-in installation should be part of a clear one-click or guided installation flow.

### 5. The app runs in development server mode

The setup scripts currently start Uvicorn with `--reload`.

That is useful during development, but not appropriate for production distribution. A production build should run a stable packaged server process without reload mode.

### 6. Dependencies are not locked

The dependency file uses broad version ranges such as `>=`.

This means a fresh install in the future may receive newer package versions than the ones currently tested. For production, dependencies should be locked and reproducible.

### 7. Local certificate trust is fragile

The Word add-in requires HTTPS, so the app creates and trusts a self-signed local certificate.

This has several production concerns:

- requires admin permission or password prompts
- may be blocked by enterprise security policy
- may fail silently if the trust command fails
- certificate renewal is not yet handled as a polished user flow
- users may be uncomfortable trusting a local root certificate

### 8. Port handling is fragile

The app assumes port `8000`.

The scripts currently stop any process already using that port. This can interrupt another app and is not production-safe.

For production, the app should either:

- reserve/manage its own local service port safely, or
- find an available port and update the add-in manifest/service config consistently.

### 9. Runtime data is stored inside the project folder

Settings and local databases are currently stored under the project `data/` directory.

For production installers, user data should be stored in OS-appropriate user-data locations, for example:

- macOS: `~/Library/Application Support/TarCite Workspace`
- Windows: `%APPDATA%\TarCite Workspace`

This avoids permission problems when the app is installed in a protected folder.

### 10. Platform coverage still needs real clean-machine testing

The current scripts and installer logic should be tested on:

- clean macOS machine with no developer tools
- clean Windows machine with no Python/OpenSSL installed
- Windows with Microsoft Store Office
- Windows with Click-to-Run Office
- macOS with sandboxed Microsoft Word
- machines with enterprise Office add-in restrictions

Without this testing, production readiness cannot be confirmed.

## Production Packaging Requirements

To become a true standalone install for normal users, the project needs a packaging layer.

### Windows

Recommended production path:

- bundle the Python app into an executable with PyInstaller or equivalent
- package it with Inno Setup or WiX Toolset
- install/start a local background service or user-level launcher
- install the Word add-in manifest
- manage local certificate trust or a safer HTTPS strategy
- store data under `%APPDATA%`
- optionally sign the installer and executable

### macOS

Recommended production path:

- bundle the Python app into a `.app` with PyInstaller, Briefcase, or equivalent
- create a `.dmg` or `.pkg`
- install/start a local background service or launch agent
- install the Word add-in manifest
- manage local certificate trust or a safer HTTPS strategy
- store data under `~/Library/Application Support`
- sign and notarize the app for smooth distribution

## Production Readiness Verdict

Current stage: development/local beta.

Not yet production-ready because:

- dependencies are not bundled
- setup requires system tools and admin actions
- dependency versions are not locked
- runtime model downloads are possible
- Word add-in installation is not fully integrated into setup
- server runs with development reload mode
- user data paths are not production-style
- clean-machine cross-platform testing has not been completed

## Recommended Next Steps

1. Decide the packaging target: simple local beta installer or polished production installer.
2. Lock Python dependencies.
3. Move runtime data to OS user-data directories.
4. Remove `--reload` from production launch scripts.
5. Create packaged app builds for macOS and Windows.
6. Integrate Word connector installation into the installer or first-run flow.
7. Improve certificate setup, verification, renewal, and failure handling.
8. Test on clean macOS and Windows machines.
9. Add code signing and notarization for public production distribution.

