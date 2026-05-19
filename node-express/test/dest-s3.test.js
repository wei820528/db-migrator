// v2 Theme A Phase 2 tests — S3 cloud destination。
//
// 不真的打 S3 — uploadFile() 吃注入的 client/PutObjectCommand。Config 解析跟
// key pattern 都是純函式。AWS SDK 沒裝也跑得起來（lazyRequire 只在真實 runtime
// 路徑碰到）。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const dest = require('../lib/dest-s3');

function tmpFile(content, suffix = '.sql') {
  const p = path.join(os.tmpdir(), `dbm-s3-test-${crypto.randomUUID()}${suffix}`);
  fs.writeFileSync(p, content);
  return p;
}

// ============ resolveS3Config ============

test('resolveS3Config: no bucket anywhere → null', () => {
  const env = {};
  assert.strictEqual(dest.resolveS3Config({}, env), null);
  assert.strictEqual(dest.resolveS3Config({ s3: {} }, env), null);
});

test('resolveS3Config: opts.s3.bucket takes priority over env', () => {
  const cfg = dest.resolveS3Config({ s3: { bucket: 'from-opts' } }, { S3_BUCKET: 'from-env' });
  assert.strictEqual(cfg.bucket, 'from-opts');
});

test('resolveS3Config: env fallback works', () => {
  const cfg = dest.resolveS3Config({}, {
    S3_BUCKET: 'envb', S3_PREFIX: 'prod/', AWS_REGION: 'us-west-2',
  });
  assert.strictEqual(cfg.bucket, 'envb');
  assert.strictEqual(cfg.prefix, 'prod/');
  assert.strictEqual(cfg.region, 'us-west-2');
});

test('resolveS3Config: S3_REGION wins over AWS_REGION', () => {
  const cfg = dest.resolveS3Config({}, {
    S3_BUCKET: 'b', S3_REGION: 'eu-west-1', AWS_REGION: 'us-west-2',
  });
  assert.strictEqual(cfg.region, 'eu-west-1');
});

test('resolveS3Config: defaults — deleteLocal false, default keyPattern, empty prefix', () => {
  const cfg = dest.resolveS3Config({ s3: { bucket: 'b' } }, {});
  assert.strictEqual(cfg.deleteLocal, false);
  assert.strictEqual(cfg.prefix, '');
  assert.strictEqual(cfg.keyPattern, '{prefix}{dbName}-{ts}{ext}');
});

test('resolveS3Config: deleteLocal:true 才會傳遞', () => {
  assert.strictEqual(dest.resolveS3Config({ s3: { bucket: 'b', deleteLocal: true } }, {}).deleteLocal, true);
  assert.strictEqual(dest.resolveS3Config({ s3: { bucket: 'b', deleteLocal: 'true' } }, {}).deleteLocal, false);  // strict bool only
});

test('resolveS3Config: forcePathStyle from env (MinIO style)', () => {
  const cfg = dest.resolveS3Config({ s3: { bucket: 'b' } }, { S3_FORCE_PATH_STYLE: 'true' });
  assert.strictEqual(cfg.forcePathStyle, true);
});

test('resolveS3Config: custom endpoint (MinIO / Cloudflare R2)', () => {
  const cfg = dest.resolveS3Config({ s3: { bucket: 'b', endpoint: 'https://my-minio:9000' } }, {});
  assert.strictEqual(cfg.endpoint, 'https://my-minio:9000');
});

// ============ buildObjectKey ============

test('buildObjectKey: default pattern { prefix dbName ts ext }', () => {
  const k = dest.buildObjectKey({
    keyPattern: '{prefix}{dbName}-{ts}{ext}',
    prefix: 'prod/',
    dbName: 'orders',
    srcPath: '/tmp/whatever.sql',
    now: new Date('2026-05-19T03:15:30.123Z'),
  });
  assert.strictEqual(k, 'prod/orders-2026-05-19T03-15-30Z.sql');
});

