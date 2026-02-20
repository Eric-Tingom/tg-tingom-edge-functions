export const JS_SYS = String.raw`function loadSystem(container) {
const subNav = document.createElement('div');subNav.className = 'sub-tabs';const tabs = [
{ id: 'sys-cron', label: 'Cron Jobs', loader: loadCronJobs },
{ id: 'sys-http', label: 'HTTP Log', loader: loadHttpLog },
{ id: 'sys-agents', label: 'Agent Registry', loader: loadAgentRegistry },
{ id: 'sys-brains', label: 'Brains', loader: null },
{ id: 'sys-config', label: 'Configuration', loader: null },
];const contentDiv = document.createElement('div');contentDiv.className = 'sub-content';contentDiv.id = 'sys-content';let activeSubTab = 'sys-cron';function renderSubTabs() {
subNav.innerHTML = '';tabs.forEach(t => {
const tab = document.createElement('div');tab.className = 'sub-tab' + (t.id === activeSubTab ? ' active' : '');tab.textContent = t.label;tab.onclick = () => {
activeSubTab = t.id;renderSubTabs();contentDiv.innerHTML = '';if (t.loader) t.loader(contentDiv);else contentDiv.innerHTML = '<div class="placeholder-pillar"><h2>' + escapeHtml(t.label) + '<\/h2><p>Coming in Phase 2<\/p><\/div>';
};subNav.appendChild(tab);
});
}
renderSubTabs();container.appendChild(subNav);container.appendChild(contentDiv);loadCronJobs(contentDiv);
}
async function loadCronJobs(container) {
container.innerHTML = '<div style="padding:1rem"><div class="shimmer" style="width:80%"><\/div><div class="shimmer" style="width:60%"><\/div><\/div>';try {
const { data, error } = await sb.rpc('get_cron_job_status');if (error) throw error;const jobs = data || [];let showActiveOnly = true;function render() {
const filtered = showActiveOnly ? jobs.filter(j => j.active) : jobs;let html = '<div class="filter-bar"><label class="toggle-wrap"><input type="checkbox" ' + (showActiveOnly ? 'checked' : '') + ' onchange="window._cronToggle(this.checked)"> Active only<\/label><\/div>';html += '<table class="data-table"><thead><tr><th>Job Name<\/th><th>Schedule<\/th><th>Active<\/th><\/tr><\/thead><tbody>';if (filtered.length === 0) {
html += '<tr><td colspan="3" style="text-align:center;color:var(--text-dim)">No jobs<\/td><\/tr>';
} else {
filtered.forEach(j => {
html += '<tr><td>' + escapeHtml(j.jobname) + '<\/td><td><code style="font-size:0.75rem;color:var(--text-muted)">' + escapeHtml(j.schedule) + '<\/code><\/td><td>' + (j.active ? '<span class="badge badge-success">Active<\/span>' : '<span class="badge badge-muted">Inactive<\/span>') + '<\/td><\/tr>';
});
}
html += '<\/tbody><\/table>';container.innerHTML = html;
}
window._cronToggle = function(checked) { showActiveOnly = checked; render(); };render();
} catch (e) {
container.innerHTML = '<div class="card-error"><p>' + escapeHtml(e.message || 'Failed to load cron jobs') + '<\/p><\/div>';
}
}
async function loadHttpLog(container) {
container.innerHTML = '<div style="padding:1rem"><div class="shimmer" style="width:80%"><\/div><div class="shimmer" style="width:60%"><\/div><\/div>';try {
const { data, error } = await sb.rpc('get_cron_http_responses', { p_limit: 50 });if (error) throw error;const logs = data || [];let errorsOnly = false;function render() {
const filtered = errorsOnly ? logs.filter(l => l.status_code !== 200 || l.timed_out || l.error_msg) : logs;let html = '<div class="filter-bar"><label class="toggle-wrap"><input type="checkbox" ' + (errorsOnly ? 'checked' : '') + ' onchange="window._httpToggle(this.checked)"> Errors only<\/label><\/div>';html += '<table class="data-table"><thead><tr><th>ID<\/th><th>Status<\/th><th>Error<\/th><th>Time<\/th><\/tr><\/thead><tbody>';if (filtered.length === 0) {
html += '<tr><td colspan="4" style="text-align:center;color:var(--text-dim)">No entries<\/td><\/tr>';
} else {
filtered.forEach(l => {
const isErr = l.status_code !== 200 || l.timed_out || l.error_msg;const statusHtml = l.timed_out ? '<span class="badge badge-error">Timeout<\/span>' : l.status_code ? (l.status_code === 200 ? '<span class="badge badge-success">200<\/span>' : '<span class="badge badge-error">' + l.status_code + '<\/span>') : '<span class="badge badge-muted">\u2014<\/span>';const errMsg = l.error_msg ? escapeHtml(l.error_msg.substring(0,80)) : '\u2014';html += '<tr><td>' + l.id + '<\/td><td>' + statusHtml + '<\/td><td>' + errMsg + '<\/td><td style="white-space:nowrap">' + formatDate(l.created) + '<\/td><\/tr>';
});
}
html += '<\/tbody><\/table>';container.innerHTML = html;
}
window._httpToggle = function(checked) { errorsOnly = checked; render(); };render();
} catch (e) {
container.innerHTML = '<div class="card-error"><p>' + escapeHtml(e.message || 'Failed to load HTTP log') + '<\/p><\/div>';
}
}
async function loadAgentRegistry(container) {
container.innerHTML = '<div style="padding:1rem"><div class="shimmer" style="width:80%"><\/div><div class="shimmer" style="width:60%"><\/div><\/div>';try {
const { data, error } = await sb.from('assistants').select('assistant_id, assistant_name, agent_type, brain, is_active, category, functional_domains, last_active_at').eq('is_active', true).order('assistant_name');if (error) throw error;const agents = data || [];const types = [...new Set(agents.map(a => a.agent_type).filter(Boolean))].sort();let searchText = '';let typeFilter = '';function render() {
let filtered = agents;if (searchText) {
const q = searchText.toLowerCase();filtered = filtered.filter(a => (a.assistant_name || '').toLowerCase().includes(q) || (a.assistant_id || '').toLowerCase().includes(q) || (a.category || '').toLowerCase().includes(q));
}
if (typeFilter) {
filtered = filtered.filter(a => a.agent_type === typeFilter);
}
let html = '<div class="filter-bar">';html += '<input type="text" placeholder="Search agents..." value="' + escapeHtml(searchText) + '" oninput="window._agentSearch(this.value)">';html += '<select onchange="window._agentTypeFilter(this.value)"><option value="">All types<\/option>';types.forEach(t => { html += '<option value="' + escapeHtml(t) + '"' + (typeFilter === t ? ' selected' : '') + '>' + escapeHtml(t) + '<\/option>'; });html += '<\/select>';html += '<span style="color:var(--text-muted);font-size:0.8rem">' + filtered.length + ' agents<\/span>';html += '<\/div>';html += '<table class="data-table"><thead><tr><th>Agent<\/th><th>Type<\/th><th>Brain<\/th><th>Category<\/th><\/tr><\/thead><tbody>';filtered.forEach(a => {
html += '<tr><td><strong>' + escapeHtml(a.assistant_name) + '<\/strong><br><span style="font-size:0.7rem;color:var(--text-dim)">' + escapeHtml(a.assistant_id) + '<\/span><\/td><td>' + statusBadge(a.agent_type) + '<\/td><td>' + (a.brain ? '<span class="badge badge-info">' + escapeHtml(a.brain) + '<\/span>' : '<span class="badge badge-muted">\u2014<\/span>') + '<\/td><td>' + escapeHtml(a.category || '\u2014') + '<\/td><\/tr>';
});html += '<\/tbody><\/table>';container.innerHTML = html;
}
window._agentSearch = function(val) { searchText = val; render(); };window._agentTypeFilter = function(val) { typeFilter = val; render(); };render();
} catch (e) {
container.innerHTML = '<div class="card-error"><p>' + escapeHtml(e.message || 'Failed to load agents') + '<\/p><\/div>';
}
}
`;
