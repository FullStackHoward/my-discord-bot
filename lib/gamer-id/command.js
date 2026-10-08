// ---------------------------------------------------------------------------
// /gamer-id-sweep - the one-time retroactive pass
// ---------------------------------------------------------------------------
//
// Owner only, preview first, nothing deleted without a Confirm press. After rollout the
// automatic paths (member leave, daily reconcile) cover everything and this is never
// needed again.
//
// Like /purge, the confirm buttons route through handleInteractionCreate rather than a
// component collector, so the gating is explicit and auditable.

const crypto = require('crypto');
const {
    ActionRowBuilder,
    AttachmentBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
    PermissionFlagsBits
} = require('discord.js');
const { LOG_COLORS, GAMER_ID_PREVIEW_TIMEOUT_MS } = require('../config');
const { sendStaffLog, errorField } = require('../staff-log');
const { guildLabel } = require('../utils');
const activity = require('../activity');
const gamerId = require('./index');

const CUSTOM_ID_PREFIX = 'gamerid';

// token -> pending preview. In memory only, so a restart drops every pending confirm,
// which is the safe direction.
const pendingSweeps = new Map();

const GAMER_ID_COMMAND = {
    name: 'gamer-id-sweep',
    description: 'Preview and remove gamer ID posts from members who have left (owner only, always confirms first)',
    defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
    options: []
};

async function handleGamerIdSweepCommand(interaction) {
    if (!activity.isActivityOwner(interaction.user.id)) {
        await activity.logUnauthorizedAttempt(interaction);
        return interaction.reply({
            content: '❌ You do not have permission to run a gamer ID sweep.',
            flags: MessageFlags.Ephemeral
        });
    }

    const guildId = interaction.guildId;

    if (!gamerId.gamerIdConfigFor(guildId)) {
        return interaction.reply({
            content: '❌ Gamer ID cleanup is not configured for this server.',
            flags: MessageFlags.Ephemeral
        });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // dryRun forces read-only regardless of GAMER_ID_CLEANUP_ENABLED, so the preview can
    // never delete anything even in live mode.
    const report = await gamerId.runCleanup(guildId, { trigger: 'sweep', mode: 'full', dryRun: true });

    if (report.skipped) {
        return interaction.editReply('⏳ A gamer ID cleanup is already running. Try again once it finishes.');
    }

    if (report.aborted) {
        return interaction.editReply(`❌ The scan was abandoned and nothing was deleted.\n\n${report.abortReason || 'See the log channel.'}`);
    }

    const byThread = new Map();
    for (const match of report.matches) {
        if (!byThread.has(match.threadName)) byThread.set(match.threadName, 0);
        byThread.set(match.threadName, byThread.get(match.threadName) + 1);
    }

    const perThread = [...byThread.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => `• **${name}** — ${count}`)
        .join('\n') || 'None';

    // Identifiers only. The messages being removed are gamer IDs, so no content is ever
    // written to the attachment, the embed or the console.
    const listBody = [
        `Gamer ID sweep preview - ${guildLabel(guildId)} (${guildId})`,
        `Generated: ${new Date().toISOString()} by ${interaction.user.tag}`,
        `Threads scanned: ${report.threadsScanned} | messages scanned: ${report.messagesScanned}`,
        `Departed members found: ${report.absentAuthorIds.size} | messages that would be deleted: ${report.matches.length}`,
        '',
        'authorId | thread | messageId | posted',
        ...report.matches.map(m => [
            m.authorId,
            m.threadName,
            m.message.id,
            new Date(m.message.createdTimestamp).toISOString()
        ].join(' | '))
    ].join('\n');

    const date = new Date().toISOString().slice(0, 10);
    const listFile = new AttachmentBuilder(Buffer.from(listBody, 'utf8'), {
        name: `gamer-id-preview-${guildId}-${date}.txt`
    });

    await sendStaffLog(guildId, {
        color: LOG_COLORS.gamerId,
        title: '🔍 Gamer ID Sweep Preview',
        description: `**${interaction.user.tag}** (<@${interaction.user.id}>) generated a gamer ID sweep preview for ${guildLabel(guildId)}. Nothing has been deleted.`,
        fields: [
            { name: 'Threads Scanned', value: `${report.threadsScanned}`, inline: true },
            { name: 'Messages Scanned', value: `${report.messagesScanned}`, inline: true },
            { name: 'Would Delete', value: `${report.matches.length}`, inline: true },
            { name: 'Departed Members', value: `${report.absentAuthorIds.size}`, inline: true },
            { name: 'Member List Check', value: 'Passed', inline: true }
        ],
        footer: `Owner command (${interaction.user.tag})`,
        files: [listFile]
    });

    if (report.matches.length === 0) {
        return interaction.editReply(
            `✅ Nothing to clean up. Scanned ${report.messagesScanned} message(s) across ${report.threadsScanned} thread(s) `
            + `and found no posts from departed members.`
        );
    }

    const token = crypto.randomBytes(8).toString('hex');

    const body = [
        `**Gamer ID sweep preview — ${guildLabel(guildId)}** · nothing has been deleted yet.`,
        '',
        `**${report.matches.length}** message(s) from **${report.absentAuthorIds.size}** departed member(s) would be removed.`,
        `Scanned ${report.messagesScanned} message(s) across ${report.threadsScanned} thread(s). Member list check: **passed**.`,
        '',
        '**Per thread:**',
        perThread,
        '',
        '_The full list, with author and message IDs, is attached to the log channel post._',
        `_This preview expires in ${Math.round(GAMER_ID_PREVIEW_TIMEOUT_MS / 60000)} minutes._`
    ].join('\n');

    await interaction.editReply({
        content: body.slice(0, 1900),
        components: [buildConfirmRow(token, report.matches.length, false)]
    });

    const expiryTimer = setTimeout(() => {
        void expireSweep(token);
    }, GAMER_ID_PREVIEW_TIMEOUT_MS);
    expiryTimer.unref?.();

    pendingSweeps.set(token, {
        guildId,
        invokerId: interaction.user.id,
        invokerTag: interaction.user.tag,
        previewCount: report.matches.length,
        previewAuthorCount: report.absentAuthorIds.size,
        interaction,
        expiryTimer,
        consumed: false
    });
}

function buildConfirmRow(token, count, disabled) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`${CUSTOM_ID_PREFIX}:confirm:${token}`)
            .setLabel(`Delete ${count} message${count === 1 ? '' : 's'}`)
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
            content: '⌛ That gamer ID sweep preview expired. Nothing was deleted. Run `/gamer-id-sweep` again for a fresh list.',
            components: [buildConfirmRow(token, pending.previewCount, true)]
        });
    } catch (error) {
        // The ephemeral token may already be gone; the log below is the record.
    }

    await sendStaffLog(pending.guildId, {
        color: LOG_COLORS.gamerId,
        title: '⌛ Gamer ID Sweep Expired',
        description: `A gamer ID sweep preview for ${guildLabel(pending.guildId)} expired without being confirmed. **Nothing was deleted.**`,
        fields: [{ name: 'Requested By', value: `**${pending.invokerTag}** (<@${pending.invokerId}>)` }]
    });
}

