// ---------------------------------------------------------------------------
// The 60-second lobby sweep
// ---------------------------------------------------------------------------
//
// Wall-clock driven, with each stage flagged on the lobby once it has fired. Same
// trade-off the event reminder sweep already makes: a restart risks a duplicate rather
// than a miss, which is the right way round for a reminder.
//
// Two notification stages: one reminder LOBBY_REMINDER_MINUTES before the start, then
// the start post. Nothing else.
//
// Late handling: after downtime, a reminder only goes out if the lobby has not started
// yet, and a start post only inside LOBBY_LATE_GRACE_MS. Past that the stage is marked
// and skipped, so nobody gets a "starting now" an hour late.

const {
    LOG_COLORS,
    LOBBY_AGAIN_WINDOW_HOURS,
    LOBBY_CARD_CLEANUP_HOURS,
    LOBBY_GAME_PRUNE_DAYS,
    LOBBY_LATE_GRACE_MS,
    LOBBY_MAX_NUDGES_PER_LOBBY,
    LOBBY_MAX_OPEN_TOTAL,
    LOBBY_NEWCOMER_PROMPT_HOURS,
    LOBBY_NOW_EXPIRY_MINUTES,
    LOBBY_NUDGE_DAILY_CAP,
    LOBBY_NUDGE_QUIET_END_HOUR,
    LOBBY_NUDGE_QUIET_START_HOUR,
    LOBBY_REMINDER_MINUTES,
    LOBBY_RETENTION_DAYS,
    LOBBY_SERIES_LEAD_HOURS,
    LOBBY_SHOW_MIN_MINUTES,
    LOBBY_LENGTH_MINUTES
} = require('../config');
const { sendStaffLog, errorField } = require('../staff-log');
const { resolveGuild, guildLabel } = require('../utils');
const state = require('./state');
const render = require('./render');
const games = require('./games');
const board = require('./board');
const components = require('./components');
const commands = require('./commands');
const time = require('./time');
const copy = require('./copy');
const { configuredLobbyGuildIds, lobbyConfigFor } = require('./guilds');
const { reminderAction } = require('./stages');

let sweepRunning = false;

const MINUTE = 60 * 1000;

async function runLobbySweep() {
    if (sweepRunning) {
        console.log('Lobby sweep already running, skipping this pass.');
        return;
    }

    sweepRunning = true;

    try {
        const now = Date.now();

        for (const guildId of configuredLobbyGuildIds()) {
            try {
                await sweepGuild(guildId, now);
            } catch (error) {
                console.error(`Lobby sweep failed for ${guildLabel(guildId)}:`, error);

                await sendStaffLog(guildId, {
                    color: LOG_COLORS.error,
                    title: 'LFG Sweep Failed',
                    description: `The LFG sweep for ${guildLabel(guildId)} stopped early. The next pass runs in a minute.`,
                    fields: [errorField(error)]
                });
            }
        }
    } finally {
        sweepRunning = false;
    }
}

async function sweepGuild(guildId, now) {
    await sampleVoice(guildId, now);

    for (const lobby of state.allLobbies(guildId)) {
        await advanceLobby(guildId, lobby, now);
    }

    await releasePendingNudges(guildId, now);
    await createDueSeriesLobbies(guildId, now);
    await promptDueNewcomers(guildId, now);
    pruneGames(guildId, now);
    pruneOldLobbies(guildId, now);

    await board.maybeRepostBoard(guildId, now);
}

// ---------------------------------------------------------------------------
// Lobby stages
// ---------------------------------------------------------------------------

