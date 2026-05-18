// Customer self-service portal.
// Stores Bearer token in localStorage (per-browser); calls /api/user/* endpoints.

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const TOKEN_KEY = 'dbmigrator.portal.token.v1';

function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } }
function setToken(t) { try { localStorage.setItem(TOKEN_KEY, t); } catch {} }
function clearToken() { try { localStorage.removeItem(TOKEN_KEY); } catch {} }

async function api(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  const tok = getToken();
  if (tok) headers.Authorization = `Bearer ${tok}`;
  const r = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401) {
    clearToken();
    showLogin();
    throw new Error('not logged in');
  }
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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

function showLogin() {
  $('#login-screen').hidden = false;
  $('#portal').hidden = true;
}
function showPortal() {
  $('#login-screen').hidden = true;
  $('#portal').hidden = false;
  loadAll();
}

// ============== Login flow ==============
let pending2faChallengeId = null;

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#login-msg');
  msg.className = 'msg';
  msg.textContent = '登入中...';
  try {
    const r = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: $('#login-email').value, password: $('#login-password').value }),
    });
    const data = await r.json();
    if (!r.ok) { msg.textContent = data.error || '登入失敗'; return; }
    if (data.needs2fa) {
      pending2faChallengeId = data.challengeId;
      msg.className = 'msg ok';
      msg.textContent = '密碼正確，請輸入 2FA 驗證碼';
      $('#login-form').hidden = true;
      $('#login-2fa-form').hidden = false;
      $('#login-2fa-code').focus();
      return;
    }
    setToken(data.token);
    showPortal();
  } catch (e) { msg.textContent = e.message; }
});

$('#login-2fa-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#login-msg');
  msg.className = 'msg';
  msg.textContent = '驗證中...';
  try {
    const r = await fetch('/api/auth/2fa/verify-login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeId: pending2faChallengeId, code: $('#login-2fa-code').value }),
    });
    const data = await r.json();
    if (!r.ok) { msg.textContent = data.error || '驗證失敗'; return; }
    setToken(data.token);
    showPortal();
  } catch (e) { msg.textContent = e.message; }
});

$('#btn-register').addEventListener('click', async () => {
  const msg = $('#login-msg');
  msg.className = 'msg';
  const email = $('#login-email').value;
  const password = $('#login-password').value;
  if (!email || !password) { msg.textContent = '請填 email 和 password'; return; }
  msg.textContent = '註冊中...';
  try {
    const r = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await r.json();
    if (!r.ok) { msg.textContent = data.error || '註冊失敗'; return; }
    msg.className = 'msg ok';
    msg.textContent = data.message || '已寄出驗證信，驗證後可登入';
  } catch (e) { msg.textContent = e.message; }
});

