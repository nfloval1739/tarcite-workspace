/* ── TarCite Workspace - Citation Suggestions and Chat ─────────────────── */

/* ── Citation Form ─────────────────────────────────────────────────────────── */

function initCitationForm() {
    document.getElementById('suggest-citations-btn').addEventListener('click', suggestCitations);
    const topKSlider = document.getElementById('citation-top-k');
    const topKValue = document.getElementById('citation-top-k-val');
    if (topKSlider && topKValue) {
        topKValue.value = topKSlider.value;
        topKSlider.addEventListener('input', () => {
            topKValue.value = topKSlider.value;
        });
        topKValue.addEventListener('change', () => {
            const v = Math.min(100, Math.max(1, parseInt(topKValue.value) || 1));
            topKValue.value = v;
            topKSlider.value = v;
        });
    }
}

async function suggestCitations() {
    const paragraph = document.getElementById('citation-paragraph').value.trim();
    if (!paragraph) return alert('Please enter a paragraph.');

    appState.currentParagraph = paragraph;
    const topK = parseInt(document.getElementById('citation-top-k').value) || 50;
    const sourceDir = document.getElementById('citation-dir-filter').value;

    const progressEl = document.getElementById('citation-progress');
    const cpFill     = document.getElementById('cp-fill');
    const cpStep     = document.getElementById('cp-step');
    const cpPct      = document.getElementById('cp-pct');
    const resultsEl  = document.getElementById('citation-results');

    progressEl.classList.remove('hidden');
    cpFill.style.width = '0%';
    cpStep.textContent  = 'Starting…';
    cpPct.textContent   = '0%';
    startCitationProgressMessages('cp-message');
    resultsEl.innerHTML = '';

    const startTime = Date.now();

    try {
        const res = await fetch('/api/suggest-citations/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paragraph, top_k: topK, source_dir: sourceDir || null }),
        });

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                try {
                    const data = JSON.parse(line.slice(6));
                    if (data.type === 'progress') {
                        const pct = Math.round(data.pct || 0);
                        cpFill.style.width = `${pct}%`;
                        cpStep.textContent = data.step || '';
                        cpPct.textContent  = `${pct}%`;
                    } else if (data.type === 'result') {
                        progressEl.classList.add('hidden');
                        stopCitationProgressMessages('cp-message');
                        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                        setCitationContext(data.data);
                        renderCitationResults(data.data, elapsed);
                        loadSuggestionHistory({ force: true });
                    } else if (data.type === 'citation_counts') {
                        applyCitationCountUpdates(data.counts || []);
                    } else if (data.type === 'profile_switched') {
                        loadModels({ force: true });
                    } else if (data.type === 'error') {
                        progressEl.classList.add('hidden');
                        stopCitationProgressMessages('cp-message');
                        if (data.quota_exceeded) {
                            handleQuotaExceeded(data.message, data.buy_url);
                        }
                        resultsEl.innerHTML = `<div class="suggestion-card" style="color:var(--error)">${escapeHtml(data.message)}</div>`;
                    }
                } catch (e) { /* skip parse errors */ }
            }
        }
        if (!progressEl.classList.contains('hidden')) {
            stopCitationProgressMessages('cp-message');
        }
    } catch (err) {
        progressEl.classList.add('hidden');
        stopCitationProgressMessages('cp-message');
        resultsEl.innerHTML = `<div class="suggestion-card" style="color:var(--error)">Error: ${escapeHtml(err.message)}</div>`;
    }
}

