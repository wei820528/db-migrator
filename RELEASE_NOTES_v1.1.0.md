# DB Migrator v1.1.0

Five back-to-back features since v1.0.0 (2026-05-17 → 2026-05-18). No breaking changes — drop in and go.

> 升級沒有 schema migration、沒有 config 變動。`license-server` 的 `issued_licenses` 表會在啟動時自動 `CREATE IF NOT EXISTS`。

## ✨ Highlights

- **2 個新 DB 支援**：MongoDB + Redis（總共 7 種）
- **Plugin marketplace**：從 GitHub URL 一鍵裝外掛，SHA-256 + Ed25519 雙重驗證
- **Remote kill switch**：offline 模式 license 現在可遠端撤銷（30 天 grace）
- **DDL extras v2**：dump 現在含 views / stored procedures / functions / sequences (PG) / events (MySQL)
- **Real-DB integration tests**：docker-compose 起 6 個 DB，端對端跑 dump/restore round-trip
- **Test 數量**：Node unit 37 → 87；License-server 49 → 55

## 📦 What's new

| 功能 | 細節 |
|---|---|
| **MongoDB adapter** | JSONL + EJSON canonical（保留 ObjectId / Date / Binary / Decimal128）；Atlas URI 自動偵測 |
| **Redis adapter** | redis-cli 風格 command dump；key namespace 當「資料表」分群 |
| **Plugin marketplace** | `plugin.json` manifest；trusted-publishers 白名單；未簽章強制使用者確認 |
| **License revocation** | Payload v2 加 `lid` UUID；client 每 24h fetch 撤銷清單；`/api/revocation/list` 公開無 auth |
| **DDL extras** | MySQL/PG/MSSQL 都加 views/procs/funcs；PG 加 sequences + setval；MySQL 加 events |
| **Routine markers** | `-- ROUTINE_BEGIN/END` 包覆 procedure body，避免 `;` splitter 切壞內部語句 |
| **Integration tests** | `cd integration && docker compose up -d && npm test`；6 個 adapter round-trip |

## 🔒 Security

- 撤銷的 .key client 啟動時直接拒絕（30 天 grace 防拔網路繞過）
- Plugin marketplace 用 SHA-256 + Ed25519 雙重驗證；URL 限 github.com；path traversal 防護
- 預設信任專案自己的 publisher key（`license-tools/public-key.pem`），其他都要 admin 明確 add trust

## 📈 Testing

| 層 | 數量 | 跑法 |
|---|---|---|
| Node unit | 87 | `cd node-express && npm test`（秒級） |
| License-server unit | 55 | `cd license-server && npm test`（需 npm install） |
| Integration round-trip | 6 adapter | `cd integration && docker compose up -d && npm test`（~3 min） |

整合 CI workflow `.github/workflows/integration.yml` path-filtered，只在 adapter / integration 改動時跑。

## 🚀 Upgrade

```powershell
git pull
cd node-express; npm install
cd ../dotnet8; dotnet restore
cd ../license-server; npm install

# 新發行的 .key 會自動帶 lid（payload v2），舊的 v1 license 繼續有效但不能遠端撤銷
# 要啟用 marketplace：UI → 外掛商店 → 貼 GitHub URL
# 要試 integration：cd integration && docker compose up -d && npm test
```

完整變更清單看 [CHANGELOG.md](CHANGELOG.md)。

## 🙏 New dependencies

- `mongodb`、`bson`（Node，optionalDependencies）
- `ioredis`（Node，optionalDependencies）
- `MongoDB.Driver`、`StackExchange.Redis`（.NET）

---

**Full Changelog**: https://github.com/wei820528/db-migrator/compare/v1.0.0...v1.1.0
