# Changelog

All notable changes to TarCite Workspace are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Open-source project scaffolding: AGPL-3.0 license, README, contributing guide,
  code of conduct, security policy, issue/PR templates.
- `Lint` GitHub Actions workflow (ruff).

### Changed
- Repository is now focused on **Windows** packaging; macOS/Linux build scripts are
  maintained separately.

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
