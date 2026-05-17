# DB Migrator

瀏覽器操作的資料庫匯出 / 匯入 + 專案備份還原 + 排程備份工具。支援 **MySQL、PostgreSQL、SQL Server、SQLite、Supabase、MongoDB、Redis**，純 driver 實作，不需安裝任何 DB CLI。

> 💼 商業軟體 — 32 天試用（offline mode）或 7 天試用（online mode），之後需要 license。詳見 [COMMERCIAL.md](COMMERCIAL.md)。

```
匯出資料庫的bat/
├── node-express/    Node.js 18+ / Express        (客戶端 DB Migrator)
├── dotnet8/         .NET 8 / ASP.NET Core         (客戶端 DB Migrator)
├── license-server/  Node.js / SQLite              (你架在 VPS / 本機；含 Admin Web UI + Stripe + 綠界 + 2FA)
├── license-tools/   (私用) Ed25519 簽 offline license / sign plugin
├── integration/     docker-compose × 6 DB        (real round-trip tests)
└── 文件/             12 份中文 HTML 文件
```

兩個 client 版本功能完全一樣，前端 UI 共用，差別只在後端語言。

## 主要功能

| 功能 | 說明 |
|---|---|
| 7 種 DB 連線 | MySQL / PostgreSQL / SQL Server (含 SQLEXPRESS) / SQLite / Supabase / **MongoDB** / **Redis**；純 driver、SSL、Windows auth、命名 instance 都通 |
| 完整 DDL 匯出 | 欄位 + PK + 預設值 + IDENTITY **+ 外鍵 + 次要 index + trigger**（v1.0 補完） |
| 多 DB 一次匯出 | 勾多個 DB → 一個 zip |
| 部分 table 匯入 | UI 上勾選 table → server-side filter SQL（真實過濾，不再是空有 UI） |
| 專案備份 / 還原 | 程式碼 (Git) + DB + Supabase Storage 三層一次打包成 backup.zip |
| 排程備份 | 每 N 小時或每天自動 dump → 寫到指定資料夾；DB 密碼加密儲存 |
| Job 持久化 | server 重啟不會掉進度；7 天 TTL |
| 拼圖式 plugin | 丟 `.js` (Node hot reload) / `.cs` (rebuild) 進去自動載入；可貢獻 route / adapter / UI cards / UI tabs / 靜態資源 |
| Plugin marketplace | 從 GitHub URL 一鍵裝；SHA-256 + Ed25519 簽章驗證；trusted-publishers 白名單 |
| 失敗隔離 | 任一 module / adapter / plugin 壞掉只影響自己 |
| 互動指引 | 第一次開頁自動跳教學 |

## 商業 / 授權功能（License Server）

| 功能 | 說明 |
|---|---|
| Admin Web UI | Dashboard / Users / Sessions / Events / Settings 五個分頁 |
| 客戶 Portal | 看 plan / 在線裝置 / 改密碼 / 升級 (Stripe / 綠界) / 2FA 管理 |
| Online license | IP 換了自動踢；每 plan 設可用裝置數；6 種授權狀態 (trial / licensed / free / expired / kicked / offline) |
| Plan + features | trial / basic / team / enterprise；feature flags（多 DB、專案備份、檔案大小）|
| Email 驗證 | nodemailer SMTP；dev mode 印 console |
| Rate limit | 防暴力測 login（5min / 20 req / IP）|
| IP 白名單 | per-user CIDR / wildcard / 精確 |
| 免費月份 | admin 可給個別客戶免費月（自動 team 級 features）|
| Stripe | Checkout + webhook → 自動升級 plan |
| 綠界 (ECPay) | 信用卡 / ATM / 超商繳費 |
| 2FA (TOTP) | Google / Microsoft Authenticator；login 兩步驟 |
| 完整 audit log | 所有 login / kicked / 付款 / plan_upgraded 都進 event_log |

## 快速啟動

