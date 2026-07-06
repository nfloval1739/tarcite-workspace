/* ── TarCite Workspace - Settings, Models, Quota, and Connectors ──────── */

/* ── Settings ──────────────────────────────────────────────────────────────── */

function initSettingsForm() {
    document.getElementById('save-settings-btn').addEventListener('click', saveSettings);
    document.getElementById('open-dir-modal-btn')?.addEventListener('click', openDirectoryModal);
    document.getElementById('open-profile-modal-btn').addEventListener('click', openProfileModalForAdd);
    document.getElementById('add-dir-btn').addEventListener('click', addDirectory);
    document.getElementById('test-dir-btn').addEventListener('click', testDirectory);
    document.getElementById('add-profile-btn').addEventListener('click', saveProfileFromForm);
    document.getElementById('test-profile-btn').addEventListener('click', testDraftProfile);
    document.getElementById('active-profile-select').addEventListener('change', e => activateProfile(e.target.value));
    document.getElementById('edit-profile-btn').addEventListener('click', editActiveProfile);
    document.getElementById('delete-profile-btn').addEventListener('click', deleteActiveProfile);
    document.getElementById('test-active-profile-btn').addEventListener('click', testActiveProfile);
    document.getElementById('translation-source-select')?.addEventListener('change', e => {
        appState.translationSource = e.target.value || 'en';
        localStorage.setItem('translationSource', appState.translationSource);
        renderTranslationPackageManager();
    });
    document.getElementById('translation-target-select')?.addEventListener('change', e => {
        appState.translationTarget = e.target.value || 'id';
        localStorage.setItem('translationTarget', appState.translationTarget);
        renderTranslationPackageManager();
    });
    document.querySelectorAll('[data-close-modal]').forEach(btn => {
        btn.addEventListener('click', () => closeModal(btn.dataset.closeModal));
    });
    document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
        backdrop.addEventListener('mousedown', e => {
            if (e.target === backdrop) closeModal(backdrop.id);
        });
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') closeAllModals();
    });
}

function openModal(id) {
    document.getElementById(id).classList.remove('hidden');
}

function closeModal(id) {
    document.getElementById(id).classList.add('hidden');
}

function closeAllModals() {
    document.querySelectorAll('.modal-backdrop').forEach(el => el.classList.add('hidden'));
}

function openDirectoryModal() {
    document.getElementById('new-dir-path').value = '';
    document.getElementById('new-dir-label').value = '';
    setInlineResult('dir-test-result', '');
    openModal('directory-modal');
}

async function openZoteroImportModal() {
    setInlineResult('zotero-import-msg', '');
    document.getElementById('zotero-dest-path').value = '';
    document.getElementById('zotero-label').value = 'Zotero Library';
    document.getElementById('zotero-preview-tree').innerHTML = '';
    document.getElementById('zotero-db-path').value = '';
    document.getElementById('zotero-import-btn').disabled = true;
    openModal('zotero-import-modal');

    setInlineResult('zotero-import-msg', 'Detecting Zotero…');
    try {
        const res = await fetch('/api/zotero/detect');
        const data = await res.json();
        if (!data.found) {
            setInlineResult('zotero-import-msg', 'Zotero not found. Is Zotero installed?', 'error');
            return;
        }
        document.getElementById('zotero-db-path').value = data.db_path || '';
        setInlineResult('zotero-import-msg', `Found ${data.total_pdfs || 0} PDFs in Zotero library.`, 'success');
        document.getElementById('zotero-import-btn').disabled = false;
        renderZoteroPreviewTree(data.collections || [], document.getElementById('zotero-preview-tree'));
    } catch (err) {
        setInlineResult('zotero-import-msg', `Error: ${err.message}`, 'error');
    }
}

function renderZoteroPreviewTree(collections, container, depth = 0) {
    collections.forEach(col => {
        const div = document.createElement('div');
        div.style.paddingLeft = `${depth * 14 + 4}px`;
        div.style.padding = `3px 4px 3px ${depth * 14 + 4}px`;
        div.style.fontSize = '13px';
        div.style.color = 'var(--text-secondary)';
        div.textContent = `${col.name}${col.pdf_count ? ` (${col.pdf_count})` : ''}`;
        container.appendChild(div);
        if (col.children && col.children.length > 0) {
            renderZoteroPreviewTree(col.children, container, depth + 1);
        }
    });
}

async function doZoteroImport() {
    const dbPath = document.getElementById('zotero-db-path').value.trim();
    const destPath = document.getElementById('zotero-dest-path').value.trim();
    const label = document.getElementById('zotero-label').value.trim() || 'Zotero Library';

    if (!destPath) {
        setInlineResult('zotero-import-msg', 'Choose a destination folder.', 'error');
        return;
    }

    const btn = document.getElementById('zotero-import-btn');
    btn.disabled = true;
    setInlineResult('zotero-import-msg', 'Starting import…');

    try {
        const res = await fetch('/api/zotero/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ db_path: dbPath, dest_path: destPath, label }),
        });

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                try {
                    const msg = JSON.parse(line.slice(6));
                    if (msg.type === 'progress') {
                        setInlineResult('zotero-import-msg', `${msg.step}${msg.detail ? ' — ' + msg.detail : ''}`);
                    } else if (msg.type === 'done') {
                        setInlineResult('zotero-import-msg',
                            `Done! Copied ${msg.copied} files to ${msg.destination}`, 'success');
                        setTimeout(() => {
                            closeModal('zotero-import-modal');
                            loadLibraryTree({ force: true });
                            loadLibraryItems();
                        }, 2000);
                    } else if (msg.type === 'error') {
                        setInlineResult('zotero-import-msg', `Import error: ${msg.error}`, 'error');
                        btn.disabled = false;
                    }
                } catch {}
            }
        }
    } catch (err) {
        setInlineResult('zotero-import-msg', `Error: ${err.message}`, 'error');
        btn.disabled = false;
    }
}

async function openMendeleyImportModal() {
    setInlineResult('mendeley-import-msg', '');
    document.getElementById('mendeley-dest-path').value = '';
    document.getElementById('mendeley-label').value = 'Mendeley Library';
    document.getElementById('mendeley-db-path').value = '';
    document.getElementById('mendeley-import-btn').disabled = true;
    document.getElementById('mendeley-preview-info').style.display = 'none';
    openModal('mendeley-import-modal');

    setInlineResult('mendeley-import-msg', 'Detecting Mendeley…');
    try {
        const res = await fetch('/api/mendeley/detect');
        const data = await res.json();
        if (!data.found) {
            setInlineResult('mendeley-import-msg', 'Mendeley Reference Manager not found. Is it installed?', 'error');
            return;
        }
        if (data.error) {
            setInlineResult('mendeley-import-msg', `Found Mendeley but could not read library: ${data.error}`, 'error');
            return;
        }
        document.getElementById('mendeley-db-path').value = data.db_path || '';

        // Show preview
        const preview = document.getElementById('mendeley-preview-info');
        preview.style.display = 'block';
        document.getElementById('mendeley-preview-counts').textContent =
            `${data.total_docs || 0} documents · ${data.total_pdfs || 0} PDF(s) stored locally`;

        const colDiv = document.getElementById('mendeley-preview-collections');
        const cols = data.collections || [];
        if (cols.length) {
            colDiv.innerHTML = '<strong style="color:var(--text-secondary)">Collections:</strong> ' +
                cols.map(c => escapeHtml(c.name)).join(' · ');
        } else {
            colDiv.textContent = 'No user collections found.';
        }

        setInlineResult('mendeley-import-msg',
            `Found Mendeley library with ${data.total_docs || 0} documents.`, 'success');
        document.getElementById('mendeley-import-btn').disabled = false;
    } catch (err) {
        setInlineResult('mendeley-import-msg', `Error: ${err.message}`, 'error');
    }
}

async function doMendeleyImport() {
    const dbPath = document.getElementById('mendeley-db-path').value.trim();
    const destPath = document.getElementById('mendeley-dest-path').value.trim();
    const label = document.getElementById('mendeley-label').value.trim() || 'Mendeley Library';

    if (!destPath) {
        setInlineResult('mendeley-import-msg', 'Choose a destination folder.', 'error');
        return;
    }

    const btn = document.getElementById('mendeley-import-btn');
    btn.disabled = true;
    setInlineResult('mendeley-import-msg', 'Starting import…');

    try {
        const res = await fetch('/api/mendeley/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ db_path: dbPath, dest_path: destPath, label }),
        });

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                try {
                    const msg = JSON.parse(line.slice(6));
                    if (msg.type === 'progress') {
                        setInlineResult('mendeley-import-msg',
                            `${msg.step}${msg.detail ? ' — ' + msg.detail : ''}`);
                    } else if (msg.type === 'done') {
                        const note = msg.skipped
                            ? ` (${msg.skipped} doc(s) have no local PDF — metadata still exported)`
                            : '';
                        setInlineResult('mendeley-import-msg',
                            `Done! ${msg.total_docs} docs · ${msg.copied} PDF(s) copied to ${msg.destination}${note}`,
                            'success');
                        setTimeout(() => {
                            closeModal('mendeley-import-modal');
                            loadLibraryTree({ force: true });
                            loadLibraryItems();
                        }, 2500);
                    } else if (msg.type === 'error') {
                        setInlineResult('mendeley-import-msg', `Import error: ${msg.error}`, 'error');
                        btn.disabled = false;
                    }
                } catch {}
            }
        }
    } catch (err) {
        setInlineResult('mendeley-import-msg', `Error: ${err.message}`, 'error');
        btn.disabled = false;
    }
}

async function browseFolder(targetInputId) {
    const input = document.getElementById(targetInputId);
    const start = input?.value?.trim() || '';
    const btn = input?.parentElement?.querySelector('button');
    if (btn) btn.disabled = true;
    try {
        const res = await fetch(`/api/browse-folder?start=${encodeURIComponent(start)}`);
        const data = await res.json();
        if (!data.cancelled && data.path) {
            input.value = data.path;
            input.dispatchEvent(new Event('input'));
        }
    } catch (err) {
        console.error('browseFolder error:', err);
    } finally {
        if (btn) btn.disabled = false;
    }
}

