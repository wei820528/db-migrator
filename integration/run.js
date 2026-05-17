#!/usr/bin/env node
// Integration test orchestrator. Round-trips real adapter dump/restore against
// containers booted by docker-compose.
//
// Usage:
//   cd integration
//   docker compose up -d
//   node run.js              # run all 6 adapters
//   node run.js mysql redis  # run a subset
//   docker compose down -v
//
// Exit code 0 = all passed; non-zero = at least one failed. CI-friendly.

const path = require('path');
const fs = require('fs');

// Reach into the live source tree — same adapters the running server uses.
const adapterRoot = path.join(__dirname, '..', 'node-express', 'adapters');
const fixtures = require('./helpers/fixtures');
const { waitFor } = require('./helpers/wait-for');

const DUMP_DIR = path.join(__dirname, 'dumps');
fs.mkdirSync(DUMP_DIR, { recursive: true });

const args = process.argv.slice(2);
const wanted = args.length > 0 ? args : Object.keys(fixtures);

(async () => {
  console.log(`Integration round-trip — ${wanted.length} adapter(s): ${wanted.join(', ')}\n`);
  const results = [];

  for (const key of wanted) {
    const fx = fixtures[key];
    if (!fx) { console.error(`Unknown adapter: ${key}`); process.exit(2); }
    console.log(`▶ ${fx.name}`);
    const t0 = Date.now();
    try {
      await runOne(fx);
      const took = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`  ✓ ${fx.name} round-trip OK (${took}s)\n`);
      results.push({ name: fx.name, ok: true, took });
    } catch (e) {
      const took = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`  ✗ ${fx.name} FAILED: ${e.message} (${took}s)\n`);
      results.push({ name: fx.name, ok: false, error: e.message, took });
    }
  }

  console.log('─── Summary ───');
  for (const r of results) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.name.padEnd(10)} ${r.took}s${r.ok ? '' : ' — ' + r.error}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
})();

async function runOne(fx) {
  const adapter = require(path.join(adapterRoot, fx.name));

  // 1. wait for the DB to accept connections via testConnection
  await waitFor(`${fx.name} connect`, async () => {
    try { const r = await adapter.testConnection(fx.conn); return r.ok; }
    catch { return false; }
  });

  // 2. seed fresh fixtures
  process.stdout.write(`  seeding... `);
  await fx.seed();
  process.stdout.write('done\n');

  // 3. dump to file
  process.stdout.write(`  dumping... `);
  const dumpPath = path.join(DUMP_DIR, `${fx.name}.dump`);
  await adapter.dump(fx.conn, {}, dumpPath, () => {});
  const size = fs.statSync(dumpPath).size;
  process.stdout.write(`${size} bytes\n`);

  // 4. verify we can parse table names back out of the dump
  const tables = adapter.parseTableNamesFromDump(dumpPath);
  if (tables.length === 0) throw new Error('parseTableNamesFromDump returned 0 tables');
  process.stdout.write(`  parsed ${tables.length} table(s): ${tables.slice(0, 5).join(', ')}\n`);

  // 5. drop everything
  process.stdout.write(`  dropping... `);
  await fx.drop();
  process.stdout.write('done\n');

  // 6. restore from the dump
  process.stdout.write(`  restoring... `);
  await adapter.restore(fx.conn, dumpPath, () => {});
  process.stdout.write('done\n');

  // 7. verify expected counts came back
  const v = await fx.verify();
  process.stdout.write(`  verify: ${v.summary}\n`);
  if (!v.ok) throw new Error(`verify failed: ${v.summary}`);
}
