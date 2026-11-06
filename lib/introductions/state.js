// ---------------------------------------------------------------------------
// Introductions cleanup: persisted on/off state
// ---------------------------------------------------------------------------
//
// A copy of lib/gamer-id/state.js with its own file, deliberately not shared: turning on
// gamer ID cleanup must never silently start deleting whole introduction threads.
//
// Defaults to OFF whenever there is no state to read - a fresh server, a deleted file, an
// unreadable file. Report-only is always the safe direction.

const fs = require('fs');
const { INTRO_STATE_PATH } = require('../config');

const STATE_VERSION = 1;

let state = { version: STATE_VERSION, guilds: {} };

function guildEntry(guildId) {
    if (!state.guilds[guildId]) {
        state.guilds[guildId] = { cleanupEnabled: false, changedAt: 0, changedBy: null, changedByTag: null };
    }

    return state.guilds[guildId];
}

function loadIntroductionsState() {
    try {
        const parsed = JSON.parse(fs.readFileSync(INTRO_STATE_PATH, 'utf8'));
        state = { version: parsed.version || STATE_VERSION, guilds: parsed.guilds || {} };

        const enabled = Object.entries(state.guilds)
            .filter(([, entry]) => entry.cleanupEnabled)
            .map(([guildId]) => guildId);

        console.log(`Loaded introductions cleanup state: deletion enabled in ${enabled.length} server(s)`);
    } catch (error) {
        if (error.code !== 'ENOENT') {
            // OFF rather than guessing, so an unreadable file can never leave deletion
            // silently switched on.
            console.error('Could not read introductions cleanup state, defaulting to report-only:', error.message);
        }

        state = { version: STATE_VERSION, guilds: {} };
    }
}

// Written immediately and atomically: it is flipped rarely and decides whether threads
// get deleted, so it must not wait on an interval or be truncated by a crash.
function saveIntroductionsState() {
    const temp = `${INTRO_STATE_PATH}.tmp`;

    try {
        fs.writeFileSync(temp, JSON.stringify(state, null, 2));
        fs.renameSync(temp, INTRO_STATE_PATH);
        return { ok: true, error: null };
    } catch (error) {
        console.error('Failed to save introductions cleanup state:', error);
        return { ok: false, error };
    }
}

function isCleanupEnabled(guildId) {
    return Boolean(state.guilds[guildId]?.cleanupEnabled);
}

// Returns { changed, saved, error } so the command can tell "already in that state" from
// "changed but could not be written to disk".
function setCleanupEnabled(guildId, enabled, user) {
    const entry = guildEntry(guildId);

    if (entry.cleanupEnabled === enabled) return { changed: false, saved: true, error: null };

    entry.cleanupEnabled = enabled;
    entry.changedAt = Date.now();
    entry.changedBy = user?.id || null;
    entry.changedByTag = user?.tag || null;

    const result = saveIntroductionsState();
    return { changed: true, saved: result.ok, error: result.error };
}

function cleanupStatus(guildId) {
    const entry = state.guilds[guildId];

    return {
        enabled: Boolean(entry?.cleanupEnabled),
        changedAt: entry?.changedAt || 0,
        changedBy: entry?.changedBy || null,
        changedByTag: entry?.changedByTag || null,
        everSet: Boolean(entry && entry.changedAt)
    };
}

// Read at module load, so the setting is in force before `ready` fires.
loadIntroductionsState();

module.exports = {
    loadIntroductionsState,
    isCleanupEnabled,
    setCleanupEnabled,
    cleanupStatus,
};
