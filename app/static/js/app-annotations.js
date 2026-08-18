/* ── TarCite Workspace - Tags, Notes, and Annotation Analysis ───────────── */

/* ── Tag chip renderer ───────────────────────────────────────────────────────── */

function tagContrastColor(hex) {
    if (!hex || !hex.startsWith('#')) return '#ffffff';
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.55 ? '#1a1a2e' : '#ffffff';
}

function renderTagChip(tag, removable = false, removeCallback = '') {
    const bg = tag.color || '#3b82f6';
    const fg = tagContrastColor(bg);
    if (removable) {
        const removeBtn = `<span class="tag-chip-remove" onclick="event.stopPropagation();${removeCallback}" title="Remove tag">${icon('x')}</span>`;
        return `<span class="tag-chip removable" style="background:${bg};color:${fg};border-color:${bg}88">#${escapeHtml(tag.name)}${removeBtn}</span>`;
    }
    return `<span class="tag-chip tag-chip-link" style="background:${bg};color:${fg};border-color:${bg}88" onclick="filterByTagChip(${tag.tag_id})" title="Filter by #${escapeHtml(tag.name)}">#${escapeHtml(tag.name)}</span>`;
}

async function filterByTagChip(tagId) {
    // Set this tag + all its descendants as the sole active filter
    const descendants = getDescendantTagIds(tagId, appState.allTags);
    appState.annotationsViewFilter.tagIds = [tagId, ...descendants];
    renderNotesTagFilterList();
    await openAnnotationsView();
}

/* ── Tag API helpers ─────────────────────────────────────────────────────────── */

async function loadAllTags(options = {}) {
    return dedupeAsync('loadAllTags', async () => {
        try {
            const res = await fetch('/api/tags');
            if (!res.ok) return;
            const data = await res.json();
            appState.allTags = data.tags || [];
            renderNotesTagFilterList();
        } catch (err) {
            console.error('Load tags error:', err);
        }
    }, options);
}

async function apiCreateTag(name, color = '#3b82f6', parentId = null) {
    const res = await fetch('/api/tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, color, parent_id: parentId }),
    });
    if (!res.ok) throw new Error('Create tag failed');
    return res.json();
}

async function apiUpdateTag(tagId, name, color, parentId = null) {
    const res = await fetch(`/api/tags/${tagId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, color, parent_id: parentId }),
    });
    if (!res.ok) throw new Error('Update tag failed');
    return res.json();
}

/* ── Theme tree helpers ──────────────────────────────────────────────────────── */

function buildTagTree(flatTags) {
    const byId = {};
    flatTags.forEach(t => { byId[t.tag_id] = { ...t, children: [] }; });
    const roots = [];
    flatTags.forEach(t => {
        if (t.parent_id && byId[t.parent_id]) {
            byId[t.parent_id].children.push(byId[t.tag_id]);
        } else {
            roots.push(byId[t.tag_id]);
        }
    });
    // Roll up annotation + source counts from descendants to ancestors
    function rollUp(node) {
        let refs = node.annotation_count || 0;
        let srcs = node.source_count || 0;
        node.children.forEach(child => {
            rollUp(child);
            refs += child.annotation_count;
            srcs += child.source_count;
        });
        node.annotation_count = refs;
        node.source_count = srcs;
    }
    roots.forEach(rollUp);
    return roots;
}

function getDescendantTagIds(tagId, flatTags) {
    const ids = [];
    function collect(id) {
        flatTags.filter(t => t.parent_id === id).forEach(child => {
            ids.push(child.tag_id);
            collect(child.tag_id);
        });
    }
    collect(tagId);
    return ids;
}

function getTagAncestorPath(tagId, flatTags) {
    const parts = [];
    let current = flatTags.find(t => t.tag_id === tagId);
    while (current) {
        parts.unshift(current.name);
        current = current.parent_id ? flatTags.find(t => t.tag_id === current.parent_id) : null;
    }
    return parts;
}

async function apiDeleteTag(tagId) {
    const res = await fetch(`/api/tags/${tagId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Delete tag failed');
    return res.json();
}

async function apiSetAnnotationTags(annotationId, tagIds) {
    const res = await fetch(`/api/annotations/${annotationId}/tags`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag_ids: tagIds }),
    });
    if (!res.ok) throw new Error('Set annotation tags failed');
    return res.json();
}

/* ── Notes sidebar tab ───────────────────────────────────────────────────────── */

function initNotesTab() {
    document.querySelectorAll('.notes-type-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.notes-type-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            appState.annotationsViewFilter.type = btn.dataset.type;
            filterAnnotationsView();
            renderSidebarAnnotations();
        });
    });
    initNotesTreeResize();
}

function initNotesTreeResize() {
    const divider   = document.getElementById('notes-pane-divider');
    const topPane   = document.getElementById('notes-pane-top');
    const container = document.getElementById('tab-notes');
    if (!divider || !topPane || !container) return;

    const STORAGE_KEY = 'notesPaneSplit';
    const MIN_PCT = 15, MAX_PCT = 80;

    // Restore saved split
    const saved = parseFloat(localStorage.getItem(STORAGE_KEY));
    if (saved && saved >= MIN_PCT && saved <= MAX_PCT) {
        topPane.style.flex = `0 0 ${saved}%`;
    }

    let startY = 0, startTopH = 0, totalH = 0;

    divider.addEventListener('mousedown', e => {
        e.preventDefault();
        startY    = e.clientY;
        startTopH = topPane.getBoundingClientRect().height;
        totalH    = container.getBoundingClientRect().height;
        divider.classList.add('active');

        const onMove = e => {
            const delta  = e.clientY - startY;
            const newH   = Math.max(totalH * MIN_PCT / 100, Math.min(totalH * MAX_PCT / 100, startTopH + delta));
            const pct    = (newH / totalH * 100).toFixed(2);
            topPane.style.flex = `0 0 ${pct}%`;
        };

        const onUp = () => {
            divider.classList.remove('active');
            const pct = parseFloat(topPane.style.flex.match(/([\d.]+)%/)?.[1] || 55);
            localStorage.setItem(STORAGE_KEY, pct);
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });
}

function renderNotesTagFilterList(query = '') {
    const list = document.getElementById('notes-tag-filter-list');
    if (!list) return;

    // Update trash button title to reflect selection state
    const trashBtn = document.querySelector('#tab-notes .notes-icon-btn.danger');
    if (trashBtn) {
        const n = appState.annotationsViewFilter.tagIds.length;
        trashBtn.title = n > 0 ? `Remove ${n} selected theme(s)` : 'Remove all themes';
    }

    if (appState.allTags.length === 0) {
        list.innerHTML = '<div style="font-size:12px;color:var(--text-muted);padding:6px 0">No themes yet — click <strong>+</strong> to create one</div>';
        return;
    }

    const q = query.toLowerCase().replace(/^#/, '');

    if (q) {
        // Flat filtered list with ancestor path hint
        const visible = appState.allTags.filter(t => t.name.toLowerCase().includes(q));
        if (visible.length === 0) {
            list.innerHTML = '<div style="font-size:12px;color:var(--text-muted);padding:4px 0">No matching themes</div>';
            return;
        }
        list.innerHTML = '';
        visible.forEach(tag => {
            const active = appState.annotationsViewFilter.tagIds.includes(tag.tag_id);
            const path = getTagAncestorPath(tag.tag_id, appState.allTags);
            const pathStr = path.length > 1 ? path.slice(0, -1).join(' › ') + ' › ' : '';
            const row = document.createElement('button');
            row.className = `notes-theme-row${active ? ' active' : ''}`;
            row.innerHTML = `
                <span class="notes-theme-spacer"></span>
                <span class="notes-theme-dot" style="background:${tag.color || '#3b82f6'}"></span>
                <span class="notes-theme-name"><small style="color:var(--text-muted)">${escapeHtml(pathStr)}</small>${escapeHtml(tag.name)}</span>
                <span class="notes-theme-count">${tag.annotation_count || 0}</span>`;
            row.onclick = e => toggleTagFilter(e, tag.tag_id);
            list.appendChild(row);
        });
        return;
    }

    // Full tree with inline CRUD
    list.innerHTML = '';
    list.className = 'notes-theme-tree';
    const tree = buildTagTree(appState.allTags);
    tree.forEach(node => list.appendChild(buildSidebarThemeNode(node, 0)));
    initSidebarRootDropZone(list);
    refreshIcons(list);
}

function buildSidebarThemeNode(node, depth) {
    const wrap = document.createElement('div');
    wrap.className = 'notes-theme-node';
    wrap.dataset.tagId = node.tag_id;

    const hasChildren = node.children && node.children.length > 0;
    const active = appState.annotationsViewFilter.tagIds.includes(node.tag_id);
    const openKey = `themeOpen_${node.tag_id}`;
    const isOpen = sessionStorage.getItem(openKey) !== 'false';

    const row = document.createElement('div');
    row.className = `notes-theme-row${active ? ' active' : ''}`;
    row.dataset.tagId = node.tag_id;
    row.draggable = true;

    // All themes use a circle-outline icon in their theme color (color picker on click).
    const colorIcon = `<label class="notes-theme-dot-label" title="Change color" style="cursor:pointer;display:flex;align-items:center">
           <input type="color" value="${node.color || '#3b82f6'}" style="opacity:0;width:0;height:0;position:absolute"
               onchange="sidebarUpdateThemeColor(${node.tag_id}, this.value)">
           <span class="notes-theme-circle-icon" style="color:${node.color || '#3b82f6'}">${icon('circle')}</span>
       </label>`;

    row.innerHTML = `
        <span class="notes-theme-drag-handle">${icon('grip-vertical')}</span>
        ${hasChildren
            ? `<span class="notes-theme-toggle${isOpen ? ' open' : ''}" data-toggle="${node.tag_id}">${icon('chevron-right')}</span>`
            : `<span class="notes-theme-spacer"></span>`}
        ${colorIcon}
        <span class="notes-theme-name" onclick="toggleTagFilter(event, ${node.tag_id})" style="flex:1;cursor:pointer">${escapeHtml(node.name)}</span>
        <span class="notes-theme-counts">
            <span class="notes-theme-count-pill" title="Files">${icon('file-text')}<span>${node.source_count || 0}</span></span>
            <span class="notes-theme-count-pill notes-theme-count-refs" title="References">${icon('tag')}<span>${node.annotation_count || 0}</span></span>
        </span>
        <div class="notes-theme-row-actions">
            <button class="notes-theme-action-btn" data-add-menu="${node.tag_id}" title="Add theme">${icon('plus')}</button>
            <button class="notes-theme-action-btn" onclick="sidebarRenameTheme(${node.tag_id})" title="Rename">${icon('pencil')}</button>
            <button class="notes-theme-action-btn danger" onclick="sidebarDeleteTheme(${node.tag_id})" title="Delete">${icon('trash-2')}</button>
        </div>`;

    // Toggle expand on chevron click, update folder icon
    row.addEventListener('click', e => {
        if (e.target.closest('[data-toggle]')) {
            const childWrap = wrap.querySelector('.notes-theme-children');
            if (!childWrap) return;
            const key = `themeOpen_${node.tag_id}`;
            const toggle = row.querySelector('[data-toggle]');
            const isNowOpen = childWrap.style.display === 'none';
            childWrap.style.display = isNowOpen ? '' : 'none';
            toggle?.classList.toggle('open', isNowOpen);
            sessionStorage.setItem(key, isNowOpen ? 'true' : 'false');
        }
        if (e.target.closest('[data-add-menu]')) {
            const btn = e.target.closest('[data-add-menu]');
            sidebarShowAddMenu(btn, node.tag_id);
        }
    });

    // DnD
    row.addEventListener('dragstart', onThemeDragStart);
    row.addEventListener('dragend', onThemeDragEnd);
    row.addEventListener('dragover', onThemeDragOver);
    row.addEventListener('dragleave', onThemeDragLeave);
    row.addEventListener('drop', onThemeDrop);

    wrap.appendChild(row);

    if (hasChildren) {
        const childWrap = document.createElement('div');
        childWrap.className = 'notes-theme-children';
        if (!isOpen) childWrap.style.display = 'none';
        node.children.forEach(child => childWrap.appendChild(buildSidebarThemeNode(child, depth + 1)));
        wrap.appendChild(childWrap);
    }

    return wrap;
}

function filterTagSidebarList(query) {
    renderNotesTagFilterList(query);
}

/* ── Sidebar theme inline actions ────────────────────────────────────────────── */

function toggleSidebarNewTheme(forceClose = false) {
    const row = document.getElementById('notes-new-theme-row');
    const btn = document.getElementById('notes-add-theme-toggle');
    if (!row) return;
    const willOpen = forceClose ? false : row.classList.contains('hidden');
    row.classList.toggle('hidden', !willOpen);
    btn?.classList.toggle('active', willOpen);
    if (willOpen) {
        document.getElementById('notes-new-theme-name')?.focus();
    }
}

async function addThemeFromSidebar() {
    const nameEl = document.getElementById('notes-new-theme-name');
    const colorEl = document.getElementById('notes-new-theme-color');
    const name = (nameEl?.value || '').trim();
    if (!name) { nameEl?.focus(); return; }
    try {
        await apiCreateTag(name, colorEl?.value || '#3b82f6', null);
        if (nameEl) nameEl.value = '';
        toggleSidebarNewTheme(true);
        await loadAllTags({ force: true });
        renderNotesTagFilterList();
    } catch (err) { console.error('Add theme error:', err); }
}

function sidebarAddSubTheme(parentTagId) {
    const parent = appState.allTags.find(t => t.tag_id === parentTagId);
    if (!parent) return;

    // Remove any existing add-row
    document.querySelectorAll('.notes-subtheme-add-row').forEach(r => r.remove());

    const row = document.querySelector(`[data-tag-id="${parentTagId}"].notes-theme-row`);
    if (!row) return;

    const addRow = document.createElement('div');
    addRow.className = 'notes-subtheme-add-row';
    addRow.innerHTML = `
        <input type="text" class="compact-input" placeholder="Sub-theme name…" style="flex:1">
        <input type="color" class="tag-color-input" value="${parent.color || '#3b82f6'}" style="width:24px;height:24px">
        <button class="notes-subtheme-confirm-btn" title="Add">${icon('check')}</button>`;

    const nameInput = addRow.querySelector('input[type="text"]');
    const colorInput = addRow.querySelector('input[type="color"]');
    const confirmBtn = addRow.querySelector('.notes-subtheme-confirm-btn');

    const commit = async () => {
        const name = (nameInput?.value || '').trim();
        if (!name) { nameInput?.focus(); return; }
        try {
            await apiCreateTag(name, colorInput?.value || parent.color || '#3b82f6', parentTagId);
            addRow.remove();
            await loadAllTags({ force: true });
            renderNotesTagFilterList();
            // Auto-expand parent
            sessionStorage.setItem(`themeOpen_${parentTagId}`, 'true');
        } catch (err) { console.error('Add sub-theme error:', err); }
    };

    nameInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') addRow.remove();
    });
    confirmBtn.addEventListener('click', commit);

    row.insertAdjacentElement('afterend', addRow);
    refreshIcons(addRow);
    nameInput.focus();
}

function sidebarRenameTheme(tagId) {
    const tag = appState.allTags.find(t => t.tag_id === tagId);
    if (!tag) return;
    const row = document.querySelector(`[data-tag-id="${tagId}"].notes-theme-row`);
    if (!row) return;
    const nameSpan = row.querySelector('.notes-theme-name');
    if (!nameSpan) return;

    const original = tag.name;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = original;
    input.className = 'compact-input';
    input.style.cssText = 'flex:1;font-size:12px;height:22px;padding:2px 6px';

    nameSpan.replaceWith(input);
    input.focus();
    input.select();

    const commit = async () => {
        const newName = input.value.trim();
        if (newName && newName !== original) {
            try {
                await apiUpdateTag(tagId, newName, tag.color, tag.parent_id || null);
                await loadAllTags({ force: true });
            } catch (err) { console.error('Rename error:', err); }
        }
        renderNotesTagFilterList();
    };

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter') input.blur();
        if (e.key === 'Escape') { input.value = original; input.blur(); }
    });
}

async function sidebarDeleteTheme(tagId) {
    const tag = appState.allTags.find(t => t.tag_id === tagId);
    if (!tag) return;
    const descendants = getDescendantTagIds(tagId, appState.allTags);
    const total = 1 + descendants.length;
    const msg = total > 1
        ? `Delete theme "#${tag.name}" and its ${descendants.length} sub-theme(s)?\n\nThis removes them from all annotations.`
        : `Delete theme "#${tag.name}"?\n\nThis removes it from all annotations.`;
    if (!confirm(msg)) return;
    try {
        await apiDeleteTag(tagId);
        await loadAllTags({ force: true });
        renderNotesTagFilterList();
        if (appState.previewItem) await loadAnnotations(appState.previewItem.item_key);
    } catch (err) { console.error('Delete theme error:', err); }
}

async function sidebarUpdateThemeColor(tagId, newColor) {
    const tag = appState.allTags.find(t => t.tag_id === tagId);
    if (!tag) return;
    const dot = document.querySelector(`[data-tag-id="${tagId}"] .notes-theme-dot`);
    if (dot) dot.style.background = newColor;   // instant visual feedback
    try {
        await apiUpdateTag(tagId, tag.name, newColor, tag.parent_id || null);
        tag.color = newColor;
        await loadAllTags({ force: true });
        renderNotesTagFilterList();
    } catch (err) { console.error('Color update error:', err); }
}

async function sidebarDeleteAllThemes() {
    if (appState.allTags.length === 0) return;

    const selectedIds = appState.annotationsViewFilter.tagIds;
    const targetIds = selectedIds.length > 0 ? selectedIds : appState.allTags.filter(t => !t.parent_id).map(t => t.tag_id);
    const label = selectedIds.length > 0
        ? `Delete ${selectedIds.length} selected theme(s) and remove them from all annotations?`
        : `Delete all ${appState.allTags.length} theme(s) and remove them from all annotations?`;

    if (!confirm(label)) return;
    try {
        for (const id of targetIds) {
            await apiDeleteTag(id);
        }
        appState.annotationsViewFilter.tagIds = [];
        await loadAllTags({ force: true });
        renderNotesTagFilterList();
        if (appState.previewItem) await loadAnnotations(appState.previewItem.item_key);
    } catch (err) { console.error('Delete themes error:', err); }
}

/* ── Themes sidebar download ─────────────────────────────────────────────────── */

function toggleThemeExportMenu() {
    const menu = document.getElementById('notes-theme-export-menu');
    if (!menu) return;
    const willOpen = menu.classList.contains('hidden');
    menu.classList.toggle('hidden', !willOpen);
    if (willOpen) {
        refreshIcons(menu);
        const close = e => {
            if (!menu.closest('.notes-theme-export-wrap').contains(e.target)) {
                menu.classList.add('hidden');
                document.removeEventListener('click', close);
            }
        };
        setTimeout(() => document.addEventListener('click', close), 0);
    }
}

function _selectedOrAllTags() {
    // If themes are actively selected in the filter, export only those (plus their subtrees).
    // Otherwise export every theme.
    const selectedIds = appState.annotationsViewFilter.tagIds;
    if (selectedIds.length === 0) return appState.allTags;
    const include = new Set();
    selectedIds.forEach(id => {
        include.add(id);
        getDescendantTagIds(id, appState.allTags).forEach(d => include.add(d));
        // also include ancestors so the path makes sense in flat exports
        let cur = appState.allTags.find(t => t.tag_id === id);
        while (cur?.parent_id) {
            include.add(cur.parent_id);
            cur = appState.allTags.find(t => t.tag_id === cur.parent_id);
        }
    });
    return appState.allTags.filter(t => include.has(t.tag_id));
}

