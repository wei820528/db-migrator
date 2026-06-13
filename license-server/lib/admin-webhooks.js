// License-server admin webhooks — v2 Theme E follow-up (Phase 3)。
//
// 跟 node-express/lib/webhooks.js 同 architecture（為什麼不直接 reuse：
// (a) 不同 events 集合 (b) 不同 header prefix X-LicenseServer-* (c) 不同 secret
// prefix `lswhsec_` 易被 leak detector 抓 (d) 獨立的 SQLite DB 路徑）。
//
// 用法（server 內呼叫）：
//   const wh = require('./lib/admin-webhooks');
//   wh.emit('user.kicked', { userId, reason, ipAddr });
//
// 接收方驗章（範例 Node.js）：
//   const sig = req.headers['x-licenseserver-signature']; // 'sha256=...'
//   const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex');
//   if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) throw 'bad sig';

const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { URL } = require('url');

// 已知 event — admin alert 範圍。從 server.js / stripe.js 既有 logEvent 點上 fire。
const KNOWN_EVENTS = [
  'ping',                      // test-ping 永遠 trigger
  'user.kicked',               // session 被踢（IP changed / max devices / whitelist）
  'user.registered',           // 新 trial 帳號
  'license.expired',           // license / trial 過期 transition
  'payment.succeeded',         // Stripe invoice.paid 或 ECPay paid
  'payment.failed',            // Stripe invoice.payment_failed
  'subscription.canceled',     // 用戶取消訂閱
];

const RETRY_DELAYS_MS = [0, 2_000, 10_000];
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_SAMPLE = 512;

let Database;
try { Database = require('better-sqlite3'); }
catch { /* 沒裝 → emit() 變 no-op */ }

let db = null;
let dbPath = path.join(__dirname, '..', 'admin-webhooks.db');

function setDbPath(p) { dbPath = p; if (db) { try { db.close(); } catch {} db = null; } }

function getDb() {
  if (db) return db;
  if (!Database) return null;
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_webhooks (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      url           TEXT NOT NULL,
      secret_hash   TEXT NOT NULL,
      secret_prefix TEXT NOT NULL,
      events        TEXT NOT NULL,
      active        INTEGER NOT NULL DEFAULT 1,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_at       DATETIME,
      last_status   INTEGER,
      last_event    TEXT,
      last_error    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_admin_webhooks_active ON admin_webhooks(active);
  `);
  return db;
}

// ============ Secret 產生 / 簽章 ============

function generateSecret() {
  // lswhsec_ prefix 給 leak detector — 跟 node-express 的 whsec_ 不一樣，方便區分來源
  return 'lswhsec_' + crypto.randomBytes(32).toString('base64url');
}

function hashSecret(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function signBody(secret, rawBody) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

// ============ CRUD ============

function createWebhook({ name, url, events }) {
  if (!name || !url) throw new Error('name + url required');
  validateUrl(url);
  validateEvents(events);
  const d = getDb();
  if (!d) throw new Error('better-sqlite3 not installed');
  const id = crypto.randomUUID();
  const secret = generateSecret();
  d.prepare(`INSERT INTO admin_webhooks (id, name, url, secret_hash, secret_prefix, events, active)
             VALUES (?,?,?,?,?,?,?)`)
    .run(id, String(name).slice(0, 64), url, hashSecret(secret), secret.slice(0, 12),
         JSON.stringify(events), 1);
  // 加密 secret 接到 hash 後面用 '|' 隔開 — 跟 node-express 一致 format
  if (encrypt) {
    const cur = d.prepare('SELECT secret_hash FROM admin_webhooks WHERE id = ?').get(id);
    d.prepare('UPDATE admin_webhooks SET secret_hash = ? WHERE id = ?')
      .run(cur.secret_hash + '|' + encrypt.encrypt(secret), id);
  }
  // secret 只在 create 回傳一次（同 API token / Stripe webhook 設計）
  return { id, name, url, events, secret, secret_prefix: secret.slice(0, 12) };
}

function listWebhooks() {
  const d = getDb();
  if (!d) return [];
  return d.prepare(`SELECT id, name, url, secret_prefix, events, active,
                           created_at, last_at, last_status, last_event, last_error
                    FROM admin_webhooks ORDER BY created_at DESC`).all().map((r) => ({
    ...r,
    events: safeJson(r.events, []),
    active: !!r.active,
  }));
}

function updateWebhook(id, patch) {
  const d = getDb();
  if (!d) throw new Error('better-sqlite3 not installed');
  const cur = d.prepare('SELECT * FROM admin_webhooks WHERE id = ?').get(id);
  if (!cur) return null;
  const fields = [];
  const vals = [];
  for (const k of ['name', 'url', 'events', 'active']) {
    if (!(k in patch)) continue;
    if (k === 'url') validateUrl(patch[k]);
    if (k === 'events') validateEvents(patch[k]);
    let v = patch[k];
    if (k === 'events') v = JSON.stringify(v);
    if (k === 'active') v = v ? 1 : 0;
    fields.push(`${k} = ?`); vals.push(v);
  }
  if (fields.length === 0) return cur;
  vals.push(id);
  d.prepare(`UPDATE admin_webhooks SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  return d.prepare('SELECT * FROM admin_webhooks WHERE id = ?').get(id);
}

function deleteWebhook(id) {
  const d = getDb();
  if (!d) return false;
  return d.prepare('DELETE FROM admin_webhooks WHERE id = ?').run(id).changes > 0;
}

// ============ Emit / dispatch ============

function emit(event, payload) {
  if (!KNOWN_EVENTS.includes(event)) {
    console.warn(`[admin-webhooks] emit unknown event: ${event}`);
    return;
  }
  const d = getDb();
  if (!d) return;
  const subs = d.prepare('SELECT * FROM admin_webhooks WHERE active = 1').all()
    .filter((r) => {
      const evs = safeJson(r.events, []);
      return evs.includes(event) || evs.includes('*');
    });
  if (subs.length === 0) return;
  for (const sub of subs) {
    deliverWithRetry(sub, event, payload).catch((e) => {
      console.warn(`[admin-webhooks] delivery to ${sub.url} failed:`, e.message);
    });
  }
}

async function testPing(id) {
  const d = getDb();
  if (!d) throw new Error('better-sqlite3 not installed');
  const sub = d.prepare('SELECT * FROM admin_webhooks WHERE id = ?').get(id);
  if (!sub) throw new Error('webhook not found');
  return deliverWithRetry(sub, 'ping', {
    message: 'test ping from DB Migrator License Server', sent_at: new Date().toISOString(),
  });
}

async function deliverWithRetry(sub, event, payload) {
  const deliveryId = crypto.randomUUID();
  const fullPayload = { event, deliveryId, occurred_at: new Date().toISOString(), data: payload };
  const body = JSON.stringify(fullPayload);

  const signingKey = decryptSecret(sub);
  const sig = signBody(signingKey, body);

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'DB-Migrator-LicenseServer-Webhook/1.0',
    'X-LicenseServer-Event': event,
    'X-LicenseServer-Delivery': deliveryId,
    'X-LicenseServer-Signature': sig,
  };

  let lastErr, lastStatus;
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
    if (RETRY_DELAYS_MS[attempt] > 0) await sleep(RETRY_DELAYS_MS[attempt]);
    try {
      const res = await httpPost(sub.url, body, headers);
      lastStatus = res.status;
      if (res.status >= 200 && res.status < 300) {
        recordDelivery(sub.id, event, res.status, null);
        return { ok: true, status: res.status, attempt: attempt + 1 };
      }
      lastErr = `HTTP ${res.status} (body: ${res.bodySample})`;
    } catch (e) {
      lastErr = e.message;
    }
  }
  recordDelivery(sub.id, event, lastStatus ?? 0, lastErr);
  return { ok: false, attempts: RETRY_DELAYS_MS.length, error: lastErr };
}

