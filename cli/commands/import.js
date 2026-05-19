// import — 用 adapter 的 restore() 把 SQL 檔還原到目標 DB。
const path = require('path');
const fs = require('fs');
const { parseConnArgs } = require('../lib/conn');
const { _adapterDir } = require('./test');

exports.help = `dbmigrator import --type <db> --host <h> --database <name> --file <dump.sql|.enc> [--tables a,b] [--password-env VAR]

Restore a dialect-specific SQL file into a database. 自動偵測 .enc 加密檔頭，
需要 --password-env / --password 才能解密。

Options:
  --file <path>           the .sql or .sql.enc dump file (required)
  --tables <csv>          only these tables' statements get executed
  --password-env <VAR>    env var holding the dump password (for .enc files)
  --password <pw>         literal dump password（避免用 — 會落 shell history）
`;

exports.run = async (subArgs) => {
  const { type, conn, values } = parseConnArgs(subArgs, {
    file:   { type: 'string' },
    tables: { type: 'string' },
    'password-env': { type: 'string' },
    password:       { type: 'string' },
  });
  if (!values.file) throw new Error('--file <dump.sql> required');
  if (!fs.existsSync(values.file)) throw new Error(`file not found: ${values.file}`);

  const adapter = require(path.join(__dirname, '..', '..', 'node-express', 'adapters', _adapterDir(type)));
  const dc = require(path.join(__dirname, '..', '..', 'node-express', 'lib', 'dump-crypto'));

  // 偵測加密檔頭；有就先解密到 tmp，後續 flow 一律走 plaintext path
  let runPath = values.file;
  let cleanupFiltered = null;
  let cleanupDecrypted = null;
  if (dc.isEncryptedFile(values.file)) {
    const pw = dc.resolvePassword({
      password: values.password,
      passwordEnv: values['password-env'],
    });
    if (!pw) {
      throw new Error('encrypted dump requires --password-env <VAR> or --password <pw>');
    }
    const decPath = values.file + '.dec';
    await dc.decryptStream(values.file, decPath, pw);
    runPath = decPath;
    cleanupDecrypted = decPath;
    if (!values.quiet) console.error(`✓ decrypted → ${decPath}`);
  }

  // 若指定 --tables，就把 SQL 過濾過再 restore（跟 web 的 /api/import/run 同邏輯）
  // 注意 runPath 此時可能是 decrypted .dec — 過濾要讀 runPath 不是 values.file
  if (values.tables) {
    const wanted = values.tables.split(',').map((s) => s.trim()).filter(Boolean);
    const text = fs.readFileSync(runPath, 'utf8');
    let filtered;
    if (typeof adapter.filterDumpByTables === 'function') {
      filtered = adapter.filterDumpByTables(text, wanted);
    } else {
      const { filterSqlByTables } = require(path.join(__dirname, '..', '..', 'node-express', 'adapters', '_shared'));
      const quote = { mysql: '`', mssql: '[' }[type] || '"';
      filtered = filterSqlByTables(text, wanted, quote);
    }
    const filteredPath = runPath + '.filtered.sql';
    fs.writeFileSync(filteredPath, filtered.sql);
    runPath = filteredPath;
    cleanupFiltered = filteredPath;
    if (!values.quiet) console.error(`Filter: kept ${filtered.kept} stmts, skipped ${filtered.skipped}`);
  }

  const onProgress = values.quiet ? null : (m) => console.error(m);
  try {
    await adapter.restore(conn, runPath, onProgress);
    if (values.json) console.log(JSON.stringify({ ok: true }));
    else if (!values.quiet) console.error('✓ restore complete');
  } finally {
    if (cleanupFiltered) { try { fs.unlinkSync(cleanupFiltered); } catch {} }
    if (cleanupDecrypted) { try { fs.unlinkSync(cleanupDecrypted); } catch {} }
  }
  return 0;
};
