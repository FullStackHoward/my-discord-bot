// The Discord side of the Minecraft post, against a fake guild and channel. No live
// Discord or API calls: the API call is stubbed and the guild is put straight into the
// unconnected client's cache.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), `minecraft-runner-${process.pid}-`));
const GUILD = '111111111111111111';
process.env.VG_GUILD_ID = GUILD;
process.env.MINECRAFT_STATE_PATH = path.join(TEMP, 'minecraft-state.json');
process.env.REMOTE_CONFIG_CACHE_PATH = path.join(TEMP, 'remote-config-cache.json');
process.env.MINECRAFT_POST_HOUR = '18';
process.env.MINECRAFT_TZ = 'America/New_York';
delete process.env.VG_LOG_CHANNEL; // staff logs become no-ops

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { MessageType, MessageFlags } = require('discord.js');
const client = require('../lib/client');
const api = require('../lib/remote-config/api');
const remoteConfig = require('../lib/remote-config');
const minecraft = require('../lib/minecraft');
const guard = require('../lib/minecraft/guard');
const state = require('../lib/minecraft/state');

after(() => fs.rmSync(TEMP, { recursive: true, force: true }));

const BOT = 'bot-user';
client.user = { id: BOT };

const CHANNEL = '123456789012345678';
const OTHER_CHANNEL = '876543210987654321';
const LINK = 'https://realms.gg/EXAMPLE';

