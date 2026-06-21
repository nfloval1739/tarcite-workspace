# Installing TarCite Workspace on Windows

If you see a **"Windows protected your PC"** or **"Unknown publisher"** warning when running the installer, this guide explains why and how to proceed safely.

---

## Why does this happen?

TarCite Workspace is built by **Naufal Naufal** (individual developer). Currently, the Windows installer is **not digitally signed with a Microsoft-trusted certificate**.

Windows SmartScreen shows this warning for all unsigned software to protect users from malware. It does **not** mean the app is harmful — it simply means Windows does not recognize the publisher yet.

We are working on obtaining a code signing certificate to remove this warning in a future release.

---

## How to install safely

### Step 1 — Download the installer

Download the latest `.exe` from the release page:
- **Full installer** (`TarCiteWorkspace-Setup.exe`) — includes AI models (~3–4 GB). Works offline immediately.
- **Minimal installer** (`TarCiteWorkspace_minimal-Setup.exe`) — smaller download (~200 MB), but requires an internet connection on first run to download models.

### Step 2 — Run the installer

1. Double-click the downloaded `.exe` file.
2. If you see **"Windows protected your PC"**, click **"More info"**.
3. Click **"Run anyway"**.

> The app does not need Administrator rights. The installer will ask whether to install for "Anyone who uses this computer" or "Just me". Either option works.

### Step 3 — Launch the app

After installation, you can start TarCite Workspace from:
- The **Start Menu** → TarCite Workspace
- The **Desktop shortcut** (if you chose it during install)

On first launch, the app will:
1. Start the local FastAPI server
2. Start the bundled Ollama server (for offline AI)
3. Open the app window

This may take **30–60 seconds** on first launch.

---

## Antivirus warnings

Some antivirus programs (especially heuristic scanners) may flag PyInstaller-built apps as suspicious on first release. If this happens:

1. **Windows Defender** — click **"Allow on device"** if prompted.
2. **Third-party antivirus** — add the install folder (`%APPDATA%\TarCite Workspace` or `C:\Program Files\TarCite Workspace`) to your antivirus exclusion list.

If your antivirus quarantines the installer, you can verify the file is genuine by checking that it came from the official release page.

---

## Uninstalling

To remove TarCite Workspace:
1. Open **Settings → Apps → Installed apps**
2. Find **TarCite Workspace**
3. Click **Uninstall**

> Your personal citation library, settings, and database are **not deleted** during uninstall. They remain in `%APPDATA%\TarCiteWorkspace\` in case you reinstall later. To fully remove all data, delete that folder manually.

---

## Need help?

If you encounter any other issues during installation, please report them with:
- Your Windows version (e.g., Windows 11 23H2)
- The installer filename you downloaded
- Any error messages or screenshots
