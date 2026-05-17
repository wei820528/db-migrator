// Tests for lib/encrypt.js — AES-256-GCM round-trip.
const { test, describe, before } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

// Use a fixed test key via env, so test doesn't write to project .schedule-key
process.env.SCHEDULE_KEY = '0'.repeat(64);

const enc = require('../lib/encrypt');

describe('encrypt / decrypt', () => {
  test('round-trip plain string', () => {
    const ct = enc.encrypt('hello world');
    assert.ok(ct && ct.length > 20);
    assert.strictEqual(enc.decrypt(ct), 'hello world');
  });
  test('round-trip unicode', () => {
    const ct = enc.encrypt('密碼 🔑 PASS!');
    assert.strictEqual(enc.decrypt(ct), '密碼 🔑 PASS!');
  });
  test('null in / out', () => {
    assert.strictEqual(enc.encrypt(null), null);
    assert.strictEqual(enc.decrypt(null), null);
  });
  test('empty string passes through', () => {
    assert.strictEqual(enc.encrypt(''), '');
    assert.strictEqual(enc.decrypt(''), '');
  });
  test('tampered ciphertext throws', () => {
    const ct = enc.encrypt('secret');
    // Flip a bit in the last char of base64
    const tampered = ct.slice(0, -2) + (ct.slice(-2, -1) === 'A' ? 'B' : 'A') + ct.slice(-1);
    assert.throws(() => enc.decrypt(tampered));
  });
  test('two encrypts of same value differ (IV randomness)', () => {
    const a = enc.encrypt('same');
    const b = enc.encrypt('same');
    assert.notStrictEqual(a, b);
    assert.strictEqual(enc.decrypt(a), enc.decrypt(b));
  });
});

describe('invalid key', () => {
  test('non-hex SCHEDULE_KEY throws on use', () => {
    // Need a fresh module instance to re-read env. Use a child process.
    const { spawnSync } = require('node:child_process');
    const r = spawnSync(process.execPath, [
      '-e',
      `process.env.SCHEDULE_KEY = 'not-hex'; try { require('${path.resolve(__dirname, '../lib/encrypt')}').encrypt('x'); console.log('NOTHROW'); } catch (e) { console.log('THROW:' + e.message); }`,
    ], { encoding: 'utf8' });
    assert.ok(r.stdout.includes('THROW:'), `expected throw, got: ${r.stdout} / ${r.stderr}`);
  });
});
