// ---------------------------------------------------------------------------
// /motw status and /motw standings (owner only, read-only)
// ---------------------------------------------------------------------------
//
// Neither subcommand changes anything. There is deliberately no command that posts or
// resets: the tick already retries every minute, and a manual post would be a second way
// to announce the same week twice.

const { ApplicationCommandOptionType, MessageFlags, PermissionFlagsBits } = require('discord.js');
const { MOTW_CANDIDATE_LIMIT } = require('../config');
const { canManageRole, guildLabel } = require('../utils');
const activity = require('../activity');
const motw = require('./index');

const STANDINGS_SHOWN = 10;

const MOTW_COMMAND = {
    name: 'motw',
    description: 'Member of the Week (owner only)',
    defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
    options: [
        {
            name: 'status',
            description: 'Whether Member of the Week is set up and working here',
            type: ApplicationCommandOptionType.Subcommand
        },
        {
            name: 'standings',
            description: 'This week so far, who would win, and a preview of the announcement',
            type: ApplicationCommandOptionType.Subcommand
        }
    ]
};

const NO_PINGS = { parse: [] };

function ts(ms, style = 'f') {
    return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

function yesNo(value) {
    return value ? '✅' : '❌';
}

function describeLastResult(last) {
    if (!last) return 'none yet';
    if (!last.winnerId) return `week ending ${last.weekKey}: no winner`;

    const how = last.rehearsal ? 'tracking only, not posted' : last.postedAt ? `posted ${ts(last.postedAt, 'R')}` : 'not posted';
    return `week ending ${last.weekKey}: <@${last.winnerId}> with ${last.count} (lead ${last.lead}), ${how}`;
}

async function buildStatus(interaction, guildId) {
    const guild = interaction.guild;
    const config = motw.motwConfigFor(guildId);
    const summary = motw.currentWindowSummary(guildId);

    const role = guild.roles.cache.get(config.roleId) || await guild.roles.fetch(config.roleId).catch(() => null);
    const channel = await motw.resolveAnnouncementChannel(guild, config.channelId);
    const holder = summary.guildEntry.currentHolderId;
    const cachedHolders = role?.members ? role.members.size : 0;

    return [
        `👑 **Member of the Week — ${guildLabel(guildId)}**`,
        '',
        `**Configured:** ✅ role ${role ? `<@&${role.id}>` : `\`${config.roleId}\``}, channel ${channel ? `<#${channel.id}>` : `\`${config.channelId}\``}`,
        `**MOTW_ENABLED:** ${motw.isMotwEnabled() ? '✅ on, Mondays post and move the role' : '⏸️ off, tracking only (Mondays write a staff-log rehearsal)'}`,
        `**Role found:** ${yesNo(role)} · **Bot can manage it:** ${yesNo(role && canManageRole(guild, role.id))}`,
        `**Channel found:** ${yesNo(channel)} · **Bot can post there:** ${yesNo(channel && motw.botCanPostIn(channel, guild))}`,
        '',
        `**This window:** ${ts(summary.window.start)} → ${ts(summary.window.end)} (closes ${ts(summary.window.end, 'R')})${summary.partial ? ' · partial, counting started partway through' : ''}`,
        `**Counted so far:** ${summary.messages} message(s) from ${summary.members} member(s)`,
        `**Current holder (recorded):** ${holder ? `<@${holder}>` : 'none'} · members holding the role now: ${cachedHolders}`,
        `**Last result:** ${describeLastResult(summary.guildEntry.lastResult)}`
    ].join('\n');
}

function standingLine(entry, index) {
    const status = entry.status === 'eligible'
        ? 'eligible'
        : entry.status === 'departed'
            ? 'left the server'
            : `excluded: ${motw.EXCLUSION_LABELS[entry.status]}`;

    return `${index + 1}. <@${entry.userId}> — ${entry.n} · ${status}`;
}

async function handleMotwCommand(interaction) {
    if (!activity.isActivityOwner(interaction.user.id)) {
        await activity.logUnauthorizedAttempt(interaction);
        return interaction.reply({
            content: '❌ You do not have permission to use /motw.',
            flags: MessageFlags.Ephemeral
        });
    }

    const guildId = interaction.guildId;

    if (!motw.motwConfigFor(guildId)) {
        return interaction.reply({
            content: '❌ Member of the Week is not configured for this server.',
            flags: MessageFlags.Ephemeral
        });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const sub = interaction.options.getSubcommand();

    if (sub === 'status') {
        return interaction.editReply({ content: await buildStatus(interaction, guildId), allowedMentions: NO_PINGS });
    }

    // standings
    const summary = motw.currentWindowSummary(guildId);
    const selection = await motw.selectWinner(interaction.guild, summary.counts, {
        limit: MOTW_CANDIDATE_LIMIT,
        minWalk: STANDINGS_SHOWN
    });

    const header = `👑 **Standings — ${guildLabel(guildId)}**, ${ts(summary.window.start)} → ${ts(summary.window.end)}${summary.partial ? ' (partial)' : ''}`;

    if (selection.aborted) {
        return interaction.editReply({
            content: `${header}\n\n❌ Looking up <@${selection.failedUserId}> failed (${selection.error?.message || 'unknown error'}), so the standings could not be worked out. The Monday tick would retry in the same situation.`,
            allowedMentions: NO_PINGS
        });
    }

    if (selection.ranked.length === 0) {
        return interaction.editReply({ content: `${header}\n\nNo messages counted yet this window.`, allowedMentions: NO_PINGS });
    }

    const lines = [header, '', ...selection.considered.slice(0, STANDINGS_SHOWN).map(standingLine), ''];

    if (selection.winner) {
        lines.push(selection.runnerUp
            ? `If the window closed now: <@${selection.winner.userId}> wins, **${selection.lead}** ahead of <@${selection.runnerUp.userId}>.`
            : `If the window closed now: <@${selection.winner.userId}> wins, with no eligible runner-up.`);
        lines.push('', '_The announcement as it would be posted:_');
    } else {
        lines.push(`If the window closed now: no winner (nobody eligible in the top ${MOTW_CANDIDATE_LIMIT}). Nothing would be posted.`);
    }

    const payload = { content: lines.join('\n').slice(0, 1900), allowedMentions: NO_PINGS };

    if (selection.winner) {
        payload.embeds = motw.buildAnnouncement(selection, { partial: summary.partial }).embeds;
    }

    return interaction.editReply(payload);
}

module.exports = {
    MOTW_COMMAND,
    handleMotwCommand,
};
