// Phase 3 tests — tables.js (IR → CREATE TABLE per target dialect) +
// sqlite cross-DB round-trip end-to-end.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { buildCreateTable, buildCreateIndexes, buildColumnDdl, emitDefault, ident } = require('../lib/cross-db/tables');
const { NeutralWriter, readNeutral } = require('../lib/cross-db/format');

function tmpFile(suffix = '.jsonl') {
  return path.join(os.tmpdir(), `cdb-tbl-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`);
}

// ============ ident quoting ============

test('ident mysql uses backticks', () => {
  assert.strictEqual(ident('users', 'mysql'), '`users`');
  assert.strictEqual(ident('my`table', 'mysql'), '`my``table`');
});
test('ident pg uses double-quote', () => {
  assert.strictEqual(ident('users', 'postgres'), '"users"');
  assert.strictEqual(ident('weird"name', 'postgres'), '"weird""name"');
});
test('ident sqlite uses double-quote', () => {
  assert.strictEqual(ident('t', 'sqlite'), '"t"');
});

// ============ emitDefault heuristic ============

test('emitDefault returns null for null/empty', () => {
  assert.strictEqual(emitDefault(null, 'mysql'), null);
  assert.strictEqual(emitDefault('', 'mysql'), null);
});
test('emitDefault passes through CURRENT_TIMESTAMP', () => {
  assert.strictEqual(emitDefault('CURRENT_TIMESTAMP', 'mysql'), 'CURRENT_TIMESTAMP');
  assert.strictEqual(emitDefault('current_timestamp', 'pg'), 'current_timestamp');
});
test('emitDefault drops PG nextval() (handled by SERIAL)', () => {
  assert.strictEqual(emitDefault("nextval('users_id_seq'::regclass)", 'pg'), null);
});
test('emitDefault passes numeric literals', () => {
  assert.strictEqual(emitDefault('42', 'mysql'), '42');
  assert.strictEqual(emitDefault('3.14', 'mysql'), '3.14');
  assert.strictEqual(emitDefault('-1', 'mysql'), '-1');
});
test('emitDefault quotes a plain string', () => {
  assert.strictEqual(emitDefault('hello', 'mysql'), "'hello'");
  assert.strictEqual(emitDefault("it's", 'mysql'), "'it''s'");
});
test('emitDefault preserves already-quoted string', () => {
  assert.strictEqual(emitDefault("'hello'", 'mysql'), "'hello'");
});

// ============ buildColumnDdl ============

test('column ddl: plain int NOT NULL', () => {
  const r = buildColumnDdl(
    { name: 'count', type: { kind: 'int', size: 32 }, nullable: false }, 'mysql');
  assert.strictEqual(r.ddl, '`count` INT NOT NULL');
});

test('column ddl: nullable string with default', () => {
  const r = buildColumnDdl(
    { name: 'name', type: { kind: 'string', size: 64 }, nullable: true, default: 'anon' }, 'pg');
  assert.strictEqual(r.ddl, "\"name\" VARCHAR(64) DEFAULT 'anon'");
});

test('column ddl: auto-increment PK gets SERIAL family for pg', () => {
  const r = buildColumnDdl(
    { name: 'id', type: { kind: 'int', size: 32 }, nullable: false, primaryKey: true, autoIncrement: true }, 'pg');
  assert.match(r.ddl, /SERIAL/);   // SERIAL is implicitly NOT NULL, we omit it
  assert.ok(!r.ddl.includes('NOT NULL'));
});

test('column ddl: auto-increment PK becomes INTEGER for sqlite (handled at table level)', () => {
  const r = buildColumnDdl(
    { name: 'id', type: { kind: 'int', size: 32 }, nullable: false, primaryKey: true, autoIncrement: true }, 'sqlite');
  assert.match(r.ddl, /INTEGER/);
});

test('column ddl: auto-increment PK gets AUTO_INCREMENT for mysql', () => {
  const r = buildColumnDdl(
    { name: 'id', type: { kind: 'int', size: 64 }, nullable: false, primaryKey: true, autoIncrement: true }, 'mysql');
  assert.match(r.ddl, /BIGINT/);
  assert.match(r.ddl, /AUTO_INCREMENT/);
});

test('column ddl carries warnings from emit (PG widens unsigned int)', () => {
  const r = buildColumnDdl(
    { name: 'count', type: { kind: 'int', size: 32, unsigned: true }, nullable: false }, 'pg');
  assert.strictEqual(r.ddl, '"count" BIGINT NOT NULL');
  assert.ok(r.warnings.some((w) => /unsigned/i.test(w)));
});

