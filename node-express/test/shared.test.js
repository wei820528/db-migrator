// Tests for adapters/_shared.js — pure functions only, no DB / network.
const { test, describe } = require('node:test');
const assert = require('node:assert');

const sh = require('../adapters/_shared');

describe('escapeIdent', () => {
  test('backtick (MySQL default)', () => {
    assert.strictEqual(sh.escapeIdent('users'), '`users`');
  });
  test('escapes embedded backtick by doubling', () => {
    assert.strictEqual(sh.escapeIdent('weird`name'), '`weird``name`');
  });
  test('double-quote (PG/SQLite)', () => {
    assert.strictEqual(sh.escapeIdent('users', '"'), '"users"');
  });
});

describe('escapeStringSql', () => {
  test('plain string', () => {
    assert.strictEqual(sh.escapeStringSql('hello'), "'hello'");
  });
  test('embedded single-quote', () => {
    assert.strictEqual(sh.escapeStringSql("it's"), "'it''s'");
  });
});

describe('splitSqlStatements', () => {
  test('splits on semicolons outside strings', () => {
    const out = sh.splitSqlStatements("SELECT 1; SELECT 'a;b'; SELECT 3;");
    assert.strictEqual(out.length, 3);
    assert.strictEqual(out[1], "SELECT 'a;b'");
  });
  test('skips line comments', () => {
    const out = sh.splitSqlStatements("-- comment\nSELECT 1;\n-- another\nSELECT 2;");
    assert.strictEqual(out.length, 2);
    assert.ok(out[0].includes('SELECT 1'));
    assert.ok(out[1].includes('SELECT 2'));
  });
  test('skips block comments', () => {
    const out = sh.splitSqlStatements("/* hi */ SELECT 1; /* x;y */ SELECT 2;");
    assert.strictEqual(out.length, 2);
  });
  test('respects backtick identifiers (MySQL)', () => {
    const out = sh.splitSqlStatements('INSERT INTO `t;t` VALUES (1); SELECT 2;', '`');
    assert.strictEqual(out.length, 2);
    assert.ok(out[0].includes('`t;t`'));
  });
});

describe('extractTableName', () => {
  test('CREATE TABLE', () => {
    assert.strictEqual(sh.extractTableName('CREATE TABLE `users` (id INT);'), 'users');
    assert.strictEqual(sh.extractTableName('CREATE TABLE IF NOT EXISTS `orders` (id INT);'), 'orders');
  });
  test('DROP TABLE', () => {
    assert.strictEqual(sh.extractTableName('DROP TABLE IF EXISTS `users`;'), 'users');
  });
  test('INSERT INTO', () => {
    assert.strictEqual(sh.extractTableName('INSERT INTO `users` (id) VALUES (1);'), 'users');
  });
  test('ALTER TABLE', () => {
    assert.strictEqual(sh.extractTableName('ALTER TABLE `users` ADD COLUMN x INT;'), 'users');
  });
  test('TRUNCATE', () => {
    assert.strictEqual(sh.extractTableName('TRUNCATE TABLE `users`;'), 'users');
  });
  test('header / control statements return null', () => {
    assert.strictEqual(sh.extractTableName('SET FOREIGN_KEY_CHECKS=0;'), null);
    assert.strictEqual(sh.extractTableName('BEGIN TRANSACTION;'), null);
    assert.strictEqual(sh.extractTableName('COMMIT;'), null);
    assert.strictEqual(sh.extractTableName('PRAGMA foreign_keys=OFF;'), null);
    assert.strictEqual(sh.extractTableName('-- a comment'), null);
  });
  test('schema-prefixed name → strips schema', () => {
    assert.strictEqual(sh.extractTableName('CREATE TABLE public.users (id INT);', '"'), 'users');
  });
  test('PG double-quote identifier', () => {
    assert.strictEqual(sh.extractTableName('CREATE TABLE "users" (id INT);', '"'), 'users');
  });
  test('MSSQL bracket', () => {
    assert.strictEqual(sh.extractTableName('CREATE TABLE [users] (id INT);', '['), 'users');
  });
});

