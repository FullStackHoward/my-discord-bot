// ---------------------------------------------------------------------------
// /activity - the read-only view of who counts as active
// ---------------------------------------------------------------------------
//
// Read-only. Shares classifyMember with the sweep and /purge, so the three can never
// disagree about anyone's status.

const { AttachmentBuilder, MessageFlags } = require('discord.js');
const {
    LOG_COLORS,
    ACTIVITY_ROLES_ENABLED,
    ACTIVITY_THRESHOLD_DAYS,
    ACTIVITY_NEW_MEMBER_GRACE_DAYS,
    ACTIVITY_VOICE_MIN_MINUTES
} = require('../config');
const { sendStaffLog } = require('../staff-log');
const { resolveGuild, fetchAllMembers, guildLabel, respondWithError } = require('../utils');
const activity = require('./index');
const { formatDuration } = require('./seeding');

async function handleActivityCommand(interaction) {
    if (!activity.isActivityOwner(interaction.user.id)) {
        await activity.logUnauthorizedAttempt(interaction);
        return interaction.reply({
            content: '❌ You do not have permission to view activity reports.',
            flags: MessageFlags.Ephemeral
        });
    }

    const sub = interaction.options.getSubcommand();

    try {
        if (sub === 'summary') return await activitySummary(interaction);
        if (sub === 'user') return await activityUser(interaction);
    } catch (error) {
        console.error(`Error in /activity ${sub}:`, error);
        await respondWithError(interaction, '❌ Something went wrong building the activity report.');
    }
}

async function activitySummary(interaction) {
    const guildId = interaction.guildId;
    const wantsList = interaction.options.getBoolean('list') ?? false;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const guild = await resolveGuild(guildId);
    if (!guild) return interaction.editReply('❌ Could not resolve this server.');

    const state = activity.guildState(guildId);
    const config = activity.activityConfigFor(guildId);

    let members;

    try {
        members = await fetchAllMembers(guild);
    } catch (error) {
        return interaction.editReply(`❌ Could not fetch the member list: ${error.message}`);
    }

    const now = Date.now();
    const counts = { active: 0, inactive: 0, exempt: 0 };
    const exemptByReason = {};
    const activeMembers = [];
    let holdingInactiveRole = 0;

    for (const member of members.values()) {
        const verdict = activity.classifyMember(member, guildId, now);
        counts[verdict.status]++;

        if (verdict.status === 'exempt') {
            const label = activity.exemptReasonLabel(verdict.exemptReason);
            exemptByReason[label] = (exemptByReason[label] || 0) + 1;
        }

        if (verdict.status === 'active') {
            activeMembers.push({ member, verdict });
        }

        if (config && member.roles.cache.has(config.inactiveRoleId)) {
            holdingInactiveRole++;
        }
    }

    activeMembers.sort((a, b) => (b.verdict.lastActiveAt || 0) - (a.verdict.lastActiveAt || 0));

    const seeding = state.seeding;
    const files = [];

    if (wantsList && activeMembers.length > 0) {
        const body = [
            `Active members - ${guildLabel(guildId)} (${guildId})`,
            `Generated: ${new Date().toISOString()}`,
            `Window: active = any recorded activity within ${ACTIVITY_THRESHOLD_DAYS} days`,
            `Count: ${activeMembers.length}`,
            '',
            ...activeMembers.map(({ member, verdict }) => [
                member.user?.tag || member.id,
                member.id,
                `last active ${new Date(verdict.lastActiveAt).toISOString()}`,
                `signal: ${verdict.lastSignal}`
            ].join(' | '))
        ].join('\n');

        files.push(new AttachmentBuilder(Buffer.from(body, 'utf8'), {
            name: `activity-active-${guildId}-${new Date().toISOString().slice(0, 10)}.txt`
        }));
    }

    await sendStaffLog(guildId, {
        color: LOG_COLORS.activity,
        title: '📊 Activity Report Viewed',
        description: `**${interaction.user.tag}** (<@${interaction.user.id}>) viewed the activity summary for ${guildLabel(guildId)}.`,
        fields: [{ name: 'Subcommand', value: `summary${wantsList ? ' (with list)' : ''}`, inline: true }],
        footer: `Owner command (${interaction.user.tag})`
    });

    const exemptBreakdown = Object.entries(exemptByReason)
        .map(([label, count]) => `${label}: ${count}`)
        .join('\n') || 'None';

    const seedingLine = seeding.status === 'complete'
        ? `complete <t:${Math.floor(seeding.completedAt / 1000)}:R>`
            + (seeding.summary?.messagesRead ? ` (${seeding.summary.messagesRead} messages read`
                + (seeding.summary.elapsedMs ? `, took ${formatDuration(seeding.summary.elapsedMs)})` : ')') : '')
        : seeding.status;

    const lines = [
        `**Activity summary — ${guildLabel(guildId)}**`,
        '',
        `**Mode:** ${ACTIVITY_ROLES_ENABLED ? 'live (roles applied)' : 'tracking-only (no roles changed)'}`,
        `**Label window:** ${ACTIVITY_THRESHOLD_DAYS} days  •  **New-member grace:** ${ACTIVITY_NEW_MEMBER_GRACE_DAYS} days  •  **Voice minimum:** ${ACTIVITY_VOICE_MIN_MINUTES} min`,
        `**Seeding:** ${seedingLine}`,
        `**Tracking since:** ${state.trackingStartedAt ? `<t:${Math.floor(state.trackingStartedAt / 1000)}:D>` : 'unknown'}`,
        '',
        `**Active:** ${counts.active}`,
        `**Inactive:** ${counts.inactive}`,
        `**Exempt:** ${counts.exempt}`,
        exemptBreakdown.split('\n').map(l => `  • ${l}`).join('\n'),
        '',
        `**Currently holding the Inactive role:** ${holdingInactiveRole} — this is what \`/purge\` would list.`
    ];

    // Voice history can't be backfilled, so a young tracking window is worth calling out
    // right where the numbers are read.
    if (now - (state.trackingStartedAt || now) < ACTIVITY_THRESHOLD_DAYS * 24 * 60 * 60 * 1000) {
        lines.push('', `⚠️ Tracking has been running for less than ${ACTIVITY_THRESHOLD_DAYS} days. Voice and event activity could not be backfilled, so members whose only recent activity was voice may read as inactive.`);
    }

    await interaction.editReply({ content: lines.join('\n').slice(0, 1900), files });
}

