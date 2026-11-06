// ---------------------------------------------------------------------------
// /intros-sweep and /intros-cleanup
// ---------------------------------------------------------------------------
//
// A copy of lib/gamer-id/command.js adapted to threads. Owner only, preview first,
// nothing deleted without a Confirm press. The buttons route through
// handleInteractionCreate rather than a collector, so the gating is explicit, and the
// owner is re-checked on every press.

const crypto = require('crypto');
const {
    ActionRowBuilder,
    AttachmentBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
    PermissionFlagsBits
} = require('discord.js');
const { LOG_COLORS, INTRO_PREVIEW_TIMEOUT_MS } = require('../config');
const { isCleanupEnabled, setCleanupEnabled, cleanupStatus } = require('./state');
const { sendStaffLog, errorField } = require('../staff-log');
const { guildLabel } = require('../utils');
const activity = require('../activity');
const introductions = require('./index');

const CUSTOM_ID_PREFIX = 'intros';
const SAMPLE_TITLES = 5;
const SAMPLE_TITLE_MAX = 80;

// token -> pending preview. In memory only, so a restart drops every pending confirm,
// which is the safe direction.
const pendingSweeps = new Map();

const INTROS_SWEEP_COMMAND = {
    name: 'intros-sweep',
    description: 'Preview and remove intro threads from members who have left (owner only, always confirms first)',
    defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
    options: []
};

const INTROS_CLEANUP_COMMAND = {
    name: 'intros-cleanup',
    description: 'Turn automatic introductions cleanup on or off, or check it (owner only)',
    defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
    options: [
        { name: 'enable', description: 'Let leaves and the daily reconcile delete departed members\' introduction threads', type: 1 },
        { name: 'disable', description: 'Report-only: scan and report, delete nothing automatically', type: 1 },
        { name: 'status', description: 'Show whether automatic cleanup is on, and when it last changed', type: 1 }
    ]
};

// A sample title, made safe to show: clamped, newlines flattened, and wrapped so markdown
// in it cannot reformat the preview. Only ever shown in the owner's ephemeral reply.
function sampleTitle(name) {
    const flat = String(name || '(untitled)').replace(/\s+/g, ' ').trim();
    const clamped = flat.length <= SAMPLE_TITLE_MAX ? flat : flat.slice(0, SAMPLE_TITLE_MAX - 1) + '…';
    return clamped.replace(/`/g, 'ˋ');
}

function dateOnly(ms) {
    return ms ? new Date(ms).toISOString().slice(0, 10) : 'unknown';
}

// Everything the ephemeral preview says, built from a dry-run report. Exported for tests.
function buildPreviewBody(report, guildId) {
    const matches = report.matches;
    const created = matches.map(t => t.createdTimestamp).filter(Boolean).sort((a, b) => a - b);
    const counts = matches.map(t => t.messageCount).filter(n => typeof n === 'number');

    const lines = [
        `**Introductions sweep preview — ${guildLabel(guildId)}** · nothing has been deleted yet.`,
        '',
        `**${matches.length}** thread(s) from **${report.absentOwnerIds.size}** departed member(s) would be deleted.`,
        `Scanned ${report.threadsScanned} thread(s). Member list check: **passed**.`
    ];

    // Discord's message_count, which excludes the starter post and is known to be
    // inaccurate on very old threads, so it is reported as an indication only.
    if (counts.length > 0) {
        const withReplies = counts.filter(n => n > 0).length;
        lines.push(`About **${withReplies}** of them have replies, per Discord's message count. Deleting a thread deletes its replies too.`);
    }

    if (created.length > 0) {
        lines.push(`Oldest post: ${dateOnly(created[0])} · newest: ${dateOnly(created[created.length - 1])}`);
    }

    if (report.pinnedKept > 0) lines.push(`${report.pinnedKept} pinned thread(s) from departed members will be kept.`);
    if (report.noOwner > 0) lines.push(`${report.noOwner} thread(s) had no owner ID and will be kept.`);

    lines.push('', `**Sample titles** (first ${Math.min(SAMPLE_TITLES, matches.length)}):`);
    for (const thread of matches.slice(0, SAMPLE_TITLES)) {
        lines.push(`• \`${sampleTitle(thread.name)}\``);
    }

    lines.push(
        '',
        '_The full list, with owner and thread IDs, is attached to the log channel post._',
        isCleanupEnabled(guildId)
            ? '_Automatic cleanup is on, so leaves and the daily reconcile are already handling new departures._'
            : '_Automatic cleanup is off, but confirming here still deletes: this is the manual pass._',
        `_This preview expires in ${Math.round(INTRO_PREVIEW_TIMEOUT_MS / 60000)} minutes._`
    );

    return lines.join('\n');
}