const CITATION_PROGRESS_MESSAGES = [
    'Takes your coffee, speeds up local AI dependence with your machine.',
    'Local AI is thinking through your library one source at a time.',
    'Good citations are found by patience, not panic.',
    'Your machine is reading before it writes.',
    'The best reference is the one that truly supports the sentence.',
    'Like a tarsier in the dark — judging you silently until the right citation appears.',
    'Searching wide first, choosing carefully after.',
    'A useful citation earns its place in the paragraph.',
    'The library is being asked a focused question.',
    'Local models work hard because the work stays with you.',
    'A slower local run can still be the more private run.',
    'Evidence first, confidence second, citation last.',
    'The tarsier cannot move its eyes, so it rotates its whole head 180°. The model is basically doing that with your paragraph right now.',
    'The model is comparing claims against source text.',
    'Small models need clear context and a little time.',
    'A good match is better than a fast guess.',
    'Your sources are being sorted by relevance, not by noise.',
    'Tarsius: tiny, nocturnal, and judging every source in your library with those enormous unblinking eyes.',
    'The answer is being grounded before it is formatted.',
    'Citation quality improves when the machine has room to reason.',
    'Retrieval is gathering candidates; judgment comes next.',
    'A careful citation saves editing later.',
    'The local engine is limited by CPU, memory, and patience.',
    'Academic writing rewards exact support.',
    'A tarsier waits completely still, then leaps 40x its body length. Your citations are loading with similar dramatic energy.',
    'The model is looking for evidence, not decoration.',
    'If this feels slow, the machine is carrying the whole task locally.',
    'Source selection is where accuracy begins.',
    'A citation should strengthen the claim it follows.',
    'The paragraph is being mapped to your indexed library.',
    'Good retrieval narrows the search before generation starts.',
    'The tarsier has the largest eye-to-body ratio of any mammal. It sees everything. It judges everything. Including your bibliography.',
    'The model is balancing relevance, coverage, and confidence.',
    'Strong citations connect directly to the sentence.',
    'Your local library is doing the heavy lifting.',
    'This step works best with focused paragraphs.',
    'A short wait can prevent a weak reference.',
    'The tarsier does not rush its hunt. It stares. It waits. It wins. You are now experiencing this process firsthand.',
    'The model is checking which sources actually belong here.',
    'Evidence is being weighed against your wording.',
    'Local inference is private, but not always instant.',
    'The best suggestion is usually the most defensible one.',
    'The system is reducing many sources into a few useful choices.',
    'Relevance beats popularity when citing a claim.',
    'The citation list is being shaped, not merely filled.',
    'The tarsier holds perfectly still before it strikes. This loading screen is basically the same thing, but for citations.',
    'The model is reading snippets with your paragraph in mind.',
    'The strongest source should explain why it was chosen.',
    'A good recommendation includes a reason you can inspect.',
    'Your indexed text is being searched before the AI speaks.',
    'Careful citation is part retrieval and part judgment.',
    'The local model may be warming up its weights.',
    'If the first local run is slow, later runs may be faster.',
    'Context windows are finite; focused inputs help.',
    'The system is trying to avoid citation padding.',
    'A useful source answers the paragraph, not just the keywords.',
    'Precision now means fewer corrections later.',
    'Tarsius rotates its head 180° because its eyes are literally too big to move. Relatable energy when searching through 200 sources.',
    'The model is turning candidate evidence into citation suggestions.',
    'Local AI works best when the task is scoped clearly.',
    'Quality citation is quiet, specific, and defensible.',
    'The machine is matching meaning, not only words.',
    'The run is still alive while progress and source checks continue.',
    'Good scholarship is patient with evidence.',
    'The tarsier thrives by seeing what others miss in the dark. A well-cited argument does the same — and also makes reviewers less grumpy.',
];

let citationProgressMessageTimer = null;
let citationProgressMessageIndex = 0;

function startCitationProgressMessages(elementId = 'cp-message') {
    stopCitationProgressMessages();
    const el = document.getElementById(elementId);
    if (!el) return;
    citationProgressMessageIndex = 0;
    el.textContent = CITATION_PROGRESS_MESSAGES[citationProgressMessageIndex];
    citationProgressMessageTimer = setInterval(() => {
        citationProgressMessageIndex = (citationProgressMessageIndex + 1) % CITATION_PROGRESS_MESSAGES.length;
        el.textContent = CITATION_PROGRESS_MESSAGES[citationProgressMessageIndex];
    }, 5000);
}

function stopCitationProgressMessages(elementId = 'cp-message') {
    if (citationProgressMessageTimer) {
        clearInterval(citationProgressMessageTimer);
        citationProgressMessageTimer = null;
    }
    const el = document.getElementById(elementId);
    if (el) el.textContent = '';
}

function normalizeSuggestion(suggestion) {
    const normalized = { ...suggestion };
    if (!Array.isArray(normalized.evidence_points)) {
        if (normalized.evidence_points_json) {
            try {
                normalized.evidence_points = JSON.parse(normalized.evidence_points_json);
            } catch {
                normalized.evidence_points = [];
            }
        } else {
            normalized.evidence_points = [];
        }
    }
    normalized.citation_count = normalizeCitationCount(normalized.citation_count);
    return normalized;
}

function normalizeCitationCount(value) {
    const count = Number(value);
    return Number.isFinite(count) && count > 0 ? Math.round(count) : 0;
}

function formatCitationCount(value) {
    return normalizeCitationCount(value).toLocaleString();
}

function renderCitationCountBadge(item) {
    return `<span class="citation-count-badge" title="Crossref cited-by count">Cited ${formatCitationCount(item?.citation_count)}</span>`;
}

function setCitationContext(data) {
    if (!data) return;
    if (typeof data.paragraph === 'string') {
        appState.currentParagraph = data.paragraph;
    }
    if (Array.isArray(data.candidates)) {
        appState.currentCandidates = data.candidates;
    }
    if (Array.isArray(data.suggestions)) {
        appState.currentSuggestions = data.suggestions.map(normalizeSuggestion);
    }
    if (data.run_id) {
        appState.currentRunId = data.run_id;
    }
}