// ============ buildCreateTable ============

const irUsers = {
  name: 'users',
  columns: [
    { name: 'id',    type: { kind: 'int',    size: 32 },             nullable: false, primaryKey: true, autoIncrement: true },
    { name: 'email', type: { kind: 'string', size: 128 },             nullable: false },
    { name: 'paid',  type: { kind: 'bool' },                          nullable: false, default: 'FALSE' },
    { name: 'meta',  type: { kind: 'json' },                          nullable: true },
  ],
  indexes: [
    { name: 'idx_users_email', columns: ['email'], unique: true },
  ],
};

test('buildCreateTable mysql produces a single CREATE TABLE with backtick idents', () => {
  const r = buildCreateTable(irUsers, 'mysql');
  assert.match(r.sql, /^CREATE TABLE `users` \(/);
  // PK columns intentionally omit NOT NULL (PK implies NOT NULL — redundant)
  assert.match(r.sql, /`id` INT AUTO_INCREMENT/);
  assert.match(r.sql, /`email` VARCHAR\(128\) NOT NULL/);
  assert.match(r.sql, /`paid` TINYINT\(1\) NOT NULL DEFAULT FALSE/);
  assert.match(r.sql, /`meta` JSON/);
  assert.match(r.sql, /PRIMARY KEY \(`id`\)/);
});

test('buildCreateTable pg produces SERIAL + JSONB + table-level PK', () => {
  const r = buildCreateTable(irUsers, 'postgres');
  assert.match(r.sql, /^CREATE TABLE "users" \(/);
  assert.match(r.sql, /"id" SERIAL/);
  assert.match(r.sql, /"meta" JSONB/);
  assert.match(r.sql, /PRIMARY KEY \("id"\)/);
});

test('buildCreateTable sqlite inlines INTEGER PRIMARY KEY AUTOINCREMENT', () => {
  const r = buildCreateTable(irUsers, 'sqlite');
  assert.match(r.sql, /"id" INTEGER PRIMARY KEY AUTOINCREMENT/);
  // No separate PRIMARY KEY clause when inlined
  const lines = r.sql.split('\n');
  assert.ok(!lines.some((l) => /^\s*PRIMARY KEY/.test(l)));
});

test('buildCreateTable propagates per-column warnings', () => {
  const r = buildCreateTable({
    name: 't',
    columns: [{ name: 'big', type: { kind: 'int', size: 64, unsigned: true }, nullable: true }],
    indexes: [],
  }, 'pg');
  assert.ok(r.warnings.some((w) => /unsigned/i.test(w)));
});

test('buildCreateTable composite PK uses table-level clause', () => {
  const ir = {
    name: 'user_role',
    columns: [
      { name: 'user_id', type: { kind: 'int', size: 32 }, nullable: false, primaryKey: true },
      { name: 'role_id', type: { kind: 'int', size: 32 }, nullable: false, primaryKey: true },
    ],
    indexes: [],
  };
  const r = buildCreateTable(ir, 'mysql');
  assert.match(r.sql, /PRIMARY KEY \(`user_id`, `role_id`\)/);
  assert.ok(!/AUTO_INCREMENT/.test(r.sql));
});

// ============ buildCreateIndexes ============

test('buildCreateIndexes emits CREATE UNIQUE INDEX for unique secondary index', () => {
  const sqls = buildCreateIndexes(irUsers, 'mysql');
  assert.strictEqual(sqls.length, 1);
  assert.match(sqls[0], /^CREATE UNIQUE INDEX `idx_users_email` ON `users` \(`email`\);$/);
});

test('buildCreateIndexes pg passes through pg_indexes def when present', () => {
  const sqls = buildCreateIndexes({
    name: 'users',
    indexes: [{ name: 'i1', def: 'CREATE UNIQUE INDEX i1 ON public.users USING btree (email)' }],
  }, 'postgres');
  assert.strictEqual(sqls.length, 1);
  assert.ok(sqls[0].includes('CREATE UNIQUE INDEX i1'));
});

test('buildCreateIndexes skips empty/incomplete indexes', () => {
  const sqls = buildCreateIndexes({ name: 't', indexes: [{ name: 'bad', columns: [] }] }, 'sqlite');
  assert.strictEqual(sqls.length, 0);
});

// ============ SQLite cross-DB round-trip (e2e) ============

let sqlite, Database;
try {
  Database = require('better-sqlite3');
  sqlite = require('../adapters/sqlite');
} catch { /* skip e2e below */ }

const itSqlite = sqlite ? test : test.skip;

function makeNeutralFixture(file) {
  const w = new NeutralWriter(file);
  w.writeHeader({ sourceDialect: 'mysql', db: 'src', tables: ['orders'] });
  w.writeSchema({
    name: 'orders',
    columns: [
      { name: 'id',     type: { kind: 'int', size: 64 }, nullable: false, primaryKey: true, autoIncrement: true },
      { name: 'sku',    type: { kind: 'string', size: 32 }, nullable: false },
      { name: 'qty',    type: { kind: 'int', size: 32, unsigned: true }, nullable: false },   // triggers a warning
      { name: 'amount', type: { kind: 'decimal', precision: 10, scale: 2 }, nullable: false },
      { name: 'paid',   type: { kind: 'bool' }, nullable: false, default: 'FALSE' },
      { name: 'data',   type: { kind: 'json' }, nullable: true },
      { name: 'placed', type: { kind: 'datetime', timezone: false }, nullable: false },
    ],
    indexes: [{ name: 'idx_orders_sku', columns: ['sku'], unique: false }],
  });
  w.writeRow('orders', { id: 1, sku: 'A-1', qty: 3, amount: '9.99',  paid: true,  data: { a: 1 }, placed: '2026-05-18T03:14:15.000Z' });
  w.writeRow('orders', { id: 2, sku: 'B-2', qty: 1, amount: '14.50', paid: false, data: null,    placed: '2026-05-18T03:14:16.000Z' });
  return w.end();
}

itSqlite('restoreNeutral creates table + inserts rows + handles JSON/bool/datetime/decimal', async () => {
  const neutral = tmpFile();
  await makeNeutralFixture(neutral);
  const dbFile = tmpFile('.db');
  try {
    const r = await sqlite.restoreNeutral({ path: dbFile }, neutral);
    assert.strictEqual(r.ok, true);

    const db = new Database(dbFile);
    try {
      const rows = db.prepare('SELECT * FROM orders ORDER BY id').all();
      assert.strictEqual(rows.length, 2);
      assert.strictEqual(rows[0].sku, 'A-1');
      assert.strictEqual(rows[0].qty, 3);
      assert.strictEqual(rows[0].paid, 1);                  // bool → INTEGER 0/1 in sqlite
      assert.strictEqual(JSON.parse(rows[0].data).a, 1);
      assert.match(String(rows[0].placed), /2026-05-18/);

      // Index was created
      const idx = db.prepare("PRAGMA index_list(orders)").all();
      assert.ok(idx.some((i) => i.name === 'idx_orders_sku'));
    } finally { db.close(); }
  } finally {
    if (fs.existsSync(neutral)) fs.unlinkSync(neutral);
    if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
  }
});

itSqlite('sqlite dumpNeutral → sqlite restoreNeutral preserves row counts', async () => {
  // Self round-trip — proves the format + restore aren't dialect-coupled.
  const srcFile = tmpFile('.db');
  const srcDb = new Database(srcFile);
  srcDb.exec(`
    CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, qty INTEGER);
    INSERT INTO items (name, qty) VALUES ('a', 1), ('b', 2), ('c', 3);
  `);
  srcDb.close();
  const neutral = tmpFile();
  const dstFile = tmpFile('.db');

  try {
    await sqlite.dumpNeutral({ path: srcFile }, {}, neutral);
    await sqlite.restoreNeutral({ path: dstFile }, neutral);

    const db = new Database(dstFile);
    try {
      const rows = db.prepare('SELECT * FROM items ORDER BY id').all();
      assert.strictEqual(rows.length, 3);
      assert.deepStrictEqual(rows.map((r) => r.name), ['a', 'b', 'c']);
    } finally { db.close(); }
  } finally {
    for (const f of [srcFile, neutral, dstFile]) if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

itSqlite('restoreNeutral collects warnings from emit() for lossy types', async () => {
  const neutral = tmpFile();
  await makeNeutralFixture(neutral);                       // includes qty unsigned int (lossy for sqlite)
  const dbFile = tmpFile('.db');
  try {
    const r = await sqlite.restoreNeutral({ path: dbFile }, neutral);
    assert.ok(r.warnings.length > 0);
    assert.ok(r.warnings.some((w) => /unsigned/i.test(w)));
  } finally {
    if (fs.existsSync(neutral)) fs.unlinkSync(neutral);
    if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
  }
});
