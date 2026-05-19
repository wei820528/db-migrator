// Plugin worker entry — v2 Theme D Phase 2 + Phase 3。
//
// 在 worker_thread 內執行。從 parentPort 收到 `init` message 後 require plugin
// 模組，把 SDK ctx inject 進去（plugin 應該 export 一個 function 而不是 object）。
// 之後 main thread 來的 HTTP request 用 message 轉發過來，這裡呼叫 handler、把
// response 用 message 傳回去。
//
// Phase 2 提供：
//   (1) 崩潰隔離：plugin throw 不會 take down main process
//   (2) Event loop 隔離：plugin while(true){} 不會卡住主 server
//   (3) API surface：plugin 「應該」只用 ctx 物件
//
// Phase 3 加上：
//   (4) Require gate — 攔 plugin 自家檔案的 require()，依 granted permissions
//       過濾 Node builtins（沒 'fs:*' 不能 require('fs')、沒 'network' 不能
//       require('http')、'unrestricted' 則完全不擋）。npm packages 跟自家
//       相對 require 永遠 pass through。
//
// 仍然沒擋（要 OS-level sandbox 才有辦法）：
//   - process.dlopen / process.binding 之類 native escape
//   - SharedArrayBuffer + Atomics 跨 thread 通信
//   - 已經 require 過、cached 的 builtin 仍能用（worker_threads 自己就是）

const { parentPort, threadId } = require('worker_threads');
const Module = require('module');
const path = require('path');

let plugin = null;
let pluginName = null;
let grantedPermissions = [];
let registeredHandlers = []; // { method, path, handler }
let pluginRootDir = null;    // 用來判斷 require 來源是不是 plugin 自家檔案

// ============ Phase 3: Require gate ============
//
// Permission → 該 permission 解鎖哪些 Node builtins。
// 永遠 allowed 的 builtins 不需要任何 permission（純運算用的工具）。
// 沒列在這裡也不在 always-allowed 的 builtin = 強制 unrestricted 才能用。
const ALWAYS_ALLOWED_BUILTINS = new Set([
  'assert', 'buffer', 'crypto', 'events', 'path', 'querystring', 'stream',
  'string_decoder', 'timers', 'url', 'util',
]);
const PERMISSION_BUILTINS = {
  'fs:tmp':         ['fs', 'fs/promises'],
  'fs:plugin-dir':  ['fs', 'fs/promises'],
  'network':        ['http', 'https', 'http2', 'net', 'dns', 'tls', 'dgram'],
  'unrestricted':   '*',     // 全開
};

function builtinAllowed(target, perms) {
  if (ALWAYS_ALLOWED_BUILTINS.has(target)) return true;
  if (perms.includes('unrestricted')) return true;
  for (const p of perms) {
    const list = PERMISSION_BUILTINS[p];
    if (list === '*') return true;
    if (Array.isArray(list) && list.includes(target)) return true;
  }
  return false;
}

function installRequireGate() {
  const origRequire = Module.prototype.require;
  Module.prototype.require = function patched(id) {
    try {
      // 只 gate 從 plugin 自家檔案發出的 require
      // npm package 內部的 require 一律放行（不然會搞死所有依賴）
      const callerFile = this.filename || '';
      const isPluginCode = pluginRootDir && callerFile.startsWith(pluginRootDir + path.sep);
      if (!isPluginCode) return origRequire.apply(this, arguments);

      // 相對 / 絕對路徑 require — 自己的檔案，放行
      const idStr = String(id);
      if (idStr.startsWith('.') || path.isAbsolute(idStr)) return origRequire.apply(this, arguments);

      // 'node:' prefix 剝掉再比對
      const target = idStr.startsWith('node:') ? idStr.slice(5) : idStr;

      // 不是 builtin → npm package，放行
      if (!Module.builtinModules.includes(target)) return origRequire.apply(this, arguments);

      // 是 builtin — 看 permission
      if (builtinAllowed(target, grantedPermissions)) return origRequire.apply(this, arguments);

      const err = new Error(
        `[sandbox] plugin "${pluginName}" cannot require("${idStr}") — ` +
        `missing permission. Granted: [${grantedPermissions.join(', ') || '(none)'}]`
      );
      // Audit log → main thread
      parentPort?.postMessage({
        type: 'log', level: 'warn',
        msg: `denied require("${idStr}") — needs ${suggestPermission(target)}`,
      });
      throw err;
    } catch (e) {
      throw e;
    }
  };
}

function suggestPermission(target) {
  for (const [perm, list] of Object.entries(PERMISSION_BUILTINS)) {
    if (Array.isArray(list) && list.includes(target)) return `"${perm}"`;
  }
  return '"unrestricted"';
}

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
    threadId,   // 給 plugin 證明 / debug 用，不必 require('worker_threads')
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
      pluginRootDir = path.dirname(msg.pluginPath);
      // 裝 require gate 之後再 require plugin 本身（這樣 plugin 內部所有 require
      // 都會被攔）。但 require(msg.pluginPath) 自己這一次不會被攔 — 因為呼叫者
      // 不是 plugin 自家檔案。
      installRequireGate();
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
module.exports = {
  _internal: { pathMatches, matchParams, builtinAllowed, ALWAYS_ALLOWED_BUILTINS, PERMISSION_BUILTINS },
};
