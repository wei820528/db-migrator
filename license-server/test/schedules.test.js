// Tests for lib/schedules.js — expression parser.
// (Skips itself if better-sqlite3 isn't installed, since the module opens a DB on load.)
const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

const TEST_DB = path.join(os.tmpdir(), `test-schedules-${process.pid}-${Date.now()}.db`);
process.env.SCHEDULES_DB = TEST_DB;
process.env.SCHEDULE_KEY = '0'.repeat(64);

let sch;
try { sch = require('../lib/schedules'); }
catch (e) {
  console.log('[skip] schedules tests — better-sqlite3 missing:', e.message);
}

if (sch) {
  describe('parseExpression', () => {
    test('every N minutes', () => {
      assert.deepStrictEqual(sch.parseExpression('every 30 minutes'), { type: 'every', ms: 30 * 60 * 1000 });
    });
    test('every N hours', () => {
      assert.deepStrictEqual(sch.parseExpression('every 6 hours'), { type: 'every', ms: 6 * 60 * 60 * 1000 });
    });
    test('every N days', () => {
      assert.deepStrictEqual(sch.parseExpression('every 2 days'), { type: 'every', ms: 2 * 24 * 60 * 60 * 1000 });
    });
    test('daily at HH:MM', () => {
      assert.deepStrictEqual(sch.parseExpression('daily at 02:00'), { type: 'daily', hh: 2, mm: 0 });
      assert.deepStrictEqual(sch.parseExpression('daily at 23:59'), { type: 'daily', hh: 23, mm: 59 });
    });
    test('rejects unknown', () => {
      assert.throws(() => sch.parseExpression('weird'));
      assert.throws(() => sch.parseExpression(''));
    });
  });

  describe('nextRunAfter', () => {
    test('every 30 minutes adds 30 min', () => {
      const now = Date.UTC(2026, 4, 16, 12, 0, 0);
      assert.strictEqual(sch.nextRunAfter(now, 'every 30 minutes'), now + 30 * 60 * 1000);
    });
    test('daily at HH:MM lands on next occurrence (local time)', () => {
      // Hard to test absolute values due to local TZ, just verify next > now
      const now = Date.now();
      const next = sch.nextRunAfter(now, 'daily at 02:00');
      assert.ok(next > now, 'next run must be in the future');
      assert.ok(next - now < 25 * 60 * 60 * 1000, 'within 25h window');
    });
  });

  // Cleanup
  process.on('exit', () => {
    try { fs.unlinkSync(TEST_DB); } catch {}
    try { fs.unlinkSync(TEST_DB + '-shm'); } catch {}
    try { fs.unlinkSync(TEST_DB + '-wal'); } catch {}
  });
}