function renderCitationResults(data, elapsedSeconds) {
    setCitationContext(data);
    const resultsEl = document.getElementById('citation-results');
    const suggestions = (data.suggestions || []).map(normalizeSuggestion);

    const timingHtml = elapsedSeconds
        ? `<div class="processing-time">${icon('clock')} Processed in ${formatDuration(elapsedSeconds)} &mdash; ${suggestions.length} suggestion${suggestions.length !== 1 ? 's' : ''}</div>`
        : '';

    if (suggestions.length === 0) {
        resultsEl.innerHTML = timingHtml + '<div class="suggestion-card">No relevant sources found.</div>';
        return;
    }

    resultsEl.innerHTML = timingHtml + suggestions.map((s, i) => `
        <div class="suggestion-card" data-item-key="${s.item_key}">
            <div class="suggestion-header">
                <div class="suggestion-title">${escapeHtml(s.title)}</div>
                <div class="suggestion-badges">
                    ${renderCitationCountBadge(s)}
                    <span class="confidence-badge ${(s.confidence || 'Low').toLowerCase()}">${escapeHtml(s.confidence || 'Low')}</span>
                    <div class="feedback-row">
                        <button class="feedback-btn thumb-up" onclick="submitFeedback('${escapeJs(s.item_key)}', 'thumb_up', this)" title="Helpful suggestion">${icon('thumbs-up')}</button>
                        <button class="feedback-btn thumb-down" onclick="submitFeedback('${escapeJs(s.item_key)}', 'thumb_down', this)" title="Not helpful">${icon('thumbs-down')}</button>
                    </div>
                </div>
            </div>
            <div class="suggestion-citation">${escapeHtml(s.inline_citation)}</div>
            <div class="suggestion-reason">${escapeHtml(s.reason)}</div>
            ${(s.evidence_points || []).map((e, ei) => `
                <div class="suggestion-evidence">
                    <span class="evidence-body">${escapeHtml(e)}</span>
                    <div class="evidence-actions">
                        <button class="evidence-spotlight-btn" onclick="spotlightEvidence('${escapeJs(s.item_key)}', ${i}, ${ei})" title="Locate in PDF" aria-label="Locate in PDF">${icon('target')}</button>
                        <button class="evidence-save-btn" onclick="saveEvidenceAsAnnotation('${escapeJs(s.item_key)}', ${i}, ${ei})" title="Save as highlight annotation" aria-label="Save as highlight annotation">${icon('bookmark-plus')}</button>
                    </div>
                </div>
            `).join('')}
            <button class="ref-toggle" onclick="toggleRef(${i})">
                <span id="ref-arrow-${i}" class="ref-arrow">${icon('chevron-right')}</span> Full Reference
            </button>
            <div class="ref-block" id="ref-${i}">
                <div class="ref-text">${renderMarkdown(s.full_reference || '')}</div>
                <div class="ref-actions">
                    <button class="btn-icon-copy" onclick="copyFullReference(${i})" title="Copy reference">
                        ${icon('copy')}
                    </button>
                </div>
            </div>
            <div class="suggestion-actions">
                <button onclick="copyInlineCitation('${escapeJs(s.inline_citation)}')">Copy Inline</button>
                <button onclick="previewOnly('${escapeJs(s.item_key)}')">Preview</button>
            </div>
        </div>
    `).join('');

    if (data.warnings && data.warnings.length > 0) {
        resultsEl.innerHTML += data.warnings.map(w =>
            `<div class="suggestion-card" style="border-color:var(--warning)"><div style="color:var(--warning);font-size:12px">${escapeHtml(w)}</div></div>`
        ).join('');
    }
    refreshIcons(resultsEl);
}

async function submitFeedback(itemKey, feedbackType, btnEl) {
    const runId = appState.currentRunId;
    if (!runId) return;

    const card = btnEl.closest('.suggestion-card');
    if (!card) return;

    const isAlreadyActive = btnEl.classList.contains('active');

    if (isAlreadyActive) {
        try {
            await fetch('/api/suggestion-feedback', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ run_id: runId, item_key: itemKey, feedback_type: 'none' }),
            });
        } catch (e) { /* ignore */ }
        btnEl.classList.remove('active');
        return;
    }

    const body = { run_id: runId, item_key: itemKey, feedback_type: feedbackType };

    try {
        const resp = await fetch('/api/suggestion-feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!resp.ok) return;

        const row = btnEl.closest('.feedback-row');
        row.querySelectorAll('.feedback-btn').forEach(b => b.classList.remove('active'));
        btnEl.classList.add('active');
    } catch (e) {
        console.error('Feedback error:', e);
    }
}

