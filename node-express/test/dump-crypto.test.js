// v2 Theme A Phase 1 tests — dump file 加密 / 解密 round-trip。
//
// 純函式 + tmp 檔測；不依賴 better-sqlite3 / express，全部跑得起來。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const dc = require('../lib/dump-crypto');

function tmpFile(suffix = '') {
  return path.join(os.tmpdir(), `dbm-crypto-test-${crypto.randomUUID()}${suffix}`);
}

// ============ buffer-level round-trip ============

test('encryptBuffer → decryptBuffer round-trip 還原原文', () => {
  const plain = Buffer.from('Hello, world! 你好世界 🎉');
  const enc = dc.encryptBuffer(plain, 'correcthorsebatterystaple');
  const got = dc.decryptBuffer(enc, 'correcthorsebatterystaple');
  assert.deepStrictEqual(got, plain);
});

test('encrypted buffer starts with MAGIC header', () => {
  const enc = dc.encryptBuffer(Buffer.from('x'), 'pw');
  assert.ok(enc.subarray(0, dc.MAGIC.length).equals(dc.MAGIC));
});

test('encrypted buffer length = magic + salt + iv + ct + tag', () => {
  const plain = Buffer.from('A'.repeat(100));
  const enc = dc.encryptBuffer(plain, 'pw');
  // header 36 + tag 16 + ciphertext (GCM 不擴張長度) = 152
  assert.strictEqual(enc.length, dc.HEADER_LEN + plain.length + dc.TAG_LEN);
});

test('每次加密 salt + iv 都不一樣（→ ciphertext 也不一樣）', () => {
  const plain = Buffer.from('same plaintext');
  const a = dc.encryptBuffer(plain, 'pw');
  const b = dc.encryptBuffer(plain, 'pw');
  // 同樣 magic
  assert.ok(a.subarray(0, dc.MAGIC.length).equals(b.subarray(0, dc.MAGIC.length)));
  // 但 salt+iv+ct 不同
  assert.ok(!a.subarray(dc.MAGIC.length).equals(b.subarray(dc.MAGIC.length)));
});

test('wrong password 應該 throw（GCM auth tag 不過）', () => {
  const enc = dc.encryptBuffer(Buffer.from('secret'), 'right-pw');
  assert.throws(() => dc.decryptBuffer(enc, 'wrong-pw'), /decryption failed/);
});

test('tampered ciphertext 應該 throw', () => {
  const enc = dc.encryptBuffer(Buffer.from('secret data'), 'pw');
  // 改最後一個 byte（auth tag）
  enc[enc.length - 1] ^= 0xff;
  assert.throws(() => dc.decryptBuffer(enc, 'pw'), /decryption failed/);
});

test('tampered IV 應該 throw', () => {
  const enc = dc.encryptBuffer(Buffer.from('secret'), 'pw');
  enc[dc.MAGIC.length + 16] ^= 0xff;   // 改 IV 第一個 byte
  assert.throws(() => dc.decryptBuffer(enc, 'pw'), /decryption failed/);
});

test('沒 magic 的 buffer 應該 throw', () => {
  const fake = Buffer.alloc(200);
  fake.write('NOTDBM01', 0, 'ascii');
  assert.throws(() => dc.decryptBuffer(fake, 'pw'), /missing magic header/);
});

test('太短 buffer 應該 throw', () => {
  assert.throws(() => dc.decryptBuffer(Buffer.alloc(10), 'pw'), /too short/);
});

test('empty password 應該 throw', () => {
  assert.throws(() => dc.encryptBuffer(Buffer.from('x'), ''), /non-empty/);
  assert.throws(() => dc.encryptBuffer(Buffer.from('x'), null), /non-empty/);
});

// ============ file-level round-trip ============

test('encryptFile + decryptFile round-trip', () => {
  const src = tmpFile('.sql');
  const enc = tmpFile('.sql.enc');
  const out = tmpFile('.sql');
  try {
    const data = Buffer.from('CREATE TABLE foo (id INT);\nINSERT INTO foo VALUES (1);');
    fs.writeFileSync(src, data);
    dc.encryptFile(src, enc, 'pw');
    dc.decryptFile(enc, out, 'pw');
    assert.deepStrictEqual(fs.readFileSync(out), data);
  } finally {
    [src, enc, out].forEach((p) => { try { fs.unlinkSync(p); } catch {} });
  }
});

test('isEncryptedFile detects encrypted vs plain', () => {
  const plainPath = tmpFile('.sql');
  const encPath = tmpFile('.enc');
  try {
    fs.writeFileSync(plainPath, 'CREATE TABLE x();');
    dc.encryptFile(plainPath, encPath, 'pw');
    assert.strictEqual(dc.isEncryptedFile(plainPath), false);
    assert.strictEqual(dc.isEncryptedFile(encPath), true);
  } finally {
    [plainPath, encPath].forEach((p) => { try { fs.unlinkSync(p); } catch {} });
  }
});

