// Admin SPA — vanilla JS, no framework

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const API = ''; // same origin

async function api(path, opts = {}) {
  const r = await fetch(API + '/api/admin' + path, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    credentials: 'include',
    ...opts,
  });
  if (r.status === 401 && location.pathname !== '/admin/' && !location.pathname.endsWith('admin.html')) {
    showLogin();
    throw new Error('not logged in');
  }
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function fmtDate(s) {
  if (!s) return '—';
  const d = new Date(s); if (isNaN(d)) return s;
  return d.toLocaleString('zh-TW', { year: '2-digit', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function fmtRelative(s) {
  if (!s) return '—';
  const d = new Date(s); if (isNaN(d)) return s;
  const sec = Math.floor((Date.now() - d) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec/60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec/3600)}h ago`;
  return `${Math.floor(sec/86400)}d ago`;
}

// ============ Login flow ============
function showLogin() {
  $('#login-screen').hidden = false;
  $('#app').hidden = true;
}
function showApp() {
  $('#login-screen').hidden = true;
  $('#app').hidden = false;
  loadDashboard();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('#login-email').value;
  const password = $('#login-password').value;
  const msg = $('#login-msg');
  msg.textContent = '登入中...'; msg.className = 'msg';
  try {
    const r = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email, password }),
    });
    const data = await r.json();
    if (!r.ok) { msg.textContent = data.error || '登入失敗'; return; }
    msg.textContent = '✓'; msg.className = 'msg ok';
    $('#me-email').textContent = data.user.email;
    showApp();
  } catch (e) { msg.textContent = e.message; }
});

$('#btn-logout').addEventListener('click', async () => {
  await api('/logout', { method: 'POST' });
  location.reload();
});

// On load: check if already logged in
(async function () {
  try {
    const r = await fetch('/api/admin/me', { credentials: 'include' });
    if (r.ok) {
      const d = await r.json();
      $('#me-email').textContent = d.user.email;
      showApp();
    } else showLogin();
  } catch { showLogin(); }
})();

// ============ Tabs ============
$$('.tab').forEach((t) => {
  t.addEventListener('click', () => {
    $$('.tab').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    $$('.tab-panel').forEach((p) => p.hidden = true);
    const panel = $('#tab-' + t.dataset.tab);
    if (panel) panel.hidden = false;
    if (t.dataset.tab === 'dashboard') loadDashboard();
    if (t.dataset.tab === 'users') loadUsers();
    if (t.dataset.tab === 'sessions') loadSessions();
    if (t.dataset.tab === 'events') loadEvents();
    if (t.dataset.tab === 'licenses') loadLicenses();
    if (t.dataset.tab === 'settings') loadSettings();
  });
});

// ============ Dashboard ============
async function loadDashboard() {
  try {
    const stats = await api('/stats');
    $('#s-online').textContent = stats.onlineCount;
    $('#s-logins').textContent = stats.logins24h;
    $('#s-kicked').textContent = stats.kicked24h;
    $('#s-expiring').textContent = stats.expiringSoon;
    const tb = $('#plan-totals tbody');
    tb.innerHTML = stats.plans.map((p) =>
      `<tr><td>${escapeHtml(p)}</td><td><b>${stats.totals[p] ?? 0}</b></td></tr>`
    ).join('');

    // Stripe status
    const s = await fetch('/api/billing/status').then((r) => r.json()).catch(() => ({ enabled: false }));
    $('#stripe-status').innerHTML = `
      <div class="stripe-row">
        <span class="indicator ${s.enabled ? 'ok' : ''}"></span>
        Stripe ${s.enabled ? '已啟用' : '未啟用 — STRIPE_SECRET_KEY 未設'}
      </div>
      <div class="stripe-row">
        <span class="indicator ${s.webhookConfigured ? 'ok' : ''}"></span>
        Webhook ${s.webhookConfigured ? '已設' : '未設 — STRIPE_WEBHOOK_SECRET 未設'}
      </div>
      <div class="stripe-row">
        Price IDs: basic=<code>${escapeHtml(s.prices?.basic || '—')}</code>,
        team=<code>${escapeHtml(s.prices?.team || '—')}</code>,
        enterprise=<code>${escapeHtml(s.prices?.enterprise || '—')}</code>
      </div>
    `;
  } catch (e) { console.error(e); }
}

// ============ Users ============
let allUsers = [];

async function loadUsers() {
  try {
    const search = $('#users-search').value.trim();
    const r = await api('/users' + (search ? '?search=' + encodeURIComponent(search) : ''));
    allUsers = r.users;
    renderUsers();
  } catch (e) { alert(e.message); }
}

function renderUsers() {
  const tb = $('#users-table tbody');
  tb.innerHTML = allUsers.map((u) => {
    const isExpired = u.expires_at && new Date(u.expires_at) < new Date();
    const statusBadge = isExpired ? `<span class="badge expired">expired</span>` :
                        u.email_verified ? `<span class="badge licensed">active</span>` :
                        `<span class="badge expired">unverified</span>`;
    const planBadge = `<span class="badge ${u.plan}">${u.plan}</span>`;
    const onlineBadge = u.active_sessions > 0
      ? `<span class="badge online">${u.active_sessions}</span>` : '0';
    return `<tr data-id="${u.id}">
      <td>${escapeHtml(u.email)} ${u.is_admin ? '<small style="color:#9d5d1e">[admin]</small>' : ''}</td>
      <td>${planBadge}</td>
      <td>${u.max_devices}</td>
      <td>${statusBadge}</td>
      <td>${u.expires_at ? fmtDate(u.expires_at) : (u.plan==='trial' ? 'trial' : '—')}</td>
      <td>${onlineBadge}</td>
      <td>
        <button class="row-action" data-action="edit" data-id="${u.id}">編輯</button>
        <button class="row-action" data-action="kick" data-id="${u.id}">踢</button>
      </td>
    </tr>`;
  }).join('');
}

$('#users-search').addEventListener('input', debounce(loadUsers, 300));
$('#btn-refresh-users').addEventListener('click', loadUsers);
$('#btn-new-user').addEventListener('click', () => openUserModal(null));

$('#users-table').addEventListener('click', async (e) => {
  const btn = e.target.closest('.row-action');
  if (!btn) return;
  const id = btn.dataset.id;
  if (btn.dataset.action === 'edit') openUserModal(id);
  if (btn.dataset.action === 'kick') {
    if (!confirm('踢出該使用者所有裝置？')) return;
    try { await api(`/users/${id}/kick-all`, { method: 'POST' }); loadUsers(); }
    catch (err) { alert(err.message); }
  }
});

// ============ User modal ============
function openUserModal(id) {
  const isNew = !id;
  $('#user-modal-title').textContent = isNew ? '新增使用者' : '編輯使用者';
  $('#user-form').reset();
  $('#u-id').value = '';
  if (isNew) {
    $('#u-plan').value = 'trial';
    $('#u-devices').value = 1;
  } else {
    const u = allUsers.find((x) => x.id === id);
    if (!u) return;
    $('#u-id').value = u.id;
    $('#u-email').value = u.email;
    $('#u-plan').value = u.plan;
    $('#u-devices').value = u.max_devices;
    $('#u-expires').value = u.expires_at ? new Date(u.expires_at).toISOString().slice(0, 16) : '';
    $('#u-free-until').value = u.free_until ? new Date(u.free_until).toISOString().slice(0, 16) : '';
    let wl = u.ip_whitelist;
    if (wl) { try { wl = JSON.parse(wl).join(', '); } catch {} }
    $('#u-whitelist').value = wl || '';
    $('#u-notes').value = u.notes || '';
    $('#u-admin').checked = !!u.is_admin;
    $('#u-verified').checked = !!u.email_verified;
  }
  $('#user-modal').hidden = false;
}

$('#btn-modal-close').addEventListener('click', closeModal);
$('.modal-backdrop').addEventListener('click', closeModal);
function closeModal() { $('#user-modal').hidden = true; }

$('#user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('#u-id').value;
  const data = {
    email: $('#u-email').value,
    plan: $('#u-plan').value,
    max_devices: Number($('#u-devices').value),
    expires_at: $('#u-expires').value ? new Date($('#u-expires').value).toISOString() : null,
    free_until: $('#u-free-until').value ? new Date($('#u-free-until').value).toISOString() : null,
    ip_whitelist: $('#u-whitelist').value.trim()
      ? $('#u-whitelist').value.split(',').map((s) => s.trim()).filter(Boolean)
      : null,
    notes: $('#u-notes').value || null,
    is_admin: $('#u-admin').checked,
    email_verified: $('#u-verified').checked,
  };
  const pw = $('#u-password').value;
  if (pw) data.password = pw;
  try {
    if (id) {
      await api(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
    } else {
      if (!pw) return alert('新增使用者必須填密碼');
      data.password = pw;
      await api(`/users`, { method: 'POST', body: JSON.stringify(data) });
    }
    closeModal();
    loadUsers();
  } catch (err) { alert(err.message); }
});

$('#btn-modal-kick').addEventListener('click', async () => {
  const id = $('#u-id').value;
  if (!id) return;
  if (!confirm('踢出全部裝置？')) return;
  await api(`/users/${id}/kick-all`, { method: 'POST' });
  alert('已踢出');
});

$('#btn-modal-free').addEventListener('click', async () => {
  const id = $('#u-id').value;
  if (!id) return;
  const days = Number(prompt('免費幾天？', '30')) || 30;
  await api(`/users/${id}/free-month`, { method: 'POST', body: JSON.stringify({ days }) });
  closeModal(); loadUsers();
});

$('#btn-modal-delete').addEventListener('click', async () => {
  const id = $('#u-id').value;
  if (!id) return;
  if (!confirm('確定刪除此使用者？此動作無法還原')) return;
  await api(`/users/${id}`, { method: 'DELETE' });
  closeModal(); loadUsers();
});

// ============ Sessions ============
async function loadSessions() {
  try {
    const r = await api('/sessions');
    $('#sessions-count').textContent = `共 ${r.sessions.length} 個 session`;
    const tb = $('#sessions-table tbody');
    tb.innerHTML = r.sessions.map((s) => `
      <tr>
        <td>${escapeHtml(s.email)}</td>
        <td><code>${escapeHtml(s.ip)}</code></td>
        <td><small>${escapeHtml((s.user_agent || '').slice(0, 60))}</small></td>
        <td><small>${fmtDate(s.created_at)}</small></td>
        <td><small>${fmtRelative(s.last_seen)}</small></td>
        <td><button class="row-action danger" data-id="${s.id}">踢出</button></td>
      </tr>
    `).join('');
  } catch (e) { alert(e.message); }
}

$('#btn-refresh-sessions').addEventListener('click', loadSessions);
$('#sessions-table').addEventListener('click', async (e) => {
  const btn = e.target.closest('.row-action');
  if (!btn) return;
  if (!confirm('踢出此 session？')) return;
  await api(`/sessions/${btn.dataset.id}`, { method: 'DELETE' });
  loadSessions();
});

// ============ Events ============
async function loadEvents() {
  try {
    const limit = $('#events-limit').value;
    const search = $('#events-search').value.trim();
    const params = new URLSearchParams({ limit });
    if (search) params.set('email', search);
    const r = await api('/events?' + params);
    const tb = $('#events-table tbody');
    tb.innerHTML = r.events.map((e) => `
      <tr>
        <td><small>${fmtDate(e.at)}</small></td>
        <td><code>${escapeHtml(e.event)}</code></td>
        <td>${escapeHtml(e.email || '—')}</td>
        <td><code>${escapeHtml(e.ip || '')}</code></td>
        <td><small>${escapeHtml(e.details || '')}</small></td>
      </tr>
    `).join('');
  } catch (e) { alert(e.message); }
}

$('#btn-refresh-events').addEventListener('click', loadEvents);
$('#events-search').addEventListener('input', debounce(loadEvents, 300));
$('#events-limit').addEventListener('change', loadEvents);

// ============ Licenses (offline-mode kill switch) ============
let allLicenses = [];

async function loadLicenses() {
  try {
    const f = $('#licenses-filter').value;
    const r = await api('/licenses' + (f ? '?filter=' + f : ''));
    allLicenses = r.licenses;
    $('#licenses-count').textContent = `共 ${r.licenses.length} 張`;
    renderLicenses();
  } catch (e) { alert(e.message); }
}

function renderLicenses() {
  const tb = $('#licenses-table tbody');
  tb.innerHTML = allLicenses.map((l) => {
    const isRevoked = !!l.revoked_at;
    const isExpired = l.expires_at && new Date(l.expires_at) < new Date();
    const status = isRevoked
      ? `<span class="badge expired">revoked</span>`
      : isExpired
      ? `<span class="badge expired">expired</span>`
      : `<span class="badge licensed">active</span>`;
    const action = isRevoked
      ? `<button class="row-action" data-action="unrevoke" data-id="${l.id}">解除撤銷</button>`
      : `<button class="row-action danger" data-action="revoke" data-id="${l.id}">撤銷</button>`;
    return `<tr>
      <td><code title="${escapeHtml(l.id)}">${escapeHtml(l.id.slice(0, 8))}…</code></td>
      <td>${escapeHtml(l.customer || '—')}</td>
      <td>${escapeHtml(l.plan || '—')}</td>
      <td><small>${fmtDate(l.expires_at)}</small></td>
      <td>${status}${isRevoked && l.revoke_reason ? `<br><small class="muted">${escapeHtml(l.revoke_reason)}</small>` : ''}</td>
      <td>${action}
        <button class="row-action" data-action="copy" data-id="${l.id}">複製 ID</button>
      </td>
    </tr>`;
  }).join('');
}

$('#btn-refresh-licenses').addEventListener('click', loadLicenses);
$('#licenses-filter').addEventListener('change', loadLicenses);
$('#btn-add-license').addEventListener('click', () => {
  $('#license-form').reset();
  $('#license-modal').hidden = false;
});
$('#btn-license-close').addEventListener('click', () => $('#license-modal').hidden = true);

$('#license-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = {
    id: $('#l-id').value.trim().toLowerCase(),
    customer: $('#l-customer').value || null,
    plan: $('#l-plan').value || null,
    expires_at: $('#l-expires').value ? new Date($('#l-expires').value).toISOString() : null,
    notes: $('#l-notes').value || null,
  };
  try {
    await api('/licenses', { method: 'POST', body: JSON.stringify(data) });
    $('#license-modal').hidden = true;
    loadLicenses();
  } catch (err) { alert(err.message); }
});

$('#licenses-table').addEventListener('click', async (e) => {
  const btn = e.target.closest('.row-action');
  if (!btn) return;
  const id = btn.dataset.id;
  if (btn.dataset.action === 'copy') {
    navigator.clipboard.writeText(id).then(() => btn.textContent = '已複製').catch(() => {});
    setTimeout(() => btn.textContent = '複製 ID', 1500);
    return;
  }
  if (btn.dataset.action === 'revoke') {
    const reason = prompt('撤銷原因（會記到 event_log，會顯示給 client）：', '');
    if (reason === null) return;
    await api(`/licenses/${id}/revoke`, { method: 'POST', body: JSON.stringify({ reason }) });
    loadLicenses();
  }
  if (btn.dataset.action === 'unrevoke') {
    if (!confirm('解除撤銷？client 下次 phone home 會再次允許啟動')) return;
    await api(`/licenses/${id}/revoke`, { method: 'DELETE' });
    loadLicenses();
  }
});

// ============ Settings ============
async function loadSettings() {
  try {
    const r = await api('/plans');
    $('#plans-json').textContent = JSON.stringify(r.plans, null, 2);
  } catch (e) { console.error(e); }
}

// ============ Helpers ============
function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
