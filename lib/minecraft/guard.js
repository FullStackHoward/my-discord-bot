// ---------------------------------------------------------------------------
// Minecraft Realm post: pin notice cleanup
// ---------------------------------------------------------------------------
//
// Every pin makes Discord post a "pinned a message" notice, which would become the newest
// message in the channel and defeat the daily "already the newest" check. This deletes
// the notice only when it is the bot's own, in the channel the post currently lives in.
// Pins by staff are left alone, and so is everything else.
//
// Its own messageCreate listener, so it cannot break the others. Never throws.

const { MessageType } = require('discord.js');
const client = require('../client');
const { guildLabel } = require('../utils');
const { pinNoticeDecision } = require('./decide');
const minecraft = require('./index');

const HOUR_MS = 60 * 60 * 1000;
const lastErrorAt = new Map();

async function handleMessageCreate(message) {
    try {
        if (message.type !== MessageType.ChannelPinnedMessage) return;

        const guildId = message.guild?.id;
        if (!guildId || !minecraft.configuredMinecraftGuildIds().includes(guildId)) return;

        // Read at event time, so a notice left in the old channel after a move is ignored.
        const { derived } = minecraft.readCurrent(guildId);

        const decision = pinNoticeDecision({
            channelId: message.channelId,
            currentChannelId: derived.channelId || null,
            isPinNotice: true,
            authorId: message.author?.id,
            botId: client.user?.id
        });

        if (decision !== 'delete') return;

        try {
            await message.delete();
        } catch (error) {
            const now = Date.now();
            if (now - (lastErrorAt.get(guildId) || 0) < HOUR_MS) return;
            lastErrorAt.set(guildId, now);
            console.error(`Could not delete the Minecraft pin notice in ${guildLabel(guildId)}:`, error.message);
        }
    } catch (error) {
        console.error('Error in the Minecraft pin notice cleanup:', error);
    }
}

module.exports = { handleMessageCreate };
