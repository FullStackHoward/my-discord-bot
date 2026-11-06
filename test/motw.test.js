// Member of the Week, with Discord stubbed out and frozen clocks. Covers the window math,
// counting, selection and eligibility, the role transfer, and the tick's idempotency.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), `motw-${process.pid}-`));
const GUILD = '920000000000000001';
const ROLE = '920000000000000010';
const CHANNEL = '920000000000000020';
const STAFF_ROLE = '920000000000000030';
const IGNORED = '920000000000000040';
const IGNORED_MOTW = '920000000000000041';

process.env.VG_GUILD_ID = GUILD;
process.env.VG_MOTW_ROLE = ROLE;
process.env.VG_MOTW_CHANNEL = CHANNEL;
process.env.VG_STAFF_ROLE_1 = STAFF_ROLE;
process.env.VG_STAFF_USER_1 = 'staffbyid';
process.env.VICER_ADMIN = 'vicer-admin';
process.env.ACTIVITY_IGNORED_CHANNELS = IGNORED;
process.env.MOTW_IGNORED_CHANNELS = IGNORED_MOTW;
process.env.MOTW_STATE_PATH = path.join(TEMP, 'motw-state.json');
process.env.INTRO_STATE_PATH = path.join(TEMP, 'introductions-state.json');
delete process.env.MOTW_ENABLED;

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');

