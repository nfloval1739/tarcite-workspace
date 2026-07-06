/* ── TarCite Workspace - Library, Uploads, and Metadata ────────────────── */

/* ── Library ───────────────────────────────────────────────────────────────── */

function initLibrarySearch() {
    document.getElementById('library-search').addEventListener('input', debounce(loadLibraryTree, 300));
    document.getElementById('library-center-search').addEventListener('input', debounce(loadLibraryItems, 300));
    loadLibraryColumnPrefs();
    initLibraryColumnMenu();
    document.querySelectorAll('.library-view-tab').forEach(btn => {
        btn.addEventListener('click', () => switchLibraryActivityFilter(btn.dataset.libraryView || 'all'));
    });
    const sortSelect = document.getElementById('library-sort-select');
    if (sortSelect) {
        sortSelect.addEventListener('change', () => {
            appState.librarySortBy = sortSelect.value;
            loadLibraryItems();
        });
    }
}

function initLibraryColumnMenu() {
    const btn = document.getElementById('library-columns-btn');
    const menu = document.getElementById('library-columns-menu');
    if (!btn || !menu) return;

    btn.addEventListener('click', (event) => {
        event.stopPropagation();
        const opening = menu.classList.contains('hidden');
        renderLibraryColumnMenu();
        menu.classList.toggle('hidden', !opening);
        btn.setAttribute('aria-expanded', opening ? 'true' : 'false');
        refreshIcons(menu);
    });

    document.addEventListener('click', (event) => {
        if (menu.classList.contains('hidden')) return;
        if (menu.contains(event.target) || btn.contains(event.target)) return;
        menu.classList.add('hidden');
        btn.setAttribute('aria-expanded', 'false');
    });
}

function switchLibraryActivityFilter(filter) {
    appState.libraryActivityFilter = filter || 'all';
    document.querySelectorAll('.library-view-tab').forEach(btn => {
        btn.classList.toggle('active', (btn.dataset.libraryView || 'all') === appState.libraryActivityFilter);
    });
    closeMetadataEditor();
    document.getElementById('item-detail-panel')?.classList.add('hidden');
    if (appState.libraryActivityFilter === 'recent') {
        appState.librarySortBy = 'opened_at';
        appState.librarySortOrder = 'desc';
        const sortSelect = document.getElementById('library-sort-select');
        if (sortSelect) sortSelect.value = 'opened_at';
    } else if (!['related', 'health', 'mindmap'].includes(appState.libraryActivityFilter) && appState.librarySortBy === 'opened_at') {
        appState.librarySortBy = 'title';
        appState.librarySortOrder = 'asc';
    }
    loadLibraryItems();
}

function updateRelatedTab() {
    const tab = document.getElementById('library-related-tab');
    if (!tab) return;
    const hasItem = !!appState.previewItem?.item_key;
    tab.classList.toggle('hidden', !hasItem);
    if (!hasItem && appState.libraryActivityFilter === 'related') {
        switchLibraryActivityFilter('all');
    }
}

function initFileUpload() {
    const dropZone = document.getElementById('library-drop-zone');
    const addMenuBtn = document.getElementById('library-add-btn');
    const addMenu = document.getElementById('library-add-menu');
    const addFileBtn = document.getElementById('add-file-btn');
    const addDirectoryBtn = document.getElementById('add-directory-btn');
    const uploadModal = document.getElementById('upload-modal');
    const uploadBtn = document.getElementById('upload-file-btn');
    const fileInput = document.getElementById('upload-file-input');
    const dirSelect = document.getElementById('upload-dir-select');
    const subfolderRow = document.getElementById('upload-subfolder-row');
    const subfolderSelect = document.getElementById('upload-subfolder-select');

    if (dropZone) {
        ['dragenter', 'dragover'].forEach(evt => {
            dropZone.addEventListener(evt, e => {
                e.preventDefault();
                e.stopPropagation();
                dropZone.classList.add('drag-over');
            });
        });
        ['dragleave', 'drop'].forEach(evt => {
            dropZone.addEventListener(evt, e => {
                e.preventDefault();
                e.stopPropagation();
                dropZone.classList.remove('drag-over');
            });
        });
        dropZone.addEventListener('drop', e => {
            const files = e.dataTransfer.files;
            if (files.length > 0) {
                openUploadModal(files);
            }
        });
    }

    const closeAddMenu = () => {
        if (!addMenu || !addMenuBtn) return;
        addMenu.classList.add('hidden');
        addMenuBtn.setAttribute('aria-expanded', 'false');
    };

    if (addMenuBtn && addMenu) {
        addMenuBtn.addEventListener('click', e => {
            e.stopPropagation();
            const opening = addMenu.classList.contains('hidden');
            addMenu.classList.toggle('hidden', !opening);
            addMenuBtn.setAttribute('aria-expanded', String(opening));
        });
        document.addEventListener('click', e => {
            if (!addMenu.classList.contains('hidden') && !e.target.closest('.library-add-wrap')) closeAddMenu();
        });
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape') closeAddMenu();
        });
    }

    if (addFileBtn) {
        addFileBtn.addEventListener('click', () => {
            closeAddMenu();
            openUploadModal();
        });
    }

    if (addDirectoryBtn) {
        addDirectoryBtn.addEventListener('click', () => {
            closeAddMenu();
            openDirectoryModal();
        });
    }

    if (dirSelect) {
        dirSelect.addEventListener('change', () => loadSubfolders(dirSelect.value));
    }

    if (uploadBtn) {
        uploadBtn.addEventListener('click', () => doUpload());
    }

    function normaliseUploadFiles(value) {
        if (!value) return [];
        if (value.name && value.size !== undefined) return [value];
        return Array.from(value).filter(file => file && file.name && file.size !== undefined);
    }

    window.openUploadModal = function(prefillFiles) {
        // Pre-select the folder the user is currently viewing, so they don't
        // have to re-navigate to where they already are.
        populateUploadDirs(appState.activeSourceDir || '', appState.activeCollectionKey || '');
        fileInput.value = '';
        const files = normaliseUploadFiles(prefillFiles);
        if (files.length > 0) {
            const dt = new DataTransfer();
            files.forEach(file => dt.items.add(file));
            fileInput.files = dt.files;
        }
        setInlineResult('upload-msg', '');
        openModal('upload-modal');
    };

    async function populateUploadDirs(preselectDir, preselectCollectionKey) {
        try {
            const res = await fetch('/api/directories');
            const data = await res.json();
            const dirs = data.directories || [];
            dirSelect.innerHTML = dirs.map(d => `<option value="${escapeHtml(d.path)}">${escapeHtml(d.label || d.path)}</option>`).join('');
            // Default to the directory the user is currently in, else the first one.
            let chosen = '';
            if (preselectDir && dirs.some(d => d.path === preselectDir)) {
                chosen = preselectDir;
                dirSelect.value = preselectDir;
            } else if (dirs.length > 0) {
                chosen = dirs[0].path;
            }
            if (chosen) {
                loadSubfolders(chosen, chosen === preselectDir ? preselectCollectionKey : '');
            }
        } catch (err) {
            dirSelect.innerHTML = '<option value="">No directories configured</option>';
        }
    }

    async function loadSubfolders(dirPath, preselectCollectionKey) {
        if (!dirPath) {
            subfolderRow.classList.add('hidden');
            return;
        }
        try {
            const res = await fetch(`/api/directories/${encodeURIComponent(dirPath)}/subfolders`);
            const data = await res.json();
            const folders = data.folders || [];
            if (folders.length > 0) {
                subfolderRow.classList.remove('hidden');
                subfolderSelect.innerHTML = '<option value="">Root (no subfolder)</option>' +
                    folders.map(f => {
                        const indent = '    '.repeat(f.depth || 0);
                        return `<option value="${escapeHtml(f.rel_path)}">${indent}${escapeHtml(f.name)}</option>`;
                    }).join('');
                // Pre-select the folder the user is currently viewing.
                if (preselectCollectionKey) {
                    const match = folders.find(f => f.collection_key === preselectCollectionKey);
                    if (match) subfolderSelect.value = match.rel_path;
                }
            } else {
                subfolderRow.classList.add('hidden');
            }
        } catch {
            subfolderRow.classList.add('hidden');
        }
    }

    async function doUpload() {
        const files = Array.from(fileInput.files || []);
        const allowedExtensions = ['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.tif', '.ris', '.bib', '.bibtex', '.txt', '.md', '.markdown', '.csv', '.docx'];
        if (files.length === 0) {
            setInlineResult('upload-msg', 'Select one or more files to upload.', 'error');
            return;
        }
        const unsupported = files.filter(file => {
            const lowerName = file.name.toLowerCase();
            return !allowedExtensions.some(ext => lowerName.endsWith(ext));
        });
        if (unsupported.length > 0) {
            const names = unsupported.slice(0, 3).map(file => file.name).join(', ');
            const extra = unsupported.length > 3 ? ` and ${unsupported.length - 3} more` : '';
            setInlineResult('upload-msg', `Unsupported file type: ${names}${extra}. Supported: PDF, images (PNG/JPG/WebP/GIF/BMP/TIFF), RIS, BibTeX, TXT, MD, CSV, DOCX.`, 'error');
            return;
        }
        const targetDir = dirSelect.value;
        if (!targetDir) {
            setInlineResult('upload-msg', 'Select a target directory.', 'error');
            return;
        }
        const subfolder = subfolderSelect.value;
        const finalDir = subfolder ? `${targetDir}/${subfolder}` : targetDir;

        setInlineResult('upload-msg', files.length === 1 ? 'Uploading file...' : `Uploading ${files.length} files...`);
        uploadBtn.disabled = true;

        try {
            const formData = new FormData();
            files.forEach(file => formData.append('files', file));
            const res = await fetch(`/api/upload-files?target_dir=${encodeURIComponent(finalDir)}`, {
                method: 'POST',
                body: formData,
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.detail || 'Upload failed');
            const savedCount = data.count || files.length;

            loadLibraryTree({ force: true });
            loadLibraryItems();
            setInlineResult('upload-msg', `${savedCount} file${savedCount === 1 ? '' : 's'} saved — indexing in background…`, 'success');
            fileInput.value = '';
            setTimeout(() => {
                closeModal('upload-modal');
                // Go back to All Libraries so nothing disappears
                appState.activeCollectionKey = '';
                appState.activeSourceDir = '';
                appState.activeSourceDirLabel = '';
                loadLibraryTree({ force: true });
                loadLibraryItems();
            }, 1200);
        } catch (err) {
            setInlineResult('upload-msg', `Error: ${err.message}`, 'error');
        } finally {
            uploadBtn.disabled = false;
        }
    }
}

async function loadLibraryTree(options = {}) {
    return dedupeAsync('loadLibraryTree', async () => {
        await loadLibraryStats();
        try {
            const res = await fetch('/api/library/tree');
            const data = await res.json();
            appState.libraryTreeData = data.tree || [];
            renderLibraryTree(data.tree || []);
        } catch (err) {
            console.error('Load library tree error:', err);
        }
    }, options);
}

async function loadLibraryStats() {
    try {
        const res = await fetch('/api/library/stats');
        const data = await res.json();
        appState.libraryStats = data;
        renderLibraryStats(data);
    } catch (err) {
        console.error('Load library stats error:', err);
    }
}

function renderLibraryStats(data) {
    const summary = document.getElementById('library-stats-summary');
    if (!summary) return;
    summary.innerHTML = `
        <div class="library-stat-pill"><strong>${Number(data.item_count || 0).toLocaleString()}</strong><span>Items</span></div>
        <div class="library-stat-pill"><strong>${Number(data.chunk_count || 0).toLocaleString()}</strong><span>Vector</span></div>
        <div class="library-stat-pill"><strong>${Number(data.fts_chunk_count || 0).toLocaleString()}</strong><span>BM25</span></div>
    `;
}

