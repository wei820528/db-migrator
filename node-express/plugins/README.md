# Plugins (Node)

Drop a `.js` file or folder here — auto-mounted as a route, adapter, UI tab, or all of the above.
**Hot reload is enabled by default** — save your file, the plugin re-loads without restarting Node.

## Locations supported

```
plugins/
├── single-file.js              ← single-file plugin
└── folder-plugin/
    ├── index.js                ← entry
    ├── public/                 ← static files served at /plugins/static/folder-plugin/
    │   └── init.js
    └── (any other helper files)
```

Names starting with `_` or `.` are skipped.

## What a plugin can contribute

```js
module.exports = {
  // 1. HTTP route
  mount: '/api/foo',
  router,

  // 2. DB adapter (registers a new type, gets a card)
  adapter: {
    type: 'foo',
    handler: { testConnection, listTables, dump, restore, parseTableNamesFromDump },
  },

  // 3. Frontend UI: cards in the type selector + tabs in the mode switch
  ui: {
    cards: [
      { type: 'foo', title: 'Foo DB', sub: 'description', port: '1234' }
    ],
    tabs: [
      {
        id: 'foo-tab',
        label: 'Foo Tools',
        html: '<div>...</div>',
        scripts: ['/plugins/static/foo/init.js']
      }
    ],
    scripts: ['/plugins/static/foo/always.js']
  },

  // 4. Static folder served at /plugins/static/<plugin-name>/
  static: 'public',
};
```

All four fields are optional — a minimal plugin can just be a route, or just an adapter, or just a UI contribution.

## See `hello/` for a working example

It demonstrates all four: route + fake adapter + card + tab + static script.

## Hot reload

`fs.watch` watches this folder. On change:
- File contents re-required
- Adapter / route / UI re-registered
- Console prints `[plugin] xxx OK`

The frontend doesn't auto-refresh — you need to reload the browser (`Ctrl+F5`) to see UI changes.

To **disable** hot reload (if it's noisy or causes issues):
```powershell
$env:PLUGIN_WATCH = "off"
npm start
```

## Manual reload via API

```
POST /api/plugins/reload         ← rescan all
POST /api/plugins/reload/<name>  ← reload one specific plugin
```

## Failure isolation

If your plugin throws on require:
- Console prints `[plugin] xxx FAIL: <reason>`
- Other plugins and built-in routes keep working
- Status appears in `GET /api/modules`

If your plugin's adapter throws on use:
- Just that adapter's calls fail
- Other adapters keep working

## Reusing core services

```js
const { getAdapter } = require('../../adapters');
const jobs = require('../../lib/jobs');
```
