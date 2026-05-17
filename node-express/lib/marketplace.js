// Plugin marketplace — install plugins from GitHub via signed manifest.
//
// Flow:
//   1. User pastes GitHub URL (e.g. https://github.com/owner/repo[/tree/branch])
//   2. We fetch <raw>/plugin.json and validate the manifest shape
//   3. We fetch every file listed in manifest.files['node-express'] (+ 'shared')
//      and verify SHA-256 matches manifest.hashes
//   4. If manifest.signature is present, verify Ed25519 against the publisher
//      key (trusted-publishers.json). Else mark as "unsigned, review required".
//   5. Move files into node-express/plugins/<plugin-name>/
//   6. (pluginHost picks them up via fs.watch — hot reload)
//
// The marketplace lib only handles fetch + verify + atomic install. The
// route layer turns it into preview/install endpoints.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { URL } = require('url');

const ROOT = path.join(__dirname, '..');
const PLUGINS_DIR = path.join(ROOT, 'plugins');
const TRUST_FILE = path.join(ROOT, 'trusted-publishers.json');
const DEFAULT_PUBLISHER_PEM = path.join(__dirname, '..', '..', 'license-tools', 'public-key.pem');

const FETCH_TIMEOUT_MS = 15000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;   // 2 MB per file is plenty for a JS plugin
const MAX_FILES = 50;

// ============= GitHub URL parsing =============

// Returns { owner, repo, ref, base } or throws.
// Accepts:
//   https://github.com/owner/repo
//   https://github.com/owner/repo.git
//   https://github.com/owner/repo/tree/<ref>
//   https://github.com/owner/repo/tree/<ref>/<path-prefix>  (ignored for now)
function parseGithubUrl(input) {
  let u;
  try { u = new URL(String(input).trim()); }
  catch { throw new Error('Not a valid URL'); }
  if (u.hostname !== 'github.com') throw new Error('Only github.com URLs are accepted');
  const parts = u.pathname.replace(/^\/+|\/+$/g, '').split('/');
  if (parts.length < 2) throw new Error('URL must include owner/repo');
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, '');
  let ref = 'main';
  if (parts[2] === 'tree' && parts[3]) ref = parts[3];
  // raw.githubusercontent.com base for the chosen ref
  return {
    owner, repo, ref,
    base: `https://raw.githubusercontent.com/${owner}/${repo}/${ref}`,
    htmlBase: `https://github.com/${owner}/${repo}/tree/${ref}`,
  };
}

// ============= HTTP fetch (minimal, no deps) =============

function httpsGet(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: FETCH_TIMEOUT_MS, ...opts }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(httpsGet(res.headers.location, opts));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = []; let total = 0;
      res.on('data', (c) => {
        total += c.length;
        if (total > MAX_FILE_BYTES) { req.destroy(); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        if (total > MAX_FILE_BYTES) return reject(new Error(`File exceeds ${MAX_FILE_BYTES} bytes`));
        resolve(Buffer.concat(chunks));
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Fetch timeout')); });
    req.on('error', reject);
  });
}

// ============= Manifest validation + signature verify =============