function exportThemesCSV() {
    document.getElementById('notes-theme-export-menu')?.classList.add('hidden');
    const tags = _selectedOrAllTags();
    if (!tags.length) { alert('No themes to export.'); return; }

    const header = ['name', 'path', 'parent', 'color', 'files', 'references'];
    const rows = tags.map(t => {
        const path = getTagAncestorPath(t.tag_id, appState.allTags);
        const parent = t.parent_id ? (appState.allTags.find(p => p.tag_id === t.parent_id)?.name || '') : '';
        return [
            t.name,
            path.join(' › '),
            parent,
            t.color || '#3b82f6',
            String(t.source_count || 0),
            String(t.annotation_count || 0),
        ];
    });

    const csv = [header, ...rows]
        .map(row => row.map(c => `"${String(c).replace(/"/g, '""')}"`).join(','))
        .join('\r\n');

    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `themes_${_exportDateStamp()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
}

async function exportThemesWithAnnotationsJSON() {
    document.getElementById('notes-theme-export-menu')?.classList.add('hidden');
    if (!appState.allTags.length) { alert('No themes to export.'); return; }
    await _ensureAnnotationsLoaded();

    const activeTags = _selectedOrAllTags();
    const activeIds = new Set(activeTags.map(t => t.tag_id));

    const tree = buildTagTree(activeTags);

    function nodeToExport(node) {
        const anns = appState.annotationsViewItems.filter(a =>
            (a.tags || []).some(t => t.tag_id === node.tag_id)
        ).map(a => ({
            quote: a.quote || null,
            comment: a.comment || null,
            type: a.annotation_type,
            page: (a.page_index || 0) + 1,
            source: a.item_title || a.item_key,
            year: a.item_year || null,
        }));
        const out = {
            name: node.name,
            color: node.color || '#3b82f6',
            files: node.source_count || 0,
            references: node.annotation_count || 0,
            annotations: anns,
        };
        if (node.children?.length) out.children = node.children.map(nodeToExport);
        return out;
    }

    const payload = {
        exported_at: new Date().toISOString(),
        theme_count: activeTags.length,
        themes: tree.map(nodeToExport),
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `themes_${_exportDateStamp()}.json`;
    a.click();
    URL.revokeObjectURL(url);
}

async function exportThemesDocx() {
    document.getElementById('notes-theme-export-menu')?.classList.add('hidden');
    if (!appState.allTags.length) { alert('No themes to export.'); return; }
    await _ensureAnnotationsLoaded();

    const activeTags = _selectedOrAllTags();
    const tree = buildTagTree(activeTags);

    function nodeToPayload(node) {
        const anns = appState.annotationsViewItems.filter(a =>
            (a.tags || []).some(t => t.tag_id === node.tag_id)
        ).map(a => ({
            quote: a.quote || null,
            comment: a.comment || null,
            type: a.annotation_type,
            page: (a.page_index || 0) + 1,
            source: a.item_title || a.item_key || '',
            year: a.item_year || null,
            themes: (a.tags || []).map(t => ({ tag_id: t.tag_id, name: t.name, color: t.color })),
        }));
        const out = {
            name: node.name,
            color: node.color || '#3b82f6',
            files: node.source_count || 0,
            references: node.annotation_count || 0,
            annotations: anns,
        };
        if (node.children?.length) out.children = node.children.map(nodeToPayload);
        return out;
    }

    const payload = { themes: tree.map(nodeToPayload), annotations: [] };

    try {
        const res = await fetch('/api/export/themes/docx', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error(`Server error ${res.status}`);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `themes_${_exportDateStamp()}.docx`;
        a.click();
        URL.revokeObjectURL(url);
    } catch (err) {
        console.error('Themes DOCX export error:', err);
        alert('Export failed: ' + err.message);
    }
}

function sidebarShowAddMenu(btn, tagId) {
    document.querySelectorAll('.notes-add-menu').forEach(m => m.remove());

    const menu = document.createElement('div');
    menu.className = 'notes-add-menu';
    menu.innerHTML = `
        <button class="notes-add-menu-item" data-action="same">${icon('minus')} Same level</button>
        <button class="notes-add-menu-item" data-action="sub">${icon('corner-down-right')} Sub-theme</button>`;

    document.body.appendChild(menu);
    const rect = btn.getBoundingClientRect();
    menu.style.top = (rect.bottom + 4) + 'px';
    menu.style.left = rect.left + 'px';

    menu.querySelector('[data-action="same"]').addEventListener('click', () => {
        menu.remove();
        sidebarAddSameLevelTheme(tagId);
    });
    menu.querySelector('[data-action="sub"]').addEventListener('click', () => {
        menu.remove();
        sidebarAddSubTheme(tagId);
    });

    refreshIcons(menu);

    setTimeout(() => {
        const close = e => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', close); } };
        document.addEventListener('click', close);
    }, 0);
}

function sidebarAddSameLevelTheme(tagId) {
    const tag = appState.allTags.find(t => t.tag_id === tagId);
    if (!tag) return;

    document.querySelectorAll('.notes-subtheme-add-row').forEach(r => r.remove());

    const parentId = tag.parent_id || null;

    if (!parentId) {
        // Root level — reuse the top-level add form
        toggleSidebarNewTheme();
        return;
    }

    const wrap = document.querySelector(`.notes-theme-node[data-tag-id="${tagId}"]`);
    if (!wrap) return;

    const addRow = document.createElement('div');
    addRow.className = 'notes-subtheme-add-row';
    addRow.innerHTML = `
        <input type="text" class="compact-input" placeholder="Theme name…" style="flex:1">
        <input type="color" class="tag-color-input" value="${tag.color || '#3b82f6'}" style="width:24px;height:24px">
        <button class="notes-subtheme-confirm-btn" title="Add">${icon('check')}</button>`;

    const nameInput = addRow.querySelector('input[type="text"]');
    const colorInput = addRow.querySelector('input[type="color"]');
    const confirmBtn = addRow.querySelector('.notes-subtheme-confirm-btn');

    const commit = async () => {
        const name = (nameInput?.value || '').trim();
        if (!name) { nameInput?.focus(); return; }
        try {
            await apiCreateTag(name, colorInput?.value || tag.color || '#3b82f6', parentId);
            addRow.remove();
            await loadAllTags({ force: true });
            renderNotesTagFilterList();
        } catch (err) { console.error('Add same-level theme error:', err); }
    };

    nameInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') addRow.remove();
    });
    confirmBtn.addEventListener('click', commit);

    wrap.insertAdjacentElement('afterend', addRow);
    refreshIcons(addRow);
    nameInput.focus();
}

function initSidebarRootDropZone(list) {
    // Reuse existing root zone logic but for the sidebar tree
    let rootZone = list.querySelector('.sidebar-root-drop-zone');
    if (!rootZone) {
        rootZone = document.createElement('div');
        rootZone.className = 'theme-root-drop-zone sidebar-root-drop-zone';
        rootZone.textContent = 'Drop here → promote to top-level';
        rootZone.style.display = 'none';
        list.appendChild(rootZone);
    }
    rootZone.addEventListener('dragover', e => {
        e.preventDefault();
        rootZone.classList.add('drag-over');
    });
    rootZone.addEventListener('dragleave', () => rootZone.classList.remove('drag-over'));
    rootZone.addEventListener('drop', async e => {
        e.preventDefault();
        rootZone.classList.remove('drag-over');
        if (!_themeDraggedId) return;
        const tag = appState.allTags.find(t => t.tag_id === _themeDraggedId);
        await moveTheme(_themeDraggedId, null, tag);
    });
}

function toggleTagFilter(e, tagId) {
    const multi = e && (e.ctrlKey || e.metaKey || e.shiftKey);
    const descendants = getDescendantTagIds(tagId, appState.allTags);
    const allIds = [tagId, ...descendants];
    const alreadyActive = appState.annotationsViewFilter.tagIds.includes(tagId);

    if (multi) {
        // Ctrl/Cmd/Shift: add to or remove from current selection
        if (alreadyActive) {
            appState.annotationsViewFilter.tagIds = appState.annotationsViewFilter.tagIds.filter(id => !allIds.includes(id));
        } else {
            allIds.forEach(id => {
                if (!appState.annotationsViewFilter.tagIds.includes(id)) {
                    appState.annotationsViewFilter.tagIds.push(id);
                }
            });
        }
    } else {
        // Normal click: if already the sole selection, deselect; otherwise select only this
        const current = appState.annotationsViewFilter.tagIds;
        const sameSelection = allIds.every(id => current.includes(id)) && current.every(id => allIds.includes(id));
        appState.annotationsViewFilter.tagIds = sameSelection ? [] : [...allIds];
    }

    renderNotesTagFilterList();
    filterAnnotationsView();
}

function clearAnnotationsFilter() {
    appState.annotationsViewFilter = { tagIds: [], tagGroups: [], type: '', search: '', itemKey: '' };
    appState.annotationsViewDrill = '';
    document.querySelectorAll('.notes-type-btn').forEach(b => b.classList.remove('active'));
    document.querySelector('.notes-type-btn[data-type=""]')?.classList.add('active');
    document.getElementById('sidebar-file-filter-toggle')?.classList.remove('active');
    const panel = document.getElementById('sidebar-file-filter-panel');
    if (panel) panel.classList.add('hidden');
    const si = document.getElementById('notes-search-input');
    if (si) si.value = '';
    renderNotesTagFilterList();
    renderAnnotationsView();
    renderSidebarAnnotations();
}

/* ── Sidebar annotations mini-browser ───────────────────────────────────────── */

function toggleSidebarFileFilter() {
    const panel = document.getElementById('sidebar-file-filter-panel');
    const btn = document.getElementById('sidebar-file-filter-toggle');
    if (!panel) return;
    const opening = panel.classList.contains('hidden');
    panel.classList.toggle('hidden', !opening);
    btn?.classList.toggle('active', opening);
    if (opening) renderSidebarFilePanel();
}

function renderSidebarFilePanel() {
    const panel = document.getElementById('sidebar-file-filter-panel');
    if (!panel) return;

    // Build doc map: itemKey → { title, count }
    const docs = {};
    appState.annotationsViewItems.forEach(a => {
        if (!docs[a.item_key]) docs[a.item_key] = { title: a.item_title || a.item_key, count: 0 };
        docs[a.item_key].count++;
    });
    const sorted = Object.entries(docs).sort((a, b) => b[1].count - a[1].count);

    if (sorted.length === 0) {
        panel.innerHTML = '<div class="sidebar-file-empty">No annotated files yet.</div>';
        return;
    }

    const active = appState.annotationsViewFilter.itemKey;
    panel.innerHTML = sorted.map(([key, d]) => `
        <button class="sidebar-file-row${active === key ? ' active' : ''}" onclick="selectSidebarFile('${escapeJs(key)}')">
            <span class="sidebar-file-icon">${icon('file-text')}</span>
            <span class="sidebar-file-title" title="${escapeHtml(d.title)}">${escapeHtml(d.title.slice(0, 45))}${d.title.length > 45 ? '…' : ''}</span>
            <span class="sidebar-file-count">${d.count}</span>
        </button>`
    ).join('');
    refreshIcons(panel);
}

function selectSidebarFile(key) {
    const already = appState.annotationsViewFilter.itemKey === key;
    appState.annotationsViewFilter.itemKey = already ? '' : key;
    renderSidebarFilePanel();
    renderSidebarAnnotations();
}

async function loadSidebarAnnotations() {
    if (appState.annotationsViewItems.length === 0) {
        try {
            const res = await fetch('/api/annotations');
            if (!res.ok) return;
            const data = await res.json();
            appState.annotationsViewItems = data.annotations || [];
        } catch (err) { console.error('loadSidebarAnnotations:', err); return; }
    }
    renderSidebarAnnotations();
}

function renderSidebarAnnotations() {
    const list = document.getElementById('sidebar-ann-list');
    const badge = document.getElementById('sidebar-ann-count');
    if (!list) return;

    const { tagIds, type, search, itemKey } = appState.annotationsViewFilter;
    const filtered = _filteredAnnotations();

    if (badge) badge.textContent = String(filtered.length);

    // Per-type counts on filter buttons
    const counts = { '': appState.annotationsViewItems.length, highlight: 0, underline: 0, comment: 0, area: 0 };
    appState.annotationsViewItems.forEach(a => { if (counts[a.annotation_type] !== undefined) counts[a.annotation_type]++; });
    document.querySelectorAll('.notes-type-btn').forEach(btn => {
        btn.querySelector('.type-btn-count')?.remove();
        const c = counts[btn.dataset.type];
        if (c !== undefined && c > 0) {
            const s = document.createElement('span');
            s.className = 'type-btn-count';
            s.textContent = c;
            btn.appendChild(s);
        }
    });

    if (filtered.length === 0) {
        list.innerHTML = `<div class="sidebar-ann-empty">${search || type || tagIds.length ? 'No matching annotations.' : 'No annotations yet.<br><small>Highlight text in any PDF to create annotations.</small>'}</div>`;
        return;
    }

    const typeIconMap = { underline: 'underline', comment: 'message-square', area: 'square' };
    list.innerHTML = filtered.map(a => {
        const ti = typeIconMap[a.annotation_type] || 'highlighter';
        const text = (a.quote || a.comment || (a.annotation_type === 'area' ? 'Area selection' : ''));
        const excerpt = escapeHtml(text.slice(0, 120)) + (text.length > 120 ? '…' : '');
        const doc = escapeHtml((a.item_title || a.item_key || '').slice(0, 38)) + ((a.item_title || '').length > 38 ? '…' : '');
        const tagsHtml = (a.tags || []).map(t =>
            `<span class="sidebar-ann-tag" style="background:${t.color||'#3b82f6'}22;color:${t.color||'#3b82f6'};border-color:${t.color||'#3b82f6'}44">#${escapeHtml(t.name)}</span>`
        ).join('');
        return `<div class="sidebar-ann-mini-card" onclick="openPreviewFromAnnotation('${escapeJs(a.item_key)}',${(a.page_index||0)+1})">
            <div class="sidebar-ann-mini-bar" style="background:${a.color||'#ccc'}"></div>
            <div class="sidebar-ann-mini-body">
                <div class="sidebar-ann-mini-meta">
                    <span class="sidebar-ann-mini-type">${icon(ti)}</span>
                    <span class="sidebar-ann-mini-doc" title="${escapeHtml(a.item_title||'')}">p.${(a.page_index||0)+1} · ${doc}</span>
                    <span class="sidebar-ann-mini-actions">
                        <button class="sidebar-ann-mini-btn" onclick="event.stopPropagation();openNoteDrawerFromCard(${a.annotation_id})" title="Edit">${icon('pencil')}</button>
                        <button class="sidebar-ann-mini-btn danger" onclick="event.stopPropagation();deleteAnnotationFromCard(${a.annotation_id})" title="Delete">${icon('trash-2')}</button>
                    </span>
                </div>
                ${excerpt ? `<div class="sidebar-ann-mini-text">${excerpt}</div>` : ''}
                ${tagsHtml ? `<div class="sidebar-ann-mini-tags">${tagsHtml}</div>` : ''}
            </div>
        </div>`;
    }).join('');
    refreshIcons(list);
}

/* ── Note drawer ─────────────────────────────────────────────────────────────── */

function openNoteDrawer(annotationId) {
    const ann = appState.annotations.find(a => a.annotation_id === annotationId);
    if (!ann) return;

    // Toggle off if already open for this annotation
    if (appState.noteDrawerAnnotationId === annotationId) {
        closeNoteDrawer();
        return;
    }

    appState.noteDrawerAnnotationId = annotationId;
    appState.noteDrawerPendingTags = [...(ann.tags || [])];
    appState.noteDrawerPendingSentiment = ann.sentiment || null;

    if (appState.pdfFullscreen) {
        renderPdfFullscreenAnnotations();
    } else {
        renderAnnotationList();
        if (appState.annotationPanelOpen) renderAnnotationListInPanel();
    }

    // Focus textarea and render tags after DOM update
    setTimeout(() => {
        const ta = document.getElementById(`ann-inline-ta-${annotationId}`);
        if (ta) {
            ta.style.height = 'auto';
            ta.style.height = ta.scrollHeight + 'px';
            ta.focus();
            ta.setSelectionRange(ta.value.length, ta.value.length);
            ta.closest('.ann-inline-editor')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
        renderNoteDrawerTags();
    }, 30);
}

function closeNoteDrawer() {
    appState.noteDrawerAnnotationId = null;
    appState.noteDrawerPendingTags = [];
    appState.noteDrawerPendingSentiment = null;
    hideTagAutocomplete();
    if (appState.pdfFullscreen) {
        renderPdfFullscreenAnnotations();
    } else {
        renderAnnotationList();
        if (appState.annotationPanelOpen) renderAnnotationListInPanel();
    }
}

async function saveNoteDrawer() {
    const id = appState.noteDrawerAnnotationId;
    if (!id) return;

    const ann = appState.annotations.find(a => a.annotation_id === id);
    if (!ann) return;

    const ta = document.getElementById(`ann-inline-ta-${id}`);
    const newComment = ta ? ta.value.trim() : '';
    const tagIds = appState.noteDrawerPendingTags.map(t => t.tag_id);

    const newSentiment = appState.noteDrawerPendingSentiment || null;
    try {
        await patchAnnotation({ ...ann, comment: newComment, sentiment: newSentiment });
        await apiSetAnnotationTags(id, tagIds);
        pushAnnotationUndo({
            type: 'update',
            itemKey: ann.item_key,
            before: { ...ann },
            after: { ...ann, comment: newComment, sentiment: newSentiment },
        });
        closeNoteDrawer();
        await loadAnnotations(ann.item_key);
        await loadAllTags({ force: true });
        showSaveConfirmation('Note saved');
    } catch (err) {
        console.error('Save note drawer error:', err);
        showSaveConfirmation('Save failed');
    }
}

function renderNoteDrawerTags() {
    const container = document.getElementById('ann-inline-tags');
    if (!container) return;

    if (appState.noteDrawerPendingTags.length === 0) {
        container.innerHTML = '<span class="note-drawer-tags-empty">No themes yet — type #name above</span>';
        return;
    }

    container.innerHTML = appState.noteDrawerPendingTags.map((tag, i) =>
        renderTagChip(tag, true, `removeNoteDrawerTag(${i})`)
    ).join('');
    refreshIcons(container);
}

function removeNoteDrawerTag(index) {
    appState.noteDrawerPendingTags.splice(index, 1);
    renderNoteDrawerTags();
}

function setNoteDrawerSentiment(value) {
    appState.noteDrawerPendingSentiment = value;
    // Re-render just the sentiment row without losing textarea focus/content
    const id = appState.noteDrawerAnnotationId;
    const editor = document.getElementById(`ann-inline-${id}`);
    if (!editor) return;
    const row = editor.querySelector('.ann-sentiment-row');
    if (!row) return;
    const btns = ['pos', 'neu', 'neg'].map(s => {
        const emoji = s === 'pos' ? '😊' : s === 'neu' ? '😐' : '😟';
        const label = s === 'pos' ? 'Positive' : s === 'neu' ? 'Neutral' : 'Negative';
        const active = value === s ? ' active' : '';
        return `<button class="ann-sentiment-btn${active}" title="${label}" onclick="setNoteDrawerSentiment('${s}')">${emoji}</button>`;
    }).join('');
    const clear = value ? `<button class="ann-sentiment-clear" onclick="setNoteDrawerSentiment(null)" title="Clear sentiment">✕</button>` : '';
    row.innerHTML = `<span class="ann-sentiment-label">Sentiment</span>${btns}${clear}`;
}

function renderNoteDrawerHint() {
    const wrap = document.querySelector('.note-drawer-editor-wrap');
    if (!wrap) return;
    let hint = wrap.querySelector('.note-drawer-hint');
    if (!hint) {
        hint = document.createElement('div');
        hint.className = 'note-drawer-hint';
        wrap.appendChild(hint);
    }
    hint.innerHTML = 'Tip: type <span>#tag</span> to add a tag · <span>Ctrl+Enter</span> to save';
}

/* ── Tag autocomplete ────────────────────────────────────────────────────────── */

function onNoteDrawerInput(e) {
    const ta = e.target;
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
    checkTagAutocomplete(ta);
    checkNoteMentionAutocomplete(ta);
}

function onNoteDrawerKeydown(e) {
    const tagAC = appState.tagAutocompleteBox || document.getElementById('note-tag-autocomplete');
    const tagVisible = tagAC && !tagAC.classList.contains('hidden');
    // Find the visible mention box — there may be multiple; pick the one that's not hidden.
    const mentionAC = [...document.querySelectorAll('#note-mention-autocomplete')].find(b => !b.classList.contains('hidden'))
                   || document.getElementById('note-mention-autocomplete');
    const mentionVisible = mentionAC && !mentionAC.classList.contains('hidden');

    if (tagVisible) {
        if (e.key === 'ArrowDown') { e.preventDefault(); moveAutocompleteSelection(1); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); moveAutocompleteSelection(-1); return; }
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            const focused = tagAC.querySelector('.focused');
            if (focused) { focused.click(); return; }
        }
        if (e.key === 'Escape') { hideTagAutocomplete(); return; }
        if (e.key === 'Tab') { e.preventDefault(); const focused = tagAC.querySelector('.tag-autocomplete-item.focused'); if (focused) { focused.click(); return; } }
    }

    if (mentionVisible) {
        if (e.key === 'ArrowDown') { e.preventDefault(); moveNoteMentionSelection(1); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); moveNoteMentionSelection(-1); return; }
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            const focused = mentionAC.querySelector('.chat-mention-item.focused');
            if (focused) { focused.click(); return; }
        }
        if (e.key === 'Escape') { hideNoteMentionAutocomplete(); return; }
    }

    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        saveNoteDrawer();
    }
}

function checkTagAutocomplete(ta) {
    const text = ta.value;
    const caret = ta.selectionStart;
    const before = text.slice(0, caret);
    const match = before.match(/#(\w*)$/);

    if (!match) { hideTagAutocomplete(); return; }

    const query = match[1].toLowerCase();
    appState.tagAutocompleteQuery = query;
    appState.tagAutocompleteIndex = -1;
    appState.tagAutocompleteTA = ta;       // store textarea ref for click-selection
    appState.tagAutocompleteMatch = match; // store match for text removal

    const filtered = appState.allTags.filter(t => t.name.toLowerCase().startsWith(query));
    showTagAutocomplete(filtered, query, (tag) => insertTagFromAutocomplete(ta, match, tag));
}

function showTagAutocomplete(tags, query, onSelect) {
    // Two elements can share the id when a second annotation is opened (the old
    // box stays in document.body while the fresh editor creates a new one).
    // Priority: 1) already-tracked box from a previous keystroke in this session,
    //           2) the fresh box still inside the editor (not yet moved to body),
    //           3) whatever getElementById finds as a last resort.
    let box = appState.tagAutocompleteBox
              || [...document.querySelectorAll('#note-tag-autocomplete')].find(el => el.parentElement !== document.body)
              || document.getElementById('note-tag-autocomplete');
    if (!box) return;
    appState.tagAutocompleteBox = box;

    const items = tags.map((tag, i) => {
        const countBadge = tag.annotation_count ? `<span class="tag-autocomplete-count">${tag.annotation_count}</span>` : '';
        const path = getTagAncestorPath(tag.tag_id, appState.allTags);
        const pathHint = path.length > 1
            ? `<span class="tag-autocomplete-path">${escapeHtml(path.slice(0, -1).join(' › '))}</span>`
            : '';
        return `<div class="tag-autocomplete-item" data-index="${i}" onclick="selectTagAutocomplete(${tag.tag_id})">
            <span class="tag-autocomplete-dot" style="background:${tag.color || '#3b82f6'}"></span>
            <span>#${escapeHtml(tag.name)}</span>
            ${pathHint}
            ${countBadge}
        </div>`;
    }).join('');

    const createRow = query.length > 0 && !tags.some(t => t.name.toLowerCase() === query)
        ? `<div class="tag-autocomplete-create" onclick="createTagFromAutocomplete()">
               ${icon('plus')} Create tag <strong>#${escapeHtml(query)}</strong>
           </div>`
        : '';

    box.innerHTML = items + createRow;

    // Position using fixed coords so overflow:hidden/auto parents don't clip it
    const ta = appState.tagAutocompleteTA;
    if (ta) {
        const rect = ta.getBoundingClientRect();
        box.style.position = 'fixed';
        box.style.left = rect.left + 'px';
        box.style.width = rect.width + 'px';
        box.style.top = (rect.bottom + 4) + 'px';
        box.style.right = 'auto';
        box.style.zIndex = '9999';
        // In native fullscreen the browser top layer clips document.body children.
        // Append inside the fullscreen element so the box stays visible.
        const fsTarget = getFullscreenElement() || document.body;
        if (box.parentElement !== fsTarget) fsTarget.appendChild(box);
    }

    box.classList.remove('hidden');
    box._onSelect = onSelect;
    refreshIcons(box);
}

function hideTagAutocomplete() {
    const box = appState.tagAutocompleteBox || document.getElementById('note-tag-autocomplete');
    if (box) { box.classList.add('hidden'); box.innerHTML = ''; }
    appState.tagAutocompleteBox = null;
    appState.tagAutocompleteIndex = -1;
}

function moveAutocompleteSelection(dir) {
    const box = appState.tagAutocompleteBox || document.getElementById('note-tag-autocomplete');
    if (!box) return;
    const items = [...box.querySelectorAll('.tag-autocomplete-item')];
    if (items.length === 0) return;

    items.forEach(i => i.classList.remove('focused'));
    appState.tagAutocompleteIndex = Math.max(0, Math.min(items.length - 1, appState.tagAutocompleteIndex + dir));
    items[appState.tagAutocompleteIndex]?.classList.add('focused');
}

function selectTagAutocomplete(tagId) {
    const tag = appState.allTags.find(t => t.tag_id === tagId);
    if (!tag) return;
    // Remove the typed #query text from the textarea (same as keyboard path)
    const ta = appState.tagAutocompleteTA;
    const match = appState.tagAutocompleteMatch;
    if (ta && match) {
        insertTagFromAutocomplete(ta, match, tag);
    } else {
        insertTagIntoDrawer(tag);
    }
}

function insertTagFromAutocomplete(ta, match, tag) {
    const caret = ta.selectionStart;
    const before = ta.value.slice(0, caret);
    const after = ta.value.slice(caret);
    const prefix = before.slice(0, before.length - match[0].length);
    ta.value = prefix + after;
    ta.setSelectionRange(prefix.length, prefix.length);
    insertTagIntoDrawer(tag);
    ta.focus();
}

function insertTagIntoDrawer(tag) {
    if (!appState.noteDrawerPendingTags.some(t => t.tag_id === tag.tag_id)) {
        appState.noteDrawerPendingTags.push(tag);
        renderNoteDrawerTags();
    }
    hideTagAutocomplete();
}

async function createTagFromAutocomplete() {
    const query = appState.tagAutocompleteQuery;
    if (!query) return;

    try {
        const defaultColor = pickNextTagColor();
        const res = await apiCreateTag(query, defaultColor);
        const newTag = { tag_id: res.tag_id, name: query, color: defaultColor, annotation_count: 0 };
        appState.allTags.push(newTag);
        insertTagIntoDrawer(newTag);
        await loadAllTags({ force: true });
    } catch (err) {
        console.error('Create tag from autocomplete error:', err);
    }
}

const TAG_PALETTE = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'];
function pickNextTagColor() {
    const used = new Set(appState.allTags.map(t => t.color));
    return TAG_PALETTE.find(c => !used.has(c)) || TAG_PALETTE[appState.allTags.length % TAG_PALETTE.length];
}

/* ── Chat @ mention autocomplete ─────────────────────────────────────────────── */

function mentionLabel(item) {
    const creators = item.creators_list || item.creators;
    let parsed = creators;
    if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch { parsed = null; } }
    let lastName = '';
    if (Array.isArray(parsed) && parsed.length > 0) {
        const first = parsed[0];
        lastName = first.lastName || first.last_name || (first.name || '').split(' ').pop() || '';
        if (parsed.length > 1) lastName += 'EtAl';
    }
    return (lastName || 'Source') + (item.year || '');
}

async function checkChatMentionAutocomplete(ta) {
    const caret = ta.selectionStart;
    const before = ta.value.slice(0, caret);
    const match = before.match(/@(\w*)$/);
    if (!match) { hideChatMentionAutocomplete(); return; }

    const q = match[1].toLowerCase();
    appState.chatMentionAutocompleteIndex = -1;

    let items = appState.libraryItems;
    if (!items.length) {
        try {
            const res = await fetch(`/api/library/items?q=${encodeURIComponent(q)}&limit=10&sort_by=title&sort_order=asc`);
            if (res.ok) { const data = await res.json(); items = data.items || []; }
        } catch {}
    }

    const filtered = q
        ? items.filter(i =>
            (i.title || '').toLowerCase().includes(q) ||
            (formatCreators(i.creators_list || i.creators)).toLowerCase().includes(q) ||
            String(i.year || '').includes(q)
          ).slice(0, 8)
        : items.slice(0, 8);

    showChatMentionAutocomplete(filtered, ta, match);
}

