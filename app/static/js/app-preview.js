/* ── TarCite Workspace - Preview, PDF, Notes, and Annotation Tools ─────── */

/* ── Preview Controls ──────────────────────────────────────────────────────── */

function initPreviewControls() {
    document.getElementById('preview-collapse').addEventListener('click', togglePreview);
    document.getElementById('preview-swap-btn')?.addEventListener('click', togglePreviewSwap);
    document.getElementById('preview-page-prev').addEventListener('click', () => changePage(-1));
    document.getElementById('preview-page-next').addEventListener('click', () => changePage(1));
    document.getElementById('preview-zoom-in').addEventListener('click', () => changeZoom(0.15));
    document.getElementById('preview-zoom-out').addEventListener('click', () => changeZoom(-0.15));
    document.getElementById('preview-fullscreen')?.addEventListener('click', togglePdfFullscreen);
    document.getElementById('collapse-annotations-btn')?.addEventListener('click', toggleAnnotationCollapseMode);
    document.getElementById('preview-fullscreen-sidebar-toggle')?.addEventListener('click', togglePdfFullscreenSidebar);
    document.getElementById('pdf-search-input')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            const direction = e.shiftKey ? -1 : 1;
            if (appState.pdfSearchQuery === e.target.value.trim() && appState.pdfSearchResults.length) {
                stepPdfSearch(direction);
            } else {
                runPdfSearch(e.target.value.trim());
            }
        }
        if (e.key === 'Escape') clearPdfSearch();
    });
    document.getElementById('pdf-search-prev')?.addEventListener('click', () => stepPdfSearch(-1));
    document.getElementById('pdf-search-next')?.addEventListener('click', () => {
        const input = document.getElementById('pdf-search-input');
        if (input && input.value.trim() !== appState.pdfSearchQuery) runPdfSearch(input.value.trim());
        else stepPdfSearch(1);
    });
    document.getElementById('pdf-search-clear')?.addEventListener('click', clearPdfSearch);
    updatePdfSearchStatus();
    document.addEventListener('fullscreenchange', syncPdfFullscreenState);
    document.addEventListener('webkitfullscreenchange', syncPdfFullscreenState);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && appState.pdfFullscreen && !getFullscreenElement()) {
            closePdfFullscreen({ useApi: false });
        }
    });

    const container = document.getElementById('preview-container');
    container.addEventListener('wheel', (e) => {
        if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            const deltaY = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * 16 : e.deltaY;
            const scaleFactor = Math.exp(-deltaY * 0.0025);
            const viewer = document.getElementById('pdf-viewer');
            const containerRect = container.getBoundingClientRect();

            // First event in this pinch — record baseline so we can apply a
            // CSS transform for instant visual feedback while deferring re-render.
            if (!_pinchState) {
                _pinchState = {
                    baseZoom: appState.previewZoom,
                    visualScale: 1.0,
                    // Origin in pdf-viewer's own coordinate space (accounts for scroll)
                    originX: e.clientX - containerRect.left + container.scrollLeft,
                    originY: e.clientY - containerRect.top + container.scrollTop,
                };
                if (viewer) viewer.style.willChange = 'transform';
            }

            const newVisualScale = Math.max(
                0.4 / _pinchState.baseZoom,
                Math.min(3.5 / _pinchState.baseZoom, _pinchState.visualScale * scaleFactor),
            );
            _pinchState.visualScale = newVisualScale;
            appState.previewZoom = _pinchState.baseZoom * newVisualScale;

            // Hardware-accelerated instant visual response
            if (viewer) {
                viewer.style.transformOrigin = `${_pinchState.originX}px ${_pinchState.originY}px`;
                viewer.style.transform = `scale(${newVisualScale})`;
            }

            // Record anchor from the current pinch position for scroll restoration
            _zoomAnchor = getPreviewZoomAnchor(e.clientX, e.clientY);

            // Defer the actual re-render until the gesture settles
            clearTimeout(_zoomTimer);
            _zoomTimer = setTimeout(() => rerenderForZoom(), 260);

        } else if (appState.pdfFullscreen && e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
            e.preventDefault();
            container.scrollLeft += e.deltaY;
        }
        // natural vertical/horizontal scroll — browser handles it
    }, { passive: false });
}

function initResizablePreview() {
    const handle = document.getElementById('preview-resize-handle');
    const previewPane = document.getElementById('preview-pane');
    let isResizing = false;
    let startX, startWidth;

    handle.addEventListener('mousedown', (e) => {
        isResizing = true;
        startX = e.clientX;
        startWidth = previewPane.offsetWidth;
        handle.classList.add('active');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        document.body.style.webkitUserSelect = 'none';
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;
        // When swapped (preview is left of center), dragging right expands; otherwise drag left expands.
        const delta = appState.previewSwapped ? e.clientX - startX : startX - e.clientX;
        const newWidth = Math.max(300, Math.min(900, startWidth + delta));
        document.documentElement.style.setProperty('--preview-width', newWidth + 'px');
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

function togglePreview() {
    if (appState.pdfFullscreen) {
        closePdfFullscreen();
        return;
    }
    const pane = document.getElementById('preview-pane');
    appState.previewCollapsed = !appState.previewCollapsed;
    pane.classList.toggle('collapsed', appState.previewCollapsed);
    document.getElementById('workspace').classList.toggle('preview-collapsed', appState.previewCollapsed);
}

function togglePreviewSwap() {
    appState.previewSwapped = !appState.previewSwapped;
    document.getElementById('workspace').classList.toggle('preview-swapped', appState.previewSwapped);
    const btn = document.getElementById('preview-swap-btn');
    if (!btn) return;
    btn.title = appState.previewSwapped ? 'Move preview to right' : 'Move preview to left';
    btn.setAttribute('aria-label', btn.title);
    btn.classList.toggle('active', appState.previewSwapped);
}

async function togglePdfFullscreen() {
    if (appState.pdfFullscreen) {
        closePdfFullscreen();
    } else {
        await openPdfFullscreen();
    }
}

async function openPdfFullscreen() {
    const pane = document.getElementById('preview-pane');
    const pdfViewer = document.getElementById('pdf-viewer');
    const docViewer = document.getElementById('doc-viewer');
    const imageViewer = document.getElementById('image-viewer');
    const isPdf = Boolean(pdfViewer && !pdfViewer.classList.contains('hidden'));
    const hasPreview =
        isPdf ||
        (docViewer && !docViewer.classList.contains('hidden')) ||
        (imageViewer && !imageViewer.classList.contains('hidden'));
    if (!pane || !appState.previewItem || !hasPreview) return;

    if (appState.previewCollapsed) togglePreview();
    // Close the side annotation panel so its duplicate IDs don't shadow the fullscreen ones.
    if (appState.annotationPanelOpen) closeAnnotationPanel();
    appState.pdfFullscreen = true;
    appState.pdfFullscreenNative = false;
    appState.preFullscreenZoom = isPdf ? appState.previewZoom : null;
    pane.classList.add('pdf-fullscreen');
    pane.classList.toggle('pdf-fullscreen-sidebar-collapsed', appState.pdfFullscreenSidebarCollapsed);
    document.body.classList.add('pdf-fullscreen-open');
    setInkOverlayFullscreenParent(true);
    // Clear the normal annotation list so its element IDs don't shadow the fullscreen ones.
    const normalAnnList = document.getElementById('annotation-list');
    if (normalAnnList) normalAnnList.innerHTML = '';
    updatePdfFullscreenButton();
    updatePdfFullscreenSidebarButton();
    updateReadingStatusBtn(appState.previewItem?.reading_status || '');
    renderPdfFullscreenSidebar();
    initPdfFullscreenSidebarResize();
    loadPdfFullscreenLibrary();
    if (isPdf) {
        const fullscreenZoom = Math.min(3.5, appState.previewZoom * 2.6);
        changeZoom(fullscreenZoom - appState.previewZoom, { delay: 0 });
    }

    if (getFullscreenElement() !== pane) {
        try {
            await requestElementFullscreen(pane);
            appState.pdfFullscreenNative = getFullscreenElement() === pane;
        } catch (err) {
            console.debug('Fullscreen API unavailable:', err);
        }
    }

    requestAnimationFrame(() => {
        if (isPdf) {
            scrollToPage(appState.previewPage, false);
            updatePdfNavigatorActivePage();
        }
    });
}

function closePdfFullscreen(options = {}) {
    const { useApi = true } = options;
    const pane = document.getElementById('preview-pane');
    if (appState.notesScope === 'item') {
        clearTimeout(_notesSaveTimer);
        saveProjectNotes();
        closeInkConnectionsForInactiveProjectView();
        appState.notesScope = 'project';
        appState.activeNotesItemKey = '';
    }
    appState.pdfFullscreen = false;
    appState.pdfFullscreenNative = false;
    pane?.classList.remove('pdf-fullscreen');
    pane?.classList.remove('pdf-fullscreen-sidebar-collapsed');
    document.body.classList.remove('pdf-fullscreen-open');
    setInkOverlayFullscreenParent(false);
    updatePdfFullscreenButton();
    updatePdfFullscreenSidebarButton();

    if (useApi && getFullscreenElement() === pane) {
        exitDocumentFullscreen().catch(err => console.debug('Exit fullscreen failed:', err));
    }

    if (appState.preFullscreenZoom != null) {
        changeZoom(appState.preFullscreenZoom - appState.previewZoom, { delay: 0 });
        appState.preFullscreenZoom = null;
    }

    // Restore normal annotation list (was cleared on fullscreen entry).
    renderAnnotationList();
    if (appState.annotationPanelOpen) renderAnnotationListInPanel();

    requestAnimationFrame(() => scrollToPage(appState.previewPage, false));
}

function syncPdfFullscreenState() {
    const pane = document.getElementById('preview-pane');
    const fullscreenElement = getFullscreenElement();
    if (appState.pdfFullscreen && fullscreenElement === pane) {
        appState.pdfFullscreenNative = true;
    }
    if (appState.pdfFullscreen && fullscreenElement && fullscreenElement !== pane) {
        closePdfFullscreen({ useApi: false });
    }
    if (appState.pdfFullscreen && appState.pdfFullscreenNative && !fullscreenElement) {
        closePdfFullscreen({ useApi: false });
    }
}

function getFullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function requestElementFullscreen(element) {
    const request = element.requestFullscreen || element.webkitRequestFullscreen;
    if (!request) return Promise.resolve();
    return Promise.resolve(request.call(element));
}

function exitDocumentFullscreen() {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (!exit) return Promise.resolve();
    return Promise.resolve(exit.call(document));
}

function updatePdfFullscreenButton() {
    const btn = document.getElementById('preview-fullscreen');
    if (!btn) return;
    const active = appState.pdfFullscreen;
    btn.classList.toggle('active', active);
    btn.title = active ? 'Exit fullscreen preview' : 'Fullscreen preview';
    btn.setAttribute('aria-label', active ? 'Exit fullscreen preview' : 'Fullscreen preview');
    btn.innerHTML = icon(active ? 'minimize-2' : 'maximize-2');
    refreshIcons(btn);
}

let _fsSidebarResizing = false;

function initPdfFullscreenSidebarResize() {
    const pane = document.getElementById('preview-pane');
    if (!pane || pane._fsSidebarResizeInit) return;
    pane._fsSidebarResizeInit = true;

    let startX = 0, startWidth = 0;

    pane.addEventListener('mousedown', (e) => {
        const handle = e.target.closest?.('#pdf-fs-resize-handle');
        if (!handle) return;
        _fsSidebarResizing = true;
        startX = e.clientX;
        const sidebar = document.getElementById('pdf-fullscreen-sidebar');
        startWidth = sidebar ? sidebar.offsetWidth : 280;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        document.body.style.webkitUserSelect = 'none';
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!_fsSidebarResizing) return;
        const delta = e.clientX - startX;
        const newWidth = Math.max(180, Math.min(520, startWidth + delta));
        pane.style.setProperty('--fs-sidebar-width', newWidth + 'px');
    });

    document.addEventListener('mouseup', () => {
        if (_fsSidebarResizing) {
            _fsSidebarResizing = false;
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            document.body.style.webkitUserSelect = '';
        }
    });
}

function togglePdfFullscreenSidebar() {
    if (appState.pdfFullscreen) {
        appState.pdfFullscreenSidebarCollapsed = !appState.pdfFullscreenSidebarCollapsed;
        const pane = document.getElementById('preview-pane');
        pane?.classList.toggle('pdf-fullscreen-sidebar-collapsed', appState.pdfFullscreenSidebarCollapsed);
    } else {
        appState.annotationPanelOpen = !appState.annotationPanelOpen;
        toggleAnnotationPanel();
    }
    updatePdfFullscreenSidebarButton();
}

function updatePdfFullscreenSidebarButton() {
    const btn = document.getElementById('preview-fullscreen-sidebar-toggle');
    if (!btn) return;
    btn.style.display = 'flex';
    if (appState.pdfFullscreen) {
        const collapsed = appState.pdfFullscreenSidebarCollapsed;
        btn.classList.toggle('active', !collapsed);
        btn.title = collapsed ? 'Show sidebar' : 'Hide sidebar';
        btn.setAttribute('aria-label', collapsed ? 'Show sidebar' : 'Hide sidebar');
        btn.innerHTML = icon(collapsed ? 'panel-left-open' : 'panel-left-close');
    } else {
        const open = appState.annotationPanelOpen;
        btn.classList.toggle('active', open);
        btn.title = open ? 'Hide annotations' : 'Show annotations';
        btn.setAttribute('aria-label', open ? 'Hide annotations' : 'Show annotations');
        btn.innerHTML = icon(open ? 'panel-left-close' : 'panel-left');
    }
    refreshIcons(btn);
}

function changePage(delta) {
    const maxPage = appState.previewTotalPages || 999;
    const next = Math.max(1, Math.min(maxPage, appState.previewPage + delta));
    if (next === appState.previewPage) return;
    goToPdfPage(next, true);
}

function goToPdfPage(pageNum, smooth = true) {
    const maxPage = appState.previewTotalPages || appState.pdfDoc?.numPages || 999;
    const next = Math.max(1, Math.min(maxPage, pageNum));
    appState.previewPage = next;
    document.getElementById('preview-page-info').textContent = `${next} / ${appState.previewTotalPages || '?'}`;
    updatePdfNavigatorActivePage();
    scrollToPage(next, smooth);
}

async function runPdfSearch(query) {
    query = (query || '').trim();
    if (!query || !appState.pdfDoc) {
        clearPdfSearch({ keepInput: true });
        return;
    }

    appState.pdfSearchQuery = query;
    appState.pdfSearchResults = [];
    appState.pdfSearchIndex = -1;
    updatePdfSearchStatus('...');
    clearPdfSearchHighlights();

    try {
        const normalizedQuery = normalizeMatchWords(query).join(' ');
        if (!normalizedQuery) {
            updatePdfSearchStatus('0');
            return;
        }

        const results = [];
        for (let pageNum = 1; pageNum <= appState.pdfDoc.numPages; pageNum++) {
            const page = await appState.pdfDoc.getPage(pageNum);
            const textContent = await page.getTextContent();
            const pageText = textContent.items.map(item => item.str || '').join(' ');
            const normalizedPage = normalizeMatchWords(pageText).join(' ');
            if (normalizedPage.includes(normalizedQuery)) {
                results.push({ pageNum });
            }
        }

        appState.pdfSearchResults = results;
        appState.pdfSearchIndex = results.length ? 0 : -1;
        updatePdfSearchStatus();
        renderPdfSearchHighlights();
        if (results.length) goToPdfSearchResult(0);
    } catch (err) {
        console.error('PDF search error:', err);
        updatePdfSearchStatus('!');
    }
}

function stepPdfSearch(direction) {
    const input = document.getElementById('pdf-search-input');
    if (!appState.pdfSearchResults.length) {
        if (input?.value.trim()) runPdfSearch(input.value.trim());
        return;
    }

    const total = appState.pdfSearchResults.length;
    const nextIndex = (appState.pdfSearchIndex + direction + total) % total;
    goToPdfSearchResult(nextIndex);
}

function goToPdfSearchResult(index) {
    const result = appState.pdfSearchResults[index];
    if (!result) return;
    appState.pdfSearchIndex = index;
    updatePdfSearchStatus();
    goToPdfPage(result.pageNum, true);
    setTimeout(() => {
        const textLayer = document.querySelector(`#pdf-page-${result.pageNum} .text-layer`);
        if (textLayer) {
            renderPdfSearchHighlightsOnPage(result.pageNum, textLayer);
            textLayer.querySelector('.pdf-search-hit.current')?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
        }
    }, 450);
}

function clearPdfSearch(options = {}) {
    const { keepInput = false } = options;
    appState.pdfSearchQuery = '';
    appState.pdfSearchResults = [];
    appState.pdfSearchIndex = -1;
    clearPdfSearchHighlights();
    updatePdfSearchStatus();
    if (!keepInput) {
        const input = document.getElementById('pdf-search-input');
        if (input) input.value = '';
    }
}

function updatePdfSearchStatus(text = null) {
    const count = document.getElementById('pdf-search-count');
    if (!count) return;
    if (text !== null) {
        count.textContent = text;
    } else if (!appState.pdfSearchQuery) {
        count.textContent = '-';
    } else if (!appState.pdfSearchResults.length) {
        count.textContent = '0';
    } else {
        count.textContent = `${appState.pdfSearchIndex + 1}/${appState.pdfSearchResults.length}`;
    }

    const hasResults = appState.pdfSearchResults.length > 0;
    document.getElementById('pdf-search-prev')?.toggleAttribute('disabled', !hasResults);
    document.getElementById('pdf-search-next')?.toggleAttribute('disabled', !hasResults);
}

function clearPdfSearchHighlights() {
    document.querySelectorAll('.pdf-search-hit').forEach(el => el.classList.remove('pdf-search-hit', 'current'));
}

function renderPdfSearchHighlights() {
    if (!appState.pdfSearchQuery) return;
    document.querySelectorAll('.pdf-page[data-rendered="true"]').forEach(pageDiv => {
        const pageNum = parseInt(pageDiv.dataset.page);
        const textLayer = pageDiv.querySelector('.text-layer');
        if (textLayer) renderPdfSearchHighlightsOnPage(pageNum, textLayer);
    });
}

function renderPdfSearchHighlightsOnPage(pageNum, textLayer) {
    textLayer.querySelectorAll('.pdf-search-hit').forEach(el => el.classList.remove('pdf-search-hit', 'current'));
    if (!appState.pdfSearchQuery || !appState.pdfSearchResults.some(result => result.pageNum === pageNum)) return;

    const spans = findTextLayerMatchSpans(appState.pdfSearchQuery, textLayer);
    const current = appState.pdfSearchResults[appState.pdfSearchIndex]?.pageNum === pageNum;
    spans.forEach(span => {
        span.classList.add('pdf-search-hit');
        if (current) span.classList.add('current');
    });
}

let _zoomTimer = null;
let _zoomAnchor = null;
let _pinchState = null; // tracks live CSS-transform zoom during a pinch gesture
function changeZoom(delta, options = {}) {
    const newZoom = Math.max(0.4, Math.min(3.5, appState.previewZoom + delta));
    if (newZoom === appState.previewZoom) return;
    _zoomAnchor = getPreviewZoomAnchor(options.clientX, options.clientY);
    appState.previewZoom = newZoom;

    // Immediate dim feedback while re-rendering
    document.querySelectorAll('.pdf-page .pdf-canvas').forEach(c => { c.style.opacity = '0.5'; });

    clearTimeout(_zoomTimer);
    _zoomTimer = setTimeout(() => rerenderForZoom(), options.delay ?? 180);
}

async function rerenderForZoom() {
    if (!appState.pdfDoc || !appState.pdfItemKey) return;

    // Commit the pinch gesture: drop the CSS transform and do a real re-render.
    _pinchState = null;
    const viewer = document.getElementById('pdf-viewer');
    if (viewer) {
        viewer.style.transform = '';
        viewer.style.transformOrigin = '';
        viewer.style.willChange = '';
    }

    // In collapse mode, rebuild the snippets at the new zoom instead of the normal page stack.
    if (appState.annotationCollapseMode) {
        await buildCollapsedAnnotationsView();
        return;
    }

    // Clear rendered state so intersection observer re-triggers rendering
    document.querySelectorAll('.pdf-page').forEach(p => {
        delete p.dataset.rendered;
        p.dataset.rendering = 'false';
    });
    // Re-build page stack (updates placeholder sizes for new zoom)
    await setupPdfPageStack(appState.pdfDoc, appState.pdfItemKey);
    if (_zoomAnchor) {
        restorePreviewZoomAnchor(_zoomAnchor);
        _zoomAnchor = null;
    } else {
        scrollToPage(appState.previewPage, false);
    }
}

/* ── Collapse-to-Annotations Mode ─────────────────────────────────────────── */

function toggleAnnotationCollapseMode() {
    if (!appState.pdfDoc || appState.previewKind !== 'pdf') return;
    if (appState.annotationCollapseMode) {
        exitCollapsedAnnotationsView();
    } else {
        buildCollapsedAnnotationsView();
    }
}

async function buildCollapsedAnnotationsView() {
    if (!appState.pdfDoc || !appState.pdfItemKey) return;

    // Group annotations that have valid geometry by 1-based page number
    const pageMap = {};
    appState.annotations.forEach(a => {
        try {
            const geo = JSON.parse(a.geometry_json || '{}');
            if (!geo.rects || !geo.rects.length) return;
            const p = a.page_index + 1;
            if (!pageMap[p]) pageMap[p] = [];
            pageMap[p].push({ ann: a, rects: geo.rects });
        } catch (e) {}
    });

    const annotatedPages = Object.keys(pageMap).map(Number).sort((a, b) => a - b);

    if (!annotatedPages.length) {
        showCopyToast('No annotations to collapse to.');
        return;
    }

    appState.annotationCollapseMode = true;
    document.getElementById('collapse-annotations-btn')?.classList.add('active');

    if (appState.pageObserver) { appState.pageObserver.disconnect(); appState.pageObserver = null; }
    if (appState._pageTrackObserver) { appState._pageTrackObserver.disconnect(); appState._pageTrackObserver = null; }

    const viewer = document.getElementById('pdf-viewer');
    viewer.innerHTML = '';
    viewer.classList.add('collapse-mode');

    const scale = appState.previewZoom * 1.5;
    const PADDING = 0.03; // normalized page height added as context above/below each cluster
    let prevPage = 0;

    for (const pageNum of annotatedPages) {
        // Skipped pages are passed into the snippet header, not a separate row
        const skippedFrom = prevPage > 0 && pageNum > prevPage + 1 ? prevPage + 1 : null;
        const skippedTo   = skippedFrom ? pageNum - 1 : null;

        // Compute bounding Y range across all annotation rects on this page
        let yMin = 1, yMax = 0;
        pageMap[pageNum].forEach(({ rects }) => {
            rects.forEach(r => {
                yMin = Math.min(yMin, r.y);
                yMax = Math.max(yMax, r.y + r.height);
            });
        });
        yMin = Math.max(0, yMin - PADDING);
        yMax = Math.min(1, yMax + PADDING);

        const snippet = await buildCollapseSnippet(pageNum, yMin, yMax, scale, skippedFrom, skippedTo);
        viewer.appendChild(snippet);
        // Annotations must be rendered after the snippet is in the DOM so that
        // textLayer.offsetWidth / offsetHeight are non-zero (they need a layout pass).
        const annL = snippet.querySelector('.annotation-layer');
        const txtL = snippet.querySelector('.text-layer');
        if (annL && txtL) renderAnnotationsOnPage(pageNum, annL, txtL);
        prevPage = pageNum;
    }

    document.getElementById('preview-container')?.scrollTo({ top: 0, behavior: 'instant' });
}

async function buildCollapseSnippet(pageNum, yMin, yMax, scale, skippedFrom = null, skippedTo = null) {
    const page = await appState.pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale });
    const fullH = viewport.height;
    const cropTopPx = Math.floor(yMin * fullH);
    const cropH = Math.max(48, Math.ceil((yMax - yMin) * fullH));

    const snippet = document.createElement('div');
    snippet.className = 'collapse-snippet';
    snippet.dataset.page = String(pageNum);

    // Build header: page label on the left, optional skipped-pages pill + jump button on the right
    let skippedHtml = '';
    if (skippedFrom !== null) {
        const count = skippedTo - skippedFrom + 1;
        const label = count === 1 ? `Page ${skippedFrom}` : `Pages ${skippedFrom}–${skippedTo}`;
        skippedHtml = `
            <button class="collapse-skip-pill" onclick="expandFromCollapse(${skippedFrom})" title="Show ${label}">
                <i data-lucide="chevrons-up-down" aria-hidden="true"></i>
                <span>${label}</span>
            </button>`;
    }
    const header = document.createElement('div');
    header.className = 'collapse-snippet-header';
    header.innerHTML = `
        <span class="collapse-page-label">Page ${pageNum}</span>
        <span class="collapse-header-right">
            ${skippedHtml}
            <button class="collapse-jump-btn" onclick="expandFromCollapse(${pageNum})" title="Jump to full page">
                <i data-lucide="external-link" aria-hidden="true"></i>
            </button>
        </span>`;
    snippet.appendChild(header);

    // Clipping container — hides anything outside the crop window
    const clipBox = document.createElement('div');
    clipBox.className = 'collapse-clip-box';
    clipBox.style.width = viewport.width + 'px';
    clipBox.style.height = cropH + 'px';

    // Full pdf-page div shifted up so the annotation region is visible
    const pageDiv = document.createElement('div');
    pageDiv.className = 'pdf-page collapse-page-inner';
    pageDiv.id = `pdf-page-${pageNum}`;
    pageDiv.dataset.page = String(pageNum);
    pageDiv.style.width = viewport.width + 'px';
    pageDiv.style.minHeight = fullH + 'px';
    pageDiv.style.transform = `translateY(-${cropTopPx}px)`;

    const canvas = document.createElement('canvas');
    canvas.className = 'pdf-canvas';
    canvas.width = viewport.width;
    canvas.height = fullH;

    const textLayerDiv = document.createElement('div');
    textLayerDiv.className = 'textLayer text-layer interactive';
    textLayerDiv.style.width = viewport.width + 'px';
    textLayerDiv.style.height = fullH + 'px';
    textLayerDiv.style.setProperty('--scale-factor', scale);

    const annLayerDiv = document.createElement('div');
    annLayerDiv.className = 'annotation-layer';
    annLayerDiv.style.width = viewport.width + 'px';
    annLayerDiv.style.height = fullH + 'px';

    pageDiv.appendChild(canvas);
    pageDiv.appendChild(textLayerDiv);
    pageDiv.appendChild(annLayerDiv);
    clipBox.appendChild(pageDiv);
    snippet.appendChild(clipBox);

    // Render PDF canvas
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;

    // Render text layer (enables text selection inside snippets)
    const textContent = await page.getTextContent();
    const tl = new pdfjsLib.TextLayer({ textContentSource: textContent, container: textLayerDiv, viewport });
    await tl.render();

    pageDiv.dataset.rendered = 'true';
    refreshIcons(snippet);

    return snippet;
}


async function exitCollapsedAnnotationsView() {
    appState.annotationCollapseMode = false;
    document.getElementById('collapse-annotations-btn')?.classList.remove('active');
    document.getElementById('pdf-viewer')?.classList.remove('collapse-mode');
    await setupPdfPageStack(appState.pdfDoc, appState.pdfItemKey);
    scrollToPage(appState.previewPage, false);
    setTimeout(() => renderVisiblePdfPages(appState.pdfItemKey), 100);
}

function expandFromCollapse(targetPage) {
    appState.previewPage = targetPage;
    exitCollapsedAnnotationsView().then(() => {
        setTimeout(() => scrollToPage(targetPage, true), 150);
    });
}

/* ─────────────────────────────────────────────────────────────────────────── */

