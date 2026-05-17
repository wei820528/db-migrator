// Build a `CREATE TABLE` statement (and accompanying `CREATE INDEX`es) for a
// target dialect, given an IR table object.
//
// Uses Phase 1 `emit` for column types. Adds PK / NOT NULL / DEFAULT /
// AUTO_INCREMENT plumbing. Foreign keys are NOT emitted yet — would need to
// be deferred until every table exists; that's Phase 5 polish.

const { emit } = require('./emit');

// ============ Identifier quoting per dialect ============

// Map the dialect aliases the rest of the codebase uses ('pg', 'supabase')
// onto the canonical name so downstream comparisons stay simple.
function normalizeTarget(t) {
  if (t === 'pg' || t === 'supabase') return 'postgres';
  return t;
}

function ident(name, target) {
  const t = normalizeTarget(target);
  if (t === 'mysql') return '`' + String(name).replace(/`/g, '``') + '`';
  // postgres, sqlite → double-quoted
  return '"' + String(name).replace(/"/g, '""') + '"';
}

// ============ Default value emission ============

// Heuristic: pass through if it looks like a function call (e.g. CURRENT_TIMESTAMP,
// nextval(...), CURRENT_DATE) or is already quoted; otherwise treat as a string
// literal and quote it.
function emitDefault(def, target) {
  if (def === null || def === undefined) return null;
  const s = String(def).trim();
  if (s === '') return null;
  // Already a function call / keyword (case-insensitive)
  if (/^(CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME|NOW\(\)|TRUE|FALSE|NULL)\b/i.test(s)) return s;
  // SERIAL/BIGSERIAL: pg has nextval('users_id_seq'::regclass) — drop, handled by SERIAL type
  if (/^nextval\(/i.test(s)) return null;
  // Looks numeric
  if (/^-?\d+(\.\d+)?$/.test(s)) return s;
  // Already quoted (mysql / pg literal)
  if (/^'.*'$/.test(s) || /^B?'.*'$/.test(s)) return s;
  // Plain string → quote
  return "'" + s.replace(/'/g, "''") + "'";
}

// ============ Column DDL fragment ============

function buildColumnDdl(col, target) {
  const t = normalizeTarget(target);
  const warnings = [];
  let typeSql;

  // Auto-increment requires a hand-crafted type per dialect — bypass emit() in that case.
  if (col.autoIncrement && col.primaryKey) {
    if (t === 'mysql') {
      typeSql = col.type.size === 64 ? 'BIGINT' : 'INT';
    } else if (t === 'sqlite') {
      typeSql = 'INTEGER';   // SQLite: only INTEGER PRIMARY KEY can use AUTOINCREMENT
    } else {
      // postgres → SERIAL family
      typeSql = col.type.size === 64 ? 'BIGSERIAL' : (col.type.size === 16 ? 'SMALLSERIAL' : 'SERIAL');
    }
  } else {
    const r = emit(col.type, t);
    typeSql = r.sql;
    warnings.push(...r.warnings);
  }

  let ddl = `${ident(col.name, t)} ${typeSql}`;
  // NOT NULL is redundant when the column is part of a PK (PK implies NOT NULL in
  // standard SQL; SQLite tolerates NULL in PK but most dumps don't bother), and
  // PG SERIAL is already implicitly NOT NULL.
  const pkImpliesNotNull = !!col.primaryKey;
  const pgSerial = t === 'postgres' && col.autoIncrement && col.primaryKey;
  if (!pkImpliesNotNull && !pgSerial) {
    ddl += col.nullable === false ? ' NOT NULL' : '';
  }
  const def = emitDefault(col.default, t);
  if (def != null) ddl += ` DEFAULT ${def}`;

  // MySQL puts AUTO_INCREMENT on the column itself
  if (col.autoIncrement && col.primaryKey && t === 'mysql') ddl += ' AUTO_INCREMENT';
  // SQLite: same — AUTOINCREMENT after PRIMARY KEY (handled at PK clause below for single-col PK)

  return { ddl, warnings };
}

// ============ CREATE TABLE ============

function buildCreateTable(irTable, target) {
  const t = normalizeTarget(target);
  const warnings = [];
  const lines = [];

  const pkCols = (irTable.columns || []).filter((c) => c.primaryKey).map((c) => c.name);
  const singlePk = pkCols.length === 1;

  for (const col of irTable.columns || []) {
    const r = buildColumnDdl(col, t);
    let line = r.ddl;
    warnings.push(...r.warnings);

    // SQLite single-column INTEGER PRIMARY KEY AUTOINCREMENT — inline on the column
    if (t === 'sqlite' && singlePk && col.primaryKey) {
      line += col.autoIncrement ? ' PRIMARY KEY AUTOINCREMENT' : ' PRIMARY KEY';
    }
    lines.push('  ' + line);
  }

  // Table-level PK clause for everything that didn't get inlined
  const inlinedPk = t === 'sqlite' && singlePk;
  if (pkCols.length > 0 && !inlinedPk) {
    lines.push(`  PRIMARY KEY (${pkCols.map((c) => ident(c, t)).join(', ')})`);
  }

  const sql = `CREATE TABLE ${ident(irTable.name, t)} (\n${lines.join(',\n')}\n)`;
  return { sql, warnings };
}

// ============ CREATE INDEX ============
// Secondary indexes only — PK already in the CREATE TABLE.

function buildCreateIndexes(irTable, target) {
  const t = normalizeTarget(target);
  const out = [];
  for (const idx of irTable.indexes || []) {
    // PG's pg_indexes returns full DDL — pass through if available
    if (t === 'postgres' && idx.def) { out.push(idx.def + ';'); continue; }
    if (!idx.name || !idx.columns || idx.columns.length === 0) continue;
    const unique = idx.unique ? 'UNIQUE ' : '';
    const cols = idx.columns.map((c) => ident(c, t)).join(', ');
    out.push(`CREATE ${unique}INDEX ${ident(idx.name, t)} ON ${ident(irTable.name, t)} (${cols});`);
  }
  return out;
}

module.exports = { buildCreateTable, buildCreateIndexes, buildColumnDdl, emitDefault, ident };
