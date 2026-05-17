# DB Migrator — v2 Roadmap (draft)

v1 系列已收尾（7 adapter / plugin marketplace / online license / remote kill switch / DDL extras v2 / integration test）。v2 不再「補功能」，要選方向往前推。

下面是候選 themes，每個都是「3-4 週的小一輪 release」級別。建議挑 1-2 個 theme 全力做，不要全鋪。

---

## Theme A — 規模：撐大型 DB 與長期備份

針對「我的生產 DB 100GB+」「我要 30 天備份歷史」「我要備份到 S3」這類需求。

| 子項 | 為什麼 | 工作量 |
|---|---|---|
| Streaming / chunked dump | 目前是單檔；100GB+ 會吃完 disk + RAM。改 multi-file chunk + 並行 worker | 中 |
| Resumable dump/restore | 中斷後續傳（checkpoint 寫入 dump file header） | 中 |
| Incremental backup | 基準 dump + 後續 delta（row hash 或 timestamp 比對） | 大 |
| Cloud destination | S3 / GCS / Azure Blob 當 scheduled backup 目的地 | 小 |
| Dump 加密 | AES-256-GCM 加密 dump 檔；password 或 key file | 小 |
| 歷史保留 + time-travel | UI 上選日期還原 (`schedule` 留 30 個版本) | 中 |

**主要受眾**：實際把 DB Migrator 跑在 production 的客戶。
**最大風險**：incremental backup 邏輯複雜，5 個 adapter 都要對；可能要先做 streaming 再考慮 incremental。

---

## Theme B — Cross-DB migration

目前只支援 same-DB round-trip（MySQL → MySQL）。v2 加跨 DB 型別的真實遷移。

| 子項 | 為什麼 | 工作量 |
|---|---|---|
| Type mapping table | MySQL `int unsigned` → PG `bigint`、`varchar(N)` → PG `varchar(N)`、`TINYINT(1)` → PG `boolean` 等 | 中 |
| DDL translator | 把 source 的 `CREATE TABLE` 解析後重組成 target 方言 | 大 |
| Data converter | enum / bit / spatial / json 之間的轉換 | 中 |
| Dry-run preview | 顯示「哪些 column 會被截斷、哪些 enum 沒對應」讓使用者先看 | 中 |
| 跨 DB 規模測試 | integration test 加 cross 矩陣（mysql ↔ pg ↔ mssql ↔ sqlite） | 中 |

**主要受眾**：真的要把 DB 從 MySQL 搬到 PG 的人。**契合專案名字** — 叫 "DB Migrator" 結果只做 same-DB 有點怪。
**最大風險**：型別組合爆炸；可能要限制成「MySQL ↔ PG ↔ SQLite」三角，先不碰 MSSQL。

---

## Theme C — Automation：CLI + API

目前只有 web UI。v2 加 CLI 與 stable API，讓使用者把 dump/restore 寫進 cron / CI / scripts。

| 子項 | 為什麼 | 工作量 |
|---|---|---|
| `dbmigrator` CLI（Node 二進位） | `dbmigrator export --type mysql --host x --to file.sql` | 中 |
| 公開 REST API spec（OpenAPI） | 目前 endpoint 是內部用；公開後寫整合更容易 | 小 |
| Webhook | dump 完成 / 排程失敗 → POST 到使用者指定 URL | 小 |
| Long-running token | API token（非 session）用來給 cron / CI 拿 | 小 |
| GitHub Action | `actions/db-migrator@v2` 包裝 CLI，CI 一鍵備份 | 小 |

**主要受眾**：DevOps 想把備份排進 CI/CD pipeline 的客戶。
**最大風險**：CLI binary 跨平台打包（pkg / single-binary）有點吵；放棄 pkg 改純 Node script 簡單但要先裝 Node。

---

## Theme D — Plugin sandbox + capability model

目前 plugin = full Node process access。v2 把 plugin 關進沙盒，按 manifest 宣告權限。

| 子項 | 為什麼 | 工作量 |
|---|---|---|
| Capability manifest | `permissions: ["routes", "db:read", "fs:tmp"]`，沒寫的就拒絕 | 小 |
| Worker thread 隔離 | Plugin 跑在 worker_thread，只能透過 message port 跟 main 通信 | 大 |
| API surface 受限 | Plugin 只看得到我們開的小 SDK（`ctx.db`, `ctx.route`, `ctx.log`），其他 require 擋掉 | 大 |
| Permission UI | 安裝時 UI 顯示 plugin 要的權限，使用者勾選 | 小 |
| Audit log | 每次 plugin 呼叫敏感 API 都進 event log | 小 |

**主要受眾**：開放 plugin marketplace 給第三方時的安全護欄。
**最大風險**：Node 沒有真正的 sandbox（vm2 deprecated, isolated-vm 難用），worker thread 也只是 process 內隔離。要做就是大工程。

---

## Theme E — Observability + ops

把 client + license server 變得更「production-ready」。

| 子項 | 為什麼 | 工作量 |
|---|---|---|
| Prometheus `/metrics` | 排程跑了幾次、平均 dump 大小 / 時間、license fetch 次數 | 小 |
| Structured log (JSON) | 取代現在的 console.log，方便餵 ELK / Loki | 小 |
| OpenTelemetry trace | dump / restore 變 span，能在 Jaeger 看 | 中 |
| Health endpoint v2 | `/healthz` 帶 adapter + DB + license server 狀態 | 小 |
| Admin alert webhook | License server 偵測到「24h 內有 N 個 kicked」就 webhook 通知 | 小 |

**主要受眾**：把 DB Migrator 當 internal tool 跑的中型團隊。
**最大風險**：低；都是純加法，不會動現有功能。可當 v2.0 的「順手做」。

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