async function advanceLobby(guildId, lobby, now) {
    if (lobby.status === 'open') {
        // /lobby now with nobody else aboard: let it lapse rather than linger.
        if (lobby.isNow && lobby.players.length <= 1 && now >= lobby.startsAt + LOBBY_NOW_EXPIRY_MINUTES * MINUTE) {
            state.setLobbyStatus(lobby, 'expired');
            await components.postToThread(guildId, lobby, copy.lobbyNowExpired);
            await components.refreshCard(guildId, lobby);
            board.markBoardDirty(guildId);
            return;
        }

        // One reminder, decided by a pure function so the timing rules are testable.
        // 'skip' marks the stage without posting, which covers both a start time already
        // passed and a lobby booked inside the reminder window (including /lobby now).
        const reminder = reminderAction(lobby, now, LOBBY_REMINDER_MINUTES);

        if (reminder === 'post' || reminder === 'skip') {
            lobby.stages.reminded = true;
            state.markDirty();
        }

        if (reminder === 'post') {
            const minPlayersUnmet = Boolean(lobby.minPlayers) && lobby.players.length < lobby.minPlayers;
            const posted = await components.postToThread(guildId, lobby, render.reminderPrompt(lobby, { minPlayersUnmet }));

            // Tracked so the prompt's buttons can be greyed when the lobby locks.
            components.trackPrompt(lobby, posted);
        }

        if (!lobby.stages.started && now >= lobby.startsAt) {
            lobby.stages.started = true;
            state.setLobbyStatus(lobby, 'live');

            if (now - lobby.startsAt <= LOBBY_LATE_GRACE_MS) {
                await components.postToThread(guildId, lobby, render.startPrompt(lobby));
            }

            await components.refreshCard(guildId, lobby);
            board.markBoardDirty(guildId);
            return;
        }
    }

    if (lobby.status === 'live' && !lobby.stages.ended && now >= lobby.endsAt) {
        await endLobby(guildId, lobby, now);
        return;
    }

    // Voice evidence becomes the record if the host never confirms.
    if (lobby.status === 'ended' && !lobby.attendance.source && lobby.endedAt && now - lobby.endedAt >= 24 * 60 * 60 * 1000) {
        const qualified = Object.entries(lobby.voiceMinutes || {})
            .filter(([, minutes]) => minutes >= LOBBY_SHOW_MIN_MINUTES)
            .map(([userId]) => userId)
            .filter(userId => lobby.players.includes(userId));

        lobby.attendance.source = qualified.length > 0 ? 'voice' : 'unconfirmed';
        lobby.attendance.showed = qualified;
        state.snapshotResult(lobby);

        // Attendance is settled either way now, so the lobby closes: card and tracked
        // thread prompts all go grey.
        await components.lockLobbyUi(guildId, lobby);
    }

    // Finished cards are deleted so the channel does not fill with dead embeds. The
    // thread is left alone to auto-archive, which keeps the conversation readable.
    const closed = lobby.status === 'ended' || lobby.status === 'cancelled' || lobby.status === 'expired';

    if (closed && !lobby.cardDeleted && lobby.endedAt && now - lobby.endedAt >= LOBBY_CARD_CLEANUP_HOURS * 60 * MINUTE) {
        await deleteCard(guildId, lobby);
    }
}

async function endLobby(guildId, lobby, now) {
    lobby.stages.ended = true;
    state.setLobbyStatus(lobby, 'ended');
    lobby.againClosesAt = now + LOBBY_AGAIN_WINDOW_HOURS * 60 * MINUTE;

    // Pre-select whoever the voice sampling already saw, so the host usually just presses
    // Confirm.
    lobby.attendance.showed = Object.entries(lobby.voiceMinutes || {})
        .filter(([, minutes]) => minutes >= LOBBY_SHOW_MIN_MINUTES)
        .map(([userId]) => userId)
        .filter(userId => lobby.players.includes(userId));

    state.markDirty();

    const labels = {};

    try {
        const guild = await resolveGuild(guildId);

        if (guild) {
            for (const userId of lobby.players) {
                const member = guild.members.cache.get(userId) || await guild.members.fetch(userId).catch(() => null);
                if (member) labels[userId] = member.displayName || member.user.username;
            }
        }
    } catch (error) {
        // Labels are cosmetic; ids still work as select values.
    }

    const prompt = await components.postToThread(guildId, lobby, render.attendancePrompt(lobby, labels));
    components.trackPrompt(lobby, prompt);

    await components.refreshCard(guildId, lobby);
    board.markBoardDirty(guildId);
}

async function deleteCard(guildId, lobby) {
    lobby.cardDeleted = true;
    state.markDirty();

    if (!lobby.cardChannelId || !lobby.cardMessageId) return;

    try {
        const guild = await resolveGuild(guildId);
        if (!guild) return;

        const channel = guild.channels.cache.get(lobby.cardChannelId)
            || await guild.channels.fetch(lobby.cardChannelId).catch(() => null);
        if (!channel || !channel.isTextBased()) return;

        await channel.messages.delete(lobby.cardMessageId);
    } catch (error) {
        // Already gone is the desired end state, so nothing to report.
    }
}

// ---------------------------------------------------------------------------
// Voice sampling
// ---------------------------------------------------------------------------

// One sample per sweep: anyone confirmed for a live lobby who is sitting in its voice
// channel gets a minute credited. Cheap (cache only) and good enough to pre-fill the
// attendance prompt.
async function sampleVoice(guildId, now) {
    const live = state.allLobbies(guildId).filter(lobby => lobby.status === 'live' && lobby.voiceChannelId);
    if (live.length === 0) return;

    const guild = await resolveGuild(guildId);
    if (!guild) return;

    for (const lobby of live) {
        for (const [userId, voiceState] of guild.voiceStates.cache) {
            if (voiceState.channelId !== lobby.voiceChannelId) continue;
            if (!lobby.players.includes(userId)) continue;

            lobby.voiceMinutes[userId] = (lobby.voiceMinutes[userId] || 0) + 1;
            state.markDirty();
        }
    }
}

