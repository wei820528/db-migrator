// 從 CLI args 組出 connection object，跟 web UI 的 connection.js 行為對齊。
//
// Precedence（從高到低）：
//   1. --config <file.json>      整份 JSON 載進來當 conn（其他 flag 仍可 override）
//   2. --password-env <NAME>     從 env 拿密碼
//   3. --password <pw>           直接給（不建議用在 shared shell）
//
// 回 { type, conn }，type 是 adapter type（mysql / postgres / sqlite / ...）。

const fs = require('fs');
const { parseArgs } = require('util');

// 所有 connection 相關的 flags（subcommand 額外 flags 自己宣告）
const CONN_OPTIONS = {
  type:         { type: 'string' },
  host:         { type: 'string' },
  port:         { type: 'string' },                   // 用 string，後面手動 parseInt
  user:         { type: 'string' },
  password:     { type: 'string' },
  'password-env': { type: 'string' },
  database:     { type: 'string' },
  path:         { type: 'string' },                   // sqlite 用
  ssl:          { type: 'boolean', default: false },
  'auth-mode':  { type: 'string' },                   // mssql 用：sql | windows
  config:       { type: 'string' },
  json:         { type: 'boolean', default: false },
  quiet:        { type: 'boolean', default: false },
  help:         { type: 'boolean', short: 'h' },
};

// 把這些 flags 合進 subcommand 自己的 options，並 parse argv
function parseConnArgs(subArgs, extraOptions = {}) {
  const options = { ...CONN_OPTIONS, ...extraOptions };
  // util.parseArgs throws on unknown options by default — 維持 default 行為以早期抓 typo
  const { values, positionals } = parseArgs({ args: subArgs, options, allowPositionals: true });
  const { type, conn } = buildConn(values);
  return { values, positionals, type, conn };
}

function buildConn(v) {
  // --config 先載入當底，flags 再覆蓋
  let base = {};
  if (v.config) {
    try { base = JSON.parse(fs.readFileSync(v.config, 'utf8')); }
    catch (e) { throw new Error(`failed to read --config: ${e.message}`); }
  }

  const type = v.type || base.type;
  if (!type) throw new Error('--type required (or set "type" in --config file)');

  // 取出 password：優先 --password-env，再來 --password，再來 config
  let password = base.password;
  if (v['password-env']) {
    const envName = v['password-env'];
    if (!(envName in process.env)) {
      throw new Error(`env var ${envName} not set (referenced by --password-env)`);
    }
    password = process.env[envName];
  } else if (v.password !== undefined) {
    password = v.password;
  }

  const conn = {
    ...base,
    host:     v.host ?? base.host,
    port:     v.port !== undefined ? Number(v.port) : (base.port ?? 0),
    user:     v.user ?? base.user,
    password,
    database: v.database ?? base.database,
  };

  // type-specific 後處理
  if (type === 'sqlite') {
    conn.path = v.path ?? base.path ?? conn.database ?? conn.host;
  }
  if (type === 'mssql' && v['auth-mode']) {
    conn.authMode = v['auth-mode'];
  }
  if (v.ssl || base.ssl) conn.ssl = true;

  return { type, conn };
}

// 印出 conn 摘要（但隱藏 password），給 verbose CLI 訊息用
function describeConn(type, conn) {
  const safe = { ...conn, password: conn.password ? '***' : undefined };
  return `${type}://${safe.user || ''}@${safe.host || safe.path || '?'}${safe.port ? ':' + safe.port : ''}/${safe.database || ''}`;
}

module.exports = { parseConnArgs, buildConn, describeConn, CONN_OPTIONS };
