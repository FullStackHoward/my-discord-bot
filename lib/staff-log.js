// Staff log channel posting. Never throws: logging must not break its caller.

const { EmbedBuilder } = require('discord.js');
const { VG_GUILD_ID, VC_GUILD_ID, APP_GUILD_ID, LOG_CHANNELS } = require('./config');
const { resolveGuild } = require('./utils');

// Post an embed to the server's bot log channel, built from
// { color, title, description?, fields?, footer? }.
// Never throws: logging must not break the caller.
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
            .setTitle(options.title)
            .setTimestamp();

        if (options.description) {
            embed.setDescription(options.description);
        }

        if (options.fields && options.fields.length > 0) {
            embed.addFields(options.fields);
        }

        if (options.footer) {
            embed.setFooter({ text: options.footer });
        }

        await channel.send({ embeds: [embed] });
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