function applyCitationCountUpdates(counts) {
    if (!Array.isArray(counts) || counts.length === 0) return;
    for (const update of counts) {
        const itemKey = update.item_key || '';
        if (!itemKey) continue;
        const count = normalizeCitationCount(update.citation_count);
        for (const suggestion of appState.currentSuggestions || []) {
            if (suggestion.item_key === itemKey) {
                suggestion.citation_count = count;
                suggestion.citation_count_updated_at = update.citation_count_updated_at || '';
            }
        }
        for (const candidate of appState.currentCandidates || []) {
            if (candidate.item_key === itemKey) {
                candidate.citation_count = count;
                candidate.citation_count_updated_at = update.citation_count_updated_at || '';
            }
        }
        document.querySelectorAll('.suggestion-card').forEach(card => {
            if (card.dataset.itemKey !== itemKey) return;
            const badge = card.querySelector('.citation-count-badge');
            if (badge) badge.outerHTML = renderCitationCountBadge({ citation_count: count });
        });
    }
}

function copyInlineCitation(text) { navigator.clipboard.writeText(text); }
function copyFullReference(idx) {
    const sug = appState.currentSuggestions[idx];
    if (!sug) return;
    navigator.clipboard.writeText((sug.full_reference || '').replace(/\*/g, ''));
}
function toggleRef(idx) {
    const block = document.getElementById(`ref-${idx}`);
    const arrow = document.getElementById(`ref-arrow-${idx}`);
    if (!block || !arrow) return;
    const isOpen = block.classList.toggle('open');
    arrow.innerHTML = icon(isOpen ? 'chevron-down' : 'chevron-right');
    refreshIcons(arrow);
}
function renderMarkdown(text) {
    let s = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    // Zettelkasten wikilinks [[Note Title]] → clickable links. Run before
    // inline formatting so the title text is styled like surrounding prose.
    // The captured title is already HTML-escaped by the lines above.
    s = s.replace(/\[\[([^\[\]\n]+)\]\]/g, '<a class="wikilink" data-note-title="$1">$1</a>');
    // Headers → bold block
    s = s.replace(/^#{1,6} (.+)$/gm, '<strong class="md-heading">$1</strong>');
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__(.+?)__/g, '<strong>$1</strong>');
    s = s.replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, '<em>$1</em>');
    s = s.replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, '<em>$1</em>');
    s = s.replace(/`([^`]+)`/g, '<code class="md-code">$1</code>');
    s = s.replace(/^[\-\*]\s+(.+)$/gm, '<li>$1</li>');
    s = s.replace(/(<li>.*<\/li>)/s, '<ul style="padding-left:1.2em;margin:6px 0;">$1</ul>');
    s = s.replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>');
    s = s.replace(/\n/g, '<br>');
    return s;
}

function previewOnly(itemKey) {
    appState.spotlightText = null;
    openPreview(itemKey);
}

async function spotlightEvidence(itemKey, suggIdx, evIdx) {
    const sug = appState.currentSuggestions[suggIdx];
    if (!sug) return;
    const text = (sug.evidence_points || [])[evIdx] || '';
    if (!text.trim()) { previewOnly(itemKey); return; }
    await doSpotlight(itemKey, text);
}

async function saveEvidenceAsAnnotation(itemKey, suggIdx, evIdx) {
    const sug = appState.currentSuggestions[suggIdx];
    if (!sug) return;
    const text = (sug.evidence_points || [])[evIdx] || '';
    if (!text.trim()) return;

    // Spotlight first to land on the right page and highlight spans
    await doSpotlight(itemKey, text);

    // Wait for page to render and spotlight spans to appear
    await new Promise(r => setTimeout(r, 700));

    const item = appState.previewItem;
    if (!item) return;

    const pageDiv = document.getElementById(`pdf-page-${appState.previewPage}`);
    const textLayerEl = pageDiv?.querySelector('.text-layer');
    if (!textLayerEl) {
        showSaveConfirmation('Could not locate evidence in PDF');
        return;
    }

    // Get geometry from spotlight-highlighted spans on the page
    const matchedSpans = findTextLayerMatchSpans(text, textLayerEl);
    let geometry = null;
    if (matchedSpans.length > 0) {
        geometry = getGeometryFromElements(matchedSpans, textLayerEl);
    }

    // Fallback to PDF text content matching
    if (!geometry) {
        geometry = await getPdfTextMatchGeometry(text, appState.previewPage);
    }

    if (!geometry) {
        showSaveConfirmation('Could not locate evidence in PDF');
        return;
    }

    try {
        const annotationData = {
            item_key: item.item_key,
            file_id: item.files?.[0]?.file_id,
            page_index: appState.previewPage - 1,
            annotation_type: 'highlight',
            color: '#ffd700',
            comment: `Evidence from: ${escapeHtml(sug.title || sug.inline_citation || '')}`,
            quote: text.slice(0, 500),
            geometry_json: JSON.stringify(geometry),
        };
        const created = await createAnnotationForItem(item.item_key, annotationData);
        pushAnnotationUndo({
            type: 'create',
            itemKey: item.item_key,
            annotation: { ...annotationData, annotation_id: created.annotation_id },
        });
        if (!appState.annotationPanelOpen) {
            appState.annotationPanelOpen = true;
            toggleAnnotationPanel();
        }
        loadAnnotations(item.item_key);
        showSaveConfirmation('Saved as highlight');
    } catch (err) {
        console.error('Save annotation error:', err);
    }
}

function showSaveConfirmation(message = 'Saved as highlight') {
    const toast = document.createElement('div');
    toast.className = 'save-toast';
    toast.textContent = message;
    (getFullscreenElement() || document.body).appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('visible'));
    setTimeout(() => { toast.classList.remove('visible'); setTimeout(() => toast.remove(), 300); }, 2000);
}

async function spotlightSuggestion(itemKey, suggIdx) {
    const sug = appState.currentSuggestions[suggIdx];
    if (!sug) return;
    const ep = sug.evidence_points || [];
    const text = ep.length > 0 ? ep[0] : (sug.reason || '');
    if (!text.trim()) { previewOnly(itemKey); return; }
    await doSpotlight(itemKey, text);
}

async function doSpotlight(itemKey, text) {
    appState.spotlightText = text.trim();
    appState.spotlightSearchPending = true;

    await openPreview(itemKey);

    appState.spotlightSearchPending = false;
    await jumpToSpotlightPage();
}

async function jumpToSpotlightPage() {
    const searchText = appState.spotlightText;
    if (!searchText || !appState.previewItem || typeof pdfjsLib === 'undefined') return;

    const itemKey = appState.previewItem.item_key;
    const keywords = searchText.toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 4);

    if (keywords.length === 0) {
        const tl = document.querySelector(`#pdf-page-${appState.previewPage} .text-layer`);
        if (tl) highlightSpotlightInTextLayer(searchText, tl);
        return;
    }

    try {
        // Reuse cached PDF document
        const pdf = appState.pdfDoc || await (async () => {
            const t = pdfjsLib.getDocument(`/api/pdf/${itemKey}`);
            return t.promise;
        })();
        const total = pdf.numPages;
        const threshold = Math.ceil(keywords.length * 0.65);
        let bestPage = appState.previewPage, bestScore = 0;

        for (let p = 1; p <= Math.min(total, 200); p++) {
            const page = await pdf.getPage(p);
            const tc = await page.getTextContent();
            const pageText = tc.items.map(it => it.str).join(' ').toLowerCase();
            let score = 0;
            for (const kw of keywords) { if (pageText.includes(kw)) score++; }
            if (score > bestScore) { bestScore = score; bestPage = p; }
            if (bestScore >= threshold && p > 1) break;
        }

        if (bestPage !== appState.previewPage) {
            goToPdfPage(bestPage, true);
            // Wait for the page to render then highlight
            setTimeout(() => {
                const tl = document.querySelector(`#pdf-page-${bestPage} .text-layer`);
                if (tl) highlightSpotlightInTextLayer(searchText, tl);
            }, 600);
        } else {
            const tl = document.querySelector(`#pdf-page-${bestPage} .text-layer`);
            if (tl) highlightSpotlightInTextLayer(searchText, tl);
        }
    } catch (err) {
        console.error('Spotlight page search error:', err);
    }
}

