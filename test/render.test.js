const os = require('node:os');
const path = require('node:path');
process.env.LOBBY_STATE_PATH = path.join(os.tmpdir(), `lobby-render-test-${process.pid}.json`);

const { test } = require('node:test');
const assert = require('node:assert');
const render = require('../lib/lobby/render');

function lobby(overrides = {}) {
    return {
        id: 'abc123', number: 7, hostId: 'host', gameKey: 'g', gameLabel: 'Helldivers 2',
        platform: 'pc', crossplay: true, seats: 4, minPlayers: null, length: 'standard',
        note: '', voiceChannelId: null, startsAt: Date.UTC(2026, 9, 15, 23, 0),
        status: 'open', players: ['host', 'a'], maybes: [], waitlist: [],
        ...overrides
    };
}

test('the card shows seats, host and both timestamp formats', () => {
    const json = render.lobbyCardEmbed(lobby()).toJSON();

    assert.match(json.title, /LFG #7/);
    assert.match(json.title, /Helldivers 2/);
    assert.match(json.description, /<t:\d+:F>/, 'absolute time for the viewer local clock');
    assert.match(json.description, /<t:\d+:R>/, 'and a relative one');

    const seats = json.fields.find(f => f.name === 'Seats');
    assert.equal(seats.value, '2/4');
});

test('an open card has both button rows, a closed card has none', () => {
    assert.equal(render.lobbyCardComponents(lobby()).length, 2);
    assert.equal(render.lobbyCardComponents(lobby({ status: 'ended' })).length, 0);
    assert.equal(render.lobbyCardComponents(lobby({ status: 'cancelled' })).length, 0);
});

test('once attendance is final the rows stay but every button is greyed', () => {
    const locked = lobby({ status: 'ended', attendance: { source: 'host', showed: ['host'], confirmedAt: Date.now() } });
    const rows = render.lobbyCardComponents(locked);

    assert.equal(rows.length, 2, 'the rows stay visible so the card reads as closed');

    const buttons = rows.flatMap(r => r.toJSON().components);
    assert.equal(buttons.length, 8);
    assert.ok(buttons.every(b => b.disabled === true), 'every button disabled');
});

test('the voice and unconfirmed fallbacks lock the card too', () => {
    for (const source of ['voice', 'unconfirmed']) {
        const rows = render.lobbyCardComponents(lobby({ status: 'ended', attendance: { source, showed: [] } }));
        assert.equal(rows.length, 2, `${source} should lock, not blank, the card`);
        assert.ok(rows.flatMap(r => r.toJSON().components).every(b => b.disabled === true));
    }
});

test('an ended lobby with attendance still pending keeps no buttons', () => {
    const rows = render.lobbyCardComponents(lobby({ status: 'ended', attendance: { source: null, showed: [] } }));
    assert.equal(rows.length, 0);
});

test('a lobby fixture with no attendance object does not throw', () => {
    assert.equal(render.lobbyCardComponents(lobby()).length, 2);
});

test('disableComponents disables buttons and selects without mutating its input', () => {
    const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } = require('discord.js');

    const buttonRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('a').setLabel('A').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('b').setLabel('B').setStyle(ButtonStyle.Secondary)
    );
    const selectRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId('s').addOptions(
            new StringSelectMenuOptionBuilder().setLabel('one').setValue('1'))
    );

    const before = JSON.stringify([buttonRow.toJSON(), selectRow.toJSON()]);
    const disabled = render.disableComponents([buttonRow, selectRow]);

    assert.equal(JSON.stringify([buttonRow.toJSON(), selectRow.toJSON()]), before, 'input untouched');

    const all = disabled.flatMap(r => r.toJSON().components);
    assert.equal(all.length, 3);
    assert.ok(all.every(c => c.disabled === true));
});

test('disableComponents accepts raw API rows as well as builders', () => {
    const raw = [{ type: 1, components: [{ type: 2, custom_id: 'x', label: 'X', style: 1 }] }];
    const disabled = render.disableComponents(raw);

    assert.equal(disabled[0].toJSON().components[0].disabled, true);
    assert.equal(raw[0].components[0].disabled, undefined, 'raw input untouched');
});

test('disableComponents handles an empty or missing list', () => {
    assert.deepEqual(render.disableComponents([]), []);
    assert.deepEqual(render.disableComponents(undefined), []);
});

test('no row exceeds five components and no message exceeds five rows', () => {
    const rows = render.lobbyCardComponents(lobby());

    assert.ok(rows.length <= 5);
    for (const row of rows) {
        assert.ok(row.toJSON().components.length <= 5, 'at most five buttons per row');
    }
});

