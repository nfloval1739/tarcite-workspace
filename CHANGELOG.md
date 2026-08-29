# Changelog

All notable changes to TarCite Workspace are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **Drill-down from every chart to the annotations behind it.** Clicking a theme
  bar, a donut segment, a co-occurrence pair, a matrix cell, a word in the
  frequency or TF-IDF cards, or a node in the theme network now filters the
  annotation list to exactly those annotations and explains the filter in a
  banner with one click back. Theme drill-downs include the theme's whole
  subtree; a co-occurrence pair requires *both* themes rather than either.
- **Quotes / Notes / Both control for text analysis.** Word frequency, TF-IDF,
  sentiment and KWIC read the author's words and your notes as one bag, so a
  critical note ("weak evidence") scored the passage itself as negative and your
  vocabulary appeared in the corpus's word frequencies. The scope is now
  selectable, defaulting to both.
- **Jaccard option for theme co-occurrence.** Raw counts rank pairs by how large
  the two themes are, so the busiest themes always look related. The Jaccard
  index divides the overlap by the union, promoting themes that genuinely travel
  together; the raw n is still shown beside it.
- **Whole-word matching in KWIC**, so "art" no longer matches "part" and
  "artful". The boundary test is Unicode-aware rather than relying on `\b`,
  which is ASCII-only and would fail on the scripts the tokeniser now supports.
- **Krippendorff's α reported alongside Cohen's κ**, per code and as a
  prevalence-weighted summary. α pools both coders' distributions instead of
  using each coder's own marginals, so it is less flattered by two coders who
  share a bias.
- **Sentiment now reads Indonesian, and admits what it cannot read.** The
  polarity lexicons were English-only, so once the Unicode tokeniser landed an
  Indonesian corpus tokenised correctly and then matched nothing — the card drew
  a confident "100% Neutral" donut over text that was plainly positive or
  negative. Indonesian terms were added alongside the English ones, with
  negation handling (English and Indonesian) so "tidak berhasil" and "not
  effective" score negative rather than positive. Annotations containing no word
  the lexicon knows are now reported as **"not scored"** rather than counted as
  neutral, with the count stated on the card.
- **Per-chart Data / SVG / PNG export in Themes → Analysis.** The export chips
  existed only in Project Analysis, so the library-wide dashboard — where most
  reading happens — could export the whole report but not the single figure you
  want in a paper. Both dashboards now share one set of exporters that resolve
  their data, filenames and DOM from whichever dashboard is on screen.
- **Scope and method block in the exported analysis report.** The report stated
  only a timestamp, the active filter and a count. It now records the source
  (library or project), annotations and documents included, distinct themes,
  date range, filters, the theme level used, chart truncation limits, the
  tokenisation and stop-word languages, the sentiment method, the saturation
  criterion and what κ does and does not cover, plus the app version — the
  provenance a reader needs when a figure appears in a thesis.
- **Codebook roll-up in both analysis dashboards.** Themes are a tree and coding
  normally happens at the leaves, but every card counted leaves only — a parent
  holding 30 annotations across three children rendered no bar at all, while a
  4-annotation flat theme outranked it. A "Themes: As coded / Top level" control
  folds every theme into its top-level parent before any card sees the data, and
  cards say when they are showing rolled-up counts. Project KPIs (coding
  progress, codebook coverage) stay at leaf level, since they measure the
  codebook as authored.
- Multilingual text analysis: word frequency, TF-IDF and keyword sentiment now
  tokenise with `Intl.Segmenter` instead of `[a-z]{3,}`, and Indonesian stop
  words ship alongside the English list. Previously an Indonesian corpus ranked
  *yang*, *dan* and *dengan* as its main topics, Arabic/Chinese/Cyrillic text
  produced no tokens at all, and accented Latin was cut into fragments
  ("café" → "caf").
