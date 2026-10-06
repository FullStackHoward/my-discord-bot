// ---------------------------------------------------------------------------
// Activity tracking: Active / Inactive labels
// ---------------------------------------------------------------------------
//
// Nothing in this folder removes anyone from a server except the execute step of
// /purge in purge.js. Holding the Inactive role is a label and nothing more: no
// timer, flag or config value here can turn it into a removal.

const fs = require('fs');
const { ChannelType } = require('discord.js');
const client = require('../client');
const {
    VG_GUILD_ID,
    VC_GUILD_ID,
    SERVER_CONFIGS,
    LOG_COLORS,
    ACTIVITY_STATE_PATH,
    ACTIVITY_THRESHOLD_DAYS,
    ACTIVITY_NEW_MEMBER_GRACE_DAYS,
    ACTIVITY_VOICE_MIN_MINUTES,
    ACTIVITY_ROLES_ENABLED,
    ACTIVITY_IGNORED_CHANNELS,
    MS_PER_DAY
} = require('../config');
const { sendStaffLog, errorField } = require('../staff-log');
const { canManageRole, hasStaffPermission, guildLabel } = require('../utils');
const { getMemberTier } = require('../tier-sync');

const STATE_VERSION = 1;

// Only the two main servers are ever eligible. The Application Server is excluded by
// construction rather than by a check, so it can't be switched on by accident.
const ACTIVITY_GUILD_IDS = [VG_GUILD_ID, VC_GUILD_ID];

let activityState = { version: STATE_VERSION, guilds: {} };
let stateDirty = false;

// guildId:userId -> { channelId, joinedAt, credited }
const voiceSessions = new Map();

// guildId:userId currently mid-swap, so a burst of messages produces one role change.
const promotionsInFlight = new Set();

// Per-guild count of instant labelings (re-promotions and first labels) since the
// last sweep summary reported them.
const instantLabelCounts = new Map();

// Throttles the role-hierarchy error embed so a misconfiguration can't flood the log.
const lastRoleErrorLoggedAt = new Map();
const ROLE_ERROR_LOG_INTERVAL_MS = 60 * 60 * 1000;

// Members /purge just removed, so the "labeled member left" embed stays quiet for them.
const recentlyPurged = new Set();

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Activity labeling is on for a server only when both role IDs are configured,
// mirroring radarConfigFor.
function activityConfigFor(guildId) {
    if (!ACTIVITY_GUILD_IDS.includes(guildId)) return null;

    const activity = SERVER_CONFIGS[guildId]?.activity;
    if (!activity || !activity.activeRoleId || !activity.inactiveRoleId) return null;

    return activity;
}

