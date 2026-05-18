# DB Migrator v1.2.0

兩個 v2 theme 一次到位 — **跨 DB 遷移管線**（mysql ↔ postgres ↔ sqlite 三角 6 個方向 e2e）+ **完整 automation 套件**（CLI / API tokens / OpenAPI / webhook / GitHub Action）。

> 從 v1.1.0 升級 no breaking change — Web UI / 既有 license 都照舊。新功能都是 opt-in。

## ✨ Highlights

- **跨 DB 遷移**：MySQL ↔ PostgreSQL ↔ SQLite，dry-run preview 看 lossy translations、一鍵 dump 到 neutral JSONL 再 restore 到任何目標 dialect
- **`dbmigrator` CLI**：純 Node 零外部 deps，8 個 subcommand 蓋住所有日常操作，cron / CI friendly
- **GitHub Action**：`uses: wei820528/db-migrator@v2` 一行接管備份 / 還原 / preview
- **API tokens**：`dbmt_<random>` GitHub-PAT 風格，portal 自助管理 + scope guard
- **HMAC-signed webhooks**：job done / failed / schedule 事件自動 POST 通知
- **OpenAPI 3.0 + Swagger UI**：兩個 server 都在 `/api-docs/` 開放互動 reference
- **測試規模**：Node unit 87 → **240**；CLI 全新 41；License-server pure 34 → 53

## 📦 New surfaces

| Surface | 用途 |
|---|---|
| [cli/](cli/) | `dbmigrator` 命令列工具（自帶 README + 41 test）|
| [action.yml](action.yml) | GitHub composite action 入口 |
| [examples/github-actions/](examples/github-actions/) | 3 個 ready-to-use workflow templates |
| [openapi.json × 2](node-express/openapi.json) | 兩個 server 各自的 OpenAPI 3.0 spec |
| [/api-docs/](node-express/public/api-docs/) | Swagger UI（CDN-loaded，無 npm dep）|
| [node-express/lib/cross-db/](node-express/lib/cross-db/) | IR + emitter + format + preview helpers |
| [node-express/lib/webhooks.js](node-express/lib/webhooks.js) | HMAC delivery + retry + secret enc |
| [license-server/lib/tokens.js](license-server/lib/tokens.js) | API token generate / hash / scope guard |

## 🔒 Security

- **API tokens**：高熵 random，SHA-256 hash 儲存（不用 bcrypt — 太慢且不需要）；token-chain 防護（用 token 不能再建/撤新 token）；prefix `dbmt_…` 設計成可被 leak detection scanner 抓到
- **Webhook secrets**：`whsec_<random>` AES-256-GCM 加密儲存；HMAC-SHA256 簽 body；receiver 端驗章範例直接寫進 OpenAPI 文件
- **GitHub Action**：password / source-password 一律改走 `--password-env` 不落到 command line

## 🚀 Upgrade

```powershell
git pull

# Node client（webhook + cross-db 都需要 better-sqlite3 已裝）
cd node-express; npm install

# License server（API token table 自動 CREATE IF NOT EXISTS）
cd ../license-server; npm install

# 全新 CLI（也可全域 link）
cd ../cli; npm link
dbmigrator --version
```

要試 GitHub Action：把 [examples/github-actions/](examples/github-actions/) 內的 yml 搬到你自己 repo 的 `.github/workflows/`，加上對應 secrets 就動了。

## 📈 Testing

| 層 | 數量 | 跑法 |
|---|---|---|
| Node unit | 240 (229 pass + 11 skip 需 npm install) | `cd node-express && npm test` |
| CLI unit | 41 全 pass | `cd cli && npm test` |
| License-server unit | 53 pure pass + 21 需 npm install | `cd license-server && npm test` |
| Cross-DB e2e matrix | 6 個方向 | `cd integration && docker compose up -d && npm run test:crossdb` |
| Adapter same-DB e2e | 6 個 adapter | `cd integration && npm test` |

CI workflow 自動跑前兩個 + 全部 integration（path-filtered）。

## 🆕 New endpoints quick reference

**License Server**
- `POST /api/user/tokens` — 建立 API token（response 含明文，僅此一次）
- `GET /api/user/tokens` — 列表
- `DELETE /api/user/tokens/:id` — 撤銷

**DB Migrator client**
- `POST /api/cross-db/preview-live` — dry-run 跨 DB schema 翻譯
- `GET/POST /api/webhooks` — webhook CRUD
- `POST /api/webhooks/:id/test` — test-ping
- `GET /openapi.json` + `/api-docs/` — OpenAPI spec + Swagger UI

完整 API 看 spec：`http://localhost:3000/api-docs/`（client）/ `http://localhost:4000/api-docs/`（license-server）。

## 🙏 No new required deps

- 全部 v2 新功能用 Node 18+ 內建 API（`util.parseArgs`、`crypto.createHmac`）+ 既有 npm packages
- Swagger UI 走 CDN（jsdelivr）— 無 npm 新增 dep
- CLI 是 pure Node script — 沒有 `cli/node_modules`
- GitHub Action 是 composite action — runner 預裝的 Node 直接跑

---

**Full Changelog**: https://github.com/wei820528/db-migrator/compare/v1.1.0...v1.2.0
