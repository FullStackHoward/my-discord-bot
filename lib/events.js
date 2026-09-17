// Scheduled events: mirroring them into a channel, plus RSVP confirmations and
// 15-minute reminder DMs.

const fs = require('fs');
const { GuildScheduledEventStatus } = require('discord.js');
const client = require('./client');
const {
    EVENT_CHANNELS,
    LOG_COLORS,
    DM_CLOSED_ERROR_CODE,
    EVENT_REMINDER_WINDOW_MS,
    EVENT_REMINDER_PRUNE_AGE_MS,
    EVENT_REMINDER_STATE_PATH
} = require('./config');
const { sendStaffLog, errorField } = require('./staff-log');
const { resolveGuild, guildLabel } = require('./utils');
const { radarConfigFor } = require('./radar');

let eventChannelSyncRunning = false;
let eventReminderSweepRunning = false;

// Keyed "eventId:startTimestamp" -> startTimestamp. See runEventReminderSweep for why
// the timestamp is part of the key.
let eventReminderState = { remindedOccurrences: {} };

async function syncEventChannels() {
    if (eventChannelSyncRunning) {
        return;
    }

    eventChannelSyncRunning = true;

    try {
        await Promise.all(EVENT_CHANNELS.map(async ({ guildId, channelId }) => {
            try {
                await syncEventChannel(guildId, channelId);
            } catch (error) {
                console.error(`Error syncing events for guild ${guildId}:`, error);

                await sendStaffLog(guildId, {
                    color: LOG_COLORS.error,
                    title: '⚠️ Event Sync Failed',
                    description: `The scheduled-event sync for ${guildLabel(guildId)} did not finish, so the events channel may be out of date.`,
                    fields: [errorField(error)],
                    footer: 'The next sync runs in 15 minutes.'
                });
            }
        }));
    } finally {
        eventChannelSyncRunning = false;
    }
}

async function syncEventChannel(guildId, channelId) {
    if (!guildId || !channelId) {
        return;
    }

    const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) {
        console.log(`Guild not found for event sync: ${guildId}`);
        return;
    }

    const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
        console.log(`Events channel not found or not text-based for guild ${guildId}: ${channelId}`);

        await sendStaffLog(guildId, {
            color: LOG_COLORS.error,
            title: '⚠️ Events Channel Misconfigured',
            description: `The events channel configured for ${guildLabel(guildId)} is missing, not visible to the bot, or not a text channel.`,
            fields: [
                { name: 'Configured Channel ID', value: `${channelId}` }
            ],
            footer: 'Scheduled events are not being mirrored until this is fixed.'
        });
        return;
    }

    let scheduledEvents;

    try {
        scheduledEvents = await guild.scheduledEvents.fetch();
    } catch (error) {
        console.error(`Failed to fetch scheduled events for ${guild.name}:`, error);

        await sendStaffLog(guildId, {
            color: LOG_COLORS.error,
            title: '⚠️ Event Fetch Failed',
            description: `Could not fetch the scheduled events for ${guildLabel(guildId)}, so the events channel was left untouched this pass.`,
            fields: [errorField(error)],
            footer: 'The next sync runs in 15 minutes.'
        });
        return;
    }

    const messages = await fetchRecentChannelMessages(channel);
    const botUserId = client.user.id;
    const eventMessageMap = new Map();

    for (const message of messages.values()) {
        if (message.author?.id !== botUserId) {
            continue;
        }

        const eventId = extractEventIdFromMessage(message, guildId);
        if (eventId) {
            eventMessageMap.set(eventId, message);
        }
    }

    for (const scheduledEvent of scheduledEvents.values()) {
        if (scheduledEvent.status !== GuildScheduledEventStatus.Scheduled && scheduledEvent.status !== GuildScheduledEventStatus.Active) {
            continue;
        }

        if (!eventMessageMap.has(scheduledEvent.id)) {
            try {
                await channel.send(`https://discord.com/events/${guildId}/${scheduledEvent.id}`);
            } catch (error) {
                console.error(`Failed to post event ${scheduledEvent.id} in ${guild.name}:`, error);

                await sendStaffLog(guildId, {
                    color: LOG_COLORS.error,
                    title: '⚠️ Event Post Failed',
                    description: `Could not post the event **${scheduledEvent.name}** to the events channel in ${guildLabel(guildId)}.`,
                    fields: [errorField(error)],
                    footer: 'Check the bot\'s Send Messages permission in that channel.'
                });
            }
        }
    }

    for (const [eventId, message] of eventMessageMap.entries()) {
        const currentEvent = scheduledEvents.get(eventId);

        if (currentEvent && (currentEvent.status === GuildScheduledEventStatus.Scheduled || currentEvent.status === GuildScheduledEventStatus.Active)) {
            continue;
        }

        try {
            await message.delete();
        } catch (error) {
            console.log(`Could not delete event post ${eventId} in ${guild.name}:`, error.message);
        }
    }
}

