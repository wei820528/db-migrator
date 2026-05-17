// Admin routes — cookie-authenticated.
// Mounted as: app.use('/api/admin', require('./routes/admin')(deps));
//
// Login flow:
//   POST /login → set-cookie admin_session=<id>
//   All other endpoints require valid cookie

const router = require('express').Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db');
const { PLANS, getPlan } = require('../plans');

const COOKIE_NAME = 'admin_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;  // 7 days

function ipOf(req) {
  return (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() || req.ip || '';
}

function authedAdmin(req) {
  const sid = req.cookies?.[COOKIE_NAME];
  if (!sid) return null;
  const s = db.prepare('SELECT * FROM admin_sessions WHERE id = ?').get(sid);
  if (!s) return null;
  // TTL
  if (new Date() - new Date(s.last_seen) > SESSION_TTL_MS) {
    db.prepare('DELETE FROM admin_sessions WHERE id = ?').run(sid);
    return null;
  }
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id);
  if (!u || !u.is_admin) return null;
  // Refresh last_seen
  db.prepare('UPDATE admin_sessions SET last_seen = CURRENT_TIMESTAMP WHERE id = ?').run(sid);
  return u;
}

function requireAdmin(req, res, next) {
  const u = authedAdmin(req);
  if (!u) return res.status(401).json({ error: 'admin auth required' });
  req.admin = u;
  next();
}

// ---------- Public endpoints ----------

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email + password required' });
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password_hash))
    return res.status(401).json({ error: 'invalid credentials' });
  if (!user.is_admin) return res.status(403).json({ error: 'not an admin account' });

  const sid = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO admin_sessions (id, user_id, ip) VALUES (?,?,?)').run(sid, user.id, ipOf(req));
  res.cookie(COOKIE_NAME, sid, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,    // Caddy/nginx terminates TLS
    maxAge: SESSION_TTL_MS,
  });
  res.json({ ok: true, user: { email: user.email, plan: user.plan } });
});

router.post('/logout', (req, res) => {
  const sid = req.cookies?.[COOKIE_NAME];
  if (sid) db.prepare('DELETE FROM admin_sessions WHERE id = ?').run(sid);
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  const u = authedAdmin(req);
  if (!u) return res.status(401).json({ error: 'not logged in' });
  res.json({ ok: true, user: { id: u.id, email: u.email } });
});

// ---------- Admin-only endpoints ----------

router.use(requireAdmin);

// Users
router.get('/users', (req, res) => {
  const search = String(req.query.search || '').trim().toLowerCase();
  const where = search ? `WHERE LOWER(email) LIKE ?` : '';
  const params = search ? [`%${search}%`] : [];
  const rows = db.prepare(
    `SELECT u.id, u.email, u.plan, u.max_devices, u.trial_started_at, u.expires_at,
            u.email_verified, u.ip_whitelist, u.free_until, u.notes, u.is_admin,
            (SELECT COUNT(*) FROM sessions WHERE user_id = u.id) AS active_sessions,
            u.created_at
     FROM users u ${where} ORDER BY u.created_at DESC LIMIT 500`
  ).all(...params);
  res.json({ users: rows });
});

