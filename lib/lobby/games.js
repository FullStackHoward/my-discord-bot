// ---------------------------------------------------------------------------
// Game registry rules
// ---------------------------------------------------------------------------
//
// There is no curated list and no file to maintain. Games exist only because a member
// added one to their profile or a host typed one into a lobby. The rules here keep that
// self-service without needing moderation:
//
//   - the normalized key is the identity, so spelling and punctuation variants collapse
//   - a title with one submitter is visible only to that submitter, so one-off junk
//     never reaches anyone else's autocomplete
//   - a near-duplicate prompts "did you mean" rather than silently forking the registry
//
// Pure: no Discord, no state object mutation beyond what is passed in, no I/O.

const MAX_KEY_LENGTH = 40;
const MIN_LABEL_LENGTH = 2;
const MAX_LABEL_LENGTH = 60;
const MAX_CHOICES = 25;

// Anything that could smuggle a mention, a link or an invite into a public card.
const FORBIDDEN_PATTERNS = [/@/, /</, />/, /http/i, /discord\.gg/i];

// Collapses spelling variants onto one identity: "Helldivers 2", "helldivers 2" and
// "HELLDIVERS  2!" all key to "helldivers-2".
function normalizeGameKey(title) {
    if (typeof title !== 'string') return null;

    const normalized = title
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (!normalized) return null;

    return normalized.split(' ').join('-').slice(0, MAX_KEY_LENGTH).replace(/-+$/, '');
}

function cleanLabel(title) {
    return String(title || '').normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL_LENGTH);
}