async function fetchRecentChannelMessages(channel, maxMessages = 500) {
    const allMessages = new Map();
    let before;

    while (allMessages.size < maxMessages) {
        const fetchOptions = { limit: Math.min(100, maxMessages - allMessages.size) };

        if (before) {
            fetchOptions.before = before;
        }

        const messages = await channel.messages.fetch(fetchOptions);

        if (messages.size === 0) {
            break;
        }

        for (const [messageId, message] of messages.entries()) {
            allMessages.set(messageId, message);
        }

        before = messages.last().id;

        if (messages.size < fetchOptions.limit) {
            break;
        }
    }

    return allMessages;
}

function extractEventIdFromMessage(message, guildId) {
    const match = message.content.match(new RegExp(`https?:\\/\\/discord\\.com\\/events\\/${escapeRegex(guildId)}\\/(\\d+)`));
    return match ? match[1] : null;
}

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Event RSVP confirmations and 15-minute reminders
// ---------------------------------------------------------------------------

// Tells someone publicly that we couldn't reach them, because a closed DM is the one
// failure they can actually fix. Reuses the guild's Vice Radar channel rather than
// introducing new config, and stays silent where Radar isn't set up, the same way
// Vice Radar itself does.
async function announceClosedDMs(guildId, userId, eventName) {
    const radar = radarConfigFor(guildId);
    if (!radar) return;

    try {
        const guild = await resolveGuild(guildId);
        if (!guild) return;

        const channel = await guild.channels.fetch(radar.channelId).catch(() => null);
        if (!channel || !channel.isTextBased()) return;

        await channel.send(
            `⚠️ <@${userId}>, we tried to DM you about **${eventName}** but your DMs are closed. ` +
            `Open DMs from server members to get RSVP confirmations and reminders.`
        );
    } catch (error) {
        console.error(`Failed to post closed-DM callout for ${userId}:`, error);
    }
}

// Fires the moment someone marks Interested on a Discord scheduled event. A recurring
// event is one persistent object, so this fires once for the whole series rather than
// once per occurrence.

async function handleScheduledEventUserAdd(scheduledEvent, user) {
    try {
        if (user.bot) return;
        if (!EVENT_CHANNELS.some(({ guildId }) => guildId === scheduledEvent.guildId)) return;

        // null for a one-off event, an object for a recurring one.
        const recurringNote = scheduledEvent.recurrenceRule
            ? ` This one repeats, so you'll get a reminder before each occurrence, not just this one.`
            : '';

        await user.send(
            `✅ You're RSVP'd for **${scheduledEvent.name}**!\n\n` +
            `We'll send you another reminder about 15 minutes before it starts.${recurringNote}`
        );
    } catch (error) {
        if (error.code === DM_CLOSED_ERROR_CODE) {
            console.log(`Closed DMs: ${user.tag} could not receive an RSVP confirmation for "${scheduledEvent.name}"`);
            await announceClosedDMs(scheduledEvent.guildId, user.id, scheduledEvent.name);
        } else {
            console.error('Unexpected error sending RSVP confirmation DM:', error);
        }
    }
}

function loadEventReminderState() {
    try {
        const parsed = JSON.parse(fs.readFileSync(EVENT_REMINDER_STATE_PATH, 'utf8'));

        eventReminderState = { remindedOccurrences: parsed.remindedOccurrences || {} };

        console.log(`Loaded event reminder state: ${Object.keys(eventReminderState.remindedOccurrences).length} occurrence(s) already reminded`);
    } catch (error) {
        // A missing file is the normal first-run case; anything else is worth seeing.
        if (error.code !== 'ENOENT') {
            console.error('Could not read event reminder state, starting from empty:', error);
        }

        eventReminderState = { remindedOccurrences: {} };
    }
}

