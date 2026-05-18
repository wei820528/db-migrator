// Cross-DB migration routes。
//
// Phase 4 只有 /preview-live（讀 source schema、預測 target DDL）。
// 之後會加：
//   POST /preview-file  — 分析使用者上傳的 neutral JSONL
//   POST /migrate-live  — source dump + target restore 一次到位（含 job tracking）

const router = require('express').Router();
const { getAdapter } = require('../adapters');
const { buildTablePreview, stringifyIr } = require('../lib/cross-db/preview');

const SUPPORTED = new Set(['mysql', 'postgres', 'sqlite', 'supabase']);

// POST /api/cross-db/preview-live
// Body: { sourceType, sourceConn, targetType, tables? }
// 回：per-table preview，包含預測的 CREATE TABLE、per-column source→target 型別對照、warnings。
router.post('/preview-live', async (req, res) => {
  const { sourceType, sourceConn, targetType, tables } = req.body || {};

  if (!sourceType || !targetType) {
    return res.status(400).json({ error: 'sourceType + targetType required' });
  }
  if (!SUPPORTED.has(sourceType) || !SUPPORTED.has(targetType)) {
    return res.status(400).json({
      error: `Cross-DB supports ${[...SUPPORTED].join(' / ')} (got source=${sourceType}, target=${targetType})`,
    });
  }
  if (sourceType === targetType) {
    return res.status(400).json({ error: 'source and target are the same — use regular dump/restore instead' });
  }

  let adapter;
  try { adapter = getAdapter(sourceType); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  if (typeof adapter.getSchema !== 'function') {
    return res.status(400).json({ error: `adapter ${sourceType} does not support cross-DB (no getSchema)` });
  }

  try {
    const irTables = await adapter.getSchema(sourceConn, tables);
    const preview = irTables.map((ir) => buildTablePreview(ir, targetType));
    const totalWarnings = preview.reduce((n, p) => n + p.warnings.length, 0);
    res.json({
      source: sourceType,
      target: targetType,
      tableCount: preview.length,
      warningCount: totalWarnings,
      tables: preview,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
