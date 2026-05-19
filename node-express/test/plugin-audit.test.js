// v2 Theme D Phase 4 tests — persistent plugin audit log + Worker gate。
//
// audit module 透過 PLUGIN_AUDIT_DB env override 走獨立 tmp DB，避免污染 real DB。
// Worker gate 測試靠 makeGatedWorker pure helper — 不 spawn 真的 worker。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// 每個 test file 開始前把 audit DB 指到 tmp 檔。set 在 require 之前。
const AUDIT_TMP_DB = path.join(os.tmpdir(), `dbm-audit-test-${crypto.randomUUID()}.db`);
process.env.PLUGIN_AUDIT_DB = AUDIT_TMP_DB;

let audit = null;
try { audit = require('../lib/plugin-audit'); }
catch { /* better-sqlite3 missing — 所有 sqlite-dependent tests 用 test.skip */ }

const worker = require('../lib/plugin-worker');

// 跑完清掉 tmp DB
process.on('exit', () => {
  try { fs.unlinkSync(AUDIT_TMP_DB); } catch {}
  try { fs.unlinkSync(AUDIT_TMP_DB + '-wal'); } catch {}
  try { fs.unlinkSync(AUDIT_TMP_DB + '-shm'); } catch {}
});

const itAudit = audit ? test : test.skip;

// 每 test 前清 table — 避免互相干擾
function clearAudit() {
  audit._internal.db().prepare('DELETE FROM plugin_audit').run();
}

// ============ append / list 基本 ============

itAudit('append + list: round-trip 一筆紀錄', () => {
  clearAudit();
  audit.append({ pluginName: 'foo', eventType: 'route-mount', detail: { method: 'GET', path: '/' } });
  const items = audit.list();
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].pluginName, 'foo');
  assert.strictEqual(items[0].eventType, 'route-mount');
  assert.strictEqual(items[0].severity, 'info');
  assert.deepStrictEqual(items[0].detail, { method: 'GET', path: '/' });
  assert.ok(items[0].ts > 0);
  assert.strictEqual(typeof items[0].id, 'number');
});

itAudit('list: DESC by ts (newest first)', () => {
  clearAudit();
  audit.append({ pluginName: 'p1', eventType: 'route-mount', detail: { i: 1 } });
  audit.append({ pluginName: 'p1', eventType: 'route-mount', detail: { i: 2 } });
  audit.append({ pluginName: 'p1', eventType: 'route-mount', detail: { i: 3 } });
  const items = audit.list();
  assert.strictEqual(items.length, 3);
  // 最新 (i=3) 應該在最前
  assert.strictEqual(items[0].detail.i, 3);
  assert.strictEqual(items[2].detail.i, 1);
});

itAudit('list: filter by plugin name', () => {
  clearAudit();
  audit.append({ pluginName: 'alpha', eventType: 'x', detail: {} });
  audit.append({ pluginName: 'bravo', eventType: 'x', detail: {} });
  const a = audit.list({ plugin: 'alpha' });
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].pluginName, 'alpha');
});

itAudit('list: filter by eventType', () => {
  clearAudit();
  audit.append({ pluginName: 'p', eventType: 'require-denied', detail: {} });
  audit.append({ pluginName: 'p', eventType: 'route-mount',    detail: {} });
  audit.append({ pluginName: 'p', eventType: 'route-mount',    detail: {} });
  const r = audit.list({ eventType: 'route-mount' });
  assert.strictEqual(r.length, 2);
});

itAudit('list: minSeverity 過濾 (warn 不含 info)', () => {
  clearAudit();
  audit.append({ pluginName: 'p', eventType: 'a', severity: 'info',  detail: {} });
  audit.append({ pluginName: 'p', eventType: 'b', severity: 'warn',  detail: {} });
  audit.append({ pluginName: 'p', eventType: 'c', severity: 'error', detail: {} });
  const r = audit.list({ minSeverity: 'warn' });
  assert.strictEqual(r.length, 2);
  assert.ok(r.every((x) => ['warn', 'error'].includes(x.severity)));
});

