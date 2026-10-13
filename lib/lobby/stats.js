// ---------------------------------------------------------------------------
// /lobby-stats aggregation
// ---------------------------------------------------------------------------
//
// Pure: takes the guild's lobby records and profiles, returns numbers. Counts only -
// no member names leave this module, which is what keeps the owner view aggregate.

const { LOBBY_GAME_MIN_SUBMITTERS } = require('../config');
const { matchesAvailability, hourOfWeekBucket, localParts, HOUR_MS } = require('./time');

function median(values) {
    if (values.length === 0) return null;

    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);

    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function ratio(numerator, denominator) {
    return denominator > 0 ? numerator / denominator : null;
}

// `days` bounds the window; lobbies are counted by their start time.
function summarize(guild, { nowMs, days }) {
    const since = nowMs - days * 24 * 60 * 60 * 1000;
    const lobbies = Object.values(guild.lobbies || {}).filter(lobby => lobby.startsAt >= since);

    const created = lobbies.length;
    const finished = lobbies.filter(lobby => lobby.status === 'ended');
    const withResult = finished.filter(lobby => lobby.result);

    const viable = withResult.filter(lobby => (lobby.result.confirmed || 0) >= 2).length;
    const filled = withResult.filter(lobby => lobby.result.filled).length;

    const withAttendance = finished.filter(lobby => lobby.attendance?.source);
    const confirmedTotal = withAttendance.reduce((sum, lobby) => sum + (lobby.result?.confirmed || 0), 0);
    const showedTotal = withAttendance.reduce((sum, lobby) => sum + (lobby.result?.showed || 0), 0);

    const fillTimes = withResult
        .map(lobby => lobby.result.timeToFillMs)
        .filter(value => typeof value === 'number' && value >= 0);

    const hosts = new Set(lobbies.map(lobby => lobby.hostId));
    const participants = new Set();
    const perMember = {};

    for (const lobby of lobbies) {
        for (const userId of lobby.players || []) {
            participants.add(userId);
            if (!perMember[userId]) perMember[userId] = [];
            perMember[userId].push(lobby.startsAt);
        }
    }

    // Repeat participation: two or more lobbies inside any 14-day stretch.
    const fortnight = 14 * 24 * 60 * 60 * 1000;
    let repeatParticipants = 0;

    for (const times of Object.values(perMember)) {
        if (times.length < 2) continue;

        const sorted = times.sort((a, b) => a - b);
        const repeat = sorted.some((time, i) => i > 0 && time - sorted[i - 1] <= fortnight);
        if (repeat) repeatParticipants++;
    }

    const nudgesSent = lobbies.reduce((sum, lobby) => sum + (lobby.nudged || []).length, 0);
    const nudgesJoined = lobbies.reduce((sum, lobby) =>
        sum + (lobby.nudged || []).filter(userId => (lobby.players || []).includes(userId)).length, 0);

    const gameCounts = {};
    for (const lobby of lobbies) {
        if (!lobby.gameKey) continue;
        gameCounts[lobby.gameKey] = (gameCounts[lobby.gameKey] || 0) + 1;
    }

    const topGames = Object.entries(gameCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([key, count]) => ({ key, label: guild.games?.[key]?.label || key, count }));

    const topSubmitted = Object.entries(guild.games || {})
        .map(([key, entry]) => ({ key, label: entry.label || key, submitters: (entry.submitters || []).length }))
        .sort((a, b) => b.submitters - a.submitters)
        .slice(0, 5);

    return {
        windowDays: days,
        created,
        viable,
        fillRate: ratio(filled, withResult.length),
        showRate: ratio(showedTotal, confirmedTotal),
        attendanceRecords: withAttendance.length,
        medianTimeToFillMs: median(fillTimes),
        uniqueHosts: hosts.size,
        uniqueParticipants: participants.size,
        repeatParticipants,
        nudgesSent,
        nudgesJoined,
        crews: Object.keys(guild.crews || {}).length,
        activeSeries: Object.values(guild.series || {}).filter(s => s.active).length,
        openLobbies: Object.values(guild.lobbies || {}).filter(l => l.status === 'open').length,
        topGames,
        topSubmitted,
        gamesListed: Object.values(guild.games || {})
            .filter(entry => (entry.lobbyCount || 0) > 0 || (entry.submitters || []).length >= LOBBY_GAME_MIN_SUBMITTERS).length,
        gamesTotal: Object.keys(guild.games || {}).length
    };
}

// For each game, which hours of the week have the most members available.
//
// Walks the next 168 hours in UTC and asks each member's zone what that instant is for
// them, which is the same direction-of-travel the rest of the module uses. Counts only.
function availabilityOverlap(guild, { nowMs, topPerGame = 3, maxGames = 5 }) {
    const profiles = Object.values(guild.profiles || {}).filter(p => p.tz && (p.games || []).length > 0);
    if (profiles.length === 0) return [];

    const byGame = new Map();

    for (const profile of profiles) {
        for (const gameKey of profile.games) {
            if (!byGame.has(gameKey)) byGame.set(gameKey, []);
            byGame.get(gameKey).push(profile);
        }
    }

    const games = [...byGame.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .slice(0, maxGames);

    const results = [];

    for (const [gameKey, members] of games) {
        const buckets = new Map();

        for (let hour = 0; hour < 168; hour++) {
            const instant = nowMs + hour * HOUR_MS;
            let count = 0;

            for (const profile of members) {
                if (matchesAvailability(instant, profile.tz, profile.weekday, profile.weekend)) count++;
            }

            if (count > 0) buckets.set(instant, count);
        }

        const top = [...buckets.entries()]
            .sort((a, b) => b[1] - a[1] || a[0] - b[0])
            .slice(0, topPerGame)
            .map(([instant, count]) => ({ instant, count }));

        if (top.length > 0) {
            results.push({ gameKey, label: guild.games?.[gameKey]?.label || gameKey, members: members.length, top });
        }
    }

    return results;
}

// Counts for the Sunday digest: the seven days before `nowMs`.
function weekSummary(guild, nowMs) {
    const since = nowMs - 7 * 24 * 60 * 60 * 1000;
    const lobbies = Object.values(guild.lobbies || {}).filter(lobby => lobby.startsAt >= since && lobby.startsAt <= nowMs);

    const withAttendance = lobbies.filter(lobby => lobby.attendance?.source);
    const confirmed = withAttendance.reduce((sum, l) => sum + (l.result?.confirmed || 0), 0);
    const showed = withAttendance.reduce((sum, l) => sum + (l.result?.showed || 0), 0);

    const counts = {};
    for (const lobby of lobbies) {
        if (!lobby.gameKey) continue;
        counts[lobby.gameKey] = (counts[lobby.gameKey] || 0) + 1;
    }

    return {
        lobbies: lobbies.length,
        showRate: ratio(showed, confirmed),
        topGames: Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 3)
            .map(([key, count]) => ({ key, label: guild.games?.[key]?.label || key, count })),
        openCount: Object.values(guild.lobbies || {}).filter(l => l.status === 'open').length
    };
}

module.exports = { median, ratio, summarize, availabilityOverlap, weekSummary };
