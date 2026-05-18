// preview-crossdb — dry-run preview。讀 source 的 schema、預測 target dialect 的
// CREATE TABLE 跟 per-column 型別對映，印出 warnings。不執行。
const path = require('path');
const { parseArgs } = require('util');
const { _adapterDir } = require('./test');

exports.help = `dbmigrator preview-crossdb \\
    --source-type <mysql|postgres|sqlite> --source-host <h> --source-database <db> [--source-user <u>] [--source-password-env <ENV>] \\
    --target-type <mysql|postgres|sqlite> \\
    [--tables a,b]

Dry-run: read the source's getSchema(), feed each table into the cross-DB
preview helper, and print per-column source→target type mappings + warnings
for lossy translations. No data is touched on either side.
`;

exports.run = async (subArgs) => {
  const { values, positionals } = parseArgs({
    args: subArgs, allowPositionals: true,
    options: {
      'source-type':         { type: 'string' },
      'source-host':         { type: 'string' },
      'source-port':         { type: 'string' },
      'source-user':         { type: 'string' },
      'source-password':     { type: 'string' },
      'source-password-env': { type: 'string' },
      'source-database':     { type: 'string' },
      'source-path':         { type: 'string' },
      'source-ssl':          { type: 'boolean', default: false },
      'target-type':         { type: 'string' },
      tables:                { type: 'string' },
      json:                  { type: 'boolean', default: false },
      quiet:                 { type: 'boolean', default: false },
      help:                  { type: 'boolean', short: 'h' },
    },
  });

  if (!values['source-type']) throw new Error('--source-type required');
  if (!values['target-type']) throw new Error('--target-type required');

  // Resolve source password 同 conn.js 邏輯
  let password = values['source-password'];
  if (values['source-password-env']) {
    if (!(values['source-password-env'] in process.env)) {
      throw new Error(`env var ${values['source-password-env']} not set`);
    }
    password = process.env[values['source-password-env']];
  }

  const sourceType = values['source-type'];
  const sourceConn = {
    host:     values['source-host'],
    port:     values['source-port'] ? Number(values['source-port']) : 0,
    user:     values['source-user'],
    password,
    database: values['source-database'],
    path:     values['source-path'],
    ssl:      values['source-ssl'],
  };

  const sourceAdapter = require(path.join(__dirname, '..', '..', 'node-express', 'adapters', _adapterDir(sourceType)));
  if (typeof sourceAdapter.getSchema !== 'function') {
    throw new Error(`source adapter "${sourceType}" has no getSchema (need mysql / postgres / sqlite)`);
  }

  const tables = values.tables ? values.tables.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  const irTables = await sourceAdapter.getSchema(sourceConn, tables);
  const { buildTablePreview } = require(path.join(__dirname, '..', '..', 'node-express', 'lib', 'cross-db', 'preview'));
  const preview = irTables.map((ir) => buildTablePreview(ir, values['target-type']));
  const totalWarnings = preview.reduce((n, p) => n + p.warnings.length + p.columns.reduce((m, c) => m + c.warnings.length, 0), 0);

  if (values.json) {
    console.log(JSON.stringify({
      source: sourceType, target: values['target-type'],
      tableCount: preview.length, warningCount: totalWarnings, tables: preview,
    }, null, 2));
    return 0;
  }

  console.log(`${sourceType} → ${values['target-type']}  ·  ${preview.length} table(s)  ·  ${totalWarnings} warning(s)\n`);
  for (const t of preview) {
    console.log(`▶ ${t.table}`);
    for (const c of t.columns) {
      const attrs = [c.primaryKey && 'PK', c.autoIncrement && 'AI', c.nullable === false && 'NOT NULL'].filter(Boolean).join(' ');
      console.log(`    ${c.name.padEnd(20)} ${c.sourceType.padEnd(28)} →  ${c.targetType.padEnd(20)} ${attrs}`);
      for (const w of c.warnings) console.log(`        ⚠ ${w}`);
    }
    for (const w of t.warnings) console.log(`    ⚠ (table) ${w}`);
    console.log();
  }
  return 0;
};
