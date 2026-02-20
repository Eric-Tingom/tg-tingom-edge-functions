export const JS_OPS = String.raw`function loadOperations(container) {
const grid = document.createElement('div');grid.className = 'card-grid';const cards = [
{ id: 'now-items', title: 'Now Items', loader: loadNowItems },
{ id: 'todays-calendar', title: "Today's Calendar", loader: loadTodaysCalendar },
{ id: 'overdue-tickets', title: 'Overdue Tickets', loader: loadOverdueTickets },
{ id: 'retainer-billing', title: 'Retainer Billing', loader: loadRetainerBilling },
{ id: 'email-triage', title: 'Email Triage', loader: loadEmailTriage },
{ id: 'carry-forward', title: 'Carry Forward', loader: loadCarryForward },
{ id: 'stale-waiting', title: 'Stale / Waiting', loader: loadStaleWaiting },
{ id: 'open-tickets', title: 'Open Tickets', loader: loadOpenTickets },
{ id: 'time-entry', title: 'Time Entry', loader: loadTimeEntry },
];cards.forEach(c => {
grid.appendChild(createCard(c.id, c.title));c.loader();
});container.appendChild(grid);
}
async function loadNowItems() {
cardLoading('now-items');try {
const { data, error } = await sb.rpc('get_standup_now_items');if (error) { await handleCardError('now-items', 'get_standup_now_items', error, 'loadNowItems'); return; }
const items = data || [];if (items.length === 0) { cardEmpty('now-items', 'No active now items'); return; }
updateCardCount('now-items', items.length);let html = '<table class="data-table"><thead><tr><th>Task<\/th><th>Client<\/th><th>Due<\/th><th><\/th><\/tr><\/thead><tbody>';items.forEach(i => {
html += '<tr><td>' + escapeHtml(i.title) + '<\/td><td>' + clientBadge(i.client_name) + '<\/td><td>' + formatDate(i.due_date) + '<\/td><td>' + linkIcon(i.hubspot_ticket_url) + '<\/td><\/tr>';
});html += '<\/tbody><\/table>';cardSuccess('now-items', html);
} catch (e) { await handleCardError('now-items', 'get_standup_now_items', e, 'loadNowItems'); }
}
async function loadTodaysCalendar() {
cardLoading('todays-calendar');try {
const { data, error } = await sb.rpc('get_standup_todays_calendar');if (error) { await handleCardError('todays-calendar', 'get_standup_todays_calendar', error, 'loadTodaysCalendar'); return; }
const items = data || [];if (items.length === 0) { cardEmpty('todays-calendar', 'No meetings today'); return; }
updateCardCount('todays-calendar', items.length);let html = '<table class="data-table"><thead><tr><th>Time<\/th><th>Meeting<\/th><th>Client<\/th><\/tr><\/thead><tbody>';items.forEach(i => {
html += '<tr><td style="white-space:nowrap">' + formatTime(i.start_time) + '<\/td><td>' + escapeHtml(i.subject) + '<\/td><td>' + clientBadge(i.client_name) + '<\/td><\/tr>';
});html += '<\/tbody><\/table>';cardSuccess('todays-calendar', html);
} catch (e) { await handleCardError('todays-calendar', 'get_standup_todays_calendar', e, 'loadTodaysCalendar'); }
}
async function loadOverdueTickets() {
cardLoading('overdue-tickets');try {
const { data, error } = await sb.rpc('get_standup_overdue_tickets');if (error) { await handleCardError('overdue-tickets', 'get_standup_overdue_tickets', error, 'loadOverdueTickets'); return; }
if (!data || !data.by_client || data.by_client.length === 0) { cardEmpty('overdue-tickets', 'No overdue tickets'); return; }
updateCardCount('overdue-tickets', data.total_overdue + ' overdue / ' + data.total_open + ' open');let html = '<div class="kpi-row"><div class="kpi-metric"><div class="kpi-value" style="color:var(--error)">' + data.total_overdue + '<\/div><div class="kpi-label">Overdue<\/div><\/div><div class="kpi-metric"><div class="kpi-value">' + data.total_open + '<\/div><div class="kpi-label">Total Open<\/div><\/div><\/div>';html += '<table class="data-table" style="margin-top:0.75rem"><thead><tr><th>Client<\/th><th>Count<\/th><th>Sample Ticket<\/th><th><\/th><\/tr><\/thead><tbody>';data.by_client.forEach(c => {
const t = c.tickets && c.tickets[0];html += '<tr><td>' + clientBadge(c.client_name) + '<\/td><td>' + (c.count || c.tickets?.length || 0) + '<\/td><td class="truncate">' + escapeHtml(t?.subject || '\u2014') + '<\/td><td>' + linkIcon(t?.hubspot_ticket_url) + '<\/td><\/tr>';
});html += '<\/tbody><\/table>';cardSuccess('overdue-tickets', html);
} catch (e) { await handleCardError('overdue-tickets', 'get_standup_overdue_tickets', e, 'loadOverdueTickets'); }
}
async function loadRetainerBilling() {
cardLoading('retainer-billing');try {
const { data, error } = await sb.rpc('get_standup_retainer_billing');if (error) { await handleCardError('retainer-billing', 'get_standup_retainer_billing', error, 'loadRetainerBilling'); return; }
if (!data || !data.billing || data.billing.length === 0) { cardEmpty('retainer-billing', 'No retainer data'); return; }
let html = '<table class="data-table"><thead><tr><th>Client<\/th><th>Amount<\/th><th>Status<\/th><th>Planned<\/th><th>Done<\/th><\/tr><\/thead><tbody>';data.billing.forEach(b => {
const cap = data.capped_status && data.capped_status.find(c => c.client_name === b.client_name);let statusHtml = statusBadge(b.invoice_status);if (cap) { statusHtml += ' <span class="badge badge-warning">' + cap.hours_used + '/' + cap.included_hours_per_month + 'h<\/span>'; }
html += '<tr><td>' + clientBadge(b.client_name) + '<\/td><td>' + formatCurrency(b.retainer_amount) + '<\/td><td>' + statusHtml + '<\/td><td>' + (b.total_items_planned || 0) + '<\/td><td>' + (b.total_items_completed || 0) + '<\/td><\/tr>';
});html += '<\/tbody><\/table>';cardSuccess('retainer-billing', html);
} catch (e) { await handleCardError('retainer-billing', 'get_standup_retainer_billing', e, 'loadRetainerBilling'); }
}
async function loadEmailTriage() {
cardLoading('email-triage');try {
const { data, error } = await sb.rpc('get_standup_email_digest');if (error) { await handleCardError('email-triage', 'get_standup_email_digest', error, 'loadEmailTriage'); return; }
if (!data || !data.stats) { cardEmpty('email-triage', 'No email data'); return; }
const s = data.stats;let html = '<div class="kpi-row">';html += '<div class="kpi-metric"><div class="kpi-value">' + (s.total_processed || 0) + '<\/div><div class="kpi-label">Processed<\/div><\/div>';html += '<div class="kpi-metric"><div class="kpi-value">' + (s.auto_filed || 0) + '<\/div><div class="kpi-label">Auto-Filed<\/div><\/div>';html += '<div class="kpi-metric"><div class="kpi-value" style="color:' + (s.needs_action > 0 ? 'var(--warning)' : 'var(--success)') + '">' + (s.needs_action || 0) + '<\/div><div class="kpi-label">Needs Action<\/div><\/div>';html += '<div class="kpi-metric"><div class="kpi-value">' + (data.unprocessed || 0) + '<\/div><div class="kpi-label">Unprocessed<\/div><\/div>';html += '<\/div>';if (data.standup_queue && data.standup_queue.length > 0) {
html += '<table class="data-table" style="margin-top:0.75rem"><thead><tr><th>Subject<\/th><th>From<\/th><th>Type<\/th><\/tr><\/thead><tbody>';data.standup_queue.forEach(e => {
html += '<tr><td>' + escapeHtml(e.subject) + '<\/td><td>' + escapeHtml(e.sender_email || e.from) + '<\/td><td>' + statusBadge(e.email_type || e.type) + '<\/td><\/tr>';
});html += '<\/tbody><\/table>';
}
cardSuccess('email-triage', html);
} catch (e) { await handleCardError('email-triage', 'get_standup_email_digest', e, 'loadEmailTriage'); }
}
async function loadCarryForward() {
cardLoading('carry-forward');try {
const { data, error } = await sb.rpc('get_standup_carry_forward');if (error) { await handleCardError('carry-forward', 'get_standup_carry_forward', error, 'loadCarryForward'); return; }
const items = data || [];if (items.length === 0) { cardEmpty('carry-forward', 'Nothing carried forward'); return; }
updateCardCount('carry-forward', items.length);let html = '<table class="data-table"><thead><tr><th>Item<\/th><th>Type<\/th><th>Priority<\/th><\/tr><\/thead><tbody>';items.forEach(i => {
html += '<tr><td>' + escapeHtml(i.title || i.detail) + '<\/td><td>' + statusBadge(i.note_type || i.type) + '<\/td><td>' + statusBadge(i.priority) + '<\/td><\/tr>';
});html += '<\/tbody><\/table>';cardSuccess('carry-forward', html);
} catch (e) { await handleCardError('carry-forward', 'get_standup_carry_forward', e, 'loadCarryForward'); }
}
async function loadStaleWaiting() {
cardLoading('stale-waiting');try {
const { data, error } = await sb.rpc('get_standup_stale_waiting');if (error) { await handleCardError('stale-waiting', 'get_standup_stale_waiting', error, 'loadStaleWaiting'); return; }
const items = data || [];if (items.length === 0) { cardEmpty('stale-waiting', 'Nothing stale or waiting'); return; }
updateCardCount('stale-waiting', items.length);let html = '<table class="data-table"><thead><tr><th>Item<\/th><th>Status<\/th><th>Age<\/th><\/tr><\/thead><tbody>';items.forEach(i => {
html += '<tr><td>' + escapeHtml(i.title || i.subject) + '<\/td><td>' + statusBadge(i.status || i.stage) + '<\/td><td>' + staleBadge(i.days_stale || daysAgo(i.last_modified)) + '<\/td><\/tr>';
});html += '<\/tbody><\/table>';cardSuccess('stale-waiting', html);
} catch (e) { await handleCardError('stale-waiting', 'get_standup_stale_waiting', e, 'loadStaleWaiting'); }
}
async function loadOpenTickets() {
cardLoading('open-tickets');try {
const { data, error } = await sb.rpc('get_standup_open_tickets');if (error) { await handleCardError('open-tickets', 'get_standup_open_tickets', error, 'loadOpenTickets'); return; }
if (!data || !data.tickets) { cardEmpty('open-tickets', 'No open tickets'); return; }
const tickets = data.tickets;updateCardCount('open-tickets', data.total);let warn = '';const displayTickets = tickets.length > 500 ? (warn = '<div class="warning-banner">Showing first 500 of ' + tickets.length + ' tickets<\/div>', tickets.slice(0, 500)) : tickets;const columns = [
{ key: 'subject', label: 'Subject', render: r => '<span class="truncate" style="display:inline-block">' + escapeHtml(r.subject) + '<\/span> ' + linkIcon(r.url) },
{ key: 'client_name', label: 'Client', render: r => clientBadge(r.client_name) },
{ key: 'stage', label: 'Stage', render: r => statusBadge(r.stage) },
{ key: 'last_modified', label: 'Last Modified', render: r => formatDate(r.last_modified) },
];const el = document.getElementById('open-tickets');if (warn) el.innerHTML = warn;renderSortableTable('open-tickets', columns, displayTickets, { defaultSort: 'last_modified', defaultSortDir: 'desc' });
} catch (e) { await handleCardError('open-tickets', 'get_standup_open_tickets', e, 'loadOpenTickets'); }
}
async function loadTimeEntry(){cardEmpty('time-entry','Time entry coming in next deploy');}
`;
