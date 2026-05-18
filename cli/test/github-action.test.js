// Phase 5 tests — GHA entry script 純函式（input / boolInput / buildArgs）。
// 不真的 spawn CLI，只驗證 args 翻譯邏輯正確。

const test = require('node:test');
const assert = require('node:assert');

// 進來時的 env 可能有 INPUT_* 留下來；每個 test 自己清理。
function withInputs(inputs, fn) {
  const restore = {};
  // 先記下所有 INPUT_* 原值
  for (const k of Object.keys(process.env)) if (k.startsWith('INPUT_')) restore[k] = process.env[k];
  // 套用測試 inputs
  try {
    for (const k of Object.keys(restore)) delete process.env[k];
    for (const [k, v] of Object.entries(inputs)) {
      const envKey = 'INPUT_' + k.replace(/-/g, '_').toUpperCase();
      if (v !== undefined) process.env[envKey] = String(v);
    }
    // 每次 fresh require — 確保不會被前一個 test 的 module-level state 污染
    delete require.cache[require.resolve('../lib/github-action')];
    const gha = require('../lib/github-action');
    return fn(gha);
  } finally {
    for (const k of Object.keys(process.env)) if (k.startsWith('INPUT_')) delete process.env[k];
    for (const [k, v] of Object.entries(restore)) process.env[k] = v;
  }
}

// ============ input() / boolInput() ============

test('input reads INPUT_FOO from env', () => {
  withInputs({ foo: 'bar' }, (gha) => {
    assert.strictEqual(gha.input('foo'), 'bar');
  });
});

test('input maps kebab-case → SNAKE_CASE', () => {
  withInputs({ 'auth-mode': 'sql' }, (gha) => {
    assert.strictEqual(gha.input('auth-mode'), 'sql');
  });
});

test('input returns undefined for empty string', () => {
  withInputs({ foo: '' }, (gha) => {
    assert.strictEqual(gha.input('foo'), undefined);
  });
});

test('input returns undefined for missing key', () => {
  withInputs({}, (gha) => {
    assert.strictEqual(gha.input('nope'), undefined);
  });
});

test('boolInput true on "true"', () => {
  withInputs({ json: 'true' }, (gha) => {
    assert.strictEqual(gha.boolInput('json'), true);
  });
});

test('boolInput false on "false" / missing', () => {
  withInputs({ json: 'false' }, (gha) => {
    assert.strictEqual(gha.boolInput('json'), false);
  });
  withInputs({}, (gha) => {
    assert.strictEqual(gha.boolInput('json'), false);
  });
});

// ============ buildArgs() ============

test('buildArgs: basic export command', () => {
  withInputs({
    command: 'export', type: 'mysql', host: '127.0.0.1', user: 'root',
    database: 'app', out: 'dump.sql',
  }, (gha) => {
    const args = gha.buildArgs();
    assert.deepStrictEqual(args, [
      'export', '--type', 'mysql', '--host', '127.0.0.1',
      '--user', 'root', '--database', 'app', '--out', 'dump.sql',
    ]);
  });
});

test('buildArgs: password routed to --password-env (never inline)', () => {
  withInputs({
    command: 'test', type: 'mysql', host: 'h', user: 'u', password: 'secret',
  }, (gha) => {
    const args = gha.buildArgs();
    // password 不該出現在 args 上
    assert.ok(!args.includes('secret'), `password leaked into args: ${args}`);
    // 改成 --password-env DBMIGRATOR_GHA_PASSWORD
    const i = args.indexOf('--password-env');
    assert.ok(i >= 0);
    assert.strictEqual(args[i + 1], 'DBMIGRATOR_GHA_PASSWORD');
  });
});

test('buildArgs: boolean flags only included when true', () => {
  withInputs({
    command: 'export', type: 'mysql', host: 'h', out: 'x.sql',
    'no-data': 'true', json: 'true', quiet: 'false', ssl: 'false',
  }, (gha) => {
    const args = gha.buildArgs();
    assert.ok(args.includes('--no-data'));
    assert.ok(args.includes('--json'));
    assert.ok(!args.includes('--quiet'));
    assert.ok(!args.includes('--ssl'));
  });
});