function getPreviewZoomAnchor(clientX, clientY) {
    const container = document.getElementById('preview-container');
    if (!container) return null;
    const containerRect = container.getBoundingClientRect();
    const x = Number.isFinite(clientX) ? clientX : containerRect.left + containerRect.width / 2;
    const y = Number.isFinite(clientY) ? clientY : containerRect.top + containerRect.height / 2;
    let pageDiv = document.elementFromPoint(x, y)?.closest?.('.pdf-page');
    if (!pageDiv) pageDiv = document.getElementById(`pdf-page-${appState.previewPage}`);
    if (!pageDiv) return null;

    const pageRect = pageDiv.getBoundingClientRect();
    return {
        pageNum: parseInt(pageDiv.dataset.page),
        xRatio: pageRect.width ? (x - pageRect.left) / pageRect.width : 0.5,
        yRatio: pageRect.height ? (y - pageRect.top) / pageRect.height : 0.5,
        viewportX: x - containerRect.left,
        viewportY: y - containerRect.top,
    };
}

function restorePreviewZoomAnchor(anchor) {
    const container = document.getElementById('preview-container');
    const pageDiv = document.getElementById(`pdf-page-${anchor.pageNum}`);
    if (!container || !pageDiv) return;
    container.scrollTo({
        left: pageDiv.offsetLeft + pageDiv.offsetWidth * anchor.xRatio - anchor.viewportX,
        top: pageDiv.offsetTop + pageDiv.offsetHeight * anchor.yRatio - anchor.viewportY,
        behavior: 'instant',
    });
}

function scrollToPage(pageNum, smooth) {
    const pageDiv = document.getElementById(`pdf-page-${pageNum}`);
    if (!pageDiv) return;
    const container = document.getElementById('preview-container');
    container.scrollTo({
        top: pageDiv.offsetTop - 12,
        behavior: smooth ? 'smooth' : 'instant',
    });
}

async function openPreview(itemKey) {
    try {
        const res = await fetch(`/api/items/${itemKey}`);
        if (!res.ok) return;
        const item = await res.json();

        if (appState.notesScope === 'item' && appState.activeNotesItemKey && appState.activeNotesItemKey !== itemKey) {
            clearTimeout(_notesSaveTimer);
            await saveProjectNotes();
            closeInkConnectionsForInactiveProjectView();
        }

        // Clear PDF cache when switching documents
        if (appState.pdfItemKey !== itemKey) {
            appState.pdfDoc = null;
            appState.pdfItemKey = null;
            if (appState.pageObserver) { appState.pageObserver.disconnect(); appState.pageObserver = null; }
            if (appState._pageTrackObserver) { appState._pageTrackObserver.disconnect(); appState._pageTrackObserver = null; }
            appState.previewPage = 1;
            appState.previewTotalPages = null;
            appState.pdfOutlineItems = [];
            clearPdfSearch({ keepInput: false });
            clearAnnotationUndoStack();
        }

        appState.previewItem = item;
        if (typeof updateRelatedTab === 'function') {
            updateRelatedTab();
            if (appState.libraryActivityFilter === 'related') loadLibraryItems();
        }
        document.getElementById('preview-title').textContent = item.title || 'Untitled';
        updateReadingStatusBtn(item.reading_status || '');
        document.getElementById('preview-page-info').textContent = `${appState.previewPage}`;
        recordPreviewOpen(itemKey);

        const filePath = item.files && item.files.length > 0 ? item.files[0].file_path : item.file_path;
        if (!filePath) { showPreviewEmpty(); return; }

        const ext = filePath.split('.').pop().toLowerCase();
        if (ext === 'pdf') {
            await loadPdfPreview(itemKey);
        } else if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)) {
            showImagePreview(itemKey);
        } else if (ext === 'txt') {
            await showDocTextPreview(itemKey, 'text');
        } else if (['md', 'markdown'].includes(ext)) {
            await showDocTextPreview(itemKey, 'markdown');
        } else if (ext === 'csv') {
            await showDocTextPreview(itemKey, 'csv');
        } else if (ext === 'docx') {
            await showDocTextPreview(itemKey, 'docx');
        } else {
            showPreviewEmpty();
        }

        document.getElementById('annotation-tools').classList.remove('hidden');
        loadAnnotations(itemKey);

        if (appState.annotationPanelOpen) {
            renderAnnotationPanel();
        }

        if (appState.previewCollapsed) togglePreview();

        if (appState.pdfFullscreen) {
            appState.pdfLibraryRelatedItems = [];
            appState.pdfLibrarySearchItems = [];
            renderPdfFullscreenSidebar();
            loadPdfFullscreenLibrary();
        }
    } catch (err) {
        console.error('Preview error:', err);
    }
}

const _readingStatusConfig = {
    '':        { label: 'Unread',   icon: '○', cls: '' },
    'reading': { label: 'Reading',  icon: '◑', cls: 'status-reading' },
    'read':    { label: 'Read',     icon: '●', cls: 'status-read' },
};

function updateReadingStatusBtn(status) {
    const btn = document.getElementById('reading-status-btn');
    if (!btn) return;
    const cfg = _readingStatusConfig[status] || _readingStatusConfig[''];
    btn.textContent = cfg.icon + ' ' + cfg.label;
    btn.className = 'reading-status-btn ' + cfg.cls;
    btn.title = 'Reading status: ' + cfg.label + ' (click to cycle)';
    if (appState.previewItem) btn.classList.remove('hidden');
}

async function cycleReadingStatus() {
    if (!appState.previewItem) return;
    const order = ['', 'reading', 'read'];
    const cur = appState.previewItem.reading_status || '';
    const next = order[(order.indexOf(cur) + 1) % order.length];
    try {
        const res = await fetch(`/api/items/${appState.previewItem.item_key}/reading-status`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reading_status: next }),
        });
        if (!res.ok) return;
        const data = await res.json();
        appState.previewItem.reading_status = data.activity?.reading_status ?? next;
        updateReadingStatusBtn(appState.previewItem.reading_status);
        const libItem = appState.libraryItems.find(i => i.item_key === appState.previewItem.item_key);
        if (libItem) {
            libItem.reading_status = appState.previewItem.reading_status;
            renderLibraryTable();
        }
    } catch (err) {
        console.error('Reading status error:', err);
    }
}

async function recordPreviewOpen(itemKey) {
    try {
        const res = await fetch(`/api/items/${itemKey}/activity/open`, { method: 'POST' });
        if (!res.ok) return;
        const data = await res.json();
        const item = appState.libraryItems.find(i => i.item_key === itemKey);
        if (item && data.activity) Object.assign(item, data.activity);
        if (appState.previewItem?.item_key === itemKey && data.activity) {
            Object.assign(appState.previewItem, data.activity);
        }
        if (appState.activeCenterView === 'library' && appState.libraryActivityFilter === 'recent') {
            loadLibraryItems();
        }
    } catch (err) {
        console.error('Record open error:', err);
    }
}

async function loadPdfPreview(itemKey) {
    // Reset collapse mode whenever a new document is opened
    if (appState.annotationCollapseMode) {
        appState.annotationCollapseMode = false;
        document.getElementById('collapse-annotations-btn')?.classList.remove('active');
        document.getElementById('pdf-viewer')?.classList.remove('collapse-mode');
    }
    appState.previewKind = 'pdf';
    document.getElementById('pdf-viewer').classList.remove('hidden');
    document.getElementById('image-viewer').classList.add('hidden');
    document.getElementById('text-viewer').classList.add('hidden');
    document.getElementById('preview-empty').classList.add('hidden');
    document.getElementById('doc-viewer')?.classList.add('hidden');
    document.getElementById('project-notes-viewer')?.classList.add('hidden');
    document.querySelector('.pdf-search-control')?.classList.remove('hidden');
    updatePreviewToolAvailability();

    const pdfReady = await waitForPdfJs();
    if (!pdfReady) {
        document.getElementById('preview-empty').classList.remove('hidden');
        return;
    }

    try {
        if (!appState.pdfDoc || appState.pdfItemKey !== itemKey) {
            const loadingTask = pdfjsLib.getDocument(`/api/pdf/${itemKey}`);
            appState.pdfDoc = await loadingTask.promise;
            appState.pdfItemKey = itemKey;
            appState.previewTotalPages = appState.pdfDoc.numPages;
            appState.pdfOutlineItems = await loadPdfOutline(appState.pdfDoc);
            // Annotations may have loaded before the document was ready —
            // anchor any quote-only (e.g. MCP-created) annotations now.
            scheduleAnnotationAnchorResolution();
        }
        const pdf = appState.pdfDoc;
        document.getElementById('preview-page-info').textContent = `${appState.previewPage} / ${pdf.numPages}`;
        renderPdfFullscreenSidebar();

        await setupPdfPageStack(pdf, itemKey);
        scrollToPage(appState.previewPage, false);
        await renderPdfPage(appState.previewPage, itemKey);
        setTimeout(() => renderVisiblePdfPages(itemKey), 120);
    } catch (err) {
        console.error('PDF render error:', err);
    }
}

async function setupPdfPageStack(pdf, itemKey) {
    const viewer = document.getElementById('pdf-viewer');
    const container = document.getElementById('preview-container');

    // Disconnect old observers
    if (appState.pageObserver) { appState.pageObserver.disconnect(); appState.pageObserver = null; }
    if (appState._pageTrackObserver) { appState._pageTrackObserver.disconnect(); appState._pageTrackObserver = null; }

    viewer.innerHTML = '';

    // Estimate page size from page 1 for placeholders
    const firstPage = await pdf.getPage(1);
    const scale = appState.previewZoom * 1.5;
    const vp0 = firstPage.getViewport({ scale });

    for (let i = 1; i <= pdf.numPages; i++) {
        const pageDiv = document.createElement('div');
        pageDiv.className = 'pdf-page';
        pageDiv.id = `pdf-page-${i}`;
        pageDiv.dataset.page = String(i);
        pageDiv.style.width = vp0.width + 'px';
        pageDiv.style.minHeight = vp0.height + 'px';

        const canvas = document.createElement('canvas');
        canvas.className = 'pdf-canvas';

        const textLayerDiv = document.createElement('div');
        textLayerDiv.className = 'textLayer text-layer';
        if (appState.annotationTool !== 'area') textLayerDiv.classList.add('interactive');

        const annLayerDiv = document.createElement('div');
        annLayerDiv.className = 'annotation-layer';

        pageDiv.appendChild(canvas);
        pageDiv.appendChild(textLayerDiv);
        pageDiv.appendChild(annLayerDiv);
        viewer.appendChild(pageDiv);
    }

    // Lazy render observer (pre-load ±400px)
    const renderObs = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) renderPdfPage(parseInt(entry.target.dataset.page), itemKey);
        });
    }, { root: container, rootMargin: '500px 0px', threshold: 0 });

    // Page-tracker observer — determine which page is most visible
    const trackObs = new IntersectionObserver((entries) => {
        let best = { ratio: 0, page: appState.previewPage };
        entries.forEach(entry => {
            if (entry.intersectionRatio > best.ratio) {
                best = { ratio: entry.intersectionRatio, page: parseInt(entry.target.dataset.page) };
            }
        });
        if (best.ratio > 0.05 && best.page !== appState.previewPage) {
            appState.previewPage = best.page;
            document.getElementById('preview-page-info').textContent = `${best.page} / ${pdf.numPages}`;
            updatePdfNavigatorActivePage();
        }
    }, { root: container, threshold: [0.05, 0.25, 0.5, 0.75, 1.0] });

    viewer.querySelectorAll('.pdf-page').forEach(p => {
        renderObs.observe(p);
        trackObs.observe(p);
    });

    appState.pageObserver = renderObs;
    appState._pageTrackObserver = trackObs;
}

function renderVisiblePdfPages(itemKey) {
    const container = document.getElementById('preview-container');
    if (!container) return;

    const containerRect = container.getBoundingClientRect();
    document.querySelectorAll('.pdf-page').forEach(pageDiv => {
        const rect = pageDiv.getBoundingClientRect();
        const isNearViewport = rect.bottom >= containerRect.top - 500 && rect.top <= containerRect.bottom + 500;
        if (isNearViewport) renderPdfPage(parseInt(pageDiv.dataset.page), itemKey);
    });
}

async function renderPdfPage(pageNum, itemKey) {
    const pageDiv = document.getElementById(`pdf-page-${pageNum}`);
    if (!pageDiv || pageDiv.dataset.rendered === 'true' || pageDiv.dataset.rendering === 'true') return;
    const pdf = appState.pdfDoc;
    if (!pdf || appState.pdfItemKey !== itemKey) return;

    pageDiv.dataset.rendering = 'true';
    try {
        const page = await pdf.getPage(pageNum);
        const scale = appState.previewZoom * 1.5;
        const viewport = page.getViewport({ scale });

        const canvas = pageDiv.querySelector('.pdf-canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        pageDiv.style.width = viewport.width + 'px';
        pageDiv.style.minHeight = viewport.height + 'px';

        const textLayerDiv = pageDiv.querySelector('.text-layer');
        textLayerDiv.style.width = viewport.width + 'px';
        textLayerDiv.style.height = viewport.height + 'px';
        textLayerDiv.style.setProperty('--scale-factor', scale);
        textLayerDiv.innerHTML = '';

        const annLayerDiv = pageDiv.querySelector('.annotation-layer');
        annLayerDiv.style.width = viewport.width + 'px';
        annLayerDiv.style.height = viewport.height + 'px';
        annLayerDiv.innerHTML = '';

        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport }).promise;

        const textContent = await page.getTextContent();
        const tl = new pdfjsLib.TextLayer({ textContentSource: textContent, container: textLayerDiv, viewport });
        await tl.render();

        pageDiv.dataset.rendered = 'true';

        if (appState.annotationTool === 'area') {
            pageDiv.classList.add('area-mode');
        }

        renderAnnotationsOnPage(pageNum, annLayerDiv, textLayerDiv);

        if (appState.spotlightText && !appState.spotlightSearchPending && pageNum === appState.previewPage) {
            highlightSpotlightInTextLayer(appState.spotlightText, textLayerDiv);
        }
        renderPdfSearchHighlightsOnPage(pageNum, textLayerDiv);

        // Fade in
        canvas.style.opacity = '0';
        requestAnimationFrame(() => { canvas.style.opacity = '1'; });
    } catch (err) {
        console.error(`Page ${pageNum} render error:`, err);
    } finally {
        pageDiv.dataset.rendering = 'false';
    }
}

function showImagePreview(itemKey) {
    appState.previewKind = 'image';
    document.getElementById('pdf-viewer').classList.add('hidden');
    document.getElementById('image-viewer').classList.remove('hidden');
    document.getElementById('text-viewer').classList.add('hidden');
    document.getElementById('preview-empty').classList.add('hidden');
    document.getElementById('doc-viewer')?.classList.add('hidden');
    document.getElementById('project-notes-viewer')?.classList.add('hidden');
    document.querySelector('.pdf-search-control')?.classList.add('hidden');
    const img = document.getElementById('preview-image');
    img.onload = () => { if (appState.previewKind === 'image') renderAnnotationsOnImage(); };
    img.src = `/api/pdf/${itemKey}`;
    updatePreviewToolAvailability();
    loadAnnotations(itemKey);
}

function showPreviewEmpty() {
    appState.previewKind = '';
    document.getElementById('pdf-viewer').classList.add('hidden');
    document.getElementById('image-viewer').classList.add('hidden');
    document.getElementById('text-viewer').classList.add('hidden');
    document.getElementById('preview-empty').classList.remove('hidden');
    document.getElementById('doc-viewer')?.classList.add('hidden');
    document.getElementById('project-notes-viewer')?.classList.add('hidden');
    document.querySelector('.pdf-search-control')?.classList.add('hidden');
    updatePreviewToolAvailability();
}

/* ── Project Notes ─────────────────────────────────────────────────────────── */

function getActiveNotesRoot() {
    if (appState.notesScope === 'item') {
        return document.getElementById('item-notes-viewer') || document.getElementById('pdf-fullscreen-sidebar');
    }
    return document.getElementById('project-notes-viewer');
}

function getNotesContentEl() {
    return getActiveNotesRoot()?.querySelector('[data-notes-role="content"]')
        || document.getElementById('project-notes-content');
}

function getNotesBodyEl() {
    return getActiveNotesRoot()?.querySelector('[data-notes-role="body"]')
        || document.querySelector('.project-notes-body');
}

function getNotesStatusEl() {
    return getActiveNotesRoot()?.querySelector('[data-notes-role="status"]')
        || document.getElementById('notes-save-status');
}

function getNotesRoleEl(role) {
    return getActiveNotesRoot()?.querySelector(`[data-notes-role="${role}"]`);
}

function showProjectNotesPreview(project) {
    appState.notesScope = 'project';
    appState.activeNotesItemKey = '';
    appState.previewKind = 'project-notes';
    document.getElementById('pdf-viewer').classList.add('hidden');
    document.getElementById('image-viewer').classList.add('hidden');
    document.getElementById('text-viewer').classList.add('hidden');
    document.getElementById('doc-viewer')?.classList.add('hidden');
    document.getElementById('preview-empty').classList.add('hidden');
    document.getElementById('project-notes-viewer').classList.remove('hidden');
    document.getElementById('annotation-tools').classList.add('hidden');
    document.querySelector('.pdf-search-control')?.classList.add('hidden');

    document.getElementById('preview-title').textContent = project.name + ' — Notes';

    const content = getNotesContentEl();
    if (content) content.innerHTML = project.notes || '';

    const status = getNotesStatusEl();
    if (status) status.textContent = '';
    syncNotesColorControl();
    _savedNotesSelection = null;
    updatePreviewToolAvailability();
    loadNoteConnections(project);
}

let _notesSaveTimer = null;

function onNotesInput() {
    const status = getNotesStatusEl();
    if (status) status.textContent = 'Saving…';
    clearTimeout(_notesSaveTimer);
    _notesSaveTimer = setTimeout(saveProjectNotes, 1500);
}

async function saveProjectNotes(extraPayload = {}) {
    const content = getNotesContentEl();
    if (!content) return;
    const status = getNotesStatusEl();
    try {
        const isItemNotes = appState.notesScope === 'item';
        const itemKey = appState.activeNotesItemKey || appState.previewItem?.item_key || '';
        const projectId = appState.activeProjectId;
        if (isItemNotes && !itemKey) return;
        if (!isItemNotes && !projectId) return;
        if (isItemNotes && content.querySelector('.doc-loading, .pdf-sidebar-empty')) return;

        const notes = content.innerHTML;
        const url = isItemNotes ? `/api/items/${itemKey}/notes` : `/api/projects/${projectId}`;
        const res = await fetch(url, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ notes, ...extraPayload }),
        });
        if (!res.ok) throw new Error(`Notes save failed: ${res.status}`);
        if (status) {
            status.textContent = 'Saved';
            setTimeout(() => { if (status.textContent === 'Saved') status.textContent = ''; }, 2000);
        }
        if (isItemNotes && appState.previewItem?.item_key === itemKey) {
            appState.previewItem.notes = notes;
            if (Object.prototype.hasOwnProperty.call(extraPayload, 'note_connections')) {
                appState.previewItem.note_connections = extraPayload.note_connections;
            }
        } else if (appState.activeProject) {
            appState.activeProject.notes = notes;
        }
        if (!isItemNotes && appState.activeProject && Object.prototype.hasOwnProperty.call(extraPayload, 'note_connections')) {
            appState.activeProject.note_connections = extraPayload.note_connections;
        }
    } catch (err) {
        console.error('Notes save error:', err);
        if (status) status.textContent = 'Error saving';
    }
}

async function saveProjectNotesAndConnections() {
    clearTimeout(_notesSaveTimer);
    await saveProjectNotes({ note_connections: JSON.stringify(appState.noteConnections) });
}

let _savedNotesSelection = null;

function saveNotesSelection() {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
        _savedNotesSelection = sel.getRangeAt(0).cloneRange();
    }
}

function restoreNotesSelection() {
    const content = getNotesContentEl();
    if (!content) return;
    content.focus();
    if (!_savedNotesSelection) return;
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(_savedNotesSelection);
}

function notesFormat(command, value = null) {
    restoreNotesSelection();
    document.execCommand(command, false, value);
    saveNotesSelection();
}

const NOTES_COLOR_PRESETS = [
    '#e4e8f0', '#111827', '#ef4444', '#f97316',
    '#f59e0b', '#22c55e', '#06b6d4', '#3b82f6',
    '#8b5cf6', '#ec4899', '#94a3b8', '#ffffff',
];

function normalizeNotesColor(color) {
    if (!color) return '#e4e8f0';
    const value = String(color).trim();
    const match = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (!match) return value;
    const hex = match[1].toLowerCase();
    if (hex.length === 6) return `#${hex}`;
    return `#${hex.split('').map(ch => ch + ch).join('')}`;
}

function loadNotesRecentColors() {
    try {
        const parsed = JSON.parse(localStorage.getItem('notesRecentColors') || '[]');
        appState.notesRecentColors = Array.isArray(parsed)
            ? parsed.map(normalizeNotesColor).filter(Boolean).slice(0, 6)
            : [];
    } catch {
        appState.notesRecentColors = [];
    }
}

function saveNotesRecentColor(color) {
    const normalized = normalizeNotesColor(color);
    appState.notesRecentColors = [
        normalized,
        ...appState.notesRecentColors.filter(c => normalizeNotesColor(c) !== normalized),
    ].slice(0, 6);
    localStorage.setItem('notesRecentColors', JSON.stringify(appState.notesRecentColors));
}

function initProjectNotesColorControl() {
    appState.notesActiveColor = normalizeNotesColor(appState.notesActiveColor);
    loadNotesRecentColors();
    renderNotesColorMenu();
    syncNotesColorControl();
}

function renderNotesColorMenu() {
    const presets = getNotesRoleEl('color-presets') || document.getElementById('notes-color-presets');
    if (presets) presets.innerHTML = NOTES_COLOR_PRESETS.map(color => notesColorSwatchButton(color)).join('');

    const recentSection = getNotesRoleEl('color-recent-section') || document.getElementById('notes-color-recent-section');
    const recent = getNotesRoleEl('color-recent') || document.getElementById('notes-color-recent');
    if (recent) recent.innerHTML = appState.notesRecentColors.map(color => notesColorSwatchButton(color)).join('');
    if (recentSection) recentSection.classList.toggle('hidden', appState.notesRecentColors.length === 0);

    refreshIcons(getNotesRoleEl('color-menu') || document.getElementById('notes-color-menu') || document);
}

function notesColorSwatchButton(color) {
    const normalized = normalizeNotesColor(color);
    const activeClass = normalized === appState.notesActiveColor ? ' active' : '';
    return `<button class="notes-color-swatch${activeClass}" type="button" data-color="${escapeHtml(normalized)}" style="background:${escapeHtml(normalized)}" onclick="notesChooseColor('${escapeJs(normalized)}')" title="${escapeHtml(normalized)}"></button>`;
}

