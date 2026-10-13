// ---------------------------------------------------------------------------
// The board: one message in the LFG channel, kept current
// ---------------------------------------------------------------------------
//
// Edited in place on every lobby change (debounced), and re-posted once a day at the
// bottom of the channel so members actually see it. Relative timestamps mean no ticking
// refresh is needed between edits.

const { RESTJSONErrorCodes } = require('discord-api-types/v10');
const client = require('../client');
const {
    LOG_COLORS,
    LOBBY_BOARD_DEBOUNCE_SECONDS,
    LOBBY_BOARD_POST_HOUR,
    LOBBY_BOARD_RADAR_MIN,
    LOBBY_TZ
} = require('../config');
const { sendStaffLog, errorField } = require('../staff-log');
const { resolveGuild, guildLabel } = require('../utils');
const radar = require('../radar');
const state = require('./state');
const render = require('./render');
const stats = require('./stats');
const { localParts, localIsoDate, DAY_MS } = require('./time');
const { lobbyConfigFor } = require('./guilds');

// guildId -> trailing timer. One edit per debounce window, however many changes land.
const pendingEdits = new Map();
const upsertRunning = new Set();

function markBoardDirty(guildId) {
    if (!lobbyConfigFor(guildId)) return;
    if (pendingEdits.has(guildId)) return;

    const timer = setTimeout(() => {
        pendingEdits.delete(guildId);
        void upsertBoard(guildId);
    }, LOBBY_BOARD_DEBOUNCE_SECONDS * 1000);

    timer.unref?.();
    pendingEdits.set(guildId, timer);
}

// Reads Radar's in-memory map directly. Counts only, never names, and never writes to
// Radar: this is the only point of contact between the two features.
function playingNow(guildId) {
    try {
        const games = radar.radarGamesFor(guildId);

        return [...games.entries()]
            .map(([gameName, entry]) => ({ gameName, count: entry.activeMembers.size }))
            .filter(entry => entry.count >= LOBBY_BOARD_RADAR_MIN)
            .sort((a, b) => b.count - a.count);
    } catch (error) {
        console.error('Board: could not read Radar state:', error);
        return [];
    }
}

function buildBoardPayload(guildId) {
    const config = lobbyConfigFor(guildId);
    const now = Date.now();

    const open = state.allLobbies(guildId)
        .filter(lobby => lobby.status === 'open')
        .sort((a, b) => a.startsAt - b.startsAt);

    const tonightCutoff = now + DAY_MS;
    const tonight = open.filter(lobby => lobby.startsAt <= tonightCutoff);
    const thisWeek = open.filter(lobby => lobby.startsAt > tonightCutoff);

    const embeds = [render.boardEmbed({
        tonight,
        thisWeek,
        playingNow: playingNow(guildId),
        channelId: config.channelId,
        guildId
    })];

    return { embeds };
}

async function resolveBoardChannel(guildId) {
    const config = lobbyConfigFor(guildId);
    if (!config) return null;

    const guild = await resolveGuild(guildId);
    if (!guild) return null;

    const channel = guild.channels.cache.get(config.channelId)
        || await guild.channels.fetch(config.channelId).catch(() => null);

    if (!channel || !channel.isTextBased()) {
        console.error(`Lobby board: channel ${config.channelId} not found or not text-based in ${guildLabel(guildId)}`);
        return null;
    }

    return channel;
}

// Edits the existing board, or posts a fresh one if it has gone. A deleted board is a
// normal thing for staff to do, so a 10008 just means post a new one.
async function upsertBoard(guildId) {
    if (upsertRunning.has(guildId)) {
        markBoardDirty(guildId);
        return;
    }

    upsertRunning.add(guildId);

    try {
        const channel = await resolveBoardChannel(guildId);
        if (!channel) return;

        const board = state.getBoard(guildId);
        const payload = buildBoardPayload(guildId);

        if (board.messageId) {
            try {
                const message = await channel.messages.fetch(board.messageId);
                await message.edit(payload);
                return;
            } catch (error) {
                if (error.code !== RESTJSONErrorCodes.UnknownMessage) throw error;

                console.log(`Lobby board message missing in ${guildLabel(guildId)}, posting a new one.`);

                await sendStaffLog(guildId, {
                    color: LOG_COLORS.lobby,
                    title: 'LFG Board Reposted',
                    description: `The LFG board message in ${guildLabel(guildId)} had been deleted, so a new one was posted.`
                });
            }
        }

        const sent = await channel.send(payload);
        state.setBoard(guildId, { channelId: channel.id, messageId: sent.id });
    } catch (error) {
        console.error(`Lobby board update failed for ${guildLabel(guildId)}:`, error);
    } finally {
        upsertRunning.delete(guildId);
    }
}

// Daily surfacing: post a fresh board at the bottom of the channel, then delete the old
// one. Post first and delete second, so a failed post leaves the existing board in place
// rather than none at all.
async function maybeRepostBoard(guildId, nowMs) {
    const config = lobbyConfigFor(guildId);
    if (!config) return;

    const board = state.getBoard(guildId);
    const today = localIsoDate(nowMs, LOBBY_TZ);
    if (board.lastRepostDay === today) return;

    const hour = localParts(nowMs, LOBBY_TZ).hour;
    // Catch-up window: if the bot was down at the scheduled hour, repost within three
    // hours after it, but never at some unrelated time of day.
    if (hour < LOBBY_BOARD_POST_HOUR || hour > LOBBY_BOARD_POST_HOUR + 3) return;

    const channel = await resolveBoardChannel(guildId);
    if (!channel) return;

    try {
        // No point pushing a new copy to the bottom if it is already the bottom.
        if (board.messageId && channel.lastMessageId === board.messageId) {
            state.setBoard(guildId, { lastRepostDay: today });
            return;
        }

        const payload = buildBoardPayload(guildId);

        // Sunday carries the weekly digest, instead of a separate post.
        const isSunday = localParts(nowMs, LOBBY_TZ).weekday === 0;
        const digest = state.getDigest(guildId);
        const weekKey = localIsoDate(nowMs, LOBBY_TZ);

        if (isSunday && digest.lastPostedWeek !== weekKey) {
            const summary = stats.weekSummary(state.guildState(guildId), nowMs);
            payload.embeds = [...payload.embeds, render.digestEmbed(summary)];
            state.setDigest(guildId, { lastPostedWeek: weekKey });
        }

        const sent = await channel.send(payload);
        const previousId = board.messageId;

        state.setBoard(guildId, { channelId: channel.id, messageId: sent.id, lastRepostDay: today });

        if (previousId && previousId !== sent.id) {
            await channel.messages.delete(previousId).catch(() => {
                // Already gone, or no permission. The new board is up either way.
            });
        }

        console.log(`Lobby board reposted in ${guildLabel(guildId)}`);
    } catch (error) {
        console.error(`Lobby board repost failed for ${guildLabel(guildId)}:`, error);

        await sendStaffLog(guildId, {
            color: LOG_COLORS.error,
            title: 'LFG Board Repost Failed',
            description: `The daily LFG board repost for ${guildLabel(guildId)} did not go out. The existing board is untouched.`,
            fields: [errorField(error)]
        });
    }
}

module.exports = {
    markBoardDirty,
    upsertBoard,
    maybeRepostBoard,
    buildBoardPayload,
    playingNow,
    resolveBoardChannel,
};
