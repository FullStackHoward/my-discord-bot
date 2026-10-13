const os = require('node:os');
const path = require('node:path');
process.env.LOBBY_STATE_PATH = path.join(os.tmpdir(), `lobby-stats-test-${process.pid}.json`);

const { test } = require('node:test');
const assert = require('node:assert');
const stats = require('../lib/lobby/stats');

const DAY = 86400000;

function guild(overrides = {}) {
    return { lobbies: {}, profiles: {}, games: {}, crews: {}, series: {}, ...overrides };
}

function ended(id, { startsAt, confirmed, showed, filled, host = 'h', gameKey = 'g', players = [], attendance = 'host', timeToFillMs = null }) {
    return [id, {
        id, hostId: host, gameKey, startsAt, status: 'ended', endedAt: startsAt + 3600000,
        players, maybes: [], waitlist: [], nudged: [],
        attendance: { source: attendance, showed: [] },
        result: { confirmed, showed, filled, timeToFillMs }
    }];
}

test('median handles odd, even and empty', () => {
    assert.equal(stats.median([3, 1, 2]), 2);
    assert.equal(stats.median([1, 2, 3, 4]), 2.5);
    assert.equal(stats.median([]), null);
});

test('ratio guards against dividing by zero', () => {
    assert.equal(stats.ratio(1, 2), 0.5);
    assert.equal(stats.ratio(0, 0), null);
});

test('only lobbies inside the window are counted', () => {
    const now = Date.now();
    const g = guild({ lobbies: Object.fromEntries([
        ended('recent', { startsAt: now - 2 * DAY, confirmed: 2, showed: 2, filled: true }),
        ended('old', { startsAt: now - 60 * DAY, confirmed: 2, showed: 2, filled: true })
    ]) });

    assert.equal(stats.summarize(g, { nowMs: now, days: 30 }).created, 1);
    assert.equal(stats.summarize(g, { nowMs: now, days: 90 }).created, 2);
});

test('viable means two or more confirmed', () => {
    const now = Date.now();
    const g = guild({ lobbies: Object.fromEntries([
        ended('a', { startsAt: now - DAY, confirmed: 3, showed: 3, filled: true }),
        ended('b', { startsAt: now - DAY, confirmed: 1, showed: 1, filled: false })
    ]) });

    assert.equal(stats.summarize(g, { nowMs: now, days: 30 }).viable, 1);
});

test('fill rate and show rate come out of the result snapshots', () => {
    const now = Date.now();
    const g = guild({ lobbies: Object.fromEntries([
        ended('a', { startsAt: now - DAY, confirmed: 4, showed: 4, filled: true }),
        ended('b', { startsAt: now - DAY, confirmed: 4, showed: 2, filled: false })
    ]) });

    const s = stats.summarize(g, { nowMs: now, days: 30 });
    assert.equal(s.fillRate, 0.5);
    assert.equal(s.showRate, 0.75, '6 showed of 8 confirmed');
});

test('show rate is null when nothing has an attendance record', () => {
    const now = Date.now();
    const g = guild({ lobbies: Object.fromEntries([
        ended('a', { startsAt: now - DAY, confirmed: 2, showed: 0, filled: false, attendance: null })
    ]) });

    assert.equal(stats.summarize(g, { nowMs: now, days: 30 }).showRate, null);
});

test('repeat participation needs two lobbies within a fortnight', () => {
    const now = Date.now();
    const g = guild({ lobbies: Object.fromEntries([
        ended('a', { startsAt: now - 2 * DAY, confirmed: 1, showed: 1, filled: false, players: ['x', 'y'] }),
        ended('b', { startsAt: now - 5 * DAY, confirmed: 1, showed: 1, filled: false, players: ['x'] }),
        ended('c', { startsAt: now - 80 * DAY, confirmed: 1, showed: 1, filled: false, players: ['y'] })
    ]) });

    const s = stats.summarize(g, { nowMs: now, days: 90 });
    assert.equal(s.repeatParticipants, 1, 'x played twice close together; y did not');
    assert.equal(s.uniqueParticipants, 2);
});

