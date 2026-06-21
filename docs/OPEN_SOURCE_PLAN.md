# TarCite Workspace — Open-Source Release Plan

> Status: **Planning / scaffolding.** This document is the single source of truth for
> taking TarCite Workspace public on GitHub and signing Windows builds via SignPath.org.
> Last updated: 2026-06-21.

---

## 1. Decisions already made

| Decision | Choice | Rationale |
|---|---|---|
| **License** | **AGPL-3.0** | Forced by PyMuPDF (AGPL). Zero cost, legally clean, and a good fit for an open project with a managed network backend. |
| **Scope** | **Desktop client only** | This repo goes public. The Django gateway (`/var/www/04ci-work`) stays private — it holds Stripe billing, encrypted provider API keys, and device-tier logic. |
| **iOS** | **Separate repo, later** | AGPL is incompatible with the Apple App Store (VLC/FSF precedent). A future iOS app must be its own codebase with its own license, talking to `api.tarcite.com`. Not a subfolder here. |
| **Windows signing** | **SignPath.org (OSS tier)** | Free for public OSS. Requires public repo + CI artifact. |
| **macOS signing** | **Apple Developer ID + notarization** | Separate, paid track. Not blocking the Windows release. |

---

## 2. Current state (assessment summary)

**Healthy:**
- Git is clean — 180 tracked files; `data/`, `venv/`, `dist/`, models, `.env` all ignored.
- `.env` was **never** committed; no secrets found in history.
- Good existing docs (`docs/`), full landing site + brand assets (on server), Windows CI.
- Modular codebase after the `app.js` refactor.

**Gaps / blockers (tracked in the checklist below):**
- No `LICENSE` *(now added)*, `README`, `CONTRIBUTING`, `CODE_OF_CONDUCT`, `SECURITY`, or issue/PR templates.
- Personal cert artifacts tracked: `CertificateSigningRequest.certSigningRequest`, `developerID_application.cer` (public, not secret — but should be removed).
- `.env.example` drifted from real `.env` (missing a few keys).
- CI is Windows-only; no macOS build, no lint/test workflow.
- Root directory clutter (`notari.rtf`, `mac-build-bundle-and-minimal.out`, loose setup scripts).
- No automated tests in the client repo.

---

## 3. Component map

| Component | Location | Public? |
|---|---|---|
| **Desktop client** (FastAPI + vanilla-JS SPA, SQLite + ChromaDB, PyInstaller) | this repo | ✅ Yes |
| **Word add-in** | `word-addin/` | ✅ Yes (ships with client) |
| **AI gateway** (Django, LiteLLM proxy, Stripe billing, device tiers, encrypted keys) | `01govalid:/var/www/04ci-work/gateway` | ❌ Keep private |
| **Landing site** (tarcite.com) | `01govalid:.../landing` | ➖ Optional, separate repo |
| **Embedding models** (bge-large, ms-marco reranker, ~1.5 GB) | downloaded at build | ➖ Not in repo |
| **Future iOS app** | _(does not exist yet)_ | Separate repo, separate license |

The client reaches the gateway at `https://api.tarcite.com` (managed, key-optional mode).
Users can instead point at OpenAI, a local Ollama, or any OpenAI-compatible endpoint.

---

## 4. Roadmap (phased)

### Phase 0 — Scaffolding (this pass, docs only, no code changes)
- [x] `LICENSE` (AGPL-3.0)
- [x] `docs/OPEN_SOURCE_PLAN.md` (this file)
- [x] `docs/ARCHITECTURE.md`
- [x] `README.md`
- [x] `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`
- [x] `.github/ISSUE_TEMPLATE/` (bug, feature, config) + `PULL_REQUEST_TEMPLATE.md`
- [ ] `CHANGELOG.md` (can seed from the server's release commit history)

### Phase 1 — Repo hygiene (separate pass, needs your go-ahead)
- [ ] `git rm` the cert artifacts; add AGPL SPDX headers to source files (optional).
- [ ] Reconcile `.env.example` with the real `.env` (add `APP_DISPLAY_HOST`, `HF_HUB_OFFLINE`, managed-mode notes).
- [ ] Move/clean root clutter into `docs/` or `.gitignore`.
- [ ] Verify no absolute personal paths leak (e.g. `REFERENCES_DIR` defaults).

### Phase 2 — CI/CD
- [ ] Add macOS build workflow (mirror `windows-build.yml`).
- [ ] Add a lint workflow (ruff/black) and a smoke-test job.
- [ ] Pin a reproducible build (model download step, Python 3.12).

### Phase 3 — Signing
- [ ] Apply to SignPath.org OSS tier; wire signing into the Windows release workflow.
- [ ] Obtain Apple "Developer ID Application" cert; add `codesign` + `notarytool` to macOS build.

### Phase 4 — Launch polish
- [ ] First-class screenshots/GIF in README (reuse landing assets).
- [ ] GitHub release with signed installers + SHA256 checksums.
- [ ] Topics, description, social preview image on the GitHub repo.
- [ ] Optional: GitHub Discussions, a short demo video (you already have `ink_connection_tarcite.mov`).

---

## 5. Open questions for later
- Repo/org name on GitHub (`tarcite-workspace` under a personal acct or a `tarcite` org?).
- Whether to also publish a sanitized self-host guide for the gateway, or keep the managed API the only backend option for non-technical users.
- Contributor CLA / DCO — recommend DCO (`Signed-off-by`) for simplicity.