function renderLibraryTree(dirs) {
    const tree = document.getElementById('library-tree');
    const dirColors = ['dir-icon-1', 'dir-icon-2', 'dir-icon-3', 'dir-icon-4', 'dir-icon-5'];
    const totalItems = dirs.reduce((sum, d) => sum + (d.item_count || 0), 0);
    const isAllActive = appState.activeSourceDir === '' && !appState.activeCollectionKey;

    let html = `
        <div class="tree-item tree-root-item ${isAllActive ? 'active' : ''}" onclick="filterByDir('')">
            <div class="tree-icon all-icon">${icon('book-open')}</div>
            <div class="tree-label">
                <span>All Libraries</span>
                <small>${dirs.length} configured</small>
            </div>
            <span class="count">${totalItems}</span>
        </div>
    `;

    dirs.forEach((d, i) => {
        const sourceDir = d.normalized_path || d.path || '';
        const scanPath = d.path || sourceDir;
        const label = escapeHtml(d.label || (scanPath.split('/').pop() || scanPath));
        const lastSync = d.last_sync?.synced_at ? new Date(d.last_sync.synced_at).toLocaleDateString() : 'Never scanned';
        const isActiveDirOnly = appState.activeSourceDir === sourceDir && !appState.activeCollectionKey;
        const hasCollections = d.collections && d.collections.length > 0;
        const isExpanded = appState.expandedDirs.has(sourceDir);
        const colorClass = dirColors[i % dirColors.length];

        html += `<div class="tree-folder-group">
            <div class="tree-item tree-source ${isActiveDirOnly ? 'active' : ''}"
                 onclick="filterByDir('${escapeJs(sourceDir)}', '${escapeJs(d.label || (scanPath.split('/').pop() || scanPath))}')"
                 oncontextmenu="showFolderContextMenu(event, '${escapeJs(sourceDir)}', true)"
                 data-source-dir="${escapeHtml(sourceDir)}">
                ${hasCollections
                    ? `<button class="tree-expand-btn" onclick="event.stopPropagation(); toggleDirExpand('${escapeJs(sourceDir)}')" aria-label="Toggle">${icon(isExpanded ? 'chevron-down' : 'chevron-right')}</button>`
                    : '<span class="tree-expand-space"></span>'}
                <div class="tree-icon ${colorClass}">${icon('folder')}</div>
                <div class="tree-label">
                    <span>${label}</span>
                    <small>${escapeHtml(lastSync)}</small>
                </div>
                <span class="count">${d.item_count || 0}</span>
                <button class="tree-sync-btn" onclick="event.stopPropagation(); startSync('${escapeJs(scanPath)}')" title="Scan this directory" aria-label="Scan">${icon('refresh-cw')}</button>
                <button class="tree-ctx-btn" onclick="event.stopPropagation(); showFolderContextMenu(event, '${escapeJs(sourceDir)}', true)" title="More actions" aria-label="More">${icon('more-vertical')}</button>
            </div>
            ${hasCollections ? `<div class="tree-children ${isExpanded ? '' : 'hidden'}">
                ${d.collections.map(col => renderCollectionNode(col, sourceDir, 1)).join('')}
            </div>` : ''}
        </div>`;
    });

    tree.innerHTML = html;
    refreshIcons(tree);
}

function renderCollectionNode(col, sourceDir, depth) {
    const hasChildren = col.children && col.children.length > 0;
    const isActive = appState.activeCollectionKey === col.collection_key;
    const isExpanded = appState.expandedCollections.has(col.collection_key);
    const localPath = col.local_path || '';

    return `<div class="tree-folder-group">
        <div class="tree-item tree-collection ${isActive ? 'active' : ''}"
             onclick="filterByCollection('${escapeJs(col.collection_key)}', '${escapeJs(sourceDir)}')"
             oncontextmenu="showFolderContextMenu(event, '${escapeJs(sourceDir)}', false, '${escapeJs(col.collection_key)}', '${escapeJs(col.name)}')"
             data-collection-key="${escapeHtml(col.collection_key)}"
             data-source-dir="${escapeHtml(sourceDir)}"
             data-collection-name="${escapeHtml(col.name)}">
            ${hasChildren
                ? `<button class="tree-expand-btn" onclick="event.stopPropagation(); toggleCollectionExpand('${escapeJs(col.collection_key)}')" aria-label="Toggle">${icon(isExpanded ? 'chevron-down' : 'chevron-right')}</button>`
                : '<span class="tree-expand-space"></span>'}
            <div class="tree-icon">${icon('folder')}</div>
            <div class="tree-label"><span>${escapeHtml(col.name)}</span></div>
            <span class="count">${col.item_count || 0}</span>
            ${localPath ? `<button class="tree-sync-btn" onclick="event.stopPropagation(); startSync('${escapeJs(localPath)}')" title="Scan this folder" aria-label="Scan">${icon('refresh-cw')}</button>` : ''}
            <button class="tree-ctx-btn" onclick="event.stopPropagation(); showFolderContextMenu(event, '${escapeJs(sourceDir)}', false, '${escapeJs(col.collection_key)}', '${escapeJs(col.name)}')" title="More actions" aria-label="More">${icon('more-vertical')}</button>
        </div>
        ${hasChildren ? `<div class="tree-children ${isExpanded ? '' : 'hidden'}">
            ${col.children.map(child => renderCollectionNode(child, sourceDir, depth + 1)).join('')}
        </div>` : ''}
    </div>`;
}

function toggleDirExpand(sourceDir) {
    if (appState.expandedDirs.has(sourceDir)) {
        appState.expandedDirs.delete(sourceDir);
    } else {
        appState.expandedDirs.add(sourceDir);
    }
    loadLibraryTree();
}

function toggleCollectionExpand(collectionKey) {
    if (appState.expandedCollections.has(collectionKey)) {
        appState.expandedCollections.delete(collectionKey);
    } else {
        appState.expandedCollections.add(collectionKey);
    }
    loadLibraryTree();
}

function filterByCollection(collectionKey, sourceDir) {
    appState.activeCollectionKey = collectionKey;
    appState.activeSourceDir = sourceDir || '';
    appState.expandedDirs.add(sourceDir);
    document.getElementById('library-center-search').value = '';
    closeMetadataEditor();
    loadLibraryTree();
    loadLibraryItems();
}

async function loadLibraryItems() {
    if (appState.libraryActivityFilter === 'mindmap') {
        return loadCitationMindMap();
    }
    if (appState.libraryActivityFilter === 'health') {
        return loadLibraryHealth();
    }
    if (appState.libraryActivityFilter === 'related') {
        return loadRelatedItems();
    }
    const query = document.getElementById('library-center-search')?.value || '';
    const sourceDir = appState.activeSourceDir || '';
    try {
        let url = `/api/library/items?q=${encodeURIComponent(query)}&limit=200&sort_by=${encodeURIComponent(appState.librarySortBy)}&sort_order=${encodeURIComponent(appState.librarySortOrder)}`;
        if (sourceDir) url += `&source_dir=${encodeURIComponent(sourceDir)}`;
        if (appState.activeCollectionKey) url += `&collection_key=${encodeURIComponent(appState.activeCollectionKey)}`;
        if (appState.libraryActivityFilter && appState.libraryActivityFilter !== 'all') {
            url += `&activity=${encodeURIComponent(appState.libraryActivityFilter)}`;
        }
        const res = await fetch(url);
        const data = await res.json();
        appState.libraryItems = data.items || [];

        updateLibraryTabCount(data.total || 0);

        const table = document.getElementById('library-center-table');
        const columnTemplate = getLibraryColumnTemplate();
        table.style.minWidth = `${getLibraryTableMinWidth()}px`;
        table.innerHTML = `
            <div class="table-header" style="grid-template-columns:${columnTemplate}">
                <div class="table-action-head"></div>
                ${appState.libraryColumns.map(key => renderSortableHeader(key)).join('')}
            </div>
            ${data.items.map(item => `
                <div class="table-row" style="grid-template-columns:${columnTemplate}" onclick="selectLibraryItem('${escapeJs(item.item_key)}')" oncontextmenu="showItemContextMenu(event, '${escapeJs(item.item_key)}')">
                    <div class="cell cell-actions">
                        <button class="table-icon-btn favorite ${item.is_favorite ? 'active' : ''}" onclick="event.stopPropagation(); toggleFavorite('${escapeJs(item.item_key)}', ${item.is_favorite ? 'false' : 'true'})" title="${item.is_favorite ? 'Remove favorite' : 'Add favorite'}" aria-label="${item.is_favorite ? 'Remove favorite' : 'Add favorite'}">${icon('star')}</button>
                        <button class="table-icon-btn table-menu-btn" onclick="event.stopPropagation(); showItemMenuFromBtn(event, '${escapeJs(item.item_key)}')" title="More actions" aria-label="More actions">${icon('more-vertical')}</button>
                    </div>
                    ${appState.libraryColumns.map(key => renderLibraryCell(key, item)).join('')}
                </div>
            `).join('')}
        `;
        refreshIcons(table);
    } catch (err) {
        console.error('Load items error:', err);
    }
}

async function loadRelatedItems() {
    const itemKey = appState.previewItem?.item_key;
    if (!itemKey) {
        switchLibraryActivityFilter('all');
        return;
    }
    const sourceDir = appState.activeSourceDir || '';
    try {
        let url = `/api/library/related?item_key=${encodeURIComponent(itemKey)}&limit=20`;
        if (sourceDir) url += `&source_dir=${encodeURIComponent(sourceDir)}`;
        const res = await fetch(url);
        const data = await res.json();
        const items = data.items || [];

        updateLibraryTabCount(items.length);

        const table = document.getElementById('library-center-table');
        const colTemplate = '72px 1fr 200px 70px 96px';
        table.style.minWidth = '600px';

        if (items.length === 0) {
            table.innerHTML = `<div style="padding:24px 16px;color:var(--text-muted);font-size:13px;">No related documents found${sourceDir ? ' in this directory' : ''}. Try syncing your library or removing the directory filter.</div>`;
            return;
        }

        table.innerHTML = `
            <div class="table-header" style="grid-template-columns:${colTemplate}">
                <div class="table-action-head"></div>
                <div class="table-head-cell">Title</div>
                <div class="table-head-cell">Authors</div>
                <div class="table-head-cell">Year</div>
                <div class="table-head-cell">Match</div>
            </div>
            ${items.map(item => {
                const pct = Math.round((item.score || 0) * 100);
                const creators = formatCreators(item.creators);
                return `
                <div class="table-row" style="grid-template-columns:${colTemplate}"
                     onclick="selectLibraryItem('${escapeJs(item.item_key)}')"
                     oncontextmenu="showItemContextMenu(event, '${escapeJs(item.item_key)}')">
                    <div class="cell cell-actions">
                        <button class="table-icon-btn table-menu-btn" onclick="event.stopPropagation(); showRelatedItemMenuFromBtn(event, '${escapeJs(item.item_key)}')" title="More actions" aria-label="More actions">${icon('more-vertical')}</button>
                    </div>
                    <div class="cell cell-title">${escapeHtml(item.title || 'Untitled')}</div>
                    <div class="cell">${escapeHtml(creators)}</div>
                    <div class="cell">${escapeHtml(item.year || '—')}</div>
                    <div class="cell"><span class="library-related-score">${pct}%</span></div>
                </div>`;
            }).join('')}
        `;
        refreshIcons(table);
    } catch (err) {
        console.error('Load related items error:', err);
    }
}

