/* ── TarCite Workspace - Notes (Evidence-Anchored Zettelkasten) ──────────────
 *
 * Atomic notes, each optionally anchored to a PDF annotation. Notes link to
 * one another with typed links (supports/contradicts/extends/refines/questions/
 * exemplifies) and to computed links (shared evidence, semantic similarity,
 * contradiction). Notes are stored as real Markdown files on disk with YAML
 * frontmatter, so an Obsidian vault over the same folder interops directly.
 *
 * Layout mirrors the Projects tab: sidebar list + section nav, centre view
 * with Editor / Graph / Backlinks / Evidence sections.
 * ─────────────────────────────────────────────────────────────────────────── */

/* Global autocomplete check token, mirroring _mentionCheckId in app-annotations.js. */
let _zettelLinkCheckId = 0;
let _zettelSaveTimer = null;
/* A debounced save must remember the note it was typed into: the user can
 * switch notes inside the debounce window, and appState.activeZettelNoteId
 * will already point at the new one by the time the timer fires. */
let _zettelPendingNoteId = null;
let _zettelPendingPatch = {};
let _zettelRecomputeJob = null;

const ZETTEL_LINK_TYPES = [
    { value: 'supports',     label: 'Supports' },
    { value: 'contradicts',  label: 'Contradicts' },
    { value: 'extends',      label: 'Extends' },
    { value: 'refines',      label: 'Refines' },
    { value: 'questions',    label: 'Questions' },
    { value: 'exemplifies',  label: 'Exemplifies' },
];

/* ── Load & sidebar ────────────────────────────────────────────────────────── */

async function loadZettelNotes(options = {}) {
    try {
        const res = await fetch('/api/zettel/notes');
        if (!res.ok) throw new Error('Could not load notes');
        const data = await res.json();
        appState.zettelNotes = data.notes || [];
        if (!appState.activeZettelNoteId && appState.zettelNotes.length) {
            appState.activeZettelNoteId = appState.zettelNotes[0].note_id;
        }
        renderZettelSidebar();
        if (appState.activeCenterView === 'notes') {
            if (appState.activeZettelNoteId && !options.listOnly) {
                await loadZettelDetail(appState.activeZettelNoteId);
            } else {
                renderZettelEmpty();
            }
        }
    } catch (err) {
        console.error('Load notes error:', err);
        if (appState.activeCenterView === 'notes') renderZettelEmpty('Could not load notes.');
    }
}

function zettelFilterCounts() {
    const notes = appState.zettelNotes || [];
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return {
        all:      notes.length,
        anchored: notes.filter(n => n.anchor_annotation_id).length,
        /* An orphan has nothing pointing at it and points at nothing -- the
         * note a zettelkasten quietly loses. Surfacing them is the whole
         * reason this filter exists. */
        orphans:  notes.filter(n => !n.link_count).length,
        recent:   notes.filter(n => n.updated_at && Date.parse(n.updated_at) >= weekAgo).length,
    };
}

function zettelFilteredNotes() {
    const q = (document.getElementById('zettel-search')?.value || '').toLowerCase().trim();
    const filter = appState.zettelFilter || 'all';
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return (appState.zettelNotes || []).filter(n => {
        if (filter === 'anchored' && !n.anchor_annotation_id) return false;
        if (filter === 'orphans'  && n.link_count) return false;
        if (filter === 'recent'   && !(n.updated_at && Date.parse(n.updated_at) >= weekAgo)) return false;
        if (!q) return true;
        /* You search a zettelkasten for an idea, and the idea is in the body --
         * title and tags alone never find it. body_md is already in the list
         * payload, so this costs nothing. */
        const hay = `${n.title || ''} ${n.tags_json || ''} ${n.body_md || ''}`.toLowerCase();
        return hay.includes(q);
    });
}

function setZettelFilter(filter) {
    appState.zettelFilter = filter || 'all';
    renderZettelSidebar();
}

function renderZettelSidebar() {
    const list = document.getElementById('zettel-sidebar-list');
    if (!list) return;
    const notes = zettelFilteredNotes();
    if (!notes.length) {
        const q = (document.getElementById('zettel-search')?.value || '').trim();
        list.innerHTML = `<div class="projects-empty">${q ? 'No notes match “' + escapeHtml(q) + '”.' : 'No notes here yet.'}</div>`;
        renderZettelFilterNav();
        return;
    }
    list.innerHTML = notes.map(n => {
        const active = n.note_id === appState.activeZettelNoteId ? 'active' : '';
        const anchor = n.anchor_annotation_id
            ? '<i data-lucide="anchor" aria-hidden="true" class="zettel-anchor-mark" title="Anchored to a passage"></i>'
            : '';
        /* An orphan is worth flagging in the list, not just in the filter. */
        const orphan = !n.link_count ? '<span class="zettel-orphan-dot" title="No links yet"></span>' : '';
        const links = n.link_count ? `${n.link_count} link${n.link_count === 1 ? '' : 's'}` : 'unlinked';
        return `<button class="project-list-item ${active}" onclick="selectZettelNote(${n.note_id})">
            <span class="project-list-name">${anchor}${escapeHtml(n.title || 'Untitled')}</span>
            <span class="project-list-meta">${orphan}${links}</span>
        </button>`;
    }).join('');
    refreshIcons(list);
    renderZettelFilterNav();
}

async function selectZettelNote(noteId) {
    await flushZettelSave();
    appState.activeZettelNoteId = noteId;
    renderZettelSidebar();
    setCenterView('notes');
    await loadZettelDetail(noteId);
}

function renderZettelEmpty(message = '') {
    const title = document.getElementById('zettel-view-title');
    const subtitle = document.getElementById('zettel-view-subtitle');
    const content = document.getElementById('zettel-view-content');
    if (title) title.textContent = 'Notes';
    if (subtitle) subtitle.textContent = 'Atomic, evidence-anchored notes — your connected web of reading.';
    if (!content) return;
    content.innerHTML = `
        <div class="project-empty-state">
            <h3>Build a connected web of reading</h3>
            <p>${escapeHtml(message || 'Each note is one idea, optionally anchored to the PDF passage that supports it.')}</p>
            <button class="btn-small" onclick="newZettelNote()">${icon('plus')} New note</button>
        </div>`;
    refreshIcons(content);
    renderZettelFilterNav();
}

/* ── Detail & sections ────────────────────────────────────────────────────── */

async function loadZettelDetail(noteId) {
    if (!noteId) { renderZettelEmpty(); return; }
    try {
        const res = await fetch(`/api/zettel/notes/${noteId}`);
        if (!res.ok) throw new Error('Note not found');
        const data = await res.json();
        appState.activeZettelNote = data.note;
        renderZettelDetail(data.note);
    } catch (err) {
        console.error('Load note detail error:', err);
        renderZettelEmpty(err.message);
    }
}

function syncZettelModeSwitch() {
    const mode = appState.zettelMode || 'write';
    document.getElementById('zettel-mode-write')?.classList.toggle('active', mode === 'write');
    document.getElementById('zettel-mode-graph')?.classList.toggle('active', mode === 'graph');
}

function renderZettelDetail(note) {
    const title = document.getElementById('zettel-view-title');
    const subtitle = document.getElementById('zettel-view-subtitle');
    const content = document.getElementById('zettel-view-content');
    if (!content) return;
    if (title) title.textContent = note.title || 'Untitled note';
    if (subtitle) subtitle.textContent = note.anchor_item_title
        ? `Anchored to “${note.anchor_item_title}”`
        : 'Unanchored atomic note';

    content.innerHTML = renderZettelSection(note, appState.zettelMode || 'write');
    refreshIcons(content);
    renderZettelFilterNav();
    syncZettelModeSwitch();

    /* The preview pane is rebuilt empty by innerHTML; refill it. */
    if (appState.zettelPreviewOn) renderZettelPreview(note.body_md || '');

    if (appState.zettelMode === 'graph') {
        loadZettelGraph();
    }
    requestAnimationFrame(redrawInkLines);
}


