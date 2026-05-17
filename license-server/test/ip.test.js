// Tests for lib/ip.js — IP whitelist matching.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const ip = require('../lib/ip');

describe('checkAllowed', () => {
  test('null / empty whitelist allows all', () => {
    assert.strictEqual(ip.checkAllowed(null, '1.2.3.4').allowed, true);
    assert.strictEqual(ip.checkAllowed('[]', '1.2.3.4').allowed, true);
  });
  test('exact IP match', () => {
    assert.strictEqual(ip.checkAllowed(JSON.stringify(['1.2.3.4']), '1.2.3.4').allowed, true);
    assert.strictEqual(ip.checkAllowed(JSON.stringify(['1.2.3.4']), '1.2.3.5').allowed, false);
  });
  test('CIDR /24 match', () => {
    const wl = JSON.stringify(['10.0.0.0/24']);
    assert.strictEqual(ip.checkAllowed(wl, '10.0.0.99').allowed, true);
    assert.strictEqual(ip.checkAllowed(wl, '10.0.1.0').allowed, false);
  });
  test('CIDR /8 match', () => {
    const wl = JSON.stringify(['10.0.0.0/8']);
    assert.strictEqual(ip.checkAllowed(wl, '10.255.255.255').allowed, true);
    assert.strictEqual(ip.checkAllowed(wl, '11.0.0.0').allowed, false);
  });
  test('CIDR /32 = exact', () => {
    assert.strictEqual(ip.checkAllowed(JSON.stringify(['5.6.7.8/32']), '5.6.7.8').allowed, true);
    assert.strictEqual(ip.checkAllowed(JSON.stringify(['5.6.7.8/32']), '5.6.7.9').allowed, false);
  });
  test('wildcard pattern', () => {
    const wl = JSON.stringify(['192.168.*']);
    assert.strictEqual(ip.checkAllowed(wl, '192.168.1.100').allowed, true);
    assert.strictEqual(ip.checkAllowed(wl, '10.0.0.1').allowed, false);
  });
  test('* matches anything', () => {
    assert.strictEqual(ip.checkAllowed(JSON.stringify(['*']), '99.99.99.99').allowed, true);
  });
  test('multiple rules — OR', () => {
    const wl = JSON.stringify(['10.0.0.0/8', '203.0.113.7']);
    assert.strictEqual(ip.checkAllowed(wl, '10.5.5.5').allowed, true);
    assert.strictEqual(ip.checkAllowed(wl, '203.0.113.7').allowed, true);
    assert.strictEqual(ip.checkAllowed(wl, '8.8.8.8').allowed, false);
  });
  test('reason explains rejection', () => {
    const r = ip.checkAllowed(JSON.stringify(['10.0.0.0/8']), '1.1.1.1');
    assert.strictEqual(r.allowed, false);
    assert.ok(r.reason.includes('1.1.1.1'));
  });
  test('malformed input returns no match (false)', () => {
    assert.strictEqual(ip.checkAllowed(JSON.stringify(['not-an-ip']), '1.2.3.4').allowed, false);
    assert.strictEqual(ip.checkAllowed('not json', '1.2.3.4').allowed, true);  // empty list = allow
  });
});
