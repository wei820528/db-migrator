// Marketplace tests. We cover everything that doesn't require talking to GitHub:
// URL parsing, path-safety guards, canonical JSON, manifest validation,
// signature verification (using a self-generated Ed25519 key for the test).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const http = require('node:http');

const mp = require('../lib/marketplace');
const { parseGithubUrl, _internal } = mp;
const { isSafeRelativePath, isInside, canonicalJson, validateManifestShape, verifyManifestSignature } = _internal;

// =================== URL parsing ===================

test('parseGithubUrl accepts plain repo URL', () => {
  const r = parseGithubUrl('https://github.com/foo/bar');
  assert.strictEqual(r.owner, 'foo');
  assert.strictEqual(r.repo, 'bar');
  assert.strictEqual(r.ref, 'main');
  assert.strictEqual(r.base, 'https://raw.githubusercontent.com/foo/bar/main');
});

test('parseGithubUrl strips .git suffix', () => {
  const r = parseGithubUrl('https://github.com/foo/bar.git');
  assert.strictEqual(r.repo, 'bar');
});

test('parseGithubUrl extracts branch from /tree/<ref>', () => {
  const r = parseGithubUrl('https://github.com/foo/bar/tree/develop');
  assert.strictEqual(r.ref, 'develop');
  assert.strictEqual(r.base, 'https://raw.githubusercontent.com/foo/bar/develop');
});

test('parseGithubUrl rejects non-github hosts', () => {
  assert.throws(() => parseGithubUrl('https://gitlab.com/foo/bar'), /github\.com/);
});

test('parseGithubUrl rejects URLs without owner/repo', () => {
  assert.throws(() => parseGithubUrl('https://github.com/'), /owner\/repo/);
  assert.throws(() => parseGithubUrl('https://github.com/owner'), /owner\/repo/);
});

test('parseGithubUrl rejects garbage input', () => {
  assert.throws(() => parseGithubUrl('not a url'));
});

// =================== Path safety ===================

test('isSafeRelativePath accepts normal relative paths', () => {
  assert.strictEqual(isSafeRelativePath('src/index.js'), true);
  assert.strictEqual(isSafeRelativePath('a/b/c.js'), true);
  assert.strictEqual(isSafeRelativePath('hello.cs'), true);
});

test('isSafeRelativePath rejects absolute paths', () => {
  assert.strictEqual(isSafeRelativePath('/etc/passwd'), false);
  assert.strictEqual(isSafeRelativePath('C:/Windows/system32/cmd.exe'), false);
  assert.strictEqual(isSafeRelativePath('C:\\Windows\\system32\\cmd.exe'), false);
});

test('isSafeRelativePath rejects .. segments', () => {
  assert.strictEqual(isSafeRelativePath('../escape.js'), false);
  assert.strictEqual(isSafeRelativePath('a/../b'), false);
  assert.strictEqual(isSafeRelativePath('a/b/../../escape'), false);
});

test('isSafeRelativePath rejects weird chars', () => {
  assert.strictEqual(isSafeRelativePath('file;rm -rf /'), false);
  assert.strictEqual(isSafeRelativePath('file with spaces.js'), false);
});

test('isInside detects nested vs sibling/parent paths', () => {
  const tmp = os.tmpdir();
  assert.strictEqual(isInside(path.join(tmp, 'a', 'b'), path.join(tmp, 'a')), true);
  assert.strictEqual(isInside(path.join(tmp, 'a', 'b', '..', 'b'), path.join(tmp, 'a')), true);
  assert.strictEqual(isInside(path.join(tmp, 'other'), path.join(tmp, 'a')), false);
});

// =================== Canonical JSON ===================

