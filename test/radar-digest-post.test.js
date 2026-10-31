// Drives the real sampler, scheduler and poster with Discord stubbed out. The pure parts
// are covered in radar-digest.test.js; what is checked here is the wiring that decides
// whether anything gets posted at all, and whether it can post twice.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), `radar-digest-post-${process.pid}-`));
const GUILD = '900000000000000001';

process.env.RADAR_DIGEST_STATE_PATH = path.join(TEMP, 'state.json');
process.env.RADAR_GAMES_CONFIG_PATH = path.join(TEMP, 'radar-games.json');
process.env.LOBBY_STATE_PATH = path.join(TEMP, 'lobby.json');
process.env.VG_GUILD_ID = GUILD;
process.env.VG_RADAR_ROLE = '900000000000000010';
process.env.VG_RADAR_CHANNEL = '900000000000000011';
process.env.VG_RADAR_CALLOUT_CHANNEL = '900000000000000099';

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');

function stub(request, exports) {
    const filename = require.resolve(request);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const posted = [];
const staffLogs = [];
let channel = null;

const guild = {
    id: GUILD,
    name: 'Vice Gamers',
    presences: { cache: new Map() },
    members: { cache: new Map(), fetch: async () => null },
    channels: { fetch: async id => (channel && channel.id === id ? channel : null) }
};

function textChannel(id) {
    return {
        id,
        isTextBased: () => true,
        async send(payload) {
            posted.push(payload);
            return { id: `msg-${posted.length}` };
        }
    };
}

stub('../lib/client', { emojis: { cache: [] }, application: null, users: { fetch: async () => null } });
stub('../lib/utils', {
    resolveGuild: async id => (id === GUILD ? guild : null),
    guildLabel: () => 'Vice Gamers',
    canManageRole: () => true,
    respondWithError: async () => {}
});
stub('../lib/staff-log', {
    sendStaffLog: async (guildId, embed) => { staffLogs.push(embed); },
    errorField: () => ({ name: 'Error', value: 'e' })
});

const gameDigest = require('../lib/radar/game-digest');
const store = require('../lib/radar/game-digest/store');
const digest = require('../lib/radar/game-digest/digest');
const radar = require('../lib/radar');

after(() => fs.rmSync(TEMP, { recursive: true, force: true }));

// Sunday Nov 1 2026, 5:00 PM Eastern. The clocks went back that morning, so this is
// 22:00 UTC and not 21:00.
const SUNDAY_5PM = Date.UTC(2026, 10, 1, 22, 0);
const SATURDAY_4PM = Date.UTC(2026, 9, 31, 20, 0);
const MINUTE = 60 * 1000;

function presence(userId, { status = 'online', games = ['Fortnite'], bot = false } = {}) {
    return {
        userId,
        status,
        user: { id: userId, bot },
        activities: games.map(name => ({ type: 0, name, applicationId: null }))
    };
}

function setPresences(...entries) {
    guild.presences.cache = new Map(entries.map(entry => [entry.userId, entry]));
}

// Enough credited time for `players` to each qualify on one game inside the window.
function seedQualifyingWeek(players = ['alice', 'bob'], at = SUNDAY_5PM - 3 * 60 * MINUTE) {
    for (const player of players) {
        for (let i = 0; i < 4; i++) {
            store.credit(GUILD, at + i * 5 * MINUTE, player, 'game:fortnite', 'Fortnite', 5);
        }
    }
}

beforeEach(() => {
    posted.length = 0;
    staffLogs.length = 0;
    channel = textChannel('900000000000000099');
    guild.presences.cache = new Map();
    store._reset();
    try { fs.unlinkSync(process.env.RADAR_DIGEST_STATE_PATH); } catch {}
});

// ---------------------------------------------------------------------------
// Which guild, which channel
// ---------------------------------------------------------------------------

test('the digest runs in Vice Gamers only', () => {
    assert.deepEqual(gameDigest.digestGuildIds(), [GUILD]);
    assert.equal(gameDigest.isDigestGuild('somewhere-else'), false);
});

test('it posts to the callout channel, not the radar channel', async () => {
    seedQualifyingWeek();
    await gameDigest.maybePostWeekly(GUILD, SUNDAY_5PM);

    assert.equal(posted.length, 1);
    assert.equal(radar.calloutChannelIdFor(radar.radarConfigFor(GUILD)), '900000000000000099');
});

test('with no callout channel set it falls back to the radar channel', () => {
    assert.equal(radar.calloutChannelIdFor({ channelId: 'radar-chan' }), 'radar-chan');
    assert.equal(radar.calloutChannelIdFor({ channelId: 'radar-chan', calloutChannelId: 'chat' }), 'chat');
});

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

test('a sample credits five minutes per member per game', async () => {
    setPresences(presence('alice'), presence('bob', { games: ['Fortnite', 'GTA V'] }));

    const counts = await gameDigest.sampleGuild(GUILD, SATURDAY_4PM);

    assert.equal(counts.members, 2);
    assert.equal(counts.credits, 3, 'alice on one game, bob on two');

    const hour = String(store.hourStartFor(SATURDAY_4PM));
    assert.equal(store.guildState(GUILD).buckets[hour].bob['game:gta'], 5);
});

test('bots, offline members and anyone playing nothing are skipped', async () => {
    setPresences(
        presence('a-bot', { bot: true }),
        presence('offline-member', { status: 'offline' }),
        presence('invisible-member', { status: 'offline' }),
        presence('idle-but-playing', { status: 'idle' }),
        presence('no-game', { games: [] })
    );

    const counts = await gameDigest.sampleGuild(GUILD, SATURDAY_4PM);

    assert.equal(counts.members, 1, 'only the idle member who is actually playing');
    assert.deepEqual(
        Object.keys(store.guildState(GUILD).buckets[String(store.hourStartFor(SATURDAY_4PM))]),
        ['idle-but-playing']
    );
});

test('an excluded app is not credited even though it reports as Playing', async () => {
    setPresences(presence('alice', { games: ['Visual Studio Code'] }));

    assert.equal((await gameDigest.sampleGuild(GUILD, SATURDAY_4PM)).credits, 0);
});

test('the same five minute slot is never sampled twice', async () => {
    setPresences(presence('alice'));

    await gameDigest.runDigestTick(SATURDAY_4PM);
    await gameDigest.runDigestTick(SATURDAY_4PM + MINUTE);
    await gameDigest.runDigestTick(SATURDAY_4PM + 2 * MINUTE);

    const hour = String(store.hourStartFor(SATURDAY_4PM));
    assert.equal(store.guildState(GUILD).buckets[hour].alice['game:fortnite'], 5,
        'three ticks inside one slot credit it once');
});

test('the next slot is sampled', async () => {
    setPresences(presence('alice'));

    await gameDigest.runDigestTick(SATURDAY_4PM);
    await gameDigest.runDigestTick(SATURDAY_4PM + 5 * MINUTE);

    const hour = String(store.hourStartFor(SATURDAY_4PM));
    assert.equal(store.guildState(GUILD).buckets[hour].alice['game:fortnite'], 10);
});

// ---------------------------------------------------------------------------
// When it posts
// ---------------------------------------------------------------------------

test('nothing posts before Sunday at 5 PM', async () => {
    seedQualifyingWeek();

    await gameDigest.maybePostWeekly(GUILD, SATURDAY_4PM);
    await gameDigest.maybePostWeekly(GUILD, SUNDAY_5PM - MINUTE);

    assert.equal(posted.length, 0);
});

test('it posts on Sunday at 5 PM', async () => {
    seedQualifyingWeek();
    await gameDigest.maybePostWeekly(GUILD, SUNDAY_5PM);

    assert.equal(posted.length, 1);
    const embed = posted[0].embeds[0].toJSON();
    assert.equal(embed.title, 'What the Lounge played this week');
    assert.match(embed.description, /Fortnite · 2 players/);
});

test('a second pass in the same hour does not post again', async () => {
    seedQualifyingWeek();

    await gameDigest.maybePostWeekly(GUILD, SUNDAY_5PM);
    await gameDigest.maybePostWeekly(GUILD, SUNDAY_5PM + MINUTE);
    await gameDigest.maybePostWeekly(GUILD, SUNDAY_5PM + 3 * 60 * MINUTE);

    assert.equal(posted.length, 1);
});

test('a restart after posting does not post again', async () => {
    seedQualifyingWeek();
    await gameDigest.maybePostWeekly(GUILD, SUNDAY_5PM);
    assert.equal(posted.length, 1);

    // What a PM2 restart does: flush, lose the process, read the file back.
    store.flush();
    store._reset();

    await gameDigest.maybePostWeekly(GUILD, SUNDAY_5PM + 10 * MINUTE);
    assert.equal(posted.length, 1, 'the week is recorded on disk, not just in memory');
});

test('a post missed at 5 PM still goes out later the same Eastern day', async () => {
    seedQualifyingWeek();

    // 8:30 PM Eastern, because the bot was down at five.
    await gameDigest.maybePostWeekly(GUILD, SUNDAY_5PM + 3.5 * 60 * MINUTE);

    assert.equal(posted.length, 1);
});

test('a late post still reports the scheduled window, not the last seven days from now', async () => {
    seedQualifyingWeek();
    const report = gameDigest.buildReport(GUILD, digest.windowEndFor(SUNDAY_5PM + 3.5 * 60 * MINUTE, 'America/New_York'));

    assert.equal(report.windowEnd, SUNDAY_5PM);
});

test('after midnight Eastern the week is skipped and staff are told', async () => {
    seedQualifyingWeek();
    // Monday morning: the Sunday came and went while the bot was down.
    await gameDigest.maybePostWeekly(GUILD, SUNDAY_5PM + 20 * 60 * MINUTE);

    assert.equal(posted.length, 0, 'not posted a day late');
    assert.equal(staffLogs.length, 1);
    assert.match(staffLogs[0].title, /Missed/);
    assert.equal(store.guildState(GUILD).lastHandledWeek, '2026-11-01', 'and not chased again');
});

test('Sundays from before the feature existed are passed over quietly', async () => {
    // No samples at all, so there was nothing to report for any earlier Sunday.
    await gameDigest.maybePostWeekly(GUILD, SATURDAY_4PM);

    assert.equal(posted.length, 0);
    assert.equal(staffLogs.length, 0, 'no alarm about a week that predates any data');
});

// ---------------------------------------------------------------------------
// Empty weeks
// ---------------------------------------------------------------------------

test('the first week says it is tracking even when nothing qualifies', async () => {
    // One sample, nowhere near the 15 minute threshold.
    store.credit(GUILD, SUNDAY_5PM - 30 * MINUTE, 'alice', 'game:fortnite', 'Fortnite', 5);

    await gameDigest.maybePostWeekly(GUILD, SUNDAY_5PM);

    assert.equal(posted.length, 1);
    assert.equal(posted[0].content, digest.EMPTY_FIRST_WEEK);
    assert.deepEqual(posted[0].allowedMentions, { parse: [] });
});

test('from week two an empty week is skipped silently', async () => {
    store.credit(GUILD, SUNDAY_5PM - 30 * MINUTE, 'alice', 'game:fortnite', 'Fortnite', 5);

    // Backdate the first sample to before the window, which is what makes this week two.
    store.guildState(GUILD).firstSampleAt = SUNDAY_5PM - 30 * 24 * 60 * MINUTE;
    store.markDirty();

    await gameDigest.maybePostWeekly(GUILD, SUNDAY_5PM);

    assert.equal(posted.length, 0, 'nothing in the channel');
    assert.equal(staffLogs.length, 1, 'but staff can see why');
    assert.match(staffLogs[0].title, /Skipped/);
    assert.equal(store.guildState(GUILD).lastHandledWeek, '2026-11-01');
});

test('the first week label appears on a first week that does have games', async () => {
    seedQualifyingWeek();
    await gameDigest.maybePostWeekly(GUILD, SUNDAY_5PM);

    assert.match(posted[0].embeds[0].toJSON().description, /First week, tracking started Saturday/);
});

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

test('an unreachable channel leaves the week unposted and retryable', async () => {
    seedQualifyingWeek();
    channel = null;

    await gameDigest.maybePostWeekly(GUILD, SUNDAY_5PM);

    assert.equal(posted.length, 0);
    assert.equal(staffLogs.length, 1);
    assert.equal(store.guildState(GUILD).lastHandledWeek, null, 'not marked handled, so it tries again');

    channel = textChannel('900000000000000099');
    await gameDigest.maybePostWeekly(GUILD, SUNDAY_5PM + 30 * MINUTE);

    assert.equal(posted.length, 1, 'and it does');
});

test('a sampler failure does not stop the tick or the post', async () => {
    seedQualifyingWeek();
    guild.presences = null; // what a missing presence cache looks like

    await gameDigest.runDigestTick(SUNDAY_5PM);

    assert.equal(posted.length, 1, 'the digest still went out');
    guild.presences = { cache: new Map() };
});

// ---------------------------------------------------------------------------
// After the post
// ---------------------------------------------------------------------------

test('consumed buckets are deleted once the digest has posted', async () => {
    // Inside the window, and well before it.
    store.credit(GUILD, SUNDAY_5PM - 30 * 24 * 60 * MINUTE, 'old', 'game:fortnite', 'Fortnite', 5);
    seedQualifyingWeek();

    const before = Object.keys(store.guildState(GUILD).buckets).length;
    await gameDigest.maybePostWeekly(GUILD, SUNDAY_5PM);
    const after = Object.keys(store.guildState(GUILD).buckets).length;

    assert.ok(after < before, `expected buckets to be pruned, went from ${before} to ${after}`);
});

test('next week can say up, down or new, from aggregates with no member in them', async () => {
    seedQualifyingWeek();
    await gameDigest.maybePostWeekly(GUILD, SUNDAY_5PM);

    const carried = store.guildState(GUILD).lastResult;
    assert.equal(carried.length, 1);
    assert.deepEqual(Object.keys(carried[0]).sort(), ['hours', 'key', 'name', 'uniquePlayers']);
    assert.ok(!JSON.stringify(carried).includes('alice'), 'no member IDs are kept');
});

test('the history record is aggregates only, and queued rather than blocking the post', async () => {
    seedQualifyingWeek();
    await gameDigest.maybePostWeekly(GUILD, SUNDAY_5PM);

    const queue = store.takeApiQueue(GUILD);
    assert.equal(queue.length, 1);
    assert.equal(queue[0].community, 'vicegamers');
    assert.equal(queue[0].weekStart, '2026-11-01');
    assert.equal(queue[0].isFirstWeekPartial, true);
    assert.deepEqual(queue[0].games[0], {
        game_key: 'game:fortnite',
        display_name: 'Fortnite',
        unique_players: 2,
        total_hours: 0.7,
        rank: 1
    });
    assert.ok(!JSON.stringify(queue).includes('alice'));
});

// ---------------------------------------------------------------------------
// Mass mentions
// ---------------------------------------------------------------------------

test('the digest payload cannot parse a mass mention', async () => {
    seedQualifyingWeek();
    store.guildState(GUILD).labels['game:fortnite'] = '@everyone @here';
    store.markDirty();

    await gameDigest.maybePostWeekly(GUILD, SUNDAY_5PM);

    assert.deepEqual(posted[0].allowedMentions, { parse: [] });
});

test('a public callout cannot parse a mass mention either', async () => {
    // The phrase bank is an editable file on the server, so the guard matters even
    // though a mention inside an embed never notifies anybody.
    await radar.postRadarEmbed(GUILD, '@everyone come play', 3);

    assert.equal(posted.length, 1);
    assert.deepEqual(posted[0].allowedMentions, { parse: [] });
    assert.ok(!posted[0].content, 'and the text is in an embed, where mentions do not notify');
});
