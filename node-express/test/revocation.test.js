const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');

const revocation = require('../lib/revocation');

// Each test uses its own temp cache file so they don't interfere.
function tempCachePath() {
  return path.join(os.tmpdir(), `rev-cache-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

function writeCache(p, data) {
  fs.writeFileSync(p, JSON.stringify(data));
}

test('checkCache returns "never" when no cache exists', () => {
  const cp = tempCachePath();
  revocation.setCachePath(cp);
  try {
    const r = revocation.checkCache('aaa');
    assert.strictEqual(r.state, 'never');
  } finally {
    try { fs.unlinkSync(cp); } catch {}
  }
});

test('checkCache returns "revoked" when id is in list', () => {
  const cp = tempCachePath();
  revocation.setCachePath(cp);
  writeCache(cp, {
    fetchedAt: new Date().toISOString(),
    revoked: ['lic-bad-1'],
    details: [{ id: 'lic-bad-1', revokedAt: '2026-01-01T00:00:00Z', reason: 'chargeback' }],
  });
  try {
    const r = revocation.checkCache('lic-bad-1');
    assert.strictEqual(r.state, 'revoked');
    assert.strictEqual(r.reason, 'chargeback');
    assert.strictEqual(r.revokedAt, '2026-01-01T00:00:00Z');
  } finally {
    try { fs.unlinkSync(cp); } catch {}
  }
});

test('checkCache returns "clear" for unknown id within grace period', () => {
  const cp = tempCachePath();
  revocation.setCachePath(cp);
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  writeCache(cp, { fetchedAt: yesterday, revoked: ['someone-else'] });
  try {
    const r = revocation.checkCache('my-id');
    assert.strictEqual(r.state, 'clear');
  } finally {
    try { fs.unlinkSync(cp); } catch {}
  }
});

test('checkCache returns "stale" when last fetch is older than grace period', () => {
  const cp = tempCachePath();
  revocation.setCachePath(cp);
  const ancient = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();  // 60 days ago
  writeCache(cp, { fetchedAt: ancient, revoked: [] });
  try {
    const r = revocation.checkCache('any');
    assert.strictEqual(r.state, 'stale');
    assert.ok(r.daysStale > 30);
  } finally {
    try { fs.unlinkSync(cp); } catch {}
  }
});

test('shouldRefetch is true when no cache exists', () => {
  const cp = tempCachePath();
  revocation.setCachePath(cp);
  try {
    assert.strictEqual(revocation._internal.shouldRefetch(), true);
  } finally {
    try { fs.unlinkSync(cp); } catch {}
  }
});

test('shouldRefetch is false when cache is fresh (< 24h)', () => {
  const cp = tempCachePath();
  revocation.setCachePath(cp);
  writeCache(cp, { fetchedAt: new Date().toISOString(), revoked: [] });
  try {
    assert.strictEqual(revocation._internal.shouldRefetch(), false);
  } finally {
    try { fs.unlinkSync(cp); } catch {}
  }
});

test('shouldRefetch is true when cache is older than 24h', () => {
  const cp = tempCachePath();
  revocation.setCachePath(cp);
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  writeCache(cp, { fetchedAt: old, revoked: [] });
  try {
    assert.strictEqual(revocation._internal.shouldRefetch(), true);
  } finally {
    try { fs.unlinkSync(cp); } catch {}
  }
});

test('refreshNow fetches list from server and writes cache', async () => {
  const cp = tempCachePath();
  revocation.setCachePath(cp);

  // Tiny in-process HTTP server returning a revocation list
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      updated: new Date().toISOString(),
      count: 2,
      revoked: ['abc-123', 'def-456'],
      details: [
        { id: 'abc-123', revokedAt: '2026-04-01T00:00:00Z', reason: 'test' },
        { id: 'def-456', revokedAt: '2026-04-02T00:00:00Z', reason: null },
      ],
    }));
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  try {
    const r = await revocation.refreshNow(`http://127.0.0.1:${port}/list`);
    assert.strictEqual(r.ok, true);
    const stored = JSON.parse(fs.readFileSync(cp, 'utf8'));
    assert.deepStrictEqual(stored.revoked.sort(), ['abc-123', 'def-456']);

    // and a subsequent check for one of these IDs should report 'revoked'
    const c = revocation.checkCache('abc-123');
    assert.strictEqual(c.state, 'revoked');
    assert.strictEqual(c.reason, 'test');
  } finally {
    server.close();
    try { fs.unlinkSync(cp); } catch {}
  }
});

test('refreshNow returns error on HTTP failure', async () => {
  const cp = tempCachePath();
  revocation.setCachePath(cp);

  const server = http.createServer((_, res) => { res.writeHead(500); res.end(); });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  try {
    const r = await revocation.refreshNow(`http://127.0.0.1:${port}/list`);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /HTTP 500/);
  } finally {
    server.close();
    try { fs.unlinkSync(cp); } catch {}
  }
});

test('refreshNow returns error when payload is malformed', async () => {
  const cp = tempCachePath();
  revocation.setCachePath(cp);

  const server = http.createServer((_, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"not": "a list"}');
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  try {
    const r = await revocation.refreshNow(`http://127.0.0.1:${port}/list`);
    assert.strictEqual(r.ok, false);
  } finally {
    server.close();
    try { fs.unlinkSync(cp); } catch {}
  }
});
