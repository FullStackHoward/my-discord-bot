const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), `radar-digest-${process.pid}-`));
process.env.RADAR_DIGEST_STATE_PATH = path.join(TEMP, 'state.json');
process.env.RADAR_GAMES_CONFIG_PATH = path.join(TEMP, 'radar-games.json');
process.env.LOBBY_STATE_PATH = path.join(TEMP, 'lobby.json');

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const identity = require('../lib/radar/game-digest/identity');
const digest = require('../lib/radar/game-digest/digest');
const store = require('../lib/radar/game-digest/store');
const gamesConfig = require('../lib/radar/game-digest/games-config');

after(() => fs.rmSync(TEMP, { recursive: true, force: true }));

const NY = 'America/New_York';
const GUILD = 'g1';

// ---------------------------------------------------------------------------
// Game identity
// ---------------------------------------------------------------------------

const compiled = () => identity.compileGameConfig(gamesConfig.SEED_CONFIG);

function playing(name, applicationId = null) {
    return { type: 0, name, applicationId };
}

test('an application ID wins over the name as the key', () => {
    const game = identity.identifyActivity(playing('Some Shooter', '99887766'), compiled());

    assert.equal(game.key, 'app:99887766');
    assert.equal(game.name, 'Some Shooter', 'the reported name is still what gets printed');
});

test('without an application ID the key is the normalized name', () => {
    assert.equal(identity.identifyActivity(playing('Some Shooter'), compiled()).key, 'name:some shooter');
});

test('normalization folds case, trademark symbols and runs of whitespace', () => {
    assert.equal(identity.normalizeName('  Halo™   Infinite® '), 'halo infinite');
    assert.equal(identity.normalizeName('HALO infinite'), 'halo infinite');
    assert.equal(identity.normalizeName(undefined), '');
});

test('the words TM and Inc survive, since some titles contain them', () => {
    assert.equal(identity.normalizeName('TM Nations Forever'), 'tm nations forever');
});

test('an alias merges every variant into one entry with one display name', () => {
    const keys = ['GTA V', 'Grand Theft Auto V', 'gta online'].map(name =>
        identity.identifyActivity(playing(name), compiled()));

    assert.deepEqual([...new Set(keys.map(g => g.key))], ['game:gta'], 'one key for all three');
    assert.deepEqual([...new Set(keys.map(g => g.name))], ['Grand Theft Auto']);
});

test('every emulator lands in one Retro / Emulation entry', () => {
    for (const name of ['RetroArch', 'Dolphin Emulator', 'PCSX2', 'Ryujinx']) {
        const game = identity.identifyActivity(playing(name), compiled());
        assert.equal(game.key, 'game:retro', name);
        assert.equal(game.name, 'Retro / Emulation');
    }
});

test('an excluded app is dropped entirely', () => {
    assert.equal(identity.identifyActivity(playing('Visual Studio Code'), compiled()), null);
    assert.equal(identity.identifyActivity(playing('Steam'), compiled()), null);
});

test('an exclude applies whichever form it was written in', () => {
    const custom = identity.compileGameConfig({ excludes: ['app:555'], aliases: [] });

    assert.equal(identity.identifyActivity(playing('Launcher', '555'), custom), null);
    assert.equal(identity.identifyActivity(playing('Launcher'), custom).key, 'name:launcher',
        'a different copy of it without the ID is untouched');
});

test('only Playing counts: streaming, listening and custom statuses do not', () => {
    const presence = {
        activities: [
            { type: 1, name: 'Twitch' },
            { type: 2, name: 'Spotify' },
            { type: 3, name: 'Netflix' },
            { type: 4, name: 'a custom status' },
            playing('Fortnite')
        ]
    };

    assert.deepEqual([...identity.gamesForPresence(presence, compiled()).keys()], ['game:fortnite']);
});

test('two activities resolving to one game credit it once', () => {
    const presence = { activities: [playing('GTA V'), playing('Grand Theft Auto Online')] };

    assert.equal(identity.gamesForPresence(presence, compiled()).size, 1);
});