async function loadLibraryHealth(options = {}) {
    const table = document.getElementById('library-center-table');
    if (!table) return;
    table.style.minWidth = '760px';
    if (!appState.libraryHealth || options.force) {
        table.innerHTML = `
            <div class="library-health-loading">
                <div class="spinner"></div>
                <span>Scanning library health...</span>
            </div>
        `;
        try {
            const res = await fetch(options.force ? '/api/library/health/scan' : '/api/library/health', {
                method: options.force ? 'POST' : 'GET',
                headers: options.force ? { 'Content-Type': 'application/json' } : undefined,
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.detail || 'Health scan failed');
            appState.libraryHealth = data;
        } catch (err) {
            table.innerHTML = `<div class="library-health-error">Health scan failed: ${escapeHtml(err.message)}</div>`;
            return;
        }
    }
    renderLibraryHealth();
}

function renderLibraryHealth() {
    const table = document.getElementById('library-center-table');
    const data = appState.libraryHealth || {};
    const summary = data.summary || {};
    const totalIssues = summary.total_issues || 0;
    updateLibraryTabCount(totalIssues);
    table.style.minWidth = '760px';

    const sections = [
        { id: 'duplicates', label: 'Duplicate Papers', iconName: 'copy', count: summary.duplicate_groups || 0 },
        { id: 'broken', label: 'Broken File Paths', iconName: 'unlink', count: summary.broken_paths || 0 },
        { id: 'unindexed', label: 'Unindexed PDFs', iconName: 'file-search', count: (summary.unindexed_files || 0) + (summary.indexed_without_chunks || 0) },
    ];
    if (!sections.some(s => s.id === appState.libraryHealthSection)) appState.libraryHealthSection = 'duplicates';

    table.innerHTML = `
        <div class="library-health-view">
            <div class="library-health-header">
                <div>
                    <h3>Library Health</h3>
                    <p>${totalIssues ? `${totalIssues} issue${totalIssues === 1 ? '' : 's'} found` : 'No duplicate, missing-path, or indexing issues found.'}</p>
                </div>
                <button class="btn-small" onclick="refreshLibraryHealth()">${icon('refresh-cw')} Scan Health</button>
            </div>
            <div class="library-health-cards" role="tablist" aria-label="Library health checks">
                ${sections.map(section => `
                    <button
                        type="button"
                        role="tab"
                        aria-selected="${appState.libraryHealthSection === section.id ? 'true' : 'false'}"
                        class="library-health-card ${appState.libraryHealthSection === section.id ? 'active' : ''}"
                        onclick="setLibraryHealthSection('${section.id}')"
                    >
                        <span class="library-health-card-icon">${icon(section.iconName)}</span>
                        <span class="library-health-card-label">${escapeHtml(section.label)}</span>
                        <strong class="library-health-count">${Number(section.count || 0).toLocaleString()}</strong>
                        <span class="library-health-card-arrow">${icon('chevron-right')}</span>
                    </button>
                `).join('')}
            </div>
            ${renderLibraryHealthSection()}
        </div>
    `;
    refreshIcons(table);
}

function renderLibraryHealthSection() {
    const data = appState.libraryHealth || {};
    if (appState.libraryHealthSection === 'broken') return renderBrokenPathHealth(data.broken_paths || []);
    if (appState.libraryHealthSection === 'unindexed') return renderUnindexedHealth(data.unindexed_files || [], data.indexed_without_chunks || []);
    return renderDuplicateHealth(data.duplicates || []);
}

function setLibraryHealthSection(section) {
    appState.libraryHealthSection = section;
    renderLibraryHealth();
}

function openLibraryHealth() {
    appState.libraryActivityFilter = 'health';
    appState.activeSidebarTab = 'library';
    document.querySelectorAll('.sidebar-tab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === 'library');
    });
    document.querySelectorAll('.sidebar-content').forEach(content => content.classList.remove('active'));
    document.getElementById('tab-library')?.classList.add('active');
    setCenterView('library');
    switchLibraryActivityFilter('health');
}

async function refreshLibraryHealth() {
    appState.libraryHealth = null;
    await loadLibraryHealth({ force: true });
    loadLibraryStats();
}

function renderDuplicateHealth(groups) {
    if (!groups.length) {
        return `<div class="library-health-empty">${icon('check-circle')} No duplicate paper groups detected.</div>`;
    }
    return `
        <div class="library-health-section">
            <div class="library-health-section-head">
                <h4>Duplicate Papers</h4>
                <p>Review each group and choose the record to keep. Merge moves app-owned notes, tags, projects, annotations, and history onto the kept record.</p>
            </div>
            ${groups.map((group, index) => `
                <div class="health-duplicate-group">
                    <div class="health-group-head">
                        <span>${escapeHtml(healthMatchLabel(group.match_type))}</span>
                        <small>${group.items.length} records</small>
                    </div>
                    <div class="health-record-list">
                        ${group.items.map(item => renderDuplicateRecord(item, index)).join('')}
                    </div>
                </div>
            `).join('')}
        </div>
    `;
}

function renderDuplicateRecord(item, groupIndex) {
    return `
        <div class="health-record">
            <div class="health-record-main">
                <strong>${escapeHtml(item.title || 'Untitled')}</strong>
                <span>${escapeHtml(formatCreators(item.creators) || '-')} ${item.year ? `· ${escapeHtml(item.year)}` : ''}</span>
                <small>${item.doi ? `DOI: ${escapeHtml(item.doi)}` : escapeHtml(item.item_key)}${item.file_path ? ` · ${escapeHtml(item.file_path)}` : ''}</small>
            </div>
            <div class="health-record-actions">
                <button class="btn-secondary btn-small" onclick="openMetadataEditor('${escapeJs(item.item_key)}')">${icon('pencil')} Edit</button>
                <button class="btn-small" onclick="mergeDuplicateGroup(${groupIndex}, '${escapeJs(item.item_key)}')">${icon('git-merge')} Keep</button>
            </div>
        </div>
    `;
}

function healthMatchLabel(matchType) {
    const labels = {
        doi: 'Same DOI',
        title_year: 'Same title and year',
        title_author: 'Same title and first author',
    };
    return labels[matchType] || 'Possible duplicate';
}

async function mergeDuplicateGroup(groupIndex, targetItemKey) {
    const group = appState.libraryHealth?.duplicates?.[groupIndex];
    if (!group) return;
    const sources = group.items.filter(item => item.item_key !== targetItemKey);
    if (!sources.length) return;
    const keep = group.items.find(item => item.item_key === targetItemKey);
    const ok = confirm(`Merge ${sources.length} duplicate record${sources.length === 1 ? '' : 's'} into "${keep?.title || targetItemKey}"?\n\nThis removes duplicate metadata records from the app. Source files on disk are not deleted.`);
    if (!ok) return;

    try {
        for (const source of sources) {
            const res = await fetch('/api/library/duplicates/merge', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ source_item_key: source.item_key, target_item_key: targetItemKey }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.detail || 'Merge failed');
        }
        await refreshLibraryHealth();
        loadLibraryTree({ force: true });
    } catch (err) {
        alert(`Merge failed: ${err.message}`);
    }
}

