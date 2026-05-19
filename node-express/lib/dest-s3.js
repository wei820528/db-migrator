// Cloud destination — S3 (Theme A Phase 2)
//
// 為什麼是 optionalDependency: @aws-sdk/client-s3 安裝後加 ~30MB；只有真的要
// 把 dump 推 S3 的人才會碰，普通本機跑不需要。
//
// 為什麼接 PutObject 而不 MultipartUpload：MVP 一刀；single PUT 上限 5GB，比 dump
// 大小通常夠用。大檔走 streaming chunked dump 是 Theme A Phase 3 的事，
// 屆時再上 @aws-sdk/lib-storage Upload helper（auto-multipart > 5MB）。
//
// 為什麼 client 用 DI（function param）：tests 不需要真的裝 SDK，stub 就能跑。
// Production runtime 走 lazyRequireClient() 動態 require 一次性建。

const fs = require('fs');
const path = require('path');

// 解析 S3 config — opts.s3 > env vars > null（→ skip upload）
//
// Options shape：
//   { bucket: 'my-backups', prefix: 'prod/', region: 'ap-northeast-1',
//     keyPattern?: '{prefix}{dbName}-{ts}{ext}',
//     deleteLocal?: false, endpoint?: 'http://minio:9000' }
//
// Env fallback：S3_BUCKET / S3_PREFIX / AWS_REGION (or S3_REGION)
// AWS credentials 走 AWS SDK 預設鏈（env / shared config / IAM role） — 我們不碰
function resolveS3Config(opts = {}, env = process.env) {
  const s3 = opts.s3 || {};
  const bucket = s3.bucket || env.S3_BUCKET;
  if (!bucket) return null;
  return {
    bucket,
    prefix:    s3.prefix    ?? env.S3_PREFIX    ?? '',
    region:    s3.region    ?? env.S3_REGION    ?? env.AWS_REGION,
    endpoint:  s3.endpoint  ?? env.S3_ENDPOINT,
    keyPattern: s3.keyPattern || '{prefix}{dbName}-{ts}{ext}',
    deleteLocal: s3.deleteLocal === true,   // default false — 不打破現有 download
    forcePathStyle: s3.forcePathStyle ?? (env.S3_FORCE_PATH_STYLE === 'true'),  // MinIO 之類
  };
}

// 從 file path / dbName / encrypted flag 拼 S3 object key
//
// keyPattern tokens：{prefix} {dbName} {ts} {ext} {basename}
//   prefix     — config.prefix 原樣（呼叫端如要 trailing slash 自己加）
//   dbName     — DB 名稱（safe-name 過）
//   ts         — ISO 8601 但 colon 換 dash (檔名友善): 2026-05-19T03-15-00
//   ext        — 自動偵測 .sql / .sql.enc / .jsonl / .jsonl.enc
//   basename   — fallback：原始檔名 (含 ext)
function buildObjectKey({ keyPattern, prefix, dbName, srcPath, now }) {
  const ts = (now || new Date()).toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');
  const ext = pickExt(srcPath);
  const base = path.basename(srcPath);
  const safeName = (dbName || stripExt(base)).replace(/[^A-Za-z0-9._-]+/g, '_');
  return (keyPattern || '{prefix}{dbName}-{ts}{ext}')
    .replace('{prefix}', prefix || '')
    .replace('{dbName}', safeName)
    .replace('{ts}', ts)
    .replace('{ext}', ext)
    .replace('{basename}', base);
}

// 抓「double extension」: 認 .sql.enc / .jsonl.enc / .sql / .jsonl 否則就 path.extname
function pickExt(p) {
  const lower = p.toLowerCase();
  if (lower.endsWith('.sql.enc'))   return '.sql.enc';
  if (lower.endsWith('.jsonl.enc')) return '.jsonl.enc';
  return path.extname(p);
}

function stripExt(name) {
  const ext = pickExt(name);
  return ext ? name.slice(0, -ext.length) : name;
}