describe('filterSqlByTables', () => {
  const sample = [
    'SET FOREIGN_KEY_CHECKS=0;',
    'DROP TABLE IF EXISTS `users`;',
    'CREATE TABLE `users` (id INT);',
    "INSERT INTO `users` (id) VALUES (1);",
    'DROP TABLE IF EXISTS `orders`;',
    'CREATE TABLE `orders` (id INT);',
    "INSERT INTO `orders` (id) VALUES (10);",
    'DROP TABLE IF EXISTS `logs`;',
    'CREATE TABLE `logs` (id INT);',
    "INSERT INTO `logs` (id) VALUES (99);",
    'SET FOREIGN_KEY_CHECKS=1;',
  ].join('\n');

  test('allow-list filters out non-allowed table statements', () => {
    const r = sh.filterSqlByTables(sample, ['users', 'orders'], '`');
    assert.strictEqual(r.kept, 8);    // 2 SETs + (DROP+CREATE+INSERT) × 2
    assert.strictEqual(r.skipped, 3); // logs DROP/CREATE/INSERT
    assert.ok(r.sql.includes('`users`'));
    assert.ok(r.sql.includes('`orders`'));
    assert.ok(!r.sql.includes('`logs`'));
  });

  test('empty allow-list = keep nothing except headers', () => {
    const r = sh.filterSqlByTables(sample, [], '`');
    assert.strictEqual(r.skipped, 9);
    assert.strictEqual(r.kept, 2);    // only the two SET statements
  });

  test('schema-qualified tables in allow-list', () => {
    const pgSample = `CREATE TABLE "users" (id INT); INSERT INTO "users" VALUES (1);`;
    const r = sh.filterSqlByTables(pgSample, ['public.users'], '"');
    assert.strictEqual(r.kept, 2);
  });
});

describe('formatValueGeneric', () => {
  test('null/undefined → NULL', () => {
    assert.strictEqual(sh.formatValueGeneric(null), 'NULL');
    assert.strictEqual(sh.formatValueGeneric(undefined), 'NULL');
  });
  test('integer / float / NaN', () => {
    assert.strictEqual(sh.formatValueGeneric(42), '42');
    assert.strictEqual(sh.formatValueGeneric(3.14), '3.14');
    assert.strictEqual(sh.formatValueGeneric(NaN), 'NULL');
  });
  test('boolean default (TRUE/FALSE)', () => {
    assert.strictEqual(sh.formatValueGeneric(true), 'TRUE');
    assert.strictEqual(sh.formatValueGeneric(false), 'FALSE');
  });
  test('boolean with boolAs01', () => {
    assert.strictEqual(sh.formatValueGeneric(true,  { boolAs01: true }), '1');
    assert.strictEqual(sh.formatValueGeneric(false, { boolAs01: true }), '0');
  });
  test('string', () => {
    assert.strictEqual(sh.formatValueGeneric('hi'), "'hi'");
  });
  test('Buffer → default X\'hex\'', () => {
    assert.strictEqual(sh.formatValueGeneric(Buffer.from('abc')), "X'616263'");
  });
  test('Date', () => {
    const d = new Date('2026-05-16T14:30:45Z');
    assert.ok(/^'2026-05-16 14:30:45'$/.test(sh.formatValueGeneric(d)));
  });
});

describe('parseTableNamesFromDumpGeneric', () => {
  test('extracts table names from CREATE TABLE statements', () => {
    const dump = 'CREATE TABLE `a` (); CREATE TABLE IF NOT EXISTS `b` ();';
    const names = sh.parseTableNamesFromDumpGeneric(dump, '`');
    assert.deepStrictEqual(names.sort(), ['a', 'b']);
  });
  test('deduplicates', () => {
    const dump = 'CREATE TABLE `a` (); CREATE TABLE `a` ();';
    const names = sh.parseTableNamesFromDumpGeneric(dump, '`');
    assert.deepStrictEqual(names, ['a']);
  });
});
