# Collaborative Coding — UI/UX Placement Guide

This document maps every collaborative coding feature to the exact UI location in TarCite's current layout.

---

## Current Layout Recap

```
┌──────────────────────────────────────────────────────────────────────────┐
│  TOPBAR: Logo · AI Profile selector · Downloads · Theme · Refresh       │
├───────────┬──────────────────────────────────────┬───────────────────────┤
│ SIDEBAR   │  CENTER PANE                         │  RIGHT PREVIEW PANE   │
│ (tabs)    │  (switches between views)            │  (PDF/Notes viewer)   │
│           │                                      │                       │
│ • Chat    │  • Citation Assistant                │  • PDF viewer         │
│ • Library │  • Library Browser                   │  • Annotation tools   │
│ • Themes  │  • Project Workspace ← main target   │  • Annotation list    │
│ • Projects│  • Settings Center                   │  • Project notes      │
│ • Settings│  • Annotations Synthesis             │                       │
├───────────┴──────────────────────────────────────┴───────────────────────┤
│  MODALS: Add Directory · Import · AI Profile · New Project · etc.       │
└──────────────────────────────────────────────────────────────────────────┘
```

The **Project Workspace** (`view-projects` center view) is the primary home for collaborative coding. It already has a section-based navigation system with 6 sections: Overview, Codebook, Evidence Board, Coding Review, Analysis, All Evidence.

---

## Feature Placement Map

### 1. Coder Identity ("Who Am I?")

**Placement: Settings sidebar tab** (`tab-settings`)

This is a one-time setup, similar to configuring an AI profile. It belongs in Settings, not in the project view, because it's a global identity used across all projects.

```
Current Settings:
  > Appearance
  > AI Profiles
  > TarCite AI
  > Models
  > Offline Translation
  > Temperature

NEW: insert here ──▶  Coder Identity
                        Name: [Dr. Sarah Chen]
                        Color: [🔵] (picker)
                        (saved automatically)
```

**Why Settings:** It's machine-level, not project-level. A researcher uses the same identity everywhere.

**Badge in Topbar:** Add a small coder avatar dot next to the theme toggle in the topbar-right. Clicking it opens a quick popover with name + color for fast edits. This gives persistent visibility of "who I am" without opening Settings.

```
topbar-right:  [Downloads] [Coffee] [🔵 Sarah] [🌙 Theme] [🔄 Refresh]
                                    ↑ new
```

---

### 2. Coder Attribution on Annotations

**Placement: Annotation cards** — everywhere annotations appear.

There are 4 places annotations render. All 4 need the coder avatar:

**A. Sidebar Themes tab — annotation mini-cards** (`sidebar-ann-list`)
```
Current:
  "The fertilizer price increased..."
  p.3 · Farmer_Interview_12.pdf  #economic_hardship

NEW:
  "The fertilizer price increased..."
  🔵 Sarah · p.3 · Farmer_Interview_12.pdf  #economic_hardship
```

**B. PDF preview pane — annotation list** (`annotation-list` on the right pane)
```
Each annotation row gets a small colored dot + name before the page number.
```

**C. Note Drawer** (the slide-up editor for a single annotation)
```
Current header:
  [Highlight icon] Farmer_Interview_12.pdf · Page 3

NEW header:
  [Highlight icon] 🔵 Sarah · Farmer_Interview_12.pdf · Page 3
```

**D. Project Workspace — all annotation renderings** (Evidence Board, Coding Review, All Evidence)
```
Every evidence mini-card and coding review row shows the coder avatar.
```

---

### 3. Team Management (Add/Remove Coders)

**Placement: Project Workspace → Overview section**

Add a "Team" panel alongside the existing "Sources" and "Top Themes" panels in the project overview.

