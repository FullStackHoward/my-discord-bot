// ---------------------------------------------------------------------------
// Feature D: Application Server lifecycle sweep
// ---------------------------------------------------------------------------

const fs = require('fs');
const {
    VG_GUILD_ID,
    VC_GUILD_ID,
    APP_GUILD_ID,
    SERVER_CONFIGS,
    LOG_COLORS,
    APP_CHAT_CHANNEL_ID,
    APP_SUBMIT_CHANNEL_ID,
    APPLY_NUDGE_DELAY_MS,
    NUDGE_KICK_GRACE_MS,
    APPLICATION_STATE_PATH
} = require('./config');
const { sendStaffLog, errorField } = require('./staff-log');
const { resolveGuild, fetchAllMembers, hasStaffPermission } = require('./utils');


// Appy DMs an accepted applicant their invite link, so this bot never needs to know
// which main server someone applied to - only whether they have joined either one.

// Nudge timestamps live on disk so a deploy doesn't silently restart every 24h clock.
let applicationState = { applyNudges: {}, joinNudges: {} };

let applicationSweepRunning = false;

function loadApplicationState() {
    try {
        const parsed = JSON.parse(fs.readFileSync(APPLICATION_STATE_PATH, 'utf8'));

        applicationState = {
            applyNudges: parsed.applyNudges || {},
            joinNudges: parsed.joinNudges || {}
        };

        console.log(`Loaded application state: ${Object.keys(applicationState.applyNudges).length} apply reminder(s), ${Object.keys(applicationState.joinNudges).length} join reminder(s) outstanding`);
    } catch (error) {
        // A missing file is the normal first-run case; anything else is worth seeing.
        if (error.code !== 'ENOENT') {
            console.error('Could not read application state, starting from empty:', error);
        }

        applicationState = { applyNudges: {}, joinNudges: {} };
    }
}

async function saveApplicationState() {
    try {
        fs.writeFileSync(APPLICATION_STATE_PATH, JSON.stringify(applicationState, null, 2));
    } catch (error) {
        console.error('Failed to save application state:', error);

        // Worth surfacing: if this keeps failing, every 24h clock resets on each
        // restart and nobody is ever removed.
        await sendStaffLog(APP_GUILD_ID, {
            color: LOG_COLORS.error,
            title: '⚠️ Application State Not Saved',
            description: 'Reminder timestamps could not be written to disk. They will be lost if the bot restarts, which resets the 24-hour removal clocks.',
            fields: [errorField(error)],
            footer: 'Check the file permissions on application-server-state.json.'
        });
    }
}

// Returns true when the entry existed, so callers can tell whether to re-save.
function clearNudge(nudges, userId) {
    if (nudges[userId] === undefined) return false;

    delete nudges[userId];
    return true;
}

function clearAllNudges(userId) {
    const hadApply = clearNudge(applicationState.applyNudges, userId);
    const hadJoin = clearNudge(applicationState.joinNudges, userId);
    return hadApply || hadJoin;
}

// Drop timestamps for anyone no longer in the server so the file can't grow forever.
function pruneApplicationState(members) {
    let changed = false;

    for (const nudges of [applicationState.applyNudges, applicationState.joinNudges]) {
        for (const userId of Object.keys(nudges)) {
            if (!members.has(userId)) {
                delete nudges[userId];
                changed = true;
            }
        }
    }

    return changed;
}

async function runApplicationSweep() {
    if (applicationSweepRunning) {
        console.log('Application sweep already running, skipping this pass.');
        return;
    }

    applicationSweepRunning = true;

    try {
        const appConfig = SERVER_CONFIGS[APP_GUILD_ID];
        if (!appConfig) return;

        const appGuild = await resolveGuild(APP_GUILD_ID);
        if (!appGuild) {
            console.log('Application Server not available for the lifecycle sweep');
            return;
        }

        let members;

        try {
            members = await fetchAllMembers(appGuild);
        } catch (error) {
            console.error('Failed to fetch Application Server members:', error);

            await sendStaffLog(APP_GUILD_ID, {
                color: LOG_COLORS.error,
                title: '⚠️ Application Sweep Skipped',
                description: 'Could not fetch the Application Server member list, so this sweep did nothing.',
                fields: [errorField(error)],
                footer: 'The next sweep runs in an hour.'
            });
            return;
        }

        // Resolved at most once per pass, and only if a reminder is actually due, so a
        // misconfigured channel doesn't post an error every hour for nothing. Null only
        // disables reminders: removals already past their 24 hours still go ahead.
        const getChatChannel = makeChatChannelResolver(appGuild);

        let stateChanged = pruneApplicationState(members);
        const now = Date.now();

        for (const member of members.values()) {
            if (member.user.bot) continue;
            if (member.id === appGuild.ownerId) continue;
            // Staff hold their own roles for access and are never applicants.
            if (hasStaffPermission(member, member.id, appConfig)) continue;

            try {
                const changed = await handleApplicant(member, appConfig, getChatChannel, now);
                if (changed) stateChanged = true;
            } catch (error) {
                console.error(`Application sweep failed for ${member.user.tag}:`, error);
            }
        }

        if (stateChanged) {
            await saveApplicationState();
        }
    } catch (error) {
        console.error('Error during application sweep:', error);

        await sendStaffLog(APP_GUILD_ID, {
            color: LOG_COLORS.error,
            title: '⚠️ Application Sweep Failed',
            description: 'The Application Server sweep stopped early, so some reminders or removals may have been missed.',
            fields: [errorField(error)],
            footer: 'The next sweep runs in an hour.'
        });
    } finally {
        applicationSweepRunning = false;
    }
}

