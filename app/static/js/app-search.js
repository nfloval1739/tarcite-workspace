/* ── TarCite Workspace - Global Search Palette (Cmd/Ctrl+K) ─────────────── */

let _searchDebounceTimer = null;
let _searchActiveIndex = -1;
let _searchResults = [];   // flat list of {type, data} for keyboard navigation

function initGlobalSearch() {
    document.addEventListener('keydown', e => {
        const isMac = navigator.platform.toUpperCase().includes('MAC');
        const trigger = isMac ? (e.metaKey && e.key === 'k') : (e.ctrlKey && e.key === 'k');
        if (trigger && !e.shiftKey) {
            e.preventDefault();
            toggleSearchPalette();
        }
    });

    document.getElementById('search-palette-input')?.addEventListener('input', e => {
        clearTimeout(_searchDebounceTimer);
        _searchDebounceTimer = setTimeout(() => runSearch(e.target.value), 200);
    });

    document.getElementById('search-palette-input')?.addEventListener('keydown', e => {
        if (e.key === 'ArrowDown') { e.preventDefault(); moveSearchCursor(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); moveSearchCursor(-1); }
        else if (e.key === 'Enter') { e.preventDefault(); activateSearchCursor(); }
        else if (e.key === 'Escape') { closeSearchPalette(); }
    });
}

function toggleSearchPalette() {
    const el = document.getElementById('search-palette');
    if (!el) return;
    el.classList.contains('hidden') ? openSearchPalette() : closeSearchPalette();
}

function openSearchPalette() {
    const el = document.getElementById('search-palette');
    if (!el) return;
    el.classList.remove('hidden');
    _searchActiveIndex = -1;
    _searchResults = [];
    const input = document.getElementById('search-palette-input');
    if (input) {
        input.value = '';
        input.focus();
    }
    document.getElementById('search-palette-results').innerHTML =
        '<div class="search-palette-empty">Type to search library, annotations, projects, and themes…</div>';
}

function closeSearchPalette() {
    document.getElementById('search-palette')?.classList.add('hidden');
    clearTimeout(_searchDebounceTimer);
}

async function runSearch(q) {
    const resultsEl = document.getElementById('search-palette-results');
    if (!resultsEl) return;
    const trimmed = (q || '').trim();
    if (trimmed.length < 2) {
        resultsEl.innerHTML = '<div class="search-palette-empty">Type at least 2 characters…</div>';
        _searchResults = [];
        _searchActiveIndex = -1;
        return;
    }
    try {
        const res = await fetch(`/api/quick-search?q=${encodeURIComponent(trimmed)}&limit=5`);
        if (!res.ok) throw new Error('Search failed');
        const data = await res.json();
        renderSearchResults(data, trimmed);
    } catch (err) {
        resultsEl.innerHTML = '<div class="search-palette-empty">Search error. Try again.</div>';
    }
}

