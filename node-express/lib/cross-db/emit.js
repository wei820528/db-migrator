// 把一個 IR type object emit 成目標 dialect 的「欄位 DDL 片段」。
//
//   emit({ kind: 'int', size: 32, unsigned: true }, 'pg')
//     → { sql: 'BIGINT', warnings: ["PG 沒有 unsigned int；widening 到 BIGINT"] }
//
// 這層故意做得很小 — 只認 IR shape 跟 target 慣用型別。
// 識別子 quote、nullability、default 都在 tables.js（上層的 table-level emitter）。

function emit(ir, target) {
  switch (target) {
    case 'mysql':    return emitMySql(ir);
    case 'postgres': case 'pg': case 'supabase':
      return emitPg(ir);
    case 'sqlite':   return emitSqlite(ir);
    default:
      throw new Error(`Unknown target dialect: ${target}`);
  }
}

// ============ MySQL ============

function emitMySql(t) {
  const warnings = [];
  switch (t.kind) {
    case 'int': {
      const sizes = { 8: 'TINYINT', 16: 'SMALLINT', 24: 'MEDIUMINT', 32: 'INT', 64: 'BIGINT' };
      const base = sizes[t.size] || 'INT';
      return { sql: t.unsigned ? `${base} UNSIGNED` : base, warnings };
    }
    case 'float':   return { sql: t.size === 32 ? 'FLOAT' : 'DOUBLE', warnings };
    case 'decimal': return { sql: decimalSql(t), warnings };
    case 'bool':    return { sql: 'TINYINT(1)', warnings };
    case 'string': {
      const size = t.size || 255;
      if (size > 16383) {
        warnings.push(`string(${size}) exceeds MySQL VARCHAR practical max; using TEXT`);
        return { sql: 'TEXT', warnings };
      }
      return { sql: t.fixed ? `CHAR(${size})` : `VARCHAR(${size})`, warnings };
    }
    case 'text':    return { sql: 'TEXT', warnings };
    case 'binary': {
      if (t.size && t.size <= 255) return { sql: t.fixed ? `BINARY(${t.size})` : `VARBINARY(${t.size})`, warnings };
      return { sql: 'BLOB', warnings };
    }
    case 'date':    return { sql: 'DATE', warnings };
    case 'time':    return { sql: 'TIME', warnings };
    case 'datetime':
      if (t.timezone) return { sql: 'TIMESTAMP', warnings };
      return { sql: 'DATETIME', warnings };
    case 'json':    return { sql: 'JSON', warnings };
    case 'uuid':
      warnings.push("MySQL has no native UUID; using CHAR(36)");
      return { sql: 'CHAR(36)', warnings };
    case 'enum':
      return { sql: `ENUM(${(t.values || []).map((v) => "'" + String(v).replace(/'/g, "''") + "'").join(',')})`, warnings };
    case 'unknown':
      warnings.push(`unknown type "${t.raw}" — passed through as TEXT`);
      return { sql: 'TEXT', warnings };
    default:
      warnings.push(`unsupported IR kind "${t.kind}" — passed through as TEXT`);
      return { sql: 'TEXT', warnings };
  }
}

// ============ PostgreSQL ============