// One member, in priority order: denied, then accepted, then pending, then never applied.
// Returns true if the on-disk nudge state changed.
async function handleApplicant(member, appConfig, getChatChannel, now) {
    const userId = member.id;

    // 1. Denied - removed straight away, no grace period.
    if (appConfig.deniedRoleId && member.roles.cache.has(appConfig.deniedRoleId)) {
        const changed = clearAllNudges(userId);

        await kickApplicant(member, 'Application denied', {
            title: '👢 Denied Applicant Removed',
            reason: 'Their application was denied.'
        });

        return changed;
    }

    // 2. Accepted - Appy has sent them an invite, so the clock is on using it.
    if (appConfig.verifiedRoleId && member.roles.cache.has(appConfig.verifiedRoleId)) {
        if (await isInEitherMainServer(userId)) {
            // maybeKickFromApplicationServer owns them from here.
            return clearNudge(applicationState.joinNudges, userId);
        }

        const nudgedAt = applicationState.joinNudges[userId];

        if (!nudgedAt) {
            const sent = await sendApplicationNudge(await getChatChannel(), `🎉 <@${userId}>, congrats on being accepted! Don't forget to check your DMs for the invite link from our application bot and join up. If you haven't joined within 24 hours, you'll be removed from here.`);
            if (!sent) return false;

            console.log(`Application sweep: reminded ${member.user.tag} to join a main server`);

            await sendStaffLog(APP_GUILD_ID, {
                color: LOG_COLORS.reconciliation,
                title: '🔄 Join Reminder Sent',
                description: `**${member.user.tag}** (<@${userId}>) was accepted but has not joined Vice Gamers or Vice Creators, so they were reminded in the application chat.`,
                footer: 'They will be removed if they still have not joined 24 hours from now.'
            });

            applicationState.joinNudges[userId] = now;
            return true;
        }

        if (now - nudgedAt >= NUDGE_KICK_GRACE_MS) {
            const kicked = await kickApplicant(member, 'Accepted but did not join a main server within 24 hours of the reminder', {
                title: '👢 Accepted Applicant Removed',
                reason: 'Did not join Vice Gamers or Vice Creators within 24 hours of their reminder.'
            });

            // Left in place on failure so the next sweep retries the removal.
            return kicked ? clearNudge(applicationState.joinNudges, userId) : false;
        }

        return false;
    }

    // 3. Pending - mid-review, nothing to do. They clearly applied, so drop any reminder.
    if (appConfig.pendingRoleId && member.roles.cache.has(appConfig.pendingRoleId)) {
        return clearNudge(applicationState.applyNudges, userId);
    }

    // 4. None of the three. Without both role IDs configured we cannot prove that,
    // and guessing would nudge and then remove people who are mid-review.
    if (!appConfig.pendingRoleId || !appConfig.deniedRoleId) return false;

    if (!member.joinedTimestamp) return false;
    if (now - member.joinedTimestamp < APPLY_NUDGE_DELAY_MS) return false;

    const nudgedAt = applicationState.applyNudges[userId];

    if (!nudgedAt) {
        const submitChannel = APP_SUBMIT_CHANNEL_ID ? `<#${APP_SUBMIT_CHANNEL_ID}>` : '#submit-your-application';
        const sent = await sendApplicationNudge(await getChatChannel(), `👋 <@${userId}>, we noticed you haven't applied yet! Head over to ${submitChannel} to get started, it only takes about 60 seconds.`);
        if (!sent) return false;

        console.log(`Application sweep: reminded ${member.user.tag} to apply`);

        await sendStaffLog(APP_GUILD_ID, {
            color: LOG_COLORS.reconciliation,
            title: '🔄 Apply Reminder Sent',
            description: `**${member.user.tag}** (<@${userId}>) has been here over 8 hours without starting an application, so they were reminded in the application chat.`,
            footer: 'They will be removed if they still have not applied 24 hours from now.'
        });

        applicationState.applyNudges[userId] = now;
        return true;
    }

    if (now - nudgedAt >= NUDGE_KICK_GRACE_MS) {
        const kicked = await kickApplicant(member, 'Did not apply within 24 hours of the reminder', {
            title: '👢 Inactive Applicant Removed',
            reason: 'Never started an application, and did not apply within 24 hours of their reminder.'
        });

        return kicked ? clearNudge(applicationState.applyNudges, userId) : false;
    }

    return false;
}

