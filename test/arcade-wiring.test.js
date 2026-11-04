// The arcade's wiring, with Discord and the API stubbed out.
//
// The pure embed builders are covered in arcade-posts.test.js. What is checked here is
// the behaviour that only shows up under failure: what happens when the API is
// unreachable, when the member list comes back short, when a winner leaves between the
// round closing and the callout, and when a handler throws.
//
// The through-line in all of it: failing to notice a departure leaves a stale name on a
// board for a while, but wrongly concluding somebody left wipes a real player's scores.
// Every uncertain case has to resolve towards doing nothing.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), `arcade-${process.pid}-`));
const GUILD = '800000000000000001';
const ARCADE_CHANNEL = '800000000000000011';
const CHAT_CHANNEL = '800000000000000012';
const GOLD = '800000000000000021';
const SILVER = '800000000000000022';
const BRONZE = '800000000000000023';

process.env.ARCADE_STATE_PATH = path.join(TEMP, 'arcade-state.json');
process.env.VG_GUILD_ID = GUILD;
process.env.VG_ARCADE_CHANNEL_ID = ARCADE_CHANNEL;
process.env.VG_CHAT_CHANNEL_ID = CHAT_CHANNEL;
process.env.VG_ARCADE_ROLE_GOLD_ID = GOLD;
process.env.VG_ARCADE_ROLE_SILVER_ID = SILVER;
process.env.VG_ARCADE_ROLE_BRONZE_ID = BRONZE;
process.env.VG_STAFF_USER_1 = '800000000000000099';

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');

