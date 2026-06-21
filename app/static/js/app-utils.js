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
