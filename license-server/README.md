# License Server

Central licensing service for DB Migrator. Handles:
- 帳號（email + password）+ 7 天試用
- Multi-device 限制（per-plan）
- IP-based session 追蹤 — IP 換了 = 踢
- Plan-based feature flags（試用版不能 bulk export 等）
- Email 驗證（nodemailer）
- Rate limit on auth endpoints
- IP 白名單（per user）
- Free-this-month override（admin 給某使用者免費月）
- **Stripe 訂閱**（checkout + webhook 自動升級 plan）
- **Admin Web UI**（看誰在線、改 plan、查 IP 紀錄）

## Quick start

```powershell
cd license-server
npm install
$env:ADMIN_EMAIL = "you@example.com"
$env:ADMIN_PASSWORD = "your-strong-password"
npm start
# → License server listening on http://localhost:4000
# → Admin UI:  http://localhost:4000/admin/
```

`ADMIN_EMAIL` / `ADMIN_PASSWORD` 在第一次啟動時自動建一個 admin 帳號（之後啟動會跳過）。

連到 http://localhost:4000/admin/ 用上面填的帳號登入。

## Admin Web UI 功能

| 分頁 | 內容 |
|---|---|
| 📊 Dashboard | 在線數、24h 登入 / 被踢數、即將到期、各 plan 使用者數、Stripe 狀態 |
| 👥 Users | 搜尋、編輯、新增、刪除使用者；改 plan / max_devices / 到期日 / IP 白名單 / 免費月份 |
| 🟢 Sessions | 目前所有在線 session（email、IP、user agent、最後活動）+ 強制踢出 |
| 📜 Events | 所有事件 audit log（login / kicked / register / 等等）+ 搜尋 |
| ⚙ Settings | 方案定義（唯讀）、環境變數說明 |

## Switching local ↔ production

| Variable | Local test | Production |
|---|---|---|
| `LICENSE_MODE` (DB Migrator side) | `online` | `online` |
| `LICENSE_SERVER_URL` (DB Migrator side) | `http://localhost:4000` | `https://license.your-domain.com` |
| `PUBLIC_BASE_URL` (this server) | `http://localhost:4000` | `https://license.your-domain.com` |

DB Migrator 不設這兩個 → 自動 fallback 到 offline mode（Ed25519 簽章 .key 檔）。

## Deploying to a VPS

