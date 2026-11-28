const { test } = require('node:test');
const assert = require('node:assert');
const { TIER_ORDER } = require('../lib/config');
const { getMemberTier } = require('../lib/subscriber-tier');

const PLUS = '200000000000000001';
const PLUS_PLUS = '200000000000000002';
const SUPER = '200000000000000003';

// Built here rather than from config, so the suite does not depend on a developer's .env.
const TIER_ROLE_IDS = {
    vicerPlus: PLUS,
    vicerPlusPlus: PLUS_PLUS,
    superVicer: SUPER
};

function memberWith(...roleIds) {
    return { roles: { cache: new Set(roleIds) } };
}

test('TIER_ORDER runs lowest to highest', () => {
    assert.deepStrictEqual(TIER_ORDER, ['vicerPlus', 'vicerPlusPlus', 'superVicer']);
});

test('returns null when tierRoleIds is undefined', () => {
    assert.strictEqual(getMemberTier(memberWith(PLUS), undefined), null);
});

test('returns null when the member holds none of the configured tier roles', () => {
    assert.strictEqual(getMemberTier(memberWith('300000000000000001'), TIER_ROLE_IDS), null);
});

test('returns the matching tier when the member holds one tier role', () => {
    assert.strictEqual(getMemberTier(memberWith(PLUS_PLUS), TIER_ROLE_IDS), 'vicerPlusPlus');
});

test('returns the highest tier by TIER_ORDER when the member holds two', () => {
    assert.strictEqual(getMemberTier(memberWith(SUPER, PLUS), TIER_ROLE_IDS), 'superVicer');
    assert.strictEqual(getMemberTier(memberWith(PLUS, PLUS_PLUS), TIER_ROLE_IDS), 'vicerPlusPlus');
});

test('ignores a tier whose role ID is unset', () => {
    const partial = { vicerPlus: PLUS, vicerPlusPlus: undefined, superVicer: SUPER };
    // A member holding a role that happens to be undefined must not match the unset tier.
    assert.strictEqual(getMemberTier(memberWith(PLUS, undefined), partial), 'vicerPlus');
    assert.strictEqual(getMemberTier(memberWith(undefined), partial), null);
});
