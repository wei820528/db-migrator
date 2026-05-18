// Plugin worker entry — v2 Theme D Phase 2。
//
// 在 worker_thread 內執行。從 parentPort 收到 `init` message 後 require plugin
// 模組，把 SDK ctx inject 進去（plugin 應該 export 一個 function 而不是 object）。
// 之後 main thread 來的 HTTP request 用 message 轉發過來，這裡呼叫 handler、把
// response 用 message 傳回去。
//
// 注意：worker 仍能 require('fs') 等模組 — 真正 OS-level sandbox 要 child_process /
// isolated-vm。此 phase 的 isolation 價值在於：
//   (1) 崩潰隔離：plugin throw 不會 take down main process
//   (2) Event loop 隔離：plugin while(true){} 不會卡住主 server
//   (3) API surface：plugin 「應該」只用 ctx，不應 require('http')；雖然能但會被
//       code review / audit 看到

const { parentPort } = require('worker_threads');

let plugin = null;
let pluginName = null;
let grantedPermissions = [];
let registeredHandlers = []; // { method, path, handler }

// ============ SDK ctx ============
// Plugin author 拿到的唯一 API surface。Phase 2 MVP 只有 route + log。
// 未來 phase 會加 ctx.db / ctx.adapter / ctx.ui 等等。

function buildCtx() {
  const log = (level, ...args) => {
    parentPort.postMessage({ type: 'log', level, msg: args.map(String).join(' ') });
  };
  return {
    pluginName,
    permissions: grantedPermissions.slice(),
    log: Object.assign(log.bind(null, 'info'), {
      debug: (...a) => log('debug', ...a),
      info:  (...a) => log('info',  ...a),
      warn:  (...a) => log('warn',  ...a),
      error: (...a) => log('error', ...a),
    }),
    route: {
      // mount('GET', '/hello', async (req) => ({ status: 200, body: {...} }))
      mount(method, path, handler) {
        if (!grantedPermissions.includes('route')) {
          throw new Error(`plugin ${pluginName} needs "route" permission to register endpoints`);
        }
        if (typeof handler !== 'function') throw new Error('handler must be a function');
        registeredHandlers.push({ method: String(method).toUpperCase(), path, handler });
      },
    },
    hasPermission(p) { return grantedPermissions.includes(p); },
  };
}

// ============ Message handlers ============

// 只在 worker thread 中註冊 handler — 從 main thread require 進來（unit test 用）
// 時 parentPort 是 null，跳過避免 crash；下面 export 的 _internal helpers 仍能用。
if (parentPort) parentPort.on('message', async (msg) => {
  try {
    if (msg.type === 'init') {
      pluginName = msg.name;
      grantedPermissions = msg.grantedPermissions || [];
      const pluginEntry = require(msg.pluginPath);
      if (typeof pluginEntry !== 'function') {
        throw new Error(
          `sandboxed plugin must export a function(ctx); got ${typeof pluginEntry}. ` +
          `Legacy object-export plugins are not supported in sandboxed mode.`
        );
      }
      const ctx = buildCtx();
      // Plugin 同步 / 非同步皆可
      await pluginEntry(ctx);
      parentPort.postMessage({
        type: 'ready',
        routes: registeredHandlers.map((h) => ({ method: h.method, path: h.path })),
      });
    } else if (msg.type === 'request') {
      const h = registeredHandlers.find(
        (x) => x.method === msg.method && pathMatches(x.path, msg.path)
      );
      if (!h) {
        parentPort.postMessage({ type: 'response', id: msg.id, status: 404, body: { error: 'no handler' } });
        return;
      }
      try {
        const result = await Promise.resolve(h.handler({
          method: msg.method,
          path: msg.path,
          headers: msg.headers || {},
          body: msg.body,
          params: matchParams(h.path, msg.path),
          query: msg.query || {},
        }));
        const status = (result && result.status) || 200;
        const headers = (result && result.headers) || {};
        const body = (result && 'body' in result) ? result.body : (result ?? null);
        parentPort.postMessage({ type: 'response', id: msg.id, status, headers, body });
      } catch (e) {
        parentPort.postMessage({
          type: 'response', id: msg.id, status: 500,
          body: { error: e.message, plugin: pluginName },
        });
      }
    } else if (msg.type === 'shutdown') {
      parentPort.postMessage({ type: 'shutdown-ack' });
      // 給 main thread 一點時間收 ack 再退出
      setTimeout(() => process.exit(0), 50);
    }
  } catch (e) {
    parentPort.postMessage({
      type: 'fatal', plugin: pluginName, msg: e.message, stack: e.stack,
    });
  }
});

// ============ Tiny path matcher ============
// 支援 '/users/:id' 風格的 named params。沒做 regex / wildcard，MVP 夠用。

function pathToParts(p) {
  return String(p).replace(/^\/+|\/+$/g, '').split('/');
}

function pathMatches(template, actual) {
  const t = pathToParts(template);
  const a = pathToParts(actual);
  if (t.length !== a.length) return false;
  for (let i = 0; i < t.length; i++) {
    if (t[i].startsWith(':')) continue;
    if (t[i] !== a[i]) return false;
  }
  return true;
}

function matchParams(template, actual) {
  const t = pathToParts(template);
  const a = pathToParts(actual);
  const out = {};
  for (let i = 0; i < t.length; i++) {
    if (t[i].startsWith(':')) out[t[i].slice(1)] = a[i];
  }
  return out;
}

// 暴露給 test
module.exports = { _internal: { pathMatches, matchParams } };
