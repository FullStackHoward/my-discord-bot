// ---------------------------------------------------------------------------
// Member of the Week: persisted state (motw-state.json)
// ---------------------------------------------------------------------------
//
// Same pattern as lib/radar/game-digest/store.js: a gitignored JSON file at the repo root,
// written atomically through a temp file and a rename, a dirty flag with a coalescing
// flush, and an unreadable file moved aside to .corrupt-<timestamp> rather than thrown
// away.
//
// Holds user IDs and message counts only, never message content. Counts are keyed by
// window, so a failure partway through a Monday never loses a week: the week is marked
// handled only once its announcement has gone out.

const fs = require('node:fs');
const { MOTW_STATE_PATH, MOTW_STATE_FLUSH_INTERVAL_MS, MOTW_RETAIN_WEEKS } = require('../config');

let state = null;
let dirty = false;
let flushTimer = null;

function emptyGuild(nowMs) {
    return {
        // When this server's counting began. A window that ended before this is never
        // announced, and one that started before it is labeled partial.
        trackingStartedAt: nowMs,
        firstCountedAt: null,
        // weekKey -> userId -> { n, lastAt }
        weeks: {},
        lastHandledWeek: null,
        lastMissedNoticeKey: null,
        currentHolderId: null,
        lastResult: null
    };
}

function quarantineCorrupt(error) {
    const movedTo = `${MOTW_STATE_PATH}.corrupt-${Date.now()}`;

    try {
        fs.renameSync(MOTW_STATE_PATH, movedTo);
        console.error(`Member of the Week state was unreadable (${error.message}); moved it to ${movedTo} and started fresh.`);
    } catch (moveError) {
        console.error('Member of the Week state was unreadable and could not be moved aside:', moveError.message);
    }
}

function load() {
    if (state) return state;

    try {
        const parsed = JSON.parse(fs.readFileSync(MOTW_STATE_PATH, 'utf8'));
        if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
        state = { version: 1, guilds: parsed.guilds || {} };
    } catch (error) {
        if (error.code !== 'ENOENT') quarantineCorrupt(error);
        state = { version: 1, guilds: {} };
    }

    return state;
}

function guildState(guildId, nowMs = Date.now()) {
    const all = load();

    if (!all.guilds[guildId]) {
        all.guilds[guildId] = emptyGuild(nowMs);
        dirty = true;
    }

    const guild = all.guilds[guildId];
    if (!guild.weeks || typeof guild.weeks !== 'object') guild.weeks = {};
    if (!guild.trackingStartedAt) guild.trackingStartedAt = guild.firstCountedAt || nowMs;

    return guild;
}

function markDirty() {
    dirty = true;
}

function flush() {
    if (!dirty || !state) return;

    const temp = `${MOTW_STATE_PATH}.tmp`;

    try {
        fs.writeFileSync(temp, JSON.stringify(state));
        fs.renameSync(temp, MOTW_STATE_PATH);
        dirty = false;
    } catch (error) {
        console.error('Could not write the Member of the Week state:', error.message);
    }
}

function startFlushing() {
    if (flushTimer) return;

    flushTimer = setInterval(flush, MOTW_STATE_FLUSH_INTERVAL_MS);
    flushTimer.unref?.();
}

// One message, credited to the window it was created in.
function countMessage(guildId, weekKey, userId, createdAt) {
    const guild = guildState(guildId, createdAt);
    const week = guild.weeks[weekKey] || (guild.weeks[weekKey] = {});
    const entry = week[userId] || (week[userId] = { n: 0, lastAt: 0 });

    entry.n += 1;
    entry.lastAt = createdAt;
    if (!guild.firstCountedAt) guild.firstCountedAt = createdAt;

    dirty = true;
}

// Drops a departed member from every retained week. Returns how many weeks were touched.
function forgetMember(guildId, userId) {
    const all = load();
    const guild = all.guilds[guildId];
    if (!guild) return 0;

    let touched = 0;

    for (const week of Object.values(guild.weeks || {})) {
        if (week[userId]) {
            delete week[userId];
            touched += 1;
        }
    }

    if (touched > 0) dirty = true;
    return touched;
}

function setHandledWeek(guildId, weekKey, extra = {}) {
    const guild = guildState(guildId);

    guild.lastHandledWeek = weekKey;
    Object.assign(guild, extra);
    dirty = true;
}

function setCurrentHolder(guildId, userId) {
    guildState(guildId).currentHolderId = userId || null;
    dirty = true;
}

// Keeps the newest MOTW_RETAIN_WEEKS week keys. Keys are YYYY-MM-DD, so they sort as
// strings. Returns how many weeks were dropped.
function pruneWeeks(guildId, keep = MOTW_RETAIN_WEEKS) {
    const guild = guildState(guildId);
    const keys = Object.keys(guild.weeks).sort().reverse();
    let dropped = 0;

    for (const key of keys.slice(keep)) {
        delete guild.weeks[key];
        dropped += 1;
    }

    if (dropped > 0) dirty = true;
    return dropped;
}

module.exports = {
    STATE_PATH: MOTW_STATE_PATH,
    load,
    guildState,
    markDirty,
    flush,
    startFlushing,
    countMessage,
    forgetMember,
    setHandledWeek,
    setCurrentHolder,
    pruneWeeks,
    // Testing seams.
    _reset: () => { state = null; dirty = false; },
    _isDirty: () => dirty,
};
