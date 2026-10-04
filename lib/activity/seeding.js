// ---------------------------------------------------------------------------
// Activity seeding: message-history backfill
// ---------------------------------------------------------------------------
//
// On first run, walks every readable channel back to the label cutoff so members who
// have posted recently start with a real lastActiveAt. Without this, every member would
// look inactive on day one and the first sweep would be meaningless.
//
// Resumable: each finished channel is checkpointed, so a restart mid-scan picks up where
// it left off rather than re-reading everything.

const { AttachmentBuilder, ChannelType, PermissionsBitField } = require('discord.js');
const client = require('../client');
const {
    LOG_COLORS,
    ACTIVITY_THRESHOLD_DAYS,
    SEED_PAGE_DELAY_MS,
    SEED_CHANNEL_DELAY_MS,
    SEED_MAX_MESSAGES_PER_CHANNEL,
    SEED_PROGRESS_EVERY_CHANNELS,
    SEED_PROGRESS_EVERY_MS,
    MS_PER_DAY
} = require('../config');
const { sendStaffLog, errorField } = require('../staff-log');
const { resolveGuild, fetchAllMembers, sleep, guildLabel } = require('../utils');
const activity = require('./index');

let seedingRunning = false;

// Channel types whose message history is worth scanning.
const TEXTY_TYPES = new Set([
    ChannelType.GuildText,
    ChannelType.GuildAnnouncement,
    ChannelType.GuildVoice,          // text-in-voice
    ChannelType.GuildStageVoice,
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread
]);

// Runs the guilds one after another rather than in parallel: this is a long, REST-heavy
// job and there's no reason to double its rate-limit pressure.
async function runSeedingForAllGuilds() {
    if (seedingRunning) {
        console.log('Activity seeding already running, skipping.');
        return;
    }

    seedingRunning = true;

    try {
        for (const guildId of activity.configuredActivityGuildIds()) {
            try {
                await seedGuild(guildId);
            } catch (error) {
                console.error(`Activity seeding failed for guild ${guildId}:`, error);

                // Status deliberately left as 'running' so the next boot resumes.
                await sendStaffLog(guildId, {
                    color: LOG_COLORS.error,
                    title: '⚠️ Activity Seeding Failed',
                    description: `The message-history backfill for ${guildLabel(guildId)} stopped early.`,
                    fields: [errorField(error)],
                    footer: 'It will resume from the last completed channel on the next boot.'
                });
            }
        }
    } finally {
        seedingRunning = false;
    }
}