async function saveEventReminderState() {
    try {
        fs.writeFileSync(EVENT_REMINDER_STATE_PATH, JSON.stringify(eventReminderState, null, 2));
    } catch (error) {
        // A save failure here risks a duplicate reminder after a restart, not a missed
        // one, so this is a console error rather than a staff log page.
        console.error('Failed to save event reminder state:', error);
    }
}

// Returns true when anything was dropped, so the caller knows to re-save.
function pruneEventReminderState(now) {
    let changed = false;

    for (const [key, startTimestamp] of Object.entries(eventReminderState.remindedOccurrences)) {
        if (now - startTimestamp > EVENT_REMINDER_PRUNE_AGE_MS) {
            delete eventReminderState.remindedOccurrences[key];
            changed = true;
        }
    }

    return changed;
}

// There's no gateway event for "an event is starting soon", so this is a periodic check
// against wall-clock time. That makes it naturally restart-safe: a restart any time
// before the 15-minute mark still leaves the next tick to catch it. The one gap is a bot
// that's offline for the whole window between the mark and the start, which misses that
// occurrence outright.
//
// Subscribers are fetched at send time rather than recorded at RSVP time, so anyone who
// un-marks Interested beforehand drops out of the reminder with no extra bookkeeping.
async function runEventReminderSweep() {
    if (eventReminderSweepRunning) {
        console.log('Event reminder sweep already running, skipping this pass.');
        return;
    }

    eventReminderSweepRunning = true;

    try {
        const now = Date.now();
        let stateChanged = pruneEventReminderState(now);

        for (const { guildId } of EVENT_CHANNELS) {
            const guild = await resolveGuild(guildId);
            if (!guild) continue;

            let scheduledEvents;

            try {
                scheduledEvents = await guild.scheduledEvents.fetch();
            } catch (error) {
                console.error(`Failed to fetch scheduled events for the reminder sweep in ${guild.name}:`, error);
                continue; // This guild's reminders get picked up on the next tick.
            }

            for (const event of scheduledEvents.values()) {
                const isUpcoming = event.status === GuildScheduledEventStatus.Scheduled
                    || event.status === GuildScheduledEventStatus.Active;
                if (!isUpcoming || !event.scheduledStartTimestamp) continue;

                // Keyed by occurrence, not by event ID. A recurring event keeps one
                // persistent ID and just advances its start timestamp, so an ID-only key
                // would remind for the first occurrence and then never again.
                const occurrenceKey = `${event.id}:${event.scheduledStartTimestamp}`;
                if (eventReminderState.remindedOccurrences[occurrenceKey]) continue;

                const msUntilStart = event.scheduledStartTimestamp - now;
                if (msUntilStart > EVENT_REMINDER_WINDOW_MS || msUntilStart <= 0) continue;

                let subscribers;

                try {
                    subscribers = await event.fetchSubscribers();
                } catch (error) {
                    console.error(`Failed to fetch subscribers for event ${event.id}:`, error);
                    continue; // Retry next tick rather than marking it reminded on a failed fetch.
                }

                for (const { user } of subscribers.values()) {
                    if (user.bot) continue;

                    try {
                        await user.send(
                            `⏰ **${event.name}** starts in about 15 minutes!\n\nSee you there.`
                        );
                    } catch (dmError) {
                        if (dmError.code === DM_CLOSED_ERROR_CODE) {
                            console.log(`Closed DMs: ${user.tag} could not receive a reminder for "${event.name}"`);
                            await announceClosedDMs(guildId, user.id, event.name);
                        } else {
                            console.error(`Unexpected error sending event reminder DM to ${user.tag}:`, dmError);
                        }
                    }
                }

                eventReminderState.remindedOccurrences[occurrenceKey] = event.scheduledStartTimestamp;
                stateChanged = true;

                console.log(`Event reminder: DM'd ${subscribers.size} subscriber(s) for "${event.name}" in ${guild.name}`);
            }
        }

        if (stateChanged) {
            await saveEventReminderState();
        }
    } catch (error) {
        console.error('Error during event reminder sweep:', error);
    } finally {
        eventReminderSweepRunning = false;
    }
}

module.exports = {
    syncEventChannels,
    syncEventChannel,
    announceClosedDMs,
    handleScheduledEventUserAdd,
    loadEventReminderState,
    saveEventReminderState,
    runEventReminderSweep,
};
