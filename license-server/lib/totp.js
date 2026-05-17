// TOTP (RFC 6238) helper — uses otplib for codes + qrcode for SVG QR.
//
// Secret is stored encrypted (AES-256-GCM) via lib/encrypt.js.
// The Authenticator app scans the otpauth:// URI which embeds the *plain* secret.

const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const { encrypt, decrypt } = require('./encrypt');

const ISSUER = process.env.TOTP_ISSUER || 'DB Migrator';

// Slight time-window tolerance (1 step before/after) for clock skew
authenticator.options = { window: 1 };

// Setup: generate fresh secret + otpauth URI + QR SVG (data URL).
async function setup(email) {
  const secret = authenticator.generateSecret();
  const uri = authenticator.keyuri(email, ISSUER, secret);
  const qrSvg = await QRCode.toString(uri, { type: 'svg', margin: 1, width: 200 });
  return {
    secret,                        // plain base32 — to show user once + embed in QR
    secretEnc: encrypt(secret),    // what gets stored in DB
    uri,                           // user can paste this into Authenticator
    qrSvg,                         // inline SVG <svg>...</svg>
  };
}

// Verify a 6-digit code against the stored (encrypted) secret.
function verify(code, secretEnc) {
  if (!code || !secretEnc) return false;
  let secret;
  try { secret = decrypt(secretEnc); }
  catch { return false; }
  if (!secret) return false;
  // otplib has timing-safe compare internally
  try { return authenticator.verify({ token: String(code).trim(), secret }); }
  catch { return false; }
}

// Generate a current TOTP code from a stored secret — for tests / admin recovery.
function currentCode(secretEnc) {
  if (!secretEnc) return null;
  const secret = decrypt(secretEnc);
  return secret ? authenticator.generate(secret) : null;
}

module.exports = { setup, verify, currentCode };