function openProfileModalForAdd() {
    clearProfileForm();
    setInlineResult('profile-test-result', '');
    document.getElementById('profile-modal-title').textContent = 'Add AI Profile';
    openModal('profile-modal');
}

async function loadSettings(options = {}) {
    return dedupeAsync('loadSettings', async () => {
        try {
            const res = await fetch('/api/settings');
            appState.settings = await res.json();
            populateSettingsForm();
            loadBackupStatus();
            loadDirectorySuggestions();
        } catch (err) {
            console.error('Load settings error:', err);
        }
    }, options);
}

function setBackupMessage(message, status = '') {
    const el = document.getElementById('backup-msg');
    if (!el) return;
    el.textContent = message || '';
    el.className = `settings-inline-result ${status}`;
}

async function loadBackupStatus() {
    const detail = document.getElementById('backup-card-detail');
    if (!detail) return;
    try {
        const res = await fetch('/api/backup/status');
        if (!res.ok) throw new Error('Could not load backup status');
        const data = await res.json();
        const counts = data.counts || {};
        const parts = [
            `${counts.items || 0} item(s)`,
            `${counts.annotations || 0} annotation(s)`,
            `${counts.tags || 0} tag(s)`,
        ];
        detail.textContent = `${parts.join(' · ')}. Backups include the database and settings.`;
    } catch (err) {
        detail.textContent = 'Backups include the database and settings.';
    }
}

function backupFilenameFromResponse(res) {
    const disposition = res.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename="?([^"]+)"?/i);
    return match ? match[1] : `tarcite_workspace_backup_${_exportDateStamp()}.zip`;
}

async function exportWorkspaceBackup() {
    const btn = document.getElementById('export-backup-btn');
    if (btn) btn.disabled = true;
    setBackupMessage('Creating backup...');
    try {
        const res = await fetch('/api/backup/export');
        if (!res.ok) {
            let message = `Backup failed (${res.status})`;
            try { message = (await res.json()).detail || message; } catch {}
            throw new Error(message);
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = backupFilenameFromResponse(res);
        a.click();
        URL.revokeObjectURL(url);
        setBackupMessage('Backup created.', 'success');
        loadBackupStatus();
    } catch (err) {
        setBackupMessage(err.message || 'Backup failed.', 'error');
    } finally {
        if (btn) btn.disabled = false;
    }
}

async function restoreWorkspaceBackup(event) {
    const input = event.target;
    const file = input.files?.[0];
    if (!file) return;

    const ok = confirm(
        'Restore this workspace backup?\n\nThis will replace the current TarCite database and settings. A pre-restore safety backup will be created automatically.'
    );
    if (!ok) {
        input.value = '';
        return;
    }

    const btn = document.getElementById('export-backup-btn');
    if (btn) btn.disabled = true;
    setBackupMessage('Restoring backup...');

    try {
        const form = new FormData();
        form.append('file', file);
        const res = await fetch('/api/backup/restore', { method: 'POST', body: form });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.detail || `Restore failed (${res.status})`);

        appState.annotations = [];
        appState.annotationsViewItems = [];
        appState.annotationsViewSelected.clear();
        await loadSettings({ force: true });
        await loadAllTags({ force: true });
        await loadLibraryTree({ force: true });
        await loadLibraryItems();
        await loadLibraryStats();
        if (appState.activeCenterView === 'annotations') await loadAnnotationsViewData();

        const counts = data.counts || {};
        setBackupMessage(`Restore complete: ${counts.items || 0} item(s), ${counts.annotations || 0} annotation(s). Run a scan if search results look stale.`, 'success');
    } catch (err) {
        setBackupMessage(err.message || 'Restore failed.', 'error');
    } finally {
        input.value = '';
        if (btn) btn.disabled = false;
    }
}

/* ── Project / thesis workspaces ──────────────────────────────────────────── */

function projectTypeLabel(type) {
    return ({
        thesis_chapter: 'Thesis chapter',
        article: 'Journal article',
        systematic_review: 'Systematic review',
        proposal: 'Proposal',
        project: 'Project',
    })[type] || 'Project';
}

/* ── MODEL PACKAGE MANAGER ────────────────────────────────────────────────── */

let _pkgPollTimer = null;
let _packagesLoading = false;
let _packagesLoadedAt = 0;
const PACKAGE_REFRESH_INTERVAL_MS = 15000;

function _fmtBytes(b) {
    if (!b) return '';
    if (b >= 1e9) return (b / 1e9).toFixed(1) + ' GB';
    if (b >= 1e6) return (b / 1e6).toFixed(0) + ' MB';
    return (b / 1e3).toFixed(0) + ' KB';
}

/* ── OFFLINE TRANSLATION PACKAGE MANAGER ─────────────────────────────────── */

let _translationPollTimer = null;
let _translationPackagesLoading = false;
let _translationPackagesLoadedAt = 0;

function _translationPairKey(fromCode, toCode) {
    return `${fromCode || ''}_${toCode || ''}`;
}

function _translationPackageByPair(fromCode, toCode) {
    return (appState.translationPackages || []).find(p => p.from_code === fromCode && p.to_code === toCode);
}

function _translationPairName(fromCode, toCode) {
    const pkg = _translationPackageByPair(fromCode, toCode);
    if (pkg) return pkg.name;
    return `${String(fromCode || '').toUpperCase()} -> ${String(toCode || '').toUpperCase()}`;
}

function _translationStatusControl(pkg) {
    const ds = pkg.download_state;
    if (pkg.installed) return '<span class="pkg-badge installed">Installed</span>';
    if (!ds) return `<button class="pkg-badge pkg-download-badge" type="button" onclick="downloadTranslationPackage('${escapeJs(pkg.slug)}')">Download</button>`;
    if (ds.status === 'downloading') return `<span class="pkg-badge downloading">Downloading ${ds.pct}%</span>`;
    if (ds.status === 'installing') return '<span class="pkg-badge installing">Installing...</span>';
    if (ds.status === 'done') return '<span class="pkg-badge installed">Installed</span>';
    if (ds.status === 'error') {
        return `<button class="pkg-badge pkg-download-badge error" type="button" title="${escapeHtml(ds.error || 'Retry download')}" onclick="downloadTranslationPackage('${escapeJs(pkg.slug)}')">Retry</button>`;
    }
    return `<button class="pkg-badge pkg-download-badge" type="button" onclick="downloadTranslationPackage('${escapeJs(pkg.slug)}')">Download</button>`;
}

function _renderTranslationDownloadArea(pkg) {
    const ds = pkg.download_state;
    if (!ds || !['downloading','installing'].includes(ds.status)) return '';
    const pct = ds.status === 'installing' ? 100 : ds.pct;
    const label = ds.status === 'installing' ? 'Installing...' : _fmtBytes(ds.bytes_downloaded) + ' / ' + _fmtBytes(ds.total_bytes);
    return `<div class="pkg-progress-row">
        <div class="pkg-progress-wrap">
            <div class="pkg-progress-bar" style="width:${pct}%"></div>
        </div>
        <span class="pkg-progress-label">${label}</span>
        ${ds.status === 'downloading' ? `<button class="pkg-cancel-btn" type="button" onclick="cancelTranslationPackage('${escapeJs(pkg.slug)}')">Cancel</button>` : ''}
    </div>`;
}

async function loadTranslationPackages(options = {}) {
    const container = document.getElementById('translation-packages-list');
    if (!container) return;
    const force = Boolean(options.force);
    if (!force && _translationPackagesLoading) return;
    if (!force && appState.translationPackages.length && Date.now() - _translationPackagesLoadedAt < PACKAGE_REFRESH_INTERVAL_MS) {
        renderTranslationPackageManager();
        return;
    }

    _translationPackagesLoading = true;
    try {
        const res = await fetch('/api/translation/packages');
        const data = await res.json();
        appState.translationPackages = data.packages || [];
        appState.translationInstalledPairs = data.installed_pairs || [];
        _translationPackagesLoadedAt = Date.now();
        if (!data.available) {
            setInlineResult('translation-msg', 'Argos Translate is not installed in this environment.', 'error');
        } else {
            setInlineResult('translation-msg', '');
        }
        renderTranslationPackageManager();
        _startTranslationPoll(appState.translationPackages);
    } catch (err) {
        container.innerHTML = '<p class="packages-empty">Could not load translation models.</p>';
    } finally {
        _translationPackagesLoading = false;
    }
}