test('a malformed config costs the bad entry, not the digest', () => {
    const broken = identity.compileGameConfig({
        aliases: [null, { key: 'x' }, { match: ['name:y'] }, { key: 'game:ok', name: 'Ok', match: ['name:ok'] }],
        excludes: [null, 42, 'name:bad']
    });

    assert.equal(identity.identifyActivity(playing('Ok'), broken).key, 'game:ok');
    assert.equal(identity.identifyActivity(playing('Bad'), broken), null);
});

// ---------------------------------------------------------------------------
// The schedule
// ---------------------------------------------------------------------------

test('the first digest fires at 5 PM Eastern on Nov 1 2026, not 4 PM', () => {
    // Saturday Oct 31 2026, 3:00 PM Eastern (EDT, UTC-4).
    const from = Date.UTC(2026, 9, 31, 19, 0);

    const first = digest.nextPostAfter(from, NY);
    assert.equal(new Date(first).toISOString(), '2026-11-01T22:00:00.000Z',
        'the clocks go back that morning, so 5 PM Eastern is 22:00 UTC, not 21:00');

    assert.equal(new Date(digest.nextPostAfter(first, NY)).toISOString(), '2026-11-08T22:00:00.000Z');
});

test('spring forward keeps the same local hour too', () => {
    // Sunday Mar 7 2027 is the week before the US spring-forward on Mar 14.
    const before = Date.UTC(2027, 2, 7, 22, 0);
    const after = digest.nextPostAfter(before, NY);

    assert.equal(new Date(after).toISOString(), '2027-03-14T21:00:00.000Z', 'EDT, so 21:00 UTC');
    const { hour, weekday } = require('../lib/lobby/time').localParts(after, NY);
    assert.equal(hour, 17);
    assert.equal(weekday, 0);
});

test('the window is seven calendar days, which across the clock change is 169 hours', () => {
    const end = Date.UTC(2026, 10, 1, 22, 0);
    const start = digest.windowStartFor(end, NY);

    assert.equal(new Date(start).toISOString(), '2026-10-25T21:00:00.000Z');
    assert.equal((end - start) / digest.HOUR_MS, 169, 'not a naive 168');
});

test('a normal week is 168 hours', () => {
    const end = Date.UTC(2026, 10, 8, 22, 0);
    assert.equal((end - digest.windowStartFor(end, NY)) / digest.HOUR_MS, 168);
});

test('the window end is the scheduled instant, so a late post still reports the right week', () => {
    const scheduled = Date.UTC(2026, 10, 1, 22, 0);

    // An hour and a half late, because the bot was restarting.
    assert.equal(digest.windowEndFor(scheduled + 90 * 60 * 1000, NY), scheduled);
    assert.equal(digest.windowEndFor(scheduled, NY), scheduled, 'and exactly on time');
});

// ---------------------------------------------------------------------------
// Counting and ranking
// ---------------------------------------------------------------------------

const HOUR = digest.HOUR_MS;

// Builds buckets directly: { hourStart: { memberId: { gameKey: minutes } } }
function buckets(spec) {
    return spec;
}

test('three samples qualify a player, two do not', () => {
    const tally = digest.tallyWindow(buckets({
        [0]: { alice: { 'game:a': 10 }, bob: { 'game:a': 15 } }
    }), 0, HOUR);

    const { rows } = digest.rankGames(tally, { minPlayers: 1 });

    assert.equal(rows.length, 1);
    assert.equal(rows[0].uniquePlayers, 1, 'bob at 15 minutes counts, alice at 10 does not');
    assert.equal(rows[0].totalMinutes, 15, 'and the hours only count qualifying players');
});

test('minutes add up across hourly buckets inside the window', () => {
    const tally = digest.tallyWindow(buckets({
        [0]: { alice: { 'game:a': 10 } },
        [HOUR]: { alice: { 'game:a': 10 } }
    }), 0, 2 * HOUR);

    const { rows } = digest.rankGames(tally, { minPlayers: 1 });
    assert.equal(rows[0].uniquePlayers, 1, '20 minutes across two hours still clears 15');
});

