// Neutral value encoder / decoder for the cross-DB dump format.
//
// The dump format (see ../README.md → "Phase 2 format") writes a {schema}
// event before each table's rows. Both encoder and decoder consult that IR
// to figure out how to serialize each column — no per-value `$type` wrappers,
// which would collide with user-supplied JSON content.
//
// Encoding rules (driver value → JSON-safe value):
//
//   IR kind         driver type            JSON value
//   ──────────────  ─────────────────────  ─────────────────────────────────
//   int             number / BigInt        number (if safe int) else string
//   float           number                 number
//   decimal         string / number        string (preserve precision)
//   bool            boolean / 0/1          boolean
//   string / text   string                 string
//   enum            string                 string
//   uuid            string                 string
//   date            Date / string          'YYYY-MM-DD'
//   time            string                 'HH:MM:SS' (with optional fractional seconds)
//   datetime        Date / string          ISO 8601 ('YYYY-MM-DDTHH:MM:SS[.sss]Z')
//   binary          Buffer / Uint8Array    base64 string
//   json            any                    passed through (nested JSON value)
//   unknown         any                    JSON.stringify-able value as-is

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const MIN_SAFE = Number.MIN_SAFE_INTEGER;

function encodeValue(value, irType) {
  if (value === null || value === undefined) return null;
  const kind = irType?.kind || 'unknown';

  switch (kind) {
    case 'int': {
      if (typeof value === 'bigint') {
        if (value <= MAX_SAFE && value >= MIN_SAFE) return Number(value);
        return value.toString();
      }
      return Number(value);
    }
    case 'float':
      return Number(value);
    case 'decimal':
      // PG driver returns string; mysql2 may return number or string depending on config
      return typeof value === 'string' ? value : String(value);
    case 'bool':
      if (typeof value === 'boolean') return value;
      if (typeof value === 'number')  return value !== 0;
      if (typeof value === 'string')  return value === '1' || value.toLowerCase() === 'true';
      return Boolean(value);
    case 'string': case 'text': case 'enum': case 'uuid':
      return String(value);
    case 'date':
      if (value instanceof Date) return value.toISOString().slice(0, 10);
      return String(value).slice(0, 10);
    case 'time':
      if (value instanceof Date) return value.toISOString().slice(11, 19);
      return String(value);
    case 'datetime':
      if (value instanceof Date) return value.toISOString();
      // mysql2 might return strings like '2026-05-18 03:14:15'
      if (typeof value === 'string') {
        const iso = value.replace(' ', 'T');
        return /Z$|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso + 'Z';
      }
      return String(value);
    case 'binary':
      if (Buffer.isBuffer(value)) return value.toString('base64');
      if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
      if (typeof value === 'string') return Buffer.from(value).toString('base64');
      return null;
    case 'json':
      // Some drivers return JSON column values as strings, others as objects
      if (typeof value === 'string') {
        try { return JSON.parse(value); } catch { return value; }
      }
      return value;
    default:
      // Unknown — try JSON-friendly coercion
      if (value instanceof Date)   return value.toISOString();
      if (Buffer.isBuffer(value))  return value.toString('base64');
      if (typeof value === 'bigint') return value.toString();
      return value;
  }
}

// Reverse: JSON-decoded value back to a driver-ready value for the target dialect.
// The target adapter can rely on this giving back Date / Buffer / etc. where
// it makes sense, and a plain string for everything else (driver-side coercion
// usually handles the rest).
function decodeValue(value, irType) {
  if (value === null || value === undefined) return null;
  const kind = irType?.kind || 'unknown';

  switch (kind) {
    case 'int':
      // Came back as either number or string (for big values)
      if (typeof value === 'string') {
        // Try BigInt if it doesn't fit in Number
        try { const n = Number(value); return Number.isSafeInteger(n) ? n : BigInt(value); }
        catch { return value; }
      }
      return value;
    case 'float':   return typeof value === 'number' ? value : Number(value);
    case 'decimal': return String(value);
    case 'bool':    return Boolean(value);
    case 'string': case 'text': case 'enum': case 'uuid': return String(value);
    case 'date': case 'time':
      // Most drivers accept ISO strings directly
      return String(value);
    case 'datetime':
      // Return a Date object for drivers that prefer it; ISO string still works
      return new Date(String(value));
    case 'binary':
      return Buffer.from(String(value), 'base64');
    case 'json':
      return value;
    default:
      return value;
  }
}

// Convenience: encode an entire row given an IR schema.
function encodeRow(row, irColumns) {
  const out = {};
  const byName = Object.fromEntries((irColumns || []).map((c) => [c.name, c]));
  for (const [name, v] of Object.entries(row)) {
    out[name] = encodeValue(v, byName[name]?.type);
  }
  return out;
}

function decodeRow(jsonRow, irColumns) {
  const out = {};
  const byName = Object.fromEntries((irColumns || []).map((c) => [c.name, c]));
  for (const [name, v] of Object.entries(jsonRow)) {
    out[name] = decodeValue(v, byName[name]?.type);
  }
  return out;
}

module.exports = { encodeValue, decodeValue, encodeRow, decodeRow };