function renderTranslationPackageManager() {
    const container = document.getElementById('translation-packages-list');
    const installedList = document.getElementById('translation-installed-list');
    const sourceSelect = document.getElementById('translation-source-select');
    const targetSelect = document.getElementById('translation-target-select');
    if (!container || !sourceSelect || !targetSelect) return;
    const packages = appState.translationPackages || [];
    if (!packages.length) {
        container.innerHTML = '<p class="packages-empty">No translation models available.</p>';
        if (installedList) installedList.innerHTML = '';
        return;
    }

    const sources = [...new Map(packages.map(p => [p.from_code, p.from_name || p.from_code])).entries()]
        .sort((a, b) => a[1].localeCompare(b[1]));
    if (!sources.some(([code]) => code === appState.translationSource)) appState.translationSource = sources[0]?.[0] || 'en';
    sourceSelect.innerHTML = sources.map(([code, name]) =>
        `<option value="${escapeHtml(code)}" ${code === appState.translationSource ? 'selected' : ''}>${escapeHtml(name)} (${escapeHtml(code)})</option>`
    ).join('');

    const targets = packages
        .filter(p => p.from_code === appState.translationSource)
        .map(p => [p.to_code, p.to_name || p.to_code]);
    const uniqueTargets = [...new Map(targets).entries()].sort((a, b) => a[1].localeCompare(b[1]));
    if (!uniqueTargets.some(([code]) => code === appState.translationTarget)) {
        appState.translationTarget = uniqueTargets.find(([code]) => code === 'id')?.[0] || uniqueTargets[0]?.[0] || 'id';
    }
    localStorage.setItem('translationSource', appState.translationSource);
    localStorage.setItem('translationTarget', appState.translationTarget);
    targetSelect.innerHTML = uniqueTargets.map(([code, name]) =>
        `<option value="${escapeHtml(code)}" ${code === appState.translationTarget ? 'selected' : ''}>${escapeHtml(name)} (${escapeHtml(code)})</option>`
    ).join('');

    const installedPairs = (appState.translationInstalledPairs || [])
        .map(p => ({ from_code: p.from_code, to_code: p.to_code, name: _translationPairName(p.from_code, p.to_code) }))
        .sort((a, b) => a.name.localeCompare(b.name));
    if (installedList) {
        installedList.innerHTML = installedPairs.length
            ? `<div class="translation-installed-label">Installed</div>
               <div class="translation-installed-pills">
                   ${installedPairs.map(pair => {
                       const active = pair.from_code === appState.translationSource && pair.to_code === appState.translationTarget;
                       return `<button class="translation-installed-pill ${active ? 'active' : ''}" type="button"
                            onclick="useTranslationPair('${escapeJs(pair.from_code)}','${escapeJs(pair.to_code)}')"
                            title="${escapeHtml(pair.name)}">${escapeHtml(pair.name)}</button>`;
                   }).join('')}
               </div>`
            : '<div class="translation-installed-empty">No downloaded translation models yet.</div>';
        refreshIcons(installedList);
    }

    const selected = packages.filter(p =>
        p.from_code === appState.translationSource && p.to_code === appState.translationTarget
    );
    if (!selected.length) {
        container.innerHTML = '<p class="packages-empty">No direct model for this language pair.</p>';
        return;
    }

    container.innerHTML = selected.map(pkg => `
        <div class="pkg-card translation-pkg-card" id="translation-pkg-${pkg.slug}">
            <div class="pkg-card-top">
                <div class="pkg-info">
                    <span class="pkg-name">${escapeHtml(pkg.name)}</span>
                    <span class="pkg-status-slot">${_translationStatusControl(pkg)}</span>
                </div>
                ${pkg.file_size_bytes ? `<div class="pkg-meta">${_fmtBytes(pkg.file_size_bytes)}</div>` : ''}
            </div>
            <div class="pkg-download-area">${_renderTranslationDownloadArea(pkg)}</div>
        </div>
    `).join('');
    refreshIcons(container);
}

function useTranslationPair(fromCode, toCode) {
    appState.translationSource = fromCode || 'en';
    appState.translationTarget = toCode || 'id';
    localStorage.setItem('translationSource', appState.translationSource);
    localStorage.setItem('translationTarget', appState.translationTarget);
    renderTranslationPackageManager();
}

function _startTranslationPoll(packages) {
    const hasActive = packages.some(p => p.download_state && ['downloading','installing'].includes(p.download_state.status));
    clearInterval(_translationPollTimer);
    if (hasActive) _translationPollTimer = setInterval(_pollTranslationProgress, 1200);
}

async function _pollTranslationProgress() {
    try {
        const res = await fetch('/api/translation/progress');
        const { downloads } = await res.json();
        let anyActive = false;
        downloads.forEach(ds => {
            anyActive = anyActive || ['downloading','installing'].includes(ds.status);
            _updateTranslationPkgCard(ds);
        });
        if (!anyActive) {
            clearInterval(_translationPollTimer);
            loadTranslationPackages({ force: true });
        }
    } catch { /* ignore */ }
}

function _updateTranslationPkgCard(ds) {
    const card = document.getElementById(`translation-pkg-${ds.slug}`);
    if (!card) return;
    const statusEl = card.querySelector('.pkg-status-slot');
    const areaEl = card.querySelector('.pkg-download-area');
    const pkg = { slug: ds.slug, installed: ds.status === 'done', download_state: ds.status === 'done' ? null : ds };
    if (statusEl) statusEl.innerHTML = _translationStatusControl(pkg);
    if (areaEl) areaEl.innerHTML = _renderTranslationDownloadArea(pkg);
}

async function downloadTranslationPackage(slug) {
    try {
        const res = await fetch(`/api/translation/packages/${slug}/download`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'Download failed');
        clearInterval(_translationPollTimer);
        _translationPollTimer = setInterval(_pollTranslationProgress, 1200);
        loadTranslationPackages({ force: true });
    } catch (err) {
        setInlineResult('translation-msg', err.message || 'Download failed', 'error');
    }
}

async function cancelTranslationPackage(slug) {
    await fetch(`/api/translation/packages/${slug}/cancel`, { method: 'POST' });
    loadTranslationPackages({ force: true });
}

function _pkgStatusControl(pkg) {
    const ds = pkg.download_state;
    if (pkg.installed) return `<span class="pkg-badge installed">Installed</span>`;
    if (!ds) return `<button class="pkg-badge pkg-download-badge" type="button" onclick="downloadPackage('${escapeJs(pkg.slug)}')">Download</button>`;
    if (ds.status === 'downloading') return `<span class="pkg-badge downloading">Downloading ${ds.pct}%</span>`;
    if (ds.status === 'installing') return `<span class="pkg-badge installing">Installing…</span>`;
    if (ds.status === 'done')       return `<span class="pkg-badge installed">Installed</span>`;
    if (ds.status === 'error') {
        return `<button class="pkg-badge pkg-download-badge error" type="button" title="${escapeHtml(ds.error || 'Retry download')}" onclick="downloadPackage('${escapeJs(pkg.slug)}')">Retry</button>`;
    }
    if (ds.status === 'cancelled') {
        return `<button class="pkg-badge pkg-download-badge" type="button" onclick="downloadPackage('${escapeJs(pkg.slug)}')">Download</button>`;
    }
    return `<button class="pkg-badge pkg-download-badge" type="button" onclick="downloadPackage('${escapeJs(pkg.slug)}')">Download</button>`;
}

function _renderPackageDownloadArea(pkg) {
    const ds = pkg.download_state;
    if (!ds || !['downloading','installing'].includes(ds.status)) return '';
    const pct = ds.status === 'installing' ? 100 : ds.pct;
    const label = ds.status === 'installing' ? 'Installing…' : _fmtBytes(ds.bytes_downloaded) + ' / ' + _fmtBytes(ds.total_bytes);
    return `<div class="pkg-progress-row">
        <div class="pkg-progress-wrap">
            <div class="pkg-progress-bar" style="width:${pct}%"></div>
        </div>
        <span class="pkg-progress-label">${label}</span>
        ${ds.status === 'downloading' ? `<button class="pkg-cancel-btn" type="button" onclick="cancelPackage('${escapeJs(pkg.slug)}')">Cancel</button>` : ''}
    </div>`;
}

async function loadPackages(options = {}) {
    const container = document.getElementById('packages-list');
    if (!container) return;
    const force = Boolean(options.force);
    const hasRenderedPackages = container.querySelector('.pkg-card, .packages-empty');
    if (!force && _packagesLoading) return;
    if (!force && hasRenderedPackages && Date.now() - _packagesLoadedAt < PACKAGE_REFRESH_INTERVAL_MS) return;

    _packagesLoading = true;
    try {
        const res = await fetch('/api/packages');
        const { packages } = await res.json();
        _packagesLoadedAt = Date.now();
        if (!packages.length) {
            container.innerHTML = '<p class="packages-empty">No packages available.</p>';
            return;
        }
        container.innerHTML = packages.map(pkg => `
            <div class="pkg-card" id="pkg-${pkg.slug}">
                <div class="pkg-card-top">
                    <div class="pkg-info">
                        <span class="pkg-name">${escapeHtml(pkg.name)}</span>
                        <span class="pkg-status-slot">${_pkgStatusControl(pkg)}</span>
                    </div>
                    <div class="pkg-meta">${_fmtBytes(pkg.file_size_bytes)}</div>
                </div>
                <div class="pkg-desc">${escapeHtml(pkg.description)}</div>
                <div class="pkg-download-area">${_renderPackageDownloadArea(pkg)}</div>
            </div>`).join('');
        _startPkgPoll(packages);
    } catch (err) {
        container.innerHTML = '<p class="packages-empty">Could not load packages.</p>';
    } finally {
        _packagesLoading = false;
    }
}

function renderModelPackagesCard() {
    return `
        <div class="status-card model-packages-card">
            <div class="status-card-header">
                <h4>Available Model Packages</h4>
                <button class="btn-icon-sm" id="refreshPackagesBtn" title="Refresh" aria-label="Refresh model packages" onclick="loadPackages({ force: true })">${icon('refresh-cw')}</button>
            </div>
            <div id="packages-list">
                <div class="packages-loading">Loading packages…</div>
            </div>
        </div>
    `;
}

function _startPkgPoll(packages) {
    const hasActive = packages.some(p => p.download_state && ['downloading','installing'].includes(p.download_state.status));
    clearInterval(_pkgPollTimer);
    if (hasActive) {
        _pkgPollTimer = setInterval(_pollPackageProgress, 1200);
    }
}

async function _pollPackageProgress() {
    try {
        const res = await fetch('/api/packages/progress');
        const { downloads } = await res.json();
        if (!downloads.length) { clearInterval(_pkgPollTimer); return; }

        let anyActive = false;
        downloads.forEach(ds => {
            anyActive = anyActive || ['downloading','installing'].includes(ds.status);
            _updatePkgCard(ds);
        });
        _updateDlIndicator(downloads);
        if (!anyActive) clearInterval(_pkgPollTimer);
    } catch (e) { /* ignore */ }
}

function _updatePkgCard(ds) {
    const card = document.getElementById(`pkg-${ds.slug}`);
    if (!card) return;

    const statusEl = card.querySelector('.pkg-status-slot');
    const areaEl = card.querySelector('.pkg-download-area');

    const isInstalled = ds.status === 'done';
    const pkg = { slug: ds.slug, installed: isInstalled, download_state: isInstalled ? null : ds };
    if (statusEl) statusEl.innerHTML = _pkgStatusControl(pkg);
    if (areaEl) areaEl.innerHTML = _renderPackageDownloadArea(pkg);
}

// ── Download indicator (header) ────────────────────────────────────────────

