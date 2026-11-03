// ---------------------------------------------------------------------------
// The one thing the arcade keeps on disk
// ---------------------------------------------------------------------------
//
// Departures that could not be reported because the API was unreachable. Nothing else:
// leaderboards, rounds and roles all live in the API, so there is no local view of them
// to go stale.
//
// Why these have to survive a restart: a departure is only observed once, when Discord
// fires the event. If the report fails and the queue is in memory only, that player
// stays on the boards until the daily sweep notices, and a restart in between loses it
// entirely. The startup sweep is the backstop, and this is the cheap path.

const fs = require('fs');

const { ARCADE_STATE_PATH } = require('../config');

const EMPTY = { pendingDepartures: [] };

// A queue that has grown this long means the API has been down for a long time, and the
// daily sweep will catch whatever is dropped. Bounded so a broken API cannot grow a file
// without limit.
const MAX_QUEUED = 500;

function read() {
    try {
        const parsed = JSON.parse(fs.readFileSync(ARCADE_STATE_PATH, 'utf8'));

        return {
            pendingDepartures: Array.isArray(parsed.pendingDepartures) ? parsed.pendingDepartures : []
        };
    } catch {
        // A missing or unreadable file is the normal first-run case, not an error.
        return { ...EMPTY, pendingDepartures: [] };
    }
}

function write(state) {
    try {
        fs.writeFileSync(ARCADE_STATE_PATH, JSON.stringify(state, null, 2));
    } catch (error) {
        console.error('Could not write the arcade state file:', error.message);
    }
}

function queueDepartures(entries) {
    if (entries.length === 0) return;

    const state = read();
    const seen = new Set(state.pendingDepartures.map(entry => `${entry.discord_user_id}:${entry.left_at}`));

    for (const entry of entries) {
        const key = `${entry.discord_user_id}:${entry.left_at}`;
        if (seen.has(key)) continue;

        seen.add(key);
        state.pendingDepartures.push(entry);
    }

    // Oldest dropped first: a recent departure is the one still visible on a board.
    if (state.pendingDepartures.length > MAX_QUEUED) {
        state.pendingDepartures = state.pendingDepartures.slice(-MAX_QUEUED);
    }

    write(state);
}

// Taken rather than peeked, so a failed report re-queues explicitly instead of being
// retried forever by a queue nobody drains.
function takeDepartures() {
    const state = read();
    const taken = state.pendingDepartures;

    if (taken.length === 0) return [];

    write({ ...state, pendingDepartures: [] });

    return taken;
}

module.exports = { queueDepartures, takeDepartures, readState: read };
