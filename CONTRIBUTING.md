# Contributing to TarCite Workspace

Thanks for your interest in improving TarCite Workspace! This guide covers how to set up,
make changes, and submit them.

## Code of Conduct

This project follows our [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you agree
to uphold it.

## Development setup

Requires **Python 3.12**.

```bash
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
./run.sh
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for an overview of the codebase before
diving in.

## Project conventions

- **Backend:** FastAPI. New HTTP endpoints go in a router under `app/routers/`; register it
  in `app/main.py`. Keep data access in `app/database.py` / `app/repositories/`.
- **Frontend:** Vanilla JS, **no framework and no build step**. Match the existing module
  style in `app/static/js/`. Shared state lives in `app-state.js`.
- **Match the surrounding code** — naming, comment density, and idioms. Don't introduce new
  dependencies or build tooling without discussing it first in an issue.
- Keep commits focused; write clear commit messages (we suggest Conventional Commits, e.g.
  `fix(library): …`, `feat(chat): …`).

## Submitting changes

1. Open an issue first for anything non-trivial, so we can agree on the approach.
2. Fork, branch from `main`, and make your change.
3. Test manually that the app runs and your change behaves as intended (and add automated
   tests where the area has them).
4. Open a pull request using the template; describe what changed and why, and link the issue.

## Developer Certificate of Origin (DCO)

We use the [DCO](https://developercertificate.org/). Sign off each commit to certify you
have the right to submit it:

```bash
git commit -s -m "fix(search): handle empty query"
```

This adds a `Signed-off-by:` line to your commit.

## Licensing of contributions

TarCite Workspace is licensed under **AGPL-3.0**. By contributing, you agree that your
contributions are licensed under the same terms.

## Reporting bugs & requesting features

Use the GitHub issue templates. For **security vulnerabilities**, do **not** open a public
issue — follow [`SECURITY.md`](SECURITY.md).
