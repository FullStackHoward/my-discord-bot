// ---------------------------------------------------------------------------
// Introductions forum cleanup (Vice Gamers and Vice Creators, each opt-in)
// ---------------------------------------------------------------------------
//
// Members introduce themselves with a post in a forum channel. When the member who made
// a post is no longer in the server, the whole thread is deleted, so the forum stays a
// list of people who are actually here.
//
// This feature deletes THREADS and nothing else. It never removes a member, never changes
// a role, and lives outside lib/activity/ so that folder's single-removal-path guarantee
// stays intact. It is a sibling of lib/gamer-id/ rather than an extension of it: gamer ID
// cleanup is live and deletes messages, and this reuses its exports without touching it.
//
// Three triggers reach the same code: a member leaving (debounced), a daily reconcile for
// leaves the bot missed, and the one-time /intros-sweep. The automatic paths delete only
// while cleanup is switched on for that server with /intros-cleanup, persisted in
// introductions-state.json. Otherwise they run read-only and report what they would have
// done. The confirmed /intros-sweep is the one exception: it has shown a preview and taken
// an explicit Confirm press, so it deletes either way.
//
// Differences from gamer ID cleanup worth knowing:
//   - The unit removed is a whole thread, owned by the departed member (thread.ownerId).
//     A departed member's replies in somebody else's thread are left alone.
//   - Deleting a thread also deletes every reply in it, including current members'.
//   - Pinned threads are never deleted.
//   - Only thread metadata is read, never messages, so a scan is cheap.
//   - Thread titles are user-written, so logs, embeds and files carry IDs only.

const fs = require('fs');
const { ChannelFlags, ChannelType, PermissionsBitField } = require('discord.js');
const { RESTJSONErrorCodes } = require('discord-api-types/v10');
const {
    VG_GUILD_ID,
    VC_GUILD_ID,
    SERVER_CONFIGS,
    LOG_COLORS,
    INTRODUCTIONS_FORUM_ENV_NAMES,
    INTRO_LEAVE_DEBOUNCE_MS,
    INTRO_DELETE_DELAY_MS,
    INTRO_MAX_CONSECUTIVE_FAILURES,
    INTRO_MEMBER_FETCH_MIN_RATIO,
    INTRO_LOG_PATH
} = require('../config');
const { sendStaffLog, errorField } = require('../staff-log');
const { resolveGuild, fetchMembersWithRatio, guildLabel, sleep } = require('../utils');
const { collectThreads, resolveTargetedAbsentees } = require('../gamer-id');
const { isCleanupEnabled, cleanupStatus } = require('./state');

const DELETE_REASON = 'Introductions cleanup: author left the server';

// One cleanup per guild at a time, tracked separately from gamer ID's so the two features
// never block each other. A trigger arriving mid-run sets the rerun flag instead.
const running = new Set();
const rerunRequested = new Set();

// guildId -> { ids: Set, timer }
const pendingLeavers = new Map();

// Throttles the forum-misconfigured embed so a bad channel ID can't flood the log.
const lastForumErrorAt = new Map();
const FORUM_ERROR_INTERVAL_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// The two main servers only, and only when that server's forum is configured. Every other
// guild gets null, which makes the listener, the reconcile, the commands and the boot
// announcement all inert there.
function introductionsConfigFor(guildId) {
    if (!guildId || (guildId !== VG_GUILD_ID && guildId !== VC_GUILD_ID)) return null;

    const config = SERVER_CONFIGS[guildId]?.introductions;
    if (!config || !config.forumChannelId) return null;

    return config;
}

function configuredIntroductionsGuildIds() {
    return [VG_GUILD_ID, VC_GUILD_ID].filter(guildId => introductionsConfigFor(guildId));
}

// ---------------------------------------------------------------------------
// Forum resolution and validation
// ---------------------------------------------------------------------------

