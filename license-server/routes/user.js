// User self-service endpoints — Bearer-token。
// 支援兩種 Bearer：
//   (1) 一般 session id（瀏覽器登入後拿到的；存在 sessions table）
//   (2) API token，prefix 'dbmt_'（v2 Theme C Phase 2；存在 api_tokens table）
// Mounted as: app.use('/api/user', require('./routes/user'));

const router = require('express').Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db');
const { PLANS, getPlan, freeOverridePlan } = require('../plans');
const tokens = require('../lib/tokens');

function ipOf(req) {
  return (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() || req.ip || '';
}

function authBearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

// 回 { user, session? OR apiToken? }，未驗證回 null。
// API token 認證的 request 沒有 session 物件，但有 apiToken（含 scopes）。
function currentUser(req) {
  const token = authBearer(req);
  if (!token) return null;

  if (tokens.isApiToken(token)) {
    const hash = tokens.hashToken(token);
    const t = db.prepare('SELECT * FROM api_tokens WHERE token_hash = ?').get(hash);
    if (!t) return null;
    if (t.revoked_at) return null;
    if (t.expires_at && new Date(t.expires_at) < new Date()) return null;
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(t.user_id);
    if (!u) return null;
    // touch last_used，方便 portal 顯示「最後使用」
    db.prepare('UPDATE api_tokens SET last_used_at = CURRENT_TIMESTAMP, last_used_ip = ? WHERE id = ?')
      .run(ipOf(req), t.id);
    let scopes;
    try { scopes = JSON.parse(t.scopes); } catch { scopes = []; }
    return { user: u, apiToken: { id: t.id, name: t.name, scopes } };
  }

  // 一般 session token
  const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(token);
  if (!s) return null;
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id);
  return u ? { user: u, session: s } : null;
}

// 若是 API token，要求它擁有指定 scope；session 則一律放行（互動登入比 scope 強）。
function requireScope(scope) {
  return (req, res, next) => {
    const r = req.userCtx;
    if (!r) return res.status(401).json({ error: 'not logged in' });
    if (r.apiToken && !tokens.hasScope(r.apiToken.scopes, scope)) {
      return res.status(403).json({ error: `api token missing scope: ${scope}` });
    }
    next();
  };
}

function checkStatus(user) {
  if (user.free_until && new Date(user.free_until) > new Date()) {
    const plan = freeOverridePlan();
    return {
      status: 'free', plan,
      daysLeft: Math.ceil((new Date(user.free_until) - new Date()) / 86400000),
    };
  }
  const plan = getPlan(user.plan);
  if (user.plan === 'trial') {
    const start = user.trial_started_at ? new Date(user.trial_started_at) : null;
    if (!start) return { status: 'trial', plan, daysLeft: plan.duration_days };
    const left = Math.max(0, Math.ceil(plan.duration_days - (Date.now() - start.getTime()) / 86400000));
    return left > 0 ? { status: 'trial', plan, daysLeft: left } : { status: 'expired', plan, daysLeft: 0 };
  }
  if (user.expires_at) {
    const exp = new Date(user.expires_at);
    if (exp < new Date()) return { status: 'expired', plan, daysLeft: 0 };
    return { status: 'licensed', plan, daysLeft: Math.ceil((exp - new Date()) / 86400000) };
  }
  return { status: 'licensed', plan, daysLeft: null };
}

function requireUser(req, res, next) {
  const r = currentUser(req);
  if (!r) return res.status(401).json({ error: 'not logged in' });
  req.userCtx = r;
  next();
}

// =================================================================
router.get('/me', requireUser, (req, res) => {
  const { user, session } = req.userCtx;
  const s = checkStatus(user);
  res.json({
    email: user.email,
    plan: user.plan,
    status: s.status,
    daysLeft: s.daysLeft,
    features: s.plan.features,
    maxDevices: user.max_devices,
    expiresAt: user.expires_at,
    freeUntil: user.free_until,
    totpEnabled: !!user.totp_enabled,
    currentSession: { id: session.id, ip: session.ip, createdAt: session.created_at, lastSeen: session.last_seen },
  });
});

