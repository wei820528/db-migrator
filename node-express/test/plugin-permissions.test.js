// v2 Theme D Phase 1 tests — permission catalog + manifest validator + grant flow。
// 純函式，無 I/O；marketplace install 路徑 e2e 留給 marketplace.test.js 既有的 stub。

const test = require('node:test');
const assert = require('node:assert');

const {
  PERMISSIONS, KNOWN_PERMISSIONS,
  validatePermissions, describePermissions, verifyGrants,
} = require('../lib/plugin-permissions');

// ============ Catalog sanity ============

test('PERMISSIONS catalog has all expected ids', () => {
  for (const id of [
    'route', 'ui:cards', 'ui:tabs', 'static', 'adapter',
    'db:read', 'db:write',
    'fs:tmp', 'fs:plugin-dir', 'network', 'unrestricted',
  ]) {
    assert.ok(PERMISSIONS[id], `missing permission catalog entry: ${id}`);
    assert.ok(PERMISSIONS[id].label, `${id} missing label`);
    assert.ok(PERMISSIONS[id].description, `${id} missing description`);
    assert.ok([1, 2, 3].includes(PERMISSIONS[id].risk), `${id} risk out of [1,2,3]`);
  }
});

test('KNOWN_PERMISSIONS matches catalog keys', () => {
  assert.deepStrictEqual([...KNOWN_PERMISSIONS].sort(), Object.keys(PERMISSIONS).sort());
});

test('high-risk permissions include unrestricted / network / adapter / db:write', () => {
  for (const id of ['unrestricted', 'network', 'adapter', 'db:write']) {
    assert.strictEqual(PERMISSIONS[id].risk, 3, `${id} should be risk=3`);
  }
});

// ============ validatePermissions ============

test('validatePermissions: omitted → legacy unrestricted (with warning flag)', () => {
  for (const v of [undefined, null]) {
    const r = validatePermissions(v);
    assert.deepStrictEqual(r.permissions, ['unrestricted']);
    assert.strictEqual(r.legacy, true);
  }
});

test('validatePermissions: accepts known permissions, normalizes dupes', () => {
  const r = validatePermissions(['route', 'ui:cards', 'route', 'static']);
  assert.deepStrictEqual(r.permissions, ['route', 'ui:cards', 'static']);
  assert.strictEqual(r.legacy, false);
});

test('validatePermissions: rejects unknown permission', () => {
  assert.throws(() => validatePermissions(['route', 'wat']), /unknown permission: wat/);
});

test('validatePermissions: rejects non-array', () => {
  assert.throws(() => validatePermissions('route'), /must be an array/);
  assert.throws(() => validatePermissions({}),      /must be an array/);
});

test('validatePermissions: rejects empty array (different from omitted)', () => {
  assert.throws(() => validatePermissions([]), /cannot be empty/);
});

test('validatePermissions: rejects non-string entries', () => {
  assert.throws(() => validatePermissions(['route', 42]), /permissions must be strings/);
});

// ============ describePermissions ============

test('describePermissions enriches ids with label / desc / risk', () => {
  const out = describePermissions(['route', 'network']);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].id, 'route');
  assert.ok(out[0].label);
  assert.ok(out[0].description);
  assert.strictEqual(out[1].id, 'network');
  assert.strictEqual(out[1].risk, 3);
});

test('describePermissions: unknown id surfaces as risk=3 with placeholder', () => {
  const out = describePermissions(['definitely-not-real']);
  assert.strictEqual(out[0].risk, 3);   // default to high risk
  assert.match(out[0].description, /unknown/);
});

// ============ verifyGrants ============

test('verifyGrants: grants must be subset of requested', () => {
  assert.doesNotThrow(() => verifyGrants(['route', 'static'], ['route']));
  assert.doesNotThrow(() => verifyGrants(['route', 'static'], []));   // grant nothing OK
  assert.doesNotThrow(() => verifyGrants(['route'], null));            // null OK
});

test('verifyGrants: granting unrequested permission throws', () => {
  assert.throws(
    () => verifyGrants(['route'], ['route', 'network']),
    /granted permission "network" was not requested/
  );
});

test('verifyGrants returns the granted list unchanged', () => {
  const r = verifyGrants(['route', 'static'], ['route']);
  assert.deepStrictEqual(r, ['route']);
});

// ============ marketplace integration (signal-level) ============
// 跑 marketplace lib 的 validateManifestShape 確認 permissions 走進來會被 validate

test('marketplace.validateManifestShape rejects manifests with bad permissions', () => {
  const { _internal } = require('../lib/marketplace');
  assert.throws(
    () => _internal.validateManifestShape({
      name: 'demo', version: '1.0.0',
      files: { 'node-express': ['index.js'] },
      permissions: ['nonexistent-perm'],
    }),
    /unknown permission/
  );
});

test('marketplace.validateManifestShape accepts manifests with valid permissions', () => {
  const { _internal } = require('../lib/marketplace');
  assert.doesNotThrow(() => _internal.validateManifestShape({
    name: 'demo', version: '1.0.0',
    files: { 'node-express': ['index.js'] },
    permissions: ['route', 'static'],
  }));
});

test('marketplace.validateManifestShape accepts manifest WITHOUT permissions (legacy)', () => {
  const { _internal } = require('../lib/marketplace');
  assert.doesNotThrow(() => _internal.validateManifestShape({
    name: 'demo', version: '1.0.0',
    files: { 'node-express': ['index.js'] },
  }));
});

// ============ hello plugin sample manifest validates ============

test('plugins/hello/plugin.json is a valid permission-aware manifest', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const m = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'plugins', 'hello', 'plugin.json'), 'utf8'));
  const r = validatePermissions(m.permissions);
  assert.strictEqual(r.legacy, false);
  // Demo plugin uses route + adapter + ui + static — no high-risk ones (adapter is 3 though)
  assert.ok(r.permissions.includes('route'));
  assert.ok(r.permissions.includes('adapter'));
});
