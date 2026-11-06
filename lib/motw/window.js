// ---------------------------------------------------------------------------
// Member of the Week: window math
// ---------------------------------------------------------------------------
//
// Pure: no Discord, no I/O, and the caller passes the clock. Time zones are left to
// lib/lobby/time.js, which scans in UTC and asks Intl what the local clock says, because
// a constant offset is wrong across a clock change (Oct 26 - Nov 2 2026 is 169 hours,
// Mar 8 - Mar 15 2027 is 167).
//
// A window is [start, end): Monday 9:00 to the next Monday 9:00, local time. A message
// exactly at a boundary belongs to the new window. Each window is keyed by the local
// date of the boundary that ENDS it, which is also the day its winner is announced.
//
// One trap, and the reason for the walk below: nextWeeklyOccurrence(t) starts scanning
// at t + 60 s, so asking from less than a minute before a boundary skips that boundary
// and returns the one a week later. Boundaries are therefore found by walking forward
// from eight days back, the way the game digest's windowEndFor does it, never by asking
// from a point near the boundary itself.

const time = require('../lobby/time');
const { LOBBY_TZ, MOTW_WEEKDAY, MOTW_HOUR, MOTW_MINUTE } = require('../config');

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

const DEFAULT_SCHEDULE = { weekday: MOTW_WEEKDAY, hour: MOTW_HOUR, minute: MOTW_MINUTE };

function next(fromMs, zone, schedule) {
    return time.nextWeeklyOccurrence(fromMs, zone, schedule.weekday, schedule.hour, schedule.minute);
}

// The latest boundary instant at or before nowMs.
function latestBoundaryAtOrBefore(nowMs, zone = LOBBY_TZ, schedule = DEFAULT_SCHEDULE) {
    let cursor = next(nowMs - 8 * DAY_MS, zone, schedule);
    let latest = null;

    while (cursor !== null && cursor <= nowMs) {
        latest = cursor;
        cursor = next(cursor, zone, schedule);
    }

    return latest;
}

// The window containing nowMs: { start, end, key }.
function windowFor(nowMs, zone = LOBBY_TZ, schedule = DEFAULT_SCHEDULE) {
    const start = latestBoundaryAtOrBefore(nowMs, zone, schedule);

    // Only possible for a local time that does not exist in the zone, which 9:00 never is
    // in America/New_York. Falls back rather than crediting nowhere.
    if (start === null) {
        const end = nowMs + WEEK_MS;
        return { start: nowMs, end, key: time.localIsoDate(end, zone) };
    }

    const end = next(start, zone, schedule) ?? start + WEEK_MS;
    return { start, end, key: time.localIsoDate(end, zone) };
}

// The window that most recently closed at or before nowMs. Its key is the local date of
// the boundary at or before now.
function endedWindowFor(nowMs, zone = LOBBY_TZ, schedule = DEFAULT_SCHEDULE) {
    const boundary = latestBoundaryAtOrBefore(nowMs, zone, schedule);
    if (boundary === null) return null;

    return windowFor(boundary - 1, zone, schedule);
}

module.exports = {
    DAY_MS,
    WEEK_MS,
    DEFAULT_SCHEDULE,
    latestBoundaryAtOrBefore,
    windowFor,
    endedWindowFor,
};
