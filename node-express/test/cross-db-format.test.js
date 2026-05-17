// Phase 2 tests — encoder + neutral format + SQLite getSchema / dumpNeutral.
// The MySQL / PG paths can't be unit-tested without a container; they get
// covered by the cross-DB integration matrix in Phase 5.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { encodeValue, decodeValue, encodeRow, decodeRow } = require('../lib/cross-db/encode');
const { NeutralWriter, readNeutral, readMetadata, FORMAT_VERSION } = require('../lib/cross-db/format');

function tmpFile(suffix = '.jsonl') {
  return path.join(os.tmpdir(), `cdb-fmt-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`);
}

// ============ encodeValue ============

test('encodeValue null returns null regardless of type', () => {
  assert.strictEqual(encodeValue(null, { kind: 'int' }), null);
  assert.strictEqual(encodeValue(undefined, { kind: 'string' }), null);
});

test('encodeValue int from BigInt within safe range → Number', () => {
  assert.strictEqual(encodeValue(42n, { kind: 'int' }), 42);
});

test('encodeValue int from BigInt outside safe range → string', () => {
  const big = 9_007_199_254_740_993n;   // MAX_SAFE_INTEGER + 2
  assert.strictEqual(encodeValue(big, { kind: 'int' }), '9007199254740993');
});

test('encodeValue decimal coerces to string (preserve precision)', () => {
  assert.strictEqual(encodeValue('123.4500', { kind: 'decimal' }), '123.4500');
  assert.strictEqual(encodeValue(99.5, { kind: 'decimal' }), '99.5');
});

test('encodeValue bool accepts boolean / number / "1"', () => {
  assert.strictEqual(encodeValue(true, { kind: 'bool' }), true);
  assert.strictEqual(encodeValue(1, { kind: 'bool' }), true);
  assert.strictEqual(encodeValue(0, { kind: 'bool' }), false);
  assert.strictEqual(encodeValue('1', { kind: 'bool' }), true);
  assert.strictEqual(encodeValue('true', { kind: 'bool' }), true);
});

test('encodeValue datetime from Date → ISO string', () => {
  const d = new Date('2026-05-18T03:14:15.000Z');
  assert.strictEqual(encodeValue(d, { kind: 'datetime' }), '2026-05-18T03:14:15.000Z');
});

test('encodeValue datetime from mysql-style "YYYY-MM-DD HH:MM:SS" string', () => {
  assert.strictEqual(
    encodeValue('2026-05-18 03:14:15', { kind: 'datetime' }),
    '2026-05-18T03:14:15Z'
  );
});

test('encodeValue date from Date → YYYY-MM-DD', () => {
  const d = new Date('2026-05-18T03:14:15.000Z');
  assert.strictEqual(encodeValue(d, { kind: 'date' }), '2026-05-18');
});

test('encodeValue binary Buffer → base64 string', () => {
  const buf = Buffer.from([0x48, 0x69]);   // 'Hi'
  assert.strictEqual(encodeValue(buf, { kind: 'binary' }), 'SGk=');
});

test('encodeValue json string is parsed back to object', () => {
  assert.deepStrictEqual(
    encodeValue('{"a":1,"b":"x"}', { kind: 'json' }),
    { a: 1, b: 'x' }
  );
});

test('encodeValue json object is passed through', () => {
  assert.deepStrictEqual(
    encodeValue({ a: 1 }, { kind: 'json' }),
    { a: 1 }
  );
});

test('encodeValue unknown kind falls back to JSON-friendly coercion', () => {
  assert.strictEqual(encodeValue(42n, { kind: 'unknown' }), '42');
  assert.strictEqual(
    encodeValue(Buffer.from([0x41]), { kind: 'unknown' }),
    'QQ=='
  );
});

// ============ decodeValue + round-trip ============

test('round-trip int safe range', () => {
  const v = 12345;
  assert.strictEqual(decodeValue(encodeValue(v, { kind: 'int' }), { kind: 'int' }), v);
});

test('round-trip int unsafe range stays string→BigInt', () => {
  const big = 9_007_199_254_740_993n;
  const encoded = encodeValue(big, { kind: 'int' });
  const decoded = decodeValue(encoded, { kind: 'int' });
  assert.strictEqual(typeof decoded, 'bigint');
  assert.strictEqual(decoded, big);
});

