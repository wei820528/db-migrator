const router = require('express').Router();
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const { getAdapter } = require('../adapters');
const jobs = require('../lib/jobs');
const schedules = require('../lib/schedules');

const TMP_DIR = path.join(__dirname, '..', 'tmp');

// Sanitize filename
function safeName(s) {
  return String(s).replace(/[<>:"/\\|?*\s]+/g, '_').slice(0, 100) || 'dump';
}

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
// Dispatcher — called by schedules.tick() when a schedule fires.
// Creates a job, runs the dump in background, writes to OUTPUT_DIR.
// ============================================================
async function dispatchSchedule(sched) {
  const adapter = getAdapter(sched.type);
  const conn = schedules.loadConnectionWithPassword(sched.id);
  if (!conn) throw new Error('schedule connection not found');

  const job = jobs.create('scheduled-backup');
  jobs.setStatus(job.id, 'running');
  jobs.append(job.id, `=== Scheduled: ${sched.name} ===`);

  (async () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outBase = path.join(schedules.OUTPUT_DIR, `${safeName(sched.name)}_${stamp}`);
    const workDir = outBase + '_tmp';
    fs.mkdirSync(workDir, { recursive: true });

    try {
      for (const db of sched.databases) {
        jobs.append(job.id, `> ${db}`);
        const perConn = sched.type === 'sqlite' ? { path: db } : { ...conn, database: db };
        const file = path.join(workDir, `${safeName(db)}.sql`);
        await adapter.dump(perConn, {}, file, (line) => jobs.append(job.id, line));
      }
      let outPath;
      if (sched.databases.length === 1) {
        outPath = outBase + '.sql';
        fs.renameSync(path.join(workDir, fs.readdirSync(workDir)[0]), outPath);
        fs.rmdirSync(workDir);
      } else {
        outPath = outBase + '.zip';
        await zipDir(workDir, outPath);
        fs.rmSync(workDir, { recursive: true, force: true });
      }
      jobs.setStatus(job.id, 'done', { result: { ok: true, path: outPath } });
      jobs.append(job.id, `Saved to ${outPath}`);
    } catch (e) {
      jobs.setStatus(job.id, 'error', { error: e.message });
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
    }
  })();

  return job.id;
}
schedules.setDispatcher(dispatchSchedule);

// ============================================================
// REST API
// ============================================================
router.get('/', (req, res) => {
  res.json({ schedules: schedules.list(), outputDir: schedules.OUTPUT_DIR });
});

router.get('/:id', (req, res) => {
  const s = schedules.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  res.json(s);
});

router.post('/', (req, res) => {
  try { res.json(schedules.create(req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.patch('/:id', (req, res) => {
  try { res.json(schedules.update(req.params.id, req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete('/:id', (req, res) => {
  schedules.remove(req.params.id);
  res.json({ ok: true });
});

// Run immediately (still respects normal job flow)
router.post('/:id/run-now', async (req, res) => {
  const s = schedules.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  try {
    const jobId = await dispatchSchedule(s);
    schedules.markRunResult(req.params.id, true, null, jobId);
    res.json({ ok: true, jobId });
  } catch (e) {
    schedules.markRunResult(req.params.id, false, e.message, null);
    res.status(500).json({ error: e.message });
  }
});

// List output files
router.get('/_files/list', (req, res) => {
  const dir = schedules.OUTPUT_DIR;
  if (!fs.existsSync(dir)) return res.json({ files: [] });
  const files = fs.readdirSync(dir).map((name) => {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    return { name, size: st.size, mtime: st.mtimeMs };
  }).sort((a, b) => b.mtime - a.mtime);
  res.json({ files });
});

router.get('/_files/download', (req, res) => {
  const name = String(req.query.name || '');
  if (!name || name.includes('..') || name.includes('/') || name.includes('\\'))
    return res.status(400).json({ error: 'bad name' });
  const full = path.join(schedules.OUTPUT_DIR, name);
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'not found' });
  res.download(full);
});

module.exports = router;
module.exports.startLoop = schedules.startLoop;