// Same canonical JSON as license-tools/sign-plugin.js — both must produce the
// exact same string for signatures to verify.
function canonicalJson(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

function validateManifestShape(m) {
  if (!m || typeof m !== 'object') throw new Error('Manifest is not an object');
  if (typeof m.name !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(m.name))
    throw new Error('Manifest.name must be a slug (alnum / _ / -, ≤ 64 chars)');
  if (typeof m.version !== 'string') throw new Error('Manifest.version required');
  if (!m.files || typeof m.files !== 'object') throw new Error('Manifest.files required');
  const allFiles = [];
  for (const [rt, files] of Object.entries(m.files)) {
    if (!['node-express', 'dotnet8', 'shared'].includes(rt))
      throw new Error(`Unknown runtime in files: ${rt}`);
    if (!Array.isArray(files)) throw new Error(`files.${rt} must be an array`);
    for (const f of files) {
      if (typeof f !== 'string') throw new Error('files entries must be strings');
      if (!isSafeRelativePath(f)) throw new Error(`Unsafe file path: ${f}`);
      allFiles.push(f);
    }
  }
  if (allFiles.length === 0) throw new Error('Manifest lists no files');
  if (allFiles.length > MAX_FILES) throw new Error(`Too many files (max ${MAX_FILES})`);
}

// Reject absolute paths, drive letters, and any `..` segment.
function isSafeRelativePath(p) {
  if (!p || typeof p !== 'string') return false;
  if (path.isAbsolute(p)) return false;
  if (/^[A-Za-z]:[\\/]/.test(p)) return false;
  const normalized = p.replace(/\\/g, '/');
  if (normalized.split('/').includes('..')) return false;
  return /^[a-z0-9_\-./]+$/i.test(normalized);
}

function loadTrustedPublishers() {
  const list = [];
  // Default trust: the project's own publisher key (license-tools/public-key.pem)
  try {
    if (fs.existsSync(DEFAULT_PUBLISHER_PEM)) {
      list.push({ id: 'project-default', pem: fs.readFileSync(DEFAULT_PUBLISHER_PEM, 'utf8') });
    }
  } catch { }
  // User-added trusted publishers
  try {
    const j = JSON.parse(fs.readFileSync(TRUST_FILE, 'utf8'));
    if (Array.isArray(j.publishers)) {
      for (const p of j.publishers) if (p && p.pem) list.push(p);
    }
  } catch { }
  return list;
}

function verifyManifestSignature(manifest) {
  if (!manifest.signature) return { signed: false };
  const sig = Buffer.from(manifest.signature, 'base64');
  const copy = { ...manifest, signature: '' };
  const msg = Buffer.from(canonicalJson(copy), 'utf8');
  for (const pub of loadTrustedPublishers()) {
    try {
      const key = crypto.createPublicKey(pub.pem);
      if (crypto.verify(null, msg, key, sig)) {
        return { signed: true, publisher: pub.id || 'unknown', trusted: true };
      }
    } catch { /* try next */ }
  }
  return { signed: true, trusted: false, error: 'signature does not match any trusted publisher' };
}

// ============= Preview (download + verify, but don't install) =============

async function preview(githubUrl) {
  const g = parseGithubUrl(githubUrl);
  const manifestUrl = `${g.base}/plugin.json`;
  const buf = await httpsGet(manifestUrl);
  let manifest;
  try { manifest = JSON.parse(buf.toString('utf8')); }
  catch { throw new Error('plugin.json is not valid JSON'); }
  validateManifestShape(manifest);

  const sigInfo = verifyManifestSignature(manifest);

  // Pull just the node-express + shared file contents into memory and verify hashes
  const wanted = [
    ...(manifest.files['node-express'] || []).map((f) => ({ rt: 'node-express', f })),
    ...(manifest.files['shared'] || []).map((f) => ({ rt: 'shared', f })),
  ];
  const fetched = [];
  for (const { rt, f } of wanted) {
    const url = `${g.base}/${f}`;
    const body = await httpsGet(url);
    const hex = crypto.createHash('sha256').update(body).digest('hex');
    const expected = manifest.hashes?.[rt]?.[f];
    if (expected && expected !== hex) {
      throw new Error(`Hash mismatch for ${rt}/${f}: manifest says ${expected.slice(0, 16)}…, got ${hex.slice(0, 16)}…`);
    }
    fetched.push({ rt, f, bytes: body.length, hash: hex, hashOk: !expected || expected === hex, body });
  }

  return {
    source: g,
    manifest,
    signature: sigInfo,
    files: fetched.map((x) => ({ runtime: x.rt, path: x.f, bytes: x.bytes, hash: x.hash, hashOk: x.hashOk })),
    // Internal: bodies are returned only for install() consumption; the route layer strips them.
    _bodies: fetched,
  };
}

// ============= Install (write files atomically into plugins/) =============

async function install(githubUrl, { allowUnsigned = false } = {}) {
  const prev = await preview(githubUrl);
  if (!prev.signature.signed && !allowUnsigned) {
    throw new Error('plugin is unsigned — re-run with allowUnsigned=true after reviewing source');
  }
  if (prev.signature.signed && !prev.signature.trusted && !allowUnsigned) {
    throw new Error(`plugin signed by untrusted publisher: ${prev.signature.error || 'unknown'}`);
  }
  for (const f of prev.files) {
    if (!f.hashOk) throw new Error(`hash failed for ${f.path}`);
  }

  const pluginRoot = path.join(PLUGINS_DIR, prev.manifest.name);
  if (!isInside(pluginRoot, PLUGINS_DIR)) throw new Error('install path escape attempt');

  // Write into a staging dir first, then rename — so a half-finished install
  // doesn't get picked up by the hot-reload watcher.
  const staging = pluginRoot + '.staging-' + Date.now();
  fs.mkdirSync(staging, { recursive: true });
  try {
    fs.writeFileSync(path.join(staging, 'plugin.json'), JSON.stringify(prev.manifest, null, 2));
    for (const f of prev._bodies) {
      const outPath = path.join(staging, f.f);
      const outDir = path.dirname(outPath);
      if (!isInside(outPath, staging)) throw new Error(`path escape on file ${f.f}`);
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(outPath, f.body);
    }
    // Remove previous version if any, then atomically rename staging → pluginRoot
    if (fs.existsSync(pluginRoot)) fs.rmSync(pluginRoot, { recursive: true, force: true });
    fs.renameSync(staging, pluginRoot);
  } catch (e) {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
    throw e;
  }

  return {
    ok: true,
    installed: prev.manifest.name,
    version: prev.manifest.version,
    fileCount: prev.files.length,
    signed: prev.signature.signed,
    trusted: !!prev.signature.trusted,
    installPath: pluginRoot,
  };
}

function isInside(target, parent) {
  const t = path.resolve(target);
  const p = path.resolve(parent);
  return t === p || t.startsWith(p + path.sep);
}

function listInstalled() {
  if (!fs.existsSync(PLUGINS_DIR)) return [];
  const out = [];
  for (const entry of fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const mfPath = path.join(PLUGINS_DIR, entry.name, 'plugin.json');
    if (!fs.existsSync(mfPath)) continue;
    try {
      const m = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
      out.push({
        name: m.name, version: m.version, description: m.description || '',
        signed: !!m.signature, dir: entry.name,
      });
    } catch { /* skip corrupt */ }
  }
  return out;
}

function uninstall(name) {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(name)) throw new Error('bad plugin name');
  const dir = path.join(PLUGINS_DIR, name);
  if (!isInside(dir, PLUGINS_DIR)) throw new Error('path escape');
  if (!fs.existsSync(dir)) throw new Error('not installed: ' + name);
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true, uninstalled: name };
}

