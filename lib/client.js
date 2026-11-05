// The one Client instance every module shares.
//
// Asking for an intent the application has not been granted in the Developer Portal
// fails the login outright, so every intent here needs its toggle there.

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

const client = new Client(VERIFY_BOT_OPTIONS);

module.exports = client;
