// Webhook delivery — v2 Theme C Phase 4。
//
// 用法：
//   const wh = require('./lib/webhooks');
//   wh.emit('job.done', { jobId, kind, result });
//
// 自己存 SQLite（webhooks.db），自己 dispatch（HTTPS POST + retry）。
// 簽章用 HMAC-SHA256 of body，header X-DBMigrator-Signature: sha256=<hex>。
// 接收方驗章方式（範例 Node.js）：
//   const sig = req.headers['x-dbmigrator-signature']; // 'sha256=...'
//   const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex');
//   if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) throw 'bad sig';

const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { URL } = require('url');

// 已知 event 集合 — 新增 event 時加進來，UI 也會引用
const KNOWN_EVENTS = [
  'ping',                  // 給 test-ping 用，永遠 trigger
  'job.done',              // 任何 job 完成
  'job.failed',            // 任何 job 失敗
  'schedule.run.ok',       // 排程備份完成
  'schedule.run.failed',   // 排程備份失敗
  'license.expired',       // license / trial 剛過期（transition）
];

const RETRY_DELAYS_MS = [0, 2_000, 10_000];     // 第一次立刻、第二次 2s、第三次 10s
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_SAMPLE = 512;                 // 留下後給 UI 顯示的最大長度

let Database;
try { Database = require('better-sqlite3'); }
catch { /* better-sqlite3 未裝；emit() 會 no-op */ }

let db = null;          // 延遲初始化（讓 require 順序不卡）
let dbPath = path.join(__dirname, '..', 'webhooks.db');

function setDbPath(p) { dbPath = p; if (db) { try { db.close(); } catch {} db = null; } }

function getDb() {
  if (db) return db;
  if (!Database) return null;        // better-sqlite3 不在，emit() 變 no-op
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhooks (
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
    CREATE INDEX IF NOT EXISTS idx_webhooks_active ON webhooks(active);
  `);
  return db;
}

// ============ Secret 產生 / 簽章 ============

function generateSecret() {
  return 'whsec_' + crypto.randomBytes(32).toString('base64url');
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
  d.prepare(`INSERT INTO webhooks (id, name, url, secret_hash, secret_prefix, events, active)
             VALUES (?,?,?,?,?,?,?)`)
    .run(id, String(name).slice(0, 64), url, hashSecret(secret), secret.slice(0, 12),
         JSON.stringify(events), 1);
  // secret 只在 create 回傳一次（同 API token 設計）
  return { id, name, url, events, secret, secret_prefix: secret.slice(0, 12) };
}

function listWebhooks() {
  const d = getDb();
  if (!d) return [];
  const rows = d.prepare(`SELECT id, name, url, secret_prefix, events, active,
                                 created_at, last_at, last_status, last_event, last_error
                          FROM webhooks ORDER BY created_at DESC`).all();
  return rows.map((r) => ({
    ...r,
    events: safeJson(r.events, []),
    active: !!r.active,
  }));
}

function updateWebhook(id, patch) {
  const d = getDb();
  if (!d) throw new Error('better-sqlite3 not installed');
  const cur = d.prepare('SELECT * FROM webhooks WHERE id = ?').get(id);
  if (!cur) return null;
  const allowed = ['name', 'url', 'events', 'active'];
  const fields = [];
  const vals = [];
  for (const k of allowed) {
    if (!(k in patch)) continue;
    if (k === 'url') validateUrl(patch[k]);
    if (k === 'events') validateEvents(patch[k]);
    let v = patch[k];
    if (k === 'events') v = JSON.stringify(v);
    if (k === 'active') v = v ? 1 : 0;
    fields.push(`${k} = ?`);
    vals.push(v);
  }
  if (fields.length === 0) return cur;
  vals.push(id);
  d.prepare(`UPDATE webhooks SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  return d.prepare('SELECT * FROM webhooks WHERE id = ?').get(id);
}

function deleteWebhook(id) {
  const d = getDb();
  if (!d) return false;
  return d.prepare('DELETE FROM webhooks WHERE id = ?').run(id).changes > 0;
}

// ============ Emit / dispatch ============

// 公開 API：呼叫者只丟事件名稱 + payload，dispatcher 自己查訂閱者。
// 非同步（fire-and-forget），不阻塞 caller。
function emit(event, payload) {
  if (!KNOWN_EVENTS.includes(event)) {
    console.warn(`[webhooks] emit unknown event: ${event}`);
    return;
  }
  const d = getDb();
  if (!d) return;
  const subs = d.prepare('SELECT * FROM webhooks WHERE active = 1').all()
    .filter((r) => {
      const evs = safeJson(r.events, []);
      return evs.includes(event) || evs.includes('*');
    });
  if (subs.length === 0) return;
  for (const sub of subs) {
    // 不要 await — 讓 caller 立刻返回
    deliverWithRetry(sub, event, payload).catch((e) => {
      console.warn(`[webhooks] delivery to ${sub.url} failed:`, e.message);
    });
  }
}

// Test-ping：刻意 deliver 給單一 webhook 不管其 event 訂閱清單。
// 走 retry 流程（短 retry），讓使用者立刻看到結果。
async function testPing(id) {
  const d = getDb();
  if (!d) throw new Error('better-sqlite3 not installed');
  const sub = d.prepare('SELECT * FROM webhooks WHERE id = ?').get(id);
  if (!sub) throw new Error('webhook not found');
  return deliverWithRetry(sub, 'ping', { message: 'test ping from DB Migrator', sent_at: new Date().toISOString() });
}

async function deliverWithRetry(sub, event, payload) {
  const deliveryId = crypto.randomUUID();
  const fullPayload = { event, deliveryId, occurred_at: new Date().toISOString(), data: payload };
  const body = JSON.stringify(fullPayload);

  // Server 要能簽 HMAC，所以 secret 必須能被還原回明文 — 用 AES-256-GCM 加密
  // 後接在 secret_hash 欄位後面（'<sha256>|<encrypted>' 格式）。
  // 詳見下方 encryptSecret / decryptSecret。
  const signingKey = decryptSecret(sub);
  const sig = signBody(signingKey, body);

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'DB-Migrator-Webhook/1.0',
    'X-DBMigrator-Event': event,
    'X-DBMigrator-Delivery': deliveryId,
    'X-DBMigrator-Signature': sig,
  };

  let lastErr;
  let lastStatus;
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
  d.prepare(`UPDATE webhooks SET last_at = CURRENT_TIMESTAMP, last_status = ?,
             last_event = ?, last_error = ? WHERE id = ?`)
    .run(status, event, error ? String(error).slice(0, MAX_RESPONSE_SAMPLE) : null, id);
}

