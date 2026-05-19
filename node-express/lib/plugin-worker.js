// Plugin worker entry — v2 Theme D Phase 2 + Phase 3 + Phase 4。
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
// Phase 4 加上：
//   (5) Worker gate — wrap globalThis.Worker + worker_threads.Worker，plugin
//       想 spawn nested worker 必須有 "unrestricted"。否則 throw 同時進 audit。
//   (6) Persistent audit trail — require-denied、worker-spawn-attempt、
//       route-mount、handler-error 都 emit `audit` message 給 host，host 寫 DB。
//
// 仍然沒擋（要 OS-level sandbox 才有辦法）：
//   - process.dlopen / process.binding 之類 native escape
//   - SharedArrayBuffer + Atomics 跨 thread 通信

const workerThreads = require('worker_threads');
const { parentPort, threadId } = workerThreads;
const Module = require('module');
const path = require('path');

// Audit helper — 把 sensitive event 包成 message 傳給 main thread。
// Main thread 端在 sandboxed-plugin-host.js 收 type:'audit' 寫 SQLite。
// 故意做純函式（沒 import 任何 stateful）— easy to test。
function emitAudit(event, severity, detail) {
  if (!parentPort) return;
  try {
    parentPort.postMessage({
      type: 'audit',
      event,                            // require-denied / worker-spawn-attempt / etc.
      severity,                         // info / warn / error
      detail: detail || {},
    });
  } catch { /* postMessage 失敗就吞 — audit 不該 crash plugin */ }
}

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
      // Phase 4: 寫 audit + 同時 log 一行（人類友善）
      emitAudit('require-denied', 'warn', {
        target: idStr,
        suggestedPermission: suggestPermission(target),
        grantedPermissions: grantedPermissions.slice(),
        caller: callerFile,
      });
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

// ============ Phase 4: Worker constructor gate ============
//
// Plugin 可能透過幾個路徑拿到 Worker class:
//   a. require('worker_threads').Worker  → 被 Phase 3 require gate 攔（無 unrestricted）
//   b. globalThis.Worker  → Node 21+ 才有 expose，未來保險
//   c. 已經有 'unrestricted' permission 的 plugin 拿到 Worker — Phase 3 放行
//
// (c) 才是 Phase 4 要解決的：有 unrestricted 仍然要 audit + 預設 deny nested
// worker（除非 plugin 額外設了 "worker-spawn" — 但 MVP 沒這個 perm，一律 deny）。
// 這樣即使 plugin 拿到 unrestricted 還是不能無痕 spawn 子 worker 逃出 sandbox。
function makeGatedWorker(OriginalWorker) {
  function GatedWorker(...args) {
    const argSummary = args.map((a) => {
      if (typeof a === 'string') return { kind: 'path-or-code', preview: a.slice(0, 120) };
      if (Buffer.isBuffer(a))    return { kind: 'buffer', length: a.length };
      if (a && typeof a === 'object') {
        return { kind: 'options', keys: Object.keys(a).slice(0, 10), eval: !!a.eval };
      }
      return { kind: typeof a };
    });
    emitAudit('worker-spawn-attempt', 'error', {
      args: argSummary,
      grantedPermissions: grantedPermissions.slice(),
    });
    // Phase 4 MVP：一律 deny nested worker — 即使 unrestricted。
    // 將來要放就改成 grantedPermissions.includes('worker-spawn')。
    throw new Error(
      `[sandbox] plugin "${pluginName}" cannot spawn worker_threads.Worker — ` +
      `nested workers are blocked to prevent sandbox escape`
    );
  }
  // 讓 instanceof / static method lookup 仍然 work
  GatedWorker.prototype = OriginalWorker.prototype;
  Object.setPrototypeOf(GatedWorker, OriginalWorker);
  return GatedWorker;
}

function installWorkerGate() {
  const Original = workerThreads.Worker;
  const Gated = makeGatedWorker(Original);

  // (a) module cache 的 Worker — plugin require('worker_threads').Worker 拿這個
  try {
    Object.defineProperty(workerThreads, 'Worker', {
      value: Gated, writable: true, configurable: true,
    });
  } catch { /* 某些 Node 版本可能不准 — 但 require gate 仍然會擋 */ }

  // (b) globalThis.Worker — Node 21+ 才存在；都加保險
  try { globalThis.Worker = Gated; } catch {}
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
        emitAudit('route-mount', 'info', { method: String(method).toUpperCase(), path });
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
      installWorkerGate();   // Phase 4 — 攔 nested worker spawn
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
        emitAudit('handler-error', 'error', {
          method: msg.method, path: msg.path, message: e.message,
        });
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
  _internal: {
    pathMatches, matchParams, builtinAllowed,
    ALWAYS_ALLOWED_BUILTINS, PERMISSION_BUILTINS,
    makeGatedWorker,
  },
};