test('buckets outside the window are ignored at both ends', () => {
    const spec = buckets({
        [0]: { alice: { 'game:a': 60 } },
        [HOUR]: { bob: { 'game:a': 60 } },
        [2 * HOUR]: { carol: { 'game:a': 60 } }
    });

    const tally = digest.tallyWindow(spec, HOUR, 2 * HOUR);
    assert.deepEqual([...tally.get('game:a').keys()], ['bob'], 'the end is exclusive, the start inclusive');
});

test('a game only one person played is left out', () => {
    const tally = digest.tallyWindow(buckets({
        [0]: { alice: { 'game:solo': 120 }, bob: { 'game:shared': 60 }, carol: { 'game:shared': 60 } }
    }), 0, HOUR);

    const { rows, belowPlayerFloor } = digest.rankGames(tally);

    assert.deepEqual(rows.map(r => r.key), ['game:shared']);
    assert.equal(belowPlayerFloor, 1, 'and the preview can say one was held back');
});

test('ranking is by players first, then hours', () => {
    const tally = digest.tallyWindow(buckets({
        [0]: {
            a: { 'game:popular': 30 }, b: { 'game:popular': 30 }, c: { 'game:popular': 30 },
            d: { 'game:long': 600 }, e: { 'game:long': 600 }
        }
    }), 0, HOUR);

    const { rows } = digest.rankGames(tally);

    assert.deepEqual(rows.map(r => r.key), ['game:popular', 'game:long'],
        'three players beats twenty hours between two');
});

test('hours break a tie on players', () => {
    const tally = digest.tallyWindow(buckets({
        [0]: {
            a: { 'game:x': 30, 'game:y': 90 },
            b: { 'game:x': 30, 'game:y': 90 }
        }
    }), 0, HOUR);

    assert.deepEqual(digest.rankGames(tally).rows.map(r => r.key), ['game:y', 'game:x']);
});

test('fewer than five qualifying games shows fewer lines', () => {
    const members = {};
    for (const key of ['g1', 'g2']) {
        members[`${key}-a`] = { [key]: 60 };
        members[`${key}-b`] = { [key]: 60 };
    }

    const { rows } = digest.rankGames(digest.tallyWindow({ [0]: members }, 0, HOUR));
    assert.equal(rows.length, 2);
});

test('never more than five lines', () => {
    const members = {};
    for (let i = 0; i < 9; i++) {
        members[`m${i}a`] = { [`game:${i}`]: 60 };
        members[`m${i}b`] = { [`game:${i}`]: 60 };
    }

    assert.equal(digest.rankGames(digest.tallyWindow({ [0]: members }, 0, HOUR)).rows.length, 5);
});

test('hours are one decimal of the qualifying minutes', () => {
    const tally = digest.tallyWindow({ [0]: { a: { 'game:a': 75 }, b: { 'game:a': 70 } } }, 0, HOUR);
    const { rows } = digest.rankGames(tally);

    assert.equal(rows[0].hours, 2.4, '145 minutes is 2.4 hours');
});

// ---------------------------------------------------------------------------
// Week over week
// ---------------------------------------------------------------------------

test('up, down and new are measured against last week placing', () => {
    const rows = [{ key: 'b' }, { key: 'a' }, { key: 'c' }];
    const previous = [{ key: 'a' }, { key: 'b' }];

    const changed = digest.withChange(rows, previous);

    assert.equal(changed[0].change, 'up 1', 'b went from 2nd to 1st');
    assert.equal(changed[1].change, 'down 1', 'a went from 1st to 2nd');
    assert.equal(changed[2].change, 'new', 'c was not there last week');
});

test('a game holding its place says nothing', () => {
    assert.equal(digest.withChange([{ key: 'a' }], [{ key: 'a' }])[0].change, null);
});

test('with no previous week nothing is marked new', () => {
    const changed = digest.withChange([{ key: 'a' }, { key: 'b' }], []);
    assert.deepEqual(changed.map(r => r.change), [null, null],
        'the first post should not label everything new');
});

// ---------------------------------------------------------------------------
// The embed
// ---------------------------------------------------------------------------