function showChatMentionAutocomplete(items, ta, match) {
    const box = document.getElementById('chat-mention-autocomplete');
    if (!box) return;

    if (items.length === 0) { hideChatMentionAutocomplete(); return; }

    box.innerHTML = items.map((item, i) => {
        const label = mentionLabel(item);
        const authors = formatCreators(item.creators_list || item.creators).split(';')[0].trim();
        return `<div class="chat-mention-item" data-index="${i}" data-key="${escapeHtml(item.item_key)}">
            <span class="chat-mention-label">@${escapeHtml(label)}</span>
            <span class="chat-mention-title">${escapeHtml((item.title || 'Untitled').slice(0, 50))}${item.title?.length > 50 ? '…' : ''}</span>
            <span class="chat-mention-meta">${escapeHtml(authors)}${item.year ? ' · ' + item.year : ''}</span>
        </div>`;
    }).join('');

    box._items = items;
    box._ta = ta;
    box._match = match;
    box.classList.remove('hidden');

    box.querySelectorAll('.chat-mention-item').forEach(el => {
        el.addEventListener('click', () => {
            const idx = parseInt(el.dataset.index);
            insertChatMention(box._ta, box._match, box._items[idx]);
        });
    });
}

function hideChatMentionAutocomplete() {
    const box = document.getElementById('chat-mention-autocomplete');
    if (box) { box.classList.add('hidden'); box.innerHTML = ''; }
    appState.chatMentionAutocompleteIndex = -1;
}

function moveChatMentionSelection(dir) {
    const box = document.getElementById('chat-mention-autocomplete');
    if (!box) return;
    const items = [...box.querySelectorAll('.chat-mention-item')];
    if (!items.length) return;
    items.forEach(i => i.classList.remove('focused'));
    appState.chatMentionAutocompleteIndex = Math.max(0, Math.min(items.length - 1, appState.chatMentionAutocompleteIndex + dir));
    items[appState.chatMentionAutocompleteIndex]?.classList.add('focused');
}

function insertChatMention(ta, match, item) {
    const caret = ta.selectionStart;
    const before = ta.value.slice(0, caret);
    const after  = ta.value.slice(caret);
    const prefix = before.slice(0, before.length - match[0].length);
    const label  = mentionLabel(item);
    ta.value = prefix + `@${label}` + after;
    ta.selectionStart = ta.selectionEnd = prefix.length + label.length + 1;
    ta.focus();
    hideChatMentionAutocomplete();

    if (!appState.chatMentionedItems.some(m => m.item_key === item.item_key)) {
        appState.chatMentionedItems.push({ item_key: item.item_key, label });
    }
    renderChatMentionChips();
}

function renderChatMentionChips() {
    const container = document.getElementById('chat-mention-chips');
    if (!container) return;
    if (appState.chatMentionedItems.length === 0) { container.innerHTML = ''; return; }
    container.innerHTML = appState.chatMentionedItems.map(m =>
        `<span class="chat-mention-chip">
            ${icon('file-text')} @${escapeHtml(m.label)}
            <button class="chat-mention-chip-remove" onclick="removeChatMention('${escapeHtml(m.item_key)}')" title="Remove">&times;</button>
        </span>`
    ).join('');
    refreshIcons(container);
}

function removeChatMention(itemKey) {
    appState.chatMentionedItems = appState.chatMentionedItems.filter(m => m.item_key !== itemKey);
    renderChatMentionChips();
}

/* ── Note inline @ mention ────────────────────────────────────────────────────── */

let _mentionCheckId = 0; // incremented on each new check or explicit dismiss to cancel stale async results

async function checkNoteMentionAutocomplete(ta) {
    const myId = ++_mentionCheckId;
    const caret = ta.selectionStart;
    const before = ta.value.slice(0, caret);
    const match = before.match(/@(\w*)$/);
    if (!match) { hideNoteMentionAutocomplete(); return; }

    const q = match[1].toLowerCase();
    let items = appState.libraryItems;
    if (!items.length) {
        try {
            const res = await fetch(`/api/library/items?q=${encodeURIComponent(q)}&limit=10&sort_by=title&sort_order=asc`);
            if (myId !== _mentionCheckId) return; // superseded by newer input or dismiss
            if (res.ok) { const data = await res.json(); items = data.items || []; }
        } catch {}
    }
    if (myId !== _mentionCheckId) return; // superseded

    const filtered = q
        ? items.filter(i =>
            (i.title || '').toLowerCase().includes(q) ||
            formatCreators(i.creators_list || i.creators).toLowerCase().includes(q) ||
            String(i.year || '').includes(q)
          ).slice(0, 8)
        : items.slice(0, 8);

    // Prefer the box inside THIS textarea's editor; fall back to any in the document.
    // This avoids picking up stale boxes that were moved out of a previous render.
    const box = ta.closest('.ann-inline-editor-wrap')?.querySelector('#note-mention-autocomplete')
              || document.getElementById('note-mention-autocomplete');
    if (!box) return;
    if (!filtered.length) { hideNoteMentionAutocomplete(); return; }

    box.innerHTML = filtered.map((item, i) => {
        const label = mentionLabel(item);
        const authors = formatCreators(item.creators_list || item.creators).split(';')[0].trim();
        return `<div class="chat-mention-item" data-index="${i}">
            <span class="chat-mention-label">@${escapeHtml(label)}</span>
            <span class="chat-mention-title">${escapeHtml((item.title || 'Untitled').slice(0, 50))}${(item.title || '').length > 50 ? '…' : ''}</span>
            <span class="chat-mention-meta">${escapeHtml(authors)}${item.year ? ' · ' + item.year : ''}</span>
        </div>`;
    }).join('');

    box._items = filtered;
    box._ta = ta;
    box._match = match;

    // Fixed positioning to escape overflow:hidden parents (fullscreen sidebar)
    const rect = ta.getBoundingClientRect();
    box.style.position = 'fixed';
    box.style.left = rect.left + 'px';
    box.style.width = rect.width + 'px';
    box.style.top = (rect.bottom + 4) + 'px';
    box.style.right = 'auto';
    box.style.zIndex = '9999';
    const fsMentionTarget = getFullscreenElement() || document.body;
    if (box.parentElement !== fsMentionTarget) fsMentionTarget.appendChild(box);

    box.classList.remove('hidden');

    box.querySelectorAll('.chat-mention-item').forEach((el, i) => {
        el.addEventListener('click', () => insertNoteMention(ta, match, filtered[i]));
    });
}

function hideNoteMentionAutocomplete() {
    _mentionCheckId++; // cancel any in-flight async check
    // Hide ALL instances — there can be more than one after the box gets moved out of its editor.
    document.querySelectorAll('#note-mention-autocomplete').forEach(box => {
        box.classList.add('hidden');
        box.innerHTML = '';
    });
}

function moveNoteMentionSelection(dir) {
    const box = document.getElementById('note-mention-autocomplete');
    if (!box) return;
    const items = [...box.querySelectorAll('.chat-mention-item')];
    if (!items.length) return;
    const current = items.findIndex(i => i.classList.contains('focused'));
    items.forEach(i => i.classList.remove('focused'));
    const next = Math.max(0, Math.min(items.length - 1, current + dir));
    items[next]?.classList.add('focused');
}

function insertNoteMention(ta, match, item) {
    const caret = ta.selectionStart;
    const before = ta.value.slice(0, caret);
    const after  = ta.value.slice(caret);
    const prefix = before.slice(0, before.length - match[0].length);
    const label  = mentionLabel(item);
    ta.value = prefix + `@${label}` + after;
    ta.selectionStart = ta.selectionEnd = prefix.length + label.length + 1;
    ta.focus();
    hideNoteMentionAutocomplete();
}

/* ── Tag Manager ─────────────────────────────────────────────────────────────── */

function openTagManager() {
    document.getElementById('tag-manager-modal')?.classList.remove('hidden');
    renderTagManagerList();
}

async function addTagFromManager() {
    const nameEl = document.getElementById('new-tag-name');
    const colorEl = document.getElementById('new-tag-color');
    const name = (nameEl?.value || '').trim();
    if (!name) { nameEl?.focus(); return; }

    try {
        const color = colorEl?.value || '#3b82f6';
        await apiCreateTag(name, color, null);   // null = top-level theme
        if (nameEl) nameEl.value = '';
        await loadAllTags({ force: true });
        renderTagManagerList();
    } catch (err) {
        console.error('Add tag error:', err);
    }
}

function renderTagManagerList() {
    const list = document.getElementById('tag-manager-list');
    if (!list) return;

    // Keep the root drop zone element
    const rootZone = document.getElementById('theme-root-drop-zone');

    if (appState.allTags.length === 0) {
        list.innerHTML = '<div class="tag-manager-empty">No themes yet. Add your first theme above.</div>';
        return;
    }

    // Clear except root drop zone
    [...list.children].forEach(c => { if (c.id !== 'theme-root-drop-zone') c.remove(); });

    const tree = buildTagTree(appState.allTags);
    tree.forEach(node => list.insertBefore(buildManagerThemeNode(node, 0), rootZone || null));

    if (rootZone) rootZone.style.display = 'none';
    refreshIcons(list);
    initRootDropZone();
}

function buildManagerThemeNode(node, depth) {
    const wrap = document.createElement('div');
    wrap.className = 'theme-tree-node';
    wrap.dataset.tagId = node.tag_id;

    const hasChildren = node.children && node.children.length > 0;
    const openKey = `mgr_themeOpen_${node.tag_id}`;
    const isOpen = sessionStorage.getItem(openKey) !== 'false';

    const row = document.createElement('div');
    row.className = 'theme-tree-row';
    row.id = `tag-mgr-item-${node.tag_id}`;
    row.draggable = true;
    row.dataset.tagId = node.tag_id;

    row.innerHTML = `
        ${hasChildren
            ? `<button class="theme-tree-toggle${isOpen ? ' open' : ''}" onclick="toggleManagerThemeNode(${node.tag_id})" title="Expand/collapse">${icon('chevron-right')}</button>`
            : `<span class="theme-tree-spacer"></span>`}
        <span class="theme-tree-drag-handle" title="Drag to reorganize">${icon('grip-vertical')}</span>
        <input type="color" class="tag-color-input theme-tree-dot" value="${node.color || '#3b82f6'}"
               onchange="updateTagColorFromManager(${node.tag_id}, this.value)" title="Change color">
        <span class="theme-tree-name">${escapeHtml(node.name)}</span>
        <span class="theme-tree-count">${node.annotation_count || 0}</span>
        <div class="theme-tree-actions">
            <button class="theme-tree-btn" onclick="openAddSubTheme(${node.tag_id})" title="Add sub-theme">${icon('git-branch')}</button>
            <button class="theme-tree-btn" onclick="startTagManagerEdit(${node.tag_id})" title="Rename">${icon('pencil')}</button>
            <button class="theme-tree-btn danger" onclick="deleteTagFromManager(${node.tag_id})" title="Delete">${icon('trash-2')}</button>
        </div>`;

    // DnD events
    row.addEventListener('dragstart', onThemeDragStart);
    row.addEventListener('dragend', onThemeDragEnd);
    row.addEventListener('dragover', onThemeDragOver);
    row.addEventListener('dragleave', onThemeDragLeave);
    row.addEventListener('drop', onThemeDrop);

    wrap.appendChild(row);

    if (hasChildren) {
        const childWrap = document.createElement('div');
        childWrap.className = 'theme-tree-children';
        childWrap.id = `mgr-children-${node.tag_id}`;
        if (!isOpen) childWrap.style.display = 'none';
        node.children.forEach(child => childWrap.appendChild(buildManagerThemeNode(child, depth + 1)));
        wrap.appendChild(childWrap);
    }

    return wrap;
}

function toggleManagerThemeNode(tagId) {
    const key = `mgr_themeOpen_${tagId}`;
    const childWrap = document.getElementById(`mgr-children-${tagId}`);
    const toggle = document.querySelector(`#tag-mgr-item-${tagId} .theme-tree-toggle`);
    if (!childWrap) return;
    const isNowOpen = childWrap.style.display === 'none';
    childWrap.style.display = isNowOpen ? '' : 'none';
    toggle?.classList.toggle('open', isNowOpen);
    sessionStorage.setItem(key, isNowOpen ? 'true' : 'false');
}

/* ── Drag-and-drop theme reorganization ─────────────────────────────────────── */

let _themeDraggedId = null;
let _themeDragOverTimeout = null;

function onThemeDragStart(e) {
    _themeDraggedId = parseInt(e.currentTarget.dataset.tagId);
    e.currentTarget.closest('[data-tag-id]')?.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(_themeDraggedId));

    // Show all root drop zones
    document.querySelectorAll('.theme-root-drop-zone, .sidebar-root-drop-zone').forEach(z => z.style.display = '');
}

function onThemeDragEnd(e) {
    _themeDraggedId = null;
    clearTimeout(_themeDragOverTimeout);
    document.querySelectorAll('.theme-tree-row, .notes-theme-row').forEach(r => {
        r.classList.remove('drop-target-inside', 'drop-target-before', 'drop-target-after');
    });
    document.querySelectorAll('[data-tag-id].dragging').forEach(n => n.classList.remove('dragging'));
    document.querySelectorAll('.theme-root-drop-zone, .sidebar-root-drop-zone').forEach(z => z.style.display = 'none');
}

function onThemeDragOver(e) {
    e.preventDefault();
    const row = e.currentTarget;
    const targetId = parseInt(row.dataset.tagId);
    if (!_themeDraggedId || targetId === _themeDraggedId) return;
    if (!canDropOn(_themeDraggedId, targetId)) return;

    e.dataTransfer.dropEffect = 'move';
    document.querySelectorAll('.theme-tree-row, .notes-theme-row').forEach(r => {
        r.classList.remove('drop-target-inside', 'drop-target-before', 'drop-target-after');
    });

    const rect = row.getBoundingClientRect();
    const relY = (e.clientY - rect.top) / rect.height;

    if (relY < 0.28) {
        row.classList.add('drop-target-before');
    } else if (relY > 0.72) {
        row.classList.add('drop-target-after');
    } else {
        row.classList.add('drop-target-inside');
        // Auto-expand collapsed nodes after hovering 600ms
        clearTimeout(_themeDragOverTimeout);
        _themeDragOverTimeout = setTimeout(() => {
            const childWrap = document.getElementById(`mgr-children-${targetId}`);
            if (childWrap && childWrap.style.display === 'none') {
                toggleManagerThemeNode(targetId);
            }
        }, 600);
    }
}

function onThemeDragLeave(e) {
    e.currentTarget.classList.remove('drop-target-inside', 'drop-target-before', 'drop-target-after');
    clearTimeout(_themeDragOverTimeout);
}

async function onThemeDrop(e) {
    e.preventDefault();
    const row = e.currentTarget;
    const targetId = parseInt(row.dataset.tagId);
    if (!_themeDraggedId || targetId === _themeDraggedId) return;
    if (!canDropOn(_themeDraggedId, targetId)) return;

    const rect = row.getBoundingClientRect();
    const relY = (e.clientY - rect.top) / rect.height;

    const tag = appState.allTags.find(t => t.tag_id === _themeDraggedId);
    const targetTag = appState.allTags.find(t => t.tag_id === targetId);

    let newParentId;
    if (relY < 0.28 || relY > 0.72) {
        // Drop before/after → same level as target (target's parent)
        newParentId = targetTag?.parent_id || null;
    } else {
        // Drop inside → make child of target
        newParentId = targetId;
    }

    row.classList.remove('drop-target-inside', 'drop-target-before', 'drop-target-after');
    await moveTheme(_themeDraggedId, newParentId, tag);
}

function initRootDropZone() {
    const zone = document.getElementById('theme-root-drop-zone');
    if (!zone || zone._zoneInited) return;
    zone._zoneInited = true;

    zone.addEventListener('dragover', e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        zone.classList.add('drag-over');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', async e => {
        e.preventDefault();
        zone.classList.remove('drag-over');
        if (!_themeDraggedId) return;
        const tag = appState.allTags.find(t => t.tag_id === _themeDraggedId);
        await moveTheme(_themeDraggedId, null, tag);
    });
}

function canDropOn(draggedId, targetId) {
    if (draggedId === targetId) return false;
    // Cannot drop onto a descendant of the dragged node (would create cycle)
    const descendants = getDescendantTagIds(draggedId, appState.allTags);
    return !descendants.includes(targetId);
}

async function moveTheme(tagId, newParentId, tag) {
    if (!tag) return;
    if (tag.parent_id === newParentId) return; // no change
    try {
        await apiUpdateTag(tagId, tag.name, tag.color, newParentId);
        await loadAllTags({ force: true });
        renderTagManagerList();
    } catch (err) {
        console.error('Move theme error:', err);
    }
}

/* ── Import / Export ─────────────────────────────────────────────────────────── */

function exportThemes() {
    const tree = buildTagTree(appState.allTags);

    function nodeToExport(node) {
        const out = { name: node.name, color: node.color || '#3b82f6' };
        if (node.children?.length) out.children = node.children.map(nodeToExport);
        return out;
    }

    const json = JSON.stringify(tree.map(nodeToExport), null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'themes.json';
    a.click();
    URL.revokeObjectURL(url);
}

async function importThemes(input) {
    const file = input.files?.[0];
    if (!file) return;
    input.value = '';

    try {
        const text = await file.text();
        const ext = file.name.split('.').pop().toLowerCase();

        if (ext === 'json') {
            await importThemesFromJson(text);
        } else if (ext === 'csv') {
            await importThemesFromCsv(text);
        } else {
            alert('Unsupported file type. Use .json or .csv');
        }
    } catch (err) {
        console.error('Import error:', err);
        alert('Import failed: ' + err.message);
    }
}

async function importThemesFromJson(text) {
    const data = JSON.parse(text);
    const nodes = Array.isArray(data) ? data : (data.themes || []);

    async function createNode(node, parentId) {
        const tagId = await apiCreateTag(node.name || 'Untitled', node.color || '#3b82f6', parentId);
        if (node.children?.length) {
            for (const child of node.children) {
                await createNode(child, tagId.tag_id);
            }
        }
    }

    for (const node of nodes) await createNode(node, null);

    await loadAllTags({ force: true });
    renderTagManagerList();
    showSaveConfirmation(`Imported ${nodes.length} top-level theme(s)`);
}

async function importThemesFromCsv(text) {
    // Expected columns: name, parent, color  (header row required)
    const lines = text.trim().split('\n').filter(Boolean);
    if (lines.length < 2) { alert('CSV must have a header row and at least one data row.'); return; }

    const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/"/g, ''));
    const nameIdx = headers.indexOf('name');
    const parentIdx = headers.indexOf('parent');
    const colorIdx = headers.indexOf('color');

    if (nameIdx < 0) { alert('CSV must have a "name" column.'); return; }

    const rows = lines.slice(1).map(line => {
        const cols = line.split(',').map(c => c.trim().replace(/^"|"$/g, ''));
        return {
            name: cols[nameIdx] || '',
            parent: parentIdx >= 0 ? (cols[parentIdx] || '') : '',
            color: colorIdx >= 0 ? (cols[colorIdx] || '#3b82f6') : '#3b82f6',
        };
    }).filter(r => r.name);

    // Two-pass: create top-level first, then children
    const nameToId = {};

    // First pass: top-level (no parent)
    for (const row of rows.filter(r => !r.parent)) {
        const res = await apiCreateTag(row.name, row.color, null);
        nameToId[row.name.toLowerCase()] = res.tag_id;
    }
    // Second pass: with parent (up to 5 levels deep)
    for (let pass = 0; pass < 5; pass++) {
        for (const row of rows.filter(r => r.parent && !nameToId[r.name.toLowerCase()])) {
            const parentId = nameToId[row.parent.toLowerCase()];
            if (!parentId) continue;
            const res = await apiCreateTag(row.name, row.color, parentId);
            nameToId[row.name.toLowerCase()] = res.tag_id;
        }
    }

    await loadAllTags({ force: true });
    renderTagManagerList();
    showSaveConfirmation(`Imported ${rows.length} theme(s) from CSV`);
}

function openAddSubTheme(parentTagId) {
    const parent = appState.allTags.find(t => t.tag_id === parentTagId);
    if (!parent) return;
    const label = document.getElementById('sub-theme-parent-label');
    if (label) label.innerHTML = `Sub-theme of <strong>#${escapeHtml(parent.name)}</strong>`;
    const nameEl = document.getElementById('sub-theme-name');
    const colorEl = document.getElementById('sub-theme-color');
    if (nameEl) nameEl.value = '';
    if (colorEl) colorEl.value = parent.color || '#3b82f6';
    document.getElementById('sub-theme-modal')._parentTagId = parentTagId;
    document.getElementById('sub-theme-modal')?.classList.remove('hidden');
    setTimeout(() => nameEl?.focus(), 50);
}

async function commitAddSubTheme() {
    const modal = document.getElementById('sub-theme-modal');
    const parentTagId = modal?._parentTagId;
    const name = document.getElementById('sub-theme-name')?.value.trim();
    const color = document.getElementById('sub-theme-color')?.value || '#3b82f6';
    if (!name) return;
    try {
        await apiCreateTag(name, color, parentTagId);
        closeModal('sub-theme-modal');
        await loadAllTags({ force: true });
        renderTagManagerList();
    } catch (err) {
        console.error('Add sub-theme error:', err);
    }
}

function startTagManagerEdit(tagId) {
    const tag = appState.allTags.find(t => t.tag_id === tagId);
    if (!tag) return;
    const row = document.getElementById(`tag-mgr-item-${tagId}`);
    if (!row) return;

    const nameSpan = row.querySelector('.theme-tree-name');
    if (!nameSpan) return;
    const original = escapeHtml(tag.name);
    nameSpan.outerHTML = `<input type="text" class="compact-input theme-tree-name" value="${original}"
        style="flex:1;font-size:13px;height:26px;padding:2px 8px"
        onblur="commitTagManagerEdit(${tagId}, this.value)"
        onkeydown="if(event.key==='Enter') this.blur(); if(event.key==='Escape') { this.value='${original}'; this.blur(); }">`;
    row.querySelector('input[type="text"]')?.focus();
}

async function commitTagManagerEdit(tagId, newName) {
    const tag = appState.allTags.find(t => t.tag_id === tagId);
    if (!tag || !newName.trim() || newName.trim() === tag.name) { renderTagManagerList(); return; }

    try {
        await apiUpdateTag(tagId, newName.trim(), tag.color, tag.parent_id || null);
        await loadAllTags({ force: true });
        renderTagManagerList();
    } catch (err) {
        console.error('Rename tag error:', err);
        renderTagManagerList();
    }
}

async function updateTagColorFromManager(tagId, newColor) {
    const tag = appState.allTags.find(t => t.tag_id === tagId);
    if (!tag) return;
    try {
        await apiUpdateTag(tagId, tag.name, newColor, tag.parent_id || null);
        tag.color = newColor;
        await loadAllTags({ force: true });
    } catch (err) {
        console.error('Update tag color error:', err);
    }
}

async function deleteTagFromManager(tagId) {
    const tag = appState.allTags.find(t => t.tag_id === tagId);
    if (!tag) return;
    if (!confirm(`Delete tag "#${tag.name}"?\n\nThis will remove it from all annotations.`)) return;

    try {
        await apiDeleteTag(tagId);
        await loadAllTags({ force: true });
        renderTagManagerList();
        if (appState.previewItem) await loadAnnotations(appState.previewItem.item_key);
    } catch (err) {
        console.error('Delete tag error:', err);
    }
}

/* ── Annotations export ──────────────────────────────────────────────────────── */

function toggleAnnotationsExportMenu() {
    const menu = document.getElementById('annotations-export-menu');
    if (!menu) return;
    const isHidden = menu.classList.contains('hidden');
    menu.classList.toggle('hidden', !isHidden);
    if (isHidden) {
        refreshIcons(menu);
        const close = e => {
            if (!menu.closest('.annotations-export-wrap').contains(e.target)) {
                menu.classList.add('hidden');
                document.removeEventListener('click', close);
            }
        };
        setTimeout(() => document.addEventListener('click', close), 0);
    }
}

async function _ensureAnnotationsLoaded() {
    if (appState.annotationsViewItems.length === 0) {
        const res = await fetch('/api/annotations');
        if (res.ok) {
            const data = await res.json();
            appState.annotationsViewItems = data.annotations || [];
        }
    }
}

function _exportedAnnotations() {
    return _filteredAnnotations();
}

async function exportAnnotationsCSV() {
    document.getElementById('annotations-export-menu')?.classList.add('hidden');
    await _ensureAnnotationsLoaded();
    const items = _exportedAnnotations();
    if (!items.length) { alert('No annotations to export with the current filters.'); return; }

    const header = ['quote', 'note', 'type', 'themes', 'source', 'year', 'page'];
    const rows = items.map(a => [
        a.quote || '',
        a.comment || '',
        a.annotation_type || '',
        (a.tags || []).map(t => t.name).join('; '),
        a.item_title || a.item_key || '',
        a.item_year || '',
        String((a.page_index || 0) + 1),
    ]);

    const csvContent = [header, ...rows].map(row =>
        row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')
    ).join('\r\n');

    const blob = new Blob(['﻿' + csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `annotations_${_exportDateStamp()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
}

async function exportAnnotationsJSON() {
    document.getElementById('annotations-export-menu')?.classList.add('hidden');
    await _ensureAnnotationsLoaded();
    const items = _exportedAnnotations();
    if (!items.length) { alert('No annotations to export with the current filters.'); return; }

    const tree = buildTagTree(appState.allTags);
    function nodeToExport(node) {
        const out = { name: node.name, color: node.color || '#3b82f6', annotation_count: node.annotation_count || 0, source_count: node.source_count || 0 };
        if (node.children?.length) out.children = node.children.map(nodeToExport);
        return out;
    }

    const payload = {
        exported_at: new Date().toISOString(),
        annotation_count: items.length,
        themes: tree.map(nodeToExport),
        annotations: items.map(a => ({
            annotation_id: a.annotation_id,
            type: a.annotation_type,
            quote: a.quote || null,
            comment: a.comment || null,
            page: (a.page_index || 0) + 1,
            color: a.color || null,
            source: a.item_title || a.item_key,
            year: a.item_year || null,
            item_key: a.item_key,
            themes: (a.tags || []).map(t => ({ name: t.name, color: t.color })),
        })),
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `annotations_${_exportDateStamp()}.json`;
    a.click();
    URL.revokeObjectURL(url);
}

async function exportAnnotationsDocx() {
    document.getElementById('annotations-export-menu')?.classList.add('hidden');
    await _ensureAnnotationsLoaded();
    const items = _exportedAnnotations();
    if (!items.length) { alert('No annotations to export with the current filters.'); return; }

    const tree = buildTagTree(appState.allTags);
    function nodeToExport(node) {
        const out = { name: node.name, color: node.color || '#3b82f6' };
        if (node.children?.length) out.children = node.children.map(nodeToExport);
        return out;
    }

    const payload = {
        themes: tree.map(nodeToExport),
        annotations: items.map(a => ({
            annotation_id: a.annotation_id,
            type: a.annotation_type,
            quote: a.quote || null,
            comment: a.comment || null,
            page: (a.page_index || 0) + 1,
            color: a.color || null,
            source: a.item_title || a.item_key || '',
            year: a.item_year || null,
            item_key: a.item_key,
            themes: (a.tags || []).map(t => ({ tag_id: t.tag_id, name: t.name, color: t.color })),
        })),
    };

    try {
        const res = await fetch('/api/export/annotations/docx', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error(`Server error ${res.status}`);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `annotations_${_exportDateStamp()}.docx`;
        a.click();
        URL.revokeObjectURL(url);
    } catch (err) {
        console.error('DOCX export error:', err);
        alert('Export failed: ' + err.message);
    }
}

function _exportDateStamp() {
    return new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '');
}

/* ── Annotations synthesis view ─────────────────────────────────────────────── */

async function openAnnotationsView() {
    // Ensure Notes sidebar tab is active
    document.querySelectorAll('.sidebar-tab').forEach(b => b.classList.remove('active'));
    document.querySelector('.sidebar-tab[data-tab="notes"]')?.classList.add('active');
    document.querySelectorAll('.sidebar-content').forEach(c => c.classList.remove('active'));
    document.getElementById('tab-notes')?.classList.add('active');
    appState.activeSidebarTab = 'notes';

    setCenterView('annotations');
    await loadAnnotationsViewData();
}

async function loadAnnotationsViewData() {
    try {
        const res = await fetch('/api/annotations');
        if (!res.ok) return;
        const data = await res.json();
        appState.annotationsViewItems = data.annotations || [];
        renderAnnotationsView();
    } catch (err) {
        console.error('Load annotations view error:', err);
    }
}

function filterAnnotationsView() {
    const searchEl = document.getElementById('notes-search-input');
    appState.annotationsViewFilter.search = (searchEl?.value || '').toLowerCase();
    const sortEl = document.getElementById('annotations-sort-select');
    if (sortEl) appState.annotationsViewGroupBy = sortEl.value;
    // If annotations haven't loaded yet, load them first
    if (appState.annotationsViewItems.length === 0) {
        loadAnnotationsViewData();
    } else if (appState.annotationsViewMode === 'analysis') {
        // Rebuilding the dashboard means recomputing 13 cards and re-running the
        // network layout; the search box calls this on every keystroke.
        _renderAnalysisDashboardDebounced();
    } else {
        renderAnnotationsView();
    }
}

const _renderAnalysisDashboardDebounced = debounce(renderAnalysisDashboard, 250);

function renderAnnotationsView() {
    const content = document.getElementById('annotations-view-content');
    const countEl = document.getElementById('annotations-view-count');
    if (!content) return;

    const { tagIds, type, search } = appState.annotationsViewFilter;

    let items = _filteredAnnotations();

    if (countEl) countEl.textContent = String(items.length);
    const drillBanner = _drillBanner(items.length);

    const synthBtn = document.getElementById('annotations-synthesize-btn');
    if (synthBtn) synthBtn.disabled = appState.annotationsViewSelected.size === 0;

    if (items.length === 0) {
        content.innerHTML = drillBanner + `<div class="annotations-view-empty">
            No annotations found.<br>
            <small>Highlight text in any PDF to create annotations, then add <strong>#tags</strong> and notes.</small>
        </div>`;
        return;
    }

    const groupBy = appState.annotationsViewGroupBy;
    let html = '';

    if (groupBy === 'doc') {
        const byDoc = {};
        items.forEach(a => {
            const key = a.item_key;
            if (!byDoc[key]) byDoc[key] = { title: a.item_title || a.item_key, year: a.item_year, items: [] };
            byDoc[key].items.push(a);
        });
        Object.values(byDoc).forEach(group => {
            html += `<div class="annotations-group-header">${icon('file-text')} ${escapeHtml(group.title)}${group.year ? ` <small>(${group.year})</small>` : ''}</div>`;
            html += group.items.map(a => renderAnnotationCard(a)).join('');
        });

    } else if (groupBy === 'tag') {
        const tagged = {};
        const untagged = [];
        items.forEach(a => {
            if (!a.tags || a.tags.length === 0) { untagged.push(a); return; }
            a.tags.forEach(t => {
                if (!tagged[t.tag_id]) tagged[t.tag_id] = { tag: t, items: [] };
                tagged[t.tag_id].items.push(a);
            });
        });
        Object.values(tagged).forEach(group => {
            html += `<div class="annotations-group-header">${icon('tag')} <span style="color:${group.tag.color || '#3b82f6'}">#${escapeHtml(group.tag.name)}</span></div>`;
            html += group.items.map(a => renderAnnotationCard(a)).join('');
        });
        if (untagged.length) {
            html += `<div class="annotations-group-header">${icon('circle-dashed')} Untagged</div>`;
            html += untagged.map(a => renderAnnotationCard(a)).join('');
        }

    } else {
        if (groupBy === 'page') items.sort((a, b) => (a.page_index || 0) - (b.page_index || 0));
        if (groupBy === 'date') items.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
        html = items.map(a => renderAnnotationCard(a)).join('');
    }

    content.innerHTML = drillBanner + html;
    refreshIcons(content);

    // Re-attach checkbox state
    content.querySelectorAll('.ann-card-select').forEach(cb => {
        const id = parseInt(cb.dataset.id);
        cb.checked = appState.annotationsViewSelected.has(id);
        cb.addEventListener('change', () => {
            if (cb.checked) appState.annotationsViewSelected.add(id);
            else appState.annotationsViewSelected.delete(id);
            const synthBtn = document.getElementById('annotations-synthesize-btn');
            if (synthBtn) synthBtn.disabled = appState.annotationsViewSelected.size === 0;
        });
    });
}

