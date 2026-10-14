const { test } = require('node:test');
const assert = require('node:assert');
const { reminderAction } = require('../lib/lobby/stages');

const MIN = 60 * 1000;
const REMIND = 60; // minutes

// `lead` is how far ahead of start the lobby was created.
function lobby({ startsIn, lead = 180, reminded = false }) {
    const now = 1_000_000_000_000;
    const startsAt = now + startsIn * MIN;

    return {
        now,
        lobby: { startsAt, createdAt: startsAt - lead * MIN, stages: { reminded } }
    };
}

test('too early: wait', () => {
    const { lobby: l, now } = lobby({ startsIn: 120 });
    assert.equal(reminderAction(l, now, REMIND), 'wait');
});

test('just outside the window: still wait', () => {
    const { lobby: l, now } = lobby({ startsIn: 61 });
    assert.equal(reminderAction(l, now, REMIND), 'wait');
});

test('exactly at the window boundary: post', () => {
    const { lobby: l, now } = lobby({ startsIn: 60 });
    assert.equal(reminderAction(l, now, REMIND), 'post');
});

test('inside the window: post', () => {
    const { lobby: l, now } = lobby({ startsIn: 30 });
    assert.equal(reminderAction(l, now, REMIND), 'post');
});

test('one minute before start: post', () => {
    const { lobby: l, now } = lobby({ startsIn: 1 });
    assert.equal(reminderAction(l, now, REMIND), 'post');
});

test('at the start time: skip, because a reminder then is noise', () => {
    const { lobby: l, now } = lobby({ startsIn: 0 });
    assert.equal(reminderAction(l, now, REMIND), 'skip');
});

test('after the start (bot was down): skip, never post late', () => {
    const { lobby: l, now } = lobby({ startsIn: -45 });
    assert.equal(reminderAction(l, now, REMIND), 'skip');
});

test('short lead: a lobby booked inside the window gets no reminder', () => {
    // Created 40 minutes before start, which is inside the 60-minute window.
    const { lobby: l, now } = lobby({ startsIn: 40, lead: 40 });
    assert.equal(reminderAction(l, now, REMIND), 'skip');
});

test('short lead at the boundary: a 60-minute lead does get one', () => {
    const { lobby: l, now } = lobby({ startsIn: 60, lead: 60 });
    assert.equal(reminderAction(l, now, REMIND), 'post');
});

test('/lobby now (startsAt equals createdAt) never gets a reminder', () => {
    const now = 1_000_000_000_000;
    const l = { startsAt: now, createdAt: now, stages: { reminded: false } };
    assert.equal(reminderAction(l, now, REMIND), 'skip');
});

test('a 70-minute lobby reminds about ten minutes later, not at creation', () => {
    const now = 1_000_000_000_000;
    const startsAt = now + 70 * MIN;
    const l = { startsAt, createdAt: now, stages: { reminded: false } };

    assert.equal(reminderAction(l, now, REMIND), 'wait', 'nothing at creation');
    assert.equal(reminderAction(l, now + 9 * MIN, REMIND), 'wait');
    assert.equal(reminderAction(l, now + 10 * MIN, REMIND), 'post', 'posts once inside the window');
});

test('already reminded: none, so it never repeats', () => {
    const { lobby: l, now } = lobby({ startsIn: 30, reminded: true });
    assert.equal(reminderAction(l, now, REMIND), 'none');
});

test('a missing lobby or stages object is handled, not thrown on', () => {
    assert.equal(reminderAction(null, Date.now(), REMIND), 'none');
    assert.equal(reminderAction({ startsAt: 0, createdAt: 0 }, Date.now(), REMIND), 'none');
});

test('the window follows the configured value', () => {
    const { lobby: l, now } = lobby({ startsIn: 25, lead: 180 });

    assert.equal(reminderAction(l, now, 30), 'post', 'inside a 30-minute window');
    assert.equal(reminderAction(l, now, 20), 'wait', 'outside a 20-minute window');
});
