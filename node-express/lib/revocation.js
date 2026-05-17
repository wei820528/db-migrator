// Revocation check for offline-mode licenses.
//
// On each license status query, asynchronously fetch the revocation list
// (at most once every 24h) and cache it to .revocation-cache.json next to
// the license file. The status check itself is synchronous — it looks at
// whatever's in cache. The phone-home is fire-and-forget; first one might
// not catch the revocation, but a license server admin who just revoked is
// happy waiting ≤ 24h for it to take effect.
//
// Grace period: if we haven't been able to fetch in GRACE_DAYS, we still
// allow startup but mark `status: 'revocation-stale'` so the UI can warn.
// That way a customer with no internet keeps working (until they hit the
// hard grace cap).

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const DEFAULT_CACHE_PATH = path.join(__dirname, '..', '.revocation-cache.json');

const FETCH_INTERVAL_MS = 24 * 60 * 60 * 1000;   // refetch at most every 24h
const GRACE_DAYS = 30;                            // hard cap: stale this long = treat as revoked
const FETCH_TIMEOUT_MS = 5000;

let inflight = null;
let cachePath = DEFAULT_CACHE_PATH;

function setCachePath(p) { cachePath = p; }
function getCachePath() { return cachePath; }

function readCache() {
  try {
    const j = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (!j || !Array.isArray(j.revoked)) return null;
    return j;
  } catch { return null; }
}

function writeCache(data) {
  try { fs.writeFileSync(cachePath, JSON.stringify(data, null, 2)); }
  catch { /* non-fatal */ }
}

// Decide what the cache says about a given license id, including grace period.
//
// Returns one of:
//   { state: 'revoked', revokedAt, reason }
//   { state: 'clear', fetchedAt }
//   { state: 'stale', fetchedAt, daysStale }   // older than GRACE_DAYS — treat as suspect
//   { state: 'never', }                         // never successfully fetched
function checkCache(licenseId, now = Date.now()) {
  const cache = readCache();
  if (!cache) return { state: 'never' };
  if (cache.revoked.includes(licenseId)) {
    const detail = (cache.details || []).find((d) => d.id === licenseId);
    return {
      state: 'revoked',
      revokedAt: detail?.revokedAt || cache.fetchedAt,
      reason: detail?.reason || null,
    };
  }
  const fetchedAt = cache.fetchedAt ? new Date(cache.fetchedAt).getTime() : 0;
  if (!fetchedAt) return { state: 'never' };
  const daysStale = (now - fetchedAt) / (1000 * 60 * 60 * 24);
  if (daysStale > GRACE_DAYS) return { state: 'stale', fetchedAt: cache.fetchedAt, daysStale };
  return { state: 'clear', fetchedAt: cache.fetchedAt };
}

// Fetch the revocation list. Returns a promise; multiple callers share one inflight.
function fetchList(url) {
  if (inflight) return inflight;
  inflight = new Promise((resolve) => {
    let parsed;
    try { parsed = new URL(url); } catch { resolve({ ok: false, error: 'bad url' }); inflight = null; return; }
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(parsed, { timeout: FETCH_TIMEOUT_MS }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve({ ok: false, error: `HTTP ${res.statusCode}` });
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 1024 * 1024) req.destroy(); });
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          if (!Array.isArray(j.revoked)) { resolve({ ok: false, error: 'bad payload' }); return; }
          const cache = {
            fetchedAt: new Date().toISOString(),
            source: url,
            revoked: j.revoked,
            details: Array.isArray(j.details) ? j.details : [],
          };
          writeCache(cache);
          resolve({ ok: true, cache });
        } catch (e) { resolve({ ok: false, error: e.message }); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
  }).finally(() => { inflight = null; });
  return inflight;
}

// Should we re-fetch right now?
function shouldRefetch(now = Date.now()) {
  const cache = readCache();
  if (!cache || !cache.fetchedAt) return true;
  return (now - new Date(cache.fetchedAt).getTime()) > FETCH_INTERVAL_MS;
}

// Fire-and-forget refresh. Caller doesn't await — UI shows whatever's in cache now.
function maybeRefresh(url) {
  if (!url) return;
  if (!shouldRefetch()) return;
  fetchList(url).catch(() => {});
}

// Force refresh and wait — used by tests and by user-clicked "check now".
async function refreshNow(url) {
  if (!url) return { ok: false, error: 'no url' };
  return fetchList(url);
}

module.exports = {
  checkCache,
  maybeRefresh,
  refreshNow,
  setCachePath,
  getCachePath,
  // exposed for tests
  _internal: { readCache, writeCache, shouldRefetch, FETCH_INTERVAL_MS, GRACE_DAYS },
};
