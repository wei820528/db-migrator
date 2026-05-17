const router = require('express').Router();
const license = require('../lib/license');
const offline = require('../lib/license-offline');
const online = require('../lib/license-online');

router.get('/', (req, res) => res.json(license.getStatus()));

// ---- Offline mode endpoints (signed key file) ----
router.post('/key', (req, res) => {
  const text = req.body?.license || req.body?.key || '';
  if (!text) return res.status(400).json({ error: 'license string required in body.license' });
  try { res.json({ ok: true, info: offline.saveLicense(text) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.delete('/key', (req, res) => {
  offline.removeLicense();
  res.json({ ok: true });
});

// Manually trigger a revocation-list fetch (UI "check now" button).
// Normally happens automatically every 24h on getStatus().
router.post('/revocation/refresh', async (req, res) => {
  try { res.json(await offline.refreshRevocation()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Online mode endpoints (proxy to license server, with token managed server-side) ----
router.post('/online/register', async (req, res) => {
  try { res.json(await online.register(req.body?.email, req.body?.password)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/online/login', async (req, res) => {
  try { res.json(await online.login(req.body?.email, req.body?.password)); }
  catch (e) { res.status(401).json({ error: e.message }); }
});
router.post('/online/logout', async (req, res) => {
  try { await online.logout(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