test('isEncryptedFile on missing file returns false (no throw)', () => {
  assert.strictEqual(dc.isEncryptedFile('/nonexistent/no-such.enc'), false);
});

test('isEncryptedBuffer 判斷對 magic / non-magic / 太短', () => {
  const enc = dc.encryptBuffer(Buffer.from('x'), 'pw');
  assert.strictEqual(dc.isEncryptedBuffer(enc), true);
  assert.strictEqual(dc.isEncryptedBuffer(Buffer.from('CREATE TABLE')), false);
  assert.strictEqual(dc.isEncryptedBuffer(Buffer.alloc(3)), false);
  assert.strictEqual(dc.isEncryptedBuffer('not a buffer'), false);
});

// ============ size variants — sanity test 各種 dump 規模 ============

test('round-trip works for empty payload', () => {
  const enc = dc.encryptBuffer(Buffer.alloc(0), 'pw');
  assert.deepStrictEqual(dc.decryptBuffer(enc, 'pw'), Buffer.alloc(0));
});

test('round-trip works for 1MB payload', () => {
  const plain = crypto.randomBytes(1024 * 1024);
  const enc = dc.encryptBuffer(plain, 'pw');
  assert.deepStrictEqual(dc.decryptBuffer(enc, 'pw'), plain);
});

test('round-trip works for binary (non-UTF8) payload', () => {
  const plain = crypto.randomBytes(512);
  const enc = dc.encryptBuffer(plain, 'pw');
  assert.deepStrictEqual(dc.decryptBuffer(enc, 'pw'), plain);
});

// ============ resolvePassword ============

test('resolvePassword: direct password takes priority', () => {
  process.env.__DBM_TEST_PW = 'env-pw';
  try {
    assert.strictEqual(
      dc.resolvePassword({ password: 'literal', passwordEnv: '__DBM_TEST_PW' }),
      'literal',
    );
  } finally { delete process.env.__DBM_TEST_PW; }
});

test('resolvePassword: env var fallback', () => {
  process.env.__DBM_TEST_PW = 'from-env';
  try {
    assert.strictEqual(dc.resolvePassword({ passwordEnv: '__DBM_TEST_PW' }), 'from-env');
  } finally { delete process.env.__DBM_TEST_PW; }
});

test('resolvePassword: missing env var throws with name', () => {
  delete process.env.__DBM_TEST_NOEXIST;
  assert.throws(
    () => dc.resolvePassword({ passwordEnv: '__DBM_TEST_NOEXIST' }),
    /__DBM_TEST_NOEXIST not set/,
  );
});

test('resolvePassword: nothing → null（呼叫端決定）', () => {
  assert.strictEqual(dc.resolvePassword(), null);
  assert.strictEqual(dc.resolvePassword({}), null);
});

// ============ key derivation 確定性 ============

test('deriveKey: same password + salt → same key（必要的 — restore 才能 work）', () => {
  const salt = Buffer.alloc(16, 0xab);
  const k1 = dc._internal.deriveKey('pw', salt);
  const k2 = dc._internal.deriveKey('pw', salt);
  assert.deepStrictEqual(k1, k2);
});

test('deriveKey: different salt → different key', () => {
  const k1 = dc._internal.deriveKey('pw', Buffer.alloc(16, 0x00));
  const k2 = dc._internal.deriveKey('pw', Buffer.alloc(16, 0xff));
  assert.ok(!k1.equals(k2));
});

test('deriveKey: different password → different key', () => {
  const salt = Buffer.alloc(16, 0xab);
  const k1 = dc._internal.deriveKey('pw-a', salt);
  const k2 = dc._internal.deriveKey('pw-b', salt);
  assert.ok(!k1.equals(k2));
});

// ============ streaming encrypt / decrypt (Phase 3) ============

test('encryptStream → decryptStream round-trip 還原原文', async () => {
  const src = tmpFile('.sql');
  const enc = tmpFile('.sql.enc');
  const out = tmpFile('.sql');
  try {
    const data = Buffer.from('CREATE TABLE foo (id INT);\nINSERT INTO foo VALUES (1);\n'.repeat(50));
    fs.writeFileSync(src, data);
    await dc.encryptStream(src, enc, 'pw');
    // output 應該是 valid DBMENC 檔
    assert.strictEqual(dc.isEncryptedFile(enc), true);
    await dc.decryptStream(enc, out, 'pw');
    assert.deepStrictEqual(fs.readFileSync(out), data);
  } finally {
    [src, enc, out].forEach((p) => { try { fs.unlinkSync(p); } catch {} });
  }
});

test('encryptStream 跟 encryptBuffer 互通：streaming encrypt → buffered decrypt', async () => {
  const src = tmpFile('.sql');
  const enc = tmpFile('.sql.enc');
  try {
    const data = Buffer.from('hello world');
    fs.writeFileSync(src, data);
    await dc.encryptStream(src, enc, 'pw');
    const decoded = dc.decryptBuffer(fs.readFileSync(enc), 'pw');
    assert.deepStrictEqual(decoded, data);
  } finally {
    [src, enc].forEach((p) => { try { fs.unlinkSync(p); } catch {} });
  }
});

