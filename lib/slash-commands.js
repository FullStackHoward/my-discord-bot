// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

const { ApplicationCommandOptionType } = require('discord.js');
const client = require('./client');
const { VG_GUILD_ID, VC_GUILD_ID, APP_GUILD_ID, LOG_COLORS } = require('./config');
const { sendStaffLog, errorField } = require('./staff-log');
const { guildLabel } = require('./utils');
const { handleVerifyCommand } = require('./verification');
const { handleAnnounceCommand } = require('./announcements');
const { RADAR_COMMAND, radarConfigFor, handleViceRadarCommand } = require('./radar');

// These run alongside the !verify / !announce prefix handlers above. The two systems
// are independent, so the old commands stay live until the slash versions are
// confirmed working in production.
const SLASH_COMMANDS = [
    {
        name: 'verify',
        description: 'Manually verify a member in this server',
        options: [
            {
                name: 'user',
                description: 'The member to verify',
                type: ApplicationCommandOptionType.User,
                required: true
            }
        ]
    },
    {
        name: 'announce',
        description: 'Post an announcement to the Vicers community site',
        options: [
            {
                name: 'title',
                description: 'Announcement title',
                type: ApplicationCommandOptionType.String,
                required: true
            },
            {
                name: 'content',
                description: 'Announcement body',
                type: ApplicationCommandOptionType.String,
                required: true
            },
            {
                name: 'link',
                description: 'Optional link to include with the announcement',
                type: ApplicationCommandOptionType.String,
                required: false
            }
        ]
    }
];

// Guild-scoped rather than global: guild commands appear instantly and only show up
// in our three servers. Re-registering an identical definition is a no-op on Discord's
// side, so running this on every startup needs no separate deploy step.
async function registerSlashCommands() {
    for (const guildId of [VG_GUILD_ID, VC_GUILD_ID, APP_GUILD_ID]) {
        if (!guildId) continue;

        // Built per guild so /vice-radar doesn't show up in servers without Radar config.
        const commands = radarConfigFor(guildId) ? [...SLASH_COMMANDS, RADAR_COMMAND] : SLASH_COMMANDS;

        try {
            await client.application.commands.set(commands, guildId);
            console.log(`Registered ${commands.length} slash command(s) in ${guildLabel(guildId)}`);
        } catch (error) {
            // A bot invited without the applications.commands scope fails here. The bot
            // keeps running and the !verify / !announce prefix commands still work.
            console.error(`Failed to register slash commands in ${guildLabel(guildId)}:`, error);

            void sendStaffLog(guildId, {
                color: LOG_COLORS.error,
                title: '⚠️ Slash Command Registration Failed',
                description: `Slash commands could not be registered in ${guildLabel(guildId)}.`,
                fields: [errorField(error)],
                footer: 'Check that the bot was invited with the applications.commands scope.'
            });
        }
    }
}

async function handleInteractionCreate(interaction) {
    if (!interaction.isChatInputCommand()) return;

    try {
        if (interaction.commandName === 'verify') {
            await handleVerifyCommand(interaction);
        } else if (interaction.commandName === 'announce') {
            await handleAnnounceCommand(interaction);
        } else if (interaction.commandName === 'vice-radar') {
            await handleViceRadarCommand(interaction);
        }
    } catch (error) {
        // Safety net for anything the handlers below don't catch themselves, e.g. the
        // interaction expiring before we could respond to it at all.
        console.error(`Error handling /${interaction.commandName}:`, error);
    }
}

module.exports = {
    SLASH_COMMANDS,
    registerSlashCommands,
    handleInteractionCreate,
};
