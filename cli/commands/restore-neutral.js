// restore-neutral — 把任何 source 產的 neutral JSONL 還原到 mysql / postgres / sqlite。
const path = require('path');
const fs = require('fs');
const { parseConnArgs } = require('../lib/conn');
const { _adapterDir } = require('./test');

exports.help = `dbmigrator restore-neutral --type <mysql|postgres|sqlite> --host <h> --database <name> --file <dump.jsonl|.enc> [--password-env VAR]

Restore from a neutral JSONL (produced by 'dump-neutral' on any source dialect).
Emits target-dialect CREATE TABLE + parameterized INSERTs. Warns on lossy
translations (e.g. unsigned int into PG, JSON into SQLite).

自動偵測 .enc 加密檔頭。

Options:
  --file <path>           the .jsonl or .jsonl.enc dump file (required)
  --password-env <VAR>    env var holding the dump password (for .enc files)
  --password <pw>         literal dump password（避免用）
`;

exports.run = async (subArgs) => {
  const { type, conn, values } = parseConnArgs(subArgs, {
    file: { type: 'string' },
    'password-env': { type: 'string' },
    password:       { type: 'string' },
  });
  if (!values.file) throw new Error('--file <dump.jsonl> required');
  if (!fs.existsSync(values.file)) throw new Error(`file not found: ${values.file}`);

  const adapter = require(path.join(__dirname, '..', '..', 'node-express', 'adapters', _adapterDir(type)));
  if (typeof adapter.restoreNeutral !== 'function') {
    throw new Error(`adapter "${type}" does not support neutral restore (only mysql / postgres / sqlite)`);
  }
  const dc = require(path.join(__dirname, '..', '..', 'node-express', 'lib', 'dump-crypto'));

  let runPath = values.file;
  let cleanupDecrypted = null;
  if (dc.isEncryptedFile(values.file)) {
    const pw = dc.resolvePassword({
      password: values.password,
      passwordEnv: values['password-env'],
    });
    if (!pw) throw new Error('encrypted dump requires --password-env <VAR> or --password <pw>');
    const decPath = values.file + '.dec';
    await dc.decryptStream(values.file, decPath, pw);
    runPath = decPath;
    cleanupDecrypted = decPath;
    if (!values.quiet) console.error(`✓ decrypted → ${decPath}`);
  }

  const onProgress = values.quiet ? null : (m) => console.error(m);
  try {
    const r = await adapter.restoreNeutral(conn, runPath, onProgress);
    if (values.json) console.log(JSON.stringify(r));
    else if (!values.quiet) {
      if (r.warnings?.length) console.error(`Warnings (${r.warnings.length}):`);
      for (const w of (r.warnings || [])) console.error('  • ' + w);
      console.error('✓ restore complete');
    }
  } finally {
    if (cleanupDecrypted) { try { fs.unlinkSync(cleanupDecrypted); } catch {} }
  }
  return 0;
};
