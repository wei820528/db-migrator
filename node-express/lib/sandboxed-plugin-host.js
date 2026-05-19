// Sandboxed plugin host — v2 Theme D Phase 2 (main-thread side)。
//
// 對應的 worker 端在 lib/plugin-worker.js。本檔負責：
//   1. spawn worker_thread 跑 plugin
//   2. 收 plugin 的 log message → 印到主 console
//   3. 收 HTTP request → 包成 message 給 worker → 收回 response → 寫到 res
//   4. 監控 worker exit / error → 標記 plugin failed，main 不會 crash
//
// 一個 SandboxedPlugin instance = 一個 worker_thread + 一個 Express handler。

const { Worker } = require('worker_threads');
const path = require('path');
const crypto = require('crypto');

const WORKER_ENTRY = path.join(__dirname, 'plugin-worker.js');
const REQUEST_TIMEOUT_MS = 30_000;        // 給 plugin 30 秒處理單一 request
const READY_TIMEOUT_MS = 10_000;          // worker 啟動上限

class SandboxedPlugin {
  constructor({ name, pluginPath, grantedPermissions, onLog, onAudit }) {
    this.name = name;
    this.pluginPath = pluginPath;
    this.grantedPermissions = grantedPermissions || [];
    this.onLog = onLog || ((level, msg) => console.log(`[plugin:${name}] ${level}: ${msg}`));
    // Phase 4: audit callback。預設只 console.warn — 真正進 SQLite 由 pluginHost 注入
    this.onAudit = onAudit || ((evt) => console.warn(`[audit:${name}] ${evt.event}`, evt.detail || {}));
    this.worker = null;
    this.pending = new Map();              // id → {resolve, reject, timer}
    this.routes = [];                      // [{method, path}]
    this.state = 'idle';                   // idle | starting | ready | dead
    this.deathReason = null;
  }

  async start() {
    if (this.state !== 'idle') throw new Error(`plugin ${this.name} already ${this.state}`);
    this.state = 'starting';

    this.worker = new Worker(WORKER_ENTRY);
    this.worker.on('message', (msg) => this._onMessage(msg));
    this.worker.on('error', (e) => this._die('worker error: ' + e.message));
    this.worker.on('exit', (code) => {
      if (this.state !== 'dead') this._die(`worker exited unexpectedly (code ${code})`);
    });

    // 等 'ready' message
    const readyPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('plugin start timeout')), READY_TIMEOUT_MS);
      this._readyResolve = (routes) => { clearTimeout(timer); this.routes = routes || []; resolve(routes); };
      this._readyReject  = (e)      => { clearTimeout(timer); reject(e); };
    });

    this.worker.postMessage({
      type: 'init',
      pluginPath: this.pluginPath,
      name: this.name,
      grantedPermissions: this.grantedPermissions,
    });

    await readyPromise;
    this.state = 'ready';
    return this.routes;
  }

  async stop() {
    if (this.state === 'dead' || !this.worker) return;
    this.state = 'dead';
    try {
      this.worker.postMessage({ type: 'shutdown' });
      // 給 ack 一點時間，逾時就強制 terminate
      await Promise.race([
        new Promise((r) => this.worker.once('exit', r)),
        new Promise((r) => setTimeout(r, 500)),
      ]);
    } catch { /* ignore */ }
    try { await this.worker.terminate(); } catch { /* ignore */ }
    this._failAllPending('plugin stopped');
  }

  // 建一個 Express handler：把 req/res 序列化送進 worker、把 response 寫出去。
  asExpressHandler() {
    return async (req, res, next) => {
      if (this.state !== 'ready') {
        res.status(503).json({ error: `plugin ${this.name} not ready (state=${this.state})`, deathReason: this.deathReason });
        return;
      }
      const id = crypto.randomUUID();
      try {
        const result = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`plugin ${this.name} response timeout`));
          }, REQUEST_TIMEOUT_MS);
          this.pending.set(id, { resolve, reject, timer });
          this.worker.postMessage({
            type: 'request', id,
            method: req.method,
            // 把 mount 拿掉，只送相對 path 給 plugin
            path: req.path,
            headers: serializableHeaders(req.headers),
            query: req.query,
            body: req.body,
          });
        });
        res.status(result.status || 200);
        for (const [k, v] of Object.entries(result.headers || {})) res.set(k, v);
        if (result.body == null) res.end();
        else if (typeof result.body === 'string') res.send(result.body);
        else res.json(result.body);
      } catch (e) {
        res.status(502).json({ error: e.message, plugin: this.name });
      }
    };
  }

  // ============ 內部 ============

  _onMessage(msg) {
    if (msg.type === 'ready')    { this._readyResolve?.(msg.routes); return; }
    if (msg.type === 'log')      { this.onLog(msg.level, msg.msg); return; }
    if (msg.type === 'audit') {
      // Phase 4: 把 audit event 傳給 host 注入的 callback（寫 SQLite）
      try {
        this.onAudit({
          pluginName: this.name,
          event: msg.event,
          severity: msg.severity || 'info',
          detail: msg.detail || {},
        });
      } catch (e) { /* audit callback 失敗不該 crash plugin host */ }
      return;
    }
    if (msg.type === 'response') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      p.resolve({ status: msg.status, headers: msg.headers, body: msg.body });
      return;
    }
    if (msg.type === 'fatal') {
      this._readyReject?.(new Error(msg.msg));
      this._die('plugin fatal: ' + msg.msg);
      return;
    }
    if (msg.type === 'shutdown-ack') return;
  }

  _die(reason) {
    if (this.state === 'dead') return;
    this.state = 'dead';
    this.deathReason = reason;
    this.onLog('error', `[host] ${reason}`);
    this._readyReject?.(new Error(reason));
    this._failAllPending(reason);
    try { this.worker?.terminate(); } catch { }
  }

  _failAllPending(reason) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }
}

// Headers 物件可能含不能 structured-clone 的東西（Node 內部 Symbol etc.）
// 拍平成 plain object 再送。
function serializableHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h || {})) out[k] = String(v);
  return out;
}

module.exports = SandboxedPlugin;
