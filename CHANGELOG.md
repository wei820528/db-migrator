# Changelog

All notable changes to this project will be documented in this file.

格式參考 [Keep a Changelog](https://keepachangelog.com/zh-TW/1.1.0/)，版本採用 [SemVer](https://semver.org/lang/zh-TW/)：`MAJOR.MINOR.PATCH`。

- `MAJOR` — 不相容的 API / 行為變更
- `MINOR` — 向下相容的新功能
- `PATCH` — 向下相容的 bug 修正

## [Unreleased]

(no pending changes)

## [1.2.0] - 2026-05-18

v2 Theme B + Theme C 收尾：跨 DB 遷移管線（mysql ↔ postgres ↔ sqlite 6 個方向 e2e）+ 完整 automation 套件（CLI / API tokens / OpenAPI / webhook / GitHub Action）。Node unit test 87 → 240；CLI 全新 41 tests；License-server pure 34 → 53。

### Added — Cross-DB migration (v2 Theme B)

- **IR + dialect emitter**（[lib/cross-db/](node-express/lib/cross-db/)）：12 種 normalized `kind`（int / float / decimal / string / text / binary / bool / date / datetime / time / json / uuid / enum + unknown 兜底）；`normalize(dialect, src) → IR`、`emit(IR, target) → {sql, warnings}`；lossy 一律 warn 不 throw（PG 拓寬 unsigned int、SQLite 丟 sign、JSON → TEXT 等）
- **Neutral JSONL dump format**（neutral-v1）：3 種 event（header / schema / row），value 編碼 schema-guided 不用 `$type` wrapper（避免跟 JSON column 內容衝突）；BigInt safe-range / Date ISO / Buffer base64 / decimal 字串都涵蓋
- **Per-adapter `getSchema(conn)` + `dumpNeutral` + `restoreNeutral`**：mysql / postgres / sqlite 三個；restore 用 parameterized INSERT（不用自寫 escape）；auto-increment 在三個方言都正確（mysql AUTO_INCREMENT / pg SERIAL / sqlite INTEGER PRIMARY KEY AUTOINCREMENT）
- **`tables.js`**：IR table → target-dialect `CREATE TABLE` + `CREATE INDEX`，PK 隱含 NOT NULL（標準 SQL），SQLite 單欄 PK 自動 inline
- **Dry-run preview**：`POST /api/cross-db/preview-live`、UI 新「跨 DB 遷移」tab，per-table 卡片含 column 對映表 + 摺疊 DDL + warnings inline
- **Integration matrix**：`integration/run-crossdb.js` 跑 6 個方向 e2e round-trip（docker-compose × MySQL 8.4 / PG 16 / SQLite）；CI workflow 自動跑

### Added — Automation (v2 Theme C)

- **`dbmigrator` CLI**（[cli/](cli/)）：8 個 subcommand（test / list-dbs / list-tables / export / import / dump-neutral / restore-neutral / preview-crossdb）；純 Node script 零外部 deps；`--password-env` 優於 `--password` 避免 shell history 洩漏；`--json` machine-readable 模式；`--config <file.json>` 一份設定多個指令共用
- **Long-running API tokens**：`dbmt_<random>` GitHub-PAT 風格，SHA-256 hash 儲存；scope guard（user:read / user:write）；token-chain 防護（用 API token 不能再建 / 撤新 token）；portal UI 自助管理 + `last_used_at` / `last_used_ip` 追蹤
- **OpenAPI 3.0 specs**：兩個 server 各自一份 `openapi.json`（手寫 + spec ↔ route 漂移 test），CDN-loaded Swagger UI at `/api-docs/`（無 npm 新增 dep）
- **HMAC-signed webhook delivery**：5 種 event（job.done / job.failed / schedule.run.{ok,failed} / license.expired）+ ping；secret 加密儲存 (AES-256-GCM)；HMAC-SHA256 簽 body，header `X-DBMigrator-Signature: sha256=...`；3 次 retry（0 / 2 / 10s 間隔）；test-ping 按鈕；UI 顯示最後狀態 + error sample
- **GitHub Action** at repo root（[action.yml](action.yml)）：composite action 包 CLI，password 自動走 env 不落到 command line；3 個 ready-to-use workflow templates（[examples/github-actions/](examples/github-actions/)）— daily backup、cross-DB preview on PR、restore on tag

### Changed

- License-server `routes/user.js` 的 `currentUser()` 現在同時接受 session bearer 跟 `dbmt_` API token，自動觸發 `last_used_at` 更新
- Adapter `getSchema` 每個 column 加 `sourceTypeRaw`（保留 dialect 原始字串，給 UI preview 顯示用）

### Fixed

- Cross-DB Phase 1 開發時抓到的 normalizeMySql 把 ENUM 值大小寫毀掉的 bug（`toUpperCase()` 蓋過 enum literal）— 改成從原始 src 拉 values
- Phase 3 開發時抓到的 tables.js dialect alias 不一致 — `'pg'` / `'supabase'` 不會 normalize 成 `'postgres'`，導致 PG SERIAL 多了 NOT NULL；加 `normalizeTarget()` 統一

### Docs

- **繁體中文註解翻譯**：v2 Theme B 所有新檔（lib/cross-db/* + adapter cross-db sections + routes + UI module）；保留 warning / log / error 訊息用英文（machine-greppable）
- ROADMAP_v2.md：Themes B + C 標 ✓ 完成；Themes A / D / E 仍 pending
- 新增 [examples/github-actions/README.md](examples/github-actions/README.md)
- 兩份 OpenAPI spec 都可在 `/api-docs/` 互動瀏覽 + Try It Out

## [1.1.0] - 2026-05-18

P3 全數收尾：兩個新 adapter、一個 plugin 商店、licence 遠端撤銷、DDL 大補、real-DB integration 測試。Node unit test 從 37 → 87；License-server 49 → 55。

### Added
- **Integration tests（docker-compose × 6 DB containers）**：
  - 新資料夾 [integration/](integration/)：`docker-compose.yml` 起 mysql 8.4 / postgres 16 / mssql 2022 / mongo 7 / redis 7（sqlite 用本機檔）
  - [integration/run.js](integration/run.js) — round-trip orchestrator：每 adapter 跑 `seed → adapter.dump → parseTableNamesFromDump → drop → adapter.restore → verify`，exit code CI-friendly
  - [integration/helpers/fixtures.js](integration/helpers/fixtures.js) — 每個 adapter 一套 seed/drop/verify（含 FK、unique index、hash、set 各種型別）
  - `npm test` / `npm run test:sql` / `npm run test:nosql` 三種子集；`node run.js mysql redis` 指定單跑
  - **CI workflow** [.github/workflows/integration.yml](.github/workflows/integration.yml)：path-filtered（只在 adapter / integration 變動時跑），失敗時上傳 dumps + container logs 當 artifact
  - 為什麼需要：unit test 蓋格式正確性，integration 蓋「driver × adapter」邊角 — 之前抓到 MSSQL bracket 與 IP wildcard bug 就是 integration 級的問題

- **DDL extras v2（views / procedures / functions / sequences / events）**：
  - **MySQL**：views (`SHOW CREATE VIEW`)、stored procedures (`SHOW CREATE PROCEDURE`)、functions (`SHOW CREATE FUNCTION`)、events (`SHOW CREATE EVENT`)、triggers 改用 routine marker
  - **PostgreSQL**：sequences (含 `setval()` 還原 last_value)、views (`pg_views`)、functions / procedures (`pg_get_functiondef`，prokind `f`/`p`)
  - **SQL Server**：views、stored procedures (sys.procedures)、functions (sys.objects type IN `FN`/`IF`/`TF`/`FS`/`FT`)，全部用 `OBJECT_DEFINITION` 抓 body
  - **SQLite**：已有 views（無新增）
  - **ROUTINE_BEGIN / ROUTINE_END 標記**：MySQL/PG 的 routine body 含內部 `;`，用 marker 包起來；restore 端 `extractRoutineBlocks()` 整段送 driver，不踩半形分號雷
  - **MSSQL** 直接用 `GO` batch separator（既有 restore 已支援，不需 marker）
  - **Node + .NET 對等**：兩邊 SQL 格式 byte-compatible，可互相 restore
  - 共用 helper `extractRoutineBlocks(text)` 在 `_shared.js` / `SqlHelpers.cs`
  - 8 個 splitter test（無 routine / 中間夾 routine / 連續 routine / 5 段交錯 / 沒 END 的 dangling / 多 `;` body / 空 input / 字串中假命中）

- **C-07 Plugin marketplace（從 GitHub 一鍵裝 plugin）**：
  - **Manifest 格式**：`plugin.json` 含 name / version / files / hashes (SHA-256) / signature (Ed25519, optional)；統一 canonical-JSON 簽章流程（Node + .NET 同步）
  - **Signer 工具**：[license-tools/sign-plugin.js](license-tools/sign-plugin.js) — 用同一把 license-tools key 簽 plugin manifest
  - **Trust model**：白名單 publisher PEM 存 `trusted-publishers.json`；預設信任專案本身的 license-tools key；admin 可加 / 刪 publisher
  - **三段式驗證**：(1) URL 必須是 `github.com/owner/repo[/tree/branch]`；(2) 每檔 SHA-256 跟 manifest 對比；(3) 簽章對信任名單驗 Ed25519
  - **Install flow**：UI 預覽（顯示檔案 + 簽章狀態）→ 確認 → 寫到 staging dir → atomic rename 到 `plugins/<name>/`，pluginHost 自動 hot reload
  - **未簽章 plugin**：UI 顯示紅色 badge + 強制使用者勾選「我已檢查過原始碼」才能安裝
  - **Path safety**：拒絕絕對路徑 / 磁碟機字母 / `..` / 非 `[a-z0-9_./-]` 字元；裝完還會 `isInside()` 雙重檢查
  - **API**：`POST /api/marketplace/preview` / `/install`、`GET/DELETE /installed[/:name]`、`GET/POST/DELETE /trusted[/:id]`
  - **Node + .NET 對等**：Node 用 `plugins/<name>/`，.NET 用 `Plugins/marketplace/<name>/`；trust file 共用 JSON 格式
  - 22 個 unit test（URL parse、path safety、canonical JSON、manifest validation、signature trust / untrust path）

- **C-08 NoSQL adapters（MongoDB + Redis）**：
  - **MongoDB**：JSONL/EJSON dump 格式（canonical extended JSON 保留 BSON 型別 ObjectId / Date / Binary / Decimal128）；events `header` / `collection` / `insert`；restore drop → createCollection → createIndexes → insertMany；listCollections（含 view 過濾）
  - **Redis**：純文字 command dump（`SET / RPUSH / SADD / ZADD / HSET / PEXPIRE`），跟 redis-cli 相容；list/set/zset/hash 整批寫成一行；TTL 用 PEXPIRE 保留；listTables 把 keys 按 `<prefix>:` 分群（無前綴 → `_root`）
  - 兩個 adapter 都實作各自的 `filterDumpByTables`，Mongo 過濾 JSONL events、Redis 過濾 key namespace；import route 自動偵測 adapter override，SQL 系列保持原本 `filterSqlByTables`
  - **Node + .NET 對等**：dump 格式 byte-compatible，可互相 restore；`ioredis` + `mongodb` (Node) / `StackExchange.Redis` + `MongoDB.Driver` (.NET)；Node 用 `optionalDependencies` 避免硬依賴
  - 新 .NET interface `FilterResult? FilterDumpByTables(string, List<string>)` 預設 return null（fallthrough 到 SQL filter）
  - UI 新增 MongoDB / Redis 卡片 + `TYPE_DEFAULTS` / `HOST_HINTS`；Mongo Atlas 把 `mongodb+srv://...` 整段貼到 Host 即可（自動偵測）；Redis Database 欄位用 0-15 選 logical DB
  - 10 個格式測試（parse + filter + Redis 的 tokenize/quote）

- **Remote kill switch（offline license 遠端撤銷）**：
  - `license-tools/issue-license.js` 在 payload 內加 `lid`（UUID）與可選 `rurl`（revocation URL），所有新發行的 .key 都帶；payload `v` 升到 2
  - License Server 新表 `issued_licenses(id, customer, plan, issued_at, expires_at, revoked_at, revoke_reason)` + 公開 `GET /api/revocation/list`、`GET /api/revocation/check`
  - Admin 面板新增 **🔑 Licenses** 分頁：列出已發行 license、一鍵撤銷 / 解除撤銷、註冊新 license（手填 UUID 或 `import-licenses` 從 `issued-licenses.jsonl`）
  - Admin CLI：`list-licenses` / `add-license` / `import-licenses` / `revoke-license` / `unrevoke-license`
  - Client（Node + .NET）每 24 小時 phone home 取撤銷清單，cache 到 `.revocation-cache.json`；命中 `lid` → status `revoked` → gate 回 403
  - 30 天 grace：拿不到清單超過 30 天就拒絕啟動（避免有人靠拔網路繞過）；< 30 天就繼續放行
  - 舊版 v1 license（沒 `lid`）向下相容，不做 revocation check
  - 環境變數 `LICENSE_REVOCATION_URL` 可覆蓋 payload 內的 `rurl`
  - 10 個 client cache test（grace / fresh / stale / fetch / malformed payload）+ 6 個 server 端 test

### Planned (next)
(P3 全數完成 — 沒有 backlog)

## [1.0.0] - 2026-05-17

第一個對外正式 release。整合 v0.1.0 後所有 P0 / P1 / P2 功能 + 71 個自動測試。

### Added — 商業 / 授權

- **Online license server**：獨立 Node.js + SQLite 服務，含完整 admin web UI（Dashboard / Users / Sessions / Events / Settings）
- **三種授權模式**：offline (Ed25519)、online (heartbeat)、disabled (dev)
- **IP 偵測踢人**：同帳號換 IP 自動踢前一台；同時可用裝置數 per-plan
- **Plan + features**：trial (7 天 / 1 台 / 不能多 DB 匯) / basic / team (5 台) / enterprise；定義在 `plans.js`
- **Email 驗證**：nodemailer SMTP；無 SMTP 時 dev mode 印 console
- **Rate limit**：5 分鐘 20 req per IP on `/api/auth/*`
- **IP 白名單**：per-user，支援 CIDR / wildcard / 精確
- **Free month override**：admin 可給特定使用者免費月份（自動套用 team 級 features）
- **Stripe**：Checkout sessions + webhook（checkout.session.completed / invoice.paid / customer.subscription.deleted）
- **綠界 (ECPay)**：CheckMacValue + 表單 payload builder + return 驗章；支援信用卡 / ATM / 超商繳費
- **2FA (TOTP)**：Authenticator app 掃 QR；login 兩步驟驗證；可用密碼 fallback 停用
- **使用者面板 (portal)**：客戶自助看 plan / 在線裝置 / 強制踢出其他 / 改密碼 / 升級
- **Admin CLI**：create-user / list / revoke / kick-all / set-plan / reset-trial / make-admin / set-free / list-events / list-sessions
- **Bootstrap admin**：`ADMIN_EMAIL` + `ADMIN_PASSWORD` env 第一次啟動自動建 admin

### Added — DB Migrator 核心

- **完整 DDL 匯出**（C-02）：四種 DB 都補 FK / 次要 index / trigger；SQLite + view；輸出順序放在資料 INSERT 之後 → restore 時 FK 不卡 ordering
- **部分 table 多選匯入**（C-01）：UI 上的 checkbox 真的篩選 SQL；header (`SET` / `BEGIN`) 永遠保留；支援 `host\instance` 風格的 schema-qualified names
- **Job 持久化**（R-03）：jobs 改 SQLite (`jobs.db`)；server 重啟 → 未完 job 標 `error: Server restarted`；7 天 TTL 自動清
- **排程備份**（C-09）：UI 上設「every N hours」或「daily at HH:MM」；DB 密碼 AES-256-GCM 加密；輸出到 `scheduled-backups/`；含 in-app run-now + 檔案下載
- **tmp 自動清理**（R-04）：每 6 小時掃 tmp/，>24 小時的 job dir / upload 自動刪
- **.NET online 客戶端整合**：跟 Node 完全對等的 login / heartbeat / feature gate

### Added — 架構 / 開發體驗

- **拼圖式 plugin**（Node + .NET）：route + adapter + UI cards / tabs + static assets，Node 版支援 hot reload
- **前端模組化**（R-05）：app.js 從 1148 行 → 28 行 bootstrap + 12 個 `modules/*.js`
- **失敗隔離**：route / adapter / plugin 任一個壞掉，其他不受影響；狀態從 `/api/modules` 看
- **75+ 個自動測試**（B-01）：node-express 37（filter / encrypt / format / split / extract / parse），license-server 35 + 14 TOTP（CIDR / plans / schedule expr / ECPay encoder & mac / TOTP verify）；用 Node 18+ 內建 `node:test`，無 framework 依賴

### Added — 文件

- **12 份頂層 HTML 文件**（[文件/](文件/)）：
  - 方案首頁、架構展示、區塊參考、技術文件、程式碼對應、操作文件、使用手冊、進度文件、重構計畫、優化擴充、HANDOVER 完整交接、共用 docs-nav
- **真實 UI 渲染**（不是假截圖）：使用手冊 + HANDOVER 內的「截圖」用 `screenshots.css` 把真實 HTML 嵌進來，零誤差
- **跨文件 nav bar** + 滾動進度條
- 統一橘 / cream PolyForm 風格，可選擇深色片段
- **License Server / Plugin / 客戶 portal** 各自 README

### Fixed

- CSS `[hidden]` 被 `.form-grid { display: grid }` 蓋過 → 加 `[hidden] { display: none !important; }`
- MSSQL `Login failed` 錯誤訊息空白 → 從 `SqlException.Errors[0].Message` 撈內層
- 前端送 `port: ""` (空字串) → .NET `int` 反序列化失敗 → 前端見 `undefined` → 改前端傳 0 + 後端 fallback
- **B-01 測試發現**：MSSQL bracket `[users]` 在 `extractTableName` 被解析錯誤 → 真實影響 C-01 在 MSSQL 上 filter 失效
- **B-01 測試發現**：IP 白名單 `192.168.*` 之前**不會** match `192.168.1.100` → 客戶設規則後連不進來
- SQL Server 命名 instance (`HOST\INSTANCE`) + Windows / SQL 雙驗證模式（之前完全沒實作）

### Changed

- License key 機制：原本只 Ed25519 簽章 → 加上 online 模式（IP 偵測 + 多裝置 + plan feature gate）
- HTML 文件統一改為 PolyForm cream + 橘色主題（之前綠 / 藍漸層各檔不一致）

### Security

- 密碼：bcrypt 10 rounds
- TOTP secret：AES-256-GCM 加密儲存
- 排程備份的 DB 密碼：同上 AES-256-GCM
- License server cookies：HttpOnly + SameSite=Lax + Secure (HTTPS)
- Rate limit + IP 白名單 + 2FA 三層防護

## [0.1.0] - 2026-05-15

第一個對外可裝可用的版本。

### Added
- Node.js + Express 與 .NET 8 兩個對等版本，前端 UI 共用
- 純 driver 的 5 個 DB adapter：MySQL / MariaDB、PostgreSQL、SQL Server、SQLite、Supabase
- SQL Server 命名 instance + Windows / SQL 雙驗證
- 連線測試自動列出 DB；多選 checkbox UI
- 多 DB 匯出 → zip 打包
- 匯入 inspect 顯示「已存在 / 不存在」對照表
- 專案備份 / 還原（code + DB + Supabase Storage）+ manifest.json
- 互動式新手指引（tour）
- HTML 線上文件（/docs/）
- localStorage 連線記憶（10 組）
- PolyForm Free Trial 1.0.0 授權 + Ed25519 license key 機制
- 商業條款（COMMERCIAL.md / CONTRIBUTING.md / SECURITY.md）

[Unreleased]: https://github.com/wei820528/db-migrator/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/wei820528/db-migrator/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/wei820528/db-migrator/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/wei820528/db-migrator/compare/v0.1.0...v1.0.0
[0.1.0]: https://github.com/wei820528/db-migrator/releases/tag/v0.1.0
