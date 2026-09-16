require('dotenv').config();

const fs = require('fs');
const https = require('https');
const path = require('path');
const { ActivityType, ApplicationCommandOptionType, Client, EmbedBuilder, GatewayIntentBits, GuildScheduledEventStatus, MessageFlags, Partials } = require('discord.js');

// Create a new client instance
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        // Vice Radar: GuildPresences needs the Presence Intent toggle in the Developer
        // Portal, GuildMessageReactions powers its reaction opt-in.
        GatewayIntentBits.GuildPresences,
        GatewayIntentBits.GuildMessageReactions,
        // Event RSVP DMs: not a privileged intent, no Developer Portal toggle needed.
        GatewayIntentBits.GuildScheduledEvents
    ],
    // A radar post that has aged out of the message cache arrives partial; without
    // these the reaction opt-in would silently stop working on older posts.
    partials: [Partials.Message, Partials.Reaction, Partials.User]
});

// Conf pulled from .env
const BOT_TOKEN = process.env.BOT_TOKEN;

const VG_GUILD_ID = process.env.VG_GUILD_ID;
const VC_GUILD_ID = process.env.VC_GUILD_ID;
const APP_GUILD_ID = process.env.APP_GUILD_ID;

const EVENT_CHANNELS = [
    { guildId: VG_GUILD_ID, channelId: process.env.VG_EVENT_CHANNEL },
    { guildId: VC_GUILD_ID, channelId: process.env.VC_EVENT_CHANNEL }
];

const SERVER_CONFIGS = {};

SERVER_CONFIGS[VG_GUILD_ID] = {
    verifiedRoleId: process.env.VG_VERIFIED_ROLE,
    staffRoleIds: [
        process.env.VG_STAFF_ROLE_1,
        process.env.VG_STAFF_ROLE_2
    ],
    staffUserIds: [
        process.env.VG_STAFF_USER_1,
        process.env.VG_STAFF_USER_2
    ]
};

SERVER_CONFIGS[VC_GUILD_ID] = {
    verifiedRoleId: process.env.VC_VERIFIED_ROLE,
    staffRoleIds: [
        process.env.VC_STAFF_ROLE_1,
        process.env.VC_STAFF_ROLE_2
    ],
    staffUserIds: [
        process.env.VC_STAFF_USER_1,
        process.env.VC_STAFF_USER_2
    ]
};

// Appy (the third-party application bot) owns these three roles and assigns
// exactly one as staff review an application. verifiedRoleId is Appy's Accepted role.
SERVER_CONFIGS[APP_GUILD_ID] = {
    verifiedRoleId: process.env.APP_VERIFIED_ROLE,
    pendingRoleId: process.env.APP_PENDING_ROLE,
    deniedRoleId: process.env.APP_DENIED_ROLE,
    staffRoleIds: [
        process.env.APP_STAFF_ROLE_1
    ],
    staffUserIds: [
        process.env.APP_STAFF_USER_1
    ]
};

// Subscription tier roles, lowest to highest. Order matters: getMemberTier()
// resolves a member holding several tier roles to the highest one.
const TIER_ORDER = ['vicerPlus', 'vicerPlusPlus', 'superVicer'];

SERVER_CONFIGS[VG_GUILD_ID].tierRoleIds = {
    vicerPlus: process.env.VG_TIER_VICER_PLUS,
    vicerPlusPlus: process.env.VG_TIER_VICER_PLUS_PLUS,
    superVicer: process.env.VG_TIER_SUPER_VICER
};

SERVER_CONFIGS[VC_GUILD_ID].tierRoleIds = {
    vicerPlus: process.env.VC_TIER_VICER_PLUS,
    vicerPlusPlus: process.env.VC_TIER_VICER_PLUS_PLUS,
    superVicer: process.env.VC_TIER_SUPER_VICER
};

// Vice Radar (presence-based squad matching). A server is opted into the feature by
// having BOTH of these set; leave either blank to keep Radar off in that server.
SERVER_CONFIGS[VG_GUILD_ID].radar = {
    roleId: process.env.VG_RADAR_ROLE,
    channelId: process.env.VG_RADAR_CHANNEL
};

SERVER_CONFIGS[VC_GUILD_ID].radar = {
    roleId: process.env.VC_RADAR_ROLE,
    channelId: process.env.VC_RADAR_CHANNEL
};

// Bot log channels, one per server.
const LOG_CHANNELS = {
    [VG_GUILD_ID]: process.env.VG_LOG_CHANNEL,
    [VC_GUILD_ID]: process.env.VC_LOG_CHANNEL,
    [APP_GUILD_ID]: process.env.APP_LOG_CHANNEL
};

// Embed colors by event category, so staff can scan a log channel at a glance.
const LOG_COLORS = {
    join: 0x5865F2,
    verifyAuto: 0x57F287,
    verifyManual: 0x57F287,
    kick: 0xE67E22,
    tierGrant: 0xEB459E,
    tierRemove: 0x992D22,
    mismatch: 0xFEE75C,
    // Deliberately the same blue as join; reconciliation entries are told apart by the 🔄 in the title.
    reconciliation: 0x5865F2,
    error: 0xED4245
};

// Staff never see the raw TIER_ORDER keys; every log goes through tierLabel().
const TIER_DISPLAY_NAMES = {
    vicerPlus: 'Vicer+',
    vicerPlusPlus: 'Vicer++',
    superVicer: 'Super Vicer'
};

function tierLabel(tierName) {
    return TIER_DISPLAY_NAMES[tierName] || tierName;
}

// Reference only: the reconciliation job queries by role, not channel visibility.
// Kept here so the "who is stuck in the waiting room" mapping is documented in code.
const WAITING_ROOM_CHANNELS = {
    [VG_GUILD_ID]: process.env.VG_WAITING_ROOM_CHANNEL,
    [VC_GUILD_ID]: process.env.VC_WAITING_ROOM_CHANNEL
};

// Application Server channels. APP_SUBMIT_CHANNEL only drives a channel mention in
// the apply reminder, so a missing value degrades to plain text rather than failing.
const APP_CHAT_CHANNEL_ID = process.env.APP_CHAT;
const APP_SUBMIT_CHANNEL_ID = process.env.APP_SUBMIT_CHANNEL;

const RECONCILIATION_INTERVAL_MS = 60 * 60 * 1000;
const APPLICATION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

// Offset from the reconciliation pass so the two hourly jobs never request the full
// Application Server member list at the same instant.
const APPLICATION_SWEEP_START_DELAY_MS = 5 * 60 * 1000;

// A full member fetch is a fire-and-forget gateway request: if the shard is
// reconnecting when it goes out, no chunks come back and discord.js gives up after
// 120s of silence. One retry turns that transient failure into a non-event.
const MEMBER_FETCH_ATTEMPTS = 2;
const MEMBER_FETCH_RETRY_MS = 15 * 1000;

// How long someone may sit in the Application Server without starting an application
// before they are reminded, and how long any reminder stands before they are removed.
const APPLY_NUDGE_DELAY_MS = 8 * 60 * 60 * 1000;
const NUDGE_KICK_GRACE_MS = 24 * 60 * 60 * 1000;

// Nudge timestamps live on disk so a deploy doesn't silently restart every 24h clock.
const APPLICATION_STATE_PATH = path.join(__dirname, 'application-server-state.json');

let applicationState = { applyNudges: {}, joinNudges: {} };

// Event RSVP reminders. Checked every minute so the 15-minute mark is caught within a
// tight window; reminded occurrences are dropped a day past their start so the state
// file doesn't grow forever.
const EVENT_REMINDER_CHECK_INTERVAL_MS = 60 * 1000;
const EVENT_REMINDER_WINDOW_MS = 15 * 60 * 1000;
const EVENT_REMINDER_PRUNE_AGE_MS = 24 * 60 * 60 * 1000;
const EVENT_REMINDER_STATE_PATH = path.join(__dirname, 'event-reminder-state.json');

// Discord's error code for a closed DM or a blocked bot, as opposed to a transient
// failure. Only this one earns a public callout.
const DM_CLOSED_ERROR_CODE = 50007;

// Keyed "eventId:startTimestamp" -> startTimestamp. See runEventReminderSweep for why
// the timestamp is part of the key.
let eventReminderState = { remindedOccurrences: {} };

let eventChannelSyncRunning = false;
let reconciliationRunning = false;
let applicationSweepRunning = false;
let eventReminderSweepRunning = false;

// Bot ready event
client.once('ready', () => {
    console.log(`${client.user.tag} is now online and ready!`);
    console.log(`Configured for ${Object.keys(SERVER_CONFIGS).length} server(s)`);

    warnAboutMissingConfig();
    loadApplicationState();
    loadEventReminderState();

    void registerSlashCommands();

    void syncEventChannels();
    setInterval(() => {
        void syncEventChannels();
    }, 15 * 60 * 1000);

    void runReconciliation();
    setInterval(() => {
        void runReconciliation();
    }, RECONCILIATION_INTERVAL_MS);

    setTimeout(() => {
        void runApplicationSweep();
        setInterval(() => {
            void runApplicationSweep();
        }, APPLICATION_SWEEP_INTERVAL_MS);
    }, APPLICATION_SWEEP_START_DELAY_MS);

    void runEventReminderSweep();
    setInterval(() => {
        void runEventReminderSweep();
    }, EVENT_REMINDER_CHECK_INTERVAL_MS);
});