function isGamerIdButton(customId) {
    return typeof customId === 'string' && customId.startsWith(`${CUSTOM_ID_PREFIX}:`);
}

async function handleGamerIdButton(interaction) {
    const [, action, token] = interaction.customId.split(':');
    const pending = pendingSweeps.get(token);

    if (!pending) {
        return interaction.reply({
            content: '⌛ That preview is no longer valid. Nothing was deleted. Run `/gamer-id-sweep` again.',
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
            title: '✋ Gamer ID Sweep Cancelled',
            description: `**${interaction.user.tag}** cancelled a gamer ID sweep in ${guildLabel(pending.guildId)}. **Nothing was deleted.**`
        });
        return;
    }

    if (action !== 'confirm') return;

    await interaction.update({
        content: `⏳ Deleting up to ${pending.previewCount} message(s). A full report goes to the log channel when it finishes.`,
        components: [disabledRow]
    });

    try {
        // Deliberately re-scanned rather than trusting the preview's list: anyone who
        // rejoined in between is a current member again and their posts stay.
        const report = await gamerId.runCleanup(pending.guildId, { trigger: 'sweep', mode: 'full' });

        if (report.skipped) {
            return interaction.editReply({
                content: '⏳ Another cleanup started in the meantime, so this one did nothing.',
                components: []
            });
        }

        await gamerId.reportCleanup(report, { force: true });

        const summary = report.live
            ? `✅ Sweep finished. Deleted **${report.deleted.length}**, failed **${report.failures.length}**.`
            : `ℹ️ Report-only mode is on, so nothing was deleted. **${report.matches.length}** message(s) would have been removed.`;

        await interaction.editReply({
            content: `${summary}\nThe full report is in the log channel.`,
            components: []
        });
    } catch (error) {
        console.error('Gamer ID sweep failed:', error);

        await sendStaffLog(pending.guildId, {
            color: LOG_COLORS.error,
            title: '⚠️ Gamer ID Sweep Failed',
            description: `The gamer ID sweep of ${guildLabel(pending.guildId)} stopped with an error. Anything already deleted is in the log above and in the gamer ID log file.`,
            fields: [errorField(error)],
            footer: `Owner command (${pending.invokerTag})`
        });

        await interaction.editReply({ content: `❌ The sweep stopped with an error: ${error.message}`, components: [] }).catch(() => {});
    }
}

module.exports = {
    GAMER_ID_COMMAND,
    handleGamerIdSweepCommand,
    handleGamerIdButton,
    isGamerIdButton,
};
