# Runtime hook: wire stdlib urllib/SSL trust store to the bundled certifi CA
# bundle in PyInstaller builds.
#
# Without this hook, urllib's HTTPS default context (ssl._create_default_https_context,
# invoked by urllib.request.urlopen for "https://" URLs) cannot locate a CA trust
# store inside the frozen app, and every HTTPS request fails with:
#     URLError: <urlopen error [SSL: CERTIFICATE_VERIFY_FAILED] ...>
# app/crossref.py uses urllib.request.urlopen to reach api.crossref.org, so on
# macOS bundled builds Crossref metadata lookups silently fail and surface to the
# UI as "No Crossref metadata found for this DOI".
#
# httpx (used by the AI/chat code paths) ships its own SSL handling via the
# `truststore`/certifi integration, so it is unaffected — only the stdlib urllib
# callers needed this fix.
#
# This hook sets SSL_CERT_FILE / REQUESTS_CA_BUNDLE / CURL_CA_BUNDLE (covering
# urllib, requests, and curl-style tooling) and replaces the default HTTPS
# context factory so any stdlib SSL client trusts the bundled roots.
#
# It runs before any application module imports; certifi itself is a frozen
# package collected by hook-certifi.py.

import os
import ssl


def _resolve_ca_bundle():
    # Option 1: certifi.where() — preferred when certifi is importable.
    try:
        import certifi  # type: ignore
        where = certifi.where()
        if where and os.path.isfile(where):
            return where
    except Exception:
        pass

    # Option 2: explicit env override set by the user / launcher.
    env_file = os.environ.get("SSL_CERT_FILE") or os.environ.get("REQUESTS_CA_BUNDLE")
    if env_file and os.path.isfile(env_file):
        return env_file

    # Option 3: macOS system roots (last-resort fallback; not present on Linux
    # or when the bundle is relocated outside /Applications).
    for candidate in ("/etc/ssl/cert.pem", "/usr/local/etc/ssl/cert.pem"):
        if os.path.isfile(candidate):
            return candidate

    return ""


def _install_default_https_context(ca_bundle):
    # Save the existing factory and override it with one that pre-loads our CA
    # bundle. urllib.request.urlopen uses ssl._create_default_https_context()
    # by default, so this is the single chokepoint that fixes all stdlib HTTPS
    # clients (urllib, http.client via urlopen, etc.).
    try:
        original = ssl._create_default_https_context
    except AttributeError:
        original = None

    def _create_default_https_context(purpose=ssl.Purpose.SERVER_AUTH):
        ctx = ssl.create_default_context(purpose=purpose)
        if ca_bundle:
            try:
                ctx.load_verify_locations(cafile=ca_bundle)
            except (ssl.SSLError, OSError):
                pass
        return ctx

    ssl._create_default_https_context = _create_default_https_context
    # Restore original on demand is unnecessary in a frozen app; keep a handle
    # for debugging only.
    ssl._tarcite_original_default_https_context = original


def main():
    ca_bundle = _resolve_ca_bundle()
    if not ca_bundle:
        # No CA bundle found — let stdlib fall back to its defaults and fail
        # loudly with a real SSL error rather than a silent empty trust store.
        return

    os.environ.setdefault("SSL_CERT_FILE", ca_bundle)
    os.environ.setdefault("REQUESTS_CA_BUNDLE", ca_bundle)
    os.environ.setdefault("CURL_CA_BUNDLE", ca_bundle)
    _install_default_https_context(ca_bundle)


main()