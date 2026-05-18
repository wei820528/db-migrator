# Cross-DB migration (v2 Theme B)

Move data between SQL dialects (currently MySQL ↔ PostgreSQL ↔ SQLite).
Built around an **intermediate representation (IR)** so adding a new dialect
later is one parser + one emitter, not N² translators.

## Status

| Phase | Item | Status |
|---|---|---|
| 1a | IR shape + type normalization | done |
| 1b | Type mapping table (mysql↔pg↔sqlite) + dialect emitter | done |
| 1c | Tests | done |
| 2a | Neutral JSONL dump format spec | done |
| 2b | `getSchema(conn)` per adapter (mysql / pg / sqlite) | done |
| 2c | `dumpNeutral(conn, opts, outFile)` per adapter | done |
| 2d | Value encoder (Date / Buffer / JSON → portable JSONL) | done |
| 2e | Tests (encoder + format + sqlite e2e) | done |
| 3a | `tables.js` — IR → `CREATE TABLE` + `CREATE INDEX` per target | done |
| 3b | `restoreNeutral(conn, neutralPath)` per adapter (sqlite / mysql / pg) | done |
| 3c | Tests + sqlite end-to-end (`dumpNeutral` → `restoreNeutral` round-trip) | done |
| 4a | `getSchema` 每欄加 `sourceTypeRaw`（保留原始 dialect string） | done |
| 4b | `POST /api/cross-db/preview-live` route + `buildTablePreview` helper | done |
| 4c | UI: 跨 DB 遷移 tab + per-table preview cards + warnings inline | done |
| 4d | Tests for preview helper + HTTP route validation | done |
| 5  | Integration matrix (6 directions) | done — `integration/run-crossdb.js`，CI 自動跑 |

## IR shape

A neutral schema is a JSON document. Same shape regardless of source dialect.

```js
{
  name: 'users',
  columns: [
    { name: 'id',    type: { kind: 'int',     size: 32, unsigned: true,  autoIncrement: true }, nullable: false, primaryKey: true },
    { name: 'email', type: { kind: 'string',  size: 128 },                                       nullable: false, unique: true },
    { name: 'note',  type: { kind: 'text' },                                                     nullable: true },
    { name: 'price', type: { kind: 'decimal', precision: 10, scale: 2 },                         nullable: true },
    { name: 'meta',  type: { kind: 'json' },                                                     nullable: true },
    { name: 'data',  type: { kind: 'binary', size: 1024 },                                       nullable: true },
    { name: 'flag',  type: { kind: 'bool' },                                                     nullable: false, default: false },
    { name: 'ts',    type: { kind: 'datetime', timezone: false },                                nullable: false, default: 'CURRENT_TIMESTAMP' },
  ],
  indexes: [
    { name: 'idx_users_email', columns: ['email'], unique: true },
  ],
}
```

## Supported `type.kind`

`int` / `float` / `decimal` / `string` / `text` / `binary` / `bool` / `date` /
`datetime` / `time` / `json` / `uuid` / `enum`

Anything that doesn't fit cleanly falls back to `unknown` with the raw
source-dialect string preserved — the emitter then either passes it through
or warns.

## Lossy translations

Some conversions lose information. The emitter returns these as **warnings**
in `emit(ir, target).warnings`, so the dry-run preview UI can surface them
before the actual run. Examples:

- PG `numeric(38, 10)` → SQLite `REAL` — precision loss
- MySQL `MEDIUMINT(8) UNSIGNED` → SQLite `INTEGER` — sign loss (SQLite has no unsigned)
- PG `tsvector` / `inet` / `cidr` — no SQLite/MySQL equivalent, store as text
- MySQL `enum('a','b','c')` → PG `CHECK (col IN (...))` — works but loses native enum

## Files

- [normalize.js](normalize.js) — source-dialect string → IR `type` object
- [emit.js](emit.js) — IR `type` object → target-dialect column DDL string
- [encode.js](encode.js) — driver value ↔ JSON-safe value, schema-guided (Date / Buffer / BigInt / JSON)
- [format.js](format.js) — `NeutralWriter` / `readNeutral` / `readMetadata` for the JSONL event stream
- [tables.js](tables.js) — IR table → `CREATE TABLE` + `CREATE INDEX` per target dialect (handles SERIAL / AUTOINCREMENT / AUTO_INCREMENT, PK clause inlining for sqlite, default-value heuristic)
- [preview.js](preview.js) — `buildTablePreview(ir, target)` + `stringifyIr(t)` — pure helpers behind `/api/cross-db/preview-live`
- [index.js](index.js) — public surface: `normalize(dialect, source) → ir`, `emit(ir, target) → { sql, warnings }`, `translate(src, srcD, tgtD)`

Adapter-side additions:

- Phase 2: `getSchema(conn, tables?)` + `dumpNeutral(conn, opts, outFile)`
- Phase 3: `restoreNeutral(conn, neutralPath, onProgress)` — reads JSONL, emits target-dialect DDL, runs parameterized INSERTs (no escaping required)

All three implemented in [adapters/sqlite.js](../../adapters/sqlite.js), [adapters/mysql.js](../../adapters/mysql.js), [adapters/postgres.js](../../adapters/postgres.js).

## Neutral JSONL format (v1)

```
{"op":"header","format":"neutral-v1","sourceDialect":"sqlite","db":"app.db","generated":"...","tables":["users"]}
{"op":"schema","table":"users","columns":[
  {"name":"id","type":{"kind":"int","size":64},"nullable":false,"primaryKey":true,"autoIncrement":true},
  {"name":"email","type":{"kind":"string","size":128},"nullable":false}
],"indexes":[{"name":"idx_email","columns":["email"],"unique":true}]}
{"op":"row","table":"users","values":{"id":1,"email":"a@x.com"}}
{"op":"row","table":"users","values":{"id":2,"email":"b@x.com"}}
```

Order: header must come first; for each table, its `schema` event must precede that table's `row` events. Tables can be interleaved or grouped. Reader keeps a `name → schema` map.

Value-encoding rules are schema-guided (see [encode.js](encode.js) docstring) — no `$type` wrappers, so JSON columns with arbitrary content don't collide with type metadata.

## Tests

`node --test ../../test/cross-db.test.js` — Phase 1 (56 tests)
`node --test ../../test/cross-db-format.test.js` — Phase 2 (25 tests, 4 skipped if better-sqlite3 not installed)
`node --test ../../test/cross-db-tables.test.js` — Phase 3 (26 tests, 3 skipped if better-sqlite3 not installed)

Run from project root: `npm test --prefix node-express`.
