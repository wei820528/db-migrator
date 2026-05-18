// dump-neutral — 用 adapter 的 dumpNeutral() 寫出 cross-DB-friendly JSONL。
// 只有 mysql / postgres / sqlite 三個 adapter 支援（v2 Theme B Phase 2）。
const path = require('path');
const fs = require('fs');
const { parseConnArgs } = require('../lib/conn');
const { _adapterDir } = require('./test');

exports.help = `dbmigrator dump-neutral --type <mysql|postgres|sqlite> --host <h> --database <name> --out <file.jsonl> [--tables a,b] [--no-data]

Dump a database in cross-DB-friendly JSONL format. The output can be restored
into any of mysql / postgres / sqlite via 'dbmigrator restore-neutral'.

Options:
  --out <file>     output JSONL path (required)
  --tables <csv>   only these tables (else all)
  --no-data        schema events only (no rows)
`;

exports.run = async (subArgs) => {
  const { type, conn, values } = parseConnArgs(subArgs, {
    out:        { type: 'string' },
    tables:     { type: 'string' },
    'no-data':  { type: 'boolean', default: false },
  });
  if (!values.out) throw new Error('--out <file.jsonl> required');

  const adapter = require(path.join(__dirname, '..', '..', 'node-express', 'adapters', _adapterDir(type)));
  if (typeof adapter.dumpNeutral !== 'function') {
    throw new Error(`adapter "${type}" does not support neutral dump (only mysql / postgres / sqlite)`);
  }
  const options = {
    tables: values.tables ? values.tables.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    noData: values['no-data'],
  };
  const onProgress = values.quiet ? null : (m) => console.error(m);
  await adapter.dumpNeutral(conn, options, values.out, onProgress);
  const size = fs.statSync(values.out).size;
  if (values.json) console.log(JSON.stringify({ ok: true, out: values.out, bytes: size }));
  else if (!values.quiet) console.error(`✓ wrote ${values.out} (${size} bytes)`);
  return 0;
};