function renderBrokenPathHealth(items) {
    if (!items.length) {
        return `<div class="library-health-empty">${icon('check-circle')} No broken file paths detected.</div>`;
    }
    return `
        <div class="library-health-section">
            <div class="library-health-section-head">
                <h4>Broken File Paths</h4>
                <p>These records point to files that are no longer found on disk. Repair a moved file, remove the stale record, or rescan the directory.</p>
            </div>
            <div class="health-table">
                ${items.map(item => `
                    <div class="health-table-row">
                        <div>
                            <strong>${escapeHtml(item.title || item.file_name || 'Untitled')}</strong>
                            <span>${escapeHtml(item.file_path || '')}</span>
                        </div>
                        <div class="health-record-actions">
                            <button class="btn-secondary btn-small" onclick="repairBrokenPath('${escapeJs(item.item_key)}', '${escapeJs(item.file_path)}')">${icon('link')} Repair</button>
                            <button class="btn-secondary btn-small danger" onclick="deleteLibraryItem('${escapeJs(item.item_key)}', false).then(refreshLibraryHealth)">${icon('x')} Remove</button>
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>
    `;
}

async function repairBrokenPath(itemKey, oldPath) {
    const newPath = prompt('Enter the replacement file path:', oldPath);
    if (!newPath || newPath === oldPath) return;
    try {
        const res = await fetch('/api/library/files/repair-path', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ item_key: itemKey, old_path: oldPath, new_path: newPath }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'Repair failed');
        await refreshLibraryHealth();
        loadLibraryItems();
    } catch (err) {
        alert(`Repair failed: ${err.message}`);
    }
}

function renderUnindexedHealth(unindexedFiles, indexedWithoutChunks) {
    const total = unindexedFiles.length + indexedWithoutChunks.length;
    if (!total) {
        return `<div class="library-health-empty">${icon('check-circle')} No unindexed files detected.</div>`;
    }
    return `
        <div class="library-health-section">
            <div class="library-health-section-head">
                <h4>Unindexed PDFs</h4>
                <p>PDFs not yet in the library, plus PDF records missing text chunks or BM25 entries.</p>
            </div>
            <div class="health-table">
                ${unindexedFiles.map(file => `
                    <div class="health-table-row">
                        <div>
                            <strong>${escapeHtml(file.file_name || 'Untitled file')}</strong>
                            <span>${escapeHtml(file.file_path || '')}</span>
                        </div>
                        <div class="health-record-actions">
                            <button class="btn-small" onclick="indexHealthFile('${escapeJs(file.file_path)}', '${escapeJs(file.source_dir || '')}')">${icon('file-plus')} Index</button>
                        </div>
                    </div>
                `).join('')}
                ${indexedWithoutChunks.map(item => `
                    <div class="health-table-row">
                        <div>
                            <strong>${escapeHtml(item.title || item.file_name || 'Untitled')}</strong>
                            <span>${escapeHtml(item.file_path || '')}</span>
                            <small>Existing library record, missing text index (${item.chunk_count || 0} chunks, ${item.fts_count || 0} BM25 rows)</small>
                        </div>
                        <div class="health-record-actions">
                            <button class="btn-small" onclick="indexHealthFile('${escapeJs(item.file_path)}', '${escapeJs(item.source_dir || '')}')">${icon('refresh-cw')} Re-index</button>
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>
    `;
}

async function indexHealthFile(filePath, sourceDir = '') {
    try {
        const res = await fetch('/api/library/files/index', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file_path: filePath, source_dir: sourceDir }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'Indexing failed');
        alert('Indexing started in the background. Run Scan Health again after it finishes.');
        updateSyncStatus();
    } catch (err) {
        alert(`Indexing failed: ${err.message}`);
    }
}

async function loadCitationMindMap(options = {}) {
    const table = document.getElementById('library-center-table');
    if (!table) return;
    table.style.minWidth = '920px';
    renderCitationMindMapShell('Loading citation graph status...');
    await refreshCitationGraphStatus();
    const status = appState.citationGraphStatus || {};
    if (['ready', 'stale'].includes(status.status)) {
        await fetchCitationGraphMap();
    } else {
        renderCitationMindMapShell();
    }
}

function currentCitationGraphSourceDir() {
    return appState.activeSourceDir || '';
}

async function refreshCitationGraphStatus() {
    const sourceDir = currentCitationGraphSourceDir();
    const res = await fetch(`/api/citation-graph/status?source_dir=${encodeURIComponent(sourceDir)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Could not load citation graph status');
    appState.citationGraphStatus = data;
    return data;
}

async function fetchCitationGraphMap() {
    const sourceDir = currentCitationGraphSourceDir();
    const params = new URLSearchParams({
        source_dir: sourceDir,
        include_outside: appState.citationGraphIncludeOutside ? 'true' : 'false',
        min_confidence: '0.85',
        limit: '500',
    });
    const res = await fetch(`/api/citation-graph/map?${params.toString()}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Could not load citation graph map');
    appState.citationGraphMap = data;
    updateLibraryTabCount(data.summary?.edge_count || 0);
    renderCitationMindMapShell();
}

function renderCitationMindMapShell(loadingText = '') {
    const table = document.getElementById('library-center-table');
    if (!table) return;
    const status = appState.citationGraphStatus || {};
    const map = appState.citationGraphMap || { nodes: [], edges: [], summary: {} };
    const running = status.status === 'indexing';
    const ready = ['ready', 'stale'].includes(status.status);
    const scopeLabel = appState.activeSourceDir
        ? (appState.activeSourceDirLabel || appState.activeSourceDir.split('/').pop() || appState.activeSourceDir)
        : 'All Library';

    table.innerHTML = `
        <div class="citation-map-view">
            <div class="citation-map-toolbar">
                <div class="citation-map-title-row">
                    <h3>Mind Map</h3>
                    <span class="citation-map-scope-badge">${escapeHtml(scopeLabel)}</span>
                    ${running
                        ? `<button class="btn-secondary btn-small danger" onclick="cancelCitationGraphBuild()">${icon('x')} Cancel</button>`
                        : `<button class="btn-small" onclick="buildCitationGraph()">${icon(ready ? 'refresh-cw' : 'play')} ${ready ? 'Update Map' : 'Build Map'}</button>`}
                </div>
                <div class="citation-map-subtitle-row">
                    <p>${citationGraphStatusText(status)}</p>
                    <label class="citation-map-toggle">
                        <input type="checkbox" ${appState.citationGraphIncludeOutside ? 'checked' : ''} onchange="setCitationGraphOutside(this.checked)">
                        <span>Other Directory</span>
                    </label>
                </div>
            </div>
            ${loadingText ? `<div class="citation-map-empty">${icon('loader')} ${escapeHtml(loadingText)}</div>` : renderCitationMapBody(map, status)}
        </div>
    `;
    refreshIcons(table);
    if (!loadingText && ready && map.nodes?.length) drawCitationMapSvg(map);
}

function citationGraphStatusText(status = {}) {
    if (status.status === 'indexing') {
        const job = status.running_job || status.latest_job || {};
        const total = job.total_items || status.total_items || 0;
        const processed = job.processed_items || 0;
        return `Building citation map: ${processed} / ${total} papers, ${job.edges_created || 0} local citation links.`;
    }
    if (status.status === 'ready') {
        return `Ready: ${status.indexed_items || 0} papers indexed, ${status.edge_count || 0} citation links.`;
    }
    if (status.status === 'stale') {
        return `Stale: ${status.indexed_items || 0} of ${status.total_items || 0} DOI-bearing papers indexed, ${status.edge_count || 0} links.`;
    }
    if (status.status === 'error') return `Last build failed: ${status.latest_job?.error || 'Unknown error'}`;
    return `Not indexed yet. ${status.total_items || 0} DOI-bearing papers are available for this scope.`;
}

function renderCitationMapBody(map, status) {
    if (status.status === 'indexing') {
        return `
            <div class="citation-map-progress">
                ${renderCitationGraphProgress(status.running_job || status.latest_job || {})}
            </div>
        `;
    }
    if (!['ready', 'stale'].includes(status.status)) {
        return `
            <div class="citation-map-empty">
                ${icon('network')}
                <span>Build the citation map to connect papers by actual cited references from Crossref.</span>
            </div>
        `;
    }
    if (!map.nodes?.length) {
        return `
            <div class="citation-map-empty">
                ${icon('circle-off')}
                <span>No indexed papers found for this scope yet. Try building the map or indexing more DOI-bearing papers.</span>
            </div>
        `;
    }
    return `
        <div class="citation-map-stats">
            <span><strong>${map.summary?.node_count || 0}</strong> papers</span>
            <span><strong>${map.summary?.edge_count || 0}</strong> links</span>
            <span>X = year · Y = local cited-by count</span>
        </div>
        <div class="citation-map-legend">
            <span class="cml-item">
                <svg width="14" height="14" viewBox="0 0 14 14" style="overflow:visible"><circle cx="7" cy="7" r="5" style="fill:var(--accent,#2d6fd4);stroke:var(--bg,#fff);stroke-width:1.5"/></svg>
                Same directory
            </span>
            <span class="cml-item">
                <svg width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5" fill="none" stroke="var(--text-muted,#94a3b8)" stroke-width="1.5" stroke-dasharray="3 2.5"/></svg>
                Other directory (cited)
            </span>
            <span class="cml-item">
                <svg width="28" height="14" viewBox="0 0 28 14"><circle cx="5" cy="9" r="3" fill="var(--accent,#2d6fd4)" stroke="#fff" stroke-width="1"/><circle cx="20" cy="7" r="6" fill="var(--accent,#2d6fd4)" stroke="#fff" stroke-width="1"/></svg>
                Size = citation degree
            </span>
            <span class="cml-item cml-hint">Scroll to zoom · Drag to pan</span>
        </div>
        <div class="citation-map-canvas-wrap" style="position:relative;">
            <div class="citation-map-zoom-btns">
                <button class="cmz-btn" onclick="citationMapZoom(1.3)" title="Zoom in">+</button>
                <button class="cmz-btn" onclick="citationMapZoom(1/1.3)" title="Zoom out">−</button>
                <button class="cmz-btn" onclick="citationMapZoomReset()" title="Reset zoom">⊙</button>
            </div>
            <svg id="citation-map-svg" class="citation-map-svg" viewBox="0 0 1100 620" role="img" aria-label="Citation mind map"></svg>
        </div>
    `;
}

function renderCitationGraphProgress(job) {
    const total = Number(job.total_items || 0);
    const processed = Number(job.processed_items || 0);
    const pct = total ? Math.min(100, Math.round((processed / total) * 100)) : 0;
    return `
        <div class="cp-track"><div class="cp-fill" style="width:${pct}%"></div></div>
        <div class="cp-meta"><span>${escapeHtml(job.step || 'Building citation map...')}</span><span>${pct}%</span></div>
        <div class="citation-map-progress-grid">
            <span>${processed} / ${total} papers</span>
            <span>${Number(job.references_found || 0).toLocaleString()} references</span>
            <span>${Number(job.edges_created || 0).toLocaleString()} links</span>
        </div>
    `;
}

function setCitationGraphOutside(checked) {
    appState.citationGraphIncludeOutside = !!checked;
    appState.citationGraphMap = null;
    loadCitationMindMap();
}

async function buildCitationGraph() {
    const sourceDir = currentCitationGraphSourceDir();
    try {
        const res = await fetch('/api/citation-graph/build', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source_dir: sourceDir }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'Could not start citation map build');
        appState.citationGraphStatus = { status: 'indexing', running_job: data };
        renderCitationMindMapShell();
        pollCitationGraphStatus();
    } catch (err) {
        alert(`Could not start citation map build: ${err.message}`);
    }
}

async function pollCitationGraphStatus() {
    if (appState.libraryActivityFilter !== 'mindmap') return;
    try {
        const status = await refreshCitationGraphStatus();
        renderCitationMindMapShell();
        if (status.status === 'indexing') {
            setTimeout(pollCitationGraphStatus, 2500);
        } else if (['ready', 'stale'].includes(status.status)) {
            await fetchCitationGraphMap();
        }
    } catch (err) {
        console.error('Citation graph poll error:', err);
    }
}

async function cancelCitationGraphBuild() {
    try {
        await fetch('/api/citation-graph/cancel', { method: 'POST' });
        setTimeout(loadCitationMindMap, 800);
    } catch (err) {
        alert(`Could not cancel: ${err.message}`);
    }
}

function _resolveNodeCollisions(nodes, gap, iterations) {
    for (let iter = 0; iter < iterations; iter++) {
        let moved = false;
        for (let i = 0; i < nodes.length; i++) {
            for (let j = i + 1; j < nodes.length; j++) {
                const a = nodes[i], b = nodes[j];
                const dx = b._x - a._x;
                const dy = b._y - a._y;
                const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
                const minDist = a._r + b._r + gap;
                if (dist < minDist) {
                    const push = (minDist - dist) / 2;
                    const ux = dx / dist;
                    const uy = dy / dist;
                    a._x -= ux * push;
                    a._y -= uy * push;
                    b._x += ux * push;
                    b._y += uy * push;
                    moved = true;
                }
            }
        }
        if (!moved) break;
    }
}

let _citationMapTransform = { k: 1, x: 0, y: 0 };

function drawCitationMapSvg(map) {
    const svg = document.getElementById('citation-map-svg');
    if (!svg) return;
    _citationMapTransform = { k: 1, x: 0, y: 0 };
    const width = 1100;
    const height = 620;
    const margin = { left: 72, right: 42, top: 36, bottom: 66 };
    const nodes = map.nodes || [];
    const edges = map.edges || [];
    const years = nodes.map(n => n.year).filter(Boolean);
    const minYear = years.length ? Math.min(...years) : 2000;
    const maxYear = years.length ? Math.max(...years) : minYear + 1;
    const maxLocal = Math.max(1, ...nodes.map(n => n.local_cited_by || 0));
    const maxDegree = Math.max(1, ...nodes.map(n => n.degree || 0));
    const nodeByKey = new Map(nodes.map(n => [n.item_key, n]));
    nodes.forEach(node => {
        node._r = 6 + Math.sqrt((node.degree || 0) / maxDegree) * 14;
    });
    const maxRadius = Math.max(16, ...nodes.map(n => n._r || 0));
    const plot = {
        left: margin.left + maxRadius + 8,
        right: width - margin.right - maxRadius - 8,
        top: margin.top + maxRadius + 8,
        bottom: height - margin.bottom - maxRadius - 10,
    };

    const xFor = year => {
        const y = year || minYear;
        const span = Math.max(1, maxYear - minYear);
        return plot.left + ((y - minYear) / span) * (plot.right - plot.left);
    };
    const yFor = citedBy => {
        return plot.bottom - ((citedBy || 0) / maxLocal) * (plot.bottom - plot.top);
    };
    const coordinateGroups = new Map();
    nodes.forEach(node => {
        const key = `${node.year || minYear}|${node.local_cited_by || 0}`;
        if (!coordinateGroups.has(key)) coordinateGroups.set(key, []);
        coordinateGroups.get(key).push(node);
    });
    coordinateGroups.forEach(group => {
        group.forEach((node, index) => {
            const offset = (index - (group.length - 1) / 2) * (maxRadius * 2 + 8);
            const rawX = xFor(node.year) + offset;
            node._x = Math.max(plot.left, Math.min(rawX, plot.right));
            const rawY = yFor(node.local_cited_by || 0);
            node._y = Math.max(plot.top + node._r + 4, Math.min(rawY, plot.bottom - node._r - 6));
        });
    });

    _resolveNodeCollisions(nodes, 8, 60);

    // Only clamp Y — do not clamp X so collision resolution keeps its guaranteed 8px gaps.
    // Nodes that fan out beyond the plot right edge are reachable via pan.
    nodes.forEach(node => {
        node._y = Math.max(plot.top + node._r + 4, Math.min(node._y, plot.bottom - node._r - 4));
    });

    // If nodes overflow the display width, set an initial zoom-to-fit so everything is visible
    {
        const xVals = nodes.map(n => n._x);
        const xMin = Math.min(...xVals);
        const xMax = Math.max(...xVals) + (nodes.reduce((m, n) => Math.max(m, n._r), 0));
        const xSpan = xMax - xMin + margin.left + margin.right;
        if (xSpan > width * 1.02) {
            const k0 = (width - margin.left - margin.right) / (xMax - xMin) * 0.97;
            const tx0 = margin.left - xMin * k0;
            _citationMapTransform = { k: k0, x: tx0, y: 0 };
        }
    }

    const yearTicks = buildYearTicks(minYear, maxYear);
    const yTicks = buildNumberTicks(maxLocal);
    svg.innerHTML = `
        <defs>
        </defs>
        <g class="citation-axis">
            <line x1="${margin.left}" y1="${plot.bottom}" x2="${width - margin.right}" y2="${plot.bottom}"></line>
            <line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${plot.bottom}"></line>
            ${yearTicks.map(year => {
                const x = xFor(year);
                return `<g><line x1="${x}" y1="${plot.bottom}" x2="${x}" y2="${plot.bottom + 6}"></line><text x="${x}" y="${plot.bottom + 24}">${year}</text></g>`;
            }).join('')}
            ${yTicks.map(tick => {
                const y = yFor(tick);
                return `<g><line x1="${margin.left - 6}" y1="${y}" x2="${width - margin.right}" y2="${y}"></line><text x="${margin.left - 12}" y="${y + 4}">${tick}</text></g>`;
            }).join('')}
            <text x="${width / 2}" y="${height - 18}" class="axis-label">Publication year</text>
            <text x="0" y="0" transform="translate(18 ${height / 2}) rotate(-90)" class="axis-label" dominant-baseline="middle">Local cited-by count</text>
        </g>
        <g id="citation-map-zoom-layer" transform="translate(0,0) scale(1)">
        <g class="citation-edges">
            ${edges.map((edge, edgeIndex) => {
                const s = nodeByKey.get(edge.source);
                const t = nodeByKey.get(edge.target);
                if (!s || !t) return '';
                const points = citationEdgePoints(s, t);
                const mx = (points.start.x + points.end.x) / 2;
                const curveOffset = Math.min(80, Math.abs(points.start.x - points.end.x) / 4) || 32;
                const my = (points.start.y + points.end.y) / 2 - curveOffset - ((edgeIndex % 3) - 1) * 10;
                const strokeWidth = Math.min(4, 1.4 + (edge.weight || 1) * 0.7);
                return `<path d="M${points.start.x},${points.start.y} Q${mx},${my} ${points.end.x},${points.end.y}" style="stroke-width:${strokeWidth}"><title>${escapeHtml(s.title)} cites ${escapeHtml(t.title)}</title></path>`;
            }).join('')}
        </g>
        <g class="citation-nodes">
            ${nodes.map(node => {
                const label = [node.first_author, node.year].filter(Boolean).join(', ');
                const labelAbove = node._y + node._r + 13 > plot.bottom;
                const labelDy = labelAbove ? -(node._r + 4) : (node._r + 10);
                const circleStyle = node.in_selected_dir
                    ? 'fill:var(--accent,#2d6fd4);stroke:var(--bg,#fff);stroke-width:2.5'
                    : 'fill:none;stroke:var(--text-muted,#94a3b8);stroke-width:2;stroke-dasharray:5 4';
                return `
                    <g class="citation-node ${node.in_selected_dir ? 'inside' : 'outside'}" transform="translate(${node._x},${node._y})" onclick="openPreview('${escapeJs(node.item_key)}')">
                        <g class="node-symbol">
                            <circle r="${node._r}" style="${circleStyle}"></circle>
                            ${label ? `<text class="citation-node-label" dy="${labelDy}" text-anchor="middle">${escapeHtml(label)}</text>` : ''}
                        </g>
                        <title>${escapeHtml(node.title)} (${node.year || '-'}) · cited locally ${node.local_cited_by || 0} time(s)</title>
                    </g>
                `;
            }).join('')}
        </g>
        </g>
    `;

    _attachCitationMapZoom(svg);
    // Apply initial transform (may be zoom-to-fit if nodes overflowed)
    _applyCitationMapTransform(svg);
}

function _citationMapSvgPoint(svg, clientX, clientY) {
    const rect = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    return {
        x: (clientX - rect.left) * (vb.width / rect.width),
        y: (clientY - rect.top) * (vb.height / rect.height),
    };
}

function _applyCitationMapTransform(svg) {
    const layer = svg.querySelector('#citation-map-zoom-layer');
    if (!layer) return;
    const { k, x, y } = _citationMapTransform;
    layer.setAttribute('transform', `translate(${x},${y}) scale(${k})`);
    // Counter-scale each node symbol so circles stay the same visual size.
    // With this, zooming in spreads node positions apart (×k) while radii stay constant,
    // so overlapping nodes genuinely separate as you zoom.
    const invK = `scale(${1 / k})`;
    layer.querySelectorAll('.node-symbol').forEach(g => g.setAttribute('transform', invK));
}

function citationMapZoom(factor) {
    const svg = document.getElementById('citation-map-svg');
    if (!svg) return;
    const vb = svg.viewBox.baseVal;
    const cx = vb.width / 2;
    const cy = vb.height / 2;
    const t = _citationMapTransform;
    const newK = Math.max(0.3, Math.min(8, t.k * factor));
    t.x = cx - (cx - t.x) * (newK / t.k);
    t.y = cy - (cy - t.y) * (newK / t.k);
    t.k = newK;
    _applyCitationMapTransform(svg);
}

function citationMapZoomReset() {
    _citationMapTransform = { k: 1, x: 0, y: 0 };
    const svg = document.getElementById('citation-map-svg');
    if (svg) _applyCitationMapTransform(svg);
}

function _attachCitationMapZoom(svg) {
    let dragging = false;
    let dragStart = { x: 0, y: 0 };
    let transformAtDragStart = { k: 1, x: 0, y: 0 };

    svg.addEventListener('wheel', e => {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
        const pt = _citationMapSvgPoint(svg, e.clientX, e.clientY);
        const t = _citationMapTransform;
        const newK = Math.max(0.3, Math.min(8, t.k * factor));
        t.x = pt.x - (pt.x - t.x) * (newK / t.k);
        t.y = pt.y - (pt.y - t.y) * (newK / t.k);
        t.k = newK;
        _applyCitationMapTransform(svg);
    }, { passive: false });

    svg.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        dragging = true;
        dragStart = _citationMapSvgPoint(svg, e.clientX, e.clientY);
        transformAtDragStart = { ..._citationMapTransform };
        svg.style.cursor = 'grabbing';
        e.preventDefault();
    });

    window.addEventListener('mousemove', e => {
        if (!dragging) return;
        const cur = _citationMapSvgPoint(svg, e.clientX, e.clientY);
        _citationMapTransform.x = transformAtDragStart.x + (cur.x - dragStart.x);
        _citationMapTransform.y = transformAtDragStart.y + (cur.y - dragStart.y);
        _applyCitationMapTransform(svg);
    });

    window.addEventListener('mouseup', () => {
        if (dragging) {
            dragging = false;
            svg.style.cursor = '';
        }
    });
}

