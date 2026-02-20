export const JS_AUTH = String.raw`const SUPABASE_URL = 'https://bbsldtgusmjpulohxzpa.supabase.co';const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJic2xkdGd1c21qcHVsb2h4enBhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzAwNTAyNzQsImV4cCI6MjA4NTYyNjI3NH0.wnRJpsDrXn2dRqQQsGVzToAeauxZgboPiXPxRc-5Xq8';const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);let failedLogins = 0;const PILLARS = [
{ id: 'operations', label: 'Operations', loader: 'loadOperations' },
{ id: 'sales', label: 'Sales', loader: null },
{ id: 'marketing', label: 'Marketing', loader: null },
{ id: 'leadership', label: 'Leadership', loader: null },
{ id: 'finance', label: 'Finance', loader: null },
{ id: 'legal', label: 'Legal', loader: null },
{ id: 'system', label: 'System', loader: 'loadSystem' },
];let activePillar = 'operations';async function doLogin() {
const email = document.getElementById('email').value.trim();const pw = document.getElementById('password').value;const errEl = document.getElementById('login-error');const btn = document.getElementById('login-btn');errEl.style.display = 'none';if (!email || !pw) { errEl.textContent = 'Email and password required.'; errEl.style.display = 'block'; return; }
btn.disabled = true; btn.textContent = 'Signing in...';try {
const { data, error } = await sb.auth.signInWithPassword({ email, password: pw });if (error) {
failedLogins++;if (error.message && error.message.includes('Invalid login credentials')) {
errEl.textContent = 'Invalid email or password.';
} else if (failedLogins >= 3) {
errEl.textContent = 'Authentication may not be configured. Contact admin.';
} else {
errEl.textContent = error.message || 'Login failed.';
}
errEl.style.display = 'block';btn.disabled = false; btn.textContent = 'Sign In';return;
}
showDashboard(data.user);
} catch (e) {
errEl.textContent = 'Unable to connect. Check your network.';errEl.style.display = 'block';btn.disabled = false; btn.textContent = 'Sign In';
}
}
async function doLogout() {
await sb.auth.signOut();document.getElementById('dashboard').style.display = 'none';document.getElementById('login-screen').style.display = 'flex';document.getElementById('password').value = '';document.getElementById('login-error').style.display = 'none';
}
function showDashboard(user) {
document.getElementById('login-screen').style.display = 'none';document.getElementById('dashboard').style.display = 'block';document.getElementById('user-email').textContent = user.email;renderNav();navigateTo('operations');
}
function renderNav() {
const nav = document.getElementById('nav-tabs');nav.innerHTML = '';
PILLARS.forEach(p => {
const tab = document.createElement('div');tab.className = 'nav-tab' + (p.id === activePillar ? ' active' : '');tab.textContent = p.label;tab.onclick = () => navigateTo(p.id);nav.appendChild(tab);
});
}
function navigateTo(pillarId) {
activePillar = pillarId;renderNav();const content = document.getElementById('pillar-content');content.innerHTML = '';const pillar = PILLARS.find(p => p.id === pillarId);if (pillar && pillar.loader) {
const fn = typeof pillar.loader === 'string' ? window[pillar.loader] : pillar.loader;if (typeof fn === 'function') { fn(content); } else { content.innerHTML = '<div class="placeholder-pillar"><h2>' + escapeHtml(pillar.label) + '<\/h2><p>Loader not found: ' + escapeHtml(pillar.loader) + '<\/p><\/div>'; }
} else {
content.innerHTML = '<div class="placeholder-pillar"><h2>' + escapeHtml(pillar.label) + '<\/h2><p>Coming in Phase 2<\/p><\/div>';
}
}
function logError(cardId, rpcName, code, message) {
console.error({ card_id: cardId, rpc_name: rpcName, error_code: code, error_message: message, timestamp: new Date().toISOString() });
}
async function handleCardError(containerId, rpcName, error, retryFn) {
if (error && (error.code === 'PGRST301' || error.message && error.message.includes('JWT'))) {
showToast('Session expired. Redirecting to login...', 'error');await doLogout();return;
}
logError(containerId, rpcName, error?.code || 'UNKNOWN', error?.message || 'Unknown error');cardError(containerId, error?.message || 'Failed to load data', retryFn);
}
(async function initApp() {
const { data: { session } } = await sb.auth.getSession();if (session && session.user) {
showDashboard(session.user);
}
sb.auth.onAuthStateChange((event) => {
if (event === 'SIGNED_OUT') {
document.getElementById('dashboard').style.display = 'none';document.getElementById('login-screen').style.display = 'flex';
}
});
})();
`;
