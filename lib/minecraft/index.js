// ---------------------------------------------------------------------------
// Minecraft Realm post (Vice Gamers only)
// ---------------------------------------------------------------------------
//
// One message in the Minecraft channel telling people how to join the Realm, pinned,
// edited in place while it is current, and posted again at the bottom of the channel
// once a day. The same shape as the LFG board and the arcade callout.
//
// The channel id, invite link and dead link switch are managed in Django admin and read
// through lib/remote-config; nothing about them is in .env. Each remote config refresh
// (about every 10 minutes) runs one pass here, so an admin change reaches Discord with no
// restart. An API outage keeps acting on the last good copy; with none, nothing happens.
//
// Hard rule: this module deletes only its own previous posts (and, in guard.js, the bot's
// own pin notices). No member messages, no kicks, no bans.

const { RESTJSONErrorCodes } = require('discord-api-types/v10');
const client = require('../client');
const { LOG_COLORS, VG_GUILD_ID, MINECRAFT_POST_HOUR, MINECRAFT_TZ } = require('../config');
const { sendStaffLog, errorField } = require('../staff-log');
const { resolveGuild, guildLabel } = require('../utils');
const { localIsoDate } = require('../lobby/time');
const remoteConfig = require('../remote-config');
const copy = require('./copy');
const state = require('./state');
const decide = require('./decide');

const HOUR_MS = 60 * 60 * 1000;

// Vice Gamers only. No Vice Creators path.
function configuredMinecraftGuildIds() {
    return VG_GUILD_ID ? [VG_GUILD_ID] : [];
}

// One staff log per kind of problem per guild per hour, so a missing permission or a bad
// admin entry cannot flood the log channel. The console still gets every one.
const lastLoggedAt = new Map();

function throttled(key, nowMs = Date.now()) {
    if (nowMs - (lastLoggedAt.get(key) || 0) < HOUR_MS) return false;
    lastLoggedAt.set(key, nowMs);
    return true;
}

// The section, validated and resolved against the last good values, as it stands right
// now. Shared with the pin notice guard so both agree on which channel is current.
function readCurrent(guildId) {
    const community = remoteConfig.communityFor(guildId);
    if (!community) return { derived: { state: 'idle', invalid: [] }, stale: true };

    const { config, stale } = remoteConfig.get(community);
    const section = config && config.minecraft ? config.minecraft : null;
    const saved = state.getGuild(guildId);
    const validation = decide.validateSection(section);
    const derived = decide.deriveState(section, validation, {
        channelId: saved.channelId,
        inviteUrl: saved.inviteUrl
    });

    return { derived, stale, saved };
}

async function reportInvalid(guildId, fields) {
    console.warn(`Minecraft post: ignoring invalid ${fields.join(' and ')} from the bot config for ${guildLabel(guildId)}, keeping the last good value.`);
    if (!throttled(`invalid:${guildId}:${fields.join(',')}`)) return;

    await sendStaffLog(guildId, {
        color: LOG_COLORS.error,
        title: 'Minecraft Post: Bad Config Ignored',
        description: `The Minecraft Realm settings in Django admin have an invalid ${fields.join(' and ')}. The post keeps using the last good value until it is fixed.`,
        fields: [{ name: 'What to check', value: 'The channel id is 17 to 20 digits. The invite link starts with https:// and has no spaces.' }]
    });
}

async function resolveChannel(guildId, channelId) {
    const guild = await resolveGuild(guildId);
    if (!guild) return null;

    const channel = guild.channels.cache.get(channelId)
        || await guild.channels.fetch(channelId).catch(() => null);

    if (channel && channel.isTextBased() && channel.guildId === guildId) return channel;

    console.error(`Minecraft post: channel ${channelId} not found or not text-based in ${guildLabel(guildId)}.`);

    if (throttled(`channel:${guildId}:${channelId}`)) {
        await sendStaffLog(guildId, {
            color: LOG_COLORS.error,
            title: 'Minecraft Post: Channel Not Found',
            description: `The channel id set for the Minecraft Realm post (${channelId}) is not a text channel in ${guildLabel(guildId)}, or the bot cannot see it. Nothing was posted.`,
            fields: [{ name: 'Likely Cause', value: 'A channel id from another server, a deleted channel, or the bot missing View Channel there.' }]
        });
    }

    return null;
}