function _updateDlIndicator(downloads) {
    const wrap   = document.getElementById('dlIndicatorWrap');
    const badge  = document.getElementById('dlBadge');
    const list   = document.getElementById('dlDropdownList');
    if (!wrap) return;

    const active = downloads.filter(d => ['downloading','installing'].includes(d.status));
    wrap.style.display = downloads.length ? '' : 'none';
    badge.textContent  = active.length || '';
    badge.style.display = active.length ? '' : 'none';

    list.innerHTML = downloads.map(ds => {
        const pct   = ds.status === 'installing' ? 100 : ds.pct;
        const label = ds.status === 'done'       ? 'Done'
                    : ds.status === 'error'      ? 'Error'
                    : ds.status === 'cancelled'  ? 'Cancelled'
                    : ds.status === 'installing' ? 'Installing…'
                    : `${ds.pct}% · ${_fmtBytes(ds.bytes_downloaded)}`;
        return `<div class="dl-item">
            <span class="dl-item-name">${escapeHtml(ds.name)}</span>
            <span class="dl-item-status ${ds.status}">${label}</span>
            ${['downloading','installing'].includes(ds.status) ? `<div class="dl-item-bar"><div class="dl-item-fill" style="width:${pct}%"></div></div>` : ''}
        </div>`;
    }).join('') || '<p class="dl-item-empty">No downloads</p>';
}

async function downloadPackage(slug) {
    await fetch(`/api/packages/${slug}/download`, { method: 'POST' });
    clearInterval(_pkgPollTimer);
    _pkgPollTimer = setInterval(_pollPackageProgress, 1200);
    document.getElementById('dlIndicatorWrap').style.display = '';
    loadPackages({ force: true });
}

async function cancelPackage(slug) {
    await fetch(`/api/packages/${slug}/cancel`, { method: 'POST' });
    loadPackages({ force: true });
}

// Toggle dropdown
document.addEventListener('DOMContentLoaded', () => {
    const btn  = document.getElementById('dlIndicatorBtn');
    const drop = document.getElementById('dlDropdown');
    if (!btn) return;
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        drop.classList.toggle('open');
    });
    document.addEventListener('click', () => drop.classList.remove('open'));
});

function populateSettingsForm() {
    const s = appState.settings;
    appState.currentDirs = s.reference_dirs || [];
    appState.currentProfiles = s.ai_profiles || [];
    appState.activeProfile = s.active_profile || '';
    renderDirectorySettings(appState.currentDirs);
    renderActiveProfileSettings(appState.currentProfiles, appState.activeProfile);

    document.getElementById('citation-dir-filter').innerHTML =
        '<option value="">All directories</option>' +
        (s.reference_dirs || []).map(d => `<option value="${escapeHtml(d.path)}">${escapeHtml(d.label || d.path)}</option>`).join('');

    document.getElementById('settings-embedding-model').value = s.embedding_model || 'BAAI/bge-large-en-v1.5';
    document.getElementById('settings-reranker-model').value = s.reranker_model || 'BAAI/bge-reranker-base';
    document.getElementById('settings-crossref-mailto').value = 'info@tarcite.com';

    const active = appState.currentProfiles.find(p => p.name === appState.activeProfile);
    const sugTemp = active?.suggestion_temperature ?? s.suggestion_temperature ?? 0.1;
    const chatTemp = active?.chat_temperature ?? s.chat_temperature ?? 0.3;
    const sugTopK = active?.suggestion_top_k ?? 50;
    const citSugEl = document.getElementById('citation-suggestion-temp');
    if (citSugEl) { citSugEl.value = sugTemp; document.getElementById('citation-suggestion-temp-val').value = parseFloat(sugTemp).toFixed(2); }
    const topKSliderEl = document.getElementById('citation-top-k');
    if (topKSliderEl) { topKSliderEl.value = sugTopK; document.getElementById('citation-top-k-val').value = sugTopK; }
    document.getElementById('settings-chat-temp').value = chatTemp;
    document.getElementById('settings-chat-temp-val').textContent = parseFloat(chatTemp).toFixed(2);
    renderHeaderProfileMenu(appState.currentProfiles, appState.activeProfile);
    loadTranslationPackages();
    loadMcpStatus();
}

function renderDirectorySettings(dirs) {
    const dirsList = document.getElementById('ref-dirs-list');
    if (!dirsList) return;
    if (!dirs || dirs.length === 0) {
        dirsList.innerHTML = '<div class="settings-empty">No directories added yet.</div>';
        return;
    }
    dirsList.innerHTML = dirs.map(d => `
        <div class="dir-card">
            <div class="dir-card-info">
                ${d.label ? `<div class="dir-card-label">${escapeHtml(d.label)}</div>` : ''}
                <div class="dir-card-path">${escapeHtml(d.path)}</div>
            </div>
            <button class="settings-icon-btn edit" onclick="editDirectoryLabel('${escapeJs(d.path)}')" title="Edit label" aria-label="Edit label">${icon('pencil')}</button>
            <button class="settings-icon-btn" onclick="removeDirectory('${escapeJs(d.path)}')" title="Remove directory" aria-label="Remove directory">${icon('x')}</button>
        </div>
    `).join('');
    refreshIcons(dirsList);
}

function buildSettingsPayload(referenceDirs = appState.currentDirs) {
    return {
        reference_dirs: referenceDirs,
        embedding_model: document.getElementById('settings-embedding-model').value,
        reranker_model: document.getElementById('settings-reranker-model').value,
        crossref_mailto: document.getElementById('settings-crossref-mailto').value.trim(),
        crossref_timeout_seconds: 5,
        suggestion_temperature: parseFloat(document.getElementById('citation-suggestion-temp')?.value ?? 0.1),
        suggestion_top_k: parseInt(document.getElementById('citation-top-k')?.value ?? 50, 10),
        chat_temperature: parseFloat(document.getElementById('settings-chat-temp').value),
        mcp_enabled: document.getElementById('settings-mcp-enabled')?.checked ?? true,
    };
}

async function loadMcpStatus() {
    const badge = document.getElementById('mcp-status-badge');
    try {
        const res = await fetch('/api/mcp/status');
        const s = await res.json();
        const toggle = document.getElementById('settings-mcp-enabled');
        if (toggle) toggle.checked = !!s.enabled;
        const urlEl = document.getElementById('mcp-http-url');
        if (urlEl) urlEl.value = s.http_url || '';
        const cfgEl = document.getElementById('mcp-stdio-config');
        if (cfgEl && s.stdio) {
            const server = { command: s.stdio.command, args: s.stdio.args };
            if (s.stdio.cwd) server.cwd = s.stdio.cwd;  // omitted for packaged builds
            const cfg = { mcpServers: { tarcite: server } };
            cfgEl.textContent = JSON.stringify(cfg, null, 2);
        }
        if (badge) {
            badge.textContent = s.active ? 'Active' : 'Inactive';
            badge.className = 'mcp-status-badge ' + (s.active ? 'active' : 'inactive');
        }
        const note = document.getElementById('mcp-restart-note');
        if (note) note.style.display = s.restart_required ? 'block' : 'none';
    } catch (err) {
        if (badge) { badge.textContent = 'Unavailable'; badge.className = 'mcp-status-badge inactive'; }
    }
}

function copyMcpField(elementId) {
    const el = document.getElementById(elementId);
    if (!el) return;
    const text = el.value !== undefined && el.tagName === 'INPUT' ? el.value : el.textContent;
    navigator.clipboard.writeText(text).then(() => {
        setInlineResult('settings-msg', 'Copied to clipboard.', 'success');
    }).catch(() => {
        setInlineResult('settings-msg', 'Could not copy.', 'error');
    });
}

async function editDirectoryLabel(path) {
    const dir = appState.currentDirs.find(d => d.path === path);
    if (!dir) return;
    const nextLabel = prompt('Directory label', dir.label || '');
    if (nextLabel === null) return;
    const updatedDirs = appState.currentDirs.map(d => (
        d.path === path ? { ...d, label: nextLabel.trim() } : d
    ));

    try {
        const res = await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(buildSettingsPayload(updatedDirs)),
        });
        const data = await res.json();
        if (data.status === 'saved') {
            appState.currentDirs = updatedDirs;
            await loadSettings({ force: true });
            await loadLibraryStats();
            setInlineResult('settings-msg', 'Directory label updated.', 'success');
        } else if (data.message) {
            setInlineResult('settings-msg', data.message, 'error');
        }
    } catch (err) {
        setInlineResult('settings-msg', 'Error updating label: ' + err.message, 'error');
    }
}

function renderActiveProfileSettings(profiles, activeName) {
    const active = profiles.find(p => p.name === activeName);
    document.getElementById('active-profile-name').textContent = active?.name || '-';
    document.getElementById('active-profile-detail').textContent = active
        ? `${active.name} · ${active.ai_api_base_url || ''}`
        : 'No profile selected';

    const select = document.getElementById('active-profile-select');
    select.innerHTML = profiles.length
        ? profiles.map(p => `<option value="${escapeHtml(p.name)}" ${p.name === activeName ? 'selected' : ''}>${escapeHtml(p.provider_label ? `${p.name} (${p.provider_label})` : p.name)}</option>`).join('')
        : '<option value="">No profiles configured</option>';
}

async function loadDirectorySuggestions() {
    try {
        const res = await fetch('/api/settings/browse', { method: 'POST' });
        const data = await res.json();
        const box = document.getElementById('dir-suggestions');
        box.innerHTML = (data.suggestions || []).map(dir => `
            <button type="button" class="dir-suggestion" onclick="setDirectoryPath('${escapeJs(dir)}')" title="${escapeHtml(dir)}">${escapeHtml(dir.replace(data.home, '~'))}</button>
        `).join('');
    } catch (err) {
        console.error('Load directory suggestions error:', err);
    }
}

function setDirectoryPath(path) {
    document.getElementById('new-dir-path').value = path;
}

function setInlineResult(id, message, status = '') {
    const el = document.getElementById(id);
    el.textContent = message || '';
    el.className = `settings-inline-result ${status}`;
}

