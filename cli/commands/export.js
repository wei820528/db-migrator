// export — 用 adapter 的 dump() 把資料寫成 dialect-specific SQL 檔。
const path = require('path');
const fs = require('fs');
const { parseConnArgs } = require('../lib/conn');
const { _adapterDir } = require('./test');

exports.help = `dbmigrator export --type <db> --host <h> --database <name> --out <file.sql> [--tables a,b,c] [--no-data] [--no-schema] [--encrypt --password-env VAR] [--s3-bucket <b> [--s3-prefix <p>] [--s3-region <r>] [--s3-delete-local]]

Dump a database to a dialect-specific SQL file (the same format the web UI 匯出 tab produces).

Options:
  --tables <csv>          only these tables (else all)
  --no-data               schema only
  --no-schema             data only
  --out <file>            output file path (required)
  --encrypt               AES-256-GCM encrypt the dump in-place; output goes to <out>.enc
  --password-env <VAR>    env var holding the dump password (recommended over --password)
  --password <pw>         literal dump password（避免用 — 會落 shell history）
  --s3-bucket <name>      after dump (+optional encrypt), upload to s3://bucket/...
  --s3-prefix <p>         key prefix (default empty)
  --s3-region <r>         AWS region (default AWS_REGION env)
  --s3-endpoint <url>     custom S3 endpoint (MinIO / R2)
  --s3-delete-local       砍掉本機檔（純 S3 archive 模式）
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
    's3-bucket':   { type: 'string' },
    's3-prefix':   { type: 'string' },
    's3-region':   { type: 'string' },
    's3-endpoint': { type: 'string' },
    's3-delete-local': { type: 'boolean', default: false },
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

  // S3 upload (after encryption — encrypt-at-rest)
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

  if (values.json) {
    console.log(JSON.stringify({
      ok: true,
      out: s3Config && s3Config.deleteLocal ? null : finalOut,
      bytes: finalBytes,
      encrypted: !!dumpPassword,
      s3: s3Info,
    }));
  } else if (!values.quiet) {
    if (s3Info) console.error(`✓ uploaded to s3://${s3Info.bucket}/${s3Info.key}`);
    if (!(s3Config && s3Config.deleteLocal)) console.error(`✓ wrote ${finalOut} (${finalBytes} bytes)`);
  }
  return 0;
};
