// ---------------------------------------------------------------------------
// Remote config: last good copy on disk
// ---------------------------------------------------------------------------
//
// One body per community, the last one the API returned "ok". Loaded at boot, so a
// restart during an API outage still runs on the last good config. Written immediately
// and atomically (temp file plus rename); an unreadable file is set aside as
// .corrupt-<timestamp> rather than overwritten, like lib/lobby/state.js.
//
// The file holds the Minecraft invite link and channel id. Both are already visible to
// anyone in that channel, and the file is gitignored.

const fs = require('fs');

const CACHE_VERSION = 1;

function createCache(filePath) {
    let data = { version: CACHE_VERSION, communities: {} };

    function load() {
        try {
            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            const communities = parsed && typeof parsed.communities === 'object' && parsed.communities
                ? parsed.communities
                : {};
            data = { version: CACHE_VERSION, communities };
            return { ok: true };
        } catch (error) {
            data = { version: CACHE_VERSION, communities: {} };
            if (error.code === 'ENOENT') return { ok: true, empty: true };

            const movedTo = `${filePath}.corrupt-${Date.now()}`;
            try {
                fs.renameSync(filePath, movedTo);
                console.error(`Remote config cache unreadable, set aside as ${movedTo}:`, error.message);
            } catch (renameError) {
                console.error('Could not set aside the unreadable remote config cache:', renameError.message);
            }
            return { ok: false, movedTo };
        }
    }

    // { body, fetchedAt } or null.
    function get(community) {
        const entry = data.communities[community];
        return entry && entry.body ? entry : null;
    }

    function set(community, body, fetchedAt = Date.now()) {
        data.communities[community] = { body, fetchedAt };

        const temp = `${filePath}.tmp`;
        try {
            fs.writeFileSync(temp, JSON.stringify(data, null, 2));
            fs.renameSync(temp, filePath);
            return { ok: true };
        } catch (error) {
            // The in-memory copy is still current; only a restart would lose it.
            console.error('Failed to write the remote config cache:', error.message);
            return { ok: false, error };
        }
    }

    return { load, get, set, path: filePath };
}

module.exports = { createCache, CACHE_VERSION };