// IDs and timestamps only, no titles.
function buildPreviewFile(report, guildId, invokerTag) {
    const body = [
        `Introductions sweep preview - ${guildLabel(guildId)} (${guildId})`,
        `Generated: ${new Date().toISOString()} by ${invokerTag}`,
        `Threads scanned: ${report.threadsScanned}`,
        `Departed owners found: ${report.absentOwnerIds.size} | threads that would be deleted: ${report.matches.length}`,
        '',
        'ownerId | threadId | created | archived | messageCount',
        ...report.matches.map(t => [
            t.ownerId,
            t.id,
            t.createdTimestamp ? new Date(t.createdTimestamp).toISOString() : 'unknown',
            t.archived ? 'yes' : 'no',
            typeof t.messageCount === 'number' ? t.messageCount : 'unknown'
        ].join(' | '))
    ].join('\n');

    const date = new Date().toISOString().slice(0, 10);
    return new AttachmentBuilder(Buffer.from(body, 'utf8'), { name: `intros-preview-${guildId}-${date}.txt` });
}

async function denyUnlessOwner(interaction, what) {
    if (activity.isActivityOwner(interaction.user.id)) return false;

    await activity.logUnauthorizedAttempt(interaction);
    await interaction.reply({
        content: `❌ You do not have permission to ${what}.`,
        flags: MessageFlags.Ephemeral
    });
    return true;
}

async function handleIntrosSweepCommand(interaction) {
    if (await denyUnlessOwner(interaction, 'run an introductions sweep')) return;

    const guildId = interaction.guildId;

    if (!introductions.introductionsConfigFor(guildId)) {
        return interaction.reply({
            content: '❌ Introductions cleanup is not configured for this server.',
            flags: MessageFlags.Ephemeral
        });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const report = await introductions.runCleanup(guildId, { trigger: 'sweep', mode: 'full', dryRun: true });

    if (report.skipped) {
        return interaction.editReply('⏳ An introductions cleanup is already running. Try again once it finishes.');
    }

    if (report.aborted) {
        return interaction.editReply(`❌ The scan was abandoned and nothing was deleted.\n\n${report.abortReason || 'See the log channel.'}`);
    }

    await sendStaffLog(guildId, {
        color: LOG_COLORS.gamerId,
        title: '🔍 Introductions Sweep Preview',
        description: `**${interaction.user.tag}** (<@${interaction.user.id}>) generated an introductions sweep preview for ${guildLabel(guildId)}. Nothing has been deleted.`,
        fields: [
            { name: 'Threads Scanned', value: `${report.threadsScanned}`, inline: true },
            { name: 'Would Delete', value: `${report.matches.length}`, inline: true },
            { name: 'Departed Owners', value: `${report.absentOwnerIds.size}`, inline: true },
            { name: 'Pinned, Kept', value: `${report.pinnedKept}`, inline: true },
            { name: 'No Owner, Kept', value: `${report.noOwner}`, inline: true },
            { name: 'Member List Check', value: 'Passed', inline: true }
        ],
        footer: `Owner command (${interaction.user.tag})`,
        files: [buildPreviewFile(report, guildId, interaction.user.tag)]
    });

    if (report.matches.length === 0) {
        return interaction.editReply(
            `✅ Nothing to clean up. Scanned ${report.threadsScanned} thread(s) and found none from departed members.`
        );
    }

    const token = crypto.randomBytes(8).toString('hex');

    await interaction.editReply({
        content: buildPreviewBody(report, guildId).slice(0, 1900),
        components: [buildConfirmRow(token, report.matches.length, false)],
        allowedMentions: { parse: [] }
    });

    const expiryTimer = setTimeout(() => {
        void expireSweep(token);
    }, INTRO_PREVIEW_TIMEOUT_MS);
    expiryTimer.unref?.();

    pendingSweeps.set(token, {
        guildId,
        invokerId: interaction.user.id,
        invokerTag: interaction.user.tag,
        previewCount: report.matches.length,
        interaction,
        expiryTimer,
        consumed: false
    });
}

function buildConfirmRow(token, count, disabled) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`${CUSTOM_ID_PREFIX}:confirm:${token}`)
            .setLabel(`Delete ${count} thread${count === 1 ? '' : 's'}`)
            .setStyle(ButtonStyle.Danger)
            .setDisabled(disabled),
        new ButtonBuilder()
            .setCustomId(`${CUSTOM_ID_PREFIX}:cancel:${token}`)
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(disabled)
    );
}