// Handle member joining a server
client.on('guildMemberAdd', async (member) => {
    // Hoisted out of the try so the catch below knows which log channel to use.
    const guildId = member.guild.id;

    try {
        const serverConfig = SERVER_CONFIGS[guildId];

        if (!serverConfig) {
            console.log(`Member joined unconfigured server: ${guildId}`);
            return;
        }

        console.log(`${member.user.tag} joined ${member.guild.name} (${guildId})`);

        await sendStaffLog(guildId, {
            color: LOG_COLORS.join,
            title: '📥 Member Joined',
            description: `**${member.user.tag}** (<@${member.id}>) joined ${guildLabel(guildId)}.`,
            fields: [
                { name: 'Account Created', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true },
                { name: 'Member Count', value: `${member.guild.memberCount}`, inline: true }
            ]
        });

        const verificationSource = await checkAutoVerificationSource(member.user.id, guildId);

        if (verificationSource.shouldVerify && canManageRole(member.guild, serverConfig.verifiedRoleId)) {
            const verifiedRole = member.guild.roles.cache.get(serverConfig.verifiedRoleId);

            await member.roles.add(verifiedRole);
            console.log(`Auto-verified ${member.user.tag} in ${member.guild.name}`);

            let verificationBasis;
            if (verificationSource.fromServer3) {
                verificationBasis = 'an accepted application on the Application Server';
            } else if (verificationSource.fromOtherMainServer) {
                verificationBasis = 'being verified on the other main server';
            } else {
                verificationBasis = 'being verified in another Vice Community server';
            }

            await sendStaffLog(guildId, {
                color: LOG_COLORS.verifyAuto,
                title: '✅ Auto-Verified',
                description: `**${member.user.tag}** (<@${member.id}>) was auto-verified in ${guildLabel(guildId)} on join.`,
                fields: [
                    { name: 'Source', value: `Verified from ${verificationBasis}.` }
                ]
            });

            await maybeKickFromApplicationServer(member.user.id, guildId);

            try {
                let dmMessage = '';

                if (verificationSource.fromServer3) {
                    dmMessage = `🎉 **Welcome to The Vice Community!** 🎉\n\n` +
                        `Congratulations on becoming an official member! Your application has been accepted, ` +
                        `and you've been automatically verified in **${member.guild.name}**.\n\n` +
                        `We're thrilled to have you join our community. Enjoy your stay and feel free to ` +
                        `explore all the channels and connect with fellow members!\n\n` +
                        `Welcome aboard! 🚀`;
                } else if (verificationSource.fromOtherMainServer) {
                    dmMessage = `✅ You've been automatically verified in **${member.guild.name}** based on your verification status in another Vice Community server.`;
                }

                if (dmMessage) {
                    await member.send(dmMessage);
                }
            } catch (dmError) {
                console.log(`Could not send DM to ${member.user.tag}`);
            }
        } else if (verificationSource.shouldVerify) {
            console.error(`Cannot auto-verify ${member.user.tag} in ${member.guild.name} - missing verified role or role hierarchy issue`);

            await sendStaffLog(guildId, {
                color: LOG_COLORS.error,
                title: '⚠️ Auto-Verify Failed',
                description: `**${member.user.tag}** (<@${member.id}>) should have been auto-verified in ${guildLabel(guildId)}, but the role could not be granted.`,
                fields: [
                    { name: 'Reason', value: 'The verified role is missing, or the bot\'s highest role sits below it.' }
                ],
                footer: 'Fix the role setup, then verify this member manually with !verify.'
            });
        }

        // Independent of verification: carry any subscription tier over from the other main server.
        await syncTierRolesOnJoin(member);
    } catch (error) {
        console.error('Error in guildMemberAdd event:', error);

        await sendStaffLog(guildId, {
            color: LOG_COLORS.error,
            title: '⚠️ Join Handler Failed',
            description: `Something went wrong while processing **${member.user.tag}** (<@${member.id}>) joining ${guildLabel(guildId)}. They may not have been verified or given their tier roles.`,
            fields: [errorField(error)],
            footer: 'The hourly reconciliation pass will retry anything that was missed.'
        });
    }
});

// Function to check if a user should be auto-verified and identify the source
async function checkAutoVerificationSource(userId, joinedGuildId) {
    try {
        let fromServer3 = false;
        let fromOtherMainServer = false;
        let shouldVerify = false;

        const mainServers = [process.env.VG_GUILD_ID, process.env.VC_GUILD_ID];
        const server3Id = process.env.APP_GUILD_ID;

        for (const [serverId, config] of Object.entries(SERVER_CONFIGS)) {
            if (serverId === joinedGuildId) continue;

            const guild = await resolveGuild(serverId);
            if (!guild) {
                console.log(`Guild ${serverId} not found`);
                continue;
            }

            try {
                const member = await guild.members.fetch(userId);

                if (member && member.roles.cache.has(config.verifiedRoleId)) {
                    console.log(`User ${userId} is verified in ${guild.name}`);
                    shouldVerify = true;

                    if (serverId === server3Id) {
                        fromServer3 = true;
                    } else if (mainServers.includes(serverId) && mainServers.includes(joinedGuildId)) {
                        fromOtherMainServer = true;
                    }
                }
            } catch (fetchError) {
                // User is not in this guild, continue checking others
            }
        }

        return {
            shouldVerify,
            fromServer3,
            fromOtherMainServer
        };
    } catch (error) {
        console.error('Error checking auto-verification:', error);

        await sendStaffLog(joinedGuildId, {
            color: LOG_COLORS.error,
            title: '⚠️ Verification Check Failed',
            description: `Could not work out whether <@${userId}> should be auto-verified in ${guildLabel(joinedGuildId)}, so they were left unverified.`,
            fields: [errorField(error)],
            footer: 'The hourly reconciliation pass will retry.'
        });

        return { shouldVerify: false, fromServer3: false, fromOtherMainServer: false };
    }
}

// Post announcement to Django API
async function postAnnouncement(title, content, link = null) {
    const payload = JSON.stringify({
        title: title,
        content: content,
        link: link,
    });

    const options = {
        hostname: 'api.vicers.net',
        path: '/api/announcement/create/',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Bot-Secret': process.env.BOT_API_SECRET,
            'Content-Length': Buffer.byteLength(payload),
        }
    };

    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 201) {
                    resolve(JSON.parse(data));
                } else {
                    reject(new Error(`API responded with ${res.statusCode}: ${data}`));
                }
            });
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

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
client.on('guildScheduledEventUserAdd', async (scheduledEvent, user) => {
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
});

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

// Message handler
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    // !verify command
    if (message.content.startsWith('!verify')) {
        try {
            const guildId = message.guild.id;
            const serverConfig = SERVER_CONFIGS[guildId];

            if (!serverConfig) {
                return message.reply('❌ This bot is not configured for this server.');
            }

            if (!hasStaffPermission(message.member, message.author.id, serverConfig)) {
                return message.reply('❌ You don\'t have permission to verify users.');
            }

            const targetUser = message.mentions.members.first();
            if (!targetUser) {
                return message.reply('❌ Please mention a user to verify. Usage: `!verify @user`');
            }

            const verifiedRole = message.guild.roles.cache.get(serverConfig.verifiedRoleId);
            if (!verifiedRole) {
                return message.reply('❌ Verified role not found. Please check the role ID configuration for this server.');
            }

            if (!canManageRole(message.guild, serverConfig.verifiedRoleId)) {
                return message.reply('❌ I cannot assign this role. My role must be positioned above the verified role in server settings.');
            }

            if (targetUser.roles.cache.has(serverConfig.verifiedRoleId)) {
                return message.reply(`❌ ${targetUser.user.tag} is already verified.`);
            }

            await targetUser.roles.add(verifiedRole);
            message.reply(`✅ ${targetUser.user.tag} has been verified!`);
            console.log(`${message.author.tag} verified ${targetUser.user.tag} in ${message.guild.name} (${guildId})`);

            await sendStaffLog(guildId, {
                color: LOG_COLORS.verifyManual,
                title: '✅ Manually Verified',
                description: `**${targetUser.user.tag}** (<@${targetUser.id}>) was verified in ${guildLabel(guildId)}.`,
                fields: [
                    { name: 'Verified By', value: `**${message.author.tag}** (<@${message.author.id}>)` }
                ]
            });

            await maybeKickFromApplicationServer(targetUser.user.id, guildId);
            await autoVerifyInOtherServers(targetUser.user.id, guildId);

        } catch (error) {
            console.error('Error during verification:', error);
            message.reply('❌ An error occurred while verifying the user. Please check bot permissions.');
        }
    }

    // !announce command
    if (message.content.startsWith('!announce')) {
        if (message.author.id !== process.env.VICER_ADMIN) {
            return message.reply('❌ You do not have permission to post announcements.');
        }

        // Usage: !announce Title | Content | optional link
        const args = message.content.slice('!announce '.length).split('|').map(s => s.trim());

        if (args.length < 2) {
            return message.reply('❌ Correct usage: `!announce Title | Content | optional link`');
        }

        const title = args[0];
        const content = args[1];
        const link = args[2] || null;

        try {
            await postAnnouncement(title, content, link);
            message.reply(`✅ Announcement posted successfully!`);
        } catch (error) {
            console.error('Error posting announcement:', error);
            message.reply(`❌ Failed to post announcement. Error: ${error.message}`);
        }
    }
});

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

