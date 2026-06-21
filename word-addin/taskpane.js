/* ── TarCite Workspace Word Add-in ───────────────────────────────────────── */

const API_BASE = window.location.origin || "https://tarcite.workspace:4443";
const API_BASE_FALLBACKS = [
    API_BASE,
    "https://tarcite.workspace:4443",
    "https://127.0.0.1:4443",
    "https://tarcite.workspace",
    "http://tarcite.workspace",
];
const CITATION_MARKER_PREFIX = "CW-CITE-";
const BIBLIOGRAPHY_MARKER = "CW-BIBLIOGRAPHY";
const BIBLIOGRAPHY_HANGING_INDENT_POINTS = 36;

let _apiBase = API_BASE;
let _schemeDiscovered = false;
let _tpProfileMenuOpen = "";

const state = {
    connected: false,
    currentStyle: "apa7",
    sourceDir: "",
    searchResults: [],
    documentCitations: [],
    editingCitationId: null,
    editingCitationDraft: null,
    editingItemMeta: {},
    editPreviewTimer: null,
    citationCounter: 0,
    selectedCitations: [],
    currentSuggestions: [],
    currentCandidates: [],
    currentParagraph: "",
    currentRunId: "",
    suggestionHistory: [],
    suggestionChatMessages: [],
    suggestionChatSessionId: null,
    suggestionChatHistoryVisible: false,
    numberedCitationFormat: "separate",
};

/* ── Initialization ───────────────────────────────────────────────────────── */

Office.onReady((info) => {
    initTheme();
    initSplashScreen();
    if (info.host !== Office.HostType.Word) {
        showToast("This add-in requires Microsoft Word.", "error");
        return;
    }
    initTabs();
    initSearch();
    initSettings();
    initCitations();
    initBibliography();
    initEditModal();
    initChips();
    initSuggestions();
    initTpProfileDropdown();
    checkConnection();
    refreshIcons();
    setInterval(checkConnection, 10000);
    loadDocumentCitations();
    loadSuggestionHistory();
});

function initTheme() {
    const storageKey = "citation-workspace-word-theme";
    let saved = "";
    try {
        saved = localStorage.getItem(storageKey) || "";
    } catch {}
    if (saved === "light" || saved === "dark") {
        document.documentElement.setAttribute("data-theme", saved);
    }

    const btn = document.getElementById("theme-toggle");
    if (!btn) return;
    const updateButton = () => {
        const current = document.documentElement.getAttribute("data-theme") || "dark";
        btn.setAttribute("aria-label", current === "light" ? "Switch to dark mode" : "Switch to light mode");
        btn.setAttribute("title", current === "light" ? "Switch to dark mode" : "Switch to light mode");
    };
    btn.addEventListener("click", () => {
        const current = document.documentElement.getAttribute("data-theme") || "dark";
        const next = current === "light" ? "dark" : "light";
        document.documentElement.setAttribute("data-theme", next);
        try {
            localStorage.setItem(storageKey, next);
        } catch {}
        updateButton();
    });
    updateButton();
}

function icon(name, className = "") {
    const cls = className ? ` class="${escapeHtml(className)}"` : "";
    return `<i data-lucide="${escapeHtml(name)}"${cls} aria-hidden="true"></i>`;
}

function refreshIcons(root = document) {
    if (!window.lucide || !root) return;
    window.lucide.createIcons({
        attrs: {
            "stroke-width": 2,
            "aria-hidden": "true",
        },
    });
}

function initSplashScreen() {
    const splash = document.getElementById("splash-screen");
    if (!splash) return;
    setTimeout(() => {
        splash.classList.add("hidden");
        setTimeout(() => splash.remove(), 350);
    }, 3000);
}

async function checkConnection() {
    try {
        const connected = await tryConnect();
        const wasConnected = state.connected;
        if (connected) {
            setConnected(true);
            if (!wasConnected) {
                loadDirectories();
                loadSuggestionHistory();
            }
        } else {
            setConnected(false);
        }
    } catch {
        setConnected(false);
    }
}

function setConnected(connected) {
    state.connected = connected;
    const el = document.getElementById("connection-status");
    const text = el.querySelector(".status-text");
    el.classList.toggle("connected", connected);
    el.classList.toggle("error", !connected);
    text.textContent = connected ? "Connected" : "Disconnected";
}

/* ── API Helpers ───────────────────────────────────────────────────────────── */

async function apiGet(path) {
    const url = `${_apiBase}${path}`;
    const res = await fetch(url, { method: "GET", headers: { "Accept": "application/json" } });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
}

async function apiPost(path, body) {
    const url = `${_apiBase}${path}`;
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
}

async function apiDelete(path) {
    const url = `${_apiBase}${path}`;
    const res = await fetch(url, { method: "DELETE", headers: { "Accept": "application/json" } });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
}

async function tryConnect() {
    // Once scheme is known, only poll that one — avoids HTTP hitting an SSL port
    if (_schemeDiscovered) {
        try {
            const res = await fetch(`${_apiBase}/api/word/status`, { method: "GET" });
            if (res.ok) return true;
        } catch {}
        return false;
    }
    // First-time discovery: same origin first, then legacy URLs for upgraded installs.
    for (const base of [...new Set(API_BASE_FALLBACKS)]) {
        try {
            const res = await fetch(`${base}/api/word/status`, { method: "GET" });
            if (res.ok) { _apiBase = base; _schemeDiscovered = true; return true; }
        } catch {}
    }
    return false;
}

/* ── Tabs ──────────────────────────────────────────────────────────────────── */

function initTabs() {
    document.querySelectorAll(".tab-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
            document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
            btn.classList.add("active");
            document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
            if (btn.dataset.tab === "citations") loadDocumentCitations();
            if (btn.dataset.tab === "suggestion") loadSuggestionHistory();
        });
    });
}

/* ── Chips ─────────────────────────────────────────────────────────────────── */

function initChips() {
    document.getElementById("clear-chips-btn").addEventListener("click", clearChips);
    document.getElementById("insert-all-btn").addEventListener("click", insertAllCitations);
}

function addToChips(item) {
    if (state.selectedCitations.find(c => c.item_key === item.item_key)) {
        showToast(`"${item.title}" already selected.`, "warning");
        return;
    }
    state.selectedCitations.push({
        item_key: item.item_key, title: item.title || "Untitled",
        year: item.year || "n.d.", creators_formatted: item.creators_formatted || "",
        locator: "", prefix: "", suffix: "", suppress_author: false,
    });
    renderChips();
    showToast("Added to selection.", "success");
}

function removeFromChips(index) {
    state.selectedCitations.splice(index, 1);
    renderChips();
}

function clearChips() {
    state.selectedCitations = [];
    renderChips();
}

function renderChips() {
    const area = document.getElementById("selected-citations-area");
    const container = document.getElementById("chips-container");
    const count = document.querySelector(".chips-count");
    if (!state.selectedCitations.length) { area.classList.add("hidden"); return; }
    area.classList.remove("hidden");
    count.textContent = `${state.selectedCitations.length} selected`;
    container.innerHTML = state.selectedCitations.map((c, i) =>
        `<div class="chip"><span class="chip-text">${escapeHtml(c.creators_formatted)} (${c.year})</span><button class="chip-remove" data-index="${i}" aria-label="Remove">${icon("x")}</button></div>`
    ).join("");
    refreshIcons(container);
    container.querySelectorAll(".chip-remove").forEach(btn => {
        btn.addEventListener("click", () => removeFromChips(parseInt(btn.dataset.index)));
    });
}

/* ── Search ────────────────────────────────────────────────────────────────── */

function initSearch() {
    const input = document.getElementById("search-input");
    let debounce = null;
    input.addEventListener("input", () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => performSearch(input.value.trim()), 300);
    });
    document.getElementById("search-filter").addEventListener("change", (e) => {
        state.sourceDir = e.target.value;
        if (input.value.trim()) performSearch(input.value.trim());
    });
}

async function performSearch(query) {
    if (!state.connected) { showToast("Not connected to TarCite Workspace.", "error"); return; }
    if (!query) { document.getElementById("search-results").innerHTML = ""; return; }
    showLoading("Searching library...");
    try {
        let url = `/api/word/search?q=${encodeURIComponent(query)}`;
        if (state.sourceDir) url += `&source_dir=${encodeURIComponent(state.sourceDir)}`;
        const data = await apiGet(url);
        state.searchResults = data.items || [];
        renderSearchResults(state.searchResults);
    } catch (err) {
        showToast(`Search failed: ${err.message}`, "error");
    } finally { hideLoading(); }
}

function renderSearchResults(items) {
    const container = document.getElementById("search-results");
    if (!items.length) { container.innerHTML = '<p class="empty-state">No results found.</p>'; return; }
    container.innerHTML = items.map((item, i) => `
        <div class="result-item" data-index="${i}">
            <div class="result-title">${escapeHtml(item.title || "Untitled")}</div>
            <div class="result-meta">${escapeHtml(item.creators_formatted || "")} (${item.year || "n.d."})</div>
            <div class="result-actions">
                <button class="btn-primary btn-small btn-add-citation" data-index="${i}">+ Add</button>
                <button class="btn-secondary btn-small btn-insert-single" data-index="${i}">Insert Now</button>
                <button class="btn-secondary btn-small btn-insert-note" data-index="${i}">Note</button>
            </div>
        </div>
    `).join("");
    container.querySelectorAll(".btn-add-citation").forEach(btn => {
        btn.addEventListener("click", () => addToChips(state.searchResults[parseInt(btn.dataset.index)]));
    });
    container.querySelectorAll(".btn-insert-single").forEach(btn => {
        btn.addEventListener("click", () => insertSingleCitation(state.searchResults[parseInt(btn.dataset.index)]));
    });
    container.querySelectorAll(".btn-insert-note").forEach(btn => {
        btn.addEventListener("click", () => insertFootnote(state.searchResults[parseInt(btn.dataset.index)]));
    });
}

/* ── Numbered Citation Insertion (IEEE/Vancouver) ─────────────────────────── */