test('canonicalJson sorts object keys', () => {
  assert.strictEqual(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
});

test('canonicalJson is recursive', () => {
  const obj = { z: { c: 3, a: 1 }, a: [{ y: 2, x: 1 }] };
  assert.strictEqual(canonicalJson(obj), '{"a":[{"x":1,"y":2}],"z":{"a":1,"c":3}}');
});

test('canonicalJson handles primitives', () => {
  assert.strictEqual(canonicalJson(null), 'null');
  assert.strictEqual(canonicalJson(true), 'true');
  assert.strictEqual(canonicalJson('hello'), '"hello"');
  assert.strictEqual(canonicalJson(42), '42');
});

// =================== Manifest validation ===================

const validManifest = {
  name: 'hello-plugin',
  version: '1.0.0',
  description: 'demo',
  files: { 'node-express': ['index.js'], 'dotnet8': ['Hello.cs'] },
};

test('validateManifestShape accepts a minimal valid manifest', () => {
  assert.doesNotThrow(() => validateManifestShape(validManifest));
});

test('validateManifestShape rejects bad names', () => {
  assert.throws(() => validateManifestShape({ ...validManifest, name: 'BAD NAME!' }), /slug/);
  assert.throws(() => validateManifestShape({ ...validManifest, name: '' }), /slug/);
});

test('validateManifestShape rejects unknown runtimes', () => {
  assert.throws(() => validateManifestShape({ ...validManifest, files: { python: ['x.py'] } }), /Unknown runtime/);
});

test('validateManifestShape rejects unsafe paths in files', () => {
  assert.throws(() => validateManifestShape({ ...validManifest, files: { 'node-express': ['../escape.js'] } }), /Unsafe/);
});

test('validateManifestShape rejects empty file list', () => {
  assert.throws(() => validateManifestShape({ ...validManifest, files: { 'node-express': [] } }), /no files/);
});

// =================== Signature verification ===================

test('verifyManifestSignature reports "not signed" for empty signature', () => {
  const r = verifyManifestSignature({ ...validManifest, signature: '' });
  assert.strictEqual(r.signed, false);
});

test('verifyManifestSignature reports "untrusted" for a signature that no publisher matches', () => {
  // Generate a one-off key, sign a manifest, but DON'T register it as trusted.
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const m = { ...validManifest, hashes: { 'node-express': { 'index.js': 'abc' } }, signedAt: '2026-01-01', signature: '' };
  const sig = crypto.sign(null, Buffer.from(canonicalJson(m), 'utf8'), privateKey).toString('base64');
  m.signature = sig;
  // (We don't add the publicKey to the trust store; project-default key won't match either.)
  const r = verifyManifestSignature(m);
  assert.strictEqual(r.signed, true);
  assert.strictEqual(r.trusted, false);
  // Keep generated public key from being unused-var warning
  assert.ok(publicKey);
});

test('verifyManifestSignature trusts a manifest signed by a registered publisher (uses temp trust file)', () => {
  // We can't easily inject a custom trust file path without touching the module,
  // but we CAN use addTrustedPublisher() which writes to the file in PLUGINS dir.
  // Use a key tied to a unique ID so this test is idempotent.
  const id = 'test-' + process.pid;
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' });

  // Sign a manifest with this key
  const m = { ...validManifest, signedAt: '2026-01-01', signature: '' };
  const sig = crypto.sign(null, Buffer.from(canonicalJson(m), 'utf8'), privateKey).toString('base64');
  m.signature = sig;

  try {
    mp.addTrustedPublisher({ id, pem });
    const r = verifyManifestSignature(m);
    assert.strictEqual(r.signed, true);
    assert.strictEqual(r.trusted, true);
    assert.strictEqual(r.publisher, id);
  } finally {
    mp.removeTrustedPublisher(id);
  }
});

// =================== Full preview/install round trip against a local HTTP fixture ===================
// We can't redirect raw.githubusercontent.com to localhost, so we monkey-patch
// parseGithubUrl by constructing a tiny stand-in for testing. Skip this for now —
// the unit tests above cover the verification logic. End-to-end preview+install
// is covered by manual smoke tests and (future) docker-compose integration.
