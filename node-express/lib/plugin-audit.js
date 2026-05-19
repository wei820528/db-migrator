// Theme D Phase 4 — Persistent plugin audit log。
//
// Phase 3 已經會在 require gate denial 時 console.warn，但沒留 trail。Phase 4
// 改成 SQLite-backed，admin / security audit 可以 query。Worker constructor
// wrap、route mount、handler error 等 sensitive event 也都進這個 log。
//
// Schema 故意刻意 simple — 之後加新 event type 不用 migration（detail 是 JSON）。
//
// 為什麼自己一個 DB 不塞 jobs.db：(a) audit 是 append-only，jobs 會被刪改；
// (b) 可以另開 disk / 不同保留策略 / 給 read-only DB user 看；(c) Plugin 失敗
// 跟 jobs 走的層級不同。

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.PLUGIN_AUDIT_DB || path.join(__dirname, '..', 'plugin-audit.db');

let _db = null;
function db() {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS plugin_audit (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      ts           INTEGER NOT NULL,                -- unix ms
      plugin_name  TEXT    NOT NULL,
      event_type   TEXT    NOT NULL,                -- require-denied / worker-spawn-attempt / route-mount / handler-error
      severity     TEXT    NOT NULL DEFAULT 'info', -- info / warn / error
      detail_json  TEXT    NOT NULL                 -- JSON.stringify(detail)
    );
    CREATE INDEX IF NOT EXISTS idx_audit_ts ON plugin_audit(ts);
    CREATE INDEX IF NOT EXISTS idx_audit_plugin ON plugin_audit(plugin_name);
    CREATE INDEX IF NOT EXISTS idx_audit_event ON plugin_audit(event_type);
  `);
  return _db;
}

// Public: 寫一筆 audit。同步 — SQLite WAL 配 prepared stmt 已經夠快，沒必要 async。
function append({ pluginName, eventType, severity = 'info', detail = {} }) {
  if (!pluginName || !eventType) throw new Error('append: pluginName + eventType required');
  let detailJson;
  try { detailJson = JSON.stringify(detail); }
  catch { detailJson = JSON.stringify({ _serialized_error: true }); }
  const r = db().prepare(`
    INSERT INTO plugin_audit (ts, plugin_name, event_type, severity, detail_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(Date.now(), String(pluginName), String(eventType), String(severity), detailJson);
  return r.lastInsertRowid;
}

// Query：filter by plugin / event / since (ms epoch) / minSeverity；DESC by ts。limit 預設 100。
function list({ plugin, eventType, since, minSeverity, limit = 100 } = {}) {
  const where = [];
  const params = [];
  if (plugin)    { where.push('plugin_name = ?'); params.push(plugin); }
  if (eventType) { where.push('event_type = ?');  params.push(eventType); }
  if (since)     { where.push('ts >= ?');         params.push(Number(since)); }
  if (minSeverity) {
    const order = { info: 1, warn: 2, error: 3 };
    const thresh = order[minSeverity] || 1;
    where.push("(CASE severity WHEN 'error' THEN 3 WHEN 'warn' THEN 2 ELSE 1 END) >= ?");
    params.push(thresh);
  }
  const sql = `SELECT id, ts, plugin_name AS pluginName, event_type AS eventType,
                      severity, detail_json
               FROM plugin_audit ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY ts DESC, id DESC
               LIMIT ?`;
  params.push(Math.max(1, Math.min(1000, Number(limit) | 0)));
  return db().prepare(sql).all(...params).map((r) => ({
    ...r,
    detail: safeParse(r.detail_json),
    detail_json: undefined,
  }));
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return { _parse_error: true, raw: s }; }
}

// 清舊 audit 紀錄 — 預設留 30 天
function prune({ olderThanDays = 30 } = {}) {
  const cutoff = Date.now() - olderThanDays * 86400 * 1000;
  const r = db().prepare('DELETE FROM plugin_audit WHERE ts < ?').run(cutoff);
  return { deleted: r.changes };
}

function count({ plugin, eventType, since } = {}) {
  const where = [];
  const params = [];
  if (plugin)    { where.push('plugin_name = ?'); params.push(plugin); }
  if (eventType) { where.push('event_type = ?');  params.push(eventType); }
  if (since)     { where.push('ts >= ?');         params.push(Number(since)); }
  return db().prepare(`SELECT COUNT(*) AS n FROM plugin_audit ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`)
    .get(...params).n;
}

module.exports = { append, list, count, prune, _internal: { db } };