function renderZettelFilterNav() {
    const nav = document.getElementById('zettel-section-nav');
    if (!nav) return;
    const c = zettelFilterCounts();
    const active = appState.zettelFilter || 'all';
    const defs = [
        { id: 'all',      label: 'All notes', iconName: 'layers',   count: c.all },
        { id: 'anchored', label: 'Anchored',  iconName: 'anchor',   count: c.anchored },
        { id: 'orphans',  label: 'Orphans',   iconName: 'unlink',   count: c.orphans },
        { id: 'recent',   label: 'This week', iconName: 'clock',    count: c.recent },
    ];
    nav.innerHTML = `
        <div class="project-section-title">Filter</div>
        <div class="project-section-tree">
            ${defs.map(d => `
                <button class="project-section-item ${d.id === active ? 'active' : ''}" onclick="setZettelFilter('${d.id}')">
                    ${icon(d.iconName)}
                    <span>${escapeHtml(d.label)}</span>
                    <small>${d.count}</small>
                </button>`).join('')}
        </div>`;
    refreshIcons(nav);
}

async function setZettelMode(mode) {
    /* Switching mode rebuilds the panel with innerHTML, destroying the
     * textarea -- so anything typed but not yet saved has to land first. */
    await flushZettelSave();
    appState.zettelMode = mode === 'graph' ? 'graph' : 'write';
    if (appState.activeZettelNote) renderZettelDetail(appState.activeZettelNote);
}

function renderZettelSection(note, mode) {
    if (mode === 'graph') return renderZettelGraphSection(note);
    return renderZettelNoteSurface(note);
}

/* One scrolling surface. The passage a note is about, the note itself, and
 * what it connects to are the same thought -- splitting them across tabs meant
 * you could never see the evidence you were writing about. */
function renderZettelNoteSurface(note) {
    return `
        <div class="zettel-surface">
            ${renderZettelEvidenceBlock(note)}
            ${renderZettelEditorSection(note)}
            ${renderZettelConnections(note)}
        </div>`;
}

/* ── Editor section ────────────────────────────────────────────────────────── */

function renderZettelEditorSection(note) {
    const tags = safeJsonArray(note.tags_json).join(', ');
    const aliases = safeJsonArray(note.aliases_json).join(', ');
    const preview = !!appState.zettelPreviewOn;
    return `
        <section class="zettel-write">
            <input type="text" id="zettel-title-input" class="zettel-title-input" value="${escapeHtml(note.title || '')}"
                   placeholder="One idea, in a sentence" oninput="onZettelTitleInput()">
            <div class="zettel-meta-row">
                <input type="text" id="zettel-tags-input" class="compact-input" value="${escapeHtml(tags)}" placeholder="Tags, comma-separated" oninput="onZettelMetaInput()">
                <input type="text" id="zettel-aliases-input" class="compact-input" value="${escapeHtml(aliases)}" placeholder="Aliases (Obsidian)" oninput="onZettelMetaInput()">
                <button class="zettel-preview-toggle ${preview ? 'active' : ''}" onclick="toggleZettelPreview()"
                        title="An atomic note is short; the editor keeps the full width unless you ask for a preview.">
                    ${icon('eye')} Preview
                </button>
            </div>
            <div class="zettel-editor-body ${preview ? 'with-preview' : ''}">
                <textarea id="zettel-body-input" class="zettel-body-input"
                          placeholder="Write in Markdown. Type [[ to link another note."
                          oninput="onZettelBodyInput()" onkeyup="checkZettelLinkAutocomplete(this)" onkeydown="onZettelLinkKeydown(event)">${escapeHtml(note.body_md || '')}</textarea>
                ${preview ? '<div id="zettel-preview" class="zettel-preview"></div>' : ''}
            </div>
            <div id="zettel-link-autocomplete" class="chat-mention-autocomplete hidden"></div>
            <div class="zettel-write-footer">
                <span class="project-muted">${escapeHtml(note.source || 'manual')}</span>
                <button class="zettel-delete-link" onclick="deleteActiveZettelNote()">${icon('trash-2')} Delete note</button>
            </div>
        </section>`;
}

function toggleZettelPreview() {
    appState.zettelPreviewOn = !appState.zettelPreviewOn;
    if (appState.activeZettelNote) renderZettelDetail(appState.activeZettelNote);
}

function onZettelTitleInput() {
    scheduleZettelSave({ title: document.getElementById('zettel-title-input').value });
}

function onZettelMetaInput() {
    const tags = document.getElementById('zettel-tags-input').value;
    const aliases = document.getElementById('zettel-aliases-input').value;
    scheduleZettelSave({
        tags_json: JSON.stringify(splitCsv(tags)),
        aliases_json: JSON.stringify(splitCsv(aliases)),
    });
}

function onZettelBodyInput() {
    const ta = document.getElementById('zettel-body-input');
    scheduleZettelSave({ body_md: ta.value });
    if (appState.zettelPreviewOn) renderZettelPreview(ta.value);
}

function renderZettelPreview(markdown) {
    const pane = document.getElementById('zettel-preview');
    if (!pane) return;
    pane.innerHTML = renderZettelMarkdown(markdown || '');
}

function renderZettelMarkdown(text) {
    /* renderMarkdown (app-citation-chat.js) already maps [[wikilink]] to
     * <a class="wikilink" data-note-title="..."> links. Attach click handlers
     * that resolve the title to a note and select it. */
    const html = renderMarkdown(text || '');
    const wrap = document.createElement('div');
    wrap.innerHTML = html;
    wrap.querySelectorAll('a.wikilink').forEach(a => {
        a.style.cursor = 'pointer';
        a.addEventListener('click', (e) => {
            e.preventDefault();
            const title = a.getAttribute('data-note-title');
            const target = (appState.zettelNotes || []).find(n =>
                (n.title || '').toLowerCase() === (title || '').toLowerCase() ||
                safeJsonArray(n.aliases_json).some(al => al.toLowerCase() === (title || '').toLowerCase()));
            if (target) selectZettelNote(target.note_id);
        });
    });
    return wrap.innerHTML;
}

function scheduleZettelSave(patch) {
    const noteId = appState.activeZettelNoteId;
    if (!noteId) return;
    /* Anything still pending for another note lands now, before we start
     * batching edits for this one -- otherwise it would be sent to whichever
     * note happens to be open when the timer fires. */
    if (_zettelPendingNoteId && _zettelPendingNoteId !== noteId) flushZettelSave();
    _zettelPendingNoteId = noteId;
    /* Merge rather than replace: editing the body and then the tags inside one
     * debounce window must save both, not just the later field. */
    Object.assign(_zettelPendingPatch, patch);
    markZettelDirty();
    if (_zettelSaveTimer) clearTimeout(_zettelSaveTimer);
    _zettelSaveTimer = setTimeout(flushZettelSave, 500);
}

/* ── Save status ──────────────────────────────────────────────────────────── */

function _setZettelSaveStatus(text, cls) {
    const el = document.getElementById('zettel-save-status');
    if (!el) return;
    el.textContent = text;
    el.className = 'zettel-save-status' + (cls ? ' ' + cls : '');
}

function markZettelDirty()     { _setZettelSaveStatus('Unsaved changes…', 'dirty'); }
function markZettelSaved()     { _setZettelSaveStatus('Saved', 'saved'); }
function markZettelSaveFailed() { _setZettelSaveStatus('Could not save — your last edit is still in the editor', 'failed'); }

