# GitHub Actions examples

範例 workflow 配置，搬到你自己 repo 的 `.github/workflows/` 就能直接用。

| 檔案 | 用途 |
|---|---|
| [backup-daily.yml](backup-daily.yml) | 每天凌晨自動 dump 上傳成 artifact（30 天保留）|
| [cross-db-preview-on-pr.yml](cross-db-preview-on-pr.yml) | PR 改 schema 就跑跨 DB 預覽，warnings comment 到 PR |
| [restore-on-tag.yml](restore-on-tag.yml) | Tag `restore-*` 觸發 staging 還原（disaster recovery drill）|

## 需要的 secrets

把以下 secret 加到 repo（Settings → Secrets and variables → Actions）：

- `DB_HOST` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` — production DB（給 backup 用）
- `STAGING_DB_HOST` / `STAGING_DB_USER` / `STAGING_DB_PASSWORD` / `STAGING_DB_NAME` — staging（給 restore 用）
- 可選：`SLACK_WEBHOOK` — 通知用

## 自訂版本 pin

`uses: wei820528/db-migrator@v2` 會抓 v2 tag 最新版。建議 production 改成 commit SHA pin 比較穩：

```yaml
- uses: wei820528/db-migrator@<sha>
```

## 其他可能 pattern

- **Webhook 通知失敗**：在 backup job 加 `if: failure()` 步驟，POST 到你自己的 Slack / PagerDuty
- **Cross-region replica**：兩個 job，一個 dump-neutral，一個 restore-neutral 到另一個 region 的 PG
- **PR-driven test seed**：PR 開了就把該 branch 的 schema 推到一個 ephemeral staging DB

如果你想到別的 pattern，歡迎開 PR 到 [examples/github-actions/](.)。
