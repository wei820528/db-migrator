const router = require('express').Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getAdapter } = require('../adapters');
const { filterSqlByTables } = require('../adapters/_shared');
const jobs = require('../lib/jobs');

const TMP_DIR = path.join(__dirname, '..', 'tmp');
const upload = multer({
  dest: path.join(TMP_DIR, 'uploads'),
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1GB cap
});

// Each DB type has a different identifier quote character.
function identQuoteFor(type) {
  switch (type) {
    case 'mysql': return '`';
    case 'mssql': return '[';
    default: return '"';   // postgres, sqlite, supabase
  }
}

// Step 1: upload SQL file, return parsed table list + diff against target DB.
router.post('/inspect', upload.single('file'), async (req, res) => {
  try {
    const meta = JSON.parse(req.body.meta || '{}');
    const { type, connection } = meta;
    const adapter = getAdapter(type);

    const fileTables = adapter.parseTableNamesFromDump(req.file.path);
    const dbTables = (await adapter.listTables(connection)).map((t) => t.name);

    const diff = fileTables.map((t) => ({
      name: t,
      existsInTarget: dbTables.includes(t),
    }));

    res.json({
      uploadId: path.basename(req.file.path),
      fileTables,
      dbTables,
      diff,
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Step 2: actually run the import. If `tables` array is given, only those tables' statements run.
router.post('/run', async (req, res) => {
  const { type, connection, uploadId, tables } = req.body || {};
  if (!uploadId) return res.status(400).json({ error: 'uploadId required' });

  let adapter;
  try { adapter = getAdapter(type); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  const origPath = path.join(TMP_DIR, 'uploads', uploadId);
  if (!fs.existsSync(origPath)) return res.status(404).json({ error: 'Upload not found' });

  const job = jobs.create('import');
  jobs.setStatus(job.id, 'running');
  res.json({ jobId: job.id });

  // If user picked a subset of tables, write a filtered version and use that.
  // Non-SQL adapters can expose their own filterDumpByTables() — fall back to the
  // shared SQL filter otherwise.
  let runPath = origPath;
  let cleanupFiltered = null;
  if (Array.isArray(tables) && tables.length > 0) {
    try {
      const text = fs.readFileSync(origPath, 'utf8');
      const { sql, kept, skipped } = typeof adapter.filterDumpByTables === 'function'
        ? adapter.filterDumpByTables(text, tables)
        : filterSqlByTables(text, tables, identQuoteFor(type));
      runPath = origPath + '.filtered.sql';
      fs.writeFileSync(runPath, sql);
      cleanupFiltered = runPath;
      jobs.append(job.id, `Filter: kept ${kept} stmts, skipped ${skipped} (only ${tables.length} item(s) selected)`);
    } catch (e) {
      jobs.setStatus(job.id, 'error', { error: 'filter failed: ' + e.message });
      return;
    }
  }

  adapter
    .restore(connection, runPath, (line) => jobs.append(job.id, line))
    .then(() => {
      jobs.setStatus(job.id, 'done', { result: { ok: true } });
      try { fs.unlinkSync(origPath); } catch {}
      if (cleanupFiltered) { try { fs.unlinkSync(cleanupFiltered); } catch {} }
    })
    .catch((e) => {
      jobs.setStatus(job.id, 'error', { error: e.message });
      if (cleanupFiltered) { try { fs.unlinkSync(cleanupFiltered); } catch {} }
    });
});

module.exports = router;