/* A pending edit must survive the window closing. fetch(keepalive) is allowed
 * to outlive the page; a normal fetch here would simply be cancelled. */
window.addEventListener('beforeunload', () => {
    if (!_zettelPendingNoteId || !Object.keys(_zettelPendingPatch).length) return;
    try {
        fetch(`/api/zettel/notes/${_zettelPendingNoteId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(_zettelPendingPatch),
            keepalive: true,
        });
    } catch (_) { /* nothing useful to do while unloading */ }
});

/* Send any pending edit immediately. Safe to call when nothing is pending. */
function flushZettelSave() {
    if (_zettelSaveTimer) { clearTimeout(_zettelSaveTimer); _zettelSaveTimer = null; }
    const noteId = _zettelPendingNoteId;
    const patch = _zettelPendingPatch;
    _zettelPendingNoteId = null;
    _zettelPendingPatch = {};
    if (!noteId || !Object.keys(patch).length) return Promise.resolve();
    return patchZettelNote(noteId, patch);
}

async function patchZettelNote(noteId, patch) {
    try {
        const res = await fetch(`/api/zettel/notes/${noteId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch),
        });
        if (!res.ok) throw new Error('Save failed');
        const data = await res.json();
        /* A flush for a note the user has already navigated away from still
         * updates the list, but must not touch the view showing another note. */
        const isActive = noteId === appState.activeZettelNoteId;
        if (isActive) appState.activeZettelNote = data.note;
        /* Keep the sidebar title in sync without re-rendering the textarea
         * (which would steal focus / reset the caret). */
        const item = (appState.zettelNotes || []).find(n => n.note_id === noteId);
        if (item) {
            Object.assign(item, data.note);
            renderZettelSidebar();
        }
        if (isActive) {
            const titleEl = document.getElementById('zettel-view-title');
            if (titleEl) titleEl.textContent = data.note.title || 'Untitled note';
        }
        markZettelSaved();
    } catch (err) {
        console.error('Patch note error:', err);
        markZettelSaveFailed();
    }
}

/* ── [[ link autocomplete ─────────────────────────────────────────────────── */

function checkZettelLinkAutocomplete(ta) {
    const myId = ++_zettelLinkCheckId;
    const caret = ta.selectionStart;
    const before = ta.value.slice(0, caret);
    const match = before.match(/\[\[([^\[\]]*)$/);
    if (!match) { hideZettelLinkAutocomplete(); return; }
    const q = match[1].toLowerCase().trim();
    const all = appState.zettelNotes || [];
    const filtered = all.filter(n =>
        n.note_id !== appState.activeZettelNoteId &&
        ((n.title || '').toLowerCase().includes(q) ||
         safeJsonArray(n.aliases_json).some(al => al.toLowerCase().includes(q)))
    ).slice(0, 8);
    const box = document.getElementById('zettel-link-autocomplete');
    if (!box) return;
    if (!filtered.length) { hideZettelLinkAutocomplete(); return; }
    box.innerHTML = filtered.map((n, i) => `
        <div class="chat-mention-item" data-index="${i}">
            <span class="chat-mention-label">[[${escapeHtml(n.title || 'Untitled')}]]</span>
            <span class="chat-mention-meta">${n.anchor_annotation_id ? 'anchored' : ''}</span>
        </div>`).join('');
    box._items = filtered;
    box._ta = ta;
    box._match = match;
    const rect = ta.getBoundingClientRect();
    box.style.position = 'fixed';
    box.style.left = rect.left + 'px';
    box.style.width = rect.width + 'px';
    box.style.top = (rect.bottom + 4) + 'px';
    box.style.right = 'auto';
    box.style.zIndex = '9999';
    const fsTarget = getFullscreenElement?.() || document.body;
    if (box.parentElement !== fsTarget) fsTarget.appendChild(box);
    box.classList.remove('hidden');
    box.querySelectorAll('.chat-mention-item').forEach((el, i) => {
        el.addEventListener('click', () => insertZettelLink(ta, match, filtered[i]));
    });
}

function hideZettelLinkAutocomplete() {
    _zettelLinkCheckId++;
    document.querySelectorAll('#zettel-link-autocomplete').forEach(b => b.classList.add('hidden'));
}

function onZettelLinkKeydown(e) {
    const box = document.getElementById('zettel-link-autocomplete');
    if (!box || box.classList.contains('hidden')) return;
    const items = box.querySelectorAll('.chat-mention-item');
    if (!items.length) return;
    let idx = parseInt(box._activeIndex || '0', 10);
    if (e.key === 'ArrowDown') { e.preventDefault(); idx = (idx + 1) % items.length; }
    else if (e.key === 'ArrowUp') { e.preventDefault(); idx = (idx - 1 + items.length) % items.length; }
    else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insertZettelLink(box._ta, box._match, box._items[idx]);
        return;
    } else if (e.key === 'Escape') { hideZettelLinkAutocomplete(); return; }
    else return;
    box._activeIndex = idx;
    items.forEach((el, i) => el.classList.toggle('active', i === idx));
}

function insertZettelLink(ta, match, note) {
    if (!note) return;
    const start = ta.selectionStart - match[0].length;
    const end = ta.selectionStart;
    const insert = `[[${note.title}]]`;
    ta.value = ta.value.slice(0, start) + insert + ta.value.slice(end);
    const pos = start + insert.length;
    ta.selectionStart = ta.selectionEnd = pos;
    ta.focus();
    hideZettelLinkAutocomplete();
    onZettelBodyInput();
}

/* ── New note / delete ─────────────────────────────────────────────────────── */

async function newZettelNote() {
    try {
        const res = await fetch('/api/zettel/notes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: 'Untitled note', body_md: '' }),
        });
        if (!res.ok) throw new Error('Could not create note');
        const data = await res.json();
        appState.zettelNotes.unshift(data.note);
        appState.activeZettelNoteId = data.note.note_id;
        appState.zettelMode = 'write';
        renderZettelSidebar();
        await loadZettelDetail(data.note.note_id);
        const titleInput = document.getElementById('zettel-title-input');
        if (titleInput) { titleInput.focus(); titleInput.select(); }
    } catch (err) {
        console.error('New note error:', err);
    }
}

