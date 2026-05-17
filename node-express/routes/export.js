const router = require('express').Router();
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const { getAdapter } = require('../adapters');
const jobs = require('../lib/jobs');

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

      jobs.setStatus(job.id, 'done', { result: { downloadUrl, count: databases.length } });
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
  const sql = files.find((f) => f.endsWith('.sql'));
  if (!sql) return res.status(404).json({ error: 'File missing' });
  res.download(path.join(filesDir, sql));
});

router.get('/:id/zip', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== 'done') return res.status(404).json({ error: 'Not ready' });
  const zipPath = path.join(TMP_DIR, req.params.id, 'dumps.zip');
  if (!fs.existsSync(zipPath)) return res.status(404).json({ error: 'Zip missing' });
  res.download(zipPath, 'dumps.zip');
});

module.exports = router;
