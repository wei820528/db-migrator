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
| 2  | `getSchema(conn)` per adapter + neutral JSONL dump format | pending |
| 3  | Cross-DB restore (read JSONL, emit target dialect) | pending |
| 4  | Dry-run preview UI | pending |
| 5  | Integration matrix (6 directions) | pending |

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
- [tables.js](tables.js) — IR `table` object → target-dialect `CREATE TABLE` (Phase 2)
- [index.js](index.js) — public surface: `normalize(dialect, source) → ir`, `emit(ir, target) → { sql, warnings }`

## Tests

`node --test ../../test/cross-db.test.js`

Run from project root: `npm test --prefix node-express`.