/* ── Analysis export ─────────────────────────────────────────────────────────── */

function toggleAnalysisExportMenu() {
    const menu = document.getElementById('analysis-export-menu');
    if (!menu) return;
    const willOpen = menu.classList.contains('hidden');
    menu.classList.toggle('hidden', !willOpen);
    if (willOpen) {
        refreshIcons(menu);
        const close = e => {
            if (!menu.closest('#analysis-export-wrap').contains(e.target)) {
                menu.classList.add('hidden');
                document.removeEventListener('click', close);
            }
        };
        setTimeout(() => document.addEventListener('click', close), 0);
    }
}

function _analysisFilterSummary() {
    const { tagIds, type, search } = appState.annotationsViewFilter;
    const parts = [];
    if (tagIds.length) {
        const names = tagIds.map(id => appState.allTags.find(t => t.tag_id === id)?.name).filter(Boolean);
        if (names.length) parts.push(`Themes: ${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''}`);
    }
    if (type) parts.push(`Type: ${type}`);
    if (search) parts.push(`Search: "${search}"`);
    return parts.join(' · ');
}

/* The report inlined the app's entire stylesheet — around 200 KB of rules for
   the library table, the PDF viewer, settings and everything else — into every
   exported file.  Keep the rules the report can actually use: anything defining
   custom properties or targeting the document root (which carries the whole
   theme), plus any rule mentioning a class that appears in the report body. */
