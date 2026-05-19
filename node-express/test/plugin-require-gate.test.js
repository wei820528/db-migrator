// v2 Theme D Phase 3 tests — require gate（permission-based Node builtin allow-list）。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const SandboxedPlugin = require('../lib/sandboxed-plugin-host');
const { _internal } = require('../lib/plugin-worker');

// ============ Pure helpers: builtinAllowed() ============

test('builtinAllowed: ALWAYS_ALLOWED builtins pass with empty permissions', () => {
  for (const b of ['crypto', 'util', 'events', 'stream', 'buffer', 'url', 'path']) {
    assert.ok(_internal.builtinAllowed(b, []), `${b} should be always allowed`);
  }
});

test('builtinAllowed: fs requires fs:tmp or fs:plugin-dir', () => {
  assert.strictEqual(_internal.builtinAllowed('fs', []), false);
  assert.strictEqual(_internal.builtinAllowed('fs', ['route']), false);
  assert.strictEqual(_internal.builtinAllowed('fs', ['fs:tmp']), true);
  assert.strictEqual(_internal.builtinAllowed('fs', ['fs:plugin-dir']), true);
  assert.strictEqual(_internal.builtinAllowed('fs/promises', ['fs:tmp']), true);
});

test('builtinAllowed: http / https / net require "network"', () => {
  for (const b of ['http', 'https', 'net', 'dns', 'tls', 'dgram']) {
    assert.strictEqual(_internal.builtinAllowed(b, []), false);
    assert.strictEqual(_internal.builtinAllowed(b, ['network']), true);
  }
});

test('builtinAllowed: child_process is never allowed except via unrestricted', () => {
  assert.strictEqual(_internal.builtinAllowed('child_process', []), false);
  assert.strictEqual(_internal.builtinAllowed('child_process', ['fs:tmp', 'network']), false);
  assert.strictEqual(_internal.builtinAllowed('child_process', ['unrestricted']), true);
});

test('builtinAllowed: unrestricted permission opens everything', () => {
  for (const b of ['fs', 'child_process', 'vm', 'cluster', 'os', 'http']) {
    assert.strictEqual(_internal.builtinAllowed(b, ['unrestricted']), true);
  }
});

// ============ End-to-end with a real worker ============

