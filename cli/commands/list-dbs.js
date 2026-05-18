// list-dbs — 列出 server 上看得到的 databases（用 testConnection 順便回的 list）。
const path = require('path');
const { parseConnArgs } = require('../lib/conn');
const { _adapterDir } = require('./test');

exports.help = `dbmigrator list-dbs --type <db> --host <h> [--user <u>] [--password-env <ENV>]

List databases visible on the server.
`;

exports.run = async (subArgs) => {
  const { type, conn, values } = parseConnArgs(subArgs);
  const adapter = require(path.join(__dirname, '..', '..', 'node-express', 'adapters', _adapterDir(type)));
  const r = await adapter.testConnection(conn);
  if (!r.ok) { console.error('connection failed:', r.error); return 1; }
  const dbs = r.databases || [];
  if (values.json) console.log(JSON.stringify(dbs, null, 2));
  else for (const d of dbs) console.log(d);
  return 0;
};
