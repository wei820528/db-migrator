// dump-neutral — 用 adapter 的 dumpNeutral() 寫出 cross-DB-friendly JSONL。
// 只有 mysql / postgres / sqlite 三個 adapter 支援（v2 Theme B Phase 2）。
const path = require('path');
const fs = require('fs');
const { parseConnArgs } = require('../lib/conn');
const { _adapterDir } = require('./test');

exports.help = `dbmigrator dump-neutral --type <mysql|postgres|sqlite> --host <h> --database <name> --out <file.jsonl> [--tables a,b] [--no-data] [--encrypt --password-env VAR] [--s3-bucket <b> ...]

Dump a database in cross-DB-friendly JSONL format. The output can be restored
into any of mysql / postgres / sqlite via 'dbmigrator restore-neutral'.

Options:
  --out <file>            output JSONL path (required)
  --tables <csv>          only these tables (else all)
  --no-data               schema events only (no rows)
  --encrypt               AES-256-GCM encrypt; output goes to <out>.enc
  --password-env <VAR>    env var holding the dump password
  --password <pw>         literal dump password（避免用）
  --s3-bucket <name>      after dump (+optional encrypt), upload to S3
  --s3-prefix <p>         key prefix
  --s3-region <r>         AWS region
  --s3-endpoint <url>     custom S3 endpoint (MinIO / R2)
  --s3-delete-local       砍掉本機檔
`;

exports.run = async (subArgs) => {
  const { type, conn, values } = parseConnArgs(subArgs, {
    out:        { type: 'string' },
    tables:     { type: 'string' },
    'no-data':  { type: 'boolean', default: false },
    encrypt:        { type: 'boolean', default: false },
    'password-env': { type: 'string' },
    password:       { type: 'string' },
    's3-bucket':   { type: 'string' },
    's3-prefix':   { type: 'string' },
    's3-region':   { type: 'string' },
    's3-endpoint': { type: 'string' },
    's3-delete-local': { type: 'boolean', default: false },
  });
  if (!values.out) throw new Error('--out <file.jsonl> required');

  let dumpPassword = null;
  if (values.encrypt) {
    const dc = require(path.join(__dirname, '..', '..', 'node-express', 'lib', 'dump-crypto'));
    dumpPassword = dc.resolvePassword({
      password: values.password,
      passwordEnv: values['password-env'],
    });
    if (!dumpPassword) throw new Error('--encrypt requires --password-env <VAR> or --password <pw>');
  }

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

  let finalOut = values.out;
  let finalBytes = fs.statSync(values.out).size;
  if (dumpPassword) {
    const dc = require(path.join(__dirname, '..', '..', 'node-express', 'lib', 'dump-crypto'));
    const encOut = values.out + '.enc';
    await dc.encryptStream(values.out, encOut, dumpPassword);
    fs.unlinkSync(values.out);
    finalOut = encOut;
    finalBytes = fs.statSync(encOut).size;
    if (!values.quiet) console.error(`✓ encrypted → ${encOut}`);
  }

  let s3Info = null;
  const destS3 = require(path.join(__dirname, '..', '..', 'node-express', 'lib', 'dest-s3'));
  const s3Config = destS3.resolveS3Config(
    {
      s3: {
        bucket:    values['s3-bucket'],
        prefix:    values['s3-prefix'],
        region:    values['s3-region'],
        endpoint:  values['s3-endpoint'],
        deleteLocal: values['s3-delete-local'],
      },
    },
    process.env,
  );
  if (s3Config) {
    const key = destS3.buildObjectKey({
      keyPattern: s3Config.keyPattern,
      prefix: s3Config.prefix,
      dbName: conn.database || path.basename(finalOut),
      srcPath: finalOut,
    });
    s3Info = await destS3.uploadFile(finalOut, {
      ...s3Config, key, log: values.quiet ? null : (m) => console.error(m),
    });
    if (s3Config.deleteLocal) {
      fs.unlinkSync(finalOut);
      if (!values.quiet) console.error(`✓ removed local ${finalOut}`);
    }
  }

  if (values.json) console.log(JSON.stringify({
    ok: true,
    out: s3Config && s3Config.deleteLocal ? null : finalOut,
    bytes: finalBytes,
    encrypted: !!dumpPassword,
    s3: s3Info,
  }));
  else if (!values.quiet) {
    if (s3Info) console.error(`✓ uploaded to s3://${s3Info.bucket}/${s3Info.key}`);
    if (!(s3Config && s3Config.deleteLocal)) console.error(`✓ wrote ${finalOut} (${finalBytes} bytes)`);
  }
  return 0;
};
