// ---------------------------------------------------------------------------
// Gamer ID forum cleanup (Vice Gamers only)
// ---------------------------------------------------------------------------
//
// Members post their gamer IDs as replies in a locked forum, one thread per platform.
// When someone is no longer in the server their replies are removed.
//
// This feature deletes MESSAGES and nothing else. It never removes a member, never
// changes a role, and lives outside lib/activity/ so that folder's single-removal-path
// guarantee stays intact. Three triggers reach the same code: a member leaving, a daily
// reconcile that catches leaves the bot was offline for, and the one-time /gamer-id-sweep.
//
// Nothing here is deleted unless GAMER_ID_CLEANUP_ENABLED is the literal string "true";
// otherwise every path runs read-only and reports what it would have done. The manual
// sweep is the one exception, and only after an explicit Confirm press.

const fs = require('fs');
const { ChannelType, MessageType, PermissionsBitField } = require('discord.js');
const { RESTJSONErrorCodes } = require('discord-api-types/v10');
const client = require('../client');
const {
    VG_GUILD_ID,
    SERVER_CONFIGS,
    LOG_COLORS,
    GAMER_ID_FORUM_ENV_NAMES,
    GAMER_ID_CLEANUP_ENABLED,
    GAMER_ID_LEAVE_DEBOUNCE_MS,
    GAMER_ID_DELETE_DELAY_MS,
    GAMER_ID_PAGE_DELAY_MS,
    GAMER_ID_MAX_CONSECUTIVE_FAILURES,
    GAMER_ID_LOG_PATH,
    GAMER_ID_MEMBER_FETCH_MIN_RATIO
} = require('../config');
const { sendStaffLog, errorField } = require('../staff-log');
const { resolveGuild, fetchAllMembers, guildLabel, sleep } = require('../utils');

// One cleanup per guild at a time. A trigger arriving mid-run sets the rerun flag instead
// of starting a second scan, so a burst of leaves can't stack scans on top of each other.
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

// Vice Gamers only, and only when the forum channel is configured. Every other guild
// gets null, which makes the listener, the reconcile, the command and the boot
// announcement all inert there.
function gamerIdConfigFor(guildId) {
    if (!guildId || guildId !== VG_GUILD_ID) return null;

    const gamerId = SERVER_CONFIGS[guildId]?.gamerId;
    if (!gamerId || !gamerId.forumChannelId) return null;

    return gamerId;
}

function configuredGamerIdGuildIds() {
    return [VG_GUILD_ID].filter(guildId => gamerIdConfigFor(guildId));
}

// ---------------------------------------------------------------------------
// Forum resolution and validation
// ---------------------------------------------------------------------------

