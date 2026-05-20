# DB Migrator v1.4.0

Theme A（規模）4 個 phase 一次出 + Theme D（plugin sandbox）整個收尾。**Production-grade 大型 DB 加密備份到雲端 + 時光回溯還原**整套上線。

> 從 v1.3.0 升級 no breaking change — 既有 schedule / dump / plugin 都照舊跑。所有新功能 opt-in：
> - 不設 `DBMIGRATOR_DUMP_PASSWORD` env → 不加密（同 v1.3.0 行為）
> - 不設 `S3_BUCKET` env / `options.s3` → 不上傳雲端
> - 不設 `retentionCount` / `retentionDays` → 歷史無限保留（同 v1.3.0 行為）

## ✨ Highlights

- **Dump 加密**：AES-256-GCM + scrypt KDF；檔頭 magic `DBMENC01` + salt + iv，尾端 16B GCM tag。Wrong password 一律 generic error 防 oracle 攻擊。
- **S3 cloud destination**：`@aws-sdk/client-s3` (optional dep)；100MB 以上自動走 `@aws-sdk/lib-storage` 多片上傳；支援 MinIO / Cloudflare R2 自訂 endpoint。
- **完全 streaming**：encrypt / decrypt / upload 全條沒 in-memory buffer — 100GB+ DB dump 不會 OOM。Decrypt 透過「滾動保留末 16B」邏輯處理 GCM auth tag。
- **Time-travel restore**：scheduled backup 自動 per-schedule history；`retentionCount` + `retentionDays` 聯集判定；UI / API 隨選某份歷史檔還原到任意 DB。
- **Plugin nested-worker gate**：Theme D 之前如果 plugin 有 `unrestricted` 還是可以 `new Worker(code, {eval:true})` 逃 sandbox。Phase 4 直接 patch `Worker` constructor，**一律 throw**。
- **Persistent audit log**：require-denied / worker-spawn-attempt / route-mount / handler-error 全進 SQLite，admin 可 query。
- **測試規模**：Node unit 309 → **401**；CLI 41 → **48**；License-server 66 不變。

## 📦 New surfaces

| Surface | 用途 |
|---|---|
| [node-express/lib/dump-crypto.js](node-express/lib/dump-crypto.js) | AES-256-GCM + scrypt KDF；buffer + streaming 兩條路徑 |
| [node-express/lib/dest-s3.js](node-express/lib/dest-s3.js) | S3 upload (auto-multipart > 100MB)；DI client → tests 零依賴 |
| [node-express/lib/schedule-history.js](node-express/lib/schedule-history.js) | History list + retention enforce + path traversal-safe resolver |
| [node-express/lib/plugin-audit.js](node-express/lib/plugin-audit.js) | SQLite-backed audit append / list / count / prune |
| [node-express/routes/plugin-audit.js](node-express/routes/plugin-audit.js) | `GET /api/plugin-audit` + `/count` + `POST /prune` |
| 3 新 schedule endpoint | `/api/schedule/:id/history`、`/restore`、`DELETE /history/:name` |
| `--encrypt --password-env / --s3-*` CLI flags | export & dump-neutral & import & restore-neutral |
| 7 個新 GHA inputs | `encrypt` / `dump-password` / `s3-bucket` / `s3-prefix` / `s3-region` / `s3-endpoint` / `s3-delete-local` |

## 🔒 Security

- **Dump 加密**：scrypt N=16384 讓 password brute-force 變貴；GCM authenticated encryption — corrupted / tampered ciphertext 一律 throw 同一句訊息（無 oracle 洩漏）
- **不留 plaintext**：streaming encrypt 完原檔立刻 unlink；schedule restore 解密到 tmp，restore 完馬上清
- **AWS credentials**：完全靠 AWS SDK 標準鏈（env / shared config / IAM role），DB Migrator 不碰
- **Plugin Worker gate**：`unrestricted` plugin 仍不能 spawn nested worker — 防 sandbox escape
- **Audit trail**：所有 sandbox sensitive event 留痕 30 天（可設 retention）；admin 可 query 「plugin X 有沒有試過做不該做的事」
- **Path traversal**：history file resolve 雙層檢查（kebab-case + normalize start-with-dir）

## 🚀 Upgrade

