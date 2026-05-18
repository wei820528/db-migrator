// import — 用 adapter 的 restore() 把 SQL 檔還原到目標 DB。
const path = require('path');
const fs = require('fs');
const { parseConnArgs } = require('../lib/conn');
const { _adapterDir } = require('./test');

exports.help = `dbmigrator import --type <db> --host <h> --database <name> --file <dump.sql> [--tables a,b]

Restore a dialect-specific SQL file into a database.

Options:
  --file <path>   the .sql dump file (required)
  --tables <csv>  only these tables' statements get executed (uses filterSqlByTables)
`;

exports.run = async (subArgs) => {
  const { type, conn, values } = parseConnArgs(subArgs, {
    file:   { type: 'string' },
    tables: { type: 'string' },
  });
  if (!values.file) throw new Error('--file <dump.sql> required');
  if (!fs.existsSync(values.file)) throw new Error(`file not found: ${values.file}`);

  const adapter = require(path.join(__dirname, '..', '..', 'node-express', 'adapters', _adapterDir(type)));

  let runPath = values.file;
  let cleanupFiltered = null;

  // 若指定 --tables，就把 SQL 過濾過再 restore（跟 web 的 /api/import/run 同邏輯）
  if (values.tables) {
    const wanted = values.tables.split(',').map((s) => s.trim()).filter(Boolean);
    const text = fs.readFileSync(values.file, 'utf8');
    let filtered;
    if (typeof adapter.filterDumpByTables === 'function') {
      filtered = adapter.filterDumpByTables(text, wanted);
    } else {
      // SQL 系列走共用 filter
      const { filterSqlByTables } = require(path.join(__dirname, '..', '..', 'node-express', 'adapters', '_shared'));
      const quote = { mysql: '`', mssql: '[' }[type] || '"';
      filtered = filterSqlByTables(text, wanted, quote);
    }
    runPath = values.file + '.filtered.sql';
    fs.writeFileSync(runPath, filtered.sql);
    cleanupFiltered = runPath;
    if (!values.quiet) console.error(`Filter: kept ${filtered.kept} stmts, skipped ${filtered.skipped}`);
  }

  const onProgress = values.quiet ? null : (m) => console.error(m);
  try {
    await adapter.restore(conn, runPath, onProgress);
    if (values.json) console.log(JSON.stringify({ ok: true }));
    else if (!values.quiet) console.error('✓ restore complete');
  } finally {
    if (cleanupFiltered) { try { fs.unlinkSync(cleanupFiltered); } catch {} }
  }
  return 0;
};
