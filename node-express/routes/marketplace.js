const router = require('express').Router();
const marketplace = require('../lib/marketplace');

// Preview: download + verify, do NOT install. Returns manifest + signature info
// + per-file hashes. UI uses this to show the "are you sure" pane.
router.post('/preview', async (req, res) => {
  try {
    const r = await marketplace.preview(req.body?.url || '');
    // Strip binary bodies before sending to client
    res.json({
      source: r.source,
      manifest: r.manifest,
      signature: r.signature,
      files: r.files,
    });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Install: assumes user has reviewed the preview already. Set allowUnsigned
// to bypass the unsigned check (UI requires explicit confirmation for that).
router.post('/install', async (req, res) => {
  try {
    const r = await marketplace.install(req.body?.url || '', {
      allowUnsigned: !!req.body?.allowUnsigned,
    });
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/installed', (req, res) => {
  res.json({ plugins: marketplace.listInstalled() });
});

router.delete('/installed/:name', (req, res) => {
  try { res.json(marketplace.uninstall(req.params.name)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/trusted', (req, res) => {
  // Don't ship the full PEM to the UI — just IDs + key fingerprint
  const list = marketplace.loadTrustedPublishers().map((p) => ({
    id: p.id,
    fingerprint: fingerprint(p.pem),
  }));
  res.json({ publishers: list });
});

router.post('/trusted', (req, res) => {
  try { res.json(marketplace.addTrustedPublisher(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete('/trusted/:id', (req, res) => {
  res.json(marketplace.removeTrustedPublisher(req.params.id));
});

function fingerprint(pem) {
  try {
    const crypto = require('crypto');
    const der = crypto.createPublicKey(pem).export({ type: 'spki', format: 'der' });
    return crypto.createHash('sha256').update(der).digest('hex').slice(0, 32);
  } catch { return null; }
}

module.exports = router;