function profileFormData(existing = null) {
    return {
        name: document.getElementById('new-profile-name').value.trim(),
        provider_label: document.getElementById('new-profile-provider').value.trim(),
        ai_api_base_url: document.getElementById('new-profile-base-url').value.trim() || 'https://api.openai.com/v1',
        ai_api_key: document.getElementById('new-profile-api-key').value.trim() || existing?.ai_api_key || '',
        ai_model: document.getElementById('new-profile-model').value.trim() || 'qwen2.5:3b',
        suggestion_temperature: parseFloat(document.getElementById('citation-suggestion-temp')?.value ?? 0.1),
        suggestion_top_k: parseInt(document.getElementById('citation-top-k')?.value ?? 50, 10),
        chat_temperature: parseFloat(document.getElementById('settings-chat-temp').value),
    };
}

function clearProfileForm() {
    document.getElementById('new-profile-name').value = '';
    document.getElementById('new-profile-provider').value = '';
    document.getElementById('new-profile-base-url').value = '';
    document.getElementById('new-profile-api-key').value = '';
    document.getElementById('new-profile-model').value = '';
    appState.editingProfileName = '';
    document.getElementById('add-profile-btn').textContent = 'Add Profile';
}

async function saveSettings() {
    try {
        const active = appState.currentProfiles.find(p => p.name === appState.activeProfile);
        if (active) {
            await fetch('/api/settings/profiles/update', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    old_name: active.name,
                    profile: {
                        ...active,
                        suggestion_temperature: parseFloat(document.getElementById('citation-suggestion-temp')?.value ?? 0.1),
                        suggestion_top_k: parseInt(document.getElementById('citation-top-k')?.value ?? 50, 10),
                        chat_temperature: parseFloat(document.getElementById('settings-chat-temp').value),
                    },
                }),
            });
        }
        const body = buildSettingsPayload();
        const res = await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data = await res.json();
        if (data.status === 'saved') {
            loadSettings({ force: true });
            loadModels({ force: true });
            setInlineResult('settings-msg', 'Settings saved.', 'success');
        }
    } catch (err) {
        setInlineResult('settings-msg', 'Error saving settings: ' + err.message, 'error');
    }
}

async function addDirectory() {
    const path = document.getElementById('new-dir-path').value.trim();
    const label = document.getElementById('new-dir-label').value.trim();
    if (!path) {
        setInlineResult('dir-test-result', 'Enter a directory path first.', 'error');
        return;
    }

    try {
        const res = await fetch('/api/settings/add-directory', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dir_path: path, label }),
        });
        const data = await res.json();
        if (data.status === 'saved') {
            document.getElementById('new-dir-path').value = '';
            document.getElementById('new-dir-label').value = '';
            await loadSettings({ force: true });
            await loadLibraryTree({ force: true });
            setInlineResult('dir-test-result', 'Directory added. Starting scan...', 'success');
            closeModal('directory-modal');
            await startSync(path);
        } else {
            setInlineResult('dir-test-result', data.message, 'error');
        }
    } catch (err) {
        setInlineResult('dir-test-result', 'Error: ' + err.message, 'error');
    }
}

async function testDirectory() {
    const path = document.getElementById('new-dir-path').value.trim();
    if (!path) {
        setInlineResult('dir-test-result', 'Enter a directory path first.', 'error');
        return;
    }
    setInlineResult('dir-test-result', 'Testing...');
    try {
        const res = await fetch('/api/settings/test-directory', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dir_path: path }),
        });
        const data = await res.json();
        setInlineResult('dir-test-result', data.message, data.success ? 'success' : 'error');
    } catch (err) {
        setInlineResult('dir-test-result', 'Error: ' + err.message, 'error');
    }
}

async function removeDirectory(path) {
    const deleteItems = confirm(`Remove "${path}" from settings?\n\nPress OK to also delete its indexed items, or Cancel to only remove the directory from settings.`);
    try {
        const res = await fetch('/api/settings/remove-directory', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dir_path: path, delete_items: deleteItems }),
        });
        const data = await res.json();
        if (data.status === 'saved') {
            loadSettings({ force: true });
            loadLibraryTree({ force: true });
            loadLibraryItems();
        }
    } catch (err) {
        alert('Error: ' + err.message);
    }
}

async function saveProfileFromForm() {
    const existing = appState.currentProfiles.find(p => p.name === appState.editingProfileName);
    const profile = profileFormData(existing);
    if (!profile.name) {
        setInlineResult('profile-test-result', 'Enter a profile name.', 'error');
        return;
    }
    const isEdit = Boolean(appState.editingProfileName);
    try {
        const res = await fetch(isEdit ? '/api/settings/profiles/update' : '/api/settings/profiles/add', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(isEdit ? { old_name: appState.editingProfileName, profile } : { profile }),
        });
        const data = await res.json();
        if (data.status === 'saved') {
            clearProfileForm();
            await loadSettings({ force: true });
            await loadModels({ force: true });
            setInlineResult('profile-test-result', isEdit ? 'Profile updated.' : 'Profile added.', 'success');
            closeModal('profile-modal');
        } else {
            setInlineResult('profile-test-result', data.message, 'error');
        }
    } catch (err) {
        setInlineResult('profile-test-result', 'Error: ' + err.message, 'error');
    }
}

function editActiveProfile() {
    const profile = appState.currentProfiles.find(p => p.name === appState.activeProfile);
    if (!profile) {
        setInlineResult('active-profile-test-result', 'Select a profile to edit.', 'error');
        return;
    }
    document.getElementById('new-profile-name').value = profile.name;
    document.getElementById('new-profile-provider').value = profile.provider_label || '';
    document.getElementById('new-profile-base-url').value = profile.ai_api_base_url || '';
    document.getElementById('new-profile-api-key').value = '';
    document.getElementById('new-profile-model').value = profile.ai_model || '';
    appState.editingProfileName = profile.name;
    document.getElementById('add-profile-btn').textContent = 'Update Profile';
    document.getElementById('profile-modal-title').textContent = 'Edit AI Profile';
    setInlineResult('profile-test-result', '');
    openModal('profile-modal');
}

async function deleteActiveProfile() {
    const profileName = document.getElementById('active-profile-select').value;
    if (!profileName) return;
    if (!confirm(`Delete profile "${profileName}"?`)) return;
    try {
        const res = await fetch('/api/settings/profiles/remove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: profileName }),
        });
        const data = await res.json();
        if (data.status === 'saved') {
            clearProfileForm();
            await loadSettings({ force: true });
            await loadModels({ force: true });
            setInlineResult('active-profile-test-result', 'Profile deleted.', 'success');
        } else {
            setInlineResult('active-profile-test-result', data.message, 'error');
        }
    } catch (err) {
        setInlineResult('active-profile-test-result', 'Error: ' + err.message, 'error');
    }
}

async function testProfilePayload(profile, resultId) {
    if (!profile.ai_api_key) {
        setInlineResult(resultId, 'Enter an API key first.', 'error');
        return;
    }
    if (!profile.ai_model) {
        setInlineResult(resultId, 'Enter a model name first.', 'error');
        return;
    }
    setInlineResult(resultId, 'Testing...');
    try {
        const res = await fetch('/api/settings/test-ai', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ai_api_base_url: profile.ai_api_base_url,
                ai_api_key: profile.ai_api_key,
                ai_model: profile.ai_model,
            }),
        });
        const data = await res.json();
        setInlineResult(resultId, data.message, data.status === 'ok' ? 'success' : 'error');
    } catch (err) {
        setInlineResult(resultId, 'Error: ' + err.message, 'error');
    }
}

function testDraftProfile() {
    const existing = appState.currentProfiles.find(p => p.name === appState.editingProfileName);
    testProfilePayload(profileFormData(existing), 'profile-test-result');
}

function testActiveProfile() {
    const profile = appState.currentProfiles.find(p => p.name === appState.activeProfile);
    if (!profile) {
        setInlineResult('active-profile-test-result', 'No active profile to test.', 'error');
        return;
    }
    testProfilePayload(profile, 'active-profile-test-result');
}

async function startSync(dirPath = '') {
    const targetDir = dirPath || appState.activeSourceDir || '';
    const statusEl = document.getElementById('library-sync-status');
    if (!targetDir) {
        if (statusEl) {
            statusEl.textContent = 'Select a directory or use a directory scan button.';
            statusEl.className = 'library-sync-status error';
        }
        return;
    }

    try {
        if (statusEl) {
            statusEl.textContent = 'Starting scan...';
            statusEl.className = 'library-sync-status syncing';
        }
        const res = await fetch('/api/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ force_resync: false, dir_path: targetDir }),
        });
        const data = await res.json();
        if (statusEl) {
            statusEl.textContent = data.message || 'Scan started.';
            statusEl.className = data.status === 'already_running' ? 'library-sync-status warning' : 'library-sync-status syncing';
        }
        updateSyncStatus();
    } catch (err) {
        if (statusEl) {
            statusEl.textContent = 'Error: ' + err.message;
            statusEl.className = 'library-sync-status error';
        } else {
            alert('Error: ' + err.message);
        }
    }
}

async function updateSyncStatus() {
    try {
        const res = await fetch('/api/sync/status');
        const data = await res.json();
        const el = document.getElementById('sync-status');
        const libEl = document.getElementById('library-sync-status');
        if (data.running) {
            el.textContent = `Syncing: ${data.step}`;
            el.className = 'sync-status syncing';
            if (libEl) {
                libEl.textContent = `${data.step || 'Syncing'}${data.detail ? ': ' + data.detail : ''}`;
                libEl.className = 'library-sync-status syncing';
            }
        } else if (data.result) {
            const resultSignature = JSON.stringify(data.result);
            el.textContent = `Last sync: ${data.result.items_synced} items`;
            el.className = 'sync-status complete';
            if (libEl) {
                if (data.result.status === 'error') {
                    const errMsg = data.result.error || (data.result.errors && data.result.errors[0]) || 'Unknown error';
                    libEl.textContent = `Scan error: ${errMsg}`;
                    libEl.className = 'library-sync-status error';
                } else {
                    const skipped = data.result.items_skipped ? `, ${data.result.items_skipped} skipped` : '';
                    libEl.textContent = `Last scan: ${data.result.items_synced} processed${skipped}`;
                    libEl.className = 'library-sync-status complete';
                }
                if (resultSignature !== appState.lastSyncResultSignature) {
                    appState.lastSyncResultSignature = resultSignature;
                    loadLibraryTree({ force: true });
                    loadLibraryStats();
                    if (appState.activeCenterView === 'library') loadLibraryItems();
                }
            }
        } else {
            el.textContent = '';
            if (libEl && !libEl.textContent) libEl.className = 'library-sync-status';
        }
    } catch (err) { /* silent */ }
}

