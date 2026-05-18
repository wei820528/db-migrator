// Webhook CRUD + test-ping。Mount: app.use('/api/webhooks', router)
const router = require('express').Router();
const wh = require('../lib/webhooks');

router.get('/', (req, res) => {
  res.json({ webhooks: wh.listWebhooks(), events: wh.KNOWN_EVENTS });
});

router.post('/', (req, res) => {
  try {
    const { name, url, events } = req.body || {};
    const created = wh.createWebhook({ name, url, events });
    // Secret 只此一次回傳；之後就拿不到了
    res.json(created);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.patch('/:id', (req, res) => {
  try {
    const updated = wh.updateWebhook(req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
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
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
