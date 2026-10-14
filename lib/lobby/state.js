// ---------------------------------------------------------------------------
// Lobby state: persistence plus the pure seat/waitlist machine
// ---------------------------------------------------------------------------
//
// lobby-state.json is the only source of truth. Nothing here talks to the Vicers API or
// to Discord; the mutators are synchronous and side-effect free apart from the state
// object, which is what makes the last-seat race safe (see joinLobby).
//
// Follows the activity-state pattern: dirty flag, coalescing flush, atomic
// temp-file-plus-rename write, corrupt-file quarantine, forced flush on shutdown.

const crypto = require('crypto');
const fs = require('fs');
const { LOBBY_STATE_PATH, LOBBY_STATE_FLUSH_INTERVAL_MS, LOBBY_STATE_COALESCE_MS } = require('../config');

const STATE_VERSION = 1;

let state = { version: STATE_VERSION, guilds: {} };
let dirty = false;
let coalesceTimer = null;

// Set by index.js so a save failure can be reported without state.js importing
// staff-log (which would pull Discord into a pure-ish module).
let onSaveError = null;
let onQuarantine = null;

function setStateHooks({ saveError, quarantine }) {
    onSaveError = saveError || null;
    onQuarantine = quarantine || null;
}

function blankGuild() {
    return {
        profiles: {},
        lobbies: {},
        templates: {},
        series: {},
        crews: {},
        pendingNudges: [],
        newcomers: {},
        digest: { lastPostedWeek: null },
        board: { channelId: null, messageId: null, lastRepostDay: null },
        games: {},
        blockedGames: [],
        counters: { nextLobbyNumber: 1 }
    };
}

function guildState(guildId) {
    if (!state.guilds[guildId]) state.guilds[guildId] = blankGuild();

    // Older files predate fields added later; fill them in rather than crashing.
    const g = state.guilds[guildId];
    const blank = blankGuild();

    for (const key of Object.keys(blank)) {
        if (g[key] === undefined) g[key] = blank[key];
    }
    if (!g.counters.nextLobbyNumber) g.counters.nextLobbyNumber = 1;

    return g;
}

function loadLobbyState() {
    try {
        const parsed = JSON.parse(fs.readFileSync(LOBBY_STATE_PATH, 'utf8'));
        state = { version: parsed.version || STATE_VERSION, guilds: parsed.guilds || {} };

        const lobbyCount = Object.values(state.guilds)
            .reduce((total, g) => total + Object.keys(g.lobbies || {}).length, 0);
        const profileCount = Object.values(state.guilds)
            .reduce((total, g) => total + Object.keys(g.profiles || {}).length, 0);

        console.log(`Loaded lobby state: ${profileCount} profile(s), ${lobbyCount} lobby record(s)`);
    } catch (error) {
        if (error.code === 'ENOENT') {
            state = { version: STATE_VERSION, guilds: {} };
            return;
        }

        // Keep the unusable file rather than overwriting it: losing every profile and
        // open lobby silently is worse than a stray file on disk.
        const movedTo = `${LOBBY_STATE_PATH}.corrupt-${Date.now()}`;

        try {
            fs.renameSync(LOBBY_STATE_PATH, movedTo);
            console.error(`Lobby state unreadable, set aside as ${movedTo}:`, error.message);
            if (onQuarantine) onQuarantine(movedTo, error);
        } catch (renameError) {
            console.error('Could not set aside the unreadable lobby state file:', renameError);
        }

        state = { version: STATE_VERSION, guilds: {} };
    }
}

function markDirty() {
    dirty = true;

    // Coalescing timer: a burst of mutations (a join that promotes a waitlister, say)
    // produces one write about a second later rather than one per change.
    if (coalesceTimer) return;

    coalesceTimer = setTimeout(() => {
        coalesceTimer = null;
        flushLobbyState();
    }, LOBBY_STATE_COALESCE_MS);
    coalesceTimer.unref?.();
}