// A pin failure never fails the post: an unpinned post is still a post.
async function ensurePinned(guildId, message) {
    if (!message || message.pinned) return;

    try {
        await message.pin('Minecraft Realm post');
    } catch (error) {
        console.error(`Could not pin the Minecraft post in ${guildLabel(guildId)}:`, error.message);
        if (!throttled(`pin:${guildId}`)) return;

        await sendStaffLog(guildId, {
            color: LOG_COLORS.error,
            title: 'Minecraft Post Pin Failed',
            description: `The Minecraft Realm post in ${guildLabel(guildId)} could not be pinned. It is still posted and still updating.`,
            fields: [
                errorField(error),
                { name: 'Likely Cause', value: 'The bot needs Manage Messages in the Minecraft channel (and Pin Messages, if Discord lists it separately).' }
            ]
        });
    }
}

const IGNORABLE_DELETE_CODES = new Set([
    RESTJSONErrorCodes.UnknownMessage,
    RESTJSONErrorCodes.UnknownChannel
]);

// Best effort, and only ever a message this bot wrote.
async function deleteOwnPost(channel, messageId) {
    if (!channel || !messageId) return;

    try {
        const message = await channel.messages.fetch({ message: messageId, force: true });

        if (message.author?.id !== client.user?.id) {
            console.error(`Minecraft post: refusing to delete message ${messageId}, which the bot did not write.`);
            return;
        }

        await message.delete();
    } catch (error) {
        if (IGNORABLE_DELETE_CODES.has(error.code)) return;
        console.error(`Minecraft post: could not delete the old post ${messageId}:`, error.message);
    }
}

// The saved post, or false when Discord says it is gone. Any other failure throws and
// ends the pass, so an outage is never read as "deleted".
async function fetchSavedPost(channel, messageId) {
    try {
        return await channel.messages.fetch({ message: messageId, force: true });
    } catch (error) {
        if (error.code === RESTJSONErrorCodes.UnknownMessage) return false;
        throw error;
    }
}

async function isNewestMessage(channel, messageId) {
    const latest = await channel.messages.fetch({ limit: 1, cache: false });
    return latest.first()?.id === messageId;
}

const running = new Set();