async function activityUser(interaction) {
    const guildId = interaction.guildId;
    const member = interaction.options.getMember('member');
    const user = interaction.options.getUser('member');

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    await sendStaffLog(guildId, {
        color: LOG_COLORS.activity,
        title: '📊 Activity Report Viewed',
        description: `**${interaction.user.tag}** (<@${interaction.user.id}>) looked up a member's activity in ${guildLabel(guildId)}.`,
        fields: [
            { name: 'Subcommand', value: 'user', inline: true },
            { name: 'Target', value: user ? `**${user.tag}** (<@${user.id}>)` : 'Unresolved', inline: true }
        ],
        footer: `Owner command (${interaction.user.tag})`
    });

    if (!member) {
        const record = user ? activity.getMemberActivity(guildId, user.id) : null;

        return interaction.editReply(
            user
                ? `**${user.tag}** is not a member of this server.`
                    + (record
                        ? `\nStale record: last active <t:${Math.floor(record.lastActiveAt / 1000)}:R> (${record.lastSignal}).`
                        : '\nNo activity record stored.')
                : '❌ Could not resolve that member.'
        );
    }

    const config = activity.activityConfigFor(guildId);
    const verdict = activity.classifyMember(member, guildId);

    const heldLabel = config
        ? member.roles.cache.has(config.activeRoleId) ? 'Active'
            : member.roles.cache.has(config.inactiveRoleId) ? 'Inactive'
                : 'None'
        : 'Not configured';

    const lines = [
        `**Activity — ${member.user.tag}** in ${guildLabel(guildId)}`,
        '',
        `**Computed status:** ${verdict.status}`
            + (verdict.exemptReason ? ` (${activity.exemptReasonLabel(verdict.exemptReason)})` : ''),
        `**Role currently held:** ${heldLabel}`,
        `**Last active:** ${verdict.lastActiveAt
            ? `<t:${Math.floor(verdict.lastActiveAt / 1000)}:F> — <t:${Math.floor(verdict.lastActiveAt / 1000)}:R>`
            : 'No recorded activity'}`,
        `**Last signal:** ${verdict.lastSignal || 'none'}`,
        `**Joined:** ${member.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:D>` : 'unknown'}`,
        `**User ID:** ${member.id}`
    ];

    // A mismatch between the computed status and the role held is exactly what the
    // purge safety rules key off, so surface it rather than leaving it to be noticed.
    if (verdict.status === 'active' && heldLabel === 'Inactive') {
        lines.push('', '⚠️ They read as active but still carry the Inactive role. `/purge` lists them under "looks active, skipped" and will not remove them. The next sweep corrects the label.');
    } else if (verdict.status === 'exempt' && heldLabel !== 'None') {
        lines.push('', 'ℹ️ They are exempt but still carry a label. The next sweep removes it.');
    }

    await interaction.editReply(lines.join('\n').slice(0, 1900));
}

module.exports = {
    handleActivityCommand,
};