test('nudge conversion counts only those who then joined', () => {
    const now = Date.now();
    const g = guild({ lobbies: {
        a: {
            id: 'a', hostId: 'h', gameKey: 'g', startsAt: now - DAY, status: 'ended', endedAt: now,
            players: ['h', 'joined'], maybes: [], waitlist: [], nudged: ['joined', 'ignored'],
            attendance: { source: 'host', showed: [] }, result: { confirmed: 2, showed: 2, filled: true }
        }
    } });

    const s = stats.summarize(g, { nowMs: now, days: 30 });
    assert.equal(s.nudgesSent, 2);
    assert.equal(s.nudgesJoined, 1);
});

test('top games rank by lobby count and use the registry label', () => {
    const now = Date.now();
    const g = guild({
        games: { halo: { label: 'Halo', submitters: ['a', 'b'] }, lol: { label: 'LoL', submitters: ['a'] } },
        lobbies: Object.fromEntries([
            ended('a', { startsAt: now - DAY, confirmed: 2, showed: 2, filled: true, gameKey: 'halo' }),
            ended('b', { startsAt: now - DAY, confirmed: 2, showed: 2, filled: true, gameKey: 'halo' }),
            ended('c', { startsAt: now - DAY, confirmed: 2, showed: 2, filled: true, gameKey: 'lol' })
        ])
    });

    const s = stats.summarize(g, { nowMs: now, days: 30 });
    assert.equal(s.topGames[0].label, 'Halo');
    assert.equal(s.topGames[0].count, 2);
});

test('overlap reports counts per hour and never names anyone', () => {
    const g = guild({
        games: { halo: { label: 'Halo', submitters: ['a', 'b'] } },
        profiles: {
            a: { tz: 'America/New_York', weekday: ['evening'], weekend: [], games: ['halo'], platforms: [] },
            b: { tz: 'America/New_York', weekday: ['evening'], weekend: [], games: ['halo'], platforms: [] },
            c: { tz: 'America/New_York', weekday: ['morning'], weekend: [], games: ['halo'], platforms: [] }
        }
    });

    const overlap = stats.availabilityOverlap(g, { nowMs: Date.UTC(2026, 9, 12, 12, 0) });

    assert.equal(overlap.length, 1);
    assert.equal(overlap[0].label, 'Halo');
    assert.equal(overlap[0].members, 3);
    assert.ok(overlap[0].top.length > 0);
    assert.equal(overlap[0].top[0].count, 2, 'the two evening members overlap');

    const serialized = JSON.stringify(overlap);
    for (const id of ['"a"', '"b"', '"c"']) {
        assert.ok(!serialized.includes(id), 'no member ids in the overlap output');
    }
});

test('overlap is empty with no usable profiles', () => {
    assert.deepEqual(stats.availabilityOverlap(guild(), { nowMs: Date.now() }), []);
    assert.deepEqual(stats.availabilityOverlap(guild({
        profiles: { a: { tz: null, games: ['x'], weekday: [], weekend: [] } }
    }), { nowMs: Date.now() }), [], 'a profile with no zone cannot be placed in time');
});

test('the week summary covers the last seven days only', () => {
    const now = Date.now();
    const g = guild({
        games: { halo: { label: 'Halo' } },
        lobbies: Object.fromEntries([
            ended('in', { startsAt: now - 2 * DAY, confirmed: 4, showed: 3, filled: true, gameKey: 'halo' }),
            ended('out', { startsAt: now - 20 * DAY, confirmed: 4, showed: 4, filled: true, gameKey: 'halo' })
        ])
    });

    const week = stats.weekSummary(g, now);
    assert.equal(week.lobbies, 1);
    assert.equal(week.showRate, 0.75);
    assert.equal(week.topGames[0].label, 'Halo');
});