async function deleteActiveZettelNote() {
    const note = appState.activeZettelNote;
    if (!note) return;
    if (!confirm(`Delete “${note.title || 'Untitled note'}”? This cannot be undone.`)) return;
    try {
        /* Drop any queued edit for this note; the PATCH would 404 and be
         * reported to the user as a failed save. */
        if (_zettelPendingNoteId === note.note_id) {
            if (_zettelSaveTimer) { clearTimeout(_zettelSaveTimer); _zettelSaveTimer = null; }
            _zettelPendingNoteId = null;
            _zettelPendingPatch = {};
        }
        const res = await fetch(`/api/zettel/notes/${note.note_id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('Could not delete note');
        appState.zettelNotes = (appState.zettelNotes || []).filter(n => n.note_id !== note.note_id);
        appState.activeZettelNoteId = appState.zettelNotes.length ? appState.zettelNotes[0].note_id : null;
        appState.activeZettelNote = null;
        renderZettelSidebar();
        if (appState.activeZettelNoteId) await loadZettelDetail(appState.activeZettelNoteId);
        else renderZettelEmpty();
    } catch (err) {
        console.error('Delete note error:', err);
    }
}

/* ── Add-link modal ────────────────────────────────────────────────────────── */

function addZettelLinkModal() {
    const note = appState.activeZettelNote;
    if (!note) return;
    const others = (appState.zettelNotes || []).filter(n => n.note_id !== note.note_id);
    const overlay = document.createElement('div');
    overlay.className = 'modal-backdrop';
    overlay.innerHTML = `
        <div class="modal-panel" style="max-width:520px;">
            <div class="modal-header">
                <h3>Add link from “${escapeHtml(note.title || 'Untitled')}”</h3>
                <button class="modal-close" onclick="this.closest('.modal-backdrop').remove()">${icon('x')}</button>
            </div>
            <div class="modal-body" style="display:flex; flex-direction:column; gap:10px;">
                <label class="settings-label" style="font-size:12px; font-weight:600; color:var(--text-secondary);">Target note</label>
                <select id="zettel-link-target" class="compact-select">
                    ${others.map(n => `<option value="${n.note_id}">${escapeHtml(n.title || 'Untitled')}</option>`).join('')}
                </select>
                <label class="settings-label" style="font-size:12px; font-weight:600; color:var(--text-secondary);">Link type</label>
                <select id="zettel-link-type" class="compact-select">
                    ${ZETTEL_LINK_TYPES.map(t => `<option value="${t.value}">${t.label}</option>`).join('')}
                </select>
                <label class="settings-label" style="font-size:12px; font-weight:600; color:var(--text-secondary);">Rationale (optional)</label>
                <input type="text" id="zettel-link-rationale" class="compact-input" placeholder="Why does this link hold?">
            </div>
            <div class="modal-footer">
                <button class="btn-secondary btn-small" onclick="this.closest('.modal-backdrop').remove()">Cancel</button>
                <button class="btn-small" onclick="submitZettelLink(${note.note_id}, this)">${icon('link')} Add link</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);
    refreshIcons(overlay);
}

async function submitZettelLink(sourceNoteId, btn) {
    const overlay = btn.closest('.modal-backdrop');
    const targetId = parseInt(overlay.querySelector('#zettel-link-target').value, 10);
    const linkType = overlay.querySelector('#zettel-link-type').value;
    const rationale = overlay.querySelector('#zettel-link-rationale').value.trim();
    if (!targetId || targetId === sourceNoteId) return;
    try {
        const res = await fetch(`/api/zettel/notes/${sourceNoteId}/links`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ target_note_id: targetId, link_type: linkType, rationale }),
        });
        if (!res.ok) throw new Error('Could not add link');
        overlay.remove();
        await loadZettelDetail(sourceNoteId);
    } catch (err) {
        console.error('Add link error:', err);
    }
}

async function deleteZettelLink(linkId) {
    if (!linkId) return;
    try {
        const res = await fetch(`/api/zettel/links/${linkId}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('Could not delete link');
        if (appState.activeZettelNoteId) await loadZettelDetail(appState.activeZettelNoteId);
    } catch (err) {
        console.error('Delete link error:', err);
    }
}

/* ── Backlinks section ─────────────────────────────────────────────────────── */

function renderZettelConnections(note) {
    const links = note.links || {};
    const incoming = links.incoming || [];
    const outgoing = links.outgoing || [];
    const isManual = l => (l.origin || 'manual') === 'manual';

    /* A link you drew and a link the machine proposed are different kinds of
     * claim. The old UI grouped both by origin in one list, so an LLM guess sat
     * beside your own reasoning with equal weight. */
    const mine = [
        ...outgoing.filter(isManual).map(l => ({ ...l, dir: 'out', id: l.target_note_id, title: l.target_title })),
        ...incoming.filter(isManual).map(l => ({ ...l, dir: 'in',  id: l.source_note_id, title: l.source_title })),
    ];
    const suggested = [
        ...outgoing.filter(l => !isManual(l)).map(l => ({ ...l, dir: 'out', id: l.target_note_id, title: l.target_title })),
        ...incoming.filter(l => !isManual(l)).map(l => ({ ...l, dir: 'in',  id: l.source_note_id, title: l.source_title })),
    ];

    const row = (l, removable) => `
        <div class="zettel-conn-row">
            <button class="zettel-conn-item" onclick="selectZettelNote(${l.id})">
                <span class="zettel-conn-dir" title="${l.dir === 'out' ? 'This note links out' : 'Links to this note'}">${l.dir === 'out' ? '→' : '←'}</span>
                <span class="zettel-conn-title">${escapeHtml(l.title || 'Untitled')}</span>
                <span class="zettel-conn-type zettel-origin-${escapeHtml(l.origin || 'manual')}">${escapeHtml(l.link_type || originLabel(l.origin))}</span>
                ${l.rationale ? `<span class="zettel-conn-why">${escapeHtml(l.rationale)}</span>` : ''}
            </button>
            ${removable ? `<button class="zettel-conn-remove" onclick="deleteZettelLink(${l.link_id})" title="Remove link">${icon('x')}</button>` : ''}
        </div>`;

    return `
        <section class="zettel-connections">
            <header class="zettel-conn-head">
                <h3>Connections</h3>
                <span class="zettel-conn-counts">${mine.length} yours · ${suggested.length} suggested</span>
                <button class="btn-secondary btn-small" onclick="addZettelLinkModal()">${icon('link')} Add link</button>
            </header>

            <div class="zettel-conn-group">
                <div class="zettel-conn-group-title">Links you made</div>
                ${mine.length ? mine.map(l => row(l, l.dir === 'out')).join('')
                    : '<div class="project-muted">None yet — write <code>[[note title]]</code> in the body, or use Add link.</div>'}
            </div>

            ${suggested.length ? `
            <div class="zettel-conn-group zettel-conn-suggested">
                <div class="zettel-conn-group-title">Suggested — not yet yours ${icon('sparkles')}</div>
                ${suggested.map(l => row(l, false)).join('')}
            </div>` : ''}
        </section>`;
}

/* ── Evidence section ───────────────────────────────────────────────────────── */

function renderZettelEvidenceBlock(note) {
    const ev = note.evidence;
    if (!ev || !note.anchor_annotation_id) return renderZettelAnchorPicker(note);
    const collapsed = appState.zettelEvidenceCollapsed ? ' collapsed' : '';
    const tags = (ev.tags || []).map(t =>
        `<span class="project-theme-chip" style="--theme-color:${t.color || '#3b82f6'}">#${escapeHtml(t.name)}</span>`).join('');
    const cite = [ev.item_title, ev.item_year].filter(Boolean).join(' · ');
    return `
        <section class="zettel-evidence-card${collapsed}">
            <header class="zettel-evidence-head">
                <button class="zettel-evidence-toggle" onclick="toggleZettelEvidence()" title="Collapse or expand the passage">
                    ${icon(appState.zettelEvidenceCollapsed ? 'chevron-right' : 'chevron-down')}
                    <span class="zettel-evidence-label">Evidence</span>
                </button>
                <span class="zettel-evidence-cite">${escapeHtml(cite)}${ev.page_index != null ? ' · p.' + (ev.page_index + 1) : ''}</span>
                <span class="zettel-evidence-head-actions">
                    <button class="btn-secondary btn-small" onclick="jumpToZettelEvidence()">${icon('external-link')} Open in PDF</button>
                    <button class="btn-secondary btn-small danger" onclick="removeZettelAnchor()" title="Remove anchor">${icon('unlink')}</button>
                </span>
            </header>
            <blockquote class="zettel-evidence-quote">${escapeHtml(ev.quote || '(no quote captured)')}</blockquote>
            ${tags ? `<div class="zettel-evidence-tags">${tags}</div>` : ''}
        </section>`;
}

function toggleZettelEvidence() {
    appState.zettelEvidenceCollapsed = !appState.zettelEvidenceCollapsed;
    if (appState.activeZettelNote) renderZettelDetail(appState.activeZettelNote);
}

function renderZettelAnchorPicker(note) {
    const currentAnn = appState.editingAnnotationId || appState.noteDrawerAnnotationId || '';
    return `
        <section class="zettel-anchor-cta">
            <div class="zettel-anchor-cta-text">
                ${icon('anchor')}
                <span>Not anchored. Tying this note to the passage it came from is what separates a zettelkasten from a notebook.</span>
            </div>
            <div class="zettel-anchor-picker">
                ${currentAnn
                    ? `<button class="btn-small" onclick="setZettelAnchor(${Number(currentAnn)})">${icon('anchor')} Anchor to the passage open in the PDF</button>`
                    : `<span class="project-muted">Open a PDF and select a highlight, then come back — it will be offered here.</span>`}
                <details class="zettel-anchor-manual">
                    <summary>Enter an annotation ID</summary>
                    <div class="zettel-anchor-manual-row">
                        <input type="number" id="zettel-anchor-id" class="compact-input" value="${currentAnn}" placeholder="Annotation ID" style="max-width:150px;">
                        <button class="btn-secondary btn-small" onclick="setZettelAnchor()">Set anchor</button>
                    </div>
                </details>
            </div>
        </section>`;
}

async function setZettelAnchor(annotationId = null) {
    const note = appState.activeZettelNote;
    if (!note) return;
    /* Called either with the annotation already open in the PDF, or from the
     * manual id field behind the disclosure. */
    const annId = annotationId || parseInt(document.getElementById('zettel-anchor-id')?.value, 10);
    if (!annId) return;
    try {
        const res = await fetch(`/api/zettel/notes/${note.note_id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ anchor_annotation_id: annId }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || 'Could not set anchor');
        }
        await loadZettelDetail(note.note_id);
        renderZettelSidebar();
    } catch (err) {
        console.error('Set anchor error:', err);
        alert(err.message);
    }
}

async function removeZettelAnchor() {
    const note = appState.activeZettelNote;
    if (!note) return;
    try {
        const res = await fetch(`/api/zettel/notes/${note.note_id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ anchor_annotation_id: null }),
        });
        if (!res.ok) throw new Error('Could not remove anchor');
        await loadZettelDetail(note.note_id);
        renderZettelSidebar();
    } catch (err) {
        console.error('Remove anchor error:', err);
    }
}

