// Tests for the public revocation list endpoint + DB schema.
//
// We point LICENSE_DB at a temp file BEFORE requiring db.js so the schema
// is built in isolation. Then we mount just the revocation route on a tiny
// express app and exercise it over HTTP.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');

const dbFile = path.join(os.tmpdir(), `license-rev-test-${process.pid}-${Date.now()}.db`);
process.env.LICENSE_DB = dbFile;

const db = require('../db');
const express = require('express');
const revRouter = require('../routes/revocation');

function startServer() {
  const app = express();
  app.use(express.json());
  app.use('/api/revocation', revRouter);
  return new Promise((resolve) => {
    const srv = app.listen(0, () => resolve({ srv, port: srv.address().port }));
  });
}

async function get(port, path) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

test.after(() => {
  try { db.close(); } catch {}
  try { fs.unlinkSync(dbFile); } catch {}
  try { fs.unlinkSync(dbFile + '-shm'); } catch {}
  try { fs.unlinkSync(dbFile + '-wal'); } catch {}
});

test('issued_licenses table exists after db init', () => {
  const cols = db.prepare("PRAGMA table_info(issued_licenses)").all();
  const names = cols.map((c) => c.name);
  for (const k of ['id', 'customer', 'plan', 'issued_at', 'expires_at', 'revoked_at', 'revoke_reason']) {
    assert.ok(names.includes(k), `column ${k} missing`);
  }
});

test('GET /api/revocation/list returns empty array when no revoked licenses', async () => {
  // Clear out anything from earlier tests
  db.prepare('DELETE FROM issued_licenses').run();

  const { srv, port } = await startServer();
  try {
    const r = await get(port, '/api/revocation/list');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.revoked, []);
    assert.strictEqual(r.body.count, 0);
    assert.ok(r.body.updated);
  } finally {
    srv.close();
  }
});

test('GET /api/revocation/list returns only revoked licenses, not active ones', async () => {
  db.prepare('DELETE FROM issued_licenses').run();
  // 2 active, 1 revoked
  db.prepare(`INSERT INTO issued_licenses (id, customer) VALUES (?,?)`).run('aaaa-1', 'A');
  db.prepare(`INSERT INTO issued_licenses (id, customer) VALUES (?,?)`).run('bbbb-2', 'B');
  db.prepare(`INSERT INTO issued_licenses (id, customer, revoked_at, revoke_reason)
              VALUES (?,?,CURRENT_TIMESTAMP,?)`).run('cccc-3', 'C', 'chargeback');

  const { srv, port } = await startServer();
  try {
    const r = await get(port, '/api/revocation/list');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.revoked, ['cccc-3']);
    assert.strictEqual(r.body.count, 1);
    assert.strictEqual(r.body.details[0].id, 'cccc-3');
    assert.strictEqual(r.body.details[0].reason, 'chargeback');
  } finally {
    srv.close();
  }
});

test('GET /api/revocation/check?id=... reports revoked', async () => {
  db.prepare('DELETE FROM issued_licenses').run();
  db.prepare(`INSERT INTO issued_licenses (id, revoked_at, revoke_reason)
              VALUES (?, CURRENT_TIMESTAMP, ?)`).run('killed-id', 'abuse');

  const { srv, port } = await startServer();
  try {
    const r = await get(port, '/api/revocation/check?id=killed-id');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.revoked, true);
    assert.strictEqual(r.body.known, true);
    assert.strictEqual(r.body.reason, 'abuse');
  } finally {
    srv.close();
  }
});

test('GET /api/revocation/check?id=unknown reports not revoked, not known', async () => {
  db.prepare('DELETE FROM issued_licenses').run();

  const { srv, port } = await startServer();
  try {
    const r = await get(port, '/api/revocation/check?id=never-issued');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.revoked, false);
    assert.strictEqual(r.body.known, false);
  } finally {
    srv.close();
  }
});

test('GET /api/revocation/check without id returns 400', async () => {
  const { srv, port } = await startServer();
  try {
    const r = await get(port, '/api/revocation/check');
    assert.strictEqual(r.status, 400);
  } finally {
    srv.close();
  }
});