async function repairVectorIndex() {
    const statusEl = document.getElementById('repair-status');
    const btn = document.getElementById('repair-index-btn');
    try {
        if (btn) btn.disabled = true;
        if (statusEl) {
            statusEl.textContent = 'Starting repair…';
            statusEl.className = 'library-sync-status syncing';
        }
        const res = await fetch('/api/library/repair-index', { method: 'POST' });
        const data = await res.json();
        if (statusEl) {
            statusEl.textContent = data.message || 'Repair started.';
            statusEl.className = data.status === 'already_running' ? 'library-sync-status warning' : 'library-sync-status syncing';
        }
        updateSyncStatus();
    } catch (err) {
        if (statusEl) {
            statusEl.textContent = 'Error: ' + err.message;
            statusEl.className = 'library-sync-status error';
        }
    } finally {
        if (btn) btn.disabled = false;
    }
}

async function loadTextFailures() {
    try {
        const res = await fetch('/api/library/text-failures');
        const data = await res.json();
        const el = document.getElementById('text-failures');
        if (!el) return;
        if (!data.count) { el.innerHTML = ''; return; }
        const rows = data.items.map(i => {
            const fp = (i.file_path || '').replace(/"/g, '&quot;');
            const name = (i.title || i.item_key || '').toString();
            const reason = (i.text_error || 'extraction failed').toString();
            return `<li title="${fp}">${name} — <span class="muted">${reason}</span></li>`;
        }).join('');
        el.innerHTML = `<div class="warning">${data.count} file(s) could not be read for text:</div><ul>${rows}</ul>`;
    } catch (err) { /* silent */ }
}

async function loadSystemStatus() {
    loadTextFailures();
    try {
        const res = await fetch('/api/library/stats');
        const data = await res.json();
        const panel = document.getElementById('system-status');
        const statusSignature = JSON.stringify({
            packages_loaded_at: _packagesLoadedAt,
            word_connector: true,
        });
        const panelReady = panel.querySelector('.model-packages-card') && panel.querySelector('.word-connector-card');
        if (panelReady && panel.dataset.statusSignature === statusSignature) {
            loadWordConnectorStatus();
            loadPackages();
            return;
        }

        panel.dataset.statusSignature = statusSignature;
        panel.innerHTML = `
            ${renderModelPackagesCard()}
            ${renderWordConnectorCard()}
            ${renderLibraryHealthStatusCard()}
            ${renderReferenceDirectoriesCard()}
            ${renderWorkspaceBackupCard()}
        `;
        bindWordConnectorControls();
        renderDirectorySettings(appState.currentDirs);
        bindWorkspaceBackupControls();
        loadBackupStatus();
        loadWordConnectorStatus();
        loadPackages();
        loadLibraryHealthSummary();
        refreshIcons(panel);
    } catch (err) {
        console.error('Load status error:', err);
    }
}

function renderLibraryHealthStatusCard() {
    return `
        <div class="status-card library-health-status-card">
            <div class="backup-card-top">
                <div>
                    <h4>Library Health</h4>
                    <div id="library-health-card-detail" class="backup-card-detail">Checking library health...</div>
                </div>
                ${icon('shield-check')}
            </div>
            <div class="settings-action-row">
                <button class="btn-small" type="button" onclick="openLibraryHealth()">${icon('layout-dashboard')} Open Health</button>
                <button class="btn-secondary btn-small" type="button" onclick="loadLibraryHealthSummary(true)">${icon('refresh-cw')} Rescan</button>
            </div>
        </div>
    `;
}

async function loadLibraryHealthSummary(force = false) {
    const detail = document.getElementById('library-health-card-detail');
    if (!detail) return;
    detail.textContent = 'Checking library health...';
    try {
        const res = await fetch(force ? '/api/library/health/scan' : '/api/library/health', {
            method: force ? 'POST' : 'GET',
            headers: force ? { 'Content-Type': 'application/json' } : undefined,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'Health check failed');
        appState.libraryHealth = data;
        const s = data.summary || {};
        const parts = [
            `${s.duplicate_groups || 0} duplicate group${(s.duplicate_groups || 0) === 1 ? '' : 's'}`,
            `${s.broken_paths || 0} broken path${(s.broken_paths || 0) === 1 ? '' : 's'}`,
            `${(s.unindexed_files || 0) + (s.indexed_without_chunks || 0)} unindexed`,
        ];
        detail.textContent = parts.join(', ');
    } catch (err) {
        detail.textContent = `Health check failed: ${err.message}`;
    }
}

function renderWorkspaceBackupCard() {
    return `
        <div class="status-card workspace-backup-card">
            <div class="backup-card-top">
                <div>
                    <h4>Workspace Backup</h4>
                    <div id="backup-card-detail" class="backup-card-detail">Checking backup status...</div>
                </div>
                ${icon('archive')}
            </div>
            <div class="settings-action-row backup-actions">
                <button id="export-backup-btn" class="btn-small" type="button">${icon('download')} Create Backup</button>
                <label class="btn-secondary btn-small backup-restore-label" for="restore-backup-input">
                    ${icon('upload')} Restore
                    <input type="file" id="restore-backup-input" accept=".zip,application/zip" style="display:none">
                </label>
            </div>
            <div id="backup-msg" class="settings-inline-result"></div>
        </div>
    `;
}

function bindWorkspaceBackupControls() {
    document.getElementById('export-backup-btn')?.addEventListener('click', exportWorkspaceBackup);
    document.getElementById('restore-backup-input')?.addEventListener('change', restoreWorkspaceBackup);
}

function renderReferenceDirectoriesCard() {
    return `
        <div class="status-card reference-directories-card">
            <div class="status-card-header">
                <h4>Reference Directories</h4>
                <button class="btn-small" type="button" onclick="openDirectoryModal()">${icon('plus')} Add Directory</button>
            </div>
            <div id="ref-dirs-list"></div>
        </div>
    `;
}

/* ── Models ────────────────────────────────────────────────────────────────── */

async function loadModels(options = {}) {
    return dedupeAsync('loadModels', async () => {
        try {
            const res = await fetch('/api/models');
            const data = await res.json();
            appState.activeProfile = data.active_profile || '';
            const select = document.getElementById('chat-model-select');
            const models = data.models || [];
            if (select) {
                select.innerHTML = models.length
                    ? models.map(m => {
                        const label = m.name;
                        return `<option value="${escapeHtml(m.name)}" ${m.is_active ? 'selected' : ''}>${escapeHtml(label)}</option>`;
                    }).join('')
                    : '<option value="">No profiles</option>';
            }
            renderCitationProfileMenu(models, data.active_profile);
            renderHeaderProfileMenu(models, data.active_profile);
            renderPdfChatProfileSelect(models, data.active_profile);
        } catch (err) {
            console.error('Load models error:', err);
        }
    }, options);
}

async function activateProfile(profileName) {
    if (!profileName || profileName === appState.activeProfile) {
        closeProfileMenus();
        return;
    }
    try {
        const res = await fetch('/api/settings/profiles/activate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: profileName }),
        });
        const data = await res.json();
        if (data.status === 'saved') {
            appState.activeProfile = data.active_profile || profileName;
            closeProfileMenus();
            loadModels({ force: true });
            loadSettings({ force: true });
        } else if (data.message) {
            alert(data.message);
        }
    } catch (err) {
        alert('Error activating profile: ' + err.message);
    }
}

/* ── Suggestion History ────────────────────────────────────────────────────── */

async function loadSuggestionHistory(options = {}) {
    return dedupeAsync('loadSuggestionHistory', async () => {
        try {
            const res = await fetch('/api/suggestion-runs');
            const data = await res.json();
            appState.suggestionHistory = data.runs || [];
            const area = document.getElementById('suggestion-history');
            const section = document.getElementById('suggestion-history-section');
            if (area) {
                const runs = (data.runs || []).slice(0, 10);
                if (section) section.classList.toggle('hidden', runs.length === 0);
                area.innerHTML = runs.map(r => `
                    <div class="history-card" onclick="loadSuggestionRun('${r.run_id}')">
                        <div class="history-card-info">
                            <div class="history-card-title">${escapeHtml(r.title || 'Untitled')}</div>
                            <div class="history-card-meta">${escapeHtml(formatHistoryDate(r.created_at))}${formatHistoryDuration(r.elapsed_seconds)}${formatHistoryTopK(r.top_k)}${formatHistoryTemp(r.temperature)} &middot; ${escapeHtml(r.active_profile || r.ai_model || '')}</div>
                            <div class="history-card-badges">${renderConfidenceBadges(r)}</div>
                        </div>
                        <button class="history-card-delete" onclick="event.stopPropagation(); deleteSuggestionRun('${r.run_id}')" title="Delete" aria-label="Delete">${icon('x')}</button>
                    </div>
                `).join('');
                refreshIcons(area);
            }
            // Show/hide Remove All button in the history divider
            const removeAllBtn = document.getElementById('history-remove-all-btn');
            if (removeAllBtn) removeAllBtn.style.display = (data.runs || []).length ? '' : 'none';
        } catch (err) {
            console.error('Load history error:', err);
        }
    }, options);
}

async function deleteAllSuggestionRuns() {
    try {
        const res = await fetch('/api/suggestion-runs', { method: 'DELETE' });
        if (!res.ok) throw new Error(`Could not delete all history (${res.status})`);
        appState.suggestionHistory = [];
        await loadSuggestionHistory({ force: true });
    } catch (err) {
        console.error('Delete all history error:', err);
    }
}

async function deleteSuggestionRun(runId) {
    if (!confirm('Delete this suggestion run?')) return;
    try {
        const res = await fetch(`/api/suggestion-runs/${runId}`, { method: 'DELETE' });
        if (res.ok) {
            loadSuggestionHistory({ force: true });
        }
    } catch (err) {
        console.error('Delete run error:', err);
    }
}

async function loadSuggestionRun(runId) {
    try {
        const res = await fetch(`/api/suggestion-runs/${runId}`);
        const run = await res.json();
        if (run.paragraph) {
            document.getElementById('citation-paragraph').value = run.paragraph;
            appState.currentParagraph = run.paragraph;
        }
        if (run.results) {
            renderCitationResults({
                paragraph: run.paragraph || appState.currentParagraph,
                suggestions: run.results,
                candidates: [],
                warnings: [],
                run_id: run.run_id,
            });
        }
    } catch (err) {
        console.error('Load run error:', err);
    }
}

/* ── Quota & Credits ────────────────────────────────────────────────────────── */

async function loadQuotaBalance(options = {}) {
    return dedupeAsync('loadQuotaBalance', async () => {
        try {
            const res = await fetch('/api/billing/balance');
            const data = await res.json();
            appState.quotaData = data;
            renderQuotaPanel(data);
        } catch (err) {
            console.error('Load quota error:', err);
            const panel = document.getElementById('quota-panel');
            if (panel) panel.innerHTML = '<div class="quota-error">Could not load quota info.</div>';
        }
    }, options);
}

function renderQuotaPanel(data) {
    const panel = document.getElementById('quota-panel');
    if (!panel) return;

    if (data.error && !data.tier && !data.tier_usage) {
        panel.innerHTML = '<div class="quota-note">Quota info unavailable for current profile. Configure a TarCite API profile to see usage.</div>';
        return;
    }

    const tierUsage = data.tier_usage || [];
    const creditsRemaining = data.credits_remaining || 0;
    const hasCredits = creditsRemaining > 0;
    const minimumPaymentDollars = Math.round((data.minimum_payment_cents || 300) / 100);
    const requestsPerDollar = data.requests_per_dollar || 200;
    const defaultBuyAmount = Math.max(3, minimumPaymentDollars);

    let html = '';

    if (hasCredits) {
        const approxRemaining = data.approx_requests_remaining || 0;
        html += `
            <div class="quota-section">
                <div class="quota-section-title">Credits</div>
                <div class="quota-row">
                    <span class="quota-label">Remaining Premium</span>
                    <span class="quota-value">${approxRemaining} requests</span>
                </div>
                <div class="quota-note">Credits bypass the daily free limit. Billed per request.</div>
            </div>
            <hr class="quota-divider">
        `;
    }

    for (const tier of tierUsage) {
        const limit = tier.daily_limit || 0;
        const used = tier.used_today || 0;
        const remaining = limit - used;
        const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
        const barClass = pct >= 100 ? 'exhausted' : pct >= 80 ? 'low' : 'free';
        const groupLabel = tier.group === 'default' ? 'Daily Free Tier' : tier.group.charAt(0).toUpperCase() + tier.group.slice(1);

        html += `
            <div class="quota-section">
                <div class="quota-section-title">${escapeHtml(groupLabel)}</div>
                <div class="quota-row">
                    <span class="quota-label">Used today</span>
                    <span class="quota-value ${remaining <= 3 ? (remaining <= 0 ? 'danger' : 'warn') : ''}">${used} / ${limit} req</span>
                </div>
                <div class="quota-bar-track"><div class="quota-bar-fill ${barClass}" style="width:${pct}%"></div></div>
            </div>
        `;
    }

    html += `
        <hr class="quota-divider">
        <div class="quota-section">
            <div class="quota-buy-row">
                <span class="quota-label" style="font-size:13px">Buy premium:</span>
                <span class="quota-label" style="font-size:12px">$</span>
                <input type="number" id="quota-buy-amount" class="quota-buy-input" value="${defaultBuyAmount}" min="${minimumPaymentDollars}" max="100" step="1" oninput="updateQuotaBuyEstimate(${requestsPerDollar})">
                <button id="quota-buy-btn" class="quota-buy-btn" onclick="buyCredits()">Buy Premium</button>
            </div>
            <div id="quota-buy-estimate" class="quota-note">~${Math.round(defaultBuyAmount * requestsPerDollar).toLocaleString()} requests, Payment via Stripe.</div>
        </div>
    `;

    panel.innerHTML = html;
}

function updateQuotaBuyEstimate(requestsPerDollar) {
    const input = document.getElementById('quota-buy-amount');
    const note = document.getElementById('quota-buy-estimate');
    if (!input || !note) return;
    const dollars = parseFloat(input.value) || 0;
    const estimated = Math.max(0, Math.round(dollars * (requestsPerDollar || 200)));
    note.textContent = `~${estimated.toLocaleString()} requests, Payment via Stripe.`;
}

async function buyCredits() {
    const input = document.getElementById('quota-buy-amount');
    const btn = document.getElementById('quota-buy-btn');
    if (!input || !btn) return;

    const dollars = parseFloat(input.value);
    if (!dollars || dollars < 3) {
        alert('Minimum purchase is $3.');
        return;
    }
    if (dollars > 100) {
        alert('Maximum purchase is $100.');
        return;
    }

    const cents = Math.round(dollars * 100);
    btn.disabled = true;
    btn.textContent = 'Opening...';

    try {
        const res = await fetch('/api/billing/checkout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount_cents: cents }),
        });
        if (res.ok) {
            const data = await res.json();
            if (data.url) {
                window.open(data.url, '_blank');
                showQuotaModal(
                    'Checkout Opened',
                    'A Stripe payment page has been opened in your browser. After payment, your credits will be available automatically. Click "Refresh" to check your updated balance.',
                    'Refresh', () => { loadQuotaBalance({ force: true }); }
                );
            }
        } else {
            let msg = 'Could not start checkout.';
            try {
                const err = await res.json();
                msg = err.detail || msg;
            } catch {}
            alert(msg);
        }
    } catch (err) {
        alert('Checkout error: ' + err.message);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Buy';
    }
}