function uniqueSortedNumbers(numbers) {
    return [...new Set(numbers.map(n => parseInt(n, 10)).filter(n => Number.isFinite(n) && n > 0))]
        .sort((a, b) => a - b);
}

function compressNumberRanges(numbers) {
    const sorted = uniqueSortedNumbers(numbers);
    const ranges = [];
    for (let i = 0; i < sorted.length; i++) {
        const start = sorted[i];
        let end = start;
        while (i + 1 < sorted.length && sorted[i + 1] === end + 1) {
            end = sorted[i + 1];
            i++;
        }
        ranges.push(start === end ? `${start}` : `${start}–${end}`);
    }
    return ranges;
}

function formatNumberedCitation(indices, format = state.numberedCitationFormat) {
    const nums = uniqueSortedNumbers(indices);
    if (!nums.length) return "";
    if (format === "grouped") return `[${nums.join(", ")}]`;
    if (format === "ranges") return `[${compressNumberRanges(nums).join(", ")}]`;
    return nums.map(n => `[${n}]`).join(", ");
}

async function insertNumberedCitations(newItems, citationFormat) {
    const newKeys = newItems.map(i => i.item_key);
    const existing = await scanDocumentCitations();
    const orderedKeys = [];
    for (const cc of existing) {
        for (const item of (cc.items || [])) { if (!orderedKeys.includes(item.item_key)) orderedKeys.push(item.item_key); }
    }
    for (const key of newKeys) { if (!orderedKeys.includes(key)) orderedKeys.push(key); }
    const keyToNumber = {};
    orderedKeys.forEach((key, i) => { keyToNumber[key] = i + 1; });
    const newIndices = newItems.map(it => keyToNumber[it.item_key] || 1);

    await Word.run(async (context) => {
        const contentControls = context.document.contentControls;
        contentControls.load("id, title, tag, text");
        await context.sync();
        const allCCs = [];
        for (const cc of contentControls.items) {
            if (cc.title && cc.title.startsWith(CITATION_MARKER_PREFIX)) {
                try { allCCs.push({ cc, data: JSON.parse(cc.tag) }); } catch {}
            }
        }
        for (const { cc, data } of allCCs) {
            const items = data.items || [];
            const indices = items.map(it => keyToNumber[it.item_key] || 1);
            const formatted = formatNumberedCitation(indices);
            cc.insertText(formatted, "Replace");
            cc.tag = JSON.stringify(data);
        }
        const citationData = {
            citation_id: `${CITATION_MARKER_PREFIX}${generateId()}`,
            items: newItems,
            style: state.currentStyle,
            citation_format: citationFormat,
            numbered_format: state.numberedCitationFormat,
        };
        const formatted = formatNumberedCitation(newIndices);
        const range = context.document.getSelection();
        const cc = range.insertContentControl();
        cc.title = citationData.citation_id; cc.tag = JSON.stringify(citationData);
        cc.appearance = "Hidden"; cc.insertText(formatted, "Replace"); cc.select();
        context.trackedObjects.add(cc);
        await context.sync();
    });
    return { formatted_text: formatNumberedCitation(newIndices) };
}

async function scanDocumentCitations() {
    const citations = [];
    await Word.run(async (context) => {
        const contentControls = context.document.contentControls;
        contentControls.load("id, title, tag, text");
        await context.sync();
        for (const cc of contentControls.items) {
            if (cc.title && cc.title.startsWith(CITATION_MARKER_PREFIX)) {
                try { citations.push(JSON.parse(cc.tag)); } catch {}
            }
        }
    });
    return citations;
}

/* ── Citation Insertion ────────────────────────────────────────────────────── */

async function insertAllCitations() {
    if (!state.connected || !state.selectedCitations.length) return;
    const formatRadio = document.querySelector('input[name="citation-format"]:checked');
    const citationFormat = formatRadio ? formatRadio.value : "parenthetical";
    const isNumbered = isNumberedStyle();
    showLoading("Inserting citations...");
    try {
        const items = state.selectedCitations.map(c => ({ item_key: c.item_key, locator: c.locator, prefix: c.prefix, suffix: c.suffix, suppress_author: c.suppress_author }));
        if (isNumbered) {
            await insertNumberedCitations(items, citationFormat);
        } else {
            const formatRes = await apiPost("/api/word/format-citation", { items, style: state.currentStyle, citation_format: citationFormat });
            const citationData = { citation_id: `${CITATION_MARKER_PREFIX}${generateId()}`, items, style: state.currentStyle, citation_format: citationFormat };
            await Word.run(async (context) => {
                const range = context.document.getSelection();
                const cc = range.insertContentControl();
                cc.title = citationData.citation_id; cc.tag = JSON.stringify(citationData);
                cc.appearance = "Hidden"; cc.insertText(formatRes.formatted_text, "Replace"); cc.select();
                context.trackedObjects.add(cc); await context.sync();
            });
        }
        state.citationCounter++; clearChips();
        showToast("Citations inserted.", "success");
    } catch (err) { showToast(`Failed: ${err.message}`, "error"); } finally { hideLoading(); }
}

async function insertSingleCitation(item) {
    if (!state.connected) return;
    const formatRadio = document.querySelector('input[name="citation-format"]:checked');
    const citationFormat = formatRadio ? formatRadio.value : "parenthetical";
    const isNumbered = isNumberedStyle();
    showLoading("Inserting citation...");
    try {
        if (isNumbered) {
            await insertNumberedCitations([{ item_key: item.item_key, locator: "", prefix: "", suffix: "", suppress_author: false }], citationFormat);
            state.citationCounter++; showToast("Citation inserted.", "success"); return;
        }
        const citationData = { citation_id: `${CITATION_MARKER_PREFIX}${generateId()}`, items: [{ item_key: item.item_key, locator: "", prefix: "", suffix: "", suppress_author: false }], style: state.currentStyle, citation_format: citationFormat };
        const formatRes = await apiPost("/api/word/format-citation", { items: citationData.items, style: state.currentStyle, citation_format: citationFormat });
        await Word.run(async (context) => {
            const range = context.document.getSelection();
            const cc = range.insertContentControl();
            cc.title = citationData.citation_id; cc.tag = JSON.stringify(citationData);
            cc.appearance = "Hidden"; cc.insertText(formatRes.formatted_text, "Replace"); cc.select();
            context.trackedObjects.add(cc); await context.sync();
        });
        state.citationCounter++; showToast("Citation inserted.", "success");
    } catch (err) { showToast(`Failed: ${err.message}`, "error"); } finally { hideLoading(); }
}

async function insertFootnote(item) {
    if (!state.connected) return;
    showLoading("Inserting footnote...");
    try {
        const formatRes = await apiPost("/api/word/format-citation", { items: [{ item_key: item.item_key }], style: state.currentStyle });
        await Word.run(async (context) => { context.document.getSelection().insertFootnote(formatRes.formatted_text); await context.sync(); });
        showToast("Footnote inserted.", "success");
    } catch (err) { showToast(`Failed: ${err.message}`, "error"); } finally { hideLoading(); }
}

/* ── Citation Suggestions ─────────────────────────────────────────────────── */

function initSuggestions() {
    document.getElementById("suggestion-run-btn").addEventListener("click", suggestCitations);
    document.getElementById("suggestion-history-clear-all")?.addEventListener("click", deleteAllSuggestionHistoryRuns);
    document.getElementById("suggestion-dir-filter").addEventListener("change", (e) => { state.sourceDir = e.target.value; });
    const topKSlider = document.getElementById("suggestion-top-k");
    const topKValue = document.getElementById("suggestion-top-k-val");
    if (topKSlider && topKValue) {
        topKValue.textContent = topKSlider.value;
        topKSlider.addEventListener("input", () => { topKValue.textContent = topKSlider.value; });
    }
    const tempSlider = document.getElementById("suggestion-temp");
    const tempValue = document.getElementById("suggestion-temp-val");
    if (tempSlider && tempValue) {
        tempValue.textContent = parseFloat(tempSlider.value).toFixed(2);
        tempSlider.addEventListener("input", () => { tempValue.textContent = parseFloat(tempSlider.value).toFixed(2); });
    }
    document.getElementById("suggestion-chat-new").addEventListener("click", startNewSuggestionChat);
    document.getElementById("suggestion-chat-history-toggle").addEventListener("click", toggleSuggestionChatHistory);
    document.getElementById("suggestion-chat-send").addEventListener("click", sendSuggestionChatMessage);
    document.getElementById("suggestion-chat-input").addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            sendSuggestionChatMessage();
        }
    });
    setSuggestionChatHistoryVisible(false);
}

async function useSelectedTextForSuggestion() {
    try {
        await Word.run(async (context) => {
            const range = context.document.getSelection();
            range.load("text");
            await context.sync();
            const text = (range.text || "").trim();
            if (!text) {
                showToast("No text selected in Word.", "warning");
                return;
            }
            document.getElementById("suggestion-paragraph").value = text;
        });
    } catch (err) {
        showToast(`Could not read selection: ${err.message}`, "error");
    }
}