function citationEdgePoints(source, target) {
    // Draw center-to-center; the node circles (rendered on top) visually cap the endpoints.
    // This avoids mis-alignment when circles are counter-scaled during zoom.
    return {
        start: { x: source._x, y: source._y },
        end: { x: target._x, y: target._y },
    };
}

function buildYearTicks(minYear, maxYear) {
    if (minYear === maxYear) return [minYear];
    const span = maxYear - minYear;
    const step = span > 30 ? 10 : span > 12 ? 5 : 2;
    const start = Math.floor(minYear / step) * step;
    const ticks = [];
    for (let y = start; y <= maxYear; y += step) {
        if (y >= minYear) ticks.push(y);
    }
    if (!ticks.includes(maxYear)) ticks.push(maxYear);
    return ticks.slice(0, 10);
}

function buildNumberTicks(maxValue) {
    if (maxValue <= 4) return Array.from({ length: maxValue + 1 }, (_, i) => i);
    const step = Math.ceil(maxValue / 4);
    const ticks = [];
    for (let n = 0; n <= maxValue; n += step) ticks.push(n);
    if (!ticks.includes(maxValue)) ticks.push(maxValue);
    return ticks;
}

function hashString(value) {
    let hash = 0;
    for (let i = 0; i < value.length; i++) hash = ((hash << 5) - hash) + value.charCodeAt(i);
    return hash;
}

function updateLibraryTabCount(total) {
    const activeFilter = appState.libraryActivityFilter || 'all';
    document.querySelectorAll('.library-view-tab').forEach(btn => {
        const count = btn.querySelector('.library-tab-count');
        if (!count) return;
        if ((btn.dataset.libraryView || 'all') === activeFilter) {
            count.textContent = Number(total || 0).toLocaleString();
        } else {
            count.textContent = '';
        }
    });
}

const libraryColumnConfig = {
    title:          { label: 'Title',    width: 280, minWidth: 180 },
    year:           { label: 'Year',     width: 82,  minWidth: 56 },
    creators:       { label: 'Authors',  width: 210, minWidth: 140 },
    keywords:       { label: 'Keywords', width: 220, minWidth: 150 },
    annotations:    { label: 'Notes',    width: 96,  minWidth: 78 },
    citation_count: { label: 'Cited',    width: 96,  minWidth: 78 },
    item_type:      { label: 'Type',     width: 120, minWidth: 88 },
    opened_at:      { label: 'Opened',   width: 136, minWidth: 100 },
    synced_at:      { label: 'Created',  width: 136, minWidth: 100 },
};

const defaultLibraryColumns = ['title', 'year', 'creators', 'keywords', 'annotations', 'citation_count', 'item_type', 'opened_at', 'synced_at'];

function getLibraryColumnTemplate() {
    return '72px ' + appState.libraryColumns.map(key => `${getLibraryColumnWidth(key)}px`).join(' ');
}

function getLibraryColumnWidth(key) {
    const cfg = libraryColumnConfig[key] || { width: 120, minWidth: 70 };
    const raw = appState.libraryColumnWidths[key];
    const width = Number.isFinite(raw) ? raw : Number(cfg.width || 120);
    return Math.max(Number(cfg.minWidth || 70), Math.min(width, 720));
}

function getLibraryTableMinWidth() {
    const columnWidth = appState.libraryColumns.reduce((sum, key) => sum + getLibraryColumnWidth(key), 0);
    return columnWidth + 72;
}

function loadLibraryColumnPrefs() {
    try {
        appState.libraryColumnWidths = JSON.parse(localStorage.getItem('libraryColumnWidths') || '{}') || {};
    } catch {
        appState.libraryColumnWidths = {};
    }
    try {
        const savedColumns = JSON.parse(localStorage.getItem('libraryVisibleColumns') || '[]');
        const valid = savedColumns.filter(key => libraryColumnConfig[key]);
        if (valid.length > 0) appState.libraryColumns = valid;
    } catch {}
}

function saveLibraryColumnWidths() {
    localStorage.setItem('libraryColumnWidths', JSON.stringify(appState.libraryColumnWidths));
}

function saveLibraryVisibleColumns() {
    localStorage.setItem('libraryVisibleColumns', JSON.stringify(appState.libraryColumns));
}

function applyLibraryColumnTemplate() {
    const table = document.getElementById('library-center-table');
    if (!table) return;
    const template = getLibraryColumnTemplate();
    table.style.minWidth = `${getLibraryTableMinWidth()}px`;
    table.querySelectorAll('.table-header, .table-row').forEach(row => {
        row.style.gridTemplateColumns = template;
    });
}

function renderLibraryColumnMenu() {
    const menu = document.getElementById('library-columns-menu');
    if (!menu) return;
    menu.innerHTML = `
        <div class="library-columns-menu-title">Visible columns</div>
        ${defaultLibraryColumns.map(key => {
            const cfg = libraryColumnConfig[key];
            const checked = appState.libraryColumns.includes(key);
            const disabled = checked && appState.libraryColumns.length === 1;
            return `
                <label class="library-column-option ${disabled ? 'disabled' : ''}">
                    <input type="checkbox"
                           ${checked ? 'checked' : ''}
                           ${disabled ? 'disabled' : ''}
                           onchange="toggleLibraryColumn('${escapeJs(key)}', this.checked)">
                    <span>${escapeHtml(cfg.label)}</span>
                </label>
            `;
        }).join('')}
        <button class="library-columns-reset" type="button" onclick="resetLibraryColumns()">${icon('rotate-ccw')} Reset columns</button>
    `;
    refreshIcons(menu);
}

function toggleLibraryColumn(columnKey, visible) {
    if (!libraryColumnConfig[columnKey]) return;
    if (visible) {
        if (!appState.libraryColumns.includes(columnKey)) {
            const next = [...appState.libraryColumns];
            const defaultIndex = defaultLibraryColumns.indexOf(columnKey);
            const insertAt = next.findIndex(key => defaultLibraryColumns.indexOf(key) > defaultIndex);
            if (insertAt >= 0) next.splice(insertAt, 0, columnKey);
            else next.push(columnKey);
            appState.libraryColumns = next;
        }
    } else if (appState.libraryColumns.length > 1) {
        appState.libraryColumns = appState.libraryColumns.filter(key => key !== columnKey);
    }
    saveLibraryVisibleColumns();
    renderLibraryColumnMenu();
    loadLibraryItems();
}

function resetLibraryColumns() {
    appState.libraryColumns = [...defaultLibraryColumns];
    appState.libraryColumnWidths = {};
    localStorage.removeItem('libraryVisibleColumns');
    localStorage.removeItem('libraryColumnWidths');
    renderLibraryColumnMenu();
    loadLibraryItems();
}

const ITEM_TYPE_LABELS = {
    journalArticle:   'Article',
    book:             'Book',
    bookSection:      'Book Chapter',
    conferencePaper:  'Conference',
    thesis:           'Thesis',
    report:           'Report',
    webpage:          'Webpage',
    preprint:         'Preprint',
    magazineArticle:  'Magazine',
    newspaperArticle: 'Newspaper',
    manuscript:       'Manuscript',
    patent:           'Patent',
    dataset:          'Dataset',
    software:         'Software',
    document:         'Document',
    note:             'Note',
    image:            'Image',
};

function formatItemType(raw) {
    if (!raw || raw === '-') return '-';
    return ITEM_TYPE_LABELS[raw] || raw;
}

function renderLibraryCell(key, item) {
    if (key === 'citation_count') {
        const n = formatCitationCount(item?.citation_count);
        return `<div class="cell cell-cited"><span class="citation-count-badge" title="Crossref cited-by count">${n}</span></div>`;
    }
    if (key === 'keywords') {
        const kws = item.keywords || [];
        if (!kws.length) return `<div class="cell cell-muted">—</div>`;
        return `<div class="cell cell-keywords">${escapeHtml(kws.join(', '))}</div>`;
    }
    if (key === 'annotations') {
        const n = item.annotation_count || 0;
        return n > 0
            ? `<div class="cell"><span class="ann-count-badge">${n}</span></div>`
            : `<div class="cell cell-muted">—</div>`;
    }
    const values = {
        title: item.title || 'Untitled',
        year: item.year || '-',
        item_type: formatItemType(item.item_type),
        opened_at: formatDate(item.opened_at),
        creators: formatCreators(item.creators_list || item.creators),
        synced_at: formatDate(item.synced_at),
    };
    if (key === 'title') {
        const rs = item.reading_status || '';
        const badge = rs ? `<span class="reading-status-badge rs-${rs}" title="${rs === 'reading' ? 'Reading' : 'Read'}"></span>` : '';
        return `<div class="cell cell-title" title="${escapeHtml(values.title || '-')}">${badge}<span class="cell-clamp-2">${escapeHtml(values.title || '-')}</span></div>`;
    }
    if (key === 'creators') {
        return `<div class="cell cell-creators" title="${escapeHtml(values.creators || '-')}"><span class="cell-clamp-2">${escapeHtml(values.creators || '-')}</span></div>`;
    }
    return `<div class="cell">${escapeHtml(values[key] || '-')}</div>`;
}

