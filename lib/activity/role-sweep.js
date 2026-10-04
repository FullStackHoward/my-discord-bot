// ---------------------------------------------------------------------------
// Daily Active / Inactive role sweep
// ---------------------------------------------------------------------------
//
// Labels only. This file never removes anyone from a server; it adds and removes the
// two activity roles and reports what it did. In tracking-only mode it computes
// everything and changes nothing.

const { AttachmentBuilder } = require('discord.js');
const {
    LOG_COLORS,
    ACTIVITY_ROLES_ENABLED,
    ACTIVITY_THRESHOLD_DAYS,
    ACTIVITY_LOG_INDIVIDUAL_MAX
} = require('../config');
const { sendStaffLog, errorField } = require('../staff-log');
const { resolveGuild, fetchAllMembers, guildLabel, sleep } = require('../utils');
const activity = require('./index');
const { formatDuration } = require('./seeding');

let roleSweepRunning = false;

// Staff-log embeds are posted one at a time with a gap, so a big sweep can't trip the
// channel's rate limit.
const LOG_SPACING_MS = 1100;

async function runActivityRoleSweep() {
    if (roleSweepRunning) {
        console.log('Activity role sweep already running, skipping this pass.');
        return;
    }

    roleSweepRunning = true;

    try {
        for (const guildId of activity.configuredActivityGuildIds()) {
            try {
                await sweepGuild(guildId);
            } catch (error) {
                console.error(`Activity role sweep failed for guild ${guildId}:`, error);

                await sendStaffLog(guildId, {
                    color: LOG_COLORS.error,
                    title: '⚠️ Activity Sweep Failed',
                    description: `The daily activity sweep for ${guildLabel(guildId)} stopped early, so some labels may be out of date.`,
                    fields: [errorField(error)],
                    footer: 'The next sweep runs in 24 hours.'
                });
            }
        }
    } finally {
        roleSweepRunning = false;
    }
}

async function sweepGuild(guildId) {
    const state = activity.guildState(guildId);

    // Labeling before the backfill finishes would mark half the server inactive.
    if (state.seeding.status !== 'complete') {
        console.log(`Activity sweep: skipping ${guildLabel(guildId)}, seeding is ${state.seeding.status}`);
        return;
    }

    const guild = await resolveGuild(guildId);
    if (!guild) {
        console.log(`Activity sweep: guild ${guildId} unavailable`);
        return;
    }

    const startedAt = Date.now();
    let members;

    try {
        members = await fetchAllMembers(guild);
    } catch (error) {
        console.error(`Activity sweep: could not fetch members for ${guild.name}:`, error);

        await sendStaffLog(guildId, {
            color: LOG_COLORS.error,
            title: '⚠️ Activity Sweep Skipped',
            description: `Could not fetch the member list for ${guildLabel(guildId)}, so this sweep did nothing there.`,
            fields: [errorField(error)],
            footer: 'The next sweep runs in 24 hours.'
        });
        return;
    }

    // Checked once per guild rather than per member, and only when roles would actually
    // be applied; tracking-only mode has nothing to be blocked on.
    const permission = activity.canManageActivityRoles(guild);

    if (ACTIVITY_ROLES_ENABLED && !permission.ok) {
        console.error(`Activity sweep: cannot manage roles in ${guild.name} - ${permission.problem}`);

        await sendStaffLog(guildId, {
            color: LOG_COLORS.error,
            title: '⚠️ Activity Sweep Skipped',
            description: `Activity roles could not be applied in ${guildLabel(guildId)}, so this sweep was skipped there. The other server is unaffected.`,
            fields: [{ name: 'Reason', value: permission.problem }],
            footer: 'Move the bot\'s role above the Active and Inactive roles in server settings.'
        });
        return;
    }

    const now = Date.now();
    const counts = { active: 0, inactive: 0, exempt: 0 };
    const exemptByReason = {};
    const changes = [];
    const failures = [];
    let pruned = 0;

    for (const member of members.values()) {
        const verdict = activity.classifyMember(member, guildId, now);

        counts[verdict.status]++;

        if (verdict.status === 'exempt') {
            const label = activity.exemptReasonLabel(verdict.exemptReason);
            exemptByReason[label] = (exemptByReason[label] || 0) + 1;
        }

        const change = plannedChange(member, guildId, verdict);
        if (!change) continue;

        if (!ACTIVITY_ROLES_ENABLED) {
            changes.push(change);
            continue;
        }

        const result = await activity.applyActivityRoles(member, verdict.status, 'Activity sweep');

        if (result.error) {
            failures.push({ member, change, error: result.error });
            continue;
        }

        if (result.changed) changes.push(change);
    }

    // Drop records for anyone who has left since the last pass.
    for (const userId of Object.keys(state.members)) {
        if (!members.has(userId)) {
            activity.forgetMember(guildId, userId);
            pruned++;
        }
    }

    const instantPromotions = activity.takeInstantPromotionCount(guildId);
    const elapsedMs = Date.now() - startedAt;

    await reportSweep(guildId, {
        counts,
        exemptByReason,
        changes,
        failures,
        pruned,
        instantPromotions,
        elapsedMs,
        liveMode: ACTIVITY_ROLES_ENABLED
    });
}

