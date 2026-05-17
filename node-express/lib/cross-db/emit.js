// Take an IR type object and emit it as a column DDL fragment for the target dialect.
//
//   emit({ kind: 'int', size: 32, unsigned: true }, 'pg')
//     → { sql: 'BIGINT', warnings: ["mysql 'int unsigned' has no PG equivalent; widened to BIGINT"] }
//
// The emitter is deliberately small — it knows the IR shape and the target's
// idiomatic type, nothing more. Quoting / nullability / defaults belong to
// tables.js (the table-level emitter built on top of this).

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
      // PG has no unsigned — widen to the next signed size so values fit
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
      // PG has CREATE TYPE enums but those need a separate DDL statement; for now
      // emit as VARCHAR with a CHECK — that survives round-trip without extra plumbing.
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

// ============ SQLite (5 affinities — INTEGER / REAL / TEXT / BLOB / NUMERIC) ============

function emitSqlite(t) {
  const warnings = [];
  switch (t.kind) {
    case 'int': {
      if (t.unsigned) warnings.push("SQLite has no unsigned int; sign is lost");
      return { sql: 'INTEGER', warnings };
    }
    case 'float':   return { sql: 'REAL', warnings };
    case 'decimal':
      // Use NUMERIC affinity but flag precision loss
      if (t.precision && t.precision > 15) {
        warnings.push(`SQLite NUMERIC affinity is REAL-backed; decimal(${t.precision},${t.scale ?? 0}) loses precision beyond 15 digits`);
      }
      return { sql: t.precision != null ? `NUMERIC(${t.precision}${t.scale != null ? ',' + t.scale : ''})` : 'NUMERIC', warnings };
    case 'bool':    return { sql: 'INTEGER', warnings };
    case 'string':  return { sql: t.size ? `VARCHAR(${t.size})` : 'TEXT', warnings };
    case 'text':    return { sql: 'TEXT', warnings };
    case 'binary':  return { sql: 'BLOB', warnings };
    case 'date': case 'time': case 'datetime':
      // SQLite stores these as TEXT/INTEGER/REAL — TEXT is the canonical form
      return { sql: 'TEXT', warnings };
    case 'json':
      warnings.push('SQLite has no native JSON type; stored as TEXT (JSON1 ext works on TEXT)');
      return { sql: 'TEXT', warnings };
    case 'uuid':
      return { sql: 'TEXT', warnings };
    case 'enum':
      // CHECK constraints survive in SQLite
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