test('round-trip datetime → Date', () => {
  const d = new Date('2026-05-18T03:14:15.000Z');
  const decoded = decodeValue(encodeValue(d, { kind: 'datetime' }), { kind: 'datetime' });
  assert.ok(decoded instanceof Date);
  assert.strictEqual(decoded.toISOString(), d.toISOString());
});

test('round-trip binary → Buffer', () => {
  const buf = Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]);
  const decoded = decodeValue(encodeValue(buf, { kind: 'binary' }), { kind: 'binary' });
  assert.ok(Buffer.isBuffer(decoded));
  assert.strictEqual(decoded.toString('hex'), 'deadbeef');
});

test('round-trip json preserves nested structure', () => {
  const obj = { a: 1, b: [2, 3], c: { d: 'e' } };
  const decoded = decodeValue(encodeValue(obj, { kind: 'json' }), { kind: 'json' });
  assert.deepStrictEqual(decoded, obj);
});

// ============ encodeRow / decodeRow ============

test('encodeRow + decodeRow with mixed types', () => {
  const irColumns = [
    { name: 'id',   type: { kind: 'int', size: 32 } },
    { name: 'name', type: { kind: 'string', size: 64 } },
    { name: 'paid', type: { kind: 'bool' } },
    { name: 'ts',   type: { kind: 'datetime', timezone: false } },
  ];
  const row = {
    id: 1, name: 'Alice', paid: true, ts: new Date('2026-05-18T00:00:00.000Z'),
  };
  const encoded = encodeRow(row, irColumns);
  assert.strictEqual(encoded.id, 1);
  assert.strictEqual(encoded.name, 'Alice');
  assert.strictEqual(encoded.paid, true);
  assert.strictEqual(encoded.ts, '2026-05-18T00:00:00.000Z');

  const decoded = decodeRow(encoded, irColumns);
  assert.strictEqual(decoded.name, 'Alice');
  assert.ok(decoded.ts instanceof Date);
});

// ============ NeutralWriter + readNeutral round-trip ============

test('write + readNeutral preserves event order', async () => {
  const file = tmpFile();
  const writer = new NeutralWriter(file);
  writer.writeHeader({ sourceDialect: 'sqlite', db: 'test', tables: ['users'] });
  writer.writeSchema({
    name: 'users',
    columns: [
      { name: 'id',   type: { kind: 'int', size: 32 }, primaryKey: true, nullable: false },
      { name: 'name', type: { kind: 'text' }, nullable: false },
    ],
    indexes: [],
  });
  writer.writeRow('users', { id: 1, name: 'Alice' });
  writer.writeRow('users', { id: 2, name: 'Bob' });
  await writer.end();

  try {
    const events = [];
    for await (const e of readNeutral(file)) events.push(e);
    assert.strictEqual(events.length, 4);
    assert.strictEqual(events[0].op, 'header');
    assert.strictEqual(events[0].format, FORMAT_VERSION);
    assert.strictEqual(events[1].op, 'schema');
    assert.strictEqual(events[1].table, 'users');
    assert.strictEqual(events[2].op, 'row');
    assert.deepStrictEqual(events[2].values, { id: 1, name: 'Alice' });
  } finally { fs.unlinkSync(file); }
});

test('readMetadata stops at first row event (no row scan)', async () => {
  const file = tmpFile();
  const writer = new NeutralWriter(file);
  writer.writeHeader({ sourceDialect: 'sqlite', db: 'test', tables: ['users'] });
  writer.writeSchema({ name: 'users', columns: [{ name: 'id', type: { kind: 'int', size: 32 } }], indexes: [] });
  for (let i = 0; i < 1000; i++) writer.writeRow('users', { id: i });
  await writer.end();

  try {
    const meta = await readMetadata(file);
    assert.strictEqual(meta.header.sourceDialect, 'sqlite');
    assert.strictEqual(meta.schemas.length, 1);
    assert.strictEqual(meta.schemas[0].table, 'users');
  } finally { fs.unlinkSync(file); }
});

test('readNeutral rejects malformed JSON line', async () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{"op":"header"}\nNOT JSON\n');
  try {
    let caught = false;
    try {
      for await (const _ of readNeutral(file)) { /* drain */ }
    } catch (e) { caught = /Bad JSON/.test(e.message); }
    assert.ok(caught, 'expected Bad JSON error');
  } finally { fs.unlinkSync(file); }
});

// ============ SQLite getSchema + dumpNeutral end-to-end ============
// Skipped if better-sqlite3 isn't installed (same as the other adapter-requiring
// tests). These get full coverage in Phase 5 integration matrix anyway.