function recordDelivery(id, event, status, error) {
  const d = getDb();
  if (!d) return;
  d.prepare(`UPDATE admin_webhooks SET last_at = CURRENT_TIMESTAMP, last_status = ?,
             last_event = ?, last_error = ? WHERE id = ?`)
    .run(status, event, error ? String(error).slice(0, MAX_RESPONSE_SAMPLE) : null, id);

  // 進 Prometheus metrics — 跟 client-side webhook 同 metric naming convention
  try {
    require('./metrics').counter('licenseserver_webhook_deliveries_total',
      'Admin webhook deliveries by event and outcome')
      .inc({ event, status: (status >= 200 && status < 300) ? 'ok' : 'fail' });
  } catch { /* metrics 沒裝 — non-fatal */ }
}

// ============ Secret encryption（用 lib/encrypt） ============

let encrypt;
try { encrypt = require('./encrypt'); } catch { /* 沒 encrypt → emit no-op */ }

function decryptSecret(sub) {
  const parts = String(sub.secret_hash || '').split('|');
  if (parts.length < 2 || !encrypt) return '';
  try { return encrypt.decrypt(parts[1]); } catch { return ''; }
}

// ============ Helpers ============

function validateUrl(url) {
  let u;
  try { u = new URL(String(url)); } catch { throw new Error('url must be a valid URL'); }
  if (!['http:', 'https:'].includes(u.protocol)) {
    throw new Error('url must be http:// or https://');
  }
}

function validateEvents(events) {
  if (!Array.isArray(events) || events.length === 0) {
    throw new Error('events must be a non-empty array');
  }
  for (const e of events) {
    if (e === '*') continue;
    if (!KNOWN_EVENTS.includes(e)) throw new Error(`unknown event: ${e}`);
  }
}

function safeJson(s, fallback) { try { return JSON.parse(s); } catch { return fallback; } }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function httpPost(url, body, headers) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error('bad url')); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      method: 'POST',
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      const chunks = []; let total = 0;
      res.on('data', (c) => { total += c.length; if (total <= MAX_RESPONSE_SAMPLE) chunks.push(c); });
      res.on('end', () => resolve({
        status: res.statusCode,
        bodySample: Buffer.concat(chunks).toString('utf8').slice(0, MAX_RESPONSE_SAMPLE),
      }));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

module.exports = {
  KNOWN_EVENTS,
  createWebhook,
  listWebhooks,
  updateWebhook,
  deleteWebhook,
  emit,
  testPing,
  // 暴露給 tests
  _internal: {
    generateSecret, hashSecret, signBody, validateUrl, validateEvents,
    setDbPath, deliverWithRetry,
  },
};
