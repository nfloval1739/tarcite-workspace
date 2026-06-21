# Offline Word Connector Plan

## Goal

Create a Microsoft Word connector for TarCite Workspace that works like Zotero or Mendeley, while keeping the app local-first. Users should be able to search their local library, insert citations into Word, edit citation details, refresh citations, and generate bibliographies without uploading documents, PDFs, or metadata to a remote service.

## Product Principles

- Local-first: library data, document text, PDFs, citation state, and generated references stay on the user's computer.
- Explicit trust: installing the connector must clearly ask the user before copying files, trusting a local URL, or installing a local certificate.
- Reversible: the app must provide an uninstall/repair flow for the Word connector.
- Optional integration: the main app should remain useful without Word installed.
- Transparent permissions: the user should know what Word can access and what the connector does.

## Architecture

The Word connector should be an Office Add-in that talks to the local TarCite Workspace app.

```text
Microsoft Word
  -> Office.js add-in task pane
  -> local connector API
  -> TarCite Workspace FastAPI app
  -> local SQLite database, PDFs, metadata, CSL formatter
```

The add-in should not connect to a cloud backend. It should call only a local address, for example:

```text
https://127.0.0.1:<port>/word-addin/
https://127.0.0.1:<port>/api/word/...
```

## Installation Model

The app should include a Settings section called `Word Connector`.

Initial state:

```text
Status: Not installed
Local server: Running / Not running
Manifest: Not installed
Certificate: Not trusted
Word: Detected / Not detected
```

Actions:

- `Install Word Connector`
- `Repair Connector`
- `Uninstall Connector`
- `Open Word`

Before installation, show a confirmation dialog explaining:

- one Word add-in manifest will be copied or registered locally
- Word will be configured to trust the local connector
- Word may need to restart
- documents and library data stay on this computer
- the user can uninstall later

On macOS, installation can copy the manifest into Word's local `wef` folder. On Windows, installation can use a trusted add-in catalog approach, with clear user approval before changing trust settings.

## Trust And Security

The connector should avoid silent installation. It should ask before:

- copying the manifest
- registering a trusted catalog
- trusting a local HTTPS certificate
- opening Word

The local certificate, if needed, should be scoped to localhost/127.0.0.1 and explained in plain language. The app should not ask for broad trust unless absolutely required.

Uninstall should remove:

- local manifest file or catalog entry
- local connector trust configuration where possible
- optional local certificate, if created by this app

## Word User Experience

The Word task pane should provide:

- search local library
- filter by collection/source directory
- preview metadata
- insert citation
- insert bibliography
- refresh all citations
- change citation style
- edit selected citation
- convert citations to plain text

Citation edit fields:

- cited item(s)
- page or locator
- prefix
- suffix
- suppress author
- citation style

## Citation Storage In Word

Citations should not be inserted as plain text only. Each inserted citation should carry hidden metadata so it can be refreshed later.

Preferred approach:

- use Word content controls for citation markers
- store citation metadata in the control tag/title or document custom properties
- keep visible text as the formatted citation

Example citation state:

```json
{
  "citation_id": "local-generated-id",
  "items": [
    {
      "item_key": "abc123",
      "locator": "45",
      "prefix": "see",
      "suffix": "",
      "suppress_author": false
    }
  ],
  "style": "apa-7"
}
```

This enables refresh, style changes, bibliography generation, and missing-reference detection.

## Local API Needed

Add Word-specific local endpoints later:

- `GET /api/word/status`
- `GET /api/word/search?q=...`
- `GET /api/word/items/{item_key}`
- `POST /api/word/format-citation`
- `POST /api/word/format-bibliography`
- `POST /api/word/validate-citations`

The API should return CSL-compatible metadata so citation formatting is consistent across the app and Word.

## Citation Formatting

The long-term formatter should use CSL data and CSL styles. Required styles:

- APA 7
- Harvard
- IEEE
- Chicago
- MLA
- Vancouver

The connector should support changing style per document and refreshing all citations/bibliography after the style changes.

## Offline Behavior

The connector should work when there is no internet connection if the metadata already exists locally.

Online-only actions, such as Crossref refetch, should be optional and clearly labeled. Word insertion and bibliography generation should not depend on Crossref or any cloud service.

## Fallback Workflow

Before the full Word add-in is mature, support a local DOCX scan workflow:

1. User writes in Word using temporary markers such as `{cite:item_key}`.
2. User saves the document.
3. TarCite Workspace scans the `.docx`.
4. User maps markers to library items if needed.
5. App exports a new `.docx` with formatted citations and bibliography.

This keeps the product useful even without connector installation.

## Suggested Milestones

1. Planning and technical proof of concept
   - Create add-in skeleton.
   - Confirm local API calls from Word.
   - Insert one citation at cursor.

2. Local connector installer
   - Add Word Connector settings panel.
   - Add install, repair, uninstall status flow.
   - Make trust prompts explicit.

3. Citation insertion MVP
   - Search local library from Word.
   - Insert citation with hidden metadata.
   - Insert bibliography.

4. Refresh and edit
   - Detect citations in document.
   - Edit selected citation.
   - Refresh all citations.
   - Change citation style.

5. Polish and safety
   - Missing item warnings.
   - Convert to plain text.
   - Better installer diagnostics.
   - Documentation for manual install.

## Open Questions

- Should the connector use a fixed local port or discover the running app dynamically?
- Should HTTPS be mandatory from the start, or should development support HTTP?
- Which citation style engine should become the canonical formatter?
- Should bibliography placement be manual, automatic at the end, or both?
- Should the connector support multiple local TarCite Workspace profiles?