function eastern(day, hour, minute = 0) {
    return Date.UTC(2026, 10, day, hour + 5, minute);
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

let nextId = 1000;

function unknown(code) {
    const error = new Error(code === 10008 ? 'Unknown Message' : 'Unknown Channel');
    error.code = code;
    return error;
}

function fakeChannel(id) {
    const messages = new Map();

    const channel = {
        id,
        guildId: GUILD,
        isTextBased: () => true,
        messages: {
            all: messages,
            async fetch(options) {
                if (options && options.limit) {
                    const ids = [...messages.keys()];
                    const newest = messages.get(ids[ids.length - 1]);
                    return { first: () => newest };
                }
                const messageId = typeof options === 'string' ? options : options.message;
                const message = messages.get(messageId);
                if (!message) throw unknown(10008);
                return message;
            }
        },
        pinFails: false,
        async send(payload) {
            return channel.add({ authorId: BOT, ...payload });
        },
        add({ authorId, content = '', flags, allowedMentions, type = MessageType.Default }) {
            const message = {
                id: String(nextId++),
                channelId: id,
                author: { id: authorId },
                content,
                flags,
                allowedMentions,
                type,
                pinned: false,
                async pin() {
                    if (channel.pinFails) throw new Error('Missing Permissions');
                    message.pinned = true;
                },
                async edit(payload) {
                    message.content = payload.content;
                    message.flags = payload.flags;
                    message.allowedMentions = payload.allowedMentions;
                    message.edits = (message.edits || 0) + 1;
                },
                async delete() {
                    messages.delete(message.id);
                }
            };
            messages.set(message.id, message);
            return message;
        },
        list: () => [...messages.values()],
        pinned: () => [...messages.values()].filter(m => m.pinned)
    };

    return channel;
}

let channels;
let apiBody;

function install() {
    channels = new Map([[CHANNEL, fakeChannel(CHANNEL)], [OTHER_CHANNEL, fakeChannel(OTHER_CHANNEL)]]);

    const guild = {
        id: GUILD,
        channels: {
            cache: new Map(),
            async fetch(channelId) {
                if (!channels.has(channelId)) throw unknown(10003);
                return channels.get(channelId);
            }
        }
    };
    client.guilds.cache.set(GUILD, guild);
}

// The API, stubbed: null body means an outage.
api.fetchBotConfig = async community => apiBody
    ? { status: 'ok', body: { community, ...apiBody } }
    : { status: 'unavailable', reason: 'stubbed outage' };

remoteConfig.registerConsumer(guildId => minecraft.runMinecraftPass(guildId, currentNow));
let currentNow = eastern(24, 12);

async function pass(nowMs = eastern(24, 12)) {
    currentNow = nowMs;
    await remoteConfig.refresh(nowMs);
}

function realm(overrides = {}) {
    return { minecraft: { channel_id: CHANNEL, invite_url: LINK, link_unavailable: false, updated_at: 'x', ...overrides } };
}

beforeEach(() => {
    try { fs.unlinkSync(process.env.MINECRAFT_STATE_PATH); } catch {}
    state.loadMinecraftState();
    install();
    apiBody = null;
});

const main = () => channels.get(CHANNEL);
const other = () => channels.get(OTHER_CHANNEL);

// ---------------------------------------------------------------------------

test('no row, or no channel id, posts nothing', async () => {
    apiBody = { minecraft: null };
    await pass();
    apiBody = realm({ channel_id: '' });
    await pass();
    assert.equal(main().list().length, 0);
});

test('a filled-in row posts one pinned message with no pings and no preview', async () => {
    apiBody = realm();
    await pass();

    const posts = main().list();
    assert.equal(posts.length, 1);
    assert.ok(posts[0].pinned);
    assert.ok(posts[0].content.includes(LINK));
    assert.equal(posts[0].flags, MessageFlags.SuppressEmbeds);
    assert.deepEqual(posts[0].allowedMentions, { parse: [] });

    const saved = state.getGuild(GUILD);
    assert.equal(saved.channelId, CHANNEL);
    assert.equal(saved.messageId, posts[0].id);
    assert.equal(saved.inviteUrl, LINK);
});

test('a second pass changes nothing', async () => {
    apiBody = realm();
    await pass();
    await pass();
    assert.equal(main().list().length, 1);
    assert.equal(main().list()[0].edits, undefined);
});

test('a new link edits in place', async () => {
    apiBody = realm();
    await pass();
    apiBody = realm({ invite_url: 'https://realms.gg/NEWONE' });
    await pass();

    const posts = main().list();
    assert.equal(posts.length, 1);
    assert.equal(posts[0].edits, 1);
    assert.ok(posts[0].content.includes('NEWONE'));
    assert.ok(posts[0].pinned);
});

test('the dead link switch swaps the link for the note, and back', async () => {
    apiBody = realm();
    await pass();
    apiBody = realm({ link_unavailable: true });
    await pass();
    assert.ok(!main().list()[0].content.includes(LINK));
    assert.ok(main().list()[0].content.includes('Admins will update it soon'));

    apiBody = realm({ invite_url: 'https://realms.gg/FIXED' });
    await pass();
    assert.ok(main().list()[0].content.includes('FIXED'));
    assert.equal(main().list().length, 1);
});

test('clearing the link with the switch off leaves the post alone', async () => {
    apiBody = realm();
    await pass();
    const before = main().list()[0].content;

    apiBody = realm({ invite_url: '' });
    await pass();
    assert.equal(main().list().length, 1);
    assert.equal(main().list()[0].content, before);
});

test('a bad link from the API never reaches the channel', async () => {
    apiBody = realm();
    await pass();
    apiBody = realm({ invite_url: 'http://evil.example/x' });
    await pass();
    assert.ok(main().list()[0].content.includes(LINK));
    assert.ok(!main().list()[0].content.includes('evil'));
});

test('a post deleted by staff is posted again and pinned', async () => {
    apiBody = realm();
    await pass();
    await main().list()[0].delete();

    await pass();
    assert.equal(main().list().length, 1);
    assert.ok(main().list()[0].pinned);
});

test('a channel change posts in the new channel and removes the old post', async () => {
    apiBody = realm();
    await pass();
    apiBody = realm({ channel_id: OTHER_CHANNEL });
    await pass();

    assert.equal(main().list().length, 0);
    assert.equal(other().list().length, 1);
    assert.ok(other().list()[0].pinned);
    assert.equal(state.getGuild(GUILD).channelId, OTHER_CHANNEL);
});

test('a channel id from another server posts nowhere', async () => {
    apiBody = realm({ channel_id: '999999999999999999' });
    await pass();
    assert.equal(main().list().length + other().list().length, 0);
});

test('the daily resurface moves the post to the bottom, with exactly one pinned', async () => {
    apiBody = realm();
    await pass(eastern(24, 12));
    const first = main().list()[0];
    main().add({ authorId: 'member', content: 'hi' });

    await pass(eastern(24, 18, 5));

    const posts = main().list().filter(m => m.author.id === BOT);
    assert.equal(posts.length, 1);
    assert.notEqual(posts[0].id, first.id);
    assert.equal(main().list()[main().list().length - 1].id, posts[0].id);
    assert.equal(main().pinned().length, 1);
    assert.equal(state.getGuild(GUILD).lastRepostDay, '2026-11-24');

    // Later the same evening, even after more chat: no second repost.
    main().add({ authorId: 'member', content: 'more' });
    await pass(eastern(24, 19));
    assert.equal(main().list().filter(m => m.author.id === BOT)[0].id, posts[0].id);
});

test('already the newest at the post hour: nothing new is posted', async () => {
    apiBody = realm();
    await pass(eastern(24, 12));
    const first = main().list()[0];

    await pass(eastern(24, 18, 5));
    assert.equal(main().list().length, 1);
    assert.equal(main().list()[0].id, first.id);
    assert.equal(state.getGuild(GUILD).lastRepostDay, '2026-11-24');
});

test('an API outage keeps the post and still resurfaces from the cache', async () => {
    apiBody = realm();
    await pass(eastern(24, 12));
    main().add({ authorId: 'member', content: 'hi' });

    apiBody = null;
    await pass(eastern(24, 13));
    assert.equal(main().list().filter(m => m.author.id === BOT).length, 1);

    await pass(eastern(24, 18, 5));
    const posts = main().list().filter(m => m.author.id === BOT);
    assert.equal(posts.length, 1);
    assert.equal(main().list()[main().list().length - 1].id, posts[0].id);
});

test('a pin failure leaves the post up, unpinned', async () => {
    main().pinFails = true;
    apiBody = realm();
    await pass();
    assert.equal(main().list().length, 1);
    assert.equal(main().list()[0].pinned, false);
});

test('a saved message id the bot did not write is never deleted', async () => {
    // A hand-edited state file pointing at a member's message in the old channel: the
    // move to CHANNEL goes ahead, but the delete of the "old post" is refused.
    const theirs = other().add({ authorId: 'member', content: 'not ours' });
    state.updateGuild(GUILD, { channelId: OTHER_CHANNEL, messageId: theirs.id, contentHash: 'x' });

    apiBody = realm();
    await pass();

    assert.equal(main().list().length, 1);
    assert.ok(other().messages.all.has(theirs.id));
});

test('the bot\'s pin notice is deleted in the current channel only', async () => {
    apiBody = realm();
    await pass();

    const guildRef = { id: GUILD };
    const make = (channel, authorId) => {
        const m = channel.add({ authorId, type: MessageType.ChannelPinnedMessage });
        m.guild = guildRef;
        return m;
    };

    const ours = make(main(), BOT);
    const staff = make(main(), 'staff');
    const elsewhere = make(other(), BOT);

    await guard.handleMessageCreate(ours);
    await guard.handleMessageCreate(staff);
    await guard.handleMessageCreate(elsewhere);

    assert.equal(main().messages.all.has(ours.id), false);
    assert.equal(main().messages.all.has(staff.id), true);
    assert.equal(other().messages.all.has(elsewhere.id), true);
});
