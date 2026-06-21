# TarCite Collaborative Qualitative Coding

## Why This Matters

TarCite is a single-user app today. Every highlight, tag, and coding decision lives in one local database with no owner. That works for one researcher, but qualitative research is a team sport.

Consider a typical study: 50 farmer interview transcripts, 3 researchers coding them using a shared theme hierarchy. Today, each person would have to manage their own TarCite instance independently, then somehow reconcile their coding in a spreadsheet. There is no way to:

- Know **who** coded what
- Share a **codebook** across machines
- Detect **disagreements** between coders
- Measure **inter-coder reliability** (required by thesis committees and journals)
- **Merge** everyone's work into one final coding set

This document describes how to add collaborative coding to TarCite while keeping its local-first, privacy-first architecture intact.

---

## What Already Exists

TarCite already has a strong foundation for qualitative coding:

- **Annotations** — highlight, underline, comment, area, freehand draw on PDFs
- **Theme tags** — hierarchical tree with codebook fields (description, inclusion/exclusion criteria)
- **Projects** — workspace that collects sources, annotations, and attached codebook themes
- **Evidence Board** — annotations grouped by theme
- **Coding Review** — identify uncoded/outside-codebook annotations with AI suggestions
- **Project Analysis** — coding progress, theme frequency, saturation curves, co-occurrence networks, sentiment, TF-IDF, document-theme matrix

The gap is that none of this knows about **multiple people**.

---

## What's Missing (The Gaps)

| Existing Component | Current State | What's Missing |
|---|---|---|
| Annotations | Created on a single machine, no owner | No "coded by" — can't tell who made each one |
| Theme tags | Global hierarchy, local only | No way to share or sync the codebook across machines |
| Annotation tags | Links annotation to theme | No attribution — who assigned this tag? |
| Projects | Single-user workspace | No team members, no roles, no assignments |
| Sentiment | One opinion per annotation | Multiple coders may disagree |
| Project Analysis | Rich charts for one coder's work | No inter-coder reliability metrics, no cross-coder comparison |

---

## Architecture: How Sync Works

### The Principle: No Cloud Server Required

TarCite's identity is local-first. Instead of building a cloud backend, collaboration uses a **shared folder** as the sync medium. This works with Dropbox, Google Drive, a LAN share, a USB stick, or any shared filesystem.

Each researcher codes independently on their own laptop. Periodically, they sync — pushing their new coding events to the shared folder and pulling their teammates' events from it.

### The Flow

```
Researcher A                                    Researcher B
    |                                               |
    |  Codes Interview_01, tags passages            |
    |  with #economic_hardship, #input_costs        |
    |                                               |
    |  ─── Push to shared folder ──────────────────▶|
    |                                               |
    |                       Pulls events, sees Sarah's
    |                       annotations appear in local DB
    |                                               |
    |◀── Pull from shared folder ───────────────────|
    |                                               |
    |  Sees Amir's coding on Interview_02           |
    |  Both now have shared codebook + each          |
    |  other's annotations                          |
```

### What Travels Through the Shared Folder

Every coding action becomes an **immutable event** — a small JSON record. Events are append-only: they are never edited or deleted. This makes them safe to sync even with race conditions.

**Event types:**

| Event | Meaning |
|---|---|
| Annotate | Someone highlighted or commented on a passage |
| Tag | Someone assigned a theme to an annotation |
| Untag | Someone removed a theme from an annotation |
| Comment | Someone wrote or edited a note on an annotation |
| Sentiment | Someone rated positive/neutral/negative |
| Theme Add | Someone added a new theme to the codebook |
| Theme Edit | Someone renamed or re-colored a theme |

### ID Mapping Problem

Each TarCite instance generates its own internal annotation IDs (auto-incrementing integers). When Researcher A creates annotation #42, Researcher B imports it and creates it as annotation #87 in their own database. A mapping table tracks these cross-references so that when B tags "A's annotation," A understands which annotation was tagged.

### Sync Triggers

| Method | When to Use |
|---|---|
| **Auto (folder watch)** | Dropbox/Google Drive/LAN — detects new files automatically |
| **Manual button** | USB stick, air-gapped machines, or when researcher prefers control |
| **Timer (poll every N seconds)** | LAN, slow sync scenarios |
| **TarCite Cloud (future)** | Remote teams that can't use shared folders |

---

## The 7 Phases

