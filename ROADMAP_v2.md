# DB Migrator — v2 Roadmap (draft)

v1 系列已收尾（7 adapter / plugin marketplace / online license / remote kill switch / DDL extras v2 / integration test）。v2 不再「補功能」，要選方向往前推。

下面是候選 themes，每個都是「3-4 週的小一輪 release」級別。建議挑 1-2 個 theme 全力做，不要全鋪。

---

## Theme A — 規模：撐大型 DB 與長期備份

針對「我的生產 DB 100GB+」「我要 30 天備份歷史」「我要備份到 S3」這類需求。

| Phase | 子項 | 狀態 |
|---|---|---|
| 1 | Dump 加密（AES-256-GCM + scrypt KDF） | ✓ done — 24 tests |
| 2 | Cloud destination（S3 / MinIO / R2，optional @aws-sdk/client-s3） | ✓ done — 23 tests |
| 3 | Streaming encrypt + multipart S3 upload（lib-storage @ 100MB+） | ✓ done — 14 tests (10 streaming + 4 multipart) |
| 4 | 歷史保留 + time-travel restore（per-schedule subdir + retentionCount/Days） | ✓ done — 17 tests |
| 5 | Resumable dump/restore（中斷後續傳 — checkpoint 寫入 dump header） | pending |
| 6 | Incremental backup（基準 dump + delta — row hash / timestamp 比對） | pending |

**主要受眾**：實際把 DB Migrator 跑在 production 的客戶。
**最大風險**：incremental backup 邏輯複雜，5 個 adapter 都要對。

**狀態**：✓ **Phase 1-4 完成**（v1.4.0 ship）— encrypt-at-rest dump + S3 multipart streaming 上線；scheduled backup per-schedule history + retention + time-travel restore 就緒。整條 dump → encrypt → upload 沒 in-memory buffer（RAM O(1)）。Phase 5/6 留給 v1.5/v2.0 — 一般使用者用不到。

---

## Theme B — Cross-DB migration

目前只支援 same-DB round-trip（MySQL → MySQL）。v2 加跨 DB 型別的真實遷移。

**Scope**：MySQL ↔ PostgreSQL ↔ SQLite 三角（6 個方向）。MSSQL / Mongo / Redis 不在這 round。

| Phase | 子項 | 狀態 |
|---|---|---|
| 1 | IR + type mapping + dialect emitter（含 lossy warnings） | ✓ done — 56 tests pass |
| 2 | `getSchema(conn)` per adapter + neutral JSONL dump + value encoder | ✓ done — 25 tests (4 skip 需 npm install) |
| 3 | `tables.js` + `restoreNeutral` per adapter（parameterized INSERT，無 escaping） | ✓ done — 26 tests (3 skip 需 npm install) |
| 4 | Dry-run preview UI + `/api/cross-db/preview-live` + 跨 DB tab | ✓ done — 13 tests + UI |
| 5 | Integration matrix（6 方向 e2e round-trip + CI） | ✓ done — `integration/run-crossdb.js` |

**主要受眾**：真的要把 DB 從 MySQL 搬到 PG 的人。**契合專案名字** — 叫 "DB Migrator" 結果只做 same-DB 有點怪。
**最大風險**：型別組合爆炸；可能要限制成「MySQL ↔ PG ↔ SQLite」三角，先不碰 MSSQL。

**狀態**：✓ **完成** — Phase 1-5 全收尾、120 個 unit test、6 個 e2e 方向 CI 自動跑。下一輪可考慮：(a) MSSQL 加進三角變四角 (b) FK 跨 DB 保留（要做 deferred constraint emission）(c) cross-DB live migration 一鍵執行 endpoint（目前只有 preview）。

---

## Theme C — Automation：CLI + API

目前只有 web UI。v2 加 CLI 與 stable API，讓使用者把 dump/restore 寫進 cron / CI / scripts。

| Phase | 子項 | 狀態 |
|---|---|---|
| 1 | `dbmigrator` CLI（8 subcommands，純 Node 零外部 deps） | ✓ done — 25 tests |
| 2 | Long-running API tokens（`dbmt_…`，portal 自助管理 + scope guard） | ✓ done — 19 tests |
| 3 | OpenAPI 3.0 specs + Swagger UI（兩個 server，CDN-loaded） | ✓ done — 14 tests |
| 4 | HMAC-signed webhook delivery（job.done / failed / schedule.*）| ✓ done — 19 tests |
| 5 | GitHub Action wrapper（composite + 3 example workflows）| ✓ done — 16 tests |

**主要受眾**：DevOps 想把備份排進 CI/CD pipeline 的客戶。
**最大風險**：CLI binary 跨平台打包（pkg / single-binary）有點吵；放棄 pkg 改純 Node script 簡單但要先裝 Node。

