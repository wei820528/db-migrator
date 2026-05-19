#!/usr/bin/env node
// DB Migrator CLI — entry point。
// 用法：dbmigrator <command> [...options]
//
// 純 Node script、零外部 deps（util.parseArgs 是 Node 18+ 內建）。
// 共用 adapter 跟 lib 透過相對 require 拉 ../node-express/。
//
// Subcommands 在 ../commands/<name>.js 各自 export 一個 run(parsed) 函式 +
// 一個 help() 字串。

const path = require('path');
const { parseArgs } = require('util');

const COMMANDS = {
  test:             require('../commands/test'),
  'list-dbs':       require('../commands/list-dbs'),
  'list-tables':    require('../commands/list-tables'),
  export:           require('../commands/export'),
  import:           require('../commands/import'),
  'dump-neutral':   require('../commands/dump-neutral'),
  'restore-neutral':require('../commands/restore-neutral'),
  'preview-crossdb':require('../commands/preview-crossdb'),
};

// ========================= 頂層解析 =========================

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === '--help' || args[0] === '-h') { printHelp(); process.exit(0); }
if (args[0] === '--version' || args[0] === '-V') {
  console.log(require('../package.json').version);
  process.exit(0);
}

const cmdName = args[0];
const cmd = COMMANDS[cmdName];
if (!cmd) {
  console.error(`Unknown command: ${cmdName}\n`);
  printHelp();
  process.exit(2);
}

// 子命令的 args（去掉第一個 cmd name）
const subArgs = args.slice(1);
if (subArgs.includes('--help') || subArgs.includes('-h')) {
  console.log(cmd.help);
  process.exit(0);
}

// 每個 subcommand 自己宣告 options schema，這層只負責 dispatch
(async () => {
  try {
    const code = await cmd.run(subArgs);
    process.exit(typeof code === 'number' ? code : 0);
  } catch (e) {
    console.error('ERR:', e.message);
    if (process.env.DBMIGRATOR_DEBUG) console.error(e.stack);
    process.exit(1);
  }
})();

// ========================= 頂層 help =========================

function printHelp() {
  console.log(`DB Migrator CLI

Usage:  dbmigrator <command> [options]

Commands:
  test              Test a DB connection
  list-dbs          List databases on a server
  list-tables       List tables in a database
  export            Dump a DB to a dialect-specific SQL file
  import            Restore a SQL file into a DB
  dump-neutral      Dump in cross-DB-friendly JSONL format (v2 Theme B)
  restore-neutral   Restore from a neutral JSONL into any supported dialect
  preview-crossdb   Dry-run preview: how the source schema maps to a target

Common options (most commands):
  --type <mysql|postgres|mssql|sqlite|supabase|mongo|redis>
  --host <h>  --port <p>  --user <u>  --password <pw>  --database <db>
  --password-env <ENV_NAME>   (read password from env var; preferred over --password)
  --config <file.json>        (read all connection fields from a JSON file)
  --json                      (machine-readable output)
  --quiet                     (suppress progress chatter)

Examples:
  dbmigrator test --type mysql --host 127.0.0.1 --user root --password-env MYSQL_PW
  dbmigrator export --type mysql --host 127.0.0.1 --user root --password-env PW \\
                    --database app --out app.sql
  dbmigrator dump-neutral --type mysql --host 127.0.0.1 --user root --password-env PW \\
                          --database app --out app.jsonl
  dbmigrator restore-neutral --type postgres --host 127.0.0.1 --user pg --password-env PGPW \\
                             --database app_new --file app.jsonl

Per-command help:
  dbmigrator <command> --help

Environment:
  DBMIGRATOR_DEBUG=1   Print stack traces on error
`);
}
