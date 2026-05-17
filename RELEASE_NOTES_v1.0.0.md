# DB Migrator v1.0.0

第一個對外正式 release。整合 v0.1.0 後所有 P0 / P1 / P2 功能 + 71 個自動測試，含完整 online license server。

> 從 v0.1.0 升級沒有 breaking change — DB Migrator client 依舊跑 offline mode（32 天試用），加 license server 是新選項。

## ✨ Highlights

- **Online license server**（獨立服務）：admin web UI、客戶 portal、IP 偵測踢人、Stripe + 綠界付款、2FA (TOTP)
- **完整 DDL 匯出**：四種 DB 都補 FK / 次要 index / trigger，SQLite 加上 view
- **部分 table 多選匯入**：UI checkbox 真實 server-side filter（不再是空有 UI）
- **排程備份**：每 N 小時或每天 HH:MM；DB 密碼 AES-256-GCM 加密儲存；含 in-app run-now + 檔案下載
- **Job 持久化**：server 重啟不會掉進度；7 天 TTL 自動清
- **拼圖式 plugin**：Node 版 hot reload；route + adapter + UI cards/tabs + 靜態資源；失敗隔離
- **前端模組化**：`app.js` 從 1148 行 → 28 行 bootstrap + 12 個獨立模組
- **75+ 個自動測試**：用 Node 18+ 內建 `node:test`，零 framework 依賴
- **真實 UI 渲染進文件**：HANDOVER / 使用手冊內的「截圖」是把真實 HTML/CSS 嵌進文件，零誤差

## 📦 New components

| Component | Stack | What it does |
|---|---|---|
| `license-server/` | Node + SQLite | Admin UI、客戶 portal、auth、payment、2FA |
| `license-tools/` | Node + crypto | Ed25519 簽 offline license（私用） |
| `node-express/test/` | node:test | 37 個 unit test |
| `license-server/test/` | node:test | 49 個 unit test（含 14 個 TOTP） |

## 🔒 Security

- 密碼 bcrypt 10 rounds
- TOTP secret + 排程備份 DB 密碼：AES-256-GCM 加密儲存
- License cookies：HttpOnly + SameSite=Lax + Secure
- Rate limit (5min / 20 req / IP) + IP 白名單 + 2FA 三層

## 🐛 Important fixes

被自動測試抓到的兩個之前漏掉的 bug：

- **MSSQL bracket parsing**：`[users]` 在 `extractTableName` 解析錯誤 → C-01 在 MSSQL 上 filter 失效
- **IP 白名單 wildcard**：`192.168.*` 不會 match `192.168.1.100` → 客戶設規則後連不進來

## 🚀 Upgrade

```powershell
git pull
# Node client
cd node-express; npm install
# .NET client
cd dotnet8; dotnet restore
# License server（新元件，如果要用 online 模式才裝）
cd license-server; npm install
```

完整變更清單看 [CHANGELOG.md](CHANGELOG.md)。完整交接（架構、檔案對應、未完事項）看 [文件/HANDOVER.html](文件/HANDOVER.html)。

## 🙏 Acknowledgements

純 driver 實作背後感謝這些套件作者：mysql2、pg、mssql、tedious、Microsoft.Data.SqlClient、Npgsql、MySqlConnector、Microsoft.Data.Sqlite、better-sqlite3、@supabase/supabase-js、simple-git、LibGit2Sharp、BouncyCastle、otplib、qrcode。

---

**Full Changelog**: https://github.com/wei820528/db-migrator/compare/v0.1.0...v1.0.0
