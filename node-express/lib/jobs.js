// Job store — SQLite-backed. Same API as before (drop-in replacement for the in-memory Map).
//
// Persistence means:
//   - Server restart no longer loses in-progress job state
//   - On startup, any 'pending' / 'running' jobs are marked 'error' (server-restarted)
//   - Job records survive for 7 days, then auto-pruned

const path = require('path');
const Database = require('better-sqlite3');
const { randomUUID } = require('crypto');

const DB_PATH = process.env.JOBS_DB || path.join(__dirname, '..', 'jobs.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,             -- pending | running | done | error
  progress TEXT NOT NULL DEFAULT '[]',
  result TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
`);

// Recovery: jobs that were running when the process died can never complete
const restartedRows = db.prepare(
  `SELECT id, kind FROM jobs WHERE status IN ('pending', 'running')`
).all();
if (restartedRows.length > 0) {
  db.prepare(
    `UPDATE jobs SET status='error', error='Server restarted while job was running', updated_at=?
     WHERE status IN ('pending', 'running')`
  ).run(Date.now());
  console.log(`[jobs] recovered ${restartedRows.length} stale job(s) → marked error`);
}

// Periodic cleanup of old records (>7 days)
setInterval(() => {
  try {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const n = db.prepare('DELETE FROM jobs WHERE created_at < ?').run(cutoff).changes;
    if (n > 0) console.log(`[jobs] pruned ${n} old job record(s)`);
  } catch (e) { console.error('[jobs] prune failed:', e.message); }
}, 60 * 60 * 1000).unref();  // hourly

function rowToJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    progress: JSON.parse(row.progress || '[]'),
    result: row.result ? JSON.parse(row.result) : null,
    error: row.error,
    createdAt: row.created_at,
  };
}

function create(kind) {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(`INSERT INTO jobs (id, kind, status, progress, created_at, updated_at)
              VALUES (?, ?, 'pending', '[]', ?, ?)`).run(id, kind, now, now);
  return { id, kind, status: 'pending', progress: [], result: null, error: null, createdAt: now };
}

function get(id) {
  return rowToJob(db.prepare('SELECT * FROM jobs WHERE id = ?').get(id));
}

function append(id, line) {
  if (!line) return;
  const row = db.prepare('SELECT progress FROM jobs WHERE id = ?').get(id);
  if (!row) return;
  const arr = JSON.parse(row.progress || '[]');
  arr.push({ t: Date.now(), line });
  if (arr.length > 200) arr.shift();   // keep most recent 200
  db.prepare('UPDATE jobs SET progress = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(arr), Date.now(), id);
}

function setStatus(id, status, patch = {}) {
  const fields = ['status = ?'];
  const values = [status];
  if (patch.result !== undefined) {
    fields.push('result = ?');
    values.push(JSON.stringify(patch.result));
  }
  if (patch.error !== undefined) {
    fields.push('error = ?');
    values.push(patch.error);
  }
  fields.push('updated_at = ?');
  values.push(Date.now());
  values.push(id);
  db.prepare(`UPDATE jobs SET ${fields.join(', ')} WHERE id = ?`).run(...values);

  // Webhook emit — terminal transitions only。Lazy-require 避免 cycle。
  if (status === 'done' || status === 'error') {
    try {
      const wh = require('./webhooks');
      const event = status === 'done' ? 'job.done' : 'job.failed';
      const row = db.prepare('SELECT kind FROM jobs WHERE id = ?').get(id);
      wh.emit(event, {
        jobId: id,
        kind: row?.kind,
        status,
        result: patch.result ?? null,
        error: patch.error ?? null,
      });
    } catch (e) { /* webhooks module loading failed — non-fatal */ }
  }
}

module.exports = { create, get, append, setStatus };