async function suggestCitations() {
    if (!state.connected) { showToast("Not connected to TarCite Workspace.", "error"); return; }

    const paragraph = document.getElementById("suggestion-paragraph").value.trim();
    if (!paragraph) { showToast("Enter a paragraph first.", "warning"); return; }

    const topK = parseInt(document.getElementById("suggestion-top-k").value, 10) || 15;
    const suggestionTemp = parseFloat(document.getElementById("suggestion-temp")?.value ?? 0.1);
    const sourceDir = document.getElementById("suggestion-dir-filter").value;
    const progressEl = document.getElementById("suggestion-progress");
    const fillEl = document.getElementById("suggestion-progress-fill");
    const stepEl = document.getElementById("suggestion-progress-step");
    const pctEl = document.getElementById("suggestion-progress-pct");
    const resultsEl = document.getElementById("suggestion-results");
    const startTime = Date.now();

    progressEl.classList.remove("hidden");
    fillEl.style.width = "0%";
    stepEl.textContent = "Starting...";
    pctEl.textContent = "0%";
    startCitationProgressMessages("suggestion-progress-message");
    resultsEl.innerHTML = "";

    try {
        const res = await fetch(`${_apiBase}/api/suggest-citations/stream`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Accept": "text/event-stream" },
            body: JSON.stringify({
                paragraph,
                top_k: topK,
                suggestion_temperature: suggestionTemp,
                source_dir: sourceDir || null,
                citation_style: state.currentStyle,
            }),
        });
        if (!res.ok) throw new Error(`API error: ${res.status}`);
        if (!res.body || !res.body.getReader) throw new Error("Streaming is not supported in this Word webview.");

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
                if (!line.startsWith("data: ")) continue;
                const msg = JSON.parse(line.slice(6));
                if (msg.type === "progress") {
                    const pct = Math.round(msg.pct || 0);
                    fillEl.style.width = `${pct}%`;
                    stepEl.textContent = msg.step || "";
                    pctEl.textContent = `${pct}%`;
                } else if (msg.type === "result") {
                    progressEl.classList.add("hidden");
                    stopCitationProgressMessages("suggestion-progress-message");
                    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                    renderSuggestionResults(msg.data, elapsed);
                    loadSuggestionHistory();
                } else if (msg.type === "citation_counts") {
                    applyCitationCountUpdates(msg.counts || []);
                } else if (msg.type === "profile_switched") {
                    loadDirectories();
                } else if (msg.type === "error") {
                    progressEl.classList.add("hidden");
                    stopCitationProgressMessages("suggestion-progress-message");
                    if (msg.quota_exceeded) {
                        handleQuotaExceeded(msg.message, msg.buy_url);
                    }
                    resultsEl.innerHTML = `<div class="suggestion-card error">${escapeHtml(msg.message || "Suggestion failed.")}</div>`;
                }
            }
        }
        if (!progressEl.classList.contains("hidden")) {
            stopCitationProgressMessages("suggestion-progress-message");
        }
    } catch (err) {
        progressEl.classList.add("hidden");
        stopCitationProgressMessages("suggestion-progress-message");
        resultsEl.innerHTML = `<div class="suggestion-card error">Error: ${escapeHtml(err.message)}</div>`;
    }
}

const CITATION_PROGRESS_MESSAGES = [
    "Takes your coffee, speeds up local AI dependence with your machine.",
    "Local AI is thinking through your library one source at a time.",
    "Good citations are found by patience, not panic.",
    "Your machine is reading before it writes.",
    "The best reference is the one that truly supports the sentence.",
    "Searching wide first, choosing carefully after.",
    "A useful citation earns its place in the paragraph.",
    "The library is being asked a focused question.",
    "Local models work hard because the work stays with you.",
    "A slower local run can still be the more private run.",
    "Evidence first, confidence second, citation last.",
    "The model is comparing claims against source text.",
    "Small models need clear context and a little time.",
    "A good match is better than a fast guess.",
    "Your sources are being sorted by relevance, not by noise.",
    "The answer is being grounded before it is formatted.",
    "Citation quality improves when the machine has room to reason.",
    "Retrieval is gathering candidates; judgment comes next.",
    "A careful citation saves editing later.",
    "The local engine is limited by CPU, memory, and patience.",
    "Academic writing rewards exact support.",
    "The model is looking for evidence, not decoration.",
    "If this feels slow, the machine is carrying the whole task locally.",
    "Source selection is where accuracy begins.",
    "A citation should strengthen the claim it follows.",
    "The paragraph is being mapped to your indexed library.",
    "Good retrieval narrows the search before generation starts.",
    "The model is balancing relevance, coverage, and confidence.",
    "Strong citations connect directly to the sentence.",
    "Your local library is doing the heavy lifting.",
    "This step works best with focused paragraphs.",
    "A short wait can prevent a weak reference.",
    "The model is checking which sources actually belong here.",
    "Evidence is being weighed against your wording.",
    "Local inference is private, but not always instant.",
    "The best suggestion is usually the most defensible one.",
    "The system is reducing many sources into a few useful choices.",
    "Relevance beats popularity when citing a claim.",
    "The citation list is being shaped, not merely filled.",
    "The model is reading snippets with your paragraph in mind.",
    "The strongest source should explain why it was chosen.",
    "A good recommendation includes a reason you can inspect.",
    "Your indexed text is being searched before the AI speaks.",
    "Careful citation is part retrieval and part judgment.",
    "The local model may be warming up its weights.",
    "If the first local run is slow, later runs may be faster.",
    "Context windows are finite; focused inputs help.",
    "The system is trying to avoid citation padding.",
    "A useful source answers the paragraph, not just the keywords.",
    "Precision now means fewer corrections later.",
    "The model is turning candidate evidence into citation suggestions.",
    "Local AI works best when the task is scoped clearly.",
    "Quality citation is quiet, specific, and defensible.",
    "The machine is matching meaning, not only words.",
    "The run is still alive while progress and source checks continue.",
    "Good scholarship is patient with evidence.",
];

let citationProgressMessageTimer = null;
let citationProgressMessageIndex = 0;

function startCitationProgressMessages(elementId = "suggestion-progress-message") {
    stopCitationProgressMessages();
    const el = document.getElementById(elementId);
    if (!el) return;
    citationProgressMessageIndex = 0;
    el.textContent = CITATION_PROGRESS_MESSAGES[citationProgressMessageIndex];
    citationProgressMessageTimer = setInterval(() => {
        citationProgressMessageIndex = (citationProgressMessageIndex + 1) % CITATION_PROGRESS_MESSAGES.length;
        el.textContent = CITATION_PROGRESS_MESSAGES[citationProgressMessageIndex];
    }, 3500);
}

function stopCitationProgressMessages(elementId = "suggestion-progress-message") {
    if (citationProgressMessageTimer) {
        clearInterval(citationProgressMessageTimer);
        citationProgressMessageTimer = null;
    }
    const el = document.getElementById(elementId);
    if (el) el.textContent = "";
}