async function seedGuild(guildId) {
    const state = activity.guildState(guildId);
    if (state.seeding.status === 'complete') return;

    const guild = await resolveGuild(guildId);
    if (!guild) {
        console.log(`Guild ${guildId} not available for activity seeding`);
        return;
    }

    const resuming = state.seeding.status === 'running' && state.seeding.completedChannels.length > 0;

    if (!resuming) {
        state.seeding.startedAt = Date.now();
        // Only the label window needs covering: /purge has no longer window of its own.
        state.seeding.cutoffTimestamp = Date.now() - ACTIVITY_THRESHOLD_DAYS * MS_PER_DAY;
        state.seeding.completedChannels = [];
    }

    state.seeding.status = 'running';
    activity.markStateDirty();
    activity.flushActivityState(true);

    const cutoff = state.seeding.cutoffTimestamp;
    const done = new Set(state.seeding.completedChannels);
    const channels = await collectScannableChannels(guild);
    const todo = channels.scannable.filter(channel => !done.has(channel.id));

    await sendStaffLog(guildId, {
        color: LOG_COLORS.activity,
        title: '🔎 Activity Seeding Started',
        description: resuming
            ? `Resuming the message-history backfill for ${guildLabel(guildId)}.`
            : `Scanning message history in ${guildLabel(guildId)} so activity labels are meaningful immediately.`,
        fields: [
            { name: 'Channels To Scan', value: `${todo.length}`, inline: true },
            { name: 'Already Done', value: `${done.size}`, inline: true },
            { name: 'Skipped (No Access)', value: `${channels.skipped.length}`, inline: true },
            { name: 'Cutoff', value: `<t:${Math.floor(cutoff / 1000)}:f> (${ACTIVITY_THRESHOLD_DAYS} days back)` }
        ],
        footer: resuming ? 'Resumed after a restart' : 'Seeding'
    });

    const totals = {
        channelsScanned: done.size,
        messagesRead: 0,
        cappedChannels: [],
        authors: new Set()
    };

    let sinceProgressChannels = 0;
    let lastProgressAt = Date.now();

    for (const channel of todo) {
        const result = await scanChannel(guildId, channel, cutoff);

        totals.messagesRead += result.messagesRead;
        totals.channelsScanned++;
        for (const authorId of result.authors) totals.authors.add(authorId);

        if (result.capped) {
            totals.cappedChannels.push(channel.name || channel.id);

            await sendStaffLog(guildId, {
                color: LOG_COLORS.activityDemote,
                title: '⚠️ Seeding Channel Capped',
                description: `Stopped scanning **#${channel.name || channel.id}** after hitting the per-channel message cap, so older messages in it were not read.`,
                fields: [
                    { name: 'Cap', value: `${SEED_MAX_MESSAGES_PER_CHANNEL} messages`, inline: true },
                    { name: 'Channel ID', value: channel.id, inline: true }
                ],
                footer: 'Seeding'
            });
        }

        // Checkpoint per channel so a restart never redoes finished work.
        state.seeding.completedChannels.push(channel.id);
        activity.markStateDirty();
        activity.flushActivityState(true);

        sinceProgressChannels++;
        const dueByCount = sinceProgressChannels >= SEED_PROGRESS_EVERY_CHANNELS;
        const dueByTime = Date.now() - lastProgressAt >= SEED_PROGRESS_EVERY_MS;

        if ((dueByCount || dueByTime) && totals.channelsScanned < channels.scannable.length) {
            sinceProgressChannels = 0;
            lastProgressAt = Date.now();

            await sendStaffLog(guildId, {
                color: LOG_COLORS.activity,
                title: '🔎 Activity Seeding Progress',
                fields: [
                    { name: 'Channels', value: `${totals.channelsScanned} / ${channels.scannable.length}`, inline: true },
                    { name: 'Messages Read', value: `${totals.messagesRead}`, inline: true },
                    { name: 'Authors Found', value: `${totals.authors.size}`, inline: true }
                ],
                footer: 'Seeding'
            });
        }

        await sleep(SEED_CHANNEL_DELAY_MS);
    }

    // Prune anyone no longer in the server now that we have the full picture.
    let pruned = 0;

    try {
        const members = await fetchAllMembers(guild);

        for (const userId of Object.keys(activity.guildState(guildId).members)) {
            if (!members.has(userId)) {
                activity.forgetMember(guildId, userId);
                pruned++;
            }
        }
    } catch (error) {
        console.error(`Could not prune non-members after seeding ${guild.name}:`, error);
    }

    const elapsedMs = Date.now() - state.seeding.startedAt;

    state.seeding.status = 'complete';
    state.seeding.completedAt = Date.now();
    state.seeding.summary = {
        channelsScanned: totals.channelsScanned,
        channelsSkipped: channels.skipped.map(c => c.label),
        cappedChannels: totals.cappedChannels,
        messagesRead: totals.messagesRead,
        distinctAuthors: totals.authors.size,
        prunedNonMembers: pruned,
        elapsedMs
    };
    activity.markStateDirty();
    activity.flushActivityState(true);

    console.log(`Activity seeding complete for ${guild.name}: ${totals.messagesRead} message(s), ${totals.authors.size} author(s)`);

    const skippedList = channels.skipped.map(c => c.label).join('\n') || 'None';
    const files = [];
    let skippedField = skippedList;

    // A long skip list belongs in an attachment, not a truncated embed field.
    if (skippedList.length > 1000) {
        skippedField = `${channels.skipped.length} channels - see the attached list.`;
        files.push(new AttachmentBuilder(
            Buffer.from(channels.skipped.map(c => c.label).join('\n'), 'utf8'),
            { name: `seeding-skipped-${guildId}.txt` }
        ));
    }

    await sendStaffLog(guildId, {
        color: LOG_COLORS.activityPromote,
        title: '✅ Activity Seeding Complete',
        description: `Message history for ${guildLabel(guildId)} has been backfilled. Activity labels are now meaningful.`,
        fields: [
            { name: 'Channels Scanned', value: `${totals.channelsScanned}`, inline: true },
            { name: 'Messages Read', value: `${totals.messagesRead}`, inline: true },
            { name: 'Members Found Active', value: `${totals.authors.size}`, inline: true },
            { name: 'Elapsed', value: formatDuration(elapsedMs), inline: true },
            { name: 'Pruned (No Longer Members)', value: `${pruned}`, inline: true },
            { name: 'Capped Channels', value: totals.cappedChannels.join(', ') || 'None', inline: true },
            { name: 'Skipped (No Access)', value: skippedField },
            {
                name: '⚠️ Known Limitation',
                value: 'Discord exposes no voice history, so voice and event attendance could not be backfilled. A member whose only recent activity was voice will look inactive until live tracking catches them.'
            }
        ],
        footer: 'Seeding',
        files
    });
}

