# Contributing

歡迎貢獻！先看完這份再開始，避免來回調整。

## Important: Licensing of contributions

**This is commercial software** (PolyForm Free Trial 1.0.0 — see [LICENSE](LICENSE)).
By submitting a pull request, you grant the project owner perpetual, worldwide,
royalty-free, sublicensable rights to use your contribution under any current
or future license terms of this project — including the right to relicense
under different terms.

If you cannot agree to this, please do not submit pull requests.

> 白話：你提交 PR 等於把這段程式碼的著作權同意讓專案擁有者使用 / 改授權 / 包進付費版。
> 不接受這條請別交 PR。

## What kind of contributions are welcome

✅ **Yes please:**
- Bug fixes (with steps to reproduce + ideally a test case)
- Small features that fit existing scope (e.g., new DB adapter)
- Documentation fixes / typos
- Performance improvements with measurements

⚠ **Discuss first via Issue:**
- New features touching multiple files
- Breaking API changes
- New dependencies (we keep dep list small on purpose)
- UI redesigns

❌ **Probably won't merge:**
- Style-only refactors with no functional change
- Renaming things for personal preference
- Removing existing features without discussion

## Setting up local dev

### Node version

```powershell
cd node-express
npm install
npm start         # http://localhost:3000
```

### .NET version

```powershell
cd dotnet8
dotnet restore
dotnet run        # http://localhost:3001
```

兩個版本前端共用，後端各自獨立 — 改前端要記得 sync 到兩邊（直接 cp）。

## Code style

- **Comments**: only when the *why* is non-obvious. Don't narrate what the code does.
- **No new dependencies** without discussion in an Issue first.
- **Errors**: throw with a message that helps the user fix it; don't swallow.
- **Tests**: not strictly required for small fixes, but bigger features benefit.

## Commit messages

Anything readable is fine. Conventional Commits welcome but not required.

```
fix(mssql): handle Windows auth when DB is empty
feat(plugins): expose ui.cards via /api/plugins/ui
docs(readme): add Supabase setup steps
```

## Pull request process

1. Fork + branch (`feature/xxx` or `fix/yyy`)
2. Make your change
3. Test manually — at least the happy path of what you touched
4. Open PR with description: what changed, why, and how you tested
5. Be responsive to review comments

CI must pass before merge.

## Reporting bugs

See [.github/ISSUE_TEMPLATE/bug_report.md](.github/ISSUE_TEMPLATE/bug_report.md).
Please include:
- Which version (Node / .NET)
- DB type + version
- Reproduction steps
- Actual vs expected
- Console / server log

## Reporting security issues

**Do not** open a public Issue. See [SECURITY.md](SECURITY.md).