function tmpPlugin(body) {
  const dir = path.join(os.tmpdir(), `sb-p3-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'index.js');
  fs.writeFileSync(p, body);
  return { dir, file: p };
}

function fakeReq(method, path) {
  return { method, path, headers: {}, query: {}, body: null };
}
function fakeRes() {
  let status = 200, body;
  return {
    status(s) { status = s; return this; },
    set() { return this; },
    json(b) { body = b; },
    send(b) { body = b; },
    end() {},
    _status: () => status, _body: () => body,
  };
}

async function withPlugin(body, permissions, fn) {
  const { dir, file } = tmpPlugin(body);
  const sb = new SandboxedPlugin({
    name: 'gatetest', pluginPath: file,
    grantedPermissions: ['route', ...permissions],
    onLog: () => {},
  });
  try {
    await sb.start();
    await fn(sb);
  } finally {
    await sb.stop().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('e2e: plugin can require always-allowed builtins (crypto / path / util) without any permission', async () => {
  await withPlugin(`
    const crypto = require('crypto');
    const path = require('path');
    const util = require('util');
    module.exports = function(ctx) {
      ctx.route.mount('GET', '/', async () => ({
        status: 200,
        body: { sha: crypto.createHash('sha256').update('hi').digest('hex').slice(0, 8) },
      }));
    };
  `, [], async (sb) => {
    const res = fakeRes();
    await sb.asExpressHandler()(fakeReq('GET', '/'), res);
    assert.strictEqual(res._status(), 200);
    assert.match(res._body().sha, /^[0-9a-f]{8}$/);
  });
});

test('e2e: plugin WITHOUT fs:* cannot require("fs") — init fails', async () => {
  // require('fs') at module top-level — init should fail
  const code = `
    const fs = require('fs');
    module.exports = function(ctx) { ctx.route.mount('GET', '/', async () => ({ status: 200 })); };
  `;
  const { dir, file } = tmpPlugin(code);
  const sb = new SandboxedPlugin({
    name: 'no-fs', pluginPath: file, grantedPermissions: ['route'], onLog: () => {},
  });
  try {
    await assert.rejects(() => sb.start(), /cannot require\("fs"\)/);
  } finally {
    await sb.stop().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('e2e: plugin WITH fs:tmp can require("fs")', async () => {
  await withPlugin(`
    const fs = require('fs');
    module.exports = function(ctx) {
      ctx.route.mount('GET', '/', async () => ({
        status: 200, body: { fsLoaded: typeof fs.readFileSync === 'function' },
      }));
    };
  `, ['fs:tmp'], async (sb) => {
    const res = fakeRes();
    await sb.asExpressHandler()(fakeReq('GET', '/'), res);
    assert.deepStrictEqual(res._body(), { fsLoaded: true });
  });
});

test('e2e: plugin WITHOUT network cannot require("http"); WITH network can', async () => {
  // Without permission — init fails
  const code = `const http = require('http'); module.exports = function(ctx) {};`;
  const t1 = tmpPlugin(code);
  const sb1 = new SandboxedPlugin({
    name: 'no-net', pluginPath: t1.file, grantedPermissions: ['route'], onLog: () => {},
  });
  await assert.rejects(() => sb1.start(), /cannot require\("http"\)/);
  await sb1.stop().catch(() => {});
  fs.rmSync(t1.dir, { recursive: true, force: true });

  // With permission — works
  await withPlugin(code + `
    module.exports = function(ctx) {
      ctx.route.mount('GET', '/', async () => ({
        status: 200, body: { httpLoaded: typeof http.createServer === 'function' },
      }));
    };
  `, ['network'], async (sb) => {
    const res = fakeRes();
    await sb.asExpressHandler()(fakeReq('GET', '/'), res);
    assert.strictEqual(res._body().httpLoaded, true);
  });
});

test('e2e: unrestricted plugin can require child_process (escape hatch)', async () => {
  await withPlugin(`
    const cp = require('child_process');
    module.exports = function(ctx) {
      ctx.route.mount('GET', '/', async () => ({
        status: 200, body: { cpLoaded: typeof cp.spawn === 'function' },
      }));
    };
  `, ['unrestricted'], async (sb) => {
    const res = fakeRes();
    await sb.asExpressHandler()(fakeReq('GET', '/'), res);
    assert.strictEqual(res._body().cpLoaded, true);
  });
});

test('e2e: deny error message suggests the right permission', async () => {
  const code = `const fs = require('fs'); module.exports = function(ctx) {};`;
  const t = tmpPlugin(code);
  const sb = new SandboxedPlugin({
    name: 'msgtest', pluginPath: t.file, grantedPermissions: ['route'], onLog: () => {},
  });
  let err;
  try { await sb.start(); } catch (e) { err = e; }
  await sb.stop().catch(() => {});
  fs.rmSync(t.dir, { recursive: true, force: true });
  assert.ok(err);
  assert.match(err.message, /cannot require\("fs"\)/);
  assert.match(err.message, /Granted: \[route\]/);
});

test('e2e: at-runtime require() inside a handler is also gated', async () => {
  // No top-level require — gate only fires when handler runs
  await withPlugin(`
    module.exports = function(ctx) {
      ctx.route.mount('GET', '/', async () => {
        try { require('net'); return { status: 200, body: { gated: false } }; }
        catch (e) { return { status: 200, body: { gated: true, msg: e.message } }; }
      });
    };
  `, [], async (sb) => {
    const res = fakeRes();
    await sb.asExpressHandler()(fakeReq('GET', '/'), res);
    assert.strictEqual(res._body().gated, true);
    assert.match(res._body().msg, /cannot require\("net"\)/);
  });
});

test('e2e: node: prefix is stripped before gate check', async () => {
  // require('node:fs') should be treated same as require('fs')
  const code = `const fs = require('node:fs'); module.exports = function(ctx) {};`;
  const t = tmpPlugin(code);
  const sb = new SandboxedPlugin({
    name: 'nodeprefix', pluginPath: t.file, grantedPermissions: ['route'], onLog: () => {},
  });
  await assert.rejects(() => sb.start(), /cannot require\("node:fs"\)/);
  await sb.stop().catch(() => {});
  fs.rmSync(t.dir, { recursive: true, force: true });
});

test('e2e: relative require (./helper.js) is always allowed', async () => {
  const { dir, file } = tmpPlugin(`
    const greet = require('./helper.js');
    module.exports = function(ctx) {
      ctx.route.mount('GET', '/', async () => ({ status: 200, body: greet() }));
    };
  `);
  fs.writeFileSync(path.join(dir, 'helper.js'), 'module.exports = () => "hi from helper";');
  const sb = new SandboxedPlugin({
    name: 'relreq', pluginPath: file, grantedPermissions: ['route'], onLog: () => {},
  });
  try {
    await sb.start();
    const res = fakeRes();
    await sb.asExpressHandler()(fakeReq('GET', '/'), res);
    assert.strictEqual(res._body(), 'hi from helper');
  } finally {
    await sb.stop().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('e2e: gate denial is reported to onLog (audit trail)', async () => {
  const logs = [];
  const code = `
    module.exports = function(ctx) {
      ctx.route.mount('GET', '/', async () => {
        try { require('os'); } catch {}
        return { status: 200 };
      });
    };
  `;
  const t = tmpPlugin(code);
  const sb = new SandboxedPlugin({
    name: 'auditme', pluginPath: t.file, grantedPermissions: ['route'],
    onLog: (level, msg) => logs.push({ level, msg }),
  });
  try {
    await sb.start();
    await sb.asExpressHandler()(fakeReq('GET', '/'), fakeRes());
    // wait for log message to bubble (cross-thread message is async)
    await new Promise((r) => setTimeout(r, 100));
    const denied = logs.find((l) => /denied require\("os"\)/.test(l.msg));
    assert.ok(denied, `expected denial log; got: ${JSON.stringify(logs)}`);
  } finally {
    await sb.stop().catch(() => {});
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
});

test('e2e: sample plugins/sandboxed-hello /try-fs returns "denied" body', async () => {
  // 直接跑 repo 內既有的 sample plugin（permissions: ["route"]）
  const pluginPath = path.join(__dirname, '..', 'plugins', 'sandboxed-hello', 'index.js');
  const sb = new SandboxedPlugin({
    name: 'sandboxed-hello', pluginPath, grantedPermissions: ['route'], onLog: () => {},
  });
  try {
    await sb.start();
    const res = fakeRes();
    await sb.asExpressHandler()(fakeReq('GET', '/try-fs'), res);
    assert.strictEqual(res._body().ok, false);
    assert.match(res._body().note, /denied/);
  } finally {
    await sb.stop().catch(() => {});
  }
});