router.get('/sessions', requireUser, (req, res) => {
  const { user, session: cur } = req.userCtx;
  const rows = db.prepare(
    'SELECT id, ip, user_agent, created_at, last_seen FROM sessions WHERE user_id = ? ORDER BY last_seen DESC'
  ).all(user.id);
  res.json({
    currentSessionId: cur.id,
    sessions: rows.map((r) => ({ ...r, isCurrent: r.id === cur.id })),
  });
});

router.delete('/sessions/:id', requireUser, (req, res) => {
  const { user } = req.userCtx;
  const target = db.prepare('SELECT * FROM sessions WHERE id = ? AND user_id = ?').get(req.params.id, user.id);
  if (!target) return res.status(404).json({ error: 'not found or not yours' });
  db.prepare('DELETE FROM sessions WHERE id = ?').run(req.params.id);
  db.prepare('INSERT INTO event_log (user_id, ip, user_agent, event, details) VALUES (?,?,?,?,?)').run(
    user.id, target.ip, target.user_agent, 'kicked',
    JSON.stringify({ by: 'self', via: 'user portal', kickerIp: ipOf(req) })
  );
  res.json({ ok: true });
});

router.post('/kick-others', requireUser, (req, res) => {
  const { user, session: cur } = req.userCtx;
  const others = db.prepare('SELECT * FROM sessions WHERE user_id = ? AND id != ?').all(user.id, cur.id);
  for (const s of others) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(s.id);
    db.prepare('INSERT INTO event_log (user_id, ip, user_agent, event, details) VALUES (?,?,?,?,?)').run(
      user.id, s.ip, s.user_agent, 'kicked',
      JSON.stringify({ by: 'self', reason: 'kick-others' })
    );
  }
  res.json({ ok: true, kicked: others.length });
});

router.post('/change-password', requireUser, (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!oldPassword || !newPassword) return res.status(400).json({ error: 'oldPassword + newPassword required' });
  if (newPassword.length < 8) return res.status(400).json({ error: 'newPassword must be ≥ 8 chars' });
  const { user } = req.userCtx;
  if (!bcrypt.compareSync(oldPassword, user.password_hash))
    return res.status(401).json({ error: 'old password wrong' });
  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
  db.prepare('INSERT INTO event_log (user_id, ip, user_agent, event, details) VALUES (?,?,?,?,?)').run(
    user.id, ipOf(req), req.headers['user-agent'] || '', 'password_changed', null
  );
  res.json({ ok: true });
});

// Lightweight wrapper — same as /api/billing/checkout but takes user from token,
// avoids exposing the userToken in the body. Convenience for portal UI.
router.post('/upgrade', requireUser, async (req, res) => {
  const { plan } = req.body || {};
  if (!plan) return res.status(400).json({ error: 'plan required' });
  // Re-issue as billing/checkout, passing the user's current token
  const url = `http://localhost:${process.env.PORT || 4000}/api/billing/checkout`;
  try {
    const r = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan, userToken: authBearer(req) }),
    });
    res.status(r.status).type('application/json').send(await r.text());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/plans', requireUser, (req, res) => {
  // Public plan info (without internal stripe IDs)
  const safe = Object.fromEntries(Object.entries(PLANS).map(([k, v]) => [k, {
    max_devices: v.max_devices,
    duration_days: v.duration_days,
    features: v.features,
    hasStripePrice: !!v.stripe_price,
  }]));
  res.json({ plans: safe });
});

// ============ API tokens（v2 Theme C Phase 2） ============
//
// Self-managed long-lived tokens for cron / CI / scripts。建立後只有一次機會
// 拿到完整 token 字串（response body 內），server 不再保存明文。

