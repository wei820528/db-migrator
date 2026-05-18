// Plugin host: scans plugins/ folder, manages lifecycle, supports hot reload.
//
// A plugin module exports:
// {
//   mount?:  '/api/foo',                      // Express mount path
//   router?: <express.Router instance>,
//   adapter?: { type: 'foo', handler: { testConnection, listTables, dump, restore, parseTableNamesFromDump } },
//   ui?: {
//     cards?:   [{ type, title, sub, port? }],
//     tabs?:    [{ id, label, html, scripts? }],
//     scripts?: ['/plugins/static/<name>/init.js']
//   },
//   static?: 'public',  // folder (relative to plugin) served at /plugins/static/<name>/
// }

const fs = require('fs');
const path = require('path');
const express = require('express');
const adapters = require('../adapters');
const SandboxedPlugin = require('./sandboxed-plugin-host');

class PluginHost {
  constructor(app, pluginsDir) {
    this.app = app;
    this.dir = pluginsDir;
    this.plugins = new Map();   // name -> { modulePath, mount, routerHolder, adapterType, ui, static }
    this.routeProxies = new Map(); // mount -> proxy fn (so we can swap router on reload)
    this.status = {};            // name -> { ok, error?, mount?, source }
  }

  scan() {
    if (!fs.existsSync(this.dir)) return;
    for (const entry of fs.readdirSync(this.dir, { withFileTypes: true })) {
      if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
      const name = entry.name.replace(/\.js$/, '');
      this.loadOrReload(name);
    }
  }

  resolveModulePath(name) {
    const asFile = path.join(this.dir, `${name}.js`);
    const asFolder = path.join(this.dir, name, 'index.js');
    if (fs.existsSync(asFile)) return asFile;
    if (fs.existsSync(asFolder)) return asFolder;
    return null;
  }

  // Cached pluginRoot for a plugin (folder or file's parent if single file)
  pluginRoot(name) {
    const folder = path.join(this.dir, name);
    if (fs.existsSync(folder) && fs.statSync(folder).isDirectory()) return folder;
    return null;  // single file plugin has no root
  }

  loadOrReload(name) {
    const modulePath = this.resolveModulePath(name);
    if (!modulePath) {
      this.unload(name);
      return;
    }

    // v2 Theme D Phase 2: 讀 manifest 判斷是否走 sandboxed 路徑
    const manifest = this._readManifest(name);
    if (manifest?.sandboxed === true) {
      return this._loadSandboxed(name, modulePath, manifest);
    }

    // Invalidate require cache for this plugin and any children inside its folder
    this._invalidateRequireCache(name);

    let mod;
    try {
      mod = require(modulePath);
    } catch (e) {
      this.status[name] = { ok: false, error: e.message };
      console.error(`[plugin] ${name.padEnd(18)} FAIL: ${e.message}`);
      return;
    }

    const existing = this.plugins.get(name);

    // Unregister adapter if it changed
    if (existing?.adapterType && (!mod.adapter || mod.adapter.type !== existing.adapterType)) {
      adapters.unregisterAdapter(existing.adapterType);
    }

    // Register adapter
    if (mod.adapter?.type && mod.adapter?.handler) {
      try {
        adapters.registerAdapter(mod.adapter.type, mod.adapter.handler, `plugin:${name}`);
      } catch (e) {
        this.status[name] = { ok: false, error: `adapter register failed: ${e.message}` };
        console.error(`[plugin] ${name.padEnd(18)} FAIL: ${e.message}`);
        return;
      }
    }

    // Mount route via proxy (so hot-reload can swap the router)
    if (mod.mount && mod.router) {
      let proxy = this.routeProxies.get(mod.mount);
      if (!proxy) {
        const holder = { router: mod.router };
        proxy = (req, res, next) => holder.router(req, res, next);
        proxy._holder = holder;
        this.routeProxies.set(mod.mount, proxy);
        this.app.use(mod.mount, proxy);
      } else {
        proxy._holder.router = mod.router;
      }
    }

    // Mount static folder
    if (mod.static && this.pluginRoot(name)) {
      const staticDir = path.join(this.pluginRoot(name), mod.static);
      if (fs.existsSync(staticDir)) {
        // Mount once at /plugins/static/<name>
        const mountPath = `/plugins/static/${name}`;
        // Only mount once
        if (!this._staticMounted) this._staticMounted = new Set();
        if (!this._staticMounted.has(name)) {
          this.app.use(mountPath, express.static(staticDir));
          this._staticMounted.add(name);
        }
      }
    }

    this.plugins.set(name, {
      modulePath,
      mount: mod.mount,
      adapterType: mod.adapter?.type,
      ui: mod.ui || {},
    });
    this.status[name] = { ok: true, mount: mod.mount, source: 'plugin' };
    console.log(`[plugin] ${name.padEnd(18)} OK   ${mod.mount || ''}`);
  }

