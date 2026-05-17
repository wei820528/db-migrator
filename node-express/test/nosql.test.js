// Format-level tests for the NoSQL adapters. We don't connect to a real
// Mongo / Redis here — those go in P3 integration tests under docker-compose.
// What we DO test: parse + filter + tokenize, which is where most bugs live.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const mongo = require('../adapters/mongo');
const redis = require('../adapters/redis');

function tmpFile(content) {
  const p = path.join(os.tmpdir(), `nosql-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.dump`);
  fs.writeFileSync(p, content);
  return p;
}

// ============ Mongo ============

test('mongo.parseTableNamesFromDump extracts collection names from JSONL', () => {
  const dump = [
    '{"op":"header","db":"mydb","collections":["users","posts"]}',
    '{"op":"collection","name":"users","options":{},"indexes":[]}',
    '{"op":"insert","coll":"users","doc":{"_id":1}}',
    '{"op":"insert","coll":"users","doc":{"_id":2}}',
    '{"op":"collection","name":"posts","options":{},"indexes":[]}',
    '{"op":"insert","coll":"posts","doc":{"_id":1}}',
  ].join('\n');
  const p = tmpFile(dump);
  try {
    const names = mongo.parseTableNamesFromDump(p).sort();
    assert.deepStrictEqual(names, ['posts', 'users']);
  } finally { fs.unlinkSync(p); }
});

test('mongo.filterDumpByTables keeps only wanted collections + rewrites header', () => {
  const dump = [
    '{"op":"header","db":"mydb","collections":["users","posts","comments"]}',
    '{"op":"collection","name":"users","options":{},"indexes":[]}',
    '{"op":"insert","coll":"users","doc":{"_id":1}}',
    '{"op":"collection","name":"posts","options":{},"indexes":[]}',
    '{"op":"insert","coll":"posts","doc":{"_id":1}}',
    '{"op":"collection","name":"comments","options":{},"indexes":[]}',
    '{"op":"insert","coll":"comments","doc":{"_id":1}}',
  ].join('\n');
  const r = mongo.filterDumpByTables(dump, ['users', 'posts']);
  assert.ok(r.sql.includes('"users"'));
  assert.ok(r.sql.includes('"posts"'));
  assert.ok(!r.sql.includes('"comments"'));
  // header should reflect the filter
  const header = JSON.parse(r.sql.split('\n')[0]);
  assert.deepStrictEqual(header.collections.sort(), ['posts', 'users']);
  assert.strictEqual(r.kept, 4);          // 2 collections + 2 inserts
  assert.strictEqual(r.skipped, 2);       // 1 collection + 1 insert for "comments"
});

test('mongo.filterDumpByTables handles empty wanted list (nothing kept)', () => {
  const dump = '{"op":"header","db":"x","collections":["a"]}\n{"op":"insert","coll":"a","doc":{}}\n';
  const r = mongo.filterDumpByTables(dump, []);
  // header row is always emitted (with filtered collections), but no inserts kept
  assert.strictEqual(r.kept, 0);
  assert.strictEqual(r.skipped, 1);
});

// ============ Redis ============

test('redis.splitCmd handles bare words and quoted strings', () => {
  const { splitCmd } = redis._internal;
  assert.deepStrictEqual(splitCmd('SET user:1 "Alice"'), ['SET', 'user:1', 'Alice']);
  assert.deepStrictEqual(splitCmd('HSET h f1 v1 f2 v2'), ['HSET', 'h', 'f1', 'v1', 'f2', 'v2']);
  assert.deepStrictEqual(splitCmd('SET k "hello world"'), ['SET', 'k', 'hello world']);
});

test('redis.splitCmd unescapes \\n, \\t, \\", \\\\', () => {
  const { splitCmd } = redis._internal;
  assert.deepStrictEqual(splitCmd('SET k "line1\\nline2"'), ['SET', 'k', 'line1\nline2']);
  assert.deepStrictEqual(splitCmd('SET k "say \\"hi\\""'), ['SET', 'k', 'say "hi"']);
  assert.deepStrictEqual(splitCmd('SET k "back\\\\slash"'), ['SET', 'k', 'back\\slash']);
});

test('redis.quoteArg leaves safe bareword identifiers alone', () => {
  const { quoteArg } = redis._internal;
  assert.strictEqual(quoteArg('user:1'), 'user:1');
  assert.strictEqual(quoteArg('abc-def'), 'abc-def');
  assert.strictEqual(quoteArg('foo.bar'), 'foo.bar');
});

test('redis.quoteArg double-quotes strings with spaces or special chars', () => {
  const { quoteArg } = redis._internal;
  assert.strictEqual(quoteArg('hello world'), '"hello world"');
  assert.strictEqual(quoteArg('with "quotes"'), '"with \\"quotes\\""');
  assert.strictEqual(quoteArg('back\\slash'), '"back\\\\slash"');
  assert.strictEqual(quoteArg('line1\nline2'), '"line1\\nline2"');
});

test('redis.parseTableNamesFromDump groups by ":" prefix; unprefixed → _root', () => {
  const dump = [
    '# header',
    'SELECT 0',
    'SET user:1 "Alice"',
    'HSET user:2 name "Bob" age "30"',
    'SET counter "42"',
    'SADD session:abc "data"',
    'PEXPIRE user:1 3600',
  ].join('\n');
  const p = tmpFile(dump);
  try {
    const names = redis.parseTableNamesFromDump(p).sort();
    assert.deepStrictEqual(names, ['_root', 'session:*', 'user:*']);
  } finally { fs.unlinkSync(p); }
});

test('redis.filterDumpByTables keeps only chosen namespaces; preserves comments + SELECT', () => {
  const dump = [
    '# header',
    'SELECT 0',
    'SET user:1 "A"',
    'SET cache:1 "B"',
    'SADD session:x "y"',
  ].join('\n');
  const r = redis.filterDumpByTables(dump, ['user:*']);
  assert.ok(r.sql.includes('SET user:1 "A"'));
  assert.ok(!r.sql.includes('cache:1'));
  assert.ok(!r.sql.includes('session:x'));
  assert.ok(r.sql.includes('SELECT 0'));      // structural lines preserved
  assert.ok(r.sql.includes('# header'));      // comments preserved
  assert.strictEqual(r.kept, 1);
  assert.strictEqual(r.skipped, 2);
});

test('redis.filterDumpByTables _root keeps unprefixed keys', () => {
  const dump = [
    'SET foo "1"',
    'SET bar "2"',
    'SET user:1 "x"',
  ].join('\n');
  const r = redis.filterDumpByTables(dump, ['_root']);
  assert.ok(r.sql.includes('SET foo'));
  assert.ok(r.sql.includes('SET bar'));
  assert.ok(!r.sql.includes('user:1'));
  assert.strictEqual(r.kept, 2);
  assert.strictEqual(r.skipped, 1);
});
