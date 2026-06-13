// v2 Theme E follow-up tests — license-server admin webhooks (Phase 3)。
//
// 純函式：generateSecret / hashSecret / signBody / validateUrl / validateEvents
// SQLite-dependent (createWebhook / list / emit) 用 test.skip 在沒裝
// better-sqlite3 環境跳過 — 跟 node-express webhooks.test.js 同 pattern。

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const wh = require('../lib/admin-webhooks');
const { _internal } = wh;

// 偵測 better-sqlite3 — 沒裝就 skip 所有 sqlite-dependent test
let canSqlite = false;
try { require('better-sqlite3'); canSqlite = true; } catch {}
const itDb = canSqlite ? test : test.skip;

// 每 test 用獨立 tmp DB 避免互相干擾
function freshDb() {
  const p = path.join(os.tmpdir(), `dbm-adminwh-test-${crypto.randomUUID()}.db`);
  _internal.setDbPath(p);
  return p;
}

process.on('exit', () => {
  // cleanup any leftover tmp DBs from this run
  for (const f of fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('dbm-adminwh-test-'))) {
    try { fs.unlinkSync(path.join(os.tmpdir(), f)); } catch {}
  }
});

// ============ secret / signing pure functions ============

test('generateSecret: lswhsec_ prefix + base64url body', () => {
  const s = _internal.generateSecret();
  assert.match(s, /^lswhsec_[A-Za-z0-9_-]+$/);
  assert.ok(s.length >= 12);
});

test('generateSecret: 不重複 (10 取樣)', () => {
  const set = new Set();
  for (let i = 0; i < 10; i++) set.add(_internal.generateSecret());
  assert.strictEqual(set.size, 10);
});

test('hashSecret: deterministic SHA-256 hex (64 chars)', () => {
  const h1 = _internal.hashSecret('xxx');
  const h2 = _internal.hashSecret('xxx');
  assert.strictEqual(h1, h2);
  assert.match(h1, /^[0-9a-f]{64}$/);
});

test('hashSecret: 不同 input 不同 hash', () => {
  assert.notStrictEqual(_internal.hashSecret('a'), _internal.hashSecret('b'));
});

test('signBody: header 包 sha256= prefix + hex digest', () => {
  const sig = _internal.signBody('secret', 'payload-body');
  assert.match(sig, /^sha256=[0-9a-f]{64}$/);
});

test('signBody: 同 input 同 sig (deterministic)', () => {
  assert.strictEqual(
    _internal.signBody('s', 'b'),
    _internal.signBody('s', 'b'),
  );
});

test('signBody: secret 不同 sig 不同', () => {
  assert.notStrictEqual(
    _internal.signBody('s1', 'b'),
    _internal.signBody('s2', 'b'),
  );
});

test('signBody: body 不同 sig 不同', () => {
  assert.notStrictEqual(
    _internal.signBody('s', 'b1'),
    _internal.signBody('s', 'b2'),
  );
});

// ============ URL / events validation ============

test('validateUrl: http / https 通過', () => {
  assert.doesNotThrow(() => _internal.validateUrl('http://example.com/hook'));
  assert.doesNotThrow(() => _internal.validateUrl('https://example.com/hook'));
});

