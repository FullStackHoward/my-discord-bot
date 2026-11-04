// ---------------------------------------------------------------------------
// Vice Arcade: the bot's half
// ---------------------------------------------------------------------------
//
// The API owns the leaderboards, the rounds and who is on the podium. This module owns
// everything that needs a Discord connection: the posts, the three roles, and telling
// the API when somebody leaves the server.
//
// The poll is the arcade's heartbeat in a stronger sense than it looks. The API opens
// and closes rounds lazily, triggered by this very call, so if this loop stops then
// rounds stop turning over as well as posts stopping. That is deliberate and safe: when
// the bot is down nothing needs to turn over, because nothing can be posted.
//
// Finalizing a round is a handshake, not a notification. The API cannot see Discord
// membership, so it closes the round and says so; this module confirms each winner is
// still in Vice Gamers before anything is written or called out. An outage leaves the
// round unfinalized and retries, because calling out somebody who has left is worse
// than calling out nobody for another thirty seconds.
//
// Vice Gamers only. There is no Vice Creators arcade.

const {
    SERVER_CONFIGS,
    VG_GUILD_ID,
    ARCADE_POLL_INTERVAL_MS,
    ARCADE_ROLE_RECONCILE_INTERVAL_MS,
    ARCADE_DEPARTURE_SWEEP_INTERVAL_MS,
    ARCADE_DEPARTURE_SWEEP_START_DELAY_MS,
    LOG_COLORS
} = require('../config');
const { resolveGuild } = require('../utils');
const { sendStaffLog } = require('../staff-log');

const api = require('./api');
const departures = require('./departures');
const edits = require('./edits');
const posts = require('./posts');
const roles = require('./roles');

let polling = null;
let reconciling = null;
let sweeping = null;

// Guards against a slow pass overlapping the next tick. The API is idempotent, but two
// passes racing would post twice.
let passInFlight = false;

// Warned about once each, so an API newer than the bot is visible without filling the
// console every thirty seconds.
const unknownTypesSeen = new Set();

function arcadeConfig() {
    return SERVER_CONFIGS[VG_GUILD_ID]?.arcade || null;
}

function isEnabled() {
    return Boolean(arcadeConfig()?.channelId);
}

// Matches radarConfigFor and gamerIdConfigFor, so slash-command registration asks the
// same question of every feature. Vice Gamers only: there is no Vice Creators arcade.
function arcadeConfigFor(guildId) {
    if (guildId !== VG_GUILD_ID) return null;

    return isEnabled() ? arcadeConfig() : null;
}

// A missing channel is skipped, never substituted. A leaderboard in the wrong channel is
// worse than no leaderboard.
async function channelFor(client, which) {
    const config = arcadeConfig();
    const id = which === 'chat' ? config?.chatChannelId : config?.channelId;

    if (!id) return null;

    try {
        const channel = await client.channels.fetch(id);
        return channel?.isTextBased?.() ? channel : null;
    } catch (error) {
        console.error(`Vice Arcade: channel ${id} could not be fetched: ${error.message}`);
        return null;
    }
}

// ---------------------------------------------------------------------------
// Event handlers. Each returns true when the event is done with and may be acked.
// ---------------------------------------------------------------------------

async function onRecord(client, payload) {
    const channel = await channelFor(client, 'arcade');

    if (!channel) return true;

    await channel.send(posts.recordMessage({
        gameName: payload.game_display_name || payload.game_slug,
        displayName: payload.display_name,
        score: payload.score,
        previousBest: payload.previous_best,
        previousHolder: payload.previous_holder,
        scoreId: payload.score_id
    }));

    return true;
}

async function onDailyBoardClosed(client, payload) {
    const channel = await channelFor(client, 'arcade');

    if (!channel) return true;

    const board = await api.dailyBoard(payload.game_slug, payload.day);

    if (!board?.entries?.length) return true;

    const messages = posts.dailyBoardMessages({
        gameName: board.game?.display_name || payload.game_display_name,
        day: board.day,
        entries: board.entries,
        resetsAt: board.resets_at
    });

    const ids = [];

    for (const message of messages) {
        const sent = await channel.send(message);
        ids.push(sent.id);
    }

    // Stored so a later departure can edit exactly these messages rather than guessing.
    await api.recordPostedMessages(board.board_id, ids);

    return true;
}

async function onDailyBoardsChanged(client, payload) {
    const channel = await channelFor(client, 'arcade');

    if (!channel) return true;

    // Queued, not awaited: a /purge can touch many messages and the poll loop must not
    // be held up behind them.
    edits.enqueue(channel, payload.boards || []);

    return true;
}

async function onPodiumChanged() {
    // Silent by design. Roles move, nothing is posted.
    await roles.reconcile(api);

    return true;
}

async function onSeasonClosing(client, payload) {
    const seasonId = payload.season_id;

    let preview;

    try {
        preview = await api.seasonPreview(seasonId);
    } catch (error) {
        console.error(`Vice Arcade: could not preview round ${seasonId}: ${error.message}`);
        return false;
    }

    const top = preview?.top || [];

    // A round nobody played is finalized with no winners and no callout.
    if (top.length === 0) {
        await api.finalizeSeason(seasonId, []);
        return true;
    }

    const checked = await departures.confirmWinners(top);

    // Somebody in the top three has left. They are now reported, which recomputes the
    // standings, so the next pass previews a different three rather than guessing at
    // who moved up.
    if (checked.departed.length > 0) return false;

    // A timeout or an outage: nobody is wiped and nothing is finalized. Tried again on
    // the next poll.
    if (!checked.ready) {
        console.warn(`Vice Arcade: round ${seasonId} has unresolved winners, retrying.`);
        return false;
    }

    await api.finalizeSeason(seasonId, checked.winners.map(winner => ({
        discord_user_id: winner.discord_user_id,
        display_name: winner.display_name,
        average_placement: winner.average_placement,
        breakdown: winner.breakdown || {}
    })));

    return true;
}

