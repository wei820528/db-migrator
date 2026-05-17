// Tests for plans.js — plan definitions integrity.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { PLANS, getPlan, freeOverridePlan } = require('../plans');

describe('plans', () => {
  test('all 4 plans defined', () => {
    for (const k of ['trial', 'basic', 'team', 'enterprise']) {
      assert.ok(PLANS[k], `plan ${k} missing`);
    }
  });
  test('each plan has features object', () => {
    for (const [k, v] of Object.entries(PLANS)) {
      assert.ok(v.features, `plan ${k} missing features`);
      assert.ok(typeof v.max_devices === 'number', `plan ${k} missing max_devices`);
    }
  });
  test('trial is restricted', () => {
    assert.strictEqual(PLANS.trial.features.bulk_export, false);
    assert.strictEqual(PLANS.trial.features.project_backup, false);
    assert.strictEqual(PLANS.trial.max_devices, 1);
    assert.strictEqual(PLANS.trial.duration_days, 7);
  });
  test('higher tiers unlock features', () => {
    assert.strictEqual(PLANS.basic.features.bulk_export, true);
    assert.strictEqual(PLANS.team.features.bulk_export, true);
    assert.strictEqual(PLANS.enterprise.features.bulk_export, true);
  });
  test('max_devices ascends', () => {
    assert.ok(PLANS.basic.max_devices <= PLANS.team.max_devices);
    assert.ok(PLANS.team.max_devices <= PLANS.enterprise.max_devices);
  });
});

describe('getPlan', () => {
  test('known plan', () => {
    assert.strictEqual(getPlan('team'), PLANS.team);
  });
  test('unknown plan → trial fallback', () => {
    assert.strictEqual(getPlan('unknown'), PLANS.trial);
    assert.strictEqual(getPlan(null), PLANS.trial);
  });
});

describe('freeOverridePlan', () => {
  test('returns team-equivalent', () => {
    const p = freeOverridePlan();
    assert.strictEqual(p.features.bulk_export, true);
    assert.strictEqual(p.features.project_backup, true);
  });
});
