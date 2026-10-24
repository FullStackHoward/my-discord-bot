const os = require('node:os');
const path = require('node:path');
process.env.LOBBY_STATE_PATH = path.join(os.tmpdir(), `lobby-now-test-${process.pid}.json`);

const { test } = require('node:test');
const assert = require('node:assert');
const sweep = require('../lib/lobby/sweep');
const state = require('../lib/lobby/state');
const { LOBBY_NOW_EXPIRY_MINUTES } = require('../lib/config');

const MINUTE = 60 * 1000;
const START = Date.UTC(2026, 9, 23, 23, 0);

// A /lobby now lobby, as the sweep sees it once it has gone live: its start time is in
// the past and only the host is aboard.
function nowLobby(overrides = {}) {
    return {
        id: 'n1', number: 4, hostId: 'host', gameLabel: 'Halo', isNow: true,
        startsAt: START, endsAt: START + 2 * 60 * MINUTE, status: 'live',
        players: ['host'], maybes: [], waitlist: [], stages: {},
        ...overrides
    };
}

const after = minutes => START + minutes * MINUTE;

test('an empty /lobby now lobby lapses once its window passes', () => {
    assert.equal(sweep.hasLapsedUnjoined(nowLobby(), after(LOBBY_NOW_EXPIRY_MINUTES)), true);
});

// The bug: the check used to sit inside the `status === 'open'` branch, and a now-lobby
// leaves 'open' on the first sweep after it is created - about a minute in, far short of
// the 45-minute window - so it never fired and the lobby read "Live now." until its
// end time.
test('a live lobby is checked, not just an open one', () => {
    const late = after(LOBBY_NOW_EXPIRY_MINUTES + 1);

    assert.equal(sweep.hasLapsedUnjoined(nowLobby({ status: 'live' }), late), true);
    assert.equal(sweep.hasLapsedUnjoined(nowLobby({ status: 'open' }), late), true);
});

test('it holds off until the window is actually up', () => {
    assert.equal(sweep.hasLapsedUnjoined(nowLobby(), after(LOBBY_NOW_EXPIRY_MINUTES - 1)), false);
    assert.equal(sweep.hasLapsedUnjoined(nowLobby(), START), false);
});

test('somebody joining saves it', () => {
    const lobby = nowLobby({ players: ['host', 'a'] });

    assert.equal(sweep.hasLapsedUnjoined(lobby, after(LOBBY_NOW_EXPIRY_MINUTES * 10)), false);
});

test('a scheduled lobby never lapses this way, however empty', () => {
    const scheduled = nowLobby({ isNow: false });

    assert.equal(sweep.hasLapsedUnjoined(scheduled, after(LOBBY_NOW_EXPIRY_MINUTES * 10)), false);
});

test('a lobby that already finished is left alone', () => {
    for (const status of ['ended', 'cancelled', 'expired']) {
        assert.equal(
            sweep.hasLapsedUnjoined(nowLobby({ status }), after(LOBBY_NOW_EXPIRY_MINUTES)),
            false,
            status
        );
    }
});

// The two halves of the fix meeting: a now-lobby stays joinable for its whole window,
// and the moment it lapses it stops being joinable.
test('a now-lobby is joinable right up until it lapses', () => {
    const lobby = nowLobby({ seats: 4 });

    assert.equal(state.joinLobby(lobby, 'a').result, 'joined');
    assert.equal(sweep.hasLapsedUnjoined(lobby, after(LOBBY_NOW_EXPIRY_MINUTES)), false,
        'and once somebody is in, it does not lapse at all');

    assert.equal(state.joinLobby(nowLobby({ seats: 4, status: 'expired' }), 'b').result, 'closed');
});
