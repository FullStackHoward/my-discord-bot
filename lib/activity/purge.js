// ---------------------------------------------------------------------------
// /purge and /purge-exempt
// ---------------------------------------------------------------------------
//
// HARD RULE (spec section 1.1): the execute step below is the only place in the whole
// codebase outside the Application Server features that removes a member from a main
// server. It runs only after Howard presses Confirm on a specific preview he just
// generated. There is deliberately:
//
//   - no timer, interval, cron or startup path that reaches executePurge
//   - no env var or config value that skips the confirmation
//   - no "auto purge" or "purge after N days" option, not even disabled
//   - no resume-after-restart: a dead process means the rest are simply not removed
//
// Holding the Inactive role is a label. It never causes a removal on its own. Anywhere
// state is ambiguous (member not kickable, missing from the re-check, unreadable roles)
// the member is skipped, never removed.

const crypto = require('crypto');
const fs = require('fs');
const {
    ActionRowBuilder,
    AttachmentBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags
} = require('discord.js');
const {
    LOG_COLORS,
    SERVER_CONFIGS,
    TIER_ORDER,
    ACTIVITY_ROLES_ENABLED,
    ACTIVITY_THRESHOLD_DAYS,
    DM_CLOSED_ERROR_CODE,
    PURGE_ACTION_DELAY_MS,
    PURGE_CONFIRM_TIMEOUT_MS,
    PURGE_LOG_PATH,
    PURGE_MAX_CONSECUTIVE_FAILURES,
    PURGE_REAPPLY_URL,
    MS_PER_DAY
} = require('../config');
const { sendStaffLog, errorField } = require('../staff-log');
const {
    resolveGuild,
    fetchAllMembers,
    guildLabel,
    isMainServer,
    otherMainServerId,
    respondWithError,
    sleep
} = require('../utils');
const activity = require('./index');

// Only one purge may be in flight across the whole process.
let purgeRunning = false;

// And only one bulk exemption clear. Kept separate from purgeRunning so the two guards
// read independently, but each refuses while the other is going.
let exemptClearRunning = false;

// token -> pending preview. In memory only: a restart drops every pending confirm,
// which is the safe direction.
const pendingPurges = new Map();

const CUSTOM_ID_PREFIX = 'purge';

// A distinct prefix, so isPurgeButton's startsWith('purge:') can never match a clear
// button and route it into the removal flow.
const EXEMPT_CLEAR_PREFIX = 'exclear';

// token -> pending clear preview. In memory only, like the purge previews.
const pendingClears = new Map();

// ---------------------------------------------------------------------------
// DM copy
// ---------------------------------------------------------------------------

// Kept as one function so the marketing pass can rewrite it without touching logic.
function purgeDmText(member, guild) {
    const name = member.displayName || member.user.username;

    return `Hi ${name}, this is an automated message from ${guild.name}. `
        + `We periodically remove members who have not been active for a while, and you have been removed for that reason. `
        + `This is not a ban and you did nothing wrong.\n\n`
        + `If you would like to come back, you are welcome to reapply any time at ${PURGE_REAPPLY_URL}. `
        + `We would be glad to see you again.`;
}

const KICK_REASON = `Inactive purge: held the Inactive role (no activity for ${ACTIVITY_THRESHOLD_DAYS}+ days)`;

// ---------------------------------------------------------------------------
// Candidate selection
// ---------------------------------------------------------------------------

// Everyone holding the Inactive role, split into those who may be removed and those the
// safety rules hold back. The role is the source of truth because it is what Howard sees
// on the member list, but a stale role must never be enough on its own.
function buildCandidates(guild, members, now) {
    const guildId = guild.id;
    const config = activity.activityConfigFor(guildId);

    const candidates = [];
    const skippedExempt = [];
    const skippedActive = [];

    for (const member of members.values()) {
        if (!member.roles.cache.has(config.inactiveRoleId)) continue;

        const verdict = activity.classifyMember(member, guildId, now);

        // Staff, bots, the owner, subscribers and anyone manually exempted. These
        // shouldn't be holding Inactive at all, but a leftover role is not a reason to
        // remove someone.
        if (verdict.status === 'exempt') {
            skippedExempt.push({ member, verdict });
            continue;
        }

        // A stale Inactive role on someone who now reads as active, e.g. an instant
        // re-promotion that failed. Listed separately so it is visible, never removed.
        if (verdict.status === 'active') {
            skippedActive.push({ member, verdict });
            continue;
        }

        candidates.push({
            member,
            verdict,
            kickable: member.kickable,
            recentlyJoined: Boolean(member.joinedTimestamp)
                && now - member.joinedTimestamp < ACTIVITY_THRESHOLD_DAYS * MS_PER_DAY
        });
    }

    // Longest inactive first, so the clearest cases are at the top. No recorded activity
    // at all sorts above everyone.
    candidates.sort((a, b) => (a.verdict.lastActiveAt || 0) - (b.verdict.lastActiveAt || 0));

    return {
        removable: candidates.filter(c => c.kickable),
        notKickable: candidates.filter(c => !c.kickable),
        skippedExempt,
        skippedActive
    };
}

// Membership of the other main server, purely as context on the preview line.
async function fetchOtherServerMemberIds(guildId) {
    if (!isMainServer(guildId)) return new Set();

    const otherId = otherMainServerId(guildId);
    const otherGuild = await resolveGuild(otherId);
    if (!otherGuild) return new Set();

    try {
        const members = await fetchAllMembers(otherGuild);
        return new Set(members.keys());
    } catch (error) {
        console.error(`Purge preview: could not fetch ${guildLabel(otherId)} members for the cross-server flag:`, error);
        return new Set();
    }
}

function formatCandidateLine(candidate, otherServerIds, guildId) {
    const { member, verdict, recentlyJoined } = candidate;

    const parts = [
        member.user?.tag || member.id,
        member.id,
        verdict.lastActiveAt
            ? `last active ${new Date(verdict.lastActiveAt).toISOString().slice(0, 10)} (${verdict.lastSignal})`
            : 'no recorded activity',
        member.joinedTimestamp
            ? `joined ${new Date(member.joinedTimestamp).toISOString().slice(0, 10)}`
            : 'join date unknown'
    ];

    if (otherServerIds.has(member.id)) {
        parts.push(`also in ${guildLabel(otherMainServerId(guildId))}`);
    }

    if (recentlyJoined) parts.push('recently joined');
    if (!candidate.kickable) parts.push('CANNOT REMOVE (role hierarchy)');

    return parts.join(' | ');
}

// ---------------------------------------------------------------------------
// /purge - preview
// ---------------------------------------------------------------------------

