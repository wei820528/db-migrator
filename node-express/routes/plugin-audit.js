// Theme D Phase 4 — plugin audit log query endpoint。
//
// Read-only — append 由 worker 端的 sensitive event 觸發（require gate denial、
// nested-worker spawn attempt、route mount、handler error）。

const router = require('express').Router();
const audit = require('../lib/plugin-audit');

// GET /api/plugin-audit?plugin=X&event=Y&since=<ms>&minSeverity=warn&limit=100
router.get('/', (req, res) => {
  try {
    const items = audit.list({
      plugin: req.query.plugin || undefined,
      eventType: req.query.event || undefined,
      since: req.query.since ? Number(req.query.since) : undefined,
      minSeverity: req.query.minSeverity || undefined,
      limit: req.query.limit ? Number(req.query.limit) : 100,
    });
    res.json({ items, count: items.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/plugin-audit/count — 不拉 items，只回數字（dashboard 用）
router.get('/count', (req, res) => {
  try {
    const n = audit.count({
      plugin: req.query.plugin || undefined,
      eventType: req.query.event || undefined,
      since: req.query.since ? Number(req.query.since) : undefined,
    });
    res.json({ count: n });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/plugin-audit/prune?olderThanDays=30 — 砍舊紀錄
router.post('/prune', (req, res) => {
  try {
    const days = req.body?.olderThanDays || req.query.olderThanDays || 30;
    const r = audit.prune({ olderThanDays: Number(days) });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
