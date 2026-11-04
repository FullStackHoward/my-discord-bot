require('dotenv').config();

// Vice Arcade bot entrypoint. The same codebase as Vice Verify Bot, run as its own PM2
// process and logged in as the Vice Arcade application, so the arcade's posts, roles and
// callouts come from the arcade itself. Everything it does lives in lib/arcade; this file
// is login and wiring only, like index.js.
//
// Set before anything requires lib/client (every module does, through lib/utils), so
// the client is built with the arcade's intents rather than the verify bot's.
process.env.BOT_PROCESS = 'arcade';

const client = require('./lib/client');
const { VICE_ARCADE_BOT_TOKEN, VG_GUILD_ID, LOG_COLORS } = require('./lib/config');
const { sendStaffLog, errorField } = require('./lib/staff-log');
const arcade = require('./lib/arcade');

if (!VICE_ARCADE_BOT_TOKEN) {
    console.error('VICE_ARCADE_BOT_TOKEN is not set, so the Vice Arcade bot cannot log in.');
    process.exit(1);
}

// This bot registers no slash commands. Scores are no longer reviewed, so /arcade-review
// is gone, and on login it is deleted from Vice Gamers if an earlier version registered
// it. Deleted by name rather than with a set([]), so any other guild command the
// Vice Arcade application has is left alone. Never global: the application's global
// list holds /arcade, the Entry Point command.
const RETIRED_COMMANDS = ['arcade-review'];

async function removeRetiredCommands() {
    try {
        const registered = await client.application.commands.fetch({ guildId: VG_GUILD_ID });

        for (const command of registered.values()) {
            if (!RETIRED_COMMANDS.includes(command.name)) continue;

            await client.application.commands.delete(command.id, VG_GUILD_ID);
            console.log(`Removed the retired /${command.name} command from Vice Gamers`);
        }
    } catch (error) {
        // Harmless if it fails: a leftover /arcade-review is only visible to staff and
        // nothing answers it. Logged so it is not a mystery.
        console.error('Could not remove the retired Vice Arcade slash commands:', error);
    }
}

client.once('ready', () => {
    console.log(`${client.user.tag} is now online and ready!`);

    void removeRetiredCommands();

    // One call starts all three loops: the thirty-second event poll, the ten-minute role
    // reconcile, and the departure sweep. Inert unless the arcade channel is configured,
    // and Vice Gamers only.
    //
    // The poll is more than a notification drain: the API opens and closes rounds
    // lazily, triggered by that call, so this loop is what makes rounds turn over at
    // all.
    arcade.start(client);
});

// Anyone who leaves Vice Gamers disappears from every arcade leaderboard, so the API is
// told at once with no debounce. A report that cannot be delivered is queued to disk and
// retried, because the event happens once.
client.on('guildMemberRemove', arcade.handleGuildMemberRemove);

// Error handling. Vice Gamers' staff log only: it is the one server this bot is in.
client.on('error', error => {
    console.error('Client error:', error);

    void sendStaffLog(VG_GUILD_ID, {
        color: LOG_COLORS.error,
        title: '⚠️ Vice Arcade Bot Client Error',
        description: 'The Vice Arcade bot reported a Discord client error and may have briefly lost its connection.',
        fields: [errorField(error)],
        footer: 'If this repeats, check the vice-arcade-bot PM2 log on the server.'
    });
});

process.on('unhandledRejection', error => {
    console.error('Unhandled promise rejection:', error);

    void sendStaffLog(VG_GUILD_ID, {
        color: LOG_COLORS.error,
        title: '⚠️ Vice Arcade Unhandled Error',
        description: 'The Vice Arcade bot hit an unhandled error. Whatever action triggered it may not have completed.',
        fields: [errorField(error)],
        footer: 'If this repeats, check the vice-arcade-bot PM2 log on the server.'
    });
});

// Adding a signal handler replaces Node's default exit, so it has to exit explicitly.
// The departure queue is written to disk as it changes, so there is nothing to flush.
function shutdown(signal) {
    console.log(`Received ${signal}, stopping the Vice Arcade loops before exit.`);

    try {
        arcade.stop();
    } catch (error) {
        console.error('Failed to stop the Vice Arcade loops on shutdown:', error);
    }

    process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

client.login(VICE_ARCADE_BOT_TOKEN);