```
Current overview layout:
  ┌─────────────────┐  ┌─────────────────┐
  │ Sources (12)    │  │ Top Themes (8)  │
  └─────────────────┘  └─────────────────┘

NEW layout:
  ┌─────────────────┐  ┌─────────────────┐  ┌──────────────────┐
  │ Sources (12)    │  │ Top Themes (8)  │  │ Team (3)         │
  │                 │  │                 │  │ 🔵 Sarah (owner) │
  │                 │  │                 │  │ 🟢 Amir (coder)  │
  │                 │  │                 │  │ 🟠 Priya (coder) │
  │                 │  │                 │  │ [+ Add Coder]    │
  └─────────────────┘  └─────────────────┘  └──────────────────┘
```

**"Add Coder" flow:** Opens a small modal asking for the coder's name and color. Since there's no server, this creates a placeholder coder profile locally. When the coder syncs from the shared folder, their real profile overwrites the placeholder.

**Project modal update:** The existing "New Project" / "Edit Project" modal (`project-modal`) gets an additional optional field:

```
  > Project Name
  > Type / Status
  > Research Question
  > Objective
NEW: > Shared Folder Path   [Browse...]   ← for sync
NEW: > Codebook Mode        ○ Locked  ○ Open
```

---

### 4. Shared Codebook

**Placement: Project Workspace → existing "Project Codebook" section**

The codebook section already exists in the project workspace. It already shows attached theme roots with their tree. The changes are additive:

**Enhance the existing Codebook panel header:**

```
Current:
  Project Codebook                    5 theme(s)
  [Theme Root selector] [Attach Root]

NEW:
  Project Codebook                    5 theme(s)  🔒 Locked by Sarah
  [Theme Root selector] [Attach Root]  [Sync Now ↻]
```

**Add a "Codebook Activity" feed at the bottom of the codebook panel:**

```
  ─── Recent Changes ─────────────────────────────
  🔵 Sarah added "Input Costs" — 2 min ago
  🟢 Amir added "Knowledge sharing" — 1 hr ago
  🔵 Sarah edited "Economic Hardship" description — 3 hr ago
```

**Why here:** The codebook section is already where researchers manage their theme hierarchy. The activity feed and sync button are natural extensions, not a new UI section.

---

### 5. Sync Status and Controls

**Three places, each serving a different purpose:**

**A. Project toolbar** (top of the Project Workspace center view)
```
Current project toolbar:
  [Project Name]                    [subtitle]    [+ New Project]

NEW:
  [Project Name]  [subtitle]  [🔄 Synced 2m ago · 3 pending]  [+ New Project]
                              ↑ new sync status pill
```

The sync pill shows last sync time and pending event count. Clicking it opens a dropdown:
- Push now
- Pull now
- Sync settings (change shared folder path)
- Sync log (recent events pushed/pulled)

**B. Topbar** — global sync indicator

There's already a `sync-status` element in the topbar-left. Currently it shows library sync status. Extend it to also show collaboration sync:

```
When in a collaborative project:
  [🔄 Library synced · Collab: 3 events pending]
```

**C. Settings sidebar** — shared folder configuration
```
A new section in the project settings (within the project modal):
  Shared Folder: /Dropbox/FarmerStudy/
  Auto-sync: ○ On (every 30s)  ○ Manual only
```

---

### 6. Conflict Resolution

**Placement: NEW section in Project Workspace navigation**

Add a 7th section to the existing project section navigation (`projects-section-nav`):

```
Current sections:
  Overview · Codebook · Evidence Board · Coding Review · Analysis · All Evidence

NEW:
  Overview · Codebook · Evidence Board · Coding Review · Conflicts · Analysis · All Evidence
                                                    ↑ new
```

**Why a new section, not a tab or modal:**

- Conflicts are a first-class workflow, not a quick action. Researchers spend significant time on them.
- A section gets a count badge (number of pending conflicts), making it scannable.
- The section-based nav is already the established pattern in the project workspace.

**Conflicts section layout:**

