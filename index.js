require('dotenv').config();

const client = require('./lib/client');
const {
    BOT_TOKEN,
    RECONCILIATION_INTERVAL_MS,
    APPLICATION_SWEEP_INTERVAL_MS,
    APPLICATION_SWEEP_START_DELAY_MS,
    EVENT_REMINDER_CHECK_INTERVAL_MS,
    ACTIVITY_STATE_FLUSH_INTERVAL_MS,
    ACTIVITY_VOICE_TICK_INTERVAL_MS,
    ACTIVITY_ROLE_SWEEP_INTERVAL_MS,
    ACTIVITY_ROLE_SWEEP_START_DELAY_MS,
    GAMER_ID_RECONCILE_INTERVAL_MS,
    GAMER_ID_RECONCILE_START_DELAY_MS,
    SERVER_CONFIGS,
    LOG_COLORS
} = require('./lib/config');
const { sendStaffLogToAllServers, errorField } = require('./lib/staff-log');
const { warnAboutMissingConfig } = require('./lib/utils');
const verification = require('./lib/verification');
const tierSync = require('./lib/tier-sync');
const reconciliation = require('./lib/reconciliation');
const applicationSweep = require('./lib/application-sweep');
const events = require('./lib/events');
const slashCommands = require('./lib/slash-commands');
const prefixCommands = require('./lib/prefix-commands');
const radar = require('./lib/radar');
const activity = require('./lib/activity');
const activitySeeding = require('./lib/activity/seeding');
const activityRoleSweep = require('./lib/activity/role-sweep');
const gamerId = require('./lib/gamer-id');

// Bot ready event
client.once('ready', () => {
    console.log(`${client.user.tag} is now online and ready!`);
    console.log(`Configured for ${Object.keys(SERVER_CONFIGS).length} server(s)`);

    warnAboutMissingConfig();
    applicationSweep.loadApplicationState();
    events.loadEventReminderState();

    void slashCommands.registerSlashCommands();

    void events.syncEventChannels();
    setInterval(() => {
        void events.syncEventChannels();
    }, 15 * 60 * 1000);

    void reconciliation.runReconciliation();
    setInterval(() => {
        void reconciliation.runReconciliation();
    }, RECONCILIATION_INTERVAL_MS);

    setTimeout(() => {
        void applicationSweep.runApplicationSweep();
        setInterval(() => {
            void applicationSweep.runApplicationSweep();
        }, APPLICATION_SWEEP_INTERVAL_MS);
    }, APPLICATION_SWEEP_START_DELAY_MS);

    void events.runEventReminderSweep();
    setInterval(() => {
        void events.runEventReminderSweep();
    }, EVENT_REMINDER_CHECK_INTERVAL_MS);

    // Activity tracking. State first, then in-progress voice sessions, then the periodic
    // jobs. Seeding runs in the background so a long backfill never blocks startup.
    activity.loadActivityState();
    activity.initVoiceSessions();
    void activity.announceActivityStartup();

    setInterval(() => {
        void activity.runVoiceTick();
    }, ACTIVITY_VOICE_TICK_INTERVAL_MS);

    setInterval(() => {
        activity.flushActivityState();
    }, ACTIVITY_STATE_FLUSH_INTERVAL_MS);

    void activitySeeding.runSeedingForAllGuilds();

    // Offset from the other full-member-list jobs: reconciliation runs at boot and the
    // application sweep 5 minutes in.
    setTimeout(() => {
        void activityRoleSweep.runActivityRoleSweep();
        setInterval(() => {
            void activityRoleSweep.runActivityRoleSweep();
        }, ACTIVITY_ROLE_SWEEP_INTERVAL_MS);
    }, ACTIVITY_ROLE_SWEEP_START_DELAY_MS);

    // Gamer ID forum cleanup. The daily reconcile is the safety net for leaves the bot was
    // offline for; 35 minutes keeps it clear of the other full-member-list jobs, which run
    // at boot, +5 and +20 minutes.
    void gamerId.announceGamerIdStartup();

    setTimeout(() => {
        void gamerId.runGamerIdReconcile();
        setInterval(() => {
            void gamerId.runGamerIdReconcile();
        }, GAMER_ID_RECONCILE_INTERVAL_MS);
    }, GAMER_ID_RECONCILE_START_DELAY_MS);
});

// ---------------------------------------------------------------------------
// Listener wiring. Each handler lives in the module that owns its feature.
// ---------------------------------------------------------------------------

client.on('guildMemberAdd', verification.handleGuildMemberAdd);
client.on('guildScheduledEventUserAdd', events.handleScheduledEventUserAdd);
client.on('messageCreate', prefixCommands.handleMessageCreate);
client.on('interactionCreate', slashCommands.handleInteractionCreate);
client.on('guildMemberUpdate', tierSync.handleGuildMemberUpdate);
client.on('presenceUpdate', (oldPresence, newPresence) => {
    void radar.handlePresenceUpdate(newPresence);
});
client.on('guildMemberRemove', radar.handleGuildMemberRemove);

// Activity tracking listeners. messageCreate is a second, separate listener rather than
// a branch inside the prefix-command one, so neither feature can break the other.
client.on('messageCreate', activity.handleMessageCreate);
client.on('voiceStateUpdate', activity.handleVoiceStateUpdate);
client.on('guildMemberRemove', activity.handleGuildMemberRemove);

// A third listener on the same event, alongside the radar and activity ones: a departing
// member's gamer ID posts are queued for removal, debounced so a burst of leaves (a /purge
// run, say) produces one scan rather than one per person.
client.on('guildMemberRemove', gamerId.handleGuildMemberRemove);

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

// Adding a signal handler replaces Node's default exit, so each one has to flush the
// activity state and then exit explicitly. Without this, a PM2 restart during a deploy
// would drop up to a minute of recorded activity.
function shutdown(signal) {
    console.log(`Received ${signal}, flushing activity state before exit.`);

    try {
        activity.flushActivityState(true);
    } catch (error) {
        console.error('Failed to flush activity state on shutdown:', error);
    }

    process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Login to Discord
client.login(BOT_TOKEN);