async function expireSweep(token) {
    const pending = pendingSweeps.get(token);
    if (!pending || pending.consumed) return;

    pendingSweeps.delete(token);

    try {
        await pending.interaction.editReply({
            content: '⌛ That introductions sweep preview expired. Nothing was deleted. Run `/intros-sweep` again for a fresh list.',
            components: [buildConfirmRow(token, pending.previewCount, true)]
        });
    } catch (error) {
        // The ephemeral token may already be gone; the log below is the record.
    }

    await sendStaffLog(pending.guildId, {
        color: LOG_COLORS.gamerId,
        title: '⌛ Introductions Sweep Expired',
        description: `An introductions sweep preview for ${guildLabel(pending.guildId)} expired without being confirmed. **Nothing was deleted.**`,
        fields: [{ name: 'Requested By', value: `**${pending.invokerTag}** (<@${pending.invokerId}>)` }]
    });
}

function isIntrosButton(customId) {
    return typeof customId === 'string' && customId.startsWith(`${CUSTOM_ID_PREFIX}:`);
}

async function handleIntrosButton(interaction) {
    const [, action, token] = interaction.customId.split(':');
    const pending = pendingSweeps.get(token);

    if (!pending) {
        return interaction.reply({
            content: '⌛ That preview is no longer valid. Nothing was deleted. Run `/intros-sweep` again.',
            flags: MessageFlags.Ephemeral
        });
    }

    // Re-checked on every press, not just at preview time.
    if (!activity.isActivityOwner(interaction.user.id) || interaction.user.id !== pending.invokerId) {
        await activity.logUnauthorizedAttempt(interaction);
        return interaction.reply({
            content: '❌ Only the person who generated this preview can act on it.',
            flags: MessageFlags.Ephemeral
        });
    }

    // Consumed before any await, so a double press cannot start two runs.
    if (pending.consumed) {
        return interaction.reply({ content: '⏳ That button has already been used.', flags: MessageFlags.Ephemeral });
    }

    pending.consumed = true;
    clearTimeout(pending.expiryTimer);
    pendingSweeps.delete(token);

    const disabledRow = buildConfirmRow(token, pending.previewCount, true);

    if (action === 'cancel') {
        await interaction.update({ content: '✋ Sweep cancelled. Nothing was deleted.', components: [disabledRow] });

        await sendStaffLog(pending.guildId, {
            color: LOG_COLORS.gamerId,
            title: '✋ Introductions Sweep Cancelled',
            description: `**${interaction.user.tag}** cancelled an introductions sweep in ${guildLabel(pending.guildId)}. **Nothing was deleted.**`
        });
        return;
    }

    if (action !== 'confirm') return;

    await interaction.update({
        content: `⏳ Deleting up to ${pending.previewCount} thread(s). A full report goes to the log channel when it finishes.`,
        components: [disabledRow]
    });

    try {
        // Re-scanned rather than trusting the preview's list: anyone who rejoined in
        // between is a current member again and keeps their thread.
        const report = await introductions.runCleanup(pending.guildId, {
            trigger: 'sweep',
            mode: 'full',
            forceLive: true
        });

        if (report.skipped) {
            await interaction.editReply({
                content: '⏳ Another cleanup started in the meantime, so this one did nothing.',
                components: []
            }).catch(() => {});
            return;
        }

        if (report.aborted && report.abortReason) {
            await interaction.editReply({
                content: `❌ The sweep was abandoned and nothing was deleted.\n\n${report.abortReason}`,
                components: []
            }).catch(() => {});
            return;
        }

        await introductions.reportCleanup(report, { force: true });

        // A long sweep can outlive the 15 minute interaction token; the staff-log report
        // is the record either way.
        await interaction.editReply({
            content: `✅ Sweep finished. Deleted **${report.deleted.length}**, failed **${report.failures.length}**.\nThe full report is in the log channel.`,
            components: []
        }).catch(() => {});
    } catch (error) {
        console.error('Introductions sweep failed:', error);

        await sendStaffLog(pending.guildId, {
            color: LOG_COLORS.error,
            title: '⚠️ Introductions Sweep Failed',
            description: `The introductions sweep of ${guildLabel(pending.guildId)} stopped with an error. Anything already deleted is in introductions-log.jsonl.`,
            fields: [errorField(error)],
            footer: `Owner command (${pending.invokerTag})`
        });

        await interaction.editReply({ content: `❌ The sweep stopped with an error: ${error.message}`, components: [] }).catch(() => {});
    }
}

