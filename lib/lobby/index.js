// ---------------------------------------------------------------------------
// LFG lobbies: public surface
// ---------------------------------------------------------------------------
//
// Deliberately contains no member moderation of any kind. This feature creates, edits and
// deletes messages and threads and keeps its own state file; it never kicks, bans, times
// anyone out, touches a role, calls into lib/activity, or makes an HTTP request of its
// own. With the channel guard on it also deletes non-command posts in the LFG channel,
// which is message handling rather than moderation of the member who posted.

const { LOG_COLORS, LOBBY_BOARD_POST_HOUR, LOBBY_TZ, SERVER_CONFIGS, VG_GUILD_ID } = require('../config');
const { sendStaffLog, errorField } = require('../staff-log');
const { guildLabel } = require('../utils');
const state = require('./state');
const board = require('./board');
const sweep = require('./sweep');
const components = require('./components');
const commands = require('./commands');
const render = require('./render');
const { LOBBY_GUILD_IDS, lobbyConfigFor, configuredLobbyGuildIds } = require('./guilds');
const { LOBBY_NEWCOMER_PROMPT_HOURS, LOBBY_CHANNEL_GUARD_ENABLED, LOBBY_REMINDER_MINUTES } = require('../config');
const channelGuard = require('./channel-guard');
const copy = require('./copy');

// Coalesces card re-renders during a burst of departures, so a /purge of many members
// produces one edit per affected lobby rather than one per member.
const pendingRerenders = new Map();

function scheduleRerender(guildId, lobby) {
    const key = `${guildId}:${lobby.id}`;
    if (pendingRerenders.has(key)) return;

    const timer = setTimeout(() => {
        pendingRerenders.delete(key);
        void components.refreshCard(guildId, lobby);
    }, 3000);

    timer.unref?.();
    pendingRerenders.set(key, timer);
}

// A fourth guildMemberRemove listener, beside radar, activity and gamer-id.
async function handleGuildMemberRemove(member) {
    try {
        const guildId = member.guild?.id;
        if (!guildId || !lobbyConfigFor(guildId)) return;

        const result = state.purgeMember(guildId, member.id);

        for (const { lobby } of result.touchedLobbies) {
            scheduleRerender(guildId, lobby);
        }

        for (const lobby of result.cancelledLobbies) {
            // The people who signed up are told, the same as any other cancellation.
            await components.notifyCancelled(guildId, lobby, copy.cancelReasonHostLeft);
            scheduleRerender(guildId, lobby);
        }

        if (result.touchedLobbies.length > 0 || result.cancelledLobbies.length > 0) {
            board.markBoardDirty(guildId);
        }

        // Promotions still get their thread mention, which is the notice that matters.
        for (const { lobby, promoted } of result.touchedLobbies) {
            if (!promoted) continue;

            await components.postToThread(guildId, lobby,
                `${render.mention(promoted)} a seat opened up and you are in.`);
            void components.dmUser(promoted, 'A seat opened up in a lobby you were waiting for.');
        }
    } catch (error) {
        console.error('Error cleaning up LFG state on member leave:', error);
    }
}

// A second guildMemberUpdate listener, beside tier-sync's. Only watches for the verified
// role appearing, and only schedules a DM for later.
async function handleGuildMemberUpdate(oldMember, newMember) {
    try {
        const guildId = newMember.guild?.id;
        if (!guildId || !lobbyConfigFor(guildId)) return;

        const verifiedRoleId = SERVER_CONFIGS[guildId]?.verifiedRoleId;
        if (!verifiedRoleId) return;

        // A partial oldMember cannot be diffed, so skip rather than guess.
        if (oldMember.partial) return;
        if (oldMember.roles.cache.has(verifiedRoleId)) return;
        if (!newMember.roles.cache.has(verifiedRoleId)) return;

        // Delayed, so it does not land on top of the existing welcome DM.
        state.setNewcomer(guildId, newMember.id, Date.now() + LOBBY_NEWCOMER_PROMPT_HOURS * 60 * 60 * 1000);
    } catch (error) {
        console.error('Error scheduling the LFG newcomer prompt:', error);
    }
}

// Called from createLobby once the card is up, so a match hears about it promptly rather
// than on the next sweep.
async function onLobbyCreated(guildId, lobby) {
    try {
        await sweep.dispatchNudges(guildId, lobby);
    } catch (error) {
        console.error('Could not dispatch lobby nudges:', error);
    }
}

function wireStateHooks() {
    state.setStateHooks({
        saveError: error => {
            console.error('Lobby state save failed:', error.message);
        },
        quarantine: (movedTo, error) => {
            for (const guildId of configuredLobbyGuildIds()) {
                void sendStaffLog(guildId, {
                    color: LOG_COLORS.error,
                    title: 'LFG State Unreadable',
                    description: 'The LFG state file could not be read, so it was set aside and the feature restarted from empty. Profiles and open lobbies from before are in the renamed file.',
                    fields: [errorField(error), { name: 'Renamed To', value: movedTo }]
                });
            }
        }
    });
}

// One line per guild at boot, so the PM2 log says plainly whether the feature is live.
function announceLobbyStartup() {
    for (const guildId of LOBBY_GUILD_IDS) {
        if (!guildId) continue;

        const config = lobbyConfigFor(guildId);

        if (!config) {
            console.log(`LFG lobbies: dormant in ${guildLabel(guildId)} (no LFG channel configured, no commands registered)`);
            continue;
        }

        console.log(
            `LFG lobbies: enabled in ${guildLabel(guildId)} | channel ${config.channelId}`
            + ` | default voice ${config.defaultVoiceChannelId || 'none'}`
            + ` | board repost ${LOBBY_BOARD_POST_HOUR}:00 ${LOBBY_TZ} (pinned)`
            + ` | reminder ${LOBBY_REMINDER_MINUTES}m before start`
            + ` | channel guard ${LOBBY_CHANNEL_GUARD_ENABLED ? 'ON' : 'off'}`
            + ' | commands /lobby /lfg-profile /lobby-stats /lobby-games'
        );
    }
}

module.exports = {
    LOBBY_GUILD_IDS,
    lobbyConfigFor,
    configuredLobbyGuildIds,
    PLATFORMS: render.PLATFORMS,

    // state
    loadLobbyState: state.loadLobbyState,
    flushLobbyState: state.flushLobbyState,
    startFlushInterval: state.startFlushInterval,
    wireStateHooks,

    // listeners
    handleGuildMemberRemove,
    handleGuildMemberUpdate,
    handleMessageCreate: channelGuard.handleMessageCreate,
    guardDecision: channelGuard.guardDecision,

    // commands and components
    LOBBY_COMMANDS: commands.LOBBY_COMMANDS,
    handleLobbyCommand: commands.handleLobbyCommand,
    handleAvailabilityCommand: commands.handleAvailabilityCommand,
    handleLobbyStatsCommand: commands.handleLobbyStatsCommand,
    handleLobbyGamesCommand: commands.handleLobbyGamesCommand,
    handleLobbyAutocomplete: commands.handleLobbyAutocomplete,
    isLobbyComponent: components.isLobbyComponent,
    lockLobbyUi: components.lockLobbyUi,
    lockReason: components.lockReason,
    handleLobbyButton: components.handleLobbyButton,
    handleLobbySelect: components.handleLobbySelect,
    handleLobbyModal: components.handleLobbyModal,

    // sweep and board
    runLobbySweep: sweep.runLobbySweep,
    upsertBoard: board.upsertBoard,
    markBoardDirty: board.markBoardDirty,
    onLobbyCreated,
    announceLobbyStartup,
};