function configuredActivityGuildIds() {
    return ACTIVITY_GUILD_IDS.filter(guildId => activityConfigFor(guildId));
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

function blankGuildState() {
    return {
        trackingStartedAt: 0,
        lastMode: null,
        seeding: {
            status: 'pending',
            startedAt: 0,
            completedAt: 0,
            cutoffTimestamp: 0,
            completedChannels: [],
            summary: {}
        },
        members: {},
        purgeExempt: {}
    };
}

function guildState(guildId) {
    if (!activityState.guilds[guildId]) {
        activityState.guilds[guildId] = blankGuildState();
    }

    // Older files predate fields added later; fill them in rather than crashing on undefined.
    const state = activityState.guilds[guildId];
    const blank = blankGuildState();

    for (const key of Object.keys(blank)) {
        if (state[key] === undefined) state[key] = blank[key];
    }
    for (const key of Object.keys(blank.seeding)) {
        if (state.seeding[key] === undefined) state.seeding[key] = blank.seeding[key];
    }

    return state;
}

function loadActivityState() {
    try {
        const parsed = JSON.parse(fs.readFileSync(ACTIVITY_STATE_PATH, 'utf8'));

        activityState = {
            version: parsed.version || STATE_VERSION,
            guilds: parsed.guilds || {}
        };

        const memberCount = Object.values(activityState.guilds)
            .reduce((total, g) => total + Object.keys(g.members || {}).length, 0);

        console.log(`Loaded activity state: ${Object.keys(activityState.guilds).length} guild(s), ${memberCount} tracked member(s)`);
    } catch (error) {
        if (error.code === 'ENOENT') {
            // Normal first run.
            activityState = { version: STATE_VERSION, guilds: {} };
        } else {
            // Anything else means the file exists but is unusable. Keep it: losing weeks
            // of timestamps silently is worse than a stray file on disk.
            console.error('Could not read activity state:', error);
            preserveCorruptState(error);
            activityState = { version: STATE_VERSION, guilds: {} };
        }
    }

    const now = Date.now();

    for (const guildId of configuredActivityGuildIds()) {
        const state = guildState(guildId);
        if (!state.trackingStartedAt) state.trackingStartedAt = now;
    }

    stateDirty = true;
}

function preserveCorruptState(error) {
    const movedTo = `${ACTIVITY_STATE_PATH}.corrupt-${Date.now()}`;

    try {
        fs.renameSync(ACTIVITY_STATE_PATH, movedTo);
        console.error(`Renamed unreadable activity state to ${movedTo}`);

        void sendStaffLogToConfiguredGuilds({
            color: LOG_COLORS.error,
            title: '⚠️ Activity State Unreadable',
            description: 'The activity state file could not be read, so it was set aside and tracking restarted from empty. Previously recorded activity timestamps are in the renamed file.',
            fields: [
                errorField(error),
                { name: 'Renamed To', value: movedTo }
            ],
            footer: 'Seeding will re-run on the next boot to rebuild message history.'
        });
    } catch (renameError) {
        console.error('Could not set aside the unreadable activity state file:', renameError);
    }
}

async function sendStaffLogToConfiguredGuilds(options) {
    for (const guildId of configuredActivityGuildIds()) {
        await sendStaffLog(guildId, options);
    }
}

// Atomic: this file is written every minute, so a crash mid-write must not be able to
// leave a half-JSON file behind.
function flushActivityState(force = false) {
    if (!stateDirty && !force) return;

    const temp = `${ACTIVITY_STATE_PATH}.tmp`;

    try {
        fs.writeFileSync(temp, JSON.stringify(activityState, null, 2));
        fs.renameSync(temp, ACTIVITY_STATE_PATH);
        stateDirty = false;
    } catch (error) {
        console.error('Failed to flush activity state:', error);
        throttledStateError(error);
    }
}

let lastStateErrorLoggedAt = 0;

function throttledStateError(error) {
    const now = Date.now();
    if (now - lastStateErrorLoggedAt < ROLE_ERROR_LOG_INTERVAL_MS) return;
    lastStateErrorLoggedAt = now;

    void sendStaffLogToConfiguredGuilds({
        color: LOG_COLORS.error,
        title: '⚠️ Activity State Not Saved',
        description: 'Activity timestamps could not be written to disk. Recent activity will be lost if the bot restarts before the next successful save.',
        fields: [errorField(error)],
        footer: `Check file permissions on ${ACTIVITY_STATE_PATH}.`
    });
}

function markStateDirty() {
    stateDirty = true;
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

// Monotonic by design: live signals and the seeding scan race constantly, and only the
// most recent timestamp matters, so write order is irrelevant.
function markActive(guildId, userId, timestamp, signal) {
    if (!activityConfigFor(guildId)) return false;
    if (!timestamp || !Number.isFinite(timestamp)) return false;

    const members = guildState(guildId).members;
    const existing = members[userId];

    if (existing && existing.lastActiveAt >= timestamp) return false;

    members[userId] = { lastActiveAt: timestamp, lastSignal: signal };
    stateDirty = true;
    return true;
}

function getMemberActivity(guildId, userId) {
    return guildState(guildId).members[userId] || null;
}

function forgetMember(guildId, userId) {
    const members = guildState(guildId).members;
    if (members[userId] === undefined) return false;

    delete members[userId];
    stateDirty = true;
    return true;
}

// ---------------------------------------------------------------------------
// Classification - the single source of truth for the sweep, /purge and /activity
// ---------------------------------------------------------------------------

// Pure apart from reading module state, so the sweep, the purge preview and the report
// can never disagree about someone's status.
function classifyMember(member, guildId, now = Date.now()) {
    const record = getMemberActivity(guildId, member.id);
    const lastActiveAt = record ? record.lastActiveAt : 0;
    const lastSignal = record ? record.lastSignal : null;
    const base = { lastActiveAt, lastSignal };

    const exempt = exemptReasonFor(member, guildId, now);
    if (exempt) return { status: 'exempt', exemptReason: exempt, ...base };

    if (lastActiveAt && now - lastActiveAt <= ACTIVITY_THRESHOLD_DAYS * MS_PER_DAY) {
        return { status: 'active', exemptReason: null, ...base };
    }

    return { status: 'inactive', exemptReason: null, ...base };
}

// Server boosters. premiumSince is the real signal; the guild's managed booster role is
// a fallback for a member object that arrived without premium data. Read live off the
// member every time, so someone who stops boosting is classified normally from their
// next evaluation - no state to persist and nothing to clean up.
function isBooster(member) {
    if (member.premiumSince) return true;

    const boosterRole = member.guild?.roles?.premiumSubscriberRole;
    return Boolean(boosterRole) && member.roles.cache.has(boosterRole.id);
}

// First match wins, in the order the spec fixes.
function exemptReasonFor(member, guildId, now) {
    if (member.user?.bot) return 'bot';

    const guild = member.guild;
    if (guild && member.id === guild.ownerId) return 'owner';
    if (process.env.VICER_ADMIN && member.id === process.env.VICER_ADMIN) return 'owner';

    const serverConfig = SERVER_CONFIGS[guildId];
    if (serverConfig && hasStaffPermission(member, member.id, serverConfig)) return 'staff';

    if (serverConfig && getMemberTier(member, serverConfig.tierRoleIds)) return 'subscriber';

    if (isBooster(member)) return 'booster';

    if (isPurgeExempt(guildId, member.id)) return 'manual';

    if (member.joinedTimestamp && now - member.joinedTimestamp < ACTIVITY_NEW_MEMBER_GRACE_DAYS * MS_PER_DAY) {
        return 'newMember';
    }

    return null;
}

const EXEMPT_REASON_LABELS = {
    bot: 'Bot',
    owner: 'Owner',
    staff: 'Staff',
    subscriber: 'Subscriber',
    booster: 'Booster',
    manual: 'Manually exempted',
    newMember: `New member (under ${ACTIVITY_NEW_MEMBER_GRACE_DAYS} days)`
};

function exemptReasonLabel(reason) {
    return EXEMPT_REASON_LABELS[reason] || reason || 'Unknown';
}

// ---------------------------------------------------------------------------
// Manual exemptions
// ---------------------------------------------------------------------------

function isPurgeExempt(guildId, userId) {
    return Boolean(guildState(guildId).purgeExempt[userId]);
}

function listPurgeExempt(guildId) {
    const exempt = guildState(guildId).purgeExempt;
    return Object.entries(exempt).map(([userId, entry]) => ({ userId, ...entry }));
}

// Flushed immediately rather than on the interval: these are rare and load-bearing for
// whether someone shows up in a purge preview.
function addPurgeExempt(guildId, userId, note) {
    guildState(guildId).purgeExempt[userId] = { addedAt: Date.now(), note: note || '' };
    stateDirty = true;
    flushActivityState(true);
}

function removePurgeExempt(guildId, userId) {
    const exempt = guildState(guildId).purgeExempt;
    if (exempt[userId] === undefined) return false;

    delete exempt[userId];
    stateDirty = true;
    flushActivityState(true);
    return true;
}

// ---------------------------------------------------------------------------
// Role application - shared by the daily sweep and the instant path so the two
// cannot drift apart
// ---------------------------------------------------------------------------

// Adds the target role before removing the other one, so a member is never briefly left
// with neither during a swap. Returns what actually changed, or an error.
async function applyActivityRoles(member, status, reason) {
    const config = activityConfigFor(member.guild.id);
    if (!config) return { changed: false, added: null, removed: [] };

    const { activeRoleId, inactiveRoleId } = config;

    let wanted = null;
    if (status === 'active') wanted = activeRoleId;
    else if (status === 'inactive') wanted = inactiveRoleId;

    const unwanted = [activeRoleId, inactiveRoleId].filter(roleId => roleId !== wanted);

    const needsAdd = wanted && !member.roles.cache.has(wanted);
    const needsRemove = unwanted.filter(roleId => member.roles.cache.has(roleId));

    if (!needsAdd && needsRemove.length === 0) {
        return { changed: false, added: null, removed: [] };
    }

    try {
        if (needsAdd) {
            await member.roles.add(wanted, reason);
        }

        if (needsRemove.length > 0) {
            await member.roles.remove(needsRemove, reason);
        }
    } catch (error) {
        return { changed: false, added: null, removed: [], error };
    }

    return {
        changed: true,
        added: needsAdd ? wanted : null,
        removed: needsRemove
    };
}

// True when both roles exist and sit below the bot's top role.
function canManageActivityRoles(guild) {
    const config = activityConfigFor(guild.id);
    if (!config) return { ok: false, problem: 'Activity roles are not configured for this server.' };

    const missing = [config.activeRoleId, config.inactiveRoleId]
        .filter(roleId => !guild.roles.cache.get(roleId));

    if (missing.length > 0) {
        return { ok: false, problem: `Configured role ID(s) do not exist in this server: ${missing.join(', ')}.` };
    }

    const unmanageable = [config.activeRoleId, config.inactiveRoleId]
        .filter(roleId => !canManageRole(guild, roleId));

    if (unmanageable.length > 0) {
        return { ok: false, problem: 'The bot\'s highest role sits below the Active and/or Inactive role.' };
    }

    return { ok: true, problem: null };
}

// ---------------------------------------------------------------------------
// Instant labeling (6.7)
// ---------------------------------------------------------------------------

// Labels a member the moment they do something that counts, rather than making them wait
// for the next daily sweep. Covers two cases:
//
//   - someone carrying Inactive, who is moved back to Active ("reactivated")
//   - someone carrying neither role, who is labeled for the first time
//
// Deliberately cheap on the common path: anyone already carrying Active costs one cache
// lookup and returns, so ordinary chatter from labeled members adds no API traffic. The
// remaining in-memory work (classification) touches only the role cache, never REST.
async function labelActiveFromSignal(member, signal, context = {}) {
    if (!ACTIVITY_ROLES_ENABLED) return;
    if (!member || !member.guild) return;

    const guildId = member.guild.id;
    const config = activityConfigFor(guildId);
    if (!config) return;

    // Already labeled correctly: nothing to do, and this is the overwhelmingly common
    // case for an active member.
    if (member.roles.cache.has(config.activeRoleId)) return;

    const key = `${guildId}:${member.id}`;
    if (promotionsInFlight.has(key)) return;
    promotionsInFlight.add(key);

    try {
        // Exempt members carry neither role, so staff, subscribers and anyone inside the
        // new-member grace are left alone here; the daily sweep strips anything stale.
        const verdict = classifyMember(member, guildId);
        if (verdict.status === 'exempt') return;

        const permission = canManageActivityRoles(member.guild);
        if (!permission.ok) {
            throttledRoleError(guildId, permission.problem);
            return;
        }

        const wasInactive = member.roles.cache.has(config.inactiveRoleId);

        // Applies whatever classification says rather than hardcoding Active, so this
        // path can never disagree with the sweep. In practice a member who just produced
        // a qualifying signal always classifies as active.
        const result = await applyActivityRoles(
            member,
            verdict.status,
            wasInactive ? 'Activity resumed' : 'Activity recorded'
        );

        if (result.error) {
            console.error(`Instant labeling failed for ${member.user.tag} in ${member.guild.name}:`, result.error);
            throttledRoleError(guildId, result.error.message);
            return;
        }

        if (!result.changed) return;

        instantLabelCounts.set(guildId, (instantLabelCounts.get(guildId) || 0) + 1);

        const becameActive = result.added === config.activeRoleId;

        console.log(`Activity: ${wasInactive ? 're-promoted' : 'labeled'} ${member.user.tag} as ${becameActive ? 'Active' : 'Inactive'} in ${member.guild.name} (${signal})`);

        await sendStaffLog(guildId, {
            color: becameActive ? LOG_COLORS.activityPromote : LOG_COLORS.activityDemote,
            title: becameActive
                ? (wasInactive ? '⬆️ Reactivated' : '⬆️ Labeled Active')
                : '⬇️ Marked Inactive',
            description: wasInactive
                ? `**${member.user.tag}** (<@${member.id}>) was inactive and is now Active again.`
                : `**${member.user.tag}** (<@${member.id}>) was carrying no activity label and is now **${becameActive ? 'Active' : 'Inactive'}**.`,
            fields: [
                { name: 'User ID', value: member.id, inline: true },
                { name: 'Signal', value: signal, inline: true },
                ...(context.channelId ? [{ name: 'Channel', value: `<#${context.channelId}>`, inline: true }] : []),
                { name: 'Change', value: `${wasInactive ? 'Inactive' : 'None'} → ${becameActive ? 'Active' : 'Inactive'}`, inline: true },
                {
                    name: wasInactive ? 'Previously Active' : 'Previous Activity',
                    value: context.previousLastActiveAt
                        ? `<t:${Math.floor(context.previousLastActiveAt / 1000)}:R>`
                        : 'No previously recorded activity'
                }
            ],
            footer: wasInactive ? 'Instant re-promotion' : 'Instant labeling'
        });
    } finally {
        promotionsInFlight.delete(key);
    }
}

function throttledRoleError(guildId, problem) {
    const now = Date.now();
    const last = lastRoleErrorLoggedAt.get(guildId) || 0;
    if (now - last < ROLE_ERROR_LOG_INTERVAL_MS) return;
    lastRoleErrorLoggedAt.set(guildId, now);

    void sendStaffLog(guildId, {
        color: LOG_COLORS.error,
        title: '⚠️ Activity Role Change Blocked',
        description: `An activity role change could not be applied in ${guildLabel(guildId)}.`,
        fields: [{ name: 'Reason', value: problem }],
        footer: 'Move the bot\'s role above the Active and Inactive roles in server settings.'
    });
}

function takeInstantLabelCount(guildId) {
    const count = instantLabelCounts.get(guildId) || 0;
    instantLabelCounts.set(guildId, 0);
    return count;
}

// ---------------------------------------------------------------------------
// Listeners
// ---------------------------------------------------------------------------

// A separate messageCreate listener from the prefix-command one, so neither can break
// the other.
async function handleMessageCreate(message) {
    try {
        if (!message.guild) return;                 // DMs never count
        if (!activityConfigFor(message.guild.id)) return;
        if (message.author?.bot) return;
        if (message.webhookId) return;
        if (message.system) return;
        if (ACTIVITY_IGNORED_CHANNELS.includes(message.channelId)) return;

        // A thread's parent being ignored should ignore the thread too, otherwise an
        // ignored channel leaks activity through its own threads.
        if (message.channel?.isThread?.() && ACTIVITY_IGNORED_CHANNELS.includes(message.channel.parentId)) return;

        const guildId = message.guild.id;
        const previous = getMemberActivity(guildId, message.author.id);
        const previousLastActiveAt = previous ? previous.lastActiveAt : 0;

        markActive(guildId, message.author.id, message.createdTimestamp, 'message');

        const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
        if (!member) return;

        await labelActiveFromSignal(member, 'message', {
            channelId: message.channelId,
            previousLastActiveAt
        });
    } catch (error) {
        console.error('Error in activity messageCreate handler:', error);
    }
}

function voiceKey(guildId, userId) {
    return `${guildId}:${userId}`;
}

// A voice or stage channel that isn't the AFK channel. Stage audience members have a
// voice state too, so listeners count as attendance, not just speakers.
function isCountableVoiceChannel(guild, channelId) {
    if (!channelId) return false;
    if (guild.afkChannelId && channelId === guild.afkChannelId) return false;
    if (ACTIVITY_IGNORED_CHANNELS.includes(channelId)) return false;

    const channel = guild.channels.cache.get(channelId);
    if (!channel) return true; // not cached; assume countable rather than losing the session

    return channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice;
}

async function handleVoiceStateUpdate(oldState, newState) {
    try {
        const guild = newState.guild || oldState.guild;
        if (!guild || !activityConfigFor(guild.id)) return;

        const userId = newState.id || oldState.id;
        const member = newState.member || oldState.member;
        if (member?.user?.bot) return;

        const key = voiceKey(guild.id, userId);
        const wasCountable = isCountableVoiceChannel(guild, oldState.channelId);
        const isCountable = isCountableVoiceChannel(guild, newState.channelId);

        // Moving between two countable channels continues the same session.
        if (isCountable) {
            if (!voiceSessions.has(key)) {
                voiceSessions.set(key, { channelId: newState.channelId, joinedAt: Date.now(), credited: false });
            } else {
                voiceSessions.get(key).channelId = newState.channelId;
            }
            return;
        }

        if (!wasCountable) return;

        const session = voiceSessions.get(key);
        voiceSessions.delete(key);
        if (!session) return;

        await creditVoiceSession(guild, member, userId, session, Date.now());
    } catch (error) {
        console.error('Error in activity voiceStateUpdate handler:', error);
    }
}

// Credits a session that has met the minimum length. Called when a session ends and
// from the minute tick, so a long sitting counts without waiting for them to leave.
async function creditVoiceSession(guild, member, userId, session, endTimestamp) {
    const minutes = (endTimestamp - session.joinedAt) / 60000;
    if (minutes < ACTIVITY_VOICE_MIN_MINUTES) return false;
    if (session.credited) return false;

    session.credited = true;

    const signal = isEventChannel(guild, session.channelId) ? 'event' : 'voice';
    const previous = getMemberActivity(guild.id, userId);
    const previousLastActiveAt = previous ? previous.lastActiveAt : 0;

    markActive(guild.id, userId, endTimestamp, signal);

    const resolved = member || await guild.members.fetch(userId).catch(() => null);
    if (resolved) {
        await labelActiveFromSignal(resolved, signal, {
            channelId: session.channelId,
            previousLastActiveAt
        });
    }

    return true;
}

// True when this channel is hosting a scheduled event that is currently running, so the
// session is recorded as event attendance rather than plain voice.
function isEventChannel(guild, channelId) {
    if (!channelId) return false;

    for (const event of guild.scheduledEvents.cache.values()) {
        if (event.channelId !== channelId) continue;
        // 2 === Active. Compared numerically so this doesn't depend on the enum import.
        if (event.status === 2) return true;
    }

    return false;
}

// Credits anyone who has now been in voice past the minimum, so hours-long sessions
// register without waiting for them to disconnect.
async function runVoiceTick() {
    const now = Date.now();

    for (const [key, session] of [...voiceSessions.entries()]) {
        if (session.credited) continue;

        const [guildId, userId] = key.split(':');
        const guild = client.guilds.cache.get(guildId);
        if (!guild) continue;

        try {
            await creditVoiceSession(guild, guild.members.cache.get(userId), userId, session, now);
        } catch (error) {
            console.error(`Voice tick failed for ${key}:`, error);
        }
    }
}

// Time already spent in voice before a restart can't be recovered, so open sessions
// start their clock now. A known, accepted undercount.
function initVoiceSessions() {
    const now = Date.now();
    let opened = 0;

    for (const guildId of configuredActivityGuildIds()) {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) continue;

        for (const [userId, state] of guild.voiceStates.cache.entries()) {
            if (!isCountableVoiceChannel(guild, state.channelId)) continue;
            if (state.member?.user?.bot) continue;

            voiceSessions.set(voiceKey(guildId, userId), { channelId: state.channelId, joinedAt: now, credited: false });
            opened++;
        }
    }

    if (opened > 0) {
        console.log(`Activity: started tracking ${opened} in-progress voice session(s)`);
    }
}

// Drops a member's record when they leave, and logs it when they were carrying a label.
async function handleGuildMemberRemove(member) {
    try {
        const guildId = member.guild?.id;
        if (!guildId || !activityConfigFor(guildId)) return;

        voiceSessions.delete(voiceKey(guildId, member.id));

        const record = getMemberActivity(guildId, member.id);
        const config = activityConfigFor(guildId);

        // member.roles is unavailable on a partial, so the label is best-effort here.
        const heldActive = member.roles?.cache?.has(config.activeRoleId) || false;
        const heldInactive = member.roles?.cache?.has(config.inactiveRoleId) || false;

        forgetMember(guildId, member.id);

        // /purge already logged everyone it removed; don't log them twice.
        if (recentlyPurged.has(`${guildId}:${member.id}`)) return;
        if (!heldActive && !heldInactive) return;

        await sendStaffLog(guildId, {
            color: LOG_COLORS.activity,
            title: '🚪 Labeled Member Left',
            // Without View Audit Log the bot can't tell leaving from being kicked.
            description: `**${member.user?.tag || member.id}** (<@${member.id}>) left or was removed from ${guildLabel(guildId)} while carrying an activity label.`,
            fields: [
                { name: 'User ID', value: member.id, inline: true },
                { name: 'Label', value: heldActive ? 'Active' : 'Inactive', inline: true },
                {
                    name: 'Last Active',
                    value: record?.lastActiveAt
                        ? `<t:${Math.floor(record.lastActiveAt / 1000)}:R> (${record.lastSignal})`
                        : 'No recorded activity'
                }
            ]
        });
    } catch (error) {
        console.error('Error in activity guildMemberRemove handler:', error);
    }
}

function markRecentlyPurged(guildId, userId) {
    const key = `${guildId}:${userId}`;
    recentlyPurged.add(key);
    // Long enough for the gateway's own member-remove event to arrive and be suppressed.
    setTimeout(() => recentlyPurged.delete(key), 5 * 60 * 1000).unref?.();
}

// ---------------------------------------------------------------------------
// Owner gate, shared by /purge, /purge-exempt and /activity
// ---------------------------------------------------------------------------

// VICER_ADMIN is the real gate. default_member_permissions only hides the commands from
// the picker, and an Administrator can still see them, so the ID check is what matters.
function isActivityOwner(userId) {
    return Boolean(process.env.VICER_ADMIN) && userId === process.env.VICER_ADMIN;
}

async function logUnauthorizedAttempt(interaction) {
    const guildId = interaction.guildId;

    console.warn(`Unauthorized ${interaction.commandName} attempt by ${interaction.user.tag} (${interaction.user.id}) in ${guildId}`);

    if (!guildId || !activityConfigFor(guildId)) return;

    const options = interaction.options?.data
        ?.map(option => `${option.name}: ${option.value ?? '(subcommand)'}`)
        .join(', ') || 'None';

    await sendStaffLog(guildId, {
        color: LOG_COLORS.error,
        title: '🚫 Unauthorized Command Attempt',
        description: `**${interaction.user.tag}** (<@${interaction.user.id}>) tried to use \`/${interaction.commandName}\` in ${guildLabel(guildId)} and was denied.`,
        fields: [
            { name: 'User ID', value: interaction.user.id, inline: true },
            { name: 'Channel', value: interaction.channelId ? `<#${interaction.channelId}>` : 'Unknown', inline: true },
            { name: 'Options', value: options }
        ]
    });
}

// ---------------------------------------------------------------------------
// Boot logging
// ---------------------------------------------------------------------------

async function announceActivityStartup() {
    for (const guildId of configuredActivityGuildIds()) {
        const state = guildState(guildId);
        const mode = ACTIVITY_ROLES_ENABLED ? 'live' : 'tracking-only';

        await sendStaffLog(guildId, {
            color: LOG_COLORS.activity,
            title: '📊 Activity Tracking Started',
            description: `Activity tracking is running for ${guildLabel(guildId)}.`,
            fields: [
                { name: 'Mode', value: mode === 'live' ? 'Live (roles are applied)' : 'Tracking-only (no roles changed)', inline: true },
                { name: 'Label Window', value: `${ACTIVITY_THRESHOLD_DAYS} days`, inline: true },
                { name: 'New Member Grace', value: `${ACTIVITY_NEW_MEMBER_GRACE_DAYS} days`, inline: true },
                { name: 'Voice Minimum', value: `${ACTIVITY_VOICE_MIN_MINUTES} minutes`, inline: true },
                { name: 'Seeding', value: state.seeding.status, inline: true },
                {
                    name: 'Tracking Since',
                    value: state.trackingStartedAt ? `<t:${Math.floor(state.trackingStartedAt / 1000)}:R>` : 'Just now',
                    inline: true
                }
            ]
        });

        if (state.lastMode && state.lastMode !== mode) {
            await sendStaffLog(guildId, {
                color: mode === 'live' ? LOG_COLORS.activityPromote : LOG_COLORS.activityDemote,
                title: mode === 'live' ? '🟢 Activity Roles Now Live' : '⏸️ Activity Roles Switched to Tracking-Only',
                description: mode === 'live'
                    ? 'Activity roles will now be added and removed for real.'
                    : 'Activity roles will no longer be changed. Signals are still recorded.',
                fields: [
                    { name: 'Previous Mode', value: state.lastMode, inline: true },
                    { name: 'New Mode', value: mode, inline: true }
                ]
            });
        }

        state.lastMode = mode;
        stateDirty = true;
    }

    flushActivityState(true);
}

module.exports = {
    // config
    activityConfigFor,
    configuredActivityGuildIds,
    // state
    loadActivityState,
    flushActivityState,
    markStateDirty,
    guildState,
    // signals
    markActive,
    getMemberActivity,
    forgetMember,
    // classification
    classifyMember,
    exemptReasonLabel,
    isBooster,
    // exemptions
    isPurgeExempt,
    listPurgeExempt,
    addPurgeExempt,
    removePurgeExempt,
    // roles
    applyActivityRoles,
    canManageActivityRoles,
    labelActiveFromSignal,
    takeInstantLabelCount,
    // listeners
    handleMessageCreate,
    handleVoiceStateUpdate,
    handleGuildMemberRemove,
    initVoiceSessions,
    runVoiceTick,
    markRecentlyPurged,
    // commands
    isActivityOwner,
    logUnauthorizedAttempt,
    // boot
    announceActivityStartup,
    sendStaffLogToConfiguredGuilds,
};