function syncNotesColorControl() {
    const color = normalizeNotesColor(appState.notesActiveColor);
    const indicator = getNotesRoleEl('color-indicator') || document.getElementById('notes-color-indicator');
    const input = getNotesRoleEl('color-input') || document.getElementById('notes-color-input');
    const customSwatch = getNotesRoleEl('color-custom-swatch') || document.getElementById('notes-color-custom-swatch');
    if (indicator) indicator.style.borderBottomColor = color;
    if (input && /^#[0-9a-f]{6}$/i.test(color)) input.value = color;
    if (customSwatch) customSwatch.style.background = color;
    document.querySelectorAll('.notes-color-swatch').forEach(btn => {
        btn.classList.toggle('active', normalizeNotesColor(btn.dataset.color) === color);
    });
}

function setNotesActiveColor(color, { remember = true } = {}) {
    appState.notesActiveColor = normalizeNotesColor(color);
    localStorage.setItem('notesActiveColor', appState.notesActiveColor);
    if (remember) saveNotesRecentColor(appState.notesActiveColor);
    renderNotesColorMenu();
    syncNotesColorControl();
}

function notesApplyActiveColor() {
    notesApplyColor(appState.notesActiveColor);
}

function notesChooseColor(color) {
    setNotesActiveColor(color);
    closeNotesColorMenu();
    notesApplyActiveColor();
}

function notesChooseCustomColor(color) {
    notesChooseColor(color);
}

function toggleNotesColorMenu(event) {
    event?.preventDefault();
    event?.stopPropagation();
    saveNotesSelection();
    const menu = document.getElementById('notes-color-menu');
    const activeMenu = getNotesRoleEl('color-menu') || menu;
    if (!activeMenu) return;
    const willOpen = activeMenu.classList.contains('hidden');
    document.querySelectorAll('.notes-color-menu').forEach(el => el.classList.add('hidden'));
    activeMenu.classList.toggle('hidden', !willOpen);
    if (willOpen) {
        renderNotesColorMenu();
        syncNotesColorControl();
        setTimeout(() => document.addEventListener('mousedown', dismissNotesColorMenu), 0);
    }
}

function dismissNotesColorMenu(event) {
    if (event.target.closest?.('.notes-color-control')) return;
    closeNotesColorMenu();
}

function closeNotesColorMenu() {
    document.querySelectorAll('.notes-color-menu').forEach(el => el.classList.add('hidden'));
    document.removeEventListener('mousedown', dismissNotesColorMenu);
}

function openNotesColorPicker(event) {
    if (event?.target?.id === 'notes-color-input') return;
    event?.preventDefault();
    event?.stopPropagation();
    saveNotesSelection();
    (getNotesRoleEl('color-input') || document.getElementById('notes-color-input'))?.click();
}

function notesApplyColor(color) {
    setNotesActiveColor(color, { remember: true });
    restoreNotesSelection();
    document.execCommand('foreColor', false, appState.notesActiveColor);
    saveNotesSelection();
    closeNotesColorMenu();
}

/* ── Ink Connections ──────────────────────────────────────────────────────── */

function toggleNotesInkMode() {
    if (appState.notesScope !== 'item' && appState.activeCenterView !== 'projects') {
        activateProjectsTab();
    }
    appState.inkMode = !appState.inkMode;
    _syncInkModeUi();
    if (!appState.inkMode) _cancelInkDrag();
}

function _syncInkModeUi() {
    document.getElementById('notes-ink-btn')?.classList.toggle('active', appState.inkMode);
    document.getElementById('item-notes-ink-btn')?.classList.toggle('active', appState.inkMode);
    getNotesBodyEl()?.classList.toggle('ink-mode', appState.inkMode);
}

function _inkSurfaceActive() {
    return (appState.notesScope === 'project' && appState.previewKind === 'project-notes' && appState.activeCenterView === 'projects')
        || (
            appState.notesScope === 'item'
            && (
                (appState.pdfFullscreen && appState.pdfFullscreenSidebarTab === 'notes')
                || (!appState.pdfFullscreen && appState.annotationPanelOpen && appState.annotationPanelTab === 'notes')
            )
        );
}

function _clearInkOverlay() {
    const svg = document.getElementById('ink-connection-overlay');
    if (!svg) return;
    svg.querySelectorAll('.ink-conn-group, .ink-preview-group').forEach(g => g.remove());
}

function setInkOverlayFullscreenParent(active) {
    const svg = document.getElementById('ink-connection-overlay');
    if (!svg) return;
    const targetParent = active ? document.getElementById('preview-pane') : document.body;
    if (targetParent && svg.parentElement !== targetParent) {
        targetParent.appendChild(svg);
    }
}

function closeInkConnectionsForInactiveProjectView() {
    _cancelInkDrag();
    appState.inkMode = false;
    _syncInkModeUi();
    _clearInkOverlay();
    document.querySelectorAll('.ink-drop-target').forEach(el => el.classList.remove('ink-drop-target'));
    _inkPopupEl?.remove();
    _inkPopupEl = null;
}

async function activateProjectsTab(options = {}) {
    document.querySelectorAll('.sidebar-tab').forEach(b => b.classList.remove('active'));
    document.querySelector('.sidebar-tab[data-tab="projects"]')?.classList.add('active');
    document.querySelectorAll('.sidebar-content').forEach(c => c.classList.remove('active'));
    document.getElementById('tab-projects')?.classList.add('active');
    appState.activeSidebarTab = 'projects';
    setCenterView('projects', { skipProjectLoad: options.awaitRender });
    if (options.awaitRender) {
        await loadProjects();
    }
}

function _createFloatingAnchor(connId, offsetX, offsetY) {
    const body = getNotesBodyEl();
    if (!body) return null;
    const anchor = document.createElement('span');
    anchor.className = 'ink-anchor ink-anchor-float';
    anchor.dataset.connId = connId;
    anchor.style.left = offsetX + 'px';
    anchor.style.top  = offsetY + 'px';
    body.appendChild(anchor);
    return anchor;
}

function loadNoteConnections(project) {
    try {
        appState.noteConnections = JSON.parse(project.note_connections || '[]');
    } catch { appState.noteConnections = []; }

    // Remove any stale floating anchors from a previous project load
    getNotesBodyEl()?.querySelectorAll('.ink-anchor-float').forEach(a => a.remove());

    // Recreate floating anchors for connections that store pixel offsets
    appState.noteConnections.forEach(conn => {
        if (conn.anchorOffsetX !== undefined) {
            _createFloatingAnchor(conn.id, conn.anchorOffsetX, conn.anchorOffsetY);
        }
    });

    _attachInkAnchorHandlers();
    requestAnimationFrame(redrawInkLines);
}

function _attachInkAnchorHandlers() {
    const _wire = anchor => {
        const fresh = anchor.cloneNode(true);
        anchor.parentNode?.replaceChild(fresh, anchor);
        fresh.addEventListener('mousedown', e => e.stopPropagation());
        fresh.addEventListener('click', e => {
            e.preventDefault(); e.stopPropagation();
            if (appState.inkMode && appState.notesScope !== 'item') return;
            const conn = appState.noteConnections.find(c => c.id === fresh.dataset.connId);
            if (conn) { navigateToInkTarget(conn.targetType, conn.targetId, conn); flashInkLine(conn.id); }
        });
        fresh.addEventListener('mouseenter', () => _showInkAnchorPopup(fresh));
        fresh.addEventListener('mouseleave', () => _scheduleHideInkPopup());
    };
    // New: floating anchors in notes-body
    getNotesBodyEl()?.querySelectorAll('.ink-anchor-float').forEach(_wire);
    // Legacy: inline anchors in notes-content
    getNotesContentEl()?.querySelectorAll('.ink-anchor:not(.ink-anchor-float)').forEach(_wire);
}

let _inkPopupEl = null;
let _inkPopupTimer = null;

function _showInkAnchorPopup(anchor) {
    clearTimeout(_inkPopupTimer);
    _inkPopupEl?.remove();

    const connId = anchor.dataset.connId;
    const conn = appState.noteConnections.find(c => c.id === connId);

    const popup = document.createElement('div');
    popup.className = 'ink-anchor-popup';
    const label = conn?.targetLabel || conn?.targetSection || 'Connection';
    popup.innerHTML = `
        <span class="ink-anchor-popup-label">${escapeHtml(label.slice(0, 40))}</span>
        <button class="ink-anchor-delete-btn" title="Remove connection">×</button>
    `;
    const popupParent = appState.pdfFullscreen
        ? (document.getElementById('preview-pane') || getFullscreenElement() || document.body)
        : document.body;
    popupParent.appendChild(popup);
    _inkPopupEl = popup;

    // Position above the anchor dot
    const ar = anchor.getBoundingClientRect();
    const pw = popup.offsetWidth;
    const ph = popup.offsetHeight;
    let left = ar.left + ar.width / 2 - pw / 2;
    let top = ar.top - ph - 6;
    // Flip below if too close to top
    if (top < 6) top = ar.bottom + 6;
    // Clamp horizontally
    left = Math.max(6, Math.min(left, window.innerWidth - pw - 6));
    popup.style.left = left + 'px';
    popup.style.top = top + 'px';

    popup.querySelector('.ink-anchor-delete-btn').addEventListener('click', e => {
        e.preventDefault(); e.stopPropagation();
        popup.remove();
        _inkPopupEl = null;
        _deleteInkConnection(connId);
    });

    popup.addEventListener('mouseenter', () => clearTimeout(_inkPopupTimer));
    popup.addEventListener('mouseleave', () => _scheduleHideInkPopup());
}

function _scheduleHideInkPopup() {
    _inkPopupTimer = setTimeout(() => {
        _inkPopupEl?.remove();
        _inkPopupEl = null;
    }, 200);
}

function initInkDragListeners() {
    const notesBody = () => getNotesBodyEl();

    document.addEventListener('mousedown', e => {
        if (!appState.inkMode) return;
        const body = notesBody();
        if (!body || !body.contains(e.target)) return;
        if (e.target.closest('.ink-anchor')) return;
        e.preventDefault();

        // Store the click position relative to the notes-body (including its scroll).
        // This lets us place the anchor dot at exactly the clicked pixel, not at the
        // nearest text-character boundary (which caretRangeFromPoint forced before).
        const bodyRect = body.getBoundingClientRect();
        const anchorOffsetX = e.clientX - bodyRect.left;
        const anchorOffsetY = e.clientY - bodyRect.top + body.scrollTop;

        const connId = 'ink-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
        const anchor = document.createElement('span');
        anchor.className = 'ink-anchor ink-anchor-float';
        anchor.dataset.connId = connId;
        anchor.style.left = anchorOffsetX + 'px';
        anchor.style.top  = anchorOffsetY + 'px';
        body.appendChild(anchor);

        const svg = document.getElementById('ink-connection-overlay');
        const previewGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        previewGroup.setAttribute('class', 'ink-preview-group');
        svg?.appendChild(previewGroup);

        appState._inkDrag = { connId, anchor, startX: e.clientX, startY: e.clientY, anchorOffsetX, anchorOffsetY, previewGroup, overEl: null };
    }, true);

    document.addEventListener('mousemove', e => {
        const drag = appState._inkDrag;
        if (!drag) return;
        drag.previewGroup.innerHTML = '';
        _drawInkPath(drag.previewGroup, drag.startX, drag.startY, e.clientX, e.clientY, { opacity: 0.55, dashed: true });

        if (drag.overEl) { drag.overEl.classList.remove('ink-drop-target'); drag.overEl = null; }
        const target = _findInkTargetAtPoint(e.clientX, e.clientY);
        if (target) { target.el.classList.add('ink-drop-target'); drag.overEl = target.el; }
    }, true);

    document.addEventListener('mouseup', e => {
        const drag = appState._inkDrag;
        if (!drag) return;
        drag.previewGroup.remove();

        let target = drag.overEl ? _findInkTargetFromEl(drag.overEl, e.clientX, e.clientY) : null;
        if (!target) {
            target = _findInkTargetAtPoint(e.clientX, e.clientY);
        }

        if (drag.overEl) drag.overEl.classList.remove('ink-drop-target');
        appState._inkDrag = null;

        if (target) {
            const conn = { id: drag.connId, targetType: target.type, targetId: String(target.id), targetLabel: target.label || '', targetSection: appState.activeProjectSection || '', anchorOffsetX: drag.anchorOffsetX, anchorOffsetY: drag.anchorOffsetY };
            ['targetOffsetX', 'targetOffsetY', 'targetPctX', 'targetPctY'].forEach(key => {
                if (target[key] !== undefined) conn[key] = target[key];
            });
            appState.noteConnections.push(conn);
            _attachInkAnchorHandlers();
            saveProjectNotesAndConnections();
            requestAnimationFrame(() => { redrawInkLines(); flashInkLine(drag.connId); });
        } else {
            drag.anchor.remove();
            onNotesInput();
        }
    }, true);
}

function _findInkTargetAtPoint(x, y) {
    const svg = document.getElementById('ink-connection-overlay');
    const prev = svg?.style.pointerEvents;
    if (svg) svg.style.pointerEvents = 'none';
    const el = document.elementFromPoint(x, y);
    if (svg) svg.style.pointerEvents = prev || '';
    if (!el) return null;
    if (getActiveNotesRoot()?.contains(el)) return null;
    return _findInkTargetFromEl(el, x, y);
}

function _targetPointData(targetEl, x, y) {
    if (!targetEl || typeof x !== 'number' || typeof y !== 'number') return {};
    const rect = targetEl.getBoundingClientRect();
    if (!rect.width || !rect.height) return {};
    const targetOffsetX = Math.max(0, Math.min(rect.width, x - rect.left));
    const targetOffsetY = Math.max(0, Math.min(rect.height, y - rect.top));
    return {
        targetOffsetX,
        targetOffsetY,
        targetPctX: targetOffsetX / rect.width,
        targetPctY: targetOffsetY / rect.height,
    };
}

function _findInkTargetFromEl(el, x = null, y = null) {
    if (!el) return null;
    if (appState.notesScope === 'item') {
        const annRow = el.closest('[data-annotation-id]');
        if (annRow) {
            const label = annRow.querySelector('.annotation-text, .project-ann-quote, .project-ann-note, span')?.textContent?.slice(0, 60).trim() || `Annotation ${annRow.dataset.annotationId}`;
            return { type: 'annotation', id: annRow.dataset.annotationId, el: annRow, label, ..._targetPointData(annRow, x, y) };
        }
        const pdfPage = el.closest('.pdf-page[data-page]');
        if (pdfPage) {
            return { type: 'pdf-page', id: pdfPage.dataset.page, el: pdfPage, label: `Page ${pdfPage.dataset.page}`, ..._targetPointData(pdfPage, x, y) };
        }
        const pdfViewer = el.closest('#pdf-viewer, #preview-container');
        if (pdfViewer && appState.previewKind === 'pdf') {
            const pageNum = appState.previewPage || 1;
            const pageEl = document.getElementById(`pdf-page-${pageNum}`) || pdfViewer;
            return { type: 'pdf-page', id: pageNum, el: pageEl, label: `Page ${pageNum}`, ..._targetPointData(pageEl, x, y) };
        }
        const docViewer = el.closest('#doc-viewer-content, #doc-viewer');
        if (docViewer) {
            return { type: 'document', id: appState.previewItem?.item_key || '', el: docViewer, label: 'Document text', ..._targetPointData(docViewer, x, y) };
        }
        const imageViewer = el.closest('#image-viewer, .image-annotation-container, #preview-image');
        if (imageViewer) {
            return { type: 'image', id: appState.previewItem?.item_key || '', el: imageViewer, label: 'Image preview', ..._targetPointData(imageViewer, x, y) };
        }
        return null;
    }

    // annotation-id checked first — evidence cards and coding rows sit inside
    // theme nodes that also have data-tag-id, so specifics must win over parents
    const annRow = el.closest('[data-annotation-id]');
    if (annRow) {
        const label = annRow.querySelector('.project-ann-quote, .project-ann-note, span')?.textContent?.slice(0, 60).trim() || `Annotation ${annRow.dataset.annotationId}`;
        return { type: 'annotation', id: annRow.dataset.annotationId, el: annRow, label };
    }
    const srcRow = el.closest('[data-item-key]');
    if (srcRow) {
        const label = srcRow.querySelector('strong')?.textContent?.slice(0, 60).trim() || srcRow.dataset.itemKey;
        return { type: 'item', id: srcRow.dataset.itemKey, el: srcRow, label };
    }
    const codeNode = el.closest('[data-tag-id]');
    if (codeNode) {
        const label = codeNode.querySelector('span')?.textContent?.replace(/^#/, '').trim() || `Theme ${codeNode.dataset.tagId}`;
        return { type: 'theme', id: codeNode.dataset.tagId, el: codeNode, label };
    }
    const analysisCard = el.closest('[data-analysis-card]');
    if (analysisCard) {
        const label = analysisCard.querySelector('.analysis-card-header, span')?.textContent?.trim().slice(0, 60) || analysisCard.dataset.analysisCard;
        return { type: 'analysis', id: analysisCard.dataset.analysisCard, el: analysisCard, label };
    }
    return null;
}

function _findInkTargetElement(targetType, targetId) {
    if (appState.notesScope === 'item') {
        if (targetType === 'annotation') return document.querySelector(`[data-annotation-id="${CSS.escape(targetId)}"]`);
        if (targetType === 'pdf-page') return document.getElementById(`pdf-page-${targetId}`);
        if (targetType === 'document') return document.getElementById('doc-viewer-content') || document.getElementById('doc-viewer');
        if (targetType === 'image') return document.getElementById('image-viewer') || document.getElementById('preview-image');
        return null;
    }

    const scope = document.getElementById('project-view-content') || document;
    if (targetType === 'theme') return scope.querySelector(`[data-tag-id="${CSS.escape(targetId)}"]`);
    if (targetType === 'annotation') return scope.querySelector(`[data-annotation-id="${CSS.escape(targetId)}"]`);
    if (targetType === 'item') return scope.querySelector(`[data-item-key="${CSS.escape(targetId)}"]`);
    if (targetType === 'analysis') return scope.querySelector(`[data-analysis-card="${CSS.escape(targetId)}"]`);
    return null;
}

function redrawInkLines() {
    const svg = document.getElementById('ink-connection-overlay');
    if (!svg) return;
    svg.querySelectorAll('.ink-conn-group').forEach(g => g.remove());
    if (!_inkSurfaceActive()) return;

    const content = getNotesContentEl();
    if (!content) return;

    const notesBody = getNotesBodyEl();

    appState.noteConnections.forEach(conn => {
        const targetEl = _findInkTargetElement(conn.targetType, conn.targetId);
        if (!targetEl) return;

        let x1, y1;
        if (conn.anchorOffsetX !== undefined && notesBody) {
            // New: position stored as pixel offset relative to notes-body
            const br = notesBody.getBoundingClientRect();
            x1 = br.left + conn.anchorOffsetX;
            y1 = br.top  + conn.anchorOffsetY - notesBody.scrollTop;
        } else {
            // Legacy: anchor span embedded in notes content HTML
            const anchor = content.querySelector(`.ink-anchor[data-conn-id="${conn.id}"]`);
            if (!anchor) return;
            const ar = anchor.getBoundingClientRect();
            if (!ar.width) return;
            x1 = ar.left + ar.width / 2;
            y1 = ar.top  + ar.height / 2;
        }

        // Skip if anchor scrolled out of view
        if (y1 < -20 || y1 > window.innerHeight + 20) return;

        const tr = targetEl.getBoundingClientRect();
        // Skip only if target is completely off-viewport
        if (tr.bottom < 0 || tr.top > window.innerHeight) return;

        let x2, y2;
        if (appState.notesScope === 'item' && (conn.targetPctX !== undefined || conn.targetOffsetX !== undefined)) {
            const offsetX = conn.targetPctX !== undefined ? Number(conn.targetPctX) * tr.width : Number(conn.targetOffsetX);
            const offsetY = conn.targetPctY !== undefined ? Number(conn.targetPctY) * tr.height : Number(conn.targetOffsetY);
            x2 = tr.left + Math.max(0, Math.min(tr.width, Number.isFinite(offsetX) ? offsetX : tr.width / 2));
            y2 = tr.top + Math.max(0, Math.min(tr.height, Number.isFinite(offsetY) ? offsetY : tr.height / 2));
        } else {
            x2 = appState.notesScope === 'item' ? tr.left - 4 : tr.right + 4;
            y2 = tr.top + tr.height / 2;
        }

        const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        group.setAttribute('class', 'ink-conn-group');
        group.setAttribute('data-conn-id', conn.id);
        group.style.cursor = 'pointer';
        group.setAttribute('pointer-events', 'painted');
        _drawInkPath(group, x1, y1, x2, y2, { opacity: 0.38 });

        group.addEventListener('click', () => {
            navigateToInkTarget(conn.targetType, conn.targetId, conn);
            flashInkLine(conn.id);
        });
        svg.appendChild(group);
    });
}

function _inkAccentColor() {
    return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#2d6fd4';
}

function _drawInkPath(parent, x1, y1, x2, y2, options = {}) {
    const { opacity = 0.4, dashed = false } = options;
    const color = _inkAccentColor();
    const dx = Math.abs(x1 - x2) * 0.45;
    const direction = x2 >= x1 ? 1 : -1;
    const cp1x = x1 + (direction * dx), cp1y = y1;
    const cp2x = x2 - (direction * dx), cp2y = y2;

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', `M ${x1} ${y1} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${x2} ${y2}`);
    path.style.stroke = color;
    path.style.strokeWidth = '2px';
    path.style.fill = 'none';
    path.style.opacity = String(opacity);
    path.style.strokeLinecap = 'round';
    if (dashed) path.style.strokeDasharray = '6 4';
    parent.appendChild(path);

    [[ x1, y1 ], [ x2, y2 ]].forEach(([cx, cy]) => {
        const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        c.setAttribute('cx', cx); c.setAttribute('cy', cy); c.setAttribute('r', '4');
        c.style.fill = color;
        c.style.opacity = String(Math.min(1, opacity + 0.25));
        parent.appendChild(c);
    });
}

function flashInkLine(connId) {
    const svg = document.getElementById('ink-connection-overlay');
    const group = svg?.querySelector(`.ink-conn-group[data-conn-id="${connId}"]`);
    if (group) {
        group.querySelectorAll('path').forEach(p => { p.setAttribute('opacity', '0.85'); p.style.transition = 'opacity 1.2s ease'; });
        group.querySelectorAll('circle').forEach(c => { c.setAttribute('opacity', '1'); c.style.transition = 'opacity 1.2s ease'; });
        setTimeout(() => {
            group.querySelectorAll('path').forEach(p => p.setAttribute('opacity', '0.38'));
            group.querySelectorAll('circle').forEach(c => c.setAttribute('opacity', '0.63'));
        }, 1400);
    }
    const conn = appState.noteConnections.find(c => c.id === connId);
    if (conn) {
        const el = _findInkTargetElement(conn.targetType, conn.targetId);
        if (el) { el.classList.add('ink-flash-target'); setTimeout(() => el.classList.remove('ink-flash-target'), 1400); }
    }
}

function scrollToItemInkConnection(conn, targetEl, smooth = true) {
    const container = document.getElementById('preview-container');
    if (!container || !targetEl) {
        targetEl?.scrollIntoView({ behavior: smooth ? 'smooth' : 'instant', block: 'center' });
        return;
    }

    const hasStoredPoint = conn && (conn.targetPctX !== undefined || conn.targetOffsetX !== undefined);
    if (!hasStoredPoint) {
        targetEl.scrollIntoView({ behavior: smooth ? 'smooth' : 'instant', block: 'center', inline: 'center' });
        return;
    }

    const offsetX = conn.targetPctX !== undefined
        ? Number(conn.targetPctX) * targetEl.offsetWidth
        : Number(conn.targetOffsetX);
    const offsetY = conn.targetPctY !== undefined
        ? Number(conn.targetPctY) * targetEl.offsetHeight
        : Number(conn.targetOffsetY);
    const pointX = targetEl.offsetLeft + (Number.isFinite(offsetX) ? offsetX : targetEl.offsetWidth / 2);
    const pointY = targetEl.offsetTop + (Number.isFinite(offsetY) ? offsetY : targetEl.offsetHeight / 2);
    const maxLeft = Math.max(0, container.scrollWidth - container.clientWidth);
    const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);

    container.scrollTo({
        left: Math.max(0, Math.min(maxLeft, pointX - container.clientWidth / 2)),
        top: Math.max(0, Math.min(maxTop, pointY - container.clientHeight / 2)),
        behavior: smooth ? 'smooth' : 'instant',
    });
}

async function navigateToInkTarget(targetType, targetId, connOverride = null) {
    if (appState.notesScope === 'item') {
        const conn = connOverride || appState.noteConnections.find(c => c.targetType === targetType && c.targetId === String(targetId));
        if (targetType === 'annotation') {
            const annEl = _findInkTargetElement(targetType, targetId);
            if (annEl) {
                scrollToItemInkConnection(conn, annEl, true);
            } else {
                navigateToAnnotation(parseInt(targetId, 10));
            }
        } else if (targetType === 'pdf-page') {
            const pageEl = _findInkTargetElement(targetType, targetId);
            if (pageEl) {
                appState.previewPage = parseInt(targetId, 10) || appState.previewPage;
                document.getElementById('preview-page-info').textContent = `${appState.previewPage} / ${appState.previewTotalPages || '?'}`;
                updatePdfNavigatorActivePage();
                scrollToItemInkConnection(conn, pageEl, true);
            } else {
                goToPdfPage(parseInt(targetId, 10), true);
            }
        } else {
            const targetEl = _findInkTargetElement(targetType, targetId);
            if (targetEl) scrollToItemInkConnection(conn, targetEl, true);
        }
        requestAnimationFrame(redrawInkLines);
        setTimeout(redrawInkLines, 350);
        return;
    }

    if (appState.activeCenterView !== 'projects') {
        await activateProjectsTab({ awaitRender: true });
    }
    const el = _findInkTargetElement(targetType, targetId);
    if (el) {
        requestAnimationFrame(() => {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            redrawInkLines();
        });
        return;
    }
    // Use the section stored at connection-creation time so evidence board
    // connections go back to 'evidence', coding review to 'review', etc.
    const conn = appState.noteConnections.find(c => c.targetType === targetType && c.targetId === String(targetId));
    const fallbackMap = { theme: 'codebook', annotation: 'annotations', item: 'overview', analysis: 'analysis' };
    const needed = conn?.targetSection || fallbackMap[targetType];
    if (needed) {
        selectProjectSection(needed);
        setTimeout(() => {
            const el2 = _findInkTargetElement(targetType, targetId);
            if (el2) el2.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 120);
    }
}

function _deleteInkConnection(connId) {
    appState.noteConnections = appState.noteConnections.filter(c => c.id !== connId);
    // Remove floating anchor (new style)
    getNotesBodyEl()?.querySelector(`.ink-anchor-float[data-conn-id="${connId}"]`)?.remove();
    // Remove legacy inline anchor (old style)
    getNotesContentEl()?.querySelector(`.ink-anchor[data-conn-id="${connId}"]`)?.remove();
    saveProjectNotesAndConnections();
    redrawInkLines();
}

function _cancelInkDrag() {
    if (!appState._inkDrag) return;
    appState._inkDrag.previewGroup?.remove();
    if (appState._inkDrag.overEl) appState._inkDrag.overEl.classList.remove('ink-drop-target');
    appState._inkDrag.anchor.remove();
    appState._inkDrag = null;
}

function initInkScrollListeners() {
    let _rafPending = false;
    const redraw = () => {
        if (_rafPending) return;
        _rafPending = true;
        requestAnimationFrame(() => { _rafPending = false; redrawInkLines(); });
    };

    // Capture-phase scroll catches every scrollable container (notes body,
    // project-view-content, etc.) without needing to know them at init time
    window.addEventListener('scroll', redraw, { passive: true, capture: true });

    // ResizeObserver fires continuously during window/element resize — much
    // smoother than the 'resize' event which only fires at the end on some platforms
    if (window.ResizeObserver) {
        new ResizeObserver(redraw).observe(document.body);
    } else {
        window.addEventListener('resize', redraw, { passive: true });
    }
}

/* ── Document Text Viewer (txt / md / csv / docx) ─────────────────────────── */

async function showDocTextPreview(itemKey, type) {
    appState.previewKind = 'doc';
    document.getElementById('pdf-viewer').classList.add('hidden');
    document.getElementById('image-viewer').classList.add('hidden');
    document.getElementById('text-viewer').classList.add('hidden');
    document.getElementById('preview-empty').classList.add('hidden');
    document.getElementById('project-notes-viewer')?.classList.add('hidden');
    document.querySelector('.pdf-search-control')?.classList.add('hidden');
    clearPdfSearch({ keepInput: false });
    updatePreviewToolAvailability();

    const docViewer = document.getElementById('doc-viewer');
    if (docViewer) docViewer.classList.remove('hidden');

    // Show loading state
    const contentEl = document.getElementById('doc-viewer-content');
    if (contentEl) contentEl.innerHTML = '<div class="doc-loading">Loading…</div>';

    try {
        const res = await fetch(`/api/file-content/${itemKey}`);
        if (!res.ok) { showPreviewEmpty(); return; }
        const data = await res.json();
        appState.currentDocContent = data;
        appState.currentDocItemKey = itemKey;
        renderDocContent(data, itemKey);
    } catch (err) {
        console.error('Doc preview error:', err);
        showPreviewEmpty();
    }
}

function renderDocContent(data, itemKey) {
    const contentEl = document.getElementById('doc-viewer-content');
    if (!contentEl) return;

    if (data.type === 'text') {
        contentEl.innerHTML = `<pre class="doc-text">${escapeHtml(data.content)}</pre>`;
    } else if (data.type === 'markdown') {
        contentEl.innerHTML = `<div class="doc-markdown">${renderDocMarkdown(data.content)}</div>`;
    } else if (data.type === 'csv') {
        contentEl.innerHTML = renderCsvTable(data);
    } else if (data.type === 'docx') {
        contentEl.innerHTML = renderDocxContent(data);
    }

    // Highlight existing annotations
    highlightDocAnnotations(itemKey);

    refreshIcons(contentEl);
}

function renderDocMarkdown(md) {
    // Comprehensive markdown renderer for the doc viewer
    let html = escapeHtml(md);

    // Code blocks (``` ```) — protect first
    const codeBlocks = [];
    html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
        const i = codeBlocks.length;
        codeBlocks.push(`<pre class="md-code-block${lang ? ' lang-' + escapeHtml(lang) : ''}"><code>${code.trimEnd()}</code></pre>`);
        return `\x00CODE${i}\x00`;
    });

    // Inline code
    const inlineCodes = [];
    html = html.replace(/`([^`]+)`/g, (_, code) => {
        const i = inlineCodes.length;
        inlineCodes.push(`<code class="md-inline-code">${code}</code>`);
        return `\x00IC${i}\x00`;
    });

    // Headings
    html = html.replace(/^######\s+(.+)$/gm, '<h6 class="md-h6">$1</h6>');
    html = html.replace(/^#####\s+(.+)$/gm, '<h5 class="md-h5">$1</h5>');
    html = html.replace(/^####\s+(.+)$/gm, '<h4 class="md-h4">$1</h4>');
    html = html.replace(/^###\s+(.+)$/gm, '<h3 class="md-h3">$1</h3>');
    html = html.replace(/^##\s+(.+)$/gm, '<h2 class="md-h2">$1</h2>');
    html = html.replace(/^#\s+(.+)$/gm, '<h1 class="md-h1">$1</h1>');

    // Blockquotes
    html = html.replace(/^&gt;\s?(.+)$/gm, '<blockquote class="md-blockquote">$1</blockquote>');

    // Bold + italic
    html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    html = html.replace(/_(.+?)_/g, '<em>$1</em>');

    // Strikethrough
    html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');

    // Horizontal rule
    html = html.replace(/^[-*_]{3,}$/gm, '<hr class="md-hr">');

    // Unordered lists
    html = html.replace(/((?:^[ \t]*[-*+]\s+.+\n?)+)/gm, match => {
        const items = match.trim().split('\n').map(l => `<li>${l.replace(/^[ \t]*[-*+]\s+/, '')}</li>`).join('');
        return `<ul class="md-ul">${items}</ul>`;
    });

    // Ordered lists
    html = html.replace(/((?:^[ \t]*\d+\.\s+.+\n?)+)/gm, match => {
        const items = match.trim().split('\n').map(l => `<li>${l.replace(/^[ \t]*\d+\.\s+/, '')}</li>`).join('');
        return `<ol class="md-ol">${items}</ol>`;
    });

    // Links and images
    html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img class="md-img" src="$2" alt="$1">');
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a class="md-link" href="$2" target="_blank" rel="noopener">$1</a>');

    // Paragraphs (double newline)
    html = html.replace(/\n\n+/g, '</p><p class="md-p">');
    html = `<p class="md-p">${html}</p>`;

    // Single line breaks within paragraphs
    html = html.replace(/([^>])\n([^<])/g, '$1<br>$2');

    // Restore protected blocks
    codeBlocks.forEach((block, i) => { html = html.replace(`\x00CODE${i}\x00`, block); });
    inlineCodes.forEach((code, i) => { html = html.replace(`\x00IC${i}\x00`, code); });

    // Clean up empty paragraphs around block elements
    html = html.replace(/<p class="md-p">(<(?:h[1-6]|ul|ol|blockquote|hr|pre)[^>]*>)/g, '$1');
    html = html.replace(/(<\/(?:h[1-6]|ul|ol|blockquote|hr|pre)>)<\/p>/g, '$1');

    return html;
}

function renderCsvTable(data) {
    if (!data.headers || !data.headers.length) return '<p class="doc-empty">Empty CSV file.</p>';
    const maxRows = 500;
    const shown = data.rows.slice(0, maxRows);
    const truncated = data.rows.length > maxRows;
    const thead = `<tr>${data.headers.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr>`;
    const tbody = shown.map(row =>
        `<tr>${row.map(cell => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`
    ).join('');
    return `
        <div class="csv-meta">${data.total_rows.toLocaleString()} rows \xb7 ${data.headers.length} columns</div>
        <div class="csv-scroll">
            <table class="csv-table">
                <thead>${thead}</thead>
                <tbody>${tbody}</tbody>
            </table>
        </div>
        ${truncated ? `<p class="csv-truncated">Showing first ${maxRows} of ${data.total_rows} rows.</p>` : ''}`;
}

function renderDocxContent(data) {
    const parts = data.paragraphs.map(p => {
        const style = p.style || 'Normal';
        if (/^Heading\s*1$/i.test(style)) return `<h1 class="md-h1">${escapeHtml(p.text)}</h1>`;
        if (/^Heading\s*2$/i.test(style)) return `<h2 class="md-h2">${escapeHtml(p.text)}</h2>`;
        if (/^Heading\s*3$/i.test(style)) return `<h3 class="md-h3">${escapeHtml(p.text)}</h3>`;
        if (/^Heading\s*[456]$/i.test(style)) return `<h4 class="md-h4">${escapeHtml(p.text)}</h4>`;
        if (/^(List|Bullet)/i.test(style)) return `<li class="docx-li">${escapeHtml(p.text)}</li>`;
        return `<p class="doc-para">${escapeHtml(p.text)}</p>`;
    }).join('');

    const tables = data.tables.map(tbl => {
        if (!tbl.length) return '';
        const head = `<tr>${tbl[0].map(c => `<th>${escapeHtml(c)}</th>`).join('')}</tr>`;
        const body = tbl.slice(1).map(r => `<tr>${r.map(c => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`).join('');
        return `<table class="docx-table"><thead>${head}</thead><tbody>${body}</tbody></table>`;
    }).join('');

    return `<div class="doc-body">${parts}</div>${tables ? `<div class="docx-tables">${tables}</div>` : ''}`;
}

/* ── Doc viewer text selection + annotation support ───────────────────────── */

let _docSelectionHandler = null;

function initDocTextSelection(itemKey) {
    const contentEl = document.getElementById('doc-viewer-content');
    if (!contentEl) return;

    // Remove previous handler
    if (_docSelectionHandler) {
        document.removeEventListener('mouseup', _docSelectionHandler);
    }

    _docSelectionHandler = (e) => {
        // Remove any existing toolbar
        document.getElementById('doc-ann-toolbar')?.remove();

        if (appState.annotationTool === 'select') return;

        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || !sel.toString().trim()) return;
        if (!contentEl.contains(sel.anchorNode)) return;

        const quote = sel.toString().trim().slice(0, 2000);
        if (!quote) return;

        const range = sel.getRangeAt(0);
        const rect = range.getBoundingClientRect();

        const toolbar = document.createElement('div');
        toolbar.id = 'doc-ann-toolbar';
        toolbar.className = 'doc-ann-toolbar';
        toolbar.style.top = (rect.top + window.scrollY - 44) + 'px';
        toolbar.style.left = (rect.left + rect.width / 2) + 'px';
        toolbar.innerHTML = `
            <button class="doc-ann-btn highlight" data-type="highlight" data-quote="${escapeHtml(quote).replace(/"/g,'&quot;')}" title="Highlight & add note">
                ${icon('highlighter')} Highlight
            </button>
            <button class="doc-ann-btn comment" data-type="comment" data-quote="${escapeHtml(quote).replace(/"/g,'&quot;')}" title="Highlight & add note">
                ${icon('pencil')} Annotate
            </button>`;

        document.body.appendChild(toolbar);
        refreshIcons(toolbar);

        toolbar.querySelectorAll('.doc-ann-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const type = btn.dataset.type;
                const q = btn.dataset.quote;
                toolbar.remove();
                sel.removeAllRanges();
                await createDocAnnotation(itemKey, type, q);
            });
        });

        // Close on next click elsewhere
        setTimeout(() => {
            const close = (ev) => { if (!toolbar.contains(ev.target)) { toolbar.remove(); document.removeEventListener('mousedown', close); } };
            document.addEventListener('mousedown', close);
        }, 10);
    };

    document.addEventListener('mouseup', _docSelectionHandler);
}

async function createDocAnnotation(itemKey, annType, quote) {
    const color = annType === 'highlight' ? '#facc15' : '#60a5fa';
    const data = {
        annotation_type: annType,
        color,
        quote,
        comment: '',
        page_index: 0,
        geometry_json: JSON.stringify({ doc_offset: quote }),
    };

    try {
        const res = await fetch(`/api/items/${itemKey}/annotations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        });
        if (!res.ok) throw new Error('Failed');
        const created = await res.json();
        await loadAnnotations(itemKey);
        highlightDocAnnotations(itemKey);
        // Open the existing note drawer so user can add tags/notes — same as PDF
        if (created?.annotation_id) {
            openNoteDrawer(created.annotation_id);
        }
    } catch (err) {
        console.error('Doc annotation error:', err);
    }
}

