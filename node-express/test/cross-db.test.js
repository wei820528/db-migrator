// Phase 1 tests for cross-DB type translation.
// Covers: normalize() for each source dialect, emit() for each target dialect,
// and the most important round-trips through translate().

const test = require('node:test');
const assert = require('node:assert');

const { normalize, emit, translate } = require('../lib/cross-db');

// ============ MySQL normalization ============

test('normalize mysql INT UNSIGNED', () => {
  assert.deepStrictEqual(normalize('mysql', 'INT UNSIGNED'),
    { kind: 'int', size: 32, unsigned: true });
});
test('normalize mysql BIGINT', () => {
  assert.deepStrictEqual(normalize('mysql', 'BIGINT'),
    { kind: 'int', size: 64 });
});
test('normalize mysql TINYINT(1) → bool (driver convention)', () => {
  assert.deepStrictEqual(normalize('mysql', 'TINYINT(1)'),
    { kind: 'bool' });
});
test('normalize mysql VARCHAR(64)', () => {
  assert.deepStrictEqual(normalize('mysql', 'VARCHAR(64)'),
    { kind: 'string', size: 64 });
});
test('normalize mysql DECIMAL(12,4)', () => {
  assert.deepStrictEqual(normalize('mysql', 'DECIMAL(12,4)'),
    { kind: 'decimal', precision: 12, scale: 4 });
});
test('normalize mysql TIMESTAMP carries timezone=true', () => {
  assert.deepStrictEqual(normalize('mysql', 'TIMESTAMP'),
    { kind: 'datetime', timezone: true });
});
test('normalize mysql DATETIME has no timezone', () => {
  assert.deepStrictEqual(normalize('mysql', 'DATETIME'),
    { kind: 'datetime', timezone: false });
});
test('normalize mysql JSON', () => {
  assert.deepStrictEqual(normalize('mysql', 'JSON'),
    { kind: 'json' });
});
test('normalize mysql ENUM extracts values', () => {
  const r = normalize('mysql', "ENUM('a','b','c''d')");
  assert.deepStrictEqual(r.values, ['a', 'b', "c'd"]);
});
test('normalize mysql unknown → unknown', () => {
  const r = normalize('mysql', 'WEIRD_TYPE');
  assert.strictEqual(r.kind, 'unknown');
  assert.strictEqual(r.raw, 'WEIRD_TYPE');
});

// ============ PostgreSQL normalization ============

test('normalize pg integer', () => {
  assert.deepStrictEqual(normalize('pg', 'integer'),
    { kind: 'int', size: 32 });
});
test('normalize pg bigserial → int + autoIncrement', () => {
  assert.deepStrictEqual(normalize('pg', 'bigserial'),
    { kind: 'int', size: 64, autoIncrement: true });
});
test('normalize pg "double precision"', () => {
  assert.deepStrictEqual(normalize('pg', 'double precision'),
    { kind: 'float', size: 64 });
});
test('normalize pg numeric(10,2)', () => {
  assert.deepStrictEqual(normalize('pg', 'numeric(10, 2)'),
    { kind: 'decimal', precision: 10, scale: 2 });
});
test('normalize pg numeric unlimited', () => {
  assert.deepStrictEqual(normalize('pg', 'numeric'),
    { kind: 'decimal' });
});
test('normalize pg varchar without size → text', () => {
  assert.deepStrictEqual(normalize('pg', 'varchar'),
    { kind: 'text' });
});
test('normalize pg timestamptz', () => {
  assert.deepStrictEqual(normalize('pg', 'timestamptz'),
    { kind: 'datetime', timezone: true });
});
test('normalize pg uuid', () => {
  assert.deepStrictEqual(normalize('pg', 'uuid'),
    { kind: 'uuid' });
});
test('normalize pg jsonb', () => {
  assert.deepStrictEqual(normalize('pg', 'jsonb'),
    { kind: 'json' });
});
test('normalize pg bytea', () => {
  assert.deepStrictEqual(normalize('pg', 'bytea'),
    { kind: 'binary' });
});

// ============ SQLite normalization (affinity-based) ============