function highlightSpotlightInTextLayer(searchText, textLayerEl) {
    const textLayer = textLayerEl || document.querySelector('.pdf-page .text-layer');
    if (!textLayer || !searchText) return;

    textLayer.querySelectorAll('.spotlight-kw').forEach(el => el.classList.remove('spotlight-kw'));

    const matchedSpans = findTextLayerMatchSpans(searchText, textLayer);
    if (matchedSpans.length === 0) return;

    matchedSpans.forEach(span => span.classList.add('spotlight-kw'));

    const firstMatch = matchedSpans[0];
    if (firstMatch) firstMatch.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/* ── Chat ──────────────────────────────────────────────────────────────────── */

function initChatForm() {
    document.getElementById('chat-send').addEventListener('click', sendChatMessage);
    const chatInput = document.getElementById('chat-input');
    chatInput.addEventListener('input', () => checkChatMentionAutocomplete(chatInput));
    chatInput.addEventListener('keydown', e => {
        const box = document.getElementById('chat-mention-autocomplete');
        const menuOpen = box && !box.classList.contains('hidden');
        if (menuOpen) {
            if (e.key === 'ArrowDown') { e.preventDefault(); moveChatMentionSelection(1); return; }
            if (e.key === 'ArrowUp')   { e.preventDefault(); moveChatMentionSelection(-1); return; }
            if (e.key === 'Escape')    { e.preventDefault(); hideChatMentionAutocomplete(); return; }
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                const focused = box.querySelector('.chat-mention-item.focused');
                if (focused) { focused.click(); return; }
            }
        }
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }
    });
    const newChatButton = document.getElementById('chat-new');
    if (newChatButton) {
        newChatButton.addEventListener('click', startNewChatSession);
    }
    const historyToggle = document.getElementById('chat-history-toggle');
    if (historyToggle) {
        historyToggle.addEventListener('click', toggleChatHistory);
    }
    const profileSelect = document.getElementById('chat-model-select');
    if (profileSelect) {
        profileSelect.addEventListener('change', () => activateProfile(profileSelect.value));
    }
    setChatHistoryVisible(false);
}

