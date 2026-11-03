// The one Client instance every module shares.
//
// Two processes run from this codebase, each its own Discord application with its own
// token: Vice Verify Bot (index.js) and the Vice Arcade bot (arcade.js). Modules reach
// Discord through this shared instance rather than being handed a client, so the process
// decides which intents it is built with. arcade.js sets BOT_PROCESS before requiring
// anything, because asking for an intent the application has not been granted in the
// Developer Portal fails the login outright.

const { Client, GatewayIntentBits, Partials } = require('discord.js');

const VERIFY_BOT_OPTIONS = {
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        // Vice Radar: needs the Presence Intent toggle in the Developer Portal.
        GatewayIntentBits.GuildPresences,
        // Event RSVP DMs: not a privileged intent, no Developer Portal toggle needed.
        GatewayIntentBits.GuildScheduledEvents,
        // Activity tracking: voice and stage sessions. Also not privileged (bit 128; the
        // three privileged intents are GuildMembers, GuildPresences and MessageContent),
        // so no Developer Portal toggle either.
        GatewayIntentBits.GuildVoiceStates
    ],
    // Partials.User is load-bearing for guildScheduledEventUserAdd: discord.js resolves
    // the RSVPing user from the user cache and drops the event entirely when it misses,
    // so without this an RSVP from an uncached user would silently never be confirmed.
    partials: [Partials.User]
};

// The arcade posts, edits its own posts, moves three roles and watches for departures.
// Sending and editing need no intent, so Server Members is the only privileged one.
const ARCADE_BOT_OPTIONS = {
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers
    ],
    // Without it discord.js drops guildMemberRemove for a member it never cached, and a
    // departure would wait for the daily sweep instead of being reported at once.
    partials: [Partials.GuildMember]
};

const client = new Client(process.env.BOT_PROCESS === 'arcade' ? ARCADE_BOT_OPTIONS : VERIFY_BOT_OPTIONS);

module.exports = client;
