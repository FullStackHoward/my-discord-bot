// Drives the real DM machinery in lib/radar/index.js with Discord stubbed out, which is
// where the wiring between the planner and the senders can go wrong: who is sent a first
// DM, whose existing DM is edited instead, and what each of them ends up reading.

const GUILD = '900000000000000001';
const RADAR_ROLE = '900000000000000010';

process.env.VG_GUILD_ID = GUILD;
process.env.VG_RADAR_ROLE = RADAR_ROLE;
process.env.VG_RADAR_CHANNEL = '900000000000000011';
process.env.VG_LFG_CHANNEL = '900000000000000012';
process.env.VG_GAME_FORUMS_CHANNEL = '900000000000000013';
process.env.VG_GAME_CHAT_CHANNEL = '900000000000000014';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

// ---------------------------------------------------------------------------
// Stubs, seeded into the module cache before lib/radar can load the real ones
// ---------------------------------------------------------------------------

function stub(request, exports) {
    const filename = require.resolve(request);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const guild = { id: GUILD, name: 'Vice Gamers', members: null, channels: null };

// userId -> every payload that user has been sent or had edited, in order.
const inboxes = new Map();

function member(id, { optedIn = true, dmsClosed = false } = {}) {
    const sent = [];
    inboxes.set(id, sent);

    return {
        id,
        guild,
        displayName: `Player ${id.toUpperCase()}`,
        user: { tag: `${id}#0001`, bot: false },
        roles: { cache: new Set(optedIn ? [RADAR_ROLE] : []) },
        async send(payload) {
            if (dmsClosed) throw new Error('Cannot send messages to this user');

            sent.push({ kind: 'sent', payload });

            // The Message object the real code keeps so it can edit this DM later.
            return {
                id: `m-${id}`,
                async edit(next) {
                    sent.push({ kind: 'edited', payload: next });
                    return this;
                }
            };
        }
    };
}

let roster = new Map();

guild.members = {
    cache: { get: id => roster.get(id) },
    fetch: async id => roster.get(id) || Promise.reject(new Error('Unknown Member'))
};

stub('../lib/client', { emojis: { cache: [] }, application: null, users: { fetch: async () => null } });
stub('../lib/utils', {
    resolveGuild: async guildId => (guildId === GUILD ? guild : null),
    guildLabel: () => 'Vice Gamers',
    canManageRole: () => true,
    respondWithError: async () => {}
});
stub('../lib/staff-log', { sendStaffLog: async () => {}, errorField: () => ({ name: 'e', value: 'e' }) });

const radar = require('../lib/radar');

const GAME = 'Helldivers 2';

function entryFor(game = GAME) {
    return radar.radarGamesFor(GUILD).get(game);
}

// Puts a roster in place without going through presence events, so each test states the
// situation it is about rather than a sequence of arrivals.
function setRoster(members, { game = GAME } = {}) {
    roster = new Map(members.map(m => [m.id, m]));

    const games = radar.radarGamesFor(GUILD);
    games.delete(game);

    return radar.applyRadarPresence(GUILD, members[0], new Set([game]))
        .then(async () => {
            const entry = games.get(game);
            for (const m of members) entry.activeMembers.add(m.id);
            return entry;
        });
}

function inbox(id) {
    return inboxes.get(id) || [];
}

function descriptionsFor(id) {
    return inbox(id).map(record => ({
        kind: record.kind,
        text: record.payload.embeds[0].toJSON().description
    }));
}

beforeEach(() => {
    inboxes.clear();

    // Cancel the debounce timers a previous test armed before dropping the entries:
    // they are unref'd, so they would not hold the suite open, but they would still
    // fire against state a later test is using.
    for (const entry of radar.radarGamesFor(GUILD).values()) {
        clearTimeout(entry.dmResetTimer);
        clearTimeout(entry.dmEditTimer);
        clearTimeout(entry.publicResetTimer);
    }

    radar.radarGamesFor(GUILD).clear();
});

// ---------------------------------------------------------------------------

test('two people on Radar each get exactly one DM, naming the other', async () => {
    const [a, b] = [member('a'), member('b')];
    const entry = await setRoster([a, b]);

    await radar.syncRadarDms(GUILD, GAME, entry);

    assert.equal(inbox('a').length, 1);
    assert.equal(inbox('b').length, 1);
    assert.match(descriptionsFor('a')[0].text, /<@b>/);
    assert.match(descriptionsFor('b')[0].text, /<@a>/);
});

test('a third arrival is DMed, and the first two are edited rather than DMed again', async () => {
    const [a, b, c] = [member('a'), member('b'), member('c')];
    const entry = await setRoster([a, b]);
    await radar.syncRadarDms(GUILD, GAME, entry);

    roster.set('c', c);
    entry.activeMembers.add('c');
    await radar.syncRadarDms(GUILD, GAME, entry);

    assert.deepEqual(inbox('c').map(r => r.kind), ['sent'], 'the newcomer gets their own DM at once');
    assert.deepEqual(inbox('a').map(r => r.kind), ['sent'], 'and nobody else gets a second one');

    // The edits are coalesced onto a timer; run the round the timer would have run.
    assert.ok(entry.dmEditTimer, 'an edit round was scheduled');
    await radar.runDmEdits(GUILD, GAME);

    assert.deepEqual(inbox('a').map(r => r.kind), ['sent', 'edited']);
    assert.match(descriptionsFor('a')[1].text, /<@c>/, 'the edit adds the newcomer to the list');
    assert.match(descriptionsFor('a')[1].text, /<@b>/, 'and keeps the one who was there');
});

test('the same roster twice over is not worth an edit', async () => {
    const entry = await setRoster([member('a'), member('b')]);
    await radar.syncRadarDms(GUILD, GAME, entry);
    await radar.syncRadarDms(GUILD, GAME, entry);
    await radar.runDmEdits(GUILD, GAME);

    assert.deepEqual(inbox('a').map(r => r.kind), ['sent']);
});

test('somebody who is not on Radar is counted but never DMed', async () => {
    const entry = await setRoster([member('a'), member('lurker', { optedIn: false })]);
    await radar.syncRadarDms(GUILD, GAME, entry);

    assert.equal(inbox('lurker').length, 0);
    assert.equal(inbox('a').length, 1);
    assert.match(descriptionsFor('a')[0].text, /1 other Vicer is playing/,
        'the solo layout, since nobody else in the match is on Radar');
});

test('the solo DM points at the three places to find players', async () => {
    const entry = await setRoster([member('a'), member('lurker', { optedIn: false })]);
    await radar.syncRadarDms(GUILD, GAME, entry);

    const text = descriptionsFor('a')[0].text;
    assert.match(text, /<#900000000000000012>/, 'the LFG channel');
    assert.match(text, /<#900000000000000013>/, 'the game forums');
    assert.match(text, /<#900000000000000014>/, 'game chat');
});

test('a solo DM becomes the squad layout by edit when somebody on Radar turns up', async () => {
    const entry = await setRoster([member('a'), member('lurker', { optedIn: false })]);
    await radar.syncRadarDms(GUILD, GAME, entry);

    const b = member('b');
    roster.set('b', b);
    entry.activeMembers.add('b');
    await radar.syncRadarDms(GUILD, GAME, entry);
    await radar.runDmEdits(GUILD, GAME);

    assert.deepEqual(inbox('a').map(r => r.kind), ['sent', 'edited'], 'edited, not sent twice');
    assert.match(descriptionsFor('a')[1].text, /The following people are also playing/);
    assert.match(descriptionsFor('a')[1].text, /<@b>/);
});

test('a leaver is edited out of the DMs of the people still playing', async () => {
    const entry = await setRoster([member('a'), member('b'), member('c')]);
    await radar.syncRadarDms(GUILD, GAME, entry);

    entry.activeMembers.delete('c');
    await radar.syncRadarDms(GUILD, GAME, entry);
    await radar.runDmEdits(GUILD, GAME);

    assert.match(descriptionsFor('a')[1].text, /<@b>/);
    assert.ok(!/<@c>/.test(descriptionsFor('a')[1].text), 'c is gone from the list');
    assert.deepEqual(inbox('c').map(r => r.kind), ['sent'], 'and the one who left keeps the DM they saw');
});

test('a Discord game earns no DM at all', async () => {
    const entry = await setRoster([member('a'), member('b')], { game: 'Wordle' });

    await radar.evaluateRadarGame(GUILD, 'Wordle');

    assert.equal(inbox('a').length, 0);
    assert.equal(inbox('b').length, 0);
    assert.equal(entry.activeMembers.size, 2, 'but both are still counted in the match');
});

test('a closed DM is not retried on every later roster change', async () => {
    const entry = await setRoster([member('a', { dmsClosed: true }), member('b')]);
    await radar.syncRadarDms(GUILD, GAME, entry);

    assert.equal(inbox('a').length, 0, 'nothing was delivered');
    assert.equal(entry.dmMessages.get('a').message, null, 'and it is remembered as a failure');

    roster.set('c', member('c'));
    entry.activeMembers.add('c');
    await radar.syncRadarDms(GUILD, GAME, entry);

    assert.equal(inbox('a').length, 0, 'still nothing: the claim keeps it out of the send list');
});

test('the group chat button carries a token the bot can resolve', async () => {
    const entry = await setRoster([member('a'), member('b')]);
    await radar.syncRadarDms(GUILD, GAME, entry);

    const rows = inbox('a')[0].payload.components.map(row => row.toJSON());
    const button = rows.at(-1).components[0];

    assert.equal(button.custom_id, `radar:group:${entry.matchToken}`);
    assert.ok(radar.isRadarButton(button.custom_id));
});

test('a solo match mints no token, there being no button to carry it', async () => {
    const entry = await setRoster([member('a'), member('lurker', { optedIn: false })]);
    await radar.syncRadarDms(GUILD, GAME, entry);

    assert.equal(entry.matchToken, null);
});

test('a button from a finished match says so instead of failing', async () => {
    const entry = await setRoster([member('a'), member('b')]);
    await radar.syncRadarDms(GUILD, GAME, entry);

    const token = entry.matchToken;
    radar.radarGamesFor(GUILD).delete(GAME);

    const replies = [];
    await radar.handleRadarButton({
        customId: `radar:group:${token}`,
        user: { id: 'a' },
        deferReply: async () => {},
        editReply: async content => { replies.push(content); }
    });

    assert.equal(replies.length, 1);
    assert.match(replies[0], /has ended/);
});

test('somebody who is no longer in the match is told so, not handed a thread', async () => {
    const entry = await setRoster([member('a'), member('b')]);
    await radar.syncRadarDms(GUILD, GAME, entry);

    const replies = [];
    await radar.handleRadarButton({
        customId: `radar:group:${entry.matchToken}`,
        user: { id: 'stranger' },
        deferReply: async () => {},
        editReply: async content => { replies.push(content); }
    });

    assert.match(replies[0], /not in that match any more/);
    assert.equal(entry.groupThreadId, null, 'and no thread was opened');
});

test('opting in while already playing gets you the DM without waiting', async () => {
    const lurker = member('lurker', { optedIn: false });
    const entry = await setRoster([member('a'), lurker]);
    await radar.syncRadarDms(GUILD, GAME, entry);

    assert.equal(inbox('lurker').length, 0, 'not on Radar, so not DMed');

    // What /vice-radar join (or the role picker in #opt-in) leaves behind.
    const before = { roles: { cache: new Set() } };
    lurker.roles.cache.add(RADAR_ROLE);
    await radar.handleGuildMemberUpdate(before, lurker);

    assert.deepEqual(inbox('lurker').map(r => r.kind), ['sent']);
    assert.match(descriptionsFor('lurker')[0].text, /<@a>/, 'and it names who they can play with');

    await radar.runDmEdits(GUILD, GAME);
    assert.match(descriptionsFor('a').at(-1).text, /<@lurker>/, 'while a is edited, not re-sent');
});

test('opting out is not mistaken for opting in', async () => {
    const a = member('a');
    const entry = await setRoster([a, member('b')]);
    await radar.syncRadarDms(GUILD, GAME, entry);

    const before = { roles: { cache: new Set([RADAR_ROLE]) } };
    a.roles.cache.delete(RADAR_ROLE);
    await radar.handleGuildMemberUpdate(before, a);

    assert.deepEqual(inbox('a').map(r => r.kind), ['sent'], 'nothing new on the way out');
});

test('an unrelated role change does nothing', async () => {
    const a = member('a');
    const entry = await setRoster([a, member('b')]);
    await radar.syncRadarDms(GUILD, GAME, entry);

    const before = { roles: { cache: new Set([RADAR_ROLE]) } };
    await radar.handleGuildMemberUpdate(before, a);

    assert.deepEqual(inbox('a').map(r => r.kind), ['sent']);
});
