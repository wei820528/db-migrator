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
