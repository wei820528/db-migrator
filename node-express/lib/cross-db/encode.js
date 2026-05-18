// Cross-DB dump format 用的中性 value encoder / decoder。
//
// Dump 格式（詳見 ../README.md → "Phase 2 format"）會在每張 table 的 rows
// 前面寫一個 {schema} event。Encoder 跟 decoder 都查那份 IR 決定怎麼序列化
// 每個欄位 — 不用 per-value `$type` wrapper，否則會跟使用者 JSON 欄位的內容衝突。
//
// Encoding 規則（driver value → JSON-safe value）：
//
//   IR kind         driver 型別             JSON value
//   ──────────────  ─────────────────────  ─────────────────────────────────
//   int             number / BigInt        number（safe int 範圍內）否則 string
//   float           number                 number
//   decimal         string / number        string（保留精度）
//   bool            boolean / 0/1          boolean
//   string / text   string                 string
//   enum            string                 string
//   uuid            string                 string
//   date            Date / string          'YYYY-MM-DD'
//   time            string                 'HH:MM:SS'（可選小數秒）
//   datetime        Date / string          ISO 8601（'YYYY-MM-DDTHH:MM:SS[.sss]Z'）
//   binary          Buffer / Uint8Array    base64 string
//   json            any                    pass through（nested JSON value）
//   unknown         any                    可被 JSON.stringify 的 value 原樣帶過

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
      // PG driver 回 string；mysql2 可能回 number 也可能回 string，看 driver 設定
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
      // mysql2 可能回 '2026-05-18 03:14:15' 這種字串
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
      // 有些 driver 回 string、有些回 object
      if (typeof value === 'string') {
        try { return JSON.parse(value); } catch { return value; }
      }
      return value;
    default:
      // Unknown — 試著做 JSON-friendly 轉換
      if (value instanceof Date)   return value.toISOString();
      if (Buffer.isBuffer(value))  return value.toString('base64');
      if (typeof value === 'bigint') return value.toString();
      return value;
  }
}

// 反向：JSON-decoded value 還原成適合 target dialect driver 吃的值。
// Target adapter 可以信賴這函式在需要時回 Date / Buffer 等型別，其他情況回 string
// （多數 driver 端 coercion 會處理剩下的）。
function decodeValue(value, irType) {
  if (value === null || value === undefined) return null;
  const kind = irType?.kind || 'unknown';

  switch (kind) {
    case 'int':
      // 回來時可能是 number、也可能是 string（大數）
      if (typeof value === 'string') {
        // 塞不下 Number 就用 BigInt
        try { const n = Number(value); return Number.isSafeInteger(n) ? n : BigInt(value); }
        catch { return value; }
      }
      return value;
    case 'float':   return typeof value === 'number' ? value : Number(value);
    case 'decimal': return String(value);
    case 'bool':    return Boolean(value);
    case 'string': case 'text': case 'enum': case 'uuid': return String(value);
    case 'date': case 'time':
      // 多數 driver 直接吃 ISO string
      return String(value);
    case 'datetime':
      // 偏好 Date object 的 driver 拿到 Date 即可，回 ISO string 大多也通
      return new Date(String(value));
    case 'binary':
      return Buffer.from(String(value), 'base64');
    case 'json':
      return value;
    default:
      return value;
  }
}

// 便利包裝：給一張 IR schema，整個 row 一起 encode。
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