function normalizeSuggestion(suggestion) {
    const normalized = { ...suggestion };
    if (!Array.isArray(normalized.evidence_points)) {
        if (normalized.evidence_points_json) {
            try { normalized.evidence_points = JSON.parse(normalized.evidence_points_json); }
            catch { normalized.evidence_points = []; }
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

function renderSuggestionResults(data, elapsedSeconds) {
    const resultsEl = document.getElementById("suggestion-results");
    const payload = data || {};
    const suggestions = (payload.suggestions || []).map(normalizeSuggestion);
    const incomingRunId = payload.run_id || "";
    if (incomingRunId && incomingRunId !== state.currentRunId) {
        state.suggestionChatMessages = [];
        state.suggestionChatSessionId = null;
        renderSuggestionChatMessages(false);
    }
    if (typeof payload.paragraph === "string") state.currentParagraph = payload.paragraph;
    if (Array.isArray(payload.candidates)) state.currentCandidates = payload.candidates;
    if (incomingRunId) state.currentRunId = incomingRunId;
    state.currentSuggestions = suggestions;

    const timing = elapsedSeconds
        ? `<div class="processing-time">Processed in ${formatDuration(elapsedSeconds)} - ${suggestions.length} suggestion${suggestions.length === 1 ? "" : "s"}</div>`
        : "";

    if (!suggestions.length) {
        resultsEl.innerHTML = timing + '<div class="suggestion-card">No relevant sources found.</div>';
        renderSuggestionWarnings(payload.warnings || []);
        return;
    }

    resultsEl.innerHTML = timing + suggestions.map((s, i) => `
        <div class="suggestion-card" data-item-key="${escapeHtml(s.item_key)}">
            <div class="suggestion-header">
                <div class="suggestion-title">${escapeHtml(s.title || "Untitled")}</div>
                <div class="suggestion-badges">
                    ${renderCitationCountBadge(s)}
                    <span class="confidence-badge ${(s.confidence || "Low").toLowerCase()}">${escapeHtml(s.confidence || "Low")}</span>
                </div>
            </div>
            <div class="suggestion-citation">${escapeHtml(s.inline_citation || "")}</div>
            <div class="suggestion-reason">${escapeHtml(s.reason || "")}</div>
            ${(s.evidence_points || []).map(e => `<div class="suggestion-evidence">${escapeHtml(e)}</div>`).join("")}
            <div class="suggestion-actions">
                <button class="btn-primary btn-small" data-action="insert" data-index="${i}">Insert Citation</button>
                <button class="btn-secondary btn-small" data-action="add" data-index="${i}">Add</button>
                <button class="btn-secondary btn-small" data-action="spotlight" data-index="${i}">Spotlight</button>
            </div>
        </div>
    `).join("");

    resultsEl.querySelectorAll("button[data-action]").forEach(btn => {
        btn.addEventListener("click", () => handleSuggestionAction(btn.dataset.action, parseInt(btn.dataset.index, 10)));
    });
    renderSuggestionWarnings(payload.warnings || []);
}

function applyCitationCountUpdates(counts) {
    if (!Array.isArray(counts) || !counts.length) return;
    for (const update of counts) {
        const itemKey = update.item_key || "";
        if (!itemKey) continue;
        const count = normalizeCitationCount(update.citation_count);
        for (const suggestion of state.currentSuggestions || []) {
            if (suggestion.item_key === itemKey) {
                suggestion.citation_count = count;
                suggestion.citation_count_updated_at = update.citation_count_updated_at || "";
            }
        }
        for (const candidate of state.currentCandidates || []) {
            if (candidate.item_key === itemKey) {
                candidate.citation_count = count;
                candidate.citation_count_updated_at = update.citation_count_updated_at || "";
            }
        }
        document.querySelectorAll(".suggestion-card").forEach(card => {
            if (card.dataset.itemKey !== itemKey) return;
            const badge = card.querySelector(".citation-count-badge");
            if (badge) badge.outerHTML = renderCitationCountBadge({ citation_count: count });
        });
    }
}

function renderSuggestionWarnings(warnings) {
    if (!warnings || !warnings.length) return;
    const resultsEl = document.getElementById("suggestion-results");
    resultsEl.innerHTML += warnings.map(w => `<div class="suggestion-card warning">${escapeHtml(w)}</div>`).join("");
}

async function handleSuggestionAction(action, index) {
    const suggestion = state.currentSuggestions[index];
    if (!suggestion) return;

    if (action === "insert") {
        await insertSingleCitation({ item_key: suggestion.item_key });
    } else if (action === "add") {
        await addSuggestionToChips(suggestion);
    } else if (action === "spotlight") {
        openSuggestionSpotlight(suggestion);
    }
}

async function addSuggestionToChips(suggestion) {
    let item = {
        item_key: suggestion.item_key,
        title: suggestion.title || "Untitled",
        year: "n.d.",
        creators_formatted: suggestion.inline_citation || suggestion.title || suggestion.item_key,
    };
    try {
        item = { ...item, ...(await apiGet(`/api/word/items/${suggestion.item_key}`)) };
    } catch {}
    addToChips(item);
}

async function loadSuggestionHistory() {
    if (!state.connected) return;
    try {
        const data = await apiGet("/api/suggestion-runs");
        state.suggestionHistory = data.runs || [];
        renderSuggestionHistory(state.suggestionHistory.slice(0, 10));
    } catch (err) {
        console.error("Suggestion history load failed:", err);
    }
}

function renderConfidenceBadges(r) {
    const high   = Number(r.high_count)   || 0;
    const medium = Number(r.medium_count) || 0;
    const low    = Number(r.low_count)    || 0;
    const total  = Number(r.result_count) || 0;
    if (!total) return '';
    const parts = [];
    if (high)   parts.push(`<span class="conf-badge high">${high} High</span>`);
    if (medium) parts.push(`<span class="conf-badge moderate">${medium} Medium</span>`);
    if (low)    parts.push(`<span class="conf-badge low">${low} Low</span>`);
    return `<span class="conf-badge source">${total} Source${total !== 1 ? 's' : ''}</span>` + parts.join('');
}

function renderSuggestionHistory(runs) {
    const section = document.getElementById("suggestion-history-section");
    const area = document.getElementById("suggestion-history");
    if (!section || !area) return;
    section.classList.toggle("hidden", !runs.length);
    area.innerHTML = runs.map(run => `
        <div class="history-card" data-run-id="${escapeHtml(run.run_id)}">
            <div class="history-card-body">
                <span class="history-title">${escapeHtml(run.title || "Untitled")}</span>
                <span class="history-meta">${escapeHtml(formatHistoryDate(run.created_at))}${formatHistoryDuration(run.elapsed_seconds)}${formatHistoryTopK(run.top_k)} · ${escapeHtml(run.ai_model || "")}</span>
                <div class="history-card-badges">${renderConfidenceBadges(run)}</div>
            </div>
            <button class="history-card-delete" data-run-id="${escapeHtml(run.run_id)}" title="Delete" aria-label="Delete">${icon("x")}</button>
        </div>
    `).join("");
    refreshIcons(area);
    area.querySelectorAll(".history-card").forEach(card => {
        card.addEventListener("click", (e) => { if (!e.target.closest(".history-card-delete")) loadSuggestionRun(card.dataset.runId); });
    });
    area.querySelectorAll(".history-card-delete").forEach(btn => {
        btn.addEventListener("click", (e) => { e.stopPropagation(); deleteSuggestionHistoryRun(btn.dataset.runId); });
    });
}

async function deleteSuggestionHistoryRun(runId) {
    if (!runId) return;
    try {
        await apiDelete(`/api/suggestion-runs/${runId}`);
        state.suggestionHistory = state.suggestionHistory.filter(r => r.run_id !== runId);
        renderSuggestionHistory(state.suggestionHistory.slice(0, 10));
    } catch (err) {
        showToast(`Could not delete: ${err.message}`, "error");
    }
}

async function deleteAllSuggestionHistoryRuns() {
    try {
        await apiDelete("/api/suggestion-runs");
        state.suggestionHistory = [];
        renderSuggestionHistory([]);
        showToast("Suggestion history cleared.", "info");
    } catch (err) {
        showToast(`Could not delete history: ${err.message}`, "error");
    }
}

async function loadSuggestionRun(runId) {
    try {
        const run = await apiGet(`/api/suggestion-runs/${runId}`);
        document.getElementById("suggestion-paragraph").value = run.paragraph || "";
        state.currentParagraph = run.paragraph || "";
        state.currentCandidates = [];
        renderSuggestionResults({
            paragraph: run.paragraph || "",
            suggestions: run.results || [],
            warnings: parseJsonArray(run.warnings_json),
            run_id: run.run_id || runId,
        });
    } catch (err) {
        showToast(`Could not load history: ${err.message}`, "error");
    }
}

function openSuggestionSpotlight(suggestion) {
    const evidence = (suggestion.evidence_points || []).find(e => (e || "").trim()) || suggestion.reason || suggestion.title || "";
    const params = new URLSearchParams();
    params.set("item_key", suggestion.item_key);
    if (evidence) params.set("spotlight", evidence);
    const url = `${_apiBase}/?${params.toString()}`;

    if (Office.context.ui && Office.context.ui.displayDialogAsync) {
        Office.context.ui.displayDialogAsync(url, { height: 80, width: 80, displayInIframe: false }, (result) => {
            if (result.status !== Office.AsyncResultStatus.Succeeded) {
                window.open(url, "_blank");
            }
        });
    } else {
        window.open(url, "_blank");
    }
}

async function sendSuggestionChatMessage() {
    if (!state.connected) { showToast("Not connected to TarCite Workspace.", "error"); return; }
    const input = document.getElementById("suggestion-chat-input");
    const message = input.value.trim();
    if (!message) return;

    setSuggestionChatHistoryVisible(false);
    input.value = "";
    state.suggestionChatMessages.push({ role: "user", content: message, time: new Date().toISOString() });
    renderSuggestionChatMessages(true);

    try {
        const data = await apiPost("/api/chat", {
            message,
            paragraph: state.currentParagraph || document.getElementById("suggestion-paragraph").value.trim(),
            candidates: state.currentCandidates || [],
            suggestions: state.currentSuggestions || [],
            history: state.suggestionChatMessages.slice(-8),
        });
        if (data.switched_to_profile) loadDirectories();
        state.suggestionChatMessages.push({ role: "assistant", content: data.reply || "", time: new Date().toISOString() });
        renderSuggestionChatMessages(false);
        await saveSuggestionChatTurn(message, data.reply || "");
    } catch (err) {
        const errStr = err.message || "";
        if (errStr.includes("429") || errStr.includes("daily_limit")) {
            handleQuotaExceeded("Daily limit reached. Buy premium for unlimited access.", "");
        }
        state.suggestionChatMessages.push({ role: "assistant", content: `Error: ${err.message}`, time: new Date().toISOString() });
        renderSuggestionChatMessages(false);
    }
}

function startNewSuggestionChat() {
    state.suggestionChatSessionId = null;
    state.suggestionChatMessages = [];
    renderSuggestionChatMessages(false);
    setSuggestionChatHistoryVisible(false);

    const input = document.getElementById("suggestion-chat-input");
    if (input) input.focus();
}

async function toggleSuggestionChatHistory() {
    const nextVisible = !state.suggestionChatHistoryVisible;
    setSuggestionChatHistoryVisible(nextVisible);
    if (nextVisible) await loadSuggestionChatSessions();
}

function setSuggestionChatHistoryVisible(visible) {
    state.suggestionChatHistoryVisible = visible;
    const area = document.getElementById("suggestion-chat-history");
    const messages = document.getElementById("suggestion-chat-messages");
    const toggle = document.getElementById("suggestion-chat-history-toggle");
    if (area) area.classList.toggle("hidden", !visible);
    if (messages) messages.classList.toggle("hidden", visible);
    if (toggle) {
        toggle.classList.toggle("active", visible);
        toggle.setAttribute("aria-expanded", String(visible));
        toggle.setAttribute("aria-label", visible ? "Hide chat history" : "Show chat history");
    }
}

async function loadSuggestionChatSessions() {
    if (!state.connected) return;
    try {
        const data = await apiGet("/api/chat-sessions");
        const area = document.getElementById("suggestion-chat-history");
        if (!area) return;
        const sessions = data.sessions || [];
        const removeAllBtn = sessions.length ? `<button class="chat-history-remove-all btn-text danger" type="button">Remove all</button>` : '';
        area.innerHTML = `<div class="chat-history-header">${removeAllBtn}</div>` +
            sessions.map(session => `
            <div class="chat-session-card ${session.session_id === state.suggestionChatSessionId ? "active" : ""}" data-session-id="${escapeHtml(session.session_id)}">
                <button class="chat-session-select" type="button" data-session-id="${escapeHtml(session.session_id)}">
                    <span class="chat-session-title">${escapeHtml(session.title || "Untitled")}</span>
                    <span class="chat-session-meta">${escapeHtml(formatHistoryDate(session.updated_at || session.created_at))}</span>
                </button>
                <button class="chat-session-delete" type="button" data-session-id="${escapeHtml(session.session_id)}" title="Delete chat" aria-label="Delete chat">${icon("x")}</button>
            </div>
        `).join("");
        area.querySelector(".chat-history-remove-all")?.addEventListener("click", deleteAllSuggestionChatSessions);
        area.querySelectorAll(".chat-session-select").forEach(btn => {
            btn.addEventListener("click", () => loadSuggestionChatSession(btn.dataset.sessionId));
        });
        area.querySelectorAll(".chat-session-delete").forEach(btn => {
            btn.addEventListener("click", () => deleteSuggestionChatSession(btn.dataset.sessionId));
        });
        refreshIcons(area);
    } catch (err) {
        console.error("Chat history load failed:", err);
        showToast(`Could not load chat history: ${err.message}`, "error");
    }
}

async function loadSuggestionChatSession(sessionId) {
    if (!sessionId) return;
    try {
        const data = await apiGet(`/api/chat-sessions/${sessionId}/messages`);
        state.suggestionChatSessionId = sessionId;
        state.suggestionChatMessages = (data.messages || []).map(message => ({
            role: message.role,
            content: message.content,
            time: message.created_at || "",
        }));
        renderSuggestionChatMessages(false);
        setSuggestionChatHistoryVisible(false);
    } catch (err) {
        showToast(`Could not load chat: ${err.message}`, "error");
    }
}

async function deleteSuggestionChatSession(sessionId) {
    if (!sessionId || !confirm("Delete this chat?")) return;
    try {
        await apiDelete(`/api/chat-sessions/${sessionId}`);
        if (sessionId === state.suggestionChatSessionId) {
            state.suggestionChatSessionId = null;
            state.suggestionChatMessages = [];
            renderSuggestionChatMessages(false);
        }
        await loadSuggestionChatSessions();
    } catch (err) {
        showToast(`Could not delete chat: ${err.message}`, "error");
    }
}

async function deleteAllSuggestionChatSessions() {
    try {
        await apiDelete("/api/chat-sessions");
        state.suggestionChatSessionId = null;
        state.suggestionChatMessages = [];
        renderSuggestionChatMessages(false);
        await loadSuggestionChatSessions();
        showToast("Chat history cleared.", "info");
    } catch (err) {
        showToast(`Could not delete all chats: ${err.message}`, "error");
    }
}

function renderSuggestionChatMessages(typing) {
    const area = document.getElementById("suggestion-chat-messages");
    if (!state.suggestionChatMessages.length && !typing) {
        area.innerHTML = '<p class="empty-state compact">Ask about the current suggestions.</p>';
        return;
    }
    area.innerHTML = state.suggestionChatMessages.map(m => `
        <div class="suggestion-chat-row ${escapeHtml(m.role)}">
            <div class="suggestion-chat-message ${escapeHtml(m.role)}">${m.role === "assistant" ? renderSuggestionChatMarkdown(m.content) : escapeHtml(m.content)}</div>
            <div class="suggestion-chat-time">${escapeHtml(formatChatTime(m.time))}</div>
        </div>
    `).join("") + (typing ? '<div class="suggestion-chat-row assistant"><div class="suggestion-chat-message assistant">Thinking...</div></div>' : "");
    area.scrollTop = area.scrollHeight;
}

function renderSuggestionChatMarkdown(text) {
    const lines = stripSourceLineMarkers(text).replace(/\r\n?/g, "\n").split("\n");
    const html = [];
    let listType = "";

    const closeList = () => {
        if (!listType) return;
        html.push(`</${listType}>`);
        listType = "";
    };

    const openList = (type) => {
        if (listType === type) return;
        closeList();
        listType = type;
        html.push(`<${type} class="chat-md-list">`);
    };

    lines.forEach((rawLine) => {
        const line = rawLine.trimEnd();
        if (!line.trim()) {
            closeList();
            html.push('<div class="chat-md-gap"></div>');
            return;
        }

        const heading = line.match(/^#{1,6}\s+(.+)$/);
        if (heading) {
            closeList();
            html.push(`<div class="chat-md-heading">${renderSuggestionChatInlineMarkdown(heading[1])}</div>`);
            return;
        }

        const unordered = line.match(/^\s*[-*]\s+(.+)$/);
        if (unordered) {
            openList("ul");
            html.push(`<li>${renderSuggestionChatInlineMarkdown(unordered[1])}</li>`);
            return;
        }

        const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
        if (ordered) {
            openList("ol");
            html.push(`<li>${renderSuggestionChatInlineMarkdown(ordered[1])}</li>`);
            return;
        }

        closeList();
        html.push(`<p class="chat-md-paragraph">${renderSuggestionChatInlineMarkdown(line)}</p>`);
    });

    closeList();
    return html.join("");
}

function stripSourceLineMarkers(text) {
    return String(text || "")
        .replace(/【\s*\d+\s*†\s*L?\d+(?:\s*[-–]\s*L?\d+)?\s*】/g, "")
        .replace(/【\s*\d+\s*†\s*L?\d+(?:\s*[-–]\s*L?\d+)?/g, "")
        .replace(/\s+([,.;:!?])/g, "$1")
        .replace(/[ \t]{2,}/g, " ")
        .trim();
}

function renderSuggestionChatInlineMarkdown(text) {
    let s = escapeHtml(text);
    s = s.replace(/`([^`]+)`/g, '<code class="chat-md-code">$1</code>');
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^\w])\*([^*\n]+)\*([^\w]|$)/g, '$1<em>$2</em>$3');
    s = s.replace(/(^|[^\w])_([^_\n]+)_([^\w]|$)/g, '$1<em>$2</em>$3');
    return s;
}

function formatChatTime(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

async function saveSuggestionChatTurn(userMessage, assistantReply) {
    try {
        if (!state.suggestionChatSessionId) {
            const session = await apiPost("/api/chat-sessions", {
                title: userMessage.slice(0, 50),
                suggestion_run_id: state.currentRunId || "",
            });
            state.suggestionChatSessionId = session.session_id;
        }
        await apiPost(`/api/chat-sessions/${state.suggestionChatSessionId}/messages`, {
            role: "user",
            content: userMessage,
        });
        await apiPost(`/api/chat-sessions/${state.suggestionChatSessionId}/messages`, {
            role: "assistant",
            content: assistantReply,
        });
    } catch (err) {
        console.error("Could not save suggestion chat:", err);
    }
}

function parseJsonArray(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function formatHistoryDate(value) {
    if (!value) return "";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatDuration(seconds) {
    const totalSeconds = Math.round(Number(seconds));
    if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return "";
    const minutes = Math.floor(totalSeconds / 60);
    const remainingSeconds = totalSeconds % 60;
    if (minutes <= 0) return `${remainingSeconds}s`;
    if (remainingSeconds === 0) return `${minutes}m`;
    return `${minutes}m${remainingSeconds}s`;
}

function formatHistoryDuration(seconds) {
    const duration = formatDuration(seconds);
    return duration ? ` - ${duration}` : "";
}

function formatHistoryTopK(topK) {
    const value = Number(topK);
    return Number.isFinite(value) && value > 0 ? ` - Top K ${value}` : "";
}

/* ── Document Citations ────────────────────────────────────────────────────── */

async function loadDocumentCitations() {
    if (!state.connected) return;
    try {
        await Word.run(async (context) => {
            const contentControls = context.document.contentControls;
            contentControls.load("id, title, tag, text"); await context.sync();
            state.documentCitations = [];
            contentControls.items.forEach(cc => {
                if (cc.title && cc.title.startsWith(CITATION_MARKER_PREFIX)) {
                    try { state.documentCitations.push({ contentControlId: cc.id, visibleText: cc.text, ...JSON.parse(cc.tag) }); } catch {}
                }
            });
            renderCitationsList();
        });
    } catch (err) { console.error("Error loading citations:", err); }
}

async function renderCitationsList() {
    const container = document.getElementById("citations-list");
    if (!state.documentCitations.length) { container.innerHTML = '<p class="empty-state">No citations inserted yet.</p>'; return; }

    const itemCache = {};
    for (const c of state.documentCitations) {
        for (const item of (c.items || [])) {
            if (!itemCache[item.item_key]) {
                try {
                    const data = await apiGet(`/api/word/items/${item.item_key}`);
                    itemCache[item.item_key] = data;
                } catch {
                    itemCache[item.item_key] = { creators_formatted: "", year: "n.d." };
                }
            }
        }
    }

    container.innerHTML = state.documentCitations.map((c, i) => {
        const labels = c.items.map(it => {
            const meta = itemCache[it.item_key] || {};
            return `${meta.creators_formatted || it.item_key} (${meta.year || "n.d."})`;
        }).join("; ");
        return `<div class="citation-item" data-index="${i}"><div class="citation-text">${escapeHtml(labels)}</div><div class="citation-meta"><span>Style: ${c.style || state.currentStyle}</span><div class="citation-actions"><button class="btn-secondary btn-small btn-edit-citation" data-index="${i}">Edit</button><button class="btn-secondary btn-small btn-remove-citation" data-index="${i}">Remove</button></div></div></div>`;
    }).join("");
    container.querySelectorAll(".btn-edit-citation").forEach(btn => { btn.addEventListener("click", () => openEditModal(parseInt(btn.dataset.index))); });
    container.querySelectorAll(".btn-remove-citation").forEach(btn => { btn.addEventListener("click", () => removeCitation(parseInt(btn.dataset.index))); });
}

async function refreshCitations(options = {}) {
    if (!state.connected) { showToast("Not connected.", "error"); return false; }
    if (!options.silent) showLoading("Refreshing citations...");
    try {
        if (!options.skipScan) await loadDocumentCitations();
        const isNumbered = isNumberedStyle();
        if (isNumbered) { await renumberAllCitations(); }
        else {
            const toRefresh = [...state.documentCitations];
            for (const citation of toRefresh) {
                if (!citation.items || !citation.items.length) continue;
                const formatRes = await apiPost("/api/word/format-citation", {
                    items: citation.items,
                    style: state.currentStyle,
                    citation_format: citation.citation_format || "parenthetical",
                });
                await Word.run(async (context) => {
                    const cc = context.document.contentControls.getById(citation.contentControlId);
                    cc.load("text"); await context.sync();
                    cc.insertText(formatRes.formatted_text, "Replace"); citation.style = state.currentStyle; cc.tag = JSON.stringify(citation);
                    await context.sync();
                });
            }
        }
        if (!options.silent) showToast("Citations refreshed.", "success");
        await loadDocumentCitations();
        return true;
    } catch (err) {
        if (!options.silent) showToast(`Refresh failed: ${err.message}`, "error");
        else throw err;
        return false;
    } finally {
        if (!options.silent) hideLoading();
    }
}

async function renumberAllCitations() {
    const existing = await scanDocumentCitations();
    const orderedKeys = [];
    for (const cc of existing) { for (const item of (cc.items || [])) { if (!orderedKeys.includes(item.item_key)) orderedKeys.push(item.item_key); } }
    const keyToNumber = {};
    orderedKeys.forEach((key, i) => { keyToNumber[key] = i + 1; });
    await Word.run(async (context) => {
        const contentControls = context.document.contentControls;
        contentControls.load("id, title, tag, text"); await context.sync();
        for (const cc of contentControls.items) {
            if (cc.title && cc.title.startsWith(CITATION_MARKER_PREFIX)) {
                try {
                    const data = JSON.parse(cc.tag);
                    const items = data.items || [];
                    const indices = items.map(it => keyToNumber[it.item_key] || 1);
                    cc.insertText(formatNumberedCitation(indices), "Replace");
                    data.style = state.currentStyle;
                    data.numbered_format = state.numberedCitationFormat;
                    cc.tag = JSON.stringify(data);
                } catch {}
            }
        }
        await context.sync();
    });
}

async function removeCitation(index) {
    const citation = state.documentCitations[index];
    if (!citation) return;
    try {
        await Word.run(async (context) => { context.document.contentControls.getById(citation.contentControlId).delete(false); await context.sync(); });
        state.documentCitations.splice(index, 1); await renderCitationsList();
        showToast("Citation removed.", "success");
    } catch (err) { showToast(`Failed: ${err.message}`, "error"); }
}

async function convertToPlainText() {
    if (!state.connected) { showToast("Not connected.", "error"); return; }
    showLoading("Converting citations...");
    try {
        const toConvert = [...state.documentCitations];
        for (const citation of toConvert) {
            await Word.run(async (context) => { context.document.contentControls.getById(citation.contentControlId).delete(false); await context.sync(); });
        }
        state.documentCitations = []; await renderCitationsList();
        showToast("All citations converted to plain text.", "success");
    } catch (err) { showToast(`Conversion failed: ${err.message}`, "error"); } finally { hideLoading(); }
}

/* ── Edit Modal ────────────────────────────────────────────────────────────── */

function isNumberedStyle(style = state.currentStyle) {
    return ["ieee", "vancouver", "nature", "acs", "ama"].includes(style);
}

function updateNumberedFormatVisibility() {
    const group = document.getElementById("numbered-format-group");
    if (!group) return;
    group.classList.toggle("hidden", !isNumberedStyle());
}

function normalizeCitationItem(item) {
    return {
        item_key: item.item_key,
        prefix: item.prefix || "",
        locator: item.locator || "",
        locator_type: item.locator_type || "page",
        suffix: item.suffix || "",
        suppress_author: !!item.suppress_author,
    };
}

function cloneCitationForEdit(citation) {
    return {
        citation_id: citation.citation_id,
        items: (citation.items || []).map(normalizeCitationItem),
        style: state.currentStyle,
        citation_format: citation.citation_format || "parenthetical",
        visibleText: citation.visibleText || "",
    };
}

function initEditModal() {
    document.getElementById("edit-modal-close").addEventListener("click", closeEditModal);
    document.getElementById("edit-cancel-btn").addEventListener("click", closeEditModal);
    document.getElementById("edit-save-btn").addEventListener("click", saveEditCitation);
    document.getElementById("edit-modal").addEventListener("input", handleEditModalInput);
    document.getElementById("edit-modal").addEventListener("change", handleEditModalInput);
}

async function openEditModal(index) {
    const citation = state.documentCitations[index];
    if (!citation || !citation.items || !citation.items.length) return;
    state.editingCitationId = index;
    state.editingCitationDraft = cloneCitationForEdit(citation);
    state.editingItemMeta = {};
    document.getElementById("edit-citation-heading").textContent = "Loading citation...";
    document.getElementById("edit-citation-title").textContent = "";
    document.getElementById("edit-current-citation").textContent = citation.visibleText || "-";
    document.getElementById("edit-items-container").innerHTML = "";
    document.getElementById("edit-preview").textContent = "-";
    document.getElementById("edit-modal").classList.remove("hidden");
    await loadEditItemMetadata(state.editingCitationDraft.items);
    if (state.editingCitationId !== index) return;
    renderEditModal();
    scheduleEditPreview();
}

function closeEditModal() {
    document.getElementById("edit-modal").classList.add("hidden");
    state.editingCitationId = null;
    state.editingCitationDraft = null;
    state.editingItemMeta = {};
    if (state.editPreviewTimer) {
        clearTimeout(state.editPreviewTimer);
        state.editPreviewTimer = null;
    }
}

async function loadEditItemMetadata(items) {
    const entries = await Promise.all(items.map(async (item) => {
        try {
            return [item.item_key, await apiGet(`/api/word/items/${item.item_key}`)];
        } catch {
            return [item.item_key, { item_key: item.item_key, title: "", year: "", creators_formatted: "" }];
        }
    }));
    state.editingItemMeta = Object.fromEntries(entries);
}

function citationItemLabel(item) {
    const meta = state.editingItemMeta[item.item_key] || {};
    const author = meta.creators_formatted || item.item_key;
    const year = meta.year || "n.d.";
    return `${author} (${year})`;
}

function locatorTypeOptions(selected) {
    const options = [
        ["page", "Page"],
        ["chapter", "Chapter"],
        ["section", "Section"],
        ["paragraph", "Paragraph"],
    ];
    return options.map(([value, label]) =>
        `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`
    ).join("");
}

function renderEditModal() {
    const draft = state.editingCitationDraft;
    if (!draft) return;

    const firstItem = draft.items[0];
    const firstMeta = state.editingItemMeta[firstItem.item_key] || {};
    document.getElementById("edit-citation-heading").textContent =
        draft.items.length === 1 ? citationItemLabel(firstItem) : `${draft.items.length} sources in this citation`;
    document.getElementById("edit-citation-title").textContent =
        draft.items.length === 1 ? (firstMeta.title || firstItem.item_key) : "Edit each source separately.";
    document.getElementById("edit-current-citation").textContent = draft.visibleText || "-";

    const numbered = isNumberedStyle();
    document.getElementById("edit-format-section").classList.toggle("hidden", numbered);
    document.getElementById("edit-numbered-note").classList.toggle("hidden", !numbered);
    const formatRadio = document.querySelector(`input[name="edit-citation-format"][value="${draft.citation_format || "parenthetical"}"]`);
    if (formatRadio) formatRadio.checked = true;

    renderEditItems();
}

function renderEditItems() {
    const draft = state.editingCitationDraft;
    if (!draft) return;
    const numbered = isNumberedStyle();
    const narrative = draft.citation_format === "narrative";
    const disabled = numbered ? "disabled" : "";
    const prefixDisabled = numbered || narrative ? "disabled" : "";
    const showSuppressAuthor = !numbered && !narrative;

    document.getElementById("edit-items-container").innerHTML = draft.items.map((item, index) => {
        const meta = state.editingItemMeta[item.item_key] || {};
        const title = meta.title || item.item_key;
        return `
            <div class="citation-edit-item" data-index="${index}">
                <div class="citation-edit-item-header">
                    <div class="citation-edit-item-label">${escapeHtml(citationItemLabel(item))}</div>
                    <div class="citation-edit-item-title">${escapeHtml(title)}</div>
                </div>
                <div class="citation-edit-grid">
                    <div class="settings-group">
                        <label>Prefix</label>
                        <input type="text" class="text-input" data-field="prefix" value="${escapeHtml(item.prefix)}" placeholder="e.g. see" ${prefixDisabled}>
                    </div>
                    <div class="settings-group">
                        <label>Locator type</label>
                        <select class="compact-select" data-field="locator_type" ${disabled}>
                            ${locatorTypeOptions(item.locator_type || "page")}
                        </select>
                    </div>
                    <div class="settings-group">
                        <label>Locator</label>
                        <input type="text" class="text-input" data-field="locator" value="${escapeHtml(item.locator)}" placeholder="e.g. 45" ${disabled}>
                    </div>
                    <div class="settings-group">
                        <label>Suffix</label>
                        <input type="text" class="text-input" data-field="suffix" value="${escapeHtml(item.suffix)}" placeholder="e.g. , and references therein" ${disabled}>
                    </div>
                </div>
                ${showSuppressAuthor ? `
                    <label class="checkbox-row">
                        <input type="checkbox" data-field="suppress_author" ${item.suppress_author ? "checked" : ""}>
                        <span>Suppress author</span>
                    </label>
                ` : ""}
            </div>
        `;
    }).join("");
}

function handleEditModalInput(event) {
    if (!state.editingCitationDraft) return;
    syncEditDraftFromForm();
    if (event.target && event.target.name === "edit-citation-format") {
        renderEditItems();
    }
    scheduleEditPreview();
}

function syncEditDraftFromForm() {
    const draft = state.editingCitationDraft;
    if (!draft) return;
    const selectedFormat = document.querySelector('input[name="edit-citation-format"]:checked');
    draft.citation_format = selectedFormat ? selectedFormat.value : "parenthetical";
    document.querySelectorAll(".citation-edit-item").forEach(row => {
        const index = parseInt(row.dataset.index);
        const item = draft.items[index];
        if (!item) return;
        const prefix = row.querySelector('[data-field="prefix"]');
        const locatorType = row.querySelector('[data-field="locator_type"]');
        const locator = row.querySelector('[data-field="locator"]');
        const suffix = row.querySelector('[data-field="suffix"]');
        const suppressAuthor = row.querySelector('[data-field="suppress_author"]');
        if (prefix) item.prefix = prefix.value;
        if (locatorType) item.locator_type = locatorType.value;
        if (locator) item.locator = locator.value;
        if (suffix) item.suffix = suffix.value;
        if (suppressAuthor) item.suppress_author = suppressAuthor.checked;
    });
}

function scheduleEditPreview() {
    if (state.editPreviewTimer) clearTimeout(state.editPreviewTimer);
    state.editPreviewTimer = setTimeout(updateEditPreview, 250);
}

async function updateEditPreview() {
    const draft = state.editingCitationDraft;
    if (!draft) return;
    syncEditDraftFromForm();
    if (isNumberedStyle()) {
        document.getElementById("edit-preview").textContent = draft.visibleText || "Numbered citation";
        return;
    }
    try {
        const res = await apiPost("/api/word/format-citation", {
            items: draft.items,
            style: state.currentStyle,
            citation_format: draft.citation_format || "parenthetical",
        });
        if (state.editingCitationDraft !== draft) return;
        document.getElementById("edit-preview").textContent = res.formatted_text || "-";
    } catch {
        document.getElementById("edit-preview").textContent = "Preview unavailable.";
    }
}

async function saveEditCitation() {
    const index = state.editingCitationId;
    if (index === null) return;
    const citation = state.documentCitations[index];
    const draft = state.editingCitationDraft;
    if (!citation || !draft || !draft.items || !draft.items.length) return;
    syncEditDraftFromForm();
    const updatedCitation = {
        citation_id: citation.citation_id,
        items: draft.items,
        style: state.currentStyle,
        citation_format: draft.citation_format || "parenthetical",
        numbered_format: state.numberedCitationFormat,
    };
    showLoading("Updating citation...");
    try {
        if (isNumberedStyle()) {
            await Word.run(async (context) => {
                const cc = context.document.contentControls.getById(citation.contentControlId);
                cc.tag = JSON.stringify(updatedCitation);
                await context.sync();
            });
            await renumberAllCitations();
        } else {
            const formatRes = await apiPost("/api/word/format-citation", {
                items: updatedCitation.items,
                style: state.currentStyle,
                citation_format: updatedCitation.citation_format,
            });
            await Word.run(async (context) => {
                const cc = context.document.contentControls.getById(citation.contentControlId);
                cc.insertText(formatRes.formatted_text, "Replace");
                cc.tag = JSON.stringify(updatedCitation);
                await context.sync();
            });
        }
        closeEditModal(); await loadDocumentCitations();
        showToast("Citation updated.", "success");
    } catch (err) { showToast(`Update failed: ${err.message}`, "error"); } finally { hideLoading(); }
}

/* ── Bibliography ──────────────────────────────────────────────────────────── */

function initBibliography() {
    document.getElementById("insert-bibliography-btn").addEventListener("click", insertBibliography);
    document.getElementById("update-bibliography-btn").addEventListener("click", updateBibliography);
}

function bibliographyNeedsHangingIndent(style = state.currentStyle) {
    const normalized = (style || "").toLowerCase();
    return normalized !== "ieee" && normalized !== "vancouver";
}

function bibliographyEntries(text) {
    return (text || "").split(/\r?\n/).map(entry => entry.trim()).filter(Boolean);
}

function applyBibliographyParagraphFormat(paragraph, needsHanging, isHeading = false) {
    paragraph.leftIndent = isHeading || !needsHanging ? 0 : BIBLIOGRAPHY_HANGING_INDENT_POINTS;
    paragraph.firstLineIndent = isHeading || !needsHanging ? 0 : -BIBLIOGRAPHY_HANGING_INDENT_POINTS;
    paragraph.spaceBefore = 0;
    paragraph.spaceAfter = isHeading ? 6 : 0;
}

function buildBibliographyText(bibliography, orderedKeys) {
    const isNumbered = isNumberedStyle();
    const lines = ["References"];
    const entries = bibliographyEntries(bibliography);
    if (isNumbered) {
        for (let i = 0; i < orderedKeys.length && i < entries.length; i++) {
            const entry = entries[i].replace(/^\[\d+\]\s*/, "").trim();
            if (entry) lines.push(`[${i + 1}] ${entry}`);
        }
    } else {
        lines.push(...entries);
    }
    return lines.join("\n");
}

async function getOrderedCitationKeys() {
    const existing = await scanDocumentCitations();
    const orderedKeys = [];
    for (const cc of existing) {
        for (const item of (cc.items || [])) {
            if (!orderedKeys.includes(item.item_key)) orderedKeys.push(item.item_key);
        }
    }
    return orderedKeys;
}

async function insertBibliographyBlock(context, bibliographyText) {
    const body = context.document.body;
    const range = body.insertText(`\n${bibliographyText}`, "End");
    const bibCC = range.insertContentControl();
    bibCC.title = BIBLIOGRAPHY_MARKER;
    bibCC.tag = JSON.stringify({ style: state.currentStyle });
    bibCC.appearance = "Hidden";
    await context.sync();
    await formatBibliographyBlock(context, bibCC);
}

async function formatBibliographyBlock(context, bibCC) {
    const paragraphs = bibCC.paragraphs;
    paragraphs.load("items, text");
    await context.sync();
    const needsHanging = bibliographyNeedsHangingIndent();
    let headingSeen = false;
    for (const p of paragraphs.items) {
        const text = p.text.trim();
        const isHeading = !headingSeen && text === "References";
        if (isHeading) headingSeen = true;
        applyBibliographyParagraphFormat(p, needsHanging, isHeading || !text);
    }
    await context.sync();
}

async function replaceUnmarkedTrailingBibliography(context, bibliographyText) {
    const body = context.document.body;
    const paragraphs = body.paragraphs;
    paragraphs.load("items, text");
    await context.sync();

    let headingIndex = -1;
    for (let i = paragraphs.items.length - 1; i >= 0; i--) {
        if (paragraphs.items[i].text.trim().toLowerCase() === "references") {
            headingIndex = i;
            break;
        }
    }
    if (headingIndex < 0) return false;

    for (let i = paragraphs.items.length - 1; i >= headingIndex; i--) {
        paragraphs.items[i].delete();
    }
    await context.sync();
    await insertBibliographyBlock(context, bibliographyText);
    return true;
}

async function insertBibliography() {
    if (!state.connected) { showToast("Not connected.", "error"); return; }
    showLoading("Generating bibliography...");
    try {
        const orderedKeys = await getOrderedCitationKeys();
        if (!orderedKeys.length) { showToast("No citations in document.", "warning"); hideLoading(); return; }
        const items = orderedKeys.map(k => ({ item_key: k }));
        const res = await apiPost("/api/word/format-bibliography", { items, style: state.currentStyle });
        const bibliographyText = buildBibliographyText(res.bibliography || "", orderedKeys);
        await Word.run(async (context) => {
            await insertBibliographyBlock(context, bibliographyText);
        });
        showToast("Bibliography inserted.", "success");
    } catch (err) { showToast(`Failed: ${err.message}`, "error"); } finally { hideLoading(); }
}

async function updateBibliography(options = {}) {
    if (!state.connected) { showToast("Not connected.", "error"); return false; }
    if (!options.silent) showLoading("Updating bibliography...");
    try {
        const orderedKeys = await getOrderedCitationKeys();
        if (!orderedKeys.length) {
            if (!options.silent) showToast("No citations in document.", "warning");
            return false;
        }
        const items = orderedKeys.map(k => ({ item_key: k }));
        const res = await apiPost("/api/word/format-bibliography", { items, style: state.currentStyle });
        const newText = buildBibliographyText(res.bibliography || "", orderedKeys);
        let didUpdate = false;
        await Word.run(async (context) => {
            const contentControls = context.document.contentControls;
            contentControls.load("id, title, text"); await context.sync();
            let bibCC = null;
            for (const cc of contentControls.items) { if (cc.title === BIBLIOGRAPHY_MARKER) { bibCC = cc; break; } }
            if (bibCC) {
                bibCC.insertText(newText, "Replace");
                bibCC.tag = JSON.stringify({ style: state.currentStyle });
                await context.sync();
                await formatBibliographyBlock(context, bibCC);
                didUpdate = true;
            } else {
                didUpdate = await replaceUnmarkedTrailingBibliography(context, newText);
                if (!didUpdate && options.insertIfMissing !== false) {
                    await insertBibliographyBlock(context, newText);
                    didUpdate = true;
                }
            }
        });
        if (!options.silent) {
            showToast(didUpdate ? "Bibliography updated." : "No bibliography block found.", didUpdate ? "success" : "warning");
        }
        return didUpdate;
    } catch (err) {
        if (!options.silent) showToast(`Update failed: ${err.message}`, "error");
        else throw err;
        return false;
    } finally {
        if (!options.silent) hideLoading();
    }
}

/* ── Settings ──────────────────────────────────────────────────────────────── */

function initSettings() {
    document.getElementById("style-select").addEventListener("change", async (e) => {
        state.currentStyle = e.target.value;
        updateNumberedFormatVisibility();
        const label = e.target.options[e.target.selectedIndex].text;
        if (!state.connected) {
            showToast(`Style changed to ${label}`, "success");
            return;
        }
        showLoading(`Updating document to ${label}...`);
        try {
            await refreshCitations({ silent: true });
            const bibliographyUpdated = await updateBibliography({ silent: true, insertIfMissing: false });
            showToast(
                bibliographyUpdated
                    ? `Document updated to ${label}.`
                    : `Citations updated to ${label}. Insert Bibliography to add a managed reference list.`,
                bibliographyUpdated ? "success" : "warning",
            );
        } catch (err) {
            showToast(`Style changed, but document update failed: ${err.message}`, "error");
        } finally {
            hideLoading();
        }
    });
    updateNumberedFormatVisibility();
    document.getElementById("numbered-format-select").addEventListener("change", async (e) => {
        state.numberedCitationFormat = e.target.value;
        if (!state.connected || !isNumberedStyle()) {
            showToast("Numbered citation format saved.", "success");
            return;
        }
        showLoading("Updating numbered citations...");
        try {
            await renumberAllCitations();
            showToast("Numbered citations updated.", "success");
            await loadDocumentCitations();
        } catch (err) {
            showToast(`Update failed: ${err.message}`, "error");
        } finally {
            hideLoading();
        }
    });
    document.getElementById("dir-filter").addEventListener("change", (e) => { state.sourceDir = e.target.value; });
    document.getElementById("refresh-citations-btn").addEventListener("click", refreshCitations);
    document.getElementById("profile-select")?.addEventListener("change", (e) => { activateProfile(e.target.value); });
}

async function loadDirectories() {
    try {
        const data = await apiGet("/api/settings");
        const dirs = data.reference_dirs || [];
        const dirOptions = ['<option value="">All sources</option>'];
        for (const d of dirs) { const label = d.label || d.path; dirOptions.push(`<option value="${escapeHtml(d.path)}">${escapeHtml(label)}</option>`); }
        document.getElementById("dir-filter").innerHTML = dirOptions.join("");
        document.getElementById("search-filter").innerHTML = dirOptions.join("");
        document.getElementById("suggestion-dir-filter").innerHTML = dirOptions.join("");
        document.getElementById("server-info").textContent = `${_apiBase} (Port: ${data.app_port || 443})`;

        const profiles = data.ai_profiles || [];
        const activeProfileName = data.active_profile || "";
        state.activeProfileName = activeProfileName;
        const profileSelect = document.getElementById("profile-select");
        if (profileSelect) {
            profileSelect.innerHTML = profiles.length
                ? profiles.map(p => `<option value="${escapeHtml(p.name)}" ${p.name === activeProfileName ? "selected" : ""}>${escapeHtml(p.name)}${p.provider_label ? " · " + escapeHtml(p.provider_label) : ""}</option>`).join("")
                : '<option value="">No profiles configured</option>';
        }
        updateActiveProfileBadge(activeProfileName);

        const active = profiles.find(p => p.name === activeProfileName);
        const sugTemp = active?.suggestion_temperature ?? data.suggestion_temperature ?? 0.1;
        const sugTopK = active?.suggestion_top_k ?? data.suggestion_top_k ?? 15;
        const tempEl = document.getElementById("suggestion-temp");
        const tempValEl = document.getElementById("suggestion-temp-val");
        if (tempEl) { tempEl.value = sugTemp; tempValEl.textContent = parseFloat(sugTemp).toFixed(2); }
        const topKEl = document.getElementById("suggestion-top-k");
        const topKValEl = document.getElementById("suggestion-top-k-val");
        if (topKEl) { topKEl.value = sugTopK; topKValEl.textContent = String(sugTopK); }

        renderTpProfileMenu(profiles, activeProfileName);
        loadQuotaBalance();
    } catch {}
}

function updateActiveProfileBadge(name) {
    const badge = document.getElementById("active-profile-badge");
    if (!badge) return;
    badge.textContent = name || "";
    badge.classList.toggle("hidden", !name);
}

async function activateProfile(name) {
    if (!name) return;
    try {
        await apiPost("/api/settings/profiles/activate", { name });
        state.activeProfileName = name;
        updateActiveProfileBadge(name);
        loadDirectories();
    } catch (err) {
        showToast(`Could not switch profile: ${err.message}`, "error");
    }
}

function initCitations() {}

/* ── Quota Exceeded Handler ─────────────────────────────────────────────────── */

function handleQuotaExceeded(message, buyUrl) {
    const msg = message || "Daily limit reached. Buy premium for unlimited access.";
    showToast(msg, "error");
    if (buyUrl) {
        setTimeout(() => window.open(buyUrl, "_blank"), 500);
    }
    loadQuotaBalance();
}

/* ── Profile Dropdown (Suggestion tab) ─────────────────────────────────────── */

function initTpProfileDropdown() {
    bindTpProfileButton("tp-profile-btn", "tp-profile-menu");
    bindTpProfileButton("suggestion-chat-profile-toggle", "suggestion-chat-profile-menu");
    document.addEventListener("click", () => {
        if (!_tpProfileMenuOpen) return;
        closeTpProfileMenus();
    });
}

function bindTpProfileButton(btnId, menuId) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const nextOpen = _tpProfileMenuOpen === menuId ? "" : menuId;
        closeTpProfileMenus();
        _tpProfileMenuOpen = nextOpen;
        const menu = document.getElementById(menuId);
        if (menu) menu.classList.toggle("hidden", !nextOpen);
        btn.setAttribute("aria-expanded", String(Boolean(nextOpen)));
    });
}

function closeTpProfileMenus() {
    _tpProfileMenuOpen = "";
    ["tp-profile-menu", "suggestion-chat-profile-menu"].forEach(id => {
        document.getElementById(id)?.classList.add("hidden");
    });
    ["tp-profile-btn", "suggestion-chat-profile-toggle"].forEach(id => {
        document.getElementById(id)?.setAttribute("aria-expanded", "false");
    });
}

function profileMenuHtml(profiles, activeProfileName) {
    if (!profiles || !profiles.length) {
        return '<div class="tp-profile-empty">No profiles</div>';
    }
    return profiles.map(p => {
        const pLabel = `${p.provider_label ? p.provider_label + ": " : ""}${p.ai_model || p.name}`;
        const isActive = p.name === activeProfileName;
        return `<button class="tp-profile-item ${isActive ? "active" : ""}" data-profile="${escapeHtml(p.name)}">${escapeHtml(pLabel)}${isActive ? ' <span class="tp-profile-check">' + icon("check") + '</span>' : ""}</button>`;
    }).join("");
}

function renderTpProfileMenu(profiles, activeProfileName) {
    const active = (profiles || []).find(p => p.name === activeProfileName);
    const label = document.getElementById("tp-profile-label");
    if (label) {
        label.textContent = active ? `${active.provider_label ? active.provider_label + ": " : ""}${active.ai_model || active.name}` : "No profile";
    }

    ["tp-profile-menu", "suggestion-chat-profile-menu"].forEach(menuId => {
        const menu = document.getElementById(menuId);
        if (!menu) return;
        menu.innerHTML = profileMenuHtml(profiles, activeProfileName);
        bindTpProfileMenuItems(menu);
        refreshIcons(menu);
    });
}

function bindTpProfileMenuItems(menu) {
    menu.querySelectorAll(".tp-profile-item").forEach(item => {
        item.addEventListener("click", (e) => {
            e.stopPropagation();
            const profileName = item.dataset.profile;
            closeTpProfileMenus();
            if (profileName && profileName !== (state.activeProfileName || "")) {
                activateProfile(profileName);
            }
        });
    });
}

/* ── TarCite AI Quota ───────────────────────────────────────────────────────── */

async function loadQuotaBalance() {
    if (!state.connected) return;
    try {
        const data = await apiGet("/api/billing/balance");
        state.quotaData = data;
        renderTpQuotaPanel(data);
    } catch (err) {
        const panel = document.getElementById("tp-quota-panel");
        if (panel) panel.innerHTML = '<div class="tp-quota-note">Could not load quota info.</div>';
    }
}

function renderTpQuotaPanel(data) {
    const panel = document.getElementById("tp-quota-panel");
    if (!panel) return;

    if (data.error && !data.tier && !data.tier_usage) {
        panel.innerHTML = '<div class="tp-quota-note">Quota info unavailable for current profile.</div>';
        return;
    }

    const tierUsage = data.tier_usage || [];
    const creditsRemaining = data.credits_remaining || 0;
    const hasCredits = creditsRemaining > 0;
    const approxRemaining = data.approx_requests_remaining || 0;
    let html = "";

    if (hasCredits) {
        html += `
            <div class="tp-quota-section">
                <div class="tp-quota-row">
                    <span class="tp-quota-label">Credits</span>
                    <span class="tp-quota-value">${approxRemaining} requests</span>
                </div>
            </div>
            <hr class="tp-quota-divider">
        `;
    }

    for (const tier of tierUsage) {
        const limit = tier.daily_limit || 0;
        const used = tier.used_today || 0;
        const remaining = limit - used;
        const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
        const barClass = pct >= 100 ? "exhausted" : pct >= 80 ? "low" : "ok";
        const groupLabel = tier.group === "default" ? "Daily Free Tier" : tier.group.charAt(0).toUpperCase() + tier.group.slice(1);
        html += `
            <div class="tp-quota-section">
                <div class="tp-quota-row">
                    <span class="tp-quota-label">${escapeHtml(groupLabel)}</span>
                    <span class="tp-quota-value ${remaining <= 3 ? (remaining <= 0 ? "danger" : "warn") : ""}">${used}/${limit} req</span>
                </div>
                <div class="tp-quota-bar-track"><div class="tp-quota-bar-fill ${barClass}" style="width:${pct}%"></div></div>
            </div>
        `;
    }

    html += `
        <hr class="tp-quota-divider">
        <div class="tp-quota-buy-row">
            <span class="tp-quota-label" style="font-size:12px">Buy premium:</span>
            <span class="tp-quota-label" style="font-size:11px">$</span>
            <input type="number" id="tp-buy-amount" class="tp-buy-input" value="3" min="3" max="100" step="1">
            <button id="tp-buy-btn" class="tp-buy-btn" onclick="buyPremium()">Buy Premium</button>
        </div>
        <div class="tp-quota-note">$1 = ~${data.requests_per_dollar || 100} requests. Minimum $${Math.round((data.minimum_payment_cents || 300) / 100)}. Payment via Stripe.</div>
    `;

    panel.innerHTML = html;
}

async function buyPremium() {
    const input = document.getElementById("tp-buy-amount");
    const btn = document.getElementById("tp-buy-btn");
    if (!input || !btn) return;
    const dollars = parseFloat(input.value);
    if (!dollars || dollars < 3) { showToast("Minimum purchase is $3.", "warning"); return; }
    if (dollars > 100) { showToast("Maximum purchase is $100.", "warning"); return; }
    const cents = Math.round(dollars * 100);
    btn.disabled = true;
    btn.textContent = "Opening...";
    try {
        const data = await apiPost("/api/billing/checkout", { amount_cents: cents });
        if (data.url) {
            window.open(data.url, "_blank");
            showToast("Checkout page opened in browser.", "success");
        }
    } catch (err) {
        showToast(`Checkout failed: ${err.message}`, "error");
    } finally {
        btn.disabled = false;
        btn.textContent = "Buy Premium";
    }
}

/* ── Utilities ─────────────────────────────────────────────────────────────── */

function generateId() { return Math.random().toString(36).substring(2, 10) + Date.now().toString(36); }
function escapeHtml(str) { if (str === null || str === undefined) return ""; return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function showLoading(text) { document.getElementById("loading-text").textContent = text || "Loading..."; document.getElementById("loading-overlay").classList.remove("hidden"); }
function hideLoading() { document.getElementById("loading-overlay").classList.add("hidden"); }
function showToast(message, type = "info") {
    const container = document.getElementById("toast-container");
    const toast = document.createElement("div");
    toast.className = `toast ${type}`; toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => { toast.style.opacity = "0"; toast.style.transition = "opacity 0.3s"; setTimeout(() => toast.remove(), 300); }, 3000);
}