test('buildObjectKey: .sql.enc double-extension preserved', () => {
  const k = dest.buildObjectKey({
    keyPattern: '{prefix}{dbName}-{ts}{ext}',
    prefix: '',
    dbName: 'orders',
    srcPath: '/tmp/orders.sql.enc',
    now: new Date('2026-05-19T00:00:00Z'),
  });
  assert.ok(k.endsWith('.sql.enc'), `expected .sql.enc, got ${k}`);
});

test('buildObjectKey: .jsonl.enc double-extension preserved', () => {
  const k = dest.buildObjectKey({
    keyPattern: '{prefix}{dbName}-{ts}{ext}',
    prefix: '',
    dbName: 'x',
    srcPath: '/tmp/x.jsonl.enc',
    now: new Date('2026-05-19T00:00:00Z'),
  });
  assert.ok(k.endsWith('.jsonl.enc'));
});

test('buildObjectKey: unsafe dbName chars normalized', () => {
  const k = dest.buildObjectKey({
    keyPattern: '{prefix}{dbName}-{ts}{ext}',
    prefix: '',
    dbName: 'db with/slash and "quote"',
    srcPath: '/tmp/x.sql',
    now: new Date('2026-05-19T00:00:00Z'),
  });
  // 空白、斜線、雙引號都被換成 _
  assert.ok(/^db_with_slash_and_quote_-/.test(k), `unexpected key: ${k}`);
});

test('buildObjectKey: {basename} token', () => {
  const k = dest.buildObjectKey({
    keyPattern: '{prefix}{basename}',
    prefix: 'raw/',
    srcPath: '/tmp/orders.sql',
    now: new Date(),
  });
  assert.strictEqual(k, 'raw/orders.sql');
});

test('buildObjectKey: timestamp 用 dash (S3 key 不能用 colon)', () => {
  const k = dest.buildObjectKey({
    keyPattern: '{ts}',
    srcPath: '/tmp/x.sql',
    now: new Date('2026-05-19T03:15:30.500Z'),
  });
  // 不該有 colon 也不該有 period (S3 OK 但會亂)
  assert.ok(!k.includes(':'));
  assert.ok(!k.includes('.500'));   // millis 應該被 dash 化掉再尾砍
});

// ============ uploadFile (stubbed client) ============

function makeStubClient(resp = { ETag: '"stub-etag"' }, sentCalls = []) {
  return {
    sentCalls,
    async send(cmd) {
      // 把 Body stream 排乾，避免 fs.createReadStream 在 test 後才開檔
      // (Node test runner 抓到 lazy I/O 會把 test 標 fail)
      if (cmd.input && cmd.input.Body && typeof cmd.input.Body.on === 'function') {
        await new Promise((resolve, reject) => {
          cmd.input.Body.on('data', () => {});
          cmd.input.Body.on('end', resolve);
          cmd.input.Body.on('error', reject);
        });
      }
      sentCalls.push(cmd);
      return resp;
    },
  };
}

class FakePutObjectCommand {
  constructor(input) { this.input = input; this.__cmd = 'PutObject'; }
}

test('uploadFile: 真的 send PutObjectCommand 帶 Bucket/Key/Body', async () => {
  const tmp = tmpFile('hello world');
  try {
    const sent = [];
    const r = await dest.uploadFile(tmp, {
      bucket: 'mybucket', key: 'a/b.sql',
      client: makeStubClient({ ETag: '"x"' }, sent),
      PutObjectCommand: FakePutObjectCommand,
    });
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].input.Bucket, 'mybucket');
    assert.strictEqual(sent[0].input.Key, 'a/b.sql');
    assert.strictEqual(sent[0].input.ContentLength, fs.statSync(tmp).size);
    assert.ok(sent[0].input.Body);          // stream — 沒驗 internals
    assert.strictEqual(r.bucket, 'mybucket');
    assert.strictEqual(r.key, 'a/b.sql');
    assert.strictEqual(r.etag, '"x"');
  } finally { fs.unlinkSync(tmp); }
});