// Escapes what Discord would otherwise render as markdown, since labels appear on public
// cards and in embeds.
function escapeLabel(label) {
    return String(label || '').replace(/([*_`~|\\])/g, '\\$1');
}

// { ok, reason, key, label }
function validateGameTitle(title, blockedGames = []) {
    const label = cleanLabel(title);

    if (label.length < MIN_LABEL_LENGTH) return { ok: false, reason: 'tooShort' };
    if (label.length > MAX_LABEL_LENGTH) return { ok: false, reason: 'tooLong' };
    if (FORBIDDEN_PATTERNS.some(pattern => pattern.test(label))) return { ok: false, reason: 'forbidden' };

    const key = normalizeGameKey(label);
    if (!key) return { ok: false, reason: 'empty' };
    if (blockedGames.includes(key)) return { ok: false, reason: 'blocked' };

    return { ok: true, reason: null, key, label };
}

// Levenshtein, bounded: returns max+1 as soon as it is clear the distance exceeds max,
// so a long comparison stops early.
function editDistance(a, b, max = Infinity) {
    if (a === b) return 0;
    if (Math.abs(a.length - b.length) > max) return max + 1;

    let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

    for (let i = 1; i <= a.length; i++) {
        const current = [i];
        let rowMin = i;

        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
            rowMin = Math.min(rowMin, current[j]);
        }

        if (rowMin > max) return max + 1;
        previous = current;
    }

    return previous[b.length];
}

// Tighter threshold on short keys, where a 2-character edit is a different game rather
// than a typo ("lol" vs "low").
function duplicateThreshold(key) {
    return key.length < 6 ? 1 : 2;
}

// The closest existing key within the typo threshold, or null. Only considers titles the
// member can actually see, so a private one-submitter entry from someone else never
// surfaces as a suggestion.
function findNearDuplicate(key, games, visibleKeys) {
    if (!key) return null;
    if (games[key]) return null; // exact hit is not a near-duplicate

    const max = duplicateThreshold(key);
    let best = null;
    let bestDistance = Infinity;

    for (const candidate of visibleKeys) {
        if (candidate === key) continue;

        const distance = editDistance(key, candidate, max);
        if (distance <= max && distance < bestDistance) {
            best = candidate;
            bestDistance = distance;
        }
    }

    return best;
}

// A title reaches everyone's lists once two distinct members have submitted it, or once a
// lobby has used it (a lobby card is already public and attributable to its host).
function isListed(entry, minSubmitters) {
    if (!entry) return false;
    if ((entry.lobbyCount || 0) > 0) return true;
    return (entry.submitters || []).length >= minSubmitters;
}

// Keys this member may see: everything listed, plus their own unlisted submissions.
function visibleGameKeys(games, userId, minSubmitters) {
    const keys = [];

    for (const [key, entry] of Object.entries(games || {})) {
        if (isListed(entry, minSubmitters) || (entry.submitters || []).includes(userId)) {
            keys.push(key);
        }
    }

    return keys;
}

// Starts-with ranks above contains; then popularity; then label, so results are stable.
function rankGames(games, keys, query, userId) {
    const q = normalizeGameKey(query) || '';

    const scored = keys.map(key => {
        const entry = games[key] || {};
        const label = entry.label || key;
        const submitters = (entry.submitters || []).length;
        const lobbyCount = entry.lobbyCount || 0;
        const mine = (entry.submitters || []).includes(userId) ? 1 : 0;

        let matchRank = 2;
        if (q) {
            if (key.startsWith(q)) matchRank = 0;
            else if (key.includes(q)) matchRank = 1;
            else matchRank = 3;
        }

        return { key, label, submitters, lobbyCount, mine, matchRank };
    });

    return scored
        .filter(item => item.matchRank !== 3)
        .sort((a, b) =>
            a.matchRank - b.matchRank
            || (q ? 0 : b.mine - a.mine)
            || (b.submitters + b.lobbyCount) - (a.submitters + a.lobbyCount)
            || a.label.localeCompare(b.label))
        .map(item => ({ key: item.key, label: item.label }));
}

// Autocomplete choices for a game option. When nothing matches, the only suggestion is
// to add what they typed - carried as `new:<text>` so the handler knows to create it.
// The handler re-validates regardless, since Discord accepts any typed string.
function gameChoices(games, { query, userId, minSubmitters, blockedGames = [] }) {
    const visible = visibleGameKeys(games, userId, minSubmitters);
    const ranked = rankGames(games, visible, query, userId);

    const choices = ranked.slice(0, MAX_CHOICES).map(item => ({
        name: item.label.slice(0, 100),
        value: item.key
    }));

    const typed = cleanLabel(query);

    if (typed.length >= MIN_LABEL_LENGTH) {
        const check = validateGameTitle(typed, blockedGames);
        const exists = check.ok && ranked.some(item => item.key === check.key);

        if (check.ok && !exists) {
            // Offered first so it is reachable even when 25 near-matches exist.
            choices.unshift({ name: `Add "${typed}"`.slice(0, 100), value: `new:${typed}`.slice(0, 100) });
        }
    }

    return choices.slice(0, MAX_CHOICES);
}

// Options for the Games multi-select in /availability set: the member's own games first,
// then the most popular listed ones, capped at 25 (a Discord select limit).
function gameSelectOptions(games, { userId, minSubmitters, selected = [] }) {
    const mine = [];
    const others = [];

    for (const [key, entry] of Object.entries(games || {})) {
        const isMine = selected.includes(key) || (entry.submitters || []).includes(userId);

        if (isMine) mine.push({ key, entry });
        else if (isListed(entry, minSubmitters)) others.push({ key, entry });
    }

    const popularity = item => ((item.entry.submitters || []).length + (item.entry.lobbyCount || 0));
    others.sort((a, b) => popularity(b) - popularity(a) || (a.entry.label || a.key).localeCompare(b.entry.label || b.key));
    mine.sort((a, b) => (a.entry.label || a.key).localeCompare(b.entry.label || b.key));

    const combined = [...mine, ...others].slice(0, 25);

    return combined.map(item => ({
        label: (item.entry.label || item.key).slice(0, 100),
        value: item.key,
        default: selected.includes(item.key)
    }));
}

// Registry entries with no submitters left and no recent use. Returns keys to delete so
// the caller can mutate state and report a count.
function prunableGameKeys(games, nowMs, pruneDays) {
    const cutoff = nowMs - pruneDays * 24 * 60 * 60 * 1000;
    const keys = [];

    for (const [key, entry] of Object.entries(games || {})) {
        if ((entry.submitters || []).length > 0) continue;
        if ((entry.lobbyCount || 0) > 0) continue;
        if ((entry.lastUsedAt || entry.createdAt || 0) > cutoff) continue;

        keys.push(key);
    }

    return keys;
}

module.exports = {
    MAX_KEY_LENGTH,
    MIN_LABEL_LENGTH,
    MAX_LABEL_LENGTH,
    normalizeGameKey,
    cleanLabel,
    escapeLabel,
    validateGameTitle,
    editDistance,
    duplicateThreshold,
    findNearDuplicate,
    isListed,
    visibleGameKeys,
    rankGames,
    gameChoices,
    gameSelectOptions,
    prunableGameKeys,
};