  unload(name) {
    const existing = this.plugins.get(name);
    if (!existing) return;
    if (existing.adapterType) adapters.unregisterAdapter(existing.adapterType);
    // Sandboxed plugin: 把 worker 停掉
    if (existing.sandboxedInstance) {
      existing.sandboxedInstance.stop().catch(() => {});
    }
    if (existing.mount && this.routeProxies.has(existing.mount)) {
      // We can't truly unmount in Express; replace with 503
      this.routeProxies.get(existing.mount)._holder.router =
        (req, res) => res.status(503).json({ error: `Plugin "${name}" unloaded` });
    }
    this.plugins.delete(name);
    this.status[name] = { ok: false, error: 'unloaded' };
    console.log(`[plugin] ${name.padEnd(18)} UNLOADED`);
  }

  _invalidateRequireCache(name) {
    const root = this.pluginRoot(name);
    const fileBase = root || path.join(this.dir, `${name}.js`);
    for (const cached of Object.keys(require.cache)) {
      if (cached.startsWith(fileBase)) delete require.cache[cached];
    }
  }

  // ============ v2 Theme D Phase 2: sandboxed plugin support ============

  _readManifest(name) {
    const root = this.pluginRoot(name);
    if (!root) return null;
    const mf = path.join(root, 'plugin.json');
    if (!fs.existsSync(mf)) return null;
    try { return JSON.parse(fs.readFileSync(mf, 'utf8')); }
    catch { return null; }
  }

  _readGrants(name) {
    const root = this.pluginRoot(name);
    if (!root) return null;
    const g = path.join(root, '.granted-permissions.json');
    if (!fs.existsSync(g)) return null;
    try { return JSON.parse(fs.readFileSync(g, 'utf8')); }
    catch { return null; }
  }

  async _loadSandboxed(name, modulePath, manifest) {
    // 先停掉之前的 sandboxed instance（若有）
    const existing = this.plugins.get(name);
    if (existing?.sandboxedInstance) {
      try { await existing.sandboxedInstance.stop(); } catch {}
    }

    const grants = this._readGrants(name);
    const grantedPermissions = grants?.granted || manifest.permissions || [];

    const sb = new SandboxedPlugin({
      name,
      pluginPath: modulePath,
      grantedPermissions,
      onLog: (level, msg) => console.log(`[plugin:${name}] ${level}: ${msg}`),
    });

    try {
      await sb.start();
    } catch (e) {
      this.status[name] = { ok: false, error: 'sandbox start failed: ' + e.message, sandboxed: true };
      console.error(`[plugin] ${name.padEnd(18)} FAIL (sandbox): ${e.message}`);
      try { await sb.stop(); } catch {}
      return;
    }

    // 把 sandbox 變成 Express handler 掛到 mount。mount 從 manifest 拿，
    // 沒給就用 /api/plugin/<name>。
    const mount = manifest.mount || `/api/plugin/${name}`;
    const handler = sb.asExpressHandler();

    let proxy = this.routeProxies.get(mount);
    if (!proxy) {
      const holder = { router: handler };
      proxy = (req, res, next) => holder.router(req, res, next);
      proxy._holder = holder;
      this.routeProxies.set(mount, proxy);
      this.app.use(mount, proxy);
    } else {
      proxy._holder.router = handler;
    }

    this.plugins.set(name, {
      modulePath,
      mount,
      sandboxedInstance: sb,
      ui: {},                       // Phase 2 不支援 sandboxed UI（留 Phase 3）
    });
    this.status[name] = {
      ok: true, mount, source: 'plugin:sandboxed', sandboxed: true,
      routes: sb.routes, permissions: grantedPermissions,
    };
    console.log(`[plugin] ${name.padEnd(18)} OK   ${mount} (sandboxed, ${sb.routes.length} route(s))`);
  }

  watch() {
    if (!fs.existsSync(this.dir)) return;
    let timer = null;
    const pending = new Set();
    const trigger = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        for (const name of pending) this.loadOrReload(name);
        pending.clear();
      }, 200);  // debounce
    };
    fs.watch(this.dir, { recursive: true }, (event, filename) => {
      if (!filename) return;
      // Get top-level plugin name
      const top = filename.split(/[\\/]/)[0];
      if (top.startsWith('_') || top.startsWith('.')) return;
      const name = top.endsWith('.js') ? top.replace(/\.js$/, '') : top;
      pending.add(name);
      trigger();
    });
    console.log(`[plugin] watching ${this.dir} for changes (hot reload enabled)`);
  }

  getStatus() {
    return { ...this.status };
  }

  collectUi() {
    const cards = [];
    const tabs = [];
    const scripts = [];
    for (const [name, p] of this.plugins) {
      if (p.ui.cards) cards.push(...p.ui.cards.map((c) => ({ ...c, _plugin: name })));
      if (p.ui.tabs) tabs.push(...p.ui.tabs.map((t) => ({ ...t, _plugin: name })));
      if (p.ui.scripts) scripts.push(...p.ui.scripts);
    }
    return { cards, tabs, scripts };
  }
}

module.exports = PluginHost;
