// ---------------------------------------------------------------------------
// LFG channel guard
// ---------------------------------------------------------------------------
//
// The LFG channel carries lobby cards and slash commands only; conversation belongs in
// the per-lobby threads. Discord permissions do the real enforcement (deny Send Messages
// on @everyone, allow Use Application Commands and Send Messages in Threads). This is the
// code backstop for what gets through anyway: a role with posting rights, a permission
// that was never applied, a newly configured server.
//
// It deletes messages. That is the one destructive thing the LFG feature does, and it is
// not member moderation: no kick, no ban, no timeout, no role change.

const { MessageType } = require('discord.js');
const {
    LOG_COLORS,
    LOBBY_CHANNEL_GUARD_ENABLED,
    LOBBY_CHANNEL_REMINDER_COOLDOWN_MINUTES
} = require('../config');
const { sendStaffLog, errorField } = require('../staff-log');
const { guildLabel } = require('../utils');
const client = require('../client');
const copy = require('./copy');
const components = require('./components');
const { lobbyConfigFor } = require('./guilds');

// userId -> when they were last sent the explanation.
const lastReminderAt = new Map();

const lastDeleteErrorAt = new Map();
const lastPinNoticeErrorAt = new Map();
const HOUR_MS = 60 * 60 * 1000;

// Pure, so the whole decision table can be unit tested without a Discord message.
//
// 'ignore'             leave it alone
// 'delete-pin-notice'  the bot's own "pinned a message" system notice: remove it so the
//                      channel stays clean. Deliberately NOT gated on the guard flag,
//                      because pinning the board happens either way.
// 'delete'             a member posted in a command-only channel
function guardDecision({
    hasLobbyConfig,
    channelId,
    lobbyChannelId,
    isThread,
    authorBot,
    webhookId,
    system,
    type,
    authorId,
    botId,
    ownerId,
    guardEnabled
}) {
    if (!hasLobbyConfig) return 'ignore';

    // Thread messages carry the thread's own id, so lobby chat is untouched. The explicit
    // isThread check is belt and braces.
    if (isThread) return 'ignore';
    if (channelId !== lobbyChannelId) return 'ignore';

    // Checked before the bot/system filters below, since this notice is both.
    if (type === MessageType.ChannelPinnedMessage && authorId === botId) return 'delete-pin-notice';

    if (authorBot) return 'ignore';
    if (webhookId) return 'ignore';
    if (system) return 'ignore';

    // The owner is left alone, so a staff !verify or a quick note is not swallowed.
    if (ownerId && authorId === ownerId) return 'ignore';

    if (!guardEnabled) return 'ignore';

    return 'delete';
}

// Its own messageCreate listener, so this and the activity tracker cannot break each
// other. Never throws.
async function handleMessageCreate(message) {
    try {
        const guildId = message.guild?.id;
        if (!guildId) return;

        const config = lobbyConfigFor(guildId);

        const decision = guardDecision({
            hasLobbyConfig: Boolean(config),
            channelId: message.channelId,
            lobbyChannelId: config?.channelId,
            isThread: Boolean(message.channel?.isThread?.()),
            authorBot: Boolean(message.author?.bot),
            webhookId: message.webhookId || null,
            system: Boolean(message.system),
            type: message.type,
            authorId: message.author?.id,
            botId: client.user?.id,
            ownerId: process.env.VICER_ADMIN || null,
            guardEnabled: LOBBY_CHANNEL_GUARD_ENABLED
        });

        if (decision === 'ignore') return;

        if (decision === 'delete-pin-notice') {
            try {
                await message.delete();
            } catch (error) {
                throttled(lastPinNoticeErrorAt, guildId, () => {
                    console.error(`Could not delete the pin notice in ${guildLabel(guildId)}:`, error.message);
                });
            }
            return;
        }

        // decision === 'delete'
        try {
            await message.delete();
        } catch (error) {
            await reportDeleteFailure(guildId, error);
            return; // no explanation for a post that is still sitting there
        }

        await sendReminder(message.author.id, config.channelId);
    } catch (error) {
        console.error('Error in the LFG channel guard:', error);
    }
}

function throttled(map, key, run) {
    const now = Date.now();
    if (now - (map.get(key) || 0) < HOUR_MS) return;

    map.set(key, now);
    run();
}

async function reportDeleteFailure(guildId, error) {
    console.error(`LFG channel guard could not delete a message in ${guildLabel(guildId)}:`, error.message);

    const now = Date.now();
    if (now - (lastDeleteErrorAt.get(guildId) || 0) < HOUR_MS) return;
    lastDeleteErrorAt.set(guildId, now);

    await sendStaffLog(guildId, {
        color: LOG_COLORS.error,
        title: 'LFG Channel Guard Could Not Delete',
        description: `A message posted in the LFG channel in ${guildLabel(guildId)} could not be removed, so the channel is not being kept clear.`,
        fields: [
            errorField(error),
            { name: 'Likely Cause', value: 'The bot needs Manage Messages in the LFG channel.' }
        ]
    });
}

// A DM, because Discord's ephemeral flag exists only on interaction responses and a
// deleted plain message has no interaction to reply to. A closed DM is not reported
// publicly, matching how nudges already behave.
async function sendReminder(userId, channelId) {
    const now = Date.now();
    const cooldownMs = LOBBY_CHANNEL_REMINDER_COOLDOWN_MINUTES * 60 * 1000;

    if (now - (lastReminderAt.get(userId) || 0) < cooldownMs) return;
    lastReminderAt.set(userId, now);

    await components.dmUser(userId, copy.channelGuardDm(`<#${channelId}>`));
}

module.exports = { guardDecision, handleMessageCreate };