- Every truncating card now states what it is hiding ("showing top 15 of 40
  themes"), including the theme network, which caps at the 60 most-used themes.

### Fixed
- **The Windows installer aborted with "IPersistFile::Save failed; code
  0x80070005. Access is denied."** whenever it was run without administrator
  rights — either from a standard account or by choosing "install for me only"
  in the privileges dialogue. The desktop shortcut was pinned to
  `{commondesktop}` (`C:\Users\Public\Desktop`), which only an administrator
  may write to, so setup failed at the "Creating shortcuts" step. It now uses
  `{autodesktop}`, which follows whichever install mode the user picked. Two
  further admin-only steps behind that one are also gone: a hand-written
  `HKLM` uninstall key, which needed the same rights and duplicated the key
  Inno Setup already writes (leaving a second, un-uninstallable entry in Apps &
  Features), and the post-install launch, which now runs as the logged-in user
  via `runasoriginaluser` rather than inheriting the elevated token — so an
  install elevated with a different administrator account no longer creates the
  library and settings under that administrator's profile.
- **The Windows installer put the app in `Program Files (x86)` on ARM64
  machines, and installed a broken copy on 32-bit x86.**
  `ArchitecturesInstallIn64BitMode=x64` matched x64 only, so an ARM64 Windows
  PC — which runs the x64 build fine under emulation — fell back to 32-bit
  mode and the wrong Program Files directory. It is now `x64compatible`, which
  covers x64 and ARM64. A matching `ArchitecturesAllowed=x64compatible` stops
  setup on genuine 32-bit x86 Windows with a clear "not compatible with this
  version of Windows" message, rather than installing an x64 bundle that
  cannot start. Existing installs keep their current directory on upgrade.
  Building now requires **Inno Setup 6.3+** (was 6+) for the `x64compatible`
  constant.
- **Eleven CSS custom properties were referenced but never defined**, with no
  fallback: `--border` (32 uses), `--bg-hover` (12), `--accent-rgb` (12),
  `--text` (10), `--red` (9) and six others. Every declaration reading one was
  discarded by the browser, so those elements rendered with no border, no hover
  background and inherited rather than intended colours; `rgba(var(--accent-rgb),
  …)` produced an invalid colour and dropped the whole declaration. The missing
  names are now defined as aliases of the palette entries that do exist, and the
  `--accent-rgb` usages were rewritten to `color-mix()`, which works across all
  six accent themes without needing a triplet per theme. Found while trimming
  the report stylesheet, not introduced by it.
- **"Filter by file" applied to the sidebar only.** The annotation list and every
  analysis chart ignored `annotationsViewFilter.itemKey`, because the filter
  logic existed as three near-copies and only one honoured it. All three now
  share a single predicate.
- The analysis CSV export re-implemented the chart logic with its own third
  stop-word list and the old ASCII-only tokeniser, so the exported word
  frequencies and sentiment disagreed with the charts they claim to export. It
  now shares the chart pipeline, including the theme roll-up, the text scope and
  the negation-aware sentiment scorer.
- The exported HTML report inlined the app's entire stylesheet — every rule for
  the PDF viewer, library table and settings — into each file. It now carries
  only the rules the report renders plus the theme variables, taking the CSS
  from 242 KB to 28 KB.
- `switchAnnotationsMode()` accessed four DOM elements without null checks,
  which drill-down would have hit when called from a chart.
- **Saturation could be declared by a single annotation.** The test was "did the
  very last annotation add a new theme?", so one trailing annotation flipped the
  verdict to "Saturated" and it was reported as a confident percentage.
  Saturation now requires a run of at least 10% of the corpus (minimum 5
  annotations) with no new theme, states the criterion and the observed run, and
  declines to judge fewer than 15 annotations. Coding order comes from
  `created_at` where available rather than the autoincrement id, which
  mis-orders bulk-imported corpora.
- **KWIC reported a fabricated match count.** Its 40-result cap used `return`
  inside a `forEach`, which continues rather than breaks, so each remaining
  annotation still contributed one more hit: 75 real matches were reported as
  "51", and 180 as "86". Every match is now counted, up to 200 are rendered, and
  the card distinguishes the two.
- **TF-IDF ranked the wrong themes and overstated its own method.** Themes were
  taken with `slice(0, 6)` over an object keyed by tag id — and integer-like
  keys iterate numerically — so it always analysed the six *oldest* themes and
  computed IDF over only those, while the subtitle claimed a comparison against
  "the rest of the corpus". IDF now spans every theme with enough text, and the
  six shown are the six largest.
- **Theme × Document matrix showed arbitrary documents.** Columns were the first
  eight encountered, and since the API orders annotations by `item_key` that was
  the eight lexicographically smallest keys; in testing it omitted the four
  documents holding 200 of 208 annotations. Columns are now the most-coded
  documents.
- **Inter-rater κ was reported as a flat mean over codes**, so a code used once
  moved the headline as much as one used 200 times: perfect agreement on 100
  annotations plus one disputed rare code read as κ=0.495, "Moderate". The
  headline is now prevalence-weighted (0.980 for that case) with the unweighted
  mean shown beside it, each code displays the n behind it, codes used fewer
  than 10 times are flagged as unstable, and the card reports how many
  annotations had no counterpart in the other coder's export — disagreement
  about *what* to code, which κ cannot measure.
- The theme network ran a 220-iteration O(n²) layout over every theme,
  synchronously: 200 themes measured ~500 ms and 400 themes ~2 s, on every
  dashboard render — and the annotation search box triggers one per keystroke.
  Node count is capped and the render is debounced; the same corpora now lay out
  in ~50 ms.
- Annotations Over Time bucketed by calendar month only, so 400 annotations
  inside one month rendered "Not enough dated annotations yet". Buckets now
  follow the span (day / week / month).
- The sentiment card now states that it scores the quote and your note together,
  so a critical note reading the source as negative is at least visible.

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
