# DB Migrator CLI

`dbmigrator` 是 DB Migrator 的命令列介面。為了 cron / CI / scripts 而生 — 拿來自動化 dump、restore、跨 DB preview，不需要開瀏覽器。

純 Node script，**零外部 dependencies**（用 Node 18+ 內建 `util.parseArgs`）。共用 `node-express/adapters` 跟 `node-express/lib`，所以不會跟 web UI 行為漂移。

## 安裝

目前還沒 publish 到 npm。本機跑：

```powershell
cd cli
# (node-express 的 deps 必須先裝起來，CLI 會 require 那邊的 adapter)
cd ../node-express && npm install
cd ../cli

# 直接執行
node bin/dbmigrator.js test --type sqlite --path ./app.db

# 或全域連結
npm link
dbmigrator test --type sqlite --path ./app.db
```

## 命令清單

| Command | 用途 |
|---|---|
| `test`            | 測連線、印版本 + 看得到的 databases |
| `list-dbs`        | 列出 server 上的 databases |
| `list-tables`     | 列出指定 database 內的 tables |
| `export`          | dump 到 dialect-specific SQL 檔（同 web 匯出 tab）|
| `import`          | 把 SQL 檔還原到 DB |
| `dump-neutral`    | 寫成 cross-DB 中性 JSONL（v2 Theme B Phase 2 格式）|
| `restore-neutral` | 從中性 JSONL 還原到 mysql / postgres / sqlite |
| `preview-crossdb` | Dry-run：看 source 的 schema 翻成 target 會長怎樣 + 哪些欄位 lossy |

每個 command 都有 `--help` 看自己的 flag。

## Connection flags（多數 command 共用）

| Flag | 說明 |
|---|---|
| `--type <db>` | mysql / postgres / mssql / sqlite / supabase / mongo / redis |
| `--host <h>` | host name / IP / Atlas URI / file path（mssql 可寫 `HOST\INSTANCE`）|
| `--port <p>` | 不寫的話 fallback 各 driver 預設 |
| `--user <u>` | 帳號 |
| `--password <pw>` | 密碼（**不建議**在共享 shell 用，會落到 history）|
| `--password-env <NAME>` | 從環境變數讀密碼（建議的方式）|
| `--database <name>` | DB 名 |
| `--path <p>` | SQLite 用的檔案路徑 |
| `--ssl` | 啟用 SSL（Supabase 自動加）|
| `--auth-mode <sql\|windows>` | mssql 用 |
| `--config <file.json>` | 整份 connection 從 JSON 載入；其他 flag 仍可 override |
| `--json` | 機器可讀 JSON 輸出 |
| `--quiet` | 不印 progress |

## Examples

```powershell
# 測連線
$env:MYSQL_PW = 'secret'
dbmigrator test --type mysql --host 127.0.0.1 --user root --password-env MYSQL_PW

# 列 databases
dbmigrator list-dbs --type mysql --host 127.0.0.1 --user root --password-env MYSQL_PW

# 用 JSON 設定檔（連續多個 command 共用）
cat > conn.json << 'EOF'
{ "type": "mysql", "host": "db.prod.example.com", "user": "backup", "database": "app" }
EOF
dbmigrator export --config conn.json --password-env BACKUP_PW --out app.sql

# 跨 DB：mysql → postgres
dbmigrator dump-neutral --config mysql.json --password-env MYSQL_PW --out app.jsonl
dbmigrator preview-crossdb \
    --source-type mysql --source-host 127.0.0.1 --source-user root --source-password-env MYSQL_PW --source-database app \
    --target-type postgres
dbmigrator restore-neutral --config pg.json --password-env PG_PW --file app.jsonl

# cron-friendly：每天凌晨 2 點備份到 /backups/
0 2 * * *  /usr/bin/dbmigrator export --config /etc/dbmigrator/prod.json \
              --password-env BACKUP_PW --out /backups/app-$(date +\%F).sql
```

## Exit codes

- `0` — success
- `1` — runtime error（連線失敗、dump 失敗、target 不接受等等）
- `2` — invalid arguments / unknown subcommand

## Environment variables

| Env | 作用 |
|---|---|
| `DBMIGRATOR_DEBUG=1` | 出錯時印 stack trace |
| 你自己的 `*_PW` 之類 | 被 `--password-env <NAME>` 引用，避免密碼出現在 process list / shell history |

## Roadmap（v2 Theme C 其他 phase）

- Phase 2：long-running API token（給 cron 拿，token 有 scope 控制）
- Phase 3：OpenAPI spec + Swagger UI（讓寫 client 的人有 single source of truth）
- Phase 4：Webhook delivery（job 完成 / 排程失敗 → POST 通知，HMAC 簽名）
- Phase 5：GitHub Action wrapper（`actions/db-migrator@v2` 一鍵在 CI 跑備份）