itAudit('list: since 過濾', () => {
  clearAudit();
  audit.append({ pluginName: 'p', eventType: 'x', detail: { i: 1 } });
  const t = Date.now();
  // 稍等一點確保 ts 增加
  for (let i = 0; i < 1000; i++) ;
  audit.append({ pluginName: 'p', eventType: 'x', detail: { i: 2 } });
  const r = audit.list({ since: t });
  assert.ok(r.every((x) => x.ts >= t));
});

itAudit('list: limit 預設 100 + clamp', () => {
  clearAudit();
  for (let i = 0; i < 5; i++) audit.append({ pluginName: 'p', eventType: 'x', detail: { i } });
  assert.strictEqual(audit.list({ limit: 3 }).length, 3);
  assert.strictEqual(audit.list({ limit: 0 }).length, 1);     // clamp 至 min 1
  assert.strictEqual(audit.list({ limit: 9999 }).length, 5);  // clamp 至 max 1000 but only 5 exist
});

itAudit('count: 沒 filter 算全部', () => {
  clearAudit();
  for (let i = 0; i < 4; i++) audit.append({ pluginName: 'p', eventType: 'x', detail: {} });
  assert.strictEqual(audit.count(), 4);
});

itAudit('count: 帶 plugin filter', () => {
  clearAudit();
  audit.append({ pluginName: 'a', eventType: 'x', detail: {} });
  audit.append({ pluginName: 'b', eventType: 'x', detail: {} });
  audit.append({ pluginName: 'b', eventType: 'x', detail: {} });
  assert.strictEqual(audit.count({ plugin: 'b' }), 2);
});

itAudit('prune: 砍 olderThanDays 之前的', () => {
  clearAudit();
  // 手動插入一筆舊紀錄
  audit._internal.db().prepare(`INSERT INTO plugin_audit (ts, plugin_name, event_type, severity, detail_json) VALUES (?, ?, ?, ?, ?)`)
    .run(Date.now() - 60 * 86400 * 1000, 'old', 'x', 'info', '{}');
  audit.append({ pluginName: 'fresh', eventType: 'x', detail: {} });
  const r = audit.prune({ olderThanDays: 30 });
  assert.strictEqual(r.deleted, 1);
  assert.strictEqual(audit.count(), 1);
  assert.strictEqual(audit.list()[0].pluginName, 'fresh');
});

itAudit('append: pluginName + eventType 必填', () => {
  assert.throws(() => audit.append({}), /required/);
  assert.throws(() => audit.append({ pluginName: 'x' }), /required/);
  assert.throws(() => audit.append({ eventType: 'x' }), /required/);
});

itAudit('append: detail 不能序列化也不會炸', () => {
  clearAudit();
  const circular = {};
  circular.self = circular;
  const id = audit.append({ pluginName: 'p', eventType: 'x', detail: circular });
  assert.ok(id > 0);
  const r = audit.list({ limit: 1 })[0];
  assert.deepStrictEqual(r.detail, { _serialized_error: true });
});

// ============ Worker gate ============

test('makeGatedWorker: 一律 throw nested-worker 訊息', () => {
  // 模擬 plugin-worker.js 內部呼叫 — 這裡 emitAudit 是 no-op (parentPort null)
  const FakeOriginal = function Worker() {};
  const Gated = worker._internal.makeGatedWorker(FakeOriginal);
  assert.throws(() => new Gated('any-code', { eval: true }),
    /cannot spawn worker_threads.Worker/);
});

test('makeGatedWorker: prototype chain 保留 (instanceof 仍 work)', () => {
  const FakeOriginal = function Worker() {};
  FakeOriginal.prototype.foo = function () { return 'foo'; };
  const Gated = worker._internal.makeGatedWorker(FakeOriginal);
  // 不會真的 new 起來 (gated throw) — 但 prototype 拍接到應該 OK
  assert.strictEqual(Gated.prototype, FakeOriginal.prototype);
});