function jumpToZettelEvidence() {
    const note = appState.activeZettelNote;
    if (!note || !note.anchor_annotation_id) return;
    /* If the anchor's item is not the one currently open in the preview, open
     * it first so navigateToAnnotation can find the overlay. */
    const itemKey = note.anchor_item_key;
    if (itemKey && (!appState.previewItem || appState.previewItem.item_key !== itemKey)) {
        openPreview(itemKey);
        /* The PDF renders asynchronously; defer the jump until annotations load. */
        const waitJump = () => {
            if (appState.previewKind !== 'pdf' || !appState.pdfDoc) {
                setTimeout(waitJump, 200);
                return;
            }
            navigateToAnnotation(note.anchor_annotation_id);
        };
        setTimeout(waitJump, 300);
    } else {
        navigateToAnnotation(note.anchor_annotation_id);
    }
}

/* ── Graph section ─────────────────────────────────────────────────────────── */

let _timelineInterval = null;

function renderZettelGraphSection(note) {
    const scope = appState.zettelGraphScope || 'global';
    const depth = appState.zettelGraphDepth || 1;
    const isClusters = !!appState.zettelGraphClustersEnabled;
    const isTimeline = !!appState.zettelGraphTimelineVisible;

    return `
        <section class="project-panel zettel-graph-panel">
            <div class="project-panel-header zettel-graph-header">
                <div class="zettel-graph-title-group">
                    <h3>Knowledge Graph</h3>
                    ${note ? `<span class="zettel-graph-focus-pill">${icon('eye')} Focus: ${escapeHtml(note.title)}</span>` : ''}
                </div>
                <div class="zettel-graph-legend">
                    <span class="zettel-legend-item"><span class="zettel-legend-dot anchored"></span> Anchored</span>
                    <span class="zettel-legend-item"><span class="zettel-legend-dot unanchored"></span> Unanchored</span>
                    <span class="zettel-legend-line manual">manual</span>
                    <span class="zettel-legend-line shared">shared evidence</span>
                    <span class="zettel-legend-line semantic">semantic</span>
                    <span class="zettel-legend-line contradiction">contradiction</span>
                </div>
            </div>
            <div class="zettel-graph-wrap">
                <!-- Modern Floating Glass HUD Toolbar -->
                <div class="graph-hud-controls">
                    <!-- Scope Switcher: Global vs Local -->
                    <div class="graph-hud-scope-wrap">
                        <button class="graph-scope-btn ${scope === 'global' ? 'active' : ''}" onclick="setZettelGraphScope('global')" title="View complete vault graph">Global</button>
                        <button class="graph-scope-btn ${scope === 'local' ? 'active' : ''}" onclick="setZettelGraphScope('local')" title="View local neighbourhood around focused note">Local ${scope === 'local' ? `(${depth}h)` : ''}</button>
                    </div>

                    ${scope === 'local' ? `
                    <div class="graph-hud-scope-wrap">
                        <button class="graph-scope-btn ${depth === 1 ? 'active' : ''}" onclick="setZettelGraphDepth(1)" title="1-hop immediate neighbours">1h</button>
                        <button class="graph-scope-btn ${depth === 2 ? 'active' : ''}" onclick="setZettelGraphDepth(2)" title="2-hop extended neighbours">2h</button>
                        <button class="graph-scope-btn ${depth === 3 ? 'active' : ''}" onclick="setZettelGraphDepth(3)" title="3-hop thematic horizon">3h</button>
                    </div>` : ''}

                    <!-- Search Filter -->
                    <div class="graph-hud-search-wrap">
                        <i data-lucide="search" aria-hidden="true"></i>
                        <input type="text" class="graph-hud-search" placeholder="Filter graph..." oninput="_netSearch(this.value)">
                    </div>

                    <!-- Visual Analytics Toggles -->
                    <div class="graph-hud-btn-group">
                        <button class="graph-hud-btn ${isClusters ? 'active' : ''}" id="graph-clusters-btn" onclick="toggleZettelClusters(this)" title="Toggle thematic AI cluster grouping">${icon('layers')} Clusters</button>
                        <button class="graph-hud-btn ${isTimeline ? 'active' : ''}" id="graph-timeline-btn" onclick="toggleZettelTimeline(this)" title="Toggle historical timeline filter">${icon('clock')} Timeline</button>
                        <button class="graph-hud-btn" id="graph-analytics-btn" onclick="toggleZettelAnalyticsDrawer()" title="View topological metrics & knowledge hubs">${icon('bar-chart-2')} Metrics</button>
                    </div>

                    <!-- View & Layout Actions -->
                    <div class="graph-hud-btn-group">
                        <button class="graph-hud-btn" onclick="_netReheat()" title="Re-organise physics layout">${icon('refresh-cw')} Organise</button>
                        <button class="graph-hud-btn active" id="graph-hud-particles-btn" onclick="_netToggleParticles(this)" title="Toggle energy flow particles">${icon('sparkles')} Flow</button>
                        <button class="graph-hud-btn" onclick="_netZoomFit()" title="Reset view and center">${icon('maximize-2')} Fit</button>
                        <button class="graph-hud-btn" onclick="_netZoom(0.25)" title="Zoom in">${icon('zoom-in')}</button>
                        <button class="graph-hud-btn" onclick="_netZoom(-0.25)" title="Zoom out">${icon('zoom-out')}</button>
                    </div>
                </div>

                <canvas id="zettel-network-canvas"></canvas>
                <div id="zettel-network-empty" class="project-muted" style="display:none;">No links yet. Add links or recompute computed links.</div>
                <div id="zettel-graph-tooltip" class="graph-floating-tooltip" style="display:none;"></div>

                <!-- Floating Timeline Scrubber Bar -->
                <div id="zettel-timeline-bar" class="graph-timeline-bar" style="${isTimeline ? '' : 'display:none;'}">
                    <button class="timeline-play-btn" onclick="toggleZettelTimelinePlay()" id="timeline-play-btn" title="Animate evolution over time">${icon('play')}</button>
                    <div class="timeline-slider-wrap">
                        <input type="range" class="timeline-slider" id="zettel-timeline-slider" min="2000" max="2026" step="1" value="2026" oninput="onZettelTimelineChange(this.value)">
                        <span class="timeline-label" id="zettel-timeline-val">≤ 2026</span>
                    </div>
                </div>

                <!-- Slide-Out Analytics Drawer -->
                <div id="zettel-analytics-drawer" class="graph-analytics-drawer">
                    <div class="analytics-drawer-header">
                        <h4>${icon('bar-chart-2')} Graph Analytics</h4>
                        <button onclick="toggleZettelAnalyticsDrawer()">${icon('x')}</button>
                    </div>
                    <div id="zettel-analytics-body" class="analytics-drawer-body">
                        <div class="project-muted" style="padding:16px; text-align:center;">Loading graph metrics...</div>
                    </div>
                </div>
            </div>
        </section>`;
}

