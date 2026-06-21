<div align="center">

# TarCite Workspace

**A local-first desktop research & citation manager with AI-assisted citation suggestions.**

Search your own PDF library by meaning, get ranked citation suggestions as you write,
annotate documents, and cite straight into Microsoft Word — all running on your own machine.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey)
![Python](https://img.shields.io/badge/python-3.12-blue)

</div>

---

> **Status:** Preparing for public open-source release. See
> [`docs/OPEN_SOURCE_PLAN.md`](docs/OPEN_SOURCE_PLAN.md) for the roadmap.

## What it does

- **Semantic library search** — index your local PDFs and find passages by meaning, not
  just keywords (hybrid vector + BM25 + reranking retrieval).
- **AI citation suggestions** — paste a paragraph you're writing and get ranked, relevant
  citations from *your own* library, with the supporting passages shown.
- **PDF reading & annotation** — highlight, ink/freehand, and tag annotations; build a tag
  hierarchy across your reading.
- **Reference management** — import from Zotero / Mendeley, organize into folders, and
  format citations & bibliographies (APA 7, Harvard, IEEE, Chicago, MLA, Vancouver, …).
- **Cite into Word** — a bundled Office add-in inserts citations into your document.
- **Local-first & private** — your library, embeddings, and annotations never leave your
  machine. The AI model is pluggable: use the managed endpoint, OpenAI, or a fully local
  Ollama model.
- **MCP server** — exposes your library as tools for AI agents (see [`docs/MCP_SERVER.md`](docs/MCP_SERVER.md)).

## Screenshots

> _Coming soon — see the [project site](https://tarcite.com) for a live overview._

## Install (end users)

Signed installers for macOS and Windows are published on the
[Releases](../../releases) page and at [tarcite.com](https://tarcite.com).
No setup required — the app bundles everything it needs.

## Run from source (developers)

Requires **Python 3.12**.

```bash
git clone <repo-url>
cd citation-workspace
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # then edit as needed
./run.sh                    # macOS/Linux dev launcher
```

The app serves at `https://tarcite.workspace` (or `http://127.0.0.1:4443` in HTTP mode).
See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for how it fits together.

### Configuration

Copy `.env.example` to `.env`. Key settings:

| Variable | Purpose |
|---|---|
| `REFERENCES_DIR` | Folder containing your PDFs. |
| `AI_API_BASE_URL` / `AI_API_KEY` / `AI_MODEL` | Any OpenAI-compatible endpoint (OpenAI, the managed `api.tarcite.com`, or local Ollama). |
| `EMBEDDING_PROVIDER` / `EMBEDDING_MODEL` | Local embeddings (default) or remote. |
| `CROSSREF_MAILTO` | Optional, for polite Crossref metadata lookups. |
| `MCP_ENABLED` | Expose the library as MCP tools at `/mcp`. |

## How AI is used

The AI model is **pluggable and optional for search**. Citation suggestion sends the
paragraph you're drafting plus candidate passages from your library to an
OpenAI-compatible model. You choose the backend:

- **Managed** (`api.tarcite.com`) — key-optional, easiest to start with.
- **OpenAI** — bring your own API key.
- **Local** — point at a local [Ollama](https://ollama.com) instance for fully offline use.

Embeddings and reranking run locally by default. We default to the latest, most capable
Claude models when configuring AI features.

## Building installers

See [`docs/build-distribution.md`](docs/build-distribution.md). Packaging uses PyInstaller
(`citation.spec`) plus platform tooling (create-dmg on macOS, Inno Setup on Windows).

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system overview.
- [`docs/build-distribution.md`](docs/build-distribution.md) — packaging guide.
- [`docs/CITATION_SUGGESTION_MECHANISM.md`](docs/CITATION_SUGGESTION_MECHANISM.md) — the retrieval/ranking pipeline.
- [`docs/MCP_SERVER.md`](docs/MCP_SERVER.md) — MCP integration.
- [`docs/api.md`](docs/api.md) — HTTP API reference.

## Contributing

Contributions are welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md) and our
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md). For security issues, see [`SECURITY.md`](SECURITY.md).

## License

TarCite Workspace is licensed under the **GNU Affero General Public License v3.0**
([LICENSE](LICENSE)). This is required because it builds on
[PyMuPDF](https://pymupdf.readthedocs.io/), which is AGPL-licensed. In short: you're free
to use, study, modify, and redistribute it, and if you offer a modified version as a
network service you must share your source under the same terms.
