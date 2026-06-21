/* ── TarCite Workspace - Application Bootstrap ────────────────────────────── */

document.addEventListener('DOMContentLoaded', () => {
    initSplashScreen();
    initPdfJs();
    initTheme();
    initHardResetButton();
    initSidebarTabs();
    initResizableSidebar();
    initPreviewControls();
    initResizablePreview();
    initAnnotationTools();
    initAnnotationListResize();
    initAnnotationPanelToggle();
    initNotesTab();
    loadAllTags();
    initCitationForm();
    initChatForm();
    initLibrarySearch();
    initFileUpload();
    initSettingsForm();
    initTempSliders();
    initWordConnector();
    initHeaderProfileDropdown();
    initCitationProfileDropdown();
    loadModels();
    handleWorkspaceDeepLink();
    updateSyncStatus();
    preloadSecondaryWorkspaceData();
    initProjectNotesColorControl();
    refreshIcons();
    setInterval(updateSyncStatus, 3000);
    setInterval(loadQuotaBalance, 300000);
    initInkDragListeners();
    initInkScrollListeners();
    initGlobalSearch();
});

function runWhenIdle(fn, delayMs = 0) {
    const run = () => {
        try {
            fn();
        } catch (err) {
            console.warn('Deferred startup task failed:', err);
        }
    };
    setTimeout(() => {
        if ('requestIdleCallback' in window) {
            window.requestIdleCallback(run, { timeout: 750 });
        } else {
            run();
        }
    }, delayMs);
}

function preloadSecondaryWorkspaceData() {
    runWhenIdle(() => loadSettings(), 150);
    runWhenIdle(() => loadLibraryTree(), 300);
    runWhenIdle(() => loadSuggestionHistory(), 450);
    runWhenIdle(() => loadQuotaBalance(), 600);
    runWhenIdle(() => loadAllTags(), 750);
    runWhenIdle(() => loadProjects({ listOnly: true }), 900);
}

function initSplashScreen() {
    const splash = document.getElementById('splash-screen');
    if (!splash) return;
    setTimeout(() => {
        splash.classList.add('hidden');
        setTimeout(() => splash.remove(), 350);
    }, 3000);
}

function initPdfJs() {
    if (typeof pdfjsLib !== 'undefined' && pdfjsLib.GlobalWorkerOptions) {
        pdfjsLib.GlobalWorkerOptions.workerSrc = '/static/pdfjs/build/pdf.worker.mjs';
    }
}

function waitForPdfJs(timeoutMs = 5000) {
    if (typeof pdfjsLib !== 'undefined') return Promise.resolve(true);

    return new Promise(resolve => {
        const started = Date.now();
        const check = () => {
            if (typeof pdfjsLib !== 'undefined') {
                initPdfJs();
                resolve(true);
                return;
            }
            if (Date.now() - started >= timeoutMs) {
                resolve(false);
                return;
            }
            setTimeout(check, 50);
        };
        check();
    });
}

async function handleWorkspaceDeepLink() {
    const params = new URLSearchParams(window.location.search);
    const itemKey = params.get('item_key') || params.get('itemKey');
    if (!itemKey) return;

    const spotlight = params.get('spotlight') || '';
    setCenterView('citation');

    // Let the preview pane and PDF.js worker finish their initial setup.
    setTimeout(async () => {
        if (spotlight.trim()) {
            await doSpotlight(itemKey, spotlight);
        } else {
            await openPreview(itemKey);
        }
    }, 350);
}
