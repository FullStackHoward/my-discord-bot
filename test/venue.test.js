const os = require('node:os');
const path = require('node:path');
process.env.LOBBY_STATE_PATH = path.join(os.tmpdir(), `lobby-venue-test-${process.pid}.json`);
// Set before requiring config, so the suite does not depend on a developer's .env.
process.env.VG_GUILD_ID = '900000000000000001';
process.env.VG_LFG_CHANNEL = '900000000000000002';

const { test } = require('node:test');
const assert = require('node:assert');
const { Collection, ChannelType } = require('discord.js');
const client = require('../lib/client');
const config = require('../lib/config');
const state = require('../lib/lobby/state');
const render = require('../lib/lobby/render');
const commands = require('../lib/lobby/commands');

const VG = config.VG_GUILD_ID;

// A guild with two voice channels, one stage, and one text channel that must never be offered.
const VOICE_A = '100000000000000001';
const VOICE_B = '100000000000000002';
const STAGE = '100000000000000003';
const TEXT = '100000000000000004';

client.guilds.cache.set(VG, {
    id: VG,
    channels: {
        cache: new Collection([
            [VOICE_A, { id: VOICE_A, name: 'Game Room 1', type: ChannelType.GuildVoice }],
            [VOICE_B, { id: VOICE_B, name: 'Game Room 2', type: ChannelType.GuildVoice }],
            [STAGE, { id: STAGE, name: 'Main Stage', type: ChannelType.GuildStageVoice }],
            [TEXT, { id: TEXT, name: 'general', type: ChannelType.GuildText }]
        ])
    }
});

function lobby(overrides = {}) {
    return {
        id: 'abc123', number: 1, hostId: 'host', gameKey: 'g', gameLabel: 'Helldivers 2',
        platform: 'pc', crossplay: true, seats: 4, minPlayers: null, length: 'standard',
        note: '', startsAt: Date.UTC(2026, 9, 15, 23, 0), status: 'open',
        players: ['host'], maybes: [], waitlist: [],
        ...overrides
    };
}

test('where is a required option on both create and now', () => {
    const subs = commands.LOBBY_COMMAND.options.filter(o => ['create', 'now'].includes(o.name));
    assert.equal(subs.length, 2);

    for (const sub of subs) {
        const where = sub.options.find(o => o.name === 'where');
        assert.ok(where, `${sub.name} has a where option`);
        assert.equal(where.required, true, `${sub.name}.where is required`);
        assert.equal(where.autocomplete, true);
        assert.ok(!sub.options.some(o => o.name === 'voice'), 'the old optional voice option is gone');
    }
});

test('required options still precede optional ones, which Discord enforces', () => {
    for (const sub of commands.LOBBY_COMMAND.options.filter(o => o.options)) {
        const flags = sub.options.map(o => Boolean(o.required));
        const lastRequired = flags.lastIndexOf(true);
        const firstOptional = flags.indexOf(false);

        assert.ok(firstOptional === -1 || lastRequired < firstOptional,
            `/lobby ${sub.name} has a required option after an optional one`);
    }
});

test('In-game is always offered and comes first', () => {
    const choices = commands.venueChoices(VG, '');
    assert.equal(choices[0].value, commands.VENUE_IN_GAME_VALUE);
    assert.match(choices[0].name, /In-game/);
});

test('voice and stage channels are offered, text channels are not', () => {
    const values = commands.venueChoices(VG, '').map(c => c.value);

    assert.ok(values.includes(`${commands.VENUE_VOICE_PREFIX}${VOICE_A}`));
    assert.ok(values.includes(`${commands.VENUE_VOICE_PREFIX}${STAGE}`), 'stage channels count');
    assert.ok(!values.some(v => v.includes(TEXT)), 'a text channel is never a venue');
});

test('the configured default voice channel is listed before the others', () => {
    const original = config.SERVER_CONFIGS[VG].lobby;
    config.SERVER_CONFIGS[VG].lobby = { channelId: 'lfg', defaultVoiceChannelId: VOICE_B };

    const voiceOnly = commands.venueChoices(VG, '').filter(c => c.value.startsWith(commands.VENUE_VOICE_PREFIX));
    assert.equal(voiceOnly[0].value, `${commands.VENUE_VOICE_PREFIX}${VOICE_B}`);

    config.SERVER_CONFIGS[VG].lobby = original;
});

test('typing filters the voice channels and can still reach In-game', () => {
    const room = commands.venueChoices(VG, 'room');
    assert.ok(room.every(c => c.value === commands.VENUE_IN_GAME_VALUE || /Room/.test(c.name)));
    assert.ok(!room.some(c => /Stage/.test(c.name)));

    const inGame = commands.venueChoices(VG, 'in-g');
    assert.ok(inGame.some(c => c.value === commands.VENUE_IN_GAME_VALUE));
});

