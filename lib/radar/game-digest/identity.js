// ---------------------------------------------------------------------------
// Game identity: turning a presence activity into one stable key
// ---------------------------------------------------------------------------
//
// Pure. No client, no config file reads, no env: the caller loads the alias and exclude
// lists and hands them in compiled, which is what lets every rule here be tested.
//
// Two members can be playing the same game and have Discord report it differently: one
// with a rich-presence application ID, one with a bare name, one with a trademark symbol
// in it. The key is what holds those together, and the alias list is the manual override
// for the cases a rule cannot catch.

const APP_PREFIX = 'app:';
const NAME_PREFIX = 'name:';

// Symbols only. The words "TM" and "Inc" are part of some real titles and are left
// alone; it is the glyphs that are noise.
const TRADEMARK_SYMBOLS = /[™®©℠]/g;

function normalizeName(name) {
    return String(name ?? '')
        .replace(TRADEMARK_SYMBOLS, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

function nameKey(name) {
    return `${NAME_PREFIX}${normalizeName(name)}`;
}

function appKey(applicationId) {
    return applicationId ? `${APP_PREFIX}${applicationId}` : null;
}

// Turns the raw file into lookups once, rather than scanning arrays per member per
// sample. Tolerates a malformed or half-written file: anything unusable is skipped and
// the rest still loads, because a bad alias should cost one entry and not the digest.
function compileGameConfig(raw) {
    const aliases = new Map();
    const excludes = new Set();

    for (const entry of raw?.aliases || []) {
        if (!entry?.key || !Array.isArray(entry.match)) continue;

        const display = String(entry.name || entry.key);

        for (const match of entry.match) {
            if (typeof match !== 'string' || !match) continue;
            aliases.set(match.toLowerCase(), { key: String(entry.key), name: display });
        }
    }

    for (const key of raw?.excludes || []) {
        if (typeof key === 'string' && key) excludes.add(key.toLowerCase());
    }

    return { aliases, excludes };
}

// One activity in, one `{ key, name }` out, or null when it is something that reports as
// Playing but is not a game.
//
// The application ID wins as the key when there is one, per the spec. That does mean the
// same title can arrive under two keys when only some members have rich presence for it,
// which is exactly what the alias list is for: list both and they merge.
function identifyActivity(activity, compiled) {
    if (!activity?.name) return null;

    const byName = nameKey(activity.name);
    const byApp = appKey(activity.applicationId);

    // Checked against both forms, because a launcher or a code editor may be excluded by
    // whichever of the two the person who wrote the list happened to see.
    if (compiled.excludes.has(byName)) return null;
    if (byApp && compiled.excludes.has(byApp)) return null;

    const alias = (byApp && compiled.aliases.get(byApp)) || compiled.aliases.get(byName);
    if (alias) return { key: alias.key, name: alias.name };

    return { key: byApp || byName, name: String(activity.name).trim() };
}

// Every game one member should be credited for in a single sample. A Set, because two
// activities resolving to the same key - a launcher and the game, say, or the alias list
// merging two entries - is one game's worth of time, not two.
function gamesForPresence(presence, compiled) {
    const games = new Map();

    for (const activity of presence?.activities || []) {
        // ActivityType.Playing is 0. Compared numerically so this module stays free of
        // the discord.js import and can be tested on plain objects.
        if (activity?.type !== 0) continue;

        const game = identifyActivity(activity, compiled);
        if (game && !games.has(game.key)) games.set(game.key, game.name);
    }

    return games;
}

module.exports = {
    normalizeName,
    nameKey,
    appKey,
    compileGameConfig,
    identifyActivity,
    gamesForPresence,
    APP_PREFIX,
    NAME_PREFIX,
};