async function loadZettelGraph() {
    try {
        const scope = appState.zettelGraphScope || 'global';
        const centerId = appState.activeZettelNoteId || '';
        const depth = appState.zettelGraphDepth || 1;
        const url = `/api/zettel/graph?scope=${encodeURIComponent(scope)}&center_id=${encodeURIComponent(centerId)}&depth=${encodeURIComponent(depth)}`;

        const res = await fetch(url);
        if (!res.ok) throw new Error('Could not load graph');
        const data = await res.json();
        appState.zettelGraphData = data;
        renderZettelGraph(data);

        // Update timeline range if available
        const years = (data.nodes || []).map(n => n.year).filter(Boolean);
        if (years.length > 0) {
            const minYear = Math.min(...years);
            const maxYear = Math.max(...years);
            const slider = document.getElementById('zettel-timeline-slider');
            if (slider) {
                slider.min = minYear;
                slider.max = maxYear;
                if (!appState.zettelGraphTimelineMax) {
                    slider.value = maxYear;
                    const valEl = document.getElementById('zettel-timeline-val');
                    if (valEl) valEl.textContent = `≤ ${maxYear}`;
                }
            }
        }
    } catch (err) {
        console.error('Load zettel graph error:', err);
    }
}

function renderZettelGraph(data) {
    const nodes = (data.nodes || []).map(n => ({
        id: n.id,
        name: n.name,
        count: n.count || 1,
        color: n.anchored ? '#60a5fa' : '#94a3b8',
        anchored: !!n.anchored,
        community_id: n.community_id,
        community_name: n.community_name,
        community_color: n.community_color,
        year: n.year,
        tags: n.tags || [],
        aliases: n.aliases || [],
        anchor_quote: n.anchor_quote || '',
        anchor_item_title: n.anchor_item_title || '',
        betweenness: n.betweenness || 0,
        depth: n.depth,
        _isZettel: true,
    }));

    const edges = (data.edges || []).map(e => {
        const style = zettelEdgeStyle(e.origin, e.link_type);
        return {
            source: e.source,
            target: e.target,
            label: e.link_type,
            link_type: e.link_type,
            color: style.color,
            dash: style.dash,
            _origin: e.origin,
            _rationale: e.rationale || '',
        };
    });

    const prebuilt = { nodes, edges, communities: data.communities || [] };
    if (typeof _initNetworkGraph === 'function') {
        _initNetworkGraph([], 'zettel-network-canvas', 'zettel-network-empty', {
            prebuilt: prebuilt,
            onNodeClick: (node) => selectZettelNoteById(node.id),
        });
    }
}

function setZettelGraphScope(scope) {
    appState.zettelGraphScope = scope;
    if (scope === 'local' && !appState.activeZettelNoteId) {
        // Pick first note as center if none selected
        if (appState.zettelNotes && appState.zettelNotes.length > 0) {
            appState.activeZettelNoteId = appState.zettelNotes[0].note_id;
        }
    }
    const note = appState.zettelNotes?.find(n => n.note_id === appState.activeZettelNoteId) || null;
    const content = document.getElementById('zettel-view-content');
    if (content) {
        content.innerHTML = renderZettelGraphSection(note);
        if (typeof lucide !== 'undefined') lucide.createIcons();
    }
    loadZettelGraph();
}

function setZettelGraphDepth(depth) {
    appState.zettelGraphDepth = depth;
    const note = appState.zettelNotes?.find(n => n.note_id === appState.activeZettelNoteId) || null;
    const content = document.getElementById('zettel-view-content');
    if (content) {
        content.innerHTML = renderZettelGraphSection(note);
        if (typeof lucide !== 'undefined') lucide.createIcons();
    }
    loadZettelGraph();
}

function toggleZettelClusters(btn) {
    appState.zettelGraphClustersEnabled = !appState.zettelGraphClustersEnabled;
    if (typeof _netToggleClusters === 'function') {
        _netToggleClusters(btn);
    }
}

function toggleZettelTimeline(btn) {
    appState.zettelGraphTimelineVisible = !appState.zettelGraphTimelineVisible;
    const bar = document.getElementById('zettel-timeline-bar');
    if (bar) bar.style.display = appState.zettelGraphTimelineVisible ? 'flex' : 'none';
    if (btn) btn.classList.toggle('active', appState.zettelGraphTimelineVisible);
    if (!appState.zettelGraphTimelineVisible && typeof _netSetTimelineYear === 'function') {
        _netSetTimelineYear(null);
    }
}

function onZettelTimelineChange(year) {
    const valEl = document.getElementById('zettel-timeline-val');
    if (valEl) valEl.textContent = `≤ ${year}`;
    if (typeof _netSetTimelineYear === 'function') {
        _netSetTimelineYear(year);
    }
}

function toggleZettelTimelinePlay() {
    const btn = document.getElementById('timeline-play-btn');
    const slider = document.getElementById('zettel-timeline-slider');
    if (!slider) return;

    if (_timelineInterval) {
        clearInterval(_timelineInterval);
        _timelineInterval = null;
        if (btn) btn.innerHTML = icon('play');
        return;
    }

    if (btn) btn.innerHTML = icon('pause');
    const min = parseInt(slider.min, 10);
    const max = parseInt(slider.max, 10);
    let cur = parseInt(slider.value, 10);
    if (cur >= max) cur = min;

    _timelineInterval = setInterval(() => {
        cur++;
        if (cur > max) {
            clearInterval(_timelineInterval);
            _timelineInterval = null;
            if (btn) btn.innerHTML = icon('play');
            return;
        }
        slider.value = cur;
        onZettelTimelineChange(cur);
    }, 1000);
}

async function toggleZettelAnalyticsDrawer() {
    const drawer = document.getElementById('zettel-analytics-drawer');
    const btn = document.getElementById('graph-analytics-btn');
    if (!drawer) return;
    drawer.classList.toggle('open');
    if (btn) btn.classList.toggle('active', drawer.classList.contains('open'));
    if (drawer.classList.contains('open')) {
        await loadZettelAnalytics();
    }
}