let sqlite, Database;
try {
  Database = require('better-sqlite3');
  sqlite = require('../adapters/sqlite');
} catch { /* skip the e2e block below */ }

const itSqlite = sqlite ? test : test.skip;

function makeSqlite() {
  const file = tmpFile('.db');
  const db = new Database(file);
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email VARCHAR(128) UNIQUE,
      age INTEGER,
      paid BOOLEAN DEFAULT 0
    );
    INSERT INTO users (name, email, age, paid) VALUES ('Alice', 'a@x.com', 30, 1);
    INSERT INTO users (name, email, age, paid) VALUES ('Bob', 'b@x.com', 25, 0);
  `);
  db.close();
  return file;
}

itSqlite('sqlite.getSchema returns IR-shaped table with normalized types', () => {
  const file = makeSqlite();
  try {
    const schemas = sqlite.getSchema({ path: file });
    assert.strictEqual(schemas.length, 1);
    const t = schemas[0];
    assert.strictEqual(t.name, 'users');

    const id = t.columns.find((c) => c.name === 'id');
    assert.strictEqual(id.type.kind, 'int');
    assert.strictEqual(id.primaryKey, true);
    assert.strictEqual(id.autoIncrement, true);

    const email = t.columns.find((c) => c.name === 'email');
    assert.strictEqual(email.type.kind, 'string');
    assert.strictEqual(email.type.size, 128);

    const paid = t.columns.find((c) => c.name === 'paid');
    // 'BOOLEAN' is sqlite affinity-normalized — see normalize.js (matches /BOOL/)
    assert.strictEqual(paid.type.kind, 'bool');

    // Unique index on email shows up in indexes
    assert.ok(t.indexes.some((i) => i.columns.includes('email') && i.unique));
  } finally { fs.unlinkSync(file); }
});

itSqlite('sqlite.dumpNeutral round-trips header + schema + rows', async () => {
  const file = makeSqlite();
  const out = tmpFile();
  try {
    await sqlite.dumpNeutral({ path: file }, {}, out);
    const events = [];
    for await (const e of readNeutral(out)) events.push(e);

    const header = events.find((e) => e.op === 'header');
    assert.strictEqual(header.sourceDialect, 'sqlite');
    assert.deepStrictEqual(header.tables, ['users']);

    const schema = events.find((e) => e.op === 'schema' && e.table === 'users');
    assert.strictEqual(schema.columns.length, 5);

    const rows = events.filter((e) => e.op === 'row' && e.table === 'users');
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].values.name, 'Alice');
    assert.strictEqual(rows[0].values.paid, true);     // BOOLEAN → bool encoder gave us boolean
    assert.strictEqual(rows[1].values.name, 'Bob');
    assert.strictEqual(rows[1].values.paid, false);
  } finally {
    fs.unlinkSync(file);
    if (fs.existsSync(out)) fs.unlinkSync(out);
  }
});

itSqlite('sqlite.dumpNeutral honors options.tables (subset filter)', async () => {
  const file = tmpFile('.db');
  const db = new Database(file);
  db.exec(`
    CREATE TABLE keep_me (id INTEGER);
    CREATE TABLE skip_me (id INTEGER);
    INSERT INTO keep_me VALUES (1);
    INSERT INTO skip_me VALUES (99);
  `);
  db.close();
  const out = tmpFile();
  try {
    await sqlite.dumpNeutral({ path: file }, { tables: ['keep_me'] }, out);
    const events = [];
    for await (const e of readNeutral(out)) events.push(e);
    const tables = new Set(events.filter((e) => e.op === 'schema').map((e) => e.table));
    assert.ok(tables.has('keep_me'));
    assert.ok(!tables.has('skip_me'));
  } finally {
    fs.unlinkSync(file);
    if (fs.existsSync(out)) fs.unlinkSync(out);
  }
});

itSqlite('sqlite.dumpNeutral with noData emits schema but zero rows', async () => {
  const file = makeSqlite();
  const out = tmpFile();
  try {
    await sqlite.dumpNeutral({ path: file }, { noData: true }, out);
    const events = [];
    for await (const e of readNeutral(out)) events.push(e);
    const rows = events.filter((e) => e.op === 'row');
    assert.strictEqual(rows.length, 0);
    assert.ok(events.some((e) => e.op === 'schema'));
  } finally {
    fs.unlinkSync(file);
    if (fs.existsSync(out)) fs.unlinkSync(out);
  }
});
