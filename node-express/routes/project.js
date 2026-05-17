const router = require('express').Router();
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const archiver = require('archiver');
const AdmZip = require('adm-zip');

const { getAdapter } = require('../adapters');
const jobs = require('../lib/jobs');
const github = require('../lib/github');
const storage = require('../lib/supabaseStorage');

const TMP_DIR = path.join(__dirname, '..', 'tmp');
const upload = multer({
  dest: path.join(TMP_DIR, 'uploads'),
  limits: { fileSize: 5 * 1024 * 1024 * 1024 }, // 5GB cap
});

function zipDir(srcDir, outFile) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(outFile);
    const a = archiver('zip', { zlib: { level: 6 } });
    out.on('close', resolve);
    a.on('error', reject);
    a.pipe(out);
    a.directory(srcDir, false);
    a.finalize();
  });
}

// ============================================================
// POST /api/project/backup
//   body: {
//     code:    { repoUrl, pat, branch? }     | null
//     db:      { type, connection, database } | null
//     storage: { url, serviceKey }            | null
//   }
// ============================================================
router.post('/backup', async (req, res) => {
  const { code, db, storage: storageCfg } = req.body || {};
  if (!code && !db && !storageCfg) {
    return res.status(400).json({ error: '至少要選一個層（code / db / storage）' });
  }

  const job = jobs.create('project-backup');
  const jobDir = path.join(TMP_DIR, job.id);
  const workDir = path.join(jobDir, 'work');
  fs.mkdirSync(workDir, { recursive: true });

  jobs.setStatus(job.id, 'running');
  res.json({ jobId: job.id });

  (async () => {
    const manifest = {
      createdAt: new Date().toISOString(),
      code: null, db: null, storage: null,
    };
    const log = (line) => jobs.append(job.id, line);

    try {
      // ---- Code ----
      if (code?.repoUrl) {
        log('=== Code (Git) ===');
        const codeDir = path.join(workDir, 'code');
        await github.cloneRepo(code, codeDir, log);
        // Remove .git from backup so restore can start fresh (avoid huge blobs)
        const gitDir = path.join(codeDir, '.git');
        if (fs.existsSync(gitDir)) fs.rmSync(gitDir, { recursive: true, force: true });
        manifest.code = { repoUrl: code.repoUrl, branch: code.branch || 'main' };
      }

      // ---- DB ----
      if (db?.type) {
        log('=== Database ===');
        const adapter = getAdapter(db.type);
        const dbFile = path.join(workDir, 'db.sql');
        const perConn = db.type === 'sqlite'
          ? { path: db.database }
          : { ...db.connection, database: db.database };
        await adapter.dump(perConn, db.options || {}, dbFile, log);
        manifest.db = { type: db.type, database: db.database };
      }

      // ---- Storage ----
      if (storageCfg?.url && storageCfg?.serviceKey) {
        log('=== Supabase Storage ===');
        const storageDir = path.join(workDir, 'storage');
        const stats = await storage.downloadAll(storageCfg, storageDir, log);
        manifest.storage = { url: storageCfg.url, ...stats };
      }

      // Write manifest
      fs.writeFileSync(path.join(workDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

      // Zip everything
      log('Packing backup.zip...');
      const zipPath = path.join(jobDir, 'backup.zip');
      await zipDir(workDir, zipPath);

      jobs.setStatus(job.id, 'done', {
        result: { downloadUrl: `/api/project/${job.id}/zip`, manifest },
      });
      log('Backup complete');
    } catch (e) {
      console.error('[project/backup] failed:', e);
      jobs.setStatus(job.id, 'error', { error: e.message || String(e) });
    }
  })();
});

router.get('/:id/zip', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== 'done') return res.status(404).json({ error: 'Not ready' });
  const zipPath = path.join(TMP_DIR, req.params.id, 'backup.zip');
  if (!fs.existsSync(zipPath)) return res.status(404).json({ error: 'Zip missing' });
  res.download(zipPath, 'backup.zip');
});

// ============================================================
// POST /api/project/inspect  (multipart: file + meta?)
//   peek into uploaded backup.zip, return manifest
// ============================================================
router.post('/inspect', upload.single('file'), async (req, res) => {
  try {
    const zip = new AdmZip(req.file.path);
    const manifestEntry = zip.getEntry('manifest.json');
    if (!manifestEntry) return res.status(400).json({ error: 'manifest.json not found in zip' });
    const manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
    return res.json({ uploadId: path.basename(req.file.path), manifest });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

// ============================================================
// POST /api/project/restore
//   body: {
//     uploadId,
//     dest: {
//       code?:    { repoUrl, pat, branch? }
//       db?:      { type, connection, database }
//       storage?: { url, serviceKey }
//     }
//   }
// ============================================================
router.post('/restore', async (req, res) => {
  const { uploadId, dest } = req.body || {};
  if (!uploadId) return res.status(400).json({ error: 'uploadId required' });
  if (!dest) return res.status(400).json({ error: 'dest config required' });

  const zipPath = path.join(TMP_DIR, 'uploads', uploadId);
  if (!fs.existsSync(zipPath)) return res.status(404).json({ error: 'Upload not found' });

  const job = jobs.create('project-restore');
  const jobDir = path.join(TMP_DIR, job.id);
  const workDir = path.join(jobDir, 'work');
  fs.mkdirSync(workDir, { recursive: true });

  jobs.setStatus(job.id, 'running');
  res.json({ jobId: job.id });

  (async () => {
    const log = (line) => jobs.append(job.id, line);
    try {
      // Unzip
      log('Unpacking backup.zip...');
      const zip = new AdmZip(zipPath);
      zip.extractAllTo(workDir, true);

      // ---- Code ----
      if (dest.code?.repoUrl) {
        log('=== Push code to destination repo ===');
        const codeDir = path.join(workDir, 'code');
        if (!fs.existsSync(codeDir)) {
          log('  (no code in backup, skipping)');
        } else {
          await github.pushTo(dest.code, codeDir, log);
        }
      }

      // ---- DB ----
      if (dest.db?.type) {
        log('=== Restore DB ===');
        const dbFile = path.join(workDir, 'db.sql');
        if (!fs.existsSync(dbFile)) {
          log('  (no db.sql in backup, skipping)');
        } else {
          const adapter = getAdapter(dest.db.type);
          const perConn = dest.db.type === 'sqlite'
            ? { path: dest.db.database }
            : { ...dest.db.connection, database: dest.db.database };
          await adapter.restore(perConn, dbFile, log);
        }
      }

      // ---- Storage ----
      if (dest.storage?.url && dest.storage?.serviceKey) {
        log('=== Upload Storage ===');
        const storageDir = path.join(workDir, 'storage');
        await storage.uploadAll(dest.storage, storageDir, log);
      }

      // Cleanup uploaded zip
      try { fs.unlinkSync(zipPath); } catch {}

      jobs.setStatus(job.id, 'done', { result: { ok: true } });
      log('Restore complete');
    } catch (e) {
      console.error('[project/restore] failed:', e);
      jobs.setStatus(job.id, 'error', { error: e.message || String(e) });
    }
  })();
});

module.exports = router;
