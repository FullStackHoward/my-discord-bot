const os = require('node:os');
const path = require('node:path');
process.env.LOBBY_STATE_PATH = path.join(os.tmpdir(), `lobby-guard-test-${process.pid}.json`);

const { test } = require('node:test');
const assert = require('node:assert');
const { MessageType } = require('discord.js');
const { guardDecision } = require('../lib/lobby/channel-guard');

// A normal member post in the LFG channel with the guard on.
function msg(overrides = {}) {
    return {
        hasLobbyConfig: true,
        channelId: 'lfg',
        lobbyChannelId: 'lfg',
        isThread: false,
        authorBot: false,
        webhookId: null,
        system: false,
        type: MessageType.Default,
        authorId: 'member',
        botId: 'bot',
        ownerId: 'owner',
        guardEnabled: true,
        ...overrides
    };
}

test('a member posting in the LFG channel is deleted', () => {
    assert.equal(guardDecision(msg()), 'delete');
});

test('a reply in the LFG channel is deleted too', () => {
    assert.equal(guardDecision(msg({ type: MessageType.Reply })), 'delete');
});

test('a lobby thread is never touched', () => {
    assert.equal(guardDecision(msg({ isThread: true })), 'ignore');
    // Even if the id somehow matched the parent channel.
    assert.equal(guardDecision(msg({ isThread: true, channelId: 'lfg' })), 'ignore');
});

test('other channels are never touched', () => {
    assert.equal(guardDecision(msg({ channelId: 'general' })), 'ignore');
});

test('a guild with no LFG config is never touched', () => {
    assert.equal(guardDecision(msg({ hasLobbyConfig: false })), 'ignore');
    assert.equal(guardDecision(msg({ hasLobbyConfig: false, lobbyChannelId: undefined })), 'ignore');
});

test('bots, webhooks and system messages are left alone', () => {
    assert.equal(guardDecision(msg({ authorBot: true })), 'ignore');
    assert.equal(guardDecision(msg({ webhookId: 'wh1' })), 'ignore');
    assert.equal(guardDecision(msg({ system: true })), 'ignore');
});

test('the owner is exempt', () => {
    assert.equal(guardDecision(msg({ authorId: 'owner' })), 'ignore');
});

test('with no owner configured nobody is exempt by ownership', () => {
    assert.equal(guardDecision(msg({ ownerId: null })), 'delete');
});

test('the guard flag off means nothing is deleted', () => {
    assert.equal(guardDecision(msg({ guardEnabled: false })), 'ignore');
});

test("the bot's own pin notice is removed, even with the guard off", () => {
    const pinNotice = { type: MessageType.ChannelPinnedMessage, authorId: 'bot', authorBot: true, system: true };

    assert.equal(guardDecision(msg({ ...pinNotice })), 'delete-pin-notice');
    assert.equal(guardDecision(msg({ ...pinNotice, guardEnabled: false })), 'delete-pin-notice',
        'pinning the board happens regardless of the guard, so its notice is cleaned regardless too');
});

test("someone else's pin notice is left alone", () => {
    assert.equal(guardDecision(msg({
        type: MessageType.ChannelPinnedMessage,
        authorId: 'someone-else',
        authorBot: false
    })), 'delete');

    assert.equal(guardDecision(msg({
        type: MessageType.ChannelPinnedMessage,
        authorId: 'another-bot',
        authorBot: true
    })), 'ignore', 'another bot is still a bot');
});

test('a pin notice outside the LFG channel is left alone', () => {
    assert.equal(guardDecision(msg({
        channelId: 'general',
        type: MessageType.ChannelPinnedMessage,
        authorId: 'bot'
    })), 'ignore');
});

test('the decision is one of exactly three values', () => {
    const cases = [
        msg(), msg({ isThread: true }), msg({ authorBot: true }), msg({ guardEnabled: false }),
        msg({ type: MessageType.ChannelPinnedMessage, authorId: 'bot' }), msg({ hasLobbyConfig: false })
    ];

    for (const c of cases) {
        assert.ok(['ignore', 'delete', 'delete-pin-notice'].includes(guardDecision(c)));
    }
});