### Phase 1 — Coder Identity and Attribution

**Goal:** Every annotation and tag knows who created it.

**What changes:**

- A new "coder profile" is created on first launch after update (name + color)
- Every annotation records who made it
- Every theme-tag assignment records who applied it
- Annotation cards in the UI show a small colored avatar and name
- Project views can filter by coder ("show only Sarah's coding")

**Onboarding:** A one-time lightweight modal asks for the researcher's name and a color. This takes 10 seconds and never appears again.

**Key behavior:** For existing single-user databases, all legacy annotations default to "unknown coder" — nothing breaks.

---

### Phase 2 — Shared Codebook

**Goal:** All coders in a project use the same theme hierarchy, and changes propagate.

**What changes:**

- Projects gain a "team" concept: an owner, coders, and optional reviewers
- The project codebook (theme tree attached via theme roots) becomes versioned
- When someone adds, renames, or reorganizes a theme, a codebook event is generated
- Teammates see codebook changes after sync, and the theme is auto-created in their local database

**Two codebook modes:**

| Mode | Who Can Edit Themes | Best For |
|---|---|---|
| **Locked** | Only the project owner | Structured studies with a predefined framework |
| **Open** | Any team member | Grounded theory, emergent coding where themes evolve |

**UI addition:** A "Codebook Activity" feed in the project panel shows recent changes: "Sarah added 'Input Costs' under 'Economic Hardship' — 2 min ago."

---

### Phase 3 — Coding Events and Sync Engine

**Goal:** Coding work travels between machines reliably.

**What changes:**

- Every coding action automatically generates an event record
- A new project setting lets the owner choose a shared folder path
- The sync engine pushes pending events (outgoing) and pulls/applies new events (incoming)
- A sync status indicator appears in the project header (last synced, pending count)
- The engine handles the ID mapping between machines transparently

**Sync safety:**