function highlightDocAnnotations(itemKey) {
    const contentEl = document.getElementById('doc-viewer-content');
    if (!contentEl) return;
    const annotations = appState.annotations.filter(a => a.item_key === itemKey && a.quote);

    // Reset — remove existing highlights
    contentEl.querySelectorAll('.doc-highlight').forEach(el => {
        el.replaceWith(document.createTextNode(el.textContent));
    });
    contentEl.normalize();

    // Apply highlights by finding text in the DOM
    annotations.forEach(ann => {
        if (!ann.quote || ann.annotation_type === 'comment') return;
        let geo = {};
        try { geo = JSON.parse(ann.geometry_json || '{}'); } catch {}
        const start = Number.isFinite(geo.doc_char_start) ? geo.doc_char_start : null;
        const end = Number.isFinite(geo.doc_char_end) ? geo.doc_char_end : null;
        if (start !== null && end !== null && end > start) {
            highlightTextRangeInElement(contentEl, start, end, ann.color || '#facc15', ann.annotation_id, ann.annotation_type);
        } else {
            highlightTextInElement(contentEl, ann.quote, ann.color || '#facc15', ann.annotation_id, ann.annotation_type);
        }
    });
}

function getDocTextIndex(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    let fullText = '';
    while (walker.nextNode()) {
        const node = walker.currentNode;
        textNodes.push({ node, start: fullText.length, end: fullText.length + node.textContent.length });
        fullText += node.textContent;
    }
    return { textNodes, fullText };
}

function makeDocAnnotationMark(color, annId, annType) {
    const mark = document.createElement('mark');
    mark.className = 'doc-highlight';
    if (annType === 'underline') {
        mark.style.background = 'transparent';
        mark.style.borderBottom = `2px solid ${color}`;
    } else {
        mark.style.background = color + '55';
        mark.style.borderBottom = `2px solid ${color}`;
    }
    mark.dataset.annId = String(annId);
    mark.title = 'Click to view note';
    mark.addEventListener('click', () => openNoteDrawer(annId));
    return mark;
}

function highlightTextRangeInElement(root, start, end, color, annId, annType = 'highlight') {
    const { textNodes, fullText } = getDocTextIndex(root);
    const safeStart = Math.max(0, Math.min(fullText.length, start));
    const safeEnd = Math.max(safeStart, Math.min(fullText.length, end));
    if (safeEnd <= safeStart) return false;

    const overlapping = textNodes
        .filter(entry => entry.end > safeStart && entry.start < safeEnd)
        .reverse();

    let applied = false;
    overlapping.forEach(entry => {
        const localStart = Math.max(0, safeStart - entry.start);
        const localEnd = Math.min(entry.node.textContent.length, safeEnd - entry.start);
        if (localEnd <= localStart) return;
        try {
            const range = document.createRange();
            range.setStart(entry.node, localStart);
            range.setEnd(entry.node, localEnd);
            range.surroundContents(makeDocAnnotationMark(color, annId, annType));
            applied = true;
        } catch {}
    });
    return applied;
}

function highlightTextInElement(root, text, color, annId, annType = 'highlight') {
    const { fullText } = getDocTextIndex(root);
    const idx = fullText.toLowerCase().indexOf(text.toLowerCase());
    if (idx === -1) return;
    highlightTextRangeInElement(root, idx, idx + text.length, color, annId, annType);
}

function findDocAutoMatches(root, searchText, matchMode) {
    const { fullText } = getDocTextIndex(root);
    const normalized = buildNormalizedTextMap(fullText);
    const ranges = findNormalizedTextRanges(normalized.text, searchText, matchMode);
    return ranges.map(range => {
        const start = normalized.map[range.start] ?? 0;
        const end = (normalized.map[Math.max(range.end - 1, range.start)] ?? start) + 1;
        return {
            start,
            end,
            quote: fullText.slice(start, end).replace(/\s+/g, ' ').trim(),
        };
    }).filter(match => match.quote);
}

/* ── Doc viewer search ─────────────────────────────────────────────────────── */

let _docSearchMatches = [];
let _docSearchIdx = 0;

function docViewerSearch(query) {
    const content = document.getElementById('doc-viewer-content');
    if (!content) return;

    // Remove existing highlights
    content.querySelectorAll('.doc-search-match').forEach(el => {
        el.replaceWith(document.createTextNode(el.textContent));
    });
    content.normalize();
    _docSearchMatches = [];
    _docSearchIdx = 0;

    if (!query || query.length < 2) return;

    const q = query.toLowerCase();
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    nodes.forEach(node => {
        const text = node.textContent;
        const lower = text.toLowerCase();
        let pos = 0, idx;
        while ((idx = lower.indexOf(q, pos)) !== -1) {
            try {
                const range = document.createRange();
                range.setStart(node, idx);
                range.setEnd(node, idx + q.length);
                const mark = document.createElement('mark');
                mark.className = 'doc-search-match';
                range.surroundContents(mark);
                _docSearchMatches.push(mark);
                pos = 0; // node has been split, re-process
                break;
            } catch { break; }
        }
    });

    if (_docSearchMatches.length > 0) {
        _docSearchMatches[0].classList.add('active');
        _docSearchMatches[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

/* ── Annotation Tools ──────────────────────────────────────────────────────── */

function initAnnotationTools() {
    const annotationToolButtons = document.querySelectorAll('#annotation-tools .tool-btn[data-tool]');
    annotationToolButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            if (!btn.dataset.tool) return;
            annotationToolButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            appState.annotationTool = btn.dataset.tool;

            document.querySelectorAll('.text-layer').forEach(tl => {
                const pageDiv = tl.closest('.pdf-page');
                const blocksText = appState.annotationTool === 'area' || appState.annotationTool === 'draw';
                tl.classList.toggle('interactive', !blocksText);
                if (pageDiv) {
                    pageDiv.classList.toggle('area-mode', appState.annotationTool === 'area');
                    pageDiv.classList.toggle('draw-mode', appState.annotationTool === 'draw');
                }
            });

            const imgContainer = document.querySelector('.image-annotation-container');
            if (imgContainer) {
                imgContainer.classList.toggle('area-mode', appState.annotationTool === 'area');
                imgContainer.classList.toggle('comment-mode', appState.annotationTool === 'comment');
                imgContainer.classList.toggle('draw-mode', appState.annotationTool === 'draw');
            }

            // Show draw-specific controls only when draw tool is active
            document.querySelectorAll('.draw-tool-only').forEach(el => {
                el.classList.toggle('hidden', appState.annotationTool !== 'draw');
            });
        });
    });

    document.querySelectorAll('.color-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            appState.annotationColor = btn.dataset.color;
        });
    });

    const drawSizeInput = document.getElementById('draw-size-input');
    if (drawSizeInput) {
        // size 1–20 maps to normalized lineWidth via × 0.001
        drawSizeInput.addEventListener('input', () => {
            const v = Math.max(1, Math.min(20, parseInt(drawSizeInput.value) || 4));
            appState.drawLineWidth = v * 0.001;
        });
        drawSizeInput.addEventListener('change', () => {
            const v = Math.max(1, Math.min(20, parseInt(drawSizeInput.value) || 4));
            drawSizeInput.value = String(v);
            appState.drawLineWidth = v * 0.001;
        });
    }

    document.getElementById('annotation-undo-btn')?.addEventListener('click', undoAnnotationAction);
    document.getElementById('auto-annotation-btn')?.addEventListener('click', openAutoAnnotationDialog);
    document.addEventListener('click', handleAnnotationDeleteClick);
    document.addEventListener('keydown', handleAnnotationUndoShortcut);
    document.addEventListener('mouseup', handleTextSelection);
    initAreaSelection();
    initDrawTool();
}

function updatePreviewToolAvailability() {
    const isPdf = appState.previewKind === 'pdf';
    const isImage = appState.previewKind === 'image';
    const collapseBtn = document.getElementById('collapse-annotations-btn');
    if (collapseBtn) {
        collapseBtn.disabled = !isPdf;
        collapseBtn.title = isPdf ? 'Collapse to annotations' : 'Collapse to annotations (PDF only)';
        collapseBtn.setAttribute('aria-label', collapseBtn.title);
    }
    const areaBtn = document.querySelector('#annotation-tools .tool-btn[data-tool="area"]');
    const highlightBtn = document.querySelector('#annotation-tools .tool-btn[data-tool="highlight"]');
    const underlineBtn = document.querySelector('#annotation-tools .tool-btn[data-tool="underline"]');
    const selectBtn = document.querySelector('#annotation-tools .tool-btn[data-tool="select"]');
    const fullscreenBtn = document.getElementById('preview-fullscreen');
    const autoBtn = document.getElementById('auto-annotation-btn');

    const drawBtn = document.querySelector('#annotation-tools .tool-btn[data-tool="draw"]');
    if (areaBtn) {
        areaBtn.disabled = !isPdf && !isImage;
        areaBtn.title = (isPdf || isImage) ? 'Select area' : 'Select area is available for PDF and image files';
        areaBtn.setAttribute('aria-label', areaBtn.title);

        if (!isPdf && !isImage && appState.annotationTool === 'area') {
            appState.annotationTool = 'select';
            document.querySelectorAll('#annotation-tools .tool-btn[data-tool]').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.tool === 'select');
            });
            document.querySelectorAll('.pdf-page').forEach(pageDiv => pageDiv.classList.remove('area-mode'));
            document.querySelectorAll('.text-layer').forEach(tl => tl.classList.add('interactive'));
        }
    }
    if (drawBtn) {
        drawBtn.disabled = !isPdf && !isImage;
        drawBtn.title = (isPdf || isImage) ? 'Freehand draw' : 'Freehand draw is available for PDF and image files';
        drawBtn.setAttribute('aria-label', drawBtn.title);

        if (!isPdf && !isImage && appState.annotationTool === 'draw') {
            appState.annotationTool = 'select';
            document.querySelectorAll('#annotation-tools .tool-btn[data-tool]').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.tool === 'select');
            });
            document.querySelectorAll('.pdf-page').forEach(pageDiv => pageDiv.classList.remove('draw-mode'));
            document.querySelectorAll('.text-layer').forEach(tl => tl.classList.add('interactive'));
            document.querySelectorAll('.draw-tool-only').forEach(el => el.classList.add('hidden'));
        }
    }

    // Text-selection tools don't apply to images
    [highlightBtn, underlineBtn, selectBtn].forEach(btn => {
        if (!btn) return;
        btn.disabled = isImage;
        btn.title = isImage
            ? `${btn.dataset.tool.charAt(0).toUpperCase() + btn.dataset.tool.slice(1)} is not available for images`
            : btn.dataset.tool.charAt(0).toUpperCase() + btn.dataset.tool.slice(1);
        btn.setAttribute('aria-label', btn.title);
    });

    if (isImage && ['highlight', 'underline', 'select'].includes(appState.annotationTool)) {
        appState.annotationTool = 'area';
        document.querySelectorAll('#annotation-tools .tool-btn[data-tool]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tool === 'area');
        });
        document.querySelector('.image-annotation-container')?.classList.add('area-mode');
    }

    if (!isImage) {
        document.querySelector('.image-annotation-container')?.classList.remove('area-mode', 'comment-mode');
    }

    if (autoBtn) {
        const canAutoAnnotate = isPdf || appState.previewKind === 'doc';
        autoBtn.disabled = !canAutoAnnotate;
        autoBtn.title = canAutoAnnotate ? 'Auto annotation' : 'Auto annotation is available for PDF and document files';
        autoBtn.setAttribute('aria-label', autoBtn.title);
    }

    if (fullscreenBtn) {
        const hasPreview = Boolean(appState.previewKind);
        fullscreenBtn.disabled = !hasPreview;
        fullscreenBtn.title = appState.pdfFullscreen ? 'Exit fullscreen preview' : 'Fullscreen preview';
        fullscreenBtn.setAttribute('aria-label', fullscreenBtn.title);
    }
}

/* ── Freehand Draw Tool ────────────────────────────────────────────────────── */

function chaikinSmooth(pts, iterations = 2) {
    let result = pts;
    for (let i = 0; i < iterations; i++) {
        const next = [result[0]];
        for (let j = 0; j < result.length - 1; j++) {
            const [x0, y0] = result[j], [x1, y1] = result[j + 1];
            next.push([0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1]);
            next.push([0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1]);
        }
        next.push(result[result.length - 1]);
        result = next;
    }
    return result;
}

function initDrawTool() {
    let active = false;
    let rawPoints = [];
    let tempCanvas = null;
    let tempCtx = null;
    let drawingLayer = null;
    let drawingPageNum = 1;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

    document.addEventListener('mousedown', e => {
        if (appState.annotationTool !== 'draw') return;
        const pageDiv = e.target.closest('.pdf-page');
        const imgContainer = !pageDiv ? e.target.closest('.image-annotation-container') : null;
        if (!pageDiv && !imgContainer) return;

        drawingLayer = pageDiv
            ? pageDiv.querySelector('.annotation-layer')
            : imgContainer.querySelector('.image-annotation-layer');
        if (!drawingLayer) return;

        drawingPageNum = pageDiv ? parseInt(pageDiv.dataset.page) : 1;

        const rect = drawingLayer.getBoundingClientRect();
        const x = clamp(e.clientX - rect.left, 0, rect.width);
        const y = clamp(e.clientY - rect.top, 0, rect.height);

        // Live-preview canvas layered on top of the annotation layer
        tempCanvas = document.createElement('canvas');
        tempCanvas.width = drawingLayer.offsetWidth;
        tempCanvas.height = drawingLayer.offsetHeight;
        tempCanvas.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:20';
        drawingLayer.appendChild(tempCanvas);
        tempCtx = tempCanvas.getContext('2d');
        tempCtx.strokeStyle = appState.annotationColor;
        tempCtx.lineWidth = Math.max(1, appState.drawLineWidth * drawingLayer.offsetWidth);
        tempCtx.lineCap = 'round';
        tempCtx.lineJoin = 'round';

        active = true;
        rawPoints = [[x, y]];
        tempCtx.beginPath();
        tempCtx.moveTo(x, y);

        e.preventDefault();
        e.stopPropagation();
    }, true);

    document.addEventListener('mousemove', e => {
        if (!active || !tempCtx || !drawingLayer) return;
        const rect = drawingLayer.getBoundingClientRect();
        const x = clamp(e.clientX - rect.left, 0, rect.width);
        const y = clamp(e.clientY - rect.top, 0, rect.height);

        // Only record a new point if the mouse has moved at least 3px (reduces point count)
        const last = rawPoints[rawPoints.length - 1];
        const dx = x - last[0], dy = y - last[1];
        if (dx * dx + dy * dy < 9) return;

        rawPoints.push([x, y]);
        tempCtx.lineTo(x, y);
        tempCtx.stroke();
        tempCtx.beginPath();
        tempCtx.moveTo(x, y);
    }, true);

    document.addEventListener('mouseup', async e => {
        if (!active) return;
        active = false;

        if (tempCanvas) { tempCanvas.remove(); tempCanvas = null; tempCtx = null; }

        if (rawPoints.length < 2 || !drawingLayer) {
            drawingLayer = null; rawPoints = [];
            return;
        }

        const tw = drawingLayer.offsetWidth;
        const th = drawingLayer.offsetHeight;

        // Normalize to [0,1]
        let normPts = rawPoints.map(([px, py]) => [px / tw, py / th]);

        // Apply Chaikin smoothing if enabled
        if (appState.drawSmoothing && normPts.length > 3) {
            normPts = chaikinSmooth(normPts, 2);
        }

        // Bounding box for collapse-mode compatibility
        const xs = normPts.map(p => p[0]), ys = normPts.map(p => p[1]);
        const bx = Math.min(...xs), by = Math.min(...ys);
        const bw = Math.max(...xs) - bx, bh = Math.max(...ys) - by;

        const geometry = {
            points: normPts,
            lineWidth: appState.drawLineWidth,
            rects: [{ x: bx, y: by, width: Math.max(bw, 0.001), height: Math.max(bh, 0.001) }],
        };

        const itemKey = appState.previewItem?.item_key;
        if (!itemKey) { drawingLayer = null; rawPoints = []; return; }

        const annotationData = {
            item_key: itemKey,
            file_id: appState.previewItem?.files?.[0]?.file_id ?? null,
            page_index: drawingPageNum - 1,
            annotation_type: 'draw',
            color: appState.annotationColor,
            comment: '',
            quote: '',
            geometry_json: JSON.stringify(geometry),
        };

        try {
            const created = await createAnnotationForItem(itemKey, annotationData);
            pushAnnotationUndo({
                type: 'create',
                itemKey,
                annotation: { ...annotationData, annotation_id: created.annotation_id },
            });
            await loadAnnotations(itemKey);
        } catch (err) {
            console.error('Draw annotation error:', err);
        }

        drawingLayer = null;
        rawPoints = [];
    }, true);
}

/* ─────────────────────────────────────────────────────────────────────────── */

function initAreaSelection() {
    let isDrawing = false;
    let startX, startY, currentRect;
    let overlayDiv = null;
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

    document.addEventListener('mousedown', e => {
        const isAreaTool = appState.annotationTool === 'area';
        const isCommentTool = appState.annotationTool === 'comment';
        if (!isAreaTool && !isCommentTool) return;

        const pageDiv = e.target.closest('.pdf-page');
        const imgContainer = !pageDiv ? e.target.closest('.image-annotation-container') : null;
        // comment tool on images only; area tool on both
        if (isCommentTool && !imgContainer) return;
        if (!pageDiv && !imgContainer) return;

        let drawingLayer;
        if (pageDiv) {
            drawingLayer = pageDiv.querySelector('.annotation-layer') || pageDiv.querySelector('.text-layer');
        } else {
            drawingLayer = imgContainer.querySelector('.image-annotation-layer');
        }
        if (!drawingLayer) return;

        isDrawing = true;
        currentRect = null;
        const rect = drawingLayer.getBoundingClientRect();
        startX = clamp(e.clientX - rect.left, 0, rect.width);
        startY = clamp(e.clientY - rect.top, 0, rect.height);

        overlayDiv = document.createElement('div');
        overlayDiv.className = 'area-selection-preview';
        overlayDiv.style.left = startX + 'px';
        overlayDiv.style.top = startY + 'px';
        overlayDiv.style.borderColor = appState.annotationColor;
        overlayDiv.style.background = appState.annotationColor + '18';
        drawingLayer.appendChild(overlayDiv);

        e.preventDefault();
        e.stopPropagation();
    }, true);

    document.addEventListener('mousemove', e => {
        if (!isDrawing || !overlayDiv) return;
        const drawingLayer = overlayDiv.parentElement;
        const rect = drawingLayer.getBoundingClientRect();
        const currentX = clamp(e.clientX - rect.left, 0, rect.width);
        const currentY = clamp(e.clientY - rect.top, 0, rect.height);

        const left = Math.min(startX, currentX);
        const top = Math.min(startY, currentY);
        const width = Math.abs(currentX - startX);
        const height = Math.abs(currentY - startY);

        overlayDiv.style.left = left + 'px';
        overlayDiv.style.top = top + 'px';
        overlayDiv.style.width = width + 'px';
        overlayDiv.style.height = height + 'px';

        currentRect = { left, top, width, height };
    }, true);

    document.addEventListener('mouseup', async e => {
        if (!isDrawing) return;

        if (!overlayDiv || !currentRect) {
            if (overlayDiv) overlayDiv.remove();
            isDrawing = false;
            overlayDiv = null;
            currentRect = null;
            return;
        }

        const drawingLayer = overlayDiv.parentElement;
        const pageDiv = drawingLayer.closest('.pdf-page');
        const imgContainer = drawingLayer.closest('.image-annotation-container');
        const isImageMode = Boolean(imgContainer && !pageDiv);
        const tw = drawingLayer.offsetWidth;
        const th = drawingLayer.offsetHeight;
        const isTinyClick = currentRect.width < 5 && currentRect.height < 5;

        // For image comment tool: a click (no drag) places a pin
        if (isImageMode && isTinyClick && appState.annotationTool === 'comment') {
            currentRect = { left: startX - 8, top: startY - 8, width: 16, height: 16 };
        } else if (currentRect.width < 5 || currentRect.height < 5) {
            overlayDiv.remove();
            isDrawing = false;
            overlayDiv = null;
            currentRect = null;
            return;
        }

        const geometry = {
            rects: [{
                x: currentRect.left / tw,
                y: currentRect.top / th,
                width: currentRect.width / tw,
                height: currentRect.height / th,
            }]
        };

        overlayDiv.remove();
        isDrawing = false;
        overlayDiv = null;

        const itemKey = appState.previewItem.item_key;
        const fileId = appState.previewItem.files?.[0]?.file_id;
        const pageNum = isImageMode ? 1 : parseInt(pageDiv?.dataset.page || '1');
        const annotationType = (appState.annotationTool === 'comment') ? 'comment' : 'area';

        const annotationData = {
            item_key: itemKey,
            file_id: fileId,
            page_index: pageNum - 1,
            annotation_type: annotationType,
            color: appState.annotationColor,
            comment: '',
            quote: '',
            geometry_json: JSON.stringify(geometry),
        };

        try {
            const created = await createAnnotationForItem(itemKey, annotationData);
            pushAnnotationUndo({
                type: 'create',
                itemKey,
                annotation: { ...annotationData, annotation_id: created.annotation_id },
            });
            await loadAnnotations(itemKey);
            openNoteDrawer(created.annotation_id);
        } catch (err) {
            console.error('Area annotation error:', err);
        }

        currentRect = null;
    }, true);
}

function handleAnnotationUndoShortcut(event) {
    if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.key.toLowerCase() !== 'z') return;
    if (!appState.previewItem || document.getElementById('annotation-tools')?.classList.contains('hidden')) return;
    const active = document.activeElement;
    if (active && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName)) return;
    event.preventDefault();
    undoAnnotationAction();
}

function setAnnotationUndoEnabled() {
    const btn = document.getElementById('annotation-undo-btn');
    if (!btn) return;
    btn.disabled = appState.annotationUndoStack.length === 0;
}

function clearAnnotationUndoStack() {
    appState.annotationUndoStack = [];
    setAnnotationUndoEnabled();
}

function pushAnnotationUndo(action) {
    if (!action || !action.type) return;
    appState.annotationUndoStack.push(action);
    if (appState.annotationUndoStack.length > 30) appState.annotationUndoStack.shift();
    setAnnotationUndoEnabled();
}

function annotationPostBody(annotation) {
    return {
        file_id: annotation.file_id ?? null,
        page_index: annotation.page_index || 0,
        annotation_type: annotation.annotation_type || 'highlight',
        color: annotation.color || '',
        quote: annotation.quote || '',
        comment: annotation.comment || '',
        geometry_json: annotation.geometry_json || '{}',
        source_chunk_id: annotation.source_chunk_id || '',
        sentiment: annotation.sentiment || null,
    };
}

