// export — 用 adapter 的 dump() 把資料寫成 dialect-specific SQL 檔。
const path = require('path');
const fs = require('fs');
const { parseConnArgs } = require('../lib/conn');
const { _adapterDir } = require('./test');

exports.help = `dbmigrator export --type <db> --host <h> --database <name> --out <file.sql> [--tables a,b,c] [--no-data] [--no-schema] [--encrypt --password-env VAR]

Dump a database to a dialect-specific SQL file (the same format the web UI 匯出 tab produces).

Options:
  --tables <csv>          only these tables (else all)
  --no-data               schema only
  --no-schema             data only
  --out <file>            output file path (required)
  --encrypt               AES-256-GCM encrypt the dump in-place; output goes to <out>.enc
  --password-env <VAR>    env var holding the dump password (recommended over --password)
  --password <pw>         literal dump password（避免用 — 會落 shell history）
`;

exports.run = async (subArgs) => {
  const { type, conn, values } = parseConnArgs(subArgs, {
    out:        { type: 'string' },
    tables:     { type: 'string' },
    'no-data':  { type: 'boolean', default: false },
    'no-schema':{ type: 'boolean', default: false },
    encrypt:        { type: 'boolean', default: false },
    'password-env': { type: 'string' },
    password:       { type: 'string' },
  });
  if (!values.out) throw new Error('--out <file.sql> required');

  // 加密前先解析 password — 失敗就早死，不要等 dump 跑完才發現
  let dumpPassword = null;
  if (values.encrypt) {
    const dc = require(path.join(__dirname, '..', '..', 'node-express', 'lib', 'dump-crypto'));
    dumpPassword = dc.resolvePassword({
      password: values.password,
      passwordEnv: values['password-env'],
    });
    if (!dumpPassword) {
      throw new Error('--encrypt requires --password-env <VAR> or --password <pw>');
    }
  }

  const adapter = require(path.join(__dirname, '..', '..', 'node-express', 'adapters', _adapterDir(type)));
  const options = {
    tables: values.tables ? values.tables.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    noData: values['no-data'],
    noSchema: values['no-schema'],
  };
  const onProgress = values.quiet ? null : (m) => console.error(m);
  await adapter.dump(conn, options, values.out, onProgress);

  let finalOut = values.out;
  let finalBytes = fs.statSync(values.out).size;
  if (dumpPassword) {
    const dc = require(path.join(__dirname, '..', '..', 'node-express', 'lib', 'dump-crypto'));
    const encOut = values.out + '.enc';
    dc.encryptFile(values.out, encOut, dumpPassword);
    fs.unlinkSync(values.out);
    finalOut = encOut;
    finalBytes = fs.statSync(encOut).size;
    if (!values.quiet) console.error(`✓ encrypted → ${encOut}`);
  }

  if (values.json) {
    console.log(JSON.stringify({ ok: true, out: finalOut, bytes: finalBytes, encrypted: !!dumpPassword }));
  } else if (!values.quiet) {
    console.error(`✓ wrote ${finalOut} (${finalBytes} bytes)`);
  }
  return 0;
};