test('buildArgs: omits flags whose input is empty/missing', () => {
  withInputs({
    command: 'test', type: 'sqlite', path: '/tmp/x.db',
    // host / user / password 都沒給
  }, (gha) => {
    const args = gha.buildArgs();
    assert.ok(args.includes('--type'));
    assert.ok(args.includes('--path'));
    assert.ok(!args.includes('--host'));
    assert.ok(!args.includes('--user'));
    assert.ok(!args.includes('--password-env'));
  });
});

test('buildArgs: preview-crossdb uses source-* + target-* flags, NOT plain ones', () => {
  withInputs({
    command: 'preview-crossdb',
    type: 'postgres',                  // ignored for preview-crossdb (it has its own source-type)
    'source-type': 'mysql', 'source-host': '127.0.0.1', 'source-user': 'root',
    'source-database': 'app', 'target-type': 'postgres',
    'source-password': 'pgsecret',
  }, (gha) => {
    const args = gha.buildArgs();
    assert.ok(args.includes('--source-type'));
    assert.ok(args.includes('--source-host'));
    assert.ok(args.includes('--target-type'));
    // plain --type 不該出現
    assert.ok(!args.includes('--type'));
    // source-password 路徑
    const i = args.indexOf('--source-password-env');
    assert.ok(i >= 0);
    assert.strictEqual(args[i + 1], 'DBMIGRATOR_GHA_SOURCE_PASSWORD');
  });
});

test('buildArgs: command is always the first positional arg', () => {
  withInputs({ command: 'list-tables', type: 'mysql', host: 'h', database: 'd' }, (gha) => {
    const args = gha.buildArgs();
    assert.strictEqual(args[0], 'list-tables');
  });
});

test('buildArgs: missing command exits 2 with an error', () => {
  withInputs({ type: 'mysql', host: 'h' }, (gha) => {
    // 攔 process.exit + console.error
    const origExit = process.exit;
    const origErr = console.error;
    let exitCode, errMsg;
    process.exit = (c) => { exitCode = c; throw new Error('exit:' + c); };
    console.error = (m) => { errMsg = m; };
    try { gha.buildArgs(); } catch {}
    process.exit = origExit;
    console.error = origErr;
    assert.strictEqual(exitCode, 2);
    assert.match(errMsg, /command.*required/);
  });
});

test('buildArgs: --config alone is enough (no individual conn flags needed)', () => {
  withInputs({ command: 'export', type: 'mysql', config: '/etc/dbmigrator.json', out: 'x.sql' }, (gha) => {
    const args = gha.buildArgs();
    assert.ok(args.includes('--config'));
    assert.ok(args[args.indexOf('--config') + 1] === '/etc/dbmigrator.json');
  });
});

// ============ Sanity: examples/ workflows reference us correctly ============

test('examples/github-actions/*.yml reference the right action path', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', '..', 'examples', 'github-actions');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.yml'))) {
    const txt = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.match(txt, /uses:\s*wei820528\/db-migrator@v\d+/,
      `${f} doesn't reference wei820528/db-migrator action`);
  }
});

test('action.yml declares all the inputs the entry script reads', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const actionYml = fs.readFileSync(path.join(__dirname, '..', '..', 'action.yml'), 'utf8');
  // 確保所有 entry script 用到的 input name 都在 action.yml 裡（粗略 string check 即可）
  for (const name of [
    'command', 'type', 'host', 'port', 'user', 'password', 'database', 'path',
    'ssl', 'auth-mode', 'out', 'file', 'tables', 'no-data', 'no-schema',
    'source-type', 'source-host', 'source-port', 'source-user', 'source-password',
    'source-database', 'target-type', 'json', 'quiet', 'config',
  ]) {
    assert.ok(new RegExp(`^\\s*${name}:`, 'm').test(actionYml),
      `action.yml is missing input declaration for "${name}"`);
  }
});