async function _applyChatCreatedLinksAndHighlights(data) {
    try {
        if (Array.isArray(data.created_annotations) && data.created_annotations.length) {
            if (appState.previewItem?.item_key && appState.previewItem.item_key === data.created_annotations[0].item_key) {
                await loadAnnotations(appState.previewItem.item_key);
            }
        }
        const notesChanged = (Array.isArray(data.notes_rewritten) && data.notes_rewritten.length)
            || (Array.isArray(data.created_connections) && data.created_connections.length);
        if (notesChanged && appState.previewItem?.item_key && typeof loadItemNotesForPreview === 'function') {
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
            // The input listener is delegated at the container level via
            // oninput="onNotesInput()" in renderItemNotesEditor(), so per-child
            // listeners aren't needed here either.
            await loadItemNotesForPreview();
        }
        if (appState.previewKind === 'pdf' && appState.pdfDoc && typeof scheduleAnnotationAnchorResolution === 'function') {
            scheduleAnnotationAnchorResolution();
        }
    } catch (err) {
        console.warn('applyChatCreatedLinksAndHighlights error:', err);
    }
}

async function sendChatMessage() {
    const input = document.getElementById('chat-input');
    const message = input.value.trim();
    if (!message) return;

    // Merge @-mentioned papers into suggestions
    const mentionedSuggestions = appState.chatMentionedItems.map(m => ({ item_key: m.item_key }));
    const allSuggestions = [...appState.currentSuggestions];
    mentionedSuggestions.forEach(ms => {
        if (!allSuggestions.some(s => s.item_key === ms.item_key)) allSuggestions.push(ms);
    });

    setChatHistoryVisible(false);
    input.value = '';
    appState.chatMentionedItems = [];
    renderChatMentionChips();
    const now = new Date();
    appState.chatMessages.push({ role: 'user', content: message, time: now });
    renderChatMessages();
    showTypingIndicator();

    const profileSelect = document.getElementById('chat-model-select');
    const selectedProfile = profileSelect ? profileSelect.value : '';
    const reqStart = Date.now();

    try {
        const openItemKey = appState.previewItem?.item_key || '';
        const toolsEnabled = !!openItemKey;
        const res = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message,
                paragraph: appState.currentParagraph,
                candidates: appState.currentCandidates,
                suggestions: allSuggestions,
                history: appState.chatMessages.slice(-8),
                current_item_key: openItemKey,
                profile_override: selectedProfile,
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
        hideTypingIndicator();
        const replyTime = new Date();
        appState.chatMessages.push({ role: 'assistant', content: data.reply, time: replyTime, duration: Date.now() - reqStart });
        renderChatMessages();

        if (data.created_annotations || data.created_connections || data.notes_rewritten) {
            await _applyChatCreatedLinksAndHighlights(data);
        }

        if (!appState.chatSessionId) {
            const sessionRes = await fetch('/api/chat-sessions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title: message.slice(0, 50) }),
            });
            if (!sessionRes.ok) {
                throw new Error(`Could not save chat session (${sessionRes.status})`);
            }
            const sessionData = await sessionRes.json();
            appState.chatSessionId = sessionData.session_id;
            loadChatSessions();
        }

        const userSaveRes = await fetch(`/api/chat-sessions/${appState.chatSessionId}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role: 'user', content: message }),
        });
        if (!userSaveRes.ok) {
            throw new Error(`Could not save user message (${userSaveRes.status})`);
        }
        const assistantSaveRes = await fetch(`/api/chat-sessions/${appState.chatSessionId}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role: 'assistant', content: data.reply }),
        });
        if (!assistantSaveRes.ok) {
            throw new Error(`Could not save assistant message (${assistantSaveRes.status})`);
        }
    } catch (err) {
        hideTypingIndicator();
        const errTime = new Date();
        appState.chatMessages.push({ role: 'assistant', content: `Error: ${err.message}`, time: errTime });
        renderChatMessages();
    }
}

