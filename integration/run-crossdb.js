#!/usr/bin/env node
// Cross-DB integration matrix — v2 Theme B Phase 5。
//
// 跑「source → target」6 個方向：mysql ↔ postgres ↔ sqlite 三角的所有組合。
// 每個方向：
//   1. seed source DB（用 fixtures.js 既有的 schema + data）
//   2. source.dumpNeutral() 把資料寫成 neutral JSONL
//   3. drop target DB（清乾淨）
//   4. target.restoreNeutral() 從 JSONL 還原
//   5. verify：target 的 row counts 應跟 source seed 一致
//
// 用法：
//   cd integration && docker compose up -d
//   node run-crossdb.js                       # 跑全部 6 個方向
//   node run-crossdb.js mysql:postgres        # 只跑指定 pair
//   node run-crossdb.js mysql                 # mysql 為 source 的所有方向
//
// 注意：seed 函式用 dialect-specific DDL 建本地測試 schema，但 cross-DB
// pipeline 走 IR + 自家 buildCreateTable，所以 target 端的 table 結構由
// dumpNeutral / restoreNeutral 自己重建，跟 fixtures.js 的 drop() 一起搭配
// 確保起跑時 target 是空的。

const path = require('path');
const fs = require('fs');

const adapterRoot = path.join(__dirname, '..', 'node-express', 'adapters');
const fixtures = require('./helpers/fixtures');
const { waitFor } = require('./helpers/wait-for');

const DUMP_DIR = path.join(__dirname, 'dumps');
fs.mkdirSync(DUMP_DIR, { recursive: true });

// MSSQL / mongo / redis 不在 v2 Theme B 範圍
const SUPPORTED = ['mysql', 'postgres', 'sqlite'];

// 所有 6 個方向（src !== tgt）
function allPairs() {
  const out = [];
  for (const s of SUPPORTED) for (const t of SUPPORTED) if (s !== t) out.push([s, t]);
  return out;
}

// CLI 篩選：'mysql:postgres' / 'mysql'（當 source）/ 空 = 全部
function parseArgs(args) {
  if (args.length === 0) return allPairs();
  const out = [];
  for (const a of args) {
    if (a.includes(':')) {
      const [s, t] = a.split(':');
      out.push([s, t]);
    } else {
      // 視為 source filter
      for (const t of SUPPORTED) if (t !== a) out.push([a, t]);
    }
  }
  return out;
}

(async () => {
  const pairs = parseArgs(process.argv.slice(2));
  console.log(`Cross-DB matrix — ${pairs.length} direction(s)\n`);
  const results = [];

  for (const [srcType, tgtType] of pairs) {
    const t0 = Date.now();
    const label = `${srcType} → ${tgtType}`;
    console.log(`▶ ${label}`);
    try {
      await runOne(srcType, tgtType);
      const took = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`  ✓ ${label} OK (${took}s)\n`);
      results.push({ pair: label, ok: true, took });
    } catch (e) {
      const took = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`  ✗ ${label} FAILED: ${e.message} (${took}s)\n`);
      results.push({ pair: label, ok: false, error: e.message, took });
    }
  }

  console.log('─── Summary ───');
  for (const r of results) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.pair.padEnd(28)} ${r.took}s${r.ok ? '' : ' — ' + r.error}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
})();

async function runOne(srcType, tgtType) {
  const srcFx = fixtures[srcType];
  const tgtFx = fixtures[tgtType];
  if (!srcFx) throw new Error(`unknown source: ${srcType}`);
  if (!tgtFx) throw new Error(`unknown target: ${tgtType}`);

  const srcAdapter = require(path.join(adapterRoot, srcType));
  const tgtAdapter = require(path.join(adapterRoot, tgtType));

  if (typeof srcAdapter.dumpNeutral !== 'function')
    throw new Error(`adapter ${srcType} has no dumpNeutral (v2 Theme B Phase 2)`);
  if (typeof tgtAdapter.restoreNeutral !== 'function')
    throw new Error(`adapter ${tgtType} has no restoreNeutral (v2 Theme B Phase 3)`);

  // 1. 等兩邊都 ready
  await waitFor(`${srcType} connect`, async () => {
    try { return (await srcAdapter.testConnection(srcFx.conn)).ok; } catch { return false; }
  });
  await waitFor(`${tgtType} connect`, async () => {
    try { return (await tgtAdapter.testConnection(tgtFx.conn)).ok; } catch { return false; }
  });

  // 2. 用 source 自家的 seed 函式準備測試資料
  process.stdout.write(`  src seed... `);
  await srcFx.seed();
  process.stdout.write('done\n');

  // 3. dumpNeutral
  process.stdout.write(`  src dumpNeutral... `);
  const dumpPath = path.join(DUMP_DIR, `${srcType}-to-${tgtType}.jsonl`);
  await srcAdapter.dumpNeutral(srcFx.conn, {}, dumpPath, () => {});
  const size = fs.statSync(dumpPath).size;
  process.stdout.write(`${size} bytes\n`);

  // 4. target 清空（讓 restoreNeutral 從乾淨狀態建表）
  process.stdout.write(`  tgt drop... `);
  await tgtFx.drop();
  process.stdout.write('done\n');

  // 5. restoreNeutral
  process.stdout.write(`  tgt restoreNeutral... `);
  const r = await tgtAdapter.restoreNeutral(tgtFx.conn, dumpPath, () => {});
  const warns = (r && r.warnings) ? r.warnings.length : 0;
  process.stdout.write(`done${warns > 0 ? ` (${warns} warning(s))` : ''}\n`);

  // 6. verify on target
  const v = await tgtFx.verify();
  process.stdout.write(`  verify: ${v.summary}\n`);
  if (!v.ok) throw new Error(`verify failed on ${tgtType}: ${v.summary}`);
}
