// User self-service endpoints — Bearer-token (regular user session, NOT admin cookie).
// Mounted as: app.use('/api/user', require('./routes/user'));

const router = require('express').Router();
const bcrypt = require('bcryptjs');
const db = require('../db');
const { PLANS, getPlan, freeOverridePlan } = require('../plans');

function ipOf(req) {
  return (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() || req.ip || '';
}

function authBearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

function currentUser(req) {
  const token = authBearer(req);
  if (!token) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(token);
  if (!s) return null;
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id);
  return u ? { user: u, session: s } : null;
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

module.exports = router;
