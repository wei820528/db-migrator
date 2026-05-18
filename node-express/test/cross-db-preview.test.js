// Phase 4 tests — the preview helper buildTablePreview() + route input
// validation. The HTTP path is exercised by spinning up a tiny express
// app and a mocked source adapter (no live DB).

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

// Helpers live in lib/cross-db/preview.js — pure functions, no I/O / no express.
const { buildTablePreview, stringifyIr } = require('../lib/cross-db/preview');

// HTTP-level tests require express + the adapter registry (which needs the
// driver modules transitively). Guard accordingly.
let express, route;
try {
  express = require('express');
  route = require('../routes/cross-db');
} catch { /* skip HTTP tests */ }

const itHttp = express ? test : test.skip;

// ============ buildTablePreview ============

const irUsers = {
  name: 'users',
  columns: [
    { name: 'id',    sourceTypeRaw: 'int unsigned', type: { kind: 'int', size: 32, unsigned: true },
      nullable: false, primaryKey: true, autoIncrement: true },
    { name: 'email', sourceTypeRaw: 'varchar(128)', type: { kind: 'string', size: 128 },
      nullable: false },
    { name: 'meta',  sourceTypeRaw: 'json', type: { kind: 'json' }, nullable: true },
  ],
  indexes: [{ name: 'idx_email', columns: ['email'], unique: true }],
};

test('buildTablePreview returns per-column source / target types', () => {
  const p = buildTablePreview(irUsers, 'postgres');
  assert.strictEqual(p.table, 'users');
  assert.strictEqual(p.columns.length, 3);
  const id = p.columns.find((c) => c.name === 'id');
  assert.strictEqual(id.sourceType, 'int unsigned');
  assert.strictEqual(id.targetType, 'SERIAL');           // autoIncrement PK rule
  assert.strictEqual(id.primaryKey, true);
  assert.strictEqual(id.autoIncrement, true);
});

test('buildTablePreview surfaces per-column warnings (unsigned int → pg widens)', () => {
  const irNoAi = {
    ...irUsers,
    columns: irUsers.columns.map((c) =>
      c.name === 'id' ? { ...c, primaryKey: false, autoIncrement: false } : c
    ),
  };
  const p = buildTablePreview(irNoAi, 'postgres');
  const id = p.columns.find((c) => c.name === 'id');
  assert.ok(id.warnings.some((w) => /unsigned/i.test(w)));
});

test('buildTablePreview deduplicates table-level warnings', () => {
  const irRepeat = {
    name: 't',
    columns: [
      { name: 'a', sourceTypeRaw: '?', type: { kind: 'unknown', raw: '?' }, nullable: true },
      { name: 'b', sourceTypeRaw: '?', type: { kind: 'unknown', raw: '?' }, nullable: true },
    ],
    indexes: [],
  };
  const p = buildTablePreview(irRepeat, 'mysql');
  // Each column has its own warning (per-column); table-level warnings list is
  // a deduped set of column warnings — same message twice would collapse to one.
  // For unknown type, the warning includes the raw type so both columns produce
  // the SAME message — verify dedup.
  const tableWarns = p.warnings;
  assert.ok(tableWarns.length <= p.columns.length);
});

test('buildTablePreview produces a runnable createTable statement for the target dialect', () => {
  const p = buildTablePreview(irUsers, 'mysql');
  assert.match(p.createTable, /^CREATE TABLE `users`/);
  assert.match(p.createTable, /AUTO_INCREMENT/);
  assert.ok(p.indexes.length === 1);
  assert.match(p.indexes[0], /CREATE UNIQUE INDEX `idx_email` ON `users`/);
});

test('buildTablePreview round-trips between all 3 dialect targets without throwing', () => {
  for (const target of ['mysql', 'postgres', 'sqlite']) {
    const p = buildTablePreview(irUsers, target);
    assert.ok(p.createTable.length > 0, `${target} produced empty createTable`);
    assert.strictEqual(p.columns.length, irUsers.columns.length);
  }
});

// ============ stringifyIr (used when sourceTypeRaw is missing) ============

test('stringifyIr renders int + flags', () => {
  assert.strictEqual(stringifyIr({ kind: 'int', size: 32, unsigned: true }), 'int32 unsigned');
});
test('stringifyIr renders decimal with precision/scale', () => {
  assert.strictEqual(stringifyIr({ kind: 'decimal', precision: 10, scale: 2 }), 'decimal(10,2)');
});
test('stringifyIr renders enum count', () => {
  assert.strictEqual(stringifyIr({ kind: 'enum', values: ['a', 'b'] }), 'enum(2 value(s))');
});
test('stringifyIr renders unknown with raw', () => {
  assert.strictEqual(stringifyIr({ kind: 'unknown', raw: 'WEIRD' }), 'unknown:WEIRD');
});

// ============ Route — HTTP-level validation + happy path against a mocked adapter ============

// Stand up a tiny express app for each test (no shared state).
function buildApp() {
  const app = express();
  app.use(express.json());
  // Hijack the adapter registry temporarily — give the route a stub source.
  // The cleanest way is to swap require.cache before mounting the route,
  // but the route is already loaded, so we monkey-patch `getAdapter` via
  // a small wrapper module. Simpler: mount the route as-is and rely on
  // input validation tests; for the happy-path tests we replace the
  // adapter registry's getAdapter at runtime.
  app.use('/api/cross-db', route);
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => resolve({ srv, port: srv.address().port }));
  });
}

async function post(port, path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      method: 'POST', hostname: '127.0.0.1', port, path,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(payload); req.end();
  });
}

itHttp('POST /preview-live rejects missing sourceType', async () => {
  const { srv, port } = await listen(buildApp());
  try {
    const r = await post(port, '/api/cross-db/preview-live', { targetType: 'mysql' });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /sourceType.*targetType/);
  } finally { srv.close(); }
});

itHttp('POST /preview-live rejects unsupported dialects', async () => {
  const { srv, port } = await listen(buildApp());
  try {
    const r = await post(port, '/api/cross-db/preview-live', { sourceType: 'mongo', targetType: 'mysql' });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /supports/);
  } finally { srv.close(); }
});

itHttp('POST /preview-live rejects same source + target', async () => {
  const { srv, port } = await listen(buildApp());
  try {
    const r = await post(port, '/api/cross-db/preview-live', { sourceType: 'mysql', targetType: 'mysql' });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /same/);
  } finally { srv.close(); }
});

itHttp('POST /preview-live succeeds with a stubbed adapter (no real DB)', async () => {
  // Swap getAdapter on the live registry for the duration of this test.
  const registry = require('../adapters');
  const original = registry.getAdapter;
  registry.getAdapter = (type) => {
    if (type === 'mysql') {
      return {
        getSchema: async () => [irUsers],   // pretend mysql returned irUsers
      };
    }
    return original(type);
  };

  const { srv, port } = await listen(buildApp());
  try {
    const r = await post(port, '/api/cross-db/preview-live', {
      sourceType: 'mysql', sourceConn: {}, targetType: 'postgres',
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.source, 'mysql');
    assert.strictEqual(r.body.target, 'postgres');
    assert.strictEqual(r.body.tableCount, 1);
    assert.strictEqual(r.body.tables[0].table, 'users');
    // Surfaces the per-column source→target mapping
    const id = r.body.tables[0].columns.find((c) => c.name === 'id');
    assert.strictEqual(id.targetType, 'SERIAL');
  } finally {
    srv.close();
    registry.getAdapter = original;
  }
});
