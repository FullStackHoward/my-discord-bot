const os = require('node:os');
const path = require('node:path');
process.env.LOBBY_STATE_PATH = path.join(os.tmpdir(), `lobby-nudge-test-${process.pid}.json`);

const { test } = require('node:test');
const assert = require('node:assert');
const sweep = require('../lib/lobby/sweep');
const { LOBBY_NUDGE_DAILY_CAP } = require('../lib/config');
const time = require('../lib/lobby/time');

const NY = 'America/New_York';
// 2026-10-15 23:00 UTC = 7pm New York on a Thursday: inside an "evening" weekday block.
const START = Date.UTC(2026, 9, 15, 23, 0);
const NOW = START - 2 * 60 * 60 * 1000;

function lobby(overrides = {}) {
    return {
        id: 'l1', hostId: 'host', gameKey: 'halo', gameLabel: 'Halo',
        platform: 'pc', crossplay: true, startsAt: START,
        players: ['host'], maybes: [], waitlist: [], nudged: [],
        ...overrides
    };
}

function profile(overrides = {}) {
    return {
        tz: NY, weekday: ['evening'], weekend: [], platforms: ['pc'], games: ['halo'],
        nudges: true, nudgeLog: { day: null, count: 0 }, tags: {},
        ...overrides
    };
}

test('a matching member is a candidate', () => {
    assert.equal(sweep.isNudgeCandidate(lobby(), 'u', profile(), NOW), true);
});

test('nudges off means never a candidate', () => {
    assert.equal(sweep.isNudgeCandidate(lobby(), 'u', profile({ nudges: false }), NOW), false);
});

test('no saved time zone means the start cannot be placed, so no nudge', () => {
    assert.equal(sweep.isNudgeCandidate(lobby(), 'u', profile({ tz: null }), NOW), false);
});

test('the game has to be on their profile', () => {
    assert.equal(sweep.isNudgeCandidate(lobby(), 'u', profile({ games: ['other'] }), NOW), false);
});

test('the start has to fall inside one of their blocks', () => {
    assert.equal(sweep.isNudgeCandidate(lobby(), 'u', profile({ weekday: ['morning'] }), NOW), false);
    assert.equal(sweep.isNudgeCandidate(lobby(), 'u', profile({ weekday: [], weekend: ['evening'] }), NOW), false,
        'a Thursday is not a weekend');
});

test('the host and anyone already involved are never nudged', () => {
    const l = lobby({ players: ['host', 'player'], maybes: ['maybe'], waitlist: ['waiting'] });

    assert.equal(sweep.isNudgeCandidate(l, 'host', profile(), NOW), false);
    assert.equal(sweep.isNudgeCandidate(l, 'player', profile(), NOW), false);
    assert.equal(sweep.isNudgeCandidate(l, 'maybe', profile(), NOW), false);
    assert.equal(sweep.isNudgeCandidate(l, 'waiting', profile(), NOW), false);
});

test('nobody is nudged twice for the same lobby', () => {
    assert.equal(sweep.isNudgeCandidate(lobby({ nudged: ['u'] }), 'u', profile(), NOW), false);
});

test('platform only matters when crossplay is off', () => {
    const crossplayOn = lobby({ crossplay: true, platform: 'xbox' });
    const crossplayOff = lobby({ crossplay: false, platform: 'xbox' });
    const pcOnly = profile({ platforms: ['pc'] });

    assert.equal(sweep.isNudgeCandidate(crossplayOn, 'u', pcOnly, NOW), true, 'crossplay on, platform irrelevant');
    assert.equal(sweep.isNudgeCandidate(crossplayOff, 'u', pcOnly, NOW), false, 'crossplay off and no match');
    assert.equal(sweep.isNudgeCandidate(crossplayOff, 'u', profile({ platforms: ['xbox'] }), NOW), true);
    assert.equal(sweep.isNudgeCandidate(crossplayOff, 'u', profile({ platforms: [] }), NOW), true,
        'no platforms listed is not a reason to exclude them');
});

test('the daily cap is counted in the member own local day', () => {
    const today = time.localIsoDate(NOW, NY);

    const atCap = profile({ nudgeLog: { day: today, count: LOBBY_NUDGE_DAILY_CAP } });
    assert.equal(sweep.isNudgeCandidate(lobby(), 'u', atCap, NOW), false);

    const underCap = profile({ nudgeLog: { day: today, count: LOBBY_NUDGE_DAILY_CAP - 1 } });
    assert.equal(sweep.isNudgeCandidate(lobby(), 'u', underCap, NOW), true);

    // A count from a previous local day does not carry over.
    const yesterday = profile({ nudgeLog: { day: '2000-01-01', count: 99 } });
    assert.equal(sweep.isNudgeCandidate(lobby(), 'u', yesterday, NOW), true);
});

test('quiet hours: the window is the member local 08:00 to 22:00', () => {
    // 2026-10-15 11:00 UTC = 7am New York, before the window.
    const earlyMorning = Date.UTC(2026, 9, 15, 11, 0);
    assert.equal(time.localHour(earlyMorning, NY), 7);

    // 2026-10-16 02:00 UTC = 10pm New York, at the closing edge.
    const lateNight = Date.UTC(2026, 9, 16, 2, 0);
    assert.equal(time.localHour(lateNight, NY), 22);

    // 2026-10-15 17:00 UTC = 1pm New York, inside it.
    const midday = Date.UTC(2026, 9, 15, 17, 0);
    assert.equal(time.localHour(midday, NY), 13);

    const inWindow = hour => hour >= 8 && hour < 22;
    assert.equal(inWindow(time.localHour(earlyMorning, NY)), false);
    assert.equal(inWindow(time.localHour(lateNight, NY)), false);
    assert.equal(inWindow(time.localHour(midday, NY)), true);
});
