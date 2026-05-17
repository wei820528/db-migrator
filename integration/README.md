# Integration tests

Round-trips every adapter against a real database (booted via docker-compose):

```
seed → adapter.dump → verify parseTableNamesFromDump → drop → adapter.restore → verify counts
```

Catches `driver bug × adapter` issues that unit tests can't see — e.g. an
`extractTableName` regex that mis-parses MSSQL brackets, or a Mongo EJSON
mismatch between Node and .NET dumps.

## Prerequisites

- Docker (24+) with the Compose plugin
- Node.js 18+
- The same dependencies as `node-express/` (run `cd ../node-express && npm install` first;
  it has `mongodb` + `ioredis` in `optionalDependencies` which is required here)

## Run

```powershell
cd integration

# 1. Boot all 6 DBs (sqlite uses a local file, no container)
npm run up
#  mysql       :33306
#  postgres    :55432
#  mssql       :11433  (sa / DbMigrator!1)
#  mongo       :27017
#  redis       :6379

# 2. Round-trip all adapters (skips ones whose container isn't healthy yet)
npm test

# 3. Or just one
node run.js mysql
node run.js mongo redis

# 4. Tear down (also wipes container volumes)
npm run down
```

`run.js` exits 0 if every requested adapter passed, non-zero otherwise — CI-friendly.

## What each round-trip checks

| Adapter | Tables / collections seeded | Verify |
|---|---|---|
| mysql    | `users` + `orders` (FK)             | row counts after restore |
| postgres | `users` + `orders` (FK)             | row counts after restore |
| mssql    | `dbo.users` + `dbo.orders` (FK)     | row counts after restore |
| sqlite   | `users` + `orders` (FK)             | row counts after restore |
| mongo    | `users` (3 docs + unique idx) + `orders` (3 docs) | `countDocuments` after restore |
| redis    | 3 string keys + 3 hashes + 1 set    | `KEYS *` count + spot value |

Dumps land in `integration/dumps/<adapter>.dump` for manual inspection.

## Adding new fixtures

Edit [helpers/fixtures.js](helpers/fixtures.js) — add a new entry with
`{ name, conn, seed, drop, verify }`. The orchestrator auto-runs whatever's
in the registry. To exercise the new DDL extras (procedures, views,
sequences, events) end-to-end, extend the per-adapter `seed()` to create them
and add post-restore checks to `verify()`.

## CI

A GitHub Actions workflow at [.github/workflows/integration.yml](../.github/workflows/integration.yml)
boots docker-compose on `ubuntu-latest`, runs the full suite, and uploads
dumps as artifacts when something fails. Triggers on push to `main` and on
PRs touching `node-express/adapters/**` or `integration/**`.
