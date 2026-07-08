# TarCite Workspace — MCP Server

TarCite exposes your local research library as an **MCP (Model Context Protocol)**
server, so any MCP client (Claude Desktop, Claude Code, Cursor, …) can use your
private PDF library as a grounded, **fully-local** knowledge source.

Nothing leaves your machine: the tools run in-process against the same
SQLite + ChromaDB stores the app already uses. Search and citation tools are
read-only; the metadata- and annotation-editing tools write to the library.

## Tools

### Read-only (search & cite)

| Tool | What it does |
|------|--------------|
| `search_library` | Hybrid semantic search (vector + BM25 + title → rerank → MMR) for passages relevant to a topic/claim. Returns papers with evidence snippets + citations. |
| `suggest_citations` | Given a paragraph you're writing, AI-ranks which library sources to cite, with reasons, evidence points, and confidence. *(Calls the configured LLM.)* |
| `get_item` | Full metadata for one item (authors, tags, files, collections); optional full text. |
| `search_metadata` | Fast keyword lookup over title/author/year/filename → resolves a paper to its `item_key`. |
| `format_citation` | In-text citation + full reference for an item in a chosen style. |
| `format_bibliography` | Formatted reference list for several items. |
| `list_collections` | Collections (folders) and their keys (for the `collection_key` filter). |
| `library_stats` | Item / collection / chunk counts and last sync time. |
| `list_annotations` | All annotations (highlights, notes, ink) on an item, with tags, page, quote, comment. |
| `list_tags` | All theme tags with colour, parent, and usage counts. |

### Write (edit metadata & annotations)

These mutate the library. They return the updated record so the agent can
confirm the change.

| Tool | What it does |
|------|--------------|
| `update_item_metadata` | Edit bibliographic fields of an item (title, year, `item_type`, `publication_title`, `doi`, `url`, `abstract`, `volume`/`issue`/`pages`, `publisher`, `place`, `edition`, `isbn`, `issn`, `extra`, and `creators`). Omitted fields are untouched. |
| `set_item_notes` | Set or clear the free-text notes (and `note_connections` JSON) on an item. |
| `set_item_favorite` | Favourite / unfavourite an item. |
| `set_item_reading_status` | Set reading status to `""`, `"reading"`, or `"read"`. |
| `add_annotation` | Add a highlight/note/ink annotation to an item, with quote, comment, colour, page, geometry, optional sentiment, and optional theme tags (new tags auto-created). |
| `update_annotation` | Edit an existing annotation's type, quote, comment, colour, geometry, or sentiment. |
| `delete_annotation` | Permanently delete an annotation (and its tag links). |
| `set_annotation_tags` | Replace the theme tags on an annotation (new tag names auto-created; `[]` clears). |
| `import_annotations` | Import annotations embedded in the item's PDF (idempotent). |
| `create_tag` | Create a theme tag (or return the existing id if the name already exists). |

Styles: `apa7, apa6, harvard, ieee, chicago, mla, vancouver, nature, acs, ama,
elsevierharvard, springerauthordate`.

## Option A — stdio (recommended for Claude Desktop, zero network)

The client launches the server as a subprocess and talks over stdin/stdout.
Nothing binds a port.

Add to `claude_desktop_config.json`
(`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "tarcite": {
      "command": "/path/to/tarcite-workspace/venv/bin/python",
      "args": ["-m", "app.mcp_server"],
      "cwd": "/path/to/tarcite-workspace"
    }
  }
}
```

Restart Claude Desktop; the TarCite tools appear in the tools menu.

## Option B — streamable HTTP (the running app doubles as an MCP server)

When the TarCite app is running, an MCP endpoint is mounted at **`/mcp`** on the
same Uvicorn server — no separate process. It shares the app's port and does
**not** interfere with the Word add-in (`/word-addin/*`, `/api/word/*`) or any
other route; it's an additive path.

* Local (plain HTTP, dev): `http://127.0.0.1:4443/mcp`
* Via the friendly host / HTTPS: `https://tarcite.workspace/mcp`
  *(an HTTP MCP client must trust the self-signed cert, same as the Word add-in.)*

Point an HTTP-capable MCP client at that URL. It stays local unless you
deliberately bind the server to a public interface (which would also need
authentication — not enabled by default).

## Notes

- The endpoint is mounted in `app/main.py` and is fully guarded: if the `mcp`
  package is missing or mounting fails, the rest of the app is unaffected
  (`MCP endpoint not mounted: …` is logged, nothing crashes).
- Server definition + tools live in `app/mcp_server.py` (shared by both transports).
- Dependency: `mcp>=1.2.0` (added to `requirements.txt`).