async function onSeasonAwarded(client, payload) {
    const channel = await channelFor(client, 'chat');

    if (!channel) return true;

    const winners = payload.winners || [];

    if (winners.length === 0) return true;

    const message = payload.corrected || (payload.revision || 1) > 1
        ? posts.correctionMessage({ winners })
        : posts.podiumMessage({
            winners,
            arcadeChannelId: arcadeConfig()?.channelId || null,
            oneGame: true
        });

    if (message) await channel.send(message);

    // The new round's board is empty, so this takes the roles off. Reconciliation would
    // do it within ten minutes anyway; doing it here makes the roles and the callout
    // land together.
    await roles.reconcile(api);

    return true;
}

const HANDLERS = {
    new_alltime_record: onRecord,
    daily_board_closed: onDailyBoardClosed,
    daily_boards_changed: onDailyBoardsChanged,
    podium_changed: onPodiumChanged,
    season_closing: onSeasonClosing,
    season_awarded: onSeasonAwarded
};

// ---------------------------------------------------------------------------
// The poll
// ---------------------------------------------------------------------------

async function runPass(client) {
    if (passInFlight) return { skipped: true };

    passInFlight = true;

    try {
        // Departures that could not be reported earlier go first, so the boards are
        // correct before anything is posted from them.
        await departures.flushQueue();

        const payload = await api.pendingEvents();
        const events = payload?.events || [];

        for (const event of events) {
            const handler = HANDLERS[event.type];

            if (!handler) {
                // Not acked. An unknown type means the API is ahead of the bot, and
                // dropping it would lose whatever it was. Warned about once per type.
                if (!unknownTypesSeen.has(event.type)) {
                    unknownTypesSeen.add(event.type);
                    console.warn(`Vice Arcade: no handler for event type "${event.type}", left pending.`);
                }
                continue;
            }

            try {
                const done = await handler(client, event.payload || {});
                if (done) await api.ackEvent(event.id);
            } catch (error) {
                // Left unacked on purpose, so a transient failure is retried rather
                // than silently swallowing a record post or a podium callout.
                console.error(`Vice Arcade: event ${event.id} (${event.type}) failed: ${error.message}`);
            }
        }

        return { handled: events.length };
    } catch (error) {
        // Includes the API being unreachable, which is expected occasionally and is not
        // worth a staff log every thirty seconds.
        console.error(`Vice Arcade poll failed: ${error.message}`);
        return { failed: true };
    } finally {
        passInFlight = false;
    }
}

function startPolling(client) {
    if (!isEnabled() || polling) return;

    void runPass(client);
    polling = setInterval(() => { void runPass(client); }, ARCADE_POLL_INTERVAL_MS);
}

function startRoleReconciliation() {
    if (!isEnabled() || reconciling) return;

    void roles.reconcile(api);
    reconciling = setInterval(() => { void roles.reconcile(api); }, ARCADE_ROLE_RECONCILE_INTERVAL_MS);
}

async function reportSweep(result) {
    if (result.aborted) {
        await sendStaffLog(VG_GUILD_ID, {
            color: LOG_COLORS.error,
            title: 'Vice Arcade: the departure sweep was abandoned',
            description: `${result.reason}\n\nNo scores were removed.`
        });
        return;
    }

    if (!result.departed?.length) return;

    await sendStaffLog(VG_GUILD_ID, {
        color: LOG_COLORS.kick,
        title: 'Vice Arcade: departed players removed from the leaderboards',
        description: `${result.departed.length} player(s) were on the boards but not in the server, `
            + `out of ${result.checked} checked. Their scores have been removed.`
    });
}

function startDepartureSweep() {
    if (!isEnabled() || sweeping) return;

    // Runs on every boot, so a departure during downtime does not sit on the boards
    // until the next daily pass. Delayed a little so a restart is not doing everything
    // in the same second.
    setTimeout(() => {
        void departures.runSweep().then(reportSweep);
    }, ARCADE_DEPARTURE_SWEEP_START_DELAY_MS);

    sweeping = setInterval(() => {
        void departures.runSweep().then(reportSweep);
    }, ARCADE_DEPARTURE_SWEEP_INTERVAL_MS);
}

function start(client) {
    if (!isEnabled()) {
        console.log('Vice Arcade is off: VG_ARCADE_CHANNEL_ID is not set.');
        return;
    }

    startPolling(client);
    startRoleReconciliation();
    startDepartureSweep();

    console.log('Vice Arcade started: polling every 30s, roles reconciled every 10m.');
}

function stop() {
    if (polling) clearInterval(polling);
    if (reconciling) clearInterval(reconciling);
    if (sweeping) clearInterval(sweeping);

    polling = null;
    reconciling = null;
    sweeping = null;
}

module.exports = {
    isEnabled,
    arcadeConfig,
    arcadeConfigFor,
    start,
    stop,
    runPass,
    startPolling,
    startRoleReconciliation,
    startDepartureSweep,
    handleGuildMemberRemove: departures.handleGuildMemberRemove,
    HANDLERS
};
