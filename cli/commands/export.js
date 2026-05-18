// export — 用 adapter 的 dump() 把資料寫成 dialect-specific SQL 檔。
const path = require('path');
const fs = require('fs');
const { parseConnArgs } = require('../lib/conn');
const { _adapterDir } = require('./test');

exports.help = `dbmigrator export --type <db> --host <h> --database <name> --out <file.sql> [--tables a,b,c] [--no-data] [--no-schema]

Dump a database to a dialect-specific SQL file (the same format the web UI 匯出 tab produces).

Options:
  --tables <csv>   only these tables (else all)
  --no-data        schema only
  --no-schema      data only
  --out <file>     output file path (required)
`;

exports.run = async (subArgs) => {
  const { type, conn, values } = parseConnArgs(subArgs, {
    out:        { type: 'string' },
    tables:     { type: 'string' },
    'no-data':  { type: 'boolean', default: false },
    'no-schema':{ type: 'boolean', default: false },
  });
  if (!values.out) throw new Error('--out <file.sql> required');

  const adapter = require(path.join(__dirname, '..', '..', 'node-express', 'adapters', _adapterDir(type)));
  const options = {
    tables: values.tables ? values.tables.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    noData: values['no-data'],
    noSchema: values['no-schema'],
  };
  const onProgress = values.quiet ? null : (m) => console.error(m);
  await adapter.dump(conn, options, values.out, onProgress);
  const size = fs.statSync(values.out).size;
  if (values.json) {
    console.log(JSON.stringify({ ok: true, out: values.out, bytes: size }));
  } else if (!values.quiet) {
    console.error(`✓ wrote ${values.out} (${size} bytes)`);
  }
  return 0;
};
