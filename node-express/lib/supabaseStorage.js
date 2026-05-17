const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

function client(url, serviceKey) {
  if (!url || !serviceKey) throw new Error('Supabase URL and service_role key required');
  return createClient(url, serviceKey, { auth: { persistSession: false } });
}

async function listAllBuckets(supabase) {
  const { data, error } = await supabase.storage.listBuckets();
  if (error) throw new Error(`listBuckets: ${error.message}`);
  return data || [];
}

// Recursively list all files in a bucket. Supabase API only lists one folder at a time.
async function listAllFiles(supabase, bucketName, prefix = '') {
  const out = [];
  let offset = 0;
  const limit = 1000;
  while (true) {
    const { data, error } = await supabase.storage
      .from(bucketName)
      .list(prefix, { limit, offset, sortBy: { column: 'name', order: 'asc' } });
    if (error) throw new Error(`list ${bucketName}/${prefix}: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const item of data) {
      const full = prefix ? `${prefix}/${item.name}` : item.name;
      // Folders have id === null
      if (item.id === null) {
        const sub = await listAllFiles(supabase, bucketName, full);
        out.push(...sub);
      } else {
        out.push({ name: item.name, path: full, size: item.metadata?.size ?? 0 });
      }
    }
    if (data.length < limit) break;
    offset += data.length;
  }
  return out;
}

async function downloadAll({ url, serviceKey }, destDir, onProgress) {
  const supabase = client(url, serviceKey);
  fs.mkdirSync(destDir, { recursive: true });

  const buckets = await listAllBuckets(supabase);
  onProgress?.(`Found ${buckets.length} bucket(s)`);

  let totalFiles = 0;
  for (const bucket of buckets) {
    onProgress?.(`> bucket: ${bucket.name}`);
    const files = await listAllFiles(supabase, bucket.name);
    onProgress?.(`  ${files.length} file(s)`);
    const bucketDir = path.join(destDir, bucket.name);
    fs.mkdirSync(bucketDir, { recursive: true });

    // Save bucket metadata for restore
    fs.writeFileSync(
      path.join(destDir, `${bucket.name}.bucket.json`),
      JSON.stringify({ id: bucket.id, name: bucket.name, public: bucket.public }, null, 2)
    );

    for (const f of files) {
      const { data, error } = await supabase.storage.from(bucket.name).download(f.path);
      if (error) { onProgress?.(`  ! ${f.path}: ${error.message}`); continue; }
      const localPath = path.join(bucketDir, f.path);
      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      const buf = Buffer.from(await data.arrayBuffer());
      fs.writeFileSync(localPath, buf);
      totalFiles++;
      if (totalFiles % 50 === 0) onProgress?.(`  downloaded ${totalFiles} file(s)...`);
    }
  }
  onProgress?.(`Total: ${totalFiles} file(s) across ${buckets.length} bucket(s)`);
  return { bucketCount: buckets.length, fileCount: totalFiles };
}

async function uploadAll({ url, serviceKey }, srcDir, onProgress) {
  const supabase = client(url, serviceKey);
  if (!fs.existsSync(srcDir)) {
    onProgress?.('No storage dir in backup, skipping');
    return { bucketCount: 0, fileCount: 0 };
  }

  const existingBuckets = (await listAllBuckets(supabase)).map((b) => b.name);

  // Find bucket dirs (anything that's a directory in srcDir, also matched by .bucket.json)
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  const bucketDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

  let totalFiles = 0;
  for (const bucketName of bucketDirs) {
    onProgress?.(`> bucket: ${bucketName}`);

    // Create bucket if missing
    if (!existingBuckets.includes(bucketName)) {
      const metaPath = path.join(srcDir, `${bucketName}.bucket.json`);
      let meta = { public: false };
      if (fs.existsSync(metaPath)) {
        try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch {}
      }
      const { error } = await supabase.storage.createBucket(bucketName, { public: meta.public });
      if (error) {
        onProgress?.(`  ! createBucket failed: ${error.message}`);
        continue;
      }
      onProgress?.(`  created bucket (public=${meta.public})`);
    }

    const bucketDir = path.join(srcDir, bucketName);
    const files = walk(bucketDir);
    onProgress?.(`  uploading ${files.length} file(s)...`);
    for (const localPath of files) {
      const relPath = path.relative(bucketDir, localPath).replace(/\\/g, '/');
      const buf = fs.readFileSync(localPath);
      const { error } = await supabase.storage.from(bucketName).upload(relPath, buf, {
        upsert: true,
        contentType: 'application/octet-stream',
      });
      if (error) { onProgress?.(`  ! ${relPath}: ${error.message}`); continue; }
      totalFiles++;
      if (totalFiles % 50 === 0) onProgress?.(`  uploaded ${totalFiles} file(s)...`);
    }
  }
  onProgress?.(`Total: ${totalFiles} file(s) across ${bucketDirs.length} bucket(s)`);
  return { bucketCount: bucketDirs.length, fileCount: totalFiles };
}

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

module.exports = { downloadAll, uploadAll };
