# Integration tests

兩種測試模式：

**A. Same-DB round-trip** — 每個 adapter 自己 dump/restore，驗證 driver × adapter 邊角：
```
seed → adapter.dump → verify parseTableNamesFromDump → drop → adapter.restore → verify counts
```

**B. Cross-DB matrix（v2 Theme B Phase 5）** — 三角 6 個方向（MySQL ↔ PostgreSQL ↔ SQLite）：
```
src.seed → src.dumpNeutral → tgt.drop → tgt.restoreNeutral → verify tgt counts
```

Same-DB 抓 driver × adapter 邊角（之前抓到 MSSQL bracket 跟 IP wildcard 兩個 bug 都是 integration 級的）。Cross-DB 抓 IR translation × dialect 邊角（型別映射、autoIncrement 處理、parameterized INSERT 在 3 個 driver 上的行為差異）。

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
npm test                            # same-DB round-trip × 6 adapter
npm run test:crossdb                # cross-DB matrix（6 個方向）
node run.js mysql                   # 單跑一個
node run.js mongo redis             # 多個
node run-crossdb.js mysql:postgres  # 單個 cross-DB 方向
node run-crossdb.js mysql           # mysql 為 source 的所有方向

# 3. Tear down (也清 container volumes)
npm run down
```

兩個 orchestrator 都 exit 0 if all pass、non-zero otherwise — CI-friendly。

## What each round-trip checks

### A. Same-DB (`run.js`)

| Adapter | Tables / collections seeded | Verify |
|---|---|---|
| mysql    | `users` + `orders` (FK)             | row counts after restore |
| postgres | `users` + `orders` (FK)             | row counts after restore |
| mssql    | `dbo.users` + `dbo.orders` (FK)     | row counts after restore |
| sqlite   | `users` + `orders` (FK)             | row counts after restore |
| mongo    | `users` (3 docs + unique idx) + `orders` (3 docs) | `countDocuments` after restore |
| redis    | 3 string keys + 3 hashes + 1 set    | `KEYS *` count + spot value |

### B. Cross-DB matrix (`run-crossdb.js`)

| Direction | 預期行為 |
|---|---|
| mysql → postgres | `int unsigned` 拓寬到 BIGINT、`TINYINT(1)` → BOOLEAN、`DATETIME` → TIMESTAMP |
| mysql → sqlite   | 全 `INTEGER` affinity；unsigned 標記 warning |
| postgres → mysql | `SERIAL` → `INT AUTO_INCREMENT`、`JSONB` → JSON、`BYTEA` → VARBINARY/BLOB |
| postgres → sqlite | `JSONB` → TEXT + warning、`numeric(p,s)` 精度提示 |
| sqlite → mysql   | 從 affinity 推回具體型別；INTEGER PK → INT AUTO_INCREMENT |
| sqlite → postgres | 同上 → SERIAL |

每個方向 verify target 端的 `users` + `orders` row count 應該都還是 3+3。Dumps 留在 `integration/dumps/<src>-to-<tgt>.jsonl` 供事後檢查（fail 時 CI 會 upload 當 artifact）。

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