function embedJson(overrides = {}) {
    return digest.buildDigestEmbed({
        rows: digest.withChange([
            { key: 'game:fortnite', uniquePlayers: 7, totalMinutes: 744, hours: 12.4 },
            { key: 'game:gta', uniquePlayers: 3, totalMinutes: 180, hours: 3.0 }
        ], []),
        labels: { 'game:fortnite': 'Fortnite', 'game:gta': 'Grand Theft Auto' },
        ...overrides
    }).toJSON();
}

test('the embed carries the title, footer and one line per game', () => {
    const json = embedJson();

    assert.equal(json.title, 'What the Lounge played this week');
    assert.equal(json.footer.text, 'Counts members who share their activity on Discord.');
    assert.match(json.description, /\*\*1\.\*\* Fortnite · 7 players · 12\.4 hours/);
    assert.match(json.description, /\*\*2\.\*\* Grand Theft Auto · 3 players · 3\.0 hours/);
});

test('the embed names no members and can mention nobody', () => {
    const json = embedJson();

    assert.ok(!/<@/.test(json.description), 'no member mentions');
    assert.ok(!/@everyone|@here/.test(json.description));
});

test('the first week says so', () => {
    assert.match(embedJson({ firstWeek: true }).description, /First week, tracking started Saturday/);
    assert.ok(!/First week/.test(embedJson().description));
});

