// ---------------------------------------------------------------------------
// Minecraft Realm post: what has been posted where
// ---------------------------------------------------------------------------
//
// minecraft-state.json, written immediately and atomically (temp file plus rename). An
// unreadable file is set aside as .corrupt-<timestamp> and the module starts empty; the
// worst case is one duplicate post that staff delete by hand.
//
// Per guild: { channelId, messageId, contentHash, inviteUrl, lastRepostDay, checkedAt }.
// inviteUrl is the last link that passed validation and went into a post, kept so a bad
// admin entry falls back to it instead of reaching the channel.

const fs = require('fs');
const { MINECRAFT_STATE_PATH } = require('../config');

const STATE_VERSION = 1;

function blankGuild() {
    return {
        channelId: null,
        messageId: null,
        contentHash: null,
        inviteUrl: null,
        lastRepostDay: null,
        checkedAt: null
    };
}

function createStateStore(filePath) {
    let state = { version: STATE_VERSION, guilds: {} };

    function load() {
        try {
            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            const guilds = parsed && typeof parsed.guilds === 'object' && parsed.guilds ? parsed.guilds : {};
            state = { version: STATE_VERSION, guilds };
            return { ok: true };
        } catch (error) {
            state = { version: STATE_VERSION, guilds: {} };
            if (error.code === 'ENOENT') return { ok: true, empty: true };

            const movedTo = `${filePath}.corrupt-${Date.now()}`;
            try {
                fs.renameSync(filePath, movedTo);
                console.error(`Minecraft post state unreadable, set aside as ${movedTo}:`, error.message);
            } catch (renameError) {
                console.error('Could not set aside the unreadable Minecraft post state:', renameError.message);
            }
            return { ok: false, movedTo };
        }
    }

    function getGuild(guildId) {
        return { ...blankGuild(), ...(state.guilds[guildId] || {}) };
    }

    function save() {
        const temp = `${filePath}.tmp`;
        try {
            fs.writeFileSync(temp, JSON.stringify(state, null, 2));
            fs.renameSync(temp, filePath);
            return { ok: true };
        } catch (error) {
            console.error('Failed to write the Minecraft post state:', error.message);
            return { ok: false, error };
        }
    }

    function updateGuild(guildId, patch) {
        state.guilds[guildId] = { ...getGuild(guildId), ...patch };
        return save();
    }

    return { load, getGuild, updateGuild, path: filePath };
}

const store = createStateStore(MINECRAFT_STATE_PATH);

module.exports = {
    STATE_VERSION,
    blankGuild,
    createStateStore,
    loadMinecraftState: store.load,
    getGuild: store.getGuild,
    updateGuild: store.updateGuild,
};
