// ---------------------------------------------------------------------------
// Weekly digest state
// ---------------------------------------------------------------------------
//
// Same shape as lib/lobby/state.js: a gitignored JSON file at the repo root, written
// atomically through a temp file and a rename, a dirty flag with a coalescing flush, and
// a corrupt file moved aside rather than thrown away.
//
// What is held here is the one genuinely new thing this feature stores: per member, per
// game, per hour minute counts. Radar itself has only ever kept a transient set of IDs.
// So the retention rule below is part of the design rather than housekeeping - buckets
// are deleted as soon as the digest that consumed them has posted.

const fs = require('node:fs');
const path = require('node:path');

const STATE_PATH = process.env.RADAR_DIGEST_STATE_PATH
    || path.join(__dirname, '..', '..', '..', 'radar-digest-state.json');

const FLUSH_INTERVAL_MS = 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// Buckets live this long past the end of the window that consumed them. A week plus a
// day of slack covers a digest that could not post on time; nothing needs them after.
const RETENTION_MS = 8 * 24 * HOUR_MS;

// A failed API write is retried, but a queue that can only grow is a disk leak when the
// endpoint does not exist yet. Oldest weeks are dropped first and the loss is logged.
const MAX_QUEUED_WEEKS = 12;

let state = null;
let dirty = false;
let flushTimer = null;

function emptyGuild() {
    return {
        // hourStartUtc -> memberId -> gameKey -> minutes
        buckets: {},
        // gameKey -> the display name last seen for it
        labels: {},
        firstSampleAt: null,
        lastSampledSlot: null,
        // The Eastern date of the last Sunday this guild posted or deliberately skipped.
        lastHandledWeek: null,
        lastPostedMessageId: null,
        // Last week's ranked rows, kept so this week can say up, down or new. Aggregates
        // only: no member IDs survive here.
        lastResult: [],
        apiQueue: []
    };
}

function quarantineCorrupt(error) {
    const movedTo = `${STATE_PATH}.corrupt-${Date.now()}`;

    try {
        fs.renameSync(STATE_PATH, movedTo);
        console.error(`Radar digest state was unreadable (${error.message}); moved it to ${movedTo} and started fresh.`);
    } catch (moveError) {
        console.error('Radar digest state was unreadable and could not be moved aside:', moveError.message);
    }
}

function load() {
    if (state) return state;

    try {
        const raw = fs.readFileSync(STATE_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        state = { version: 1, guilds: parsed.guilds || {} };
    } catch (error) {
        if (error.code !== 'ENOENT') quarantineCorrupt(error);
        state = { version: 1, guilds: {} };
    }

    return state;
}

function guildState(guildId) {
    const all = load();
    if (!all.guilds[guildId]) all.guilds[guildId] = emptyGuild();

    // Older records, and anything a half-written file left behind.
    const guild = all.guilds[guildId];
    if (!guild.buckets) guild.buckets = {};
    if (!guild.labels) guild.labels = {};
    if (!Array.isArray(guild.lastResult)) guild.lastResult = [];
    if (!Array.isArray(guild.apiQueue)) guild.apiQueue = [];

    return guild;
}

function markDirty() {
    dirty = true;
}

function flush() {
    if (!dirty || !state) return;

    const temp = `${STATE_PATH}.tmp`;

    try {
        fs.writeFileSync(temp, JSON.stringify(state));
        fs.renameSync(temp, STATE_PATH);
        dirty = false;
    } catch (error) {
        console.error('Could not write the Radar digest state:', error.message);
    }
}

function startFlushing() {
    if (flushTimer) return;

    flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);
    flushTimer.unref?.();
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

function hourStartFor(instantMs) {
    return Math.floor(instantMs / HOUR_MS) * HOUR_MS;
}

// Credits one sample's worth of time to a member on a game. Called once per member per
// game per five-minute slot.
function credit(guildId, instantMs, memberId, gameKey, displayName, minutes) {
    const guild = guildState(guildId);
    const hourKey = String(hourStartFor(instantMs));

    const hour = guild.buckets[hourKey] || (guild.buckets[hourKey] = {});
    const member = hour[memberId] || (hour[memberId] = {});

    member[gameKey] = (member[gameKey] || 0) + minutes;
    if (displayName) guild.labels[gameKey] = displayName;
    if (!guild.firstSampleAt) guild.firstSampleAt = instantMs;

    markDirty();
}

// Returns false when this slot has already been sampled, which is what stops a restart
// inside the same five minutes from crediting it twice. Missed slots are not backfilled:
// the bot was not watching, so it does not know what was being played.
function claimSlot(guildId, slotIndex) {
    const guild = guildState(guildId);
    if (guild.lastSampledSlot === slotIndex) return false;

    guild.lastSampledSlot = slotIndex;
    markDirty();

    return true;
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

// Returns how many hourly buckets were dropped, so the caller can log a count rather
// than anything about who was in them.
function pruneBuckets(guildId, cutoffMs) {
    const guild = guildState(guildId);
    let dropped = 0;

    for (const hourKey of Object.keys(guild.buckets)) {
        if (Number(hourKey) >= cutoffMs) continue;
        delete guild.buckets[hourKey];
        dropped += 1;
    }

    if (dropped > 0) markDirty();

    return dropped;
}

// Drops every trace of one member, for an opt-out or a departure. Labels are left: they
// are game names, not people.
function forgetMember(guildId, memberId) {
    const guild = guildState(guildId);
    let touched = 0;

    for (const hour of Object.values(guild.buckets)) {
        if (hour[memberId]) {
            delete hour[memberId];
            touched += 1;
        }
    }

    if (touched > 0) markDirty();

    return touched;
}

// ---------------------------------------------------------------------------
// Week records
// ---------------------------------------------------------------------------

function setHandledWeek(guildId, weekKey, extra = {}) {
    const guild = guildState(guildId);

    guild.lastHandledWeek = weekKey;
    Object.assign(guild, extra);
    markDirty();
}

function queueApiWrite(guildId, record) {
    const guild = guildState(guildId);

    guild.apiQueue.push(record);

    while (guild.apiQueue.length > MAX_QUEUED_WEEKS) {
        const dropped = guild.apiQueue.shift();
        console.warn(`Radar digest: dropped a queued history write for ${dropped.weekStart}, the queue is full (${MAX_QUEUED_WEEKS}).`);
    }

    markDirty();
}

function takeApiQueue(guildId) {
    return [...guildState(guildId).apiQueue];
}

function clearQueuedWrite(guildId, weekStart) {
    const guild = guildState(guildId);
    const before = guild.apiQueue.length;

    guild.apiQueue = guild.apiQueue.filter(record => record.weekStart !== weekStart);
    if (guild.apiQueue.length !== before) markDirty();
}

module.exports = {
    STATE_PATH,
    RETENTION_MS,
    MAX_QUEUED_WEEKS,
    guildState,
    markDirty,
    flush,
    startFlushing,
    hourStartFor,
    credit,
    claimSlot,
    pruneBuckets,
    forgetMember,
    setHandledWeek,
    queueApiWrite,
    takeApiQueue,
    clearQueuedWrite,
    // Testing seam: drops the in-memory copy so a test can point at another file.
    _reset: () => { state = null; dirty = false; }
};