function showQuotaModal(title, message, actionLabel, actionFn) {
    const existing = document.querySelector('.quota-modal-backdrop');
    if (existing) existing.remove();

    const backdrop = document.createElement('div');
    backdrop.className = 'quota-modal-backdrop';
    backdrop.innerHTML = `
        <div class="quota-modal">
            <h3>${escapeHtml(title)}</h3>
            <p>${escapeHtml(message)}</p>
            <div class="quota-modal-actions">
                <button class="btn-secondary btn-small quota-modal-dismiss">Close</button>
                <button class="btn-small quota-modal-action">${escapeHtml(actionLabel)}</button>
            </div>
        </div>
    `;

    backdrop.querySelector('.quota-modal-dismiss').onclick = () => backdrop.remove();
    backdrop.querySelector('.quota-modal-action').onclick = () => {
        backdrop.remove();
        if (actionFn) actionFn();
    };
    backdrop.addEventListener('mousedown', e => {
        if (e.target === backdrop) backdrop.remove();
    });

    document.body.appendChild(backdrop);
}

function handleQuotaExceeded(message, buyUrl) {
    const msg = message || 'Daily limit reached. Buy credits for unlimited access.';
    showQuotaModal(
        'Quota Exceeded',
        msg,
        'Buy Credits',
        () => {
            if (buyUrl) {
                window.open(buyUrl, '_blank');
            } else {
                document.querySelector('.sidebar-tab[data-tab="settings"]')?.click();
            }
        }
    );
    loadQuotaBalance({ force: true });
}

function closeProfileMenus() {
    appState.citationProfileMenuOpen = false;
    appState.headerProfileMenuOpen = false;
    const citationMenu = document.getElementById('citation-profile-menu');
    const citationBtn = document.getElementById('citation-profile-btn');
    const headerMenu = document.getElementById('topbar-profile-menu');
    const headerBtn = document.getElementById('topbar-profile-btn');
    if (citationMenu) citationMenu.classList.add('hidden');
    if (citationBtn) citationBtn.setAttribute('aria-expanded', 'false');
    if (headerMenu) headerMenu.classList.add('hidden');
    if (headerBtn) headerBtn.setAttribute('aria-expanded', 'false');
}

function initHeaderProfileDropdown() {
    const btn = document.getElementById('topbar-profile-btn');
    const menu = document.getElementById('topbar-profile-menu');
    if (!btn || !menu) return;

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        appState.headerProfileMenuOpen = !appState.headerProfileMenuOpen;
        if (appState.headerProfileMenuOpen) {
            appState.citationProfileMenuOpen = false;
            document.getElementById('citation-profile-menu')?.classList.add('hidden');
            document.getElementById('citation-profile-btn')?.setAttribute('aria-expanded', 'false');
        }
        menu.classList.toggle('hidden', !appState.headerProfileMenuOpen);
        btn.setAttribute('aria-expanded', String(appState.headerProfileMenuOpen));
    });

    document.addEventListener('click', (e) => {
        if (!appState.headerProfileMenuOpen) return;
        if (btn.contains(e.target) || menu.contains(e.target)) return;
        appState.headerProfileMenuOpen = false;
        menu.classList.add('hidden');
        btn.setAttribute('aria-expanded', 'false');
    });
}

function initCitationProfileDropdown() {
    const btn = document.getElementById('citation-profile-btn');
    if (!btn) return;
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        appState.citationProfileMenuOpen = !appState.citationProfileMenuOpen;
        const menu = document.getElementById('citation-profile-menu');
        if (appState.citationProfileMenuOpen) {
            appState.headerProfileMenuOpen = false;
            document.getElementById('topbar-profile-menu')?.classList.add('hidden');
            document.getElementById('topbar-profile-btn')?.setAttribute('aria-expanded', 'false');
        }
        menu.classList.toggle('hidden', !appState.citationProfileMenuOpen);
        btn.setAttribute('aria-expanded', String(appState.citationProfileMenuOpen));
    });
    document.addEventListener('click', (e) => {
        if (!appState.citationProfileMenuOpen) return;
        const menu = document.getElementById('citation-profile-menu');
        const btn = document.getElementById('citation-profile-btn');
        if (btn && btn.contains(e.target)) return;
        if (menu && menu.contains(e.target)) return;
        appState.citationProfileMenuOpen = false;
        if (menu) menu.classList.add('hidden');
        if (btn) btn.setAttribute('aria-expanded', 'false');
    });
}

