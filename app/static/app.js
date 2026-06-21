/* ── TarCite Workspace - Main Application Script ──────────────────────────── */

/* ── Theme ─────────────────────────────────────────────────────────────────── */

function initTheme() {
    const saved = localStorage.getItem('theme');
    if (saved) document.documentElement.setAttribute('data-theme', saved);
    const toggle = () => {
        const current = document.documentElement.getAttribute('data-theme');
        const next = current === 'light' ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem('theme', next);
    };
    document.getElementById('theme-toggle').addEventListener('click', toggle);
    document.getElementById('fs-theme-toggle')?.addEventListener('click', toggle);

    const savedAccent = localStorage.getItem('accent') || 'blue';
    applyAccent(savedAccent);

    document.querySelectorAll('.accent-swatch').forEach(btn => {
        btn.addEventListener('click', () => {
            applyAccent(btn.dataset.accent);
            localStorage.setItem('accent', btn.dataset.accent);
        });
    });
}

function applyAccent(accent) {
    if (accent === 'blue') {
        document.documentElement.removeAttribute('data-accent');
    } else {
        document.documentElement.setAttribute('data-accent', accent);
    }
    document.querySelectorAll('.accent-swatch').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.accent === accent);
    });
}

function initHardResetButton() {
    document.getElementById('hard-reset-btn')?.addEventListener('click', hardResetApp);
}

async function hardResetApp() {
    closeInkConnectionsForInactiveProjectView?.();
    sessionStorage.clear();

    if ('caches' in window) {
        try {
            const names = await caches.keys();
            await Promise.all(names.map(name => caches.delete(name)));
        } catch (err) {
            console.warn('Cache clear failed before hard refresh:', err);
        }
    }

    const url = new URL(window.location.href);
    url.searchParams.set('_hard_reset', Date.now().toString(36));
    window.location.replace(url.toString());
}

/* ── Sidebar Tabs ──────────────────────────────────────────────────────────── */

function initSidebarTabs() {
    document.querySelectorAll('.sidebar-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            const tab = btn.dataset.tab;
            document.querySelectorAll('.sidebar-tab').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            document.querySelectorAll('.sidebar-content').forEach(c => c.classList.remove('active'));
            document.getElementById(`tab-${tab}`).classList.add('active');
            appState.activeSidebarTab = tab;

            if (tab === 'chat') setCenterView('citation');
            else if (tab === 'library') setCenterView('library');
            else if (tab === 'projects') {
                setCenterView('projects');
                loadProjects();
            }
            else if (tab === 'notes') {
                loadAllTags();
                // Switch center to annotations workspace only if not already there
                if (appState.activeCenterView !== 'annotations') setCenterView('annotations');
                loadAnnotationsViewData();
            }
            else if (tab === 'settings') setCenterView('settings');
        });
    });
}

function setCenterView(view, options = {}) {
    document.querySelectorAll('.center-view').forEach(v => v.classList.remove('active'));
    const viewEl = document.getElementById(`view-${view}`);
    if (!viewEl) return;
    viewEl.classList.add('active');
    appState.activeCenterView = view;

    if (view !== 'projects') {
        closeInkConnectionsForInactiveProjectView();
    }

    if (view === 'library') {
        loadLibraryStats();
        loadLibraryItems();
    }
    if (view === 'settings') {
        loadSystemStatus();
        loadQuotaBalance();
    }
    if (view === 'projects' && !options.skipProjectLoad) {
        loadProjects();
    }
    if (view === 'annotations') {
        loadAnnotationsViewData();
    }
}

/* ── Resizable Sidebar ────────────────────────────────────────────────────── */

function initResizableSidebar() {
    const handle = document.getElementById('sidebar-resize-handle');
    const sidebar = document.getElementById('sidebar');
    let isResizing = false;
    let startX, startWidth;

    handle.addEventListener('mousedown', (e) => {
        isResizing = true;
        startX = e.clientX;
        startWidth = sidebar.offsetWidth;
        handle.classList.add('active');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        document.body.style.webkitUserSelect = 'none';
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;
        const delta = e.clientX - startX;
        const newWidth = Math.max(280, Math.min(600, startWidth + delta));
        document.documentElement.style.setProperty('--sidebar-width', newWidth + 'px');
    });

    document.addEventListener('mouseup', () => {
        if (isResizing) {
            isResizing = false;
            handle.classList.remove('active');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            document.body.style.webkitUserSelect = '';
        }
    });
}

/* ── Temperature Sliders ──────────────────────────────────────────────────── */

function initTempSliders() {
    const suggestionSlider = document.getElementById('citation-suggestion-temp');
    const suggestionVal = document.getElementById('citation-suggestion-temp-val');
    const chatSlider = document.getElementById('settings-chat-temp');
    const chatVal = document.getElementById('settings-chat-temp-val');

    suggestionSlider?.addEventListener('input', () => {
        if (suggestionVal) suggestionVal.value = parseFloat(suggestionSlider.value).toFixed(2);
    });
    suggestionVal?.addEventListener('change', () => {
        const v = Math.min(2, Math.max(0, parseFloat(suggestionVal.value) || 0));
        suggestionVal.value = v.toFixed(2);
        if (suggestionSlider) suggestionSlider.value = v;
    });

    chatSlider.addEventListener('input', () => {
        chatVal.textContent = parseFloat(chatSlider.value).toFixed(2);
    });
}
