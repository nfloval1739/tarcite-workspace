# Changelog

All notable changes to TarCite Workspace are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.46] - 2026-08-17

### Added
- **Selection action bar in the PDF/document viewer** — releasing a selection
  with the default tool now offers Highlight (in any palette colour), Underline,
  Note, Copy and Translate in one popup, so the tool no longer has to be chosen
  *before* selecting. The dedicated highlight/underline/comment tools still act
  the moment you release, for fast repeated marking. The popup is anchored to
  the selection and clamped to the viewport instead of being placed at the mouse
  point, where it could land off-screen.
- **Copied PDF text is reflowed into prose.** Text taken from a PDF used to
  arrive one visual line at a time, with the typesetter's hyphens intact
  ("seques-\nter"). The clipboard (both the Copy button and Cmd/Ctrl+C), the
  translator input, and the quote stored on every annotation now go through a
  normaliser that rejoins wrapped lines, repairs broken words while leaving real
  compounds ("socio-economic") alone, expands ligatures, strips soft hyphens and
  keeps paragraph breaks. Shift-clicking Copy still copies verbatim, for tables
  and code listings.
- **Right-click menu on annotations in the page** — recolour, add or edit the
  note, copy the quote, reveal in the list, or delete, without going to the
  sidebar. Works on PDF pages (resolved geometrically) and on image overlays.
- **Viewer keyboard shortcuts**: `Cmd/Ctrl+F` focuses the PDF search, `←`/`→`
  and `PageUp`/`PageDown` change page, `Home`/`End` jump to the first/last page,
  `+`/`-`/`0` zoom, `V`/`H`/`U`/`C`/`A`/`D` pick a tool and `Esc` returns to the
  select tool. All of it is inert while typing in a field or when a dialog is
  open. A selection made with Shift+arrows now raises the action bar too.
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

### Fixed
- **Translating a selection no longer freezes the whole app.** The translate
  route was declared `async def` while calling Argos synchronously, so the
  CPU-bound translation ran *on* the event loop and uvicorn stopped accepting
  connections until it finished — measured at ~30 s, during which saving an
  annotation, or any other request, failed with `ERR_TIMED_OUT`. Blocking
  handlers (translate, the package-index fetch, download start, and billing
  checkout, which does a 15 s HTTP call) are now plain `def`, which FastAPI
  dispatches to its threadpool. Verified with 44 concurrent requests during a
  translation: all answered, slowest 0.08 s.
- **Translation no longer needs the network, and is ~6× faster.** Argos builds
  its sentence splitter with Stanza's default `download_method`, so every
  translation re-fetched `resources_*.json` from raw.githubusercontent.com even
  though each language package already ships that file; when GitHub rate-limited
  the request it failed outright with `429 Too Many Requests`, surfaced in the
  viewer as a failed translation. Stanza now prefers the bundled resources
  (`REUSE_RESOURCES`). A cold translation went from 18.3 s (failing) to 2.8 s,
  and a warm one takes 0.1 s.
- Translation errors carry meaningful status codes instead of a blanket 400: 400
  for an empty or over-long selection, 409 plus "Install it under Settings →
  Translation" for a missing language pack, 500 for anything unexpected (which
  is now logged with a traceback rather than swallowed).
- The translate request has a 90 s deadline and reports what it is waiting for,
  so a slow first run shows "Loading the translation model…" and a stalled one
  reports a timeout instead of showing "Translating…" indefinitely. Both the
  selection popup and the in-popup language switcher share one request path.
- Concurrent translations are serialised, so a burst of clicks cannot start
  several CTranslate2 runs across every core at once.
- **Annotated text is selectable again.** Highlight, underline and area shapes
  are painted above the PDF text layer and were pointer-interactive so they
  could be clicked, which meant they swallowed the mousedown that starts a
  selection: dragging across an underlined sentence selected nothing at all, and
  a drag that began on a highlight made the browser snap the selection to the
  whole block. The shapes are now pointer-transparent and clicks on them are
  resolved geometrically, so clicking one still jumps to its entry in the list.
  Ink strokes are hit-tested with `isPointInStroke()`, and note-connection lines
  no longer intercept clicks along their whole length (their endpoints still do).
  Selecting text and releasing over a highlight also used to suppress the
  Copy/Translate popup entirely; it no longer does.
- Ported pdf.js's `endOfContent` selection guard, which the bundled `pdf.mjs`
  API build does not ship (it lives in the viewer's `TextLayerBuilder`). It caps
  how far a selection can jump when the pointer strays into the gaps between
  text spans.
- The note drawer no longer springs open after every highlight — only the
  comment tool and the new Note action open it.
- Annotations created in the document (txt/md/csv/docx) viewer are now covered
  by annotation undo, like PDF ones already were.
- Annotations created outside the PDF viewer (MCP tools, API clients) now
  anchor to the page automatically: when the PDF is opened, each quote-only
  annotation's passage is located in the PDF text, its highlight rectangles
  and (corrected) page number are stored, and it renders and click-navigates
  exactly like a viewer-made highlight. Clicking an annotation whose quote
  cannot be located falls back to the text-layer spotlight. The annotations
  PATCH route and MCP `update_annotation` tool can now move an annotation to
  a different page (`page_index`).

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

[Unreleased]: https://github.com/nfloval1739/tarcite-workspace/compare/v0.2.46...HEAD
[0.2.46]: https://github.com/nfloval1739/tarcite-workspace/compare/v0.2.36...v0.2.46
[0.2.36]: https://github.com/nfloval1739/tarcite-workspace/compare/v0.2.26...v0.2.36
[0.2.26]: https://github.com/nfloval1739/tarcite-workspace/releases/tag/v0.2.26