function addTrustedPublisher({ id, pem }) {
  if (!id || !pem) throw new Error('id and pem required');
  try { crypto.createPublicKey(pem); }
  catch (e) { throw new Error('invalid PEM: ' + e.message); }
  let trust = { publishers: [] };
  try { trust = JSON.parse(fs.readFileSync(TRUST_FILE, 'utf8')); } catch {}
  trust.publishers = (trust.publishers || []).filter((p) => p.id !== id);
  trust.publishers.push({ id, pem });
  fs.writeFileSync(TRUST_FILE, JSON.stringify(trust, null, 2));
  return { ok: true };
}

function removeTrustedPublisher(id) {
  try {
    const trust = JSON.parse(fs.readFileSync(TRUST_FILE, 'utf8'));
    trust.publishers = (trust.publishers || []).filter((p) => p.id !== id);
    fs.writeFileSync(TRUST_FILE, JSON.stringify(trust, null, 2));
  } catch { }
  return { ok: true };
}

module.exports = {
  parseGithubUrl,
  preview,
  install,
  listInstalled,
  uninstall,
  loadTrustedPublishers,
  addTrustedPublisher,
  removeTrustedPublisher,
  // exposed for tests
  _internal: { isSafeRelativePath, isInside, canonicalJson, validateManifestShape, verifyManifestSignature },
};
