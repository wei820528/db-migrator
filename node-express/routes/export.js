const router = require('express').Router();
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const { getAdapter } = require('../adapters');
const jobs = require('../lib/jobs');
const dumpCrypto = require('../lib/dump-crypto');

const TMP_DIR = path.join(__dirname, '..', 'tmp');

// Sanitize a filename so it's safe for the filesystem.
function safeName(s) {
  return String(s).replace(/[<>:"/\\|?*\s]+/g, '_').slice(0, 100) || 'dump';
}

function zipDir(srcDir, outFile) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(outFile);
    const archive = archiver('zip', { zlib: { level: 6 } });
    out.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(out);
    archive.directory(srcDir, false);
    archive.finalize();
  });
}

router.post('/', async (req, res) => {
  const { type, connection, databases, options = {} } = req.body || {};
  if (!type || !connection) return res.status(400).json({ error: 'type and connection required' });
  if (!Array.isArray(databases) || databases.length === 0)
    return res.status(400).json({ error: 'databases array required (at least one)' });

  let adapter;
  try { adapter = getAdapter(type); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  // 加密選項：options.encrypt:true 觸發；password 一律走 env (避免落 request body)
  // env var 名預設 DBMIGRATOR_DUMP_PASSWORD，可被 options.passwordEnv override
  let dumpPassword = null;
  if (options.encrypt) {
    try {
      dumpPassword = dumpCrypto.resolvePassword({
        passwordEnv: options.passwordEnv || 'DBMIGRATOR_DUMP_PASSWORD',
      });
    } catch (e) {
      return res.status(400).json({ error: `encryption requested: ${e.message}` });
    }
    if (!dumpPassword) {
      return res.status(400).json({
        error: 'encryption requested but no password — set DBMIGRATOR_DUMP_PASSWORD env',
      });
    }
  }

  const job = jobs.create('export');
  const jobDir = path.join(TMP_DIR, job.id);
  fs.mkdirSync(jobDir, { recursive: true });

  jobs.setStatus(job.id, 'running');
  res.json({ jobId: job.id });

  (async () => {
    try {
      const filesDir = path.join(jobDir, 'sql');
      fs.mkdirSync(filesDir, { recursive: true });

      for (const db of databases) {
        jobs.append(job.id, `=== ${db} ===`);
        const perDbConn = type === 'sqlite'
          ? { ...connection, path: db }
          : { ...connection, database: db };
        const outFile = path.join(filesDir, `${safeName(db)}.sql`);
        await adapter.dump(perDbConn, options, outFile, (line) => jobs.append(job.id, line));

        // 寫完之後 (in-place) 加密成 .enc，原檔砍掉避免 plaintext 留在 tmp
        if (dumpPassword) {
          const encFile = outFile + '.enc';
          dumpCrypto.encryptFile(outFile, encFile, dumpPassword);
          fs.unlinkSync(outFile);
          jobs.append(job.id, `Encrypted → ${path.basename(encFile)}`);
        }
      }

      let downloadUrl;
      if (databases.length === 1) {
        downloadUrl = `/api/export/${job.id}/file`;
      } else {
        const zipPath = path.join(jobDir, 'dumps.zip');
        jobs.append(job.id, `Packing ${databases.length} dump(s) into zip...`);
        await zipDir(filesDir, zipPath);
        downloadUrl = `/api/export/${job.id}/zip`;
      }

      jobs.setStatus(job.id, 'done', {
        result: { downloadUrl, count: databases.length, encrypted: !!dumpPassword },
      });
    } catch (e) {
      console.error('[export] failed:', e);
      jobs.setStatus(job.id, 'error', { error: e.message || String(e) });
    }
  })();
});

router.get('/:id/file', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== 'done') return res.status(404).json({ error: 'Not ready' });
  const filesDir = path.join(TMP_DIR, req.params.id, 'sql');
  const files = fs.existsSync(filesDir) ? fs.readdirSync(filesDir) : [];
  // 加密過會是 .sql.enc；優先給 .enc，沒才回 .sql
  const enc = files.find((f) => f.endsWith('.sql.enc'));
  const sql = files.find((f) => f.endsWith('.sql'));
  const pick = enc || sql;
  if (!pick) return res.status(404).json({ error: 'File missing' });
  res.download(path.join(filesDir, pick));
});

router.get('/:id/zip', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== 'done') return res.status(404).json({ error: 'Not ready' });
  const zipPath = path.join(TMP_DIR, req.params.id, 'dumps.zip');
  if (!fs.existsSync(zipPath)) return res.status(404).json({ error: 'Zip missing' });
  res.download(zipPath, 'dumps.zip');
});

module.exports = router;