function startNewChatSession() {
    appState.chatSessionId = null;
    appState.chatMessages = [];
    renderChatMessages();
    setChatHistoryVisible(false);

    const input = document.getElementById('chat-input');
    if (input) input.focus();
}

async function toggleChatHistory() {
    const nextVisible = !appState.chatHistoryVisible;
    setChatHistoryVisible(nextVisible);
    if (nextVisible) await loadChatSessions();
}

function setChatHistoryVisible(visible) {
    appState.chatHistoryVisible = visible;
    const list = document.getElementById('chat-sessions-list');
    const messages = document.getElementById('chat-messages');
    const toggle = document.getElementById('chat-history-toggle');
    if (list) list.classList.toggle('hidden', !visible);
    if (messages) messages.classList.toggle('hidden', visible);
    if (toggle) {
        toggle.classList.toggle('active', visible);
        toggle.setAttribute('aria-expanded', String(visible));
        toggle.setAttribute('aria-label', visible ? 'Hide chat history' : 'Show chat history');
    }
}

/* ── PDF fullscreen chat helpers ─────────────────────────────────────────── */

function showPdfChatTypingIndicator() {
    const area = document.getElementById('pdf-fullscreen-chat-messages');
    if (!area) return;
    const indicator = document.createElement('div');
    indicator.className = 'typing-indicator';
    indicator.id = 'pdf-chat-typing-indicator';
    indicator.innerHTML = '<div class="dot"></div><div class="dot"></div><div class="dot"></div>';
    area.appendChild(indicator);
    area.scrollTop = area.scrollHeight;
}

function hidePdfChatTypingIndicator() {
    document.getElementById('pdf-chat-typing-indicator')?.remove();
}

function startPdfNewChat() {
    startNewChatSession();
    renderPdfFullscreenChat();
}

let _pdfChatHistoryVisible = false;

function togglePdfChatHistoryPanel() {
    setPdfChatHistoryVisible(!_pdfChatHistoryVisible);
}

function setPdfChatHistoryVisible(visible) {
    _pdfChatHistoryVisible = visible;
    const sessions = document.getElementById('pdf-fs-chat-sessions');
    const messages = document.getElementById('pdf-fullscreen-chat-messages');
    const toggle = document.getElementById('pdf-chat-history-toggle');
    if (sessions) sessions.classList.toggle('hidden', !visible);
    if (messages) messages.classList.toggle('hidden', visible);
    if (toggle) {
        toggle.classList.toggle('active', visible);
        toggle.setAttribute('aria-expanded', String(visible));
    }
    if (visible) loadPdfChatSessions();
}

async function loadPdfChatSessions() {
    try {
        const res = await fetch('/api/chat-sessions');
        const data = await res.json();
        const list = document.getElementById('pdf-fs-chat-sessions');
        if (!list) return;
        const sessions = data.sessions || [];
        const removeAllBtn = sessions.length
            ? `<div class="pdf-chat-history-header">
                   <span class="pdf-chat-history-label">History</span>
                   <button class="btn-secondary btn-small danger" onclick="deleteAllPdfChatSessions()" title="Remove all chats">
                       ${icon('trash-2')} Remove All
                   </button>
               </div>`
            : '';
        list.innerHTML = removeAllBtn + (sessions.length
            ? sessions.map(s => `
                <div class="session-item ${s.session_id === appState.chatSessionId ? 'active' : ''}"
                     onclick="selectChatSession('${s.session_id}'); setPdfChatHistoryVisible(false); renderPdfFullscreenChat();">
                    <span class="session-title">${escapeHtml(s.title)}</span>
                    <button class="session-delete" onclick="event.stopPropagation(); deletePdfChatSession('${s.session_id}')" title="Delete" aria-label="Delete">${icon('x')}</button>
                </div>`
            ).join('')
            : '<p class="sessions-empty">No chat history yet.</p>');
        refreshIcons(list);
    } catch (err) {
        console.error('Load PDF chat sessions error:', err);
    }
}

async function deletePdfChatSession(sessionId) {
    try {
        const res = await fetch(`/api/chat-sessions/${sessionId}`, { method: 'DELETE' });
        if (!res.ok) throw new Error(`Could not delete chat (${res.status})`);
        if (sessionId === appState.chatSessionId) {
            appState.chatSessionId = null;
            appState.chatMessages = [];
            renderPdfFullscreenChat();
            renderChatMessages();
        }
        // Refresh both lists but keep fullscreen panel open
        await Promise.all([loadChatSessions(), loadPdfChatSessions()]);
    } catch (err) {
        console.error('Delete chat error:', err);
    }
}

async function deleteAllPdfChatSessions() {
    try {
        const res = await fetch('/api/chat-sessions', { method: 'DELETE' });
        if (!res.ok) throw new Error(`Could not delete all chats (${res.status})`);
        appState.chatSessionId = null;
        appState.chatMessages = [];
        renderPdfFullscreenChat();
        renderChatMessages();
        await Promise.all([loadChatSessions(), loadPdfChatSessions()]);
    } catch (err) {
        console.error('Delete all chats error:', err);
    }
}

