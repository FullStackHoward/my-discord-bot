const os = require('node:os');
const path = require('node:path');
// Point state at a temp file so the suite never writes into the repo.
process.env.LOBBY_STATE_PATH = path.join(os.tmpdir(), `lobby-state-test-${process.pid}.json`);

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const state = require('../lib/lobby/state');

after(() => {
    for (const suffix of ['', '.tmp']) {
        try { fs.unlinkSync(process.env.LOBBY_STATE_PATH + suffix); } catch {}
    }
});

function lobby(overrides = {}) {
    return {
        id: 'abc123', number: 1, hostId: 'host', gameKey: 'g', gameLabel: 'G',
        platform: 'pc', crossplay: true, seats: 2, minPlayers: null,
        startsAt: Date.now() + 3600000, endsAt: Date.now() + 7200000,
        status: 'open', createdAt: Date.now() - 1000, endedAt: null,
        players: ['host'], maybes: [], waitlist: [], nudged: [],
        stages: {}, voiceMinutes: {}, attendance: { source: null, showed: [], confirmedAt: null },
        againVotes: [], result: null,
        ...overrides
    };
}

test('join takes a seat while one is free', () => {
    const l = lobby({ seats: 3 });
    const r = state.joinLobby(l, 'a');

    assert.equal(r.ok, true);
    assert.equal(r.result, 'joined');
    assert.deepEqual(l.players, ['host', 'a']);
    assert.deepEqual(l.waitlist, []);
});

test('join waitlists once the seats are gone', () => {
    const l = lobby({ seats: 2 });
    assert.equal(state.joinLobby(l, 'a').result, 'joined');

    const r = state.joinLobby(l, 'b');
    assert.equal(r.result, 'waitlisted');
    assert.deepEqual(l.players, ['host', 'a']);
    assert.deepEqual(l.waitlist, ['b']);
});

test('THE LAST-SEAT RACE: two joins cannot both take the final seat', () => {
    const l = lobby({ seats: 2 });

    // joinLobby is synchronous with no await between the seat check and the push, so
    // interleaving is impossible. Back-to-back calls prove the ordering holds.
    const first = state.joinLobby(l, 'a');
    const second = state.joinLobby(l, 'b');

    assert.equal(first.result, 'joined');
    assert.equal(second.result, 'waitlisted');
    assert.equal(l.players.length, 2, 'never oversubscribed');
    assert.ok(l.players.length <= l.seats);
});

test('join is idempotent for someone already confirmed', () => {
    const l = lobby({ seats: 4 });
    state.joinLobby(l, 'a');

    const again = state.joinLobby(l, 'a');
    assert.equal(again.ok, false);
    assert.equal(again.result, 'already');
    assert.equal(l.players.filter(id => id === 'a').length, 1);
});

test('join refuses a closed lobby and a platform mismatch', () => {
    assert.equal(state.joinLobby(lobby({ status: 'ended' }), 'a').result, 'closed');
    assert.equal(state.joinLobby(lobby({ seats: 4 }), 'a', { platformOk: false }).result, 'platform');
});

test('join upgrades a maybe and clears them from the maybe list', () => {
    const l = lobby({ seats: 4 });
    state.maybeLobby(l, 'a');
    assert.deepEqual(l.maybes, ['a']);

    state.joinLobby(l, 'a');
    assert.deepEqual(l.players, ['host', 'a']);
    assert.deepEqual(l.maybes, [], 'no longer a maybe once seated');
});

test('maybe holds no seat', () => {
    const l = lobby({ seats: 2 });
    state.maybeLobby(l, 'a');

    assert.equal(l.players.length, 1);
    assert.equal(state.seatsLeft(l), 1, 'the maybe did not consume the seat');
});

test('leaving a seat promotes the first waitlister', () => {
    const l = lobby({ seats: 2 });
    state.joinLobby(l, 'a');
    state.joinLobby(l, 'b');
    state.joinLobby(l, 'c');
    assert.deepEqual(l.waitlist, ['b', 'c']);

    const r = state.leaveLobby(l, 'a');
    assert.equal(r.promoted, 'b', 'first in, first promoted');
    assert.deepEqual(l.players, ['host', 'b']);
    assert.deepEqual(l.waitlist, ['c']);
});

test('leaving from the waitlist promotes nobody', () => {
    const l = lobby({ seats: 2 });
    state.joinLobby(l, 'a');
    state.joinLobby(l, 'b');

    const r = state.leaveLobby(l, 'b');
    assert.equal(r.promoted, null);
    assert.deepEqual(l.players, ['host', 'a']);
});

test('leaving when not in the lobby is a no-op', () => {
    const l = lobby();
    const r = state.leaveLobby(l, 'nobody');

    assert.equal(r.ok, false);
    assert.equal(r.result, 'notIn');
});

test('a closed lobby does not promote on leave', () => {
    const l = lobby({ seats: 2, status: 'live' });
    state.joinLobby(l, 'a');
    l.waitlist.push('b');

    const r = state.leaveLobby(l, 'a');
    assert.equal(r.promoted, null, 'promotion only happens while open');
});

test('raising the seat count absorbs the waitlist in order', () => {
    const l = lobby({ seats: 2 });
    state.joinLobby(l, 'a');
    state.joinLobby(l, 'b');
    state.joinLobby(l, 'c');

    const r = state.setSeats(l, 4);
    assert.equal(r.ok, true);
    assert.deepEqual(l.players, ['host', 'a', 'b', 'c']);
    assert.deepEqual(l.waitlist, []);
});

test('seats cannot drop below the confirmed count', () => {
    const l = lobby({ seats: 4 });
    state.joinLobby(l, 'a');
    state.joinLobby(l, 'b');

    const r = state.setSeats(l, 2);
    assert.equal(r.ok, false);
    assert.equal(r.result, 'belowConfirmed');
    assert.equal(l.seats, 4, 'unchanged');
});

test('noteFilled records time-to-fill once only', () => {
    const l = lobby({ seats: 2, createdAt: Date.now() - 5000 });
    state.joinLobby(l, 'a');
    state.noteFilled(l);

    const first = l.result.timeToFillMs;
    assert.ok(first >= 0);

    state.noteFilled(l);
    assert.equal(l.result.timeToFillMs, first, 'not overwritten by a later call');
});

test('snapshotResult freezes counts so later departures cannot change history', () => {
    const l = lobby({ seats: 3 });
    state.joinLobby(l, 'a');
    state.joinLobby(l, 'b');
    l.attendance.showed = ['host', 'a'];

    const snap = state.snapshotResult(l);
    assert.equal(snap.confirmed, 3);
    assert.equal(snap.showed, 2);
    assert.equal(snap.filled, true);

    state.leaveLobby(l, 'a');
    assert.equal(l.result.confirmed, 3, 'the snapshot is unchanged by the departure');
});

test('setLobbyStatus stamps endedAt once', () => {
    const l = lobby();
    state.setLobbyStatus(l, 'ended');
    const first = l.endedAt;

    assert.ok(first);
    state.setLobbyStatus(l, 'cancelled');
    assert.equal(l.endedAt, first, 'not restamped');
});