async function loadZettelAnalytics() {
    const body = document.getElementById('zettel-analytics-body');
    if (!body) return;
    try {
        const res = await fetch('/api/zettel/analytics');
        if (!res.ok) throw new Error('Could not load analytics');
        const data = await res.json();

        const s = data.summary || {};
        body.innerHTML = `
            <!-- Top Vitals Grid -->
            <div class="analytics-metric-grid">
                <div class="analytics-metric-card">
                    <div class="analytics-metric-val">${s.node_count || 0}</div>
                    <div class="analytics-metric-lbl">Total Notes</div>
                </div>
                <div class="analytics-metric-card">
                    <div class="analytics-metric-val">${s.edge_count || 0}</div>
                    <div class="analytics-metric-lbl">Total Links</div>
                </div>
                <div class="analytics-metric-card">
                    <div class="analytics-metric-val">${((s.density || 0) * 100).toFixed(1)}%</div>
                    <div class="analytics-metric-lbl">Network Density</div>
                </div>
                <div class="analytics-metric-card">
                    <div class="analytics-metric-val">${s.avg_degree || 0}</div>
                    <div class="analytics-metric-lbl">Avg Connections</div>
                </div>
            </div>

            <!-- Top Knowledge Hubs -->
            <div>
                <div class="analytics-section-title">
                    <span>${icon('award')} Key Knowledge Hubs</span>
                    <span class="project-muted" style="font-size:10px;">Degree Centrality</span>
                </div>
                <div class="analytics-list">
                    ${(data.hubs || []).map(h => `
                        <div class="analytics-item-card" onclick="selectZettelNoteById(${h.id}); toggleZettelAnalyticsDrawer();">
                            <div class="analytics-item-header">
                                <span class="analytics-item-title">${escapeHtml(h.name)}</span>
                                <span class="analytics-item-badge">${h.degree} links</span>
                            </div>
                            <div class="analytics-item-sub">${escapeHtml(h.community || 'Cluster')}</div>
                        </div>
                    `).join('')}
                </div>
            </div>

            <!-- Critical Bridge Notes -->
            <div>
                <div class="analytics-section-title">
                    <span>${icon('git-merge')} Critical Bridge Notes</span>
                    <span class="project-muted" style="font-size:10px;">Betweenness</span>
                </div>
                <div class="analytics-list">
                    ${(data.bridges || []).map(b => `
                        <div class="analytics-item-card" onclick="selectZettelNoteById(${b.id}); toggleZettelAnalyticsDrawer();">
                            <div class="analytics-item-header">
                                <span class="analytics-item-title">${escapeHtml(b.name)}</span>
                                <span class="analytics-item-badge" style="background:rgba(168,85,247,0.15); color:#a855f7;">Bridge (${((b.betweenness||0)*100).toFixed(1)}%)</span>
                            </div>
                            <div class="analytics-item-sub">${escapeHtml(b.community || 'Cluster')}</div>
                        </div>
                    `).join('')}
                </div>
            </div>

            <!-- Thematic Communities -->
            <div>
                <div class="analytics-section-title">
                    <span>${icon('layers')} Thematic Communities</span>
                    <span class="project-muted" style="font-size:10px;">${(data.communities || []).length} clusters</span>
                </div>
                <div class="analytics-clusters-grid">
                    ${(data.communities || []).map(c => `
                        <div class="analytics-cluster-pill">
                            <div class="analytics-cluster-title-wrap">
                                <span class="analytics-cluster-dot" style="background:${c.color};"></span>
                                <strong>${escapeHtml(c.name)}</strong>
                            </div>
                            <span class="project-muted">${c.count} note${c.count !== 1 ? 's' : ''}</span>
                        </div>
                    `).join('')}
                </div>
            </div>

            <!-- Isolated Notes / Opportunities -->
            ${(data.isolated && data.isolated.length > 0) ? `
            <div>
                <div class="analytics-section-title">
                    <span>${icon('link-2')} Isolated Notes / Opportunities</span>
                    <span class="project-muted" style="font-size:10px;">${data.isolated.length} notes</span>
                </div>
                <div class="analytics-list">
                    ${data.isolated.slice(0, 4).map(iso => `
                        <div class="analytics-item-card" onclick="selectZettelNoteById(${iso.id}); toggleZettelAnalyticsDrawer();">
                            <div class="analytics-item-title">${escapeHtml(iso.name)}</div>
                            <div class="analytics-item-sub" style="color:var(--text-muted);">Candidate for synthesis or linking</div>
                        </div>
                    `).join('')}
                </div>
            </div>` : ''}
        `;
        if (typeof lucide !== 'undefined') lucide.createIcons();
    } catch (err) {
        body.innerHTML = `<div class="project-muted" style="padding:16px; color:var(--danger);">Error loading analytics: ${escapeHtml(err.message)}</div>`;
    }
}

function exportZettelGraphHtml() {
    window.open('/api/zettel/export?format=html', '_blank');
}

function selectZettelNoteById(noteId) {
    if (noteId) selectZettelNote(noteId);
}

function zettelEdgeStyle(origin, linkType) {
    if (origin === 'shared_evidence') return { color: '#34d399', dash: [6, 4] };
    if (origin === 'shared_theme')    return { color: '#2dd4bf', dash: [6, 4] };
    if (origin === 'semantic')        return { color: '#fbbf24', dash: [2, 3] };
    if (origin === 'contradiction')   return { color: '#f87171', dash: null };
    /* manual */
    if (linkType === 'contradicts')   return { color: '#f87171', dash: null };
    return { color: '#64748b', dash: null };
}

/* ── Recompute computed links ─────────────────────────────────────────────── */

async function recomputeZettelLinks() {
    const btn = document.getElementById('zettel-recompute-btn');
    if (btn) btn.disabled = true;
    try {
        const res = await fetch('/api/zettel/recompute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kinds: ['shared_evidence', 'semantic', 'contradiction'] }),
        });
        if (res.status === 202) {
            const data = await res.json();
            _zettelRecomputeJob = data.job_id;
            pollZettelRecompute(data.job_id);
        } else if (res.ok) {
            await loadZettelNotes({ listOnly: true });
            if (appState.activeZettelNote) await loadZettelDetail(appState.activeZettelNote.note_id);
            if (appState.zettelMode === 'graph') loadZettelGraph();
        } else {
            throw new Error('Recompute failed');
        }
    } catch (err) {
        console.error('Recompute links error:', err);
        if (btn) btn.disabled = false;
    }
}

async function pollZettelRecompute(jobId) {
    const btn = document.getElementById('zettel-recompute-btn');
    try {
        const res = await fetch(`/api/zettel/recompute/${jobId}`);
        const data = await res.json();
        if (data.status === 'completed' || data.status === 'done') {
            if (btn) btn.disabled = false;
            await loadZettelNotes({ listOnly: true });
            if (appState.activeZettelNote) await loadZettelDetail(appState.activeZettelNote.note_id);
            if (appState.zettelMode === 'graph') loadZettelGraph();
        } else if (data.status === 'running' || data.status === 'pending') {
            setTimeout(() => pollZettelRecompute(jobId), 1500);
        } else {
            if (btn) btn.disabled = false;
        }
    } catch (err) {
        console.error('Poll recompute error:', err);
        if (btn) btn.disabled = false;
    }
}

/* ── Export dropdown ────────────────────────────────────────────────────────── */

function toggleZettelExportMenu(ev) {
    if (ev) ev.stopPropagation();
    const menu = document.getElementById('zettel-export-menu');
    if (menu) menu.classList.toggle('open');
}

function closeZettelExportMenu() {
    const menu = document.getElementById('zettel-export-menu');
    if (menu) menu.classList.remove('open');
}

document.addEventListener('click', (e) => {
    const menu = document.getElementById('zettel-export-menu');
    if (!menu || !menu.classList.contains('open')) return;
    if (!e.target.closest('.zettel-export-wrap')) closeZettelExportMenu();
});

/* ── Exporters ─────────────────────────────────────────────────────────────── */

