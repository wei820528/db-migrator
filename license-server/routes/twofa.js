// 2FA setup / enable / disable / login-challenge endpoints.
// Mounted as: app.use('/api/auth/2fa', require('./routes/twofa'));
//
// Flow:
//   Setup:    POST /setup  (Bearer)         → { secret, uri, qrSvg }  (NOT yet enabled)
//   Enable:   POST /enable (Bearer, code)   → verifies; persists secret; enabled=1
//   Disable:  POST /disable(Bearer, code OR password) → wipes secret; enabled=0
//   Login challenge: handled in /api/auth/login + /api/auth/2fa/verify-login

const router = require('express').Router();
const crypto = require('crypto');
const db = require('../db');
const totp = require('../lib/totp');
const bcrypt = require('bcryptjs');

function authBearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}
function currentUser(req) {
  const token = authBearer(req);
  if (!token) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(token);
  if (!s) return null;
  return db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id);
}
function ipOf(req) {
  return (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() || req.ip || '';
}
function logEvent(userId, ip, ua, event, details) {
  db.prepare('INSERT INTO event_log (user_id, ip, user_agent, event, details) VALUES (?,?,?,?,?)').run(
    userId || null, ip || '', ua || '', event, details ? JSON.stringify(details) : null
  );
}

// In-memory store for partial "needs 2FA" login sessions.
// Lives 5 min. Each entry: { userId, ip, createdAt }
const pendingChallenges = new Map();
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
function issueChallenge(userId, ip) {
  const id = crypto.randomBytes(24).toString('hex');
  pendingChallenges.set(id, { userId, ip, createdAt: Date.now() });
  return id;
}
function consumeChallenge(id) {
  const c = pendingChallenges.get(id);
  if (!c) return null;
  pendingChallenges.delete(id);
  if (Date.now() - c.createdAt > CHALLENGE_TTL_MS) return null;
  return c;
}
setInterval(() => {
  const cutoff = Date.now() - CHALLENGE_TTL_MS;
  for (const [k, v] of pendingChallenges) if (v.createdAt < cutoff) pendingChallenges.delete(k);
}, 60 * 1000).unref();

// ============================================================
// POST /setup — Bearer required; user must NOT have 2FA enabled yet
// Returns { secret, uri, qrSvg } — secret is base32 (show + QR)
// ============================================================
router.post('/setup', async (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'not logged in' });
  if (u.totp_enabled) return res.status(400).json({ error: '2FA already enabled — disable first' });
  try {
    const s = await totp.setup(u.email);
    // Stash encrypted secret in DB but keep totp_enabled = 0 until /enable confirms
    db.prepare('UPDATE users SET totp_secret_enc = ? WHERE id = ?').run(s.secretEnc, u.id);
    res.json({ secret: s.secret, uri: s.uri, qrSvg: s.qrSvg });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// POST /enable — verifies the first code → enable 2FA
// ============================================================
router.post('/enable', (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'not logged in' });
  if (!u.totp_secret_enc) return res.status(400).json({ error: 'run /setup first' });
  if (u.totp_enabled) return res.status(400).json({ error: 'already enabled' });
  const code = req.body?.code;
  if (!totp.verify(code, u.totp_secret_enc)) {
    return res.status(401).json({ error: 'invalid code' });
  }
  db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(u.id);
  logEvent(u.id, ipOf(req), req.headers['user-agent'] || '', '2fa_enabled', null);
  res.json({ ok: true });
});

// ============================================================
// POST /disable — verifies current code OR password → disable
// ============================================================
router.post('/disable', (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'not logged in' });
  if (!u.totp_enabled) return res.status(400).json({ error: 'not enabled' });
  const { code, password } = req.body || {};

  const okByCode = code && totp.verify(code, u.totp_secret_enc);
  const okByPwd = password && bcrypt.compareSync(password, u.password_hash);
  if (!okByCode && !okByPwd) return res.status(401).json({ error: 'wrong code or password' });

  db.prepare('UPDATE users SET totp_enabled = 0, totp_secret_enc = NULL WHERE id = ?').run(u.id);
  logEvent(u.id, ipOf(req), req.headers['user-agent'] || '', '2fa_disabled', null);
  res.json({ ok: true });
});

// ============================================================
// POST /verify-login — second step after /auth/login returns needs2fa=true
// body: { challengeId, code }
// On success: issues normal session token (like /auth/login does)
// ============================================================
router.post('/verify-login', (req, res) => {
  const { challengeId, code } = req.body || {};
  if (!challengeId || !code) return res.status(400).json({ error: 'challengeId + code required' });
  const ch = consumeChallenge(challengeId);
  if (!ch) return res.status(401).json({ error: 'challenge expired or invalid' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(ch.userId);
  if (!user || !user.totp_enabled || !totp.verify(code, user.totp_secret_enc)) {
    return res.status(401).json({ error: 'invalid code' });
  }

  // Enforce max_devices like normal login
  const active = db.prepare('SELECT * FROM sessions WHERE user_id = ? ORDER BY last_seen ASC').all(user.id);
  while (active.length >= (user.max_devices || 1)) {
    const old = active.shift();
    db.prepare('DELETE FROM sessions WHERE id = ?').run(old.id);
    logEvent(user.id, old.ip, old.user_agent, 'kicked', { reason: 'max_devices_via_2fa' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (id, user_id, ip, user_agent) VALUES (?,?,?,?)')
    .run(token, user.id, ipOf(req), req.headers['user-agent'] || '');
  logEvent(user.id, ipOf(req), req.headers['user-agent'] || '', 'login', { via: '2fa' });

  res.json({ ok: true, token, user: { email: user.email, plan: user.plan } });
});

// Expose helpers used by /api/auth/login
router.issueChallenge = issueChallenge;

module.exports = router;