function renderSortableHeader(sortKey) {
    const label = libraryColumnConfig[sortKey]?.label || sortKey;
    const active = appState.librarySortBy === sortKey;
    const arrow = active ? (appState.librarySortOrder === 'asc' ? '▲' : '▼') : '';
    return `
        <button class="table-sort-btn ${active ? 'active' : ''}"
                data-column-key="${escapeHtml(sortKey)}"
                draggable="true"
                ondragstart="startColumnDrag(event, '${sortKey}')"
                ondragover="allowColumnDrop(event)"
                ondrop="dropColumn(event, '${sortKey}')"
                onclick="sortLibraryBy('${sortKey}')"
                title="Drag to reorder, click to sort">
            <span class="table-sort-label">${escapeHtml(label)}</span>
            <span class="table-sort-arrow">${arrow}</span>
            <span class="column-resize-handle"
                  title="Resize column"
                  onclick="event.preventDefault(); event.stopPropagation();"
                  onmousedown="startColumnResize(event, '${sortKey}')"></span>
        </button>
    `;
}

function sortLibraryBy(sortKey) {
    if (appState.librarySortBy === sortKey) {
        appState.librarySortOrder = appState.librarySortOrder === 'asc' ? 'desc' : 'asc';
    } else {
        appState.librarySortBy = sortKey;
        appState.librarySortOrder = 'asc';
    }
    const sortSelect = document.getElementById('library-sort-select');
    if (sortSelect && Array.from(sortSelect.options).some(o => o.value === sortKey)) {
        sortSelect.value = sortKey;
    }
    loadLibraryItems();
}

function startColumnDrag(event, sortKey) {
    event.dataTransfer.setData('text/plain', sortKey);
    event.dataTransfer.effectAllowed = 'move';
}

function allowColumnDrop(event) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
}

function dropColumn(event, targetKey) {
    event.preventDefault();
    event.stopPropagation();
    const draggedKey = event.dataTransfer.getData('text/plain');
    if (!draggedKey || draggedKey === targetKey) return;

    const next = appState.libraryColumns.filter(key => key !== draggedKey);
    const targetIndex = next.indexOf(targetKey);
    next.splice(targetIndex, 0, draggedKey);
    appState.libraryColumns = next;
    saveLibraryVisibleColumns();
    loadLibraryItems();
}

function startColumnResize(event, columnKey) {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = getLibraryColumnWidth(columnKey);
    const minWidth = libraryColumnConfig[columnKey]?.minWidth || 70;
    document.body.classList.add('is-column-resizing');

    const onMove = (moveEvent) => {
        const delta = moveEvent.clientX - startX;
        appState.libraryColumnWidths[columnKey] = Math.max(minWidth, Math.min(startWidth + delta, 720));
        applyLibraryColumnTemplate();
    };
    const onUp = () => {
        document.body.classList.remove('is-column-resizing');
        saveLibraryColumnWidths();
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
}

async function toggleFavorite(itemKey, favorite) {
    try {
        const res = await fetch(`/api/items/${itemKey}/favorite`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ favorite: !!favorite }),
        });
        if (!res.ok) throw new Error(`Favorite failed (${res.status})`);
        const item = appState.libraryItems.find(i => i.item_key === itemKey);
        if (item) item.is_favorite = !!favorite;
        if (appState.previewItem?.item_key === itemKey) appState.previewItem.is_favorite = !!favorite;
        loadLibraryItems();
    } catch (err) {
        console.error('Favorite error:', err);
    }
}

async function loadItemKeywords(itemKey) {
    try {
        const res = await fetch(`/api/items/${itemKey}/keywords`);
        if (!res.ok) return;
        const data = await res.json();
        const container = document.getElementById('item-keywords-row');
        if (!container) return;
        if (data.keywords && data.keywords.length > 0) {
            container.innerHTML = data.keywords.map(kw =>
                `<span class="keyword-chip">${escapeHtml(kw)}</span>`
            ).join('');
            container.classList.remove('hidden');
        } else {
            container.classList.add('hidden');
        }
    } catch {}
}

async function selectLibraryItem(itemKey) {
    appState.selectedItemId = itemKey;
    try {
        const res = await fetch(`/api/items/${itemKey}`);
        const item = await res.json();

        const panel = document.getElementById('item-detail-panel');
        panel.classList.remove('hidden');
        panel.classList.toggle('minimized', appState.detailPanelMinimized);
        panel.innerHTML = `
            <div class="detail-header">
                <h4>${escapeHtml(item.title || 'Untitled')}</h4>
                <div class="detail-header-actions">
                    <button class="btn-secondary btn-small" onclick="openMetadataEditor('${escapeJs(itemKey)}')">Edit Metadata</button>
                    <button class="detail-minimize-btn" onclick="toggleDetailPanel()" title="${appState.detailPanelMinimized ? 'Expand' : 'Minimize'}" aria-label="${appState.detailPanelMinimized ? 'Expand panel' : 'Minimize panel'}"><i data-lucide="${appState.detailPanelMinimized ? 'chevron-up' : 'chevron-down'}" aria-hidden="true"></i></button>
                </div>
            </div>
            <div class="detail-field"><span class="detail-label">Authors</span><span class="detail-value">${escapeHtml(formatCreators(item.creators_list || item.creators))}</span></div>
            <div class="detail-field"><span class="detail-label">Year</span><span class="detail-value">${escapeHtml(item.year || '-')}</span></div>
            <div class="detail-field"><span class="detail-label">Type</span><span class="detail-value">${escapeHtml(item.item_type || '-')}</span></div>
            <div class="detail-field"><span class="detail-label">Cited</span><span class="detail-value">${renderCitationCountBadge(item)}</span></div>
            <div class="detail-field"><span class="detail-label">DOI</span><span class="detail-value">${escapeHtml(item.doi || '-')}</span></div>
            <div class="detail-field"><span class="detail-label">Publication</span><span class="detail-value">${escapeHtml(item.publication_title || '-')}</span></div>
            ${item.abstract ? `<div class="detail-field"><span class="detail-label">Abstract</span><span class="detail-value">${escapeHtml(item.abstract.slice(0, 500))}</span></div>` : ''}
            <div class="detail-field">
                <span class="detail-label">Keywords</span>
                <div class="item-keywords-section hidden" id="item-keywords-row"></div>
            </div>
            <div class="detail-actions">
                <button class="btn-small" onclick="openPreview('${itemKey}')">Open Preview</button>
                <button class="btn-secondary btn-small" onclick="deleteLibraryItem('${escapeJs(itemKey)}', false)">Remove from App</button>
                ${renderDeleteSourceButton(item, itemKey)}
            </div>
        `;

        refreshIcons(panel);
        loadItemKeywords(itemKey);
        openPreview(itemKey);
    } catch (err) {
        console.error('Select item error:', err);
    }
}

function toggleDetailPanel() {
    const panel = document.getElementById('item-detail-panel');
    if (!panel) return;
    appState.detailPanelMinimized = panel.classList.toggle('minimized');
    const btn = panel.querySelector('.detail-minimize-btn');
    if (btn) {
        const minimized = appState.detailPanelMinimized;
        btn.title = minimized ? 'Expand' : 'Minimize';
        btn.setAttribute('aria-label', minimized ? 'Expand panel' : 'Minimize panel');
        btn.innerHTML = `<i data-lucide="${minimized ? 'chevron-up' : 'chevron-down'}" aria-hidden="true"></i>`;
        refreshIcons(btn);
    }
}

async function openMetadataEditor(itemKey) {
    try {
        const res = await fetch(`/api/items/${itemKey}`);
        if (!res.ok) throw new Error(`Item load failed (${res.status})`);
        const item = await res.json();
        appState.metadataEditorItem = item;
        renderMetadataEditor(item);
        document.getElementById('metadata-editor-panel').classList.remove('hidden');
        document.getElementById('library-content-split').classList.add('editor-open');
    } catch (err) {
        console.error('Open metadata editor error:', err);
    }
}

function closeMetadataEditor() {
    appState.metadataEditorItem = null;
    document.getElementById('metadata-editor-panel').classList.add('hidden');
    document.getElementById('library-content-split').classList.remove('editor-open');
}

async function importPdfAnnotations(itemKey) {
    const btn = document.getElementById('import-ann-btn');
    const msg = document.getElementById('import-ann-msg');
    if (btn) btn.disabled = true;
    if (msg) { msg.textContent = 'Reading PDF…'; msg.className = 'settings-inline-result'; }
    try {
        const res = await fetch(`/api/items/${itemKey}/import-annotations`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'Import failed');
        let text;
        if (data.total_in_pdf === 0) {
            text = 'No embedded annotations found in this PDF.';
        } else if (data.imported === 0 && data.skipped > 0) {
            text = `Already imported (${data.skipped} annotation${data.skipped !== 1 ? 's' : ''}).`;
        } else {
            text = `Imported ${data.imported} annotation${data.imported !== 1 ? 's' : ''}`;
            if (data.skipped > 0) text += `, ${data.skipped} already existed`;
            text += '.';
        }
        if (msg) { msg.textContent = text; msg.className = 'settings-inline-result success'; }
        if (data.imported > 0) loadAnnotations(itemKey);
    } catch (err) {
        if (msg) { msg.textContent = `Error: ${err.message}`; msg.className = 'settings-inline-result error'; }
    } finally {
        if (btn) btn.disabled = false;
        refreshIcons(document.getElementById('metadata-editor-panel'));
    }
}

