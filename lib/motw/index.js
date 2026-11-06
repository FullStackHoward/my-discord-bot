// ---------------------------------------------------------------------------
// Member of the Week (Vice Gamers and Vice Creators, each opt-in)
// ---------------------------------------------------------------------------
//
// Every Monday at 9:00 AM Eastern, per server: count messages for the week that just
// ended, announce the most active eligible member with their avatar and their lead over
// the runner-up, give them the Member of the Week role, and take it from whoever held it.
// Our own replacement for the Mee6 module of the same name.
//
// Who can win: anyone except bots, the server owner, VICER_ADMIN and that server's staff
// (hasStaffPermission against that server's own config). Excluded members' messages are
// still counted; eligibility is decided at post time, so a staff change on Monday morning
// applies to that week. The runner-up must also be eligible and still in the server.
//
// Until MOTW_ENABLED is "true" this runs tracking-only: counts are kept, and each Monday
// writes a staff-log rehearsal of who would have won, but nothing is posted and no role
// changes.
//
// Messages only, not voice or events. Deleted or edited messages are not subtracted.

const { EmbedBuilder, PermissionsBitField } = require('discord.js');
const { RESTJSONErrorCodes } = require('discord-api-types/v10');
const {
    VG_GUILD_ID,
    VC_GUILD_ID,
    SERVER_CONFIGS,
    LOG_COLORS,
    LOBBY_TZ,
    MOTW_ENABLED,
    MOTW_CANDIDATE_LIMIT,
    ACTIVITY_IGNORED_CHANNELS,
    MOTW_IGNORED_CHANNELS
} = require('../config');
const { sendStaffLog, errorField } = require('../staff-log');
const { resolveGuild, canManageRole, hasStaffPermission, guildLabel } = require('../utils');
const time = require('../lobby/time');
const windowMath = require('./window');
const store = require('./store');
const copy = require('./copy');

const ROLE_REASON = 'Member of the Week';

// Throttles repeated problems (a missing channel, a failing member fetch) to one staff
// log per hour per server, since the tick retries every minute.
const PROBLEM_LOG_INTERVAL_MS = 60 * 60 * 1000;
const lastProblemLoggedAt = new Map();

// Testing seam for the tracking-only switch, which is otherwise fixed at boot.
let enabledOverride = null;