function renderSearchResults(data, q) {
    const resultsEl = document.getElementById('search-palette-results');
    if (!resultsEl) return;

    const { items = [], annotations = [], projects = [], tags = [] } = data;
    const total = items.length + annotations.length + projects.length + tags.length;

    if (total === 0) {
        resultsEl.innerHTML = `<div class="search-palette-empty">No results for "<strong>${escapeHtml(q)}</strong>"</div>`;
        _searchResults = [];
        _searchActiveIndex = -1;
        return;
    }

    _searchResults = [];
    let html = '';

    if (items.length) {
        html += `<div class="search-palette-section">
            <div class="search-palette-section-label">${icon('book-open')} Library</div>`;
        for (const it of items) {
            const idx = _searchResults.length;
            _searchResults.push({ type: 'item', data: it });
            const meta = [it.item_type, it.year].filter(Boolean).join(' · ');
            html += `<div class="search-palette-item" data-idx="${idx}" onclick="activateSearchResult(${idx})">
                <i data-lucide="file-text" class="search-palette-item-icon" aria-hidden="true"></i>
                <div class="search-palette-item-body">
                    <div class="search-palette-item-title">${escapeHtml(it.title || 'Untitled')}</div>
                    ${meta ? `<div class="search-palette-item-meta">${escapeHtml(meta)}</div>` : ''}
                </div>
            </div>`;
        }
        html += '</div>';
    }

    if (annotations.length) {
        html += `<div class="search-palette-section">
            <div class="search-palette-section-label">${icon('highlighter')} Annotations</div>`;
        for (const a of annotations) {
            const idx = _searchResults.length;
            _searchResults.push({ type: 'annotation', data: a });
            const typeIcon = a.annotation_type === 'comment' ? 'message-square' : a.annotation_type === 'underline' ? 'underline' : 'highlighter';
            const meta = [a.item_title, a.page_index != null ? `p.${a.page_index + 1}` : ''].filter(Boolean).join(' · ');
            html += `<div class="search-palette-item" data-idx="${idx}" onclick="activateSearchResult(${idx})">
                <i data-lucide="${typeIcon}" class="search-palette-item-icon" aria-hidden="true"></i>
                <div class="search-palette-item-body">
                    <div class="search-palette-item-title">${escapeHtml(a.snippet || '—')}</div>
                    ${meta ? `<div class="search-palette-item-meta">${escapeHtml(meta)}</div>` : ''}
                </div>
            </div>`;
        }
        html += '</div>';
    }

    if (projects.length) {
        html += `<div class="search-palette-section">
            <div class="search-palette-section-label">${icon('folder-open')} Projects</div>`;
        for (const p of projects) {
            const idx = _searchResults.length;
            _searchResults.push({ type: 'project', data: p });
            const meta = [projectTypeLabel?.(p.project_type), `${p.source_count || 0} source(s)`].filter(Boolean).join(' · ');
            html += `<div class="search-palette-item" data-idx="${idx}" onclick="activateSearchResult(${idx})">
                <i data-lucide="folder-open" class="search-palette-item-icon" aria-hidden="true"></i>
                <div class="search-palette-item-body">
                    <div class="search-palette-item-title">${escapeHtml(p.name || 'Untitled')}</div>
                    ${meta ? `<div class="search-palette-item-meta">${escapeHtml(meta)}</div>` : ''}
                </div>
            </div>`;
        }
        html += '</div>';
    }

    if (tags.length) {
        html += `<div class="search-palette-section">
            <div class="search-palette-section-label">${icon('tag')} Themes</div>`;
        for (const t of tags) {
            const idx = _searchResults.length;
            _searchResults.push({ type: 'tag', data: t });
            html += `<div class="search-palette-item" data-idx="${idx}" onclick="activateSearchResult(${idx})">
                <span class="search-palette-item-dot" style="background:${escapeHtml(t.color || '#888')}"></span>
                <div class="search-palette-item-body">
                    <div class="search-palette-item-title">${escapeHtml(t.name)}</div>
                    <div class="search-palette-item-meta">${t.annotation_count || 0} annotation(s)</div>
                </div>
            </div>`;
        }
        html += '</div>';
    }

    resultsEl.innerHTML = html;
    refreshIcons(resultsEl);
    _searchActiveIndex = -1;
}

function moveSearchCursor(dir) {
    if (!_searchResults.length) return;
    const items = document.querySelectorAll('#search-palette-results .search-palette-item');
    if (!items.length) return;

    items[_searchActiveIndex]?.classList.remove('active');
    _searchActiveIndex = Math.max(0, Math.min(_searchResults.length - 1, _searchActiveIndex + dir));
    const target = items[_searchActiveIndex];
    if (target) {
        target.classList.add('active');
        target.scrollIntoView({ block: 'nearest' });
    }
}

function activateSearchCursor() {
    if (_searchActiveIndex >= 0 && _searchActiveIndex < _searchResults.length) {
        activateSearchResult(_searchActiveIndex);
    }
}

function activateSearchResult(idx) {
    const result = _searchResults[idx];
    if (!result) return;
    closeSearchPalette();

    const { type, data } = result;

    if (type === 'item') {
        _switchSidebarTab('library');
        openPreview(data.item_key);
    } else if (type === 'annotation') {
        _switchSidebarTab('notes');
        openPreview(data.item_key);
    } else if (type === 'project') {
        _switchSidebarTab('projects');
        selectProject(data.project_id);
    } else if (type === 'tag') {
        _switchSidebarTab('notes');
        if (typeof filterByTagChip === 'function') filterByTagChip(data.tag_id);
    }
}

function _switchSidebarTab(tabName) {
    const btn = document.querySelector(`.sidebar-tab[data-tab="${tabName}"]`);
    if (btn && !btn.classList.contains('active')) btn.click();
}
