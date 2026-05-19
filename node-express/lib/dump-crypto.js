// Dump 檔加密 (Theme A Phase 1) — 跟 schedule key 不一樣：
// schedule key 是 server-managed 32-byte hex（自家用），這邊是 user-supplied
// password，scrypt KDF 衍生 key，把 dump 整檔 AES-256-GCM 加密。
//
// 為什麼 scrypt 而不直接拿 password 當 key：password 通常熵不夠（人選的），KDF
// 讓 brute-force 變貴。N=2^14 是 Node 預設，wifi 隨身碟級別足夠。
//
// 為什麼整檔讀完再加密而不 streaming：dump 通常 <100MB（streaming / chunked 是
// Theme A Phase 2 的事）；GCM 整檔最簡單也避免 chunked GCM 自己切 nonce 的雷區。
//
// File format（all little-endian byte order）:
//   [8 bytes  magic         "DBMENC01"  (ASCII)]
//   [16 bytes salt          random / unique per file]
//   [12 bytes nonce/iv      random / unique per file]
//   [N bytes  ciphertext]
//   [16 bytes auth tag      GCM tag, validates header+salt+iv+ciphertext implicitly via key]
//
// Total overhead: 52 bytes per file，相對 dump 大小可忽略。

const fs = require('fs');
const crypto = require('crypto');

const MAGIC = Buffer.from('DBMENC01', 'ascii');   // 8 bytes
const SALT_LEN  = 16;
const IV_LEN    = 12;
const TAG_LEN   = 16;
const HEADER_LEN = MAGIC.length + SALT_LEN + IV_LEN;   // 36
const SCRYPT_N = 16384;                            // 2^14；Node 預設
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN  = 32;                               // AES-256

function deriveKey(password, salt) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('dump password must be a non-empty string');
  }
  return crypto.scryptSync(password, salt, KEY_LEN, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P,
    maxmem: 64 * 1024 * 1024,   // 64MB cap；scryptSync 預設 32MB 對 N=16384 有時不夠
  });
}

// 給定路徑判斷檔頭是否是我們的 magic。Read 8 bytes — 不用 readFileSync。
function isEncryptedFile(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(MAGIC.length);
    const n = fs.readSync(fd, buf, 0, MAGIC.length, 0);
    return n === MAGIC.length && buf.equals(MAGIC);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

// 從 Buffer / string buffer 也能判斷（給 inspect 流程用，避免重讀檔）
function isEncryptedBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < MAGIC.length) return false;
  return buf.subarray(0, MAGIC.length).equals(MAGIC);
}

// 加密：plain → enc。In-place 不允許（避免半成品破壞 source）— 一律寫 destPath。
function encryptFile(srcPath, destPath, password) {
  const plain = fs.readFileSync(srcPath);
  const enc = encryptBuffer(plain, password);
  fs.writeFileSync(destPath, enc);
}

// Buffer-level 加密；export.js / CLI 都用得到
function encryptBuffer(plainBuf, password) {
  if (!Buffer.isBuffer(plainBuf)) plainBuf = Buffer.from(plainBuf);
  const salt = crypto.randomBytes(SALT_LEN);
  const iv   = crypto.randomBytes(IV_LEN);
  const key  = deriveKey(password, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plainBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, salt, iv, ct, tag]);
}

// 解密：enc → plain。檔頭驗 magic，沒過直接 throw（避免靜默亂解）
function decryptFile(srcPath, destPath, password) {
  const enc = fs.readFileSync(srcPath);
  const plain = decryptBuffer(enc, password);
  fs.writeFileSync(destPath, plain);
}

function decryptBuffer(encBuf, password) {
  if (!Buffer.isBuffer(encBuf)) encBuf = Buffer.from(encBuf);
  if (encBuf.length < HEADER_LEN + TAG_LEN) {
    throw new Error('encrypted dump file too short / not a DBMENC file');
  }
  if (!encBuf.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('not a DBMENC encrypted dump (missing magic header)');
  }
  const salt = encBuf.subarray(MAGIC.length, MAGIC.length + SALT_LEN);
  const iv   = encBuf.subarray(MAGIC.length + SALT_LEN, HEADER_LEN);
  const tag  = encBuf.subarray(encBuf.length - TAG_LEN);
  const ct   = encBuf.subarray(HEADER_LEN, encBuf.length - TAG_LEN);
  const key  = deriveKey(password, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch (e) {
    // GCM auth tag fail 一律 throw 同一句，避免 oracle 攻擊
    throw new Error('decryption failed — wrong password or corrupted file');
  }
}

// Helper：從多種來源解析 password（CLI / route 用）
//   1. 直接傳 password string
//   2. envVar 名稱（推薦 — 不會落 shell history）
//   3. 都沒有 → 回 null（呼叫端決定 throw 或不加密）
function resolvePassword({ password, passwordEnv } = {}) {
  if (password != null && password !== '') return String(password);
  if (passwordEnv) {
    const v = process.env[passwordEnv];
    if (v == null || v === '') {
      throw new Error(`env var ${passwordEnv} not set or empty`);
    }
    return v;
  }
  return null;
}

module.exports = {
  MAGIC,
  HEADER_LEN,
  TAG_LEN,
  isEncryptedFile,
  isEncryptedBuffer,
  encryptFile,
  encryptBuffer,
  decryptFile,
  decryptBuffer,
  resolvePassword,
  _internal: { deriveKey },
};