- Events are immutable and append-only — no merge conflicts on the events themselves
- If the same passage is annotated by two coders independently, both annotations are preserved (they're treated as separate observations, which is correct behavior for qualitative coding)
- If sync is interrupted, it resumes from where it left off

---

### Phase 4 — Conflict Detection and Resolution

**Goal:** When coders disagree, the team can see it and decide.

**What counts as a conflict:**

| Situation | Is It a Conflict? |
|---|---|
| Both coders tag the same passage with the same theme | No — agreement |
| Coder A tags as "Economic Hardship," Coder B tags as "Livelihood Strategy" | Yes — tag disagreement |
| Coder A rates positive sentiment, Coder B rates negative | Yes — sentiment disagreement |
| Coder A highlights a passage, Coder B doesn't | No — just different coverage |
| Both highlight the same text with slightly different boundaries | Minor — overlap, worth reviewing |

**Resolution UI:**

A new "Conflicts" tab in the project workspace shows each disagreement. For each one, the team can:

- **Accept one coder's version** (the other is marked as rejected)
- **Accept both** (multi-coding — very common in qualitative research; a passage often belongs to multiple themes legitimately)
- **Create a new theme** (if the disagreement reveals a gap in the codebook)
- **Defer** (leave for later discussion)

Each resolution records who resolved it, when, and what was decided.

---

### Phase 5 — Inter-Coder Reliability (ICR)

**Goal:** Produce academically defensible agreement metrics.

This is the feature that sets TarCite apart from simply sharing a folder of coded PDFs. Thesis committees and peer reviewers want to see evidence that your coding is reliable — that different people would reach similar conclusions.

**Metrics:**

| Metric | What It Measures | Typical Target |
|---|---|---|
| Percentage Agreement | Raw overlap of codes on the same passages | 80%+ |
| Cohen's Kappa (2 coders) | Agreement corrected for chance | 0.70+ |
| Fleiss' Kappa (3+ coders) | Multi-coder chance-corrected agreement | 0.70+ |
| Krippendorff's Alpha | Most robust; handles missing data and any number of coders | 0.67+ |

**How matching works across coders:**

Annotations from different coders are considered "the same passage" when they are on the same document, same page (±1), and the quoted text overlaps with high similarity (using TarCite's existing embedding infrastructure).

**ICR Dashboard (new section in Project Analysis):**

- Overall Kappa score with pass/fail indicator against the target threshold
- Per-theme agreement breakdown — reveals which themes are clear and which are ambiguous
- Pairwise agreement matrix — shows which pair of coders agree most/least
- Disagreement hotspots — specific passages where coders diverge most, linked to open the PDF at that page
- Export button for ICR report (CSV for Excel, or formatted PDF)

**The ICR-guided coding workflow:**

This is the standard academic practice that TarCite would now support end-to-end:

1. Both coders independently code 20% of the data (the "agreement sample")
2. Run ICR calculation
3. If Kappa is below target (e.g., < 0.70):
   - Review the disagreement hotspots together
   - Refine the codebook definitions (tighten inclusion/exclusion criteria)
   - Re-code the disputed passages
   - Re-run ICR
4. Once target is met:
   - Split the remaining 80% of documents between coders
   - Optionally keep 10% overlap for drift detection

---

### Phase 6 — Task Assignment and Progress

**Goal:** The project owner can divide work and track completion.

**What changes:**

- Documents (interviews) can be assigned to specific coders
- Assignment status: pending → in progress → done → reviewed
- A progress dashboard shows overall and per-coder completion
- Auto-assign strategies:
  - **Even split** — divide documents equally
  - **Similarity-balanced** — cluster documents by topic (using existing embeddings) and give each coder a representative mix
  - **With overlap** — each coder gets unique documents plus X% shared for ICR checking

**Progress dashboard addition:**

The project overview shows a completion bar, per-coder progress, current ICR score, and a sortable assignment table.

---

### Phase 7 — Merge and Finalization

**Goal:** Turn all coders' work into one authoritative coding set.

After collaborative coding is complete, the team needs to produce a single "master" coding that represents the final analysis. This is especially important for:

- Exporting the coded dataset for analysis in SPSS/R/Python
- Generating the theme report for the thesis
- Locking the project so no further changes can be made

**Merge process:**

1. **Auto-accept agreement** — where all coders agree on a tag, it goes straight into the final set
2. **Surface conflicts** — disagreements that weren't already resolved appear for final review
3. **Mark as final** — each annotation and tag in the merged set gets a "final" flag
4. **Lock the project** — after finalization, the project becomes read-only (with an optional unlock if needed)

**Export:** All existing export tools (CSV, JSON, Word DOCX, analysis charts) work with the finalized set, producing a clean output that excludes rejected and unresolved codings.

---

## Implementation Roadmap

| Phase | Focus | Estimated Effort |
|---|---|---|
| 1 | Coder identity and attribution | 2–3 days |
| 2 | Shared codebook with versioning | 3–4 days |
| 3 | Coding events and sync engine | 5–7 days |
| 4 | Conflict detection and resolution UI | 3–4 days |
| 5 | Inter-coder reliability metrics and dashboard | 3–4 days |
| 6 | Task assignment and progress tracking | 2–3 days |
| 7 | Merge and finalization | 2–3 days |

**Total: approximately 20–28 days**

Phases 1–3 are foundational and must be built in order. Phases 4–7 can be partially parallelized but each builds on the sync infrastructure.

---

## Design Principles

**Local-first always.** A single researcher using TarCite alone should see zero change in their workflow. All new database columns default to empty values. Collaboration features only appear when a project has multiple team members.

**Append-only audit trail.** Coding events are never mutated or deleted. This provides a full history of who coded what, when — essential for academic transparency and for undoing mistakes.

**Graceful degradation.** If sync fails or the shared folder is unavailable, local coding continues without interruption. The researcher syncs when the connection is restored.

**No required server.** The shared folder approach works offline, on air-gapped machines, in low-bandwidth fieldwork environments, and in institutions that block cloud services. A future TarCite Cloud relay can serve remote teams but is never mandatory.

**Academic rigor by default.** ICR metrics, conflict tracking, codebook versioning, and project finalization are not optional extras — they're the reason this feature exists. Every design decision prioritizes defensible methodology.

**Backward compatible.** The existing single-user database upgrades cleanly with no data loss. Legacy annotations without a coder attribution continue to work normally.

---

## Future Option: TarCite Cloud Relay

For teams that cannot use shared folders (remote researchers, cross-institution projects), the same event/sync protocol can run through a centralized relay at api.tarcite.com. This would add real-time WebSocket sync but requires no changes to the core coding logic — the event format and conflict resolution remain identical.

This is intentionally deferred. The shared-folder approach validates the entire architecture first, and the cloud relay becomes a deployment upgrade, not a redesign.
