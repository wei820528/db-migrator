// v2 Theme A Phase 4 tests — schedule history / retention / path safety。
//
// 純函式 + tmp 檔；不需要 better-sqlite3 / express，全部跑得起來。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const h = require('../lib/schedule-history');

function tmpDir() {
  const p = path.join(os.tmpdir(), `dbm-sched-hist-${crypto.randomUUID()}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function makeHistoryFile(root, schedId, name, ageMs = 0) {
  const dir = h.historyDir(root, schedId);
  fs.mkdirSync(dir, { recursive: true });
  const full = path.join(dir, name);
  fs.writeFileSync(full, 'fake dump content');
  if (ageMs > 0) {
    const t = (Date.now() - ageMs) / 1000;
    fs.utimesSync(full, t, t);
  }
  return full;
}

// ============ historyDir ============

test('historyDir 拼出 {root}/{schedId}', () => {
  assert.strictEqual(h.historyDir('/var/backups', 'abc'), path.join('/var/backups', 'abc'));
});

// ============ listHistory ============

test('listHistory: 空目錄回 []', () => {
  const root = tmpDir();
  try {
    assert.deepStrictEqual(h.listHistory(root, 'no-such-sched'), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('listHistory: 列檔 + sort DESC by mtime', () => {
  const root = tmpDir();
  try {
    const old = makeHistoryFile(root, 'sched1', 'old.sql', 3600 * 1000);   // 1 hour old
    const newer = makeHistoryFile(root, 'sched1', 'new.sql', 0);
    const items = h.listHistory(root, 'sched1');
    assert.strictEqual(items.length, 2);
    assert.strictEqual(items[0].name, 'new.sql');   // 最新優先
    assert.strictEqual(items[1].name, 'old.sql');
    assert.ok(items[0].mtime >= items[1].mtime);
    assert.ok(items[0].sizeBytes > 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('listHistory: encrypted flag 認 .enc 副檔名', () => {
  const root = tmpDir();
  try {
    makeHistoryFile(root, 's', 'a.sql');
    makeHistoryFile(root, 's', 'b.sql.enc');
    const items = h.listHistory(root, 's');
    const a = items.find((x) => x.name === 'a.sql');
    const b = items.find((x) => x.name === 'b.sql.enc');
    assert.strictEqual(a.encrypted, false);
    assert.strictEqual(b.encrypted, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('listHistory: 子目錄不算 (只算 isFile)', () => {
  const root = tmpDir();
  try {
    const dir = h.historyDir(root, 's');
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, 'subdir'));    // 不該被列
    fs.writeFileSync(path.join(dir, 'real.sql'), 'x');
    const items = h.listHistory(root, 's');
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].name, 'real.sql');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ============ pickRetentionVictims (pure function) ============

function fakeEntry(name, ageMs) {
  return { name, mtime: Date.now() - ageMs, fullPath: '/fake', sizeBytes: 1 };
}

test('pickRetentionVictims: count=0 + days=0 → []', () => {
  const entries = [fakeEntry('a', 0), fakeEntry('b', 1000)];
  assert.deepStrictEqual(h.pickRetentionVictims(entries, {}), []);
});

test('pickRetentionVictims: retentionCount=2 留最新 2 份 (entries 已 DESC by mtime)', () => {
  const entries = [
    fakeEntry('newest', 0),
    fakeEntry('mid',    1000),
    fakeEntry('oldest', 5000),
  ];
  const victims = h.pickRetentionVictims(entries, { retentionCount: 2 });
  assert.deepStrictEqual(victims.map((v) => v.name), ['oldest']);
});

test('pickRetentionVictims: retentionCount=1 留最新 1 份', () => {
  const entries = [
    fakeEntry('a', 0), fakeEntry('b', 100), fakeEntry('c', 200), fakeEntry('d', 300),
  ];
  const victims = h.pickRetentionVictims(entries, { retentionCount: 1 });
  assert.deepStrictEqual(victims.map((v) => v.name), ['b', 'c', 'd']);
});

test('pickRetentionVictims: retentionDays=1 砍超過 1 天的', () => {
  const now = Date.now();
  const entries = [
    fakeEntry('today',     6 * 3600 * 1000),
    fakeEntry('yesterday', 23 * 3600 * 1000),
    fakeEntry('twoDays',   2 * 86400 * 1000),
    fakeEntry('fourDays',  4 * 86400 * 1000),
  ];
  const victims = h.pickRetentionVictims(entries, { retentionDays: 1, now });
  assert.deepStrictEqual(victims.map((v) => v.name).sort(), ['fourDays', 'twoDays']);
});

test('pickRetentionVictims: count + days 聯集 (任一條 trigger 就砍)', () => {
  const entries = [
    fakeEntry('a',  0),
    fakeEntry('b',  1000),
    fakeEntry('c',  86400 * 1000 * 5),   // 5 天前
  ];
  // count=10 不會 trigger，但 days=1 會砍 c
  const victims = h.pickRetentionVictims(entries, { retentionCount: 10, retentionDays: 1 });
  assert.deepStrictEqual(victims.map((v) => v.name), ['c']);

  // count=1 砍 b/c, days=1 也砍 c — union = [b, c]
  const victims2 = h.pickRetentionVictims(entries, { retentionCount: 1, retentionDays: 1 });
  assert.deepStrictEqual(victims2.map((v) => v.name).sort(), ['b', 'c']);
});

test('pickRetentionVictims: count = entries.length 不砍', () => {
  const entries = [fakeEntry('a', 0), fakeEntry('b', 1000)];
  assert.deepStrictEqual(h.pickRetentionVictims(entries, { retentionCount: 2 }), []);
});

// ============ applyRetention (real fs) ============

test('applyRetention: 真的 unlink 過期 / 超量檔，回傳 deleted list', () => {
  const root = tmpDir();
  try {
    const a = makeHistoryFile(root, 'sched', 'a.sql', 0);
    const b = makeHistoryFile(root, 'sched', 'b.sql', 1000);
    const c = makeHistoryFile(root, 'sched', 'c.sql', 86400 * 1000 * 5);
    const r = h.applyRetention(root, 'sched', { retentionCount: 2 });
    assert.deepStrictEqual(r.deleted, ['c.sql']);
    assert.strictEqual(r.kept, 2);
    assert.strictEqual(fs.existsSync(a), true);
    assert.strictEqual(fs.existsSync(b), true);
    assert.strictEqual(fs.existsSync(c), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('applyRetention: 不設規則就什麼都不刪', () => {
  const root = tmpDir();
  try {
    makeHistoryFile(root, 'sched', 'a.sql', 86400 * 1000 * 100);   // 100 天舊
    const r = h.applyRetention(root, 'sched', {});
    assert.strictEqual(r.deleted.length, 0);
    assert.strictEqual(r.kept, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ============ Safety — path traversal ============

test('isSafeHistoryName 拒 path traversal', () => {
  assert.strictEqual(h.isSafeHistoryName('normal.sql'), true);
  assert.strictEqual(h.isSafeHistoryName('with-dash_underscore.sql.enc'), true);
  assert.strictEqual(h.isSafeHistoryName(''), false);
  assert.strictEqual(h.isSafeHistoryName(null), false);
  assert.strictEqual(h.isSafeHistoryName('../etc/passwd'), false);
  assert.strictEqual(h.isSafeHistoryName('a/b'), false);
  assert.strictEqual(h.isSafeHistoryName('a\\b'), false);
  assert.strictEqual(h.isSafeHistoryName('null\0byte'), false);
  assert.strictEqual(h.isSafeHistoryName('x'.repeat(256)), false);
});

test('resolveHistoryPath: legit name → full path', () => {
  const root = tmpDir();
  try {
    const real = makeHistoryFile(root, 'sched', 'legit.sql');
    const got = h.resolveHistoryPath(root, 'sched', 'legit.sql');
    assert.strictEqual(got, real);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('resolveHistoryPath: traversal → throw', () => {
  const root = tmpDir();
  try {
    assert.throws(() => h.resolveHistoryPath(root, 'sched', '../../../etc/passwd'),
      /path traversal blocked/);
    assert.throws(() => h.resolveHistoryPath(root, 'sched', 'a/b.sql'),
      /path traversal blocked/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('resolveHistoryPath: 檔不存在 → throw', () => {
  const root = tmpDir();
  try {
    fs.mkdirSync(h.historyDir(root, 'sched'), { recursive: true });
    assert.throws(() => h.resolveHistoryPath(root, 'sched', 'nope.sql'),
      /not found/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
