// The public post's hype lines. Read fresh on every pick rather than cached at
// startup, so uploading a new data/radar-phrases.json takes effect on the very next
// radar post with no restart and no redeploy. Radar posts are rare enough that
// re-reading a ~6 KB file per pick costs nothing worth optimising away.
//
// This is also the single seam where phrases enter the bot: swapping the body of
// loadPhrases() for an API call later needs no change anywhere else.

const fs = require('fs');
const path = require('path');

const PHRASES_PATH = path.join(__dirname, '..', '..', 'data', 'radar-phrases.json');

// Used only if the JSON file is missing or broken, so Vice Radar never goes fully
// silent over a bad upload. Not meant to be the everyday phrase list.
const FALLBACK_PHRASES = [
    '{count} Vicers are running {game} right now. Squad up. 🌴',
    '{count} Vicers deep in {game}. Room for one more?',
    'Headcount: {count} Vicers in {game}.'
];

function loadPhrases() {
    try {
        const parsed = JSON.parse(fs.readFileSync(PHRASES_PATH, 'utf8'));

        if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every(p => typeof p === 'string')) {
            throw new Error('radar-phrases.json must be a non-empty JSON array of strings');
        }

        return parsed;
    } catch (error) {
        console.error(`Could not load ${PHRASES_PATH}, falling back to the built-in default phrases:`, error.message);
        return FALLBACK_PHRASES;
    }
}

// Game names come straight from Discord, so a name containing $& or $' would be read
// as a replacement pattern by a plain string replace. The function form can't be.
function pickPhrase(count, gameName) {
    const phrases = loadPhrases();
    const phrase = phrases[Math.floor(Math.random() * phrases.length)];

    return phrase
        .replace(/\{count\}/g, () => String(count))
        .replace(/\{game\}/g, () => gameName);
}

module.exports = { pickPhrase };