async function resolveForum(guild) {
    const config = introductionsConfigFor(guild.id);
    if (!config) return { forum: null, problem: 'Introductions cleanup is not configured for this server.' };

    const channel = guild.channels.cache.get(config.forumChannelId)
        || await guild.channels.fetch(config.forumChannelId).catch(() => null);

    const envNames = (INTRODUCTIONS_FORUM_ENV_NAMES[guild.id] || []).join(' / ');

    if (!channel) {
        return {
            forum: null,
            problem: `No channel with ID \`${config.forumChannelId}\` is visible to the bot. Check ${envNames} in .env.`
        };
    }

    if (channel.type !== ChannelType.GuildForum) {
        return {
            forum: null,
            problem: `Channel <#${channel.id}> is not a forum channel, so it has no introduction threads to clean up.`
        };
    }

    const me = guild.members.me;
    const permissions = channel.permissionsFor?.(me);
    const required = [
        ['View Channel', PermissionsBitField.Flags.ViewChannel],
        ['Read Message History', PermissionsBitField.Flags.ReadMessageHistory],
        ['Manage Threads', PermissionsBitField.Flags.ManageThreads]
    ];

    const missing = permissions
        ? required.filter(([, flag]) => !permissions.has(flag)).map(([name]) => name)
        : ['(could not read the bot\'s permissions in that channel)'];

    if (missing.length > 0) {
        return { forum: null, problem: `Missing permission(s) in <#${channel.id}>: ${missing.join(', ')}.` };
    }

    return { forum: channel, problem: null };
}

async function reportForumProblem(guildId, problem) {
    const now = Date.now();
    const last = lastForumErrorAt.get(guildId) || 0;

    console.error(`Introductions cleanup: ${problem}`);
    if (now - last < FORUM_ERROR_INTERVAL_MS) return;
    lastForumErrorAt.set(guildId, now);

    await sendStaffLog(guildId, {
        color: LOG_COLORS.error,
        title: '⚠️ Introductions Forum Unavailable',
        description: `The introductions forum for ${guildLabel(guildId)} could not be used, so no cleanup ran.`,
        fields: [{ name: 'Problem', value: problem }],
        footer: 'Fix the channel ID or the bot\'s permissions, then restart.'
    });
}

// ---------------------------------------------------------------------------
// Which threads qualify
// ---------------------------------------------------------------------------

function isPinned(thread) {
    try {
        return Boolean(thread?.flags?.has?.(ChannelFlags.Pinned));
    } catch (error) {
        // An unreadable flags field is treated as pinned: when unsure, keep the thread.
        return true;
    }
}

// Pure, and the single source of truth for every trigger, preview and confirm.
//
// A missing ownerId never means departed: discord.js copies owner_id straight from the
// payload, so it can be undefined, and that is a reason to skip rather than delete.
function shouldDeleteThread(thread, absentOwnerIds, forumId) {
    if (!thread || thread.parentId !== forumId) return false;
    if (!thread.ownerId) return false;
    if (isPinned(thread)) return false;

    return absentOwnerIds.has(thread.ownerId);
}

// ---------------------------------------------------------------------------
// Who counts as absent
// ---------------------------------------------------------------------------

// Full mode: the member list is sanity-checked first, because a truncated fetch would make
// current members look departed. The ratio check is shared; the wording is local because
// it names what would be lost.
async function resolveFullModeMembers(guild) {
    const fetched = await fetchMembersWithRatio(guild, INTRO_MEMBER_FETCH_MIN_RATIO);

    if (fetched.error) {
        return { members: null, aborted: true, reason: `The member list could not be fetched (${fetched.error.message}), so nothing was scanned.` };
    }

    if (!fetched.ok) {
        return {
            members: null,
            aborted: true,
            reason: `The member list came back short (${fetched.fetched} of about ${fetched.expected}, ${Math.round(fetched.ratio * 100)}%). `
                + 'Treating current members as departed would delete the wrong threads, so the run was abandoned.'
        };
    }

    return { members: fetched.members, aborted: false, reason: null };
}

// ---------------------------------------------------------------------------
// Deleting
// ---------------------------------------------------------------------------

async function attemptThreadDelete(thread) {
    try {
        await thread.delete(DELETE_REASON);
        return 'deleted';
    } catch (error) {
        // Already gone is the outcome we wanted, not a failure.
        if (error.code === RESTJSONErrorCodes.UnknownChannel) return 'gone';
        if (error.code === RESTJSONErrorCodes.InvalidActionOnArchivedThread) return 'archived';

        return error.message || 'unknown error';
    }
}