```
  ┌──────────────────────────────────────────────────────────────┐
  │ ⚠️ Coding Conflicts                           3 pending      │
  │ [Auto-resolve agreements] [Export conflicts]                 │
  │                                                              │
  │ ┌──────────────────────────────────────────────────────────┐ │
  │ │ 📄 Farmer_Interview_12.pdf · p.3                        │ │
  │ │ "The fertilizer price increased by 40%, forcing me to    │ │
  │ │  switch to organic methods..."                            │ │
  │ │                                                          │ │
  │ │ 🔵 Sarah: #economic_hardship 😟 Neg                     │ │
  │ │ 🟢 Amir:  #livelihood_strategy 😊 Pos                   │ │
  │ │                                                          │ │
  │ │ ○ Sarah's  ○ Amir's  ● Both  ○ New theme               │ │
  │ │                                          [Resolve] [Skip]│ │
  │ └──────────────────────────────────────────────────────────┘ │
  │                                                              │
  │ ┌──────────────────────────────────────────────────────────┐ │
  │ │ (next conflict card...)                                  │ │
  │ └──────────────────────────────────────────────────────────┘ │
  └──────────────────────────────────────────────────────────────┘
```

---

### 7. Inter-Coder Reliability (ICR)

**Placement: Project Workspace → existing "Project Analysis" section**

The Analysis section already has a rich grid of analysis cards (coding progress, codebook coverage, theme frequency, annotation types, annotations over time, word frequency, co-occurrence, document matrix, coding density, network, saturation, sentiment, TF-IDF, project shape).

ICR cards are added to this existing grid:

```
Current analysis grid:
  [Coding Progress]  [Codebook Coverage]
  [Theme Frequency]  [Annotation Types]
  [Annotations Over Time ←── wide]
  [Word Frequency    ←── wide]
  [Co-occurrence     ←── wide]
  [Document Matrix   ←── wide]
  [Coding Density    ←── wide]
  [Network           ←── wide]
  [Saturation        ←── wide]
  [Sentiment]         [TF-IDF          ←── wide]
  [Project Shape]

NEW cards inserted (only appear when project has 2+ coders):
  [ICR Overview      ←── wide]  ← overall Kappa + pass/fail
  [Per-Theme Agreement]          ← table of Kappa per theme
  [Pairwise Matrix]              ← coder × coder grid
  [Disagreement Hotspots ← wide] ← clickable list of problem passages
```

**ICR Overview card** (wide, spans full row):
```
  ┌───────────────────────────────────────────────────┐
  │ Inter-Coder Reliability                            │
  │ κ = 0.74 (Substantial)  ✅ Target 0.70 met        │
  │ 3 coders · 45 overlapping annotations · 89% agree │
  │ [Export ICR Report] [Recalculate]                  │
  └───────────────────────────────────────────────────┘
```

**Why inside Analysis, not a new section:** ICR is an analytical measurement, not a workflow. It fits naturally alongside the existing coding progress, saturation, and co-occurrence cards. Only showing when 2+ coders exist keeps the single-user experience clean.

---

### 8. Task Assignment and Progress

**Two placements:**

**A. Project Overview section** — progress dashboard

The overview currently shows stat cards (Sources, Annotations, Pinned evidence, Need coding review). Add coder progress cards:

```
Current stat grid:
  [12 Sources]  [87 Annotations]  [23 Pinned]  [14 Need review]

NEW (additional row, only when project has 2+ coders):
  [🔵 Sarah: 18/25 (72%)]  [🟢 Amir: 10/25 (40%)]  [⏳ 12 unassigned]
```

**B. NEW section or sub-panel: Assignments**

This could be either a new project section ("Assignments" between "Coding Review" and "Conflicts") or a panel within the Overview. Given it's a management task rather than a deep analytical view, it fits better as an expandable panel in Overview:

```
  ┌─────────────────────────────────────────────────────────────┐
  │ Assignments                             [Auto-Assign] [+]   │
  │                                                             │
  │ Document              Coder        Status      Coded        │
  │ Interview_01.pdf      🔵 Sarah     ✅ Done     12 ann       │
  │ Interview_02.pdf      🟢 Amir      🔄 In Prog  8 ann        │
  │ Interview_03.pdf      🔵 Sarah     ⏳ Pending  —            │
  │ Interview_04.pdf      🟢 Amir      ⏳ Pending  —            │
  │ ...                                                        │
  └─────────────────────────────────────────────────────────────┘
```

