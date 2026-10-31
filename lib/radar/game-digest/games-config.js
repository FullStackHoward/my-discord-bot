// ---------------------------------------------------------------------------
// The alias and exclude lists
// ---------------------------------------------------------------------------
//
// A gitignored JSON file so the lists can be curated on the server without a deploy,
// read fresh on every digest and preview run so an edit through /radar-games takes
// effect immediately. A missing or broken file falls back to the seeds below rather
// than failing the digest: the worst case is a few titles listed twice.
//
// [Unverified] The seeds are reasonable guesses at the strings Discord reports, not
// observed ones. Run with RADAR_PRESENCE_DEBUG=true for ten minutes, look at what comes
// back, and fix them with /radar-games. Every seed should be treated as wrong until
// seen in a real payload.

const fs = require('node:fs');
const path = require('node:path');

const CONFIG_PATH = process.env.RADAR_GAMES_CONFIG_PATH
    || path.join(__dirname, '..', '..', '..', 'data', 'radar-games.json');

// `match` entries are raw keys as the identity module builds them: `name:<normalized>`
// or `app:<application id>`. `key` is what they all collapse to, `name` is what the
// embed prints.
const SEED_CONFIG = {
    aliases: [
        { key: 'game:fortnite', name: 'Fortnite', match: ['name:fortnite'] },
        {
            key: 'game:minecraft',
            name: 'Minecraft',
            match: ['name:minecraft', 'name:minecraft: java edition', 'name:minecraft: bedrock edition']
        },
        { key: 'game:battlefield-6', name: 'Battlefield 6', match: ['name:battlefield 6', 'name:battlefield6'] },
        { key: 'game:arc-raiders', name: 'Arc Raiders', match: ['name:arc raiders', 'name:arcraiders'] },
        {
            key: 'game:gta',
            name: 'Grand Theft Auto',
            match: [
                'name:gta v', 'name:gta 5', 'name:gta online',
                'name:grand theft auto v', 'name:grand theft auto online', 'name:grand theft auto'
            ]
        },
        {
            // Every emulator lands in one entry: nobody is looking for "who else is on
            // PCSX2", they are looking for who else is playing old games.
            key: 'game:retro',
            name: 'Retro / Emulation',
            match: [
                'name:retroarch', 'name:dolphin emulator', 'name:dolphin', 'name:pcsx2',
                'name:ppsspp', 'name:duckstation', 'name:cemu', 'name:ryujinx', 'name:yuzu',
                'name:snes9x', 'name:mgba', 'name:project64', 'name:citra', 'name:mesen',
                'name:bizhawk', 'name:flycast', 'name:redream'
            ]
        }
    ],
    // Code editors and launchers only, per the spec. Nothing is excluded for being
    // unpopular, and no member is ever excluded here - this list is about apps.
    excludes: [
        'name:visual studio code', 'name:visual studio', 'name:code', 'name:cursor',
        'name:intellij idea', 'name:pycharm', 'name:webstorm', 'name:phpstorm',
        'name:android studio', 'name:xcode', 'name:sublime text', 'name:neovim', 'name:vim',
        'name:steam', 'name:epic games launcher', 'name:ea app', 'name:battle.net',
        'name:ubisoft connect', 'name:gog galaxy', 'name:riot client',
        'name:rockstar games launcher', 'name:xbox', 'name:playnite', 'name:itch'
    ]
};

function emptyIfMissing(value) {
    return Array.isArray(value) ? value : [];
}

// Read fresh every time. The file is small and this runs once per sample slot, so the
// cost is nothing next to the benefit of an edit taking effect without a restart.
function loadGameConfig() {
    try {
        const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

        return {
            aliases: emptyIfMissing(parsed.aliases),
            excludes: emptyIfMissing(parsed.excludes)
        };
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.warn(`Radar digest: ${CONFIG_PATH} could not be read (${error.message}); using the built-in seed lists.`);
        }

        return { aliases: SEED_CONFIG.aliases, excludes: SEED_CONFIG.excludes };
    }
}

function saveGameConfig(config) {
    const temp = `${CONFIG_PATH}.tmp`;

    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(temp, JSON.stringify(config, null, 2));
    fs.renameSync(temp, CONFIG_PATH);
}

// First write materialises the seeds, so curating starts from something rather than an
// empty file nobody can see the shape of.
function mutateGameConfig(change) {
    const current = loadGameConfig();
    const next = {
        aliases: current.aliases.map(entry => ({ ...entry, match: [...entry.match] })),
        excludes: [...current.excludes]
    };

    const result = change(next);
    saveGameConfig(next);

    return result;
}

module.exports = {
    CONFIG_PATH,
    SEED_CONFIG,
    loadGameConfig,
    saveGameConfig,
    mutateGameConfig,
};