test('uploadFile: .enc 檔 ContentType 是 octet-stream，.sql 是 text/plain', async () => {
  const encFile = tmpFile('xxx', '.sql.enc');
  const sqlFile = tmpFile('CREATE TABLE');
  try {
    const sent = [];
    const c = makeStubClient(undefined, sent);
    await dest.uploadFile(encFile, { bucket: 'b', key: 'k1', client: c, PutObjectCommand: FakePutObjectCommand });
    await dest.uploadFile(sqlFile, { bucket: 'b', key: 'k2', client: c, PutObjectCommand: FakePutObjectCommand });
    assert.strictEqual(sent[0].input.ContentType, 'application/octet-stream');
    assert.strictEqual(sent[1].input.ContentType, 'text/plain');
  } finally {
    fs.unlinkSync(encFile); fs.unlinkSync(sqlFile);
  }
});

test('uploadFile: log callback 被叫到', async () => {
  const tmp = tmpFile('data');
  try {
    const lines = [];
    await dest.uploadFile(tmp, {
      bucket: 'b', key: 'k', log: (m) => lines.push(m),
      client: makeStubClient(undefined, []),
      PutObjectCommand: FakePutObjectCommand,
    });
    assert.ok(lines.some((l) => l.includes('Uploading')), `no Uploading log: ${lines}`);
    assert.ok(lines.some((l) => l.includes('uploaded')), `no done log: ${lines}`);
  } finally { fs.unlinkSync(tmp); }
});

test('uploadFile: 沒注入 client 又沒裝 SDK → throw 訊息提示裝法', async () => {
  // 已知 @aws-sdk/client-s3 在 test env 沒裝（optionalDependencies）
  const tmp = tmpFile('x');
  try {
    await assert.rejects(
      dest.uploadFile(tmp, { bucket: 'b', key: 'k' }),
      /@aws-sdk\/client-s3 not installed/,
    );
  } finally { fs.unlinkSync(tmp); }
});

// ============ Phase 3: multipart upload path ============

// Stub Upload class — 模擬 @aws-sdk/lib-storage 的 Upload
class FakeUpload {
  constructor(opts) { this.opts = opts; FakeUpload.lastInstance = this; this._listeners = {}; }
  on(ev, cb) { this._listeners[ev] = cb; return this; }
  async done() {
    // 排乾 Body stream（同 PutObject stub），然後 fire 一次 progress
    if (this.opts.params.Body && typeof this.opts.params.Body.on === 'function') {
      await new Promise((res, rej) => {
        this.opts.params.Body.on('data', () => {});
        this.opts.params.Body.on('end', res);
        this.opts.params.Body.on('error', rej);
      });
    }
    if (this._listeners.httpUploadProgress) {
      this._listeners.httpUploadProgress({ loaded: 100, total: 100 });
    }
    return { ETag: '"multipart-etag"' };
  }
}

test('uploadFile: 小檔 (< threshold) 走 PutObject 即使有 Upload', async () => {
  const tmp = tmpFile('small payload');
  try {
    const sent = [];
    const r = await dest.uploadFile(tmp, {
      bucket: 'b', key: 'k',
      client: makeStubClient(undefined, sent),
      PutObjectCommand: FakePutObjectCommand,
      Upload: FakeUpload,
    });
    assert.strictEqual(r.multipart, false);
    assert.strictEqual(sent.length, 1);              // PutObject path 有 send
    assert.strictEqual(FakeUpload.lastInstance, undefined);  // multipart 沒被 new
  } finally { fs.unlinkSync(tmp); }
});