---

### 9. Coder Filter (View One Person's Work)

**Placement: Multiple locations — as a filter control**

This is not a new section but a **filter dropdown** added to existing views:

**A. Project Evidence Board** — add a coder filter dropdown in the panel header:
```
  Evidence Board          23 annotations
  [All Coders ▼]  [ 🔵 ] [ 🟢 ] [ 🟠 ]    ← toggle buttons
```

**B. Coding Review** — filter by coder:
```
  Coding Review           14 items
  [All Coders ▼]  [Show only conflicts ▼]
```

**C. All Evidence section** — same filter row

**D. Sidebar Themes tab — annotations pane** — add a coder filter button next to the existing type filter buttons:
```
Current:  [All] [Highlight] [Underline] [Comment] [Area] [File]
NEW:      [All] [Highlight] [Underline] [Comment] [Area] [File] [👤]
                                                              ↑ opens coder dropdown
```

---

### 10. Merge and Finalization

**Placement: Project Workspace → Overview section + a confirmation modal**

**Merge button in the overview action bar:**

```
  [Edit Project] [🗑 Delete]  [🔀 Merge Codings]  ← new button
```

**Clicking "Merge Codings" opens a full-screen modal/stepper:**

```
  ┌──────────────────────────────────────────────────────────────┐
  │ Merge Project Codings                                        │
  │                                                              │
  │ Step 1 of 3: Review                                         │
  │                                                              │
  │ 87 annotations from 3 coders                                 │
  │ 62 matching annotations (same passage, different coders)     │
  │ 48 auto-accepted (full agreement)                            │
  │ 14 conflicts to resolve                                      │
  │                                                              │
  │ [Review Conflicts →]                                         │
  └──────────────────────────────────────────────────────────────┘

  Step 2: Resolve remaining conflicts (reuses conflict resolution UI)

  Step 3: Finalize
  ┌──────────────────────────────────────────────────────────────┐
  │ Finalize Coding Set                                          │
  │                                                              │
  │ 87 annotations finalized                                     │
  │ 14 conflicts resolved                                        │
  │ 0 unresolved                                                 │
  │                                                              │
  │ ⚠️ This will lock the project. No further coding changes     │
  │    can be made after finalization.                           │
  │                                                              │
  │ [← Back]  [Finalize & Lock Project]                         │
  └──────────────────────────────────────────────────────────────┘
```

**After finalization**, the project overview shows a locked indicator:

```
  🔒 Project Finalized — May 27, 2026
  [Unlock (read-only)] [Export Final Coding Set]
```

---

## Summary: What Goes Where

| Feature | UI Location | New or Modified |
|---|---|---|
| Coder identity setup | **Settings tab** → new "Coder Identity" section | New section in existing Settings |
| Coder badge in topbar | **Topbar right** → small avatar dot | New element |
| Attribution on annotations | **All 4 annotation render locations** | Modified — add avatar to existing cards |
| Team management | **Project Overview** → new "Team" panel | New panel in existing Overview |
| Shared codebook + activity | **Project Codebook** section (existing) | Enhanced header + new activity feed |
| Sync status | **Project toolbar** + **Topbar** sync indicator | Modified existing elements |
| Sync settings | **Project modal** (existing) | New fields in existing modal |
| Conflict resolution | **New project section: "Conflicts"** | New section in project nav |
| Inter-coder reliability | **Project Analysis** section (existing) | New analysis cards in existing grid |
| Task assignment | **Project Overview** → expandable panel | New panel in existing Overview |
| Coder filter | **Multiple views** (Evidence, Review, Sidebar) | New filter toggle in existing headers |
| Merge & finalization | **Project Overview** → new button + modal | New button + new stepper modal |

**Key principle:** No new center views. No new sidebar tabs. Everything plugs into the existing Project Workspace structure. Single-user projects see zero changes — collaborative UI elements only appear when a project has 2+ team members.
