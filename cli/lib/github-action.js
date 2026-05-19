// GitHub Action entry — 把 INPUT_* env vars 翻成 CLI 參數然後 spawn dbmigrator。
//
// GitHub Actions runner 會自動把每個 `inputs.foo` 設成 `INPUT_FOO` env var
// （連字號變底線、轉大寫）。這個 script 讀那些 env，組出 CLI args 陣列，spawn 子程序。
//
// Password 走 --password-env 避免落到 process list（其實在 GitHub runner 上
// process list 是 ephemeral 的、但養成好習慣 + 避免進 log）。

const path = require('path');
const { spawnSync } = require('child_process');

// 從 INPUT_FOO env 讀 input value（空字串視為未設）
function input(name) {
  const key = 'INPUT_' + name.replace(/-/g, '_').toUpperCase();
  const v = process.env[key];
  return v == null || v === '' ? undefined : v;
}

// boolean input：GitHub Actions 把 'true' / 'false' 字串塞進去
function boolInput(name) {
  return String(input(name) || '').toLowerCase() === 'true';
}

// 主要 connection flags 對映：CLI flag → action input name
const CONN_FLAGS = [
  ['--type',      'type'],
  ['--host',      'host'],
  ['--port',      'port'],
  ['--user',      'user'],
  ['--database',  'database'],
  ['--path',      'path'],
  ['--auth-mode', 'auth-mode'],
  ['--config',    'config'],
];

const PER_CMD_FLAGS = [
  ['--out',         'out'],
  ['--file',        'file'],
  ['--tables',      'tables'],
  ['--s3-bucket',   's3-bucket'],
  ['--s3-prefix',   's3-prefix'],
  ['--s3-region',   's3-region'],
  ['--s3-endpoint', 's3-endpoint'],
];

const BOOL_FLAGS = [
  ['--ssl',              'ssl'],
  ['--no-data',          'no-data'],
  ['--no-schema',        'no-schema'],
  ['--json',             'json'],
  ['--quiet',            'quiet'],
  ['--encrypt',          'encrypt'],
  ['--s3-delete-local',  's3-delete-local'],
];

// preview-crossdb 是特例 — 用一組 source-* flag
const CROSSDB_FLAGS = [
  ['--source-type',     'source-type'],
  ['--source-host',     'source-host'],
  ['--source-port',     'source-port'],
  ['--source-user',     'source-user'],
  ['--source-database', 'source-database'],
  ['--target-type',     'target-type'],
];

function buildArgs() {
  const cmd = input('command');
  if (!cmd) {
    console.error('::error::input "command" is required');
    process.exit(2);
  }
  const args = [cmd];

  const isPreview = cmd === 'preview-crossdb';

  // Connection flags (跳過 preview-crossdb — 它有自己的 source-* 組)
  if (!isPreview) {
    for (const [flag, name] of CONN_FLAGS) {
      const v = input(name);
      if (v !== undefined) args.push(flag, v);
    }
  } else {
    for (const [flag, name] of CROSSDB_FLAGS) {
      const v = input(name);
      if (v !== undefined) args.push(flag, v);
    }
  }

  for (const [flag, name] of PER_CMD_FLAGS) {
    const v = input(name);
    if (v !== undefined) args.push(flag, v);
  }
  for (const [flag, name] of BOOL_FLAGS) {
    if (boolInput(name)) args.push(flag);
  }

  // Password 走 --password-env，避免出現在 args 上
  if (input('password') !== undefined) {
    args.push(isPreview ? '--source-password-env' : '--password-env',
              isPreview ? 'DBMIGRATOR_GHA_SOURCE_PASSWORD' : 'DBMIGRATOR_GHA_PASSWORD');
  }
  if (isPreview && input('source-password') !== undefined) {
    args.push('--source-password-env', 'DBMIGRATOR_GHA_SOURCE_PASSWORD');
  }

  // Dump 加密 password 也走 env (export / import / dump-neutral / restore-neutral 共用)
  if (input('dump-password') !== undefined) {
    args.push('--password-env', 'DBMIGRATOR_GHA_DUMP_PASSWORD');
  }

  return args;
}

function run() {
  const args = buildArgs();
  const cliPath = path.join(__dirname, '..', 'bin', 'dbmigrator.js');

  // 公開（GitHub log 上看得到）—— password 已經改走 env 不會在這
  console.log(`::debug::dbmigrator ${args.map(maskMaybe).join(' ')}`);

  const r = spawnSync('node', [cliPath, ...args], {
    stdio: ['inherit', 'pipe', 'inherit'],
    env: process.env,
  });

  const stdout = r.stdout ? r.stdout.toString() : '';
  // 把 CLI stdout 同步印到 Action log（讓使用者看得到）
  process.stdout.write(stdout);

  // 把 stdout 寫入 $GITHUB_OUTPUT 給後續 step 用
  const ghOutput = process.env.GITHUB_OUTPUT;
  if (ghOutput && stdout) {
    const fs = require('fs');
    // multi-line outputs 用 heredoc syntax
    const delim = 'EOF_' + Math.random().toString(36).slice(2);
    fs.appendFileSync(ghOutput, `stdout<<${delim}\n${stdout}\n${delim}\n`);
  }

  if (r.error) {
    console.error('::error::failed to spawn dbmigrator: ' + r.error.message);
    process.exit(1);
  }
  process.exit(r.status ?? 1);
}

// Defense in depth — 雖然我們已經把 password 轉成 env，這裡再保險：
// 把任何看起來像 secret 的 token 從 debug log 遮掉。
function maskMaybe(s) {
  if (s == null) return '';
  const str = String(s);
  if (/^dbmt_|^whsec_/.test(str)) return '***';
  return str;
}

if (require.main === module) run();
module.exports = { buildArgs, input, boolInput };
