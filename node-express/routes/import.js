const router = require('express').Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getAdapter } = require('../adapters');
const { filterSqlByTables } = require('../adapters/_shared');
const jobs = require('../lib/jobs');
const dumpCrypto = require('../lib/dump-crypto');

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
// 上傳檔頭是 DBMENC magic 就先解密成原檔（password 走 DBMIGRATOR_DUMP_PASSWORD env）
router.post('/inspect', upload.single('file'), async (req, res) => {
  try {
    const meta = JSON.parse(req.body.meta || '{}');
    const { type, connection } = meta;
    const adapter = getAdapter(type);

    let workPath = req.file.path;
    let wasEncrypted = false;
    if (dumpCrypto.isEncryptedFile(workPath)) {
      wasEncrypted = true;
      let pw;
      try {
        pw = dumpCrypto.resolvePassword({
          passwordEnv: meta.passwordEnv || 'DBMIGRATOR_DUMP_PASSWORD',
        });
      } catch (e) {
        return res.status(400).json({ error: `encrypted dump: ${e.message}` });
      }
      if (!pw) {
        return res.status(400).json({
          error: 'encrypted dump but no password — set DBMIGRATOR_DUMP_PASSWORD env',
        });
      }
      const decPath = workPath + '.dec';
      try {
        await dumpCrypto.decryptStream(workPath, decPath, pw);
      } catch (e) {
        try { fs.unlinkSync(decPath); } catch {}
        return res.status(400).json({ error: e.message });
      }
      // 留 .dec 給 step 2 (run) 直接用，原 .enc 先留著當 audit；run 完一起刪
      workPath = decPath;
    }

    const fileTables = adapter.parseTableNamesFromDump(workPath);
    const dbTables = (await adapter.listTables(connection)).map((t) => t.name);

    const diff = fileTables.map((t) => ({
      name: t,
      existsInTarget: dbTables.includes(t),
    }));

    res.json({
      // uploadId 指向「解密後」的檔（如果有加密過）— step 2 直接吃
      uploadId: path.basename(workPath),
      encryptedInput: wasEncrypted,
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