// ---------------------------------------------------------------------------
// Nudges
// ---------------------------------------------------------------------------

// Called when a lobby is created, not from the sweep, so a match is told promptly.
// Anyone outside their quiet hours is queued for the sweep to release.
async function dispatchNudges(guildId, lobby) {
    const guild = state.guildState(guildId);
    const now = Date.now();
    let sent = 0;

    for (const [userId, profile] of Object.entries(guild.profiles)) {
        if (sent >= LOBBY_MAX_NUDGES_PER_LOBBY) break;

        if (!isNudgeCandidate(lobby, userId, profile, now)) continue;

        const hour = time.localHour(now, profile.tz);
        const insideWindow = hour >= LOBBY_NUDGE_QUIET_START_HOUR && hour < LOBBY_NUDGE_QUIET_END_HOUR;

        // Marked as nudged either way, so a queued nudge cannot also be sent now.
        lobby.nudged.push(userId);
        state.markDirty();

        if (insideWindow) {
            if (await sendNudge(guildId, lobby, userId)) sent++;
        } else {
            state.addPendingNudge(guildId, { userId, lobbyId: lobby.id, queuedAt: now });
        }
    }
}

function isNudgeCandidate(lobby, userId, profile, now) {
    if (!profile.nudges) return false;
    if (!profile.tz) return false;
    if (userId === lobby.hostId) return false;
    if (lobby.players.includes(userId) || lobby.maybes.includes(userId) || lobby.waitlist.includes(userId)) return false;
    if (lobby.nudged.includes(userId)) return false;
    if (!(profile.games || []).includes(lobby.gameKey)) return false;

    // Platform only matters when the lobby refuses crossplay.
    if (!lobby.crossplay && lobby.platform && (profile.platforms || []).length > 0
        && !profile.platforms.includes(lobby.platform)) return false;

    if (!time.matchesAvailability(lobby.startsAt, profile.tz, profile.weekday, profile.weekend)) return false;

    // Daily cap, counted in the member's own day.
    const today = time.localIsoDate(now, profile.tz);
    const log = profile.nudgeLog || { day: null, count: 0 };
    if (log.day === today && log.count >= LOBBY_NUDGE_DAILY_CAP) return false;

    return true;
}

async function sendNudge(guildId, lobby, userId) {
    const guild = await resolveGuild(guildId);
    const profile = state.getProfile(guildId, userId);
    if (!profile) return false;

    const payload = render.nudgeDm(lobby, guild?.name || guildLabel(guildId));
    const ok = await components.dmUser(userId, payload);

    if (!ok) {
        // A closed DM turns their nudges off rather than retrying forever, and never
        // produces a public callout.
        state.updateProfile(guildId, userId, { nudges: false });
        return false;
    }

    const today = time.localIsoDate(Date.now(), profile.tz);
    const log = profile.nudgeLog?.day === today ? profile.nudgeLog : { day: today, count: 0 };
    state.updateProfile(guildId, userId, { nudgeLog: { day: today, count: log.count + 1 } });

    return true;
}

// Queued nudges go out once the member's local morning arrives, and only while the
// lobby is still worth joining.
async function releasePendingNudges(guildId, now) {
    const ready = state.takePendingNudges(guildId, entry => {
        const profile = state.getProfile(guildId, entry.userId);
        if (!profile || !profile.nudges || !profile.tz) return true; // drop it

        const lobby = state.getLobby(guildId, entry.lobbyId);
        if (!lobby || lobby.status !== 'open') return true;          // drop it
        if (lobby.startsAt - now < 60 * MINUTE) return true;         // too late to matter

        const hour = time.localHour(now, profile.tz);
        return hour >= LOBBY_NUDGE_QUIET_START_HOUR && hour < LOBBY_NUDGE_QUIET_END_HOUR;
    });

    for (const entry of ready) {
        const lobby = state.getLobby(guildId, entry.lobbyId);
        const profile = state.getProfile(guildId, entry.userId);
        if (!lobby || lobby.status !== 'open' || !profile?.nudges) continue;
        if (lobby.startsAt - now < 60 * MINUTE) continue;

        await sendNudge(guildId, lobby, entry.userId);
    }
}

// ---------------------------------------------------------------------------
// Recurring lobbies
// ---------------------------------------------------------------------------

