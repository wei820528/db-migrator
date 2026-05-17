// Tiny generic "wait until probe returns true" helper.
// Used to wait for each DB to accept connections before the round-trip starts.

async function waitFor(label, probe, { timeoutMs = 90_000, intervalMs = 1500 } = {}) {
  const t0 = Date.now();
  let lastErr;
  while (Date.now() - t0 < timeoutMs) {
    try {
      const ok = await probe();
      if (ok) {
        const took = ((Date.now() - t0) / 1000).toFixed(1);
        process.stdout.write(`  ${label}: ready (${took}s)\n`);
        return true;
      }
    } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`${label}: did not become ready within ${timeoutMs / 1000}s. Last error: ${lastErr?.message || '(none)'}`);
}

module.exports = { waitFor };