function renderHeaderProfileMenu(profiles, activeProfile) {
    const menu = document.getElementById('topbar-profile-menu');
    const label = document.getElementById('active-profile');
    if (!menu) return;

    const active = (profiles || []).find(p => p.name === activeProfile);
    if (label) {
        label.textContent = active ? active.name : 'No AI profile';
        label.title = active ? `${active.name}${active.ai_model ? ` · ${active.ai_model}` : ''}` : 'No AI profile';
    }

    if (!profiles || profiles.length === 0) {
        menu.innerHTML = '<div class="citation-profile-empty">No profiles</div>';
        return;
    }

    menu.innerHTML = profiles.map(profile => {
        const isActive = profile.name === activeProfile;
        const detail = [profile.provider_label, profile.ai_model].filter(Boolean).join(' · ');
        return `
            <button class="citation-profile-item ${isActive ? 'active' : ''}" data-profile="${escapeHtml(profile.name)}">
                <span class="topbar-profile-meta">
                    <span class="topbar-profile-name">${escapeHtml(profile.name)}</span>
                    ${detail ? `<span class="topbar-profile-detail">${escapeHtml(detail)}</span>` : ''}
                </span>
                ${isActive ? '<span class="citation-profile-check">' + icon('check') + '</span>' : ''}
            </button>`;
    }).join('');

    menu.querySelectorAll('.citation-profile-item').forEach(item => {
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            const profileName = item.dataset.profile;
            if (profileName) activateProfile(profileName);
        });
    });
    refreshIcons(menu);
}

function renderCitationProfileMenu(models, activeProfile) {
    const menu = document.getElementById('citation-profile-menu');
    const label = document.getElementById('citation-profile-label');
    if (!menu) return;

    const active = (models || []).find(m => m.name === activeProfile);
    if (label) {
        label.textContent = active ? active.name : 'No profile';
    }

    if (!models || models.length === 0) {
        menu.innerHTML = '<div class="citation-profile-empty">No profiles</div>';
        return;
    }
    menu.innerHTML = models.map(m => {
        const mLabel = m.name;
        const isActive = m.name === activeProfile;
        return `<button class="citation-profile-item ${isActive ? 'active' : ''}" data-profile="${escapeHtml(m.name)}">${escapeHtml(mLabel)}${isActive ? ' <span class="citation-profile-check">' + icon('check') + '</span>' : ''}</button>`;
    }).join('');
    menu.querySelectorAll('.citation-profile-item').forEach(item => {
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            const profileName = item.dataset.profile;
            appState.citationProfileMenuOpen = false;
            menu.classList.add('hidden');
            const btn = document.getElementById('citation-profile-btn');
            if (btn) btn.setAttribute('aria-expanded', 'false');
            if (profileName && profileName !== appState.activeProfile) {
                activateProfile(profileName);
            }
        });
    });
    refreshIcons(menu);
}

/* ── Word Connector ────────────────────────────────────────────────────────── */

function initWordConnector() {
    bindWordConnectorControls();
}

function bindWordConnectorControls() {
    const installBtn = document.getElementById('wc-install-btn');
    const repairBtn = document.getElementById('wc-repair-btn');
    const uninstallBtn = document.getElementById('wc-uninstall-btn');
    const openWordBtn = document.getElementById('wc-open-word-btn');

    if (installBtn) installBtn.onclick = installWordConnector;
    if (repairBtn) repairBtn.onclick = repairWordConnector;
    if (uninstallBtn) uninstallBtn.onclick = uninstallWordConnector;
    if (openWordBtn) openWordBtn.onclick = openWordApp;
}

function renderWordConnectorCard() {
    return `
        <div class="status-card word-connector-card">
            <h4>Word Connector</h4>
            <div id="word-connector-status" class="word-connector-status">
                <div class="wc-status-row">
                    <span class="wc-label">Status:</span>
                    <span id="wc-status-value" class="wc-value">-</span>
                </div>
                <div class="wc-status-row">
                    <span class="wc-label">Local server:</span>
                    <span id="wc-server-value" class="wc-value">-</span>
                </div>
                <div class="wc-status-row">
                    <span class="wc-label">Word URL:</span>
                    <span id="wc-word-url-value" class="wc-value">-</span>
                </div>
                <div class="wc-status-row">
                    <span class="wc-label">Manifest:</span>
                    <span id="wc-manifest-value" class="wc-value">-</span>
                </div>
                <div class="wc-status-row">
                    <span class="wc-label">Certificate:</span>
                    <span id="wc-cert-value" class="wc-value">-</span>
                </div>
                <div class="wc-status-row">
                    <span class="wc-label">Word:</span>
                    <span id="wc-word-value" class="wc-value">-</span>
                </div>
            </div>
            <div class="settings-action-row">
                <button id="wc-install-btn" class="btn-small">Install Word Connector</button>
                <button id="wc-repair-btn" class="btn-secondary btn-small">Repair</button>
                <button id="wc-uninstall-btn" class="btn-secondary btn-small danger">Uninstall</button>
                <button id="wc-open-word-btn" class="btn-secondary btn-small">Open Word</button>
            </div>
            <div id="wc-msg" class="settings-msg"></div>
        </div>
    `;
}

async function loadWordConnectorStatus() {
    try {
        const res = await fetch('/api/word/connector/status');
        const data = await res.json();
        updateWordConnectorUI(data);
    } catch (err) {
        console.error('Word connector status error:', err);
    }
}

function updateWordConnectorUI(data) {
    const statusEl = document.getElementById('wc-status-value');
    const serverEl = document.getElementById('wc-server-value');
    const wordUrlEl = document.getElementById('wc-word-url-value');
    const manifestEl = document.getElementById('wc-manifest-value');
    const certEl = document.getElementById('wc-cert-value');
    const wordEl = document.getElementById('wc-word-value');

    if (statusEl) {
        statusEl.textContent = data.status === 'installed' ? 'Installed' : 'Not installed';
        statusEl.className = 'wc-value ' + (data.status === 'installed' ? 'installed' : 'not-installed');
    }
    if (serverEl) {
        serverEl.textContent = data.local_server === 'running' ? 'Running' : 'Not running';
        serverEl.className = 'wc-value ' + (data.local_server === 'running' ? 'running' : 'not-running');
    }
    if (wordUrlEl) {
        const ok = data.word_url_reachable === 'reachable';
        wordUrlEl.textContent = ok ? 'Reachable' : 'Not reachable';
        if (data.word_url) wordUrlEl.title = data.word_url;
        wordUrlEl.className = 'wc-value ' + (ok ? 'running' : 'not-running');
    }
    if (manifestEl) {
        manifestEl.textContent = data.manifest === 'installed' ? 'Installed' : 'Not installed';
        manifestEl.className = 'wc-value ' + (data.manifest === 'installed' ? 'installed' : 'not-installed');
    }
    if (certEl) {
        certEl.textContent = data.certificate === 'trusted' ? 'Trusted' : 'Not trusted';
        certEl.className = 'wc-value ' + (data.certificate === 'trusted' ? 'trusted' : 'not-trusted');
    }
    if (wordEl) {
        wordEl.textContent = data.word === 'detected' ? 'Detected' : 'Not detected';
        wordEl.className = 'wc-value ' + (data.word === 'detected' ? 'detected' : 'not-detected');
    }
}

async function installWordConnector() {
    const msgEl = document.getElementById('wc-msg');
    if (!confirm(
        'Install Word Connector?\n\n' +
        '- A Word add-in manifest will be copied to your system.\n' +
        '- Word will be configured to trust the local connector.\n' +
        '- Word may need to restart.\n' +
        '- Your documents and library data stay on this computer.\n' +
        '- You can uninstall later from this panel.\n\n' +
        'Continue?'
    )) return;

    showWordMsg('Installing...', 'info');
    try {
        const res = await fetch('/api/word/connector/install', { method: 'POST' });
        const data = await res.json();
        if (data.status === 'success') {
            showWordMsg(data.message, 'success');
            loadWordConnectorStatus();
        } else {
            showWordMsg(data.message || 'Installation failed.', 'error');
        }
    } catch (err) {
        showWordMsg('Installation error: ' + err.message, 'error');
    }
}

async function repairWordConnector() {
    const msgEl = document.getElementById('wc-msg');
    if (!confirm('Repair Word Connector? This will reinstall the manifest.')) return;

    showWordMsg('Repairing...', 'info');
    try {
        const res = await fetch('/api/word/connector/repair', { method: 'POST' });
        const data = await res.json();
        if (data.status === 'success') {
            showWordMsg(data.message, 'success');
            loadWordConnectorStatus();
        } else {
            showWordMsg(data.message || 'Repair failed.', 'error');
        }
    } catch (err) {
        showWordMsg('Repair error: ' + err.message, 'error');
    }
}

async function uninstallWordConnector() {
    if (!confirm('Uninstall Word Connector?\n\nThis will remove the manifest from Word. You will need to reinstall to use the connector again.')) return;

    showWordMsg('Uninstalling...', 'info');
    try {
        const res = await fetch('/api/word/connector/uninstall', { method: 'POST' });
        const data = await res.json();
        if (data.status === 'success') {
            showWordMsg(data.message, 'success');
            loadWordConnectorStatus();
        } else {
            showWordMsg(data.message || 'Uninstall failed.', 'error');
        }
    } catch (err) {
        showWordMsg('Uninstall error: ' + err.message, 'error');
    }
}

async function openWordApp() {
    try {
        const res = await fetch('/api/word/connector/open-word', { method: 'POST' });
        const data = await res.json();
        showWordMsg(data.message, data.status === 'success' ? 'success' : 'error');
    } catch (err) {
        showWordMsg('Could not open Word: ' + err.message, 'error');
    }
}

function showWordMsg(text, type) {
    const msgEl = document.getElementById('wc-msg');
    if (!msgEl) return;
    msgEl.textContent = text;
    msgEl.className = 'settings-msg ' + (type === 'success' ? 'success' : type === 'error' ? 'error' : '');
    setTimeout(() => { msgEl.textContent = ''; }, 5000);
}