function stub(request, exports) {
    const filename = require.resolve(request);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

let guild = null;
const staffLogs = [];

stub('../lib/client', {
    guilds: { cache: { get: () => guild }, fetch: async () => guild },
    channels: { fetch: async (id) => channels.get(id) || null },
    users: { fetch: async () => ({ send: async () => {} }) }
});

stub('../lib/staff-log', {
    sendStaffLog: async (guildId, entry) => { staffLogs.push({ guildId, ...entry }); },
    sendStaffLogToAllServers: async () => {},
    errorField: () => ({})
});

const apiCalls = [];
let apiBehaviour = {};

function apiStub(name, fallback) {
    return async (...args) => {
        apiCalls.push({ name, args });

        const behaviour = apiBehaviour[name];

        if (typeof behaviour === 'function') return behaviour(...args);
        if (behaviour instanceof Error) throw behaviour;
        if (behaviour !== undefined) return behaviour;

        return fallback;
    };
}

class StubApiError extends Error {
    constructor(message, status = 0) {
        super(message);
        this.status = status;
        this.answered = status > 0;
    }
}

stub('../lib/arcade/api', {
    ArcadeApiError: StubApiError,
    pendingEvents: apiStub('pendingEvents', { events: [] }),
    ackEvent: apiStub('ackEvent', null),
    currentPodium: apiStub('currentPodium', { holders: [] }),
    liveStandings: apiStub('liveStandings', { standings: [] }),
    closingSeasons: apiStub('closingSeasons', { seasons: [] }),
    seasonPreview: apiStub('seasonPreview', { top: [] }),
    finalizeSeason: apiStub('finalizeSeason', { announced: true }),
    dailyBoard: apiStub('dailyBoard', { entries: [] }),
    recordPostedMessages: apiStub('recordPostedMessages', null),
    removeScore: apiStub('removeScore', null),
    reportDepartures: apiStub('reportDepartures', { processed: 0, scores_removed: 0, boards_changed: 0 }),
    activePlayers: apiStub('activePlayers', { discord_user_ids: [] })
});

const channels = new Map();
const sentTo = new Map();

function makeChannel(id) {
    const sent = [];
    sentTo.set(id, sent);

    return {
        id,
        isTextBased: () => true,
        send: async (payload) => {
            sent.push(payload);
            return { id: `msg-${sent.length}`, edit: async () => {}, delete: async () => {} };
        },
        messages: { fetch: async () => ({ edit: async () => {}, delete: async () => {} }) }
    };
}

// Roles the bot can manage sit below position 100; the bot's own highest role is 100.
function makeGuild({ memberIds = [], roleHolders = {}, unmanageable = [], memberCount = null } = {}) {
    const members = new Map();

    for (const id of memberIds) {
        members.set(id, {
            id,
            roles: {
                cache: new Map(),
                add: async (roleId) => { roleAdds.push({ id, roleId }); },
                remove: async (roleId) => { roleRemoves.push({ id, roleId }); }
            }
        });
    }

    const roles = new Map();

    for (const roleId of [GOLD, SILVER, BRONZE]) {
        const holders = new Map(
            (roleHolders[roleId] || []).map(id => [id, members.get(id) || {
                id,
                roles: { remove: async (rid) => { roleRemoves.push({ id, roleId: rid }); } }
            }])
        );

        roles.set(roleId, {
            id: roleId,
            name: `role-${roleId}`,
            position: unmanageable.includes(roleId) ? 200 : 10,
            members: holders
        });
    }

    return {
        id: GUILD,
        name: 'Vice Gamers',
        memberCount: memberCount === null ? memberIds.length : memberCount,
        members: {
            cache: members,
            fetch: async (id) => {
                if (id === undefined) return members;

                const found = members.get(id);
                if (found) return found;

                const error = new Error('Unknown Member');
                error.code = 10007;
                throw error;
            },
            me: { roles: { highest: { position: 100 } } }
        },
        roles: { cache: roles }
    };
}

let roleAdds = [];
let roleRemoves = [];

const arcade = require('../lib/arcade');
const departures = require('../lib/arcade/departures');
const roles = require('../lib/arcade/roles');
const api = require('../lib/arcade/api');

beforeEach(() => {
    apiCalls.length = 0;
    apiBehaviour = {};
    staffLogs.length = 0;
    roleAdds = [];
    roleRemoves = [];
    channels.clear();
    sentTo.clear();
    channels.set(ARCADE_CHANNEL, makeChannel(ARCADE_CHANNEL));
    channels.set(CHAT_CHANNEL, makeChannel(CHAT_CHANNEL));
    guild = makeGuild({ memberIds: ['a', 'b', 'c'] });

    try { fs.unlinkSync(process.env.ARCADE_STATE_PATH); } catch { /* first run */ }
});

after(() => {
    arcade.stop();
    try { fs.rmSync(TEMP, { recursive: true, force: true }); } catch { /* best effort */ }
});

function called(name) {
    return apiCalls.filter(call => call.name === name);
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

test('the arcade is on for Vice Gamers and nowhere else', () => {
    assert.equal(arcade.isEnabled(), true);
    assert.ok(arcade.arcadeConfigFor(GUILD));
    assert.equal(arcade.arcadeConfigFor('900000000000000000'), null, 'no Vice Creators arcade');
});

// ---------------------------------------------------------------------------
// Departures
// ---------------------------------------------------------------------------

test('a departing Vice Gamers member is reported at once', async () => {
    await departures.handleGuildMemberRemove({ id: 'gone', guild: { id: GUILD } });

    const reported = called('reportDepartures');
    assert.equal(reported.length, 1);
    assert.equal(reported[0].args[0][0].discord_user_id, 'gone');
});

test('leaving another server changes nothing', async () => {
    await departures.handleGuildMemberRemove({ id: 'gone', guild: { id: '900000000000000000' } });

    assert.equal(called('reportDepartures').length, 0);
});

test('a report that cannot be delivered is queued and retried, because the event happens once', async () => {
    apiBehaviour.reportDepartures = new StubApiError('socket hang up');

    await departures.handleGuildMemberRemove({ id: 'gone', guild: { id: GUILD } });
    assert.equal(called('reportDepartures').length, 1);

    apiBehaviour.reportDepartures = { processed: 1, scores_removed: 2, boards_changed: 0 };
    const flushed = await departures.flushQueue();

    assert.equal(flushed.reported, 1);
    assert.equal(called('reportDepartures').length, 2);
    assert.equal(called('reportDepartures')[1].args[0][0].discord_user_id, 'gone');
});

test('an empty queue costs nothing', async () => {
    const flushed = await departures.flushQueue();

    assert.deepEqual(flushed, { reported: 0, queued: 0 });
    assert.equal(called('reportDepartures').length, 0);
});

test('the sweep reports only players the server no longer has', async () => {
    apiBehaviour.activePlayers = { discord_user_ids: ['a', 'b', 'ghost'] };

    const result = await departures.runSweep();

    assert.equal(result.aborted, false);
    assert.deepEqual(result.departed, ['ghost']);
    assert.deepEqual(called('reportDepartures')[0].args[0].map(e => e.discord_user_id), ['ghost']);
});

test('a short member list abandons the sweep and wipes nobody', async () => {
    // The API shows three players and the guild claims a thousand members, but only
    // three came back. Every current member would look departed.
    guild = makeGuild({ memberIds: ['a', 'b', 'c'], memberCount: 1000 });
    apiBehaviour.activePlayers = { discord_user_ids: ['a', 'b', 'c'] };

    const result = await departures.runSweep();

    assert.equal(result.aborted, true);
    assert.match(result.reason, /came back short/);
    assert.match(result.reason, /wipe real scores/);
    assert.equal(called('reportDepartures').length, 0, 'and nothing was removed');
});

test('an unreadable api abandons the sweep rather than assuming nobody is playing', async () => {
    apiBehaviour.activePlayers = new StubApiError('timeout');

    const result = await departures.runSweep();

    assert.equal(result.aborted, true);
    assert.equal(called('reportDepartures').length, 0);
});

test('a dry run finds the departed without removing them', async () => {
    apiBehaviour.activePlayers = { discord_user_ids: ['a', 'ghost'] };

    const result = await departures.runSweep({ dryRun: true });

    assert.deepEqual(result.departed, ['ghost']);
    assert.equal(called('reportDepartures').length, 0);
});

test('a sweep with nothing on the boards does nothing at all', async () => {
    apiBehaviour.activePlayers = { discord_user_ids: [] };

    const result = await departures.runSweep();

    assert.equal(result.aborted, false);
    assert.deepEqual(result.departed, []);
});

// ---------------------------------------------------------------------------
// The winner check
// ---------------------------------------------------------------------------

test('winners still in the server are confirmed and the round can be finalized', async () => {
    const checked = await departures.confirmWinners([
        { place: 1, discord_user_id: 'a', display_name: 'A', average_placement: 1 },
        { place: 2, discord_user_id: 'b', display_name: 'B', average_placement: 2 }
    ]);

    assert.equal(checked.ready, true);
    assert.deepEqual(checked.winners.map(w => w.discord_user_id), ['a', 'b']);
    assert.deepEqual(checked.departed, []);
});

test('a winner who left is reported and the round is not finalized on that pass', async () => {
    const checked = await departures.confirmWinners([
        { place: 1, discord_user_id: 'ghost', display_name: 'Ghost', average_placement: 1 },
        { place: 2, discord_user_id: 'a', display_name: 'A', average_placement: 2 }
    ]);

    assert.equal(checked.ready, false, 'so the next pass previews a different three');
    assert.deepEqual(checked.departed, ['ghost']);
    assert.deepEqual(called('reportDepartures')[0].args[0].map(e => e.discord_user_id), ['ghost']);
});

test('a discord outage during the winner check wipes nobody and finalizes nothing', async () => {
    guild = {
        ...makeGuild({ memberIds: ['a'] }),
        members: {
            cache: new Map(),
            fetch: async () => { throw new Error('ETIMEDOUT'); },
            me: { roles: { highest: { position: 100 } } }
        }
    };

    const checked = await departures.confirmWinners([
        { place: 1, discord_user_id: 'a', display_name: 'A', average_placement: 1 }
    ]);

    assert.equal(checked.ready, false);
    assert.deepEqual(checked.departed, [], 'a timeout is not a departure');
    assert.deepEqual(checked.unresolved, ['a']);
    assert.equal(called('reportDepartures').length, 0);
});

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

test('the podium roles are made to match the standings', async () => {
    await roles.applyHolders(guild, [
        { place: 1, discord_user_id: 'a' },
        { place: 2, discord_user_id: 'b' },
        { place: 3, discord_user_id: 'c' }
    ]);

    assert.deepEqual(roleAdds, [
        { id: 'a', roleId: GOLD },
        { id: 'b', roleId: SILVER },
        { id: 'c', roleId: BRONZE }
    ]);
});

test('a role is taken off whoever should not have it', async () => {
    guild = makeGuild({ memberIds: ['a', 'b'], roleHolders: { [GOLD]: ['b'] } });

    await roles.applyHolders(guild, [{ place: 1, discord_user_id: 'a' }]);

    assert.deepEqual(roleRemoves, [{ id: 'b', roleId: GOLD }]);
    assert.deepEqual(roleAdds, [{ id: 'a', roleId: GOLD }]);
});

test('an empty board takes all three roles off, which is what a reset does', async () => {
    guild = makeGuild({
        memberIds: ['a', 'b', 'c'],
        roleHolders: { [GOLD]: ['a'], [SILVER]: ['b'], [BRONZE]: ['c'] }
    });

    await roles.applyHolders(guild, []);

    assert.deepEqual(roleRemoves.map(r => r.roleId).sort(), [GOLD, SILVER, BRONZE].sort());
    assert.deepEqual(roleAdds, []);
});

test('a holder who keeps their place is not touched', async () => {
    guild = makeGuild({ memberIds: ['a'], roleHolders: { [GOLD]: ['a'] } });

    await roles.applyHolders(guild, [{ place: 1, discord_user_id: 'a' }]);

    assert.deepEqual(roleAdds, []);
    assert.deepEqual(roleRemoves, []);
});

test('a player holds at most one of the three', async () => {
    guild = makeGuild({ memberIds: ['a'], roleHolders: { [SILVER]: ['a'], [BRONZE]: ['a'] } });

    await roles.applyHolders(guild, [{ place: 1, discord_user_id: 'a' }]);

    assert.deepEqual(roleAdds, [{ id: 'a', roleId: GOLD }]);
    assert.deepEqual(
        roleRemoves.map(r => r.roleId).sort(),
        [BRONZE, SILVER].sort(),
        'the lower two come off'
    );
});

test('a role above the bot is left alone rather than attempted every pass', async () => {
    guild = makeGuild({ memberIds: ['a'], unmanageable: [GOLD] });

    await roles.applyHolders(guild, [{ place: 1, discord_user_id: 'a' }]);

    assert.deepEqual(roleAdds, [], 'nothing is attempted on a role it cannot manage');
});

test('an unreachable api leaves every role exactly as it is', async () => {
    guild = makeGuild({ memberIds: ['a'], roleHolders: { [GOLD]: ['a'] } });
    apiBehaviour.currentPodium = new StubApiError('timeout');

    const result = await roles.reconcile(api);

    assert.equal(result.skipped, 'api unreachable');
    assert.deepEqual(roleAdds, []);
    assert.deepEqual(roleRemoves, [], 'an outage is not an empty podium');
});

// ---------------------------------------------------------------------------
// The poll
// ---------------------------------------------------------------------------

const client = require('../lib/client');

function event(type, payload = {}, id = 1) {
    return { id, type, payload, created_at: new Date().toISOString() };
}

test('a handled event is acked', async () => {
    apiBehaviour.pendingEvents = {
        events: [event('new_alltime_record', {
            game_display_name: 'Vetrix', display_name: 'A', score: 10, previous_best: 5,
            previous_holder: 'b', score_id: 3
        }, 11)]
    };

    await arcade.runPass(client);

    assert.equal(called('ackEvent')[0].args[0], 11);
    assert.equal(sentTo.get(ARCADE_CHANNEL).length, 1, 'and the record was posted');
});

test('an event whose handler fails is left unacked so it is retried', async () => {
    apiBehaviour.pendingEvents = { events: [event('daily_board_closed', { game_slug: 'vetrix', day: '2026-11-10' }, 12)] };
    apiBehaviour.dailyBoard = new StubApiError('timeout');

    await arcade.runPass(client);

    assert.equal(called('ackEvent').length, 0);
});

test('an unknown event type is left pending rather than dropped', async () => {
    apiBehaviour.pendingEvents = { events: [event('something_new', {}, 13)] };

    await arcade.runPass(client);

    assert.equal(called('ackEvent').length, 0, 'acking it would lose whatever it was');
});

test('a closed round is not finalized while a winner is unaccounted for', async () => {
    apiBehaviour.pendingEvents = { events: [event('season_closing', { season_id: 5 }, 14)] };
    apiBehaviour.seasonPreview = {
        top: [{ place: 1, discord_user_id: 'ghost', display_name: 'Ghost', average_placement: 1 }]
    };

    await arcade.runPass(client);

    assert.equal(called('finalizeSeason').length, 0);
    assert.equal(called('ackEvent').length, 0, 'the event comes round again with fresh standings');
    assert.equal(called('reportDepartures').length, 1, 'and the leaver is reported');
});

test('a closed round with its winners present is finalized once', async () => {
    apiBehaviour.pendingEvents = { events: [event('season_closing', { season_id: 6 }, 15)] };
    apiBehaviour.seasonPreview = {
        top: [{ place: 1, discord_user_id: 'a', display_name: 'A', average_placement: 1 }]
    };

    await arcade.runPass(client);

    assert.equal(called('finalizeSeason').length, 1);
    assert.equal(called('finalizeSeason')[0].args[0], 6);
    assert.equal(called('ackEvent')[0].args[0], 15);
});

test('a round nobody played is finalized with no winners and no callout', async () => {
    apiBehaviour.pendingEvents = { events: [event('season_closing', { season_id: 7 }, 16)] };
    apiBehaviour.seasonPreview = { top: [] };

    await arcade.runPass(client);

    assert.deepEqual(called('finalizeSeason')[0].args[1], []);
    assert.equal(sentTo.get(CHAT_CHANNEL).length, 0);
});

test('the round callout goes to chat, not to the arcade channel', async () => {
    apiBehaviour.pendingEvents = {
        events: [event('season_awarded', {
            winners: [{ place: 1, discord_user_id: 'a', display_name: 'A', average_placement: 1 }],
            revision: 1
        }, 17)]
    };

    await arcade.runPass(client);

    assert.equal(sentTo.get(CHAT_CHANNEL).length, 1);
    assert.equal(sentTo.get(ARCADE_CHANNEL).length, 0);
    assert.deepEqual(sentTo.get(CHAT_CHANNEL)[0].allowedMentions, { users: ['a'] });
});

test('a corrected result posts a correction rather than a second callout', async () => {
    apiBehaviour.pendingEvents = {
        events: [event('season_awarded', {
            winners: [{ place: 1, discord_user_id: 'a', display_name: 'A', average_placement: 1 }],
            revision: 2,
            corrected: true
        }, 18)]
    };

    await arcade.runPass(client);

    const posted = sentTo.get(CHAT_CHANNEL)[0];
    assert.match(posted.embeds[0].data.title, /corrected/i);
    assert.deepEqual(posted.allowedMentions, { parse: [] });
});

test('a posted daily board records the message ids it was posted as', async () => {
    apiBehaviour.pendingEvents = { events: [event('daily_board_closed', { game_slug: 'vetrix', day: '2026-11-10' }, 19)] };
    apiBehaviour.dailyBoard = {
        board_id: 44,
        game: { display_name: 'Vetrix' },
        day: '2026-11-10',
        entries: [{ place: 1, discord_user_id: 'a', display_name: 'A', score: 10, pending: false }],
        resets_at: '2026-11-15T22:00:00Z'
    };

    await arcade.runPass(client);

    const recorded = called('recordPostedMessages')[0];
    assert.equal(recorded.args[0], 44);
    assert.deepEqual(recorded.args[1], ['msg-1']);
});

test('a day nobody played posts nothing but is still acked', async () => {
    apiBehaviour.pendingEvents = { events: [event('daily_board_closed', { game_slug: 'vetrix', day: '2026-11-10' }, 20)] };
    apiBehaviour.dailyBoard = { board_id: 45, entries: [] };

    await arcade.runPass(client);

    assert.equal(sentTo.get(ARCADE_CHANNEL).length, 0);
    assert.equal(called('ackEvent')[0].args[0], 20);
});

test('a podium change moves roles and posts nothing', async () => {
    apiBehaviour.pendingEvents = { events: [event('podium_changed', { top: [] }, 21)] };
    apiBehaviour.currentPodium = { holders: [{ place: 1, discord_user_id: 'a' }] };

    await arcade.runPass(client);

    assert.deepEqual(roleAdds, [{ id: 'a', roleId: GOLD }]);
    assert.equal(sentTo.get(ARCADE_CHANNEL).length, 0, 'role changes are silent');
    assert.equal(sentTo.get(CHAT_CHANNEL).length, 0);
});

test('a queued departure is flushed before anything is posted from the boards', async () => {
    apiBehaviour.reportDepartures = new StubApiError('down');
    await departures.handleGuildMemberRemove({ id: 'gone', guild: { id: GUILD } });

    apiCalls.length = 0;
    apiBehaviour = { pendingEvents: { events: [] }, reportDepartures: { processed: 1, scores_removed: 1, boards_changed: 0 } };

    await arcade.runPass(client);

    assert.equal(apiCalls[0].name, 'reportDepartures', 'the boards are corrected first');
});

test('an unreachable api during a poll is survived quietly', async () => {
    apiBehaviour.pendingEvents = new StubApiError('socket hang up');

    const result = await arcade.runPass(client);

    assert.equal(result.failed, true);
    assert.equal(staffLogs.length, 0, 'not worth a staff log every thirty seconds');
});