test('button ids round-trip as lobby:<action>:<id>', () => {
    const rows = render.lobbyCardComponents(lobby());
    const ids = rows.flatMap(r => r.toJSON().components.map(c => c.custom_id));

    for (const id of ids) {
        assert.ok(id.length <= 100, 'customId fits Discord limit');
        const [prefix, action, lobbyId] = id.split(':');
        assert.equal(prefix, 'lobby');
        assert.ok(action.length > 0);
        assert.equal(lobbyId, 'abc123');
    }

    assert.ok(ids.includes('lobby:join:abc123'));
    assert.ok(ids.includes('lobby:cancel:abc123'));
});

test('the crossplay button label reflects the current state', () => {
    const on = render.lobbyCardComponents(lobby({ crossplay: true }))[1].toJSON().components[1].label;
    const off = render.lobbyCardComponents(lobby({ crossplay: false }))[1].toJSON().components[1].label;

    assert.match(on, /On$/);
    assert.match(off, /Off$/);
});

test('a game label cannot inject markdown into the card', () => {
    const json = render.lobbyCardEmbed(lobby({ gameLabel: '**not bold**' })).toJSON();
    assert.match(json.title, /\\\*\\\*not bold\\\*\\\*/);
});

test('mentionList truncates with a count instead of overflowing the field', () => {
    const many = Array.from({ length: 300 }, (_, i) => `user${i}`);
    const value = render.mentionList(many);

    assert.ok(value.length <= 1024, `field value was ${value.length} chars`);
    assert.match(value, /\+\d+ more/);
});

test('a huge player list still produces a valid embed', () => {
    const many = Array.from({ length: 200 }, (_, i) => `u${i}`);
    const json = render.lobbyCardEmbed(lobby({ players: many, seats: 16 })).toJSON();

    assert.ok(json.title.length <= 256);
    assert.ok(json.description.length <= 4096);
    for (const field of json.fields) {
        assert.ok(field.name.length <= 256);
        assert.ok(field.value.length <= 1024, `${field.name} was ${field.value.length}`);
    }
    assert.ok(json.fields.length <= 25);
});

test('a long note is truncated rather than breaking the embed', () => {
    const json = render.lobbyCardEmbed(lobby({ note: 'x'.repeat(500) })).toJSON();
    assert.ok(json.description.length <= 4096);
});

test('the board shows an empty-state line with no lobbies', () => {
    const json = render.boardEmbed({ tonight: [], thisWeek: [], playingNow: [], channelId: 'c', guildId: 'g' }).toJSON();
    assert.match(json.description, /No open lobbies/);
});

test('the board separates tonight from the rest of the week', () => {
    const json = render.boardEmbed({
        tonight: [lobby({ number: 1 })],
        thisWeek: [lobby({ number: 2, startsAt: Date.now() + 5 * 86400000 })],
        playingNow: [],
        channelId: 'c', guildId: 'g'
    }).toJSON();

    assert.ok(json.fields.some(f => f.name === 'Tonight'));
    assert.ok(json.fields.some(f => f.name === 'This week'));
});

test('the board reports Playing now as counts only, never names', () => {
    const json = render.boardEmbed({
        tonight: [], thisWeek: [],
        playingNow: [{ gameName: 'Helldivers 2', count: 3 }],
        channelId: 'c', guildId: 'g'
    }).toJSON();

    const field = json.fields.find(f => f.name === 'Playing now');
    assert.match(field.value, /3 playing/);
    assert.ok(!/<@/.test(field.value), 'no member mentions on the board');
});

test('a long board list truncates with a count', () => {
    const many = Array.from({ length: 80 }, (_, i) => lobby({ number: i, gameLabel: `Game With A Fairly Long Name ${i}` }));
    const json = render.boardEmbed({ tonight: many, thisWeek: [], playingNow: [], channelId: 'c', guildId: 'g' }).toJSON();

    const field = json.fields.find(f => f.name === 'Tonight');
    assert.ok(field.value.length <= 1024);
    assert.match(field.value, /\+\d+ more/);
});

test('the availability panel uses exactly five action rows', () => {
    const profile = { tz: 'America/New_York', weekday: ['evening'], weekend: [], platforms: ['pc'], games: [], nudges: false, tags: {} };
    const payload = render.availabilityPanel(profile, [{ label: 'Halo', value: 'halo', default: false }], { zoneMissing: false });

    assert.equal(payload.components.length, 5, 'Discord allows no more than five');
    for (const row of payload.components) {
        const json = row.toJSON();
        const isSelect = json.components[0].type === 3;
        assert.ok(isSelect ? json.components.length === 1 : json.components.length <= 5,
            'one select per row, or up to five buttons');
    }
});