test('uploadFile: 大檔 (>= threshold) 走 multipart Upload', async () => {
  const tmp = path.join(os.tmpdir(), `dbm-s3-big-${crypto.randomUUID()}.bin`);
  // 寫剛好 threshold 大小（不要寫超大耗 RAM — 反正只是 stat check）
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.ftruncateSync(fd, dest.MULTIPART_THRESHOLD);  // sparse file，stat size 對得上
  } finally { fs.closeSync(fd); }
  try {
    FakeUpload.lastInstance = undefined;
    const sent = [];
    const r = await dest.uploadFile(tmp, {
      bucket: 'b', key: 'big.sql',
      client: makeStubClient(undefined, sent),
      PutObjectCommand: FakePutObjectCommand,
      Upload: FakeUpload,
    });
    assert.strictEqual(r.multipart, true);
    assert.strictEqual(r.etag, '"multipart-etag"');
    assert.strictEqual(sent.length, 0);              // PutObject 沒被叫
    assert.ok(FakeUpload.lastInstance);              // Upload 真的被 new
    assert.strictEqual(FakeUpload.lastInstance.opts.params.Bucket, 'b');
    assert.strictEqual(FakeUpload.lastInstance.opts.params.Key, 'big.sql');
  } finally { fs.unlinkSync(tmp); }
});

test('uploadFile: 大檔但 Upload=null (lib-storage 沒裝) → fallback PutObject', async () => {
  const tmp = path.join(os.tmpdir(), `dbm-s3-big-${crypto.randomUUID()}.bin`);
  const fd = fs.openSync(tmp, 'w');
  try { fs.ftruncateSync(fd, dest.MULTIPART_THRESHOLD); } finally { fs.closeSync(fd); }
  try {
    const sent = [];
    const r = await dest.uploadFile(tmp, {
      bucket: 'b', key: 'big.sql',
      client: makeStubClient(undefined, sent),
      PutObjectCommand: FakePutObjectCommand,
      Upload: null,    // 明確說沒 lib-storage
    });
    assert.strictEqual(r.multipart, false);
    assert.strictEqual(sent.length, 1);
  } finally { fs.unlinkSync(tmp); }
});

test('uploadFile: multipart progress callback 被 log', async () => {
  const tmp = path.join(os.tmpdir(), `dbm-s3-big-${crypto.randomUUID()}.bin`);
  const fd = fs.openSync(tmp, 'w');
  try { fs.ftruncateSync(fd, dest.MULTIPART_THRESHOLD); } finally { fs.closeSync(fd); }
  try {
    const lines = [];
    await dest.uploadFile(tmp, {
      bucket: 'b', key: 'k', log: (m) => lines.push(m),
      client: makeStubClient(undefined, []),
      PutObjectCommand: FakePutObjectCommand,
      Upload: FakeUpload,
    });
    assert.ok(lines.some((l) => l.includes('multipart')), `no multipart marker in log: ${lines}`);
    assert.ok(lines.some((l) => l.includes('100%')), `no progress marker in log: ${lines}`);
  } finally { fs.unlinkSync(tmp); }
});

// ============ pickExt / stripExt edge cases ============

test('pickExt: 認雙副檔名 .sql.enc', () => {
  assert.strictEqual(dest._internal.pickExt('/foo/bar.sql.enc'), '.sql.enc');
});
test('pickExt: 認 .jsonl.enc', () => {
  assert.strictEqual(dest._internal.pickExt('foo.jsonl.enc'), '.jsonl.enc');
});
test('pickExt: 普通單副檔名', () => {
  assert.strictEqual(dest._internal.pickExt('x.sql'), '.sql');
  assert.strictEqual(dest._internal.pickExt('x.jsonl'), '.jsonl');
  assert.strictEqual(dest._internal.pickExt('x.txt'), '.txt');
});
test('pickExt: 沒副檔名', () => {
  assert.strictEqual(dest._internal.pickExt('README'), '');
});
test('stripExt: 拿掉 .sql.enc 還原原名', () => {
  assert.strictEqual(dest._internal.stripExt('orders.sql.enc'), 'orders');
  assert.strictEqual(dest._internal.stripExt('orders.sql'), 'orders');
});
