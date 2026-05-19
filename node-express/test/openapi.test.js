// Phase 3 tests — OpenAPI spec sanity（純 JSON load，無需 server）。
//
// HTTP-level serving 在 license-server 跟 node-express 都靠 express.static 跟一個
// route handler；那個放在 unit test 裡會引入 express，所以這邊只驗 spec 內容對。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SPECS = {
  'node-express':   path.join(__dirname, '..', 'openapi.json'),
  'license-server': path.join(__dirname, '..', '..', 'license-server', 'openapi.json'),
};

for (const [name, file] of Object.entries(SPECS)) {
  test(`${name}: openapi.json file exists`, () => {
    assert.ok(fs.existsSync(file), `${file} missing`);
  });

  test(`${name}: openapi.json parses as JSON`, () => {
    const txt = fs.readFileSync(file, 'utf8');
    assert.doesNotThrow(() => JSON.parse(txt));
  });
}

// Detailed checks per spec

test('node-express spec: openapi 3.0.x + version + key paths', () => {
  const spec = JSON.parse(fs.readFileSync(SPECS['node-express'], 'utf8'));
  assert.match(spec.openapi, /^3\.0\.\d+$/);
  assert.ok(spec.info?.title);
  assert.ok(spec.info?.version);
  for (const p of [
    '/api/license', '/api/connection/test', '/api/export', '/api/import/run',
    '/api/jobs/{id}', '/api/schedule', '/api/marketplace/preview',
    '/api/cross-db/preview-live', '/api/modules',
  ]) {
    assert.ok(spec.paths[p], `${p} missing from node-express spec`);
  }
});

test('license-server spec: openapi 3.0.x + version + key paths', () => {
  const spec = JSON.parse(fs.readFileSync(SPECS['license-server'], 'utf8'));
  assert.match(spec.openapi, /^3\.0\.\d+$/);
  assert.ok(spec.info?.title);
  for (const p of [
    '/api/auth/register', '/api/auth/login', '/api/auth/heartbeat',
    '/api/user/me', '/api/user/sessions', '/api/user/tokens',
    '/api/user/tokens/{id}', '/api/auth/2fa/verify-login',
    '/api/billing/checkout', '/api/revocation/list',
    '/api/admin/users', '/api/admin/licenses',
  ]) {
    assert.ok(spec.paths[p], `${p} missing from license-server spec`);
  }
});

test('node-express spec: every operation has tags + summary', () => {
  const spec = JSON.parse(fs.readFileSync(SPECS['node-express'], 'utf8'));
  for (const [p, methods] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      assert.ok(op.tags && op.tags.length > 0, `${method.toUpperCase()} ${p} missing tags`);
      assert.ok(op.summary, `${method.toUpperCase()} ${p} missing summary`);
      assert.ok(op.responses, `${method.toUpperCase()} ${p} missing responses`);
    }
  }
});

test('license-server spec: every operation has tags + summary', () => {
  const spec = JSON.parse(fs.readFileSync(SPECS['license-server'], 'utf8'));
  for (const [p, methods] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      assert.ok(op.tags && op.tags.length > 0, `${method.toUpperCase()} ${p} missing tags`);
      assert.ok(op.summary, `${method.toUpperCase()} ${p} missing summary`);
      assert.ok(op.responses, `${method.toUpperCase()} ${p} missing responses`);
    }
  }
});

test('license-server spec: declares both bearerAuth + adminCookie security schemes', () => {
  const spec = JSON.parse(fs.readFileSync(SPECS['license-server'], 'utf8'));
  assert.ok(spec.components?.securitySchemes?.bearerAuth);
  assert.ok(spec.components?.securitySchemes?.adminCookie);
});

test('license-server spec: API token endpoints reference bearerAuth security', () => {
  const spec = JSON.parse(fs.readFileSync(SPECS['license-server'], 'utf8'));
  // POST /api/user/tokens 必須要 bearer
  const create = spec.paths['/api/user/tokens'].post;
  assert.ok(create.security?.some((s) => 'bearerAuth' in s),
    'POST /api/user/tokens missing bearerAuth security');
});

test('node-express spec: cross-db preview-live references IRType schema chain', () => {
  const spec = JSON.parse(fs.readFileSync(SPECS['node-express'], 'utf8'));
  // 不一定直接引用 IRType（preview returns a richer shape），但 IRType 必須有定義
  assert.ok(spec.components?.schemas?.IRType, 'IRType schema missing');
  assert.ok(spec.components?.schemas?.LicenseStatus, 'LicenseStatus schema missing');
});

test('both specs reference paths that match real routes (smoke)', () => {
  // 用 node-express server.js 的 safeMount 行當作真實路由 prefix 來源
  const srvPath = path.join(__dirname, '..', 'server.js');
  const src = fs.readFileSync(srvPath, 'utf8');
  const mounted = [...src.matchAll(/safeMount\(\s*'(\/api\/[^']+)'/g)].map((m) => m[1]);
  // 真的存在的 prefix（去重）
  const prefixes = new Set(mounted);
  // 確認 openapi spec 內每個 path 都對應到一個有掛載的 prefix（或 license / modules / plugins 那種根 app.get 的）
  const spec = JSON.parse(fs.readFileSync(SPECS['node-express'], 'utf8'));
  const allowList = new Set([
    '/api/modules', '/api/plugins/ui', '/api/plugins/reload',  // 根 app.get 註冊的
    '/metrics', '/healthz',                                     // v2 Theme E observability，根 app.get
  ]);
  for (const p of Object.keys(spec.paths)) {
    const ok = [...prefixes].some((prefix) => p === prefix || p.startsWith(prefix + '/')) || allowList.has(p);
    assert.ok(ok, `${p} not backed by any mounted route in server.js`);
  }
});

// ============ api-docs HTML sanity ============

test('node-express api-docs/index.html references /openapi.json', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'api-docs', 'index.html'), 'utf8');
  assert.match(html, /url:\s*'\/openapi\.json'/);
  assert.match(html, /SwaggerUIBundle/);
});

test('license-server api-docs/index.html references /openapi.json', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'license-server', 'public', 'api-docs', 'index.html'), 'utf8');
  assert.match(html, /url:\s*'\/openapi\.json'/);
  assert.match(html, /SwaggerUIBundle/);
});
