# Changelog

All notable changes to TarCite Workspace are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Open-source project scaffolding: AGPL-3.0 license, README, contributing guide,
  code of conduct, security policy, issue/PR templates.
- `Lint` GitHub Actions workflow (ruff).
- Settings `preload_models` (default off) and `model_idle_unload_minutes`
  (default 20) to control ML model residency; env overrides `PRELOAD_MODELS`
  and `MODEL_IDLE_UNLOAD_MINUTES`.

### Changed
- Repository is now focused on **Windows** packaging; macOS/Linux build scripts are
  maintained separately.
- **Thermal/efficiency overhaul** — the app no longer heats the machine at
  launch, between uses, or per MCP client session:
  - PDF text extraction runs through one persistent crash-isolated batch
    worker instead of respawning the frozen binary per file, removing seconds
    of process-bootstrap CPU per PDF on large scans. Crash isolation, per-file
    timeouts, and MuPDF-leak insurance (worker recycling every 50 files) are
    preserved; the worker is shut down when a scan finishes.
  - The embedding model and reranker load lazily on first use instead of at
    every launch (previously ~1 minute of high CPU per start), and unload
    after 20 idle minutes, returning ~1.6 GB of memory to the OS.
  - The startup ChromaDB health probe (a full frozen-binary re-spawn) only
    runs after an unclean exit, tracked via a clean-shutdown marker written on
    every quit path.
  - `--mcp-stdio` proxies to the running app's `/mcp` endpoint when available
    instead of loading a second SQLite/Chroma/torch stack per MCP client
    session (measured ~860 MB resident per Claude session before); standalone
    serving remains the fallback (`MCP_STDIO_NO_PROXY=1` forces it), and an
    orphan watchdog ends stdio processes whose client is gone.
  - Ollama starts lazily: at launch only when the active AI profile is local,
    otherwise on demand at the first local AI request. Closing the app window
    now stops Ollama and exits cleanly (it used to linger until the next
    launch's stale-process sweep).
  - The frontend polls sync status every 3 s only while a scan is running,
    backing off to 30 s when idle and pausing while the window is hidden.

## [0.2.36] - 2026-07-06

### Added
- Library folder rows now expose a scan action, allowing scans to run on a single
  subfolder instead of only on the configured root directory.

### Changed
- Folder create, rename, move, and delete operations now update the library tree
  immediately, including empty folders and nested subfolders.
- Subfolder scans preserve the configured root as the item `source_dir`, while
  limiting stale-folder cleanup to the scanned subtree.

### Fixed
- Moving or renaming folders now recalculates nested collection keys and item
  folder membership, preventing items from disappearing from folder-scoped views.
- Deleting a folder with contents now removes indexed app records for the deleted
  files as part of the same operation.

## [0.2.26] - 2026-06-21

First public release. Highlights of the application as it stands:

### Added
- **Semantic library search** — index local PDFs and search by meaning using hybrid
  retrieval (vector + BM25 + title) with cross-encoder reranking and MMR diversity.
- **AI citation suggestions** — ranked, evidence-backed citations for a drafted paragraph,
  streamed over SSE; pluggable OpenAI-compatible backend (managed, OpenAI, or local Ollama).
- **PDF reading & annotation** — highlight, ink/freehand, and tag annotations with a tag
  hierarchy.
- **Reference management** — Zotero and Mendeley import, folder organisation, and citation
  / bibliography formatting (APA 7, Harvard, IEEE, Chicago, MLA, Vancouver, …).
- **Microsoft Word add-in** — insert citations directly into a document.
- **MCP server** — exposes the library as Model Context Protocol tools (stdio and HTTP).
- **Local-first storage** — SQLite + ChromaDB on-device; bundled embedding/reranker models
  and an optional bundled Ollama runtime for fully offline use.

## Earlier history

Versions prior to 0.2.26 (the `v.01.x` and early `v.02.x` series) were private beta
builds and are not itemized here.

[Unreleased]: https://github.com/nfloval1739/tarcite-workspace/compare/v0.2.36...HEAD
[0.2.36]: https://github.com/nfloval1739/tarcite-workspace/compare/v0.2.26...v0.2.36
[0.2.26]: https://github.com/nfloval1739/tarcite-workspace/releases/tag/v0.2.26
