// ---------------------------------------------------------------------------
// Which guilds run lobbies
// ---------------------------------------------------------------------------
//
// Its own module so board.js, sweep.js and index.js can all read it without importing
// each other.

const { VG_GUILD_ID, VC_GUILD_ID, SERVER_CONFIGS } = require('../config');

const LOBBY_GUILD_IDS = [VG_GUILD_ID, VC_GUILD_ID];

// A guild runs lobbies only when its LFG channel is set. Same opt-in shape as Radar,
// activity and the gamer ID cleanup: with nothing set the module is dormant and
// registers no commands.
function lobbyConfigFor(guildId) {
    if (!guildId || !LOBBY_GUILD_IDS.includes(guildId)) return null;

    const lobby = SERVER_CONFIGS[guildId]?.lobby;
    if (!lobby || !lobby.channelId) return null;

    return lobby;
}

function configuredLobbyGuildIds() {
    return LOBBY_GUILD_IDS.filter(guildId => lobbyConfigFor(guildId));
}

module.exports = { LOBBY_GUILD_IDS, lobbyConfigFor, configuredLobbyGuildIds };
