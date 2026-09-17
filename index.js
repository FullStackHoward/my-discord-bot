require('dotenv').config();

const client = require('./lib/client');
const { BOT_TOKEN, RECONCILIATION_INTERVAL_MS, APPLICATION_SWEEP_INTERVAL_MS, APPLICATION_SWEEP_START_DELAY_MS, EVENT_REMINDER_CHECK_INTERVAL_MS, SERVER_CONFIGS, LOG_COLORS } = require('./lib/config');
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