test('the call to action points at a real way in', () => {
    assert.match(embedJson().description, /Playing one of these\? Drop a callout/);
    assert.match(embedJson().description, /`\/vice-radar join`/, 'the command, with no opt-in channel set');
    assert.match(embedJson({ ctaChannelId: '123' }).description, /<#123>/, 'and the channel when there is one');
});

test('an extra line can be added later without restructuring', () => {
    const json = embedJson({ extraLine: 'Arcade champion: nobody yet.' });

    assert.match(json.description, /Arcade champion: nobody yet\./);
    assert.ok(json.description.indexOf('Arcade champion') > json.description.indexOf('Grand Theft Auto'),
        'after the rankings');
});

test('a game name cannot break the formatting of the list', () => {
    const json = digest.buildDigestEmbed({
        rows: digest.withChange([{ key: 'k', uniquePlayers: 2, totalMinutes: 60, hours: 1 }], []),
        labels: { k: 'Weird **Game**' }
    }).toJSON();

    assert.match(json.description, /Weird \\\*\\\*Game\\\*\\\*/);
});

// ---------------------------------------------------------------------------
// Storage, slots and retention
// ---------------------------------------------------------------------------

beforeEach(() => {
    store._reset();
    try { fs.unlinkSync(process.env.RADAR_DIGEST_STATE_PATH); } catch {}
});

test('a slot can only be claimed once, so a restart cannot double credit', () => {
    assert.equal(store.claimSlot(GUILD, 1000), true);
    assert.equal(store.claimSlot(GUILD, 1000), false, 'the same slot again');
    assert.equal(store.claimSlot(GUILD, 1001), true, 'the next slot is fine');
});

test('credits land in the hourly bucket for the moment they were taken', () => {
    const at = Date.UTC(2026, 9, 31, 20, 17);
    store.credit(GUILD, at, 'alice', 'game:a', 'A', 5);
    store.credit(GUILD, at + 5 * 60 * 1000, 'alice', 'game:a', 'A', 5);

    const guild = store.guildState(GUILD);
    const hour = String(Date.UTC(2026, 9, 31, 20, 0));

    assert.equal(guild.buckets[hour].alice['game:a'], 10, 'both samples in the same hour');
    assert.equal(guild.labels['game:a'], 'A');
    assert.equal(guild.firstSampleAt, at, 'and the first sample is remembered for the partial first week');
});

test('state survives a reload, which is what makes a restart mid-week safe', () => {
    store.credit(GUILD, 3600000, 'alice', 'game:a', 'A', 5);
    store.setHandledWeek(GUILD, '2026-11-01', { lastResult: [{ key: 'game:a' }] });
    store.flush();
    store._reset();

    const guild = store.guildState(GUILD);
    assert.equal(guild.lastHandledWeek, '2026-11-01');
    assert.equal(guild.buckets['3600000'].alice['game:a'], 5);
    assert.deepEqual(guild.lastResult, [{ key: 'game:a' }]);
});

test('pruning drops only what is past the cutoff', () => {
    store.credit(GUILD, 0, 'alice', 'game:a', 'A', 5);
    store.credit(GUILD, 5 * HOUR, 'alice', 'game:a', 'A', 5);
    store.credit(GUILD, 10 * HOUR, 'alice', 'game:a', 'A', 5);

    assert.equal(store.pruneBuckets(GUILD, 5 * HOUR), 1, 'only the bucket before the cutoff');
    assert.deepEqual(Object.keys(store.guildState(GUILD).buckets).sort(), [String(10 * HOUR), String(5 * HOUR)].sort());
});

test('a member who leaves is forgotten without touching anybody else', () => {
    store.credit(GUILD, 0, 'alice', 'game:a', 'A', 5);
    store.credit(GUILD, 0, 'bob', 'game:a', 'A', 5);

    assert.equal(store.forgetMember(GUILD, 'alice'), 1);
    assert.deepEqual(Object.keys(store.guildState(GUILD).buckets['0']), ['bob']);
    assert.equal(store.guildState(GUILD).labels['game:a'], 'A', 'game names are not personal data');
});

test('the history queue is capped rather than growing forever', () => {
    for (let i = 0; i < store.MAX_QUEUED_WEEKS + 3; i++) {
        store.queueApiWrite(GUILD, { weekStart: `w${i}` });
    }

    const queue = store.takeApiQueue(GUILD);
    assert.equal(queue.length, store.MAX_QUEUED_WEEKS);
    assert.equal(queue[0].weekStart, 'w3', 'the oldest are dropped first');
});

test('a stored week can be cleared from the queue once it lands', () => {
    store.queueApiWrite(GUILD, { weekStart: 'a' });
    store.queueApiWrite(GUILD, { weekStart: 'b' });
    store.clearQueuedWrite(GUILD, 'a');

    assert.deepEqual(store.takeApiQueue(GUILD).map(r => r.weekStart), ['b']);
});

// ---------------------------------------------------------------------------
// The alias and exclude file
// ---------------------------------------------------------------------------

test('a missing config file falls back to the seeds rather than failing', () => {
    try { fs.unlinkSync(process.env.RADAR_GAMES_CONFIG_PATH); } catch {}

    const config = gamesConfig.loadGameConfig();
    assert.ok(config.aliases.length > 0);
    assert.ok(config.excludes.includes('name:visual studio code'));
});

test('an alias added to the file is picked up on the next read', () => {
    gamesConfig.mutateGameConfig(next => {
        next.aliases.push({ key: 'game:new', name: 'New Game', match: ['name:new game'] });
    });

    const game = identity.identifyActivity(playing('New Game'), identity.compileGameConfig(gamesConfig.loadGameConfig()));
    assert.equal(game.key, 'game:new');
    assert.equal(game.name, 'New Game');
});

test('one reported key maps to one entry, so re-adding it moves it', () => {
    gamesConfig.mutateGameConfig(next => {
        next.aliases = [{ key: 'game:one', name: 'One', match: ['name:x'] }];
    });

    gamesConfig.mutateGameConfig(next => {
        for (const entry of next.aliases) entry.match = entry.match.filter(m => m !== 'name:x');
        next.aliases.push({ key: 'game:two', name: 'Two', match: ['name:x'] });
        next.aliases = next.aliases.filter(entry => entry.match.length > 0);
    });

    const config = gamesConfig.loadGameConfig();
    assert.deepEqual(config.aliases.map(a => a.key), ['game:two'], 'the emptied entry is dropped');
});

test('seeds are written out on the first mutation, so the file shows its own shape', () => {
    try { fs.unlinkSync(process.env.RADAR_GAMES_CONFIG_PATH); } catch {}

    gamesConfig.mutateGameConfig(next => { next.excludes.push('name:something'); });

    const written = JSON.parse(fs.readFileSync(process.env.RADAR_GAMES_CONFIG_PATH, 'utf8'));
    assert.ok(written.aliases.some(a => a.key === 'game:gta'), 'the seeds are there to edit');
    assert.ok(written.excludes.includes('name:something'));
});