async function createDueSeriesLobbies(guildId, now) {
    const guild = state.guildState(guildId);

    for (const [seriesId, series] of Object.entries(guild.series)) {
        if (!series.active) continue;
        if (!series.nextStartsAt) continue;
        if (series.nextStartsAt - now > LOBBY_SERIES_LEAD_HOURS * 60 * MINUTE) continue;

        // Series lobbies skip the per-host cap but still respect the server total, so
        // they cannot crowd the channel out.
        const open = state.allLobbies(guildId).filter(l => l.status === 'open');
        if (open.length >= LOBBY_MAX_OPEN_TOTAL) continue; // retried next sweep

        // Already posted for this occurrence?
        const exists = state.allLobbies(guildId)
            .some(l => l.seriesId === seriesId && l.startsAt === series.nextStartsAt);
        if (exists) {
            advanceSeries(guildId, seriesId, series);
            continue;
        }

        const params = series.params || {};
        const lengthMinutes = LOBBY_LENGTH_MINUTES[params.length] || LOBBY_LENGTH_MINUTES.standard;

        const lobby = state.createLobby(guildId, {
            hostId: series.hostId,
            gameKey: params.gameKey,
            gameLabel: params.gameLabel,
            platform: params.platform,
            crossplay: params.crossplay,
            seats: params.seats,
            minPlayers: params.minPlayers,
            length: params.length,
            note: params.note,
            voiceChannelId: params.voiceChannelId,
            startsAt: series.nextStartsAt,
            endsAt: series.nextStartsAt + lengthMinutes * MINUTE,
            seriesId
        });

        const posted = await commands.postLobbyCard(guildId, lobby);

        if (!posted.ok) {
            state.deleteLobby(guildId, lobby.id);
            console.error(`Series ${seriesId}: could not post the next lobby card (${posted.error}); retrying next sweep.`);
            continue;
        }

        state.noteGameUsed(guildId, params.gameKey);
        await dispatchNudges(guildId, lobby);
        board.markBoardDirty(guildId);

        advanceSeries(guildId, seriesId, series);
    }
}

// Next week's instant is found by scanning UTC for the same local weekday and time, so
// the lobby stays at (say) 8pm local across a daylight-saving change.
function advanceSeries(guildId, seriesId, series) {
    const next = time.nextWeeklyOccurrence(series.nextStartsAt, series.tz, series.weekday, series.hour, series.minute);

    if (next) {
        series.nextStartsAt = next;
    } else {
        // That local time does not exist in the coming week, which happens on a
        // spring-forward day. Fall back to a plain seven days and accept the one-hour
        // drift rather than stalling the series.
        series.nextStartsAt = series.nextStartsAt + 7 * 24 * 60 * MINUTE;
        console.warn(`Series ${seriesId}: ${series.hour}:${series.minute} does not exist next week in ${series.tz}; advanced by 7 days instead.`);
    }

    state.markDirty();
}

// ---------------------------------------------------------------------------
// Newcomers
// ---------------------------------------------------------------------------

async function promptDueNewcomers(guildId, now) {
    const due = state.takeDueNewcomers(guildId, now);
    if (due.length === 0) return;

    const guild = await resolveGuild(guildId);

    for (const userId of due) {
        // Someone who already set themselves up does not need the prompt.
        if (state.getProfile(guildId, userId)) continue;

        const member = guild ? await guild.members.fetch(userId).catch(() => null) : null;
        if (!member) continue; // left in the meantime

        await components.dmUser(userId, render.newcomerDm(guildId, guild?.name || guildLabel(guildId)));
    }
}

// ---------------------------------------------------------------------------
// Pruning
// ---------------------------------------------------------------------------

function pruneGames(guildId, now) {
    const guild = state.guildState(guildId);
    const keys = games.prunableGameKeys(guild.games, now, LOBBY_GAME_PRUNE_DAYS);

    for (const key of keys) {
        delete guild.games[key];
        state.markDirty();
    }

    if (keys.length > 0) {
        console.log(`Lobby sweep: pruned ${keys.length} unused game registry entry/ies in ${guildLabel(guildId)}`);
    }
}

function pruneOldLobbies(guildId, now) {
    const cutoff = LOBBY_RETENTION_DAYS * 24 * 60 * MINUTE;

    for (const lobby of state.allLobbies(guildId)) {
        if (!lobby.endedAt) continue;
        if (now - lobby.endedAt < cutoff) continue;

        state.deleteLobby(guildId, lobby.id);
    }
}

module.exports = {
    runLobbySweep,
    sweepGuild,
    advanceLobby,
    endLobby,
    dispatchNudges,
    isNudgeCandidate,
    releasePendingNudges,
    createDueSeriesLobbies,
    advanceSeries,
    promptDueNewcomers,
    pruneGames,
    pruneOldLobbies,
    sampleVoice,
};
