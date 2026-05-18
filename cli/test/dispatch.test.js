// CLI dispatcher smoke tests — 跑 bin/dbmigrator.js 子程序，驗證 help / version /
// unknown-command / per-command --help 都會正確輸出。不真的連 DB。

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const BIN = path.join(__dirname, '..', 'bin', 'dbmigrator.js');

function run(args, env = {}) {
  return spawnSync('node', [BIN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('--version prints version + exit 0', () => {
  const r = run(['--version']);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /^\d+\.\d+\.\d+/);
});

test('no args prints top-level help + exit 0', () => {
  const r = run([]);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /DB Migrator CLI/);
  assert.match(r.stdout, /Commands:/);
});

test('--help prints same top-level help', () => {
  const r = run(['--help']);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /Commands:/);
});

test('unknown command exits 2 with error message', () => {
  const r = run(['blorpify']);
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /Unknown command: blorpify/);
});

test('per-command --help prints the command\'s help block', () => {
  for (const cmd of ['test', 'list-dbs', 'list-tables', 'export', 'import', 'dump-neutral', 'restore-neutral', 'preview-crossdb']) {
    const r = run([cmd, '--help']);
    assert.strictEqual(r.status, 0, `${cmd} --help should exit 0, got ${r.status}\nstderr: ${r.stderr}`);
    assert.ok(r.stdout.length > 0, `${cmd} --help produced empty stdout`);
  }
});

test('missing required arg → exit 1 with helpful error', () => {
  // 'export' requires --out
  const r = run(['export', '--type', 'sqlite', '--path', '/tmp/x.db']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /--out.*required/);
});

test('export with unknown flag is rejected (typo guard)', () => {
  const r = run(['export', '--type', 'sqlite', '--out', '/tmp/x.sql', '--databse', 'app']);   // typo
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /Unknown option/i);
});

test('DBMIGRATOR_DEBUG=1 prints stack trace on error', () => {
  const r = run(['export', '--type', 'sqlite', '--path', '/tmp/x.db'], { DBMIGRATOR_DEBUG: '1' });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /at /);   // stack lines
});