// Resolves the configured channel and confirms it is really a forum the bot can read and
// moderate. Returns { forum, problem } so callers can log once and stop.
async function resolveForum(guild) {
    const config = gamerIdConfigFor(guild.id);
    if (!config) return { forum: null, problem: 'Gamer ID cleanup is not configured for this server.' };

    const channel = guild.channels.cache.get(config.forumChannelId)
        || await guild.channels.fetch(config.forumChannelId).catch(() => null);

    if (!channel) {
        return {
            forum: null,
            problem: `No channel with ID \`${config.forumChannelId}\` is visible to the bot. Check ${GAMER_ID_FORUM_ENV_NAMES.join(' / ')} in .env.`
        };
    }

    if (channel.type !== ChannelType.GuildForum) {
        return {
            forum: null,
            problem: `Channel <#${channel.id}> is not a forum channel, so it has no gamer ID threads to clean up.`
        };
    }

    const me = guild.members.me;
    const permissions = channel.permissionsFor?.(me);
    const required = [
        ['View Channel', PermissionsBitField.Flags.ViewChannel],
        ['Read Message History', PermissionsBitField.Flags.ReadMessageHistory],
        ['Manage Messages', PermissionsBitField.Flags.ManageMessages]
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

    console.error(`Gamer ID cleanup: ${problem}`);
    if (now - last < FORUM_ERROR_INTERVAL_MS) return;
    lastForumErrorAt.set(guildId, now);

    await sendStaffLog(guildId, {
        color: LOG_COLORS.error,
        title: '⚠️ Gamer ID Forum Unavailable',
        description: `The gamer ID forum for ${guildLabel(guildId)} could not be used, so no cleanup ran.`,
        fields: [{ name: 'Problem', value: problem }],
        footer: 'Fix the channel ID or the bot\'s permissions, then restart.'
    });
}

// Every thread in the forum, active and archived. The two fetches overlap, so results are
// deduped by ID the same way the activity seeder does it.
async function collectThreads(forum) {
    const byId = new Map();

    try {
        const active = await forum.threads.fetchActive();
        for (const thread of active.threads.values()) byId.set(thread.id, thread);
    } catch (error) {
        console.error(`Gamer ID cleanup: could not fetch active threads in #${forum.name}:`, error.message);
    }

    try {
        let before;

        // Bounded rather than while(true): a runaway cursor would page forever.
        for (let page = 0; page < 50; page++) {
            const archived = await forum.threads.fetchArchived({ limit: 100, ...(before ? { before } : {}) });
            if (archived.threads.size === 0) break;

            for (const thread of archived.threads.values()) byId.set(thread.id, thread);

            if (!archived.hasMore) break;
            before = [...archived.threads.values()].pop()?.archivedAt ?? undefined;
            if (!before) break;

            await sleep(GAMER_ID_PAGE_DELAY_MS);
        }
    } catch (error) {
        console.error(`Gamer ID cleanup: could not page archived threads in #${forum.name}:`, error.message);
    }

    return [...byId.values()];
}

// ---------------------------------------------------------------------------
// Which messages qualify
// ---------------------------------------------------------------------------

// Pure, and the single source of truth for every trigger, so the leave path, the daily
// reconcile, the preview and the confirm step cannot disagree about what qualifies.
//
// No thread-starter check: the forum is locked so only staff create threads, meaning every
// message from a departed member is a reply. Pinned status is deliberately ignored.
function shouldDeleteMessage(message, absentAuthorIds) {
    if (!message.author) return false;
    if (message.author.bot) return false;
    if (message.webhookId) return false;
    if (message.type !== MessageType.Default && message.type !== MessageType.Reply) return false;

    return absentAuthorIds.has(message.author.id);
}

// ---------------------------------------------------------------------------
// Who counts as absent
// ---------------------------------------------------------------------------

// Targeted mode: each queued leaver is re-checked against Discord, because they may have
// rejoined during the debounce window. Only a confirmed Unknown Member counts as absent;
// any other error leaves them out of this run rather than risking a wrong deletion.
async function resolveTargetedAbsentees(guild, queuedIds) {
    const absent = new Set();
    const rejoined = [];
    const unknown = [];

    for (const userId of queuedIds) {
        try {
            await guild.members.fetch(userId);
            rejoined.push(userId);
        } catch (error) {
            if (error.code === RESTJSONErrorCodes.UnknownMember) absent.add(userId);
            else unknown.push(userId);
        }
    }

    return { absent, rejoined, unknown, aborted: false, reason: null };
}

// Full mode: anyone who posted in the forum and is not in a freshly fetched member list.
// The list itself is sanity-checked first, because a truncated fetch would make current
// members look departed - the one genuinely dangerous failure in this feature.
async function resolveFullModeMembers(guild) {
    let members;

    try {
        members = await fetchAllMembers(guild);
    } catch (error) {
        return { members: null, aborted: true, reason: `The member list could not be fetched (${error.message}), so nothing was scanned.` };
    }

    const expected = guild.memberCount || 0;
    const ratio = expected > 0 ? members.size / expected : 1;

    if (ratio < GAMER_ID_MEMBER_FETCH_MIN_RATIO) {
        return {
            members: null,
            aborted: true,
            reason: `The member list came back short (${members.size} of about ${expected}, ${Math.round(ratio * 100)}%). `
                + 'Treating current members as departed would delete the wrong messages, so the run was abandoned.'
        };
    }

    return { members, aborted: false, reason: null };
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

// Pages a thread newest to oldest, collecting the messages that qualify. Returns message
// references only - never content, which is the thing being removed.
async function scanThread(thread, absentAuthorIds, onAuthorSeen) {
    const matches = [];
    let scanned = 0;
    let before;

    while (true) {
        let page;

        try {
            page = await thread.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
        } catch (error) {
            console.error(`Gamer ID cleanup: could not read thread ${thread.id}:`, error.message);
            break;
        }

        if (page.size === 0) break;

        for (const message of page.values()) {
            scanned++;

            // Full mode decides absence as authors stream past, memoizing into the same
            // Set the pure predicate reads, so shouldDeleteMessage stays pure either way.
            if (onAuthorSeen && message.author && !message.author.bot && !message.webhookId) {
                onAuthorSeen(message.author.id);
            }

            if (shouldDeleteMessage(message, absentAuthorIds)) {
                matches.push({ message, threadId: thread.id, threadName: thread.name, authorId: message.author.id });
            }
        }

        before = page.last()?.id;
        if (page.size < 100 || !before) break;

        await sleep(GAMER_ID_PAGE_DELAY_MS);
    }

    return { matches, scanned };
}

// ---------------------------------------------------------------------------
// Deleting
// ---------------------------------------------------------------------------

// Deletes the matches found in one thread.
//
// Whether a message inside an archived thread can be deleted without unarchiving is not
// something this code assumes: it tries the delete, and only unarchives when Discord
// actually rejects it with InvalidActionOnArchivedThread. That avoids unarchiving threads
// that never needed it (which would bump them in the forum's sort order), and the result
// is logged so the real behavior is known after the first live run.
async function deleteMatchesInThread(thread, matches, trigger, report) {
    let unarchivedByUs = false;

    try {
        for (const match of matches) {
            if (report.consecutiveFailures >= GAMER_ID_MAX_CONSECUTIVE_FAILURES) {
                report.aborted = true;
                return;
            }

            let outcome = await attemptDelete(match.message);

            if (outcome === 'archived') {
                if (!unarchivedByUs) {
                    try {
                        await thread.setArchived(false, 'Gamer ID cleanup: removing a departed member\'s post');
                        unarchivedByUs = true;
                        report.threadsUnarchived.add(thread.id);
                    } catch (error) {
                        report.failures.push({ ...stripMessage(match), error: `could not unarchive the thread: ${error.message}` });
                        report.consecutiveFailures++;
                        continue;
                    }
                }

                outcome = await attemptDelete(match.message);
            }

            if (outcome === 'deleted' || outcome === 'gone') {
                report.deleted.push(stripMessage(match));
                report.consecutiveFailures = 0;
                appendGamerIdLogLine(report.guildId, match, trigger);
            } else {
                report.failures.push({ ...stripMessage(match), error: String(outcome) });
                report.consecutiveFailures++;
            }

            await sleep(GAMER_ID_DELETE_DELAY_MS);
        }
    } finally {
        // Put the thread back how it was, even if a delete threw on the way.
        if (unarchivedByUs) {
            await thread.setArchived(true, 'Gamer ID cleanup finished').catch(error => {
                console.error(`Gamer ID cleanup: could not re-archive thread ${thread.id}:`, error.message);
                report.reArchiveFailures.push(thread.id);
            });
        }
    }
}

// One message at a time, never bulkDelete: bulk deletion refuses messages older than 14
// days and these are usually far older.
async function attemptDelete(message) {
    try {
        await message.delete();
        return 'deleted';
    } catch (error) {
        // Already gone is the outcome we wanted, not a failure.
        if (error.code === RESTJSONErrorCodes.UnknownMessage) return 'gone';
        if (error.code === RESTJSONErrorCodes.InvalidActionOnArchivedThread) return 'archived';

        return error.message || 'unknown error';
    }
}

// Drops the live message object, keeping only identifiers. Guarantees no message content
// can reach a log, an embed or the console.
function stripMessage(match) {
    return {
        messageId: match.message.id,
        threadId: match.threadId,
        threadName: match.threadName,
        authorId: match.authorId,
        createdTimestamp: match.message.createdTimestamp
    };
}

function appendGamerIdLogLine(guildId, match, trigger) {
    const line = JSON.stringify({
        guildId,
        threadId: match.threadId,
        messageId: match.message.id,
        authorId: match.authorId,
        deletedAt: Date.now(),
        trigger
    });

    try {
        fs.appendFileSync(GAMER_ID_LOG_PATH, line + '\n');
    } catch (error) {
        console.error('Could not append to the gamer ID log:', error);
    }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

// mode: 'targeted' (queued leavers) or 'full' (everyone absent).
// dryRun: true forces read-only regardless of the flag, used by the /gamer-id-sweep preview.
async function runCleanup(guildId, { trigger, mode, queuedIds = [], dryRun = false }) {
    if (running.has(guildId)) {
        rerunRequested.add(guildId);
        console.log(`Gamer ID cleanup already running for ${guildLabel(guildId)}; queued a rerun instead of starting a second scan.`);
        return { skipped: true, reason: 'already running' };
    }

    running.add(guildId);

    try {
        return await executeCleanup(guildId, { trigger, mode, queuedIds, dryRun });
    } finally {
        running.delete(guildId);

        if (rerunRequested.delete(guildId)) {
            // Full mode on the rerun: whatever triggered it, a full pass is a superset.
            void runCleanup(guildId, { trigger: `${trigger} (rerun)`, mode: 'full' });
        }
    }
}

async function executeCleanup(guildId, { trigger, mode, queuedIds, dryRun }) {
    const live = GAMER_ID_CLEANUP_ENABLED && !dryRun;

    const report = {
        guildId, trigger, mode, live, dryRun,
        threadsScanned: 0,
        messagesScanned: 0,
        matches: [],
        deleted: [],
        failures: [],
        threadsUnarchived: new Set(),
        reArchiveFailures: [],
        consecutiveFailures: 0,
        aborted: false,
        abortReason: null,
        absentAuthorIds: new Set(),
        rejoined: [],
        unknown: []
    };

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

    // Decide absence before scanning, so a bad member list stops the run before any
    // deletion is even considered.
    let onAuthorSeen = null;

    if (mode === 'targeted') {
        const resolved = await resolveTargetedAbsentees(guild, queuedIds);
        report.absentAuthorIds = resolved.absent;
        report.rejoined = resolved.rejoined;
        report.unknown = resolved.unknown;

        if (resolved.absent.size === 0) {
            report.abortReason = null;
            return report; // nobody to act on; caller decides whether to log
        }
    } else {
        const resolved = await resolveFullModeMembers(guild);

        if (resolved.aborted) {
            report.aborted = true;
            report.abortReason = resolved.reason;

            await sendStaffLog(guildId, {
                color: LOG_COLORS.error,
                title: '⚠️ Gamer ID Cleanup Aborted',
                description: `A gamer ID cleanup of ${guildLabel(guildId)} was abandoned before scanning. **Nothing was deleted.**`,
                fields: [
                    { name: 'Trigger', value: trigger },
                    { name: 'Reason', value: resolved.reason }
                ]
            });
            return report;
        }

        const members = resolved.members;
        const present = new Set();

        onAuthorSeen = (authorId) => {
            if (report.absentAuthorIds.has(authorId) || present.has(authorId)) return;
            if (members.has(authorId)) present.add(authorId);
            else report.absentAuthorIds.add(authorId);
        };
    }

    const threads = await collectThreads(forum);

    for (const thread of threads) {
        const { matches, scanned } = await scanThread(thread, report.absentAuthorIds, onAuthorSeen);

        report.threadsScanned++;
        report.messagesScanned += scanned;
        report.matches.push(...matches);
    }

    if (live && report.matches.length > 0) {
        // Grouped by thread so a thread needing unarchiving is unarchived once.
        const byThread = new Map();
        for (const match of report.matches) {
            if (!byThread.has(match.threadId)) byThread.set(match.threadId, []);
            byThread.get(match.threadId).push(match);
        }

        for (const [threadId, matches] of byThread.entries()) {
            if (report.aborted) break;

            const thread = threads.find(t => t.id === threadId);
            if (!thread) continue;

            await deleteMatchesInThread(thread, matches, trigger, report);
        }
    }

    return report;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function describeTrigger(trigger) {
    return { leave: 'Member left', reconcile: 'Daily reconcile', sweep: 'Manual sweep' }[trigger] || trigger;
}

async function reportCleanup(report, { force = false } = {}) {
    const { guildId, live, matches, deleted, failures } = report;

    // A quiet daily "nothing to do" embed is noise, so silence is the default when a run
    // found nothing and hit no problems.
    if (!force && !report.aborted && matches.length === 0 && failures.length === 0) {
        console.log(`Gamer ID cleanup (${report.trigger}) in ${guildLabel(guildId)}: nothing to do.`);
        return;
    }

    if (report.aborted && report.abortReason) return; // already logged at the abort point

    const absentIds = [...report.absentAuthorIds];
    const shownIds = absentIds.slice(0, 20);
    const idsField = absentIds.length === 0
        ? 'None'
        : shownIds.map(id => `\`${id}\``).join(', ')
            + (absentIds.length > shownIds.length ? ` …and ${absentIds.length - shownIds.length} more` : '');

    const fields = [
        { name: 'Trigger', value: describeTrigger(report.trigger), inline: true },
        { name: 'Mode', value: live ? 'Live (messages deleted)' : 'Report-only (nothing deleted)', inline: true },
        { name: 'Threads Scanned', value: `${report.threadsScanned}`, inline: true },
        { name: 'Messages Scanned', value: `${report.messagesScanned}`, inline: true },
        { name: live ? 'Messages Deleted' : 'Would Delete', value: `${live ? deleted.length : matches.length}`, inline: true },
        { name: 'Failures', value: `${failures.length}`, inline: true },
        { name: 'Departed Members Found', value: `${absentIds.length}`, inline: true },
        { name: 'Departed Member IDs', value: idsField }
    ];

    if (report.rejoined.length > 0) {
        fields.push({
            name: 'Rejoined Before The Scan',
            value: `${report.rejoined.length} queued member(s) had come back, so their posts were left alone.`
        });
    }

    if (report.unknown.length > 0) {
        fields.push({
            name: 'Could Not Verify',
            value: `${report.unknown.length} queued member(s) could not be checked, so they were skipped rather than risked.`
        });
    }

    if (report.threadsUnarchived.size > 0) {
        fields.push({
            name: 'Archived Threads Touched',
            value: `${report.threadsUnarchived.size} thread(s) had to be unarchived to delete in, then were re-archived. `
                + 'This may change their position in the forum\'s sort order.'
        });
    }

    if (report.reArchiveFailures.length > 0) {
        fields.push({
            name: '⚠️ Left Unarchived',
            value: `${report.reArchiveFailures.length} thread(s) could not be re-archived: ${report.reArchiveFailures.map(id => `\`${id}\``).join(', ')}`
        });
    }

    if (report.aborted) {
        fields.push({
            name: '🛑 Stopped Early',
            value: `${GAMER_ID_MAX_CONSECUTIVE_FAILURES} consecutive failures. The rest is left for the next reconcile, which picks up where this stopped.`
        });
    }

    if (failures.length > 0) {
        fields.push({
            name: 'First Few Failures',
            value: failures.slice(0, 5).map(f => `\`${f.messageId}\` in ${f.threadName}: ${f.error}`).join('\n')
        });
    }

    await sendStaffLog(guildId, {
        color: report.aborted || failures.length > 0 ? LOG_COLORS.error : LOG_COLORS.gamerId,
        title: live ? '🧹 Gamer ID Cleanup' : '🧹 Gamer ID Cleanup (Report-Only)',
        description: live
            ? `Removed gamer ID posts belonging to departed members in ${guildLabel(guildId)}.`
            : `What a gamer ID cleanup **would** remove in ${guildLabel(guildId)}. Nothing was deleted.`,
        fields,
        footer: live ? describeTrigger(report.trigger) : `${describeTrigger(report.trigger)} - report-only mode`
    });
}

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

// A leaver is queued and the timer restarted, so twenty departures in a row produce one
// scan rather than twenty. /purge removals come through here too.
async function handleGuildMemberRemove(member) {
    try {
        const guildId = member.guild?.id;
        if (!guildId || !gamerIdConfigFor(guildId)) return;

        if (!pendingLeavers.has(guildId)) {
            pendingLeavers.set(guildId, { ids: new Set(), timer: null });
        }

        const pending = pendingLeavers.get(guildId);
        pending.ids.add(member.id);

        if (pending.timer) clearTimeout(pending.timer);

        pending.timer = setTimeout(() => {
            void flushPendingLeavers(guildId);
        }, GAMER_ID_LEAVE_DEBOUNCE_MS);
        pending.timer.unref?.();
    } catch (error) {
        console.error('Error queueing a gamer ID cleanup on member leave:', error);
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
        console.error('Gamer ID cleanup failed after a member leave:', error);

        await sendStaffLog(guildId, {
            color: LOG_COLORS.error,
            title: '⚠️ Gamer ID Cleanup Failed',
            description: `The gamer ID cleanup for departing members in ${guildLabel(guildId)} did not finish.`,
            fields: [errorField(error)],
            footer: 'The daily reconcile will catch anything missed.'
        });
    }
}

// The safety net: catches leaves the bot was offline for, restarted through, or dropped.
async function runGamerIdReconcile() {
    for (const guildId of configuredGamerIdGuildIds()) {
        try {
            const report = await runCleanup(guildId, { trigger: 'reconcile', mode: 'full' });
            if (report.skipped) continue;

            await reportCleanup(report);
        } catch (error) {
            console.error(`Gamer ID reconcile failed for ${guildLabel(guildId)}:`, error);

            await sendStaffLog(guildId, {
                color: LOG_COLORS.error,
                title: '⚠️ Gamer ID Reconcile Failed',
                description: `The daily gamer ID reconcile for ${guildLabel(guildId)} did not finish.`,
                fields: [errorField(error)],
                footer: 'The next reconcile runs in 24 hours.'
            });
        }
    }
}

async function announceGamerIdStartup() {
    for (const guildId of configuredGamerIdGuildIds()) {
        const guild = await resolveGuild(guildId);
        if (!guild) continue;

        const { forum, problem } = await resolveForum(guild);

        if (!forum) {
            await reportForumProblem(guildId, problem);
            continue;
        }

        await sendStaffLog(guildId, {
            color: LOG_COLORS.gamerId,
            title: '🧹 Gamer ID Cleanup Started',
            description: `Departed members' gamer ID posts in <#${forum.id}> will be cleaned up for ${guildLabel(guildId)}.`,
            fields: [
                {
                    name: 'Mode',
                    value: GAMER_ID_CLEANUP_ENABLED
                        ? 'Live (messages are deleted)'
                        : 'Report-only (nothing is deleted)',
                    inline: true
                },
                { name: 'Forum', value: `<#${forum.id}>`, inline: true },
                { name: 'Triggers', value: 'A member leaving (after a 60s debounce), a daily reconcile, and the one-time `/gamer-id-sweep`.' }
            ],
            footer: GAMER_ID_CLEANUP_ENABLED ? undefined : 'Set GAMER_ID_CLEANUP_ENABLED=true and restart to delete for real.'
        });
    }
}

module.exports = {
    gamerIdConfigFor,
    configuredGamerIdGuildIds,
    resolveForum,
    collectThreads,
    shouldDeleteMessage,
    resolveTargetedAbsentees,
    resolveFullModeMembers,
    runCleanup,
    reportCleanup,
    describeTrigger,
    handleGuildMemberRemove,
    flushPendingLeavers,
    runGamerIdReconcile,
    announceGamerIdStartup,
};
