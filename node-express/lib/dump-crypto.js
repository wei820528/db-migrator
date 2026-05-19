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
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');

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

// ============ streaming variants (Theme A Phase 3) ============
//
// 為什麼要 streaming：buffered encryptFile 一律 readFileSync 全檔 → RAM 是上限。
// 100GB DB dump 直接炸。streaming 版每次只 process 64KB chunk，RAM O(1)。
//
// 加密 transform：
//   先吐 [magic | salt | iv] header
//   每個 chunk 走 cipher.update → 吐密文
//   flush 時吐 cipher.final() + auth tag (16B)
function _encryptTransform(password) {
  const salt = crypto.randomBytes(SALT_LEN);
  const iv   = crypto.randomBytes(IV_LEN);
  const key  = deriveKey(password, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let headerWritten = false;
  return new Transform({
    transform(chunk, _enc, cb) {
      try {
        if (!headerWritten) {
          this.push(MAGIC);
          this.push(salt);
          this.push(iv);
          headerWritten = true;
        }
        cb(null, cipher.update(chunk));
      } catch (e) { cb(e); }
    },
    flush(cb) {
      try {
        // 空檔 edge case — header 也要寫
        if (!headerWritten) {
          this.push(MAGIC); this.push(salt); this.push(iv);
          headerWritten = true;
        }
        const final = cipher.final();
        if (final.length) this.push(final);
        this.push(cipher.getAuthTag());
        cb();
      } catch (e) { cb(e); }
    },
  });
}

async function encryptStream(srcPath, destPath, password) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('dump password must be a non-empty string');
  }
  const tx = _encryptTransform(password);
  try {
    await pipeline(
      fs.createReadStream(srcPath),
      tx,
      fs.createWriteStream(destPath),
    );
  } catch (e) {
    // 不留半成品；下游可能 retry
    try { fs.unlinkSync(destPath); } catch {}
    throw e;
  }
}

// 解密 transform：
//   先吃 HEADER_LEN bytes 拿 magic / salt / iv → 初始化 decipher
//   後續一律「滾動保留尾端 TAG_LEN bytes」— 因為直到流結束才能確定哪 16B 是 tag
//   flush 時把保留的 16B 設成 authTag 再 decipher.final()
function _decryptTransform(password) {
  let headerBuf = Buffer.alloc(0);
  let tail = Buffer.alloc(0);         // 保留尾端 (最多 TAG_LEN) 給 setAuthTag
  let decipher = null;

  return new Transform({
    transform(chunk, _enc, cb) {
      try {
        // 還沒湊滿 header — 先 buffer
        if (!decipher) {
          headerBuf = Buffer.concat([headerBuf, chunk]);
          if (headerBuf.length < HEADER_LEN) return cb();
          // 抓 header + 初始化
          if (!headerBuf.subarray(0, MAGIC.length).equals(MAGIC)) {
            return cb(new Error('not a DBMENC encrypted dump (missing magic header)'));
          }
          const salt = headerBuf.subarray(MAGIC.length, MAGIC.length + SALT_LEN);
          const iv   = headerBuf.subarray(MAGIC.length + SALT_LEN, HEADER_LEN);
          const key  = deriveKey(password, salt);
          decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
          chunk = headerBuf.subarray(HEADER_LEN);
          headerBuf = null;
          if (chunk.length === 0) return cb();
        }

        // 把 chunk 加進 tail buffer，然後從前段切出可以放心 decrypt 的部分
        const combined = Buffer.concat([tail, chunk]);
        if (combined.length <= TAG_LEN) {
          // 還無法保證哪 16B 是 tag，整段先保留
          tail = combined;
          return cb();
        }
        const safeLen = combined.length - TAG_LEN;
        const safe = combined.subarray(0, safeLen);
        tail = combined.subarray(safeLen);
        cb(null, decipher.update(safe));
      } catch (e) { cb(e); }
    },
    flush(cb) {
      try {
        if (!decipher) {
          return cb(new Error('encrypted dump file too short / not a DBMENC file'));
        }
        if (tail.length !== TAG_LEN) {
          return cb(new Error('encrypted dump truncated — expected 16-byte auth tag at end'));
        }
        decipher.setAuthTag(tail);
        try {
          const final = decipher.final();
          if (final.length) this.push(final);
          cb();
        } catch {
          cb(new Error('decryption failed — wrong password or corrupted file'));
        }
      } catch (e) { cb(e); }
    },
  });
}

async function decryptStream(srcPath, destPath, password) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('dump password must be a non-empty string');
  }
  const tx = _decryptTransform(password);
  try {
    await pipeline(
      fs.createReadStream(srcPath),
      tx,
      fs.createWriteStream(destPath),
    );
  } catch (e) {
    try { fs.unlinkSync(destPath); } catch {}
    throw e;
  }
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
  encryptStream,
  decryptStream,
  resolvePassword,
  _internal: { deriveKey, _encryptTransform, _decryptTransform },
};
