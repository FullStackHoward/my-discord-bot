// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

const { ApplicationCommandOptionType, PermissionFlagsBits } = require('discord.js');
const client = require('./client');
const { VG_GUILD_ID, VC_GUILD_ID, APP_GUILD_ID, LOG_COLORS } = require('./config');
const { sendStaffLog, errorField } = require('./staff-log');
const { guildLabel } = require('./utils');
const { handleVerifyCommand } = require('./verification');
const { handleAnnounceCommand } = require('./announcements');
const { RADAR_COMMAND, radarConfigFor, handleViceRadarCommand } = require('./radar');
const { activityConfigFor } = require('./activity');
const { handlePurgeCommand, handlePurgeExemptCommand, handlePurgeButton, isPurgeButton } = require('./activity/purge');
const { handleActivityCommand } = require('./activity/report');
const { gamerIdConfigFor } = require('./gamer-id');
const {
    GAMER_ID_COMMAND,
    handleGamerIdSweepCommand,
    handleGamerIdButton,
    isGamerIdButton
} = require('./gamer-id/command');

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

// Owner-only activity commands. default_member_permissions hides them from the picker
// for regular members; the real gate is the VICER_ADMIN check inside each handler, since
// an Administrator can still see commands restricted this way.
const ACTIVITY_COMMANDS = [
    {
        name: 'activity',
        description: 'View who counts as active in this server',
        defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
        options: [
            {
                name: 'summary',
                description: 'Counts of active, inactive and exempt members',
                type: ApplicationCommandOptionType.Subcommand,
                options: [
                    {
                        name: 'list',
                        description: 'Attach a full list of active members',
                        type: ApplicationCommandOptionType.Boolean,
                        required: false
                    }
                ]
            },
            {
                name: 'user',
                description: 'Activity details for one member',
                type: ApplicationCommandOptionType.Subcommand,
                options: [
                    {
                        name: 'member',
                        description: 'The member to look up',
                        type: ApplicationCommandOptionType.User,
                        required: true
                    }
                ]
            }
        ]
    },
    {
        name: 'purge-exempt',
        description: 'Manage members excluded from activity labeling and purges',
        defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
        options: [
            {
                name: 'add',
                description: 'Exempt a member from activity labeling and purges',
                type: ApplicationCommandOptionType.Subcommand,
                options: [
                    { name: 'user', description: 'The member to exempt', type: ApplicationCommandOptionType.User, required: true },
                    { name: 'note', description: 'Why they are exempt', type: ApplicationCommandOptionType.String, required: false }
                ]
            },
            {
                name: 'remove',
                description: 'Return a member to normal activity labeling',
                type: ApplicationCommandOptionType.Subcommand,
                options: [
                    { name: 'user', description: 'The member to un-exempt', type: ApplicationCommandOptionType.User, required: true }
                ]
            },
            {
                name: 'list',
                description: 'Show every manually exempted member',
                type: ApplicationCommandOptionType.Subcommand
            }
        ]
    },
    {
        // Deliberately has no "days" option: the 30-day label is the only time rule, and
        // this command acts on whoever currently holds the Inactive role.
        name: 'purge',
        description: 'Preview and remove members holding the Inactive role (owner only, always confirms first)',
        defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
        options: [
            {
                name: 'send_dm',
                description: 'DM each member before removing them (default: yes)',
                type: ApplicationCommandOptionType.Boolean,
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

        // Built per guild so /vice-radar and the activity commands only show up in
        // servers where those features are actually configured.
        const commands = [...SLASH_COMMANDS];
        if (radarConfigFor(guildId)) commands.push(RADAR_COMMAND);
        if (activityConfigFor(guildId)) commands.push(...ACTIVITY_COMMANDS);
        if (gamerIdConfigFor(guildId)) commands.push(GAMER_ID_COMMAND);

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
    // The purge confirm/cancel buttons route through here rather than a collector, so
    // the gating is explicit and does not depend on collector behavior for ephemeral
    // replies. handlePurgeButton re-checks the owner on every press.
    if (interaction.isButton()) {
        if (isPurgeButton(interaction.customId)) {
            try {
                await handlePurgeButton(interaction);
            } catch (error) {
                console.error('Error handling a purge button press:', error);
            }
            return;
        }

        if (isGamerIdButton(interaction.customId)) {
            try {
                await handleGamerIdButton(interaction);
            } catch (error) {
                console.error('Error handling a gamer ID sweep button press:', error);
            }
            return;
        }

        return;
    }

    if (!interaction.isChatInputCommand()) return;

    try {
        if (interaction.commandName === 'verify') {
            await handleVerifyCommand(interaction);
        } else if (interaction.commandName === 'announce') {
            await handleAnnounceCommand(interaction);
        } else if (interaction.commandName === 'vice-radar') {
            await handleViceRadarCommand(interaction);
        } else if (interaction.commandName === 'activity') {
            await handleActivityCommand(interaction);
        } else if (interaction.commandName === 'purge-exempt') {
            await handlePurgeExemptCommand(interaction);
        } else if (interaction.commandName === 'purge') {
            await handlePurgeCommand(interaction);
        } else if (interaction.commandName === 'gamer-id-sweep') {
            await handleGamerIdSweepCommand(interaction);
        }
    } catch (error) {
        // Safety net for anything the handlers below don't catch themselves, e.g. the
        // interaction expiring before we could respond to it at all.
        console.error(`Error handling /${interaction.commandName}:`, error);
    }
}

module.exports = {
    SLASH_COMMANDS,
    ACTIVITY_COMMANDS,
    registerSlashCommands,
    handleInteractionCreate,
};