function exportZettelNotesCsv() {
    const rows = [['note_id', 'title', 'anchor_annotation_id', 'anchor_item_key', 'tags', 'source', 'created_at', 'updated_at']];
    (appState.zettelNotes || []).forEach(n => {
        rows.push([
            n.note_id, csvCell(n.title), n.anchor_annotation_id || '', n.anchor_item_key || '',
            csvCell(safeJsonArray(n.tags_json).join(';')), n.source || '', n.created_at || '', n.updated_at || '',
        ]);
    });
    downloadTextFile(rows.map(r => r.join(',')).join('\n'), 'tarcite-notes.csv', 'text/csv');
}

function exportZettelLinksCsv() {
    const rows = [['link_id', 'source_note_id', 'source_title', 'target_note_id', 'target_title', 'link_type', 'origin', 'weight', 'rationale']];
    const seen = new Set();
    (appState.zettelNotes || []).forEach(n => {
        const links = n.links || {};
        [...(links.outgoing || []), ...(links.incoming || [])].forEach(l => {
            const key = l.link_id;
            if (key && seen.has(key)) return;
            if (key) seen.add(key);
            const src = l.source_note_id != null ? l.source_note_id : n.note_id;
            const srcTitle = l.source_title || n.title;
            const tgt = l.target_note_id;
            const tgtTitle = l.target_title;
            if (tgt == null) return;
            rows.push([l.link_id || '', src, csvCell(srcTitle), tgt, csvCell(tgtTitle), l.link_type, l.origin, l.weight || '', csvCell(l.rationale || '')]);
        });
    });
    downloadTextFile(rows.map(r => r.join(',')).join('\n'), 'tarcite-links.csv', 'text/csv');
}

async function exportZettelMdZip() {
    try {
        const res = await fetch('/api/zettel/export?format=mdzip');
        if (!res.ok) throw new Error('Export failed');
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'tarcite-notes.zip';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    } catch (err) {
        console.error('Export mdzip error:', err);
    }
}

/* Build a standalone SVG of the zettel graph from appState.zettelGraphData.
 * Self-contained (circular layout) so export works even when the Graph section
 * isn't the active section. Reuses the global _expFrame / _svgAsPng / _sx / _tw
 * / _ellipsize / _EXP helpers from app-projects.js, and zettelEdgeStyle so the
 * exported edges match the on-screen visual language. */
function _buildZettelGraphSvg() {
    const data = appState.zettelGraphData;
    const nodes = data?.nodes || [];
    const edges = data?.edges || [];
    if (!nodes.length) return null;

    const cx = 220, cy = 220, R = nodes.length > 1 ? 180 : 0;
    const placed = nodes.map((n, i) => {
        const ang = nodes.length > 1 ? (i / nodes.length) * 2 * Math.PI - Math.PI / 2 : 0;
        const r = Math.max(10, Math.min(26, 10 + (n.count || 1) * 3));
        return { ...n, x: cx + R * Math.cos(ang), y: cy + R * Math.sin(ang), r };
    });
    const idx = new Map(placed.map(n => [n.id, n]));

    const LBL = 12;
    const labels = placed.map(n => _ellipsize(n.name || `#${n.id}`, LBL, 170, 700));
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    placed.forEach((n, i) => {
        const half = Math.max(n.r, _tw(labels[i], LBL, 700) / 2);
        x0 = Math.min(x0, n.x - half); x1 = Math.max(x1, n.x + half);
        y0 = Math.min(y0, n.y - n.r - 2); y1 = Math.max(y1, n.y + n.r + 6 + LBL);
    });
    const M = 16;
    const ox = -x0 + M, oy = -y0 + M;
    const bodyW = (x1 - x0) + M * 2, bodyH = (y1 - y0) + M * 2;

    const dashAttr = d => Array.isArray(d) ? ` stroke-dasharray="${d.join(' ')}"` : '';
    const edgeEls = edges.map(e => {
        const a = idx.get(e.source), b = idx.get(e.target);
        if (!a || !b) return '';
        const st = zettelEdgeStyle(e.origin, e.link_type);
        const lw = Math.max(1, (e.weight || 1) * 2).toFixed(2);
        const ax = (a.x + ox).toFixed(1), ay = (a.y + oy).toFixed(1);
        const bx = (b.x + ox).toFixed(1), by = (b.y + oy).toFixed(1);
        return `<path d="M ${ax} ${ay} L ${bx} ${by}" fill="none" stroke="${st.color}" stroke-width="${lw}" stroke-linecap="round" opacity="0.75"${dashAttr(st.dash)}/>`;
    }).join('');

    const nodeEls = placed.map((n, i) => {
        const x = (n.x + ox).toFixed(1), y = (n.y + oy).toFixed(1);
        const fill = n.anchored ? '#3b82f6' : '#9ca3af';
        return `<g>
            <circle cx="${x}" cy="${y}" r="${n.r.toFixed(1)}" fill="${fill}" fill-opacity="0.85" stroke="${fill}" stroke-width="2"/>
            ${n.count > 0 ? `<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="central" font-size="${Math.max(9, n.r * 0.6).toFixed(1)}" font-weight="700" fill="#fff">${n.count}</text>` : ''}
            <text x="${x}" y="${(n.y + oy + n.r + 6).toFixed(1)}" text-anchor="middle" dominant-baseline="hanging" font-size="${LBL}" font-weight="700" fill="${_EXP.ink}" stroke="${_EXP.bg}" stroke-width="3.5" stroke-linejoin="round" paint-order="stroke">${_sx(labels[i])}</text>
        </g>`;
    }).join('');

    return _expFrame({
        title: 'Zettelkasten Note Graph',
        subtitle: `${nodes.length} notes · ${edges.length} links`,
        bodyW, bodyH, body: edgeEls + nodeEls,
    });
}

function exportZettelGraphSvg() {
    const svg = _buildZettelGraphSvg();
    if (!svg) { alert('No notes to export. Create a note first.'); return; }
    downloadTextFile(svg, `zettel_graph_${_exportDateStamp()}.svg`, 'image/svg+xml;charset=utf-8');
}

function exportZettelGraphPng() {
    const svg = _buildZettelGraphSvg();
    if (!svg) { alert('No notes to export. Create a note first.'); return; }
    _svgAsPng(svg, `zettel_graph_${_exportDateStamp()}.png`);
}

/* ── Helpers ───────────────────────────────────────────────────────────────── */

function safeJsonArray(json) {
    if (!json) return [];
    if (Array.isArray(json)) return json;
    try { const v = JSON.parse(json); return Array.isArray(v) ? v : []; } catch { return []; }
}

function splitCsv(str) {
    if (!str) return [];
    return str.split(',').map(s => s.trim()).filter(Boolean);
}

function groupBy(arr, key) {
    return (arr || []).reduce((acc, item) => {
        const k = item[key] || 'manual';
        (acc[k] = acc[k] || []).push(item);
        return acc;
    }, {});
}

function originLabel(origin) {
    const map = {
        manual: 'Manual links',
        shared_evidence: 'Shared evidence (computed)',
        shared_theme: 'Shared theme (computed)',
        semantic: 'Semantic similarity (computed)',
        contradiction: 'Contradiction (computed)',
    };
    return map[origin] || origin;
}

function csvCell(val) {
    const s = String(val == null ? '' : val);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
}

function downloadTextFile(text, filename, type) {
    const blob = new Blob([text], { type: type || 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

/* Close the link autocomplete when clicking outside the editor. */
document.addEventListener('click', (e) => {
    const box = document.getElementById('zettel-link-autocomplete');
    if (box && !box.classList.contains('hidden') && !box.contains(e.target) &&
        e.target.id !== 'zettel-body-input') {
        hideZettelLinkAutocomplete();
    }
});