// Phase 4 tests — webhook signing + helper validators。
// CRUD + delivery 路徑要 better-sqlite3 + encrypt 兩個 lib，未裝環境 skip。

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');

// 純函式（signBody / generateSecret / hashSecret / KNOWN_EVENTS）永遠可用
let wh;
try { wh = require('../lib/webhooks'); }
catch { /* better-sqlite3 missing — module still loads but some methods are no-op */ wh = null; }

// 仍然能拿到 module（require 不會 throw — better-sqlite3 不在時只是 emit 變 no-op）
wh = require('../lib/webhooks');

// ============ Signing (pure) ============

test('signBody returns "sha256=<64-hex>"', () => {
  const sig = wh.signBody('mysecret', '{"hello":"world"}');
  assert.match(sig, /^sha256=[0-9a-f]{64}$/);
});

test('signBody matches the well-known HMAC-SHA256 spec', () => {
  // 比對標準庫：要保證跟接收方用相同方式驗證會 match
  const body = '{"a":1}';
  const expected = 'sha256=' + crypto.createHmac('sha256', 'k').update(body).digest('hex');
  assert.strictEqual(wh.signBody('k', body), expected);
});

test('signBody is deterministic for same input', () => {
  assert.strictEqual(wh.signBody('s', 'body'), wh.signBody('s', 'body'));
});

test('signBody differs for different secrets', () => {
  assert.notStrictEqual(wh.signBody('s1', 'body'), wh.signBody('s2', 'body'));
});

test('signBody differs for different bodies', () => {
  assert.notStrictEqual(wh.signBody('s', 'a'), wh.signBody('s', 'b'));
});

// ============ generateSecret ============

test('generateSecret has whsec_ prefix + base64url body', () => {
  const s = wh.generateSecret();
  assert.ok(s.startsWith('whsec_'));
  assert.match(s.slice(6), /^[A-Za-z0-9_-]+$/);
  // 32 bytes base64url 應該 ≥ 43 chars
  assert.ok(s.length >= 6 + 43);
});

test('generateSecret returns unique values (1000 samples)', () => {
  const seen = new Set();
  for (let i = 0; i < 1000; i++) {
    const s = wh.generateSecret();
    assert.ok(!seen.has(s)); seen.add(s);
  }
});

// ============ hashSecret ============

test('hashSecret is SHA-256 hex deterministic', () => {
  const a = wh.hashSecret('whsec_abc');
  assert.strictEqual(a.length, 64);
  assert.match(a, /^[0-9a-f]+$/);
  assert.strictEqual(wh.hashSecret('whsec_abc'), a);
});

// ============ KNOWN_EVENTS ============

test('KNOWN_EVENTS contains expected core events', () => {
  for (const e of ['ping', 'job.done', 'job.failed', 'schedule.run.ok', 'schedule.run.failed']) {
    assert.ok(wh.KNOWN_EVENTS.includes(e), `event ${e} missing`);
  }
});

// ============ validateEvents / validateUrl ============

test('validateEvents accepts known events', () => {
  assert.doesNotThrow(() => wh._internal.validateEvents(['job.done', 'job.failed']));
  assert.doesNotThrow(() => wh._internal.validateEvents(['*']));   // wildcard
});

test('validateEvents rejects unknown event', () => {
  assert.throws(() => wh._internal.validateEvents(['bogus']), /unknown event/);
});

test('validateEvents rejects empty / non-array', () => {
  assert.throws(() => wh._internal.validateEvents([]),    /non-empty/);
  assert.throws(() => wh._internal.validateEvents(null), /non-empty/);
});

test('validateUrl rejects non-http(s) schemes', () => {
  assert.throws(() => wh._internal.validateUrl('ftp://x'),   /http/);
  assert.throws(() => wh._internal.validateUrl('javascript:alert(1)'), /http/);
});

test('validateUrl rejects bad URLs', () => {
  assert.throws(() => wh._internal.validateUrl('not a url'), /valid URL/);
});

test('validateUrl accepts http and https', () => {
  assert.doesNotThrow(() => wh._internal.validateUrl('http://example.com/hook'));
  assert.doesNotThrow(() => wh._internal.validateUrl('https://example.com/hook'));
});

// ============ HTTP-level smoke (no DB) ============

test('httpPost delivers body to a local HTTP listener with all expected headers', async () => {
  let receivedHeaders, receivedBody;
  const srv = http.createServer((req, res) => {
    receivedHeaders = req.headers;
    let buf = '';
    req.on('data', (c) => buf += c);
    req.on('end', () => {
      receivedBody = buf;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('OK');
    });
  });
  await new Promise((r) => srv.listen(0, r));
  const port = srv.address().port;
  try {
    const body = '{"hello":"world"}';
    const r = await wh._internal.httpPost(`http://127.0.0.1:${port}/hook`, body, {
      'Content-Type': 'application/json',
      'X-DBMigrator-Event': 'ping',
      'X-DBMigrator-Signature': 'sha256=abc',
      'X-DBMigrator-Delivery': 'd1',
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(receivedBody, body);
    assert.strictEqual(receivedHeaders['x-dbmigrator-event'], 'ping');
    assert.strictEqual(receivedHeaders['x-dbmigrator-signature'], 'sha256=abc');
    assert.strictEqual(receivedHeaders['x-dbmigrator-delivery'], 'd1');
  } finally { srv.close(); }
});

test('httpPost surfaces non-2xx status + body sample', async () => {
  const srv = http.createServer((req, res) => {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('server is on fire');
  });
  await new Promise((r) => srv.listen(0, r));
  const port = srv.address().port;
  try {
    const r = await wh._internal.httpPost(`http://127.0.0.1:${port}/`, '{}', {});
    assert.strictEqual(r.status, 500);
    assert.match(r.bodySample, /server is on fire/);
  } finally { srv.close(); }
});

test('httpPost rejects on connection refused', async () => {
  // 隨意挑個沒有 listener 的高 port
  await assert.rejects(
    () => wh._internal.httpPost('http://127.0.0.1:1/hook', '{}', {}),
    /ECONNREFUSED|connect|refused/i
  );
});

// ============ Verifier example — 模擬接收方驗 server 的簽章 ============

test('a receiver verifying with the documented HMAC scheme accepts our signature', () => {
  // 模擬使用者寫的 receiver code（OpenAPI / README 範例）：
  const secret = 'whsec_test';
  const body = JSON.stringify({ event: 'ping', data: { x: 1 } });
  const sig = wh.signBody(secret, body);

  // 接收方應該這樣驗：
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  assert.ok(crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)));
});
