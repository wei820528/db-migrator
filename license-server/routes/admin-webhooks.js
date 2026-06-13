// License-server admin webhooks routes — v2 Theme E follow-up (Phase 3)。
//
// Cookie-authenticated (admin_session) — 跟 routes/admin.js 用同樣 auth pattern。
// 為什麼不把 admin.js 拆 middleware 出來 共用：requireAdmin 才 15 行，重複比
// 抽 module 簡單，且 admin-webhooks 是獨立 mount path 不會繞回去。
//
// Mount path: app.use('/api/admin/webhooks', router) — 在 server.js 那邊。

const router = require('express').Router();
const db = require('../db');
const wh = require('../lib/admin-webhooks');

const COOKIE_NAME = 'admin_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;  // 7 days

function authedAdmin(req) {
  const sid = req.cookies?.[COOKIE_NAME];
  if (!sid) return null;
  const s = db.prepare('SELECT * FROM admin_sessions WHERE id = ?').get(sid);
  if (!s) return null;
  if (new Date() - new Date(s.last_seen) > SESSION_TTL_MS) {
    db.prepare('DELETE FROM admin_sessions WHERE id = ?').run(sid);
    return null;
  }
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id);
  if (!u || !u.is_admin) return null;
  db.prepare('UPDATE admin_sessions SET last_seen = CURRENT_TIMESTAMP WHERE id = ?').run(sid);
  return u;
}

function requireAdmin(req, res, next) {
  if (!authedAdmin(req)) return res.status(401).json({ error: 'admin auth required' });
  next();
}

router.use(requireAdmin);

// ============ CRUD ============

router.get('/', (req, res) => {
  res.json({
    webhooks: wh.listWebhooks(),
    knownEvents: wh.KNOWN_EVENTS,
  });
});

router.post('/', (req, res) => {
  try {
    const { name, url, events } = req.body || {};
    const r = wh.createWebhook({ name, url, events });
    // secret 只在 create 回傳一次
    res.json(r);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.patch('/:id', (req, res) => {
  try {
    const updated = wh.updateWebhook(req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', (req, res) => {
  const ok = wh.deleteWebhook(req.params.id);
  if (!ok) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

router.post('/:id/test', async (req, res) => {
  try {
    const r = await wh.testPing(req.params.id);
    res.json(r);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