test('choices never exceed 25', () => {
    const many = new Collection();
    for (let i = 0; i < 60; i++) {
        many.set(`9${i}`, { id: `9${i}`, name: `Voice ${i}`, type: ChannelType.GuildVoice });
    }
    const saved = client.guilds.cache.get(VG);
    client.guilds.cache.set(VG, { id: VG, channels: { cache: many } });

    assert.ok(commands.venueChoices(VG, '').length <= 25);
    assert.ok(commands.venueChoices(VG, 'voice').length <= 25);

    client.guilds.cache.set(VG, saved);
});

test('resolveVenue accepts In-game', () => {
    const r = commands.resolveVenue(VG, commands.VENUE_IN_GAME_VALUE);
    assert.deepEqual(r, { ok: true, venue: 'ingame', voiceChannelId: null });
});

test('resolveVenue accepts a real voice channel', () => {
    const r = commands.resolveVenue(VG, `${commands.VENUE_VOICE_PREFIX}${VOICE_A}`);
    assert.deepEqual(r, { ok: true, venue: 'voice', voiceChannelId: VOICE_A });
});

test('resolveVenue tolerates a bare channel id', () => {
    assert.deepEqual(commands.resolveVenue(VG, VOICE_A), { ok: true, venue: 'voice', voiceChannelId: VOICE_A });
});

test('resolveVenue rejects free text, text channels and unknown ids', () => {
    for (const bad of ['', '   ', 'somewhere', 'voice:nope', `voice:${TEXT}`, TEXT, '999999999999999999', null, undefined]) {
        assert.equal(commands.resolveVenue(VG, bad).ok, false, `${bad} should be rejected`);
    }
});

test('createLobby stores the venue and nulls the channel for in-game', () => {
    const inGame = state.createLobby('venue-test', {
        hostId: 'h', gameKey: 'g', gameLabel: 'G', seats: 4,
        startsAt: Date.now() + 3600000, endsAt: Date.now() + 7200000,
        venue: 'ingame', voiceChannelId: VOICE_A
    });

    assert.equal(inGame.venue, 'ingame');
    assert.equal(inGame.voiceChannelId, null, 'an in-game lobby carries no voice channel');

    const voice = state.createLobby('venue-test', {
        hostId: 'h', gameKey: 'g', gameLabel: 'G', seats: 4,
        startsAt: Date.now() + 3600000, endsAt: Date.now() + 7200000,
        venue: 'voice', voiceChannelId: VOICE_A
    });

    assert.equal(voice.venue, 'voice');
    assert.equal(voice.voiceChannelId, VOICE_A);
});

test('venueOf infers a venue for lobbies created before the field existed', () => {
    assert.equal(state.venueOf({ voiceChannelId: VOICE_A }), 'voice', 'had a channel, so it was voice');
    assert.equal(state.venueOf({ voiceChannelId: null }), 'ingame', 'had none, so treat as in-game');
    assert.equal(state.venueOf({ venue: 'ingame', voiceChannelId: VOICE_A }), 'ingame', 'explicit wins');
    assert.equal(state.venueOf({ venue: 'voice', voiceChannelId: VOICE_A }), 'voice');
    assert.equal(state.venueOf(null), 'ingame');
});

test('the card always shows where to play', () => {
    const inGame = render.lobbyCardEmbed(lobby({ venue: 'ingame', voiceChannelId: null })).toJSON();
    const details = inGame.fields.find(f => f.name === 'Details').value;
    assert.match(details, /In-game/);
    assert.ok(!/<#/.test(details), 'no channel mention for an in-game lobby');

    const voice = render.lobbyCardEmbed(lobby({ venue: 'voice', voiceChannelId: VOICE_A })).toJSON();
    const voiceDetails = voice.fields.find(f => f.name === 'Details').value;
    assert.match(voiceDetails, new RegExp(`<#${VOICE_A}>`));
    assert.ok(!/In-game/.test(voiceDetails));
});

test('the start post points people to the right place', () => {
    assert.match(render.startPrompt(lobby({ venue: 'ingame', voiceChannelId: null })).content, /in-game/i);
    assert.match(render.startPrompt(lobby({ venue: 'voice', voiceChannelId: VOICE_A })).content, new RegExp(`<#${VOICE_A}>`));
});

test('an older lobby with a channel but no venue still renders as voice', () => {
    const details = render.lobbyCardEmbed(lobby({ voiceChannelId: VOICE_A })).toJSON()
        .fields.find(f => f.name === 'Details').value;

    assert.match(details, new RegExp(`<#${VOICE_A}>`));
});