function emitPg(t) {
  const warnings = [];
  switch (t.kind) {
    case 'int': {
      // PG 沒有 unsigned — widening 到下一個 signed size 確保 value 塞得下
      if (t.unsigned) {
        warnings.push(`PG has no unsigned int; widening from ${t.size}-bit to next signed size`);
        const widened = { 8: 'SMALLINT', 16: 'INTEGER', 24: 'INTEGER', 32: 'BIGINT', 64: 'NUMERIC(20)' }[t.size] || 'BIGINT';
        return { sql: widened, warnings };
      }
      const sizes = { 8: 'SMALLINT', 16: 'SMALLINT', 24: 'INTEGER', 32: 'INTEGER', 64: 'BIGINT' };
      return { sql: sizes[t.size] || 'INTEGER', warnings };
    }
    case 'float':   return { sql: t.size === 32 ? 'REAL' : 'DOUBLE PRECISION', warnings };
    case 'decimal': return { sql: decimalSql(t, 'NUMERIC'), warnings };
    case 'bool':    return { sql: 'BOOLEAN', warnings };
    case 'string': {
      const size = t.size || 255;
      return { sql: t.fixed ? `CHAR(${size})` : `VARCHAR(${size})`, warnings };
    }
    case 'text':    return { sql: 'TEXT', warnings };
    case 'binary':  return { sql: 'BYTEA', warnings };
    case 'date':    return { sql: 'DATE', warnings };
    case 'time':    return { sql: t.timezone ? 'TIMETZ' : 'TIME', warnings };
    case 'datetime':return { sql: t.timezone ? 'TIMESTAMPTZ' : 'TIMESTAMP', warnings };
    case 'json':    return { sql: 'JSONB', warnings };
    case 'uuid':    return { sql: 'UUID', warnings };
    case 'enum': {
      // PG 有 CREATE TYPE enum，但需要獨立 DDL；先用 VARCHAR + CHECK，round-trip 不需要額外管線。
      warnings.push(`enum dropped to VARCHAR + CHECK; native PG ENUM type not emitted`);
      const vals = (t.values || []).map((v) => "'" + String(v).replace(/'/g, "''") + "'").join(',');
      return { sql: `VARCHAR CHECK (VALUE IN (${vals}))`, warnings };
    }
    case 'unknown':
      warnings.push(`unknown type "${t.raw}" — passed through as TEXT`);
      return { sql: 'TEXT', warnings };
    default:
      warnings.push(`unsupported IR kind "${t.kind}" — passed through as TEXT`);
      return { sql: 'TEXT', warnings };
  }
}

// ============ SQLite（5 種 affinity — INTEGER / REAL / TEXT / BLOB / NUMERIC） ============

function emitSqlite(t) {
  const warnings = [];
  switch (t.kind) {
    case 'int': {
      if (t.unsigned) warnings.push("SQLite has no unsigned int; sign is lost");
      return { sql: 'INTEGER', warnings };
    }
    case 'float':   return { sql: 'REAL', warnings };
    case 'decimal':
      // 用 NUMERIC affinity，但精度超 15 會 lose（NUMERIC 底層是 REAL）
      if (t.precision && t.precision > 15) {
        warnings.push(`SQLite NUMERIC affinity is REAL-backed; decimal(${t.precision},${t.scale ?? 0}) loses precision beyond 15 digits`);
      }
      return { sql: t.precision != null ? `NUMERIC(${t.precision}${t.scale != null ? ',' + t.scale : ''})` : 'NUMERIC', warnings };
    case 'bool':    return { sql: 'INTEGER', warnings };
    case 'string':  return { sql: t.size ? `VARCHAR(${t.size})` : 'TEXT', warnings };
    case 'text':    return { sql: 'TEXT', warnings };
    case 'binary':  return { sql: 'BLOB', warnings };
    case 'date': case 'time': case 'datetime':
      // SQLite 把這些存成 TEXT/INTEGER/REAL — TEXT 是 canonical form
      return { sql: 'TEXT', warnings };
    case 'json':
      warnings.push('SQLite has no native JSON type; stored as TEXT (JSON1 ext works on TEXT)');
      return { sql: 'TEXT', warnings };
    case 'uuid':
      return { sql: 'TEXT', warnings };
    case 'enum':
      // SQLite 支援 CHECK constraint
      warnings.push('SQLite has no enum type; emitted as TEXT + CHECK');
      const vals = (t.values || []).map((v) => "'" + String(v).replace(/'/g, "''") + "'").join(',');
      return { sql: `TEXT CHECK (VALUE IN (${vals}))`, warnings };
    case 'unknown':
      warnings.push(`unknown type "${t.raw}" — passed through as TEXT`);
      return { sql: 'TEXT', warnings };
    default:
      warnings.push(`unsupported IR kind "${t.kind}" — passed through as TEXT`);
      return { sql: 'TEXT', warnings };
  }
}

function decimalSql(t, baseName = 'DECIMAL') {
  if (t.precision == null) return baseName;
  if (t.scale == null)     return `${baseName}(${t.precision})`;
  return `${baseName}(${t.precision},${t.scale})`;
}

module.exports = { emit, emitMySql, emitPg, emitSqlite };
