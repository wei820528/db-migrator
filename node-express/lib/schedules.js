// Scheduled backups.
//
// Schedule expression supports two simple forms (no full cron parser needed):
//   "every N minutes"  / "every N hours"  / "every N days"
//   "daily at HH:MM"   (24h, server local time)
//
// On each tick (every minute), if next_run_at <= now, dispatch the backup.

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { randomUUID } = require('crypto');
const { encrypt, decrypt } = require('./encrypt');

const DB_PATH = process.env.SCHEDULES_DB || path.join(__dirname, '..', 'schedules.db');
const TMP_DIR = path.join(__dirname, '..', 'tmp');
const OUTPUT_DIR = process.env.SCHEDULE_OUTPUT_DIR || path.join(__dirname, '..', 'scheduled-backups');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,                  -- mysql|postgres|mssql|sqlite|supabase
  conn_json TEXT NOT NULL,             -- JSON, password encrypted as conn_pwd_enc
  conn_pwd_enc TEXT,                   -- encrypted password (separate from JSON for safety)
  databases_json TEXT NOT NULL,        -- JSON array of DB names
  expression TEXT NOT NULL,            -- "every N hours" / "daily at HH:MM" / etc.
  active INTEGER NOT NULL DEFAULT 1,
  next_run_at INTEGER,                 -- unix ms; null = compute on next tick
  last_run_at INTEGER,
  last_status TEXT,                    -- 'ok' | 'error'
  last_error TEXT,
  last_job_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_schedules_next ON schedules(active, next_run_at);
`);

// ============================================================
// Schedule expression parsing
// ============================================================
function parseExpression(expr) {
  const s = String(expr || '').trim().toLowerCase();
  let m;
  if ((m = s.match(/^every\s+(\d+)\s*(minute|minutes|hour|hours|day|days)$/))) {
    const n = Number(m[1]);
    const unit = m[2];
    const ms = unit.startsWith('minute') ? n * 60 * 1000
             : unit.startsWith('hour')   ? n * 60 * 60 * 1000
             : n * 24 * 60 * 60 * 1000;
    return { type: 'every', ms };
  }
  if ((m = s.match(/^daily\s+at\s+(\d{1,2}):(\d{2})$/))) {
    return { type: 'daily', hh: Number(m[1]), mm: Number(m[2]) };
  }
  throw new Error(`Unsupported schedule expression: ${expr}. Use "every N minutes/hours/days" or "daily at HH:MM"`);
}

function nextRunAfter(now, expr) {
  const p = parseExpression(expr);
  if (p.type === 'every') return now + p.ms;
  if (p.type === 'daily') {
    const d = new Date(now);
    d.setSeconds(0, 0);
    d.setHours(p.hh, p.mm);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  return now + 60 * 60 * 1000;
}

// ============================================================
// CRUD
// ============================================================
function rowToSchedule(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    connection: { ...JSON.parse(row.conn_json), hasPassword: !!row.conn_pwd_enc },
    databases: JSON.parse(row.databases_json),
    expression: row.expression,
    active: !!row.active,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status,
    lastError: row.last_error,
    lastJobId: row.last_job_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function list() {
  return db.prepare('SELECT * FROM schedules ORDER BY created_at DESC').all().map(rowToSchedule);
}

function get(id) {
  return rowToSchedule(db.prepare('SELECT * FROM schedules WHERE id = ?').get(id));
}

function create({ name, type, connection, databases, expression, active = true }) {
  if (!name || !type || !connection || !databases || !expression) {
    throw new Error('name, type, connection, databases, expression required');
  }
  parseExpression(expression);  // validates
  const id = randomUUID();
  const now = Date.now();
  const { password, ...connRest } = connection;
  const enc = password ? encrypt(password) : null;
  db.prepare(`INSERT INTO schedules
    (id, name, type, conn_json, conn_pwd_enc, databases_json, expression, active, next_run_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, name, type,
      JSON.stringify(connRest), enc,
      JSON.stringify(databases), expression, active ? 1 : 0,
      nextRunAfter(now, expression), now, now
    );
  return get(id);
}

