// Symmetric encryption for storing DB passwords in scheduler.
//
// Key resolution:
//   1. process.env.SCHEDULE_KEY  (64-hex = 32 bytes; production should set this)
//   2. .schedule-key file in project root (auto-generated on first start; gitignored)
//
// Format of encrypted value: base64(iv[12] | tag[16] | ciphertext)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KEY_FILE = path.join(__dirname, '..', '.schedule-key');
let _key = null;

function loadKey() {
  if (_key) return _key;
  // 1. env override
  const fromEnv = process.env.SCHEDULE_KEY;
  if (fromEnv) {
    if (!/^[0-9a-f]{64}$/i.test(fromEnv)) {
      throw new Error('SCHEDULE_KEY must be 64 hex chars (32 bytes)');
    }
    _key = Buffer.from(fromEnv, 'hex');
    console.log('[encrypt] using SCHEDULE_KEY from env');
    return _key;
  }
  // 2. file (auto-generated if missing)
  if (fs.existsSync(KEY_FILE)) {
    const hex = fs.readFileSync(KEY_FILE, 'utf8').trim();
    if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error(`Invalid key in ${KEY_FILE}`);
    _key = Buffer.from(hex, 'hex');
    return _key;
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(KEY_FILE, key.toString('hex'), { mode: 0o600 });
  console.log(`[encrypt] generated new key at ${KEY_FILE} (keep it safe; don't commit)`);
  console.log('[encrypt] tip: set SCHEDULE_KEY env var in production to control key rotation');
  _key = key;
  return _key;
}

function encrypt(plaintext) {
  if (plaintext == null) return null;
  if (plaintext === '') return '';
  const key = loadKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

function decrypt(envelopeB64) {
  if (envelopeB64 == null) return null;
  if (envelopeB64 === '') return '';
  const key = loadKey();
  const buf = Buffer.from(envelopeB64, 'base64');
  if (buf.length < 12 + 16 + 1) throw new Error('Encrypted value too short');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}

module.exports = { encrypt, decrypt };