function flushLobbyState(force = false) {
    if (!dirty && !force) return { ok: true, skipped: true };

    const temp = `${LOBBY_STATE_PATH}.tmp`;

    try {
        fs.writeFileSync(temp, JSON.stringify(state, null, 2));
        fs.renameSync(temp, LOBBY_STATE_PATH);
        dirty = false;
        return { ok: true, skipped: false };
    } catch (error) {
        console.error('Failed to flush lobby state:', error);
        if (onSaveError) onSaveError(error);
        return { ok: false, error };
    }
}

function startFlushInterval() {
    const timer = setInterval(() => flushLobbyState(), LOBBY_STATE_FLUSH_INTERVAL_MS);
    timer.unref?.();
    return timer;
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

// Six base36 characters, checked against the guild's existing lobbies so a collision
// cannot silently overwrite a live lobby.
function newLobbyId(guildId) {
    const g = guildState(guildId);

    for (let attempt = 0; attempt < 20; attempt++) {
        const id = crypto.randomBytes(4).readUInt32BE(0).toString(36).padStart(6, '0').slice(-6);
        if (!g.lobbies[id]) return id;
    }

    return `${Date.now().toString(36)}`.slice(-6);
}

function newId(prefix) {
    return `${prefix}${crypto.randomBytes(4).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

function blankProfile() {
    return {
        tz: null,
        weekday: [],
        weekend: [],
        platforms: [],
        games: [],
        tags: {},
        nudges: false,
        nudgeLog: { day: null, count: 0 },
        updatedAt: 0
    };
}

function getProfile(guildId, userId) {
    return guildState(guildId).profiles[userId] || null;
}

function ensureProfile(guildId, userId) {
    const g = guildState(guildId);

    if (!g.profiles[userId]) {
        g.profiles[userId] = blankProfile();
        markDirty();
    }

    const profile = g.profiles[userId];
    const blank = blankProfile();
    for (const key of Object.keys(blank)) {
        if (profile[key] === undefined) profile[key] = blank[key];
    }

    return profile;
}

function updateProfile(guildId, userId, patch) {
    const profile = ensureProfile(guildId, userId);
    Object.assign(profile, patch, { updatedAt: Date.now() });
    markDirty();
    return profile;
}

function deleteProfile(guildId, userId) {
    const g = guildState(guildId);
    if (!g.profiles[userId]) return false;

    delete g.profiles[userId];
    markDirty();
    return true;
}

// ---------------------------------------------------------------------------
// Game registry mutators
// ---------------------------------------------------------------------------

function registerGame(guildId, key, label, submitterId) {
    const g = guildState(guildId);

    if (!g.games[key]) {
        g.games[key] = { label, submitters: [], lobbyCount: 0, createdAt: Date.now(), lastUsedAt: 0 };
    }

    const entry = g.games[key];
    // The label is the first spelling submitted, so later variants do not rename it.
    if (!entry.label) entry.label = label;

    if (submitterId && !entry.submitters.includes(submitterId)) entry.submitters.push(submitterId);

    markDirty();
    return entry;
}

function noteGameUsed(guildId, key) {
    const entry = guildState(guildId).games[key];
    if (!entry) return;

    entry.lobbyCount = (entry.lobbyCount || 0) + 1;
    entry.lastUsedAt = Date.now();
    markDirty();
}

function removeGameSubmitter(guildId, key, userId) {
    const entry = guildState(guildId).games[key];
    if (!entry) return;

    const index = (entry.submitters || []).indexOf(userId);
    if (index === -1) return;

    entry.submitters.splice(index, 1);
    markDirty();
}

function blockGame(guildId, key) {
    const g = guildState(guildId);

    if (!g.blockedGames.includes(key)) g.blockedGames.push(key);
    delete g.games[key];

    for (const profile of Object.values(g.profiles)) {
        const index = (profile.games || []).indexOf(key);
        if (index !== -1) profile.games.splice(index, 1);
    }

    markDirty();
}

// ---------------------------------------------------------------------------
// Lobbies
// ---------------------------------------------------------------------------

function createLobby(guildId, fields) {
    const g = guildState(guildId);
    const id = newLobbyId(guildId);
    const number = g.counters.nextLobbyNumber++;

    const lobby = {
        id,
        number,
        hostId: fields.hostId,
        gameKey: fields.gameKey,
        gameLabel: fields.gameLabel,
        platform: fields.platform || null,
        crossplay: fields.crossplay !== false,
        seats: fields.seats,
        minPlayers: fields.minPlayers || null,
        startsAt: fields.startsAt,
        endsAt: fields.endsAt,
        length: fields.length || 'standard',
        note: fields.note || '',
        // 'voice' (play in a voice channel) or 'ingame' (meet in the game itself).
        // voiceChannelId is null for 'ingame'.
        venue: fields.venue === 'ingame' ? 'ingame' : 'voice',
        voiceChannelId: fields.venue === 'ingame' ? null : (fields.voiceChannelId || null),
        seriesId: fields.seriesId || null,
        crewId: fields.crewId || null,
        status: 'open',
        createdAt: Date.now(),
        endedAt: null,
        cardChannelId: '',
        cardMessageId: '',
        cardDeleted: false,
        threadId: null,
        // The host holds the first seat.
        players: [fields.hostId],
        maybes: [],
        waitlist: [],
        nudged: [],
        stages: { reminded: false, started: false, ended: false },
        // Ids of thread prompts that carry buttons, so they can be greyed out when
        // the lobby locks. Read everywhere as `lobby.promptMessageIds || []`, since
        // lobbies persisted before this field existed will not have it.
        promptMessageIds: [],
        voiceMinutes: {},
        attendance: { source: null, showed: [], confirmedAt: null },
        againVotes: [],
        againClosesAt: null,
        result: null,
        isNow: Boolean(fields.isNow)
    };

    g.lobbies[id] = lobby;
    markDirty();
    return lobby;
}

function getLobby(guildId, lobbyId) {
    return guildState(guildId).lobbies[lobbyId] || null;
}

// A DM button press carries no guild, so the lobby has to be found by id across guilds.
function findLobbyAnywhere(lobbyId) {
    for (const [guildId, g] of Object.entries(state.guilds)) {
        if (g.lobbies && g.lobbies[lobbyId]) return { guildId, lobby: g.lobbies[lobbyId] };
    }

    return null;
}

function allLobbies(guildId) {
    return Object.values(guildState(guildId).lobbies);
}

function openLobbies(guildId) {
    return allLobbies(guildId).filter(lobby => lobby.status === 'open' || lobby.status === 'live');
}

function isOpenForJoining(lobby) {
    return lobby && lobby.status === 'open';
}

function confirmedCount(lobby) {
    return lobby.players.length;
}

function seatsLeft(lobby) {
    return Math.max(0, lobby.seats - lobby.players.length);
}

function isParticipant(lobby, userId) {
    return lobby.players.includes(userId);
}

function removeFromArrays(lobby, userId) {
    const from = [];

    for (const key of ['players', 'maybes', 'waitlist']) {
        const index = lobby[key].indexOf(userId);
        if (index !== -1) {
            lobby[key].splice(index, 1);
            from.push(key);
        }
    }

    return from;
}

// THE LAST-SEAT RACE: everything below happens synchronously with no await between the
// seat check and the state change, so two simultaneous presses cannot both take the last
// seat. The caller persists and re-renders afterwards.
//
// `platformOk` is computed by the caller (it needs the member's profile) and passed in,
// keeping this function free of lookups.
function joinLobby(lobby, userId, { platformOk = true } = {}) {
    if (!isOpenForJoining(lobby)) return { ok: false, result: 'closed' };
    if (lobby.players.includes(userId)) return { ok: false, result: 'already' };
    if (!platformOk) return { ok: false, result: 'platform' };

    // Joining supersedes maybe and waitlist standing.
    const wasOn = removeFromArrays(lobby, userId);

    if (lobby.players.length < lobby.seats) {
        lobby.players.push(userId);
        markDirty();
        return { ok: true, result: 'joined', wasOn };
    }

    if (!lobby.waitlist.includes(userId)) lobby.waitlist.push(userId);
    markDirty();
    return { ok: true, result: 'waitlisted', wasOn };
}

function maybeLobby(lobby, userId) {
    if (!isOpenForJoining(lobby)) return { ok: false, result: 'closed' };
    if (lobby.maybes.includes(userId) && !lobby.players.includes(userId)) {
        return { ok: false, result: 'already' };
    }

    removeFromArrays(lobby, userId);
    lobby.maybes.push(userId);
    markDirty();
    return { ok: true, result: 'maybe' };
}

// Returns the promoted member id, if a seat opened and somebody was waiting.
function leaveLobby(lobby, userId) {
    const from = removeFromArrays(lobby, userId);
    if (from.length === 0) return { ok: false, result: 'notIn' };

    let promoted = null;

    if (from.includes('players') && lobby.status === 'open' && lobby.players.length < lobby.seats) {
        promoted = lobby.waitlist.shift() || null;
        if (promoted) lobby.players.push(promoted);
    }

    markDirty();
    return { ok: true, result: 'left', from, promoted };
}

// True once attendance is settled, by the host confirming or by the 24-hour voice
// fallback. 'unconfirmed' counts: the record is final either way, so the lobby is closed.
// Optional chaining throughout, because older records and test fixtures may have no
// attendance object at all.
function isAttendanceFinal(lobby) {
    return Boolean(lobby?.attendance?.source);
}

// Lobbies created before the venue field existed have no `venue`, so it is inferred
// from whether they carried a voice channel. Used everywhere rather than reading
// lobby.venue directly.
function venueOf(lobby) {
    if (lobby?.venue === 'ingame' || lobby?.venue === 'voice') return lobby.venue;
    return lobby?.voiceChannelId ? 'voice' : 'ingame';
}

function setLobbyStatus(lobby, status) {
    lobby.status = status;

    if ((status === 'ended' || status === 'cancelled' || status === 'expired') && !lobby.endedAt) {
        lobby.endedAt = Date.now();
    }

    markDirty();
    return lobby;
}

function setSeats(lobby, seats) {
    if (seats < lobby.players.length) return { ok: false, result: 'belowConfirmed' };

    lobby.seats = seats;
    // A bigger lobby can absorb people already waiting.
    while (lobby.players.length < lobby.seats && lobby.waitlist.length > 0) {
        lobby.players.push(lobby.waitlist.shift());
    }

    markDirty();
    return { ok: true };
}

function deleteLobby(guildId, lobbyId) {
    const g = guildState(guildId);
    if (!g.lobbies[lobbyId]) return false;

    delete g.lobbies[lobbyId];
    markDirty();
    return true;
}

// Snapshot taken at end, so later departures cannot change historical counts.
function snapshotResult(lobby) {
    const showed = lobby.attendance.showed || [];

    lobby.result = {
        confirmed: lobby.players.length,
        showed: showed.length,
        filled: lobby.players.length >= lobby.seats,
        seats: lobby.seats,
        gameKey: lobby.gameKey,
        hostId: lobby.hostId,
        startedAt: lobby.startsAt,
        timeToFillMs: lobby.result?.timeToFillMs ?? null
    };

    markDirty();
    return lobby.result;
}

function noteFilled(lobby) {
    if (lobby.result?.timeToFillMs != null) return;
    if (lobby.players.length < lobby.seats) return;

    lobby.result = { ...(lobby.result || {}), timeToFillMs: Date.now() - lobby.createdAt };
    markDirty();
}

// ---------------------------------------------------------------------------
// Templates, series, crews, nudges, newcomers, board
// ---------------------------------------------------------------------------

function getTemplates(guildId, userId) {
    return guildState(guildId).templates[userId] || {};
}

function saveTemplate(guildId, userId, name, params, max) {
    const g = guildState(guildId);
    if (!g.templates[userId]) g.templates[userId] = {};

    const existing = g.templates[userId];
    if (!existing[name] && Object.keys(existing).length >= max) return { ok: false, result: 'cap' };

    existing[name] = { ...params, savedAt: Date.now() };
    markDirty();
    return { ok: true };
}

function deleteTemplate(guildId, userId, name) {
    const templates = guildState(guildId).templates[userId];
    if (!templates || !templates[name]) return false;

    delete templates[name];
    markDirty();
    return true;
}

function getSeries(guildId, seriesId) {
    return guildState(guildId).series[seriesId] || null;
}

function listSeries(guildId, hostId) {
    return Object.entries(guildState(guildId).series)
        .filter(([, s]) => s.active && (!hostId || s.hostId === hostId))
        .map(([id, s]) => ({ id, ...s }));
}

function createSeries(guildId, fields) {
    const g = guildState(guildId);
    const id = newId('s');

    g.series[id] = { hostId: fields.hostId, tz: fields.tz, weekday: fields.weekday,
        hour: fields.hour, minute: fields.minute, params: fields.params,
        nextStartsAt: fields.nextStartsAt, active: true, createdAt: Date.now() };

    markDirty();
    return { id, ...g.series[id] };
}

function stopSeries(guildId, seriesId) {
    const series = guildState(guildId).series[seriesId];
    if (!series || !series.active) return false;

    series.active = false;
    markDirty();
    return true;
}

function listCrews(guildId, userId) {
    return Object.entries(guildState(guildId).crews)
        .filter(([, crew]) => !userId || crew.members.includes(userId))
        .map(([id, crew]) => ({ id, ...crew }));
}

function createCrew(guildId, fields) {
    const g = guildState(guildId);
    const id = newId('c');

    g.crews[id] = { name: fields.name, gameKey: fields.gameKey, gameLabel: fields.gameLabel,
        platform: fields.platform || null, members: fields.members, createdAt: Date.now() };

    markDirty();
    return { id, ...g.crews[id] };
}

function removeFromCrew(guildId, crewId, userId) {
    const g = guildState(guildId);
    const crew = g.crews[crewId];
    if (!crew) return { ok: false };

    const index = crew.members.indexOf(userId);
    if (index === -1) return { ok: false };

    crew.members.splice(index, 1);
    let deleted = false;

    // A crew of one is not a crew.
    if (crew.members.length < 2) {
        delete g.crews[crewId];
        deleted = true;
    }

    markDirty();
    return { ok: true, deleted };
}

function addPendingNudge(guildId, entry) {
    guildState(guildId).pendingNudges.push(entry);
    markDirty();
}

function takePendingNudges(guildId, predicate) {
    const g = guildState(guildId);
    const ready = g.pendingNudges.filter(predicate);

    if (ready.length > 0) {
        g.pendingNudges = g.pendingNudges.filter(entry => !ready.includes(entry));
        markDirty();
    }

    return ready;
}

function setNewcomer(guildId, userId, dueAt) {
    guildState(guildId).newcomers[userId] = dueAt;
    markDirty();
}

function takeDueNewcomers(guildId, nowMs) {
    const g = guildState(guildId);
    const due = Object.entries(g.newcomers).filter(([, dueAt]) => dueAt <= nowMs).map(([userId]) => userId);

    for (const userId of due) delete g.newcomers[userId];
    if (due.length > 0) markDirty();

    return due;
}

function getBoard(guildId) {
    return guildState(guildId).board;
}

function setBoard(guildId, patch) {
    Object.assign(guildState(guildId).board, patch);
    markDirty();
}

function getDigest(guildId) {
    return guildState(guildId).digest;
}

function setDigest(guildId, patch) {
    Object.assign(guildState(guildId).digest, patch);
    markDirty();
}

// ---------------------------------------------------------------------------
// Departure cleanup
// ---------------------------------------------------------------------------

// Everything a leaving member touches, in one pass. Returns what changed so the caller
// can re-render the affected cards once each rather than per mutation.
function purgeMember(guildId, userId) {
    const g = guildState(guildId);
    const touchedLobbies = new Map();
    const cancelledLobbies = [];
    const stoppedSeries = [];
    const leftCrews = [];

    deleteProfile(guildId, userId);
    delete g.newcomers[userId];

    for (const key of Object.keys(g.games)) {
        removeGameSubmitter(guildId, key, userId);
    }

    for (const lobby of Object.values(g.lobbies)) {
        if (lobby.hostId === userId && (lobby.status === 'open' || lobby.status === 'live')) {
            setLobbyStatus(lobby, 'cancelled');
            cancelledLobbies.push(lobby);
            continue;
        }

        if (lobby.status === 'open' || lobby.status === 'live') {
            const result = leaveLobby(lobby, userId);
            if (result.ok) touchedLobbies.set(lobby.id, { lobby, promoted: result.promoted });
            continue;
        }

        // Ended records: scrub the id but keep the counted result snapshot.
        const removed = removeFromArrays(lobby, userId);
        const showedIndex = (lobby.attendance.showed || []).indexOf(userId);
        if (showedIndex !== -1) lobby.attendance.showed.splice(showedIndex, 1);
        const againIndex = (lobby.againVotes || []).indexOf(userId);
        if (againIndex !== -1) lobby.againVotes.splice(againIndex, 1);
        if (removed.length > 0 || showedIndex !== -1 || againIndex !== -1) markDirty();
    }

    for (const [seriesId, series] of Object.entries(g.series)) {
        if (series.hostId === userId && series.active) {
            series.active = false;
            stoppedSeries.push(seriesId);
            markDirty();
        }
    }

    for (const [crewId, crew] of Object.entries({ ...g.crews })) {
        if (!crew.members.includes(userId)) continue;
        const result = removeFromCrew(guildId, crewId, userId);
        if (result.ok) leftCrews.push({ crewId, deleted: result.deleted });
    }

    delete g.templates[userId];
    g.pendingNudges = g.pendingNudges.filter(entry => entry.userId !== userId);
    markDirty();

    return {
        touchedLobbies: [...touchedLobbies.values()],
        cancelledLobbies,
        stoppedSeries,
        leftCrews
    };
}

module.exports = {
    STATE_VERSION,
    setStateHooks,
    loadLobbyState,
    flushLobbyState,
    startFlushInterval,
    markDirty,
    guildState,
    blankProfile,
    getProfile,
    ensureProfile,
    updateProfile,
    deleteProfile,
    registerGame,
    noteGameUsed,
    removeGameSubmitter,
    blockGame,
    newLobbyId,
    createLobby,
    getLobby,
    findLobbyAnywhere,
    allLobbies,
    openLobbies,
    isOpenForJoining,
    confirmedCount,
    seatsLeft,
    isParticipant,
    joinLobby,
    maybeLobby,
    leaveLobby,
    setLobbyStatus,
    setSeats,
    deleteLobby,
    snapshotResult,
    noteFilled,
    isAttendanceFinal,
    venueOf,
    getTemplates,
    saveTemplate,
    deleteTemplate,
    getSeries,
    listSeries,
    createSeries,
    stopSeries,
    listCrews,
    createCrew,
    removeFromCrew,
    addPendingNudge,
    takePendingNudges,
    setNewcomer,
    takeDueNewcomers,
    getBoard,
    setBoard,
    getDigest,
    setDigest,
    purgeMember,
};