// Appy sends the right invite link, so either main server counts as having joined.
async function isInEitherMainServer(userId) {
    for (const guildId of [VG_GUILD_ID, VC_GUILD_ID]) {
        const guild = await resolveGuild(guildId);
        if (!guild) continue;

        const member = await guild.members.fetch(userId).catch(() => null);
        if (member) return true;
    }

    return false;
}

function makeChatChannelResolver(appGuild) {
    let resolved;

    return async () => {
        if (resolved === undefined) {
            resolved = await resolveApplicationChatChannel(appGuild);
        }

        return resolved;
    };
}

async function resolveApplicationChatChannel(appGuild) {
    if (!APP_CHAT_CHANNEL_ID) return null;

    const channel = appGuild.channels.cache.get(APP_CHAT_CHANNEL_ID) || await appGuild.channels.fetch(APP_CHAT_CHANNEL_ID).catch(() => null);

    if (!channel || !channel.isTextBased()) {
        console.log(`Application chat channel not found or not text-based: ${APP_CHAT_CHANNEL_ID}`);

        await sendStaffLog(APP_GUILD_ID, {
            color: LOG_COLORS.error,
            title: '⚠️ Application Chat Misconfigured',
            description: 'The application chat channel is missing, not visible to the bot, or not a text channel, so no reminders were sent this pass.',
            fields: [
                { name: 'Configured Channel ID', value: `${APP_CHAT_CHANNEL_ID}` }
            ],
            footer: 'Nobody is being removed for not applying or not joining until this is fixed.'
        });

        return null;
    }

    return channel;
}

// Returns false when nothing was posted, so the caller does not start a 24-hour
// clock for a reminder the member never saw.
async function sendApplicationNudge(channel, content) {
    if (!channel) return false;

    try {
        await channel.send(content);
        return true;
    } catch (error) {
        console.error('Failed to post an application reminder:', error);

        await sendStaffLog(APP_GUILD_ID, {
            color: LOG_COLORS.error,
            title: '⚠️ Application Reminder Failed',
            description: 'Could not post a reminder in the application chat channel.',
            fields: [errorField(error)],
            footer: 'Check the bot\'s Send Messages permission in that channel.'
        });

        return false;
    }
}

// Shared removal path for all three sweep outcomes. Returns true only if the kick landed.
async function kickApplicant(member, kickReason, log) {
    if (!member.kickable) {
        console.error(`Cannot kick ${member.user.tag} from the Application Server - missing permission or role hierarchy issue`);

        await sendStaffLog(APP_GUILD_ID, {
            color: LOG_COLORS.error,
            title: '⚠️ Applicant Removal Blocked',
            description: `**${member.user.tag}** (<@${member.id}>) should have been removed from the Application Server, but the bot could not do it.`,
            fields: [
                { name: 'Why They Were Due Removal', value: log.reason },
                { name: 'Blocked By', value: 'Missing the Kick Members permission, or the bot\'s highest role sits below theirs.' }
            ],
            footer: 'Remove them manually, or fix the permission and the next sweep will retry.'
        });

        return false;
    }

    try {
        await member.kick(kickReason);
    } catch (error) {
        console.error(`Failed to kick ${member.user.tag} from the Application Server:`, error);

        await sendStaffLog(APP_GUILD_ID, {
            color: LOG_COLORS.error,
            title: '⚠️ Applicant Removal Failed',
            description: `**${member.user.tag}** (<@${member.id}>) could not be removed from the Application Server.`,
            fields: [
                { name: 'Why They Were Due Removal', value: log.reason },
                errorField(error)
            ],
            footer: 'The next sweep retries in an hour.'
        });

        return false;
    }

    console.log(`Application sweep: kicked ${member.user.tag} from the Application Server (${kickReason})`);

    await sendStaffLog(APP_GUILD_ID, {
        color: LOG_COLORS.kick,
        title: log.title,
        description: `**${member.user.tag}** (<@${member.id}>) was removed from the Application Server.`,
        fields: [
            { name: 'Reason', value: log.reason }
        ]
    });

    return true;
}

module.exports = {
    loadApplicationState,
    saveApplicationState,
    clearNudge,
    clearAllNudges,
    pruneApplicationState,
    runApplicationSweep,
    handleApplicant,
    isInEitherMainServer,
    makeChatChannelResolver,
    resolveApplicationChatChannel,
    sendApplicationNudge,
    kickApplicant,
};