```powershell
git pull

# Node client — 既有 dep 不變；要用 S3 才裝 optional
cd node-express; npm install
# 想用 S3 + multipart 才需要：
npm install --include=optional      # 順便裝 @aws-sdk/client-s3 + lib-storage

# License server / CLI — 不變
```

開啟 dump 加密：

```powershell
$env:DBMIGRATOR_DUMP_PASSWORD = "your-strong-password"
# 之後手動 export / scheduled backup 自動加密成 .enc
# restore / import 自動偵測 magic header 解密（不用 flag）
```

開啟 S3 上傳：

```powershell
$env:AWS_REGION   = "ap-northeast-1"
$env:S3_BUCKET    = "my-backups"
$env:S3_PREFIX    = "prod/"
# 加密 + 上 S3 一次到位
dbmigrator export --type mysql --host h --database app --out backup.sql `
  --encrypt --password-env DBMIGRATOR_DUMP_PASSWORD `
  --s3-bucket my-backups --s3-prefix prod/ --s3-delete-local
```

Schedule 設 retention：

```bash
curl -X PATCH http://localhost:3000/api/schedule/$ID \
  -H 'Content-Type: application/json' \
  -d '{"retentionCount":7,"retentionDays":30}'
# 留最新 7 份 AND 砍超過 30 天 — 任一條 trigger 就刪
```

Time-travel restore：

```bash
# 列歷史
curl http://localhost:3000/api/schedule/$ID/history

# 還原某份到原 DB
curl -X POST http://localhost:3000/api/schedule/$ID/restore \
  -H 'Content-Type: application/json' \
  -d '{"historyName":"app_2026-05-15T02-00-00.sql.enc"}'

# 還原到不同 target DB
curl -X POST http://localhost:3000/api/schedule/$ID/restore \
  -H 'Content-Type: application/json' \
  -d '{"historyName":"app_2026-05-15T02-00-00.sql.enc",
       "target":{"type":"postgres","connection":{...},"database":"app_restore"}}'
```

## 📈 Testing

| 層 | 數量 | 跑法 |
|---|---|---|
| Node unit | 401 (378 pass + 23 skip 需 npm install) | `cd node-express && npm test` |
| CLI unit | 48 全 pass | `cd cli && npm test` |
| License-server unit | 66 pure pass + 1 fail 需 npm install: better-sqlite3 | `cd license-server && npm test` |
| Cross-DB e2e matrix | 6 個方向 | `cd integration && docker compose up -d && npm run test:crossdb` |

## 🆕 New endpoints quick reference

**DB Migrator client**
- `POST /api/export` — 新 options：`encrypt: true` + `passwordEnv`、`s3: { bucket, prefix?, region?, endpoint?, deleteLocal? }`
- `POST /api/import/inspect` — 自動偵測 `.enc` magic + 解密（passwordEnv 從 meta JSON）
- `GET /api/schedule/:id/history` — 列歷史
- `POST /api/schedule/:id/restore` — time-travel restore
- `DELETE /api/schedule/:id/history/:name` — 手動清
- `GET /api/plugin-audit` — sensitive event audit log (filter by plugin / event / since / minSeverity)
- `GET /api/plugin-audit/count` — 只回筆數
- `POST /api/plugin-audit/prune` — 砍舊紀錄

完整看 `http://localhost:3000/api-docs/`。

## 🙏 Dep changes

| Package | 變動 | 為什麼 |
|---|---|---|
| `@aws-sdk/client-s3` | NEW (optional `^3.700.0`) | S3 cloud destination |
| `@aws-sdk/lib-storage` | NEW (optional `^3.700.0`) | 100MB+ 自動 multipart upload |

兩個都是 optionalDependencies — 不用 S3 完全不需要裝。其餘 dep 不變。

## 🚧 Theme A 剩下

- **Phase 5 resumable**：dump 跑一半 crash 接續、restore 跳過已 INSERT 的 row（中型工程，touches 6 adapter）
- **Phase 6 incremental backup**：基準 dump + 後續 delta（大；需 row hash 或 timestamp 比對）

如果你跑的不是 100GB+ DB 一次需要 6 小時 dump 的場景，這兩 phase 大概沒迫切性 — v1.4.0 的 encrypt + S3 streaming + history 已經是「大部分中型團隊都夠用」的程度。

---

**Full Changelog**: https://github.com/wei820528/db-migrator/compare/v1.3.0...v1.4.0