// These run alongside the !verify / !announce prefix handlers above. The two systems
// are independent, so the old commands stay live until the slash versions are
// confirmed working in production.
const SLASH_COMMANDS = [
    {
        name: 'verify',
        description: 'Manually verify a member in this server',
        options: [
            {
                name: 'user',
                description: 'The member to verify',
                type: ApplicationCommandOptionType.User,
                required: true
            }
        ]
    },
    {
        name: 'announce',
        description: 'Post an announcement to the Vicers community site',
        options: [
            {
                name: 'title',
                description: 'Announcement title',
                type: ApplicationCommandOptionType.String,
                required: true
            },
            {
                name: 'content',
                description: 'Announcement body',
                type: ApplicationCommandOptionType.String,
                required: true
            },
            {
                name: 'link',
                description: 'Optional link to include with the announcement',
                type: ApplicationCommandOptionType.String,
                required: false
            }
        ]
    }
];

// Guild-scoped rather than global: guild commands appear instantly and only show up
// in our three servers. Re-registering an identical definition is a no-op on Discord's
// side, so running this on every startup needs no separate deploy step.
async function registerSlashCommands() {
    for (const guildId of [VG_GUILD_ID, VC_GUILD_ID, APP_GUILD_ID]) {
        if (!guildId) continue;

        // Built per guild so /vice-radar doesn't show up in servers without Radar config.
        const commands = radarConfigFor(guildId) ? [...SLASH_COMMANDS, RADAR_COMMAND] : SLASH_COMMANDS;

        try {
            await client.application.commands.set(commands, guildId);
            console.log(`Registered ${commands.length} slash command(s) in ${guildLabel(guildId)}`);
        } catch (error) {
            // A bot invited without the applications.commands scope fails here. The bot
            // keeps running and the !verify / !announce prefix commands still work.
            console.error(`Failed to register slash commands in ${guildLabel(guildId)}:`, error);

            void sendStaffLog(guildId, {
                color: LOG_COLORS.error,
                title: '⚠️ Slash Command Registration Failed',
                description: `Slash commands could not be registered in ${guildLabel(guildId)}.`,
                fields: [errorField(error)],
                footer: 'Check that the bot was invited with the applications.commands scope.'
            });
        }
    }
}

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    try {
        if (interaction.commandName === 'verify') {
            await handleVerifyCommand(interaction);
        } else if (interaction.commandName === 'announce') {
            await handleAnnounceCommand(interaction);
        } else if (interaction.commandName === 'vice-radar') {
            await handleViceRadarCommand(interaction);
        }
    } catch (error) {
        // Safety net for anything the handlers below don't catch themselves, e.g. the
        // interaction expiring before we could respond to it at all.
        console.error(`Error handling /${interaction.commandName}:`, error);
    }
});

// Slash-command form of !verify. Same checks, same order, same downstream calls.
async function handleVerifyCommand(interaction) {
    try {
        const guildId = interaction.guildId;
        const serverConfig = SERVER_CONFIGS[guildId];

        if (!serverConfig) {
            return interaction.reply({ content: '❌ This bot is not configured for this server.', flags: MessageFlags.Ephemeral });
        }

        if (!hasStaffPermission(interaction.member, interaction.user.id, serverConfig)) {
            return interaction.reply({ content: '❌ You don\'t have permission to verify users.', flags: MessageFlags.Ephemeral });
        }

        // Unlike a mention, the user option can resolve someone who isn't in this server.
        const targetUser = interaction.options.getMember('user');
        if (!targetUser) {
            return interaction.reply({ content: '❌ That user is not a member of this server.', flags: MessageFlags.Ephemeral });
        }

        const verifiedRole = interaction.guild.roles.cache.get(serverConfig.verifiedRoleId);
        if (!verifiedRole) {
            return interaction.reply({ content: '❌ Verified role not found. Please check the role ID configuration for this server.', flags: MessageFlags.Ephemeral });
        }

        if (!canManageRole(interaction.guild, serverConfig.verifiedRoleId)) {
            return interaction.reply({ content: '❌ I cannot assign this role. My role must be positioned above the verified role in server settings.', flags: MessageFlags.Ephemeral });
        }

        if (targetUser.roles.cache.has(serverConfig.verifiedRoleId)) {
            return interaction.reply({ content: `❌ ${targetUser.user.tag} is already verified.`, flags: MessageFlags.Ephemeral });
        }

        await targetUser.roles.add(verifiedRole);
        // Public, like the old message.reply, so the rest of staff sees the action.
        await interaction.reply(`✅ ${targetUser.user.tag} has been verified!`);
        console.log(`${interaction.user.tag} verified ${targetUser.user.tag} in ${interaction.guild.name} (${guildId})`);

        await sendStaffLog(guildId, {
            color: LOG_COLORS.verifyManual,
            title: '✅ Manually Verified',
            description: `**${targetUser.user.tag}** (<@${targetUser.id}>) was verified in ${guildLabel(guildId)}.`,
            fields: [
                { name: 'Verified By', value: `**${interaction.user.tag}** (<@${interaction.user.id}>)` }
            ]
        });

        await maybeKickFromApplicationServer(targetUser.user.id, guildId);
        await autoVerifyInOtherServers(targetUser.user.id, guildId);

    } catch (error) {
        console.error('Error during verification:', error);
        await respondWithError(interaction, '❌ An error occurred while verifying the user. Please check bot permissions.');
    }
}

// Slash-command form of !announce. postAnnouncement is untouched and still just
// receives the same three strings.
async function handleAnnounceCommand(interaction) {
    if (interaction.user.id !== process.env.VICER_ADMIN) {
        return interaction.reply({ content: '❌ You do not have permission to post announcements.', flags: MessageFlags.Ephemeral });
    }

    const title = interaction.options.getString('title');
    const content = interaction.options.getString('content');
    const link = interaction.options.getString('link') || null;

    // postAnnouncement calls api.vicers.net, which isn't guaranteed to answer inside
    // Discord's 3 second initial-response window.
    await interaction.deferReply();

    try {
        await postAnnouncement(title, content, link);
        await interaction.editReply('✅ Announcement posted successfully!');
    } catch (error) {
        console.error('Error posting announcement:', error);
        await interaction.editReply(`❌ Failed to post announcement. Error: ${error.message}`);
    }
}

// An interaction may already have been replied to or deferred by the time an error
// lands, and each of those needs a different call. Never throws.
async function respondWithError(interaction, content) {
    const payload = { content, flags: MessageFlags.Ephemeral };

    try {
        if (interaction.deferred || interaction.replied) {
            await interaction.followUp(payload);
        } else {
            await interaction.reply(payload);
        }
    } catch (error) {
        console.error('Failed to send interaction error reply:', error);
    }
}

// Function to auto-verify user in other servers after manual verification
async function autoVerifyInOtherServers(userId, verifiedInGuildId) {
    try {
        for (const [serverId, config] of Object.entries(SERVER_CONFIGS)) {
            if (serverId === verifiedInGuildId) continue;

            const guild = await resolveGuild(serverId);
            if (!guild) continue;

            try {
                const member = await guild.members.fetch(userId);

                if (member && !member.roles.cache.has(config.verifiedRoleId) && canManageRole(guild, config.verifiedRoleId)) {
                    const verifiedRole = guild.roles.cache.get(config.verifiedRoleId);

                    await member.roles.add(verifiedRole);
                    console.log(`Auto-verified ${member.user.tag} in ${guild.name} after manual verification`);

                    await sendStaffLog(serverId, {
                        color: LOG_COLORS.verifyAuto,
                        title: '✅ Auto-Verified',
                        description: `**${member.user.tag}** (<@${member.id}>) was auto-verified in ${guildLabel(serverId)}.`,
                        fields: [
                            { name: 'Source', value: `Manually verified on ${guildLabel(verifiedInGuildId)}.` }
                        ]
                    });

                    await maybeKickFromApplicationServer(userId, serverId);
                }
            } catch (fetchError) {
                // User is not in this guild, continue
            }
        }
    } catch (error) {
        console.error('Error auto-verifying in other servers:', error);
    }
}

