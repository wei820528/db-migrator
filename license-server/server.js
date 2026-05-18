const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const db = require('./db');
const { getPlan, freeOverridePlan } = require('./plans');
const email = require('./lib/email');
const ip = require('./lib/ip');

const app = express();
const PORT = process.env.PORT || 4000;

app.set('trust proxy', true);
app.use(cookieParser());
app.use('/admin', express.static(path.join(__dirname, 'public')));

// OpenAPI 3.0 spec + Swagger UI（v2 Theme C Phase 3）
app.get('/openapi.json', (req, res) => {
  res.sendFile(path.join(__dirname, 'openapi.json'));
});
app.use('/api-docs', express.static(path.join(__dirname, 'public', 'api-docs')));

// Stripe webhook needs raw body — register BEFORE express.json()
const stripeRoutes = require('./routes/stripe');
app.use('/api/billing', stripeRoutes);

// ECPay return needs URL-encoded body — register BEFORE global express.json()
const ecpayRoutes = require('./routes/billing-ecpay');
app.use('/api/billing/ecpay', ecpayRoutes);

app.use(express.json({ limit: '256kb' }));

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, PATCH, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// =================================================================
// Helpers
// =================================================================
function logEvent(userId, ipAddr, ua, event, details) {
  db.prepare('INSERT INTO event_log (user_id, ip, user_agent, event, details) VALUES (?,?,?,?,?)').run(
    userId || null, ipAddr || '', ua || '', event, details ? JSON.stringify(details) : null
  );
}
function ipOf(req) {
  return (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() || req.ip || '';
}
function authBearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}
function loadSession(token) {
  if (!token) return null;
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(token);
}
function loadUser(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

// Returns { ok, status, plan, features, daysLeft, error?, freeOverride? }
function checkUserStatus(user) {
  if (!user) return { ok: false, status: 'unknown' };

  // Free-this-month override → behaves like 'team' until free_until expires
  if (user.free_until) {
    const until = new Date(user.free_until);
    if (until > new Date()) {
      const plan = freeOverridePlan();
      return {
        ok: true, status: 'free', plan,
        daysLeft: Math.ceil((until - new Date()) / (1000 * 60 * 60 * 24)),
        freeOverride: true,
      };
    }
  }

  const plan = getPlan(user.plan);

  if (user.plan === 'trial') {
    const start = user.trial_started_at ? new Date(user.trial_started_at) : null;
    if (!start) return { ok: true, status: 'trial', plan, daysLeft: plan.duration_days };
    const elapsed = (Date.now() - start.getTime()) / (1000 * 60 * 60 * 24);
    const daysLeft = Math.max(0, Math.ceil(plan.duration_days - elapsed));
    if (daysLeft === 0) return { ok: false, status: 'expired', plan, error: 'Trial period ended' };
    return { ok: true, status: 'trial', plan, daysLeft };
  }

  if (user.expires_at) {
    const exp = new Date(user.expires_at);
    if (exp < new Date()) return { ok: false, status: 'expired', plan, error: 'Subscription expired' };
    return { ok: true, status: 'licensed', plan, daysLeft: Math.ceil((exp - new Date()) / (1000 * 60 * 60 * 24)) };
  }

  return { ok: true, status: 'licensed', plan, daysLeft: null };
}

function authResponse(user, status) {
  return {
    ok: true,
    user: { email: user.email, plan: user.plan },
    status: status.status,
    daysLeft: status.daysLeft,
    features: status.plan.features,
    maxDevices: user.max_devices,
    freeOverride: !!status.freeOverride,
  };
}

// =================================================================
// Rate limit — auth endpoints
// =================================================================
const authLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,  // 5 min
  limit: 20,                 // 20 requests per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many auth requests, slow down.' },
});

// =================================================================
// AUTH endpoints (for the DB Migrator app to use)
// =================================================================

// Register — creates a trial user (must verify email before login if SMTP configured)
app.post('/api/auth/register', authLimiter, async (req, res) => {
  const { email: emailAddr, password } = req.body || {};
  if (!emailAddr || !password) return res.status(400).json({ error: 'email + password required' });
  if (password.length < 8) return res.status(400).json({ error: 'password must be ≥ 8 chars' });
  const exists = db.prepare('SELECT 1 FROM users WHERE email = ?').get(emailAddr.toLowerCase());
  if (exists) return res.status(409).json({ error: 'email already registered' });

  const id = crypto.randomUUID();
  const hash = bcrypt.hashSync(password, 10);
  const verifyToken = crypto.randomBytes(24).toString('hex');
  const requireVerify = !!process.env.SMTP_HOST;  // if SMTP not set, auto-verify (dev)

  db.prepare(`INSERT INTO users (id, email, password_hash, plan, max_devices, trial_started_at,
              email_verified, email_verify_token)
              VALUES (?, ?, ?, 'trial', 1, CURRENT_TIMESTAMP, ?, ?)`)
    .run(id, emailAddr.toLowerCase(), hash, requireVerify ? 0 : 1, verifyToken);
  logEvent(id, ipOf(req), req.headers['user-agent'] || '', 'register', { email: emailAddr });

  let emailResult = null;
  try { emailResult = await email.sendVerification(emailAddr.toLowerCase(), verifyToken); }
  catch (e) { console.error('[email] send failed:', e.message); }

  res.json({
    ok: true,
    message: requireVerify
      ? '已寄出驗證信，請點信中連結啟用帳號'
      : '帳號已建立（dev mode 跳過 email 驗證）',
    devLink: emailResult?.dev ? emailResult.link : undefined,
  });
});

