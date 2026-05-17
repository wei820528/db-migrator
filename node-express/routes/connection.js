const router = require('express').Router();
const { getAdapter } = require('../adapters');

function describeError(e) {
  if (!e) return 'Unknown error';
  if (typeof e === 'string') return e;
  return (
    e.message ||
    e.originalError?.message ||
    e.originalError?.info?.message ||
    e.code ||
    String(e)
  );
}

router.post('/test', async (req, res) => {
  try {
    const { type, ...conn } = req.body;
    const adapter = getAdapter(type);
    const r = await adapter.testConnection(conn);
    res.json(r);
  } catch (e) {
    console.error('[connection/test] failed:', e);
    res.status(400).json({ ok: false, error: describeError(e) });
  }
});

router.post('/tables', async (req, res) => {
  try {
    const { type, ...conn } = req.body;
    const adapter = getAdapter(type);
    const tables = await adapter.listTables(conn);
    res.json({ tables });
  } catch (e) {
    console.error('[connection/tables] failed:', e);
    res.status(400).json({ error: describeError(e) });
  }
});

module.exports = router;
