/* ── TarCite Workspace - Shared Utilities ─────────────────────────────────── */

function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function escapeJs(str) {
    if (!str) return '';
    return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"');
}

function icon(name, className = '') {
    const cls = className ? ` class="${escapeHtml(className)}"` : '';
    return `<i data-lucide="${escapeHtml(name)}"${cls} aria-hidden="true"></i>`;
}

function refreshIcons(root = document) {
    if (!window.lucide || !root) return;
    window.lucide.createIcons({
        attrs: {
            'stroke-width': 2,
            'aria-hidden': 'true',
        },
    });
}

function formatHistoryDate(value) {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatDuration(seconds) {
    const totalSeconds = Math.round(Number(seconds));
    if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '';
    const minutes = Math.floor(totalSeconds / 60);
    const remainingSeconds = totalSeconds % 60;
    if (minutes <= 0) return `${remainingSeconds}s`;
    if (remainingSeconds === 0) return `${minutes}m`;
    return `${minutes}m${remainingSeconds}s`;
}

function formatHistoryDuration(seconds) {
    const duration = formatDuration(seconds);
    return duration ? ` &middot; ${duration}` : '';
}

function formatHistoryTopK(topK) {
    const value = Number(topK);
    return Number.isFinite(value) && value > 0 ? ` &middot; Top K ${value}` : '';
}

function formatHistoryTemp(temp) {
    if (temp === null || temp === undefined || temp === '') return '';
    const value = Number(temp);
    return Number.isFinite(value) ? ` &middot; T ${value}` : '';
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

/* ── PDF text normalisation ────────────────────────────────────────────────
   Text pulled out of a pdf.js text layer arrives one *visual* line at a time:
   every soft wrap is a newline, and words the typesetter broke across lines
   keep their hyphen ("seques-\ntration").  Pasted into a manuscript that reads
   as ragged, mis-spelt prose, so everything leaving the viewer as text — the
   clipboard, the translator, and the quote stored on an annotation — is run
   through here first.  Verbatim text stays available (Shift-click Copy) for
   when the layout itself matters, e.g. copying a table or a code listing. */

const PDF_LIGATURES = {
    'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi',
    'ﬄ': 'ffl', 'ﬅ': 'ft', 'ﬆ': 'st',
};

// Combining forms whose hyphen belongs to the word rather than to the line
// break, so "socio-\neconomic" stays hyphenated while "seques-\ntration" is
// rejoined.  A dictionary would settle every case; this covers the prefixes
// that actually recur in academic prose.
const PDF_COMPOUND_PREFIXES = new Set([
    'anti', 'auto', 'bio', 'co', 'counter', 'cross', 'de', 'eco', 'ex', 'extra',
    'geo', 'high', 'hyper', 'inter', 'intra', 'long', 'low', 'macro', 'meta',
    'micro', 'mid', 'multi', 'neo', 'non', 'over', 'post', 'pre', 'pro',
    'pseudo', 'quasi', 're', 'self', 'semi', 'short', 'socio', 'sub', 'super',
    'trans', 'ultra', 'un', 'under', 'well',
]);

function isPdfLineBreakHyphen(before, after) {
    const tail = /([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ]*)-$/.exec(before);
    if (!tail) return false;                       // nothing word-like before the hyphen
    if (!/^[a-zà-ÿ]/.test(after)) return false;    // continuation must look like a word tail
    const stem = tail[1];
    if (PDF_COMPOUND_PREFIXES.has(stem.toLowerCase())) return false;
    if (/[A-ZÀ-Þ]/.test(stem.slice(1))) return false;  // inner capital → likely a real compound
    return true;
}

/* A word split across a line break is put back together with no space either
   way — the only question the hyphen poses is whether it survives the join. */
function joinPdfLines(before, after) {
    const brokenWord = /[A-Za-zÀ-ÿ]-$/.test(before) && /^[A-Za-zÀ-ÿ]/.test(after);
    if (!brokenWord) return before + ' ' + after;
    return isPdfLineBreakHyphen(before, after)
        ? before.slice(0, -1) + after     // "seques-" + "tration"
        : before + after;                 // "socio-" + "economic"
}

/* A pdf.js selection loses paragraph boundaries: consecutive lines are just
   newlines whether or not a paragraph ended.  A line that both ends a sentence
   and stops noticeably short of the block's measure is where a paragraph ended,
   which is the standard reflow heuristic; it needs a few lines to estimate the
   measure from, so short selections are left alone. */
function splitPdfParagraphs(lines) {
    if (lines.length < 3) return [lines];
    const measure = Math.max(...lines.map(l => l.length));
    const blocks = [[]];
    lines.forEach((line, i) => {
        blocks[blocks.length - 1].push(line);
        const isLast = i === lines.length - 1;
        const endsSentence = /[.!?]["'”’)\]]?$/.test(line);
        if (!isLast && endsSentence && line.length < measure * 0.85) blocks.push([]);
    });
    return blocks.filter(b => b.length);
}

function normalizePdfText(text) {
    if (!text) return '';

    const cleaned = String(text)
        .replace(/\r\n?/g, '\n')
        .replace(/[­​‌﻿]/g, '')   // soft hyphen, zero-width marks
        .replace(/[ﬀ-ﬆ]/g, ch => PDF_LIGATURES[ch] || ch)
        .replace(/[ \t   ]+/g, ' ');     // collapse spaces incl. NBSP

    // Explicit blank lines are a real break the PDF gave us; keep them.
    const sourceBlocks = cleaned.split('\n')
        .map(l => l.trim())
        .join('\n')
        .split(/\n{2,}/)
        .map(block => block.split('\n').filter(Boolean))
        .filter(lines => lines.length);

    const paragraphs = [];
    sourceBlocks.forEach(lines => {
        splitPdfParagraphs(lines).forEach(block => {
            let out = '';
            block.forEach((line, i) => {
                out = i === 0 ? line : joinPdfLines(out, line);
            });
            paragraphs.push(out);
        });
    });

    return paragraphs
        .join('\n\n')
        .replace(/ +([,.;:!?])/g, '$1')
        .replace(/ {2,}/g, ' ')
        .trim();
}

function debounce(fn, delay) {
    let timer;
    return function(...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), delay);
    };
}

const _inFlightAsync = new Map();

function dedupeAsync(key, loader, options = {}) {
    if (!options.force && _inFlightAsync.has(key)) return _inFlightAsync.get(key);
    let promise;
    promise = Promise.resolve()
        .then(loader)
        .finally(() => {
            if (_inFlightAsync.get(key) === promise) _inFlightAsync.delete(key);
        });
    _inFlightAsync.set(key, promise);
    return promise;
}
