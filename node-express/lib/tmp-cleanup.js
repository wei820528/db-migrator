// Periodically clean tmp/ — both job dirs (tmp/<uuid>/) and tmp/uploads/.
// Anything older than CLEANUP_AGE_HOURS (default 24) gets removed.

const fs = require('fs');
const path = require('path');

const TMP_DIR = path.join(__dirname, '..', 'tmp');
const AGE_HOURS = Number(process.env.TMP_CLEANUP_AGE_HOURS || 24);
const INTERVAL_HOURS = Number(process.env.TMP_CLEANUP_INTERVAL_HOURS || 6);

function cleanupOnce() {
  if (!fs.existsSync(TMP_DIR)) return { removed: 0, kept: 0 };
  const cutoff = Date.now() - AGE_HOURS * 60 * 60 * 1000;
  let removed = 0, kept = 0;

  // Top-level entries (job dirs OR the uploads dir)
  for (const entry of fs.readdirSync(TMP_DIR, { withFileTypes: true })) {
    const full = path.join(TMP_DIR, entry.name);
    try {
      const stat = fs.statSync(full);
      if (entry.isDirectory()) {
        if (entry.name === 'uploads') {
          // Clean only old files inside uploads/, not the dir itself
          for (const f of fs.readdirSync(full)) {
            const fp = path.join(full, f);
            try {
              const fst = fs.statSync(fp);
              if (fst.mtimeMs < cutoff) { fs.rmSync(fp, { recursive: true, force: true }); removed++; }
              else kept++;
            } catch { /* ignore */ }
          }
        } else if (stat.mtimeMs < cutoff) {
          fs.rmSync(full, { recursive: true, force: true });
          removed++;
        } else kept++;
      } else if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(full); removed++;
      } else kept++;
    } catch { /* ignore */ }
  }
  return { removed, kept };
}

function start() {
  console.log(`[tmp-cleanup] enabled (age=${AGE_HOURS}h, interval=${INTERVAL_HOURS}h)`);
  const run = () => {
    try {
      const r = cleanupOnce();
      if (r.removed > 0) console.log(`[tmp-cleanup] removed ${r.removed} (kept ${r.kept})`);
    } catch (e) {
      console.error('[tmp-cleanup] failed:', e.message);
    }
  };
  // Initial cleanup on startup + interval
  setTimeout(run, 30 * 1000);  // wait 30s after startup
  const t = setInterval(run, INTERVAL_HOURS * 60 * 60 * 1000);
  if (t.unref) t.unref();
}

module.exports = { start, cleanupOnce };