```powershell
# 1. License Server
cd license-server
npm install
$env:ADMIN_EMAIL="you@example.com"; $env:ADMIN_PASSWORD="strong-password"
npm start
# → http://localhost:4000 (API)
# → http://localhost:4000/admin/ (Admin UI)
# → http://localhost:4000/admin/portal.html (客戶 portal)

# 2. DB Migrator (Node — 二擇一)
cd node-express
npm install
$env:LICENSE_MODE="online"; $env:LICENSE_SERVER_URL="http://localhost:4000"
npm start
# → http://localhost:3000

# 3. DB Migrator (.NET — 二擇一)
cd dotnet8
dotnet restore
$env:LICENSE_MODE="online"; $env:LICENSE_SERVER_URL="http://localhost:4000"
dotnet run
# → http://localhost:3001
```

## 自動測試

```powershell
cd node-express && npm test       # 87 個 unit test
cd license-server && npm test     # 55 個（含 14 個 TOTP + revocation 在 npm install 後跑）

# Real-DB integration round-trip（需要 Docker）
cd integration && npm run up && npm test && npm run down
```

> Unit test 用 Node 18+ 內建 `node:test`，零 framework 依賴。
> Integration test 用 docker-compose 起 mysql / postgres / mssql / mongo / redis，sqlite 用本機檔。

## 完整文件

啟動後到網頁右上角點 **📖** 圖示，或：

- Node 版：http://localhost:3000/docs/
- .NET 版：http://localhost:3001/docs/
- 直接看：[文件/方案首頁.html](文件/方案首頁.html)

文件含：使用手冊 + 操作手冊 + 架構展示 + 區塊參考 + 技術文件 + 程式碼對應 + 進度文件 + 重構計畫 + 優化擴充計畫 + HANDOVER 完整交接。

## 外掛資料夾

- **Node**：[node-express/plugins/](node-express/plugins/) — 丟 `.js` 即生效，hot reload
- **.NET**：[dotnet8/Plugins/](dotnet8/Plugins/) — 丟 `.cs` controller，rebuild 即生效

兩邊都有 `hello` 範例。

## License & 商業使用

| 用途 | 條款 |
|---|---|
| 試用（offline 32 天 / online 7 天） | 免費 |
| 試用後繼續使用（任何用途） | 需要 [購買 license](COMMERCIAL.md) |
| 個人 / 學習 / 學校研究 | 也需要 license（這不是 OSS）|

技術上，client 啟動會驗 license：
- **Offline mode**：簽章 .key 檔；過期 → API 回 402，UI 仍可換新 key
- **Online mode**：login license server；IP 換、過期、被踢都立即生效；UI 上 banner 即時顯示

## Repo 結構

```
.
├── README.md             ← 你在看這個
├── CHANGELOG.md          ← 各版本改了什麼
├── LICENSE               ← PolyForm Free Trial 1.0.0
├── COMMERCIAL.md         ← 商業 license 條款 + 購買流程
├── CONTRIBUTING.md
├── SECURITY.md
├── .github/              ← Issue / PR templates + CI matrix
├── node-express/         ← Node 版完整原始碼
├── dotnet8/              ← .NET 8 版完整原始碼
├── license-server/       ← License Server（含 admin UI / portal）
├── license-tools/        ← (私用) 產生 offline license 的 Ed25519 工具 + plugin signer
├── integration/          ← docker-compose 真實 DB round-trip 測試
└── 文件/                  ← 12 份頂層中文 HTML 文件
```

## 安全提醒

**License Server 沒有公開部署不能放心** — 必須加 HTTPS + 強密碼 admin + IP 白名單。詳見 [文件/技術文件.html](文件/技術文件.html) 的安全模型章節。

**DB Migrator client 也不要直接上公網** — 即使有 license gate，仍建議走 VPN / 內網。

## 致謝

純 driver 實作背後感謝這些套件作者：mysql2、pg、mssql、tedious、Microsoft.Data.SqlClient、Npgsql、MySqlConnector、Microsoft.Data.Sqlite、better-sqlite3、@supabase/supabase-js、simple-git、LibGit2Sharp、BouncyCastle、otplib、qrcode。