test('normalize sqlite INTEGER', () => {
  assert.deepStrictEqual(normalize('sqlite', 'INTEGER'),
    { kind: 'int', size: 64 });
});
test('normalize sqlite REAL', () => {
  assert.deepStrictEqual(normalize('sqlite', 'REAL'),
    { kind: 'float', size: 64 });
});
test('normalize sqlite VARCHAR(255)', () => {
  assert.deepStrictEqual(normalize('sqlite', 'VARCHAR(255)'),
    { kind: 'string', size: 255 });
});
test('normalize sqlite TEXT', () => {
  assert.deepStrictEqual(normalize('sqlite', 'TEXT'),
    { kind: 'text' });
});
test('normalize sqlite NUMERIC(10,2)', () => {
  assert.deepStrictEqual(normalize('sqlite', 'NUMERIC(10,2)'),
    { kind: 'decimal', precision: 10, scale: 2 });
});

// ============ MySQL emit ============

test('emit mysql int(32) → INT', () => {
  assert.strictEqual(emit({ kind: 'int', size: 32 }, 'mysql').sql, 'INT');
});
test('emit mysql int(32, unsigned) → INT UNSIGNED', () => {
  assert.strictEqual(emit({ kind: 'int', size: 32, unsigned: true }, 'mysql').sql, 'INT UNSIGNED');
});
test('emit mysql bool → TINYINT(1)', () => {
  assert.strictEqual(emit({ kind: 'bool' }, 'mysql').sql, 'TINYINT(1)');
});
test('emit mysql uuid → CHAR(36) with warning', () => {
  const r = emit({ kind: 'uuid' }, 'mysql');
  assert.strictEqual(r.sql, 'CHAR(36)');
  assert.ok(r.warnings.some((w) => /UUID/i.test(w)));
});

// ============ PostgreSQL emit ============

test('emit pg int(32) → INTEGER', () => {
  assert.strictEqual(emit({ kind: 'int', size: 32 }, 'pg').sql, 'INTEGER');
});
test('emit pg int(32, unsigned) → BIGINT with warning', () => {
  const r = emit({ kind: 'int', size: 32, unsigned: true }, 'pg');
  assert.strictEqual(r.sql, 'BIGINT');
  assert.ok(r.warnings.some((w) => /unsigned/i.test(w)));
});
test('emit pg int(64, unsigned) → NUMERIC(20) (can\'t fit in BIGINT)', () => {
  const r = emit({ kind: 'int', size: 64, unsigned: true }, 'pg');
  assert.strictEqual(r.sql, 'NUMERIC(20)');
});
test('emit pg bool → BOOLEAN', () => {
  assert.strictEqual(emit({ kind: 'bool' }, 'pg').sql, 'BOOLEAN');
});
test('emit pg json → JSONB', () => {
  assert.strictEqual(emit({ kind: 'json' }, 'pg').sql, 'JSONB');
});
test('emit pg datetime tz → TIMESTAMPTZ', () => {
  assert.strictEqual(emit({ kind: 'datetime', timezone: true }, 'pg').sql, 'TIMESTAMPTZ');
});
test('emit pg enum → VARCHAR + CHECK + warning', () => {
  const r = emit({ kind: 'enum', values: ['a', 'b'] }, 'pg');
  assert.match(r.sql, /VARCHAR CHECK/);
  assert.match(r.sql, /'a'/);
  assert.ok(r.warnings.some((w) => /enum/i.test(w)));
});

// ============ SQLite emit ============

test('emit sqlite int → INTEGER (no size dim)', () => {
  assert.strictEqual(emit({ kind: 'int', size: 32 }, 'sqlite').sql, 'INTEGER');
});
test('emit sqlite int unsigned → INTEGER + warning', () => {
  const r = emit({ kind: 'int', size: 32, unsigned: true }, 'sqlite');
  assert.strictEqual(r.sql, 'INTEGER');
  assert.ok(r.warnings.some((w) => /unsigned/i.test(w)));
});
test('emit sqlite decimal high precision warns', () => {
  const r = emit({ kind: 'decimal', precision: 38, scale: 10 }, 'sqlite');
  assert.match(r.sql, /NUMERIC/);
  assert.ok(r.warnings.some((w) => /precision/i.test(w)));
});
test('emit sqlite json → TEXT + warning', () => {
  const r = emit({ kind: 'json' }, 'sqlite');
  assert.strictEqual(r.sql, 'TEXT');
  assert.ok(r.warnings.some((w) => /JSON/i.test(w)));
});
test('emit sqlite bytea via binary IR → BLOB', () => {
  assert.strictEqual(emit({ kind: 'binary' }, 'sqlite').sql, 'BLOB');
});