function update(id, patch) {
  const cur = db.prepare('SELECT * FROM schedules WHERE id = ?').get(id);
  if (!cur) throw new Error('not found');

  const fields = [];
  const values = [];
  if (patch.name !== undefined)       { fields.push('name = ?');       values.push(patch.name); }
  if (patch.type !== undefined)       { fields.push('type = ?');       values.push(patch.type); }
  if (patch.databases !== undefined)  { fields.push('databases_json = ?'); values.push(JSON.stringify(patch.databases)); }
  if (patch.expression !== undefined) {
    parseExpression(patch.expression);  // validates
    fields.push('expression = ?'); values.push(patch.expression);
    fields.push('next_run_at = ?'); values.push(nextRunAfter(Date.now(), patch.expression));
  }
  if (patch.active !== undefined)     { fields.push('active = ?');     values.push(patch.active ? 1 : 0); }
  if (patch.connection !== undefined) {
    const { password, ...rest } = patch.connection;
    fields.push('conn_json = ?'); values.push(JSON.stringify(rest));
    if (password !== undefined) {  // only update password if explicitly given
      fields.push('conn_pwd_enc = ?'); values.push(password ? encrypt(password) : null);
    }
  }
  if (fields.length === 0) return get(id);
  fields.push('updated_at = ?'); values.push(Date.now());
  values.push(id);
  db.prepare(`UPDATE schedules SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return get(id);
}

function remove(id) {
  db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
}

function loadConnectionWithPassword(id) {
  const row = db.prepare('SELECT conn_json, conn_pwd_enc FROM schedules WHERE id = ?').get(id);
  if (!row) return null;
  const conn = JSON.parse(row.conn_json);
  if (row.conn_pwd_enc) {
    try { conn.password = decrypt(row.conn_pwd_enc); }
    catch (e) { throw new Error('Failed to decrypt password — wrong SCHEDULE_KEY?'); }
  }
  return conn;
}

function markRunResult(id, ok, error, jobId) {
  const cur = db.prepare('SELECT expression FROM schedules WHERE id = ?').get(id);
  if (!cur) return;
  const now = Date.now();
  db.prepare(`UPDATE schedules SET
    last_run_at = ?, last_status = ?, last_error = ?, last_job_id = ?,
    next_run_at = ?, updated_at = ? WHERE id = ?`)
    .run(now, ok ? 'ok' : 'error', error || null, jobId || null,
         nextRunAfter(now, cur.expression), now, id);
}

// ============================================================
// Scheduler loop — checks every minute, fires due schedules
// ============================================================
let dispatcher = null;
function setDispatcher(fn) { dispatcher = fn; }   // async (schedule) => jobId

async function tick() {
  if (!dispatcher) return;
  const now = Date.now();
  const due = db.prepare(`
    SELECT id, name FROM schedules
    WHERE active = 1 AND (next_run_at IS NULL OR next_run_at <= ?)
  `).all(now);
  for (const { id, name } of due) {
    try {
      console.log(`[schedule] firing "${name}" (${id.slice(0,8)})`);
      const jobId = await dispatcher(get(id));
      markRunResult(id, true, null, jobId);
    } catch (e) {
      console.error(`[schedule] "${name}" failed:`, e.message);
      markRunResult(id, false, e.message, null);
    }
  }
}

function startLoop() {
  console.log(`[schedule] loop started; output dir: ${OUTPUT_DIR}`);
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  setTimeout(tick, 5 * 1000);   // first tick 5s after start (avoid blocking startup)
  const t = setInterval(tick, 60 * 1000);
  if (t.unref) t.unref();
}

module.exports = {
  list, get, create, update, remove,
  loadConnectionWithPassword, markRunResult, setDispatcher, startLoop,
  parseExpression, nextRunAfter,
  OUTPUT_DIR,
};
