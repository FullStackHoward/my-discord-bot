// Staff log channel posting. Never throws: logging must not break its caller.

const { EmbedBuilder } = require('discord.js');
const { VG_GUILD_ID, VC_GUILD_ID, APP_GUILD_ID, LOG_CHANNELS } = require('./config');
const { resolveGuild } = require('./utils');

// Discord's hard limits. Exceeding any of them makes the API reject the whole message,
// so every caller-supplied string is clamped rather than trusted; an activity sweep or
// purge list can run arbitrarily long.
const TITLE_MAX = 256;
const DESCRIPTION_MAX = 4096;
const FIELD_NAME_MAX = 256;
const FIELD_VALUE_MAX = 1024;
const MAX_FIELDS = 25;

// Truncates to `max`, leaving room for an ellipsis so the cut is visible rather than
// looking like the text simply ended.
function clamp(text, max) {
    const value = String(text);
    return value.length <= max ? value : value.slice(0, max - 1) + '\u2026';
}

// Post an embed to the server's bot log channel, built from
// { color, title, description?, fields?, footer?, files? }.
//
// `files` is passed straight through to channel.send, for lists too long to belong in an
// embed (see AttachmentBuilder callers in lib/activity/). Never throws: logging must not
// break the caller.
async function sendStaffLog(guildId, options) {
    try {
        const channelId = LOG_CHANNELS[guildId];
        if (!channelId) return;

        const guild = await resolveGuild(guildId);
        if (!guild) return;

        const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
        if (!channel || !channel.isTextBased()) {
            console.log(`Log channel not found or not text-based for guild ${guildId}: ${channelId}`);
            return;
        }

        const embed = new EmbedBuilder()
            .setColor(options.color)
            .setTitle(clamp(options.title, TITLE_MAX))
            .setTimestamp();

        if (options.description) {
            embed.setDescription(clamp(options.description, DESCRIPTION_MAX));
        }

        if (options.fields && options.fields.length > 0) {
            embed.addFields(options.fields.slice(0, MAX_FIELDS).map(field => ({
                name: clamp(field.name, FIELD_NAME_MAX),
                // Discord also rejects an empty value, which a computed count of zero or
                // an empty list can easily produce.
                value: clamp(field.value || '\u2014', FIELD_VALUE_MAX),
                ...(field.inline === undefined ? {} : { inline: field.inline })
            })));
        }

        if (options.footer) {
            embed.setFooter({ text: clamp(options.footer, TITLE_MAX) });
        }

        const payload = { embeds: [embed] };

        if (options.files && options.files.length > 0) {
            payload.files = options.files;
        }

        await channel.send(payload);
    } catch (error) {
        console.error('Failed to send staff log message:', error);
    }
}

// For problems that aren't tied to one server. Best effort: sendStaffLog already
// swallows a channel that is missing or unreachable.
async function sendStaffLogToAllServers(options) {
    for (const guildId of [VG_GUILD_ID, VC_GUILD_ID, APP_GUILD_ID]) {
        await sendStaffLog(guildId, options);
    }
}

// Discord rejects empty embed field values, and truncates anything past 1024 chars.
function errorField(error) {
    const text = String(error && error.message ? error.message : error) || 'Unknown error';
    return { name: 'Error', value: text.slice(0, 1000) };
}

module.exports = {
    sendStaffLog,
    sendStaffLogToAllServers,
    errorField,
};
