// Offline license: Ed25519-signed license.key + .trial timestamp.
// (Original behavior — used when LICENSE_MODE=offline.)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const revocation = require('./revocation');

// =====================================================================
// REPLACE THIS with your real public key (from license-tools/generate-keypair.js).
// =====================================================================
const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAREPLACE_WITH_YOUR_PUBLIC_KEY_AFTER_GENERATING_IT==
-----END PUBLIC KEY-----`;

const TRIAL_DAYS = 32;
const ROOT = path.join(__dirname, '..');
const LICENSE_PATH = path.join(ROOT, 'license.key');
const TRIAL_PATH = path.join(ROOT, '.trial');

let publicKey = null;
function getPublicKey() {
  if (publicKey) return publicKey;
  try { publicKey = crypto.createPublicKey(PUBLIC_KEY_PEM); }
  catch { publicKey = null; }
  return publicKey;
}

function verifyLicenseString(licenseString) {
  const [payloadB64, sigB64] = String(licenseString || '').trim().split('.');
  if (!payloadB64 || !sigB64) throw new Error('License format invalid');
  const pk = getPublicKey();
  if (!pk) throw new Error('App is missing a public key (development build?)');
  const ok = crypto.verify(null, Buffer.from(payloadB64, 'utf8'), pk, Buffer.from(sigB64, 'base64url'));
  if (!ok) throw new Error('License signature invalid');
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  if (!payload.expires) throw new Error('License missing expiry');
  return payload;
}

function readLicenseFile() {
  if (!fs.existsSync(LICENSE_PATH)) return null;
  try { return fs.readFileSync(LICENSE_PATH, 'utf8'); } catch { return null; }
}

function readTrialStart() {
  try {
    const j = JSON.parse(fs.readFileSync(TRIAL_PATH, 'utf8'));
    return new Date(j.first_run);
  } catch { return null; }
}

function ensureTrialStart() {
  let t = readTrialStart();
  if (!t || isNaN(t.getTime())) {
    t = new Date();
    fs.writeFileSync(TRIAL_PATH, JSON.stringify({ first_run: t.toISOString() }, null, 2));
  }
  return t;
}

function revocationUrlFor(payload) {
  return process.env.LICENSE_REVOCATION_URL || payload?.rurl || '';
}

function getStatus() {
  const raw = readLicenseFile();
  if (raw) {
    try {
      const payload = verifyLicenseString(raw);
      const expires = new Date(payload.expires);
      const daysLeft = Math.max(0, Math.ceil((expires - new Date()) / (1000 * 60 * 60 * 24)));

      // Remote kill switch — only meaningful if license has an `lid`
      if (payload.lid) {
        const url = revocationUrlFor(payload);
        if (url) revocation.maybeRefresh(url);          // fire-and-forget
        const rc = revocation.checkCache(payload.lid);
        if (rc.state === 'revoked') {
          return {
            status: 'revoked', daysLeft: 0, info: payload,
            error: rc.reason ? `License revoked: ${rc.reason}` : 'License revoked by issuer',
            revocation: { revokedAt: rc.revokedAt, reason: rc.reason },
          };
        }
        if (rc.state === 'stale') {
          // hard cap exceeded — refuse to start until we can reach the server
          return {
            status: 'expired', daysLeft: 0, info: payload,
            error: `Revocation list unreachable for ${Math.floor(rc.daysStale)} days. Connect this machine to the internet to verify.`,
            revocation: { state: 'stale', daysStale: rc.daysStale },
          };
        }
        // 'clear' or 'never' → don't block. UI may surface 'never' as a warning.
        if (expires > new Date()) {
          return { status: 'licensed', daysLeft, info: payload,
                   revocation: rc.state === 'never' ? { state: 'never' } : { state: 'clear', fetchedAt: rc.fetchedAt } };
        }
        return { status: 'expired', daysLeft: 0, info: payload, error: 'License expired' };
      }

      // Legacy license (no lid) — no revocation possible
      if (expires > new Date()) return { status: 'licensed', daysLeft, info: payload };
      return { status: 'expired', daysLeft: 0, info: payload, error: 'License expired' };
    } catch (e) {
      return { status: 'expired', daysLeft: 0, error: e.message };
    }
  }
  const start = ensureTrialStart();
  const elapsed = (Date.now() - start.getTime()) / (1000 * 60 * 60 * 24);
  const daysLeft = Math.max(0, Math.ceil(TRIAL_DAYS - elapsed));
  if (daysLeft > 0) return { status: 'trial', daysLeft, info: { trialStartedAt: start.toISOString() } };
  return { status: 'expired', daysLeft: 0, error: 'Trial period ended' };
}

async function refreshRevocation() {
  const raw = readLicenseFile();
  if (!raw) return { ok: false, error: 'no license' };
  let payload;
  try { payload = verifyLicenseString(raw); }
  catch (e) { return { ok: false, error: e.message }; }
  if (!payload.lid) return { ok: false, error: 'license has no lid (legacy v1)' };
  const url = revocationUrlFor(payload);
  if (!url) return { ok: false, error: 'no revocation URL configured' };
  return revocation.refreshNow(url);
}

function saveLicense(licenseString) {
  const payload = verifyLicenseString(licenseString);
  fs.writeFileSync(LICENSE_PATH, licenseString.trim());
  return payload;
}

function removeLicense() {
  if (fs.existsSync(LICENSE_PATH)) fs.unlinkSync(LICENSE_PATH);
}

module.exports = { getStatus, saveLicense, removeLicense, refreshRevocation };