// 100MB 以上自動走 multipart upload (@aws-sdk/lib-storage Upload)
// 之下走 PutObject — 不值得多 round trip overhead
const MULTIPART_THRESHOLD = 100 * 1024 * 1024;

// 真正 lazy require AWS SDK；只在 production runtime 跑到
function lazyRequireClient(region, endpoint, forcePathStyle) {
  let mod;
  try {
    mod = require('@aws-sdk/client-s3');
  } catch (e) {
    throw new Error(
      '@aws-sdk/client-s3 not installed — run `npm install @aws-sdk/client-s3` ' +
      '(或設 optionalDependencies 開放 npm install --include=optional)',
    );
  }
  const cfg = {};
  if (region) cfg.region = region;
  if (endpoint) cfg.endpoint = endpoint;
  if (forcePathStyle) cfg.forcePathStyle = true;
  return { client: new mod.S3Client(cfg), PutObjectCommand: mod.PutObjectCommand };
}

// Lazy require multipart helper — separate package。沒裝就 fallback PutObject
function lazyRequireUpload() {
  try {
    return require('@aws-sdk/lib-storage').Upload;
  } catch {
    return null;
  }
}

// 上傳檔到 S3。client / PutObjectCommand / Upload 都可由呼叫端注入（tests 用 stub）。
// 沒注入就 lazy require 真的 SDK。File > MULTIPART_THRESHOLD 自動 multipart。
async function uploadFile(srcPath, opts) {
  const { bucket, key, region, endpoint, forcePathStyle, log } = opts;
  let { client, PutObjectCommand, Upload } = opts;
  if (!client || !PutObjectCommand) {
    ({ client, PutObjectCommand } = lazyRequireClient(region, endpoint, forcePathStyle));
  }
  if (Upload === undefined) Upload = lazyRequireUpload();   // null = 嘗試過但沒裝
  const sizeBytes = fs.statSync(srcPath).size;
  const useMultipart = sizeBytes >= MULTIPART_THRESHOLD && !!Upload;
  const ContentType = srcPath.endsWith('.enc') ? 'application/octet-stream' : 'text/plain';

  if (log) {
    const mode = useMultipart ? 'multipart' : 'PutObject';
    log(`Uploading ${srcPath} → s3://${bucket}/${key} (${sizeBytes} bytes, ${mode})`);
  }

  if (useMultipart) {
    const u = new Upload({
      client,
      params: { Bucket: bucket, Key: key, Body: fs.createReadStream(srcPath), ContentType },
      queueSize: 4,
      partSize: 5 * 1024 * 1024,    // 5MB parts (AWS minimum for multipart)
      leavePartsOnError: false,
    });
    if (log && typeof u.on === 'function') {
      let lastPct = -1;
      u.on('httpUploadProgress', (p) => {
        if (p.total && p.loaded) {
          const pct = Math.floor((p.loaded / p.total) * 100);
          if (pct - lastPct >= 10) { log(`  …${pct}%`); lastPct = pct; }
        }
      });
    }
    const r = await u.done();
    if (log) log(`✓ uploaded s3://${bucket}/${key}` + (r.ETag ? ` (etag=${r.ETag})` : ''));
    return { bucket, key, etag: r.ETag, sizeBytes, multipart: true };
  }

  const cmd = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: fs.createReadStream(srcPath),
    ContentLength: sizeBytes,
    ContentType,
  });
  const r = await client.send(cmd);
  if (log) log(`✓ uploaded s3://${bucket}/${key}` + (r.ETag ? ` (etag=${r.ETag})` : ''));
  return { bucket, key, etag: r.ETag, sizeBytes, multipart: false };
}

module.exports = {
  resolveS3Config,
  buildObjectKey,
  uploadFile,
  MULTIPART_THRESHOLD,
  _internal: { lazyRequireClient, lazyRequireUpload, pickExt, stripExt },
};