詳見 [操作文件](../文件/操作文件.html#deploy)。簡版：

```bash
# /etc/systemd/system/license-server.service
[Unit]
After=network.target

[Service]
WorkingDirectory=/opt/license-server
ExecStart=/usr/bin/node server.js
Restart=on-failure
Environment=PORT=4000
Environment=LICENSE_DB=/var/lib/license-server/license.db
Environment=PUBLIC_BASE_URL=https://license.your-domain.com
Environment=ADMIN_EMAIL=admin@your-domain.com ADMIN_PASSWORD=GENERATE_STRONG
Environment=SMTP_HOST=smtp.sendgrid.net SMTP_PORT=587 SMTP_USER=apikey SMTP_PASS=YOUR_KEY SMTP_FROM=no-reply@your-domain.com
Environment=STRIPE_SECRET_KEY=sk_live_... STRIPE_WEBHOOK_SECRET=whsec_...
Environment=STRIPE_PRICE_BASIC=price_xxx STRIPE_PRICE_TEAM=price_yyy STRIPE_PRICE_ENTERPRISE=price_zzz

[Install]
WantedBy=multi-user.target
```

加 Caddy / nginx 終結 HTTPS。

## Stripe 設定步驟

1. **Stripe Dashboard → Products** 建立 3 個 product（Basic / Team / Enterprise），各設定一個 recurring monthly / yearly price
2. 記下每個 price 的 ID（`price_xxx...`）
3. 設環境變數 `STRIPE_SECRET_KEY` + `STRIPE_PRICE_BASIC / TEAM / ENTERPRISE`
4. Stripe Dashboard → Webhooks → Add endpoint → URL：`https://license.your-domain.com/api/billing/webhook`
5. 訂閱以下事件：
   - `checkout.session.completed`
   - `invoice.paid`
   - `customer.subscription.deleted`
6. Webhook 給的 Signing secret 設成 `STRIPE_WEBHOOK_SECRET=whsec_...`
7. 重啟 server

驗證：到 Admin Dashboard → Stripe 整合那一塊應該都顯示綠燈。

## Plan 定義

編輯 [`plans.js`](plans.js) 改各 plan 的 features 與裝置數，重啟生效：

```js
trial: {
  max_devices: 1,
  duration_days: 7,
  features: {
    bulk_export: false,
    multi_db_count_max: 1,
    project_backup: false,
    max_export_mb: 50,
  },
  stripe_price: null,  // 試用不賣
},
basic: { max_devices: 1, features: { bulk_export: true, ... }, stripe_price: process.env.STRIPE_PRICE_BASIC },
team:  { max_devices: 5, ... },
```

## Admin CLI（也可以全部用 web UI）

```powershell
node admin-cli.js create-user   --email a@b.com --password test1234 [--plan team --devices 5 --expires 2027-12-31]
node admin-cli.js list-users
node admin-cli.js list-sessions [--email a@b.com]
node admin-cli.js list-events   [--email a@b.com] [--limit 50]
node admin-cli.js set-plan      --email a@b.com --plan team [--devices 5] [--expires YYYY-MM-DD]
node admin-cli.js reset-trial   --email a@b.com
node admin-cli.js revoke        --email a@b.com   # set expires=now AND kick all sessions
node admin-cli.js kick-all      --email a@b.com   # just kick sessions
node admin-cli.js delete-user   --email a@b.com
node admin-cli.js make-admin    --email a@b.com   # promote existing user
node admin-cli.js set-free      --email a@b.com [--days 30]
node admin-cli.js plans
```

## API 端點摘要

| Method | Path | 用途 | Auth |
|---|---|---|---|
| POST | /api/auth/register | 註冊試用 | rate-limited |
| POST | /api/auth/login | 登入 | rate-limited |
| POST | /api/auth/heartbeat | 30 秒心跳 | Bearer token |
| GET | /api/auth/me | 看自己 | Bearer token |
| POST | /api/auth/logout | 登出 | Bearer token |
| GET | /api/auth/verify-email?token=... | email 驗證連結 | (token) |
| POST | /api/admin/login | Admin 登入 | — |
| POST | /api/admin/logout | Admin 登出 | cookie |
| GET | /api/admin/users / sessions / events / stats / plans | 管理 | cookie |
| POST | /api/admin/users | 建使用者 | cookie |
| PATCH | /api/admin/users/:id | 改 plan / 白名單 / free_until | cookie |
| POST | /api/admin/users/:id/kick-all / reset-trial / free-month / clear-free | 動作 | cookie |
| POST | /api/billing/checkout | Stripe checkout URL | (user token) |
| POST | /api/billing/webhook | Stripe webhook | signature |
| GET | /api/billing/status | Stripe 狀態 | — |
| GET | /api/health | 健康檢查 | — |

## 安全注意事項

- Admin cookie：HttpOnly + SameSite=Lax + Secure (HTTPS)
- bcrypt 10 rounds
- Rate limit 5 min / 20 req per IP on /api/auth/*
- `app.set('trust proxy', true)` — 靠 X-Forwarded-For；確保 reverse proxy 正確設定
- **沒有 CSRF token** — admin 動作只靠 cookie，存在 CSRF 風險（屬於低風險場景但要知道）
- HTTPS production 必須

## 備份

```powershell
# 每天 cron
sqlite3 license.db ".backup /backups/license-$(date +%F).db"
```

跑久了 event_log 會大；定期：
```sql
DELETE FROM event_log WHERE at < datetime('now', '-90 days');
VACUUM;
```