function _cssForReport(css, reportRoot) {
    if (!css) return '';
    const present = new Set();
    reportRoot.querySelectorAll('*').forEach(el => {
        (el.classList || []).forEach(c => present.add(c));
        if (el.id) present.add(el.id);
    });
    ['rpt-header', 'rpt-badge', 'rpt-methods'].forEach(c => present.add(c));

    return _filterCssRules(css.replace(/\/\*[\s\S]*?\*\//g, ''), present)
        .replace(/\s*\n\s*/g, '\n')
        .replace(/;\s+/g, ';');
}

function _filterCssRules(css, present) {
    const out = [];
    let depth = 0, buffer = '', blockStart = 0;

    for (let i = 0; i < css.length; i++) {
        const ch = css[i];
        buffer += ch;
        if (ch === '{') {
            if (depth === 0) blockStart = buffer.length - 1;
            depth++;
        } else if (ch === '}') {
            depth--;
            if (depth === 0) {
                const selector = buffer.slice(0, blockStart).trim();
                const body = buffer.slice(blockStart + 1, -1);

                if (/^@(media|supports|layer)/i.test(selector)) {
                    // Recurse: a responsive block is only worth carrying for the
                    // rules inside it that the report actually uses.
                    const inner = _filterCssRules(body, present);
                    if (inner.trim()) out.push(`${selector}{${inner}}`);
                } else if (_reportNeedsRule(selector, present)) {
                    out.push(buffer.trim());
                }
                buffer = '';
            }
        }
    }
    return out.join('\n');
}

function _reportNeedsRule(selector, present) {
    if (/^@(font-face|keyframes|import|charset)/i.test(selector)) return true;
    /* A selector naming no class or id is a root/element rule — ":root", "body",
       "html:not([data-theme=...])" — and carries the theme, so it travels.  Once
       a selector names a component, that component decides: theme overrides like
       `html[data-theme] .pdf-page` are no use to a report with no PDF in it. */
    const tokens = selector.match(/[.#]([A-Za-z0-9_-]+)/g) || [];
    if (!tokens.length) return true;
    return tokens.some(t => present.has(t.slice(1)));
}

/* A figure from this dashboard can end up in a thesis, where "which annotations,
   filtered how, counted at what level, with which parameters" is exactly what a
   reader needs and what the report used to omit entirely. */
function _analysisMethodsRows(items) {
    const docs = new Set(items.map(a => a.item_key).filter(Boolean));
    const themes = new Set();
    items.forEach(a => (a.tags || []).forEach(t => themes.add(t.tag_id)));
    const dates = items.map(a => (a.created_at ? new Date(a.created_at) : null)).filter(d => d && !isNaN(d));
    const range = dates.length
        ? `${new Date(Math.min(...dates)).toLocaleDateString()} – ${new Date(Math.max(...dates)).toLocaleDateString()}`
        : 'not recorded';
    const version = (document.querySelector('.settings-version')?.textContent || '').trim() || 'unknown build';
    const manual = items.filter(a => a.sentiment).length;

    return [
        ['Source', appState.activeProject?.name ? `Project: ${appState.activeProject.name}` : 'Whole library'],
        ['Annotations included', `${items.length} across ${docs.size} document${docs.size !== 1 ? 's' : ''}`],
        ['Distinct themes present', String(themes.size)],
        ['Annotation dates', range],
        ['Filters applied', filterNoteOrNone()],
        ['Theme level', _analysisRollup === 'root'
            ? 'Rolled up — every theme counted under its top-level parent'
            : 'As coded — sub-themes counted separately from their parent'],
        ['Chart truncation', 'Cards show a ranked subset (top 15 themes, 12 pairs, 10×8 matrix, 60 network nodes); each states its own limit'],
        ['Text processing', 'Intl.Segmenter tokenisation; English + Indonesian stop words removed'],
        ['Sentiment', `Keyword lexicon (English + Indonesian) with negation handling over quote + note; ${manual} annotation${manual !== 1 ? 's' : ''} manually flagged. Annotations with no lexicon match are reported as "not scored", not neutral`],
        ['Saturation criterion', 'No new theme across a run of ≥10% of annotations (minimum 5); fewer than 15 annotations is not judged'],
        ['Inter-rater agreement', 'Cohen\'s κ and Krippendorff\'s α per code on shared annotations, each summarised prevalence-weighted; covers coding agreement only, not which passages were selected'],
        ['Generated by', `TarCite Workspace ${version}`],
    ];
}

function filterNoteOrNone() {
    return _analysisFilterSummary() || 'None — all annotations in scope';
}

async function _buildAnalysisHTML() {
    const container = document.getElementById('analysis-content');
    if (!container) return null;

    // Clone so we don't mutate the live DOM
    const clone = container.cloneNode(true);

    // Ensure the root element is fully visible (strip hidden class / inline display:none)
    clone.classList.remove('hidden');
    clone.style.removeProperty('display');
    clone.style.removeProperty('height');
    clone.style.removeProperty('overflow');

    // Snapshot the network canvas into a static <img>
    const liveCanvas = document.getElementById('network-canvas');
    const cloneCanvas = clone.querySelector('#network-canvas');
    if (liveCanvas && cloneCanvas && liveCanvas.width > 0) {
        try {
            const img = document.createElement('img');
            img.src = liveCanvas.toDataURL('image/png');
            img.className = liveCanvas.className;
            img.style.cssText = 'display:block;width:100%;border-radius:6px';
            cloneCanvas.replaceWith(img);
        } catch (e) { /* cross-origin safety */ }
    }

    // Disable interactive controls in the snapshot
    clone.querySelectorAll('input,textarea,button,select').forEach(el => {
        el.setAttribute('disabled', 'true');
        el.style.pointerEvents = 'none';
    });
    // Hide network controls row (buttons are gone, layout looks odd without canvas interaction)
    clone.querySelectorAll('.network-controls').forEach(el => el.style.display = 'none');

    // Fetch the live stylesheet to embed
    let css = '';
    try {
        const res = await fetch(document.querySelector('link[rel="stylesheet"]')?.href || '/static/style.css');
        css = _cssForReport(await res.text(), clone);
    } catch (e) {}

    const filterNote = _analysisFilterSummary();
    const date = new Date().toLocaleString();
    const scoped = _rollupItems(_filteredAnnotations());
    const itemCount = scoped.length;
    const methods = _analysisMethodsRows(scoped);

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Analysis Report</title>
<style>
/* ── embedded app styles (scoped overrides follow) ── */
${css}
/* ── REPORT LAYOUT OVERRIDES ─────────────────────────────────────────────── */
/* Undo the app's full-page locked layout */
html, body {
    height: auto !important;
    min-height: unset !important;
    overflow: visible !important;
    overflow-x: hidden !important;
}
body {
    margin: 0 !important;
    padding: 24px 32px !important;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
    background: #f1f5f9 !important;
    color: #0f172a !important;
}
/* Scope + method block: what the figures below were computed from */
.rpt-methods {
    background: #fff;
    border: 1px solid #e2e8f0;
    border-radius: 12px;
    padding: 14px 20px;
    margin-bottom: 20px;
    font-size: 12px;
    color: #0f172a;
}
.rpt-methods summary {
    cursor: pointer;
    font-weight: 700;
    font-size: 13px;
    color: #0f172a;
    margin-bottom: 8px;
}
.rpt-methods table { border-collapse: collapse; width: 100%; }
.rpt-methods th {
    text-align: left;
    vertical-align: top;
    padding: 4px 14px 4px 0;
    white-space: nowrap;
    color: #475569;
    font-weight: 600;
    width: 1%;
}
.rpt-methods td { padding: 4px 0; color: #0f172a; }
.rpt-methods tr + tr th, .rpt-methods tr + tr td { border-top: 1px solid #f1f5f9; }

/* Report header */
.rpt-header {
    background: #fff;
    border: 1px solid #e2e8f0;
    border-radius: 12px;
    padding: 20px 24px;
    margin-bottom: 20px;
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
}
.rpt-header h1 { margin: 0 0 4px; font-size: 18px; font-weight: 700; color: #0f172a; }
.rpt-header p  { margin: 0; font-size: 12px; color: #64748b; }
.rpt-badge {
    background: #eff6ff; color: #2563eb; border: 1px solid #bfdbfe;
    border-radius: 20px; padding: 3px 10px; font-size: 12px; font-weight: 600; white-space: nowrap;
}
/* Make the analysis container visible and scrollable */
.analysis-content {
    display: block !important;
    height: auto !important;
    overflow: visible !important;
}
.analysis-grid {
    display: grid !important;
    grid-template-columns: 1fr 1fr !important;
    gap: 16px !important;
    height: auto !important;
    overflow: visible !important;
}
.analysis-card, .analysis-card-wide {
    height: auto !important;
    overflow: visible !important;
    min-height: unset !important;
}
.analysis-card-wide { grid-column: 1 / -1 !important; }
/* SVG charts: allow natural sizing */
svg { max-width: 100%; height: auto; }
/* Hide interactive elements that are meaningless in a static report */
.network-controls, .irr-instructions textarea, .irr-instructions button,
#kwic-input, .network-ctrl-btn { display: none !important; }
/* Print */
@media print {
    body { padding: 8px !important; background: #fff !important; }
    .analysis-grid { grid-template-columns: 1fr 1fr !important; }
    .analysis-card { break-inside: avoid; page-break-inside: avoid; }
    .rpt-methods { break-inside: avoid; page-break-inside: avoid; }
    .rpt-methods[open] summary { list-style: none; }
    .rpt-header { break-after: avoid; }
}
@media (max-width: 700px) {
    body { padding: 12px !important; }
    .analysis-grid { grid-template-columns: 1fr !important; }
}
</style>
</head>
<body>
<div class="rpt-header">
  <div>
    <h1>Annotation Analysis Report</h1>
    <p>Generated ${date}${filterNote ? ' &nbsp;·&nbsp; ' + escapeHtml(filterNote) : ''}</p>
  </div>
  <span class="rpt-badge">${itemCount} annotation${itemCount !== 1 ? 's' : ''}</span>
</div>

<details class="rpt-methods" open>
  <summary>Scope and method</summary>
  <table>
    ${methods.map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`).join('\n    ')}
  </table>
</details>
${clone.outerHTML}
</body>
</html>`;
}

async function exportAnalysisHTML() {
    document.getElementById('analysis-export-menu')?.classList.add('hidden');
    const html = await _buildAnalysisHTML();
    if (!html) return;
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `analysis_report_${_exportDateStamp()}.html`;
    a.click();
    URL.revokeObjectURL(url);
}

async function exportAnalysisPrint() {
    document.getElementById('analysis-export-menu')?.classList.add('hidden');
    const html = await _buildAnalysisHTML();
    if (!html) return;
    const win = window.open('', '_blank', 'width=1000,height=800');
    if (!win) { alert('Allow pop-ups for this site to use Print / PDF.'); return; }
    win.document.write(html);
    win.document.close();
    win.addEventListener('load', () => { win.focus(); win.print(); });
}

function exportAnalysisData() {
    document.getElementById('analysis-export-menu')?.classList.add('hidden');
    const items = _rollupItems(_filteredAnnotations());
    if (!items.length) { alert('No annotations to export.'); return; }


    function csv(rows) {
        return rows.map(r => r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
    }

    const sections = [];

    // 1. Theme Frequency
    const themeFreq = {};
    items.forEach(a => (a.tags || []).forEach(t => {
        if (!themeFreq[t.tag_id]) themeFreq[t.tag_id] = { name: t.name, count: 0 };
        themeFreq[t.tag_id].count++;
    }));
    sections.push('=== Theme Frequency ===');
    sections.push(csv([['theme', 'count'],
        ...Object.values(themeFreq).sort((a, b) => b.count - a.count).map(r => [r.name, r.count])]));

    // 2. Annotation Types
    sections.push('\r\n=== Annotation Types ===');
    const typeCounts = {};
    items.forEach(a => { typeCounts[a.annotation_type] = (typeCounts[a.annotation_type] || 0) + 1; });
    sections.push(csv([['type', 'count'],
        ...Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).map(([t, c]) => [t, c])]));

    // 3. Co-occurrence
    const coMap = {};
    items.forEach(a => {
        const tags = a.tags || [];
        for (let i = 0; i < tags.length; i++) for (let j = i + 1; j < tags.length; j++) {
            const key = [tags[i].tag_id, tags[j].tag_id].sort().join('-');
            if (!coMap[key]) coMap[key] = { a: tags[i].name, b: tags[j].name, count: 0 };
            coMap[key].count++;
        }
    });
    sections.push('\r\n=== Theme Co-occurrence ===');
    sections.push(csv([['theme_a', 'theme_b', 'co_occurrences'],
        ...Object.values(coMap).sort((a, b) => b.count - a.count).map(r => [r.a, r.b, r.count])]));

    // 4. Word Frequency
    const wordFreq = {};
    // Same tokeniser and stop-word lists as the chart, so the CSV matches it.
    items.forEach(a => {
        _contentWords(_analysisText(a)).forEach(w => { wordFreq[w] = (wordFreq[w] || 0) + 1; });
    });
    sections.push('\r\n=== Word Frequency (top 50) ===');
    sections.push(csv([['word', 'count'],
        ...Object.entries(wordFreq).sort((a, b) => b[1] - a[1]).slice(0, 50).map(([w, c]) => [w, c])]));

    // 5. Document × Theme matrix
    const docMap = {};
    const themeSet = {};
    items.forEach(a => {
        const doc = a.item_title || a.item_key;
        if (!docMap[doc]) docMap[doc] = {};
        (a.tags || []).forEach(t => {
            docMap[doc][t.name] = (docMap[doc][t.name] || 0) + 1;
            themeSet[t.name] = true;
        });
    });
    const themeNames = Object.keys(themeSet);
    sections.push('\r\n=== Document × Theme Matrix ===');
    sections.push(csv([
        ['document', ...themeNames],
        ...Object.entries(docMap).map(([doc, tmap]) => [doc, ...themeNames.map(t => tmap[t] || 0)]),
    ]));

    // 6. Sentiment
    sections.push('\r\n=== Annotation Sentiment ===');
    // Same scorer as the card — including negation handling, and the distinction
    // between "neutral" and "nothing here could be scored".
    const sentRows = items.map(a => {
        const inferred = _scoreSentiment(_analysisText(a));
        const sent = a.sentiment || inferred || 'not_scored';
        return [
            a.item_title || a.item_key,
            (a.page_index || 0) + 1,
            (a.tags || []).map(t => t.name).join('; '),
            sent,
            a.sentiment ? 'manual' : inferred ? 'keyword' : 'no lexicon match',
        ];
    });
    sections.push(csv([['source', 'page', 'themes', 'sentiment', 'basis'], ...sentRows]));

    const blob = new Blob([sections.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `analysis_data_${_exportDateStamp()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
}

/* ── Analysis dashboard ──────────────────────────────────────────────────────── */

function switchAnnotationsMode(mode) {
    appState.annotationsViewMode = mode;
    document.getElementById('ann-mode-list')?.classList.toggle('active', mode === 'list');
    document.getElementById('ann-mode-analysis')?.classList.toggle('active', mode === 'analysis');
    // Optional chaining throughout: drill-down now calls this from the charts,
    // so a missing control must not take the whole view down with it.
    const show = (el, visible) => { if (el) el.style.display = visible ? '' : 'none'; };
    show(document.getElementById('annotations-sort-select'), mode === 'list');
    show(document.getElementById('annotations-synthesize-btn'), mode === 'list');
    show(document.querySelector('.annotations-export-wrap:not(#analysis-export-wrap)'), mode === 'list');
    show(document.getElementById('analysis-export-wrap'), mode === 'analysis');
    document.getElementById('annotations-view-content')?.classList.toggle('hidden', mode === 'analysis');
    document.getElementById('analysis-content')?.classList.toggle('hidden', mode === 'list');
    if (mode === 'analysis') renderAnalysisDashboard();
}

/* One predicate behind the annotation list, the sidebar list and the analysis
   dashboard.  They carried three near-copies, which is how the sidebar's
   "filter by file" came to apply to the sidebar only: both the main list and
   every chart ignored annotationsViewFilter.itemKey entirely.

   `tagIds` keeps its existing OR semantics for the theme filter.  `tagGroups`
   is an AND of ORs, which is what a drill-down needs — "an annotation under
   this theme's subtree AND under that one's" for a co-occurrence pair. */
function _matchesAnnotationFilter(a, filter = {}) {
    const { tagIds = [], tagGroups = [], type = '', search = '', itemKey = '' } = filter;
    if (type && a.annotation_type !== type) return false;
    if (itemKey && a.item_key !== itemKey) return false;

    const ids = (a.tags || []).map(t => t.tag_id);
    if (tagIds.length && !tagIds.some(id => ids.includes(id))) return false;
    if (tagGroups.length && !tagGroups.every(group => group.some(id => ids.includes(id)))) return false;

    if (search) {
        const hay = ((a.quote || '') + ' ' + (a.comment || '') + ' ' + (a.item_title || '')).toLowerCase();
        if (!hay.includes(search)) return false;
    }
    return true;
}

function _filteredAnnotations() {
    return appState.annotationsViewItems.filter(a => _matchesAnnotationFilter(a, appState.annotationsViewFilter));
}

/* ── Which text the analysis reads ───────────────────────────────────────────
   Quotes are the author's words; notes are yours.  Analysing them as one bag
   means a critical note ("weak evidence") is scored as the source's own tone,
   and your vocabulary shows up in the corpus's word frequencies.  Default stays
   both, so nothing changes unless asked. */

let _analysisTextScope = 'both';   // 'both' | 'quote' | 'comment'

const ANALYSIS_TEXT_SCOPE_LABELS = { both: 'quotes + notes', quote: 'quotes only', comment: 'notes only' };

function _analysisText(a) {
    if (_analysisTextScope === 'quote') return a.quote || '';
    if (_analysisTextScope === 'comment') return a.comment || '';
    return (a.quote || '') + ' ' + (a.comment || '');
}

/* ── Drill-down ──────────────────────────────────────────────────────────────
   "Show me the annotations behind this number" is the first thing anyone asks
   of a chart, and until now no chart answered it.  Every drill-down routes
   through here: it sets the shared filter, switches to the list, and leaves a
   banner explaining what is being shown and how to get back. */

function _themeSubtreeIds(tagId) {
    return [tagId, ...getDescendantTagIds(tagId, appState.allTags || [])];
}

function _themeName(tagId) {
    return (appState.allTags || []).find(t => t.tag_id === tagId)?.name || `#${tagId}`;
}

function drillIntoAnalysis(patch, label) {
    // Keep the theme/type/file filters the user already set; add the drill on top.
    appState.annotationsViewFilter = {
        ...appState.annotationsViewFilter,
        tagGroups: [],
        itemKey: '',
        ...patch,
    };
    appState.annotationsViewDrill = label;
    const searchInput = document.getElementById('notes-search-input');
    if (searchInput) searchInput.value = appState.annotationsViewFilter.search || '';
    switchAnnotationsMode('list');
    renderAnnotationsView();
    renderSidebarAnnotations();
    document.getElementById('annotations-view-content')?.scrollTo({ top: 0, behavior: 'smooth' });
}

function drillIntoTheme(tagId) {
    drillIntoAnalysis({ tagGroups: [_themeSubtreeIds(tagId)] }, `Theme: ${_themeName(tagId)}`);
}

function drillIntoThemePair(tagA, tagB) {
    drillIntoAnalysis(
        { tagGroups: [_themeSubtreeIds(tagA), _themeSubtreeIds(tagB)] },
        `${_themeName(tagA)} × ${_themeName(tagB)}`);
}

function drillIntoType(type) {
    drillIntoAnalysis({ type }, `Type: ${type}`);
}

function drillIntoThemeDocument(tagId, itemKey, docTitle) {
    drillIntoAnalysis(
        { tagGroups: [_themeSubtreeIds(tagId)], itemKey },
        `${_themeName(tagId)} in ${docTitle || itemKey}`);
}

function drillIntoWord(word, tagId) {
    drillIntoAnalysis(
        tagId ? { search: word.toLowerCase(), tagGroups: [_themeSubtreeIds(tagId)] } : { search: word.toLowerCase() },
        tagId ? `"${word}" in ${_themeName(tagId)}` : `Word: "${word}"`);
}

function clearAnalysisDrill() {
    appState.annotationsViewDrill = '';
    appState.annotationsViewFilter = { ...appState.annotationsViewFilter, tagGroups: [], itemKey: '', search: '' };
    const searchInput = document.getElementById('notes-search-input');
    if (searchInput) searchInput.value = '';
    renderAnnotationsView();
    renderSidebarAnnotations();
}

function _drillBanner(count) {
    if (!appState.annotationsViewDrill) return '';
    return `
        <div class="analysis-drill-banner">
            ${icon('filter')}
            <span>Showing <strong>${count}</strong> annotation${count !== 1 ? 's' : ''} · ${escapeHtml(appState.annotationsViewDrill)}</span>
            <button type="button" onclick="clearAnalysisDrill()">${icon('x')} Clear</button>
            <button type="button" onclick="switchAnnotationsMode('analysis')">${icon('bar-chart-3')} Back to analysis</button>
        </div>`;
}

function setAnalysisTextScope(scope) {
    _analysisTextScope = ['quote', 'comment'].includes(scope) ? scope : 'both';
    if (appState.activeCenterView === 'annotations') renderAnalysisDashboard();
    if (appState.activeProject) renderProjectDetail(appState.activeProject);
}

function renderAnalysisDashboard() {
    const container = document.getElementById('analysis-content');
    if (!container) return;
    // One roll-up decision, applied once, so no two cards can disagree about
    // what a theme is.
    const items = _rollupItems(_filteredAnnotations());
    // Export chips in these cards act on the library-wide set, not a project's.
    setAnalysisSource('library');
    container.innerHTML = `
        <div class="analysis-toolbar">
            <span class="analysis-toolbar-label">Themes</span>
            <div class="analysis-rollup-toggle" role="group" aria-label="Theme level">
                <button class="analysis-rollup-btn${_analysisRollup === 'leaf' ? ' active' : ''}" type="button"
                        onclick="setAnalysisRollup('leaf')" title="Count themes exactly as coded">As coded</button>
                <button class="analysis-rollup-btn${_analysisRollup === 'root' ? ' active' : ''}" type="button"
                        onclick="setAnalysisRollup('root')" title="Fold each theme into its top-level parent">Top level</button>
            </div>
            <small class="analysis-toolbar-hint">${_analysisRollup === 'root'
                ? 'every theme counted under its top-level parent'
                : 'sub-themes counted separately from their parent'}</small>
            <span class="analysis-toolbar-sep"></span>
            <span class="analysis-toolbar-label">Text</span>
            <div class="analysis-rollup-toggle" role="group" aria-label="Text analysed">
                ${Object.entries(ANALYSIS_TEXT_SCOPE_LABELS).map(([k, label]) => `
                <button class="analysis-rollup-btn${_analysisTextScope === k ? ' active' : ''}" type="button"
                        onclick="setAnalysisTextScope('${k}')" title="Analyse ${label}">${
                            k === 'both' ? 'Both' : k === 'quote' ? 'Quotes' : 'Notes'}</button>`).join('')}
            </div>
            <small class="analysis-toolbar-hint">word frequency, TF-IDF, sentiment and KWIC read ${ANALYSIS_TEXT_SCOPE_LABELS[_analysisTextScope]}</small>
        </div>
        <div class="analysis-grid">
            <div class="analysis-card" data-analysis-card="theme-frequency">${_chartThemeFrequency(items)}</div>
            <div class="analysis-card" data-analysis-card="annotation-type">${_chartAnnotationType(items)}</div>
            <div class="analysis-card analysis-card-wide" data-analysis-card="annotations-over-time">${_chartAnnotationsOverTime(items)}</div>
            <div class="analysis-card analysis-card-wide" data-analysis-card="word-frequency" id="wf-card">${_chartWordFrequency(items)}</div>
            <div class="analysis-card analysis-card-wide" data-analysis-card="co-occurrence">${_chartCoOccurrence(items)}</div>
            <div class="analysis-card analysis-card-wide" data-analysis-card="document-matrix">${_chartDocumentMatrix(items)}</div>
            <div class="analysis-card analysis-card-wide" data-analysis-card="coding-density">${_chartCodingDensity(items)}</div>
            <div class="analysis-card analysis-card-wide" data-analysis-card="network" id="analysis-network-card">${_chartThemeNetwork(items)}</div>
            <div class="analysis-card analysis-card-wide" data-analysis-card="kwic">${_chartKWIC()}</div>
            <div class="analysis-card analysis-card-wide" data-analysis-card="saturation">${_chartSaturation(items)}</div>
            <div class="analysis-card analysis-card-wide" data-analysis-card="sentiment">${_chartSentiment(items)}</div>
            <div class="analysis-card analysis-card-wide" data-analysis-card="tfidf">${_chartTFIDF(items)}</div>
            <div class="analysis-card analysis-card-wide" data-analysis-card="irr">${_chartIRR()}</div>
        </div>`;
    refreshIcons(container);
    _initNetworkGraph(items);
}

function _chartThemeFrequency(items, options = {}) {
    const counts = {};
    items.forEach(a => (a.tags || []).forEach(t => {
        if (!counts[t.tag_id]) counts[t.tag_id] = { tag_id: t.tag_id, name: t.name, color: t.color, count: 0 };
        counts[t.tag_id].count++;
    }));
    const all = Object.values(counts).sort((a, b) => b.count - a.count);
    const sorted = all.slice(0, 15);
    if (!sorted.length) return `<div class="analysis-card-header"><span>Theme Frequency</span></div><p class="analysis-empty">No themed annotations yet.</p>`;
    const max = sorted[0].count;
    const exportBtn = `<div class="analysis-export-actions">
        <button class="analysis-export-chip" type="button" onclick="exportProjectThemeFrequencyData()" title="Download as CSV">${icon('table-2')} Data</button>
        <button class="analysis-export-chip" type="button" onclick="exportProjectThemeFrequencySvg()" title="Download as SVG">${icon('file-code')} SVG</button>
        <button class="analysis-export-chip" type="button" onclick="exportProjectThemeFrequencyPng()" title="Download as PNG">${icon('image')} PNG</button>
    </div>`;
    return `
        <div class="analysis-card-header"><span>${icon('git-branch')} Theme Frequency</span>${_analysisRollupNote()}${_shownOf(sorted.length, all.length, 'themes')}${exportBtn}</div>
        <div class="analysis-bars">${sorted.map(t => `
            <div class="analysis-bar-row analysis-drill" role="button" tabindex="0"
                 title="Show the ${t.count} annotation${t.count !== 1 ? 's' : ''} under ${escapeHtml(t.name)}"
                 onclick="drillIntoTheme(${t.tag_id})">
                <span class="analysis-bar-label" title="${escapeHtml(t.name)}">${escapeHtml(t.name)}</span>
                <div class="analysis-bar-track">
                    <div class="analysis-bar-fill" style="width:${(t.count/max*100).toFixed(1)}%;background:${t.color || 'var(--accent)'}"></div>
                </div>
                <span class="analysis-bar-count">${t.count}</span>
            </div>`).join('')}
        </div>`;
}

function _chartAnnotationType(items) {
    const defs = [
        { key: 'highlight', label: 'Highlight', color: '#facc15' },
        { key: 'underline', label: 'Underline', color: '#60a5fa' },
        { key: 'comment',   label: 'Comment',   color: '#34d399' },
        { key: 'area',      label: 'Area',       color: '#f472b6' },
    ];
    const counts = {}; defs.forEach(d => counts[d.key] = 0);
    items.forEach(a => { if (counts[a.annotation_type] !== undefined) counts[a.annotation_type]++; });
    const total = Object.values(counts).reduce((s, c) => s + c, 0);
    if (!total) return `<div class="analysis-card-header"><span>Annotation Types</span></div><p class="analysis-empty">No annotations yet.</p>`;

    const cx = 56, cy = 56, r = 40, sw = 16, circ = 2 * Math.PI * r;
    let off = 0;
    const segs = defs.map(d => {
        const pct = counts[d.key] / total;
        const seg = { ...d, count: counts[d.key], dash: pct * circ, offset: off };
        off += seg.dash; return seg;
    }).filter(s => s.count > 0);

    return `
        <div class="analysis-card-header"><span>${icon('pie-chart')} Annotation Types</span></div>
        <div class="analysis-donut-wrap">
            <svg viewBox="0 0 112 112" width="112" height="112" style="flex-shrink:0">
                <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--bg-tertiary)" stroke-width="${sw}"/>
                ${segs.map(s => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none"
                    stroke="${s.color}" stroke-width="${sw}"
                    stroke-dasharray="${s.dash.toFixed(2)} ${(circ - s.dash).toFixed(2)}"
                    stroke-dashoffset="${(-s.offset).toFixed(2)}"
                    transform="rotate(-90 ${cx} ${cy})"/>`).join('')}
                <text x="${cx}" y="${cy+5}" text-anchor="middle" class="analysis-donut-label">${total}</text>
            </svg>
            <div class="analysis-legend">${segs.map(s => `
                <div class="analysis-legend-item analysis-drill" role="button" tabindex="0"
                     title="Show the ${s.count} ${s.label.toLowerCase()} annotation${s.count !== 1 ? 's' : ''}"
                     onclick="drillIntoType('${s.key}')">
                    <span class="analysis-legend-dot" style="background:${s.color}"></span>
                    <span>${s.label}</span>
                    <span class="analysis-legend-count">${s.count} · ${(s.count/total*100).toFixed(0)}%</span>
                </div>`).join('')}
            </div>
        </div>`;
}

/* ── Shared analysis helpers ─────────────────────────────────────────────────
   Text handling and codebook handling used by every card, kept in one place so
   the dashboard cannot disagree with itself about what a "theme" or a "word"
   is.                                                                        */

const _STOPWORDS_EN = new Set(['the','a','an','and','or','but','in','on','at','to','for','of','with','by','from','as','is','was','are','were','be','been','have','has','had','do','does','did','will','would','could','should','may','might','this','that','these','those','it','its','they','their','there','then','than','when','where','which','who','what','how','not','also','can','all','one','two','we','you','he','she','our','his','her','my','some','no','if','so','more','into','through','during','before','after','up','out','over','just','about','very','such','each','both','other','here','between','however','therefore','thus','while','among','upon']);

// Indonesian function words. Without these the word-frequency and TF-IDF cards
// on an Indonesian corpus rank "yang", "dan" and "dengan" as its main themes.
const _STOPWORDS_ID = new Set(['yang','dan','untuk','dengan','pada','adalah','ini','itu','atau','tidak','akan','telah','oleh','dalam','juga','sebagai','karena','dapat','lebih','sudah','bisa','saya','kami','kita','mereka','ada','agar','antara','apa','atas','bagi','bahwa','banyak','baru','beberapa','begitu','belum','benar','berada','berbagai','berikut','bila','bukan','dahulu','demikian','hanya','harus','hingga','ialah','ingin','jadi','jika','kalau','kemudian','ketika','lain','lalu','maka','masih','maupun','melalui','memang','mungkin','namun','pula','saat','saja','sama','sangat','sebuah','sedang','sehingga','sejak','selain','selama','semua','seperti','serta','setelah','sini','situ','suatu','supaya','tanpa','tapi','tentang','terhadap','tersebut','tetapi','tiap','walau','yaitu','yakni']);

const _STOPWORDS = new Set([..._STOPWORDS_EN, ..._STOPWORDS_ID]);

// Scripts that do not separate words with spaces need shorter minimum tokens —
// a two-character Han compound is a word, "th" is not.
const _CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
let _wordSegmenter = null;

/* Tokeniser for every text card.  The previous `[a-z]{3,}` matched ASCII only:
   it returned nothing at all for Arabic, Chinese or Cyrillic sources, and cut
   accented Latin into fragments ("café" → "caf").  Intl.Segmenter handles both,
   including scripts without spaces; the regex is a fallback for engines
   without it. */
function _tokenize(text) {
    if (!text) return [];
    const lower = String(text).toLowerCase();
    if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
        if (!_wordSegmenter) _wordSegmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
        const out = [];
        for (const seg of _wordSegmenter.segment(lower)) {
            if (!seg.isWordLike) continue;
            const w = seg.segment;
            if (w.length >= (_CJK_RE.test(w) ? 2 : 3)) out.push(w);
        }
        return out;
    }
    return lower.match(/\p{L}{3,}/gu) || [];
}

function _contentWords(text) {
    return _tokenize(text).filter(w => !_STOPWORDS.has(w));
}

/* ── Codebook roll-up ────────────────────────────────────────────────────────
   Themes are a tree, and coding normally happens at the leaves.  Counting the
   leaves alone hides the branch: a parent holding 30 annotations across three
   children rendered no bar at all, because no annotation carried the parent's
   own id.  'root' folds every theme into its top-level ancestor before any card
   sees it, which also collapses parent+child coded on one annotation into a
   single theme rather than reporting them as co-occurring.                   */

let _analysisRollup = 'leaf';   // 'leaf' = as coded · 'root' = top-level themes

function _rootTagIndex() {
    const byId = new Map();
    (appState.allTags || []).forEach(t => byId.set(t.tag_id, t));
    const rootOf = new Map();
    byId.forEach(tag => {
        const chain = [];
        let node = tag;
        let guard = 0;
        while (node && !rootOf.has(node.tag_id) && guard++ < 64) {
            chain.push(node.tag_id);
            const parent = node.parent_id != null ? byId.get(node.parent_id) : null;
            if (!parent) break;
            node = parent;
        }
        const root = rootOf.get(node?.tag_id) || node || tag;
        chain.forEach(id => rootOf.set(id, root));
    });
    return rootOf;
}

function _rollupItems(items) {
    if (_analysisRollup !== 'root') return items;
    const rootOf = _rootTagIndex();
    if (!rootOf.size) return items;   // codebook not loaded — leave data untouched
    return items.map(a => {
        const merged = new Map();
        (a.tags || []).forEach(t => {
            const root = rootOf.get(t.tag_id);
            const eff = root || t;    // unknown theme: keep exactly as coded
            if (!merged.has(eff.tag_id)) {
                merged.set(eff.tag_id, { tag_id: eff.tag_id, name: eff.name, color: eff.color || t.color });
            }
        });
        return { ...a, tags: [...merged.values()] };
    });
}

// Rolls a raw tag id up to the id the dashboard is currently counting it under.
function _rollupTagId(tagId, rootOf) {
    if (_analysisRollup !== 'root' || !rootOf?.size) return tagId;
    return rootOf.get(tagId)?.tag_id ?? tagId;
}

function setAnalysisRollup(mode) {
    _analysisRollup = mode === 'root' ? 'root' : 'leaf';
    appState._irrData = null;   // κ was computed at the other level
    if (appState.activeCenterView === 'annotations') renderAnalysisDashboard();
    if (appState.activeProject) renderProjectDetail(appState.activeProject);
}

/* "showing 15 of 60" — every card that truncates now says so. */
function _shownOf(shown, total, noun) {
    return shown < total ? `<small class="analysis-trunc">showing top ${shown} of ${total} ${noun}</small>` : '';
}

/* Force-directed layout is O(n²) per iteration × 220 iterations, synchronous.
   Past ~60 nodes the picture is unreadable long before it is slow, so cap it. */
const NETWORK_NODE_LIMIT = 60;

// Marks cards whose counts are aggregated to parent themes, so an exported
// report cannot be read as leaf-level coding.
function _analysisRollupNote() {
    return _analysisRollup === 'root'
        ? '<small class="analysis-rollup-note">rolled up to top-level themes</small>' : '';
}

let _wfMode = 'bars'; // 'bars' | 'cloud' | 'rank'
let _wfCache = null;

let _projWfMode = 'bars';
let _projWfCache = null;

function _setProjWfMode(mode) {
    _projWfMode = mode;
    const card = document.getElementById('proj-wf-card');
    if (card && _projWfCache) {
        card.innerHTML = _renderProjWf(_projWfCache.sorted, _projWfCache.max);
        refreshIcons();
    }
}

function _chartProjWordFrequency(items) {
    const wc = {};
    items.forEach(a => {
        _contentWords(_analysisText(a))
            .forEach(w => { wc[w] = (wc[w] || 0) + 1; });
    });
    const distinct = Object.keys(wc).length;
    const sorted = Object.entries(wc).sort((a, b) => b[1] - a[1]).slice(0, 30);
    sorted.totalWords = distinct;
    if (!sorted.length) return `<div class="analysis-card-header"><span>${icon('type')} Word Frequency</span></div><p class="analysis-empty">No text to analyse yet.</p>`;
    const max = sorted[0][1];
    _projWfCache = { sorted, max };
    return _renderProjWf(sorted, max);
}

function _renderProjWf(sorted, max) {
    const header = `
        <div class="analysis-card-header">
            <span>${icon('type')} Word Frequency</span>
            <small>words in quotes &amp; notes${sorted.totalWords ? ` · showing ${_wfShownCount(sorted, _projWfMode)} of ${sorted.totalWords} distinct` : ''}</small>
            <div class="wf-mode-toggle">
                <button class="wf-mode-btn${_projWfMode==='bars'?' active':''}" onclick="_setProjWfMode('bars')" title="Bar chart">${icon('bar-chart-2')}</button>
                <button class="wf-mode-btn${_projWfMode==='cloud'?' active':''}" onclick="_setProjWfMode('cloud')" title="Word cloud">${icon('wind')}</button>
                <button class="wf-mode-btn${_projWfMode==='treemap'?' active':''}" onclick="_setProjWfMode('treemap')" title="Treemap">${icon('layout-grid')}</button>
            </div>
        </div>`;
    if (_projWfMode === 'cloud') return header + _renderWfCloud(sorted, max);
    if (_projWfMode === 'treemap') return header + _renderWfTreemap(sorted, max);
    return header + _renderWfBars(sorted, max);
}

function _setWfMode(mode) {
    _wfMode = mode;
    const card = document.getElementById('wf-card');
    if (card && _wfCache) {
        card.innerHTML = _renderWf(_wfCache.sorted, _wfCache.max);
        refreshIcons();
    }
}

function _chartWordFrequency(items) {
    const wc = {};
    items.forEach(a => {
        _contentWords(_analysisText(a))
            .forEach(w => { wc[w] = (wc[w] || 0) + 1; });
    });
    const distinct = Object.keys(wc).length;
    const sorted = Object.entries(wc).sort((a, b) => b[1] - a[1]).slice(0, 30);
    sorted.totalWords = distinct;
    if (!sorted.length) return `<div class="analysis-card-header"><span>${icon('type')} Word Frequency</span></div><p class="analysis-empty">No text to analyse yet.</p>`;
    const max = sorted[0][1];
    _wfCache = { sorted, max };
    return _renderWf(sorted, max);
}

// Each view truncates differently; report the count actually on screen.
function _wfShownCount(sorted, mode) {
    if (mode === 'cloud') return sorted.length;
    if (mode === 'treemap') return Math.min(25, sorted.length);
    return Math.min(20, sorted.length);
}

function _renderWf(sorted, max) {
    const header = `
        <div class="analysis-card-header">
            <span>${icon('type')} Word Frequency</span>
            <small>words in quotes &amp; notes${sorted.totalWords ? ` · showing ${_wfShownCount(sorted, _wfMode)} of ${sorted.totalWords} distinct` : ''}</small>
            <div class="wf-mode-toggle">
                <button class="wf-mode-btn${_wfMode==='bars'?' active':''}" onclick="_setWfMode('bars')" title="Bar chart">${icon('bar-chart-2')}</button>
                <button class="wf-mode-btn${_wfMode==='cloud'?' active':''}" onclick="_setWfMode('cloud')" title="Word cloud">${icon('wind')}</button>
                <button class="wf-mode-btn${_wfMode==='treemap'?' active':''}" onclick="_setWfMode('treemap')" title="Treemap">${icon('layout-grid')}</button>
            </div>
        </div>`;
    if (_wfMode === 'cloud') return header + _renderWfCloud(sorted, max);
    if (_wfMode === 'treemap') return header + _renderWfTreemap(sorted, max);
    return header + _renderWfBars(sorted, max);
}

function _renderWfBars(sorted, max) {
    return `<div class="analysis-bars analysis-bars-2col">${sorted.slice(0, 20).map(([w, n]) => `
        <div class="analysis-bar-row analysis-drill" role="button" tabindex="0"
             title="Show the annotations containing “${escapeHtml(w)}”" onclick="drillIntoWord('${escapeJs(w)}')">
            <span class="analysis-bar-label">${escapeHtml(w)}</span>
            <div class="analysis-bar-track">
                <div class="analysis-bar-fill" style="width:${(n/max*100).toFixed(1)}%;background:var(--accent)"></div>
            </div>
            <span class="analysis-bar-count">${n}</span>
        </div>`).join('')}
    </div>`;
}

function _renderWfCloud(sorted, max) {
    const minPx = 12, maxPx = 40;
    return `<div class="wf-cloud">${sorted.map(([w, n]) => {
        const ratio = n / max;
        const size = Math.round(minPx + (maxPx - minPx) * ratio);
        const weight = ratio > 0.55 ? 700 : ratio > 0.25 ? 500 : 400;
        const opacity = (0.4 + 0.6 * ratio).toFixed(2);
        return `<span class="wf-cloud-word analysis-drill" role="button" tabindex="0" style="font-size:${size}px;font-weight:${weight};opacity:${opacity}" title="${escapeHtml(w)}: ${n} — click to show them" onclick="drillIntoWord('${escapeJs(w)}')">${escapeHtml(w)}</span>`;
    }).join('')}</div>`;
}

function _renderWfTreemap(sorted, max) {
    return `<div class="wf-treemap">${sorted.slice(0, 25).map(([w, n]) => {
        const ratio = n / max;
        const pct = Math.max(8, ratio * 92).toFixed(1);
        const height = Math.round(36 + ratio * 36);
        const opacity = (0.4 + 0.6 * ratio).toFixed(2);
        return `<div class="wf-treemap-tile analysis-drill" role="button" tabindex="0" style="width:calc(${pct}% - 4px);height:${height}px;opacity:${opacity}" title="${escapeHtml(w)}: ${n} — click to show them" onclick="drillIntoWord('${escapeJs(w)}')">
            <span class="wf-treemap-word">${escapeHtml(w)}</span>
            <span class="wf-treemap-count">${n}</span>
        </div>`;
    }).join('')}</div>`;
}

let _coocMetric = 'count';   // 'count' | 'jaccard'

function setCoocMetric(metric) {
    _coocMetric = metric === 'jaccard' ? 'jaccard' : 'count';
    if (appState.activeCenterView === 'annotations') renderAnalysisDashboard();
    if (appState.activeProject) renderProjectDetail(appState.activeProject);
}

function _chartCoOccurrence(items) {
    const pairs = {};
    const themeTotals = {};
    items.forEach(a => {
        const tags = a.tags || [];
        tags.forEach(t => { themeTotals[t.tag_id] = (themeTotals[t.tag_id] || 0) + 1; });
        for (let i = 0; i < tags.length; i++) for (let j = i + 1; j < tags.length; j++) {
            const key = [tags[i].tag_id, tags[j].tag_id].sort().join('-');
            if (!pairs[key]) pairs[key] = { a: tags[i], b: tags[j], count: 0 };
            pairs[key].count++;
        }
    });

    /* Raw counts rank pairs by how big the two themes are, so the busiest themes
       always appear to be related.  Jaccard divides the overlap by the union, so
       it answers "how much of the time these two appear, do they appear
       together" — two small themes that always co-occur outrank a large pair
       that overlaps incidentally. */
    Object.values(pairs).forEach(p => {
        const union = (themeTotals[p.a.tag_id] || 0) + (themeTotals[p.b.tag_id] || 0) - p.count;
        p.jaccard = union > 0 ? p.count / union : 0;
    });

    const allPairs = Object.values(pairs).sort((x, y) =>
        _coocMetric === 'jaccard' ? (y.jaccard - x.jaccard) || (y.count - x.count) : (y.count - x.count));
    const sorted = allPairs.slice(0, 12);
    if (!sorted.length) return `<div class="analysis-card-header"><span>Theme Co-occurrence</span></div><p class="analysis-empty">Tag multiple themes on the same annotation to see co-occurring pairs.</p>`;

    const valueOf = p => _coocMetric === 'jaccard' ? p.jaccard : p.count;
    const max = valueOf(sorted[0]) || 1;
    return `
        <div class="analysis-card-header"><span>${icon('git-merge')} Theme Co-occurrence</span>
            <small>${_coocMetric === 'jaccard'
                ? 'Jaccard index — shared annotations ÷ annotations carrying either theme'
                : 'raw count of annotations carrying both themes'}</small>
            ${_analysisRollupNote()}${_shownOf(sorted.length, allPairs.length, 'pairs')}
            <div class="analysis-rollup-toggle analysis-metric-toggle" role="group" aria-label="Co-occurrence metric">
                <button class="analysis-rollup-btn${_coocMetric === 'count' ? ' active' : ''}" type="button" onclick="setCoocMetric('count')" title="Rank by raw co-occurrence count">Count</button>
                <button class="analysis-rollup-btn${_coocMetric === 'jaccard' ? ' active' : ''}" type="button" onclick="setCoocMetric('jaccard')" title="Rank by Jaccard index, which corrects for theme size">Jaccard</button>
            </div>
        </div>
        <div class="analysis-bars analysis-bars-2col">${sorted.map(p => `
            <div class="analysis-bar-row analysis-drill" role="button" tabindex="0"
                 title="Show the ${p.count} annotation${p.count !== 1 ? 's' : ''} carrying both themes"
                 onclick="drillIntoThemePair(${p.a.tag_id}, ${p.b.tag_id})">
                <span class="analysis-cooc-label">
                    <span style="color:${p.a.color||'var(--accent)'}">${escapeHtml(p.a.name)}</span>
                    <span class="analysis-cooc-sep">×</span>
                    <span style="color:${p.b.color||'var(--accent)'}">${escapeHtml(p.b.name)}</span>
                </span>
                <div class="analysis-bar-track">
                    <div class="analysis-bar-fill" style="width:${(valueOf(p)/max*100).toFixed(1)}%;background:linear-gradient(90deg,${p.a.color||'var(--accent)'},${p.b.color||'var(--accent)'})"></div>
                </div>
                <span class="analysis-bar-count">${_coocMetric === 'jaccard'
                    ? `${p.jaccard.toFixed(2)}<small class="analysis-bar-sub"> n=${p.count}</small>`
                    : p.count}</span>
            </div>`).join('')}
        </div>`;
}

function _chartDocumentMatrix(items, options = {}) {
    const themeCounts = {};
    items.forEach(a => (a.tags || []).forEach(t => {
        if (!themeCounts[t.tag_id]) themeCounts[t.tag_id] = { ...t, c: 0 };
        themeCounts[t.tag_id].c++;
    }));
    const allThemes = Object.values(themeCounts).sort((a, b) => b.c - a.c);
    const topThemes = allThemes.slice(0, 10);

    /* Documents were previously the *first* eight encountered.  The API returns
       annotations ordered by item_key, so that was the eight lexicographically
       smallest keys — a stable but meaningless subset that could omit the
       documents holding almost all of the coding.  Rank them by how much coding
       they actually carry. */
    const docsMap = {};
    const docCounts = {};
    items.forEach(a => {
        if (!docsMap[a.item_key]) docsMap[a.item_key] = a.item_title || a.item_key;
        docCounts[a.item_key] = (docCounts[a.item_key] || 0) + 1;
    });
    const allDocs = Object.entries(docsMap).sort((a, b) => (docCounts[b[0]] || 0) - (docCounts[a[0]] || 0));
    const topDocs = allDocs.slice(0, 8);
    if (!topThemes.length || !topDocs.length) return `<div class="analysis-card-header"><span>Theme × Document Matrix</span></div><p class="analysis-empty">Not enough data.</p>`;

    const matrix = {};
    items.forEach(a => (a.tags || []).forEach(t => {
        if (!matrix[t.tag_id]) matrix[t.tag_id] = {};
        matrix[t.tag_id][a.item_key] = (matrix[t.tag_id][a.item_key] || 0) + 1;
    }));
    const maxVal = Math.max(1, ...topThemes.flatMap(t => topDocs.map(([k]) => matrix[t.tag_id]?.[k] || 0)));
    const short = s => s.length > 14 ? s.slice(0, 13) + '…' : s;

    const exportBtnMatrix = `<div class="analysis-export-actions">
        <button class="analysis-export-chip" type="button" onclick="exportProjectDocumentMatrixData()" title="Download as CSV">${icon('table-2')} Data</button>
        <button class="analysis-export-chip" type="button" onclick="exportProjectDocumentMatrixSvg()" title="Download as SVG">${icon('file-code')} SVG</button>
        <button class="analysis-export-chip" type="button" onclick="exportProjectDocumentMatrixPng()" title="Download as PNG">${icon('image')} PNG</button>
    </div>`;
    return `
        <div class="analysis-card-header"><span>${icon('grid')} Theme × Document Matrix</span><small>annotation count per theme per paper · most-coded first${
            (topThemes.length < allThemes.length || topDocs.length < allDocs.length)
                ? ` · showing ${topThemes.length}/${allThemes.length} themes × ${topDocs.length}/${allDocs.length} documents` : ''
        }</small>${exportBtnMatrix}</div>
        <div class="heatmap-scroll">
            <table class="heatmap-table">
                <thead><tr>
                    <th class="heatmap-corner"></th>
                    ${topDocs.map(([, title]) => `<th class="heatmap-col-header" title="${escapeHtml(title)}">${escapeHtml(short(title))}</th>`).join('')}
                </tr></thead>
                <tbody>${topThemes.map(t => `
                    <tr>
                        <td class="heatmap-row-header" style="color:${t.color||'var(--accent)'}">${escapeHtml(t.name)}</td>
                        ${topDocs.map(([k]) => {
                            const v = matrix[t.tag_id]?.[k] || 0;
                            const intensity = (v / maxVal * 0.75 + (v ? 0.1 : 0)).toFixed(2);
                            const title = docsMap[k] || k;
                            return `<td class="heatmap-cell${v ? ' analysis-drill' : ''}" title="${v} annotation${v!==1?'s':''}${v ? ' — click to show them' : ''}"${
                                v ? ` role="button" tabindex="0" onclick="drillIntoThemeDocument(${t.tag_id}, '${escapeJs(k)}', '${escapeJs(title)}')"` : ''}>
                                <div class="heatmap-fill" style="opacity:${intensity};background:${t.color||'var(--accent)'}"></div>
                                <span class="heatmap-val">${v || ''}</span>
                            </td>`;
                        }).join('')}
                    </tr>`).join('')}
                </tbody>
            </table>
        </div>`;
}

/* ── New analysis charts ─────────────────────────────────────────────────────── */

function _chartAnnotationsOverTime(items) {
    /* Calendar months only meant a three-week coding sprint — however intense —
       fell into one bucket and the card rendered "Not enough dated annotations
       yet". Pick the bucket from the span actually covered. */
    const dates = items.map(a => (a.created_at ? new Date(a.created_at) : null))
        .filter(d => d && !isNaN(d));
    if (dates.length < 2) return `<div class="analysis-card-header"><span>${icon('trending-up')} Annotations Over Time</span></div><p class="analysis-empty">Not enough dated annotations yet.</p>`;

    const spanDays = (Math.max(...dates) - Math.min(...dates)) / 86400000;
    const grain = spanDays <= 21 ? 'day' : spanDays <= 120 ? 'week' : 'month';
    const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const bucketOf = d => {
        if (grain === 'month') return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        if (grain === 'day') return iso(d);
        const wk = new Date(d);                        // week starting Monday
        wk.setDate(wk.getDate() - ((wk.getDay() + 6) % 7));
        return iso(wk);
    };

    const byMonth = {};
    dates.forEach(d => { const k = bucketOf(d); byMonth[k] = (byMonth[k] || 0) + 1; });
    const sorted = Object.entries(byMonth).sort((a,b) => a[0].localeCompare(b[0]));
    if (sorted.length < 2) return `<div class="analysis-card-header"><span>${icon('trending-up')} Annotations Over Time</span></div><p class="analysis-empty">All annotations fall on the same ${grain}.</p>`;

    const max = Math.max(...sorted.map(([,v]) => v));
    const bw = Math.max(18, Math.min(48, Math.floor(560 / sorted.length)));
    const gap = 3, ch = 90;
    const svgW = sorted.length * (bw + gap);

    const bars = sorted.map(([month, count], i) => {
        const h = Math.round(count / max * ch);
        const x = i * (bw + gap);
        // month keys are YYYY-MM, day/week keys are YYYY-MM-DD
        const lbl = grain === 'month' ? month.slice(5) : `${month.slice(8)}/${month.slice(5, 7)}`;
        const yr = month.slice(2, 4); // YY
        return `<g>
            <rect x="${x}" y="${ch - h}" width="${bw}" height="${h}" fill="var(--accent)" rx="3" opacity="0.85">
                <title>${month}: ${count} annotations</title>
            </rect>
            <text x="${x + bw/2}" y="${ch + 13}" text-anchor="middle" font-size="9" fill="var(--text-muted)">${lbl}</text>
            ${(grain === 'month' && lbl === '01') || i === 0 ? `<text x="${x + bw/2}" y="${ch + 22}" text-anchor="middle" font-size="8" fill="var(--text-muted)" opacity="0.7">${yr}</text>` : ''}
            <text x="${x + bw/2}" y="${ch - h - 3}" text-anchor="middle" font-size="9" fill="var(--text-secondary)">${count > 0 ? count : ''}</text>
        </g>`;
    }).join('');

    return `
        <div class="analysis-card-header"><span>${icon('trending-up')} Annotations Over Time</span><small>by ${grain} · ${sorted.length} buckets</small></div>
        <div style="overflow-x:auto">
            <svg viewBox="0 0 ${svgW} ${ch + 28}" style="display:block;min-width:${svgW}px;height:${ch+28}px;width:100%">
                ${bars}
            </svg>
        </div>`;
}

function _chartCodingDensity(items) {
    const byDoc = {};
    items.forEach(a => {
        if (!byDoc[a.item_key]) byDoc[a.item_key] = { title: a.item_title || a.item_key, pages: {} };
        const p = a.page_index ?? 0;
        byDoc[a.item_key].pages[p] = (byDoc[a.item_key].pages[p] || 0) + 1;
    });
    const docs = Object.values(byDoc).slice(0, 8);
    if (!docs.length) return `<div class="analysis-card-header"><span>${icon('map')} Coding Density per Page</span></div><p class="analysis-empty">No annotations yet.</p>`;

    const rows = docs.map(doc => {
        const pages = doc.pages;
        const maxPage = Math.max(...Object.keys(pages).map(Number));
        const maxCount = Math.max(...Object.values(pages));
        const cells = Array.from({ length: maxPage + 1 }, (_, p) => {
            const c = pages[p] || 0;
            const op = c ? (0.15 + c / maxCount * 0.82).toFixed(2) : '0.04';
            return `<div class="density-cell" style="opacity:${op};background:var(--accent)" title="p.${p+1}: ${c} annotation${c!==1?'s':''}"></div>`;
        }).join('');
        return `<div class="density-row">
            <span class="density-label" title="${escapeHtml(doc.title)}">${escapeHtml(doc.title.slice(0, 28))}${doc.title.length > 28 ? '…' : ''}</span>
            <div class="density-strip">${cells}</div>
            <span class="density-total">${Object.values(pages).reduce((s,v)=>s+v,0)}</span>
        </div>`;
    }).join('');

    return `
        <div class="analysis-card-header"><span>${icon('map')} Coding Density per Page</span><small>each cell = one page · color intensity = annotation count</small></div>
        <div class="density-chart">${rows}</div>`;
}

function _chartThemeNetwork(items) {
    return `
        <div class="analysis-card-header">
            <span>${icon('share-2')} Theme Relationship Network</span>
            <small>node size = frequency · edge = co-occurrence · click a node for its annotations</small>
            ${_analysisRollupNote()}<small class="analysis-trunc" id="network-cap-note"></small>
            <div class="analysis-export-actions">
                <button class="analysis-export-chip" type="button" onclick="exportProjectNetworkData()" title="Download network nodes and edges as CSV">${icon('table-2')} Data</button>
                <button class="analysis-export-chip" type="button" onclick="exportProjectNetworkPng()" title="Download current network view as PNG">${icon('image')} PNG</button>
                <button class="analysis-export-chip" type="button" onclick="exportProjectNetworkSvg()" title="Download editable network SVG">${icon('file-code')} SVG</button>
            </div>
        </div>
        <div class="network-controls">
            <div class="network-ctrl-group">
                <span class="network-ctrl-label">Shape</span>
                <button class="network-ctrl-btn active" data-edge="straight" onclick="_netSetEdge('straight',this)">Straight</button>
                <button class="network-ctrl-btn" data-edge="curved" onclick="_netSetEdge('curved',this)">Curved</button>
                <button class="network-ctrl-btn" data-edge="elbow" onclick="_netSetEdge('elbow',this)">Elbow</button>
            </div>
            <div class="network-ctrl-group">
                <span class="network-ctrl-label">Line</span>
                <button class="network-ctrl-btn active" data-dash="solid" onclick="_netSetDash('solid',this)" title="Solid">—</button>
                <button class="network-ctrl-btn" data-dash="dashed" onclick="_netSetDash('dashed',this)" title="Dashed">╌</button>
                <button class="network-ctrl-btn" data-dash="dotted" onclick="_netSetDash('dotted',this)" title="Dotted">···</button>
            </div>
            <div class="network-ctrl-group">
                <span class="network-ctrl-label">Color</span>
                <div class="net-color-wrap" title="Click to change edge color">
                    <button class="net-color-circle" id="net-color-circle" onclick="document.getElementById('net-color-pick').click()"></button>
                    <input type="color" id="net-color-pick" class="net-color-pick-hidden" value="#888888" oninput="_netSetColor(this.value)">
                </div>
            </div>
            <div class="network-ctrl-group">
                <span class="network-ctrl-label">Zoom</span>
                <button class="network-ctrl-btn" onclick="_netZoom(-0.25)" title="Zoom out">−</button>
                <button class="network-ctrl-btn" onclick="_netZoomFit()" title="Reset view">Fit</button>
                <button class="network-ctrl-btn" onclick="_netZoom(0.25)" title="Zoom in">+</button>
            </div>
        </div>
        <canvas id="network-canvas" class="network-canvas"></canvas>
        <p class="analysis-empty" id="network-empty" style="display:none">Not enough co-occurring theme pairs to draw a network.</p>`;
}

function _chartProjectNetworkHtml() {
    return `
        <div class="analysis-card-header">
            <span>${icon('share-2')} Theme Relationship Network</span>
            <small>node size = frequency · edge = co-occurrence · click a node for its annotations</small>
            ${_analysisRollupNote()}<small class="analysis-trunc" id="proj-network-cap-note"></small>
            <div class="analysis-export-actions">
                <button class="analysis-export-chip" type="button" onclick="exportProjectNetworkData()" title="Download network nodes and edges as CSV">${icon('table-2')} Data</button>
                <button class="analysis-export-chip" type="button" onclick="exportProjectNetworkPng()" title="Download current network view as PNG">${icon('image')} PNG</button>
                <button class="analysis-export-chip" type="button" onclick="exportProjectNetworkSvg()" title="Download editable network SVG">${icon('file-code')} SVG</button>
            </div>
        </div>
        <div class="network-controls">
            <div class="network-ctrl-group">
                <span class="network-ctrl-label">Shape</span>
                <button class="network-ctrl-btn active" data-edge="straight" onclick="_netSetEdge('straight',this)">Straight</button>
                <button class="network-ctrl-btn" data-edge="curved" onclick="_netSetEdge('curved',this)">Curved</button>
                <button class="network-ctrl-btn" data-edge="elbow" onclick="_netSetEdge('elbow',this)">Elbow</button>
            </div>
            <div class="network-ctrl-group">
                <span class="network-ctrl-label">Line</span>
                <button class="network-ctrl-btn active" data-dash="solid" onclick="_netSetDash('solid',this)" title="Solid">—</button>
                <button class="network-ctrl-btn" data-dash="dashed" onclick="_netSetDash('dashed',this)" title="Dashed">╌</button>
                <button class="network-ctrl-btn" data-dash="dotted" onclick="_netSetDash('dotted',this)" title="Dotted">···</button>
            </div>
            <div class="network-ctrl-group">
                <span class="network-ctrl-label">Color</span>
                <div class="net-color-wrap" title="Click to change edge color">
                    <button class="net-color-circle" id="proj-net-color-circle" onclick="document.getElementById('proj-net-color-pick').click()"></button>
                    <input type="color" id="proj-net-color-pick" class="net-color-pick-hidden" value="#888888" oninput="_projNetSetColor(this.value)">
                </div>
            </div>
            <div class="network-ctrl-group">
                <span class="network-ctrl-label">Zoom</span>
                <button class="network-ctrl-btn" onclick="_netZoom(-0.25)" title="Zoom out">−</button>
                <button class="network-ctrl-btn" onclick="_netZoomFit()" title="Reset view">Fit</button>
                <button class="network-ctrl-btn" onclick="_netZoom(0.25)" title="Zoom in">+</button>
            </div>
        </div>
        <canvas id="proj-network-canvas" class="network-canvas"></canvas>
        <p class="analysis-empty" id="proj-network-empty" style="display:none">Not enough co-occurring theme pairs to draw a network.</p>`;
}

function _projNetSetColor(color) {
    if (!_netState) return;
    _netState.edgeColor = color;
    const circle = document.getElementById('proj-net-color-circle');
    if (circle) circle.style.background = color;
    _netDraw();
}

let _netState = null;
let _netCleanup = null;

function _initNetworkGraph(items, canvasId = 'network-canvas', emptyId = 'network-empty') {
    // Tear down previous listeners
    if (_netCleanup) { _netCleanup(); _netCleanup = null; }
    _netState = null;

    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const H = 420;
    // clientWidth includes padding (16px × 2 = 32px); subtract to get exact content width
    const W = canvas.parentElement.clientWidth - 32;
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    canvas.getContext('2d').scale(dpr, dpr);

    // Build nodes + edges
    const nodemap = {};
    items.forEach(a => (a.tags || []).forEach(t => {
        if (!nodemap[t.tag_id]) nodemap[t.tag_id] = { id: t.tag_id, name: t.name, color: t.color || '#3b82f6', count: 0 };
        nodemap[t.tag_id].count++;
    }));
    const edgesMap = {};
    items.forEach(a => {
        const tags = a.tags || [];
        for (let i = 0; i < tags.length; i++) for (let j = i+1; j < tags.length; j++) {
            const key = [tags[i].tag_id, tags[j].tag_id].sort().join('-');
            edgesMap[key] = (edgesMap[key] || 0) + 1;
        }
    });
    const edgeList = Object.entries(edgesMap).map(([k, w]) => {
        const [s, t] = k.split('-').map(Number);
        return { s, t, w };
    });
    /* The layout is a 220-iteration O(n²) simulation run synchronously on the
       main thread, and it used every theme in the corpus: 200 themes measured
       ~500 ms, 400 themes ~2 s, every time the dashboard re-rendered.  Cap it at
       the most-used themes — beyond that the graph is unreadable anyway — and
       drop edges that lost an endpoint. */
    const allNodes = Object.values(nodemap).sort((a, b) => b.count - a.count);
    const nodes = allNodes.slice(0, NETWORK_NODE_LIMIT);
    const kept = new Set(nodes.map(n => n.id));
    const edges = edgeList.filter(e => kept.has(e.s) && kept.has(e.t));
    const hiddenNodes = allNodes.length - nodes.length;

    const capNote = document.getElementById(canvasId === 'network-canvas' ? 'network-cap-note' : 'proj-network-cap-note');
    if (capNote) {
        capNote.textContent = hiddenNodes
            ? `showing the ${nodes.length} most-used of ${allNodes.length} themes`
            : '';
    }

    if (nodes.length < 2 || edges.length === 0) {
        canvas.style.display = 'none';
        const emptyEl = document.getElementById(emptyId);
        if (emptyEl) emptyEl.style.display = '';
        return;
    }

    // Size nodes, seed positions
    const maxR = 28, minR = 10;
    const maxCount = Math.max(...nodes.map(n => n.count));
    nodes.forEach(n => {
        n.r = minR + (n.count / maxCount) * (maxR - minR);
        n.x = W/2 + (Math.random() - 0.5) * W * 0.55;
        n.y = H/2 + (Math.random() - 0.5) * H * 0.55;
        n.vx = 0; n.vy = 0;
    });
    const maxW = Math.max(...edges.map(e => e.w));
    const idxMap = {};
    nodes.forEach((n, i) => idxMap[n.id] = i);

    // Force simulation (pre-computed)
    for (let iter = 0; iter < 220; iter++) {
        const cool = 1 - iter / 220;
        for (let i = 0; i < nodes.length; i++) for (let j = i+1; j < nodes.length; j++) {
            const dx = nodes[j].x - nodes[i].x, dy = nodes[j].y - nodes[i].y;
            const d = Math.sqrt(dx*dx + dy*dy) || 1;
            const f = 5000 / (d * d);
            nodes[i].vx -= dx/d*f; nodes[i].vy -= dy/d*f;
            nodes[j].vx += dx/d*f; nodes[j].vy += dy/d*f;
        }
        edges.forEach(e => {
            const a = nodes[idxMap[e.s]], b = nodes[idxMap[e.t]];
            if (!a || !b) return;
            const dx = b.x - a.x, dy = b.y - a.y;
            const d = Math.sqrt(dx*dx + dy*dy) || 1;
            const target = 90 + (1 - e.w/maxW) * 70;
            const f = (d - target) * 0.07;
            a.vx += dx/d*f; a.vy += dy/d*f;
            b.vx -= dx/d*f; b.vy -= dy/d*f;
        });
        nodes.forEach(n => { n.vx += (W/2 - n.x) * 0.012; n.vy += (H/2 - n.y) * 0.012; });
        nodes.forEach(n => {
            n.x += n.vx * (0.85 * cool + 0.15);
            n.y += n.vy * (0.85 * cool + 0.15);
            n.vx *= 0.42; n.vy *= 0.42;
        });
    }

    // Center the settled layout
    const bx0 = Math.min(...nodes.map(n => n.x - n.r - 10));
    const bx1 = Math.max(...nodes.map(n => n.x + n.r + 10));
    const by0 = Math.min(...nodes.map(n => n.y - n.r - 10));
    const by1 = Math.max(...nodes.map(n => n.y + n.r + 10));
    const ox = W/2 - (bx0 + bx1)/2;
    const oy = H/2 - (by0 + by1)/2;
    nodes.forEach(n => { n.x += ox; n.y += oy; });

    _netState = {
        canvas, nodes, edgeList: edges, idxMap, maxW,
        W, H,
        edgeStyle: 'straight',
        edgeDash: 'solid',
        edgeColor: 'auto',
        tr: { scale: 1, tx: 0, ty: 0 },
        dragging: null,
        panning: false,
        panStart: null,
    };

    _netDraw();
    _netCleanup = _netAttachEvents(canvas);
}

function _netDraw() {
    if (!_netState) return;
    const { canvas, nodes, edgeList, idxMap, maxW, edgeStyle, tr, W, H } = _netState;
    const ctx = canvas.getContext('2d');

    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.translate(tr.tx, tr.ty);
    ctx.scale(tr.scale, tr.scale);

    const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
    const autoCol  = isDark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.16)';
    const edgeCol  = _netState.edgeColor === 'auto' ? autoCol : _netState.edgeColor;
    const edgeLbl  = isDark ? 'rgba(255,255,255,0.5)'  : 'rgba(0,0,0,0.45)';
    const textCol  = isDark ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.8)';
    const dashMap  = { solid: [], dashed: [8, 5], dotted: [2, 4] };
    const lineDash = dashMap[_netState.edgeDash] || [];

    // Edges
    edgeList.forEach(e => {
        const na = nodes[idxMap[e.s]], nb = nodes[idxMap[e.t]];
        if (!na || !nb) return;
        const lw = Math.max(1, e.w / maxW * 7);
        ctx.beginPath();
        ctx.strokeStyle = edgeCol;
        ctx.lineWidth = lw;
        ctx.setLineDash(lineDash);

        let labelX, labelY;

        if (edgeStyle === 'curved') {
            const dx = nb.x - na.x, dy = nb.y - na.y;
            const len = Math.sqrt(dx*dx + dy*dy) || 1;
            const bend = Math.min(len * 0.35, 70);
            const cpx = (na.x + nb.x)/2 - (dy/len) * bend;
            const cpy = (na.y + nb.y)/2 + (dx/len) * bend;
            ctx.moveTo(na.x, na.y);
            ctx.quadraticCurveTo(cpx, cpy, nb.x, nb.y);
            // label at curve midpoint (t=0.5 of quadratic)
            labelX = 0.25*na.x + 0.5*cpx + 0.25*nb.x;
            labelY = 0.25*na.y + 0.5*cpy + 0.25*nb.y;
        } else if (edgeStyle === 'elbow') {
            const mx = (na.x + nb.x) / 2;
            ctx.moveTo(na.x, na.y);
            ctx.lineTo(mx, na.y);
            ctx.lineTo(mx, nb.y);
            ctx.lineTo(nb.x, nb.y);
            labelX = mx; labelY = na.y;
        } else {
            ctx.moveTo(na.x, na.y);
            ctx.lineTo(nb.x, nb.y);
            labelX = (na.x + nb.x)/2; labelY = (na.y + nb.y)/2;
        }
        ctx.stroke();

        if (e.w > 1) {
            ctx.font = '9px sans-serif';
            ctx.fillStyle = edgeLbl;
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(e.w, labelX, labelY);
        }
    });

    ctx.setLineDash([]);

    // Nodes
    nodes.forEach(n => {
        ctx.shadowColor = n.color; ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx.fillStyle = n.color + 'cc';
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.strokeStyle = n.color; ctx.lineWidth = 2;
        ctx.stroke();
        // Count
        ctx.font = `bold ${Math.max(8, n.r * 0.62)}px sans-serif`;
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(n.count, n.x, n.y);
        // Label below
        ctx.font = `bold ${Math.max(9, Math.min(12, n.r))}px sans-serif`;
        ctx.fillStyle = textCol;
        ctx.textBaseline = 'top';
        const label = n.name.length > 13 ? n.name.slice(0, 12) + '…' : n.name;
        ctx.fillText(label, n.x, n.y + n.r + 3);
    });

    ctx.restore();
}

function _netCanvasXY(canvas, e) {
    const rect = canvas.getBoundingClientRect();
    const { scale, tx, ty } = _netState.tr;
    return {
        x: (e.clientX - rect.left - tx) / scale,
        y: (e.clientY - rect.top  - ty) / scale,
    };
}

function _netHitNode(x, y) {
    if (!_netState) return null;
    for (const n of _netState.nodes) {
        const dx = x - n.x, dy = y - n.y;
        if (dx*dx + dy*dy <= n.r * n.r) return n;
    }
    return null;
}

function _netAttachEvents(canvas) {
    const onWheel = e => {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const factor = e.deltaY < 0 ? 1.13 : 1/1.13;
        const tr = _netState.tr;
        tr.tx = mx - (mx - tr.tx) * factor;
        tr.ty = my - (my - tr.ty) * factor;
        tr.scale = Math.max(0.15, Math.min(6, tr.scale * factor));
        _netDraw();
    };

    const onMouseDown = e => {
        const { x, y } = _netCanvasXY(canvas, e);
        const hit = _netHitNode(x, y);
        // Remember where the press landed so mouseup can tell a click from a drag.
        _netState.pressed = { node: hit, mx: e.clientX, my: e.clientY };
        if (hit) {
            _netState.dragging = hit;
            canvas.style.cursor = 'grabbing';
        } else {
            _netState.panning = true;
            _netState.panStart = { mx: e.clientX, my: e.clientY, tx: _netState.tr.tx, ty: _netState.tr.ty };
            canvas.style.cursor = 'grabbing';
        }
    };

    const onMouseMove = e => {
        if (!_netState) return;
        if (_netState.dragging) {
            const { x, y } = _netCanvasXY(canvas, e);
            _netState.dragging.x = x;
            _netState.dragging.y = y;
            _netDraw();
        } else if (_netState.panning && _netState.panStart) {
            _netState.tr.tx = _netState.panStart.tx + (e.clientX - _netState.panStart.mx);
            _netState.tr.ty = _netState.panStart.ty + (e.clientY - _netState.panStart.my);
            _netDraw();
        } else {
            const { x, y } = _netCanvasXY(canvas, e);
            canvas.style.cursor = _netHitNode(x, y) ? 'grab' : 'default';
        }
    };

    const onMouseUp = e => {
        if (!_netState) return;
        const pressed = _netState.pressed;
        _netState.pressed = null;
        _netState.dragging = null;
        _netState.panning = false;
        canvas.style.cursor = 'default';
        // A press and release on the same node, without dragging it, means
        // "show me this theme's annotations".
        if (pressed?.node && e && Math.abs(e.clientX - pressed.mx) < 4 && Math.abs(e.clientY - pressed.my) < 4) {
            drillIntoTheme(pressed.node.id);
        }
    };

    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);

    return () => {
        canvas.removeEventListener('wheel', onWheel);
        canvas.removeEventListener('mousedown', onMouseDown);
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
    };
}

function _netSetEdge(style, btn) {
    if (!_netState) return;
    _netState.edgeStyle = style;
    document.querySelectorAll('.network-ctrl-btn[data-edge]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    _netDraw();
}

function _netSetDash(dash, btn) {
    if (!_netState) return;
    _netState.edgeDash = dash;
    document.querySelectorAll('.network-ctrl-btn[data-dash]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    _netDraw();
}

function _netSetColor(color) {
    if (!_netState) return;
    _netState.edgeColor = color;
    const circle = document.getElementById('net-color-circle');
    if (circle) circle.style.background = color;
    _netDraw();
}

function _netZoom(delta) {
    if (!_netState) return;
    const { tr, W, H } = _netState;
    const cx = W / 2, cy = H / 2;
    const factor = 1 + delta;
    tr.tx = cx - (cx - tr.tx) * factor;
    tr.ty = cy - (cy - tr.ty) * factor;
    tr.scale = Math.max(0.15, Math.min(6, tr.scale * factor));
    _netDraw();
}

function _netZoomFit() {
    if (!_netState) return;
    _netState.tr = { scale: 1, tx: 0, ty: 0 };
    _netDraw();
}

// Rows rendered at once; every match is still counted and reported.
const KWIC_RESULT_LIMIT = 200;

/* Unicode-aware word-boundary test: \b in JavaScript is ASCII-only, which would
   mis-handle the very scripts the tokeniser was fixed for. */
function _isWholeWordHit(haystack, start, length) {
    const wordChar = /[\p{L}\p{N}_]/u;
    const before = start > 0 ? haystack[start - 1] : '';
    const after = start + length < haystack.length ? haystack[start + length] : '';
    return !(before && wordChar.test(before)) && !(after && wordChar.test(after));
}

let _kwicWholeWord = false;

function setKwicWholeWord(on) {
    _kwicWholeWord = !!on;
    renderKWICResults(document.getElementById('kwic-input')?.value || '');
}

function _chartKWIC() {
    return `
        <div class="analysis-card-header"><span>${icon('search')} Keyword in Context (KWIC)</span>
            <small>searching ${ANALYSIS_TEXT_SCOPE_LABELS[_analysisTextScope]}</small>
            <label class="kwic-option" title="Match the whole word only — otherwise “art” also matches “part”">
                <input type="checkbox" ${_kwicWholeWord ? 'checked' : ''} onchange="setKwicWholeWord(this.checked)"> whole word
            </label>
        </div>
        <input type="text" class="compact-input" id="kwic-input" placeholder="Type a word or phrase…" value="${escapeHtml(document.getElementById('kwic-input')?.value || '')}" oninput="renderKWICResults(this.value)">
        <div id="kwic-results"><p class="analysis-empty">Type a keyword above to see every annotation it appears in.</p></div>`;
}

function renderKWICResults(query) {
    const container = document.getElementById('kwic-results');
    if (!container) return;
    const q = query.trim().toLowerCase();
    if (q.length < 2) { container.innerHTML = '<p class="analysis-empty">Type at least 2 characters.</p>'; return; }

    // Rolled up like every other card, so the theme chips beside each line match
    // the level the rest of the dashboard is counting at.
    const items = _rollupItems(_filteredAnnotations());
    const results = [];
    let total = 0;

    /* The cap used to be `if (results.length >= 40) return;` inside a forEach —
       where `return` skips to the next annotation instead of stopping, so every
       remaining annotation still contributed one more hit.  The count shown was
       therefore neither the true total nor the cap (75 real matches displayed
       as "51").  Count every match, collect up to the limit, and say which is
       which. */
    for (const a of items) {
        const text = _analysisTextScope === 'both'
            ? (a.quote || '') + (a.comment ? '\n' + a.comment : '')
            : _analysisText(a);
        const lower = text.toLowerCase();
        let pos = 0;
        while ((pos = lower.indexOf(q, pos)) !== -1) {
            // Whole-word mode: reject a hit that has a letter or digit hard
            // against either end, so "art" stops matching "part".
            if (_kwicWholeWord && !_isWholeWordHit(lower, pos, q.length)) { pos += q.length; continue; }
            total++;
            if (results.length < KWIC_RESULT_LIMIT) {
                const start = Math.max(0, pos - 45);
                const end = Math.min(text.length, pos + q.length + 45);
                results.push({
                    a,
                    before: (start > 0 ? '…' : '') + text.slice(start, pos),
                    match: text.slice(pos, pos + q.length),
                    after: text.slice(pos + q.length, end) + (end < text.length ? '…' : ''),
                });
            }
            pos += q.length;
        }
    }

    if (!total) { container.innerHTML = `<p class="analysis-empty">No matches for "<strong>${escapeHtml(q)}</strong>".</p>`; return; }

    container.innerHTML = `
        <div class="kwic-count">${total} match${total !== 1 ? 'es' : ''}${
            results.length < total ? ` · showing the first ${results.length}` : ''}</div>
        <div class="kwic-table">
            ${results.map(r => `
                <div class="kwic-row">
                    <span class="kwic-tags">${(r.a.tags||[]).map(t=>`<span style="color:${t.color||'var(--accent)'}">#${escapeHtml(t.name)}</span>`).join(' ')||'<span class="kwic-untagged">—</span>'}</span>
                    <span class="kwic-context"><span class="kwic-before">${escapeHtml(r.before)}</span><mark class="kwic-mark">${escapeHtml(r.match)}</mark><span class="kwic-after">${escapeHtml(r.after)}</span></span>
                    <span class="kwic-doc" title="${escapeHtml(r.a.item_title||r.a.item_key)}">${escapeHtml((r.a.item_title||r.a.item_key||'').slice(0,22))}${(r.a.item_title||'').length>22?'…':''}</span>
                </div>`).join('')}
        </div>`;
}

/* ── Statistical analysis cards ──────────────────────────────────────────────── */

/* Polarity lexicons.  English only until now, which meant an Indonesian corpus
   tokenised correctly (since the Unicode tokeniser landed) and then matched
   nothing at all — the card drew a confident "100% Neutral" donut over text that
   was plainly positive or negative.  Adding Indonesian terms without negation
   handling would have been worse than useless: "tidak berhasil" (unsuccessful)
   would have scored positive. */

const _POS_WORDS_EN = new Set(['important','significant','support','supports','confirm','confirms','strong','valid','clear','effective','positive','helpful','useful','valuable','excellent','benefit','success','demonstrate','demonstrates','evidence','consistent','reliable','robust','key','major','notable','good','better','best','contribute','contributes','suggest','suggests','show','shows','reveal','reveals','indicate','indicates','improve','improves','enhance','enhances','increase','increases','growth','advantage','unique','meaningful','innovative','promising','accurate','comprehensive','critical','essential','fundamental','effective','efficient']);
const _NEG_WORDS_EN = new Set(['problem','problems','issue','issues','limitation','limitations','lack','lacks','fail','fails','failure','weak','weakness','poor','unclear','inconsistent','contradict','contradicts','doubt','concern','concerns','missing','absent','error','errors','incorrect','invalid','uncertain','uncertainty','limited','insufficient','inadequate','challenge','challenges','difficult','difficulty','complex','complexity','confusing','incomplete','wrong','negative','decrease','decreases','decline','loss','disadvantage','constraint','barrier','obstacle','ambiguous','problematic','questionable','flawed']);

const _POS_WORDS_ID = new Set(['berhasil','sukses','baik','bagus','meningkat','meningkatkan','peningkatan','manfaat','bermanfaat','menguntungkan','keuntungan','efektif','efisien','penting','signifikan','kuat','jelas','tepat','akurat','konsisten','mendukung','dukungan','membuktikan','terbukti','positif','unggul','keunggulan','optimal','maju','kemajuan','berkembang','perkembangan','potensi','potensial','solusi','memperbaiki','perbaikan','tinggi','utama','kunci','valid','layak','mampu','berkualitas','inovatif','produktif','aman','stabil','lestari','berkelanjutan','sesuai','memadai','relevan','sehat','pulih','pemulihan','menunjukkan','mendorong']);
const _NEG_WORDS_ID = new Set(['masalah','permasalahan','kendala','hambatan','keterbatasan','terbatas','kekurangan','lemah','kelemahan','gagal','kegagalan','buruk','rusak','kerusakan','menurun','penurunan','turun','hilang','kehilangan','ancaman','terancam','risiko','berisiko','sulit','kesulitan','rendah','salah','kesalahan','keliru','meragukan','diragukan','konflik','krisis','degradasi','kritis','parah','minim','langka','lambat','terlambat','bias','khawatir','kekhawatiran','negatif','defisit','kemiskinan','miskin','tercemar','pencemaran','kerugian','merugikan','bahaya','berbahaya','ilegal','rentan','kerentanan','sengketa','tumpang','abrasi']);

const _POS_WORDS = new Set([..._POS_WORDS_EN, ..._POS_WORDS_ID]);
const _NEG_WORDS = new Set([..._NEG_WORDS_EN, ..._NEG_WORDS_ID]);

// A polarity word within two tokens after one of these has its sign flipped:
// "not effective", "tidak berhasil", "belum memadai", "no benefit".
const _NEGATORS = new Set([
    'not', 'no', 'never', 'without', 'cannot', 'none', 'hardly', 'rarely', 'nor', 'neither',
    'tidak', 'tak', 'bukan', 'belum', 'tanpa', 'jangan', 'kurang',
]);

/* Returns the polarity of one piece of text, or null when nothing in it could be
   scored at all.  "Nothing scoreable" is not the same as "neutral", and
   conflating the two is what made the card lie about non-English corpora. */
function _scoreSentiment(text) {
    const words = _tokenize(text);
    let score = 0;
    let hits = 0;
    words.forEach((w, i) => {
        const polarity = _POS_WORDS.has(w) ? 1 : _NEG_WORDS.has(w) ? -1 : 0;
        if (!polarity) return;
        hits++;
        const negated = (i > 0 && _NEGATORS.has(words[i - 1])) ||
                        (i > 1 && _NEGATORS.has(words[i - 2]));
        score += negated ? -polarity : polarity;
    });
    if (!hits) return null;
    return score > 0 ? 'pos' : score < 0 ? 'neg' : 'neu';
}

function _chartSaturation(items, options = {}) {
    if (!items.length) return `<div class="analysis-card-header"><span>${icon('activity')} Theme Saturation Curve</span></div><p class="analysis-empty">No annotations yet.</p>`;
    /* Coding order, best available: created_at when the annotation carries it,
       falling back to the autoincrement id.  Ids alone mis-order any corpus
       that was bulk-imported, because they are assigned at import time rather
       than in the order the researcher actually read. */
    const orderKey = a => {
        const t = a.created_at ? Date.parse(a.created_at) : NaN;
        return Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER;
    };
    const sorted = [...items].sort((a, b) => (orderKey(a) - orderKey(b)) || (a.annotation_id - b.annotation_id));
    const seen = new Set();
    const data = sorted.map((a, i) => {
        (a.tags || []).forEach(t => seen.add(t.tag_id));
        return { n: i + 1, total: seen.size };
    });
    const maxT = data[data.length - 1].total;
    if (!maxT) return `<div class="analysis-card-header"><span>${icon('activity')} Theme Saturation Curve</span></div><p class="analysis-empty">No themed annotations yet.</p>`;

    let lastNew = 0, prev = 0;
    data.forEach((d, i) => { if (d.total > prev) { lastNew = i; prev = d.total; } });

    /* Saturation needs a *run* of annotations that added nothing new.  The old
       test was `lastNew < data.length - 1`, i.e. one single trailing annotation
       with no new theme flipped the verdict to "Saturated" — which it then
       reported as a confident percentage.  Require a tail of at least 10% of
       the corpus (minimum 5 annotations), and refuse to judge a corpus too
       small to say anything about. */
    const sinceLastNew = data.length - 1 - lastNew;
    const window = Math.max(5, Math.ceil(data.length * 0.1));
    const tooSmall = data.length < 15;
    const isSat = !tooSmall && sinceLastNew >= window;

    const W = 520, H = 110, PL = 28, PR = 6, PT = 10, PB = 18;
    const cW = W - PL - PR, cH = H - PT - PB;
    const toX = n => PL + (n / data.length) * cW;
    const toY = t => PT + cH - (t / maxT) * cH;

    // Resolve CSS vars to actual values — SVG presentation attributes don't
    // reliably inherit custom properties in all WebKit builds.
    const cAccent  = _cssVar('--accent', '#2d6fd4');
    const cBorder  = _cssVar('--border-color', '#1e3a6a');
    const cMuted   = _cssVar('--text-muted', '#5a6d8e');
    const cBgCard  = _cssVar('--bg-card', '#132850');

    const step = Math.max(1, Math.floor(data.length / 200));
    const pts = data.filter((_, i) => i % step === 0 || i === data.length - 1);
    const poly = pts.map(d => `${toX(d.n).toFixed(1)},${toY(d.total).toFixed(1)}`).join(' ');
    const area = `${toX(1).toFixed(1)},${(PT + cH).toFixed(1)} ${poly} ${toX(data.length).toFixed(1)},${(PT + cH).toFixed(1)}`;
    const grid = [0.25, 0.5, 0.75, 1].map(f => {
        const y = toY(maxT * f).toFixed(1);
        return `<line x1="${PL}" y1="${y}" x2="${W - PR}" y2="${y}" stroke="${cBorder}" stroke-width="0.5" stroke-dasharray="3 3"/>
                 <text x="${PL - 2}" y="${y}" text-anchor="end" dominant-baseline="middle" font-size="8" fill="${cMuted}">${Math.round(maxT * f)}</text>`;
    }).join('');
    const satX = toX(lastNew + 1).toFixed(1);
    const satLabelY = PT + cH - 4;
    const satLine = isSat ? `
        <line x1="${satX}" y1="${PT}" x2="${satX}" y2="${PT + cH}" stroke="${cAccent}" stroke-width="1.5" stroke-dasharray="4 3" opacity="0.7"/>
        <rect x="${(toX(lastNew + 1) - 23).toFixed(1)}" y="${(satLabelY - 9).toFixed(1)}" width="46" height="11" rx="2" fill="${cBgCard}" opacity="0.88"/>
        <text x="${satX}" y="${satLabelY.toFixed(1)}" text-anchor="middle" font-size="8" fill="${cAccent}">saturation</text>` : '';

    const exportActions = `
            <div class="analysis-export-actions">
                <button class="analysis-export-chip" type="button" onclick="exportProjectSaturationData()" title="Download as CSV">${icon('table-2')} Data</button>
                <button class="analysis-export-chip" type="button" onclick="exportProjectSaturationSvg()" title="Download as SVG">${icon('file-code')} SVG</button>
                <button class="analysis-export-chip" type="button" onclick="exportProjectSaturationPng()" title="Download as PNG">${icon('image')} PNG</button>
            </div>`;

    return `
        <div class="analysis-card-header">
            <span>${icon('activity')} Theme Saturation Curve</span>
            <small>cumulative new themes in coding order · saturation = no new theme for ${window}+ consecutive annotations</small>${_analysisRollupNote()}
            ${exportActions}
        </div>
        <div style="overflow-x:auto"><svg viewBox="0 0 ${W} ${H}" style="width:100%;height:${H}px;display:block">
            ${grid}
            <polygon points="${area}" fill="${cAccent}" opacity="0.08"/>
            <polyline points="${poly}" fill="none" stroke="${cAccent}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
            ${satLine}
            <text x="${PL}" y="${H - 2}" font-size="8" fill="${cMuted}">1</text>
            <text x="${W - PR}" y="${H - 2}" text-anchor="end" font-size="8" fill="${cMuted}">${data.length}</text>
            <text x="${(W + PL - PR) / 2}" y="${H - 2}" text-anchor="middle" font-size="8" fill="${cMuted}">annotation #</text>
        </svg></div>
        <div class="saturation-stats">
            <div class="saturation-stat"><span>${maxT}</span><small>${_analysisRollup === 'root' ? 'top-level themes used' : 'themes used (as coded)'}</small></div>
            <div class="saturation-stat"><span>#${lastNew + 1} / ${data.length}</span><small>last new theme introduced at</small></div>
            <div class="saturation-stat"><span>${sinceLastNew}</span><small>annotations since, criterion &ge; ${window}</small></div>
            <div class="saturation-stat"><span style="color:${tooSmall ? 'var(--text-muted)' : isSat ? '#22c55e' : 'var(--accent)'}">${
                tooSmall ? 'Too early' : isSat ? 'Saturated' : 'In progress'}</span><small>${
                tooSmall ? `need ≥ 15 annotations to judge (have ${data.length})`
                : isSat ? `no new theme in the last ${sinceLastNew} annotations`
                : `${window - sinceLastNew} more without a new theme to qualify`}</small></div>
        </div>`;
}

function _chartSentiment(items, options = {}) {
    if (!items.length) return `<div class="analysis-card-header"><span>${icon('smile')} Annotation Sentiment</span></div><p class="analysis-empty">No annotations yet.</p>`;
    let manualCount = 0;
    const tagged = items.map(a => {
        if (a.sentiment) { manualCount++; return { ...a, _sent: a.sentiment, _manual: true }; }
        // null = nothing in this annotation could be scored, reported as its own
        // category rather than silently counted as neutral.
        return { ...a, _sent: _scoreSentiment(_analysisText(a)) || 'none', _manual: false };
    });

    const pos = tagged.filter(a => a._sent === 'pos').length;
    const neg = tagged.filter(a => a._sent === 'neg').length;
    const neu = tagged.filter(a => a._sent === 'neu').length;
    const none = tagged.filter(a => a._sent === 'none').length;
    const total = tagged.length;
    const inferred = total - manualCount;

    // The inferred score reads the quote and your note together, so a critical
    // note ("weak evidence") makes the passage itself look negative. Say so.
    const parts = [];
    if (manualCount) parts.push(`${manualCount} manually flagged`);
    if (inferred) parts.push(`${inferred} keyword-scored from quote + note`);
    const sourceNote = parts.join(' · ') || 'no annotations to score';
    const coverageWarning = none
        ? `<small class="analysis-warn">${none} of ${total} contained no word this lexicon knows (English + Indonesian) — shown as "not scored", not as neutral.</small>`
        : '';

    const cx = 50, cy = 50, r = 36, sw = 14, circ = 2 * Math.PI * r;
    const segs = [
        { label: 'Positive', count: pos, color: '#22c55e' },
        { label: 'Neutral', count: neu, color: '#94a3b8' },
        { label: 'Negative', count: neg, color: '#ef4444' },
        { label: 'Not scored', count: none, color: '#475569' },
    ].filter(s => s.count > 0);
    let off = 0;
    segs.forEach(s => { s.dash = s.count / total * circ; s.offset = off; off += s.dash; });

    const themeScores = {};
    tagged.forEach(a => (a.tags || []).forEach(t => {
        if (!themeScores[t.tag_id]) themeScores[t.tag_id] = { ...t, pos: 0, neg: 0, neu: 0, none: 0, total: 0 };
        themeScores[t.tag_id][a._sent]++; themeScores[t.tag_id].total++;
    }));
    const allSentimentThemes = Object.values(themeScores).sort((a, b) => b.total - a.total);
    const themes = allSentimentThemes.slice(0, 8);

    const cBgTertiary = _cssVar('--bg-tertiary', '#162d5a');
    const exportBtnSentiment = `<div class="analysis-export-actions">
        <button class="analysis-export-chip" type="button" onclick="exportProjectSentimentData()" title="Download as CSV">${icon('table-2')} Data</button>
        <button class="analysis-export-chip" type="button" onclick="exportProjectSentimentSvg()" title="Download as SVG">${icon('file-code')} SVG</button>
        <button class="analysis-export-chip" type="button" onclick="exportProjectSentimentPng()" title="Download as PNG">${icon('image')} PNG</button>
    </div>`;
    return `
        <div class="analysis-card-header"><span>${icon('smile')} Annotation Sentiment</span><small>${sourceNote}</small>${coverageWarning}${exportBtnSentiment}</div>
        <div class="sentiment-wrap">
            <div class="analysis-donut-wrap" style="flex-shrink:0">
                <svg viewBox="0 0 100 100" width="100" height="100">
                    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${cBgTertiary}" stroke-width="${sw}"/>
                    ${segs.map(s => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${s.color}" stroke-width="${sw}"
                        stroke-dasharray="${s.dash.toFixed(2)} ${(circ - s.dash).toFixed(2)}"
                        stroke-dashoffset="${(-s.offset).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})">
                        <title>${s.label}: ${s.count}</title></circle>`).join('')}
                    <text x="${cx}" y="${cy + 4}" text-anchor="middle" class="analysis-donut-label">${total}</text>
                </svg>
                <div class="analysis-legend">${segs.map(s => `
                    <div class="analysis-legend-item">
                        <span class="analysis-legend-dot" style="background:${s.color}"></span>
                        <span>${s.label}</span>
                        <span class="analysis-legend-count">${s.count} · ${(s.count / total * 100).toFixed(0)}%</span>
                    </div>`).join('')}
                </div>
            </div>
            ${themes.length ? `<div class="sentiment-theme-list">
                <div class="sentiment-theme-header"><small>Per-theme sentiment</small>${_analysisRollupNote()}${_shownOf(themes.length, allSentimentThemes.length, 'themes')}</div>
                ${themes.map(t => {
                    const pw = (t.pos / t.total * 100).toFixed(0);
                    const nw = (t.neg / t.total * 100).toFixed(0);
                    const xw = (t.none / t.total * 100).toFixed(0);
                    const uw = Math.max(0, 100 - +pw - +nw - +xw);
                    return `<div class="sentiment-theme-row">
                        <span class="sentiment-theme-name" style="color:${t.color || 'var(--accent)'}">${escapeHtml(t.name)}</span>
                        <div class="sentiment-bar-stack">
                            ${pw > 0 ? `<div style="width:${pw}%;background:#22c55e" title="${t.pos} positive"></div>` : ''}
                            ${uw > 0 ? `<div style="width:${uw}%;background:#94a3b8" title="${t.neu} neutral"></div>` : ''}
                            ${nw > 0 ? `<div style="width:${nw}%;background:#ef4444" title="${t.neg} negative"></div>` : ''}
                            ${xw > 0 ? `<div style="width:${xw}%;background:#475569" title="${t.none} not scored"></div>` : ''}
                        </div>
                        <span class="sentiment-theme-total">${t.total}</span>
                    </div>`;
                }).join('')}
            </div>` : ''}
        </div>`;
}

function _chartTFIDF(items, options = {}) {
    const themeCorpus = {};
    items.forEach(a => {
        const words = _contentWords(_analysisText(a));
        (a.tags || []).forEach(t => {
            if (!themeCorpus[t.tag_id]) themeCorpus[t.tag_id] = { ...t, words: [] };
            themeCorpus[t.tag_id].words.push(...words);
        });
    });

    /* Every theme with enough text forms the corpus the IDF is measured
       against.  Selecting six *first* and computing IDF over only those made
       "distinctive" mean "distinctive among an arbitrary six", and because
       object keys that look like integers iterate numerically, that six was
       whichever themes happened to have the lowest ids — not the largest.  Now
       IDF spans the whole corpus and the six shown are simply the six with the
       most coded text. */
    const corpus = Object.values(themeCorpus).filter(t => t.words.length >= 5);
    if (!corpus.length) return `<div class="analysis-card-header"><span>${icon('zap')} TF-IDF per Theme</span></div><p class="analysis-empty">Need at least 5 coded annotations across themes to compute TF-IDF.</p>`;

    const N = corpus.length;
    const wordDocFreq = {};
    corpus.forEach(t => { new Set(t.words).forEach(w => { wordDocFreq[w] = (wordDocFreq[w] || 0) + 1; }); });

    const themes = [...corpus].sort((a, b) => b.words.length - a.words.length).slice(0, 6);

    themes.forEach(t => {
        const tf = {};
        t.words.forEach(w => { tf[w] = (tf[w] || 0) + 1; });
        const total = t.words.length;
        t.tfidf = Object.entries(tf)
            .map(([w, f]) => ({ w, score: (f / total) * Math.log((N + 1) / (wordDocFreq[w] || 1)) }))
            .filter(x => x.score > 0.0001).sort((a, b) => b.score - a.score).slice(0, 6);
        t.maxScore = t.tfidf[0]?.score || 1;
    });

    const exportBtnTFIDF = `<div class="analysis-export-actions">
        <button class="analysis-export-chip" type="button" onclick="exportProjectTFIDFData()" title="Download as CSV">${icon('table-2')} Data</button>
        <button class="analysis-export-chip" type="button" onclick="exportProjectTFIDFSvg()" title="Download as SVG">${icon('file-code')} SVG</button>
        <button class="analysis-export-chip" type="button" onclick="exportProjectTFIDFPng()" title="Download as PNG">${icon('image')} PNG</button>
    </div>`;
    return `
        <div class="analysis-card-header"><span>${icon('zap')} TF-IDF per Theme</span><small>most distinctive words per theme, measured against all ${N} themes with enough text${themes.length < N ? ` · showing the ${themes.length} largest` : ''}</small>${exportBtnTFIDF}</div>
        <div class="tfidf-grid">
            ${themes.map(t => `
            <div class="tfidf-theme-block">
                <div class="tfidf-theme-name"><span class="tfidf-dot" style="background:${t.color || 'var(--accent)'}"></span><span style="color:${t.color || 'var(--accent)'}">${escapeHtml(t.name)}</span></div>
                <div class="analysis-bars">${t.tfidf.map(({ w, score }) => `
                    <div class="analysis-bar-row analysis-drill" role="button" tabindex="0"
                         title="Show “${escapeHtml(w)}” within ${escapeHtml(t.name)}"
                         onclick="drillIntoWord('${escapeJs(w)}', ${t.tag_id})">
                        <span class="analysis-bar-label">${escapeHtml(w)}</span>
                        <div class="analysis-bar-track">
                            <div class="analysis-bar-fill" style="width:${(score / t.maxScore * 100).toFixed(1)}%;background:${t.color || 'var(--accent)'}"></div>
                        </div>
                    </div>`).join('')}
                </div>
            </div>`).join('')}
        </div>`;
}

function _chartIRR() {
    const data = appState._irrData;
    return `
        <div class="analysis-card-header"><span>${icon('users')} Inter-rater Reliability (Cohen's κ)</span><small>compare your coding against a second coder's JSON export</small></div>
        ${data ? _renderKappaResults(data) : `
        <div class="irr-instructions">
            <p style="margin:0 0 8px;color:var(--text-secondary);font-size:0.85rem">Export annotations via <strong>Export → JSON</strong>, share with a colleague, ask them to recode the same set, then paste their JSON export below.</p>
            <textarea class="irr-paste-area" id="irr-paste" placeholder='[{"annotation_id":1,"tags":[{"tag_id":5,"name":"Theme"}]}, ...]' rows="4"></textarea>
            <div style="display:flex;gap:8px;align-items:center;margin-top:6px">
                <button class="btn-secondary" style="font-size:0.8rem;padding:4px 12px" onclick="computeIRR()">Compute κ</button>
                ${appState._irrError ? `<span style="color:#ef4444;font-size:0.8rem">${escapeHtml(appState._irrError)}</span>` : ''}
            </div>
        </div>`}`;
}

function computeIRR() {
    const ta = document.getElementById('irr-paste');
    if (!ta) return;
    try {
        const text = ta.value.trim();
        if (!text) throw new Error('Paste the second coder\'s JSON export first.');
        const raw = JSON.parse(text);
        if (!Array.isArray(raw)) throw new Error('Expected a JSON array.');
        // Both coders are folded to the same level the dashboard is displaying,
        // so κ answers the same question as the charts around it.
        const rootOf = _analysisRollup === 'root' ? _rootTagIndex() : null;
        const coder2 = {};
        raw.forEach(a => {
            coder2[a.annotation_id] = new Set((a.tags || []).map(t => _rollupTagId(t.tag_id, rootOf)));
        });
        const items = _rollupItems(_filteredAnnotations());
        const shared = items.filter(a => coder2[a.annotation_id] !== undefined);
        if (shared.length < 5) throw new Error(`Only ${shared.length} matching annotations — need at least 5.`);

        // Annotations one coder has and the other does not are disagreements
        // about *what* to code, which κ cannot see. Report them rather than
        // dropping them silently.
        const mineOnly = items.length - shared.length;
        const theirsOnly = Object.keys(coder2)
            .filter(id => !items.some(a => String(a.annotation_id) === String(id))).length;

        const allTagIds = new Set();
        items.forEach(a => (a.tags || []).forEach(t => allTagIds.add(t.tag_id)));
        Object.values(coder2).forEach(tags => tags.forEach(id => allTagIds.add(id)));
        const tagList = appState.allTags.filter(t => allTagIds.has(t.tag_id));
        const results = tagList.map(tag => {
            let a11 = 0, a10 = 0, a01 = 0, a00 = 0;
            shared.forEach(a => {
                const r1 = (a.tags || []).some(t => t.tag_id === tag.tag_id) ? 1 : 0;
                const r2 = coder2[a.annotation_id]?.has(tag.tag_id) ? 1 : 0;
                if (r1 && r2) a11++; else if (r1) a10++; else if (r2) a01++; else a00++;
            });
            const n = shared.length;
            const po = (a11 + a00) / n;
            const pe = ((a11 + a10) / n) * ((a11 + a01) / n) + ((a01 + a00) / n) * ((a10 + a00) / n);
            const kappa = pe >= 1 ? 1 : (po - pe) / (1 - pe);
            /* Krippendorff's α for the same binary decision.  κ and α disagree
               exactly where it matters — α uses one pooled distribution of all
               values rather than each coder's own marginals, so it is less
               flattered by two coders who share the same bias, and it is what
               reviewers increasingly ask for.  Nominal α with two coders and no
               missing values:
                 D_o = disagreeing units / units
                 D_e = 2·n₁·n₀ / (N·(N−1)),  N = 2·units                     */
            const units = n;
            const disagree = a10 + a01;
            const ones = 2 * a11 + a10 + a01;      // all "code applied" values
            const N = 2 * units;
            const zeros = N - ones;
            const Do = disagree / units;
            const De = N > 1 ? (2 * ones * zeros) / (N * (N - 1)) : 0;
            const alpha = De > 0 ? 1 - Do / De : 1;

            // Instances = annotations either coder assigned this code. It is the
            // weight for the summary and the warning flag for unstable codes.
            return { tag, kappa, alpha, n1: a11 + a10, n2: a11 + a01, instances: a11 + a10 + a01, agreed: a11 };
        }).filter(r => r.n1 > 0 || r.n2 > 0).sort((a, b) => b.kappa - a.kappa);

        appState._irrData = { results, shared: shared.length, mineOnly, theirsOnly, rollup: _analysisRollup };
        appState._irrError = null;
    } catch (e) {
        const msg = e instanceof SyntaxError ? 'Invalid JSON — make sure you paste the full export without modification.' : e.message;
        appState._irrError = msg;
        appState._irrData = null;
    }
    renderAnalysisDashboard();
}

const IRR_MIN_INSTANCES = 10;   // below this a per-code κ is too unstable to read

function _renderKappaResults({ results, shared, mineOnly = 0, theirsOnly = 0 }) {
    /* The headline used to be a plain mean over codes, so a code applied to one
       annotation moved it as much as a code applied to two hundred: perfect
       agreement on 100 annotations plus one disputed rare code reported as
       κ=0.495, "Moderate". Weight by how often each code was actually used, and
       show the unweighted figure beside it rather than instead of it. */
    const totalInstances = results.reduce((s, r) => s + r.instances, 0);
    const weighted = totalInstances
        ? results.reduce((s, r) => s + r.kappa * r.instances, 0) / totalInstances
        : 0;
    const unweighted = results.length ? results.reduce((s, r) => s + r.kappa, 0) / results.length : 0;
    const weightedAlpha = totalInstances
        ? results.reduce((s, r) => s + r.alpha * r.instances, 0) / totalInstances
        : 0;
    const band = k => k >= 0.8 ? ['#22c55e', 'Almost perfect']
                    : k >= 0.6 ? ['#f59e0b', 'Substantial']
                    : k >= 0.4 ? ['#f97316', 'Moderate']
                    : ['#ef4444', 'Fair / Slight'];
    const [kappaColor, kappaLabel] = band(weighted);
    const thin = results.filter(r => r.instances < IRR_MIN_INSTANCES).length;
    const shownRows = results.slice(0, 16);

    return `
        <div class="irr-summary">
            <div class="irr-kappa-big" style="color:${kappaColor}">${weighted.toFixed(3)}</div>
            <div class="irr-kappa-meta">${kappaLabel} · prevalence-weighted across ${results.length} code${results.length !== 1 ? 's' : ''}
                <br><small>Krippendorff's α ${weightedAlpha.toFixed(3)} · unweighted mean κ ${unweighted.toFixed(3)} · ${shared} annotations coded by both</small>
                ${(mineOnly || theirsOnly) ? `<br><small class="irr-warn">κ covers shared annotations only — ${mineOnly} of yours and ${theirsOnly} of theirs have no counterpart, so disagreement about <em>what</em> to code is not measured here.</small>` : ''}
                ${thin ? `<br><small class="irr-warn">${thin} code${thin !== 1 ? 's' : ''} used fewer than ${IRR_MIN_INSTANCES} times — κ is unstable at that prevalence.</small>` : ''}
                <button class="btn-secondary" style="font-size:0.75rem;padding:2px 8px;margin-left:12px" onclick="appState._irrData=null;renderAnalysisDashboard()">Reset</button>
            </div>
        </div>
        ${_shownOf(shownRows.length, results.length, 'codes')}
        <div class="analysis-bars analysis-bars-2col" style="margin-top:10px">
            ${shownRows.map(r => {
                const [c] = band(r.kappa);
                const unstable = r.instances < IRR_MIN_INSTANCES;
                return `<div class="analysis-bar-row"${unstable ? ' title="Too few instances for a stable κ"' : ''}>
                    <span class="analysis-bar-label" style="color:${r.tag.color || 'var(--accent)'}">${escapeHtml(r.tag.name)}${unstable ? ' <span class="irr-thin-flag">⚠</span>' : ''}</span>
                    <div class="analysis-bar-track">
                        <div class="analysis-bar-fill" style="width:${(Math.max(0, r.kappa) * 100).toFixed(1)}%;background:${c};${unstable ? 'opacity:.45' : ''}"></div>
                    </div>
                    <span class="analysis-bar-count" style="color:${c}">${r.kappa.toFixed(2)}<small class="irr-n"> α ${r.alpha.toFixed(2)} · n=${r.instances}</small></span>
                </div>`;
            }).join('')}
        </div>`;
}

function renderAnnotationCard(a) {
    const typeIconMap = { underline: 'underline', comment: 'message-square', area: 'square' };
    const typeIcon = typeIconMap[a.annotation_type] || 'highlighter';
    const tags = a.tags || [];
    const tagsHtml = tags.map(t => renderTagChip(t, false)).join('');
    const isSelected = appState.annotationsViewSelected.has(a.annotation_id);
    const docTitle = a.item_title ? escapeHtml(a.item_title.slice(0, 50)) + (a.item_title.length > 50 ? '…' : '') : a.item_key;

    return `
    <div class="ann-card">
        <input type="checkbox" class="ann-card-select" data-id="${a.annotation_id}" ${isSelected ? 'checked' : ''}>
        <div class="ann-card-color-bar" style="background:${a.color || '#ccc'}"></div>
        <div class="ann-card-body">
            ${a.quote ? `<div class="ann-card-quote">"${escapeHtml(a.quote.slice(0, 220))}${a.quote.length > 220 ? '…' : ''}"</div>` : ''}
            ${a.comment ? `<div class="ann-card-note">${escapeHtml(a.comment)}</div>` : ''}
            <div class="ann-card-footer">
                <span class="ann-card-page">p.${(a.page_index || 0) + 1}</span>
                <span class="ann-card-doc" title="${escapeHtml(a.item_title || a.item_key)}">${docTitle}</span>
                ${tagsHtml}
                <button class="ann-card-doc-link" onclick="openPreviewFromAnnotation('${escapeJs(a.item_key)}', ${a.page_index + 1})" title="Open in PDF">${icon('external-link')} Open PDF</button>
            </div>
        </div>
        <div class="ann-card-actions">
            <button class="ann-card-btn" onclick="openProjectAssignModal('annotation', ${a.annotation_id})" title="Add to project">${icon('folder-plus')}</button>
            <button class="ann-card-btn" onclick="suggestThemesForAnnotation(${a.annotation_id})" title="Suggest themes">${icon('sparkles')}</button>
            <button class="ann-card-btn" onclick="openNoteDrawerFromCard(${a.annotation_id})" title="Edit note">${icon('pencil')}</button>
            <button class="ann-card-btn danger" onclick="deleteAnnotationFromCard(${a.annotation_id})" title="Delete">${icon('trash-2')}</button>
        </div>
    </div>`;
}

async function openNoteDrawerFromCard(annotationId) {
    // Load the annotation's item first if it's not the current preview
    const ann = appState.annotationsViewItems.find(a => a.annotation_id === annotationId)
        || appState.activeProject?.annotations?.find(a => a.annotation_id === annotationId);
    if (!ann) return;

    // Sync into appState.annotations so openNoteDrawer can find it
    if (!appState.annotations.find(a => a.annotation_id === annotationId)) {
        await loadAnnotations(ann.item_key);
    }
    openNoteDrawer(annotationId);
}

async function deleteAnnotationFromCard(annotationId) {
    if (!confirm('Delete this annotation?')) return;
    try {
        await deleteAnnotationById(annotationId);
        appState.annotationsViewItems = appState.annotationsViewItems.filter(a => a.annotation_id !== annotationId);
        appState.annotationsViewSelected.delete(annotationId);
        if (appState.previewItem) await loadAnnotations(appState.previewItem.item_key);
        renderAnnotationsView();
    } catch (err) {
        console.error('Delete annotation from card error:', err);
    }
}

async function openPreviewFromAnnotation(itemKey, pageNum) {
    setCenterView('citation');
    await openPreview(itemKey);
    if (pageNum) setTimeout(() => scrollToPage(pageNum, true), 800);
}

async function synthesizeSelectedAnnotations() {
    if (appState.annotationsViewSelected.size === 0) return;

    const selected = appState.annotationsViewItems.filter(a => appState.annotationsViewSelected.has(a.annotation_id));
    if (selected.length === 0) return;

    const synthBtn = document.getElementById('annotations-synthesize-btn');
    if (synthBtn) { synthBtn.disabled = true; synthBtn.innerHTML = icon('loader-2') + ' Synthesizing…'; }

    const snippets = selected.map(a => {
        const lines = [];
        if (a.item_title) lines.push(`[Source: ${a.item_title}${a.item_year ? ` (${a.item_year})` : ''}, p.${(a.page_index || 0) + 1}]`);
        if (a.quote) lines.push(`Quote: "${a.quote}"`);
        if (a.comment) lines.push(`Note: ${a.comment}`);
        if (a.tags?.length) lines.push(`Tags: ${a.tags.map(t => '#' + t.name).join(', ')}`);
        return lines.join('\n');
    }).join('\n\n---\n\n');

    const prompt = `You are a research assistant. Synthesize the following reading annotations into a coherent, well-structured summary. Identify key themes, connections between ideas, and any tensions or gaps. Write in academic prose.\n\n${snippets}`;

    const content = document.getElementById('annotations-view-content');
    const resultId = 'synthesis-result-' + Date.now();

    // Prepend a result block
    const resultBlock = document.createElement('div');
    resultBlock.id = resultId;
    resultBlock.innerHTML = `
        <div class="synthesis-result">
            <div class="synthesis-result-header">${icon('sparkles')} Synthesis of ${selected.length} annotation${selected.length > 1 ? 's' : ''}</div>
            <div id="${resultId}-text" style="color:var(--text-muted);font-style:italic">Generating…</div>
        </div>`;
    content.prepend(resultBlock);

    try {
        const res = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: prompt,
                session_id: null,
                use_rag: false,
                stream: false,
            }),
        });
        const data = await res.json();
        const text = data.reply || data.message || 'No response.';
        const textEl = document.getElementById(`${resultId}-text`);
        if (textEl) { textEl.style.fontStyle = ''; textEl.style.color = ''; textEl.textContent = text; }
    } catch (err) {
        const textEl = document.getElementById(`${resultId}-text`);
        if (textEl) textEl.textContent = 'Synthesis failed: ' + err.message;
    } finally {
        if (synthBtn) {
            synthBtn.disabled = false;
            synthBtn.innerHTML = icon('sparkles') + ' Synthesize';
            refreshIcons(synthBtn);
        }
    }
}