function annotationPatchBody(annotation) {
    return {
        annotation_type: annotation.annotation_type || 'highlight',
        color: annotation.color || '',
        quote: annotation.quote || '',
        comment: annotation.comment || '',
        page_index: Number.isFinite(annotation.page_index) ? annotation.page_index : null,
        geometry_json: annotation.geometry_json || '{}',
        sentiment: annotation.sentiment || null,
    };
}

async function createAnnotationForItem(itemKey, annotation) {
    const res = await fetch(`/api/items/${itemKey}/annotations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(annotationPostBody(annotation)),
    });
    if (!res.ok) throw new Error('Create annotation failed');
    return res.json();
}

async function patchAnnotation(annotation) {
    const res = await fetch(`/api/annotations/${annotation.annotation_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(annotationPatchBody(annotation)),
    });
    if (!res.ok) throw new Error('Update annotation failed');
    return res.json();
}

async function deleteAnnotationById(id) {
    const res = await fetch(`/api/annotations/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Delete annotation failed');
    return res.json();
}

async function undoAnnotationAction() {
    if (!appState.previewItem || appState.annotationUndoStack.length === 0) return;
    const action = appState.annotationUndoStack.pop();
    setAnnotationUndoEnabled();
    const itemKey = action.itemKey || appState.previewItem.item_key;

    try {
        if (action.type === 'create') {
            await deleteAnnotationById(action.annotation.annotation_id);
        } else if (action.type === 'delete') {
            await createAnnotationForItem(itemKey, action.annotation);
        } else if (action.type === 'update') {
            await patchAnnotation(action.before);
        }
        if (appState.previewItem) await loadAnnotations(appState.previewItem.item_key);
        showSaveConfirmation('Annotation undone');
    } catch (err) {
        appState.annotationUndoStack.push(action);
        setAnnotationUndoEnabled();
        console.error('Undo annotation error:', err);
        showSaveConfirmation('Undo failed');
    }
}

function getTextLayerFromNode(node) {
    let el = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    while (el) {
        if (el.classList && el.classList.contains('text-layer')) return el;
        el = el.parentElement;
    }
    return null;
}

function annotationTypeForTool(tool) {
    if (tool === 'comment') return 'comment';
    if (tool === 'underline') return 'underline';
    return 'highlight';
}

function getSelectionGeometry(range, textLayerEl) {
    return getGeometryFromClientRects(range.getClientRects(), textLayerEl);
}

function getGeometryFromClientRects(clientRects, textLayerEl) {
    const tlRect = textLayerEl.getBoundingClientRect();
    if (!tlRect.width || !tlRect.height) return null;

    const seen = new Set();
    const rects = Array.from(clientRects)
        .map(rect => {
            const left = Math.max(rect.left, tlRect.left);
            const top = Math.max(rect.top, tlRect.top);
            const right = Math.min(rect.right, tlRect.right);
            const bottom = Math.min(rect.bottom, tlRect.bottom);
            const width = right - left;
            const height = bottom - top;

            if (width < 1 || height < 1) return null;

            return {
                x: (left - tlRect.left) / tlRect.width,
                y: (top - tlRect.top) / tlRect.height,
                width: width / tlRect.width,
                height: height / tlRect.height,
            };
        })
        .filter(Boolean)
        .filter(r => {
            const key = [r.x, r.y, r.width, r.height].map(v => v.toFixed(4)).join(':');
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

    return rects.length ? { rects: mergeInlineGeometryRects(rects) } : null;
}

function mergeInlineGeometryRects(rects) {
    const sorted = [...rects].sort((a, b) => (a.y - b.y) || (a.x - b.x));
    const merged = [];

    sorted.forEach(rect => {
        const last = merged[merged.length - 1];
        const sameLine = last && Math.abs(last.y - rect.y) < 0.004 && Math.abs(last.height - rect.height) < 0.006;
        const closeEnough = sameLine && rect.x <= last.x + last.width + 0.008;

        if (closeEnough) {
            const right = Math.max(last.x + last.width, rect.x + rect.width);
            last.x = Math.min(last.x, rect.x);
            last.width = right - last.x;
            last.height = Math.max(last.height, rect.height);
        } else {
            merged.push({ ...rect });
        }
    });

    return merged;
}

const TEXT_MATCH_STOP_WORDS = new Set([
    'about', 'after', 'again', 'against', 'also', 'among', 'because', 'before',
    'being', 'between', 'could', 'during', 'first', 'from', 'have', 'into',
    'more', 'other', 'over', 'such', 'than', 'that', 'their', 'these', 'this',
    'through', 'under', 'using', 'were', 'when', 'where', 'which', 'while',
    'with', 'within', 'would'
]);

function normalizeMatchWords(text, significantOnly = false) {
    const words = (text || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/['’]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .split(/\s+/)
        .filter(Boolean);

    if (!significantOnly) return words;
    return words.filter(word => word.length > 3 && !TEXT_MATCH_STOP_WORDS.has(word));
}

function getTextLayerTokenStream(textLayerEl) {
    const tokens = [];
    const spans = [...textLayerEl.querySelectorAll('span[role="presentation"]')]
        .filter(span => span.textContent && span.getClientRects().length > 0);

    spans.forEach(span => {
        normalizeMatchWords(span.textContent).forEach(word => tokens.push({ word, span }));
    });

    return tokens;
}

function uniqueSpansFromTokenRange(tokens, start, end) {
    const spans = [];
    const seen = new Set();
    for (let i = start; i <= end; i++) {
        const span = tokens[i]?.span;
        if (span && !seen.has(span)) {
            seen.add(span);
            spans.push(span);
        }
    }
    return spans;
}

function findBestTokenRange(tokens, searchText) {
    const targetWords = normalizeMatchWords(searchText).slice(0, 90);
    if (targetWords.length === 0 || tokens.length === 0) return null;

    let bestExact = { score: 0, start: 0, end: 0 };
    for (let start = 0; start < tokens.length; start++) {
        let score = 0;
        while (
            start + score < tokens.length &&
            score < targetWords.length &&
            tokens[start + score].word === targetWords[score]
        ) {
            score++;
        }
        if (score > bestExact.score) {
            bestExact = { score, start, end: start + score - 1 };
        }
    }

    const exactThreshold = targetWords.length < 10
        ? targetWords.length
        : Math.ceil(targetWords.length * 0.55);
    if (bestExact.score >= exactThreshold) return bestExact;

    const keywordSet = new Set(normalizeMatchWords(searchText, true).slice(0, 28));
    if (keywordSet.size < 2) return null;

    let bestWindow = { score: 0, start: 0, end: 0 };
    const maxWindow = Math.max(targetWords.length + 8, Math.min(90, keywordSet.size * 5));
    for (let start = 0; start < tokens.length; start++) {
        const found = new Set();
        let first = -1, last = -1;
        const limit = Math.min(tokens.length, start + maxWindow);

        for (let i = start; i < limit; i++) {
            if (!keywordSet.has(tokens[i].word)) continue;
            found.add(tokens[i].word);
            if (first === -1) first = i;
            last = i;
        }

        if (found.size > bestWindow.score && first !== -1) {
            bestWindow = { score: found.size, start: first, end: last };
        }
    }

    const keywordThreshold = keywordSet.size < 4
        ? keywordSet.size
        : Math.max(3, Math.ceil(Math.min(keywordSet.size, 10) * 0.45));
    return bestWindow.score >= keywordThreshold ? bestWindow : null;
}

function findTextLayerMatchSpans(searchText, textLayerEl) {
    const tokens = getTextLayerTokenStream(textLayerEl);
    if (tokens.length === 0) return [];

    const range = findBestTokenRange(tokens, searchText);
    return range ? uniqueSpansFromTokenRange(tokens, range.start, range.end) : [];
}

function getGeometryFromElements(elements, textLayerEl) {
    const rects = [];
    elements.forEach(el => rects.push(...el.getClientRects()));
    return getGeometryFromClientRects(rects, textLayerEl);
}

function transformMatrix(m1, m2) {
    return [
        m1[0] * m2[0] + m1[2] * m2[1],
        m1[1] * m2[0] + m1[3] * m2[1],
        m1[0] * m2[2] + m1[2] * m2[3],
        m1[1] * m2[2] + m1[3] * m2[3],
        m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
        m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
    ];
}

function getTextContentTokenStream(textContent, viewport) {
    const { pageWidth, pageHeight, pageX, pageY } = viewport.rawDims;
    const pageTransform = [1, 0, 0, -1, -pageX, pageY + pageHeight];
    const tokens = [];

    textContent.items.forEach((item, itemIndex) => {
        if (!item.str || !item.width || !item.height || !Array.isArray(item.transform)) return;

        const tx = transformMatrix(pageTransform, item.transform);
        const fontHeight = Math.hypot(tx[2], tx[3]) || item.height;
        const left = tx[4];
        const top = tx[5] - fontHeight * 0.88;
        const height = fontHeight * 1.12;
        const width = item.width;
        const textLength = Math.max(item.str.length, 1);
        const text = item.str.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/['’]/g, '');
        const wordRe = /[A-Za-z0-9]+/g;
        let match;

        while ((match = wordRe.exec(text)) !== null) {
            const word = normalizeMatchWords(match[0])[0];
            if (!word) continue;
            tokens.push({
                word,
                itemIndex,
                startRatio: Math.max(0, Math.min(1, match.index / textLength)),
                endRatio: Math.max(0, Math.min(1, (match.index + match[0].length) / textLength)),
                rect: { left, top, width, height, pageWidth, pageHeight },
            });
        }
    });

    return tokens;
}

function geometryFromTextContentRange(tokens, range) {
    if (!range) return null;

    const byItem = new Map();
    for (let i = range.start; i <= range.end; i++) {
        const token = tokens[i];
        if (!token) continue;
        const existing = byItem.get(token.itemIndex) || {
            rect: token.rect,
            startRatio: 1,
            endRatio: 0,
        };
        existing.startRatio = Math.min(existing.startRatio, token.startRatio);
        existing.endRatio = Math.max(existing.endRatio, token.endRatio);
        byItem.set(token.itemIndex, existing);
    }

    const rects = [...byItem.values()].map(item => {
        const { rect } = item;
        const left = rect.left + rect.width * item.startRatio;
        const width = rect.width * Math.max(0.02, item.endRatio - item.startRatio);
        return {
            x: left / rect.pageWidth,
            y: rect.top / rect.pageHeight,
            width: width / rect.pageWidth,
            height: rect.height / rect.pageHeight,
        };
    }).filter(r => r.width > 0 && r.height > 0);

    return rects.length ? { rects: mergeInlineGeometryRects(rects) } : null;
}

async function getPdfTextMatchGeometry(searchText, pageNum) {
    if (!appState.pdfDoc || !searchText) return null;

    try {
        const page = await appState.pdfDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale: 1 });
        const textContent = await page.getTextContent();
        const tokens = getTextContentTokenStream(textContent, viewport);
        const range = findBestTokenRange(tokens, searchText);
        return geometryFromTextContentRange(tokens, range);
    } catch (err) {
        console.error('PDF text geometry error:', err);
        return null;
    }
}

/* ── Auto-anchoring for quote-only annotations ───────────────────────────────
   Annotations created outside the viewer (MCP tools, API clients) carry a
   quote but no on-page geometry, so they can't be drawn on the PDF or
   clicked-to. When a PDF opens, each such quote is located in the PDF text,
   the resolved rects (and corrected page) are persisted back on the
   annotation, and the overlays are redrawn — after which it behaves exactly
   like a viewer-made highlight. */
let _annAnchorResolveToken = 0;

function scheduleAnnotationAnchorResolution() {
    const token = ++_annAnchorResolveToken;
    setTimeout(() => {
        if (token === _annAnchorResolveToken) resolveUnanchoredAnnotations(token);
    }, 600);
}

function annotationNeedsAnchor(a) {
    if (!a.quote || !a.quote.trim()) return false;
    if (a.annotation_type === 'draw') return false;
    let geo = {};
    try { geo = JSON.parse(a.geometry_json || '{}'); } catch { return false; }
    if (geo.rects?.length || geo.points?.length) return false;
    if (geo.doc_char_start != null || geo.doc_offset != null) return false; // doc-viewer anchored
    return true;
}

async function resolveUnanchoredAnnotations(token) {
    if (appState.previewKind !== 'pdf' || !appState.pdfDoc) return;
    const itemKey = appState.pdfItemKey;
    const pending = appState.annotations.filter(annotationNeedsAnchor).slice(0, 25);
    if (!pending.length) return;

    let resolvedCount = 0;
    for (const ann of pending) {
        // Abort if another resolution started or the user switched PDFs
        if (token !== _annAnchorResolveToken || appState.pdfItemKey !== itemKey) return;
        try {
            const anchor = await resolveAnnotationAnchor(ann);
            if (!anchor) continue;
            const geometryJson = JSON.stringify(anchor.geometry);
            await patchAnnotation({ ...ann, page_index: anchor.pageIndex, geometry_json: geometryJson });
            const live = appState.annotations.find(x => x.annotation_id === ann.annotation_id);
            if (live) { live.page_index = anchor.pageIndex; live.geometry_json = geometryJson; }
            resolvedCount++;
        } catch (err) {
            console.warn('Annotation anchor resolution failed for', ann.annotation_id, err);
        }
    }
    if (resolvedCount && token === _annAnchorResolveToken && appState.pdfItemKey === itemKey) {
        renderAnnotations();
    }
}

async function resolveAnnotationAnchor(ann) {
    const quote = ann.quote.trim().slice(0, 500);
    const hintPage = (ann.page_index || 0) + 1;

    let geometry = await getPdfTextMatchGeometry(quote, hintPage);
    if (geometry) return { pageIndex: hintPage - 1, geometry };

    const pageNum = await findPageForQuote(quote, hintPage);
    if (!pageNum) return null;
    geometry = await getPdfTextMatchGeometry(quote, pageNum);
    return geometry ? { pageIndex: pageNum - 1, geometry } : null;
}

async function findPageForQuote(quote, skipPage) {
    const pdf = appState.pdfDoc;
    if (!pdf) return null;
    const keywords = quote.toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 4);
    if (!keywords.length) return null;

    const threshold = Math.ceil(keywords.length * 0.65);
    const total = Math.min(pdf.numPages, 300);
    let bestPage = null, bestScore = 0;
    for (let p = 1; p <= total; p++) {
        if (p === skipPage) continue; // already tried directly
        try {
            const page = await pdf.getPage(p);
            const text = (await page.getTextContent()).items.map(i => i.str).join(' ').toLowerCase();
            let score = 0;
            for (const w of keywords) if (text.includes(w)) score++;
            if (score > bestScore) {
                bestScore = score;
                bestPage = p;
                if (score === keywords.length) break;
            }
        } catch { /* unreadable page — keep scanning */ }
    }
    return bestScore >= threshold ? bestPage : null;
}

function findExactTokenRanges(tokens, searchText) {
    const targetWords = normalizeMatchWords(searchText);
    if (!targetWords.length || !tokens.length) return [];

    const ranges = [];
    for (let start = 0; start <= tokens.length - targetWords.length; start++) {
        let matched = true;
        for (let i = 0; i < targetWords.length; i++) {
            if (tokens[start + i]?.word !== targetWords[i]) {
                matched = false;
                break;
            }
        }
        if (matched) {
            ranges.push({ start, end: start + targetWords.length - 1 });
            start += Math.max(0, targetWords.length - 1);
        }
    }
    return ranges;
}

function findContainsAllTokenRanges(tokens, searchText) {
    const significant = normalizeMatchWords(searchText, true);
    const targetWords = significant.length >= 2 ? significant : normalizeMatchWords(searchText);
    const targetSet = new Set(targetWords);
    if (!targetSet.size || !tokens.length) return [];
    if (targetSet.size === 1) return findAnyWordTokenRanges(tokens, [...targetSet]);

    const ranges = [];
    const maxWindow = Math.max(targetWords.length + 8, Math.min(40, targetWords.length * 5));

    for (let start = 0; start < tokens.length; start++) {
        const found = new Set();
        let first = -1;
        let last = -1;
        const limit = Math.min(tokens.length, start + maxWindow);

        for (let i = start; i < limit; i++) {
            if (!targetSet.has(tokens[i].word)) continue;
            found.add(tokens[i].word);
            if (first === -1) first = i;
            last = i;
            if (found.size === targetSet.size) break;
        }

        if (found.size === targetSet.size && first !== -1) {
            ranges.push({ start: first, end: last });
            start = last;
        }
    }
    return ranges;
}

function findAnyWordTokenRanges(tokens, words) {
    const targetSet = new Set((words || []).flatMap(word => normalizeMatchWords(word)));
    if (!targetSet.size) return [];
    const ranges = [];
    tokens.forEach((token, index) => {
        if (targetSet.has(token.word)) ranges.push({ start: index, end: index });
    });
    return ranges;
}

function findAutoTokenRanges(tokens, searchText, matchMode) {
    if (matchMode === 'contains_all') return findContainsAllTokenRanges(tokens, searchText);
    if (matchMode === 'any_word') {
        const words = normalizeMatchWords(searchText, true);
        return findAnyWordTokenRanges(tokens, words.length ? words : normalizeMatchWords(searchText));
    }
    return findExactTokenRanges(tokens, searchText);
}

function quoteFromTokenRange(tokens, range) {
    if (!range) return '';
    return tokens.slice(range.start, range.end + 1).map(token => token.word).join(' ');
}

function splitAutoAnnotationTerms(raw) {
    return [...new Set((raw || '')
        .split(/[\n;,]+/)
        .map(term => term.trim())
        .filter(term => normalizeMatchWords(term).length > 0))]
        .slice(0, 100);
}

function buildNormalizedTextMap(text) {
    let normalized = '';
    const map = [];
    let lastWasSpace = true;

    for (let index = 0; index < (text || '').length; index++) {
        const char = text[index];
        const clean = char.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/['’]/g, '').toLowerCase();
        if (/^[a-z0-9]$/.test(clean)) {
            normalized += clean;
            map.push(index);
            lastWasSpace = false;
        } else if (!lastWasSpace) {
            normalized += ' ';
            map.push(index);
            lastWasSpace = true;
        }
    }

    if (normalized.endsWith(' ')) {
        normalized = normalized.slice(0, -1);
        map.pop();
    }
    return { text: normalized, map };
}

function normalizedWordsWithOffsets(normalizedText) {
    const words = [];
    const re = /[a-z0-9]+/g;
    let match;
    while ((match = re.exec(normalizedText || '')) !== null) {
        words.push({ word: match[0], start: match.index, end: match.index + match[0].length });
    }
    return words;
}

function findNormalizedTextRanges(normalizedText, searchText, matchMode) {
    const queryWords = normalizeMatchWords(searchText);
    if (!queryWords.length || !normalizedText) return [];
    const words = normalizedWordsWithOffsets(normalizedText);

    if (matchMode === 'any_word') {
        const significant = normalizeMatchWords(searchText, true);
        const target = new Set(significant.length ? significant : queryWords);
        return words
            .filter(word => target.has(word.word))
            .map(word => ({ start: word.start, end: word.end }));
    }

    if (matchMode === 'contains_all') {
        const significant = normalizeMatchWords(searchText, true);
        const target = new Set(significant.length >= 2 ? significant : queryWords);
        if (target.size === 1) {
            return words
                .filter(word => target.has(word.word))
                .map(word => ({ start: word.start, end: word.end }));
        }

        const ranges = [];
        const maxWindow = Math.max(target.size + 8, Math.min(40, target.size * 5));
        for (let start = 0; start < words.length; start++) {
            const found = new Set();
            let first = -1;
            let last = -1;
            const limit = Math.min(words.length, start + maxWindow);

            for (let i = start; i < limit; i++) {
                if (!target.has(words[i].word)) continue;
                found.add(words[i].word);
                if (first === -1) first = i;
                last = i;
                if (found.size === target.size) break;
            }

            if (found.size === target.size && first !== -1) {
                ranges.push({ start: words[first].start, end: words[last].end });
                start = last;
            }
        }
        return ranges;
    }

    const phrase = queryWords.join(' ');
    const ranges = [];
    let from = 0;
    while (from < normalizedText.length) {
        const index = normalizedText.indexOf(phrase, from);
        if (index === -1) break;
        const beforeOk = index === 0 || normalizedText[index - 1] === ' ';
        const afterIndex = index + phrase.length;
        const afterOk = afterIndex >= normalizedText.length || normalizedText[afterIndex] === ' ';
        if (beforeOk && afterOk) ranges.push({ start: index, end: afterIndex });
        from = index + Math.max(phrase.length, 1);
    }
    return ranges;
}

function autoAnnotationGeometrySignature(annotation) {
    let geo = {};
    try { geo = JSON.parse(annotation.geometry_json || '{}'); } catch {}
    if (geo.doc_char_start != null && geo.doc_char_end != null) {
        return `${annotation.page_index}:doc:${geo.doc_char_start}:${geo.doc_char_end}`;
    }
    const rects = (geo.rects || []).map(r => [
        r.x, r.y, r.width, r.height,
    ].map(v => Number(v || 0).toFixed(4)).join(',')).join('|');
    return `${annotation.page_index}:pdf:${rects}`;
}

function parseAutoAnnotationTagNames(raw) {
    return [...new Set((raw || '')
        .split(/[\n,]+/)
        .map(name => name.trim().replace(/^#+/, '').trim())
        .filter(Boolean))]
        .slice(0, 20);
}

async function ensureAutoAnnotationTags(raw) {
    const names = parseAutoAnnotationTagNames(raw);
    if (!names.length) return [];
    if (typeof loadAllTags === 'function') await loadAllTags();

    const tagIds = [];
    for (const name of names) {
        const normalized = name.toLowerCase();
        let tag = (appState.allTags || []).find(t => (t.name || '').toLowerCase() === normalized);
        if (!tag && typeof apiCreateTag === 'function') {
            const created = await apiCreateTag(name, '#3b82f6', null);
            tag = created?.tag_id ? { tag_id: created.tag_id, name, color: '#3b82f6', parent_id: null } : created?.tag;
            if (!tag?.tag_id) {
                await loadAllTags({ force: true });
                tag = (appState.allTags || []).find(t => (t.name || '').toLowerCase() === normalized);
            } else {
                appState.allTags.push(tag);
            }
        }
        if (tag?.tag_id) tagIds.push(tag.tag_id);
    }
    return [...new Set(tagIds)];
}

let _autoAnnotationPending = null;

function getAutoAnnotationDialogRoot() {
    const pane = document.getElementById('preview-pane');
    return appState.pdfFullscreen && pane ? pane : document.body;
}

function openAutoAnnotationDialog() {
    if (!appState.previewItem || !['pdf', 'doc', 'text', 'markdown', 'csv'].includes(appState.previewKind)) {
        showSaveConfirmation('Open a PDF or document first');
        return;
    }

    _autoAnnotationPending = null;
    document.getElementById('auto-annotation-dialog')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'auto-annotation-dialog';
    overlay.className = 'auto-ann-overlay';
    overlay.innerHTML = `
        <div class="auto-ann-dialog" role="dialog" aria-modal="true" aria-labelledby="auto-ann-title">
            <div class="auto-ann-header">
                <h3 id="auto-ann-title">Auto Annotation</h3>
                <button class="auto-ann-close" onclick="closeAutoAnnotationDialog()" aria-label="Close">${icon('x')}</button>
            </div>
            <div class="auto-ann-grid">
                <label class="auto-ann-field auto-ann-wide">
                    <span>Words or phrases</span>
                    <textarea id="auto-ann-terms" data-auto-ann-search="true" rows="4" placeholder="input, automation in land clearing"></textarea>
                </label>
                <label class="auto-ann-field">
                    <span class="auto-ann-label-with-help">
                        Find mode
                        <button type="button" class="auto-ann-help-btn" onclick="toggleAutoAnnotationModeHelp()" title="Show match mode examples" aria-label="Show match mode examples">${icon('circle-help')}</button>
                    </span>
                    <select id="auto-ann-match-mode" data-auto-ann-search="true">
                        <option value="exact">Exactly same phrase</option>
                        <option value="contains_all">Contains several words</option>
                        <option value="any_word">Any significant word</option>
                    </select>
                </label>
                <div id="auto-ann-mode-help" class="auto-ann-mode-help auto-ann-wide hidden">
                    <div><strong>Exactly same phrase</strong><span>Matches the phrase in order. Example: "automation in land clearing".</span></div>
                    <div><strong>Contains several words</strong><span>Matches nearby text with the key words, even with extra words or different order.</span></div>
                    <div><strong>Any significant word</strong><span>Matches each important word separately, such as "automation", "land", or "clearing".</span></div>
                </div>
            </div>
            <div id="auto-ann-result" class="auto-ann-result hidden">
                <div class="auto-ann-result-main">
                    <strong id="auto-ann-result-count">Found 0</strong>
                    <span id="auto-ann-result-detail">Ready</span>
                </div>
                <div class="auto-ann-progress" aria-hidden="true"><div id="auto-ann-progress-bar"></div></div>
            </div>
            <div id="auto-ann-apply-settings" class="auto-ann-apply-settings hidden">
                <div class="auto-ann-apply-title">Apply to found matches</div>
                <div class="auto-ann-grid">
                <div class="auto-ann-field">
                    <span>Style</span>
                    <div class="auto-ann-segment" data-auto-ann-group="type">
                        <button type="button" class="auto-ann-icon-option active" data-value="highlight" onclick="setAutoAnnotationOption('type','highlight')" title="Highlight" aria-label="Highlight">${icon('highlighter')}</button>
                        <button type="button" class="auto-ann-icon-option" data-value="underline" onclick="setAutoAnnotationOption('type','underline')" title="Underline" aria-label="Underline">${icon('underline')}</button>
                    </div>
                </div>
                <div class="auto-ann-field">
                    <span>Color</span>
                    <div class="auto-ann-color-row" data-auto-ann-group="color">
                        ${['#ffff00', '#00ff00', '#00ffff', '#ff99cc', '#ff6600'].map((color, index) => `
                            <button type="button" class="auto-ann-color ${index === 0 ? 'active' : ''}" data-value="${color}" style="background:${color}" onclick="setAutoAnnotationOption('color','${color}')" title="${color}" aria-label="${color}"></button>
                        `).join('')}
                    </div>
                </div>
                <div class="auto-ann-field">
                    <span>Sentiment</span>
                    <div class="auto-ann-segment" data-auto-ann-group="sentiment">
                        <button type="button" class="auto-ann-icon-option active" data-value="" onclick="setAutoAnnotationOption('sentiment','')" title="No sentiment" aria-label="No sentiment">${icon('circle-minus')}</button>
                        <button type="button" class="auto-ann-icon-option" data-value="pos" onclick="setAutoAnnotationOption('sentiment','pos')" title="Positive" aria-label="Positive">${icon('smile')}</button>
                        <button type="button" class="auto-ann-icon-option" data-value="neu" onclick="setAutoAnnotationOption('sentiment','neu')" title="Neutral" aria-label="Neutral">${icon('meh')}</button>
                        <button type="button" class="auto-ann-icon-option" data-value="neg" onclick="setAutoAnnotationOption('sentiment','neg')" title="Negative" aria-label="Negative">${icon('frown')}</button>
                    </div>
                </div>
                <label class="auto-ann-field auto-ann-wide">
                    <span>Auto tags</span>
                    <input id="auto-ann-tags" type="text" placeholder="#theme, #method">
                </label>
                <label class="auto-ann-field auto-ann-wide">
                    <span>Auto note</span>
                    <textarea id="auto-ann-note" rows="3" placeholder="Optional note added to each match"></textarea>
                </label>
                </div>
            </div>
            <div class="auto-ann-footer">
                <span id="auto-ann-status"></span>
                <button id="auto-ann-close-btn" class="btn-secondary btn-small hidden" onclick="closeAutoAnnotationDialog()">Close</button>
                <button id="auto-ann-rerun-btn" class="btn-secondary btn-small hidden" onclick="runAutoAnnotationFromDialog()">Rerun</button>
                <button id="auto-ann-add-btn" class="btn-primary btn-small hidden" onclick="addAutoAnnotationsFromDialog()">Add it</button>
                <button id="auto-ann-cancel-btn" class="btn-secondary btn-small" onclick="closeAutoAnnotationDialog()">Cancel</button>
                <button id="auto-ann-run-btn" class="btn-primary btn-small" onclick="runAutoAnnotationFromDialog()">Find</button>
            </div>
        </div>`;
    getAutoAnnotationDialogRoot().appendChild(overlay);
    refreshIcons(overlay);
    const color = ['#ffff00', '#00ff00', '#00ffff', '#ff99cc', '#ff6600'].includes(appState.annotationColor)
        ? appState.annotationColor
        : '#ffff00';
    setAutoAnnotationOption('color', color);
    overlay.querySelectorAll('[data-auto-ann-search="true"]').forEach(el => {
        el.addEventListener('input', clearAutoAnnotationPendingAfterEdit);
        el.addEventListener('change', clearAutoAnnotationPendingAfterEdit);
    });
    overlay.querySelector('#auto-ann-terms')?.focus();
    overlay.addEventListener('mousedown', e => {
        if (e.target === overlay) closeAutoAnnotationDialog();
    });
    overlay.addEventListener('keydown', e => {
        if (e.key === 'Escape') closeAutoAnnotationDialog();
    });
}

function closeAutoAnnotationDialog() {
    _autoAnnotationPending = null;
    document.getElementById('auto-annotation-dialog')?.remove();
}

function toggleAutoAnnotationModeHelp() {
    document.getElementById('auto-ann-mode-help')?.classList.toggle('hidden');
}

function setAutoAnnotationOption(group, value) {
    const wrap = document.querySelector(`[data-auto-ann-group="${group}"]`);
    if (!wrap) return;
    wrap.dataset.value = value;
    wrap.querySelectorAll('[data-value]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.value === value);
    });
}

function getAutoAnnotationOption(group, fallback = '') {
    const wrap = document.querySelector(`[data-auto-ann-group="${group}"]`);
    return wrap?.dataset.value ?? fallback;
}

function getAutoAnnotationSearchValues() {
    return {
        terms: splitAutoAnnotationTerms(document.getElementById('auto-ann-terms')?.value || ''),
        matchMode: document.getElementById('auto-ann-match-mode')?.value || 'exact',
    };
}

function getAutoAnnotationApplyValues() {
    return {
        annotationType: getAutoAnnotationOption('type', 'highlight') || 'highlight',
        color: getAutoAnnotationOption('color', appState.annotationColor || '#ffff00') || '#ffff00',
        sentiment: getAutoAnnotationOption('sentiment', '') || null,
        note: (document.getElementById('auto-ann-note')?.value || '').trim(),
        tagsRaw: document.getElementById('auto-ann-tags')?.value || '',
    };
}

function applyAutoAnnotationSettings(annotation, values) {
    return {
        ...annotation,
        annotation_type: values.annotationType,
        color: values.color,
        comment: values.note,
        sentiment: values.sentiment,
    };
}

function setAutoAnnotationStatus(message, options = {}) {
    const status = document.getElementById('auto-ann-status');
    if (status) status.textContent = message || '';
    const result = document.getElementById('auto-ann-result');
    const count = document.getElementById('auto-ann-result-count');
    const detail = document.getElementById('auto-ann-result-detail');
    const bar = document.getElementById('auto-ann-progress-bar');
    if (result && options.showResult !== false) result.classList.remove('hidden');
    if (count && options.countText) count.textContent = options.countText;
    if (detail && options.detailText) detail.textContent = options.detailText;
    if (bar && Number.isFinite(options.progress)) {
        bar.style.width = `${Math.max(0, Math.min(100, options.progress))}%`;
    }
    if (result) {
        result.classList.toggle('is-loading', Boolean(options.loading));
        result.classList.toggle('is-done', Boolean(options.done));
        result.classList.toggle('is-error', Boolean(options.error));
    }
}

function clearAutoAnnotationPendingAfterEdit() {
    if (!_autoAnnotationPending) return;
    _autoAnnotationPending = null;
    setAutoAnnotationApplySettingsVisible(false);
    setAutoAnnotationRunState('initial');
    setAutoAnnotationStatus('Settings changed. Run again before adding.', {
        countText: 'Run again',
        detailText: 'The previous match count is stale',
        progress: 0,
    });
}

function setAutoAnnotationApplySettingsVisible(visible) {
    document.getElementById('auto-ann-apply-settings')?.classList.toggle('hidden', !visible);
}

function setAutoAnnotationRunState(state) {
    const running = state === 'running' || state === 'adding';
    const found = state === 'found';
    const doneLike = found || state === 'error';
    const addBtn = document.getElementById('auto-ann-add-btn');
    const hasMatches = Boolean(_autoAnnotationPending?.matches?.length);

    document.getElementById('auto-ann-run-btn')?.classList.toggle('hidden', doneLike || state === 'adding');
    document.getElementById('auto-ann-cancel-btn')?.classList.toggle('hidden', doneLike || state === 'adding');
    document.getElementById('auto-ann-close-btn')?.classList.toggle('hidden', !doneLike);
    document.getElementById('auto-ann-rerun-btn')?.classList.toggle('hidden', !doneLike);
    addBtn?.classList.toggle('hidden', !found || !hasMatches);
    if (addBtn) addBtn.disabled = !found || !hasMatches;
    setAutoAnnotationApplySettingsVisible(found && hasMatches);

    const runBtn = document.getElementById('auto-ann-run-btn');
    const rerunBtn = document.getElementById('auto-ann-rerun-btn');
    if (runBtn) runBtn.disabled = running;
    if (rerunBtn) rerunBtn.disabled = running;
    document.querySelectorAll('#auto-annotation-dialog textarea, #auto-annotation-dialog input, #auto-annotation-dialog select, #auto-annotation-dialog .auto-ann-icon-option, #auto-annotation-dialog .auto-ann-color')
        .forEach(el => { el.disabled = running; });
}

async function collectPdfAutoAnnotations(options, onProgress = null) {
    const matches = [];
    if (!appState.pdfDoc) return matches;

    for (let pageNum = 1; pageNum <= appState.pdfDoc.numPages; pageNum++) {
        const page = await appState.pdfDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale: 1 });
        const textContent = await page.getTextContent();
        const tokens = getTextContentTokenStream(textContent, viewport);
        if (!tokens.length) continue;

        for (const term of options.terms) {
            const ranges = findAutoTokenRanges(tokens, term, options.matchMode);
            ranges.forEach(range => {
                const geometry = geometryFromTextContentRange(tokens, range);
                if (!geometry) return;
                matches.push({
                    item_key: appState.previewItem.item_key,
                    file_id: appState.previewItem.files?.[0]?.file_id ?? null,
                    page_index: pageNum - 1,
                    annotation_type: options.annotationType,
                    color: options.color,
                    comment: options.note,
                    quote: quoteFromTokenRange(tokens, range) || term,
                    geometry_json: JSON.stringify({ ...geometry, auto_term: term, auto_match_mode: options.matchMode }),
                    sentiment: options.sentiment,
                });
            });
        }
        onProgress?.({
            pageNum,
            totalPages: appState.pdfDoc.numPages,
            matches: matches.length,
        });
    }
    return matches;
}

function collectDocAutoAnnotations(options) {
    const contentEl = document.getElementById('doc-viewer-content');
    if (!contentEl || contentEl.closest('.hidden')) return [];

    const matches = [];
    options.terms.forEach(term => {
        findDocAutoMatches(contentEl, term, options.matchMode).forEach(match => {
            matches.push({
                item_key: appState.previewItem.item_key,
                file_id: null,
                page_index: 0,
                annotation_type: options.annotationType,
                color: options.color,
                comment: options.note,
                quote: match.quote || term,
                geometry_json: JSON.stringify({
                    doc_offset: match.quote.slice(0, 100),
                    doc_char_start: match.start,
                    doc_char_end: match.end,
                    auto_term: term,
                    auto_match_mode: options.matchMode,
                }),
                sentiment: options.sentiment,
            });
        });
    });
    return matches;
}

async function runAutoAnnotationFromDialog() {
    const options = getAutoAnnotationSearchValues();
    if (!options.terms.length) {
        _autoAnnotationPending = null;
        setAutoAnnotationApplySettingsVisible(false);
        setAutoAnnotationStatus('Add at least one word or phrase', {
            countText: 'Need words',
            detailText: 'Add terms before running',
            progress: 0,
            error: true,
        });
        return;
    }
    if (!appState.previewItem?.item_key) return;

    _autoAnnotationPending = null;
    setAutoAnnotationApplySettingsVisible(false);
    setAutoAnnotationRunState('running');
    setAutoAnnotationStatus('Finding matches...', {
        countText: 'Scanning',
        detailText: 'Looking through the active document',
        progress: 5,
        loading: true,
    });

    try {
        const itemKey = appState.previewItem.item_key;
        const rawMatches = appState.previewKind === 'pdf'
            ? await collectPdfAutoAnnotations(options, progress => {
                const pct = 5 + (progress.pageNum / progress.totalPages) * 45;
                setAutoAnnotationStatus(`Scanning page ${progress.pageNum}/${progress.totalPages}`, {
                    countText: `${progress.matches} found`,
                    detailText: 'Finding text matches',
                    progress: pct,
                    loading: true,
                });
            })
            : collectDocAutoAnnotations(options);
        if (appState.previewKind !== 'pdf') {
            setAutoAnnotationStatus(`Found ${rawMatches.length} match${rawMatches.length === 1 ? '' : 'es'}`, {
                countText: `${rawMatches.length} found`,
                detailText: 'Finding text matches',
                progress: 50,
                loading: true,
            });
        }

        const existing = new Set(appState.annotations.map(autoAnnotationGeometrySignature));
        const pending = [];
        rawMatches.forEach(annotation => {
            const signature = autoAnnotationGeometrySignature(annotation);
            if (!signature || existing.has(signature)) return;
            existing.add(signature);
            pending.push(annotation);
        });

        const limit = 500;
        const toCreate = pending.slice(0, limit);
        const skipped = rawMatches.length - pending.length;
        const capped = pending.length > limit ? pending.length - limit : 0;
        const suffix = [
            skipped ? `${skipped} duplicate skipped` : '',
            capped ? `${capped} over limit skipped` : '',
        ].filter(Boolean).join(', ');
        _autoAnnotationPending = {
            itemKey,
            options,
            matches: toCreate,
            rawCount: rawMatches.length,
            skipped,
            capped,
        };

        setAutoAnnotationStatus(`Found ${toCreate.length} new match${toCreate.length === 1 ? '' : 'es'}${toCreate.length ? '. Add it?' : ''}`, {
            countText: `Found ${toCreate.length}`,
            detailText: suffix || `${rawMatches.length} total match${rawMatches.length === 1 ? '' : 'es'} found`,
            progress: 100,
            done: true,
        });
        setAutoAnnotationRunState('found');
    } catch (err) {
        console.error('Auto annotation search error:', err);
        _autoAnnotationPending = null;
        setAutoAnnotationApplySettingsVisible(false);
        setAutoAnnotationStatus('Auto annotation search failed', {
            countText: 'Failed',
            detailText: 'No matches were prepared',
            progress: 100,
            error: true,
        });
        setAutoAnnotationRunState('error');
        showSaveConfirmation('Auto annotation search failed');
    }
}

async function addAutoAnnotationsFromDialog() {
    if (!_autoAnnotationPending?.matches?.length) {
        setAutoAnnotationStatus('No prepared matches to add', {
            countText: 'Found 0',
            detailText: 'Change the settings and rerun',
            progress: 100,
            error: true,
        });
        return;
    }

    const { itemKey, matches, skipped = 0, capped = 0 } = _autoAnnotationPending;
    const applyValues = getAutoAnnotationApplyValues();
    const suffix = [
        skipped ? `${skipped} duplicate skipped` : '',
        capped ? `${capped} over limit skipped` : '',
    ].filter(Boolean).join(', ');
    setAutoAnnotationRunState('adding');
    setAutoAnnotationStatus(`Adding ${matches.length} annotation${matches.length === 1 ? '' : 's'}...`, {
        countText: `0/${matches.length}`,
        detailText: 'Saving annotations',
        progress: 5,
        loading: true,
    });

    try {
        const tagIds = await ensureAutoAnnotationTags(applyValues.tagsRaw);
        const createdAnnotations = [];
        for (let i = 0; i < matches.length; i++) {
            const annotation = applyAutoAnnotationSettings(matches[i], applyValues);
            const created = await createAnnotationForItem(itemKey, annotation);
            const annotationId = created.annotation_id;
            if (annotationId && tagIds.length && typeof apiSetAnnotationTags === 'function') {
                await apiSetAnnotationTags(annotationId, tagIds);
            }
            if (annotationId) {
                createdAnnotations.push({ ...annotation, annotation_id: annotationId });
                pushAnnotationUndo({ type: 'create', itemKey, annotation: { ...annotation, annotation_id: annotationId } });
            }
            setAutoAnnotationStatus(`Adding ${i + 1}/${matches.length}`, {
                countText: `${i + 1}/${matches.length}`,
                detailText: 'Saving annotations',
                progress: 5 + ((i + 1) / Math.max(matches.length, 1)) * 85,
                loading: true,
            });
        }

        await loadAnnotations(itemKey);
        if (tagIds.length && typeof loadAllTags === 'function') await loadAllTags({ force: true });
        setAutoAnnotationStatus(`Created ${createdAnnotations.length}${suffix ? ` (${suffix})` : ''}`, {
            countText: `Created ${createdAnnotations.length}`,
            detailText: 'Annotations added',
            progress: 100,
            done: true,
        });
        _autoAnnotationPending = null;
        showSaveConfirmation(`Auto annotated ${createdAnnotations.length} match${createdAnnotations.length === 1 ? '' : 'es'}`);
        closeAutoAnnotationDialog();
    } catch (err) {
        console.error('Auto annotation error:', err);
        setAutoAnnotationStatus('Auto annotation failed', {
            countText: 'Failed',
            detailText: 'Annotations were not added',
            progress: 100,
            error: true,
        });
        _autoAnnotationPending = null;
        setAutoAnnotationRunState('error');
        showSaveConfirmation('Auto annotation failed');
    }
}

function getSelectionNode(selection, range) {
    return range?.commonAncestorContainer || selection?.anchorNode || selection?.focusNode || null;
}

function getCopyTranslateSelectionSurface(selection) {
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    if (!selection.toString().trim()) return null;
    if (!appState.previewItem) return null;
    if (document.getElementById('annotation-tools')?.classList.contains('hidden')) return null;

    const range = selection.getRangeAt(0);
    const node = getSelectionNode(selection, range);

    if (appState.previewKind === 'doc') {
        const docContent = document.getElementById('doc-viewer-content');
        return docContent && node && docContent.contains(node) ? docContent : null;
    }

    if (appState.previewKind === 'pdf') {
        return (
            getTextLayerFromNode(node) ||
            getTextLayerFromNode(selection.anchorNode) ||
            getTextLayerFromNode(selection.focusNode)
        );
    }

    return null;
}

function shouldShowCopyTranslatePopup(e, selection) {
    const surface = getCopyTranslateSelectionSurface(selection);
    if (!surface) return false;
    return !e?.target || surface.contains(e.target);
}

function showCopyPopup(e) {
    document.getElementById('copy-text-popup')?.remove();
    document.getElementById('translation-result-popup')?.remove();
    const selection = window.getSelection();
    if (!shouldShowCopyTranslatePopup(e, selection)) return;
    if (!selection || selection.isCollapsed) return;
    const selectedText = selection.toString().trim();
    if (!selectedText) return;

    const popup = document.createElement('div');
    popup.id = 'copy-text-popup';
    popup.className = 'copy-text-popup';
    popup.style.cssText = `position:fixed;top:${e.clientY - 44}px;left:${e.clientX}px;`;
    popup.innerHTML = `
        <button class="copy-text-btn" type="button">${icon('copy')} Copy</button>
        <button class="translate-text-btn" type="button">${icon('languages')} Translate</button>`;
    (appState.pdfFullscreen ? document.getElementById('preview-pane') : document.body).appendChild(popup);
    refreshIcons(popup);

    popup.querySelector('.copy-text-btn').addEventListener('mousedown', async ev => {
        ev.preventDefault();
        let copied = false;
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(selectedText);
                copied = true;
            }
        } catch (err) {
            console.warn('Clipboard API copy failed, falling back to document selection:', err);
        }
        if (!copied) copied = document.execCommand('copy');
        window.getSelection()?.removeAllRanges();
        popup.remove();
        showCopyToast(copied ? 'Copied!' : 'Copy failed');
    });

    popup.querySelector('.translate-text-btn').addEventListener('mousedown', async ev => {
        ev.preventDefault();
        const x = e.clientX;
        const y = e.clientY;
        popup.remove();
        await translateSelectedText(selectedText, x, y);
    });

    const dismiss = (ev) => { if (!popup.contains(ev.target)) { popup.remove(); document.removeEventListener('mousedown', dismiss); } };
    setTimeout(() => document.addEventListener('mousedown', dismiss), 0);
}

async function translateSelectedText(text, clientX, clientY) {
    showTranslationResultPopup(clientX, clientY, 'Translating...', true, false, text);
    try {
        const res = await fetch('/api/translation/translate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text,
                source_language: appState.translationSource || 'en',
                target_language: appState.translationTarget || 'id',
                item_key: appState.previewItem?.item_key || '',
                page_index: appState.previewPage || 1,
            }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'Translation failed');
        showTranslationResultPopup(clientX, clientY, data.translation || '', false, false, text);
    } catch (err) {
        showTranslationResultPopup(clientX, clientY, err.message || 'Translation failed', false, true, text);
    } finally {
        window.getSelection()?.removeAllRanges();
    }
}

function showTranslationResultPopup(clientX, clientY, text, loading = false, error = false, originalText = '') {
    document.getElementById('translation-result-popup')?.remove();
    const popup = document.createElement('div');
    popup.id = 'translation-result-popup';
    popup.className = `translation-result-popup ${error ? 'error' : ''}`;
    popup.style.cssText = `position:fixed;top:${Math.max(12, clientY - 10)}px;left:${clientX}px;`;

    const src = appState.translationSource || 'en';
    const tgt = appState.translationTarget || 'id';
    const pairs = appState.translationInstalledPairs || [];

    // If multiple pairs installed: show a dropdown so the user can switch without going to Settings.
    // If 0 or 1 pair: static label is sufficient.
    let headerInner;
    if (pairs.length > 1) {
        const opts = pairs.map(p => {
            const sel = p.from_code === src && p.to_code === tgt ? ' selected' : '';
            return `<option value="${p.from_code}|${p.to_code}"${sel}>${p.from_code.toUpperCase()} → ${p.to_code.toUpperCase()}</option>`;
        }).join('');
        const curPair = pairs.find(p => p.from_code === src && p.to_code === tgt) || pairs[0];
        const curLabel = curPair ? `${curPair.from_code.toUpperCase()} → ${curPair.to_code.toUpperCase()}` : `${src.toUpperCase()} → ${tgt.toUpperCase()}`;
        headerInner = `<div class="translation-pair-dropdown${loading ? ' disabled' : ''}">
            <span class="translation-pair-text" aria-hidden="true">${curLabel}</span>
            <span class="translation-pair-chevron" aria-hidden="true">${icon('chevron-down')}</span>
            <select class="translation-pair-select" aria-label="Translation direction"${loading ? ' disabled' : ''}>${opts}</select>
        </div>`;
    } else {
        headerInner = `<span class="translation-pair-label">${src.toUpperCase()} → ${tgt.toUpperCase()}</span>`;
    }

    popup.innerHTML = `
        <div class="translation-result-head">
            ${headerInner}
            <button class="translation-result-close" type="button" title="Close" aria-label="Close">${icon('x')}</button>
        </div>
        <div class="translation-result-body ${loading ? 'loading' : ''}">${escapeHtml(text)}</div>
        ${loading || error ? '' : `<div class="translation-result-actions">
            <button class="btn-secondary btn-small translation-copy-result" type="button">${icon('copy')} Copy</button>
        </div>`}`;
    (appState.pdfFullscreen ? document.getElementById('preview-pane') : document.body).appendChild(popup);
    refreshIcons(popup);

    popup.querySelector('.translation-result-close')?.addEventListener('click', () => popup.remove());
    popup.querySelector('.translation-copy-result')?.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(text); showCopyToast('Translation copied'); }
        catch { showCopyToast('Copy failed'); }
    });

    // Pair switcher: retranslate in-place when user picks a different direction
    const select = popup.querySelector('.translation-pair-select');
    if (select && originalText) {
        select.addEventListener('change', async () => {
            const [newSrc, newTgt] = select.value.split('|');
            appState.translationSource = newSrc;
            appState.translationTarget = newTgt;
            localStorage.setItem('translationSource', newSrc);
            localStorage.setItem('translationTarget', newTgt);

            const textSpan = select.closest('.translation-pair-dropdown')?.querySelector('.translation-pair-text');
            if (textSpan) textSpan.textContent = `${newSrc.toUpperCase()} → ${newTgt.toUpperCase()}`;
            select.disabled = true;
            select.closest('.translation-pair-dropdown')?.classList.add('disabled');
            const body = popup.querySelector('.translation-result-body');
            body.className = 'translation-result-body loading';
            body.textContent = 'Translating...';
            popup.querySelector('.translation-result-actions')?.remove();
            popup.classList.remove('error');

            try {
                const res = await fetch('/api/translation/translate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        text: originalText,
                        source_language: newSrc,
                        target_language: newTgt,
                        item_key: appState.previewItem?.item_key || '',
                        page_index: appState.previewPage || 1,
                    }),
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.detail || 'Translation failed');
                const result = data.translation || '';
                body.className = 'translation-result-body';
                body.textContent = result;
                const actions = document.createElement('div');
                actions.className = 'translation-result-actions';
                actions.innerHTML = `<button class="btn-secondary btn-small translation-copy-result" type="button">${icon('copy')} Copy</button>`;
                popup.appendChild(actions);
                refreshIcons(actions);
                actions.querySelector('.translation-copy-result')?.addEventListener('click', async () => {
                    try { await navigator.clipboard.writeText(result); showCopyToast('Translation copied'); }
                    catch { showCopyToast('Copy failed'); }
                });
            } catch (err) {
                body.className = 'translation-result-body';
                body.textContent = err.message || 'Translation failed';
                popup.classList.add('error');
            } finally {
                select.disabled = false;
                select.closest('.translation-pair-dropdown')?.classList.remove('disabled');
            }
        });
    }
}

function showCopyToast(msg) {
    document.getElementById('copy-toast')?.remove();
    const toast = document.createElement('div');
    toast.id = 'copy-toast';
    toast.className = 'copy-toast';
    toast.textContent = msg;
    (appState.pdfFullscreen ? document.getElementById('preview-pane') : document.body).appendChild(toast);
    setTimeout(() => toast.remove(), 1500);
}

async function handleTextSelection(e) {
    if (appState.annotationTool === 'area') return;
    if (appState.annotationTool === 'select') {
        const selection = window.getSelection();
        if (shouldShowCopyTranslatePopup(e, selection)) {
            showCopyPopup(e);
        } else if (!e.target.closest?.('#copy-text-popup, #translation-result-popup')) {
            document.getElementById('copy-text-popup')?.remove();
        }
        return;
    }
    if (!appState.previewItem) return;

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;

    const selectedText = selection.toString().trim();
    if (!selectedText) return;

    const range = selection.getRangeAt(0);

    // ── Doc viewer branch (txt / md / csv / docx) ──────────────────────────
    const docContent = document.getElementById('doc-viewer-content');
    if (docContent && docContent.contains(range.commonAncestorContainer)) {
        const itemKey = appState.previewItem.item_key;
        const annotationData = {
            item_key: itemKey,
            file_id: null,
            page_index: 0,
            annotation_type: annotationTypeForTool(appState.annotationTool),
            color: appState.annotationColor,
            comment: '',
            quote: selectedText,
            geometry_json: JSON.stringify({ doc_offset: selectedText.slice(0, 100) }),
        };
        try {
            const created = await createAnnotationForItem(itemKey, annotationData);
            selection.removeAllRanges();
            await loadAnnotations(itemKey);
            if (created?.annotation_id) openNoteDrawer(created.annotation_id);
        } catch (err) {
            console.error('Doc annotation error:', err);
        }
        return;
    }

    // ── PDF branch ──────────────────────────────────────────────────────────
    const textLayerEl = getTextLayerFromNode(range.commonAncestorContainer) ||
        getTextLayerFromNode(selection.anchorNode) ||
        getTextLayerFromNode(selection.focusNode);
    if (!textLayerEl) return;

    const pageDiv = textLayerEl.closest('.pdf-page');
    if (!pageDiv) return;
    const pageNum = parseInt(pageDiv.dataset.page);

    const itemKey = appState.previewItem.item_key;
    const fileId = appState.previewItem.files?.[0]?.file_id;

    // Geometry for the annotation should reflect what the user actually dragged
    // across, not a fuzzy re-match against the whole page.  For direct manual
    // selections the DOM range is the source of truth: range.getClientRects()
    // returns exactly the rectangles the browser painted for the selection, so
    // the resulting highlight matches the visible drag extent.
    //
    // We previously led with getPdfTextMatchGeometry() and only fell back to
    // getSelectionGeometry() when that failed.  The PDF text-content matcher
    // (findBestTokenRange in app-preview.js) uses a fuzzy "contains-all-keywords
    // window" fallback that can stretch start..end across intervening bystander
    // tokens when an exact match isn't found — so on PDFs whose text-content
    // tokenisation doesn't cleanly line up with the visible glyphs (whitespace
    // collapsing, kerning, ligature splitting, missing ToUnicode CMaps, etc.)
    // the computed geometry covered neighbouring text the user never selected,
    // i.e. "the highlight snaps to many texts around".  This is the inverse of
    // the citation-chat path (app-citation-chat.js ~line 441), which already
    // prefers span geometry and falls back to text-content matching.
    let geometry = getSelectionGeometry(range, textLayerEl);
    if (!geometry) {
        geometry = await getPdfTextMatchGeometry(selectedText, pageNum);
    }
    if (!geometry) {
        selection.removeAllRanges();
        showSaveConfirmation('Could not locate selected text in PDF');
        return;
    }

    const annotationData = {
        item_key: itemKey,
        file_id: fileId,
        page_index: pageNum - 1,
        annotation_type: annotationTypeForTool(appState.annotationTool),
        color: appState.annotationColor,
        comment: '',
        quote: selectedText,
        geometry_json: JSON.stringify(geometry),
    };

    try {
        const created = await createAnnotationForItem(itemKey, annotationData);
        selection.removeAllRanges();
        pushAnnotationUndo({
            type: 'create',
            itemKey,
            annotation: { ...annotationData, annotation_id: created.annotation_id },
        });
        await loadAnnotations(itemKey);
        openNoteDrawer(created.annotation_id);
    } catch (err) {
        console.error('Annotation error:', err);
    }
}

function getOverlayContainer() {
    return document.fullscreenElement || document.webkitFullscreenElement || document.body;
}

function showCommentDialog(existing) {
    return new Promise(resolve => {
        const container = getOverlayContainer();
        const overlay = document.createElement('div');
        overlay.className = 'comment-dialog-overlay';
        overlay.innerHTML = `
            <div class="comment-dialog">
                <div class="comment-dialog-title">Add Comment</div>
                <textarea class="comment-dialog-input" placeholder="Enter comment…" rows="3">${escapeHtml(existing)}</textarea>
                <div class="comment-dialog-actions">
                    <button class="btn-small comment-dialog-cancel">Cancel</button>
                    <button class="btn-small comment-dialog-save">Save</button>
                </div>
            </div>
        `;
        container.appendChild(overlay);
        const ta = overlay.querySelector('.comment-dialog-input');
        ta.focus();
        const dismiss = (val) => { overlay.remove(); resolve(val); };
        overlay.querySelector('.comment-dialog-save').onclick = () => dismiss(ta.value.trim());
        overlay.querySelector('.comment-dialog-cancel').onclick = () => dismiss(null);
        overlay.addEventListener('keydown', e => { if (e.key === 'Escape') dismiss(null); });
    });
}

async function loadAnnotations(itemKey) {
    try {
        const res = await fetch(`/api/items/${itemKey}/annotations`);
        if (!res.ok) return;
        const data = await res.json();
        const wasEmpty = appState.annotations.length === 0;
        appState.annotations = (data.annotations || []).map(a => ({ ...a, item_key: itemKey }));
        renderAnnotations();
        if (wasEmpty && appState.annotations.length > 0 && !appState.annotationPanelOpen) {
            appState.annotationPanelOpen = true;
            toggleAnnotationPanel();
        }
        if (appState.previewKind === 'pdf' && appState.pdfDoc && appState.pdfItemKey === itemKey) {
            scheduleAnnotationAnchorResolution();
        }
    } catch (err) {
        console.error('Load annotations error:', err);
    }
}

function renderAnnotations() {
    // Re-draw overlays on all rendered pages
    document.querySelectorAll('.pdf-page[data-rendered="true"]').forEach(pageDiv => {
        const pageNum = parseInt(pageDiv.dataset.page);
        const annLayer = pageDiv.querySelector('.annotation-layer');
        const textLayer = pageDiv.querySelector('.text-layer');
        if (annLayer && textLayer) renderAnnotationsOnPage(pageNum, annLayer, textLayer);
    });
    // Re-draw overlays on image viewer
    if (appState.previewKind === 'image') renderAnnotationsOnImage();
    // Re-highlight doc-viewer annotations if a doc is open
    if (appState.currentDocItemKey && !document.getElementById('doc-viewer')?.classList.contains('hidden')) {
        highlightDocAnnotations(appState.currentDocItemKey);
    }
    if (appState.pdfFullscreen) {
        // In fullscreen, only render to the fullscreen panel to avoid duplicate element IDs
        // that would cause getElementById lookups (sentiment, tags, mentions) to find the wrong element.
        renderPdfFullscreenAnnotations();
    } else {
        renderAnnotationList();
        if (appState.annotationPanelOpen) renderAnnotationListInPanel();
    }
    updateAnnotationCountBadges();
}

function updateAnnotationCountBadges() {
    const count = appState.annotations.length;

    const fsTab = document.querySelector('.pdf-sidebar-tab[data-tab="annotations"]');
    if (fsTab) updateSmallCountBadge(fsTab, count);

    const fsTitleCount = document.querySelector('[data-panel="annotations"] .pdf-sidebar-count');
    if (fsTitleCount) fsTitleCount.textContent = String(count);

    const panelTab = document.querySelector('.annotation-panel-tabs .annotation-panel-tab');
    if (panelTab) updateSmallCountBadge(panelTab, count);
}

function updateSmallCountBadge(container, count) {
    let badge = container.querySelector(':scope > small');
    if (count > 0) {
        if (!badge) {
            badge = document.createElement('small');
            container.appendChild(badge);
        }
        badge.textContent = String(count);
    } else {
        badge?.remove();
    }
}

function renderPdfFullscreenSidebar() {
    const sidebar = document.getElementById('pdf-fullscreen-sidebar');
    if (!sidebar) return;

    const isPdf = appState.previewKind === 'pdf';
    // Outline tab is PDF-only; fall back to annotations if it was active
    if (!isPdf && appState.pdfFullscreenSidebarTab === 'outline') {
        appState.pdfFullscreenSidebarTab = 'annotations';
    }

    sidebar.innerHTML = `
        <div class="pdf-fs-resize-handle" id="pdf-fs-resize-handle" role="separator" aria-label="Resize sidebar" title="Drag to resize"></div>
        <div class="pdf-sidebar-tabs" role="tablist" aria-label="Fullscreen panels">
            ${renderPdfSidebarTab('annotations', 'Annotations', appState.annotations.length)}
            ${renderPdfSidebarTab('library', 'Library', (appState.pdfLibrarySearch ? appState.pdfLibrarySearchItems : appState.pdfLibraryRelatedItems).length)}
            ${isPdf ? renderPdfSidebarTab('outline', 'Outline', appState.pdfOutlineItems.length) : ''}
            ${renderPdfSidebarTab('notes', 'Notes', appState.noteConnections?.length || 0)}
            ${renderPdfSidebarTab('chat', 'Chat', appState.chatMessages.length)}
        </div>
        <div class="pdf-sidebar-tab-panel ${appState.pdfFullscreenSidebarTab === 'annotations' ? 'active' : ''}" data-panel="annotations">
            <div class="pdf-sidebar-title">
                <span>Annotations</span>
                <span class="pdf-sidebar-count">${appState.annotations.length}</span>
            </div>
            <div id="pdf-fullscreen-annotation-list" class="pdf-fullscreen-annotation-list"></div>
        </div>
        <div class="pdf-sidebar-tab-panel ${appState.pdfFullscreenSidebarTab === 'library' ? 'active' : ''}" data-panel="library">
            <div class="pdf-library-controls">
                <select id="pdf-library-dir-filter" class="pdf-library-dir-filter" aria-label="Filter by directory" onchange="onPdfLibraryDirChange(this.value)">
                    <option value="">All directories</option>
                    ${(appState.currentDirs || []).map(d => `<option value="${escapeHtml(d.path)}" ${d.path === appState.pdfLibrarySourceDir ? 'selected' : ''}>${escapeHtml(d.label || d.path)}</option>`).join('')}
                </select>
                <input id="pdf-fullscreen-library-search" class="pdf-library-search-bar" type="text" placeholder="Search library..." value="${escapeHtml(appState.pdfLibrarySearch)}" oninput="onPdfLibrarySearch(this.value)" aria-label="Search library">
            </div>
            <div id="pdf-fullscreen-library-list" class="pdf-fullscreen-library-list"></div>
        </div>
        ${isPdf ? `
        <div class="pdf-sidebar-tab-panel ${appState.pdfFullscreenSidebarTab === 'outline' ? 'active' : ''}" data-panel="outline">
            <div class="pdf-sidebar-title">
                <span>Outline</span>
                <span class="pdf-sidebar-count">${appState.pdfOutlineItems.length || '-'}</span>
            </div>
            <div id="pdf-outline-list" class="pdf-outline-list">${renderPdfOutlineItems()}</div>
        </div>` : ''}
        <div class="pdf-sidebar-tab-panel ${appState.pdfFullscreenSidebarTab === 'chat' ? 'active' : ''}" data-panel="chat">
            <div class="pdf-chat-scope-bar">
                <button class="pdf-chat-scope-btn ${appState.pdfChatScope === 'document' ? 'active' : ''}"
                        onclick="setPdfChatScope('document')" title="Ask about this document only">This doc</button>
                <button class="pdf-chat-scope-btn ${appState.pdfChatScope === 'library' ? 'active' : ''}"
                        onclick="setPdfChatScope('library')" title="Ask across your whole library">Library</button>
            </div>
            <div id="pdf-fs-chat-sessions" class="sessions-list hidden"></div>
            <div id="pdf-fullscreen-chat-messages" class="pdf-fullscreen-chat-messages"></div>
            <div class="chat-input-area pdf-chat-input-area">
                <textarea id="pdf-fullscreen-chat-input" rows="2"
                    placeholder="${appState.pdfChatScope === 'document' ? 'Ask about this document...' : 'Ask across your library...'}"
                    onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendPdfFullscreenChatMessage();}"></textarea>
                <div class="chat-input-row">
                    <select id="pdf-chat-model-select" class="chat-model-select pdf-chat-model-select" aria-label="AI profile"></select>
                    <button class="btn-secondary chat-action-button" onclick="startPdfNewChat()" title="New chat" aria-label="New chat">${icon('plus')}</button>
                    <button id="pdf-chat-history-toggle" class="btn-secondary chat-history-toggle" onclick="togglePdfChatHistoryPanel()" title="History" aria-label="Chat history" aria-expanded="false">${icon('history')}</button>
                    <button class="btn-primary chat-send-icon-btn" onclick="sendPdfFullscreenChatMessage()" title="Send" aria-label="Send">${icon('send')}</button>
                </div>
            </div>
        </div>
        <div class="pdf-sidebar-tab-panel ${appState.pdfFullscreenSidebarTab === 'notes' ? 'active' : ''}" data-panel="notes">
            <div id="item-notes-viewer" class="project-notes-viewer item-notes-viewer" data-notes-scope="item">
                ${renderItemNotesEditor()}
            </div>
        </div>
    `;
    renderPdfFullscreenLibrary();
    renderPdfFullscreenAnnotations();
    renderPdfFullscreenChat();
    renderPdfChatProfileSelect();
    if (appState.pdfFullscreenSidebarTab === 'notes') {
        loadItemNotesForPreview();
    }
    updatePdfNavigatorActivePage();
    refreshIcons(sidebar);
}

function renderPdfSidebarTab(tab, label, count) {
    const icons = { annotations: 'bookmark', library: 'book-open', outline: 'list', notes: 'notebook-tabs', chat: 'message-circle' };
    const active = appState.pdfFullscreenSidebarTab === tab;
    return `
        <button class="pdf-sidebar-tab ${active ? 'active' : ''}" role="tab" aria-selected="${active}"
                title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"
                data-tab="${escapeHtml(tab)}"
                onclick="setPdfFullscreenSidebarTab('${tab}')">
            <i data-lucide="${icons[tab] || 'circle'}" aria-hidden="true"></i>
            ${count ? `<small>${count}</small>` : ''}
        </button>
    `;
}

function setPdfChatScope(scope) {
    if (scope !== 'document' && scope !== 'library') return;
    appState.pdfChatScope = scope;
    renderPdfFullscreenSidebar();
}

function setPdfFullscreenSidebarTab(tab) {
    if (tab === 'outline' && appState.previewKind !== 'pdf') tab = 'annotations';
    if (appState.pdfFullscreenSidebarTab === 'notes' && tab !== 'notes' && appState.notesScope === 'item') {
        clearTimeout(_notesSaveTimer);
        saveProjectNotes();
        closeInkConnectionsForInactiveProjectView();
        appState.notesScope = 'project';
        appState.activeNotesItemKey = '';
    }
    appState.pdfFullscreenSidebarTab = tab;
    renderPdfFullscreenSidebar();
    if (tab === 'library') loadPdfFullscreenLibrary();
    if (tab === 'notes') {
        document.getElementById('item-notes-content')?.focus();
    }
    if (tab === 'chat') {
        renderPdfFullscreenChat();
        document.getElementById('pdf-fullscreen-chat-input')?.focus();
    }
}

function renderItemNotesEditor() {
    return `
        <div class="notes-toolbar">
            <button class="notes-tool-btn" onmousedown="event.preventDefault()" onclick="notesFormat('bold')" title="Bold"><b>B</b></button>
            <button class="notes-tool-btn notes-tool-italic" onmousedown="event.preventDefault()" onclick="notesFormat('italic')" title="Italic"><i>I</i></button>
            <button class="notes-tool-btn notes-tool-underline" onmousedown="event.preventDefault()" onclick="notesFormat('underline')" title="Underline"><u>U</u></button>
            <div class="notes-toolbar-divider"></div>
            <button class="notes-tool-btn" onmousedown="event.preventDefault()" onclick="notesFormat('formatBlock','h1')" title="Heading 1">H1</button>
            <button class="notes-tool-btn" onmousedown="event.preventDefault()" onclick="notesFormat('formatBlock','h2')" title="Heading 2">H2</button>
            <button class="notes-tool-btn" onmousedown="event.preventDefault()" onclick="notesFormat('formatBlock','p')" title="Normal text">¶</button>
            <div class="notes-toolbar-divider"></div>
            <button class="notes-tool-btn" onmousedown="event.preventDefault()" onclick="notesFormat('insertUnorderedList')" title="Bullet list">• List</button>
            <button class="notes-tool-btn" onmousedown="event.preventDefault()" onclick="notesFormat('insertOrderedList')" title="Numbered list">1. List</button>
            <div class="notes-toolbar-divider"></div>
            <button class="notes-tool-btn" onmousedown="event.preventDefault()" onclick="notesFormat('justifyLeft')" title="Align left"><i data-lucide="align-left" aria-hidden="true"></i></button>
            <button class="notes-tool-btn" onmousedown="event.preventDefault()" onclick="notesFormat('justifyCenter')" title="Align center"><i data-lucide="align-center" aria-hidden="true"></i></button>
            <button class="notes-tool-btn" onmousedown="event.preventDefault()" onclick="notesFormat('justifyRight')" title="Align right"><i data-lucide="align-right" aria-hidden="true"></i></button>
            <div class="notes-toolbar-divider"></div>
            <div class="notes-color-control" data-notes-role="color-control" onmousedown="event.preventDefault()">
                <button class="notes-tool-btn notes-color-apply-btn" onclick="notesApplyActiveColor()" title="Apply text color">
                    <span data-notes-role="color-indicator">A</span>
                </button>
                <button class="notes-tool-btn notes-color-menu-btn" onclick="toggleNotesColorMenu(event)" title="Choose text color" aria-label="Choose text color">${icon('chevron-down')}</button>
                <div class="notes-color-menu hidden" data-notes-role="color-menu">
                    <div class="notes-color-menu-section" data-notes-role="color-recent-section">
                        <div class="notes-color-menu-title">Recent</div>
                        <div class="notes-color-grid" data-notes-role="color-recent"></div>
                    </div>
                    <div class="notes-color-menu-section">
                        <div class="notes-color-menu-title">Colors</div>
                        <div class="notes-color-grid" data-notes-role="color-presets"></div>
                    </div>
                    <button class="notes-color-custom-btn" type="button" onclick="openNotesColorPicker(event)">
                        <span class="notes-color-custom-swatch" data-notes-role="color-custom-swatch"></span>
                        <span>Custom color</span>
                    </button>
                    <input type="color" data-notes-role="color-input" value="#e4e8f0" tabindex="-1" onchange="notesChooseCustomColor(this.value)">
                </div>
            </div>
            <div class="notes-toolbar-divider"></div>
            <button id="item-notes-ink-btn" class="notes-tool-btn notes-ink-btn" onmousedown="event.preventDefault()" onclick="toggleNotesInkMode()" title="Ink connection — click in notes, drag to the preview">${icon('git-branch')}</button>
            <div class="notes-toolbar-spacer"></div>
            <span id="item-notes-save-status" class="notes-save-status" data-notes-role="status"></span>
        </div>
        <div id="item-notes-body" class="project-notes-body item-notes-body" data-notes-role="body">
            <div id="item-notes-content" class="project-notes-content item-notes-content" data-notes-role="content" contenteditable="true" spellcheck="true" data-placeholder="Write notes for this document..." oninput="onNotesInput()" onmouseup="saveNotesSelection()" onkeyup="saveNotesSelection()"></div>
        </div>`;
}

async function loadItemNotesForPreview() {
    const itemKey = appState.previewItem?.item_key || '';
    const content = document.getElementById('item-notes-content');
    if (!itemKey || !content) return;

    appState.notesScope = 'item';
    appState.activeNotesItemKey = itemKey;
    content.innerHTML = '<div class="doc-loading">Loading notes...</div>';
    const status = getNotesStatusEl();
    if (status) status.textContent = '';
    try {
        const res = await fetch(`/api/items/${itemKey}/notes`);
        if (!res.ok) throw new Error('Could not load document notes');
        const data = await res.json();
        if (appState.activeNotesItemKey !== itemKey) return;
        // Re-resolve the target element rather than reuse the reference captured
        // before the fetch: a tab switch (or another caller re-rendering the
        // notes panel) while this was in flight would have replaced it, and
        // writing into the old, now-detached node would silently do nothing.
        const liveContent = document.getElementById('item-notes-content') || content;
        if (!document.body.contains(liveContent)) return;
        liveContent.innerHTML = data.notes || '';
        appState.previewItem.notes = data.notes || '';
        appState.previewItem.note_connections = data.note_connections || '[]';
        loadNoteConnections({ note_connections: data.note_connections || '[]' });
        renderNotesColorMenu();
        syncNotesColorControl();
        _syncInkModeUi();
        requestAnimationFrame(redrawInkLines);
    } catch (err) {
        console.error('Item notes load error:', err);
        content.innerHTML = '<div class="pdf-sidebar-empty">Could not load notes.</div>';
    }
}

async function loadPdfOutline(pdf) {
    try {
        const outline = await pdf.getOutline();
        if (!outline || outline.length === 0) return [];
        const items = [];
        await flattenPdfOutline(outline, pdf, items, 0);
        return items;
    } catch (err) {
        console.error('PDF outline load error:', err);
        return [];
    }
}

async function flattenPdfOutline(outline, pdf, items, level) {
    for (const item of outline) {
        const pageNum = await resolvePdfDestinationPage(pdf, item.dest);
        items.push({
            title: item.title || 'Untitled section',
            pageNum,
            level: Math.min(level, 4),
        });
        if (item.items?.length) {
            await flattenPdfOutline(item.items, pdf, items, level + 1);
        }
    }
}

async function resolvePdfDestinationPage(pdf, destination) {
    try {
        let dest = destination;
        if (typeof dest === 'string') dest = await pdf.getDestination(dest);
        if (!Array.isArray(dest) || dest.length === 0) return null;

        const ref = dest[0];
        if (typeof ref === 'number') return ref + 1;
        return (await pdf.getPageIndex(ref)) + 1;
    } catch (err) {
        return null;
    }
}

function renderPdfOutlineItems() {
    if (!appState.pdfOutlineItems.length) {
        return '<div class="pdf-sidebar-empty">No outline or bookmarks in this PDF</div>';
    }
    return appState.pdfOutlineItems.map((item, index) => `
        <button class="pdf-outline-item" data-outline-index="${index}" data-page="${item.pageNum || ''}" style="--outline-level:${item.level}" ${item.pageNum ? `onclick="goToPdfPage(${item.pageNum}, true)"` : 'disabled'}>
            <span>${escapeHtml(item.title)}</span>
            ${item.pageNum ? `<small>p.${item.pageNum}</small>` : ''}
        </button>
    `).join('');
}

async function loadPdfFullscreenLibrary() {
    if (!appState.pdfFullscreen) return;
    const itemKey = appState.previewItem?.item_key || '';
    const sourceDir = appState.pdfLibrarySourceDir;
    const search = appState.pdfLibrarySearch.trim();

    if (search) {
        try {
            let url = `/api/library/items?q=${encodeURIComponent(search)}&limit=40&sort_by=title&sort_order=asc`;
            if (sourceDir) url += `&source_dir=${encodeURIComponent(sourceDir)}`;
            const res = await fetch(url);
            const data = await res.json();
            appState.pdfLibrarySearchItems = (data.items || []).filter(i => i.item_key !== itemKey);
            appState.pdfLibraryRelatedItems = [];
        } catch (err) {
            console.error('Fullscreen library search error:', err);
        }
    } else if (itemKey) {
        try {
            let url = `/api/library/related?item_key=${encodeURIComponent(itemKey)}&limit=15`;
            if (sourceDir) url += `&source_dir=${encodeURIComponent(sourceDir)}`;
            const res = await fetch(url);
            const data = await res.json();
            appState.pdfLibraryRelatedItems = data.items || [];
            appState.pdfLibrarySearchItems = [];
        } catch (err) {
            console.error('Fullscreen library related error:', err);
        }
    } else {
        appState.pdfLibraryRelatedItems = [];
        appState.pdfLibrarySearchItems = [];
    }

    renderPdfFullscreenLibrary();
}

function itemHasPdf(item) {
    const files = item.files || [];
    return files.some(file => {
        const ext = (file.file_ext || file.file_path || file.file_name || '').toLowerCase();
        return ext === 'pdf' || ext.endsWith('.pdf');
    });
}

function onPdfLibraryDirChange(sourceDir) {
    appState.pdfLibrarySourceDir = sourceDir;
    loadPdfFullscreenLibrary();
}

let _pdfLibrarySearchTimer = null;
function onPdfLibrarySearch(value) {
    appState.pdfLibrarySearch = value;
    clearTimeout(_pdfLibrarySearchTimer);
    _pdfLibrarySearchTimer = setTimeout(loadPdfFullscreenLibrary, 300);
}

function renderPdfFullscreenLibrary() {
    const list = document.getElementById('pdf-fullscreen-library-list');
    if (!list) return;

    const search = appState.pdfLibrarySearch.trim();
    const items = search ? appState.pdfLibrarySearchItems : appState.pdfLibraryRelatedItems;

    const countEl = document.querySelector('[data-panel="library"] .pdf-sidebar-count');
    if (countEl) countEl.textContent = String(items.length || 0);

    if (items.length === 0) {
        let msg = 'No items found';
        if (!search) {
            msg = appState.previewItem
                ? 'No related documents found in your library'
                : 'Open a document to see related papers';
        }
        list.innerHTML = `<div class="pdf-sidebar-empty">${escapeHtml(msg)}</div>`;
        return;
    }

    if (search) {
        list.innerHTML = items.map(item => _renderPdfLibraryItem(item)).join('');
    } else {
        list.innerHTML =
            `<div class="pdf-library-section-header">${icon('sparkles')} Related to this document</div>` +
            items.map(item => _renderPdfLibraryRelatedItem(item)).join('');
    }
    refreshIcons(list);
}

function _renderPdfLibraryItem(item) {
    const active = item.item_key === appState.previewItem?.item_key;
    const creators = formatCreators(item.creators_list || item.creators);
    const meta = [creators, item.year].filter(Boolean).join(' · ');
    return `
        <button class="pdf-library-item ${active ? 'active' : ''}" onclick="openPreview('${escapeJs(item.item_key)}')">
            <span>${escapeHtml(item.title || 'Untitled')}</span>
            <small>${escapeHtml(meta || '')}</small>
        </button>`;
}

function _renderPdfLibraryRelatedItem(item) {
    const pct = Math.round((item.score || 0) * 100);
    const creators = formatCreators(item.creators_list || item.creators);
    const metaParts = [creators, item.year].filter(Boolean).join(' · ');
    const score = pct >= 50 ? `<span class="pdf-library-score">${pct}% match</span>` : '';
    const meta = metaParts ? `${escapeHtml(metaParts)}${score ? ' · ' + score : ''}` : score;
    return `
        <button class="pdf-library-item" onclick="openPreview('${escapeJs(item.item_key)}')">
            <span>${escapeHtml(item.title || 'Untitled')}</span>
            <small>${meta}</small>
        </button>`;
}

function renderPdfFullscreenAnnotations() {
    const list = document.getElementById('pdf-fullscreen-annotation-list');
    if (!list) return;
    const count = document.querySelector('[data-panel="annotations"] .pdf-sidebar-count');
    if (count) count.textContent = String(appState.annotations.length);

    if (appState.annotations.length === 0) {
        list.innerHTML = '<div class="annotation-empty">No annotations yet</div>';
        return;
    }

    const sortedAnnotations = [...appState.annotations].sort((a, b) => {
        const pageDiff = (a.page_index || 0) - (b.page_index || 0);
        return pageDiff || (a.annotation_id || 0) - (b.annotation_id || 0);
    });

    // Reuse renderAnnotationListItem so the inline note editor works in fullscreen too
    list.innerHTML = sortedAnnotations.map(a => renderAnnotationListItem(a)).join('');
    refreshIcons(list);

    // If a note drawer is open, focus its textarea
    if (appState.noteDrawerAnnotationId) {
        setTimeout(() => {
            const ta = document.getElementById(`ann-inline-ta-${appState.noteDrawerAnnotationId}`);
            if (ta) {
                ta.style.height = 'auto';
                ta.style.height = ta.scrollHeight + 'px';
                ta.focus();
                ta.closest('.ann-inline-editor')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
            renderNoteDrawerTags();
        }, 30);
    }
}

function updatePdfNavigatorActivePage() {
    if (!appState.pdfFullscreen) return;
    const activeOutlineIndex = appState.pdfOutlineItems.reduce((best, item, index) => {
        if (!item.pageNum || item.pageNum > appState.previewPage) return best;
        if (best === -1 || item.pageNum >= (appState.pdfOutlineItems[best]?.pageNum || 0)) return index;
        return best;
    }, -1);
    let activeOutline = null;
    document.querySelectorAll('.pdf-outline-item[data-outline-index]').forEach(btn => {
        const active = parseInt(btn.dataset.outlineIndex) === activeOutlineIndex;
        btn.classList.toggle('active', active);
        if (active) activeOutline = btn;
    });
    activeOutline?.scrollIntoView({ block: 'nearest' });
    renderPdfFullscreenLibrary();
}

function renderPdfFullscreenChat() {
    const area = document.getElementById('pdf-fullscreen-chat-messages');
    if (!area) return;
    const contextHtml = appState.previewItem
        ? `<div class="pdf-chat-context">${icon('file-text')} <span>${escapeHtml(appState.previewItem.title || 'Open document')}</span></div>`
        : '';
    if (!appState.chatMessages.length) {
        area.innerHTML = contextHtml + '<div class="pdf-sidebar-empty">No messages yet. Ask about this document.</div>';
    } else {
        area.innerHTML = contextHtml + appState.chatMessages.map(m => {
            const dur = m.role === 'assistant' && m.duration ? `<span class="message-duration">${formatDuration(m.duration / 1000)}</span>` : '';
            return `
            <div class="message-wrapper ${m.role}">
                <div class="message ${m.role}">${m.role === 'assistant' ? renderMarkdown(m.content) : escapeHtml(m.content)}</div>
                <span class="message-time">${formatTime(m.time)}${dur}</span>
            </div>`;
        }).join('');
    }
    area.scrollTop = area.scrollHeight;
    refreshIcons(area);
}

function renderPdfChatProfileSelect(models = null, activeProfile = null) {
    const select = document.getElementById('pdf-chat-model-select');
    if (!select) return;

    const profiles = models || appState.currentProfiles || [];
    const active = activeProfile ?? appState.activeProfile;
    select.innerHTML = profiles.length
        ? profiles.map(profile => {
            const name = profile.name || '';
            const label = profile.provider_label ? `${name} (${profile.provider_label})` : name;
            return `<option value="${escapeHtml(name)}" ${name === active ? 'selected' : ''}>${escapeHtml(label)}</option>`;
        }).join('')
        : '<option value="">No profiles</option>';

    select.onchange = () => activateProfile(select.value);
}

async function _applyPdfChatCreatedLinksAndHighlights(data) {
    try {
        if (Array.isArray(data.created_annotations) && data.created_annotations.length) {
            const itk = data.created_annotations[0].item_key;
            if (appState.previewItem?.item_key === itk) {
                await loadAnnotations(itk);
            }
        }
        const notesChanged = (Array.isArray(data.notes_rewritten) && data.notes_rewritten.length)
            || (Array.isArray(data.created_connections) && data.created_connections.length);
        if (notesChanged && appState.previewItem?.item_key) {
            // Reload through the same canonical loader used everywhere else notes
            // get shown (including on a fresh page load, where this reliably
            // works). It fetches fresh from the backend (which already persisted
            // everything via patch_item_notes — do NOT call
            // saveProjectNotesAndConnections here, that would push stale
            // frontend content back over what the backend just wrote), sets
            // notesScope correctly, and re-syncs noteConnections + ink lines
            // itself. A hand-rolled fetch+innerHTML here previously wrote into
            // whatever getNotesContentEl() resolved to *before* notesScope was
            // ever set to 'item' (e.g. if the user chatted without having
            // opened the Notes tab yet), landing nowhere the user could see it.
            await loadItemNotesForPreview();
        }
        if (appState.previewKind === 'pdf' && appState.pdfDoc) {
            scheduleAnnotationAnchorResolution();
        }
    } catch (err) {
        console.warn('applyPdfChatCreatedLinksAndHighlights error:', err);
    }
}

async function sendPdfFullscreenChatMessage() {
    const input = document.getElementById('pdf-fullscreen-chat-input');
    const message = input?.value.trim() || '';
    if (!message) return;

    setPdfChatHistoryVisible(false);
    input.value = '';
    const now = new Date();
    appState.chatMessages.push({ role: 'user', content: message, time: now });
    renderPdfFullscreenChat();
    renderChatMessages();
    showPdfChatTypingIndicator();
    const reqStart = Date.now();

    try {
        const profileSelect = document.getElementById('pdf-chat-model-select') || document.getElementById('chat-model-select');
        const selectedProfile = profileSelect ? profileSelect.value : '';
        const openItemKey = appState.previewItem?.item_key || '';
        const toolsEnabled = !!openItemKey;
        const res = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message,
                paragraph: appState.currentParagraph,
                candidates: appState.currentCandidates,
                suggestions: appState.currentSuggestions,
                history: appState.chatMessages.slice(-8),
                current_item_key: openItemKey,
                profile_override: selectedProfile,
                restrict_to_document: appState.pdfChatScope === 'document',
                allow_tools: toolsEnabled,
                enable_ink_links: toolsEnabled,
            }),
        });

        if (!res.ok) {
            if (res.status === 429) {
                let quotaMsg = 'Daily limit reached.';
                let buyUrl = '';
                try {
                    const errBody = JSON.parse(await res.text());
                    quotaMsg = errBody.message || quotaMsg;
                    buyUrl = errBody.buy_url || '';
                } catch {}
                handleQuotaExceeded(quotaMsg, buyUrl);
                throw new Error(quotaMsg);
            }
            const errorText = await res.text();
            throw new Error(`Server error ${res.status}: ${errorText.slice(0, 100)}`);
        }

        const data = await res.json();
        if (data.switched_to_profile) loadModels({ force: true });
        hidePdfChatTypingIndicator();
        appState.chatMessages.push({ role: 'assistant', content: data.reply, time: new Date(), duration: Date.now() - reqStart });
        renderPdfFullscreenChat();
        renderChatMessages();

        if (data.created_annotations || data.created_connections || data.notes_rewritten) {
            await _applyPdfChatCreatedLinksAndHighlights(data);
        }

        if (!appState.chatSessionId) {
            const sessionRes = await fetch('/api/chat-sessions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title: message.slice(0, 50) }),
            });
            if (sessionRes.ok) {
                const sessionData = await sessionRes.json();
                appState.chatSessionId = sessionData.session_id;
                loadChatSessions();
            }
        }
        if (appState.chatSessionId) {
            await fetch(`/api/chat-sessions/${appState.chatSessionId}/messages`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ role: 'user', content: message }),
            });
            await fetch(`/api/chat-sessions/${appState.chatSessionId}/messages`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ role: 'assistant', content: data.reply }),
            });
        }
    } catch (err) {
        hidePdfChatTypingIndicator();
        appState.chatMessages.push({ role: 'assistant', content: `Error: ${err.message}`, time: new Date() });
        renderPdfFullscreenChat();
        renderChatMessages();
    }
}

function renderAnnotationsOnPage(pageNum, annLayer, textLayer) {
    annLayer.querySelectorAll('.highlight, .underline, .comment-pin, .area-box, .draw-svg').forEach(el => el.remove());
    textLayer.querySelectorAll('.highlight, .underline, .comment-pin').forEach(el => el.remove()); // legacy cleanup

    const tw = textLayer.offsetWidth;
    const th = textLayer.offsetHeight;

    appState.annotations.filter(a => a.page_index === pageNum - 1).forEach(a => {
        try {
            const geo = JSON.parse(a.geometry_json);

            // ── Freehand draw: render as SVG path ──
            if (a.annotation_type === 'draw') {
                if (!geo.points || geo.points.length < 2) return;
                const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                svg.classList.add('draw-svg');
                const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                const d = geo.points.map(([nx, ny], i) =>
                    `${i === 0 ? 'M' : 'L'}${(nx * tw).toFixed(2)} ${(ny * th).toFixed(2)}`
                ).join(' ');
                path.setAttribute('d', d);
                path.setAttribute('stroke', a.color || '#ffff00');
                path.setAttribute('stroke-width', String(Math.max(1, (geo.lineWidth || 0.004) * tw)));
                path.setAttribute('stroke-linecap', 'round');
                path.setAttribute('stroke-linejoin', 'round');
                path.setAttribute('fill', 'none');
                path.setAttribute('pointer-events', 'stroke');
                path.dataset.annotationId = String(a.annotation_id);
                path.style.cursor = 'pointer';
                path.addEventListener('click', () => {
                    const item = document.getElementById(`ann-item-${a.annotation_id}`);
                    if (item) { item.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); item.classList.add('ann-flash'); setTimeout(() => item.classList.remove('ann-flash'), 800); }
                });
                svg.appendChild(path);
                annLayer.appendChild(svg);
                return;
            }

            const rects = geo.rects || [];
            rects.forEach(r => {
                const left = r.x * tw, top = r.y * th, width = r.width * tw, height = r.height * th;

                const div = document.createElement('div');
                if (a.annotation_type === 'area') {
                    div.className = 'area-box';
                    div.style.left = left + 'px';
                    div.style.top = top + 'px';
                    div.style.width = width + 'px';
                    div.style.height = height + 'px';
                    div.style.borderColor = a.color || appState.annotationColor;
                } else if (a.annotation_type === 'underline') {
                    div.className = 'underline';
                    div.style.left = left + 'px';
                    div.style.top = top + 'px';
                    div.style.width = width + 'px';
                    div.style.height = height + 'px';
                    div.style.borderBottomColor = a.color || appState.annotationColor;
                } else {
                    div.className = 'highlight';
                    div.style.left = left + 'px';
                    div.style.top = top + 'px';
                    div.style.width = width + 'px';
                    div.style.height = height + 'px';
                    div.style.background = a.color;
                    div.style.opacity = '0.5';
                }
                div.dataset.annotationId = a.annotation_id;
                div.addEventListener('click', () => {
                    if (a.annotation_type === 'comment') return;
                    const item = document.getElementById(`ann-item-${a.annotation_id}`);
                    if (item) { item.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); item.classList.add('ann-flash'); setTimeout(() => item.classList.remove('ann-flash'), 800); }
                });
                annLayer.appendChild(div);
            });

            if (a.annotation_type === 'comment' && rects.length) {
                const anchorRect = rects[rects.length - 1];
                const left = (anchorRect.x + anchorRect.width) * tw;
                const top = anchorRect.y * th;
                const pin = document.createElement('button');
                pin.className = 'comment-pin';
                pin.innerHTML = icon('message-square');
                pin.style.left = (left - 2) + 'px';
                pin.style.top = (top - 14) + 'px';
                pin.title = a.comment || 'Click to view note';
                pin.addEventListener('click', e => { e.stopPropagation(); showCommentPopup(a, pin); });
                annLayer.appendChild(pin);
            }
        } catch (e) { /* skip bad geometry */ }
    });
    refreshIcons(annLayer);
}

function renderAnnotationsOnImage() {
    const annLayer = document.querySelector('#image-viewer .image-annotation-layer');
    const img = document.getElementById('preview-image');
    if (!annLayer || !img) return;

    annLayer.querySelectorAll('.highlight, .underline, .comment-pin, .area-box, .draw-svg').forEach(el => el.remove());

    const tw = img.offsetWidth;
    const th = img.offsetHeight;
    if (!tw || !th) return;

    appState.annotations.forEach(a => {
        try {
            const geo = JSON.parse(a.geometry_json);

            if (a.annotation_type === 'draw') {
                if (!geo.points || geo.points.length < 2) return;
                const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                svg.classList.add('draw-svg');
                const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                const d = geo.points.map(([nx, ny], i) =>
                    `${i === 0 ? 'M' : 'L'}${(nx * tw).toFixed(2)} ${(ny * th).toFixed(2)}`
                ).join(' ');
                path.setAttribute('d', d);
                path.setAttribute('stroke', a.color || '#ffff00');
                path.setAttribute('stroke-width', String(Math.max(1, (geo.lineWidth || 0.004) * tw)));
                path.setAttribute('stroke-linecap', 'round');
                path.setAttribute('stroke-linejoin', 'round');
                path.setAttribute('fill', 'none');
                path.setAttribute('pointer-events', 'stroke');
                path.dataset.annotationId = String(a.annotation_id);
                path.style.cursor = 'pointer';
                path.addEventListener('click', () => {
                    const item = document.getElementById(`ann-item-${a.annotation_id}`);
                    if (item) { item.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); item.classList.add('ann-flash'); setTimeout(() => item.classList.remove('ann-flash'), 800); }
                });
                svg.appendChild(path);
                annLayer.appendChild(svg);
                return;
            }

            const rects = geo.rects || [];
            rects.forEach(r => {
                const left = r.x * tw, top = r.y * th, width = r.width * tw, height = r.height * th;
                const div = document.createElement('div');
                if (a.annotation_type === 'area') {
                    div.className = 'area-box';
                    div.style.left = left + 'px';
                    div.style.top = top + 'px';
                    div.style.width = width + 'px';
                    div.style.height = height + 'px';
                    div.style.borderColor = a.color || appState.annotationColor;
                } else if (a.annotation_type !== 'comment') {
                    div.className = 'highlight';
                    div.style.left = left + 'px';
                    div.style.top = top + 'px';
                    div.style.width = width + 'px';
                    div.style.height = height + 'px';
                    div.style.background = a.color;
                    div.style.opacity = '0.5';
                }
                if (a.annotation_type !== 'comment') {
                    div.dataset.annotationId = a.annotation_id;
                    div.style.pointerEvents = 'auto';
                    div.addEventListener('click', () => {
                        const item = document.getElementById(`ann-item-${a.annotation_id}`);
                        if (item) { item.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); item.classList.add('ann-flash'); setTimeout(() => item.classList.remove('ann-flash'), 800); }
                    });
                    annLayer.appendChild(div);
                }
            });
            if (a.annotation_type === 'comment' && rects.length) {
                const anchorRect = rects[rects.length - 1];
                const left = (anchorRect.x + anchorRect.width) * tw;
                const top = anchorRect.y * th;
                const pin = document.createElement('button');
                pin.className = 'comment-pin';
                pin.innerHTML = icon('message-square');
                pin.style.left = (left - 2) + 'px';
                pin.style.top = (top - 14) + 'px';
                pin.style.pointerEvents = 'auto';
                pin.title = a.comment || 'Click to view note';
                pin.addEventListener('click', e => { e.stopPropagation(); showCommentPopup(a, pin); });
                annLayer.appendChild(pin);
            }
        } catch (e) { /* skip bad geometry */ }
    });
    refreshIcons(annLayer);
}

function showCommentPopup(ann, anchor) {
    document.querySelectorAll('.comment-popup').forEach(p => p.remove());

    const popup = document.createElement('div');
    popup.className = 'comment-popup';
    popup.innerHTML = `
        <div class="comment-popup-header">
            <span class="comment-popup-label">Note · p.${ann.page_index + 1}</span>
            <button class="comment-popup-close" onclick="this.closest('.comment-popup').remove()" aria-label="Close">${icon('x')}</button>
        </div>
        ${ann.quote ? `<div class="comment-popup-quote">&ldquo;${escapeHtml(ann.quote.slice(0, 140))}${ann.quote.length > 140 ? '&hellip;' : ''}&rdquo;</div>` : ''}
        <div class="comment-popup-body">${ann.comment ? escapeHtml(ann.comment) : '<span class="comment-popup-empty">No note written yet</span>'}</div>
        <div class="comment-popup-actions">
            <button onclick="openEditComment(${ann.annotation_id}); document.querySelectorAll('.comment-popup').forEach(p=>p.remove())">${icon('pencil')} Edit</button>
        </div>
    `;

    getOverlayContainer().appendChild(popup);
    refreshIcons(popup);

    // Position near the pin, flip if off-screen
    const ar = anchor.getBoundingClientRect();
    popup.style.top = (ar.bottom + 6) + 'px';
    popup.style.left = ar.left + 'px';
    const pr = popup.getBoundingClientRect();
    if (pr.right > window.innerWidth - 8) popup.style.left = (window.innerWidth - pr.width - 8) + 'px';
    if (pr.bottom > window.innerHeight - 8) popup.style.top = (ar.top - pr.height - 6) + 'px';

    setTimeout(() => {
        document.addEventListener('click', function off(e) {
            if (!popup.contains(e.target) && e.target !== anchor) { popup.remove(); document.removeEventListener('click', off); }
        });
    }, 50);
}

const SWATCH_COLORS = ['#ffff00', '#90ee90', '#87ceeb', '#ffb6c1', '#ffa500', '#dda0dd'];

function renderAnnotationList() {
    const list = document.getElementById('annotation-list');
    if (!list) return;

    if (appState.annotations.length === 0) {
        list.innerHTML = '<div class="annotation-empty">No annotations yet</div>';
        return;
    }

    list.innerHTML = appState.annotations.map(a => renderAnnotationListItem(a)).join('');
    refreshIcons(list);
}

function renderAnnotationListItem(a) {
    const typeIcon = a.annotation_type === 'underline' ? 'underline' : a.annotation_type === 'comment' ? 'message-square' : a.annotation_type === 'area' ? 'square' : 'highlighter';
    const displayText = a.quote || a.comment || (a.annotation_type === 'area' ? 'Area selection' : '');
    const quoteDisplay = displayText ? `"${escapeHtml(displayText.slice(0, 70))}${displayText.length > 70 ? '…' : ''}"` : '';
    const tags = a.tags || [];
    const tagsHtml = tags.length
        ? `<div class="ann-tags-row">${tags.map(t => renderTagChip(t, false)).join('')}</div>`
        : '';
    const isEditing = a.annotation_id === appState.noteDrawerAnnotationId;
    const inlineEditor = isEditing ? `
    <div class="ann-inline-editor" id="ann-inline-${a.annotation_id}">
        ${a.quote ? `<div class="ann-inline-quote" style="--annotation-color:${a.color || 'var(--accent)'}">
            <span class="ann-inline-quote-bar"></span>${escapeHtml(a.quote)}</div>` : ''}
        <div class="ann-inline-editor-wrap">
            <textarea class="ann-edit-textarea ann-inline-textarea"
                id="ann-inline-ta-${a.annotation_id}"
                placeholder="Write your note… use #tag to add a theme"
                oninput="onNoteDrawerInput(event)"
                onkeydown="onNoteDrawerKeydown(event)"
                rows="4">${escapeHtml(a.comment || '')}</textarea>
            <div id="note-tag-autocomplete" class="note-tag-autocomplete hidden"></div>
            <div id="note-mention-autocomplete" class="note-tag-autocomplete note-mention-autocomplete hidden"></div>
        </div>
        <div id="ann-inline-tags" class="note-drawer-tags"></div>
        <div class="ann-sentiment-row">
            <span class="ann-sentiment-label">Sentiment</span>
            ${['pos','neu','neg'].map(s => {
                const emoji = s === 'pos' ? '😊' : s === 'neu' ? '😐' : '😟';
                const label = s === 'pos' ? 'Positive' : s === 'neu' ? 'Neutral' : 'Negative';
                const active = (appState.noteDrawerPendingSentiment === s) ? ' active' : '';
                return `<button class="ann-sentiment-btn${active}" title="${label}" onclick="setNoteDrawerSentiment('${s}')">${emoji}</button>`;
            }).join('')}
            ${appState.noteDrawerPendingSentiment ? `<button class="ann-sentiment-clear" onclick="setNoteDrawerSentiment(null)" title="Clear sentiment">✕</button>` : ''}
        </div>
        <div class="ann-inline-hint">Tip: type <span>#tag</span> to assign a theme · <span>@name</span> to cite a paper · <span>Ctrl+Enter</span> to save</div>
        <div class="ann-edit-actions">
            <button class="ann-edit-cancel" onclick="closeNoteDrawer()">${icon('x')} Cancel</button>
            <button class="ann-edit-save" onclick="saveNoteDrawer()">${icon('check')} Save</button>
        </div>
    </div>` : '';

    return `
    <div class="annotation-item${isEditing ? ' is-editing' : ''}" id="ann-item-${a.annotation_id}">
        <div class="ann-type-icon" onclick="navigateToAnnotation(${a.annotation_id})">${icon(typeIcon)}</div>
        <div class="annotation-color-dot" style="background:${a.color}" onclick="toggleAnnColorPicker(${a.annotation_id})" title="Change color"></div>
        <div class="annotation-text" onclick="navigateToAnnotation(${a.annotation_id})">
            <div class="annotation-quote">${quoteDisplay}</div>
            ${a.comment ? `<div class="annotation-comment">${escapeHtml(a.comment.slice(0, 60))}${a.comment.length > 60 ? '…' : ''}</div>` : ''}
            ${tagsHtml}
        </div>
        <div class="ann-page-label">p.${a.page_index + 1}</div>
        ${a.sentiment ? `<span class="ann-sentiment-badge" title="${a.sentiment === 'pos' ? 'Positive' : a.sentiment === 'neg' ? 'Negative' : 'Neutral'}">${a.sentiment === 'pos' ? '😊' : a.sentiment === 'neg' ? '😟' : '😐'}</span>` : ''}
        <div class="annotation-item-actions">
            <button class="ann-act-btn${isEditing ? ' active' : ''}" onclick="openNoteDrawer(${a.annotation_id})" title="Edit note" aria-label="Edit note">${icon('pencil')}</button>
            <button class="annotation-delete" data-annotation-delete-id="${a.annotation_id}" onclick="event.preventDefault();event.stopPropagation();deleteAnnotation(${a.annotation_id})" title="Delete" aria-label="Delete">${icon('x')}</button>
        </div>
    </div>
    ${inlineEditor}
    <div class="ann-color-row hidden" id="ann-colors-${a.annotation_id}">
        ${SWATCH_COLORS.map(c => `<button class="color-btn ${c === a.color ? 'active' : ''}" data-color="${c}" style="background:${c}" onclick="applyAnnotationColor(${a.annotation_id},'${c}')"></button>`).join('')}
    </div>
    `;
}

function handleAnnotationDeleteClick(event) {
    const btn = event.target.closest?.('[data-annotation-delete-id]');
    if (!btn) return;
    event.preventDefault();
    event.stopPropagation();
    const id = parseInt(btn.dataset.annotationDeleteId, 10);
    if (Number.isFinite(id)) deleteAnnotation(id);
}

function renderAnnotationListInPanel() {
    const panelBody = document.querySelector('.annotation-panel-body .annotation-list');
    if (!panelBody) return;

    if (appState.annotations.length === 0) {
        panelBody.innerHTML = '<div class="annotation-empty">No annotations yet</div>';
        return;
    }

    panelBody.innerHTML = appState.annotations.map(a => renderAnnotationListItem(a)).join('');
    refreshIcons(panelBody);
}

function handleEditKeydown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const id = parseInt(e.target.closest('.ann-edit-row').id.replace('ann-edit-', ''));
        saveInlineEdit(id);
    }
    if (e.key === 'Escape') {
        cancelInlineEdit();
    }
}

function startInlineEdit(id) {
    appState.editingAnnotationId = id;
    renderAnnotations();
}

async function saveInlineEdit(id) {
    const ann = appState.annotations.find(a => a.annotation_id === id);
    if (!ann) return;

    const ta = document.querySelector(`#ann-edit-${id} .ann-edit-textarea`);
    if (!ta) return;

    const newComment = ta.value.trim();
    if (newComment === ann.comment) {
        cancelInlineEdit();
        return;
    }

    try {
        await patchAnnotation({ ...ann, comment: newComment });
        pushAnnotationUndo({
            type: 'update',
            itemKey: ann.item_key,
            before: { ...ann },
            after: { ...ann, comment: newComment },
        });
        appState.editingAnnotationId = null;
        if (appState.previewItem) loadAnnotations(appState.previewItem.item_key);
    } catch (err) {
        console.error('Inline edit save error:', err);
    }
}