// What this member's labels should become, or null when they already match. Pure: used
// for the tracking-only report as well as the live path.
function plannedChange(member, guildId, verdict) {
    const config = activity.activityConfigFor(guildId);
    if (!config) return null;

    const { activeRoleId, inactiveRoleId } = config;
    const hasActive = member.roles.cache.has(activeRoleId);
    const hasInactive = member.roles.cache.has(inactiveRoleId);

    const from = hasActive ? 'Active' : hasInactive ? 'Inactive' : 'None';
    let to;

    if (verdict.status === 'active') to = 'Active';
    else if (verdict.status === 'inactive') to = 'Inactive';
    else to = 'None';

    if (from === to) return null;

    return {
        userId: member.id,
        tag: member.user?.tag || member.id,
        from,
        to,
        status: verdict.status,
        exemptReason: verdict.exemptReason,
        lastActiveAt: verdict.lastActiveAt,
        lastSignal: verdict.lastSignal
    };
}

async function reportSweep(guildId, summary) {
    const { counts, exemptByReason, changes, failures, pruned, instantPromotions, elapsedMs, liveMode } = summary;

    const added = changes.filter(c => c.to !== 'None').length;
    const removed = changes.filter(c => c.from !== 'None').length;

    const exemptBreakdown = Object.entries(exemptByReason)
        .map(([label, count]) => `${label}: ${count}`)
        .join('\n') || 'None';

    const files = [];
    const detailed = changes.length > 0 && changes.length <= ACTIVITY_LOG_INDIVIDUAL_MAX && liveMode;

    // A first live run can touch hundreds of members, so anything beyond the threshold
    // (and every tracking-only run) goes out as one attachment instead of a flood.
    if (changes.length > 0 && !detailed) {
        const date = new Date().toISOString().slice(0, 10);
        const header = liveMode
            ? 'Activity sweep changes (applied)'
            : 'Activity sweep changes (TRACKING-ONLY - no roles were changed)';

        const body = [
            header,
            `Guild: ${guildLabel(guildId)} (${guildId})`,
            `Generated: ${new Date().toISOString()}`,
            '',
            ...changes.map(c => [
                c.tag,
                c.userId,
                `${c.from} -> ${c.to}`,
                c.lastActiveAt ? `last active ${new Date(c.lastActiveAt).toISOString()} (${c.lastSignal})` : 'no recorded activity',
                c.exemptReason ? `exempt: ${activity.exemptReasonLabel(c.exemptReason)}` : ''
            ].filter(Boolean).join(' | '))
        ].join('\n');

        files.push(new AttachmentBuilder(Buffer.from(body, 'utf8'), {
            name: `activity-sweep-${guildId}-${date}.txt`
        }));
    }

    const changed = changes.length > 0 || failures.length > 0;

    // Tracking-only always reports, so the mode is visibly doing something. Live mode
    // only speaks up when something actually happened.
    if (liveMode && !changed) {
        console.log(`Activity sweep: no changes in ${guildLabel(guildId)}`);
        return;
    }

    await sendStaffLog(guildId, {
        color: liveMode ? LOG_COLORS.activity : LOG_COLORS.activityDemote,
        title: liveMode ? '📊 Daily Activity Sweep' : '📊 Daily Activity Sweep (Tracking-Only)',
        description: liveMode
            ? `Activity labels refreshed for ${guildLabel(guildId)}.`
            : `What the sweep **would** do in ${guildLabel(guildId)}. No roles were changed.`,
        fields: [
            { name: 'Active', value: `${counts.active}`, inline: true },
            { name: 'Inactive', value: `${counts.inactive}`, inline: true },
            { name: 'Exempt', value: `${counts.exempt}`, inline: true },
            { name: 'Exempt Breakdown', value: exemptBreakdown },
            { name: liveMode ? 'Roles Added' : 'Would Add', value: `${added}`, inline: true },
            { name: liveMode ? 'Roles Removed' : 'Would Remove', value: `${removed}`, inline: true },
            { name: 'Failures', value: `${failures.length}`, inline: true },
            { name: 'Instant Promotions Since Last Sweep', value: `${instantPromotions}`, inline: true },
            { name: 'Pruned (No Longer Members)', value: `${pruned}`, inline: true },
            { name: 'Label Window', value: `${ACTIVITY_THRESHOLD_DAYS} days`, inline: true },
            { name: 'Duration', value: formatDuration(elapsedMs), inline: true }
        ],
        footer: liveMode ? 'Daily sweep' : 'Daily sweep - tracking-only mode, no roles were changed',
        files
    });

    // Per-member embeds only for a small live sweep.
    if (detailed) {
        for (const change of changes) {
            await sleep(LOG_SPACING_MS);
            await logIndividualChange(guildId, change);
        }
    }

    if (failures.length > 0) {
        await sleep(LOG_SPACING_MS);

        const sample = failures.slice(0, 5)
            .map(f => `**${f.member.user?.tag || f.member.id}**: ${f.error.message}`)
            .join('\n');

        await sendStaffLog(guildId, {
            color: LOG_COLORS.error,
            title: '⚠️ Activity Role Changes Failed',
            description: `${failures.length} role change(s) could not be applied in ${guildLabel(guildId)}.`,
            fields: [
                { name: 'First Few Errors', value: sample },
                { name: 'Total Failures', value: `${failures.length}`, inline: true }
            ],
            footer: 'Daily sweep - the next pass retries'
        });
    }
}

