// Phase 2 tests — token lib pure helpers。完整 HTTP round-trip 留給 portal e2e。

const test = require('node:test');
const assert = require('node:assert');
const tokens = require('../lib/tokens');

// ============ generateToken ============

test('generateToken returns "dbmt_" prefix + base64url body', () => {
  const t = tokens.generateToken();
  assert.ok(t.startsWith('dbmt_'));
  // base64url 用 [A-Za-z0-9_-]，沒有 `=` padding
  assert.match(t.slice(5), /^[A-Za-z0-9_-]+$/);
});

test('generateToken returns unique tokens (10k samples no collision)', () => {
  const seen = new Set();
  for (let i = 0; i < 10_000; i++) {
    const t = tokens.generateToken();
    assert.ok(!seen.has(t), 'collision after ' + i + ' tries');
    seen.add(t);
  }
});

test('generateToken has ≥ 32 bytes of entropy in body (base64url length ≥ 43)', () => {
  const t = tokens.generateToken();
  const body = t.slice(5);
  // base64url-encoded 32 bytes = ceil(32 * 4 / 3) = 43 chars (no padding)
  assert.ok(body.length >= 43, `body length ${body.length} too short`);
});

// ============ hashToken ============

test('hashToken is deterministic SHA-256 hex (64 chars)', () => {
  const h = tokens.hashToken('dbmt_abcXYZ');
  assert.strictEqual(h.length, 64);
  assert.match(h, /^[0-9a-f]+$/);
  // determinism
  assert.strictEqual(tokens.hashToken('dbmt_abcXYZ'), h);
});

test('hashToken differs for different tokens', () => {
  assert.notStrictEqual(
    tokens.hashToken('dbmt_a'),
    tokens.hashToken('dbmt_b'),
  );
});

// ============ previewPrefix ============

test('previewPrefix returns first 12 chars + ellipsis', () => {
  const t = 'dbmt_AAAAAAAAAAAAAAA';
  assert.strictEqual(tokens.previewPrefix(t), 'dbmt_AAAAAAA…');
});

test('previewPrefix handles short input gracefully', () => {
  assert.strictEqual(tokens.previewPrefix('dbmt_'), 'dbmt_…');
});

// ============ isApiToken ============

test('isApiToken accepts dbmt_ prefix', () => {
  assert.strictEqual(tokens.isApiToken('dbmt_abc'), true);
});

test('isApiToken rejects session-style tokens (no prefix)', () => {
  assert.strictEqual(tokens.isApiToken('abc123hexbytes'), false);
});

test('isApiToken rejects non-strings', () => {
  assert.strictEqual(tokens.isApiToken(null), false);
  assert.strictEqual(tokens.isApiToken(undefined), false);
  assert.strictEqual(tokens.isApiToken(123), false);
});

// ============ validateScopes ============

test('validateScopes accepts known scopes', () => {
  assert.doesNotThrow(() => tokens.validateScopes(['user:read', 'user:write']));
  assert.doesNotThrow(() => tokens.validateScopes(['user:read']));
});

test('validateScopes rejects unknown scope', () => {
  assert.throws(() => tokens.validateScopes(['admin:full']), /unknown scope/);
  assert.throws(() => tokens.validateScopes(['user:read', 'bogus']), /unknown scope/);
});

test('validateScopes rejects non-array / empty', () => {
  assert.throws(() => tokens.validateScopes([]), /non-empty array/);
  assert.throws(() => tokens.validateScopes(null), /non-empty array/);
  assert.throws(() => tokens.validateScopes('user:read'), /non-empty array/);
});

test('validateScopes returns the (validated) list unchanged on success', () => {
  const r = tokens.validateScopes(['user:read', 'user:write']);
  assert.deepStrictEqual(r, ['user:read', 'user:write']);
});

// ============ hasScope ============

test('hasScope true when scope is in list', () => {
  assert.strictEqual(tokens.hasScope(['user:read', 'user:write'], 'user:read'), true);
});

test('hasScope false when scope is not in list', () => {
  assert.strictEqual(tokens.hasScope(['user:read'], 'user:write'), false);
});

test('hasScope false when first arg is not array', () => {
  assert.strictEqual(tokens.hasScope(null, 'user:read'), false);
  assert.strictEqual(tokens.hasScope('user:read', 'user:read'), false);
});

// ============ Defaults / constants sanity ============

test('DEFAULT_SCOPES are all in KNOWN_SCOPES', () => {
  for (const s of tokens.DEFAULT_SCOPES) {
    assert.ok(tokens.KNOWN_SCOPES.has(s), `default scope ${s} not in KNOWN_SCOPES`);
  }
});

test('TOKEN_PREFIX is the stable "dbmt_" string', () => {
  assert.strictEqual(tokens.TOKEN_PREFIX, 'dbmt_');
});