function renderMetadataEditor(item) {
    const panel = document.getElementById('metadata-editor-panel');
    const typeOptions = ['journalArticle', 'book', 'bookSection', 'conferencePaper', 'thesis', 'report', 'webpage', 'preprint', 'magazineArticle', 'newspaperArticle', 'document', 'note', 'image'];
    const filePath = (item.files && item.files.length && item.files[0].file_path) || item.file_path || '';
    const dirPath = filePath ? filePath.replace(/\/[^\/]+$/, '') : '';
    panel.innerHTML = `
        <div class="metadata-editor-header">
            <div>
                <h4>Metadata</h4>
                <span>${escapeHtml(item.item_key || '')}</span>
            </div>
            <button class="settings-icon-btn" onclick="closeMetadataEditor()" title="Close" aria-label="Close">${icon('x')}</button>
        </div>
        <div class="metadata-editor-body">
            ${metadataInput('Title', 'meta-title', item.title || '')}
            ${metadataTextarea('Authors', 'meta-authors', creatorsToLines(item.creators_list || item.creators), 4)}
            <div class="metadata-grid two">
                ${metadataInput('Year', 'meta-year', item.year || '')}
                <div class="metadata-field">
                    <label for="meta-item-type">Type</label>
                    <select id="meta-item-type" class="compact-select">
                        ${typeOptions.map(t => `<option value="${escapeHtml(t)}" ${t === item.item_type ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('')}
                    </select>
                </div>
            </div>
            ${metadataInput('Publication', 'meta-publication-title', item.publication_title || '')}
            ${metadataInput('DOI', 'meta-doi', item.doi || '')}
            ${metadataInput('URL', 'meta-url', item.url || '')}
            <div class="metadata-field">
                <label>Cited</label>
                <div>${renderCitationCountBadge(item)}</div>
            </div>
            <div class="metadata-grid two">
                ${metadataInput('Volume', 'meta-volume', item.volume || '')}
                ${metadataInput('Issue', 'meta-issue', item.issue || '')}
            </div>
            ${metadataInput('Pages', 'meta-pages', item.pages || '')}
            ${metadataInput('Publisher', 'meta-publisher', item.publisher || '')}
            <div class="metadata-grid two">
                ${metadataInput('Place', 'meta-place', item.place || '')}
                ${metadataInput('Edition', 'meta-edition', item.edition || '')}
            </div>
            <div class="metadata-grid two">
                ${metadataInput('ISBN', 'meta-isbn', item.isbn || '')}
                ${metadataInput('ISSN', 'meta-issn', item.issn || '')}
            </div>
            ${metadataTextarea('Abstract', 'meta-abstract', item.abstract || '', 6)}
            ${metadataTextarea('Extra', 'meta-extra', item.extra || '', 3)}
            <div class="metadata-field">
                <label>Directory</label>
                <div class="meta-dir-row">
                    <input type="text" id="meta-dir-path" class="compact-input" value="${escapeHtml(dirPath)}" readonly title="${escapeHtml(dirPath)}">
                    <button class="btn-secondary btn-small meta-open-dir-btn" onclick="openItemDirectory()" title="Open in Finder/Explorer">${icon('folder-open')} Open</button>
                </div>
            </div>
        </div>
        ${filePath.toLowerCase().endsWith('.pdf') ? `
        <div class="metadata-field">
            <label>Embedded Annotations</label>
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                <button class="btn-secondary btn-small" id="import-ann-btn" onclick="importPdfAnnotations('${escapeJs(item.item_key)}')">${icon('download')} Import from PDF</button>
                <span id="import-ann-msg" class="settings-inline-result" style="font-size:0.82rem"></span>
            </div>
        </div>` : ''}
        <div class="metadata-editor-footer">
            <div class="metadata-danger-actions">
                <button class="btn-secondary btn-small" onclick="deleteLibraryItem('${escapeJs(item.item_key)}', false)">Remove from App</button>
                ${renderDeleteSourceButton(item, item.item_key)}
            </div>
            <div class="metadata-save-actions">
                <button class="btn-secondary btn-small" onclick="refetchMetadataFromCrossref()">Refetch Crossref</button>
                <button class="btn-primary btn-small" onclick="saveMetadataEditor()">Save</button>
            </div>
        </div>
        <div id="metadata-editor-msg" class="settings-inline-result"></div>
    `;
    refreshIcons(panel);
}

function metadataInput(label, id, value) {
    return `
        <div class="metadata-field">
            <label for="${id}">${escapeHtml(label)}</label>
            <input type="text" id="${id}" class="compact-input" value="${escapeHtml(value)}">
        </div>
    `;
}

function metadataTextarea(label, id, value, rows = 3) {
    return `
        <div class="metadata-field">
            <label for="${id}">${escapeHtml(label)}</label>
            <textarea id="${id}" rows="${rows}">${escapeHtml(value)}</textarea>
        </div>
    `;
}

function collectMetadataEditorPayload() {
    return {
        title: document.getElementById('meta-title').value.trim(),
        creators: parseCreatorLines(document.getElementById('meta-authors').value),
        year: document.getElementById('meta-year').value.trim(),
        item_type: document.getElementById('meta-item-type').value,
        publication_title: document.getElementById('meta-publication-title').value.trim(),
        doi: document.getElementById('meta-doi').value.trim(),
        url: document.getElementById('meta-url').value.trim(),
        volume: document.getElementById('meta-volume').value.trim(),
        issue: document.getElementById('meta-issue').value.trim(),
        pages: document.getElementById('meta-pages').value.trim(),
        publisher: document.getElementById('meta-publisher').value.trim(),
        place: document.getElementById('meta-place').value.trim(),
        edition: document.getElementById('meta-edition').value.trim(),
        isbn: document.getElementById('meta-isbn').value.trim(),
        issn: document.getElementById('meta-issn').value.trim(),
        abstract: document.getElementById('meta-abstract').value.trim(),
        extra: document.getElementById('meta-extra').value.trim(),
    };
}

async function openItemDirectory() {
    const item = appState.metadataEditorItem;
    if (!item) return;
    const filePath = (item.files && item.files.length && item.files[0].file_path) || item.file_path || '';
    const dirPath = filePath ? filePath.replace(/\/[^\/]+$/, '') : '';
    if (!dirPath) return;
    try {
        await fetch('/api/open-directory', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: dirPath }),
        });
    } catch (err) {
        console.error('Failed to open directory:', err);
    }
}

async function saveMetadataEditor() {
    const item = appState.metadataEditorItem;
    if (!item) return;
    setInlineResult('metadata-editor-msg', 'Saving...');
    try {
        const res = await fetch(`/api/items/${item.item_key}/metadata`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(collectMetadataEditorPayload()),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || data.message || 'Save failed');
        appState.metadataEditorItem = data.item;
        renderMetadataEditor(data.item);
        await loadLibraryItems();
        await selectLibraryItem(item.item_key);
        setInlineResult('metadata-editor-msg', 'Metadata saved.', 'success');
    } catch (err) {
        setInlineResult('metadata-editor-msg', 'Error: ' + err.message, 'error');
    }
}

async function refetchMetadataFromCrossref() {
    const item = appState.metadataEditorItem;
    if (!item) return;
    const doi = document.getElementById('meta-doi').value.trim();
    if (!doi) {
        setInlineResult('metadata-editor-msg', 'Enter a DOI first.', 'error');
        return;
    }
    setInlineResult('metadata-editor-msg', 'Fetching Crossref metadata...');
    try {
        const res = await fetch(`/api/items/${item.item_key}/metadata/refetch-crossref`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ doi }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || data.message || 'Crossref fetch failed');
        appState.metadataEditorItem = data.item;
        renderMetadataEditor(data.item);
        await loadLibraryItems();
        await selectLibraryItem(item.item_key);
        setInlineResult('metadata-editor-msg', 'Crossref metadata applied.', 'success');
    } catch (err) {
        setInlineResult('metadata-editor-msg', 'Error: ' + err.message, 'error');
    }
}

function renderDeleteSourceButton(item, itemKey) {
    const filePath = (item.files && item.files.length && item.files[0].file_path) || item.file_path || '';
    if (!filePath.toLowerCase().endsWith('.pdf')) return '';
    return `<button class="btn-secondary btn-small danger" onclick="deleteLibraryItem('${escapeJs(itemKey)}', true)">Delete Source</button>`;
}

async function deleteLibraryItem(itemKey, deleteFile = false) {
    const item = appState.metadataEditorItem?.item_key === itemKey
        ? appState.metadataEditorItem
        : appState.libraryItems.find(i => i.item_key === itemKey);
    const title = item?.title || itemKey;
    const message = deleteFile
        ? `Permanently delete the original source file for "${title}" and remove it from this app?\n\nThis deletes the file from disk and cannot be undone.`
        : `Remove "${title}" from this app?\n\nThe source file stays in its folder, and a future rescan can add it again.`;
    if (!confirm(message)) return;

    try {
        const res = await fetch(`/api/items/${itemKey}?delete_file=${deleteFile ? 'true' : 'false'}`, {
            method: 'DELETE',
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || data.message || 'Delete failed');

        closeMetadataEditor();
        if (appState.selectedItemId === itemKey) {
            appState.selectedItemId = null;
            const panel = document.getElementById('item-detail-panel');
            panel.classList.add('hidden');
            panel.innerHTML = '';
        }
        appState.libraryItems = appState.libraryItems.filter(i => i.item_key !== itemKey);
        await loadLibraryTree({ force: true });
        await loadLibraryStats();
        await loadLibraryItems();
    } catch (err) {
        alert('Error deleting item: ' + err.message);
    }
}

function filterByDir(sourceDir, label) {
    appState.activeSourceDir = sourceDir || '';
    appState.activeSourceDirLabel = label || '';
    appState.activeCollectionKey = '';
    document.getElementById('library-center-search').value = '';
    closeMetadataEditor();
    loadLibraryTree();
    loadLibraryItems();
}


let _activeContextMenu = null;

function hideContextMenu() {
    if (_activeContextMenu) {
        _activeContextMenu.remove();
        _activeContextMenu = null;
    }
}

document.addEventListener('click', e => {
    if (_activeContextMenu && !_activeContextMenu.contains(e.target)) {
        hideContextMenu();
    }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') hideContextMenu(); });

function showFolderContextMenu(event, sourceDir, isRootDir, collectionKey, collectionName) {
    event.preventDefault();
    event.stopPropagation();
    hideContextMenu();

    const menu = document.createElement('div');
    menu.className = 'ctx-menu';

    if (isRootDir) {
        menu.innerHTML = `
            <button class="ctx-item" onclick="hideContextMenu(); createFolderIn('${escapeJs(sourceDir)}')">${icon('folder-plus')} <span>New Folder</span></button>
            <button class="ctx-item" onclick="hideContextMenu(); startSync('${escapeJs(sourceDir)}')">${icon('refresh-cw')} <span>Scan Directory</span></button>
            <button class="ctx-item" onclick="hideContextMenu(); openInFileManager('${escapeJs(sourceDir)}')">${icon('external-link')} <span>Open in File Manager</span></button>
            <div class="ctx-sep"></div>
            <button class="ctx-item" onclick="hideContextMenu(); editDirectoryLabel('${escapeJs(sourceDir)}')">${icon('pencil')} <span>Edit Label</span></button>
            <div class="ctx-sep"></div>
            <button class="ctx-item danger" onclick="hideContextMenu(); removeLibraryDir('${escapeJs(sourceDir)}')">${icon('trash-2')} <span>Remove Library</span></button>
        `;
    } else {
        const colPath = _resolveCollectionPath(sourceDir, collectionKey, collectionName);

        menu.innerHTML = `
            <button class="ctx-item" onclick="hideContextMenu(); createFolderIn('${escapeJs(colPath)}')">${icon('folder-plus')} <span>New Subfolder</span></button>
            <button class="ctx-item" onclick="hideContextMenu(); startSync('${escapeJs(colPath)}')">${icon('refresh-cw')} <span>Scan Folder</span></button>
            <button class="ctx-item" onclick="hideContextMenu(); renameFolder('${escapeJs(colPath)}', '${escapeJs(collectionName || '')}', '${escapeJs(collectionKey || '')}')">${icon('pencil')} <span>Rename</span></button>
            <button class="ctx-item" onclick="hideContextMenu(); moveFolderTo('${escapeJs(colPath)}')">${icon('corner-down-right')} <span>Move To…</span></button>
            <button class="ctx-item" onclick="hideContextMenu(); openInFileManager('${escapeJs(colPath)}')">${icon('external-link')} <span>Open in File Manager</span></button>
            <div class="ctx-sep"></div>
            <button class="ctx-item danger" onclick="hideContextMenu(); deleteFolder('${escapeJs(colPath)}')">${icon('trash-2')} <span>Delete Folder</span></button>
        `;
    }

    document.body.appendChild(menu);
    _activeContextMenu = menu;

    const rect = menu.getBoundingClientRect();
    let x = event.clientX;
    let y = event.clientY;
    if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 8;
    if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 8;
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    refreshIcons(menu);
}

function _findCollectionPath(collections, targetKey, parentPath) {
    for (const col of collections) {
        const resolved = col.local_path || (parentPath ? parentPath + '/' + col.name : '');
        if (col.collection_key === targetKey) {
            return resolved;
        }
        if (col.children && col.children.length > 0) {
            const found = _findCollectionPath(col.children, targetKey, resolved);
            if (found) return found;
        }
    }
    return '';
}

function _resolveCollectionPath(sourceDir, collectionKey, collectionName) {
    const treeData = appState.libraryTreeData || [];
    for (const d of treeData) {
        if (d.normalized_path === sourceDir || d.path === sourceDir) {
            const found = _findCollectionPath(d.collections || [], collectionKey, sourceDir);
            if (found) return found;
        }
    }
    return sourceDir + '/' + (collectionName || '');
}

function showItemContextMenu(event, itemKey) {
    event.preventDefault();
    event.stopPropagation();
    hideContextMenu();

    const item = appState.libraryItems.find(i => i.item_key === itemKey);
    if (!item) return;

    const menu = document.createElement('div');
    menu.className = 'ctx-menu';
    menu.innerHTML = `
        <button class="ctx-item" onclick="hideContextMenu(); openMetadataEditor('${escapeJs(itemKey)}')">${icon('pencil')} <span>Edit Metadata</span></button>
        <button class="ctx-item" onclick="hideContextMenu(); moveItemsTo(['${escapeJs(itemKey)}'])">${icon('corner-down-right')} <span>Move To…</span></button>
        <button class="ctx-item" onclick="hideContextMenu(); copyItemsTo(['${escapeJs(itemKey)}'])">${icon('copy')} <span>Copy To…</span></button>
        ${item.file_path ? `<button class="ctx-item" onclick="hideContextMenu(); openInFileManager('${escapeJs(item.file_path)}')">${icon('external-link')} <span>Show in File Manager</span></button>` : ''}
        <div class="ctx-sep"></div>
        <button class="ctx-item danger" onclick="hideContextMenu(); deleteLibraryItem('${escapeJs(itemKey)}', false)">${icon('trash-2')} <span>Remove from App</span></button>
    `;

    document.body.appendChild(menu);
    _activeContextMenu = menu;

    const rect = menu.getBoundingClientRect();
    let x = event.clientX;
    let y = event.clientY;
    if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 8;
    if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 8;
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    refreshIcons(menu);
}

function _positionMenuFromBtn(menu, btn) {
    const btnRect = btn.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    let x = btnRect.left;
    let y = btnRect.bottom + 4;
    if (x + menuRect.width > window.innerWidth) x = window.innerWidth - menuRect.width - 8;
    if (y + menuRect.height > window.innerHeight) y = btnRect.top - menuRect.height - 4;
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
}

function showItemMenuFromBtn(event, itemKey) {
    event.preventDefault();
    event.stopPropagation();
    hideContextMenu();

    const item = appState.libraryItems.find(i => i.item_key === itemKey);
    if (!item) return;

    const menu = document.createElement('div');
    menu.className = 'ctx-menu';
    menu.innerHTML = `
        <button class="ctx-item" onclick="hideContextMenu(); openProjectAssignModal('item', '${escapeJs(itemKey)}')">${icon('folder-plus')} <span>Add to Project</span></button>
        <button class="ctx-item" onclick="hideContextMenu(); openMetadataEditor('${escapeJs(itemKey)}')">${icon('pencil')} <span>Edit Metadata</span></button>
        <button class="ctx-item" onclick="hideContextMenu(); moveItemsTo(['${escapeJs(itemKey)}'])">${icon('corner-down-right')} <span>Move To…</span></button>
        <button class="ctx-item" onclick="hideContextMenu(); copyItemsTo(['${escapeJs(itemKey)}'])">${icon('copy')} <span>Copy To…</span></button>
        ${item.file_path ? `<button class="ctx-item" onclick="hideContextMenu(); openInFileManager('${escapeJs(item.file_path)}')">${icon('external-link')} <span>Show in File Manager</span></button>` : ''}
        <div class="ctx-sep"></div>
        <button class="ctx-item danger" onclick="hideContextMenu(); deleteLibraryItem('${escapeJs(itemKey)}', false)">${icon('trash-2')} <span>Remove from App</span></button>
    `;

    document.body.appendChild(menu);
    _activeContextMenu = menu;
    refreshIcons(menu);
    _positionMenuFromBtn(menu, event.currentTarget);
}

function showRelatedItemMenuFromBtn(event, itemKey) {
    event.preventDefault();
    event.stopPropagation();
    hideContextMenu();

    const menu = document.createElement('div');
    menu.className = 'ctx-menu';
    menu.innerHTML = `
        <button class="ctx-item" onclick="hideContextMenu(); openPreview('${escapeJs(itemKey)}')">${icon('book-open')} <span>Open Document</span></button>
        <button class="ctx-item" onclick="hideContextMenu(); openMetadataEditor('${escapeJs(itemKey)}')">${icon('pencil')} <span>Edit Metadata</span></button>
    `;

    document.body.appendChild(menu);
    _activeContextMenu = menu;
    refreshIcons(menu);
    _positionMenuFromBtn(menu, event.currentTarget);
}

async function openInFileManager(path) {
    const dirPath = path;
    try {
        await fetch('/api/open-directory', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: dirPath }),
        });
    } catch (err) {
        console.error('Open in file manager error:', err);
    }
}

async function createFolderIn(parentPath) {
    const name = prompt('New folder name:');
    if (!name || !name.trim()) return;
    try {
        const res = await fetch('/api/folders/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ parent_path: parentPath, folder_name: name.trim() }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'Failed to create folder');
        if (data.source_dir) appState.expandedDirs.add(data.source_dir);
        if (data.parent_collection_key) appState.expandedCollections.add(data.parent_collection_key);
        if (data.collection_key) appState.expandedCollections.add(data.collection_key);
        await loadLibraryTree({ force: true });
    } catch (err) {
        alert('Error: ' + err.message);
    }
}

async function renameFolder(folderPath, currentName, collectionKey = '') {
    const newName = prompt('Rename folder:', currentName);
    if (!newName || !newName.trim() || newName.trim() === currentName) return;
    try {
        const res = await fetch('/api/folders/rename', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folder_path: folderPath, new_name: newName.trim(), collection_key: collectionKey }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'Failed to rename folder');
        if (data.source_dir) appState.expandedDirs.add(data.source_dir);
        if (data.parent_collection_key) appState.expandedCollections.add(data.parent_collection_key);
        if (data.new_collection_key) {
            appState.expandedCollections.add(data.new_collection_key);
            if (appState.activeCollectionKey === (data.old_collection_key || collectionKey)) {
                appState.activeCollectionKey = data.new_collection_key;
            }
        }
        await loadLibraryTree({ force: true });
        await loadLibraryItems();
    } catch (err) {
        alert('Error: ' + err.message);
    }
}

async function deleteFolder(folderPath) {
    const name = folderPath.split('/').pop() || folderPath;
    if (!confirm(`Delete folder "${name}"?\n\nThis will also remove it from the app.`)) return;
    try {
        const res = await fetch('/api/folders/delete', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folder_path: folderPath, delete_contents: false }),
        });
        const data = await res.json();
        let dataFinal = data;
        if (!res.ok) {
            if (data.detail && data.detail.includes('not empty')) {
                const confirmDelete = confirm(`Folder "${name}" is not empty. Delete folder and ALL its contents?`);
                if (!confirmDelete) return;
                const res2 = await fetch('/api/folders/delete', {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ folder_path: folderPath, delete_contents: true }),
                });
                const data2 = await res2.json();
                if (!res2.ok) throw new Error(data2.detail || 'Failed to delete folder');
                dataFinal = data2;
            } else {
                throw new Error(data.detail || 'Failed to delete folder');
            }
        }
        const activePath = appState.activeCollectionKey
            ? _resolveCollectionPath(appState.activeSourceDir, appState.activeCollectionKey, '')
            : '';
        if (
            appState.activeCollectionKey &&
            (appState.activeCollectionKey === dataFinal.deleted_collection_key ||
             activePath === folderPath ||
             activePath.startsWith(folderPath + '/'))
        ) {
            appState.activeCollectionKey = '';
            appState.activeSourceDir = dataFinal.source_dir || appState.activeSourceDir || '';
        }
        await loadLibraryTree({ force: true });
        await loadLibraryItems();
    } catch (err) {
        alert('Error: ' + err.message);
    }
}

async function removeLibraryDir(dirPath) {
    const name = dirPath.split('/').pop() || dirPath;
    if (!confirm(`Remove "${name}" from TarCite?\n\nThis removes the folder from your library and clears its indexed items. Files on disk are not deleted.`)) return;
    try {
        const res = await fetch('/api/settings/remove-directory', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dir_path: dirPath, delete_items: true }),
        });
        const data = await res.json();
        if (data.status !== 'saved') throw new Error(data.message || 'Failed to remove library.');
        await loadLibraryTree({ force: true });
        await loadLibraryItems();
    } catch (err) {
        alert('Error: ' + err.message);
    }
}

async function moveFolderTo(folderPath) {
    const targetParent = await showFolderPickerModal('Move Folder To…');
    if (!targetParent) return;
    try {
        const res = await fetch('/api/folders/move', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folder_path: folderPath, target_parent: targetParent }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'Failed to move folder');
        if (data.source_dir) appState.expandedDirs.add(data.source_dir);
        if (data.parent_collection_key) appState.expandedCollections.add(data.parent_collection_key);
        if (data.new_collection_key) {
            appState.expandedCollections.add(data.new_collection_key);
            if (appState.activeCollectionKey === data.old_collection_key) {
                appState.activeCollectionKey = data.new_collection_key;
                appState.activeSourceDir = data.source_dir || appState.activeSourceDir;
            }
        }
        await loadLibraryTree({ force: true });
        await loadLibraryItems();
    } catch (err) {
        alert('Error: ' + err.message);
    }
}

async function moveItemsTo(itemKeys) {
    const targetDir = await showFolderPickerModal('Move Items To…');
    if (!targetDir) return;
    try {
        const res = await fetch('/api/items/move', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ item_keys: itemKeys, target_dir: targetDir }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'Failed to move items');
        const msg = data.errors && data.errors.length > 0
            ? `Moved ${data.count} item(s). ${data.errors.join('; ')}`
            : `Moved ${data.count} item(s) successfully.`;
        alert(msg);
        await loadLibraryTree({ force: true });
        await loadLibraryItems();
    } catch (err) {
        alert('Error: ' + err.message);
    }
}

async function copyItemsTo(itemKeys) {
    const targetDir = await showFolderPickerModal('Copy Items To…');
    if (!targetDir) return;
    try {
        const res = await fetch('/api/items/copy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ item_keys: itemKeys, target_dir: targetDir }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'Failed to copy items');
        alert(`Copied ${data.count} file(s). Run a scan to index the copies.`);
    } catch (err) {
        alert('Error: ' + err.message);
    }
}

function showFolderPickerModal(title) {
    return new Promise(resolve => {
        let backdrop = document.getElementById('folder-picker-backdrop');
        if (backdrop) backdrop.remove();

        backdrop = document.createElement('div');
        backdrop.id = 'folder-picker-backdrop';
        backdrop.className = 'modal-backdrop';
        backdrop.innerHTML = `
            <div class="modal-panel" style="width:440px;">
                <div class="modal-header">
                    <h3>${escapeHtml(title || 'Select Folder')}</h3>
                    <button class="modal-close-btn" data-action="cancel">&times;</button>
                </div>
                <div class="modal-body">
                    <label class="settings-label">Target Directory</label>
                    <div class="dir-input-row">
                        <input type="text" id="picker-target-path" class="settings-input" placeholder="Choose a folder…">
                        <button class="btn btn-secondary" onclick="browseFolder('picker-target-path')">${icon('folder')} Browse</button>
                    </div>
                    <div id="picker-existing" style="margin-top:12px;"></div>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-secondary" data-action="cancel">Cancel</button>
                    <button class="btn btn-primary" data-action="confirm">Move Here</button>
                </div>
            </div>
        `;
        document.body.appendChild(backdrop);
        refreshIcons(backdrop);

        const input = document.getElementById('picker-target-path');
        const existingDiv = document.getElementById('picker-existing');

        const suggestions = [];
        (appState.libraryTreeData || []).forEach(d => {
            const rootPath = d.normalized_path || d.path || d.source_dir || '';
            if (!rootPath) return;
            suggestions.push({
                path: rootPath,
                label: d.label || (rootPath.split('/').pop() || rootPath),
                depth: 0,
            });
            const walk = (collections, depth) => {
                (collections || []).forEach(col => {
                    if (col.local_path) {
                        suggestions.push({ path: col.local_path, label: col.name || col.local_path, depth });
                    }
                    if (col.children && col.children.length > 0) walk(col.children, depth + 1);
                });
            };
            walk(d.collections || [], 1);
        });

        const dirs = suggestions.length > 0
            ? suggestions
            : (appState.settings?.reference_dirs || []).map(d => ({
                path: d.path,
                label: d.label || d.path,
                depth: 0,
            }));

        if (dirs.length > 0) {
            existingDiv.innerHTML = '<label class="settings-label" style="margin-bottom:6px;">Or pick a library folder:</label>' +
                dirs.map(d => {
                    const indent = '&nbsp;'.repeat((d.depth || 0) * 4);
                    return `<button class="dir-suggestion" data-dir="${escapeHtml(d.path)}">${indent}${escapeHtml(d.label || d.path)}</button>`;
                }).join('');
            existingDiv.querySelectorAll('.dir-suggestion').forEach(btn => {
                btn.addEventListener('click', () => { input.value = btn.dataset.dir; });
            });
        }

        backdrop.addEventListener('mousedown', e => { if (e.target === backdrop) { backdrop.remove(); resolve(null); } });
        backdrop.querySelector('[data-action="cancel"]').addEventListener('click', () => { backdrop.remove(); resolve(null); });
        backdrop.querySelector('[data-action="confirm"]').addEventListener('click', () => {
            const val = input.value.trim();
            backdrop.remove();
            resolve(val || null);
        });
    });
}

function formatCreators(creators) {
    if (!creators) return '';
    if (typeof creators === 'string') {
        try { creators = JSON.parse(creators); } catch { return ''; }
    }
    if (!Array.isArray(creators)) return '';
    return creators.slice(0, 3).map(c => {
        const last = c.lastName || c.last_name || '';
        const first = c.firstName || c.first_name || '';
        if (last) return `${last}${first ? ', ' + first : ''}`;
        return c.name || '';
    }).join('; ');
}

function creatorsToLines(creators) {
    if (!creators) return '';
    if (typeof creators === 'string') {
        try { creators = JSON.parse(creators); } catch { return ''; }
    }
    if (!Array.isArray(creators)) return '';
    return creators.map(c => {
        const last = c.lastName || c.last_name || '';
        const first = c.firstName || c.first_name || '';
        if (last && first) return `${last}, ${first}`;
        return last || c.name || '';
    }).filter(Boolean).join('\n');
}

function parseCreatorLines(raw) {
    return raw.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
        if (line.includes(',')) {
            const [last, ...rest] = line.split(',');
            return {
                creatorType: 'author',
                lastName: last.trim(),
                firstName: rest.join(',').trim(),
                name: '',
            };
        }
        const parts = line.split(/\s+/);
        if (parts.length > 1) {
            return {
                creatorType: 'author',
                lastName: parts.pop(),
                firstName: parts.join(' '),
                name: '',
            };
        }
        return {
            creatorType: 'author',
            lastName: '',
            firstName: '',
            name: line,
        };
    });
}