function isMotwEnabled() {
    return enabledOverride === null ? MOTW_ENABLED : enabledOverride;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function motwConfigFor(guildId) {
    if (!guildId || (guildId !== VG_GUILD_ID && guildId !== VC_GUILD_ID)) return null;

    const config = SERVER_CONFIGS[guildId]?.motw;
    if (!config || !config.roleId || !config.channelId) return null;

    return config;
}

function configuredMotwGuildIds() {
    return [VG_GUILD_ID, VC_GUILD_ID].filter(guildId => motwConfigFor(guildId));
}

function isIgnoredChannel(channelId) {
    return Boolean(channelId) && (ACTIVITY_IGNORED_CHANNELS.includes(channelId) || MOTW_IGNORED_CHANNELS.includes(channelId));
}

// ---------------------------------------------------------------------------
// The current window, cached
// ---------------------------------------------------------------------------

// Finding a boundary costs hundreds of Intl calls, so it must not run per message. The
// window is recomputed only when an instant falls outside the cached one.
let windowCache = null;

function cachedWindowFor(instantMs) {
    if (windowCache && instantMs >= windowCache.start && instantMs < windowCache.end) return windowCache;

    windowCache = windowMath.windowFor(instantMs, LOBBY_TZ);
    return windowCache;
}

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

// A separate messageCreate listener, so it cannot break or be broken by the others. No
// role lookups here: eligibility is judged at post time, which keeps this cheap.
function handleMessageCreate(message) {
    try {
        if (!message.guild) return;
        const guildId = message.guild.id;

        if (!motwConfigFor(guildId)) return;
        if (message.author?.bot) return;
        if (message.webhookId) return;
        if (message.system) return;
        if (isIgnoredChannel(message.channelId)) return;
        if (message.channel?.isThread?.() && isIgnoredChannel(message.channel.parentId)) return;

        // Credited by when the message was created, not when the handler ran.
        const createdAt = message.createdTimestamp || Date.now();
        const window = cachedWindowFor(createdAt);

        store.countMessage(guildId, window.key, message.author.id, createdAt);
    } catch (error) {
        console.error('Member of the Week: could not count a message:', error);
    }
}

function handleGuildMemberRemove(member) {
    try {
        const guildId = member.guild?.id;
        if (!guildId || !motwConfigFor(guildId)) return;

        store.forgetMember(guildId, member.id);
    } catch (error) {
        console.error('Member of the Week: could not forget a departed member:', error);
    }
}

// ---------------------------------------------------------------------------
// Ranking and eligibility
// ---------------------------------------------------------------------------

// Higher count first; on a tie, whoever reached it first (earlier last message); then
// the lower user ID, compared as snowflakes.
function compareSnowflakes(a, b) {
    if (a.length !== b.length) return a.length - b.length;
    return a < b ? -1 : a > b ? 1 : 0;
}

function rankEntries(counts) {
    return Object.entries(counts || {})
        .map(([userId, entry]) => ({ userId, n: entry?.n || 0, lastAt: entry?.lastAt || 0 }))
        .filter(entry => entry.n > 0)
        .sort((a, b) => (b.n - a.n) || (a.lastAt - b.lastAt) || compareSnowflakes(a.userId, b.userId));
}

const EXCLUSION_LABELS = {
    bot: 'bot',
    owner: 'server owner',
    admin: 'bot owner (VICER_ADMIN)',
    staff: 'staff'
};

// null when eligible, otherwise why not.
function exclusionReason(member, guild) {
    if (member.user?.bot) return 'bot';
    if (guild?.ownerId && member.id === guild.ownerId) return 'owner';
    if (process.env.VICER_ADMIN && member.id === process.env.VICER_ADMIN) return 'admin';

    const serverConfig = SERVER_CONFIGS[guild?.id];
    if (serverConfig && hasStaffPermission(member, member.id, serverConfig)) return 'staff';

    return null;
}

// Cache, then a fetch. Returns null only for a confirmed Unknown Member; any other error
// is thrown, because skipping someone over an unexplained failure could crown the wrong
// person.
async function resolveMember(guild, userId) {
    const cached = guild.members.cache.get(userId);
    if (cached) return cached;

    try {
        return await guild.members.fetch(userId);
    } catch (error) {
        if (error.code === RESTJSONErrorCodes.UnknownMember) return null;
        throw error;
    }
}

// Walks the ranking for the first two eligible members still in the server.
// `minWalk` keeps walking past the runner-up, for the standings view.
//
// Returns { winner, runnerUp, lead, considered, ranked, aborted, error }.
async function selectWinner(guild, counts, { limit = MOTW_CANDIDATE_LIMIT, minWalk = 0 } = {}) {
    const ranked = rankEntries(counts);
    const considered = [];
    let winner = null;
    let runnerUp = null;

    for (const entry of ranked.slice(0, Math.max(limit, minWalk))) {
        if (winner && runnerUp && considered.length >= minWalk) break;

        let member;

        try {
            member = await resolveMember(guild, entry.userId);
        } catch (error) {
            return { winner: null, runnerUp: null, lead: 0, considered, ranked, aborted: true, error, failedUserId: entry.userId };
        }

        if (!member) {
            considered.push({ ...entry, status: 'departed' });
            continue;
        }

        const reason = exclusionReason(member, guild);
        considered.push({ ...entry, member, status: reason || 'eligible' });

        if (reason) continue;

        // Candidates beyond the limit are only walked for display, never chosen.
        if (considered.length > limit) continue;

        if (!winner) winner = { ...entry, member };
        else if (!runnerUp) runnerUp = { ...entry, member };
    }

    const lead = winner ? winner.n - (runnerUp?.n ?? 0) : 0;
    return { winner, runnerUp, lead, considered, ranked, aborted: false, error: null };
}

// ---------------------------------------------------------------------------
// The announcement
// ---------------------------------------------------------------------------

// The message payload. Only the winner can be pinged by it.
function buildAnnouncement({ winner, runnerUp, lead }, { partial = false } = {}) {
    const embed = new EmbedBuilder()
        .setTitle(copy.TITLE)
        .setColor(copy.COLOR)
        .setDescription(copy.description({
            winnerId: winner.userId,
            count: winner.n,
            hasRunnerUp: Boolean(runnerUp),
            lead
        }))
        .setFooter({ text: copy.footer(partial) });

    const avatar = winner.member?.displayAvatarURL?.({ extension: 'png', size: 256 });
    if (avatar) embed.setThumbnail(avatar);

    return {
        content: `<@${winner.userId}>`,
        embeds: [embed],
        allowedMentions: { parse: [], users: [winner.userId], roles: [] }
    };
}

// ---------------------------------------------------------------------------
// Role transfer
// ---------------------------------------------------------------------------

// Add to the winner first, then remove from everyone else, so the role never has zero
// holders mid-swap. If the add fails nothing is removed: the role stays where it was and
// the staff log says why. currentHolderId is stored only once the winner holds it.
async function transferRole(guild, guildId, roleId, winnerMember, previousHolderId) {
    const outcome = {
        skipped: null,
        added: false,
        alreadyHeld: false,
        removedPrevious: null,
        previousDeparted: false,
        extraRemoved: [],
        errors: []
    };

    if (!canManageRole(guild, roleId)) {
        outcome.skipped = 'The bot cannot manage the Member of the Week role: it is missing, or sits at or above the bot\'s highest role.';
        return outcome;
    }

    if (winnerMember.roles.cache.has(roleId)) {
        outcome.alreadyHeld = true;
    } else {
        try {
            await winnerMember.roles.add(roleId, ROLE_REASON);
            outcome.added = true;
        } catch (error) {
            outcome.errors.push(`Could not give the role to <@${winnerMember.id}>: ${error.message}`);
            return outcome;
        }
    }

    store.setCurrentHolder(guildId, winnerMember.id);

    if (previousHolderId && previousHolderId !== winnerMember.id) {
        try {
            const previous = await resolveMember(guild, previousHolderId);

            if (!previous) {
                // The role left with them.
                outcome.previousDeparted = true;
            } else if (previous.roles.cache.has(roleId)) {
                await previous.roles.remove(roleId, ROLE_REASON);
                outcome.removedPrevious = previousHolderId;
            }
        } catch (error) {
            outcome.errors.push(`Could not take the role from <@${previousHolderId}>: ${error.message}`);
        }
    }

    // Anyone else the cache shows holding it: a manual assignment, a missed removal, or
    // whoever the Mee6 module last gave it to. Cache only, no full member fetch.
    const role = guild.roles.cache.get(roleId);
    const holders = role?.members ? [...role.members.values()] : [];

    for (const holder of holders) {
        if (holder.id === winnerMember.id || holder.id === previousHolderId) continue;

        try {
            await holder.roles.remove(roleId, ROLE_REASON);
            outcome.extraRemoved.push(holder.id);
        } catch (error) {
            outcome.errors.push(`Could not take the role from <@${holder.id}>: ${error.message}`);
        }
    }

    return outcome;
}

// ---------------------------------------------------------------------------
// Staff logging
// ---------------------------------------------------------------------------

async function logProblemThrottled(guildId, kind, options, nowMs = Date.now()) {
    const key = `${guildId}:${kind}`;
    const last = lastProblemLoggedAt.get(key) || 0;

    console.error(`Member of the Week (${guildLabel(guildId)}): ${options.description}`);
    if (nowMs - last < PROBLEM_LOG_INTERVAL_MS) return;

    lastProblemLoggedAt.set(key, nowMs);
    await sendStaffLog(guildId, options);
}

function resultFields(selection) {
    const { winner, runnerUp, lead } = selection;

    return [
        { name: 'Winner', value: `<@${winner.userId}> (\`${winner.userId}\`)`, inline: true },
        { name: 'Messages', value: `${winner.n}`, inline: true },
        {
            name: 'Runner-up',
            value: runnerUp ? `<@${runnerUp.userId}> with ${runnerUp.n}` : 'None',
            inline: true
        },
        { name: 'Lead', value: runnerUp ? `${lead}` : '—', inline: true }
    ];
}

function excludedSummary(considered) {
    const skipped = considered.filter(entry => entry.status !== 'eligible');
    if (skipped.length === 0) return null;

    return skipped.slice(0, 10)
        .map(entry => `<@${entry.userId}> (${entry.n}): ${entry.status === 'departed' ? 'left the server' : EXCLUSION_LABELS[entry.status]}`)
        .join('\n');
}

function roleOutcomeLines(outcome, previousHolderId) {
    if (outcome.skipped) return [`⚠️ ${outcome.skipped} No role was changed.`];

    const lines = [outcome.alreadyHeld ? 'Winner already held the role.' : outcome.added ? 'Role given to the winner.' : 'Role not given.'];

    if (outcome.removedPrevious) lines.push(`Taken from the previous holder <@${outcome.removedPrevious}>.`);
    else if (outcome.previousDeparted) lines.push(`Previous holder \`${previousHolderId}\` has left the server.`);

    if (outcome.extraRemoved.length > 0) {
        lines.push(`Also taken from ${outcome.extraRemoved.map(id => `<@${id}>`).join(', ')}.`);
    }

    for (const error of outcome.errors) lines.push(`⚠️ ${error}`);

    return lines;
}

// ---------------------------------------------------------------------------
// The Monday tick
// ---------------------------------------------------------------------------

async function resolveAnnouncementChannel(guild, channelId) {
    const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
    return channel?.isTextBased?.() ? channel : null;
}

// A Monday that passed while the bot could not post. Recorded and logged rather than
// announced late; only the window that just ended is ever attempted.
async function noteMissedWeek(guildId, guildEntry, ended) {
    const previousKey = time.localIsoDate(ended.start, LOBBY_TZ);

    if (!guildEntry.lastHandledWeek || guildEntry.lastHandledWeek >= previousKey) return;
    if (guildEntry.lastMissedNoticeKey === previousKey) return;
    if (guildEntry.trackingStartedAt > ended.start) return;

    guildEntry.lastMissedNoticeKey = previousKey;
    store.markDirty();

    await sendStaffLog(guildId, {
        color: LOG_COLORS.mismatch,
        title: '👑 Member of the Week Missed',
        description: `The Member of the Week for the week ending ${previousKey} was never announced in ${guildLabel(guildId)}, so it has been skipped rather than announced late. The week ending ${time.localIsoDate(ended.end, LOBBY_TZ)} is handled as normal.`
    });
}

// One server's tick. Returns a short status string, mostly for the tests.
async function runGuildTick(guildId, nowMs) {
    const config = motwConfigFor(guildId);
    if (!config) return 'not-configured';

    const current = cachedWindowFor(nowMs);
    const weekKey = time.localIsoDate(current.start, LOBBY_TZ);
    const guildEntry = store.guildState(guildId, nowMs);

    if (guildEntry.lastHandledWeek === weekKey) return 'already-handled';

    // A window that closed before counting began, which is every Monday before the first
    // deploy. Recorded silently, not reported as an empty week.
    if (guildEntry.trackingStartedAt > current.start) {
        store.setHandledWeek(guildId, weekKey);
        return 'predates-tracking';
    }

    const ended = windowMath.windowFor(current.start - 1, LOBBY_TZ);
    const partial = guildEntry.trackingStartedAt > ended.start;

    await noteMissedWeek(guildId, guildEntry, ended);

    const guild = await resolveGuild(guildId);
    if (!guild) return 'no-guild';

    const selection = await selectWinner(guild, guildEntry.weeks[weekKey] || {});

    if (selection.aborted) {
        await logProblemThrottled(guildId, 'member-fetch', {
            color: LOG_COLORS.error,
            title: '⚠️ Member of the Week Delayed',
            description: `A member lookup failed while choosing this week's Member of the Week in ${guildLabel(guildId)}, so nothing was posted. It will be retried every minute.`,
            fields: [{ name: 'Member', value: `\`${selection.failedUserId}\`` }, errorField(selection.error)]
        }, nowMs);
        return 'aborted';
    }

    if (!selection.winner) {
        store.setHandledWeek(guildId, weekKey, {
            lastResult: { weekKey, winnerId: null, count: 0, runnerUpId: null, lead: 0, messageId: null, postedAt: null }
        });
        store.pruneWeeks(guildId);

        const excluded = excludedSummary(selection.considered);

        await sendStaffLog(guildId, {
            color: LOG_COLORS.motw,
            title: '👑 Member of the Week: No Winner',
            description: selection.ranked.length === 0
                ? `No messages were counted in ${guildLabel(guildId)} for the week ending ${weekKey}. Nothing was posted and the role was left where it is.`
                : `Nobody eligible was found in ${guildLabel(guildId)} for the week ending ${weekKey}. Nothing was posted and the role was left where it is.`,
            fields: excluded ? [{ name: 'Skipped', value: excluded }] : []
        });

        return 'no-winner';
    }

    const result = {
        weekKey,
        winnerId: selection.winner.userId,
        count: selection.winner.n,
        runnerUpId: selection.runnerUp?.userId || null,
        lead: selection.lead
    };

    if (!isMotwEnabled()) {
        store.setHandledWeek(guildId, weekKey, { lastResult: { ...result, messageId: null, postedAt: null, rehearsal: true } });
        store.pruneWeeks(guildId);

        const role = guild.roles.cache.get(config.roleId);
        const holders = role?.members ? [...role.members.keys()] : [];
        const losers = holders.filter(id => id !== result.winnerId);
        const excluded = excludedSummary(selection.considered);

        await sendStaffLog(guildId, {
            color: LOG_COLORS.motw,
            title: '👑 Member of the Week (Tracking Only)',
            description: `Who **would** have been Member of the Week in ${guildLabel(guildId)} for the week ending ${weekKey}. Nothing was posted and no role changed, because MOTW_ENABLED is not true.`,
            fields: [
                ...resultFields(selection),
                {
                    name: 'Role',
                    value: [
                        holders.includes(result.winnerId) ? 'The winner already holds it.' : `<@${result.winnerId}> would gain it.`,
                        losers.length > 0 ? `Would be taken from ${losers.map(id => `<@${id}>`).join(', ')}.` : 'Nobody else holds it.'
                    ].join('\n')
                },
                ...(excluded ? [{ name: 'Skipped', value: excluded }] : []),
                ...(partial ? [{ name: 'Partial Week', value: 'Counting started partway through this window.' }] : [])
            ],
            footer: 'Set MOTW_ENABLED=true and restart to start posting.'
        });

        return 'tracking-only';
    }

    const channel = await resolveAnnouncementChannel(guild, config.channelId);

    if (!channel) {
        await logProblemThrottled(guildId, 'channel', {
            color: LOG_COLORS.error,
            title: '⚠️ Member of the Week Could Not Post',
            description: `The announcement channel for ${guildLabel(guildId)} is missing or not a text channel, so this week's Member of the Week was not posted. It will be retried every minute.`,
            footer: 'Check the MOTW channel ID in .env and the bot\'s permissions there.'
        }, nowMs);
        return 'channel-missing';
    }

    let sent;

    try {
        sent = await channel.send(buildAnnouncement(selection, { partial }));
    } catch (error) {
        await logProblemThrottled(guildId, 'post', {
            color: LOG_COLORS.error,
            title: '⚠️ Member of the Week Could Not Post',
            description: `Posting this week's Member of the Week in ${guildLabel(guildId)} failed. It will be retried every minute.`,
            fields: [errorField(error)]
        }, nowMs);
        return 'post-failed';
    }

    // Handled first and written straight away, so nothing after this point can cause a
    // second announcement of the same week.
    const previousHolderId = guildEntry.currentHolderId;
    store.setHandledWeek(guildId, weekKey, { lastResult: { ...result, messageId: sent?.id || null, postedAt: nowMs } });
    store.flush();

    let outcome;

    try {
        outcome = await transferRole(guild, guildId, config.roleId, selection.winner.member, previousHolderId);
    } catch (error) {
        outcome = { skipped: null, added: false, alreadyHeld: false, removedPrevious: null, previousDeparted: false, extraRemoved: [], errors: [error.message] };
    }

    store.pruneWeeks(guildId);
    store.flush();

    const excluded = excludedSummary(selection.considered);

    await sendStaffLog(guildId, {
        color: outcome.skipped || outcome.errors.length > 0 ? LOG_COLORS.error : LOG_COLORS.motw,
        title: '👑 Member of the Week Posted',
        description: `Announced in <#${channel.id}> for the week ending ${weekKey}.`,
        fields: [
            ...resultFields(selection),
            { name: 'Role', value: roleOutcomeLines(outcome, previousHolderId).join('\n') },
            ...(excluded ? [{ name: 'Skipped', value: excluded }] : [])
        ]
    });

    console.log(`Member of the Week: announced ${result.winnerId} for ${guildLabel(guildId)} (week ${weekKey}).`);
    return 'posted';
}

// Called once a minute and once at boot, so a restart at 9:05 on a Monday catches up.
async function runMotwTick(nowMs = Date.now()) {
    for (const guildId of configuredMotwGuildIds()) {
        try {
            await runGuildTick(guildId, nowMs);
        } catch (error) {
            console.error(`Member of the Week: the tick failed for ${guildLabel(guildId)}:`, error);
        }
    }
}

// ---------------------------------------------------------------------------
// Read-only views, for /motw
// ---------------------------------------------------------------------------

function currentWindowSummary(guildId, nowMs = Date.now()) {
    const current = cachedWindowFor(nowMs);
    const guildEntry = store.guildState(guildId, nowMs);
    const counts = guildEntry.weeks[current.key] || {};

    return {
        window: current,
        counts,
        members: Object.keys(counts).length,
        messages: Object.values(counts).reduce((sum, entry) => sum + (entry?.n || 0), 0),
        partial: guildEntry.trackingStartedAt > current.start,
        guildEntry
    };
}

function botCanPostIn(channel, guild) {
    const permissions = channel?.permissionsFor?.(guild.members.me);
    if (!permissions) return false;

    return permissions.has([
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.EmbedLinks
    ]);
}

module.exports = {
    EXCLUSION_LABELS,
    isMotwEnabled,
    motwConfigFor,
    configuredMotwGuildIds,
    cachedWindowFor,
    handleMessageCreate,
    handleGuildMemberRemove,
    rankEntries,
    exclusionReason,
    resolveMember,
    selectWinner,
    buildAnnouncement,
    transferRole,
    resolveAnnouncementChannel,
    runGuildTick,
    runMotwTick,
    currentWindowSummary,
    botCanPostIn,
    startFlushing: store.startFlushing,
    flush: store.flush,
    // Testing seams.
    _setEnabled: value => { enabledOverride = value; },
    _resetThrottles: () => lastProblemLoggedAt.clear(),
};