async function logIndividualChange(guildId, change) {
    let title;
    let color;

    if (change.to === 'Inactive') {
        title = '⬇️ Marked Inactive';
        color = LOG_COLORS.activityDemote;
    } else if (change.to === 'Active') {
        title = '⬆️ Marked Active';
        color = LOG_COLORS.activityPromote;
    } else {
        title = '🛡️ Activity Roles Removed (Exempt)';
        color = LOG_COLORS.exempt;
    }

    await sendStaffLog(guildId, {
        color,
        title,
        description: `**${change.tag}** (<@${change.userId}>) in ${guildLabel(guildId)}.`,
        fields: [
            { name: 'User ID', value: change.userId, inline: true },
            { name: 'Change', value: `${change.from} → ${change.to}`, inline: true },
            ...(change.exemptReason
                ? [{ name: 'Exempt Reason', value: activity.exemptReasonLabel(change.exemptReason), inline: true }]
                : []),
            {
                name: 'Last Active',
                value: change.lastActiveAt
                    ? `<t:${Math.floor(change.lastActiveAt / 1000)}:R> (${change.lastSignal})`
                    : 'No recorded activity'
            }
        ],
        footer: 'Daily sweep'
    });
}

module.exports = {
    runActivityRoleSweep,
    plannedChange,
};