test('encryptBuffer → decryptStream 互通', async () => {
  const enc = tmpFile('.enc');
  const out = tmpFile('.sql');
  try {
    const data = Buffer.from('symmetric format check');
    fs.writeFileSync(enc, dc.encryptBuffer(data, 'pw'));
    await dc.decryptStream(enc, out, 'pw');
    assert.deepStrictEqual(fs.readFileSync(out), data);
  } finally {
    [enc, out].forEach((p) => { try { fs.unlinkSync(p); } catch {} });
  }
});

test('encryptStream: 8MB payload (>>64KB chunk size 確認 multi-chunk path)', async () => {
  const src = tmpFile('.sql');
  const enc = tmpFile('.sql.enc');
  const out = tmpFile('.sql');
  try {
    const data = crypto.randomBytes(8 * 1024 * 1024);
    fs.writeFileSync(src, data);
    await dc.encryptStream(src, enc, 'pw');
    await dc.decryptStream(enc, out, 'pw');
    assert.deepStrictEqual(fs.readFileSync(out), data);
  } finally {
    [src, enc, out].forEach((p) => { try { fs.unlinkSync(p); } catch {} });
  }
});

test('encryptStream: empty file round-trip', async () => {
  const src = tmpFile('.sql');
  const enc = tmpFile('.sql.enc');
  const out = tmpFile('.sql');
  try {
    fs.writeFileSync(src, Buffer.alloc(0));
    await dc.encryptStream(src, enc, 'pw');
    // 即使 input 空，output 還是該有 header + tag (52 bytes)
    assert.strictEqual(fs.statSync(enc).size, dc.HEADER_LEN + dc.TAG_LEN);
    await dc.decryptStream(enc, out, 'pw');
    assert.strictEqual(fs.statSync(out).size, 0);
  } finally {
    [src, enc, out].forEach((p) => { try { fs.unlinkSync(p); } catch {} });
  }
});

test('decryptStream: wrong password → throw + 砍掉半成品 destPath', async () => {
  const src = tmpFile('.sql');
  const enc = tmpFile('.sql.enc');
  const out = tmpFile('.sql');
  try {
    fs.writeFileSync(src, Buffer.from('data'));
    await dc.encryptStream(src, enc, 'right-pw');
    await assert.rejects(dc.decryptStream(enc, out, 'wrong-pw'), /decryption failed/);
    // dest 不該存在（pipeline failure 已 cleanup）
    assert.strictEqual(fs.existsSync(out), false);
  } finally {
    [src, enc, out].forEach((p) => { try { fs.unlinkSync(p); } catch {} });
  }
});

test('decryptStream: tampered tail bytes → throw', async () => {
  const src = tmpFile('.sql');
  const enc = tmpFile('.sql.enc');
  const out = tmpFile('.sql');
  try {
    fs.writeFileSync(src, crypto.randomBytes(1024));
    await dc.encryptStream(src, enc, 'pw');
    // 改最後一個 byte (auth tag)
    const corrupted = fs.readFileSync(enc);
    corrupted[corrupted.length - 1] ^= 0xff;
    fs.writeFileSync(enc, corrupted);
    await assert.rejects(dc.decryptStream(enc, out, 'pw'), /decryption failed/);
  } finally {
    [src, enc, out].forEach((p) => { try { fs.unlinkSync(p); } catch {} });
  }
});

test('decryptStream: missing magic → throw', async () => {
  const enc = tmpFile('.enc');
  const out = tmpFile('.sql');
  try {
    fs.writeFileSync(enc, Buffer.concat([Buffer.from('NOTDBM01'), Buffer.alloc(100)]));
    await assert.rejects(dc.decryptStream(enc, out, 'pw'), /missing magic header/);
  } finally {
    [enc, out].forEach((p) => { try { fs.unlinkSync(p); } catch {} });
  }
});

test('decryptStream: truncated (less than HEADER+TAG) → throw', async () => {
  const enc = tmpFile('.enc');
  const out = tmpFile('.sql');
  try {
    fs.writeFileSync(enc, dc.MAGIC);   // 只有 magic，後面什麼都沒有
    await assert.rejects(dc.decryptStream(enc, out, 'pw'), /too short|truncated/);
  } finally {
    [enc, out].forEach((p) => { try { fs.unlinkSync(p); } catch {} });
  }
});

test('encryptStream: empty password throws', async () => {
  const src = tmpFile('.sql');
  try {
    fs.writeFileSync(src, 'x');
    await assert.rejects(dc.encryptStream(src, tmpFile('.enc'), ''), /non-empty/);
  } finally { try { fs.unlinkSync(src); } catch {} }
});