// ============ 加解密 secret（用既有的 AES-256-GCM helpers） ============
//
// Server 要能 sign HMAC → 必須留得到原始 secret → 用 lib/encrypt（AES-256-GCM）
// 加密後存。為了避免多開欄位，把 'sha256-hash | base64-encrypted' 放在同個
// secret_hash 欄位裡，'|' 分隔。

let encrypt;
try { encrypt = require('./encrypt'); } catch { /* 沒 encrypt module → emit 會 no-op */ }

function encryptSecret(secret) {
  if (!encrypt) return '';
  return '|' + encrypt.encrypt(secret);
}
function decryptSecret(sub) {
  const parts = String(sub.secret_hash || '').split('|');
  if (parts.length < 2 || !encrypt) return '';
  try { return encrypt.decrypt(parts[1]); }
  catch { return ''; }
}

// createWebhook 包一層 — insert 完 UPDATE 把加密 secret append 到 secret_hash 欄位
const _origCreate = createWebhook;
function createWebhookWithEncryption(args) {
  const r = _origCreate(args);
  const d = getDb();
  if (!d || !encrypt) return r;
  const cur = d.prepare('SELECT secret_hash FROM webhooks WHERE id = ?').get(r.id);
  d.prepare('UPDATE webhooks SET secret_hash = ? WHERE id = ?')
    .run(cur.secret_hash + encryptSecret(r.secret), r.id);
  return r;
}

// ============ Helpers ============

function validateUrl(url) {
  let u;
  try { u = new URL(String(url)); }
  catch { throw new Error('url must be a valid URL'); }
  if (!['http:', 'https:'].includes(u.protocol))
    throw new Error('url must be http:// or https://');
}

function validateEvents(events) {
  if (!Array.isArray(events) || events.length === 0)
    throw new Error('events must be a non-empty array');
  for (const e of events) {
    if (e === '*') continue;     // wildcard 訂閱所有
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
      const chunks = [];
      let total = 0;
      res.on('data', (c) => {
        total += c.length;
        if (total <= MAX_RESPONSE_SAMPLE) chunks.push(c);
      });
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
  createWebhook: createWebhookWithEncryption,
  listWebhooks,
  updateWebhook,
  deleteWebhook,
  emit,
  testPing,
  generateSecret,
  hashSecret,
  signBody,
  setDbPath,
  // for tests
  _internal: { httpPost, RETRY_DELAYS_MS, validateUrl, validateEvents, decryptSecret },
};
