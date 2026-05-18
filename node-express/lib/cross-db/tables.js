// 把一個 IR table object 組成 target dialect 的 `CREATE TABLE`（含對應的
// `CREATE INDEX`）。
//
// 欄位型別走 Phase 1 的 `emit`。本檔額外處理 PK / NOT NULL / DEFAULT /
// AUTO_INCREMENT。Foreign key 暫不處理 — 要等所有 table 都建好再 ALTER，
// 留給 Phase 5 收尾。

const { emit } = require('./emit');

// ============ 各 dialect 的識別子 quote ============

// 把 codebase 其他地方用的 dialect 別名（'pg' / 'supabase'）轉成 canonical 名稱，
// 後續 if/switch 比對才不會漏。
function normalizeTarget(t) {
  if (t === 'pg' || t === 'supabase') return 'postgres';
  return t;
}

function ident(name, target) {
  const t = normalizeTarget(target);
  if (t === 'mysql') return '`' + String(name).replace(/`/g, '``') + '`';
  // postgres / sqlite → 雙引號
  return '"' + String(name).replace(/"/g, '""') + '"';
}

// ============ Default value emission ============

// 啟發式：看起來像 function call（CURRENT_TIMESTAMP / nextval / CURRENT_DATE）
// 或已經被 quote 的就直接 pass through；其他當字串字面值，幫忙 quote。
function emitDefault(def, target) {
  if (def === null || def === undefined) return null;
  const s = String(def).trim();
  if (s === '') return null;
  // 已經是 function call 或 keyword（case-insensitive）
  if (/^(CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME|NOW\(\)|TRUE|FALSE|NULL)\b/i.test(s)) return s;
  // SERIAL/BIGSERIAL：PG 會給 nextval('users_id_seq'::regclass) — 直接丟掉，SERIAL 型別自己會處理
  if (/^nextval\(/i.test(s)) return null;
  // 看起來是數字
  if (/^-?\d+(\.\d+)?$/.test(s)) return s;
  // 已經被 quote 過（mysql / pg literal）
  if (/^'.*'$/.test(s) || /^B?'.*'$/.test(s)) return s;
  // 純字串 → 幫忙 quote
  return "'" + s.replace(/'/g, "''") + "'";
}

// ============ Column DDL fragment ============

function buildColumnDdl(col, target) {
  const t = normalizeTarget(target);
  const warnings = [];
  let typeSql;

  // Auto-increment 在每個 dialect 都要自己手刻型別 — 這裡 bypass emit()
  if (col.autoIncrement && col.primaryKey) {
    if (t === 'mysql') {
      typeSql = col.type.size === 64 ? 'BIGINT' : 'INT';
    } else if (t === 'sqlite') {
      typeSql = 'INTEGER';   // SQLite：只有 INTEGER PRIMARY KEY 才能用 AUTOINCREMENT
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
  // PK column 不額外加 NOT NULL（標準 SQL PK 隱含 NOT NULL；SQLite 雖然容忍 NULL PK
  // 但多數 dump 也不會這樣寫）；PG SERIAL 本身也已經隱含 NOT NULL。
  const pkImpliesNotNull = !!col.primaryKey;
  const pgSerial = t === 'postgres' && col.autoIncrement && col.primaryKey;
  if (!pkImpliesNotNull && !pgSerial) {
    ddl += col.nullable === false ? ' NOT NULL' : '';
  }
  const def = emitDefault(col.default, t);
  if (def != null) ddl += ` DEFAULT ${def}`;

  // MySQL 把 AUTO_INCREMENT 放在欄位上
  if (col.autoIncrement && col.primaryKey && t === 'mysql') ddl += ' AUTO_INCREMENT';
  // SQLite 也是 — AUTOINCREMENT 跟在 PRIMARY KEY 後面（single-PK 時在下面 PK 區段處理）

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

    // SQLite 單欄 INTEGER PRIMARY KEY AUTOINCREMENT — 直接 inline 在欄位定義上
    if (t === 'sqlite' && singlePk && col.primaryKey) {
      line += col.autoIncrement ? ' PRIMARY KEY AUTOINCREMENT' : ' PRIMARY KEY';
    }
    lines.push('  ' + line);
  }

  // 沒被 inline 的就走 table-level PRIMARY KEY clause
  const inlinedPk = t === 'sqlite' && singlePk;
  if (pkCols.length > 0 && !inlinedPk) {
    lines.push(`  PRIMARY KEY (${pkCols.map((c) => ident(c, t)).join(', ')})`);
  }

  const sql = `CREATE TABLE ${ident(irTable.name, t)} (\n${lines.join(',\n')}\n)`;
  return { sql, warnings };
}

// ============ CREATE INDEX ============
// 只處理 secondary indexes — PK 已經在 CREATE TABLE 裡。

function buildCreateIndexes(irTable, target) {
  const t = normalizeTarget(target);
  const out = [];
  for (const idx of irTable.indexes || []) {
    // PG 的 pg_indexes 已經給整段 DDL — 有就直接 pass through
    if (t === 'postgres' && idx.def) { out.push(idx.def + ';'); continue; }
    if (!idx.name || !idx.columns || idx.columns.length === 0) continue;
    const unique = idx.unique ? 'UNIQUE ' : '';
    const cols = idx.columns.map((c) => ident(c, t)).join(', ');
    out.push(`CREATE ${unique}INDEX ${ident(idx.name, t)} ON ${ident(irTable.name, t)} (${cols});`);
  }
  return out;
}

module.exports = { buildCreateTable, buildCreateIndexes, buildColumnDdl, emitDefault, ident };
