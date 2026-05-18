// test — 測試連線、印 version + databases。
const path = require('path');
const { parseConnArgs, describeConn } = require('../lib/conn');

exports.help = `dbmigrator test --type <db> --host <h> [--port <p>] [--user <u>] [--password-env <ENV>] [--database <db>]

Test a DB connection and print version + visible databases.

Options:  see common conn flags via 'dbmigrator --help'.
`;

exports.run = async (subArgs) => {
  const { type, conn, values } = parseConnArgs(subArgs);
  const adapter = require(path.join(__dirname, '..', '..', 'node-express', 'adapters', adapterDir(type)));
  if (!values.quiet) console.error(`Connecting to ${describeConn(type, conn)}...`);
  const r = await adapter.testConnection(conn);
  if (values.json) {
    console.log(JSON.stringify(r, null, 2));
  } else if (r.ok) {
    console.log(`✓ ${r.version}`);
    if (r.databases) console.log(`  databases: ${r.databases.join(', ')}`);
  } else {
    console.log(`✗ ${r.error || 'connection failed'}`);
  }
  return r.ok ? 0 : 1;
};

// adapter folder name (跟 type 名一致，除了 supabase 用 postgres adapter)
function adapterDir(type) { return type === 'supabase' ? 'postgres' : type; }
exports._adapterDir = adapterDir;
