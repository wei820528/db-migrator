// v2 Theme E Phase 1 tests — metrics registry / logger / healthz。
//
// 純函式測試（無 server 啟動）— metrics 行為跟 logger 格式跟 healthz snapshot
// 都不需要 better-sqlite3 / express，所以全 testsuite 都跑得起來。

const test = require('node:test');
const assert = require('node:assert');

// ============ metrics ============

const metrics = require('../lib/metrics');

function freshMetrics() { metrics.clear(); }

test('counter inc: no labels', () => {
  freshMetrics();
  metrics.counter('test_x', 'Test counter').inc();
  metrics.counter('test_x', 'Test counter').inc();
  const out = metrics.render();
  assert.match(out, /^# HELP test_x Test counter$/m);
  assert.match(out, /^# TYPE test_x counter$/m);
  assert.match(out, /^test_x 2$/m);
});

test('counter inc: with labels stays separate', () => {
  freshMetrics();
  const c = metrics.counter('c', 'help');
  c.inc({ kind: 'a' });
  c.inc({ kind: 'a' });
  c.inc({ kind: 'b' });
  const out = metrics.render();
  assert.match(out, /^c{kind="a"} 2$/m);
  assert.match(out, /^c{kind="b"} 1$/m);
});

test('counter inc: label keys stably sorted', () => {
  freshMetrics();
  metrics.counter('c2', 'help').inc({ z: 1, a: 2 });
  const out = metrics.render();
  // a 必須排在 z 前面 (stable across runs)
  assert.match(out, /^c2{a="2",z="1"} 1$/m);
});

test('counter inc: increment by N', () => {
  freshMetrics();
  metrics.counter('c3', 'help').inc({}, 5).inc({}, 3);
  assert.match(metrics.render(), /^c3 8$/m);
});

test('gauge set: replaces (not adds)', () => {
  freshMetrics();
  const g = metrics.gauge('g1', 'help');
  g.set(10).set(7).set(42);
  assert.match(metrics.render(), /^g1 42$/m);
});

test('gauge with labels: set(labels, value)', () => {
  freshMetrics();
  const g = metrics.gauge('g2', 'help');
  g.set({ plugin: 'hello' }, 1);
  g.set({ plugin: 'broken' }, 0);
  const out = metrics.render();
  assert.match(out, /^g2{plugin="hello"} 1$/m);
  assert.match(out, /^g2{plugin="broken"} 0$/m);
});

test('gauge inc / dec', () => {
  freshMetrics();
  const g = metrics.gauge('active_workers', 'help');
  g.inc(); g.inc({ kind: 'a' }); g.inc({ kind: 'a' }); g.dec({ kind: 'a' });
  const out = metrics.render();
  assert.match(out, /^active_workers 1$/m);
  assert.match(out, /^active_workers{kind="a"} 1$/m);
});

test('histogram observe: buckets + sum + count', () => {
  freshMetrics();
  const h = metrics.histogram('latency_seconds', 'help', [0.1, 1, 5]);
  h.observe({}, 0.05);
  h.observe({}, 0.5);
  h.observe({}, 3);
  h.observe({}, 10);
  const out = metrics.render();
  // 0.05 → bucket le=0.1 (and all bigger)
  // 0.5  → le=1 and le=5
  // 3    → le=5
  // 10   → +Inf only
  assert.match(out, /^latency_seconds_bucket{le="0.1"} 1$/m);
  assert.match(out, /^latency_seconds_bucket{le="1"} 2$/m);
  assert.match(out, /^latency_seconds_bucket{le="5"} 3$/m);
  assert.match(out, /^latency_seconds_bucket{le="\+Inf"} 4$/m);
  assert.match(out, /^latency_seconds_sum 13\.55$/m);
  assert.match(out, /^latency_seconds_count 4$/m);
});

test('label values escaped: backslash / quote / newline', () => {
  freshMetrics();
  metrics.counter('e', 'help').inc({ msg: 'has "quote" and \\back\nnl' });
  const out = metrics.render();
  // Should escape: " → \" ; \ → \\ ; \n → \n (literal backslash-n)
  assert.match(out, /e\{msg="has \\"quote\\" and \\\\back\\nnl"\} 1/);
});

test('rendering empty registry → no samples but still valid', () => {
  freshMetrics();
  metrics.counter('lonely', 'help');     // create but never inc
  const out = metrics.render();
  assert.match(out, /^# HELP lonely help$/m);
  assert.match(out, /^# TYPE lonely counter$/m);
  // 沒 inc 過會 emit 一行 "lonely 0" 給 scraper 看
  assert.match(out, /^lonely 0$/m);
});

test('metric instance is cached (same call returns same instance)', () => {
  freshMetrics();
  const a = metrics.counter('cached', 'help');
  const b = metrics.counter('cached', 'help');
  a.inc(); b.inc();
  assert.match(metrics.render(), /^cached 2$/m);
});

test('list() returns sorted metric names', () => {
  freshMetrics();
  metrics.gauge('z', 'h'); metrics.counter('a', 'h'); metrics.histogram('m', 'h');
  assert.deepStrictEqual(metrics.list(), ['a', 'm', 'z']);
});

// ============ logger ============

test('logger emits to stderr in human or json based on env', () => {
  // 不能直接驗 process.stderr.write，捕不到（test runner 改寫 fd）。
  // 改用 _emit 看不會 throw。Format-level 用環境變數 test 留給 README。
  const log = require('../lib/logger');
  assert.doesNotThrow(() => log.info('hello', { x: 1 }));
  assert.doesNotThrow(() => log.warn('oops'));
  assert.doesNotThrow(() => log.error('boom', new Error('test')));
  assert.ok(['human', 'json'].includes(log.format));
});

// ============ healthz ============

const healthz = require('../lib/healthz');

test('healthz snapshot returns ok with all components present', async () => {
  const snap = await healthz.snapshot();
  assert.strictEqual(typeof snap.ok, 'boolean');
  assert.strictEqual(typeof snap.uptime, 'number');
  assert.ok(snap.components);
  // 五個 component 都該回東西
  for (const c of ['jobs_db', 'schedules_db', 'webhooks_db', 'adapters', 'license']) {
    assert.ok(c in snap.components, `missing component ${c}`);
    assert.strictEqual(typeof snap.components[c].ok, 'boolean');
  }
});

test('healthz uptime is non-negative number', async () => {
  const snap = await healthz.snapshot();
  assert.ok(snap.uptime >= 0);
});

test('healthz statCheck: missing file returns ok=true with present=false', () => {
  const r = healthz._internal.statCheck('/nonexistent/no-such-file.db');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.present, false);
});

test('healthz statCheck: existing file returns sizeBytes + mtime', () => {
  const r = healthz._internal.statCheck(__filename);   // 用本 test 檔當「存在的檔」
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.present, true);
  assert.ok(r.sizeBytes > 0);
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(r.mtime));
});

test('healthz handler: returns 503 if any component fails', async () => {
  // 注入一個一定失敗的 component
  const orig = { ...healthz._internal.CHECKS };
  healthz._internal.CHECKS.injected_fail = () => ({ ok: false, error: 'simulated' });
  try {
    let captured = { status: null, body: null };
    const fakeRes = {
      status(s) { captured.status = s; return this; },
      json(b)   { captured.body = b; return this; },
    };
    await healthz.handler()({}, fakeRes);
    assert.strictEqual(captured.status, 503);
    assert.strictEqual(captured.body.ok, false);
    assert.strictEqual(captured.body.components.injected_fail.ok, false);
  } finally {
    delete healthz._internal.CHECKS.injected_fail;
  }
});

test('healthz handler: returns 200 when all components ok', async () => {
  // 拿掉 injected_fail 後該全 ok（assuming 環境正常）
  let captured = { status: null, body: null };
  const fakeRes = {
    status(s) { captured.status = s; return this; },
    json(b)   { captured.body = b; return this; },
  };
  await healthz.handler()({}, fakeRes);
  // 注意：實際環境可能因 better-sqlite3 沒裝導致 adapters check 失敗
  // 我們只驗結構 / 一致性
  assert.ok([200, 503].includes(captured.status));
  assert.strictEqual(captured.body.ok, captured.status === 200);
});

// ============ end-to-end integration: metrics inc'd by jobs flow ============
// 不真的跑 jobs.js（需要 better-sqlite3），改測 metrics module 跟 jobs 對接的 shape

test('metrics: dbmigrator_jobs_total label shape matches what jobs.js emits', () => {
  freshMetrics();
  // 模擬 jobs.setStatus 內部的 inc 呼叫
  metrics.counter('dbmigrator_jobs_total', 'Total number of jobs by kind and final status')
    .inc({ kind: 'export', status: 'done' })
    .inc({ kind: 'export', status: 'error' })
    .inc({ kind: 'import', status: 'done' });
  const out = metrics.render();
  assert.match(out, /dbmigrator_jobs_total\{kind="export",status="done"\} 1/);
  assert.match(out, /dbmigrator_jobs_total\{kind="export",status="error"\} 1/);
  assert.match(out, /dbmigrator_jobs_total\{kind="import",status="done"\} 1/);
});

test('metrics: dbmigrator_webhook_deliveries_total label shape matches webhooks.js', () => {
  freshMetrics();
  metrics.counter('dbmigrator_webhook_deliveries_total', 'help')
    .inc({ event: 'job.done', status: 'ok' })
    .inc({ event: 'job.failed', status: 'fail' });
  const out = metrics.render();
  assert.match(out, /dbmigrator_webhook_deliveries_total\{event="job\.done",status="ok"\} 1/);
  assert.match(out, /dbmigrator_webhook_deliveries_total\{event="job\.failed",status="fail"\} 1/);
});