async function handleIntrosCleanupCommand(interaction) {
    if (await denyUnlessOwner(interaction, 'change introductions cleanup')) return;

    const guildId = interaction.guildId;

    if (!introductions.introductionsConfigFor(guildId)) {
        return interaction.reply({
            content: '❌ Introductions cleanup is not configured for this server.',
            flags: MessageFlags.Ephemeral
        });
    }

    const sub = interaction.options.getSubcommand();

    if (sub === 'status') {
        const status = cleanupStatus(guildId);

        return interaction.reply({
            content: [
                `🧹 **Introductions cleanup — ${guildLabel(guildId)}**`,
                '',
                `**Automatic cleanup:** ${status.enabled ? 'ON — leaves and the daily reconcile delete' : 'OFF — report-only'}`,
                `**Last changed:** ${status.everSet
                    ? `<t:${Math.floor(status.changedAt / 1000)}:R> by ${status.changedByTag || status.changedBy}`
                    : 'never (defaults to off)'}`,
                '',
                '`/intros-sweep` always previews first and always deletes on Confirm, whatever this is set to.'
            ].join('\n'),
            flags: MessageFlags.Ephemeral
        });
    }

    const enable = sub === 'enable';
    const result = setCleanupEnabled(guildId, enable, interaction.user);

    if (!result.changed) {
        return interaction.reply({
            content: `ℹ️ Automatic introductions cleanup is already **${enable ? 'on' : 'off'}** in ${guildLabel(guildId)}.`,
            flags: MessageFlags.Ephemeral
        });
    }

    if (!result.saved) {
        console.error('Introductions cleanup toggle could not be persisted:', result.error);

        await interaction.reply({
            content: `⚠️ Automatic cleanup is now **${enable ? 'on' : 'off'}**, but the setting could not be written to disk`
                + ` (${result.error?.message || 'unknown error'}), so it will revert to off if the bot restarts.`,
            flags: MessageFlags.Ephemeral
        });
    } else {
        await interaction.reply({
            content: enable
                ? `🧹 Automatic introductions cleanup is now **on** in ${guildLabel(guildId)}. A departing member's introduction thread is deleted after a 60-second debounce, and the daily reconcile catches anything missed.`
                : `🧹 Automatic introductions cleanup is now **off** in ${guildLabel(guildId)}. Leaves and the daily reconcile will report what they would remove but delete nothing.\n\n\`/intros-sweep\` still deletes on Confirm.`,
            flags: MessageFlags.Ephemeral
        });
    }

    await sendStaffLog(guildId, {
        color: enable ? LOG_COLORS.gamerId : LOG_COLORS.activityDemote,
        title: enable ? '🧹 Introductions Cleanup Switched ON' : '⏸️ Introductions Cleanup Switched OFF',
        description: enable
            ? `Departing members' introduction threads will now be **deleted** automatically in ${guildLabel(guildId)}.`
            : `Automatic introductions cleanup is now **report-only** in ${guildLabel(guildId)}. Nothing is deleted automatically.`,
        fields: [
            { name: 'Changed By', value: `**${interaction.user.tag}** (<@${interaction.user.id}>)` },
            { name: 'Affects', value: 'The member-leave listener and the daily reconcile.' },
            { name: 'Does Not Affect', value: '`/intros-sweep`, which always previews first and deletes on an explicit Confirm.' },
            ...(result.saved ? [] : [{ name: '⚠️ Not Persisted', value: 'The setting could not be written to disk and will revert to off on restart.' }])
        ],
        footer: `Owner command (${interaction.user.tag})`
    });
}

module.exports = {
    INTROS_SWEEP_COMMAND,
    INTROS_CLEANUP_COMMAND,
    handleIntrosSweepCommand,
    handleIntrosCleanupCommand,
    handleIntrosButton,
    isIntrosButton,
    buildPreviewBody,
    sampleTitle,
};