router.post('/users', (req, res) => {
  const { email, password, plan = 'trial', max_devices, expires_at, is_admin = false, notes } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email + password required' });
  if (password.length < 8) return res.status(400).json({ error: 'password must be ≥ 8 chars' });
  if (!PLANS[plan]) return res.status(400).json({ error: `bad plan: ${plan}` });

  const exists = db.prepare('SELECT 1 FROM users WHERE email = ?').get(email.toLowerCase());
  if (exists) return res.status(409).json({ error: 'email already registered' });

  const id = crypto.randomUUID();
  const hash = bcrypt.hashSync(password, 10);
  const trialStart = plan === 'trial' ? new Date().toISOString() : null;
  const devices = max_devices != null ? Number(max_devices) : PLANS[plan].max_devices;

  db.prepare(`INSERT INTO users (id, email, password_hash, plan, max_devices, trial_started_at, expires_at,
                                 is_admin, email_verified, notes)
              VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, email.toLowerCase(), hash, plan, devices, trialStart, expires_at || null,
         is_admin ? 1 : 0, 1, notes || null);  // admin-created users skip email verify

  res.json({ ok: true, id });
});

router.get('/users/:id', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'not found' });
  delete user.password_hash;
  res.json({ user });
});

router.patch('/users/:id', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'not found' });

  const allowed = ['plan', 'max_devices', 'expires_at', 'ip_whitelist', 'free_until', 'notes', 'email_verified', 'is_admin'];
  const updates = [];
  const params = [];
  for (const k of allowed) {
    if (k in req.body) {
      updates.push(`${k} = ?`);
      let v = req.body[k];
      if (k === 'ip_whitelist' && Array.isArray(v)) v = JSON.stringify(v);
      if (k === 'is_admin' || k === 'email_verified') v = v ? 1 : 0;
      params.push(v);
    }
  }
  if (updates.length === 0) return res.status(400).json({ error: 'no updatable fields' });
  params.push(req.params.id);
  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  // Optional new password
  if (req.body.password) {
    if (req.body.password.length < 8) return res.status(400).json({ error: 'password must be ≥ 8 chars' });
    const hash = bcrypt.hashSync(req.body.password, 10);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.params.id);
  }
  res.json({ ok: true });
});

router.delete('/users/:id', (req, res) => {
  if (req.params.id === req.admin.id) return res.status(400).json({ error: 'cannot delete yourself' });
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.params.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

router.post('/users/:id/kick-all', (req, res) => {
  const n = db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.params.id).changes;
  res.json({ ok: true, kicked: n });
});

router.post('/users/:id/reset-trial', (req, res) => {
  db.prepare(`UPDATE users SET plan='trial', trial_started_at=CURRENT_TIMESTAMP, expires_at=NULL WHERE id=?`)
    .run(req.params.id);
  res.json({ ok: true });
});

router.post('/users/:id/free-month', (req, res) => {
  const { days = 30 } = req.body || {};
  const d = new Date();
  d.setDate(d.getDate() + Number(days));
  db.prepare('UPDATE users SET free_until = ? WHERE id = ?').run(d.toISOString(), req.params.id);
  res.json({ ok: true, free_until: d.toISOString() });
});

router.post('/users/:id/clear-free', (req, res) => {
  db.prepare('UPDATE users SET free_until = NULL WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Sessions
router.get('/sessions', (req, res) => {
  const rows = db.prepare(`
    SELECT s.id, u.email, s.ip, s.user_agent, s.created_at, s.last_seen
    FROM sessions s JOIN users u ON u.id = s.user_id
    ORDER BY s.last_seen DESC LIMIT 500
  `).all();
  res.json({ sessions: rows });
});

router.delete('/sessions/:id', (req, res) => {
  const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (s) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(req.params.id);
    db.prepare('INSERT INTO event_log (user_id, ip, user_agent, event, details) VALUES (?,?,?,?,?)')
      .run(s.user_id, s.ip, s.user_agent, 'kicked', JSON.stringify({ by: 'admin', adminEmail: req.admin.email }));
  }
  res.json({ ok: true });
});

// Events
router.get('/events', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 1000);
  const search = String(req.query.email || '').toLowerCase();
  let rows;
  if (search) {
    rows = db.prepare(`
      SELECT e.id, e.event, u.email, e.ip, e.user_agent, e.details, e.at
      FROM event_log e LEFT JOIN users u ON u.id = e.user_id
      WHERE LOWER(u.email) LIKE ?
      ORDER BY e.at DESC LIMIT ?
    `).all(`%${search}%`, limit);
  } else {
    rows = db.prepare(`
      SELECT e.id, e.event, u.email, e.ip, e.user_agent, e.details, e.at
      FROM event_log e LEFT JOIN users u ON u.id = e.user_id
      ORDER BY e.at DESC LIMIT ?
    `).all(limit);
  }
  res.json({ events: rows });
});

// Stats
router.get('/stats', (req, res) => {
  const totals = db.prepare('SELECT plan, COUNT(*) AS n FROM users GROUP BY plan').all();
  const onlineCount = db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n;
  const last24h = db.prepare("SELECT COUNT(*) AS n FROM event_log WHERE event='login' AND at > datetime('now','-1 day')").get().n;
  const kicked24h = db.prepare("SELECT COUNT(*) AS n FROM event_log WHERE event='kicked' AND at > datetime('now','-1 day')").get().n;
  const expiring = db.prepare(
    `SELECT COUNT(*) AS n FROM users WHERE expires_at IS NOT NULL AND expires_at < datetime('now','+14 days') AND expires_at > datetime('now')`
  ).get().n;
  res.json({
    totals: Object.fromEntries(totals.map((t) => [t.plan, t.n])),
    onlineCount,
    logins24h: last24h,
    kicked24h,
    expiringSoon: expiring,
    plans: Object.keys(PLANS),
  });
});

// Plans (read-only — defined in code)
router.get('/plans', (req, res) => res.json({ plans: PLANS }));

// ---------- Issued offline licenses (remote kill switch) ----------
router.get('/licenses', (req, res) => {
  const filter = String(req.query.filter || '').toLowerCase();
  const where = filter === 'revoked' ? 'WHERE revoked_at IS NOT NULL'
              : filter === 'active'  ? 'WHERE revoked_at IS NULL'
              : '';
  const rows = db.prepare(
    `SELECT id, customer, plan, issued_at, expires_at, revoked_at, revoke_reason, source, notes
     FROM issued_licenses ${where} ORDER BY issued_at DESC LIMIT 1000`
  ).all();
  res.json({ licenses: rows });
});

router.post('/licenses', (req, res) => {
  const { id, customer, plan, expires_at, notes, source = 'manual' } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id (UUID from license-tools) required' });
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'id must be a UUID' });
  const exists = db.prepare('SELECT 1 FROM issued_licenses WHERE id = ?').get(id);
  if (exists) return res.status(409).json({ error: 'license id already registered' });

  db.prepare(`INSERT INTO issued_licenses (id, customer, plan, expires_at, source, notes)
              VALUES (?,?,?,?,?,?)`)
    .run(id, customer || null, plan || null, expires_at || null, source, notes || null);
  res.json({ ok: true, id });
});

router.post('/licenses/:id/revoke', (req, res) => {
  const { reason } = req.body || {};
  const row = db.prepare('SELECT * FROM issued_licenses WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'unknown license id' });
  db.prepare('UPDATE issued_licenses SET revoked_at = CURRENT_TIMESTAMP, revoke_reason = ? WHERE id = ?')
    .run(reason || null, req.params.id);
  db.prepare('INSERT INTO event_log (user_id, ip, user_agent, event, details) VALUES (?,?,?,?,?)')
    .run(null, ipOf(req), '', 'license_revoked',
         JSON.stringify({ id: req.params.id, customer: row.customer, reason: reason || null, by: req.admin.email }));
  res.json({ ok: true });
});

router.delete('/licenses/:id/revoke', (req, res) => {
  const row = db.prepare('SELECT * FROM issued_licenses WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'unknown license id' });
  db.prepare('UPDATE issued_licenses SET revoked_at = NULL, revoke_reason = NULL WHERE id = ?')
    .run(req.params.id);
  db.prepare('INSERT INTO event_log (user_id, ip, user_agent, event, details) VALUES (?,?,?,?,?)')
    .run(null, ipOf(req), '', 'license_unrevoked',
         JSON.stringify({ id: req.params.id, customer: row.customer, by: req.admin.email }));
  res.json({ ok: true });
});

router.delete('/licenses/:id', (req, res) => {
  // Hard delete — only useful for cleanup of test entries
  db.prepare('DELETE FROM issued_licenses WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = function (deps) { return router; };
