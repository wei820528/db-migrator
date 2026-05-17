// Shared helpers for SQL adapters.

function escapeIdent(name, q = '`') {
  return q + String(name).replace(new RegExp(q, 'g'), q + q) + q;
}

function escapeStringSql(s) {
  // ANSI-style with escaped backslashes (works for MySQL/PG with standard_conforming_strings on, MSSQL needs '' only).
  return "'" + String(s).replace(/'/g, "''") + "'";
}

function formatValueGeneric(v, opts = {}) {
  const stringQuote = opts.stringQuote || escapeStringSql;
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return opts.boolAs01 ? (v ? '1' : '0') : (v ? 'TRUE' : 'FALSE');
  if (Buffer.isBuffer(v)) return (opts.binaryHex || ((b) => "X'" + b.toString('hex') + "'"))(v);
  if (v instanceof Date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `'${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())} ` +
      `${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}:${pad(v.getUTCSeconds())}'`;
  }
  if (typeof v === 'object') return stringQuote(JSON.stringify(v));
  return stringQuote(String(v));
}

// Naive splitter: strips -- and /* */ comments, splits on ';' outside string/identifier literals.
function splitSqlStatements(sql, identQuote = '"') {
  const out = [];
  let buf = '';
  let inSingle = false, inDouble = false, inIdent = false;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (!inSingle && !inDouble && !inIdent) {
      if (ch === '-' && next === '-') { while (i < sql.length && sql[i] !== '\n') i++; continue; }
      if (ch === '/' && next === '*') { i += 2; while (i + 1 < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++; i += 2; continue; }
    }
    if ((inSingle || inDouble) && ch === '\\') {
      buf += ch + (sql[i + 1] || '');
      i += 2; continue;
    }
    if (!inDouble && !inIdent && ch === "'") inSingle = !inSingle;
    else if (!inSingle && !inIdent && ch === '"' && identQuote !== '"') inDouble = !inDouble;
    else if (!inSingle && !inDouble && ch === identQuote) inIdent = !inIdent;

    if (ch === ';' && !inSingle && !inDouble && !inIdent) {
      const s = buf.trim();
      if (s.length) out.push(s);
      buf = '';
    } else {
      buf += ch;
    }
    i++;
  }
  const last = buf.trim();
  if (last.length) out.push(last);
  return out;
}

// Parse table names from a generated dump (works for our own dump format).
function parseTableNamesFromDumpGeneric(text, identQuote = '`') {
  const tables = new Set();
  const escQ = identQuote.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`CREATE TABLE(?:\\s+IF NOT EXISTS)?\\s+${escQ}?([^${escQ}\\s(]+)${escQ}?`, 'gi');
  let m;
  while ((m = re.exec(text)) !== null) tables.add(m[1]);
  return [...tables];
}

// Extract the primary table this SQL statement refers to.
// Returns null for "header" statements (SET, BEGIN, COMMIT, PRAGMA, USE, comments)
// — those are always kept during filtering.
function extractTableName(stmt, identQuote = '`') {
  const head = stmt.trim().slice(0, 200);  // only inspect head for speed
  // Header / control statements: keep always
  if (/^(SET|BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION|USE|PRAGMA|GO|--|\/\*|SET\s+NAMES|SET\s+FOREIGN_KEY)/i.test(head))
    return null;
  // Identifier delimiter: brackets need open/close pair, others are same char both sides
  const isBracket = identQuote === '[';
  const escOpen = identQuote.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escClose = isBracket ? '\\]' : escOpen;
  // Inside brackets: anything except close bracket; for `/" : anything except itself
  const innerNeg = isBracket ? '\\]' : escOpen;
  // Match CREATE TABLE / DROP TABLE / INSERT INTO / ALTER TABLE / TRUNCATE / REPLACE INTO
  const re = new RegExp(
    `^(?:CREATE\\s+TABLE(?:\\s+IF\\s+NOT\\s+EXISTS)?|DROP\\s+TABLE(?:\\s+IF\\s+EXISTS)?|INSERT\\s+INTO|REPLACE\\s+INTO|ALTER\\s+TABLE|TRUNCATE(?:\\s+TABLE)?)\\s+(?:${escOpen}([^${innerNeg}]+)${escClose}|([\\w.]+))`,
    'i'
  );
  const m = head.match(re);
  if (!m) return null;
  const name = m[1] || m[2];
  return name?.includes('.') ? name.split('.').pop() : name;
}

// Filter a SQL dump to only include statements that touch tables in `allowedSet`.
// Header statements (SET / BEGIN / COMMIT / etc.) are always kept.
function filterSqlByTables(text, allowedTables, identQuote = '`') {
  const allowed = new Set(allowedTables.map((t) => t.includes('.') ? t.split('.').pop() : t));
  const stmts = splitSqlStatements(text, identQuote);
  const out = [];
  let skipped = 0;
  for (const s of stmts) {
    const t = extractTableName(s, identQuote);
    if (!t || allowed.has(t)) out.push(s);
    else skipped++;
  }
  return { sql: out.join(';\n\n') + ';\n', kept: out.length, skipped };
}

// Routine block markers — used by adapters that dump procedures / functions
// whose bodies contain semicolons (MySQL especially). Wrap each routine like:
//   -- ROUTINE_BEGIN <name>
//   CREATE PROCEDURE ... BEGIN ...; ...; END
//   -- ROUTINE_END
// Then restore can pull the body out as a single statement instead of trying
// to split on internal semicolons.
const ROUTINE_BEGIN = '-- ROUTINE_BEGIN';
const ROUTINE_END   = '-- ROUTINE_END';

// Walks the dump and returns an array of { kind: 'sql'|'routine', body }.
// 'routine' bodies are the verbatim content between the markers (one statement
// each). 'sql' bodies are raw text to be passed to the normal restore path
// (which may further split on ';').
function extractRoutineBlocks(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const begin = text.indexOf(ROUTINE_BEGIN, i);
    if (begin === -1) {
      const rest = text.slice(i).trim();
      if (rest) out.push({ kind: 'sql', body: rest });
      break;
    }
    // emit any pending sql before this routine
    if (begin > i) {
      const rest = text.slice(i, begin).trim();
      if (rest) out.push({ kind: 'sql', body: rest });
    }
    // skip past the rest of the BEGIN marker line
    const newlineAfterBegin = text.indexOf('\n', begin);
    const bodyStart = newlineAfterBegin === -1 ? begin + ROUTINE_BEGIN.length : newlineAfterBegin + 1;
    const end = text.indexOf(ROUTINE_END, bodyStart);
    if (end === -1) {
      // No END marker — treat the rest as a single routine (best-effort)
      out.push({ kind: 'routine', body: text.slice(bodyStart).trim() });
      break;
    }
    out.push({ kind: 'routine', body: text.slice(bodyStart, end).trim() });
    const nextLine = text.indexOf('\n', end);
    i = nextLine === -1 ? text.length : nextLine + 1;
  }
  return out;
}

module.exports = {
  escapeIdent,
  escapeStringSql,
  formatValueGeneric,
  splitSqlStatements,
  parseTableNamesFromDumpGeneric,
  extractTableName,
  filterSqlByTables,
  extractRoutineBlocks,
  ROUTINE_BEGIN,
  ROUTINE_END,
};
