// Tests for lib/totp.js — TOTP setup + verify.
// Skips if otplib not installed.
const { test, describe } = require('node:test');
const assert = require('node:assert');

process.env.SCHEDULE_KEY = '0'.repeat(64);  // for the encrypt module under the hood

let totp;
try { totp = require('../lib/totp'); }
catch (e) { console.log('[skip] totp tests — otplib missing:', e.message); }

if (totp) {
  describe('setup', () => {
    test('returns secret, uri, qrSvg', async () => {
      const r = await totp.setup('user@example.com');
      assert.ok(r.secret && r.secret.length >= 16);
      assert.ok(r.secretEnc && r.secretEnc.length > 20);   // encrypted is longer
      assert.ok(r.uri.startsWith('otpauth://totp/'));
      assert.ok(r.uri.includes(encodeURIComponent('user@example.com')) || r.uri.includes('user%40example.com'));
      assert.ok(r.qrSvg.startsWith('<svg'));
    });
    test('two setups produce different secrets', async () => {
      const a = await totp.setup('a@example.com');
      const b = await totp.setup('a@example.com');
      assert.notStrictEqual(a.secret, b.secret);
    });
  });

  describe('verify', () => {
    test('current code verifies', async () => {
      const r = await totp.setup('test@x.com');
      const code = totp.currentCode(r.secretEnc);
      assert.ok(code && /^\d{6}$/.test(code));
      assert.strictEqual(totp.verify(code, r.secretEnc), true);
    });
    test('wrong code rejected', async () => {
      const r = await totp.setup('test@x.com');
      assert.strictEqual(totp.verify('000000', r.secretEnc), false);
      assert.strictEqual(totp.verify('123456', r.secretEnc), false);
    });
    test('null / empty inputs → false (no throw)', async () => {
      const r = await totp.setup('test@x.com');
      assert.strictEqual(totp.verify(null, r.secretEnc), false);
      assert.strictEqual(totp.verify('123456', null), false);
      assert.strictEqual(totp.verify('', r.secretEnc), false);
    });
    test('tampered secret rejected (no throw)', async () => {
      const r = await totp.setup('test@x.com');
      const code = totp.currentCode(r.secretEnc);
      // Corrupt the encrypted envelope
      const tamp = r.secretEnc.slice(0, -2) + (r.secretEnc.slice(-2, -1) === 'A' ? 'B' : 'A') + r.secretEnc.slice(-1);
      assert.strictEqual(totp.verify(code, tamp), false);
    });
  });
}