/* ── Standard sidebar typing indicator ──────────────────────────────────── */

function showTypingIndicator() {
    const area = document.getElementById('chat-messages');
    const indicator = document.createElement('div');
    indicator.className = 'typing-indicator';
    indicator.id = 'typing-indicator';
    indicator.innerHTML = '<div class="dot"></div><div class="dot"></div><div class="dot"></div>';
    area.appendChild(indicator);
    area.scrollTop = area.scrollHeight;
}

function hideTypingIndicator() {
    const indicator = document.getElementById('typing-indicator');
    if (indicator) indicator.remove();
}

function formatTime(date) {
    if (!date) return '—';
    // SQLite timestamps use space separator; replace with T for ISO 8601 parsing
    const d = date instanceof Date ? date : new Date(String(date).replace(' ', 'T'));
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}


function formatDate(value) {
    if (!value) return '-';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return value;
    return d.toLocaleDateString([], { year: 'numeric', month: 'short', day: '2-digit' });
}

function renderChatMessages() {
    const area = document.getElementById('chat-messages');
    if (!area) return;
    area.innerHTML = appState.chatMessages.map(m => {
        const dur = m.role === 'assistant' && m.duration ? `<span class="message-duration">${formatDuration(m.duration / 1000)}</span>` : '';
        return `
        <div class="message-wrapper ${m.role}">
            <div class="message ${m.role}">${m.role === 'assistant' ? renderMarkdown(m.content) : escapeHtml(m.content)}</div>
            <span class="message-time">${formatTime(m.time)}${dur}</span>
        </div>`;
    }).join('');
    area.scrollTop = area.scrollHeight;
    if (appState.pdfFullscreenSidebarTab === 'chat') renderPdfFullscreenChat();
}

async function loadChatSessions() {
    try {
        const res = await fetch('/api/chat-sessions');
        const data = await res.json();
        const list = document.getElementById('chat-sessions-list');
        const sessions = data.sessions || [];
        const removeAllBtn = sessions.length
            ? `<div class="pdf-chat-history-header">
                   <span class="pdf-chat-history-label">History</span>
                   <button class="btn-secondary btn-small danger" onclick="deleteAllChatSessions()" title="Remove all chats">
                       ${icon('trash-2')} Remove All
                   </button>
               </div>`
            : '';
        list.innerHTML = removeAllBtn + (sessions.length
            ? sessions.map(s =>
                `<div class="session-item ${s.session_id === appState.chatSessionId ? 'active' : ''}"
                      onclick="selectChatSession('${s.session_id}')">
                    <span class="session-title">${escapeHtml(s.title)}</span>
                    <button class="session-delete" onclick="event.stopPropagation(); deleteChatSession('${s.session_id}')" title="Delete chat" aria-label="Delete chat">${icon('x')}</button>
                </div>`
            ).join('')
            : '<p class="sessions-empty">No chat history yet.</p>');
        refreshIcons(list);
    } catch (err) {
        console.error('Load sessions error:', err);
    }
}

async function deleteAllChatSessions() {
    try {
        const res = await fetch('/api/chat-sessions', { method: 'DELETE' });
        if (!res.ok) throw new Error(`Could not delete all chats (${res.status})`);
        appState.chatSessionId = null;
        appState.chatMessages = [];
        renderChatMessages();
        await loadChatSessions();
    } catch (err) {
        console.error('Delete all chats error:', err);
    }
}

async function deleteChatSession(sessionId) {
    if (!confirm('Delete this chat?')) return;
    try {
        const res = await fetch(`/api/chat-sessions/${sessionId}`, { method: 'DELETE' });
        if (!res.ok) {
            throw new Error(`Could not delete chat (${res.status})`);
        }
        if (sessionId === appState.chatSessionId) {
            appState.chatSessionId = null;
            appState.chatMessages = [];
            renderChatMessages();
        }
        await loadChatSessions();
    } catch (err) {
        console.error('Delete chat error:', err);
        alert('Error deleting chat: ' + err.message);
    }
}

async function selectChatSession(sessionId) {
    appState.chatSessionId = sessionId;
    try {
        const res = await fetch(`/api/chat-sessions/${sessionId}/messages`);
        const data = await res.json();
        appState.chatMessages = (data.messages || []).map(m => ({
            role: m.role,
            content: m.content,
            time: m.created_at ? new Date(String(m.created_at).replace(' ', 'T')) : null,
        }));
        renderChatMessages();
        loadChatSessions();
        setChatHistoryVisible(false);
    } catch (err) {
        console.error('Load messages error:', err);
    }
}
