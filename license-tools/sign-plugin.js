#!/usr/bin/env node
// Sign a plugin manifest with the project Ed25519 private key.
//
// Usage:
//   node license-tools/sign-plugin.js <path-to-plugin-dir>
//
// The dir must contain a plugin.json manifest. We:
//   1. Compute SHA-256 of every file listed in manifest.files.*
//   2. Write those hashes back into the manifest
//   3. Sign the canonical-JSON of the manifest (with `signature` field empty)
//   4. Embed the signature into the manifest
//   5. Print the final manifest
//
// The signed manifest is what users' DB Migrator clients will verify against
// their trusted-publishers list before installing.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const pluginDir = process.argv[2];
if (!pluginDir) {
  console.error('Usage: node sign-plugin.js <plugin-dir>');
  process.exit(1);
}
const manifestPath = path.join(pluginDir, 'plugin.json');
if (!fs.existsSync(manifestPath)) {
  console.error(`No plugin.json found in ${pluginDir}`);
  process.exit(1);
}
const privPath = path.join(__dirname, 'private-key.pem');
if (!fs.existsSync(privPath)) {
  console.error(`Private key not found at ${privPath}. Run generate-keypair.js first.`);
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (!manifest.name || !manifest.version || !manifest.files) {
  console.error('Manifest must have at least: name, version, files');
  process.exit(1);
}

// v2 Theme D Phase 1：驗證 permissions 欄位（若有宣告）
// Known permissions 列表跟 node-express/lib/plugin-permissions.js 同步
const KNOWN_PERMISSIONS = new Set([
  'route', 'ui:cards', 'ui:tabs', 'static', 'adapter',
  'db:read', 'db:write',
  'fs:tmp', 'fs:plugin-dir', 'network',
  'unrestricted',
]);
if (manifest.permissions !== undefined) {
  if (!Array.isArray(manifest.permissions) || manifest.permissions.length === 0) {
    console.error('manifest.permissions must be a non-empty array (or omit the field for legacy unrestricted)');
    process.exit(1);
  }
  for (const p of manifest.permissions) {
    if (!KNOWN_PERMISSIONS.has(p)) {
      console.error(`Unknown permission "${p}". Known: ${[...KNOWN_PERMISSIONS].join(', ')}`);
      process.exit(1);
    }
  }
  console.log(`✓ permissions: ${manifest.permissions.join(', ')}`);
} else {
  console.warn('⚠ no `permissions` field declared — plugin will be installed as `unrestricted` (legacy).');
  console.warn('  Add `"permissions": ["route", ...]` to your plugin.json so users see what they\'re granting.');
}

// Hash every file under manifest.files (object keyed by runtime: 'node-express' / 'dotnet8' / 'shared')
const hashes = {};
for (const [runtime, files] of Object.entries(manifest.files)) {
  hashes[runtime] = {};
  for (const rel of files) {
    const full = path.join(pluginDir, rel);
    if (!fs.existsSync(full)) {
      console.error(`Missing file referenced by manifest: ${rel}`);
      process.exit(1);
    }
    hashes[runtime][rel] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
  }
}
manifest.hashes = hashes;
manifest.signedAt = new Date().toISOString();
manifest.signature = '';     // placeholder so canonical JSON includes the key

const canonical = canonicalJson(manifest);
const privateKey = crypto.createPrivateKey(fs.readFileSync(privPath));
const sig = crypto.sign(null, Buffer.from(canonical, 'utf8'), privateKey).toString('base64');
manifest.signature = sig;

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log('Signed manifest written to', manifestPath);
console.log('Signature:', sig.slice(0, 40) + '...');
console.log('\nFiles hashed:');
for (const [rt, h] of Object.entries(hashes))
  for (const [f, hex] of Object.entries(h))
    console.log(`  ${rt}: ${f} ${hex.slice(0, 16)}...`);

// Canonical JSON: stable key order so signing is reproducible.
function canonicalJson(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}