function stub(request, exports) {
    const filename = require.resolve(request);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

// Monday Nov 9 2026, 9:00 AM EST (14:00 UTC). The window it closes opened Monday Nov 2
// at 9:00 AM EST, the day after the clocks went back.
const BOUNDARY = Date.UTC(2026, 10, 9, 14, 0);
const WINDOW_START = Date.UTC(2026, 10, 2, 14, 0);
const WEEK_KEY = '2026-11-09';
const EARLY = Date.UTC(2026, 9, 1);
const TICK = BOUNDARY + MINUTE;

// ---------------------------------------------------------------------------
// A fake guild
// ---------------------------------------------------------------------------

const staffLogs = [];
const posted = [];
const roleCalls = [];
let directory = new Map();
let fetchErrors = new Map();
let channel = null;

function unknownMember() {
    const error = new Error('Unknown Member');
    error.code = 10007;
    return error;
}

function fakeMember(id, { roles = [], bot = false } = {}) {
    const held = new Set(roles);

    return {
        id,
        user: { id, bot },
        roles: {
            cache: { has: roleId => held.has(roleId) },
            async add(roleId) { roleCalls.push(['add', id]); held.add(roleId); },
            async remove(roleId) { roleCalls.push(['remove', id]); held.delete(roleId); }
        },
        displayAvatarURL: options => `https://cdn.example/${id}.${options?.extension || 'webp'}`
    };
}

function addMembers(...members) {
    for (const member of members) directory.set(member.id, member);
}

const role = {
    id: ROLE,
    position: 5,
    get members() {
        return new Map([...directory].filter(([, member]) => member.roles.cache.has(ROLE)));
    }
};

const guild = {
    id: GUILD,
    name: 'Vice Gamers',
    ownerId: 'server-owner',
    members: {
        cache: new Map(),
        me: { id: 'bot', roles: { highest: { position: 10 } } },
        fetch: async id => {
            if (fetchErrors.has(id)) throw fetchErrors.get(id);
            if (directory.has(id)) return directory.get(id);
            throw unknownMember();
        }
    },
    roles: { cache: new Map([[ROLE, role]]) },
    channels: {
        cache: new Map(),
        fetch: async id => (channel && channel.id === id ? channel : null)
    }
};

function textChannel(id, { fail = false } = {}) {
    return {
        id,
        isTextBased: () => true,
        async send(payload) {
            if (fail) throw new Error('Missing Access');
            posted.push(payload);
            return { id: `msg-${posted.length}` };
        }
    };
}

stub('../lib/client', {
    guilds: { cache: new Map([[GUILD, guild]]), fetch: async () => null },
    user: { id: 'bot' }
});
stub('../lib/staff-log', {
    sendStaffLog: async (guildId, embed) => { staffLogs.push(embed); },
    errorField: error => ({ name: 'Error', value: String(error?.message || error) })
});

const motw = require('../lib/motw');
const store = require('../lib/motw/store');
const windowMath = require('../lib/motw/window');
const copy = require('../lib/motw/copy');

after(() => fs.rmSync(TEMP, { recursive: true, force: true }));

beforeEach(() => {
    staffLogs.length = 0;
    posted.length = 0;
    roleCalls.length = 0;
    directory = new Map();
    fetchErrors = new Map();
    channel = textChannel(CHANNEL);
    role.position = 5;
    guild.ownerId = 'server-owner';
    motw._setEnabled(true);
    motw._resetThrottles();

    store._reset();
    for (const file of fs.readdirSync(TEMP)) fs.rmSync(path.join(TEMP, file), { force: true });

    // Counting began well before the window under test, so it is not partial.
    store.guildState(GUILD, EARLY);
});

// Sets one member's tally for the window ending WEEK_KEY.
function seed(userId, n, lastAt = WINDOW_START + HOUR) {
    const week = store.guildState(GUILD).weeks[WEEK_KEY] || (store.guildState(GUILD).weeks[WEEK_KEY] = {});
    week[userId] = { n, lastAt };
}

function message(authorId, createdTimestamp, { channelId = 'general', bot = false, webhookId = null, system = false, thread = null, guildId = GUILD } = {}) {
    return {
        guild: guildId ? { id: guildId } : null,
        author: { id: authorId, bot },
        webhookId,
        system,
        channelId,
        createdTimestamp,
        channel: thread ? { isThread: () => true, parentId: thread } : { isThread: () => false }
    };
}

// ---------------------------------------------------------------------------
// Window math
// ---------------------------------------------------------------------------

test('window: the window ending 2026-11-02 9:00 EST is 169 hours long', () => {
    const end = Date.UTC(2026, 10, 2, 14, 0);
    const window = windowMath.windowFor(end - 1);

    assert.equal(window.end, end);
    assert.equal((window.end - window.start) / HOUR, 169);
    assert.equal(window.key, '2026-11-02');
});

test('window: the window ending 2027-03-15 9:00 EDT is 167 hours long', () => {
    const end = Date.UTC(2027, 2, 15, 13, 0);
    const window = windowMath.windowFor(end - 1);

    assert.equal(window.end, end);
    assert.equal((window.end - window.start) / HOUR, 167);
    assert.equal(window.key, '2027-03-15');
});

test('window: boundary minus 1 ms is in the ending window, the boundary itself in the next', () => {
    assert.equal(windowMath.windowFor(BOUNDARY - 1).key, WEEK_KEY);
    assert.equal(windowMath.windowFor(BOUNDARY).start, BOUNDARY);
    assert.equal(windowMath.windowFor(BOUNDARY).key, '2026-11-16');
});

test('window: boundary minus 30 s does not skip the boundary (the nextWeeklyOccurrence trap)', () => {
    const window = windowMath.windowFor(BOUNDARY - 30 * 1000);

    assert.equal(window.end, BOUNDARY);
    assert.equal(window.key, WEEK_KEY);
    assert.equal(windowMath.latestBoundaryAtOrBefore(BOUNDARY - 30 * 1000), WINDOW_START);
});

test('window: the ended window at 9:01 Monday is the one just closed', () => {
    const ended = windowMath.endedWindowFor(TICK);
    assert.deepEqual([ended.start, ended.end, ended.key], [WINDOW_START, BOUNDARY, WEEK_KEY]);
});

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

test('counting: credited by createdTimestamp, with the activity guards', () => {
    const at = WINDOW_START + 2 * HOUR;

    motw.handleMessageCreate(message('alice', at));
    motw.handleMessageCreate(message('alice', at + MINUTE));
    motw.handleMessageCreate(message('alice', BOUNDARY)); // the next window
    motw.handleMessageCreate(message('robot', at, { bot: true }));
    motw.handleMessageCreate(message('hook', at, { webhookId: 'w' }));
    motw.handleMessageCreate(message('sys', at, { system: true }));
    motw.handleMessageCreate(message('ign', at, { channelId: IGNORED }));
    motw.handleMessageCreate(message('ign2', at, { channelId: IGNORED_MOTW }));
    motw.handleMessageCreate(message('thr', at, { channelId: 'thread', thread: IGNORED_MOTW }));
    motw.handleMessageCreate(message('dm', at, { guildId: null }));
    motw.handleMessageCreate(message('elsewhere', at, { guildId: 'other-guild' }));

    const weeks = store.guildState(GUILD).weeks;
    assert.deepEqual(weeks[WEEK_KEY], { alice: { n: 2, lastAt: at + MINUTE } });
    assert.deepEqual(weeks['2026-11-16'], { alice: { n: 1, lastAt: BOUNDARY } });
});

test('counting: a leaver is dropped from every retained week', () => {
    seed('alice', 3);
    store.guildState(GUILD).weeks['2026-11-16'] = { alice: { n: 1, lastAt: BOUNDARY } , bob: { n: 1, lastAt: BOUNDARY } };

    motw.handleGuildMemberRemove({ id: 'alice', guild: { id: GUILD } });

    assert.equal(store.guildState(GUILD).weeks[WEEK_KEY].alice, undefined);
    assert.deepEqual(Object.keys(store.guildState(GUILD).weeks['2026-11-16']), ['bob']);
});

// ---------------------------------------------------------------------------
// Ranking and selection
// ---------------------------------------------------------------------------

test('ranking: higher count, then earlier lastAt, then lower user ID', () => {
    const ranked = motw.rankEntries({
        '200': { n: 5, lastAt: 10 },
        '100': { n: 5, lastAt: 10 },
        '300': { n: 5, lastAt: 5 },
        '400': { n: 9, lastAt: 99 },
        '99': { n: 5, lastAt: 10 }
    });

    assert.deepEqual(ranked.map(e => e.userId), ['400', '300', '99', '100', '200']);
});

test('selection: a departed top member is skipped', async () => {
    addMembers(fakeMember('bob'), fakeMember('carol'));
    seed('ghost', 50);
    seed('bob', 20);
    seed('carol', 10);

    const selection = await motw.selectWinner(guild, store.guildState(GUILD).weeks[WEEK_KEY]);

    assert.equal(selection.winner.userId, 'bob');
    assert.equal(selection.runnerUp.userId, 'carol');
    assert.equal(selection.lead, 10);
    assert.equal(selection.considered[0].status, 'departed');
});

test('selection: a fetch error that is not Unknown Member aborts and leaves the week unhandled', async () => {
    addMembers(fakeMember('bob'));
    seed('flaky', 50);
    seed('bob', 20);
    fetchErrors.set('flaky', Object.assign(new Error('Service Unavailable'), { code: 0 }));

    assert.equal(await motw.runGuildTick(GUILD, TICK), 'aborted');
    assert.equal(posted.length, 0);
    assert.notEqual(store.guildState(GUILD).lastHandledWeek, WEEK_KEY);

    fetchErrors.clear();
    addMembers(fakeMember('flaky'));
    assert.equal(await motw.runGuildTick(GUILD, TICK + MINUTE), 'posted');
    assert.match(posted[0].embeds[0].data.description, /<@flaky>/);
});

for (const [label, setup, id] of [
    ['a bot', () => addMembers(fakeMember('botty', { bot: true })), 'botty'],
    ['the server owner', () => addMembers(fakeMember('server-owner')), 'server-owner'],
    ['VICER_ADMIN', () => addMembers(fakeMember('vicer-admin')), 'vicer-admin'],
    ['staff matched by user ID', () => addMembers(fakeMember('staffbyid')), 'staffbyid'],
    ['staff matched by role', () => addMembers(fakeMember('staffbyrole', { roles: [STAFF_ROLE] })), 'staffbyrole']
]) {
    test(`eligibility: ${label} is never chosen`, async () => {
        setup();
        addMembers(fakeMember('alice'));
        seed(id, 100);
        seed('alice', 3);

        const selection = await motw.selectWinner(guild, store.guildState(GUILD).weeks[WEEK_KEY]);

        assert.equal(selection.winner.userId, 'alice');
        assert.equal(selection.runnerUp, null);
        assert.notEqual(selection.considered[0].status, 'eligible');
    });
}

test('eligibility: top staff is neither winner nor runner-up, and the lead skips them', async () => {
    addMembers(fakeMember('staffbyrole', { roles: [STAFF_ROLE] }), fakeMember('alice'), fakeMember('bob'));
    seed('alice', 40);
    seed('staffbyrole', 35);
    seed('bob', 10);

    const selection = await motw.selectWinner(guild, store.guildState(GUILD).weeks[WEEK_KEY]);

    assert.equal(selection.winner.userId, 'alice');
    assert.equal(selection.runnerUp.userId, 'bob');
    assert.equal(selection.lead, 30);
});

test('wording: lead, tie and no runner-up', () => {
    assert.equal(
        copy.description({ winnerId: 'a', count: 12, hasRunnerUp: true, lead: 1 }),
        'Congratulations to <@a> for being the most active member this week with **12 messages**! They were **1 message** ahead of the runner-up!'
    );
    assert.match(copy.description({ winnerId: 'a', count: 5, hasRunnerUp: true, lead: 0 }), /tied the runner-up on messages and got there first\.$/);
    assert.equal(
        copy.description({ winnerId: 'a', count: 1, hasRunnerUp: false, lead: 1 }),
        'Congratulations to <@a> for being the most active member this week with **1 message**!'
    );
});

test('no winner: everyone in the running is staff or owner, so nothing posts and the role stays', async () => {
    addMembers(fakeMember('server-owner'), fakeMember('staffbyid'), fakeMember('holder', { roles: [ROLE] }));
    store.guildState(GUILD).currentHolderId = 'holder';
    seed('server-owner', 30);
    seed('staffbyid', 20);

    assert.equal(await motw.runGuildTick(GUILD, TICK), 'no-winner');
    assert.equal(posted.length, 0);
    assert.equal(roleCalls.length, 0);
    assert.equal(store.guildState(GUILD).lastHandledWeek, WEEK_KEY);
    assert.match(staffLogs[0].title, /No Winner/);
});

test('no winner: an empty week posts nothing, leaves the role, and is handled', async () => {
    assert.equal(await motw.runGuildTick(GUILD, TICK), 'no-winner');
    assert.equal(posted.length, 0);
    assert.equal(roleCalls.length, 0);
    assert.equal(store.guildState(GUILD).lastHandledWeek, WEEK_KEY);
});

// ---------------------------------------------------------------------------
// The announcement and the role transfer
// ---------------------------------------------------------------------------

test('posting: avatar thumbnail, the winner pinged and nobody else, footer', async () => {
    addMembers(fakeMember('alice'), fakeMember('bob'));
    seed('alice', 12);
    seed('bob', 5);

    assert.equal(await motw.runGuildTick(GUILD, TICK), 'posted');

    const payload = posted[0];
    const embed = payload.embeds[0].data;
    assert.equal(payload.content, '<@alice>');
    assert.deepEqual(payload.allowedMentions, { parse: [], users: ['alice'], roles: [] });
    assert.equal(embed.title, copy.TITLE);
    assert.equal(embed.color, copy.COLOR);
    assert.equal(embed.thumbnail.url, 'https://cdn.example/alice.png');
    assert.equal(embed.footer.text, copy.FOOTER);
    assert.match(embed.description, /\*\*7 messages\*\* ahead/);

    const last = store.guildState(GUILD).lastResult;
    assert.deepEqual([last.winnerId, last.count, last.runnerUpId, last.lead, last.messageId], ['alice', 12, 'bob', 7, 'msg-1']);
});

test('posting: a window that started before counting began is labeled partial', async () => {
    store.guildState(GUILD).trackingStartedAt = WINDOW_START + 3 * 24 * HOUR;
    addMembers(fakeMember('alice'));
    seed('alice', 3, WINDOW_START + 4 * 24 * HOUR);

    await motw.runGuildTick(GUILD, TICK);
    assert.equal(posted[0].embeds[0].data.footer.text, copy.PARTIAL_FOOTER);
});

test('role: added to the winner before anyone loses it, previous and extra holders removed', async () => {
    addMembers(
        fakeMember('alice'),
        fakeMember('previous', { roles: [ROLE] }),
        fakeMember('manual', { roles: [ROLE] })
    );
    store.guildState(GUILD).currentHolderId = 'previous';
    seed('alice', 12);

    await motw.runGuildTick(GUILD, TICK);

    assert.deepEqual(roleCalls[0], ['add', 'alice']);
    assert.deepEqual(roleCalls.slice(1).sort(), [['remove', 'manual'], ['remove', 'previous']]);
    assert.equal(store.guildState(GUILD).currentHolderId, 'alice');
    assert.equal(directory.get('previous').roles.cache.has(ROLE), false);
});

test('role: a departed previous holder is skipped quietly', async () => {
    addMembers(fakeMember('alice'));
    store.guildState(GUILD).currentHolderId = 'long-gone';
    seed('alice', 12);

    await motw.runGuildTick(GUILD, TICK);

    assert.deepEqual(roleCalls, [['add', 'alice']]);
    const roleField = staffLogs.at(-1).fields.find(f => f.name === 'Role');
    assert.match(roleField.value, /has left the server/);
    assert.doesNotMatch(roleField.value, /⚠️/);
});

test('role: when the bot cannot manage the role, the post still goes out and no role changes', async () => {
    role.position = 20; // above the bot's highest role
    addMembers(fakeMember('alice'), fakeMember('previous', { roles: [ROLE] }));
    store.guildState(GUILD).currentHolderId = 'previous';
    seed('alice', 12);

    assert.equal(await motw.runGuildTick(GUILD, TICK), 'posted');
    assert.equal(posted.length, 1);
    assert.equal(roleCalls.length, 0);
    assert.equal(store.guildState(GUILD).currentHolderId, 'previous');
    assert.equal(store.guildState(GUILD).lastHandledWeek, WEEK_KEY);
});

test('role: a winner who already holds it keeps it and nothing is re-added', async () => {
    addMembers(fakeMember('alice', { roles: [ROLE] }));
    store.guildState(GUILD).currentHolderId = 'alice';
    seed('alice', 12);

    await motw.runGuildTick(GUILD, TICK);
    assert.deepEqual(roleCalls, []);
});

// ---------------------------------------------------------------------------
// Idempotency and tracking-only
// ---------------------------------------------------------------------------

test('idempotency: a second tick for a handled week does nothing', async () => {
    addMembers(fakeMember('alice'));
    seed('alice', 12);

    assert.equal(await motw.runGuildTick(GUILD, TICK), 'posted');
    assert.equal(await motw.runGuildTick(GUILD, TICK + MINUTE), 'already-handled');
    assert.equal(await motw.runGuildTick(GUILD, BOUNDARY + 3 * 24 * HOUR), 'already-handled');
    assert.equal(posted.length, 1);
});

test('idempotency: a failed send leaves the week unhandled, logs once, and the next tick retries', async () => {
    addMembers(fakeMember('alice'));
    seed('alice', 12);
    channel = textChannel(CHANNEL, { fail: true });

    assert.equal(await motw.runGuildTick(GUILD, TICK), 'post-failed');
    assert.equal(await motw.runGuildTick(GUILD, TICK + MINUTE), 'post-failed');
    assert.notEqual(store.guildState(GUILD).lastHandledWeek, WEEK_KEY);
    assert.equal(staffLogs.filter(log => /Could Not Post/.test(log.title)).length, 1);
    assert.equal(roleCalls.length, 0);

    channel = textChannel(CHANNEL);
    assert.equal(await motw.runGuildTick(GUILD, TICK + 2 * MINUTE), 'posted');
    assert.equal(posted.length, 1);
});

test('idempotency: a missing channel leaves the week unhandled', async () => {
    addMembers(fakeMember('alice'));
    seed('alice', 12);
    channel = null;

    assert.equal(await motw.runGuildTick(GUILD, TICK), 'channel-missing');
    assert.notEqual(store.guildState(GUILD).lastHandledWeek, WEEK_KEY);
});

test('tracking-only: posts nothing, changes no role, writes the rehearsal and marks the week handled', async () => {
    motw._setEnabled(false);
    addMembers(fakeMember('alice'), fakeMember('mee6-holder', { roles: [ROLE] }));
    seed('alice', 12);

    assert.equal(await motw.runGuildTick(GUILD, TICK), 'tracking-only');
    assert.equal(posted.length, 0);
    assert.equal(roleCalls.length, 0);
    assert.equal(store.guildState(GUILD).lastHandledWeek, WEEK_KEY);

    const rehearsal = staffLogs.at(-1);
    assert.match(rehearsal.title, /Tracking Only/);
    assert.match(rehearsal.fields.find(f => f.name === 'Role').value, /Would be taken from <@mee6-holder>/);
});

test('first deploy: a window that closed before counting began is handled silently', async () => {
    store._reset();
    fs.rmSync(process.env.MOTW_STATE_PATH, { force: true });
    store.guildState(GUILD, TICK + 2 * 24 * HOUR); // counting began mid-week

    assert.equal(await motw.runGuildTick(GUILD, TICK + 2 * 24 * HOUR), 'predates-tracking');
    assert.equal(staffLogs.length, 0);
    assert.equal(store.guildState(GUILD).lastHandledWeek, WEEK_KEY);
});

test('missed week: an older unhandled window is logged once and not posted late', async () => {
    store.guildState(GUILD).lastHandledWeek = '2026-10-26';
    addMembers(fakeMember('alice'));
    seed('alice', 12);

    await motw.runGuildTick(GUILD, TICK);

    const missed = staffLogs.filter(log => /Missed/.test(log.title));
    assert.equal(missed.length, 1);
    assert.match(missed[0].description, /2026-11-02/);
    assert.equal(posted.length, 1);
});

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

test('state: written atomically and reloaded', () => {
    store.countMessage(GUILD, WEEK_KEY, 'alice', WINDOW_START + HOUR);
    store.flush();

    assert.equal(fs.existsSync(`${process.env.MOTW_STATE_PATH}.tmp`), false);

    store._reset();
    assert.deepEqual(store.guildState(GUILD).weeks[WEEK_KEY].alice, { n: 1, lastAt: WINDOW_START + HOUR });
});

test('state: a corrupt file is quarantined and a fresh state starts', () => {
    fs.writeFileSync(process.env.MOTW_STATE_PATH, '{ broken');
    store._reset();

    assert.deepEqual(store.guildState(GUILD, EARLY).weeks, {});
    const moved = fs.readdirSync(TEMP).filter(name => name.startsWith('motw-state.json.corrupt-'));
    assert.equal(moved.length, 1);
});

test('state: only the newest weeks are retained', () => {
    const weeks = store.guildState(GUILD).weeks;
    for (const key of ['2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16']) weeks[key] = { a: { n: 1, lastAt: 1 } };

    assert.equal(store.pruneWeeks(GUILD), 2);
    assert.deepEqual(Object.keys(weeks).sort(), ['2026-11-02', '2026-11-09', '2026-11-16']);
});

test('the /motw definition fits Discord\'s limits, or registration fails for the whole server', () => {
    const { MOTW_COMMAND } = require('../lib/motw/command');

    assert.ok(MOTW_COMMAND.description.length <= 100);
    for (const option of MOTW_COMMAND.options) assert.ok(option.description.length <= 100, option.name);
});
