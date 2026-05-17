// Parse a source-dialect column type string into the neutral IR.
//
//   normalize('mysql', 'INT UNSIGNED')
//     → { kind: 'int', size: 32, unsigned: true }
//   normalize('postgres', 'NUMERIC(10, 2)')
//     → { kind: 'decimal', precision: 10, scale: 2 }
//   normalize('sqlite', 'TEXT')
//     → { kind: 'text' }
//
// Anything unrecognised falls through to `{ kind: 'unknown', raw }` so
// emit.js can pass it through with a warning instead of silently dropping.

// Common helpers
function intKind(size, unsigned) {
  return unsigned ? { kind: 'int', size, unsigned: true } : { kind: 'int', size };
}
function parseSize(str) {
  // 'VARCHAR(128)' → 128;  'DECIMAL(10,2)' → [10, 2];  'TEXT' → null
  const m = /\(\s*(\d+)(?:\s*,\s*(\d+))?\s*\)/.exec(str);
  if (!m) return null;
  return m[2] != null ? [Number(m[1]), Number(m[2])] : Number(m[1]);
}

// ============ MySQL ============

function normalizeMySql(src) {
  const s = String(src).trim().toUpperCase();
  const unsigned = /\bUNSIGNED\b/.test(s);
  const base = s.replace(/\bUNSIGNED\b|\bZEROFILL\b/g, '').trim();
  const head = base.replace(/\(.*$/, '').trim();
  const size = parseSize(base);

  switch (head) {
    case 'TINYINT':   return base.includes('(1)') ? { kind: 'bool' } : intKind(8,  unsigned);
    case 'SMALLINT':  return intKind(16, unsigned);
    case 'MEDIUMINT': return intKind(24, unsigned);
    case 'INT': case 'INTEGER': return intKind(32, unsigned);
    case 'BIGINT':    return intKind(64, unsigned);

    case 'FLOAT':     return { kind: 'float', size: 32 };
    case 'DOUBLE': case 'DOUBLE PRECISION': case 'REAL':
      return { kind: 'float', size: 64 };
    case 'DECIMAL': case 'NUMERIC':
      return Array.isArray(size)
        ? { kind: 'decimal', precision: size[0], scale: size[1] }
        : { kind: 'decimal', precision: 10, scale: 0 };

    case 'BIT':       return { kind: 'bool' };
    case 'BOOL': case 'BOOLEAN': return { kind: 'bool' };

    case 'CHAR':      return { kind: 'string', size: Number.isFinite(size) ? size : 1, fixed: true };
    case 'VARCHAR':   return { kind: 'string', size: Number.isFinite(size) ? size : 255 };
    case 'TINYTEXT': case 'TEXT': case 'MEDIUMTEXT': case 'LONGTEXT':
      return { kind: 'text' };

    case 'BINARY':    return { kind: 'binary', size: Number.isFinite(size) ? size : 1, fixed: true };
    case 'VARBINARY': return { kind: 'binary', size: Number.isFinite(size) ? size : 255 };
    case 'TINYBLOB': case 'BLOB': case 'MEDIUMBLOB': case 'LONGBLOB':
      return { kind: 'binary' };

    case 'DATE':      return { kind: 'date' };
    case 'TIME':      return { kind: 'time' };
    case 'DATETIME':  return { kind: 'datetime', timezone: false };
    case 'TIMESTAMP': return { kind: 'datetime', timezone: true };
    case 'YEAR':      return intKind(16, true);

    case 'JSON':      return { kind: 'json' };

    case 'ENUM': {
      // Pull values from the ORIGINAL (case-preserving) source — `base` has been upper-cased.
      const m = /\((.*)\)/.exec(String(src));
      const values = m ? m[1].split(',').map((v) => v.trim().replace(/^'|'$/g, '').replace(/''/g, "'")) : [];
      return { kind: 'enum', values };
    }

    default:
      return { kind: 'unknown', raw: src };
  }
}

// ============ PostgreSQL ============

function normalizePg(src) {
  const s = String(src).trim().toLowerCase();
  const head = s.replace(/\(.*$/, '').trim();
  const size = parseSize(s);

  switch (head) {
    case 'smallint': case 'int2': return intKind(16);
    case 'integer': case 'int': case 'int4': return intKind(32);
    case 'bigint': case 'int8': return intKind(64);
    case 'smallserial': return { ...intKind(16), autoIncrement: true };
    case 'serial':      return { ...intKind(32), autoIncrement: true };
    case 'bigserial':   return { ...intKind(64), autoIncrement: true };

    case 'real':             return { kind: 'float', size: 32 };
    case 'double precision': case 'float8':
      return { kind: 'float', size: 64 };
    case 'numeric': case 'decimal':
      return Array.isArray(size)
        ? { kind: 'decimal', precision: size[0], scale: size[1] }
        : { kind: 'decimal' };           // unlimited precision in PG

    case 'boolean': case 'bool': return { kind: 'bool' };

    case 'char': case 'character':
      return { kind: 'string', size: Number.isFinite(size) ? size : 1, fixed: true };
    case 'varchar': case 'character varying':
      return Number.isFinite(size) ? { kind: 'string', size } : { kind: 'text' };
    case 'text': return { kind: 'text' };

    case 'bytea': return { kind: 'binary' };

    case 'date':        return { kind: 'date' };
    case 'time': case 'time without time zone': return { kind: 'time' };
    case 'time with time zone': case 'timetz':
      return { kind: 'time', timezone: true };
    case 'timestamp': case 'timestamp without time zone':
      return { kind: 'datetime', timezone: false };
    case 'timestamp with time zone': case 'timestamptz':
      return { kind: 'datetime', timezone: true };

    case 'json': case 'jsonb': return { kind: 'json' };
    case 'uuid': return { kind: 'uuid' };

    default:
      return { kind: 'unknown', raw: src };
  }
}

// ============ SQLite (type affinity is loose — match common patterns) ============

function normalizeSqlite(src) {
  const s = String(src).trim().toUpperCase();
  // SQLite "type affinity" rules: INTEGER, REAL, TEXT, BLOB, NUMERIC
  if (/\bINT\b|\bINTEGER\b/.test(s)) return intKind(64);
  if (/\bREAL\b|\bFLOA\b|\bDOUB\b/.test(s)) return { kind: 'float', size: 64 };
  if (/\bBLOB\b/.test(s)) return { kind: 'binary' };
  if (/\bDECIMAL\b|\bNUMERIC\b/.test(s)) {
    const size = parseSize(s);
    return Array.isArray(size)
      ? { kind: 'decimal', precision: size[0], scale: size[1] }
      : { kind: 'decimal' };
  }
  if (/\bBOOL\b/.test(s)) return { kind: 'bool' };
  if (/\bDATETIME\b|\bTIMESTAMP\b/.test(s)) return { kind: 'datetime', timezone: false };
  if (/\bDATE\b/.test(s)) return { kind: 'date' };
  if (/\bTIME\b/.test(s)) return { kind: 'time' };
  if (/\bJSON\b/.test(s)) return { kind: 'json' };
  if (/\bVARCHAR\b|\bCHAR\b|\bTEXT\b|\bCLOB\b/.test(s)) {
    const size = parseSize(s);
    return Number.isFinite(size) ? { kind: 'string', size } : { kind: 'text' };
  }
  // Default affinity = NUMERIC for unrecognised → treat as decimal
  return { kind: 'unknown', raw: src };
}

// ============ Dispatcher ============

function normalize(dialect, source) {
  switch (dialect) {
    case 'mysql':    return normalizeMySql(source);
    case 'postgres': case 'pg': case 'supabase':
      return normalizePg(source);
    case 'sqlite':   return normalizeSqlite(source);
    default:
      throw new Error(`Unknown source dialect: ${dialect}`);
  }
}

module.exports = { normalize, normalizeMySql, normalizePg, normalizeSqlite };
