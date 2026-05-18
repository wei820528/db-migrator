// v2 Theme D Phase 2 tests — sandboxed plugin worker spawn + 通訊 + 隔離。
// 用 Node 內建 worker_threads，無外部 dep。each test 寫一個 temp plugin 檔。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const SandboxedPlugin = require('../lib/sandboxed-plugin-host');

// ============ 共用：建立一次性 plugin 檔 ============

function tmpPlugin(body) {
  const p = path.join(os.tmpdir(), `sb-plugin-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(p, body);
  return p;
}

// 模擬 express req/res 物件
function fakeReq(method, path, body) {
  return { method, path, headers: { host: 'localhost' }, query: {}, body };
}
function fakeRes() {
  let status = 200, headers = {}, body;
  return {
    status(s) { status = s; return this; },
    set(k, v) { headers[k] = v; return this; },
    json(b)   { body = b; this._done = true; },
    send(b)   { body = b; this._done = true; },
    end()     { this._done = true; },
    _status:  () => status,
    _headers: () => headers,
    _body:    () => body,
  };
}

// ============ Basic lifecycle ============

test('SandboxedPlugin start / stop a no-op plugin cleanly', async () => {
  const p = tmpPlugin(`module.exports = function(ctx) { /* no routes */ };`);
  const sb = new SandboxedPlugin({
    name: 'noop', pluginPath: p, grantedPermissions: ['route'],
    onLog: () => {},
  });
  try {
    const routes = await sb.start();
    assert.strictEqual(sb.state, 'ready');
    assert.deepStrictEqual(routes, []);
  } finally {
    await sb.stop();
    fs.unlinkSync(p);
  }
});

test('SandboxedPlugin: plugin must export a function (not object)', async () => {
  // 既有的 in-process plugin export object — 在 sandbox 模式不接受
  const p = tmpPlugin(`module.exports = { mount: '/foo', router: function(){} };`);
  const sb = new SandboxedPlugin({
    name: 'bad', pluginPath: p, grantedPermissions: ['route'], onLog: () => {},
  });
  try {
    await assert.rejects(() => sb.start(), /export a function/);
  } finally {
    await sb.stop().catch(() => {});
    fs.unlinkSync(p);
  }
});

test('SandboxedPlugin: requires "route" permission to register endpoints', async () => {
  const p = tmpPlugin(`
    module.exports = function(ctx) {
      ctx.route.mount('GET', '/x', () => ({ status: 200 }));
    };
  `);
  const sb = new SandboxedPlugin({
    name: 'unauthz', pluginPath: p, grantedPermissions: [], onLog: () => {},
  });
  try {
    await assert.rejects(() => sb.start(), /needs "route" permission/);
  } finally {
    await sb.stop().catch(() => {});
    fs.unlinkSync(p);
  }
});

// ============ Route round-trip ============

test('SandboxedPlugin: GET request → handler runs in worker → response back', async () => {
  const p = tmpPlugin(`
    module.exports = function(ctx) {
      ctx.route.mount('GET', '/', async (req) => ({
        status: 200,
        body: { hello: 'world', method: req.method, path: req.path },
      }));
    };
  `);
  const sb = new SandboxedPlugin({
    name: 'rt', pluginPath: p, grantedPermissions: ['route'], onLog: () => {},
  });
  try {
    await sb.start();
    const handler = sb.asExpressHandler();
    const req = fakeReq('GET', '/');
    const res = fakeRes();
    await handler(req, res);
    assert.strictEqual(res._status(), 200);
    assert.deepStrictEqual(res._body(), { hello: 'world', method: 'GET', path: '/' });
  } finally {
    await sb.stop();
    fs.unlinkSync(p);
  }
});

test('SandboxedPlugin: named-param routing :id', async () => {
  const p = tmpPlugin(`
    module.exports = function(ctx) {
      ctx.route.mount('GET', '/echo/:text', async (req) => ({
        status: 200, body: { echoed: req.params.text },
      }));
    };
  `);
  const sb = new SandboxedPlugin({
    name: 'param', pluginPath: p, grantedPermissions: ['route'], onLog: () => {},
  });
  try {
    await sb.start();
    const handler = sb.asExpressHandler();
    const res = fakeRes();
    await handler(fakeReq('GET', '/echo/hello'), res);
    assert.deepStrictEqual(res._body(), { echoed: 'hello' });
  } finally {
    await sb.stop();
    fs.unlinkSync(p);
  }
});

test('SandboxedPlugin: 404 when no handler matches', async () => {
  const p = tmpPlugin(`
    module.exports = function(ctx) {
      ctx.route.mount('GET', '/only-this', async () => ({ status: 200, body: 'ok' }));
    };
  `);
  const sb = new SandboxedPlugin({
    name: '404test', pluginPath: p, grantedPermissions: ['route'], onLog: () => {},
  });
  try {
    await sb.start();
    const handler = sb.asExpressHandler();
    const res = fakeRes();
    await handler(fakeReq('GET', '/not-found'), res);
    assert.strictEqual(res._status(), 404);
  } finally {
    await sb.stop();
    fs.unlinkSync(p);
  }
});

// ============ Failure isolation — THE big-deal test for Phase 2 ============

test('SandboxedPlugin: handler throw → 500 returned, worker stays alive', async () => {
  const p = tmpPlugin(`
    module.exports = function(ctx) {
      ctx.route.mount('GET', '/boom', async () => { throw new Error('kaboom'); });
      ctx.route.mount('GET', '/ok',   async () => ({ status: 200, body: 'still alive' }));
    };
  `);
  const sb = new SandboxedPlugin({
    name: 'crashy', pluginPath: p, grantedPermissions: ['route'], onLog: () => {},
  });
  try {
    await sb.start();
    const handler = sb.asExpressHandler();
    // Trigger crash
    const r1 = fakeRes();
    await handler(fakeReq('GET', '/boom'), r1);
    assert.strictEqual(r1._status(), 500);
    assert.match(JSON.stringify(r1._body()), /kaboom/);
    // Worker should still be ready
    assert.strictEqual(sb.state, 'ready');
    // Subsequent request still works
    const r2 = fakeRes();
    await handler(fakeReq('GET', '/ok'), r2);
    assert.strictEqual(r2._status(), 200);
    assert.strictEqual(r2._body(), 'still alive');
  } finally {
    await sb.stop();
    fs.unlinkSync(p);
  }
});

test('SandboxedPlugin: worker process.exit kills plugin but main thread keeps running', async () => {
  // 故意 process.exit 在 worker 內 — 模擬 plugin 用了 dirty hack 把 worker 殺掉
  const p = tmpPlugin(`
    module.exports = function(ctx) {
      ctx.route.mount('GET', '/suicide', async () => {
        setTimeout(() => process.exit(1), 5);
        return { status: 200, body: 'goodbye' };
      });
    };
  `);
  const sb = new SandboxedPlugin({
    name: 'suicide', pluginPath: p, grantedPermissions: ['route'], onLog: () => {},
  });
  try {
    await sb.start();
    const handler = sb.asExpressHandler();
    const r = fakeRes();
    await handler(fakeReq('GET', '/suicide'), r);
    assert.strictEqual(r._body(), 'goodbye');
    // 等 worker 真的退出
    await new Promise((res) => setTimeout(res, 200));
    assert.strictEqual(sb.state, 'dead');
    // 進來的下一個 request 應該 503，不會 hang
    const r2 = fakeRes();
    await handler(fakeReq('GET', '/suicide'), r2);
    assert.strictEqual(r2._status(), 503);
  } finally {
    await sb.stop().catch(() => {});
    fs.unlinkSync(p);
  }
});

test('SandboxedPlugin: 422 / error response from handler is honored verbatim', async () => {
  const p = tmpPlugin(`
    module.exports = function(ctx) {
      ctx.route.mount('GET', '/teapot', async () => ({
        status: 418, headers: { 'X-Special': 'yes' }, body: { im: 'a teapot' },
      }));
    };
  `);
  const sb = new SandboxedPlugin({
    name: 'teapot', pluginPath: p, grantedPermissions: ['route'], onLog: () => {},
  });
  try {
    await sb.start();
    const handler = sb.asExpressHandler();
    const res = fakeRes();
    await handler(fakeReq('GET', '/teapot'), res);
    assert.strictEqual(res._status(), 418);
    assert.strictEqual(res._headers()['X-Special'], 'yes');
    assert.deepStrictEqual(res._body(), { im: 'a teapot' });
  } finally {
    await sb.stop();
    fs.unlinkSync(p);
  }
});

// ============ Log forwarding ============

test('SandboxedPlugin: ctx.log(...) bubbles back to main onLog callback', async () => {
  const p = tmpPlugin(`
    module.exports = function(ctx) {
      ctx.log.warn('initialized with', ctx.permissions.length, 'permissions');
      ctx.route.mount('GET', '/', async () => {
        ctx.log.info('request handled');
        return { status: 200, body: 'ok' };
      });
    };
  `);
  const logs = [];
  const sb = new SandboxedPlugin({
    name: 'loggy', pluginPath: p, grantedPermissions: ['route'],
    onLog: (level, msg) => logs.push({ level, msg }),
  });
  try {
    await sb.start();
    assert.ok(logs.some((l) => l.level === 'warn' && /initialized/.test(l.msg)));
    const handler = sb.asExpressHandler();
    await handler(fakeReq('GET', '/'), fakeRes());
    assert.ok(logs.some((l) => l.level === 'info' && /request handled/.test(l.msg)));
  } finally {
    await sb.stop();
    fs.unlinkSync(p);
  }
});

// ============ Path matcher unit tests ============

test('plugin-worker path matcher: literal segment match', () => {
  const { _internal } = require('../lib/plugin-worker');
  assert.strictEqual(_internal.pathMatches('/users', '/users'), true);
  assert.strictEqual(_internal.pathMatches('/users', '/posts'), false);
});

test('plugin-worker path matcher: named param', () => {
  const { _internal } = require('../lib/plugin-worker');
  assert.strictEqual(_internal.pathMatches('/users/:id', '/users/42'), true);
  assert.deepStrictEqual(_internal.matchParams('/users/:id', '/users/42'), { id: '42' });
});

test('plugin-worker path matcher: length mismatch → false', () => {
  const { _internal } = require('../lib/plugin-worker');
  assert.strictEqual(_internal.pathMatches('/users/:id', '/users'), false);
  assert.strictEqual(_internal.pathMatches('/users', '/users/42'), false);
});

test('plugin-worker path matcher: multiple params', () => {
  const { _internal } = require('../lib/plugin-worker');
  assert.deepStrictEqual(
    _internal.matchParams('/orgs/:org/users/:id', '/orgs/acme/users/42'),
    { org: 'acme', id: '42' }
  );
});