$('#btn-logout').addEventListener('click', async () => {
  try { await fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${getToken()}` } }); } catch {}
  clearToken();
  location.reload();
});

// Auto-show portal if already logged in
(async function () {
  if (!getToken()) { showLogin(); return; }
  try { await api('GET', '/api/user/me'); showPortal(); }
  catch { showLogin(); }
})();

// ============== Portal data loaders ==============
async function loadAll() {
  await loadMe();
  await loadSessions();
  await loadPlans();
  await refreshTotpUI();
  await loadTokens();
}

// ============ 2FA ============
async function refreshTotpUI() {
  try {
    const me = await api('GET', '/api/user/me');
    const tag = $('#totp-status-tag');
    const enabled = !!me.totpEnabled;
    tag.innerHTML = enabled
      ? '<span style="background:#d1fae5;color:#065f46;padding:2px 8px;border-radius:10px;font-size:11px;">已啟用</span>'
      : '<span style="background:#fef3c7;color:#92400e;padding:2px 8px;border-radius:10px;font-size:11px;">未啟用</span>';
    $('#totp-off').hidden = enabled;
    $('#totp-on').hidden = !enabled;
    $('#totp-setup-flow').hidden = true;
  } catch (e) { console.warn(e); }
}

$('#btn-totp-setup')?.addEventListener('click', async () => {
  try {
    const r = await api('POST', '/api/auth/2fa/setup');
    $('#totp-qr').innerHTML = r.qrSvg;
    $('#totp-secret-text').textContent = r.secret;
    $('#totp-off').hidden = true;
    $('#totp-setup-flow').hidden = false;
    $('#totp-confirm-code').value = '';
    $('#totp-confirm-code').focus();
    const msg = $('#totp-setup-msg'); msg.textContent = ''; msg.className = 'msg';
  } catch (e) { alert(e.message); }
});

$('#btn-totp-enable')?.addEventListener('click', async () => {
  const msg = $('#totp-setup-msg'); msg.className = 'msg';
  const code = $('#totp-confirm-code').value.trim();
  if (!/^\d{6}$/.test(code)) { msg.textContent = '請輸入 6 位數'; return; }
  msg.textContent = '驗證中...';
  try {
    await api('POST', '/api/auth/2fa/enable', { code });
    msg.className = 'msg ok'; msg.textContent = '✓ 2FA 已啟用';
    setTimeout(refreshTotpUI, 600);
  } catch (e) { msg.className = 'msg err'; msg.textContent = e.message; }
});

$('#btn-totp-cancel')?.addEventListener('click', () => {
  $('#totp-setup-flow').hidden = true;
  $('#totp-off').hidden = false;
});

$('#btn-totp-disable')?.addEventListener('click', async () => {
  const code = prompt('輸入目前的 6 位數驗證碼（或留空後輸入密碼）：');
  let body;
  if (code && /^\d{6}$/.test(code)) body = { code };
  else {
    const pwd = prompt('輸入您的密碼以停用 2FA：');
    if (!pwd) return;
    body = { password: pwd };
  }
  try {
    await api('POST', '/api/auth/2fa/disable', body);
    alert('已停用 2FA');
    refreshTotpUI();
  } catch (e) { alert('失敗：' + e.message); }
});

async function loadMe() {
  try {
    const me = await api('GET', '/api/user/me');
    $('#me-email').textContent = me.email;
    $('#hero-plan').textContent = me.plan;
    $('#hero-days-num').textContent = me.daysLeft ?? '∞';
    $('#max-dev').textContent = me.maxDevices;
    let statusTxt = '';
    if (me.status === 'trial') statusTxt = '⏳ 試用中';
    else if (me.status === 'free') statusTxt = '🎁 免費期間';
    else if (me.status === 'licensed') statusTxt = `✅ 已啟用 ${me.expiresAt ? `（到 ${fmtDate(me.expiresAt)}）` : ''}`;
    else statusTxt = '⛔ 已過期';
    $('#hero-status').innerHTML = statusTxt;
    return me;
  } catch (e) { console.error(e); }
}

async function loadSessions() {
  try {
    const r = await api('GET', '/api/user/sessions');
    $('#ses-count').textContent = `（${r.sessions.length} 個）`;
    $('#sessions-table tbody').innerHTML = r.sessions.map((s) => `
      <tr class="${s.isCurrent ? 'current-row' : ''}">
        <td><code>${escapeHtml(s.ip)}</code> ${s.isCurrent ? '<span class="badge this-device">這台</span>' : ''}</td>
        <td><small>${escapeHtml((s.user_agent || '').slice(0, 60))}</small></td>
        <td><small>${fmtDate(s.created_at)}</small></td>
        <td><small>${fmtRelative(s.last_seen)}</small></td>
        <td>${s.isCurrent ? '' : `<button class="row-action danger" data-act="kick" data-id="${s.id}">踢出</button>`}</td>
      </tr>
    `).join('');
  } catch (e) { console.error(e); }
}

$('#sessions-table').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-act="kick"]');
  if (!b) return;
  if (!confirm('踢出此裝置？')) return;
  await api('DELETE', `/api/user/sessions/${b.dataset.id}`);
  loadSessions();
});

$('#btn-kick-others').addEventListener('click', async () => {
  if (!confirm('踢出您所有其他裝置？只保留目前這台')) return;
  const r = await api('POST', '/api/user/kick-others');
  alert(`已踢出 ${r.kicked} 個裝置`);
  loadSessions();
});

async function loadPlans() {
  const me = await api('GET', '/api/user/me');
  const r = await api('GET', '/api/user/plans');

  // Find out which billing methods are available
  let ecpayStatus = { enabled: false, amounts: {} };
  try { ecpayStatus = await fetch('/api/billing/ecpay/status').then((x) => x.json()); } catch {}

  const order = ['trial', 'basic', 'team', 'enterprise'];
  const html = order.map((key) => {
    const p = r.plans[key]; if (!p) return '';
    const isCurrent = key === me.plan;
    const f = p.features || {};
    const feats = [
      `${p.max_devices} 台裝置`,
      f.bulk_export ? '多 DB 一次匯出' : '單 DB 匯出',
      f.project_backup ? '專案備份' : '<span class="muted">不含專案備份</span>',
      p.duration_days ? `${p.duration_days} 天試用` : '正式方案',
    ];
    const stripeOk = !isCurrent && p.hasStripePrice;
    const ecpayAmount = ecpayStatus.enabled ? ecpayStatus.amounts[key] : null;
    const ecpayOk = !isCurrent && !!ecpayAmount;
    const priceLine = key === 'trial' ? '免費試用'
                   : ecpayAmount      ? `NT$ ${ecpayAmount.toLocaleString()} / 年`
                   : stripeOk         ? '付費方案 (Stripe)'
                   : '聯繫客服';

    const stripeBtn = stripeOk
      ? `<button class="upgrade-btn" data-pay="stripe" data-plan="${key}">信用卡 (Stripe)</button>` : '';
    const ecpayBtn = ecpayOk
      ? `<button class="upgrade-btn" data-pay="ecpay" data-plan="${key}" style="background:#16a34a;">綠界 (信用卡 / ATM / 超商)</button>` : '';
    const noBtn = !stripeOk && !ecpayOk
      ? `<button class="upgrade-btn" disabled>${isCurrent ? '目前方案' : '聯繫客服'}</button>` : '';

    return `
      <div class="plan-card ${isCurrent ? 'current' : ''}">
        <h3>${escapeHtml(key)}</h3>
        <div class="price">${priceLine}</div>
        <ul>${feats.map((t) => `<li>${t}</li>`).join('')}</ul>
        ${stripeBtn}${ecpayBtn}${noBtn}
      </div>
    `;
  }).join('');
  $('#plan-grid').innerHTML = html;
}

// Helper: auto-submit an HTML form built from ECPay payload
function submitEcpayForm(formAction, fields) {
  const form = document.createElement('form');
  form.action = formAction;
  form.method = 'POST';
  form.acceptCharset = 'UTF-8';
  for (const [k, v] of Object.entries(fields)) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = k;
    input.value = String(v ?? '');
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
}

$('#plan-grid').addEventListener('click', async (e) => {
  const b = e.target.closest('.upgrade-btn');
  if (!b || b.disabled) return;
  const plan = b.dataset.plan;
  const pay = b.dataset.pay;
  try {
    if (pay === 'stripe') {
      const r = await api('POST', '/api/user/upgrade', { plan });
      if (r.checkoutUrl) location.href = r.checkoutUrl;
      else alert('Stripe checkout failed: ' + (r.error || 'unknown'));
    } else if (pay === 'ecpay') {
      const tok = getToken();
      const r = await fetch('/api/billing/ecpay/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan, userToken: tok }),
      }).then((x) => x.json());
      if (r.error) return alert('ECPay 失敗：' + r.error);
      submitEcpayForm(r.formAction, r.fields);
    }
  } catch (e) { alert(e.message); }
});

// ============== Change password ==============
$('#pw-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#pw-msg');
  msg.className = 'msg';
  try {
    await api('POST', '/api/user/change-password', {
      oldPassword: $('#pw-old').value,
      newPassword: $('#pw-new').value,
    });
    msg.className = 'msg ok';
    msg.textContent = '✓ 已變更';
    $('#pw-form').reset();
  } catch (e) { msg.className = 'msg err'; msg.textContent = e.message; }
});

// ============== API Tokens（v2 Theme C Phase 2） ==============
async function loadTokens() {
  try {
    const r = await api('GET', '/api/user/tokens');
    $('#tok-count').textContent = `(${r.tokens.length})`;
    const tb = $('#tok-list tbody');
    if (r.tokens.length === 0) {
      tb.innerHTML = '<tr><td colspan="8" style="color:#9ca3af; text-align:center;">尚未建立 API token</td></tr>';
      return;
    }
    tb.innerHTML = r.tokens.map((t) => `
      <tr>
        <td><b>${escapeHtml(t.name)}</b></td>
        <td><code>${escapeHtml(t.token_prefix)}</code></td>
        <td><small>${escapeHtml((t.scopes || []).join(', '))}</small></td>
        <td><small>${fmtDate(t.created_at)}</small></td>
        <td><small>${t.expires_at ? fmtDate(t.expires_at) : '永不'}</small></td>
        <td><small>${t.last_used_at ? fmtRelative(t.last_used_at) + (t.last_used_ip ? ` from ${escapeHtml(t.last_used_ip)}` : '') : '從未'}</small></td>
        <td>${stateBadge(t.state)}</td>
        <td>${t.state === 'active'
          ? `<button class="btn-ghost" data-revoke="${escapeHtml(t.id)}" style="font-size:12px;">撤銷</button>`
          : ''}</td>
      </tr>
    `).join('');
  } catch (e) { console.error('loadTokens', e); }
}

function stateBadge(state) {
  const map = {
    active:  '<span style="background:#d1fae5;color:#065f46;padding:2px 8px;border-radius:4px;font-size:12px;">active</span>',
    revoked: '<span style="background:#fee2e2;color:#991b1b;padding:2px 8px;border-radius:4px;font-size:12px;">revoked</span>',
    expired: '<span style="background:#fef3c7;color:#92400e;padding:2px 8px;border-radius:4px;font-size:12px;">expired</span>',
  };
  return map[state] || state;
}

$('#tok-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#tok-msg');
  msg.className = 'msg';
  const scopes = [
    $('#tok-s-read').checked && 'user:read',
    $('#tok-s-write').checked && 'user:write',
  ].filter(Boolean);
  if (scopes.length === 0) { msg.className = 'msg err'; msg.textContent = '至少要勾一個 scope'; return; }
  const days = $('#tok-days').value ? Number($('#tok-days').value) : undefined;
  try {
    const r = await api('POST', '/api/user/tokens', {
      name: $('#tok-name').value.trim(),
      scopes,
      expiresInDays: days,
    });
    $('#tok-new').hidden = false;
    $('#tok-new-value').textContent = r.token;
    $('#tok-form').reset();
    $('#tok-s-read').checked = true;
    $('#tok-s-write').checked = true;
    msg.className = '';
    msg.textContent = '';
    await loadTokens();
  } catch (e) { msg.className = 'msg err'; msg.textContent = e.message; }
});

$('#tok-copy').addEventListener('click', () => {
  const v = $('#tok-new-value').textContent;
  navigator.clipboard.writeText(v).then(() => {
    $('#tok-copy').textContent = '✓ 已複製';
    setTimeout(() => { $('#tok-copy').textContent = '複製'; }, 1500);
  }).catch(() => {});
});

$('#tok-dismiss').addEventListener('click', () => {
  $('#tok-new').hidden = true;
  $('#tok-new-value').textContent = '';
});

$('#tok-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-revoke]');
  if (!btn) return;
  if (!confirm('撤銷此 token？使用中的 script 會立刻失敗。')) return;
  try {
    await api('DELETE', '/api/user/tokens/' + encodeURIComponent(btn.dataset.revoke));
    await loadTokens();
  } catch (e) { alert(e.message); }
});
