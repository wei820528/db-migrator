// Public revocation list — offline-mode clients fetch this periodically.
// No auth: the list is just license_ids that are known-bad. Knowing an
// id is revoked doesn't grant any privilege.

const express = require('express');
const db = require('../db');

const router = express.Router();

// GET /api/revocation/list
// Returns: { updated: ISO, count: N, revoked: ["<uuid>", ...] }
router.get('/list', (req, res) => {
  const rows = db.prepare(
    'SELECT id, revoked_at, revoke_reason FROM issued_licenses WHERE revoked_at IS NOT NULL ORDER BY revoked_at DESC'
  ).all();
  res.set('Cache-Control', 'public, max-age=300');  // 5 min CDN-friendly
  res.json({
    updated: new Date().toISOString(),
    count: rows.length,
    revoked: rows.map(r => r.id),
    // detailed list (id + when + reason) — clients can show this to user
    details: rows.map(r => ({ id: r.id, revokedAt: r.revoked_at, reason: r.revoke_reason || null })),
  });
});

// GET /api/revocation/check?id=<uuid>
// Returns: { id, revoked: bool, revokedAt?, reason? }
router.get('/check', (req, res) => {
  const id = String(req.query.id || '').trim();
  if (!id) return res.status(400).json({ error: 'id required' });
  const row = db.prepare('SELECT revoked_at, revoke_reason FROM issued_licenses WHERE id = ?').get(id);
  if (!row) return res.json({ id, revoked: false, known: false });
  res.json({
    id,
    known: true,
    revoked: !!row.revoked_at,
    revokedAt: row.revoked_at || null,
    reason: row.revoke_reason || null,
  });
});

module.exports = router;