async function handlePurgeCommand(interaction) {
    if (!activity.isActivityOwner(interaction.user.id)) {
        await activity.logUnauthorizedAttempt(interaction);
        return interaction.reply({
            content: '❌ You do not have permission to run a purge.',
            flags: MessageFlags.Ephemeral
        });
    }

    const guildId = interaction.guildId;
    const refuse = async (reason) => {
        console.log(`Purge refused in ${guildId}: ${reason}`);

        await sendStaffLog(guildId, {
            color: LOG_COLORS.error,
            title: '⛔ Purge Not Run',
            description: `A purge was requested in ${guildLabel(guildId)} but did not run.`,
            fields: [
                { name: 'Reason', value: reason },
                { name: 'Requested By', value: `**${interaction.user.tag}** (<@${interaction.user.id}>)` }
            ]
        });

        return interaction.reply({ content: `❌ ${reason}`, flags: MessageFlags.Ephemeral });
    };

    if (purgeRunning) {
        return refuse('A purge is already running. Wait for it to finish.');
    }

    if (!ACTIVITY_ROLES_ENABLED) {
        return refuse('Activity roles are in tracking-only mode, so the Inactive role is not being maintained and the candidate list would not be trustworthy. Set ACTIVITY_ROLES_ENABLED=true and restart first.');
    }

    const state = activity.guildState(guildId);
    if (state.seeding.status !== 'complete') {
        return refuse(`Activity seeding for this server is "${state.seeding.status}", not complete, so recorded activity is incomplete. Wait for seeding to finish.`);
    }

    // Subscriber exemption is driven entirely by the configured tier role IDs. With none
    // of them set, getMemberTier can never return a tier, so every paying member would
    // read as an ordinary member and could show up as a candidate. Refuse rather than
    // present a list that silently includes subscribers. Some-but-not-all is left to the
    // startup warning, since partial config still protects the configured tiers.
    const tierRoleIds = SERVER_CONFIGS[guildId]?.tierRoleIds || {};
    if (!TIER_ORDER.some(tierName => tierRoleIds[tierName])) {
        return refuse('No subscription tier role IDs are configured for this server, so subscribers cannot be recognized and would appear purgeable. Set the tier role IDs in .env and restart before running a purge.');
    }

    // The cross-server rule decides who is safe, so a purge must not run on a stale or
    // empty view of the other server. Unlike the sweep, which warns and carries on, here
    // being wrong means removing someone - so it refuses.
    const crossServer = await activity.ensureOtherServerReady(guildId);
    if (!crossServer.ok) {
        return refuse(`${crossServer.reason} Members active there would wrongly appear purgeable here, so the purge was not run.`);
    }

    if (crossServer.otherId) {
        const otherState = activity.guildState(crossServer.otherId);

        if (otherState.seeding.status !== 'complete') {
            return refuse(`Activity seeding for ${guildLabel(crossServer.otherId)} is "${otherState.seeding.status}", not complete. Its history is incomplete, so a member active there could still look purgeable here.`);
        }
    }

    // Decided per run on the command itself, and required, so there is no default to
    // forget about and no restart needed to change it. Read once here and stored on the
    // pending purge, so execute uses exactly what the preview showed.
    const sendDm = interaction.options.getBoolean('send_dm') === true;
    const dmLabel = sendDm ? 'Yes' : 'No';

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const guild = await resolveGuild(guildId);
    if (!guild) {
        return interaction.editReply('❌ Could not resolve this server.');
    }

    let members;

    try {
        members = await fetchAllMembers(guild);
    } catch (error) {
        console.error('Purge preview: member fetch failed:', error);
        return interaction.editReply(`❌ Could not fetch the member list: ${error.message}`);
    }

    const now = Date.now();
    const groups = buildCandidates(guild, members, now);
    const otherServerIds = await fetchOtherServerMemberIds(guildId);

    const exemptCounts = {};
    for (const { verdict } of groups.skippedExempt) {
        const label = activity.exemptReasonLabel(verdict.exemptReason);
        exemptCounts[label] = (exemptCounts[label] || 0) + 1;
    }

    const warnings = [];
    const trackingAge = now - (state.trackingStartedAt || now);

    if (trackingAge < ACTIVITY_THRESHOLD_DAYS * MS_PER_DAY) {
        warnings.push(
            `⚠️ Voice and event activity has only been tracked since <t:${Math.floor((state.trackingStartedAt || now) / 1000)}:D>, `
            + `less than the ${ACTIVITY_THRESHOLD_DAYS}-day window. Members whose only recent activity was voice may be mislabeled Inactive.`
        );
    }

    const recentlyJoinedCount = groups.removable.filter(c => c.recentlyJoined).length;
    if (recentlyJoinedCount > 0) {
        warnings.push(`⚠️ ${recentlyJoinedCount} candidate(s) joined within the last ${ACTIVITY_THRESHOLD_DAYS} days and are marked "recently joined".`);
    }

    const summaryFields = [
        { name: 'Would Remove', value: `${groups.removable.length}`, inline: true },
        { name: 'Cannot Remove (Hierarchy)', value: `${groups.notKickable.length}`, inline: true },
        { name: 'Skipped (Exempt)', value: `${groups.skippedExempt.length}`, inline: true },
        { name: 'Skipped (Looks Active)', value: `${groups.skippedActive.length}`, inline: true },
        { name: 'DM Before Removal', value: dmLabel, inline: true },
        { name: 'Label Window', value: `${ACTIVITY_THRESHOLD_DAYS} days`, inline: true },
        {
            name: 'Exempt Breakdown',
            value: Object.entries(exemptCounts).map(([k, v]) => `${k}: ${v}`).join('\n') || 'None'
        }
    ];

    if (warnings.length > 0) {
        summaryFields.push({ name: 'Warnings', value: warnings.join('\n\n') });
    }

    // The full list as a text file: a preview can run to hundreds of lines, which no
    // embed can hold.
    const listBody = [
        `Purge preview - ${guildLabel(guildId)} (${guildId})`,
        `Generated: ${new Date().toISOString()} by ${interaction.user.tag}`,
        `Label window: ${ACTIVITY_THRESHOLD_DAYS} days`,
        '',
        `WOULD REMOVE (${groups.removable.length}), longest inactive first:`,
        ...groups.removable.map(c => `  ${formatCandidateLine(c, otherServerIds, guildId)}`),
        '',
        `CANNOT REMOVE - role hierarchy (${groups.notKickable.length}):`,
        ...groups.notKickable.map(c => `  ${formatCandidateLine(c, otherServerIds, guildId)}`),
        '',
        `SKIPPED - exempt (${groups.skippedExempt.length}):`,
        ...groups.skippedExempt.map(({ member, verdict }) =>
            `  ${member.user?.tag || member.id} | ${member.id} | ${activity.exemptReasonLabel(verdict.exemptReason)}`),
        '',
        `SKIPPED - looks active despite holding Inactive (${groups.skippedActive.length}):`,
        ...groups.skippedActive.map(({ member, verdict }) =>
            `  ${member.user?.tag || member.id} | ${member.id} | last active ${new Date(verdict.lastActiveAt).toISOString().slice(0, 10)} (${verdict.lastSignal})`)
    ].join('\n');

    const date = new Date().toISOString().slice(0, 10);
    const listFile = new AttachmentBuilder(Buffer.from(listBody, 'utf8'), {
        name: `purge-preview-${guildId}-${date}.txt`
    });

    // Preview is logged every time, whether or not it is ever confirmed.
    await sendStaffLog(guildId, {
        color: LOG_COLORS.purge,
        title: '🔍 Purge Preview',
        description: `**${interaction.user.tag}** (<@${interaction.user.id}>) generated a purge preview for ${guildLabel(guildId)}. Nothing has been removed.`,
        fields: summaryFields,
        footer: `Owner command (${interaction.user.tag})`,
        files: [listFile]
    });

    if (groups.removable.length === 0) {
        return interaction.editReply({
            content: '✅ Nothing to purge: no removable members are currently holding the Inactive role.\n\n'
                + `Skipped: ${groups.skippedExempt.length} exempt, ${groups.skippedActive.length} look active, ${groups.notKickable.length} cannot be removed.`
        });
    }

    // Short previews render inline; long ones go out as the attachment.
    const inlineList = groups.removable
        .slice(0, 15)
        .map(c => `• ${formatCandidateLine(c, otherServerIds, guildId)}`)
        .join('\n');

    const token = crypto.randomBytes(8).toString('hex');

    const body = [
        `**Purge preview for ${guildLabel(guildId)}** - nothing has been removed yet.`,
        '',
        `**${groups.removable.length}** member(s) would be removed.`,
        `Skipped: ${groups.skippedExempt.length} exempt, ${groups.skippedActive.length} look active, ${groups.notKickable.length} cannot be removed (role hierarchy).`,
        `DM before removal: **${dmLabel}**`,
        ...(warnings.length > 0 ? ['', ...warnings] : []),
        '',
        groups.removable.length > 15
            ? `First 15 (longest inactive first); the full list is attached to the log channel post:\n${inlineList}`
            : `Longest inactive first:\n${inlineList}`,
        '',
        `_This preview expires in ${Math.round(PURGE_CONFIRM_TIMEOUT_MS / 60000)} minutes._`
    ].join('\n');

    const row = buildConfirmRow(token, groups.removable.length, false);

    await interaction.editReply({ content: body.slice(0, 1900), components: [row] });

    const expiryTimer = setTimeout(() => {
        void expirePurge(token);
    }, PURGE_CONFIRM_TIMEOUT_MS);
    expiryTimer.unref?.();

    pendingPurges.set(token, {
        guildId,
        invokerId: interaction.user.id,
        invokerTag: interaction.user.tag,
        candidateIds: groups.removable.map(c => c.member.id),
        previewCount: groups.removable.length,
        sendDm,
        dmLabel,
        interaction,
        expiryTimer,
        consumed: false
    });
}

