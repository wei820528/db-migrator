// Example plugin showing all four capabilities:
//   1. mount + router  → contributes /api/hello
//   2. adapter         → contributes a fake DB type so a card appears
//   3. ui.cards/tabs   → injects a card and a tab into the main UI
//   4. static          → serves files from ./public/ at /plugins/static/hello/

const express = require('express');

const router = express.Router();

router.get('/', (req, res) => {
  res.json({
    message: 'Hello from a plugin!',
    time: new Date().toISOString(),
    info: '我被 PluginHost 自動掛載；改我的程式碼存檔，會自動 hot reload',
  });
});

router.get('/echo/:text', (req, res) => {
  res.json({ echo: req.params.text });
});

// A toy "adapter" — pretends to be a DB so the UI flow lights up.
const fakeAdapter = {
  type: 'hello-fake',
  async testConnection(conn) {
    return { ok: true, version: 'Hello Fake DB v1.0', databases: ['demo_db', 'another_db'] };
  },
  async listTables(conn) {
    return [{ name: 'greetings', rowEstimate: 3 }, { name: 'farewells', rowEstimate: 1 }];
  },
  async dump(conn, opts, outFile, onProgress) {
    onProgress?.('pretending to dump...');
    require('fs').writeFileSync(outFile, '-- fake dump\nSELECT 1;\n');
    onProgress?.('done');
  },
  async restore() { throw new Error('fake restore not implemented'); },
  parseTableNamesFromDump() { return []; },
};

module.exports = {
  mount: '/api/hello',
  router,

  adapter: { type: 'hello-fake', handler: fakeAdapter },

  ui: {
    cards: [
      { type: 'hello-fake', title: 'Hello Fake DB', sub: 'plugin demo', port: '0' },
    ],
    tabs: [
      {
        id: 'hello-tab',
        label: 'Hello Tools',
        html: `
          <h2>Hello Tools <span class="tag" style="background:#fef3c7;color:#92400e;">plugin</span></h2>
          <p>這個 tab 是 plugin 動態加進來的，不在 index.html 裡。</p>
          <button id="hello-ping">Ping /api/hello</button>
          <pre id="hello-out" class="log" style="margin-top:8px;"></pre>
        `,
        scripts: ['/plugins/static/hello/init.js'],
      },
    ],
  },

  static: 'public',
};
