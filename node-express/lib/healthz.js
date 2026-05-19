// Healthz v2 — v2 Theme E Phase 1。
//
// 比舊的 GET /api/health 多了 component breakdown。Container orchestrators 跟
// monitoring 系統可以用 /healthz 看到哪一個 sub-system 病了。
//
//   200 OK    — 全部 component 都健康
//   503 SVC.. — 任何一個 component 失敗（HTTP status 寫進 response，方便 LB 用）
//
// 用法在 server.js：
//   const healthz = require('./lib/healthz');
//   app.get('/healthz', async (req, res) => res.status(...).json(...));

const fs = require('fs');
const path = require('path');

// 每個 check 回 { ok: bool, ...extras }。失敗就 ok:false。Async safe。
const CHECKS = {
  // SQLite-backed stores — 如果 better-sqlite3 沒裝，回 skipped 不算 fail
  jobs_db() {
    const file = path.join(__dirname, '..', 'jobs.db');
    return statCheck(file);
  },
  schedules_db() {
    return statCheck(path.join(__dirname, '..', 'schedules.db'));
  },
  webhooks_db() {
    return statCheck(path.join(__dirname, '..', 'webhooks.db'));
  },

  // Adapters — 從 registry 拿狀態，列出哪些 failed
  adapters() {
    try {
      const reg = require('../adapters').getStatus();
      const failed = Object.entries(reg)
        .filter(([n, s]) => !s.ok && n !== '_error')
        .map(([n, s]) => ({ name: n, error: s.error }));
      const total = Object.keys(reg).filter((n) => n !== '_error').length;
      return { ok: failed.length === 0, total, failed };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  // License gate
  license() {
    try {
      const lic = require('./license').getStatus();
      // 'disabled' / 'licensed' / 'trial' / 'free' 都算 healthy；
      // 'expired' / 'kicked' / 'revoked' / 'offline' 不算
      const okStates = ['disabled', 'licensed', 'trial', 'free'];
      return { ok: okStates.includes(lic.status), status: lic.status, mode: lic.mode };
    } catch (e) { return { ok: false, error: e.message }; }
  },
};

// 給檔案存在性的 quick check（不開啟連線，只看檔在不在）
function statCheck(file) {
  if (!fs.existsSync(file)) return { ok: true, present: false, note: 'not initialized yet' };
  try {
    const s = fs.statSync(file);
    return { ok: true, present: true, sizeBytes: s.size, mtime: s.mtime.toISOString() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// 跑全部 checks，回 { ok, components, uptime, version }
async function snapshot() {
  const out = { ok: true, components: {} };
  for (const [name, fn] of Object.entries(CHECKS)) {
    try {
      const r = await fn();
      out.components[name] = r;
      if (!r.ok) out.ok = false;
    } catch (e) {
      out.components[name] = { ok: false, error: e.message };
      out.ok = false;
    }
  }
  out.uptime = process.uptime();
  try {
    out.version = require('../package.json').version;
  } catch { /* no package.json */ }
  return out;
}

// Express handler — convenience
function handler() {
  return async (req, res) => {
    const snap = await snapshot();
    res.status(snap.ok ? 200 : 503).json(snap);
  };
}

module.exports = { snapshot, handler, _internal: { CHECKS, statCheck } };
