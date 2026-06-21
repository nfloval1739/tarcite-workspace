# Windows Build Fix Log

This document tracks the Windows packaging problems found during testing and the fixes that should also be considered when rebuilding the macOS DMG.

Current target version label: `v.02.16 (Nokilalaki Peak)`

## Fixed Issues

| Area | Problem Seen | Fix | Commit |
| --- | --- | --- | --- |
| GitHub Actions | Windows build could not run locally from macOS, so CI was needed. Initial push failed because GitHub SSH auth was not ready. | Added Windows GitHub Actions workflow and pushed after SSH authentication was working. | `6cffb650` |
| Repository size | First push tried to upload generated model/Ollama files. | Cleaned generated binaries from Git history and ignored generated model/Ollama directories. | Pre-`023fbcd6` cleanup |
| Windows CI build | Full bundled build downloaded Hugging Face models and Ollama, causing large, slow, fragile builds. Ollama URL/download failed. | Switched CI to minimal Windows installer, matching minimal macOS DMG behavior. The app downloads models internally later. | `023fbcd6` |
| Windows batch script | `packaging/build_windows.bat` failed with `... was unexpected at this time`. | Fixed Windows batch syntax so CI can run build steps. | `8cdb805e` |
| CI artifact clarity | CI uploaded an app-folder artifact, which looked like a standalone app instead of an installer. | Kept the Windows installer artifact as the main output and removed confusing app-folder upload. | `519d0851` |
| Installer behavior | Installed app opened immediately from the build folder/artifact confusion; user expected installer behavior. | Clarified installer artifact and enabled normal desktop shortcut behavior. | `519d0851` |
| Installer version | Windows installer showed stale/default version metadata. | Updated Inno Setup display/version metadata and mac bundle metadata to the current release label. | `98f4b4f4` |
| Installed Apps icon | Windows Settings uninstall list showed a blank app icon. | Added `UninstallDisplayIcon` to the Windows installer script. | `98f4b4f4` |
| Word Connector certificate | Connector status showed `Certificate: Not trusted`. | Added local certificate generation/trust flow for Windows Current User Root store, plus `cryptography` dependency. | `98f4b4f4` |
| Word Connector Word detection | Status showed `Word: Not detected` when Word was not installed. | Confirmed expected behavior when Microsoft Word is absent. Certificate fix is separate from Word installation. | `98f4b4f4` |
| PDF preview black screen | PDF viewer opened but rendered black/empty on Windows. | Added robust PDF.js readiness handling, then bundled tracked PDF.js assets that had been excluded by `.gitignore`. | `cf28f554`, `b3084d43` |
| PDF.js assets missing | Installed Windows app returned 404 for `/static/pdfjs/build/pdf.mjs` and worker. | Explicitly tracked `app/static/pdfjs/build/pdf.mjs` and `pdf.worker.mjs`; unignored these files. | `b3084d43` |
| Settings tab flicker | Opening Settings caused a quick shadow/window flash, especially around Word Connector or model package cards. | Stopped duplicate package refreshes, avoided unnecessary Settings panel rebuilds, and hid Windows helper command windows for connector checks. | `3374a812` |
| PDF fullscreen | PDF fullscreen did not stay open on Windows. | Made fullscreen work even if the native WebView fullscreen API is unavailable or unreliable. | `1d87cb83` |
| PDF area annotation | `Select area` did not work while other PDF annotation tools worked. | Moved area drag selection from the PDF text layer to the annotation layer. | `67bc324b` |
| Library add actions | Library only had `+ File`; adding directories was only available in Settings. | Replaced `+ File` with a compact `+` dropdown containing `File` and `Directory`. Directory reuses the existing Add Library modal. | `d5f837c1` |
| Non-PDF fullscreen | Fullscreen was PDF-only; Word, Markdown, TXT, CSV, and image previews did not use it. | Made fullscreen a generic preview fullscreen. | `4fdd2baf` |
| Non-PDF area annotation | `Select area` looked available for Word/Markdown/etc. but area boxes are PDF page-coordinate annotations. | Disabled `Select area` outside PDFs. Non-PDF files still support text-selection highlight/comment annotations. | `4fdd2baf` |
| Vector statistics after sync | After sync, vector statistics still showed `0` even though Settings showed BGE Large, MiniLM, and reranker as installed. | Tightened local model validation so incomplete Hugging Face caches no longer count as installed, and sync now stops with a clear model repair/download error instead of creating BM25-only chunks with zero vectors. | `1d0e4167` |

## Current Expected Windows Behavior

- The GitHub Actions artifact should be the Windows installer from the latest successful run.
- The installer should display `v.02.16 (Nokilalaki Peak)`.
- Windows Settings uninstall list should show the app icon.
- PDF preview should render using bundled PDF.js files.
- PDF fullscreen should work.
- Word, Markdown, TXT, CSV, and image previews should also support fullscreen preview.
- PDF annotation tools should support highlight, underline, comment, select text, and select area.
- Non-PDF previews should support text-selection annotations, not area selection.
- Library toolbar should show a compact `+` menu with `File` and `Directory`.
- If the selected embedding model is incomplete, Settings should not report it as properly installed and Sync should ask for model repair/download instead of leaving vector statistics at `0`.

## macOS DMG Follow-Up Checklist

These fixes are app-level unless noted, so they should already apply when rebuilding the macOS DMG from the latest source. Still verify each item on the DMG:

- Confirm DMG app version displays `v.02.16 (Nokilalaki Peak)` where visible.
- Confirm PDF preview renders with bundled PDF.js assets.
- Confirm PDF fullscreen still works on macOS.
- Confirm fullscreen works for Word, Markdown, TXT, CSV, and image previews.
- Confirm PDF `Select area` annotation works.
- Confirm `Select area` is disabled for non-PDF previews.
- Confirm Settings tab does not flicker.
- Confirm Word Connector still works on macOS after the shared connector changes.
- Confirm Library `+` dropdown opens Add File and Add Directory flows.
- Confirm model package status requires a complete local model, then sync produces vector chunks after BGE Large is repaired/downloaded.
- Confirm the minimal DMG remains minimal and does not bundle generated ML/Ollama models unless explicitly requested.

## Open Verification Notes

- Word Connector detection still needs testing on a Windows machine with Microsoft Word installed.
- The Windows build artifact should be downloaded from the latest successful GitHub Actions run after `4fdd2baf` or any newer commit.
- Existing local macOS packaging changes were not included in these Windows fix commits unless explicitly listed above.
