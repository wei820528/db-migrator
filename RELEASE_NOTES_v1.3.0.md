# DB Migrator v1.3.0

兩個 v2 theme 一起出 — **Plugin sandbox**（worker_thread + per-permission `require()` gate）跟 **Observability**（兩個 server 都吐 Prometheus `/metrics` + 結構化 `/healthz` + JSON logger）。

> 從 v1.2.0 升級 no breaking change — Web UI / 既有 license / 既有 plugin 都照舊跑。Sandbox 是 opt-in（manifest `sandboxed: true` 才啟用）；observability endpoints 是純加法。

## ✨ Highlights

- **Plugin 跑在 worker_thread**：handler 崩潰 / `process.exit()` / event loop hang 都不會 take down 主 process
- **Per-permission `require()` gate**：沒 `fs:*` 連 `require('fs')` 都不行；denial 進 audit log，可從 `/api/plugin-audit` 查
- **Capability manifest + informed consent**：11 種權限，install 時 UI 列清楚要使用者勾選同意
- **Prometheus `/metrics`** ×2 server：hand-written exposition format zero-dep；jobs / webhooks / plugin status / user counts / sessions / api tokens / issued licenses 都覆蓋
- **Structured `/healthz`** ×2 server：critical vs informational 分開算，避免「SMTP 沒設」就讓 license-server 看起來掛了
- **JSON logger**：`LOG_FORMAT=json` 切 ELK / Loki 友善格式
- **Extensibility reference**：[文件/擴充點.html](文件/擴充點.html) — 14 個擴充點一覽
- **測試規模**：Node unit 240 → **309**；License-server pure 53 → **66**

## 📦 New surfaces

| Surface | 用途 |
|---|---|
| [node-express/lib/plugin-worker.js](node-express/lib/plugin-worker.js) | worker_thread runtime + require gate |
| [node-express/lib/metrics.js](node-express/lib/metrics.js) | Counter / Gauge / Histogram + Prometheus rendering |
| [node-express/lib/logger.js](node-express/lib/logger.js) | Structured logger（human / json） |
| [node-express/lib/healthz.js](node-express/lib/healthz.js) | 5-component health snapshot |
| [license-server/lib/{metrics,logger,healthz}.js](license-server/lib/) | Mirror 三件套（healthz 跑 license-server-specific components） |
| [node-express/plugins/sandboxed-hello/](node-express/plugins/sandboxed-hello/) | Sample plugin demo `/try-fs` gate 動作 |
| [文件/擴充點.html](文件/擴充點.html) | 完整 extension point reference（14 個） |
| `/metrics` + `/healthz` × 2 server | Public（無 license gate）給 scraper / liveness probe |
| `/api/plugin-audit` | 查 plugin 被 gate 攔的 require call |

## 🔒 Security

- **Plugin sandbox**：所有 manifest 宣告 `sandboxed: true` 的 plugin 跑在 worker；require gate 攔 `fs` / `http` / `child_process` / `vm` / `worker_threads` 等敏感 builtin，依 granted permissions 過濾
- **Audit log**：每次 gate denial 都進 event log（plugin name / module name / timestamp / caller）
- **仍未擋（需 OS-level sandbox）**：`process.dlopen` / `process.binding` native escape、`Atomics + SharedArrayBuffer` 跨 thread、plugin 內 `new Worker(code, {eval:true})` spawn 沒 gate 的子 worker。Theme D Phase 4 之後考慮 wrap Worker 構造子。
- **Observability endpoints 無 auth**：`/metrics` + `/healthz` 走 public，避免 scraper / k8s probe 拿不到。Metrics 內容只有 aggregate counts，**沒有 PII / token / email**

## 🚀 Upgrade

```powershell
git pull

# Node client（plugin sandbox / metrics 都不需新 deps）
cd node-express; npm install   # 沒新增 dep；只重跑保險

# License server（同樣不需新 deps）
cd ../license-server; npm install

# 啟用 sandbox：你自己的 plugin 加 sandboxed: true + permissions: [...] 即可
# 範本：plugins/sandboxed-hello/plugin.json
```

要把 metrics 接 Prometheus：

```yaml
# prometheus.yml
scrape_configs:
  - job_name: dbmigrator-client
    static_configs: [{ targets: ['client.internal:3000'] }]
  - job_name: dbmigrator-license
    static_configs: [{ targets: ['license.internal:4000'] }]
```

要把 healthz 接 k8s liveness：

```yaml
livenessProbe:
  httpGet: { path: /healthz, port: 3000 }
  periodSeconds: 30
```

## 📈 Testing

| 層 | 數量 | 跑法 |
|---|---|---|
| Node unit | 309 (298 pass + 11 skip 需 npm install) | `cd node-express && npm test` |
| CLI unit | 41 全 pass | `cd cli && npm test` |
| License-server unit | 66 pure pass (1 fail 需 npm install: better-sqlite3) | `cd license-server && npm test` |
| Cross-DB e2e matrix | 6 個方向 | `cd integration && docker compose up -d && npm run test:crossdb` |
| Adapter same-DB e2e | 6 個 adapter | `cd integration && npm test` |

CI workflow 自動跑前兩個 + 全部 integration（path-filtered）。

## 🆕 New endpoints quick reference

**DB Migrator client**
- `GET /metrics` — Prometheus exposition（公開）
- `GET /healthz` — JSON health snapshot（公開，200 / 503）
- `GET /api/plugin-audit` — Plugin require gate denial log

**License Server**
- `GET /metrics` — Prometheus exposition（公開）
- `GET /healthz` — JSON health snapshot（公開，200 / 503）

完整 API 看 spec：`http://localhost:3000/api-docs/`（client）/ `http://localhost:4000/api-docs/`（license-server）。

## 🙏 No new required deps

- Plugin sandbox 用 Node 18+ 內建 `worker_threads` + monkey-patch `Module.prototype.require`
- Metrics 是 hand-written Prometheus exposition format — 沒裝 prom-client
- Logger 用 Node 18+ 內建 `util.inspect`
- Healthz 用內建 `fs.statSync` + `better-sqlite3 .prepare`（已有 dep）

## 🚧 Still pending in Theme D / E

- **Theme D Phase 4**：audit log 完整化（敏感 API call → event log）+ wrap `new Worker()` 防 nested escape
- **Theme D Phase 5**：legacy plugin compat（自動 grandfather 成 `unrestricted` 已偵測在 Phase 1）
- **Theme E 後續**：OpenTelemetry trace、Admin alert webhook（24h 內 N 個 kicked → 通知）

---

**Full Changelog**: https://github.com/wei820528/db-migrator/compare/v1.2.0...v1.3.0
