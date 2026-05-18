// Phase 1 CLI tests — connection builder。沒 DB 連線，純函式驗證。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { parseConnArgs, buildConn, describeConn } = require('../lib/conn');

function tmpJson(obj) {
  const p = path.join(os.tmpdir(), `cli-conn-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

// ============ parseConnArgs basics ============

test('parseConnArgs: minimum mysql conn from flags', () => {
  const { type, conn } = parseConnArgs([
    '--type', 'mysql', '--host', '127.0.0.1', '--port', '3306',
    '--user', 'root', '--password', 'x', '--database', 'app',
  ]);
  assert.strictEqual(type, 'mysql');
  assert.strictEqual(conn.host, '127.0.0.1');
  assert.strictEqual(conn.port, 3306);
  assert.strictEqual(conn.user, 'root');
  assert.strictEqual(conn.password, 'x');
  assert.strictEqual(conn.database, 'app');
});

test('parseConnArgs: --type missing throws', () => {
  assert.throws(() => parseConnArgs(['--host', '127.0.0.1']), /--type required/);
});

test('parseConnArgs: --password-env reads from env, overrides --password', () => {
  process.env._CLI_TEST_PW = 'fromenv';
  try {
    const { conn } = parseConnArgs([
      '--type', 'mysql', '--host', 'x', '--password', 'plainval',
      '--password-env', '_CLI_TEST_PW',
    ]);
    assert.strictEqual(conn.password, 'fromenv');
  } finally { delete process.env._CLI_TEST_PW; }
});

test('parseConnArgs: --password-env missing var throws', () => {
  delete process.env._CLI_TEST_MISSING;
  assert.throws(
    () => parseConnArgs(['--type', 'mysql', '--host', 'x', '--password-env', '_CLI_TEST_MISSING']),
    /not set/
  );
});

test('parseConnArgs: --config seeds conn, flags override', () => {
  const cfg = tmpJson({ type: 'postgres', host: 'oldhost', user: 'pg', database: 'old', port: 5432 });
  try {
    const { type, conn } = parseConnArgs([
      '--config', cfg, '--host', 'newhost', '--database', 'newdb',
    ]);
    assert.strictEqual(type, 'postgres');
    assert.strictEqual(conn.host, 'newhost');       // flag wins
    assert.strictEqual(conn.user, 'pg');            // config kept
    assert.strictEqual(conn.database, 'newdb');     // flag wins
    assert.strictEqual(conn.port, 5432);            // config kept
  } finally { fs.unlinkSync(cfg); }
});

test('parseConnArgs: --config bad path throws', () => {
  assert.throws(
    () => parseConnArgs(['--config', '/nonexistent/no-such.json']),
    /failed to read --config/
  );
});

// ============ Type-specific post-processing ============

test('parseConnArgs: sqlite falls back conn.database → conn.path', () => {
  const { type, conn } = parseConnArgs([
    '--type', 'sqlite', '--database', 'C:\\data\\app.db',
  ]);
  assert.strictEqual(type, 'sqlite');
  assert.strictEqual(conn.path, 'C:\\data\\app.db');
});

test('parseConnArgs: sqlite explicit --path wins over --database', () => {
  const { conn } = parseConnArgs([
    '--type', 'sqlite', '--database', 'app.db', '--path', '/var/data/app.db',
  ]);
  assert.strictEqual(conn.path, '/var/data/app.db');
});

test('parseConnArgs: mssql --auth-mode windows', () => {
  const { conn } = parseConnArgs([
    '--type', 'mssql', '--host', 'srv', '--auth-mode', 'windows',
  ]);
  assert.strictEqual(conn.authMode, 'windows');
});

test('parseConnArgs: --ssl sets conn.ssl=true', () => {
  const { conn } = parseConnArgs([
    '--type', 'postgres', '--host', 'x', '--ssl',
  ]);
  assert.strictEqual(conn.ssl, true);
});

test('parseConnArgs: ssl from --config persists', () => {
  const cfg = tmpJson({ type: 'postgres', host: 'x', ssl: true });
  try {
    const { conn } = parseConnArgs(['--config', cfg]);
    assert.strictEqual(conn.ssl, true);
  } finally { fs.unlinkSync(cfg); }
});

// ============ Unknown flag rejected ============

test('parseConnArgs: unknown flag throws (catches typos)', () => {
  assert.throws(
    () => parseConnArgs(['--type', 'mysql', '--unknown-thing', 'x']),
    /Unknown option/i
  );
});

// ============ extraOptions merge ============

test('parseConnArgs: extraOptions are accepted alongside conn flags', () => {
  const { values } = parseConnArgs(
    ['--type', 'mysql', '--host', 'x', '--out', 'dump.sql'],
    { out: { type: 'string' } }
  );
  assert.strictEqual(values.out, 'dump.sql');
});

// ============ describeConn redacts password ============

test('describeConn redacts password but keeps user@host:port/db', () => {
  const s = describeConn('mysql', {
    host: 'h', port: 3306, user: 'u', password: 'secret', database: 'd',
  });
  assert.match(s, /^mysql:\/\/u@h:3306\/d$/);
  assert.ok(!s.includes('secret'));
});

test('describeConn handles missing pieces', () => {
  const s = describeConn('sqlite', { path: '/tmp/x.db' });
  assert.match(s, /^sqlite:\/\/@\/tmp\/x\.db\/$/);
});

// ============ buildConn direct (without going through parseArgs) ============

test('buildConn: direct values object', () => {
  const { type, conn } = buildConn({
    type: 'mysql', host: 'h', port: '3306', user: 'u', password: 'p', database: 'd',
  });
  assert.strictEqual(type, 'mysql');
  assert.strictEqual(conn.port, 3306);
});

test('buildConn: port omitted gets 0 (driver default)', () => {
  const { conn } = buildConn({ type: 'mysql', host: 'h' });
  assert.strictEqual(conn.port, 0);
});