test('validateUrl: ftp / file / 亂字串 throw', () => {
  assert.throws(() => _internal.validateUrl('ftp://example.com'),  /http:\/\/ or https:\/\//);
  assert.throws(() => _internal.validateUrl('file:///etc/passwd'), /http:\/\/ or https:\/\//);
  assert.throws(() => _internal.validateUrl('not-a-url'), /valid URL/);
});

test('validateEvents: KNOWN_EVENTS 通過', () => {
  assert.doesNotThrow(() => _internal.validateEvents(['user.kicked']));
  assert.doesNotThrow(() => _internal.validateEvents(['user.kicked', 'license.expired']));
  assert.doesNotThrow(() => _internal.validateEvents(['*']));
});

test('validateEvents: 空 / 非陣列 throw', () => {
  assert.throws(() => _internal.validateEvents([]),   /non-empty/);
  assert.throws(() => _internal.validateEvents('x'),  /non-empty/);
  assert.throws(() => _internal.validateEvents(null), /non-empty/);
});

test('validateEvents: 沒列在 KNOWN_EVENTS throw', () => {
  assert.throws(() => _internal.validateEvents(['nonsense.event']), /unknown event/);
});

test('KNOWN_EVENTS 公開 — UI 跟 test 都可以引用', () => {
  assert.ok(Array.isArray(wh.KNOWN_EVENTS));
  assert.ok(wh.KNOWN_EVENTS.includes('ping'));
  assert.ok(wh.KNOWN_EVENTS.includes('user.kicked'));
  assert.ok(wh.KNOWN_EVENTS.includes('payment.failed'));
});

// ============ CRUD (needs better-sqlite3) ============

itDb('createWebhook: 回 secret + prefix + id; 之後 list 看得到', () => {
  freshDb();
  const r = wh.createWebhook({
    name: 'My Hook', url: 'https://example.com/hook',
    events: ['user.kicked', 'license.expired'],
  });
  assert.match(r.id, /^[0-9a-f-]+$/);
  assert.match(r.secret, /^lswhsec_/);
  assert.strictEqual(r.secret_prefix, r.secret.slice(0, 12));
  const items = wh.listWebhooks();
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].name, 'My Hook');
  assert.deepStrictEqual(items[0].events, ['user.kicked', 'license.expired']);
});

itDb('createWebhook: list 回傳不包 plaintext secret', () => {
  freshDb();
  const created = wh.createWebhook({ name: 'X', url: 'https://x', events: ['ping'] });
  const items = wh.listWebhooks();
  assert.strictEqual(items[0].secret_prefix, created.secret_prefix);
  // 不該有 secret 全文
  assert.ok(!('secret' in items[0]));
});

itDb('createWebhook: 拒 invalid url', () => {
  freshDb();
  assert.throws(() => wh.createWebhook({ name: 'X', url: 'ftp://x', events: ['ping'] }),
    /http:\/\/ or https:\/\//);
});

itDb('createWebhook: 拒 unknown event', () => {
  freshDb();
  assert.throws(() => wh.createWebhook({ name: 'X', url: 'https://x', events: ['weird'] }),
    /unknown event/);
});

itDb('updateWebhook: patch fields', () => {
  freshDb();
  const c = wh.createWebhook({ name: 'A', url: 'https://a', events: ['ping'] });
  wh.updateWebhook(c.id, { name: 'B', active: false });
  const items = wh.listWebhooks();
  assert.strictEqual(items[0].name, 'B');
  assert.strictEqual(items[0].active, false);
});

itDb('updateWebhook: patch events validates', () => {
  freshDb();
  const c = wh.createWebhook({ name: 'A', url: 'https://a', events: ['ping'] });
  assert.throws(() => wh.updateWebhook(c.id, { events: ['nonsense'] }), /unknown event/);
});

itDb('deleteWebhook: 真的拿掉', () => {
  freshDb();
  const c = wh.createWebhook({ name: 'A', url: 'https://a', events: ['ping'] });
  assert.strictEqual(wh.deleteWebhook(c.id), true);
  assert.strictEqual(wh.listWebhooks().length, 0);
  assert.strictEqual(wh.deleteWebhook(c.id), false);   // 第二次砍不到
});

itDb('emit: 沒訂閱該 event 就不 fire (用 wildcard 才會)', () => {
  freshDb();
  // 只訂閱 user.kicked，emit license.expired 不 fire
  wh.createWebhook({ name: 'A', url: 'http://127.0.0.1:1/should-not-fire',
                     events: ['user.kicked'] });
  // 不該 throw 也不該 hit network — emit() 是 fire-and-forget；只測 sync path
  wh.emit('license.expired', { userId: 'u1' });
  // 因為沒 fire，list 看 last_event 應該是 null
  const items = wh.listWebhooks();
  assert.strictEqual(items[0].last_event, null);
});

itDb('emit: unknown event 不 throw (console.warn only)', () => {
  freshDb();
  assert.doesNotThrow(() => wh.emit('nonsense.event', {}));
});
