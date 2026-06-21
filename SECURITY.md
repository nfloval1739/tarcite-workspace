# Security Policy

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Instead, report privately via one of:

- GitHub's [private vulnerability reporting](../../security/advisories/new) (preferred), or
- email **security@tarcite.com**

Include: a description of the issue, steps to reproduce, affected version/platform, and any
proof-of-concept. We aim to acknowledge reports within **5 business days** and will keep you
updated on remediation.

## Scope

TarCite Workspace is a **local-first desktop app**: your library, embeddings, and
annotations stay on your machine. Especially relevant areas:

- The local HTTPS server (`launcher.py`, FastAPI on port 4443) and its certificate handling.
- The Word add-in bridge (`https://tarcite.workspace:4443`).
- Handling of untrusted input: imported PDFs, Zotero/Mendeley files, and metadata.
- Configuration of external AI/embedding endpoints (`AI_API_BASE_URL`, API keys).

The managed AI gateway (`api.tarcite.com`) is a **separate, private service** and is not
part of this repository.

## Supported versions

Security fixes target the latest released version. Please upgrade to the newest release
before reporting.

## Handling secrets

Never commit secrets. `.env` is git-ignored; use `.env.example` as the template. If you
believe a secret has been committed, report it privately as above.
