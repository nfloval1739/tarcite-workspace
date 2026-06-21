# Architecture

TarCite Workspace is a **local-first desktop research & citation manager**. It runs a
FastAPI server on your machine and serves a browser-based single-page app; all your
library data, embeddings, and annotations stay on-device.

```
┌──────────────────────────────────────────────────────────────────┐
│  launcher.py  ── pystray tray icon + uvicorn (HTTPS, port 4443)    │
│                                                                    │
│  ┌──────────────┐    ┌───────────────────────────────────────┐    │
│  │  Browser SPA │◄──►│  FastAPI (app/main.py → routers/)       │    │
│  │ (vanilla JS) │    │                                         │    │
│  └──────────────┘    │   ┌─────────────┐   ┌────────────────┐  │    │
│        ▲             │   │ SQLite (WAL)│   │ ChromaDB        │  │    │
│        │ Word add-in │   │ metadata,   │   │ vector store    │  │    │
│        ▼             │   │ annotations │   │ (embeddings)    │  │    │
│  ┌──────────────┐    │   └─────────────┘   └────────────────┘  │    │
│  │ MS Word      │    │                                         │    │
│  └──────────────┘    └──────────────┬──────────────────────────┘   │
└─────────────────────────────────────┼──────────────────────────────┘
                                       │ OpenAI-compatible API
                          ┌────────────┴─────────────┐
                          │  one of:                  │
                          │  • api.tarcite.com (managed, key-optional)
                          │  • local Ollama           │
                          │  • OpenAI / any compatible │
                          └───────────────────────────┘
```

## Stack

- **Backend:** FastAPI / Uvicorn, SQLite (WAL mode), ChromaDB (vector store),
  sentence-transformers, PyMuPDF, citeproc-py, argostranslate.
- **Frontend:** Vanilla JS — **no framework, no build step**. Modules under
  `app/static/js/` loaded via `<script>` tags. PDF rendering via bundled pdf.js.
- **Entry point:** `launcher.py` → system-tray app + FastAPI on port 4443.
- **Packaging:** PyInstaller (`citation.spec`) → macOS `.app`/DMG, Windows installer.
- **Runtime:** Python 3.12.

## Data locations (user machine)

| Data | Path (macOS) | Path (Windows) |
|---|---|---|
| SQLite + ChromaDB | `~/Library/Application Support/TarCiteWorkspace/data/` | `%APPDATA%\TarCiteWorkspace\data\` |
| Local HTTPS cert/key | `~/.citation-workspace/*.pem` | (per-platform) |
| Embedding models | bundled in the app (HF_HOME points there) | bundled |

## Backend layout (`app/`)

- `main.py` — app factory + router registration only.
- `routers/` — HTTP surface: `chat`, `citations`, `search`, `files`, `items`,
  `library`, `library_health`, `projects`, `imports`, `export`, `content`,
  `annotations`, `settings`, `history`, `citation_graph`, `tags`, `translation`,
  `sync`, `backup`, `billing`, `packages`, `relevance`.
- `database.py` — SQLite schema + queries (FTS5, item/collection model).
- `retrieval.py` — hybrid retrieval: vector + BM25 + title match → RRF merge →
  cross-encoder rerank → MMR diversity.
- `ai_client.py` — OpenAI-compatible client with quota/fallback chain; detects the
  managed `api.tarcite.com` endpoint (`_is_managed_api`).
- `config.py` — profiles (managed / OpenAI / local), `.env` loading, device registration.
- `embeddings.py`, `downloader.py` — model management.
- `quota.py` — managed-tier request budgeting.
- `repositories/` — higher-level data operations (e.g. qualitative coding).

## Frontend layout (`app/static/`)

3-pane UI: left sidebar (Chat / Library / Projects / Notes / Settings) · center
(suggestions / library / document preview / settings) · right (PDF viewer + annotations).

Largest modules: `app-preview.js` (PDF viewer), `app-annotations.js` (highlight/ink),
`app-library.js` (folder tree), `app-settings.js`, `app-projects.js`,
`app-citation-chat.js` (SSE citation suggestions). Shared state in `app-state.js`.

## Key data flows

1. **Library sync:** `scan_directory` → SQLite items → ChromaDB embeddings (batched).
2. **Citation suggestion:** hybrid retrieval → RRF merge → cross-encoder rerank →
   MMR diversity → LLM evaluation, streamed to the UI via SSE.
3. **Annotation:** pdf.js highlight/freehand → annotation DB → tag hierarchy.

## External services

- **AI gateway** (`api.tarcite.com`): the managed, key-optional OpenAI-compatible
  backend. **Not part of this repository** (private Django service). The client works
  equally well against OpenAI, a local Ollama, or any OpenAI-compatible endpoint —
  configured in Settings or `.env`.
- **Crossref**: optional metadata lookup (`CROSSREF_MAILTO`).

## Word add-in (`word-addin/`)

Office task-pane add-in that talks to the local server at
`https://tarcite.workspace:4443`. Installed alongside the desktop app so citing into a
Word document works out of the box.

## Third-party licensing notes

- **PyMuPDF is AGPL-3.0** — this is why the whole project is AGPL-3.0.
- pdf.js (Apache-2.0), ChromaDB / sentence-transformers (Apache-2.0),
  FastAPI / citeproc-py (MIT/BSD), embedding models (bge: MIT, ms-marco: Apache).

See [`build-distribution.md`](build-distribution.md) for packaging.
