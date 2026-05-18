// list-tables — 列出指定 database 內所有 tables（含 rowEstimate）。
const path = require('path');
const { parseConnArgs } = require('../lib/conn');
const { _adapterDir } = require('./test');

exports.help = `dbmigrator list-tables --type <db> --host <h> --database <name> [--user <u>] [--password-env <ENV>]

List tables in the given database.
`;

exports.run = async (subArgs) => {
  const { type, conn, values } = parseConnArgs(subArgs);
  const adapter = require(path.join(__dirname, '..', '..', 'node-express', 'adapters', _adapterDir(type)));
  const tables = await adapter.listTables(conn);
  if (values.json) {
    console.log(JSON.stringify(tables, null, 2));
  } else {
    if (tables.length === 0) console.log('(no tables)');
    for (const t of tables) {
      console.log(`${t.name}${t.rowEstimate != null ? '\t~' + t.rowEstimate + ' rows' : ''}`);
    }
  }
  return 0;
};
