// Tests for lib/ecpay.js — URL encoder + CheckMacValue invariants.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const ec = require('../lib/ecpay');

describe('ecpayUrlEncode', () => {
  test('space → +', () => {
    assert.strictEqual(ec.ecpayUrlEncode('hello world'), 'hello+world');
  });
  test('lowercase hex', () => {
    // 中 = e4 b8 ad (utf-8) — should be %e4%b8%ad, not %E4%B8%AD
    assert.strictEqual(ec.ecpayUrlEncode('中'), '%e4%b8%ad');
  });
  test('preserves unencoded chars: - _ . ! * ( ) \'', () => {
    assert.strictEqual(ec.ecpayUrlEncode("-_.!*()'"), "-_.!*()'");
  });
  test('encodes &, =, +, /, ?', () => {
    assert.strictEqual(ec.ecpayUrlEncode('a&b=c+d/e?f'), 'a%26b%3dc%2bd%2fe%3ff');
  });
  test('Chinese trade desc', () => {
    const r = ec.ecpayUrlEncode('促銷方案');
    assert.ok(r.startsWith('%'));
    assert.ok(/^[%0-9a-f]+$/.test(r), 'all hex should be lowercase');
  });
});

describe('checkMacValue', () => {
  const HK = 'spPjZn66i0OhqJsQ';   // ECPay public test key
  const HI = 'hT5OJckN45isQTTs';

  test('deterministic — same input → same hash', () => {
    const params = { MerchantID: 'X', TotalAmount: '100' };
    const a = ec.checkMacValue(params, HK, HI);
    const b = ec.checkMacValue(params, HK, HI);
    assert.strictEqual(a, b);
  });
  test('SHA256 hex = 64 chars uppercase', () => {
    const params = { MerchantID: 'X', TotalAmount: '100' };
    const mac = ec.checkMacValue(params, HK, HI);
    assert.strictEqual(mac.length, 64);
    assert.strictEqual(mac, mac.toUpperCase());
    assert.ok(/^[0-9A-F]+$/.test(mac));
  });
  test('different params → different hash', () => {
    const a = ec.checkMacValue({ MerchantID: 'X', TotalAmount: '100' }, HK, HI);
    const b = ec.checkMacValue({ MerchantID: 'X', TotalAmount: '200' }, HK, HI);
    assert.notStrictEqual(a, b);
  });
  test('different key → different hash', () => {
    const params = { MerchantID: 'X', TotalAmount: '100' };
    const a = ec.checkMacValue(params, HK, HI);
    const b = ec.checkMacValue(params, 'OTHER_KEY', HI);
    assert.notStrictEqual(a, b);
  });
  test('case-insensitive key ordering produces stable hash', () => {
    // Same params, different declaration order — should hash the same
    const a = ec.checkMacValue({ MerchantID: 'X', TotalAmount: '100' }, HK, HI);
    const b = ec.checkMacValue({ TotalAmount: '100', MerchantID: 'X' }, HK, HI);
    assert.strictEqual(a, b);
  });
  test('CheckMacValue field is excluded from its own computation', () => {
    const a = ec.checkMacValue({ MerchantID: 'X', TotalAmount: '100' }, HK, HI);
    const b = ec.checkMacValue({ MerchantID: 'X', TotalAmount: '100', CheckMacValue: 'should-be-ignored' }, HK, HI);
    assert.strictEqual(a, b);
  });
});

describe('verifyReturn', () => {
  // Need env to run; otherwise skip
  const origMerch = process.env.ECPAY_MERCHANT_ID;
  const origKey = process.env.ECPAY_HASH_KEY;
  const origIv = process.env.ECPAY_HASH_IV;
  process.env.ECPAY_MERCHANT_ID = '3002599';
  process.env.ECPAY_HASH_KEY = 'spPjZn66i0OhqJsQ';
  process.env.ECPAY_HASH_IV = 'hT5OJckN45isQTTs';

  test('verifies a payload signed with the same key', () => {
    const params = { MerchantID: '3002599', RtnCode: '1', TotalAmount: '100', TradeAmt: '100', MerchantTradeNo: 'T123' };
    params.CheckMacValue = ec.checkMacValue(params, 'spPjZn66i0OhqJsQ', 'hT5OJckN45isQTTs');
    assert.strictEqual(ec.verifyReturn(params), true);
  });
  test('rejects payload with wrong mac', () => {
    const params = { MerchantID: '3002599', RtnCode: '1', TotalAmount: '100', CheckMacValue: 'BADHASH' };
    assert.strictEqual(ec.verifyReturn(params), false);
  });
  test('rejects payload with no mac', () => {
    assert.strictEqual(ec.verifyReturn({ MerchantID: 'X' }), false);
  });

  // Restore env after suite
  process.on('exit', () => {
    if (origMerch === undefined) delete process.env.ECPAY_MERCHANT_ID; else process.env.ECPAY_MERCHANT_ID = origMerch;
    if (origKey === undefined) delete process.env.ECPAY_HASH_KEY; else process.env.ECPAY_HASH_KEY = origKey;
    if (origIv === undefined) delete process.env.ECPAY_HASH_IV; else process.env.ECPAY_HASH_IV = origIv;
  });
});

describe('formatTradeDate', () => {
  test('formats as yyyy/MM/dd HH:mm:ss', () => {
    const d = new Date(2026, 4, 16, 14, 30, 45);   // local time
    assert.strictEqual(ec.formatTradeDate(d), '2026/05/16 14:30:45');
  });
});
