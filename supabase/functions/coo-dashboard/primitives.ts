export const JS_PRIMITIVES = String.raw`function showToast(message, type = 'success') {
const el = document.createElement('div');el.className = 'toast toast-' + type;el.textContent = message;document.body.appendChild(el);setTimeout(() => el.remove(), 3000);
}
function createCard(containerId, title, count) {
const card = document.createElement('div');card.className = 'card';card.id = 'card-' + containerId;const hdr = document.createElement('div');hdr.className = 'card-header';hdr.innerHTML = '<h3>' + escapeHtml(title) + '<\/h3>' + (count != null ? '<span class="card-count">' + count + '<\/span>' : '');const body = document.createElement('div');body.className = 'card-body';body.id = containerId;card.appendChild(hdr);card.appendChild(body);return card;
}
function cardLoading(containerId) {
const el = document.getElementById(containerId);if (!el) return;el.innerHTML = '<div class="shimmer" style="width:80%"><\/div><div class="shimmer" style="width:60%"><\/div><div class="shimmer" style="width:70%"><\/div>';
}
function cardSuccess(containerId, html) {
const el = document.getElementById(containerId);if (!el) return;el.innerHTML = html;
}
function cardEmpty(containerId, message) {
const el = document.getElementById(containerId);if (!el) return;el.innerHTML = '<div class="card-empty">' + escapeHtml(message || 'No data') + '<\/div>';
}
function cardError(containerId, message, retryFn) {
const el = document.getElementById(containerId);if (!el) return;el.innerHTML = '<div class="card-error"><p>' + escapeHtml(message) + '<\/p>' +
(retryFn ? '<button class="btn-retry" onclick="' + retryFn + '()">Retry<\/button>' : '') + '<\/div>';
}
function updateCardCount(containerId, count) {
const card = document.getElementById('card-' + containerId);if (!card) return;const badge = card.querySelector('.card-count');if (badge) badge.textContent = count;
}
function escapeHtml(str) {
if (str == null) return '';return String(str).replace(/&/g,'&amp;').replace(/\x3c/g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function formatDate(d) {
if (!d) return '\u2014';const dt = new Date(d);if (isNaN(dt)) return '\u2014';return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function formatTime(d) {
if (!d) return '\u2014';const dt = new Date(d);if (isNaN(dt)) return '\u2014';return dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/Phoenix' });
}
function formatCurrency(n) {
if (n == null) return '\u2014';return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}
function daysAgo(d) {
if (!d) return null;const diff = Math.floor((Date.now() - new Date(d).getTime()) / 86400000);return diff;
}
function staleBadge(days) {
if (days == null) return '';if (days > 90) return '<span class="badge badge-error">' + days + 'd<\/span>';if (days > 30) return '<span class="badge badge-warning">' + days + 'd<\/span>';if (days > 14) return '<span class="badge badge-info">' + days + 'd<\/span>';return '<span class="badge badge-muted">' + days + 'd<\/span>';
}
function statusBadge(status) {
const map = {
now: 'badge-error', in_review: 'badge-warning', next: 'badge-info',
new: 'badge-muted', waiting: 'badge-warning', in_queue: 'badge-info',
pending: 'badge-warning', healthy: 'badge-success', critical: 'badge-error',
stale: 'badge-warning', warning: 'badge-warning',
};const cls = map[status] || 'badge-muted';return '<span class="badge ' + cls + '">' + escapeHtml(status || '\u2014') + '<\/span>';
}
function clientBadge(name) {
if (!name) return '<span class="badge badge-muted">Unknown<\/span>';return '<span class="badge badge-info">' + escapeHtml(name) + '<\/span>';
}
function linkIcon(url) {
if (!url) return '';return '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener">&#8599;<\/a>';
}
function renderSortableTable(containerId, columns, rows, opts) {
opts = opts || {};const pageSize = opts.pageSize || 25;let currentPage = 0;let sortCol = opts.defaultSort || null;let sortDir = opts.defaultSortDir || 'asc';let filterText = '';function render() {
let filtered = rows;if (filterText) {
const q = filterText.toLowerCase();filtered = rows.filter(r => columns.some(c => String(r[c.key] || '').toLowerCase().includes(q)));
}
if (sortCol) {
filtered = [...filtered].sort((a, b) => {
let va = a[sortCol], vb = b[sortCol];if (va == null) va = '';if (vb == null) vb = '';if (typeof va === 'number' && typeof vb === 'number') return sortDir === 'asc' ? va - vb : vb - va;return sortDir === 'asc' ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va));
});
}
const total = filtered.length;const pages = Math.ceil(total / pageSize) || 1;if (currentPage >= pages) currentPage = pages - 1;const start = currentPage * pageSize;const pageRows = filtered.slice(start, start + pageSize);let html = '';if (rows.length > 10) {
html += '<div class="filter-bar"><input type="text" placeholder="Search..." value="' + escapeHtml(filterText) + '" onkeyup="window._tblFilter_' + containerId + '(this.value)"><\/div>';
}
html += '<table class="data-table"><thead><tr>';columns.forEach(c => {
const isSorted = sortCol === c.key;const arrow = isSorted ? (sortDir === 'asc' ? ' \u25B2' : ' \u25BC') : ' \u25B4';html += '<th class="' + (isSorted ? 'sorted' : '') + '" onclick="window._tblSort_' + containerId + '(\'' + c.key + '\')">' + escapeHtml(c.label) + '<span class="sort-icon">' + arrow + '<\/span><\/th>';
});html += '<\/tr><\/thead><tbody>';if (pageRows.length === 0) {
html += '<tr><td colspan="' + columns.length + '" style="text-align:center;color:var(--text-dim);padding:1rem">No results<\/td><\/tr>';
} else {
pageRows.forEach(r => {
html += '<tr>';columns.forEach(c => {
const val = c.render ? c.render(r) : escapeHtml(r[c.key]);html += '<td>' + val + '<\/td>';
});html += '<\/tr>';
});
}
html += '<\/tbody><\/table>';if (total > pageSize) {
html += '<div class="pagination"><span>' + (start + 1) + '-' + Math.min(start + pageSize, total) + ' of ' + total + '<\/span><div>';html += '<button ' + (currentPage === 0 ? 'disabled' : '') + ' onclick="window._tblPage_' + containerId + '(' + (currentPage - 1) + ')">Prev<\/button> ';html += '<button ' + (currentPage >= pages - 1 ? 'disabled' : '') + ' onclick="window._tblPage_' + containerId + '(' + (currentPage + 1) + ')">Next<\/button>';html += '<\/div><\/div>';
}
cardSuccess(containerId, html);
}
window['_tblSort_' + containerId] = function(col) {
if (sortCol === col) sortDir = sortDir === 'asc' ? 'desc' : 'asc';else { sortCol = col; sortDir = 'asc'; }
render();
};window['_tblFilter_' + containerId] = function(val) { filterText = val; currentPage = 0; render(); };window['_tblPage_' + containerId] = function(p) { currentPage = p; render(); };render();
}
`;