// One pass for one guild. Never throws.
async function runMinecraftPass(guildId, nowMs = Date.now()) {
    if (!configuredMinecraftGuildIds().includes(guildId)) return;
    if (running.has(guildId)) return;
    running.add(guildId);

    try {
        const { derived, saved } = readCurrent(guildId);

        if (derived.invalid.length > 0) await reportInvalid(guildId, derived.invalid);
        if (!decide.ACTING_STATES.has(derived.state)) return;

        const channel = await resolveChannel(guildId, derived.channelId);
        if (!channel) return;

        const payload = copy.buildPost({ variant: derived.state, inviteUrl: derived.inviteUrl });
        const hash = copy.contentHash(payload.content);

        let message;
        let messageExists;
        if (saved.messageId && saved.channelId === channel.id) {
            message = await fetchSavedPost(channel, saved.messageId);
            messageExists = Boolean(message);
        }

        let isNewest;
        if (message && decide.isRepostDue(saved.lastRepostDay, nowMs, MINECRAFT_POST_HOUR, MINECRAFT_TZ)) {
            isNewest = await isNewestMessage(channel, message.id);
        }

        const decision = decide.decideAction({
            derived,
            saved,
            contentHash: hash,
            messageExists,
            isNewest,
            nowMs,
            postHour: MINECRAFT_POST_HOUR,
            tz: MINECRAFT_TZ
        });

        const today = localIsoDate(nowMs, MINECRAFT_TZ);
        const postFields = {
            contentHash: hash,
            ...(derived.state === 'link' ? { inviteUrl: derived.inviteUrl } : {}),
            checkedAt: nowMs
        };

        switch (decision.action) {
            case 'post': {
                const sent = await channel.send(payload);
                state.updateGuild(guildId, { channelId: channel.id, messageId: sent.id, ...postFields });
                await ensurePinned(guildId, sent);

                console.log(`Minecraft post ${decision.reason === 'deleted' ? 'reposted after deletion' : 'posted'} in ${guildLabel(guildId)}.`);

                if (decision.reason === 'deleted') {
                    await sendStaffLog(guildId, {
                        color: LOG_COLORS.minecraft,
                        title: 'Minecraft Post Reposted',
                        description: `The Minecraft Realm post in <#${channel.id}> had been deleted, so a new one was posted and pinned.`
                    });
                }
                break;
            }

            case 'move': {
                // Post first and delete second, so a failure leaves a post up somewhere.
                const sent = await channel.send(payload);
                const old = { channelId: saved.channelId, messageId: saved.messageId };

                state.updateGuild(guildId, { channelId: channel.id, messageId: sent.id, ...postFields });
                await ensurePinned(guildId, sent);

                const guild = await resolveGuild(guildId);
                const oldChannel = guild && old.channelId
                    ? guild.channels.cache.get(old.channelId) || await guild.channels.fetch(old.channelId).catch(() => null)
                    : null;
                await deleteOwnPost(oldChannel, old.messageId);

                console.log(`Minecraft post moved to ${channel.id} in ${guildLabel(guildId)}.`);
                await sendStaffLog(guildId, {
                    color: LOG_COLORS.minecraft,
                    title: 'Minecraft Post Moved',
                    description: `The Minecraft Realm channel changed in Django admin. The post is now in <#${channel.id}>${old.channelId ? `, and the old one in <#${old.channelId}> was removed` : ''}.`
                });
                break;
            }

            case 'repost': {
                const sent = await channel.send(payload);
                const previousId = saved.messageId;

                state.updateGuild(guildId, { channelId: channel.id, messageId: sent.id, lastRepostDay: today, ...postFields });

                // Pinned before the old one is removed. Deleting a pinned message takes it
                // out of the pins, so there is never a need to unpin and never two pinned.
                await ensurePinned(guildId, sent);
                if (previousId && previousId !== sent.id) await deleteOwnPost(channel, previousId);

                console.log(`Minecraft post resurfaced in ${guildLabel(guildId)}.`);
                break;
            }

            case 'edit': {
                await message.edit(payload);
                state.updateGuild(guildId, { ...postFields, ...(decision.markDay ? { lastRepostDay: today } : {}) });
                await ensurePinned(guildId, message);
                console.log(`Minecraft post updated in ${guildLabel(guildId)}.`);
                break;
            }

            case 'keep': {
                state.updateGuild(guildId, { checkedAt: nowMs, ...(decision.markDay ? { lastRepostDay: today } : {}) });
                await ensurePinned(guildId, message);
                break;
            }

            default:
                break;
        }
    } catch (error) {
        console.error(`Minecraft post pass failed for ${guildLabel(guildId)}:`, error);

        if (throttled(`pass:${guildId}`)) {
            await sendStaffLog(guildId, {
                color: LOG_COLORS.error,
                title: 'Minecraft Post Update Failed',
                description: `The Minecraft Realm post in ${guildLabel(guildId)} could not be checked or updated. Any existing post is untouched; the next try is in about 10 minutes.`,
                fields: [errorField(error)]
            });
        }
    } finally {
        running.delete(guildId);
    }
}

module.exports = {
    configuredMinecraftGuildIds,
    loadMinecraftState: state.loadMinecraftState,
    readCurrent,
    runMinecraftPass,
};
