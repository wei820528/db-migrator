// v2 Theme E Phase 2 tests — license-server observability。
//
// metrics.js / logger.js 行為跟 node-express 端共用同份程式碼，所以這邊只要驗
// healthz 是 license-server-specific 那塊；metrics 純函式也再驗一遍當 sanity。

const test = require('node:test');
const assert = require('node:assert');

const metrics = require('../lib/metrics');

// ============ metrics basic sanity (same source as node-express) ============

test('metrics counter / gauge work', () => {
  metrics.clear();
  metrics.counter('licenseserver_x', 'help').inc({ a: '1' }).inc({ a: '1' }).inc({ a: '2' });
  metrics.gauge('licenseserver_g', 'help').set(42);
  const out = metrics.render();
  assert.match(out, /licenseserver_x\{a="1"\} 2/);
  assert.match(out, /licenseserver_x\{a="2"\} 1/);
  assert.match(out, /licenseserver_g 42/);
});

test('metrics escape: doubled-quoted email in event detail', () => {
  metrics.clear();
  metrics.counter('e', 'help').inc({ event: 'login' });
  metrics.counter('e', 'help').inc({ event: '"weird"' });
  const out = metrics.render();
  assert.match(out, /e\{event="login"\} 1/);
  assert.match(out, /e\{event="\\"weird\\""\} 1/);
});

// ============ healthz: license-server-specific components ============

const healthz = require('../lib/healthz');

test('healthz lists license-server-specific components', async () => {
  const snap = await healthz.snapshot();
  for (const c of ['license_db', 'smtp_config', 'stripe_config', 'ecpay_config']) {
    assert.ok(c in snap.components, `missing component ${c}`);
    assert.strictEqual(typeof snap.components[c].ok, 'boolean');
  }
});

test('healthz: non-critical components do NOT pull ok=false even when failing', async () => {
  // smtp / stripe / ecpay all default to "not configured" (ok=true, critical=false).
  // 確認 overall ok 不被它們影響（在 test env 沒設這些 env vars 也該 ok）
  const snap = await healthz.snapshot();
  // 至少有 smtp_config 是 critical=false
  const smtp = snap.components.smtp_config;
  assert.strictEqual(smtp.critical, false);
  // 即使 smtp.configured=false，snap.ok 不該被它影響（只看 critical）
  // 所以如果 license_db ok，overall 該 ok
  if (snap.components.license_db && snap.components.license_db.ok) {
    assert.strictEqual(snap.ok, true);
  }
});

test('healthz: critical=true component failure flips overall ok=false', async () => {
  // 注入一個 critical 失敗的 component 暫時
  const origCriticalCheck = healthz._internal.CHECKS.license_db;
  healthz._internal.CHECKS.injected_critical = () => ({ ok: false, critical: true, error: 'simulated' });
  try {
    const snap = await healthz.snapshot();
    assert.strictEqual(snap.ok, false);
    assert.strictEqual(snap.components.injected_critical.ok, false);
  } finally {
    delete healthz._internal.CHECKS.injected_critical;
  }
});

test('healthz: critical=false failure does NOT flip overall ok', async () => {
  healthz._internal.CHECKS.injected_optional = () => ({ ok: false, critical: false, error: 'optional thing missing' });
  try {
    const snap = await healthz.snapshot();
    // overall ok 只取決於 critical components
    if (snap.components.license_db.ok) {
      assert.strictEqual(snap.ok, true);
    }
    assert.strictEqual(snap.components.injected_optional.ok, false);
    assert.strictEqual(snap.components.injected_optional.critical, false);
  } finally {
    delete healthz._internal.CHECKS.injected_optional;
  }
});

test('healthz handler: 200/503 based on critical components', async () => {
  // 全 ok 場景
  let captured = { status: null, body: null };
  const fakeRes = {
    status(s) { captured.status = s; return this; },
    json(b)   { captured.body = b; return this; },
  };
  await healthz.handler()({}, fakeRes);
  assert.ok([200, 503].includes(captured.status));
  assert.strictEqual(captured.body.ok, captured.status === 200);
});

test('smtp_config check reports configured flag based on env', () => {
  const orig = process.env.SMTP_HOST;
  try {
    delete process.env.SMTP_HOST;
    let r = healthz._internal.CHECKS.smtp_config();
    assert.strictEqual(r.configured, false);
    process.env.SMTP_HOST = 'smtp.example.com';
    r = healthz._internal.CHECKS.smtp_config();
    assert.strictEqual(r.configured, true);
  } finally {
    if (orig !== undefined) process.env.SMTP_HOST = orig;
    else delete process.env.SMTP_HOST;
  }
});

test('stripe_config check reports both key + webhook flags', () => {
  const origK = process.env.STRIPE_SECRET_KEY;
  const origW = process.env.STRIPE_WEBHOOK_SECRET;
  try {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    let r = healthz._internal.CHECKS.stripe_config();
    assert.strictEqual(r.enabled, false);
    assert.strictEqual(r.webhookConfigured, false);
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    r = healthz._internal.CHECKS.stripe_config();
    assert.strictEqual(r.enabled, true);
  } finally {
    if (origK !== undefined) process.env.STRIPE_SECRET_KEY = origK; else delete process.env.STRIPE_SECRET_KEY;
    if (origW !== undefined) process.env.STRIPE_WEBHOOK_SECRET = origW; else delete process.env.STRIPE_WEBHOOK_SECRET;
  }
});

test('ecpay_config check requires ALL three env vars', () => {
  const orig = {
    ECPAY_MERCHANT_ID: process.env.ECPAY_MERCHANT_ID,
    ECPAY_HASH_KEY:    process.env.ECPAY_HASH_KEY,
    ECPAY_HASH_IV:     process.env.ECPAY_HASH_IV,
  };
  try {
    delete process.env.ECPAY_MERCHANT_ID;
    delete process.env.ECPAY_HASH_KEY;
    delete process.env.ECPAY_HASH_IV;
    assert.strictEqual(healthz._internal.CHECKS.ecpay_config().configured, false);

    process.env.ECPAY_MERCHANT_ID = 'X';
    assert.strictEqual(healthz._internal.CHECKS.ecpay_config().configured, false);  // 只有 1 個不算
    process.env.ECPAY_HASH_KEY = 'Y';
    process.env.ECPAY_HASH_IV = 'Z';
    assert.strictEqual(healthz._internal.CHECKS.ecpay_config().configured, true);
  } finally {
    for (const [k, v] of Object.entries(orig)) {
      if (v !== undefined) process.env[k] = v;
      else delete process.env[k];
    }
  }
});

test('healthz uptime is non-negative', async () => {
  const snap = await healthz.snapshot();
  assert.ok(snap.uptime >= 0);
});

// ============ logger ============

test('logger module loads + emits without throwing', () => {
  const log = require('../lib/logger');
  assert.ok(['human', 'json'].includes(log.format));
  assert.doesNotThrow(() => log.info('observability test', { phase: 2 }));
});