function cancelInlineEdit() {
    appState.editingAnnotationId = null;
    renderAnnotations();
}

async function openEditComment(id) {
    const ann = appState.annotations.find(a => a.annotation_id === id);
    if (!ann) return;
    const newComment = await showCommentDialog(ann.comment || '');
    if (newComment === null) return;
    try {
        await patchAnnotation({ ...ann, comment: newComment });
        pushAnnotationUndo({
            type: 'update',
            itemKey: ann.item_key,
            before: { ...ann },
            after: { ...ann, comment: newComment },
        });
        if (appState.previewItem) loadAnnotations(appState.previewItem.item_key);
    } catch (err) { console.error('Comment patch error:', err); }
}

function navigateToAnnotation(id) {
    const ann = appState.annotations.find(a => a.annotation_id === id);
    if (!ann) return;
    if (appState.previewKind === 'pdf') scrollToPage(ann.page_index + 1, true);
    const overlay = document.querySelector(`[data-annotation-id="${id}"]`);
    if (overlay) { overlay.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
    // No drawn overlay yet (quote-only annotation whose anchor could not be
    // resolved): fall back to the text-layer spotlight so the click still
    // lands on the quoted passage.
    if (appState.previewKind === 'pdf' && ann.quote && appState.pdfDoc) {
        appState.spotlightText = ann.quote.trim();
        jumpToSpotlightPage();
    }
}

function toggleAnnColorPicker(id) {
    document.querySelectorAll('.ann-color-row').forEach(r => {
        if (r.id !== `ann-colors-${id}`) r.classList.add('hidden');
    });
    document.getElementById(`ann-colors-${id}`)?.classList.toggle('hidden');
}

async function applyAnnotationColor(id, newColor) {
    const ann = appState.annotations.find(a => a.annotation_id === id);
    if (!ann) return;
    try {
        await patchAnnotation({ ...ann, color: newColor });
        pushAnnotationUndo({
            type: 'update',
            itemKey: ann.item_key,
            before: { ...ann },
            after: { ...ann, color: newColor },
        });
        if (appState.previewItem) loadAnnotations(appState.previewItem.item_key);
    } catch (err) { console.error('Color patch error:', err); }
}

async function openEditComment(id) {
    const ann = appState.annotations.find(a => a.annotation_id === id);
    if (!ann) return;
    const newComment = await showCommentDialog(ann.comment || '');
    if (newComment === null) return;
    try {
        await patchAnnotation({ ...ann, comment: newComment });
        pushAnnotationUndo({
            type: 'update',
            itemKey: ann.item_key,
            before: { ...ann },
            after: { ...ann, comment: newComment },
        });
        if (appState.previewItem) loadAnnotations(appState.previewItem.item_key);
    } catch (err) { console.error('Comment patch error:', err); }
}

async function deleteAnnotation(id) {
    const ann = appState.annotations.find(a => a.annotation_id === id);
    try {
        await deleteAnnotationById(id);
        if (appState.editingAnnotationId === id) {
            appState.editingAnnotationId = null;
        }
        if (appState.noteDrawerAnnotationId === id) {
            closeNoteDrawer();
        }
        if (ann) {
            pushAnnotationUndo({
                type: 'delete',
                itemKey: ann.item_key,
                annotation: { ...ann },
            });
        }
        appState.annotations = appState.annotations.filter(a => a.annotation_id !== id);
        renderAnnotations();
        if (appState.previewItem) await loadAnnotations(appState.previewItem.item_key);
        if (appState.annotationsViewItems?.length) {
            appState.annotationsViewItems = appState.annotationsViewItems.filter(a => a.annotation_id !== id);
            appState.annotationsViewSelected?.delete(id);
            if (appState.activeCenterView === 'annotations') renderAnnotationsView();
        }
        showSaveConfirmation('Annotation deleted');
    } catch (err) {
        console.error('Delete annotation error:', err);
        showSaveConfirmation('Delete failed');
    }
}

function initAnnotationListResize() {
    const list = document.getElementById('annotation-list');
    if (!list) return;

    const handle = document.createElement('div');
    handle.className = 'annotation-list-resize-handle';
    list.parentNode.insertBefore(handle, list);

    let dragging = false, startY = 0, startH = 0;

    handle.addEventListener('mousedown', e => {
        dragging = true;
        startY = e.clientY;
        startH = list.offsetHeight || 150;
        document.body.style.cursor = 'row-resize';
        document.body.style.userSelect = 'none';
        e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
        if (!dragging) return;
        const newH = Math.max(48, Math.min(520, startH + (startY - e.clientY)));
        list.style.height = newH + 'px';
        list.style.maxHeight = newH + 'px';
    });
    document.addEventListener('mouseup', () => {
        if (dragging) { dragging = false; document.body.style.cursor = ''; document.body.style.userSelect = ''; }
    });
}

function initAnnotationPanelToggle() {
    // handled by #preview-fullscreen-sidebar-toggle in both standard and fullscreen modes
}

function toggleAnnotationPanel() {
    const panel = document.getElementById('annotation-panel');
    const bottomList = document.getElementById('annotation-list');
    if (!panel) return;

    panel.classList.toggle('hidden', !appState.annotationPanelOpen);
    updatePdfFullscreenSidebarButton();

    if (bottomList) {
        bottomList.classList.add('hidden');
    }

    if (appState.annotationPanelOpen && appState.previewItem) {
        renderAnnotationPanel();
    }
}

function renderAnnotationPanel() {
    const panel = document.getElementById('annotation-panel');
    if (!panel) return;
    if (!['annotations', 'notes'].includes(appState.annotationPanelTab)) {
        appState.annotationPanelTab = 'annotations';
    }

    panel.innerHTML = `
        <div class="annotation-panel-header">
            <h4>${appState.annotationPanelTab === 'notes' ? 'Notes' : 'Annotations'}</h4>
            <button class="annotation-panel-close" onclick="closeAnnotationPanel()" aria-label="Close annotation panel">${icon('x')}</button>
        </div>
        <div class="annotation-panel-tabs" role="tablist" aria-label="Document side panel">
            <button class="annotation-panel-tab ${appState.annotationPanelTab === 'annotations' ? 'active' : ''}" role="tab" aria-selected="${appState.annotationPanelTab === 'annotations'}" onclick="setAnnotationPanelTab('annotations')">
                ${icon('bookmark')} <span>Annotations</span>
                ${appState.annotations.length ? `<small>${appState.annotations.length}</small>` : ''}
            </button>
            <button class="annotation-panel-tab ${appState.annotationPanelTab === 'notes' ? 'active' : ''}" role="tab" aria-selected="${appState.annotationPanelTab === 'notes'}" onclick="setAnnotationPanelTab('notes')">
                ${icon('notebook-tabs')} <span>Notes</span>
                ${appState.noteConnections?.length ? `<small>${appState.noteConnections.length}</small>` : ''}
            </button>
        </div>
        <div class="annotation-panel-body">
            <div class="annotation-panel-tab-panel ${appState.annotationPanelTab === 'annotations' ? 'active' : ''}" data-panel="annotations">
                <div id="annotation-list" class="annotation-list"></div>
            </div>
            <div class="annotation-panel-tab-panel annotation-panel-notes ${appState.annotationPanelTab === 'notes' ? 'active' : ''}" data-panel="notes">
                <div id="item-notes-viewer" class="project-notes-viewer item-notes-viewer" data-notes-scope="item">
                    ${renderItemNotesEditor()}
                </div>
            </div>
        </div>
    `;
    refreshIcons(panel);
    if (appState.annotationPanelTab === 'notes') {
        loadItemNotesForPreview();
    } else {
        renderAnnotationListInPanel();
    }
}

function setAnnotationPanelTab(tab) {
    if (!['annotations', 'notes'].includes(tab)) tab = 'annotations';
    if (appState.annotationPanelTab === 'notes' && tab !== 'notes' && appState.notesScope === 'item') {
        clearTimeout(_notesSaveTimer);
        saveProjectNotes();
        closeInkConnectionsForInactiveProjectView();
        appState.notesScope = 'project';
        appState.activeNotesItemKey = '';
    }
    appState.annotationPanelTab = tab;
    renderAnnotationPanel();
    if (tab === 'notes') {
        document.getElementById('item-notes-content')?.focus();
    }
}

function closeAnnotationPanel() {
    if (appState.annotationPanelTab === 'notes' && appState.notesScope === 'item') {
        clearTimeout(_notesSaveTimer);
        saveProjectNotes();
        closeInkConnectionsForInactiveProjectView();
        appState.notesScope = 'project';
        appState.activeNotesItemKey = '';
    }
    appState.annotationPanelOpen = false;
    const panel = document.getElementById('annotation-panel');
    if (panel) {
        panel.classList.add('hidden');
        panel.innerHTML = '';
    }
    updatePdfFullscreenSidebarButton();
}