// Every channel whose history the bot can actually read, plus a labeled list of the ones
// it cannot, so gaps in the backfill are visible rather than silent.
async function collectScannableChannels(guild) {
    const scannable = [];
    const skipped = [];
    const me = guild.members.me;

    const consider = (channel, labelPrefix = '') => {
        if (!channel || !TEXTY_TYPES.has(channel.type)) return;

        const label = `${labelPrefix}#${channel.name || channel.id} (${channel.id})`;

        // A thread inherits its parent's permissions, which permissionsFor already
        // accounts for; threads just can't be checked before they're fetched.
        const permissions = channel.permissionsFor?.(me);

        if (!permissions
            || !permissions.has(PermissionsBitField.Flags.ViewChannel)
            || !permissions.has(PermissionsBitField.Flags.ReadMessageHistory)) {
            skipped.push({ id: channel.id, label: `${label} - missing View Channel or Read Message History` });
            return;
        }

        scannable.push(channel);
    };

    for (const channel of guild.channels.cache.values()) {
        if (channel.type === ChannelType.GuildForum || channel.type === ChannelType.GuildMedia) {
            // A forum holds no messages itself; its threads do, and they come from the
            // active/archived fetches below.
            continue;
        }

        consider(channel);
    }

    // Active threads across the whole guild, in one call.
    try {
        const active = await guild.channels.fetchActiveThreads();
        for (const thread of active.threads.values()) consider(thread, 'thread ');
    } catch (error) {
        console.error(`Could not fetch active threads in ${guild.name}:`, error);
    }

    // Archived public threads, per parent. Private threads are skipped unless the bot is
    // already a member, which fetchArchived reflects.
    for (const channel of guild.channels.cache.values()) {
        if (!channel.threads) continue;

        try {
            let before;

            for (let page = 0; page < 10; page++) {
                const archived = await channel.threads.fetchArchived({ limit: 100, before });
                if (archived.threads.size === 0) break;

                for (const thread of archived.threads.values()) consider(thread, 'archived thread ');

                if (!archived.hasMore) break;
                before = [...archived.threads.values()].pop()?.archivedAt ?? undefined;
                if (!before) break;

                await sleep(SEED_PAGE_DELAY_MS);
            }
        } catch (error) {
            // A channel type without archived threads, or no access. Not worth a log line.
        }
    }

    // fetchActiveThreads and the per-parent fetches can both surface the same thread.
    const seen = new Set();
    const unique = scannable.filter(channel => {
        if (seen.has(channel.id)) return false;
        seen.add(channel.id);
        return true;
    });

    return { scannable: unique, skipped };
}

// Pages newest to oldest until the page runs past the cutoff. markActive is monotonic,
// so only each author's most recent message survives, whatever order they arrive in.
async function scanChannel(guildId, channel, cutoff) {
    const authors = new Set();
    let messagesRead = 0;
    let before;
    let capped = false;

    while (true) {
        let page;

        try {
            page = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
        } catch (error) {
            console.error(`Seeding: could not read #${channel.name || channel.id}:`, error.message);
            break;
        }

        if (page.size === 0) break;

        let oldestOnPage = Infinity;

        for (const message of page.values()) {
            messagesRead++;
            oldestOnPage = Math.min(oldestOnPage, message.createdTimestamp);

            if (message.createdTimestamp < cutoff) continue;
            if (message.author?.bot) continue;
            if (message.webhookId) continue;
            if (message.system) continue;

            if (activity.markActive(guildId, message.author.id, message.createdTimestamp, 'seed')) {
                authors.add(message.author.id);
            } else {
                // Already had a newer timestamp; still a seen author.
                authors.add(message.author.id);
            }
        }

        before = page.last()?.id;

        if (oldestOnPage < cutoff) break;  // walked past the window
        if (page.size < 100) break;        // no more history
        if (!before) break;

        if (messagesRead >= SEED_MAX_MESSAGES_PER_CHANNEL) {
            capped = true;
            break;
        }

        await sleep(SEED_PAGE_DELAY_MS);
    }

    return { messagesRead, authors, capped };
}

function formatDuration(ms) {
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return `${seconds}s`;

    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;

    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

module.exports = {
    runSeedingForAllGuilds,
    seedGuild,
    formatDuration,
};
