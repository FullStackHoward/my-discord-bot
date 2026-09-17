// The one Client instance every module shares.

const { Client, GatewayIntentBits, Partials } = require('discord.js');

// Create a new client instance
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        // Vice Radar: needs the Presence Intent toggle in the Developer Portal.
        GatewayIntentBits.GuildPresences,
        // Event RSVP DMs: not a privileged intent, no Developer Portal toggle needed.
        GatewayIntentBits.GuildScheduledEvents
    ],
    // Partials.User is load-bearing for guildScheduledEventUserAdd: discord.js resolves
    // the RSVPing user from the user cache and drops the event entirely when it misses,
    // so without this an RSVP from an uncached user would silently never be confirmed.
    partials: [Partials.User]
});

module.exports = client;