test('the panel warns when no time zone is set', () => {
    const profile = { tz: null, weekday: [], weekend: [], platforms: [], games: [], nudges: false, tags: {} };
    const payload = render.availabilityPanel(profile, [], { zoneMissing: true });

    assert.match(payload.embeds[0].toJSON().description, /time zone/i);
});

test('the games select survives an empty registry', () => {
    const profile = { tz: 'UTC', weekday: [], weekend: [], platforms: [], games: [], nudges: false, tags: {} };
    const payload = render.availabilityPanel(profile, [], { zoneMissing: false });
    const gameRow = payload.components[3].toJSON();

    assert.equal(gameRow.components[0].disabled, true, 'disabled rather than an invalid empty select');
    assert.ok(gameRow.components[0].options.length >= 1, 'Discord rejects a select with no options');
});

test('previously chosen blocks come back ticked', () => {
    const profile = { tz: 'UTC', weekday: ['evening', 'late'], weekend: [], platforms: [], games: [], nudges: true, tags: {} };
    const payload = render.availabilityPanel(profile, [], { zoneMissing: false });
    const options = payload.components[0].toJSON().components[0].options;

    const defaults = options.filter(o => o.default).map(o => o.value);
    assert.deepEqual(defaults.sort(), ['evening', 'late']);
});

test('the nudge DM carries join, maybe and an opt-out', () => {
    const payload = render.nudgeDm(lobby(), 'Vice Gamers');
    const ids = payload.components[0].toJSON().components.map(c => c.custom_id);

    assert.ok(ids.includes('lobby:join:abc123'));
    assert.ok(ids.includes('lobby:maybe:abc123'));
    assert.ok(ids.includes('lobby:av:nudgesoff'));
});

test('the newcomer DM button carries the guild id, since a DM has no guild', () => {
    const payload = render.newcomerDm('123456789', 'Vice Gamers');
    const id = payload.components[0].toJSON().components[0].custom_id;

    assert.equal(id, 'lobby:nc:123456789');
});

test('the attendance prompt pre-selects whoever voice saw', () => {
    const l = lobby({ players: ['host', 'a', 'b'], attendance: { source: null, showed: ['host', 'a'] } });
    const payload = render.attendancePrompt(l, { host: 'Host', a: 'A', b: 'B' });
    const options = payload.components[0].toJSON().components[0].options;

    assert.deepEqual(options.filter(o => o.default).map(o => o.value).sort(), ['a', 'host']);
});

test('the reminder adds host-only buttons when the minimum is unmet', () => {
    const l = lobby({ minPlayers: 4, players: ['host'] });

    assert.equal(render.reminderPrompt(l, { minPlayersUnmet: false }).components.length, 1);
    assert.equal(render.reminderPrompt(l, { minPlayersUnmet: true }).components.length, 2);
});

// ---------------------------------------------------------------------------
// The board carries live lobbies, which are joinable until they end.
// ---------------------------------------------------------------------------

function board(overrides = {}) {
    return render.boardEmbed({
        live: [], tonight: [], thisWeek: [], playingNow: [],
        channelId: 'c', guildId: 'g',
        ...overrides
    }).toJSON();
}

test('a live lobby gets its own board section, ahead of what is coming up', () => {
    const json = board({
        live: [lobby({ number: 3, status: 'live', isNow: true })],
        tonight: [lobby({ number: 9 })]
    });

    const names = json.fields.map(f => f.name);
    assert.ok(names.includes('Live now \u00b7 join in'), `expected a live section in ${names.join(', ')}`);
    assert.ok(names.indexOf('Live now \u00b7 join in') < names.indexOf('Tonight'), 'live comes first');
    assert.match(json.fields[0].value, /Helldivers 2/);
});

test('a board holding only live lobbies does not claim there is nothing on', () => {
    const json = board({ live: [lobby({ status: 'live' })] });

    assert.ok(!/No open lobbies right now/.test(json.description || ''),
        'a live lobby is something somebody can join');
});

test('a board with lobbies on it carries no empty-board line at all', () => {
    // This used to be unconditional: the description fell through to boardEmpty whenever
    // it was built, so every board said "No open lobbies right now" above its own list.
    const json = board({ tonight: [lobby()] });

    assert.ok(!json.description, `expected no description, got ${JSON.stringify(json.description)}`);
    assert.equal(json.fields.length, 1);
});

test('an empty board still reads as empty', () => {
    assert.match(board().description, /No open lobbies right now/);
});

test('boardEmbed tolerates callers that pass no live list', () => {
    const json = render.boardEmbed({
        tonight: [lobby()], thisWeek: [], playingNow: [], channelId: 'c', guildId: 'g'
    }).toJSON();

    assert.equal(json.fields.length, 1);
});