function buildConfirmRow(token, count, disabled) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`${CUSTOM_ID_PREFIX}:confirm:${token}`)
            .setLabel(`Purge ${count} member${count === 1 ? '' : 's'}`)
            .setStyle(ButtonStyle.Danger)
            .setDisabled(disabled),
        new ButtonBuilder()
            .setCustomId(`${CUSTOM_ID_PREFIX}:cancel:${token}`)
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(disabled)
    );
}

async function expirePurge(token) {
    const pending = pendingPurges.get(token);
    if (!pending || pending.consumed) return;

    pendingPurges.delete(token);

    try {
        await pending.interaction.editReply({
            content: '⌛ That purge preview expired. Nothing was removed. Run `/purge` again for a fresh list.',
            components: [buildConfirmRow(token, pending.previewCount, true)]
        });
    } catch (error) {
        // The ephemeral token may already be gone; the log below is the real record.
    }

    await sendStaffLog(pending.guildId, {
        color: LOG_COLORS.activity,
        title: '⌛ Purge Expired',
        description: `A purge preview for ${guildLabel(pending.guildId)} expired without being confirmed. **Nothing was removed.**`,
        fields: [
            { name: 'Requested By', value: `**${pending.invokerTag}** (<@${pending.invokerId}>)` },
            { name: 'Candidates In Preview', value: `${pending.previewCount}`, inline: true }
        ]
    });
}

// ---------------------------------------------------------------------------
// Confirm / Cancel
// ---------------------------------------------------------------------------

// Routed from handleInteractionCreate rather than an awaitMessageComponent collector, so
// the gating is explicit and auditable and does not depend on collector behavior for
// ephemeral replies.
function isPurgeButton(customId) {
    return typeof customId === 'string' && customId.startsWith(`${CUSTOM_ID_PREFIX}:`);
}

async function handlePurgeButton(interaction) {
    const [, action, token] = interaction.customId.split(':');
    const pending = pendingPurges.get(token);

    if (!pending) {
        return interaction.reply({
            content: '⌛ That purge preview is no longer valid. Nothing was removed. Run `/purge` again.',
            flags: MessageFlags.Ephemeral
        });
    }

    // Belt and braces: only the owner, and only the person who generated this preview.
    if (!activity.isActivityOwner(interaction.user.id) || interaction.user.id !== pending.invokerId) {
        await activity.logUnauthorizedAttempt(interaction);
        return interaction.reply({
            content: '❌ Only the person who generated this preview can act on it.',
            flags: MessageFlags.Ephemeral
        });
    }

    // Consumed before any await, so a double press cannot start a second run.
    if (pending.consumed) {
        return interaction.reply({
            content: '⏳ That button has already been used.',
            flags: MessageFlags.Ephemeral
        });
    }

    pending.consumed = true;
    clearTimeout(pending.expiryTimer);
    pendingPurges.delete(token);

    const disabledRow = buildConfirmRow(token, pending.previewCount, true);

    if (action === 'cancel') {
        await interaction.update({
            content: '✋ Purge cancelled. Nothing was removed.',
            components: [disabledRow]
        });

        await sendStaffLog(pending.guildId, {
            color: LOG_COLORS.activity,
            title: '✋ Purge Cancelled',
            description: `**${interaction.user.tag}** (<@${interaction.user.id}>) cancelled a purge in ${guildLabel(pending.guildId)}. **Nothing was removed.**`,
            fields: [{ name: 'Candidates In Preview', value: `${pending.previewCount}`, inline: true }]
        });
        return;
    }

    if (action !== 'confirm') return;

    if (purgeRunning) {
        return interaction.update({
            content: '❌ Another purge started in the meantime. Nothing was removed by this one.',
            components: [disabledRow]
        });
    }

    await interaction.update({
        content: `⏳ Purging up to ${pending.previewCount} member(s). This posts a full report to the log channel when it finishes.`,
        components: [disabledRow]
    });

    await executePurge(pending, interaction);
}

// ---------------------------------------------------------------------------
// Execute - the ONE place that removes a member from a main server
// ---------------------------------------------------------------------------