// POST /api/user/tokens  { name, scopes?, expiresInDays? }
//   → { id, token, name, scopes, expires_at, prefix }
router.post('/tokens', requireUser, requireScope('user:write'), (req, res) => {
  const { user, apiToken } = req.userCtx;
  // 不允許用 API token 自己生新的 token（避免「永久升級」攻擊路徑）
  if (apiToken) return res.status(403).json({ error: 'creating tokens requires an interactive session, not another token' });

  const { name, scopes, expiresInDays } = req.body || {};
  if (!name || typeof name !== 'string' || name.length === 0 || name.length > 64) {
    return res.status(400).json({ error: 'name required (1-64 chars)' });
  }
  let scopeList;
  try { scopeList = tokens.validateScopes(scopes && scopes.length ? scopes : tokens.DEFAULT_SCOPES); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  let expiresAt = null;
  if (expiresInDays != null) {
    const days = Number(expiresInDays);
    if (!Number.isFinite(days) || days <= 0 || days > 3650) {
      return res.status(400).json({ error: 'expiresInDays must be 1-3650 (or omit for no expiry)' });
    }
    const d = new Date(); d.setDate(d.getDate() + days);
    expiresAt = d.toISOString();
  }

  const token = tokens.generateToken();
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO api_tokens (id, user_id, name, token_prefix, token_hash, scopes, expires_at)
              VALUES (?,?,?,?,?,?,?)`)
    .run(id, user.id, name, token.slice(0, tokens.PREFIX_DISPLAY_LEN), tokens.hashToken(token),
         JSON.stringify(scopeList), expiresAt);

  db.prepare('INSERT INTO event_log (user_id, ip, user_agent, event, details) VALUES (?,?,?,?,?)')
    .run(user.id, ipOf(req), req.headers['user-agent'] || '', 'api_token_created',
         JSON.stringify({ id, name, scopes: scopeList, expiresAt }));

  res.json({
    id, name, token,                         // 唯一一次可看到 token
    prefix: tokens.previewPrefix(token),
    scopes: scopeList,
    expires_at: expiresAt,
  });
});

// GET /api/user/tokens  → list (沒有 token 明文)
router.get('/tokens', requireUser, requireScope('user:read'), (req, res) => {
  const { user } = req.userCtx;
  const rows = db.prepare(`SELECT id, name, token_prefix, scopes, created_at, expires_at,
                                  revoked_at, last_used_at, last_used_ip
                           FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC`).all(user.id);
  res.json({
    tokens: rows.map((r) => ({
      ...r,
      scopes: safeParseJson(r.scopes, []),
      // 給 UI 判斷：active / revoked / expired
      state: r.revoked_at ? 'revoked'
           : (r.expires_at && new Date(r.expires_at) < new Date()) ? 'expired'
           : 'active',
    })),
  });
});

// DELETE /api/user/tokens/:id  → revoke (記入 event_log)
router.delete('/tokens/:id', requireUser, requireScope('user:write'), (req, res) => {
  const { user, apiToken } = req.userCtx;
  // 同樣的理由：禁止用 API token 撤銷自己 / 別人，避免 token-chain 攻擊
  if (apiToken) return res.status(403).json({ error: 'revoking tokens requires an interactive session' });

  const target = db.prepare('SELECT * FROM api_tokens WHERE id = ? AND user_id = ?').get(req.params.id, user.id);
  if (!target) return res.status(404).json({ error: 'not found or not yours' });
  if (target.revoked_at) return res.json({ ok: true, alreadyRevoked: true });

  db.prepare('UPDATE api_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?').run(target.id);
  db.prepare('INSERT INTO event_log (user_id, ip, user_agent, event, details) VALUES (?,?,?,?,?)')
    .run(user.id, ipOf(req), req.headers['user-agent'] || '', 'api_token_revoked',
         JSON.stringify({ id: target.id, name: target.name }));
  res.json({ ok: true });
});

function safeParseJson(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

module.exports = router;
// expose for tests
module.exports._internal = { currentUser, requireScope };
