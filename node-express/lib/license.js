// License: switches between offline (Ed25519 .key) and online (license server) modes.
//
//   LICENSE_MODE=offline (default)  → use signed license.key + .trial timestamp
//   LICENSE_MODE=online             → use license-online.js (login + heartbeat)
//   LICENSE_MODE=disabled           → no gate at all (dev only)

const offline = require('./license-offline');
const online = require('./license-online');

const MODE = (process.env.LICENSE_MODE || 'offline').toLowerCase();

if (MODE === 'online') {
  console.log(`[license] mode=online server=${process.env.LICENSE_SERVER_URL || 'http://localhost:4000'}`);
  online.startHeartbeatLoop();
} else if (MODE === 'disabled') {
  console.warn('[license] MODE=disabled — gate is OFF (do not use in production)');
} else {
  console.log('[license] mode=offline (signed key)');
}

function getStatus() {
  if (MODE === 'disabled') return { status: 'disabled', daysLeft: null, mode: 'disabled' };
  if (MODE === 'online') {
    const s = online.getState();
    return { ...s, mode: 'online' };
  }
  return { ...offline.getStatus(), mode: 'offline' };
}

// Express middleware: gates /api/* by license + feature checks.
// Always allows /api/license/*, /api/license-online/*, /api/modules so the UI can manage state.
function gate() {
  return (req, res, next) => {
    if (!req.path.startsWith('/api/')) return next();
    if (
      req.path.startsWith('/api/license') ||  // covers both /api/license and /api/license-online
      req.path === '/api/modules'
    ) return next();

    if (MODE === 'disabled') return next();

    if (MODE === 'online') {
      const s = online.getState();
      if (!s.token) return res.status(402).json({ error: 'Not logged in', license: s, mode: 'online' });
      if (s.kicked) return res.status(401).json({ error: 'Session kicked (used elsewhere)', license: s, mode: 'online' });
      if (s.status === 'expired') return res.status(402).json({ error: 'License/trial expired', license: s, mode: 'online' });
      if (s.status === 'offline') return res.status(503).json({ error: 'Cannot reach license server', license: s, mode: 'online' });

      // Feature gates — block specific routes for plans that don't include them
      if (req.path === '/api/export' && req.method === 'POST') {
        const dbs = req.body?.databases || [];
        const max = s.features?.multi_db_count_max;
        if (max != null && dbs.length > max) {
          return res.status(403).json({
            error: `您的方案最多可一次匯出 ${max} 個資料庫，目前選了 ${dbs.length}`,
            feature: 'multi_db_count_max',
            license: s,
          });
        }
        if (s.features?.bulk_export === false && dbs.length > 1) {
          return res.status(403).json({
            error: '試用版不支援多資料庫一次匯出，請升級方案',
            feature: 'bulk_export',
            license: s,
          });
        }
      }
      if (req.path.startsWith('/api/project') && req.method !== 'GET' && s.features?.project_backup === false) {
        return res.status(403).json({
          error: '試用版不支援專案備份功能，請升級方案',
          feature: 'project_backup',
          license: s,
        });
      }

      return next();
    }

    // Offline mode
    const s = offline.getStatus();
    if (s.status === 'revoked') {
      return res.status(403).json({ error: s.error || 'License revoked', license: s, mode: 'offline' });
    }
    if (s.status === 'expired') {
      return res.status(402).json({ error: 'License required', license: s, mode: 'offline', commercial: '/COMMERCIAL.md' });
    }
    return next();
  };
}

module.exports = { getStatus, gate, MODE };