**狀態**：✓ **完成** — Phase 1-5 全收尾、93 個 unit test。CLI / token / OpenAPI / webhook / GitHub Action 都在線。下一輪可考慮：(a) pkg / Bun 打包成單檔 binary，免裝 Node (b) license-server 的 admin webhook（user kicked / payment failed → POST 通知）(c) GraphQL 介面 alongside REST。

---

## Theme D — Plugin sandbox + capability model

目前 plugin = full Node process access。v2 把 plugin 關進沙盒，按 manifest 宣告權限。

| Phase | 子項 | 狀態 |
|---|---|---|
| 1 | Capability manifest（11 種 permission）+ marketplace UI 知情同意 + signer 驗 + `.granted-permissions.json` | ✓ done — 18 tests |
| 2 | worker_thread 隔離 + SDK ctx + route MVP（崩潰隔離、event loop 隔離） | ✓ done — 14 tests |
| 3 | Require gate — plugin 自家 require() 按 permission 過濾 Node builtins | ✓ done — 16 tests |
| 4 | Persistent audit log (SQLite) + wrap `new Worker()` 防 nested escape | ✓ done — 14 tests (12 SQLite + 2 worker gate) |
| 5 | Migration / compat（legacy plugin 自動 grandfather 成 `unrestricted`） | ✓ partial — 偵測在 Phase 1，warn flag legacy=true |

**主要受眾**：開放 plugin marketplace 給第三方時的安全護欄。
**最大風險**：Node 沒有真正的 sandbox（vm2 deprecated, isolated-vm 難用），worker thread 也只是 process 內隔離。要做就是大工程。

**狀態**：✓ **完成** — Phase 1-4 全 ship。manifest `sandboxed: true` 的 plugin 跑在 worker_thread；require gate 攔 builtin；nested-worker spawn 一律 throw（即使 unrestricted）；require-denied / worker-spawn-attempt / route-mount / handler-error 全進 SQLite audit log，可 query `/api/plugin-audit`。
**仍未擋（要 OS-level sandbox 才行）**：`process.dlopen` / `process.binding` native escape、`Atomics + SharedArrayBuffer` 跨 thread。下一輪可考慮：(a) per-plugin event loop watchdog；(b) per-plugin memory cap；(c) plugin marketplace audit dashboard UI。
Sample [plugins/sandboxed-hello/](node-express/plugins/sandboxed-hello/) 含 `/try-fs` demo 看 gate 動作。

---

## Theme E — Observability + ops

把 client + license server 變得更「production-ready」。

| Phase | 子項 | 狀態 |
|---|---|---|
| 1 | Prometheus `/metrics` + structured logger + `/healthz` v2（node-express 端） | ✓ done — 21 tests |
| 2 | License-server `/metrics` + `/healthz`（含 critical vs informational components） | ✓ done — 12 tests |
| — | OpenTelemetry trace | pending |
| — | Admin alert webhook（License server 偵測 N 個 kicked → webhook） | pending |

**主要受眾**：把 DB Migrator 當 internal tool 跑的中型團隊。
**最大風險**：低；都是純加法，不會動現有功能。

**狀態**：✓ **完成**（Phase 1+2）— 兩個 server 都吐 Prometheus metrics + healthz；hand-written exposition format zero-dep；critical-vs-informational 區分讓「SMTP 沒設」不會讓 license-server 看起來掛了。下一輪可考慮：(a) OTel trace（dump / restore 變 span） (b) Admin alert webhook（24h 內 N 個 kicked → 通知 ops）。

---

## 建議拼盤

幾種典型組合：

1. **「Production 上線」組合**：A + E — 撐得起大 DB + 看得到健康狀態
2. **「擴大用戶面」組合**：B + C — 跨 DB 遷移 + CLI 自動化，吸引新使用者
3. **「marketplace 開放」組合**：D 單獨 — 把 plugin 商店做安全，未來能對外開放
4. **「all in 規模」組合**：A + C — 大 DB + 自動化，產品定位最清楚

---

## 沒列的東西（不打算做）

- Multi-tenant license server — 跟現在 admin 模型衝突大；除非真有 SaaS 化需求
- 多 region license server replication — overkill until > 5000 客戶
- 內建 backup encryption key management — 用 cloud KMS 比自己做安全
- 完全寫死的 backup schedule（cron expression）— 現在「每 N 小時 / 每天 HH:MM」夠用
- iOS / Android app — 不是 web 工具的競爭優勢

---

> 下一步：挑 1-2 個 theme，定 v2.0.0 範圍，開新 milestone。
