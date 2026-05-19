// Healthz v2 — license-server side。
//
// 跟 node-express/lib/healthz.js 同 pattern 但 component 不同：
//   license_db   — SQLite file 存在 + 可開
//   smtp_config  — SMTP env vars 設了沒（optional component）
//   stripe       — Stripe SDK 載得進來 + secret 設了
//   ecpay        — ECPay 設定完整
//
// 預設只把「critical components」(license_db) 列為 ok 與否影響 200/503；
// 其他都當 informational — 沒 SMTP 不該讓 healthz 變 503。

const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.LICENSE_DB || path.join(__dirname, '..', 'license.db');

// 每個 check 回 { ok, critical: bool, ...extras }
// critical=true 才會影響整體 200/503
const CHECKS = {
  license_db() {
    if (!fs.existsSync(DB_PATH)) {
      return { ok: false, critical: true, error: 'database file missing — first start?', path: DB_PATH };
    }
    try {
      const s = fs.statSync(DB_PATH);
      // 嘗試開（confirm 不 corrupt）
      try {
        const db = require('../db');         // module already initialized
        const c = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
        return { ok: true, critical: true, sizeBytes: s.size, users: c };
      } catch (e) {
        return { ok: false, critical: true, error: 'cannot query: ' + e.message, sizeBytes: s.size };
      }
    } catch (e) { return { ok: false, critical: true, error: e.message }; }
  },

  smtp_config() {
    const configured = !!process.env.SMTP_HOST;
    return {
      ok: true, critical: false, configured,
      note: configured ? 'SMTP configured (real email sent)' : 'SMTP not configured (dev mode — verify links printed to console)',
    };
  },

  stripe_config() {
    const hasKey = !!process.env.STRIPE_SECRET_KEY;
    const hasWebhook = !!process.env.STRIPE_WEBHOOK_SECRET;
    return {
      ok: true, critical: false,
      enabled: hasKey, webhookConfigured: hasWebhook,
      note: hasKey ? 'Stripe checkout enabled' : 'Stripe not configured (no STRIPE_SECRET_KEY)',
    };
  },

  ecpay_config() {
    const configured = !!(process.env.ECPAY_MERCHANT_ID && process.env.ECPAY_HASH_KEY && process.env.ECPAY_HASH_IV);
    return {
      ok: true, critical: false, configured,
      note: configured ? 'ECPay (綠界) enabled' : 'ECPay not configured (no ECPAY_* env vars)',
    };
  },
};

async function snapshot() {
  const out = { ok: true, components: {} };
  for (const [name, fn] of Object.entries(CHECKS)) {
    try {
      const r = await fn();
      out.components[name] = r;
      // 只有 critical=true 的 failure 才會把整體 ok 拉成 false
      if (!r.ok && r.critical) out.ok = false;
    } catch (e) {
      out.components[name] = { ok: false, critical: true, error: e.message };
      out.ok = false;
    }
  }
  out.uptime = process.uptime();
  try { out.version = require('../package.json').version; } catch { /* no package.json */ }
  return out;
}

function handler() {
  return async (req, res) => {
    const snap = await snapshot();
    res.status(snap.ok ? 200 : 503).json(snap);
  };
}

module.exports = { snapshot, handler, _internal: { CHECKS } };
