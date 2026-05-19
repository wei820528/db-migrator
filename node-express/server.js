const express = require('express');
const path = require('path');
const fs = require('fs');
const PluginHost = require('./lib/pluginHost');
const tmpCleanup = require('./lib/tmp-cleanup');

const app = express();
const PORT = process.env.PORT || 3000;

const TMP_DIR = path.join(__dirname, 'tmp');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// OpenAPI 3.0 spec — public, 不在 license gate 內（給 client lib 開發者用）
app.get('/openapi.json', (req, res) => {
  res.sendFile(path.join(__dirname, 'openapi.json'));
});

// v2 Theme E: observability — Prometheus /metrics + structured /healthz。
// 都不在 license gate 內（給 scraper / k8s liveness probe / uptime monitor）。
app.get('/metrics', (req, res) => {
  try {
    const metrics = require('./lib/metrics');
    metrics.gauge('dbmigrator_uptime_seconds', 'Process uptime in seconds').set(process.uptime());
    res.type('text/plain; version=0.0.4').send(metrics.render());
  } catch (e) {
    res.status(500).type('text/plain').send('# metrics error: ' + e.message + '\n');
  }
});
app.get('/healthz', require('./lib/healthz').handler());

// License gate — applied to /api/* (except /api/license/* and /api/modules)
const license = require('./lib/license');
app.use(license.gate());

// =========================================================
// Built-in modules — each route is an independent piece.
// =========================================================
const moduleStatus = {};

function safeMount(mountPath, modulePath, label) {
  try {
    const r = require(modulePath);
    app.use(mountPath, r);
    moduleStatus[label] = { ok: true, mount: mountPath };
    console.log(`[module] ${label.padEnd(12)} OK   (${mountPath})`);
  } catch (e) {
    moduleStatus[label] = { ok: false, mount: mountPath, error: e.message };
    console.error(`[module] ${label.padEnd(12)} FAIL (${mountPath}): ${e.message}`);
    app.use(mountPath, (req, res) => {
      res.status(503).json({ error: `Module "${label}" unavailable: ${e.message}`, module: label });
    });
  }
}

safeMount('/api/license',    './routes/license',    'license');
safeMount('/api/connection', './routes/connection', 'connection');
safeMount('/api/export',     './routes/export',     'export');
safeMount('/api/import',     './routes/import',     'import');
safeMount('/api/jobs',       './routes/jobs',       'jobs');
safeMount('/api/project',    './routes/project',    'project');
safeMount('/api/schedule',   './routes/schedule',   'schedule');
safeMount('/api/marketplace','./routes/marketplace', 'marketplace');
safeMount('/api/cross-db',   './routes/cross-db',    'cross-db');
safeMount('/api/webhooks',   './routes/webhooks',    'webhooks');
safeMount('/api/plugin-audit','./routes/plugin-audit', 'plugin-audit');
// Start scheduler tick loop (no-op if schedule route failed to load)
try { require('./routes/schedule').startLoop?.(); } catch (e) { console.warn('[schedule] loop not started:', e.message); }

// =========================================================
// Plugin host — auto-scan plugins/, hot reload, UI registry.
// =========================================================
const pluginHost = new PluginHost(app, path.join(__dirname, 'plugins'));
pluginHost.scan();
if (process.env.PLUGIN_WATCH !== 'off') pluginHost.watch();

// v2 Theme E: 把 plugin / module status 反映到 metrics gauge（給 Prometheus alert）
try {
  const m = require('./lib/metrics');
  const refreshPluginGauges = () => {
    const g = m.gauge('dbmigrator_plugin_status', 'Plugin status: 1=ok, 0=failed');
    g.values.clear();
    for (const [name, st] of Object.entries(pluginHost.getStatus())) {
      g.set({ plugin: name }, st.ok ? 1 : 0);
    }
    const mg = m.gauge('dbmigrator_module_status', 'Built-in route module status: 1=ok, 0=failed');
    mg.values.clear();
    for (const [name, st] of Object.entries(moduleStatus)) {
      mg.set({ module: name }, st.ok ? 1 : 0);
    }
  };
  refreshPluginGauges();
  setInterval(refreshPluginGauges, 30_000).unref();   // 每 30s 重新整理
} catch (e) { /* metrics 沒裝 — 不影響功能 */ }

// Module / plugin status — UI uses this to disable unavailable cards & tabs.
app.get('/api/modules', (req, res) => {
  let adapterStatus = {};
  try { adapterStatus = require('./adapters').getStatus(); }
  catch (e) { adapterStatus = { _error: e.message }; }

  const pluginRoutes = {};
  for (const [name, st] of Object.entries(pluginHost.getStatus())) {
    pluginRoutes[`plugin:${name}`] = st;
  }

  res.json({
    routes: { ...moduleStatus, ...pluginRoutes },
    adapters: adapterStatus,
  });
});

// Plugin UI manifest — cards / tabs / scripts contributed by all plugins.
app.get('/api/plugins/ui', (req, res) => {
  res.json(pluginHost.collectUi());
});

// Manual reload endpoint (in case watcher misses something or you want explicit control)
app.post('/api/plugins/reload/:name?', (req, res) => {
  if (req.params.name) {
    pluginHost.loadOrReload(req.params.name);
    res.json({ ok: true, reloaded: req.params.name });
  } else {
    pluginHost.scan();
    res.json({ ok: true, rescanned: true });
  }
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ error: err.message || 'Internal error' });
});

// Tmp cleanup background loop
tmpCleanup.start();

app.listen(PORT, () => {
  console.log(`\nDB migrator listening on http://localhost:${PORT}\n`);
});