// ============ End-to-end translate (the path the dry-run preview will hit) ============

test('translate mysql INT UNSIGNED → pg widens to BIGINT', () => {
  const r = translate('INT UNSIGNED', 'mysql', 'pg');
  assert.strictEqual(r.sql, 'BIGINT');
  assert.ok(r.warnings.length > 0);
});

test('translate pg BIGSERIAL → mysql BIGINT (autoIncrement is handled by table emitter, not type)', () => {
  const r = translate('bigserial', 'pg', 'mysql');
  assert.strictEqual(r.sql, 'BIGINT');
});

test('translate mysql JSON → pg JSONB (lossless)', () => {
  const r = translate('JSON', 'mysql', 'pg');
  assert.strictEqual(r.sql, 'JSONB');
  assert.strictEqual(r.warnings.length, 0);
});

test('translate pg JSONB → sqlite TEXT (lossy — warns)', () => {
  const r = translate('jsonb', 'pg', 'sqlite');
  assert.strictEqual(r.sql, 'TEXT');
  assert.ok(r.warnings.length > 0);
});

test('translate mysql TIMESTAMP → pg TIMESTAMPTZ', () => {
  const r = translate('TIMESTAMP', 'mysql', 'pg');
  assert.strictEqual(r.sql, 'TIMESTAMPTZ');
});

test('translate sqlite TEXT → mysql TEXT', () => {
  const r = translate('TEXT', 'sqlite', 'mysql');
  assert.strictEqual(r.sql, 'TEXT');
});

test('translate sqlite VARCHAR(50) → pg VARCHAR(50)', () => {
  const r = translate('VARCHAR(50)', 'sqlite', 'pg');
  assert.strictEqual(r.sql, 'VARCHAR(50)');
});

test('translate pg numeric(10,2) → mysql DECIMAL(10,2)', () => {
  const r = translate('numeric(10, 2)', 'pg', 'mysql');
  assert.strictEqual(r.sql, 'DECIMAL(10,2)');
});

test('translate pg numeric (unlimited) → sqlite NUMERIC (loses precision warning if any)', () => {
  const r = translate('numeric', 'pg', 'sqlite');
  assert.strictEqual(r.sql, 'NUMERIC');
});

test('translate mysql ENUM → pg VARCHAR + CHECK preserves all values', () => {
  const r = translate("ENUM('small','medium','large')", 'mysql', 'pg');
  assert.match(r.sql, /VARCHAR CHECK/);
  for (const v of ['small', 'medium', 'large']) assert.match(r.sql, new RegExp("'" + v + "'"));
});

test('translate unknown type → TEXT with warning, never throws', () => {
  const r = translate('SOMETHING_WEIRD', 'mysql', 'pg');
  assert.strictEqual(r.sql, 'TEXT');
  assert.ok(r.warnings.some((w) => /unknown/i.test(w)));
});

// ============ Round-trip stability (the property cross-DB really wants) ============
// For each lossless IR kind, normalizing the emitter output should reproduce the IR.

test('round-trip mysql int through pg keeps int kind', () => {
  const ir1 = normalize('mysql', 'INT');                            // { kind: 'int', size: 32 }
  const pgSql = emit(ir1, 'pg').sql;                                // 'INTEGER'
  const ir2 = normalize('pg', pgSql);                               // { kind: 'int', size: 32 }
  assert.deepStrictEqual(ir2, ir1);
});

test('round-trip pg jsonb through mysql JSON keeps json kind', () => {
  const ir1 = normalize('pg', 'jsonb');
  const mysqlSql = emit(ir1, 'mysql').sql;
  const ir2 = normalize('mysql', mysqlSql);
  assert.deepStrictEqual(ir2, ir1);
});

test('round-trip mysql bool through pg keeps bool kind', () => {
  const ir1 = normalize('mysql', 'TINYINT(1)');
  const pgSql = emit(ir1, 'pg').sql;     // 'BOOLEAN'
  const ir2 = normalize('pg', pgSql);
  assert.deepStrictEqual(ir2, ir1);
});

test('round-trip mysql DECIMAL through pg through sqlite preserves precision/scale', () => {
  const ir1 = normalize('mysql', 'DECIMAL(10,4)');
  const pgSql = emit(ir1, 'pg').sql;
  const ir2 = normalize('pg', pgSql);
  assert.strictEqual(ir2.precision, 10);
  assert.strictEqual(ir2.scale, 4);
});