// Permission check function
function hasStaffPermission(member, userId, serverConfig) {
    if (serverConfig.staffUserIds.includes(userId)) {
        return true;
    }
    return serverConfig.staffRoleIds.some(roleId => member.roles.cache.has(roleId));
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// Guild lookup that falls back to a fetch when the guild isn't warm in cache.
async function resolveGuild(guildId) {
    if (!guildId) return null;
    return client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Full guild member fetch with a retry. Throws the last error if every attempt fails,
// so callers keep their existing "skip this guild and log it" handling.
async function fetchAllMembers(guild) {
    let lastError;

    for (let attempt = 1; attempt <= MEMBER_FETCH_ATTEMPTS; attempt++) {
        try {
            return await guild.members.fetch();
        } catch (error) {
            lastError = error;
            console.warn(`Member fetch for ${guild.name} failed (attempt ${attempt}/${MEMBER_FETCH_ATTEMPTS}): ${error.message}`);

            if (attempt < MEMBER_FETCH_ATTEMPTS) {
                await sleep(MEMBER_FETCH_RETRY_MS);
            }
        }
    }

    throw lastError;
}

// True when the bot's highest role sits above the target role, i.e. it can grant/revoke it.
function canManageRole(guild, roleId) {
    if (!roleId) return false;

    const role = guild.roles.cache.get(roleId);
    if (!role) {
        console.error(`Role ${roleId} not found in ${guild.name}`);
        return false;
    }

    const botMember = guild.members.me;
    if (!botMember) return false;

    return role.position < botMember.roles.highest.position;
}

// Post an embed to the server's bot log channel, built from
// { color, title, description?, fields?, footer? }.
// Never throws: logging must not break the caller.
async function sendStaffLog(guildId, options) {
    try {
        const channelId = LOG_CHANNELS[guildId];
        if (!channelId) return;

        const guild = await resolveGuild(guildId);
        if (!guild) return;

        const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
        if (!channel || !channel.isTextBased()) {
            console.log(`Log channel not found or not text-based for guild ${guildId}: ${channelId}`);
            return;
        }

        const embed = new EmbedBuilder()
            .setColor(options.color)
            .setTitle(options.title)
            .setTimestamp();

        if (options.description) {
            embed.setDescription(options.description);
        }

        if (options.fields && options.fields.length > 0) {
            embed.addFields(options.fields);
        }

        if (options.footer) {
            embed.setFooter({ text: options.footer });
        }

        await channel.send({ embeds: [embed] });
    } catch (error) {
        console.error('Failed to send staff log message:', error);
    }
}

// For problems that aren't tied to one server. Best effort: sendStaffLog already
// swallows a channel that is missing or unreachable.
async function sendStaffLogToAllServers(options) {
    for (const guildId of [VG_GUILD_ID, VC_GUILD_ID, APP_GUILD_ID]) {
        await sendStaffLog(guildId, options);
    }
}

// Discord rejects empty embed field values, and truncates anything past 1024 chars.
function errorField(error) {
    const text = String(error && error.message ? error.message : error) || 'Unknown error';
    return { name: 'Error', value: text.slice(0, 1000) };
}

function isMainServer(guildId) {
    return guildId === VG_GUILD_ID || guildId === VC_GUILD_ID;
}

function otherMainServerId(guildId) {
    return guildId === VG_GUILD_ID ? VC_GUILD_ID : VG_GUILD_ID;
}

function guildLabel(guildId) {
    if (guildId === VG_GUILD_ID) return 'Vice Gamers';
    if (guildId === VC_GUILD_ID) return 'Vice Creators';
    if (guildId === APP_GUILD_ID) return 'the Application Server';
    return guildId;
}

// Warn once at startup about config the new features depend on, so a missing
// .env entry shows up in the PM2 log instead of silently disabling a feature.
function warnAboutMissingConfig() {
    for (const guildId of [VG_GUILD_ID, VC_GUILD_ID, APP_GUILD_ID]) {
        if (!LOG_CHANNELS[guildId]) {
            console.warn(`No bot log channel configured for ${guildLabel(guildId)} - staff logs will be skipped.`);
        }
    }

    for (const guildId of [VG_GUILD_ID, VC_GUILD_ID]) {
        const tiers = SERVER_CONFIGS[guildId]?.tierRoleIds || {};
        const missing = TIER_ORDER.filter(tierName => !tiers[tierName]);
        if (missing.length > 0) {
            console.warn(`Missing tier role IDs for ${guildLabel(guildId)}: ${missing.join(', ')} - those tiers will not sync.`);
        }
    }

    for (const guildId of [VG_GUILD_ID, VC_GUILD_ID]) {
        const radar = SERVER_CONFIGS[guildId]?.radar || {};
        if (!radar.roleId && !radar.channelId) continue; // Radar deliberately off here
        if (!radar.roleId || !radar.channelId) {
            console.warn(`Vice Radar is half-configured for ${guildLabel(guildId)} - both the role and the channel are required, so Radar is disabled there.`);
        }
    }

    const appConfig = SERVER_CONFIGS[APP_GUILD_ID] || {};

    if (!appConfig.pendingRoleId) {
        console.warn('No APP_PENDING_ROLE configured - applicants under review cannot be told apart from people who never applied, so apply reminders and their kicks are disabled.');
    }

    if (!appConfig.deniedRoleId) {
        console.warn('No APP_DENIED_ROLE configured - denied applicants will not be removed, and apply reminders are disabled.');
    }

    if (!APP_CHAT_CHANNEL_ID) {
        console.warn('No APP_CHAT configured - application reminders will be skipped, so nobody will be removed for not applying or not joining.');
    }

    if (!APP_SUBMIT_CHANNEL_ID) {
        console.warn('No APP_SUBMIT_CHANNEL configured - the apply reminder will say #submit-your-application as plain text instead of linking the channel.');
    }
}

// ---------------------------------------------------------------------------
// Feature A: leave the Application Server once access is confirmed elsewhere
// ---------------------------------------------------------------------------

async function maybeKickFromApplicationServer(userId, guildIdJustVerifiedIn) {
    try {
        // Only relevant once someone has been verified in a MAIN server.
        if (!isMainServer(guildIdJustVerifiedIn)) return;

        const appConfig = SERVER_CONFIGS[APP_GUILD_ID];
        if (!appConfig || !appConfig.verifiedRoleId) return;

        const appGuild = await resolveGuild(APP_GUILD_ID);
        if (!appGuild) return;

        const appMember = await appGuild.members.fetch(userId).catch(() => null);
        if (!appMember) return; // already gone, or never joined - nothing to do

        // Not accepted on the Application Server, so this isn't a completed application cycle.
        if (!appMember.roles.cache.has(appConfig.verifiedRoleId)) return;

        // Never kick staff or the owner: they hold the verified role for their own access.
        if (appMember.id === appGuild.ownerId) return;
        if (hasStaffPermission(appMember, appMember.id, appConfig)) return;

        if (!appMember.kickable) {
            console.error(`Cannot kick ${appMember.user.tag} from the Application Server - missing permission or role hierarchy issue`);

            await sendStaffLog(APP_GUILD_ID, {
                color: LOG_COLORS.error,
                title: '⚠️ Auto-Kick Failed',
                description: `**${appMember.user.tag}** (<@${appMember.id}>) could not be removed from the Application Server after being verified on ${guildLabel(guildIdJustVerifiedIn)}.`,
                fields: [
                    { name: 'Reason', value: 'Missing the Kick Members permission, or the bot\'s highest role sits below theirs.' }
                ],
                footer: 'Remove this member manually once the permission or role position is fixed.'
            });
            return;
        }

        await appMember.kick('Verified in a main Vice Community server - application cycle complete');
        console.log(`Kicked ${appMember.user.tag} from Application Server after verification in ${guildLabel(guildIdJustVerifiedIn)}`);

        await sendStaffLog(APP_GUILD_ID, {
            color: LOG_COLORS.kick,
            title: '👢 Auto-Kicked from Application Server',
            description: `**${appMember.user.tag}** (<@${appMember.id}>) was removed from the Application Server.`,
            fields: [
                { name: 'Reason', value: `Verified on ${guildLabel(guildIdJustVerifiedIn)} - application cycle complete.` }
            ]
        });
    } catch (error) {
        console.error(`Could not kick ${userId} from Application Server:`, error);

        await sendStaffLog(APP_GUILD_ID, {
            color: LOG_COLORS.error,
            title: '⚠️ Auto-Kick Error',
            description: `An error occurred while removing <@${userId}> from the Application Server after they were verified on ${guildLabel(guildIdJustVerifiedIn)}.`,
            fields: [errorField(error)],
            footer: 'Check whether this member is still on the Application Server.'
        });
    }
}

// ---------------------------------------------------------------------------
// Feature B: cross-server subscription tier sync
// ---------------------------------------------------------------------------

// Highest tier the member currently holds in this guild, or null.
function getMemberTier(member, tierRoleIds) {
    if (!tierRoleIds) return null;

    let found = null;
    for (const tierName of TIER_ORDER) {
        const roleId = tierRoleIds[tierName];
        if (roleId && member.roles.cache.has(roleId)) {
            found = tierName;
        }
    }
    return found;
}

// Make the member's tier roles in this guild match `desiredTier` (null clears them).
// Returns true only if something actually changed, so callers can skip noisy logs.
async function applyTier(member, tierRoleIds, desiredTier) {
    if (!tierRoleIds) return false;

    const guild = member.guild;
    const toRemove = [];
    let toAdd = null;

    for (const tierName of TIER_ORDER) {
        const roleId = tierRoleIds[tierName];
        if (!roleId) continue;

        const has = member.roles.cache.has(roleId);
        if (tierName === desiredTier) {
            if (!has) toAdd = roleId;
        } else if (has) {
            toRemove.push(roleId);
        }
    }

    if (!toAdd && toRemove.length === 0) return false;

    let changed = false;

    // Remove first so an upgrade never leaves two tier roles on the member.
    if (toRemove.length > 0) {
        const removable = toRemove.filter(roleId => canManageRole(guild, roleId));

        if (removable.length !== toRemove.length) {
            console.error(`Cannot remove some tier roles from ${member.user.tag} in ${guild.name} - role hierarchy issue`);

            await sendStaffLog(guild.id, {
                color: LOG_COLORS.error,
                title: '⚠️ Tier Role Removal Blocked',
                description: `Some tier roles could not be removed from **${member.user.tag}** (<@${member.id}>) in ${guildLabel(guild.id)}, so their tiers are out of sync.`,
                fields: [
                    { name: 'Reason', value: 'The bot\'s highest role sits below one or more tier roles.' }
                ],
                footer: 'Move the bot\'s role above the tier roles in server settings.'
            });
        }

        if (removable.length > 0) {
            try {
                await member.roles.remove(removable, 'Cross-server tier sync');
                changed = true;
            } catch (error) {
                console.error(`Failed to remove tier roles from ${member.user.tag} in ${guild.name}:`, error);

                await sendStaffLog(guild.id, {
                    color: LOG_COLORS.error,
                    title: '⚠️ Tier Role Removal Failed',
                    description: `Could not remove tier roles from **${member.user.tag}** (<@${member.id}>) in ${guildLabel(guild.id)}, so their tiers are out of sync.`,
                    fields: [errorField(error)],
                    footer: 'The hourly reconciliation pass will retry.'
                });
            }
        }
    }

    if (toAdd) {
        if (!canManageRole(guild, toAdd)) {
            console.error(`Cannot assign tier role to ${member.user.tag} in ${guild.name} - role hierarchy issue`);

            await sendStaffLog(guild.id, {
                color: LOG_COLORS.error,
                title: '⚠️ Tier Role Grant Blocked',
                description: `Could not grant **${tierLabel(desiredTier)}** to **${member.user.tag}** (<@${member.id}>) in ${guildLabel(guild.id)}.`,
                fields: [
                    { name: 'Reason', value: 'The bot\'s highest role sits below that tier role.' }
                ],
                footer: 'Move the bot\'s role above the tier roles in server settings.'
            });
        } else {
            try {
                await member.roles.add(toAdd, 'Cross-server tier sync');
                changed = true;
            } catch (error) {
                console.error(`Failed to add tier role to ${member.user.tag} in ${guild.name}:`, error);

                await sendStaffLog(guild.id, {
                    color: LOG_COLORS.error,
                    title: '⚠️ Tier Role Grant Failed',
                    description: `Could not grant **${tierLabel(desiredTier)}** to **${member.user.tag}** (<@${member.id}>) in ${guildLabel(guild.id)}.`,
                    fields: [errorField(error)],
                    footer: 'The hourly reconciliation pass will retry.'
                });
            }
        }
    }

    return changed;
}

// Mirror a tier change on one main server onto the other.
client.on('guildMemberUpdate', async (oldMember, newMember) => {
    try {
        const guildId = newMember.guild.id;
        if (!isMainServer(guildId)) return;

        const myTiers = SERVER_CONFIGS[guildId]?.tierRoleIds;
        if (!myTiers) return;

        // A partial oldMember can't be diffed; fall through and let applyTier no-op if already in sync.
        const oldTier = oldMember.partial ? undefined : getMemberTier(oldMember, myTiers);
        const newTier = getMemberTier(newMember, myTiers);
        if (oldTier === newTier) return; // this update didn't touch tier roles

        const otherGuildId = otherMainServerId(guildId);
        const otherGuild = await resolveGuild(otherGuildId);
        if (!otherGuild) return;

        const otherMember = await otherGuild.members.fetch(newMember.id).catch(() => null);
        if (!otherMember) return; // not in the other server; the join handler will catch them later

        const changed = await applyTier(otherMember, SERVER_CONFIGS[otherGuildId].tierRoleIds, newTier);
        if (!changed) return;

        if (newTier) {
            console.log(`Synced tier ${newTier} to ${otherMember.user.tag} in ${otherGuild.name}`);

            await sendStaffLog(otherGuildId, {
                color: LOG_COLORS.tierGrant,
                title: '💎 Subscription Synced',
                description: `**${otherMember.user.tag}** (<@${otherMember.id}>) was granted **${tierLabel(newTier)}** in ${guildLabel(otherGuildId)}.`,
                fields: [
                    { name: 'Source', value: `Tier granted on ${guildLabel(guildId)}.` }
                ]
            });
        } else {
            console.log(`Removed tier roles from ${otherMember.user.tag} in ${otherGuild.name}`);

            await sendStaffLog(otherGuildId, {
                color: LOG_COLORS.tierRemove,
                title: '💔 Subscription Removed',
                description: `Tier roles were removed from **${otherMember.user.tag}** (<@${otherMember.id}>) in ${guildLabel(otherGuildId)}.`,
                fields: [
                    { name: 'Source', value: `Subscription ended on ${guildLabel(guildId)}.` }
                ]
            });
        }
    } catch (error) {
        console.error('Error in guildMemberUpdate event:', error);
    }
});

// Grant the tier someone already holds on the other main server when they join this one.
async function syncTierRolesOnJoin(member) {
    try {
        const guildId = member.guild.id;
        if (!isMainServer(guildId)) return;

        const otherGuildId = otherMainServerId(guildId);
        const otherGuild = await resolveGuild(otherGuildId);
        if (!otherGuild) return;

        const otherMember = await otherGuild.members.fetch(member.id).catch(() => null);
        if (!otherMember) return;

        const tier = getMemberTier(otherMember, SERVER_CONFIGS[otherGuildId]?.tierRoleIds);
        if (!tier) return;

        const changed = await applyTier(member, SERVER_CONFIGS[guildId].tierRoleIds, tier);
        if (!changed) return;

        console.log(`Granted tier ${tier} to ${member.user.tag} on join to ${member.guild.name}`);

        await sendStaffLog(guildId, {
            color: LOG_COLORS.tierGrant,
            title: '💎 Subscription Carried Over',
            description: `**${member.user.tag}** (<@${member.id}>) was granted **${tierLabel(tier)}** in ${guildLabel(guildId)} on join.`,
            fields: [
                { name: 'Source', value: `Already held on ${guildLabel(otherGuildId)}.` }
            ]
        });
    } catch (error) {
        console.error('Error syncing tier roles on join:', error);
    }
}

// ---------------------------------------------------------------------------
// Feature C: hourly reconciliation
// ---------------------------------------------------------------------------

async function runReconciliation() {
    if (reconciliationRunning) {
        console.log('Reconciliation already running, skipping this pass.');
        return;
    }

    reconciliationRunning = true;

    try {
        // One full member fetch per guild, shared by both passes, instead of a
        // per-member fetch for every candidate.
        const guildMembers = new Map();

        for (const serverId of Object.keys(SERVER_CONFIGS)) {
            const guild = await resolveGuild(serverId);
            if (!guild) {
                console.log(`Guild ${serverId} not available for reconciliation`);
                continue;
            }

            let members = null;

            try {
                members = await fetchAllMembers(guild);
            } catch (error) {
                console.error(`Failed to fetch members for ${guild.name}:`, error);

                await sendStaffLog(serverId, {
                    color: LOG_COLORS.error,
                    title: '⚠️ Reconciliation Skipped',
                    description: `Could not fetch the member list for ${guildLabel(serverId)}, so this reconciliation pass skipped that server.`,
                    fields: [errorField(error)],
                    footer: 'The next pass retries in an hour.'
                });
            }

            if (members) {
                guildMembers.set(serverId, { guild, members });
            }
        }

        await reconcileMissingRoles(guildMembers);
        await reconcileTierRoles(guildMembers);
        await reconcileStaleApplicationServerMembers(guildMembers);
    } catch (error) {
        console.error('Error during reconciliation sweep:', error);

        await sendStaffLogToAllServers({
            color: LOG_COLORS.error,
            title: '⚠️ Reconciliation Sweep Failed',
            description: 'The reconciliation sweep stopped early, so some corrections may have been missed across the servers.',
            fields: [errorField(error)],
            footer: 'The next pass retries in an hour.'
        });
    } finally {
        reconciliationRunning = false;
    }
}

// Anyone accepted elsewhere but sitting without the verified role here - the
// same set as "stuck in the waiting room", since that channel is only visible
// to members lacking the verified role (see WAITING_ROOM_CHANNELS).
async function reconcileMissingRoles(guildMembers) {
    for (const guildId of [VG_GUILD_ID, VC_GUILD_ID]) {
        const entry = guildMembers.get(guildId);
        if (!entry) continue;

        const { guild, members } = entry;
        const config = SERVER_CONFIGS[guildId];

        const verifiedRole = guild.roles.cache.get(config.verifiedRoleId);
        if (!verifiedRole) {
            console.error(`Verified role not found for server ${guildId}, skipping reconciliation`);

            await sendStaffLog(guildId, {
                color: LOG_COLORS.error,
                title: '⚠️ Reconciliation Skipped',
                description: `The verified role configured for ${guildLabel(guildId)} no longer exists, so missing-role reconciliation was skipped.`,
                footer: 'Check the verified role ID in the bot config.'
            });
            continue;
        }

        if (!canManageRole(guild, config.verifiedRoleId)) {
            console.error(`Cannot assign the verified role in ${guild.name} - role hierarchy issue`);

            await sendStaffLog(guildId, {
                color: LOG_COLORS.error,
                title: '⚠️ Reconciliation Skipped',
                description: `The bot cannot assign the verified role in ${guildLabel(guildId)}, so missing-role reconciliation was skipped.`,
                fields: [
                    { name: 'Reason', value: 'The bot\'s highest role sits below the verified role.' }
                ],
                footer: 'Move the bot\'s role above the verified role in server settings.'
            });
            continue;
        }

        for (const member of members.values()) {
            if (member.user.bot) continue;
            if (member.id === guild.ownerId) continue;
            // Staff intentionally lack the verified role; skipping them keeps the log quiet.
            if (hasStaffPermission(member, member.id, config)) continue;
            if (member.roles.cache.has(config.verifiedRoleId)) continue;

            if (!isVerifiedElsewhere(member.id, guildId, guildMembers)) continue;

            try {
                await member.roles.add(verifiedRole, 'Reconciliation: verified in another Vice Community server');
            } catch (error) {
                console.error(`Reconciliation grant failed for ${member.user.tag}:`, error);

                await sendStaffLog(guildId, {
                    color: LOG_COLORS.error,
                    title: '⚠️ Reconciliation Grant Failed',
                    description: `**${member.user.tag}** (<@${member.id}>) is verified elsewhere but the verified role could not be granted to them in ${guildLabel(guildId)}.`,
                    fields: [errorField(error)],
                    footer: 'The next pass retries in an hour.'
                });
                continue;
            }

            console.log(`Reconciliation: corrected missing role for ${member.user.tag} in ${guild.name}`);

            await sendStaffLog(guildId, {
                color: LOG_COLORS.reconciliation,
                title: '🔄 Reconciliation: Verified Role Corrected',
                description: `**${member.user.tag}** (<@${member.id}>) was missing the verified role in ${guildLabel(guildId)} and has now been granted it.`,
                fields: [
                    { name: 'Reason', value: 'Already verified in another Vice Community server.' }
                ]
            });

            // Catches Feature A cases the live handlers missed.
            await maybeKickFromApplicationServer(member.id, guildId);
        }
    }
}

// In-memory equivalent of checkAutoVerificationSource, using the member lists
// already fetched for this sweep.
function isVerifiedElsewhere(userId, currentGuildId, guildMembers) {
    for (const [serverId, entry] of guildMembers.entries()) {
        if (serverId === currentGuildId) continue;

        const member = entry.members.get(userId);
        if (member && member.roles.cache.has(SERVER_CONFIGS[serverId].verifiedRoleId)) {
            return true;
        }
    }
    return false;
}

async function reconcileTierRoles(guildMembers) {
    const vgEntry = guildMembers.get(VG_GUILD_ID);
    const vcEntry = guildMembers.get(VC_GUILD_ID);
    if (!vgEntry || !vcEntry) return;

    const vgTiers = SERVER_CONFIGS[VG_GUILD_ID].tierRoleIds;
    const vcTiers = SERVER_CONFIGS[VC_GUILD_ID].tierRoleIds;

    for (const vgMember of vgEntry.members.values()) {
        if (vgMember.user.bot) continue;

        const vcMember = vcEntry.members.get(vgMember.id);
        if (!vcMember) continue; // not in both servers, nothing to reconcile

        const vgTier = getMemberTier(vgMember, vgTiers);
        const vcTier = getMemberTier(vcMember, vcTiers);

        if (vgTier === vcTier) continue; // in sync, including the no-subscription case

        if (vgTier && !vcTier) {
            if (await applyTier(vcMember, vcTiers, vgTier)) {
                console.log(`Reconciliation: synced tier ${vgTier} to ${vcMember.user.tag} in Vice Creators`);

                await sendStaffLog(VC_GUILD_ID, {
                    color: LOG_COLORS.reconciliation,
                    title: '🔄 Reconciliation: Subscription Synced',
                    description: `**${vcMember.user.tag}** (<@${vcMember.id}>) was granted **${tierLabel(vgTier)}** in Vice Creators.`,
                    fields: [
                        { name: 'Source', value: 'Already held on Vice Gamers.' }
                    ]
                });
            }
        } else if (vcTier && !vgTier) {
            if (await applyTier(vgMember, vgTiers, vcTier)) {
                console.log(`Reconciliation: synced tier ${vcTier} to ${vgMember.user.tag} in Vice Gamers`);

                await sendStaffLog(VG_GUILD_ID, {
                    color: LOG_COLORS.reconciliation,
                    title: '🔄 Reconciliation: Subscription Synced',
                    description: `**${vgMember.user.tag}** (<@${vgMember.id}>) was granted **${tierLabel(vcTier)}** in Vice Gamers.`,
                    fields: [
                        { name: 'Source', value: 'Already held on Vice Creators.' }
                    ]
                });
            }
        } else {
            // Both sides have a tier and they disagree. Never auto-corrected:
            // guessing either upgrades someone for free or downgrades a paying member.
            const mismatchLog = {
                color: LOG_COLORS.mismatch,
                title: '⚠️ Subscription Mismatch',
                description: `**${vgMember.user.tag}** (<@${vgMember.id}>) holds a different tier on each main server. Nothing was changed - this needs manual review.`,
                fields: [
                    { name: 'Vice Gamers', value: tierLabel(vgTier), inline: true },
                    { name: 'Vice Creators', value: tierLabel(vcTier), inline: true }
                ],
                footer: 'Auto-correcting would either upgrade someone for free or downgrade a paying member.'
            };

            console.warn(`Tier mismatch for ${vgMember.user.tag}: ${vgTier} (VG) vs ${vcTier} (VC)`);
            await sendStaffLog(VG_GUILD_ID, mismatchLog);
            await sendStaffLog(VC_GUILD_ID, mismatchLog);
        }
    }
}

// Anyone still sitting in the Application Server, holding the Accepted role,
// who is ALREADY verified in Vice Gamers or Vice Creators. reconcileMissingRoles
// doesn't catch this case: it only grants roles that are missing, so it has no
// reason to look at someone who's already fully verified elsewhere. This is
// the only thing that catches it after the fact if the live kick in
// maybeKickFromApplicationServer ever fails, gets skipped, or never had a
// reason to fire in the first place.
async function reconcileStaleApplicationServerMembers(guildMembers) {
    const appConfig = SERVER_CONFIGS[APP_GUILD_ID];
    const appEntry = guildMembers.get(APP_GUILD_ID);
    if (!appConfig || !appConfig.verifiedRoleId || !appEntry) return;

    for (const appMember of appEntry.members.values()) {
        if (appMember.user.bot) continue;
        if (appMember.id === appEntry.guild.ownerId) continue;
        if (hasStaffPermission(appMember, appMember.id, appConfig)) continue;
        if (!appMember.roles.cache.has(appConfig.verifiedRoleId)) continue;

        for (const mainGuildId of [VG_GUILD_ID, VC_GUILD_ID]) {
            const mainEntry = guildMembers.get(mainGuildId);
            if (!mainEntry) continue;

            const mainMember = mainEntry.members.get(appMember.id);
            if (mainMember && mainMember.roles.cache.has(SERVER_CONFIGS[mainGuildId].verifiedRoleId)) {
                console.log(`Reconciliation: found stale Application Server membership for ${appMember.user.tag}, already verified on ${guildLabel(mainGuildId)}`);
                await maybeKickFromApplicationServer(appMember.id, mainGuildId);
                break;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Feature D: Application Server lifecycle sweep
// ---------------------------------------------------------------------------

// Appy DMs an accepted applicant their invite link, so this bot never needs to know
// which main server someone applied to - only whether they have joined either one.

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

// ---------------------------------------------------------------------------
// Feature E: Vice Radar (presence-based squad matching)
// ---------------------------------------------------------------------------

// Concurrent opted-in players before a game counts as a squad worth announcing.
const RADAR_MIN_SQUAD = 2;

// Absorbs a brief presence drop (a loading screen, a match transition, a game's Rich
// Presence hiccup) without treating it as the session actually ending. Tune down if
// resets feel sluggish, up if flicker still gets through.
const RADAR_RESET_GRACE_MS = 5 * 60 * 1000;

// Seeded onto every radar post by the bot; reacting with it grants the opt-in role.
const RADAR_EMOJI = '🔔';

const RADAR_CTA = 'React 🔔 to get pinged anytime someone\'s playing whatever you\'re playing.';

// Rotated per post so consecutive embeds don't look identical. Deliberately separate
// from LOG_COLORS: those carry staff-log meaning, these are just brand colors.
const RADAR_COLORS = [0xFFB570, 0x2ED9C3, 0xE0A9E8];
let radarColorIndex = 0;

// Hype lines for the public post. {count} and {game} are filled in at send time.
// Pure copy: edit, reorder or replace freely without touching any logic below.
const RADAR_PHRASES = [
    '{count} Vicers are running {game} right now. Squad up. 🌴',
    '{count} Vicers deep in {game}. Room for one more?',
    '{count} of you are on {game} at the same time. That\'s a squad, not a coincidence.',
    '{count} Vicers just showed up in {game}. Go say hi.',
    '{count} playing {game}. The lobby is right there.',
    '{count} Vicers currently locked into {game}.',
    'Headcount: {count} Vicers in {game}.',
    '{count} Vicers, one game, zero excuses. {game} is live.',
    '{count} of the crew are in {game} as we speak.',
    '{count} Vicers on {game}. Somebody start the party.',
    '{count} Vicers spotted in {game}. Radar doesn\'t lie.',
    'That\'s {count} Vicers in {game}. Your move.',
    '{count} Vicers are already in {game}. Don\'t make them wait.',
    '{count} on {game} right now — the squad is forming without you.',
    '{count} Vicers in {game}. Grab a controller.',
    'We\'ve got {count} Vicers in {game} this minute.',
    '{count} Vicers queued into {game}. Join the stack.',
    '{count} Vicers just lit up {game}.',
    '{count} Vicers are live on {game}. Slide in.',
    '{count} in {game}. That number goes up if you move fast.',
    '{count} Vicers picked {game} tonight. Good taste.',
    '{count} Vicers are mid-session on {game}.',
    '{count} Vicers are grinding {game}. Bring snacks.',
    '{count} Vicers in {game} — that\'s a full crew forming.',
    'Count it: {count} Vicers, all in {game}.',
    '{game} is popping off — {count} Vicers in there now.',
    'The {game} lobby is filling up. {count} Vicers deep already.',
    '{game} just hit {count} Vicers. The night is young.',
    '{game} is the pick tonight. {count} Vicers agree.',
    '{game} servers are getting a Vice takeover: {count} and counting.',
    '{game} is live in the community right now — {count} Vicers on it.',
    '{game} has {count} Vicers in it. Make it one more.',
    'Something\'s happening in {game}. {count} Vicers, same time.',
    '{game} is calling. {count} Vicers already picked up.',
    '{game} session in progress — {count} Vicers strong.',
    '{game} is where the crew is. {count} of them, right now.',
    '{game} just became the main event. {count} Vicers in.',
    '{game}: {count} Vicers, live, this second.',
    '{game} is running hot with {count} Vicers on deck.',
    '{game} got the Vicer stamp of approval — {count} playing now.',
    '{game} is officially a whole thing tonight. {count} in.',
    'Everybody\'s on {game}. Well, {count} of us are.',
    '{game} is where it\'s at — {count} Vicers can\'t be wrong.',
    '{game} lobby check: {count} Vicers present.',
    '{game} has the crew\'s attention. {count} Vicers deep.',
    '{game} is trending in Vice right now. {count} playing.',
    'Word is {game} is the move. {count} Vicers already on it.',
    '{game} is live and {count} Vicers are on the ride.',
    '{game} has {count} Vicers in the mix already.',
    '{game} just pulled {count} Vicers in at once.',
    'Neon\'s on. {count} Vicers in {game}.',
    'Radar ping 🔔 — {game}, {count} Vicers active.',
    'The strip is glowing: {count} Vicers on {game}.',
    'Palms up 🌴 {count} Vicers are in {game}.',
    'Sunset, neon, and {count} Vicers playing {game}.',
    'Vice Radar picked up {count} signals in {game}.',
    'Signal detected: {count} Vicers, {game}, right now.',
    'The radar lit up for {game} — {count} Vicers on screen.',
    'Cruising into {game} with {count} Vicers aboard.',
    'Neon lights, {count} Vicers, one {game} lobby.',
    'Miami nights energy: {count} Vicers in {game}.',
    'The Vice Radar is blinking. {count} Vicers in {game}.',
    '{count} blips on the radar, all in {game}.',
    'Tuned in: {count} Vicers on the {game} frequency.',
    'Radar sweep complete — {count} Vicers found in {game}.',
    'Pink skies and {count} Vicers in {game}.',
    'The night crew is up: {count} Vicers on {game}.',
    'Synthwave on, {game} on, {count} Vicers on.',
    'Somewhere between the palms and the neon, {count} Vicers are playing {game}.',
    'Radar\'s hot 🔥 {count} Vicers in {game}.',
    'Full beams on {game} — {count} Vicers rolling.',
    '{count} Vicers are cruising through {game} right now.',
    'Chrome, neon, and {count} Vicers in {game}.',
    'The Vice skyline is lit and {count} Vicers are in {game}.',
    'Radar contact: {count} Vicers, {game}, no drill.',
    'Don\'t play alone — {count} Vicers are already in {game}.',
    'Solo queue is a choice. {count} Vicers are in {game}.',
    'Your squad assembled itself. {count} Vicers, {game}, go.',
    'You could be the next one in {game}. {count} Vicers are already there.',
    'Hop in: {count} Vicers are waiting in {game}.',
    '{count} Vicers in {game}. Yes, they\'d let you join.',
    'Stop scrolling. {count} Vicers are in {game}.',
    'The hard part\'s done — {count} Vicers already found each other in {game}.',
    'Fastest way to not play alone: {game}, {count} Vicers, right now.',
    'Boot it up. {count} Vicers are in {game}.',
    '{count} Vicers in {game} and the party\'s still open.',
    'This is your sign to load up {game}. {count} Vicers are in.',
    '{count} Vicers in {game}. The lobby has your name on it.',
    'Someone say squad? {count} Vicers in {game}.',
    '{count} Vicers went and started {game} without telling you. Rude.',
    'Consider yourself invited: {game}, {count} Vicers in.',
    'Free real estate in the {game} lobby — {count} Vicers already there.',
    'No plans? {count} Vicers are in {game}.',
    '{count} Vicers in {game}. Go be the reason it gets loud.',
    'The {game} crew is {count} strong and growing.',
    'Make it a party: {count} Vicers already on {game}.',
    '{count} Vicers are in {game}. Odds are they need a fourth.',
    'You\'ve got {count} reasons to open {game} right now.',
    '{game} squad forming — {count} Vicers locked in.',
    '{count} Vicers in {game}. Go win something. 🏆',
];

const RADAR_COMMAND = {
    name: 'vice-radar',
    description: 'Get notified when others are playing the same game as you',
    options: [
        {
            name: 'action',
            description: 'Turn Vice Radar on or off',
            type: ApplicationCommandOptionType.String,
            required: true,
            choices: [
                { name: 'Join', value: 'join' },
                { name: 'Leave', value: 'leave' }
            ]
        }
    ]
};

// guildId -> Map<gameName, { activeMembers: Set<userId>, peak: number, dmSent: boolean }>
// In-memory only, by design: presence rebuilds itself within seconds of a restart, so
// unlike the application sweep's multi-hour countdowns there's nothing worth persisting.
const radarState = new Map();

// Message IDs of radar posts sent since the last restart, so a stray reaction on an
// unrelated message can never grant the role.
const radarPostIds = new Set();

// Radar is on for a server only when both its role and its channel are configured.
function radarConfigFor(guildId) {
    const radar = SERVER_CONFIGS[guildId]?.radar;
    if (!radar || !radar.roleId || !radar.channelId) return null;
    return radar;
}

function radarGamesFor(guildId) {
    let games = radarState.get(guildId);
    if (!games) {
        games = new Map();
        radarState.set(guildId, games);
    }
    return games;
}

// Every game the member is showing as Playing. Streaming, Listening, Watching and
// Custom statuses deliberately don't count. Empty when they're offline or idle.
function playingGameNames(presence) {
    if (!presence) return new Set();

    return new Set(
        presence.activities
            .filter(activity => activity.type === ActivityType.Playing && activity.name)
            .map(activity => activity.name)
    );
}

// Game names come straight from Discord, so a name containing $& or $' would be read
// as a replacement pattern by a plain string replace. The function form can't be.
function pickPhrase(count, gameName) {
    const phrase = RADAR_PHRASES[Math.floor(Math.random() * RADAR_PHRASES.length)];

    return phrase
        .replace(/\{count\}/g, () => String(count))
        .replace(/\{game\}/g, () => gameName);
}

client.on('presenceUpdate', (oldPresence, newPresence) => {
    void handlePresenceUpdate(newPresence);
});

async function handlePresenceUpdate(newPresence) {
    try {
        const guildId = newPresence?.guild?.id;
        if (!guildId) return;

        const radar = radarConfigFor(guildId);
        if (!radar) return;

        const member = newPresence.member;
        if (!member || member.user.bot) return;

        // Vice Radar tracks and publicly calls out everyone with visible activity status,
        // opted in or not. The role only controls whether they personally get DM'd about a
        // match, not whether they're counted, so intentionally no opt-in check here.
        const games = playingGameNames(newPresence);

        await applyRadarPresence(guildId, member, games);
    } catch (error) {
        console.error('Error in presenceUpdate event:', error);
    }
}

// Reconciles one member's tracked games against what they're actually playing, then
// re-evaluates every game the change touched.
//
// oldPresence is deliberately ignored rather than diffed: it's null whenever the member
// wasn't already in the presence cache, which is exactly the case on the first event
// after a restart, so diffing against it would silently miss that first game start.
async function applyRadarPresence(guildId, member, currentGames) {
    const games = radarGamesFor(guildId);
    const touched = new Set();

    // Drop them from anything they're no longer playing.
    for (const [gameName, entry] of games.entries()) {
        if (currentGames.has(gameName)) continue;
        if (entry.activeMembers.delete(member.id)) touched.add(gameName);
    }

    // Add them to anything new.
    for (const gameName of currentGames) {
        let entry = games.get(gameName);

        if (!entry) {
            entry = { activeMembers: new Set(), peak: 0, dmSent: false, resetTimer: null };
            games.set(gameName, entry);
        }

        if (!entry.activeMembers.has(member.id)) {
            entry.activeMembers.add(member.id);
            touched.add(gameName);
        }
    }

    for (const gameName of touched) {
        await evaluateRadarGame(guildId, gameName);
    }
}

// Decides whether a game's current headcount is worth announcing. Runs after every
// change to that game's roster.
async function evaluateRadarGame(guildId, gameName) {
    const games = radarGamesFor(guildId);
    const entry = games.get(gameName);
    if (!entry) return;

    const count = entry.activeMembers.size;

    if (count < RADAR_MIN_SQUAD) {
        // Don't reset the instant the count dips. A member's activity can blink off for a
        // few seconds and come right back, and resetting on that made the same two people
        // re-announce as a brand new match. Schedule the reset instead, so a quick
        // recovery (below, in the at-or-above-threshold path) can cancel it.
        if (!entry.resetTimer) {
            entry.resetTimer = setTimeout(() => {
                const currentGames = radarGamesFor(guildId);
                const currentEntry = currentGames.get(gameName);
                if (!currentEntry) return;

                currentEntry.resetTimer = null;

                if (currentEntry.activeMembers.size === 0) {
                    // Nobody playing it at all: drop the entry so the map doesn't collect
                    // dead games.
                    currentGames.delete(gameName);
                } else if (currentEntry.activeMembers.size < RADAR_MIN_SQUAD) {
                    // Still short of a squad after the full grace period, so the session
                    // really did end. Keep the roster - the next person to start this game
                    // has to be able to see who's already on it - but forget the streak, so
                    // a rise back to 2+ counts as brand new.
                    currentEntry.peak = 0;
                    currentEntry.dmSent = false;
                }
                // else: recovered to threshold while this timer was pending. The recovering
                // presenceUpdate already cancelled it, so this shouldn't normally be
                // reached, but it's a safe no-op if the timing overlaps.
            }, RADAR_RESET_GRACE_MS);
        }

        return;
    }

    // Back at or above threshold: cancel any pending reset from a brief dip.
    if (entry.resetTimer) {
        clearTimeout(entry.resetTimer);
        entry.resetTimer = null;
    }

    const memberIds = [...entry.activeMembers];

    if (!entry.dmSent) {
        // Set both before awaiting: presence events keep arriving while the DMs go out,
        // and a re-entrant call here would otherwise DM the same squad twice.
        entry.dmSent = true;
        entry.peak = count;

        await dmRadarSquad(guildId, gameName, memberIds, count);
        await postRadarEmbed(guildId, gameName, count);
        return;
    }

    // Already announced this streak, so only a new high-water mark earns another post,
    // and never another round of DMs.
    if (count > entry.peak) {
        entry.peak = count;
        await postRadarEmbed(guildId, gameName, count);
    }
}

// One DM per opted-in member, once per streak. The public callout goes out for everyone
// who was counted; only the DM is gated on the Radar role, and it's filtered here at send
// time rather than upstream so non-opted-in players still count toward the match.
async function dmRadarSquad(guildId, gameName, memberIds, totalCount) {
    const radar = radarConfigFor(guildId);
    if (!radar) return;

    const guild = await resolveGuild(guildId);
    if (!guild) return;

    for (const userId of memberIds) {
        const member = await guild.members.fetch(userId).catch(() => null);
        if (!member) continue;
        if (!member.roles.cache.has(radar.roleId)) continue;

        // The full match size, not the opted-in subset, so "3 other Vicers are playing"
        // stays true even when only one of them is opted in to hear about it.
        const others = totalCount - 1;
        const othersText = others === 1 ? 'Another Vicer is' : `${others} other Vicers are`;

        try {
            await member.send(
                `🔔 **Vice Radar**\n\n` +
                `${othersText} playing **${gameName}** right now in **${guild.name}**.\n\n` +
                `Jump in and squad up. 🌴`
            );
        } catch (dmError) {
            // Closed DMs are normal, not a fault worth alerting staff about.
            console.log(`Could not send Vice Radar DM to ${member.user.tag}`);
        }
    }
}

// The public, user-facing post. Intentionally not routed through sendStaffLog: that
// only ever posts to staff log channels, and this is community-facing copy.
async function postRadarEmbed(guildId, gameName, count) {
    try {
        const radar = radarConfigFor(guildId);
        if (!radar) return;

        const guild = await resolveGuild(guildId);
        if (!guild) return;

        const channel = await guild.channels.fetch(radar.channelId).catch(() => null);
        if (!channel || !channel.isTextBased()) {
            console.error(`Vice Radar channel ${radar.channelId} not found or not text-based in ${guild.name}`);
            return;
        }

        // The leading "# " renders the headcount line as a Discord heading. RADAR_CTA
        // stays a plain field so it keeps rendering at its normal size underneath.
        const embed = new EmbedBuilder()
            .setColor(RADAR_COLORS[radarColorIndex % RADAR_COLORS.length])
            .setDescription(`# ${pickPhrase(count, gameName)}`)
            .addFields({ name: '​', value: RADAR_CTA })
            .setFooter({ text: 'Vice Radar 🌴' })
            .setTimestamp();

        radarColorIndex++;

        const sent = await channel.send({ embeds: [embed] });

        // Tracked before the reaction is seeded: if seeding fails, a member adding the
        // emoji themselves should still opt them in.
        radarPostIds.add(sent.id);

        await sent.react(RADAR_EMOJI).catch(() => {
            console.warn(`Could not seed the ${RADAR_EMOJI} reaction on the Vice Radar post in ${guild.name}`);
        });

        console.log(`Vice Radar: posted ${gameName} (${count} playing) in ${guild.name}`);
    } catch (error) {
        console.error('Error posting Vice Radar embed:', error);

        await sendStaffLog(guildId, {
            color: LOG_COLORS.error,
            title: '⚠️ Vice Radar Post Failed',
            description: `A squad match for **${gameName}** could not be posted in ${guildLabel(guildId)}.`,
            fields: [errorField(error)],
            footer: 'Check the radar channel ID and that the bot can post embeds there.'
        });
    }
}

client.on('messageReactionAdd', async (reaction, user) => {
    try {
        if (user.bot || user.id === client.user.id) return;

        // A post that has aged out of the message cache arrives partial.
        if (reaction.partial) {
            reaction = await reaction.fetch().catch(() => null);
            if (!reaction) return;
        }

        if (reaction.emoji.name !== RADAR_EMOJI) return;
        if (!radarPostIds.has(reaction.message.id)) return;

        const guildId = reaction.message.guildId;
        const radar = radarConfigFor(guildId);
        if (!radar) return;

        const guild = await resolveGuild(guildId);
        if (!guild) return;

        const member = await guild.members.fetch(user.id).catch(() => null);
        if (!member) return;
        // Re-checked on the member: an uncached user arrives partial, with no bot flag set.
        if (member.user.bot) return;
        if (member.roles.cache.has(radar.roleId)) return; // already opted in

        if (!canManageRole(guild, radar.roleId)) {
            console.error(`Cannot grant the Vice Radar role in ${guild.name} - my role must sit above it`);

            await sendStaffLog(guildId, {
                color: LOG_COLORS.error,
                title: '⚠️ Vice Radar Opt-In Failed',
                description: `**${member.user.tag}** (<@${member.id}>) reacted to opt into Vice Radar, but the role could not be granted.`,
                fields: [
                    { name: 'Reason', value: 'The bot\'s highest role sits below the Vice Radar role.' }
                ],
                footer: 'Move the bot\'s role above the Vice Radar role in server settings.'
            });
            return;
        }

        await member.roles.add(radar.roleId);
        console.log(`Vice Radar: ${member.user.tag} opted in via reaction in ${guild.name}`);
    } catch (error) {
        console.error('Error handling Vice Radar reaction:', error);
    }
});

// Leaving the server pulls the member out of every game they were counted in, exactly
// as if they'd stopped playing.
client.on('guildMemberRemove', async (member) => {
    try {
        if (!radarConfigFor(member.guild.id)) return;
        await applyRadarPresence(member.guild.id, member, new Set());
    } catch (error) {
        console.error('Error clearing Vice Radar state on member leave:', error);
    }
});

// Deliberately no listener for losing the opt-in role: tracking is not tied to the role,
// so someone who opts out while playing stays counted toward the squad. The role only
// decides whether they get DM'd, and dmRadarSquad checks that at send time.

async function handleViceRadarCommand(interaction) {
    try {
        const radar = radarConfigFor(interaction.guildId);
        if (!radar) {
            return interaction.reply({ content: '❌ Vice Radar is not configured for this server.', flags: MessageFlags.Ephemeral });
        }

        if (!canManageRole(interaction.guild, radar.roleId)) {
            return interaction.reply({ content: '❌ I cannot manage the Vice Radar role. My role must be positioned above it in server settings.', flags: MessageFlags.Ephemeral });
        }

        const action = interaction.options.getString('action');
        const member = interaction.member;

        if (action === 'join') {
            if (member.roles.cache.has(radar.roleId)) {
                return interaction.reply({ content: '🔔 You\'re already on Vice Radar.', flags: MessageFlags.Ephemeral });
            }

            await member.roles.add(radar.roleId);
            console.log(`Vice Radar: ${interaction.user.tag} opted in via /vice-radar in ${interaction.guild.name}`);

            return interaction.reply({
                content: '🔔 You\'re on **Vice Radar**. You\'ll get a DM when other Vicers are playing the same game as you.\n\n' +
                    'One thing: Discord only shows what you\'re playing if **Settings → Activity Privacy → "Display current activity as a status message"** is on. With it off, nobody can match with you.',
                flags: MessageFlags.Ephemeral
            });
        }

        if (!member.roles.cache.has(radar.roleId)) {
            return interaction.reply({ content: 'You\'re not on Vice Radar right now.', flags: MessageFlags.Ephemeral });
        }

        await member.roles.remove(radar.roleId);
        // The guildMemberUpdate listener above also clears this; doing it here too just
        // means the count is correct immediately rather than an event later. Idempotent.
        await applyRadarPresence(interaction.guildId, member, new Set());
        console.log(`Vice Radar: ${interaction.user.tag} opted out via /vice-radar in ${interaction.guild.name}`);

        return interaction.reply({ content: 'You\'re off **Vice Radar**. Run `/vice-radar join` any time to come back.', flags: MessageFlags.Ephemeral });
    } catch (error) {
        console.error('Error handling /vice-radar:', error);
        await respondWithError(interaction, '❌ Something went wrong updating your Vice Radar role. Please try again.');
    }
}

// Error handling
client.on('error', error => {
    console.error('Client error:', error);

    void sendStaffLogToAllServers({
        color: LOG_COLORS.error,
        title: '⚠️ Bot Client Error',
        description: 'The bot reported a Discord client error and may have briefly lost its connection.',
        fields: [errorField(error)],
        footer: 'If this repeats, check the PM2 log on the server.'
    });
});

process.on('unhandledRejection', error => {
    console.error('Unhandled promise rejection:', error);

    void sendStaffLogToAllServers({
        color: LOG_COLORS.error,
        title: '⚠️ Unhandled Error',
        description: 'The bot hit an unhandled error. Whatever action triggered it may not have completed.',
        fields: [errorField(error)],
        footer: 'If this repeats, check the PM2 log on the server.'
    });
});

// Login to Discord
client.login(BOT_TOKEN);