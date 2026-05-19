const router = require('express').Router();
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const { getAdapter } = require('../adapters');
const jobs = require('../lib/jobs');
const schedules = require('../lib/schedules');
const history = require('../lib/schedule-history');
const dumpCrypto = require('../lib/dump-crypto');

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
    // 改成 per-schedule subdirectory — retention enforce + history list 都靠這個分群
    const schedDir = history.historyDir(schedules.OUTPUT_DIR, sched.id);
    fs.mkdirSync(schedDir, { recursive: true });
    const outBase = path.join(schedDir, `${safeName(sched.name)}_${stamp}`);
    const workDir = outBase + '_tmp';
    fs.mkdirSync(workDir, { recursive: true });

    // 加密 password（schedule 沒有自帶 dump-encryption；走 env 跟手動 export 一致）
    let dumpPassword = null;
    try {
      dumpPassword = dumpCrypto.resolvePassword({ passwordEnv: 'DBMIGRATOR_DUMP_PASSWORD' });
    } catch { /* env 沒設就是不加密，不算錯 */ }

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

      // 加密 (streaming) — 跟 export.js 一致
      if (dumpPassword) {
        const encPath = outPath + '.enc';
        await dumpCrypto.encryptStream(outPath, encPath, dumpPassword);
        fs.unlinkSync(outPath);
        outPath = encPath;
        jobs.append(job.id, `Encrypted → ${path.basename(encPath)}`);
      }

      // Retention enforcement — 跑完才砍，避免「跑到一半最舊的被砍掉但新檔還沒寫成功」
      if (sched.retentionCount || sched.retentionDays) {
        const r = history.applyRetention(schedules.OUTPUT_DIR, sched.id, {
          retentionCount: sched.retentionCount,
          retentionDays:  sched.retentionDays,
        });
        if (r.deleted.length > 0) {
          jobs.append(job.id, `Retention: kept ${r.kept}, deleted ${r.deleted.length} (${r.deleted.slice(0, 3).join(', ')}${r.deleted.length > 3 ? '...' : ''})`);
        }
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

// List output files — Phase 4 改成「展平 legacy flat 檔 + 所有 sched-id 子目錄」
router.get('/_files/list', (req, res) => {
  const dir = schedules.OUTPUT_DIR;
  if (!fs.existsSync(dir)) return res.json({ files: [] });
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (st.isFile()) {
      out.push({ name, size: st.size, mtime: st.mtimeMs, scheduleId: null });   // legacy flat
    } else if (st.isDirectory()) {
      // Phase 4 per-schedule subdir
      const schedId = name;
      const sched = schedules.get(schedId);
      const schedName = sched ? sched.name : '(已刪除)';
      for (const inner of fs.readdirSync(full)) {
        try {
          const ist = fs.statSync(path.join(full, inner));
          if (ist.isFile()) {
            out.push({
              name: inner, size: ist.size, mtime: ist.mtimeMs,
              scheduleId: schedId, scheduleName: schedName,
            });
          }
        } catch {}
      }
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  res.json({ files: out });
});

router.get('/_files/download', (req, res) => {
  const name = String(req.query.name || '');
  const schedId = String(req.query.scheduleId || '');
  if (!name || name.includes('..') || name.includes('/') || name.includes('\\'))
    return res.status(400).json({ error: 'bad name' });
  // 有 scheduleId 走 subdir；無 (legacy) 走 flat root
  const full = schedId
    ? history.resolveHistoryPath(schedules.OUTPUT_DIR, schedId, name)
    : path.join(schedules.OUTPUT_DIR, name);
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'not found' });
  res.download(full);
});

// ============================================================
// Phase 4 — per-schedule history + restore
// ============================================================
router.get('/:id/history', (req, res) => {
  const s = schedules.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const items = history.listHistory(schedules.OUTPUT_DIR, s.id);
  // 隱藏 fullPath（client 不需要）
  res.json({
    scheduleId: s.id, scheduleName: s.name,
    retention: { count: s.retentionCount, days: s.retentionDays },
    items: items.map(({ fullPath, ...rest }) => rest),
  });
});

// 從歷史檔還原到指定 target
// body: { historyName, target?: { type, connection, database }, passwordEnv? }
// 沒給 target 就用該 schedule 的原 connection + 第一個 database
router.post('/:id/restore', async (req, res) => {
  const s = schedules.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'schedule not found' });
  const { historyName, target, passwordEnv } = req.body || {};
  let srcPath;
  try {
    srcPath = history.resolveHistoryPath(schedules.OUTPUT_DIR, s.id, historyName);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  // Target 預設用原 schedule 的 connection
  let restoreType, restoreConn;
  if (target && target.type && target.connection) {
    restoreType = target.type;
    restoreConn = { ...target.connection };
    if (target.database) restoreConn.database = target.database;
  } else {
    restoreType = s.type;
    restoreConn = schedules.loadConnectionWithPassword(s.id);
    if (!restoreConn) return res.status(500).json({ error: 'schedule connection unavailable' });
    if (s.databases.length > 0) restoreConn.database = s.databases[0];
  }

  let adapter;
  try { adapter = getAdapter(restoreType); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  const job = jobs.create('schedule-restore');
  jobs.setStatus(job.id, 'running');
  jobs.append(job.id, `=== Restoring ${historyName} → ${restoreType}:${restoreConn.database || '(default)'} ===`);
  res.json({ jobId: job.id });

  (async () => {
    let workPath = srcPath;
    let cleanupDecrypted = null;
    try {
      // 如果是 .enc 先解密到 tmp
      if (dumpCrypto.isEncryptedFile(srcPath)) {
        const pw = dumpCrypto.resolvePassword({
          passwordEnv: passwordEnv || 'DBMIGRATOR_DUMP_PASSWORD',
        });
        if (!pw) throw new Error('encrypted history file requires DBMIGRATOR_DUMP_PASSWORD env');
        const decPath = path.join(TMP_DIR, `restore-${job.id}.dec`);
        await dumpCrypto.decryptStream(srcPath, decPath, pw);
        workPath = decPath;
        cleanupDecrypted = decPath;
        jobs.append(job.id, `Decrypted → ${path.basename(decPath)}`);
      }
      await adapter.restore(restoreConn, workPath, (line) => jobs.append(job.id, line));
      jobs.setStatus(job.id, 'done', { result: { ok: true, historyName, target: restoreType } });
    } catch (e) {
      jobs.setStatus(job.id, 'error', { error: e.message });
    } finally {
      if (cleanupDecrypted) { try { fs.unlinkSync(cleanupDecrypted); } catch {} }
    }
  })();
});

router.delete('/:id/history/:name', (req, res) => {
  const s = schedules.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'schedule not found' });
  try {
    const full = history.resolveHistoryPath(schedules.OUTPUT_DIR, s.id, req.params.name);
    fs.unlinkSync(full);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
module.exports.startLoop = schedules.startLoop;