// Identifiers only. The title is user-written content, so it never leaves memory except
// as a clamped sample in the owner's ephemeral preview.
function stripThread(thread) {
    return {
        threadId: thread.id,
        ownerId: thread.ownerId,
        createdTimestamp: thread.createdTimestamp ?? null,
        archived: Boolean(thread.archived),
        messageCount: typeof thread.messageCount === 'number' ? thread.messageCount : null
    };
}

function appendIntroLogLine(guildId, thread, trigger) {
    const line = JSON.stringify({
        guildId,
        threadId: thread.id,
        ownerId: thread.ownerId,
        createdAt: thread.createdTimestamp ?? null,
        deletedAt: Date.now(),
        trigger
    });

    try {
        fs.appendFileSync(INTRO_LOG_PATH, line + '\n');
    } catch (error) {
        console.error('Could not append to the introductions log:', error);
    }
}

// Deletes the matching threads one at a time.
//
// Whether an archived thread can be deleted without unarchiving is not assumed: the delete
// is tried first, and only a rejection with InvalidActionOnArchivedThread leads to one
// unarchive and one retry. Which path each deletion took is counted, so the first live run
// documents the real behavior.
async function deleteThreads(threads, report, { delayMs = INTRO_DELETE_DELAY_MS } = {}) {
    for (let i = 0; i < threads.length; i++) {
        const thread = threads[i];

        if (report.consecutiveFailures >= INTRO_MAX_CONSECUTIVE_FAILURES) {
            report.aborted = true;
            return;
        }

        const wasArchived = Boolean(thread.archived);
        let outcome = await attemptThreadDelete(thread);
        let unarchived = false;

        if (outcome === 'archived') {
            try {
                await thread.setArchived(false, 'Introductions cleanup: removing a departed member\'s post');
                unarchived = true;
            } catch (error) {
                report.failures.push({ ...stripThread(thread), error: `could not unarchive the thread: ${error.message}` });
                report.consecutiveFailures++;
                if (i < threads.length - 1) await sleep(delayMs);
                continue;
            }

            outcome = await attemptThreadDelete(thread);
        }

        if (outcome === 'deleted' || outcome === 'gone') {
            report.deleted.push(stripThread(thread));
            report.consecutiveFailures = 0;

            if (outcome === 'gone') report.paths.alreadyGone++;
            else if (unarchived) report.paths.afterUnarchive++;
            else if (wasArchived) report.paths.archivedDirect++;
            else report.paths.direct++;

            if (outcome === 'deleted') appendIntroLogLine(report.guildId, thread, report.trigger);
        } else {
            report.failures.push({ ...stripThread(thread), error: String(outcome) });
            report.consecutiveFailures++;

            // Put a thread we unarchived back how it was.
            if (unarchived) {
                await thread.setArchived(true, 'Introductions cleanup: delete failed, restoring').catch(error => {
                    console.error(`Introductions cleanup: could not re-archive thread ${thread.id}:`, error.message);
                    report.reArchiveFailures.push(thread.id);
                });
            }
        }

        if (i < threads.length - 1) await sleep(delayMs);
    }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

function emptyReport(guildId, { trigger, mode, live, dryRun }) {
    return {
        guildId, trigger, mode, live, dryRun,
        threadsScanned: 0,
        matches: [],
        deleted: [],
        failures: [],
        paths: { direct: 0, archivedDirect: 0, afterUnarchive: 0, alreadyGone: 0 },
        reArchiveFailures: [],
        consecutiveFailures: 0,
        pinnedKept: 0,
        noOwner: 0,
        aborted: false,
        abortReason: null,
        absentOwnerIds: new Set(),
        rejoined: [],
        unknown: []
    };
}

// mode: 'targeted' (queued leavers) or 'full' (everyone absent).
// dryRun: forces read-only no matter what, used by the /intros-sweep preview.
// forceLive: deletes even while cleanup is switched off. Only the confirmed /intros-sweep
//   passes this.
async function runCleanup(guildId, { trigger, mode, queuedIds = [], dryRun = false, forceLive = false, delayMs } = {}) {
    if (running.has(guildId)) {
        rerunRequested.add(guildId);
        console.log(`Introductions cleanup already running for ${guildLabel(guildId)}; queued a rerun instead of starting a second scan.`);
        return { skipped: true, reason: 'already running' };
    }

    running.add(guildId);

    try {
        return await executeCleanup(guildId, { trigger, mode, queuedIds, dryRun, forceLive, delayMs });
    } finally {
        running.delete(guildId);

        if (rerunRequested.delete(guildId)) {
            // Full mode on the rerun: whatever triggered it, a full pass is a superset.
            void runCleanup(guildId, { trigger: `${trigger} (rerun)`, mode: 'full' })
                .then(report => (report.skipped ? null : reportCleanup(report)))
                .catch(error => console.error('Introductions cleanup rerun failed:', error));
        }
    }
}

async function executeCleanup(guildId, { trigger, mode, queuedIds, dryRun, forceLive, delayMs }) {
    // dryRun always wins, so a preview can never delete.
    const live = !dryRun && (forceLive || isCleanupEnabled(guildId));
    const report = emptyReport(guildId, { trigger, mode, live, dryRun });

    const guild = await resolveGuild(guildId);
    if (!guild) {
        report.aborted = true;
        report.abortReason = 'The server could not be resolved.';
        return report;
    }

    const { forum, problem } = await resolveForum(guild);
    if (!forum) {
        await reportForumProblem(guildId, problem);
        report.aborted = true;
        report.abortReason = problem;
        return report;
    }

    // Absence is decided before anything is considered for deletion, so a bad member list
    // stops the run first.
    let members = null;

    if (mode === 'targeted') {
        const resolved = await resolveTargetedAbsentees(guild, queuedIds);
        report.absentOwnerIds = resolved.absent;
        report.rejoined = resolved.rejoined;
        report.unknown = resolved.unknown;

        if (resolved.absent.size === 0) return report; // nobody to act on
    } else {
        const resolved = await resolveFullModeMembers(guild);

        if (resolved.aborted) {
            report.aborted = true;
            report.abortReason = resolved.reason;

            await sendStaffLog(guildId, {
                color: LOG_COLORS.error,
                title: '⚠️ Introductions Cleanup Aborted',
                description: `An introductions cleanup of ${guildLabel(guildId)} was abandoned before scanning. **No threads were deleted.**`,
                fields: [
                    { name: 'Trigger', value: describeTrigger(trigger) },
                    { name: 'Reason', value: resolved.reason }
                ]
            });
            return report;
        }

        members = resolved.members;
    }

    const threads = (await collectThreads(forum)).filter(thread => thread.parentId === forum.id);
    report.threadsScanned = threads.length;

    for (const thread of threads) {
        if (!thread.ownerId) {
            report.noOwner++;
            continue;
        }

        if (members && !members.has(thread.ownerId)) report.absentOwnerIds.add(thread.ownerId);
    }

    for (const thread of threads) {
        if (shouldDeleteThread(thread, report.absentOwnerIds, forum.id)) {
            report.matches.push(thread);
        } else if (thread.ownerId && report.absentOwnerIds.has(thread.ownerId) && isPinned(thread)) {
            report.pinnedKept++;
        }
    }

    // Oldest first, so a run that stops early has cleared the longest-departed posts.
    report.matches.sort((a, b) => (a.createdTimestamp || 0) - (b.createdTimestamp || 0));

    if (live && report.matches.length > 0) {
        await deleteThreads(report.matches, report, delayMs === undefined ? {} : { delayMs });
    }

    return report;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function describeTrigger(trigger) {
    return { leave: 'Member left', reconcile: 'Daily reconcile', sweep: 'Manual sweep' }[trigger] || trigger;
}

function idList(ids, max = 20) {
    if (ids.length === 0) return 'None';

    const shown = ids.slice(0, max);
    return shown.map(id => `\`${id}\``).join(', ')
        + (ids.length > shown.length ? ` …and ${ids.length - shown.length} more` : '');
}

function buildReportFields(report) {
    const { live, matches, deleted, failures } = report;
    const absentIds = [...report.absentOwnerIds];

    const fields = [
        { name: 'Trigger', value: describeTrigger(report.trigger), inline: true },
        { name: 'Mode', value: live ? 'Live (threads deleted)' : 'Report-only (nothing deleted)', inline: true },
        { name: 'Threads Scanned', value: `${report.threadsScanned}`, inline: true },
        { name: live ? 'Threads Deleted' : 'Would Delete', value: `${live ? deleted.length : matches.length}`, inline: true },
        { name: 'Failures', value: `${failures.length}`, inline: true },
        { name: 'Departed Owners Found', value: `${absentIds.length}`, inline: true },
        { name: 'Departed Owner IDs', value: idList(absentIds) }
    ];

    if (report.pinnedKept > 0) {
        fields.push({ name: 'Pinned, Kept', value: `${report.pinnedKept} pinned thread(s) belong to departed members and were left alone.` });
    }

    if (report.noOwner > 0) {
        fields.push({ name: 'No Owner Recorded', value: `${report.noOwner} thread(s) had no owner ID from Discord and were skipped.` });
    }

    if (report.rejoined.length > 0) {
        fields.push({
            name: 'Rejoined Before The Scan',
            value: `${report.rejoined.length} queued member(s) had come back, so their threads were left alone.`
        });
    }

    if (report.unknown.length > 0) {
        fields.push({
            name: 'Could Not Verify',
            value: `${report.unknown.length} queued member(s) could not be checked, so they were skipped rather than risked.`
        });
    }

    if (live && deleted.length > 0) {
        const { direct, archivedDirect, afterUnarchive, alreadyGone } = report.paths;
        const lines = [
            `Open threads deleted: ${direct}`,
            `Archived threads deleted without unarchiving: ${archivedDirect}`,
            `Archived threads that had to be unarchived first: ${afterUnarchive}`
        ];
        if (alreadyGone > 0) lines.push(`Already gone: ${alreadyGone}`);

        fields.push({ name: 'Delete Paths', value: lines.join('\n') });
    }

    if (report.reArchiveFailures.length > 0) {
        fields.push({
            name: '⚠️ Left Unarchived',
            value: `${report.reArchiveFailures.length} thread(s) failed to delete and could not be re-archived: ${idList(report.reArchiveFailures, 10)}`
        });
    }

    if (report.aborted) {
        fields.push({
            name: '🛑 Stopped Early',
            value: `${INTRO_MAX_CONSECUTIVE_FAILURES} consecutive failures. The rest is left for the next reconcile.`
        });
    }

    if (failures.length > 0) {
        fields.push({
            name: 'First Few Failures',
            value: failures.slice(0, 5).map(f => `\`${f.threadId}\` (owner \`${f.ownerId}\`): ${f.error}`).join('\n')
        });
    }

    return fields;
}

async function reportCleanup(report, { force = false } = {}) {
    const { guildId, live, matches, failures } = report;

    // Silent when a run found nothing and hit no problem. A report-only run that finds a
    // backlog posts every day on purpose: it nudges the owner toward /intros-sweep.
    if (!force && !report.aborted && matches.length === 0 && failures.length === 0) {
        console.log(`Introductions cleanup (${report.trigger}) in ${guildLabel(guildId)}: nothing to do.`);
        return;
    }

    if (report.aborted && report.abortReason) return; // already logged at the abort point

    await sendStaffLog(guildId, {
        color: report.aborted || failures.length > 0 ? LOG_COLORS.error : LOG_COLORS.gamerId,
        title: live ? '🧹 Introductions Cleanup' : '🧹 Introductions Cleanup (Report-Only)',
        description: live
            ? `Removed introduction threads belonging to departed members in ${guildLabel(guildId)}.`
            : `What an introductions cleanup **would** remove in ${guildLabel(guildId)}. Nothing was deleted.`,
        fields: buildReportFields(report),
        footer: live ? describeTrigger(report.trigger) : `${describeTrigger(report.trigger)} - report-only mode. Run /intros-sweep to clear the backlog.`
    });
}

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

function handleGuildMemberRemove(member) {
    try {
        const guildId = member.guild?.id;
        if (!guildId || !introductionsConfigFor(guildId)) return;

        if (!pendingLeavers.has(guildId)) {
            pendingLeavers.set(guildId, { ids: new Set(), timer: null });
        }

        const pending = pendingLeavers.get(guildId);
        pending.ids.add(member.id);

        if (pending.timer) clearTimeout(pending.timer);

        pending.timer = setTimeout(() => {
            void flushPendingLeavers(guildId);
        }, INTRO_LEAVE_DEBOUNCE_MS);
        pending.timer.unref?.();
    } catch (error) {
        console.error('Error queueing an introductions cleanup on member leave:', error);
    }
}

async function flushPendingLeavers(guildId) {
    const pending = pendingLeavers.get(guildId);
    if (!pending || pending.ids.size === 0) return;

    const queuedIds = [...pending.ids];
    pending.ids.clear();
    pending.timer = null;

    try {
        const report = await runCleanup(guildId, { trigger: 'leave', mode: 'targeted', queuedIds });
        if (report.skipped) return;

        await reportCleanup(report);
    } catch (error) {
        console.error('Introductions cleanup failed after a member leave:', error);

        await sendStaffLog(guildId, {
            color: LOG_COLORS.error,
            title: '⚠️ Introductions Cleanup Failed',
            description: `The introductions cleanup for departing members in ${guildLabel(guildId)} did not finish.`,
            fields: [errorField(error)],
            footer: 'The daily reconcile will catch anything missed.'
        });
    }
}

async function runIntroductionsReconcile() {
    for (const guildId of configuredIntroductionsGuildIds()) {
        try {
            const report = await runCleanup(guildId, { trigger: 'reconcile', mode: 'full' });
            if (report.skipped) continue;

            await reportCleanup(report);
        } catch (error) {
            console.error(`Introductions reconcile failed for ${guildLabel(guildId)}:`, error);

            await sendStaffLog(guildId, {
                color: LOG_COLORS.error,
                title: '⚠️ Introductions Reconcile Failed',
                description: `The daily introductions reconcile for ${guildLabel(guildId)} did not finish.`,
                fields: [errorField(error)],
                footer: 'The next reconcile runs in 24 hours.'
            });
        }
    }
}

async function announceIntroductionsStartup() {
    for (const guildId of configuredIntroductionsGuildIds()) {
        try {
            const guild = await resolveGuild(guildId);
            if (!guild) continue;

            const { forum, problem } = await resolveForum(guild);

            if (!forum) {
                await reportForumProblem(guildId, problem);
                continue;
            }

            const status = cleanupStatus(guildId);
            const enabled = isCleanupEnabled(guildId);

            await sendStaffLog(guildId, {
                color: LOG_COLORS.gamerId,
                title: '🧹 Introductions Cleanup Started',
                description: `Introduction threads in <#${forum.id}> whose author has left ${guildLabel(guildId)} will be cleaned up. Pinned threads are never deleted.`,
                fields: [
                    { name: 'Automatic Cleanup', value: enabled ? 'On (threads are deleted)' : 'Off (report-only)', inline: true },
                    { name: 'Forum', value: `<#${forum.id}>`, inline: true },
                    {
                        name: 'Last Changed',
                        value: status.everSet
                            ? `<t:${Math.floor(status.changedAt / 1000)}:R> by ${status.changedByTag || status.changedBy}`
                            : 'Never set (defaults to off)',
                        inline: true
                    },
                    { name: 'Triggers', value: 'A member leaving (after a 60s debounce), a daily reconcile, and the one-time `/intros-sweep`.' }
                ],
                footer: enabled
                    ? undefined
                    : 'Run /intros-cleanup enable to let the automatic paths delete. /intros-sweep deletes on Confirm either way.'
            });
        } catch (error) {
            console.error(`Introductions cleanup startup check failed for ${guildLabel(guildId)}:`, error);
        }
    }
}

module.exports = {
    DELETE_REASON,
    isCleanupEnabled,
    cleanupStatus,
    introductionsConfigFor,
    configuredIntroductionsGuildIds,
    resolveForum,
    isPinned,
    shouldDeleteThread,
    resolveFullModeMembers,
    attemptThreadDelete,
    deleteThreads,
    runCleanup,
    reportCleanup,
    buildReportFields,
    describeTrigger,
    handleGuildMemberRemove,
    flushPendingLeavers,
    runIntroductionsReconcile,
    announceIntroductionsStartup,
};
