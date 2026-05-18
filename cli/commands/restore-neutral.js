// restore-neutral — 把任何 source 產的 neutral JSONL 還原到 mysql / postgres / sqlite。
const path = require('path');
const fs = require('fs');
const { parseConnArgs } = require('../lib/conn');
const { _adapterDir } = require('./test');

exports.help = `dbmigrator restore-neutral --type <mysql|postgres|sqlite> --host <h> --database <name> --file <dump.jsonl>

Restore from a neutral JSONL (produced by 'dump-neutral' on any source dialect).
Emits target-dialect CREATE TABLE + parameterized INSERTs. Warns on lossy
translations (e.g. unsigned int into PG, JSON into SQLite).
`;

exports.run = async (subArgs) => {
  const { type, conn, values } = parseConnArgs(subArgs, {
    file: { type: 'string' },
  });
  if (!values.file) throw new Error('--file <dump.jsonl> required');
  if (!fs.existsSync(values.file)) throw new Error(`file not found: ${values.file}`);

  const adapter = require(path.join(__dirname, '..', '..', 'node-express', 'adapters', _adapterDir(type)));
  if (typeof adapter.restoreNeutral !== 'function') {
    throw new Error(`adapter "${type}" does not support neutral restore (only mysql / postgres / sqlite)`);
  }
  const onProgress = values.quiet ? null : (m) => console.error(m);
  const r = await adapter.restoreNeutral(conn, values.file, onProgress);
  if (values.json) console.log(JSON.stringify(r));
  else if (!values.quiet) {
    if (r.warnings?.length) console.error(`Warnings (${r.warnings.length}):`);
    for (const w of (r.warnings || [])) console.error('  • ' + w);
    console.error('✓ restore complete');
  }
  return 0;
};