// Email verify
app.get('/api/auth/verify-email', (req, res) => {
  const token = String(req.query.token || '');
  if (!token) return res.status(400).send('Missing token');
  const user = db.prepare('SELECT * FROM users WHERE email_verify_token = ?').get(token);
  if (!user) return res.status(404).send('無效或已使用過的驗證連結');
  db.prepare('UPDATE users SET email_verified = 1, email_verify_token = NULL WHERE id = ?').run(user.id);
  logEvent(user.id, ipOf(req), req.headers['user-agent'] || '', 'email_verified', null);
  res.send(`<!doctype html><meta charset="utf-8"><title>已驗證</title>
    <body style="font-family:-apple-system,sans-serif;max-width:500px;margin:80px auto;text-align:center;">
    <h1>✅ Email 已驗證</h1><p>${user.email} 現在可以登入了。</p></body>`);
});

// Login
app.post('/api/auth/login', authLimiter, (req, res) => {
  const { email: emailAddr, password } = req.body || {};
  if (!emailAddr || !password) return res.status(400).json({ error: 'email + password required' });
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(emailAddr).toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password_hash))
    return res.status(401).json({ error: 'invalid credentials' });

  if (!user.email_verified) return res.status(403).json({ error: '請先驗證 email 才能登入' });

  // If user has 2FA enabled, issue a challenge and require /2fa/verify-login as step 2
  if (user.totp_enabled) {
    const challengeId = twofaRoutes.issueChallenge(user.id, ipOf(req));
    logEvent(user.id, ipOf(req), req.headers['user-agent'] || '', '2fa_challenge', null);
    return res.json({ needs2fa: true, challengeId });
  }

  const status = checkUserStatus(user);
  if (!status.ok) {
    logEvent(user.id, ipOf(req), req.headers['user-agent'] || '', 'login_blocked', { reason: status.error });
    return res.status(403).json({ error: status.error, status: status.status });
  }

  // IP whitelist check
  const ipAddr = ipOf(req);
  const wl = ip.checkAllowed(user.ip_whitelist, ipAddr);
  if (!wl.allowed) {
    logEvent(user.id, ipAddr, req.headers['user-agent'] || '', 'login_blocked', { reason: wl.reason });
    return res.status(403).json({ error: wl.reason });
  }

  // Enforce max_devices
  const active = db.prepare('SELECT * FROM sessions WHERE user_id = ? ORDER BY last_seen ASC').all(user.id);
  const max = user.max_devices || 1;
  while (active.length >= max) {
    const old = active.shift();
    db.prepare('DELETE FROM sessions WHERE id = ?').run(old.id);
    logEvent(user.id, old.ip, old.user_agent, 'kicked', { reason: 'max_devices', newDeviceIp: ipAddr });
  }

  const token = crypto.randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO sessions (id, user_id, ip, user_agent) VALUES (?,?,?,?)`)
    .run(token, user.id, ipAddr, req.headers['user-agent'] || '');
  logEvent(user.id, ipAddr, req.headers['user-agent'] || '', 'login', null);

  res.json({ token, ...authResponse(user, status) });
});

// Heartbeat
app.post('/api/auth/heartbeat', (req, res) => {
  const token = authBearer(req);
  const session = loadSession(token);
  if (!session) return res.status(401).json({ error: 'no session', kicked: true });

  const ipAddr = ipOf(req);
  const ua = req.headers['user-agent'] || '';

  if (session.ip !== ipAddr) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(token);
    logEvent(session.user_id, ipAddr, ua, 'kicked', { reason: 'ip_changed', oldIp: session.ip, newIp: ipAddr });
    return res.status(401).json({ error: 'kicked: IP changed', kicked: true });
  }

  const user = loadUser(session.user_id);
  // Re-check whitelist (admin may have added one since login)
  const wl = ip.checkAllowed(user.ip_whitelist, ipAddr);
  if (!wl.allowed) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(token);
    logEvent(user.id, ipAddr, ua, 'kicked', { reason: wl.reason });
    return res.status(403).json({ error: wl.reason, kicked: true });
  }

  const status = checkUserStatus(user);
  if (!status.ok) {
    logEvent(user.id, ipAddr, ua, 'expired', null);
    return res.status(403).json({ error: status.error, status: status.status });
  }

  db.prepare('UPDATE sessions SET last_seen = CURRENT_TIMESTAMP WHERE id = ?').run(token);
  res.json(authResponse(user, status));
});

// Me
app.get('/api/auth/me', (req, res) => {
  const token = authBearer(req);
  const session = loadSession(token);
  if (!session) return res.status(401).json({ error: 'no session', kicked: true });
  const user = loadUser(session.user_id);
  const status = checkUserStatus(user);
  res.json({
    ...authResponse(user, status),
    session: { ip: session.ip, started: session.created_at, lastSeen: session.last_seen },
  });
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  const token = authBearer(req);
  const session = loadSession(token);
  if (session) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(token);
    logEvent(session.user_id, ipOf(req), req.headers['user-agent'] || '', 'logout', null);
  }
  res.json({ ok: true });
});

// =================================================================
// Health + admin routes
// =================================================================
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.use('/api/admin', require('./routes/admin')({ logEvent, ipOf, checkUserStatus }));
app.use('/api/user',  require('./routes/user'));
app.use('/api/revocation', require('./routes/revocation'));

const twofaRoutes = require('./routes/twofa');
app.use('/api/auth/2fa', twofaRoutes);

app.listen(PORT, () => {
  console.log(`License server listening on http://localhost:${PORT}`);
  console.log(`Admin UI: http://localhost:${PORT}/admin/`);
  console.log(`DB: ${process.env.LICENSE_DB || './license.db'}`);
});