async function executePurge(pending, interaction) {
    purgeRunning = true;

    const { guildId, sendDm } = pending;
    const dmLabel = pending.dmLabel || (sendDm ? 'Yes' : 'No');
    const results = [];
    let consecutiveFailures = 0;
    let aborted = false;
    let lastError = null;

    try {
        const guild = await resolveGuild(guildId);
        if (!guild) throw new Error('Guild could not be resolved at execution time.');

        // Re-checked here as well as at preview: the recompute below leans on the other
        // server's cache, so running it cold would quietly undo the cross-server
        // protection for everyone in the list.
        const crossServer = await activity.ensureOtherServerReady(guildId);

        if (!crossServer.ok) {
            await sendStaffLog(guildId, {
                color: LOG_COLORS.error,
                title: '🛑 Purge Aborted Before Removing Anyone',
                description: `The confirmed purge of ${guildLabel(guildId)} was abandoned before any DM or removal. **Nobody was removed.**`,
                fields: [
                    { name: 'Reason', value: crossServer.reason },
                    { name: 'Why This Matters', value: 'Without that check, members active in the other main server would wrongly be treated as purgeable.' }
                ],
                footer: `Owner command (${pending.invokerTag})`
            });

            await interaction.editReply({
                content: `🛑 Purge aborted before removing anyone. ${crossServer.reason}\n\nNobody was removed. Run \`/purge\` again once that is resolved.`,
                components: []
            }).catch(() => {});
            return;
        }

        // Recomputed from scratch, then intersected with the preview, so anyone who
        // became active, got exempted or left in between is dropped rather than removed.
        const members = await fetchAllMembers(guild);
        const fresh = buildCandidates(guild, members, Date.now());
        const stillEligible = new Set(fresh.removable.map(c => c.member.id));

        const toProcess = pending.candidateIds.filter(id => stillEligible.has(id));
        const dropped = pending.candidateIds.length - toProcess.length;

        await sendStaffLog(guildId, {
            color: LOG_COLORS.purge,
            title: '⚠️ Purge Confirmed',
            description: `**${pending.invokerTag}** (<@${pending.invokerId}>) confirmed a purge in ${guildLabel(guildId)}.`,
            fields: [
                { name: 'In Preview', value: `${pending.candidateIds.length}`, inline: true },
                { name: 'Still Eligible', value: `${toProcess.length}`, inline: true },
                { name: 'Dropped Since Preview', value: `${dropped}`, inline: true },
                { name: 'DM Before Removal', value: dmLabel, inline: true },
                {
                    name: 'Why Members Get Dropped',
                    value: 'They became active, were exempted, lost the Inactive role, or left the server between the preview and the confirm.'
                }
            ],
            footer: `Owner command (${pending.invokerTag})`
        });

        for (const userId of toProcess) {
            const member = members.get(userId);

            // Ambiguous state: skip, never remove.
            if (!member) {
                results.push({ userId, tag: 'unknown', removed: false, dm: 'skipped', error: 'Member not found at execution time' });
                continue;
            }

            const verdict = activity.classifyMember(member, guildId, Date.now());
            let dmResult = 'not sent';

            if (sendDm) {
                try {
                    await member.send(purgeDmText(member, guild));
                    dmResult = 'sent';
                } catch (dmError) {
                    dmResult = dmError.code === DM_CLOSED_ERROR_CODE ? 'closed' : 'failed';
                }
            }

            // Re-checked immediately before the removal: hierarchy can change mid-run.
            if (!member.kickable) {
                results.push({
                    userId, tag: member.user?.tag || userId, removed: false, dm: dmResult,
                    error: 'Not removable (role hierarchy or missing permission)',
                    lastActiveAt: verdict.lastActiveAt, joinedAt: member.joinedTimestamp
                });
                appendPurgeLogLine(guildId, pending, results[results.length - 1], verdict, member);

                await sendStaffLog(guildId, {
                    color: LOG_COLORS.error,
                    title: '⚠️ Purge Removal Failed',
                    description: `**${member.user?.tag || userId}** (<@${userId}>) could not be removed from ${guildLabel(guildId)}.`,
                    fields: [
                        { name: 'User ID', value: userId, inline: true },
                        { name: 'Reason', value: 'Not removable: role hierarchy or missing Kick Members permission.' }
                    ],
                    footer: `Owner command (${pending.invokerTag})`
                });

                consecutiveFailures++;
                if (consecutiveFailures >= PURGE_MAX_CONSECUTIVE_FAILURES) { aborted = true; break; }
                await sleep(PURGE_ACTION_DELAY_MS);
                continue;
            }

            try {
                // ---------------------------------------------------------------
                // The single member-removal call in lib/activity/. Reached only from
                // a Confirm press on a preview generated moments earlier.
                // ---------------------------------------------------------------
                await member.kick(KICK_REASON);

                activity.markRecentlyPurged(guildId, userId);
                activity.forgetMember(guildId, userId);
                consecutiveFailures = 0;

                const record = {
                    userId, tag: member.user?.tag || userId, removed: true, dm: dmResult, error: null,
                    lastActiveAt: verdict.lastActiveAt, joinedAt: member.joinedTimestamp
                };
                results.push(record);
                appendPurgeLogLine(guildId, pending, record, verdict, member);

                console.log(`Purge: removed ${record.tag} from ${guild.name} (dm: ${dmResult})`);

                await sendStaffLog(guildId, {
                    color: LOG_COLORS.kick,
                    title: '👢 Purged Member',
                    description: `**${record.tag}** (<@${userId}>) was removed from ${guildLabel(guildId)}.`,
                    fields: [
                        { name: 'User ID', value: userId, inline: true },
                        { name: 'DM Result', value: dmResult, inline: true },
                        {
                            name: 'Last Active',
                            value: verdict.lastActiveAt
                                ? `<t:${Math.floor(verdict.lastActiveAt / 1000)}:R> (${verdict.lastSignal})`
                                : 'No recorded activity',
                            inline: true
                        },
                        {
                            name: 'Joined',
                            value: member.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:D>` : 'Unknown',
                            inline: true
                        },
                        { name: 'Reason Given', value: KICK_REASON }
                    ],
                    footer: `Owner command (${pending.invokerTag})`
                });
            } catch (error) {
                lastError = error;
                consecutiveFailures++;

                const record = {
                    userId, tag: member.user?.tag || userId, removed: false, dm: dmResult,
                    error: error.message, lastActiveAt: verdict.lastActiveAt, joinedAt: member.joinedTimestamp
                };
                results.push(record);
                appendPurgeLogLine(guildId, pending, record, verdict, member);

                console.error(`Purge: failed to remove ${record.tag}:`, error);

                await sendStaffLog(guildId, {
                    color: LOG_COLORS.error,
                    title: '⚠️ Purge Removal Failed',
                    description: `**${record.tag}** (<@${userId}>) could not be removed from ${guildLabel(guildId)}.`,
                    fields: [{ name: 'User ID', value: userId, inline: true }, errorField(error)],
                    footer: `Owner command (${pending.invokerTag})`
                });

                if (consecutiveFailures >= PURGE_MAX_CONSECUTIVE_FAILURES) { aborted = true; break; }
            }

            await sleep(PURGE_ACTION_DELAY_MS);
        }

        activity.flushActivityState(true);

        const removed = results.filter(r => r.removed).length;
        const failed = results.filter(r => !r.removed).length;
        const dmCounts = {
            sent: results.filter(r => r.dm === 'sent').length,
            closed: results.filter(r => r.dm === 'closed').length,
            failed: results.filter(r => r.dm === 'failed').length
        };

        if (aborted) {
            await sendStaffLog(guildId, {
                color: LOG_COLORS.error,
                title: '🛑 Purge Aborted',
                description: `The purge in ${guildLabel(guildId)} stopped after ${PURGE_MAX_CONSECUTIVE_FAILURES} consecutive failures.`,
                fields: [
                    { name: 'Removed Before Stopping', value: `${removed}`, inline: true },
                    { name: 'Left Unprocessed', value: `${toProcess.length - results.length}`, inline: true },
                    ...(lastError ? [errorField(lastError)] : [])
                ],
                footer: `Owner command (${pending.invokerTag})`
            });
        }

        const reportBody = [
            `Purge report - ${guildLabel(guildId)} (${guildId})`,
            `Executed: ${new Date().toISOString()} by ${pending.invokerTag}`,
            `DM before removal: ${dmLabel}`,
            `In preview: ${pending.candidateIds.length} | processed: ${results.length} | removed: ${removed} | failed: ${failed}`,
            aborted ? `ABORTED after ${PURGE_MAX_CONSECUTIVE_FAILURES} consecutive failures` : '',
            '',
            ...results.map(r => [
                r.removed ? 'REMOVED' : 'FAILED ',
                r.tag,
                r.userId,
                `dm: ${r.dm}`,
                r.lastActiveAt ? `last active ${new Date(r.lastActiveAt).toISOString().slice(0, 10)}` : 'no recorded activity',
                r.error ? `error: ${r.error}` : ''
            ].filter(Boolean).join(' | '))
        ].filter(line => line !== '').join('\n');

        const date = new Date().toISOString().slice(0, 10);

        // The permanent record. The interaction token can expire on a long run, so this
        // post is the copy that matters.
        await sendStaffLog(guildId, {
            color: LOG_COLORS.purge,
            title: '📋 Purge Complete',
            description: `The purge of ${guildLabel(guildId)} has finished.`,
            fields: [
                { name: 'Removed', value: `${removed}`, inline: true },
                { name: 'Failed', value: `${failed}`, inline: true },
                { name: 'Dropped At Execution', value: `${pending.candidateIds.length - toProcess.length}`, inline: true },
                { name: 'DMs Sent', value: `${dmCounts.sent}`, inline: true },
                { name: 'DMs Closed', value: `${dmCounts.closed}`, inline: true },
                { name: 'DMs Failed', value: `${dmCounts.failed}`, inline: true },
                { name: 'Run By', value: `**${pending.invokerTag}** (<@${pending.invokerId}>)` }
            ],
            footer: aborted ? 'Aborted early - see the abort notice above' : `Owner command (${pending.invokerTag})`,
            files: [new AttachmentBuilder(Buffer.from(reportBody, 'utf8'), { name: `purge-${guildId}-${date}.txt` })]
        });

        try {
            await interaction.editReply({
                content: `✅ Purge finished. Removed **${removed}**, failed **${failed}**, dropped **${pending.candidateIds.length - toProcess.length}** since the preview.\n`
                    + `DMs — sent: ${dmCounts.sent}, closed: ${dmCounts.closed}, failed: ${dmCounts.failed}.\n`
                    + 'The full report is in the log channel.',
                components: []
            });
        } catch (error) {
            // A long run can outlive the 15-minute interaction token. The log post above
            // is the permanent record, so this is not worth surfacing.
        }
    } catch (error) {
        console.error('Purge execution failed:', error);

        await sendStaffLog(guildId, {
            color: LOG_COLORS.error,
            title: '⚠️ Purge Failed',
            description: `The purge of ${guildLabel(guildId)} stopped with an error. Members already processed are in the log above and in the purge log file.`,
            fields: [errorField(error)],
            footer: `Owner command (${pending.invokerTag})`
        });
    } finally {
        purgeRunning = false;
    }
}

// Appended as each member is processed, so a crash mid-run still leaves a record of
// exactly who was handled.
function appendPurgeLogLine(guildId, pending, record, verdict, member) {
    const line = JSON.stringify({
        ts: Date.now(),
        guildId,
        userId: record.userId,
        tag: record.tag,
        lastActiveAt: verdict.lastActiveAt || 0,
        joinedAt: member?.joinedTimestamp || 0,
        thresholdDays: ACTIVITY_THRESHOLD_DAYS,
        dm: record.dm,
        removed: record.removed,
        error: record.error,
        executedBy: pending.invokerId
    });

    try {
        fs.appendFileSync(PURGE_LOG_PATH, line + '\n');
    } catch (error) {
        console.error('Could not append to the purge log:', error);
    }
}

// ---------------------------------------------------------------------------
// /purge-exempt
// ---------------------------------------------------------------------------

async function handlePurgeExemptCommand(interaction) {
    if (!activity.isActivityOwner(interaction.user.id)) {
        await activity.logUnauthorizedAttempt(interaction);
        return interaction.reply({
            content: '❌ You do not have permission to manage purge exemptions.',
            flags: MessageFlags.Ephemeral
        });
    }

    const guildId = interaction.guildId;
    const sub = interaction.options.getSubcommand();

    try {
        if (sub === 'add') return await exemptAdd(interaction, guildId);
        if (sub === 'remove') return await exemptRemove(interaction, guildId);
        if (sub === 'list') return await exemptList(interaction, guildId);
        if (sub === 'clear') return await exemptClear(interaction, guildId);
    } catch (error) {
        console.error(`Error in /purge-exempt ${sub}:`, error);
        await respondWithError(interaction, '❌ Something went wrong updating the exemption list.');
    }
}

async function exemptAdd(interaction, guildId) {
    const target = interaction.options.getMember('user');
    const user = interaction.options.getUser('user');
    const note = interaction.options.getString('note') || '';

    if (!user) {
        return interaction.reply({ content: '❌ Could not resolve that user.', flags: MessageFlags.Ephemeral });
    }

    if (activity.isPurgeExempt(guildId, user.id)) {
        return interaction.reply({
            content: `ℹ️ **${user.tag}** is already on the exemption list.`,
            flags: MessageFlags.Ephemeral
        });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // Stored even when another exempt reason already covers them, so the exemption still
    // holds if they stop being staff or a subscriber later.
    const priorReason = target ? activity.classifyMember(target, guildId).exemptReason : null;
    activity.addPurgeExempt(guildId, user.id, note);

    let rolesNote = 'No roles changed (tracking-only mode).';

    if (ACTIVITY_ROLES_ENABLED && target) {
        const result = await activity.applyActivityRoles(target, 'exempt', 'Manually exempted from activity labeling');

        if (result.error) rolesNote = `Could not remove their activity roles: ${result.error.message}`;
        else if (result.changed) rolesNote = `Removed their activity role${result.removed.length === 1 ? '' : 's'} immediately.`;
        else rolesNote = 'They were not carrying either activity role.';
    } else if (ACTIVITY_ROLES_ENABLED && !target) {
        rolesNote = 'They are not currently in this server, so no roles were changed.';
    }

    await sendStaffLog(guildId, {
        color: LOG_COLORS.exempt,
        title: '🛡️ Exemption Added',
        description: `**${user.tag}** (<@${user.id}>) is now exempt from activity labeling and will never appear in a purge preview for ${guildLabel(guildId)}.`,
        fields: [
            { name: 'User ID', value: user.id, inline: true },
            { name: 'Added By', value: `**${interaction.user.tag}**`, inline: true },
            { name: 'Note', value: note || 'None' },
            { name: 'Roles', value: rolesNote },
            ...(priorReason && priorReason !== 'manual'
                ? [{ name: 'Already Exempt As', value: activity.exemptReasonLabel(priorReason) }]
                : [])
        ],
        footer: `Owner command (${interaction.user.tag})`
    });

    await interaction.editReply(
        `🛡️ **${user.tag}** is now exempt. They will carry neither Active nor Inactive and will never be purged.\n${rolesNote}`
        + (priorReason && priorReason !== 'manual'
            ? `\n\nNote: they were already exempt as **${activity.exemptReasonLabel(priorReason)}**. The entry is still stored, so the exemption survives if that stops applying.`
            : '')
    );
}

async function exemptRemove(interaction, guildId) {
    const user = interaction.options.getUser('user');
    const target = interaction.options.getMember('user');

    if (!user) {
        return interaction.reply({ content: '❌ Could not resolve that user.', flags: MessageFlags.Ephemeral });
    }

    if (!activity.removePurgeExempt(guildId, user.id)) {
        return interaction.reply({
            content: `ℹ️ **${user.tag}** was not on the exemption list.`,
            flags: MessageFlags.Ephemeral
        });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    let rolesNote = 'No roles changed (tracking-only mode).';

    if (ACTIVITY_ROLES_ENABLED && target) {
        const verdict = activity.classifyMember(target, guildId);
        const result = await activity.applyActivityRoles(target, verdict.status, 'Activity exemption removed');

        if (result.error) rolesNote = `Could not apply their activity role: ${result.error.message}`;
        else if (result.changed) rolesNote = `They are now labeled **${verdict.status}**.`;
        else rolesNote = `They already matched their computed status (**${verdict.status}**).`;
    } else if (ACTIVITY_ROLES_ENABLED && !target) {
        rolesNote = 'They are not currently in this server, so no roles were changed.';
    }

    await sendStaffLog(guildId, {
        color: LOG_COLORS.exempt,
        title: '🛡️ Exemption Removed',
        description: `**${user.tag}** (<@${user.id}>) is no longer exempt in ${guildLabel(guildId)} and re-enters normal activity labeling.`,
        fields: [
            { name: 'User ID', value: user.id, inline: true },
            { name: 'Removed By', value: `**${interaction.user.tag}**`, inline: true },
            { name: 'Roles', value: rolesNote },
            { name: 'Note', value: 'Re-entering labeling can mark them Inactive immediately. That is a label only; it never removes them.' }
        ],
        footer: `Owner command (${interaction.user.tag})`
    });

    await interaction.editReply(`🛡️ **${user.tag}** is no longer exempt.\n${rolesNote}`);
}

async function exemptList(interaction, guildId) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const entries = activity.listPurgeExempt(guildId);

    await sendStaffLog(guildId, {
        color: LOG_COLORS.exempt,
        title: '🛡️ Exemptions Viewed',
        description: `**${interaction.user.tag}** (<@${interaction.user.id}>) listed the activity exemptions for ${guildLabel(guildId)}.`,
        fields: [{ name: 'Entries', value: `${entries.length}`, inline: true }],
        footer: `Owner command (${interaction.user.tag})`
    });

    if (entries.length === 0) {
        return interaction.editReply('🛡️ No manual exemptions are set for this server.');
    }

    const guild = await resolveGuild(guildId);
    // One member fetch for the whole list rather than one per entry, which used to mean a
    // REST call per exemption.
    const members = guild ? await fetchAllMembers(guild).catch(() => null) : null;

    const lines = entries.map((entry) => {
        // Entries are kept for members who have left, so the exemption still applies if
        // they come back. Those resolve to a raw ID.
        const member = members?.get(entry.userId);
        const who = member ? `**${member.user.tag}**` : `\`${entry.userId}\` (not in server)`;
        const when = entry.addedAt ? `<t:${Math.floor(entry.addedAt / 1000)}:D>` : 'unknown';

        return `• ${who} — added ${when}${entry.note ? ` — ${entry.note}` : ''}`;
    });

    const header = `🛡️ **${entries.length} manual exemption(s)** in ${guildLabel(guildId)}:`;
    const inline = `${header}\n\n${lines.join('\n')}`;

    // A long list used to be silently cut at 1,900 characters. Attach it instead.
    if (inline.length > 1800) {
        const body = [
            `Manual activity exemptions - ${guildLabel(guildId)} (${guildId})`,
            `Generated: ${new Date().toISOString()}`,
            `Entries: ${entries.length}`,
            '',
            ...entries.map(entry => [
                entry.userId,
                members?.get(entry.userId)?.user?.tag || '(not in server)',
                entry.addedAt ? new Date(entry.addedAt).toISOString().slice(0, 10) : 'unknown',
                entry.note || ''
            ].filter(Boolean).join(' | '))
        ].join('\n');

        return interaction.editReply({
            content: `${header} the full list is attached, since it is too long to show inline.`,
            files: [new AttachmentBuilder(Buffer.from(body, 'utf8'), { name: `exemptions-${guildId}.txt` })]
        });
    }

    await interaction.editReply(inline);
}

// ---------------------------------------------------------------------------
// /purge-exempt clear - bulk undo
// ---------------------------------------------------------------------------
//
// Removes manual exemptions in bulk and returns those members to normal labeling. This
// changes labels and the exemption list only: there is no removal call anywhere in this
// flow. Members who come back as Inactive stay in the server until a later /purge that
// Howard confirms.
async function exemptClear(interaction, guildId) {
    if (purgeRunning) {
        return interaction.reply({
            content: '❌ A purge is running. Clearing exemptions mid-purge would change who the live recompute protects, so try again once it finishes.',
            flags: MessageFlags.Ephemeral
        });
    }

    if (exemptClearRunning) {
        return interaction.reply({ content: '❌ An exemption clear is already running.', flags: MessageFlags.Ephemeral });
    }

    const noteContains = (interaction.options.getString('note_contains') || '').trim();

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const all = activity.listPurgeExempt(guildId);
    const entries = noteContains
        ? all.filter(entry => (entry.note || '').toLowerCase().includes(noteContains.toLowerCase()))
        : all;

    if (entries.length === 0) {
        return interaction.editReply(
            noteContains
                ? `🛡️ No manual exemptions in ${guildLabel(guildId)} have a note containing "${noteContains}". Nothing to clear.`
                : `🛡️ No manual exemptions are set for ${guildLabel(guildId)}. Nothing to clear.`
        );
    }

    const guild = await resolveGuild(guildId);
    if (!guild) return interaction.editReply('❌ Could not resolve this server.');

    let members;

    try {
        members = await fetchAllMembers(guild);
    } catch (error) {
        return interaction.editReply(`❌ Could not fetch the member list: ${error.message}`);
    }

    // Only affects how accurate the projection is, so a failure here is a warning rather
    // than a refusal: this command changes labels, it never removes anyone.
    const crossServer = await activity.ensureOtherServerReady(guildId);

    const projection = projectClear(guild, members, guildId, entries);

    const warnings = [];
    if (!crossServer.ok) {
        warnings.push(`⚠️ ${crossServer.reason} The projections below may show Inactive for members who are in fact active in the other server.`);
    }
    if (projection.wouldBeInactive.length > 0) {
        warnings.push(
            `⚠️ **${projection.wouldBeInactive.length}** member(s) will be labeled Inactive immediately. That is a label only — `
            + 'nobody is removed from the server unless you later run `/purge` and press Confirm. The next `/purge` preview will list them.'
        );
    }
    if (!ACTIVITY_ROLES_ENABLED) {
        warnings.push('ℹ️ Activity roles are in tracking-only mode, so the entries will be removed but no roles will change.');
    }

    const stayExemptBreakdown = Object.entries(projection.stayExemptByReason)
        .map(([label, count]) => `${label}: ${count}`)
        .join('\n') || 'None';

    const listBody = [
        `Exemption clear preview - ${guildLabel(guildId)} (${guildId})`,
        `Generated: ${new Date().toISOString()} by ${interaction.user.tag}`,
        noteContains ? `Filter: note contains "${noteContains}"` : 'Filter: none (every manual exemption)',
        `Entries: ${entries.length}`,
        '',
        'userId | tag | projected | last active | signal | added | note',
        ...projection.rows.map(r => [
            r.userId,
            r.tag,
            r.projected,
            r.lastActiveAt ? new Date(r.lastActiveAt).toISOString().slice(0, 10) : 'no recorded activity',
            r.lastSignal || '-',
            r.addedAt ? new Date(r.addedAt).toISOString().slice(0, 10) : 'unknown',
            r.note || ''
        ].filter(Boolean).join(' | '))
    ].join('\n');

    const date = new Date().toISOString().slice(0, 10);

    await sendStaffLog(guildId, {
        color: LOG_COLORS.exempt,
        title: '🛡️ Exemption Clear Previewed',
        description: `**${interaction.user.tag}** (<@${interaction.user.id}>) previewed clearing manual exemptions in ${guildLabel(guildId)}. Nothing has changed.`,
        fields: [
            { name: 'Entries Matched', value: `${entries.length}`, inline: true },
            { name: 'Would Become Active', value: `${projection.wouldBeActive.length}`, inline: true },
            { name: 'Would Become Inactive', value: `${projection.wouldBeInactive.length}`, inline: true },
            { name: 'Stay Exempt (Other Reason)', value: `${projection.stayExempt.length}`, inline: true },
            { name: 'Not In This Server', value: `${projection.notInServer.length}`, inline: true },
            { name: 'Filter', value: noteContains ? `note contains "${noteContains}"` : 'none (all entries)', inline: true },
            { name: 'Stay-Exempt Breakdown', value: stayExemptBreakdown }
        ],
        footer: `Owner command (${interaction.user.tag})`,
        files: [new AttachmentBuilder(Buffer.from(listBody, 'utf8'), { name: `exemption-clear-preview-${guildId}-${date}.txt` })]
    });

    const token = crypto.randomBytes(8).toString('hex');

    const body = [
        `**Exemption clear preview — ${guildLabel(guildId)}** · nothing has changed yet.`,
        '',
        `**${entries.length}** manual exemption(s) would be removed`
            + (noteContains ? ` (filtered to notes containing "${noteContains}")` : ' (every manual exemption in this server)') + '.',
        '',
        `• Would become **Active**: ${projection.wouldBeActive.length}`,
        `• Would become **Inactive**: ${projection.wouldBeInactive.length}`,
        `• **Stay exempt** for another reason: ${projection.stayExempt.length}`,
        `• **Not in this server** (entry removed only): ${projection.notInServer.length}`,
        ...(projection.stayExempt.length > 0 ? ['', `Stay-exempt reasons: ${stayExemptBreakdown.replace(/\n/g, ', ')}`] : []),
        ...(warnings.length > 0 ? ['', ...warnings] : []),
        '',
        '_The full list is attached to the log channel post._'
    ].join('\n');

    await interaction.editReply({
        content: body.slice(0, 1900),
        components: [buildClearRow(token, entries.length, false)]
    });

    const expiryTimer = setTimeout(() => {
        void expireClear(token);
    }, PURGE_CONFIRM_TIMEOUT_MS);
    expiryTimer.unref?.();

    pendingClears.set(token, {
        guildId,
        invokerId: interaction.user.id,
        invokerTag: interaction.user.tag,
        userIds: entries.map(e => e.userId),
        entries,
        noteContains,
        previewCount: entries.length,
        interaction,
        expiryTimer,
        consumed: false
    });
}

// What each entry's holder would become once the manual entry is gone. Uses the same
// classifyMember every other consumer uses, with ignoreManual set, so the projection
// cannot drift from what the confirm step actually applies.
function projectClear(guild, members, guildId, entries) {
    const now = Date.now();
    const rows = [];
    const wouldBeActive = [];
    const wouldBeInactive = [];
    const stayExempt = [];
    const notInServer = [];
    const stayExemptByReason = {};

    for (const entry of entries) {
        const member = members.get(entry.userId);

        if (!member) {
            notInServer.push(entry.userId);
            rows.push({ userId: entry.userId, tag: '(not in server)', projected: 'entry removed only', addedAt: entry.addedAt, note: entry.note });
            continue;
        }

        const verdict = activity.classifyMember(member, guildId, now, { ignoreManual: true });
        const row = {
            userId: entry.userId,
            tag: member.user?.tag || entry.userId,
            lastActiveAt: verdict.lastActiveAt,
            lastSignal: verdict.lastSignal,
            addedAt: entry.addedAt,
            note: entry.note
        };

        if (verdict.status === 'active') {
            wouldBeActive.push(entry.userId);
            row.projected = 'Active';
        } else if (verdict.status === 'inactive') {
            wouldBeInactive.push(entry.userId);
            row.projected = 'Inactive';
        } else {
            stayExempt.push(entry.userId);
            const label = activity.exemptReasonLabel(verdict.exemptReason);
            stayExemptByReason[label] = (stayExemptByReason[label] || 0) + 1;
            row.projected = `stays exempt (${label})`;
        }

        rows.push(row);
    }

    return { rows, wouldBeActive, wouldBeInactive, stayExempt, notInServer, stayExemptByReason };
}

function buildClearRow(token, count, disabled) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`${EXEMPT_CLEAR_PREFIX}:confirm:${token}`)
            .setLabel(`Clear ${count} exemption${count === 1 ? '' : 's'}`)
            // Primary, not danger: nothing is removed from the server by this.
            .setStyle(ButtonStyle.Primary)
            .setDisabled(disabled),
        new ButtonBuilder()
            .setCustomId(`${EXEMPT_CLEAR_PREFIX}:cancel:${token}`)
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(disabled)
    );
}

async function expireClear(token) {
    const pending = pendingClears.get(token);
    if (!pending || pending.consumed) return;

    pendingClears.delete(token);

    try {
        await pending.interaction.editReply({
            content: '⌛ That exemption clear preview expired. Nothing was changed.',
            components: [buildClearRow(token, pending.previewCount, true)]
        });
    } catch (error) {
        // Ephemeral token may be gone; the log below is the record.
    }

    await sendStaffLog(pending.guildId, {
        color: LOG_COLORS.exempt,
        title: '⌛ Exemption Clear Expired',
        description: `An exemption clear preview for ${guildLabel(pending.guildId)} expired without being confirmed. **Nothing was changed.**`,
        fields: [{ name: 'Requested By', value: `**${pending.invokerTag}** (<@${pending.invokerId}>)` }]
    });
}

function isExemptClearButton(customId) {
    return typeof customId === 'string' && customId.startsWith(`${EXEMPT_CLEAR_PREFIX}:`);
}

async function handleExemptClearButton(interaction) {
    const [, action, token] = interaction.customId.split(':');
    const pending = pendingClears.get(token);

    if (!pending) {
        return interaction.reply({
            content: '⌛ That preview is no longer valid. Nothing was changed. Run `/purge-exempt clear` again.',
            flags: MessageFlags.Ephemeral
        });
    }

    if (!activity.isActivityOwner(interaction.user.id) || interaction.user.id !== pending.invokerId) {
        await activity.logUnauthorizedAttempt(interaction);
        return interaction.reply({
            content: '❌ Only the person who generated this preview can act on it.',
            flags: MessageFlags.Ephemeral
        });
    }

    if (pending.consumed) {
        return interaction.reply({ content: '⏳ That button has already been used.', flags: MessageFlags.Ephemeral });
    }

    pending.consumed = true;
    clearTimeout(pending.expiryTimer);
    pendingClears.delete(token);

    const disabledRow = buildClearRow(token, pending.previewCount, true);

    if (action === 'cancel') {
        await interaction.update({ content: '✋ Exemption clear cancelled. Nothing was changed.', components: [disabledRow] });

        await sendStaffLog(pending.guildId, {
            color: LOG_COLORS.exempt,
            title: '✋ Exemption Clear Cancelled',
            description: `**${interaction.user.tag}** cancelled an exemption clear in ${guildLabel(pending.guildId)}. **Nothing was changed.**`
        });
        return;
    }

    if (action !== 'confirm') return;

    if (purgeRunning) {
        return interaction.update({
            content: '❌ A purge started in the meantime, so nothing was changed.',
            components: [disabledRow]
        });
    }

    await interaction.update({
        content: `⏳ Clearing ${pending.previewCount} exemption(s) and relabeling. A full report goes to the log channel when it finishes.`,
        components: [disabledRow]
    });

    await executeExemptClear(pending, interaction);
}

async function executeExemptClear(pending, interaction) {
    exemptClearRunning = true;

    const { guildId } = pending;
    const startedAt = Date.now();

    try {
        const guild = await resolveGuild(guildId);
        if (!guild) throw new Error('Guild could not be resolved at execution time.');

        // Entries added since the preview are left alone; entries already gone are skipped.
        const current = new Set(activity.listPurgeExempt(guildId).map(e => e.userId));
        const toClear = pending.userIds.filter(id => current.has(id));
        const dropped = pending.userIds.length - toClear.length;

        // Checked BEFORE anything is removed, so an abort leaves the list untouched.
        if (ACTIVITY_ROLES_ENABLED) {
            const permission = activity.canManageActivityRoles(guild);

            if (!permission.ok) {
                await sendStaffLog(guildId, {
                    color: LOG_COLORS.error,
                    title: '🛑 Exemption Clear Aborted',
                    description: `The exemption clear in ${guildLabel(guildId)} was abandoned before any entry was removed. **Nothing was changed.**`,
                    fields: [{ name: 'Reason', value: permission.problem }],
                    footer: `Owner command (${pending.invokerTag})`
                });

                return interaction.editReply({
                    content: `🛑 Aborted before changing anything: ${permission.problem}`,
                    components: []
                }).catch(() => {});
            }
        }

        // Captured before removal so the recovery file can rebuild them.
        const removedEntries = pending.entries.filter(e => current.has(e.userId));

        const removed = activity.removePurgeExemptMany(guildId, toClear);

        let members;

        try {
            members = await fetchAllMembers(guild);
        } catch (error) {
            members = null;
            console.error('Exemption clear: member fetch failed after removing entries:', error);
        }

        const changes = [];
        const failures = [];
        const stayExemptByReason = {};
        let notInServer = 0;

        if (ACTIVITY_ROLES_ENABLED && members) {
            for (const userId of removed) {
                const member = members.get(userId);

                if (!member) { notInServer++; continue; }

                const verdict = activity.classifyMember(member, guildId);

                if (verdict.status === 'exempt') {
                    const label = activity.exemptReasonLabel(verdict.exemptReason);
                    stayExemptByReason[label] = (stayExemptByReason[label] || 0) + 1;
                }

                const config = activity.activityConfigFor(guildId);
                const from = member.roles.cache.has(config.activeRoleId) ? 'Active'
                    : member.roles.cache.has(config.inactiveRoleId) ? 'Inactive' : 'None';

                const result = await activity.applyActivityRoles(member, verdict.status, 'Activity exemption cleared');

                if (result.error) {
                    // Not fatal: the entry is already gone, so the next daily sweep reads
                    // them as non-exempt and applies the right label.
                    failures.push({ userId, tag: member.user?.tag || userId, error: result.error.message });
                    continue;
                }

                const to = verdict.status === 'active' ? 'Active' : verdict.status === 'inactive' ? 'Inactive' : 'None';
                changes.push({ userId, tag: member.user?.tag || userId, from, to, status: verdict.status, exemptReason: verdict.exemptReason });

                await sleep(250);
            }
        } else if (members) {
            for (const userId of removed) {
                if (!members.get(userId)) notInServer++;
            }
        }

        const relabeledActive = changes.filter(c => c.to === 'Active').length;
        const relabeledInactive = changes.filter(c => c.to === 'Inactive').length;
        const unchanged = removed.length - changes.length - failures.length - notInServer;
        const elapsedMs = Date.now() - startedAt;

        const reportBody = [
            `Exemption clear report - ${guildLabel(guildId)} (${guildId})`,
            `Executed: ${new Date().toISOString()} by ${pending.invokerTag}`,
            pending.noteContains ? `Filter: note contains "${pending.noteContains}"` : 'Filter: none (every manual exemption)',
            `Entries removed: ${removed.length} | dropped since preview: ${dropped} | role changes: ${changes.length} | failures: ${failures.length}`,
            ACTIVITY_ROLES_ENABLED ? '' : 'TRACKING-ONLY MODE - entries removed, no roles changed',
            '',
            'userId | tag | from -> to | note',
            ...changes.map(c => `${c.userId} | ${c.tag} | ${c.from} -> ${c.to}${c.exemptReason ? ` (${activity.exemptReasonLabel(c.exemptReason)})` : ''}`),
            ...(failures.length > 0 ? ['', 'FAILURES (entry removed, label left for the next sweep):',
                ...failures.map(f => `${f.userId} | ${f.tag} | ${f.error}`)] : [])
        ].filter(line => line !== '').join('\n');

        const date = new Date().toISOString().slice(0, 10);
        const recovery = JSON.stringify(removedEntries.map(e => ({ userId: e.userId, note: e.note || '', addedAt: e.addedAt || 0 })), null, 2);

        await sendStaffLog(guildId, {
            color: LOG_COLORS.exempt,
            title: '🛡️ Exemptions Cleared',
            description: `Manual exemptions were cleared in ${guildLabel(guildId)}. **Nobody was removed from the server** - this changed labels only.`,
            fields: [
                { name: 'Run By', value: `**${pending.invokerTag}** (<@${pending.invokerId}>)` },
                { name: 'Filter', value: pending.noteContains ? `note contains "${pending.noteContains}"` : 'none (all entries)', inline: true },
                { name: 'Entries Removed', value: `${removed.length}`, inline: true },
                { name: 'Dropped Since Preview', value: `${dropped}`, inline: true },
                { name: 'Relabeled Active', value: `${relabeledActive}`, inline: true },
                { name: 'Relabeled Inactive', value: `${relabeledInactive}`, inline: true },
                { name: 'Unchanged', value: `${Math.max(unchanged, 0)}`, inline: true },
                { name: 'Not In Server', value: `${notInServer}`, inline: true },
                { name: 'Failures', value: `${failures.length}`, inline: true },
                { name: 'Duration', value: `${Math.round(elapsedMs / 1000)}s`, inline: true },
                {
                    name: 'Stay Exempt (Other Reason)',
                    value: Object.entries(stayExemptByReason).map(([k, v]) => `${k}: ${v}`).join('\n') || 'None'
                },
                ...(ACTIVITY_ROLES_ENABLED ? [] : [{ name: 'Mode', value: 'Tracking-only: entries removed, no roles changed.' }])
            ],
            footer: 'To restore an exemption, run /purge-exempt add for that member. The attached JSON has the originals.',
            files: [
                new AttachmentBuilder(Buffer.from(reportBody, 'utf8'), { name: `exemption-clear-${guildId}-${date}.txt` }),
                new AttachmentBuilder(Buffer.from(recovery, 'utf8'), { name: `exemptions-cleared-${guildId}-${date}.json` })
            ]
        });

        await interaction.editReply({
            content: `✅ Cleared **${removed.length}** exemption(s).`
                + ` Relabeled Active: **${relabeledActive}**, Inactive: **${relabeledInactive}**, failures: **${failures.length}**.`
                + (dropped > 0 ? ` Dropped **${dropped}** that changed since the preview.` : '')
                + (ACTIVITY_ROLES_ENABLED ? '' : ' Tracking-only mode, so no roles were changed.')
                + '\n\nNobody was removed from the server. The report and a recovery JSON are in the log channel.',
            components: []
        }).catch(() => {});
    } catch (error) {
        console.error('Exemption clear failed:', error);

        await sendStaffLog(guildId, {
            color: LOG_COLORS.error,
            title: '⚠️ Exemption Clear Failed',
            description: `The exemption clear in ${guildLabel(guildId)} stopped with an error. Nobody was removed from the server.`,
            fields: [errorField(error)],
            footer: `Owner command (${pending.invokerTag})`
        });

        await interaction.editReply({ content: `❌ The clear stopped with an error: ${error.message}`, components: [] }).catch(() => {});
    } finally {
        exemptClearRunning = false;
    }
}

module.exports = {
    handlePurgeCommand,
    isExemptClearButton,
    handleExemptClearButton,
    handlePurgeExemptCommand,
    handlePurgeButton,
    isPurgeButton,
    buildCandidates,
    purgeDmText,
};
