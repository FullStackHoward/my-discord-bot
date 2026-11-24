// ---------------------------------------------------------------------------
// Remote config: values managed in Django admin, read from the Vicers API
// ---------------------------------------------------------------------------
//
// One poller for every feature that reads its config from api.vicers.net/api/bot-config/.
// It fetches shortly after boot and then every 10 minutes, keeps the last good body per
// community (in memory and on disk), and after every refresh, good or bad, runs the
// registered consumers so each feature acts on whatever is current.
//
// An outage is never an empty config: callers always get the last good copy, flagged
// stale, or null when there has never been one. Each feature decides what "null" means
// for it, and for the Minecraft post that is "do nothing".
//
// Response contract: changes are additive. Unknown keys are ignored, and a missing or
// null section means "no config for that feature".
//
// What moves here and what stays in .env is described in the README under Remote Config.

const {
    LOG_COLORS,
    REMOTE_CONFIG_COMMUNITIES,
    REMOTE_CONFIG_REFRESH_INTERVAL_MS,
    REMOTE_CONFIG_START_DELAY_MS,
    REMOTE_CONFIG_CACHE_PATH
} = require('../config');
const api = require('./api');
const { createCache } = require('./cache');

const HOUR_MS = 60 * 60 * 1000;

// Staff are told once the API has been unreachable this long, and no more often than
// every ALERT_EVERY_MS after that, so they know admin edits are not reaching Discord.
const ALERT_AFTER_MS = HOUR_MS;
const ALERT_EVERY_MS = 6 * HOUR_MS;

function createRemoteConfig({
    communities,
    cache,
    fetchConfig,
    notifyStaff = async () => {},
    log = console
}) {
    const consumers = [];
    // community -> { fresh, lastOkAt, firstFailureAt, lastAlertAt, alertedThisOutage, lastReason }
    const health = new Map();
    let running = false;
    let timers = [];

    function healthFor(community) {
        if (!health.has(community)) {
            health.set(community, {
                fresh: false,
                lastOkAt: null,
                firstFailureAt: null,
                lastAlertAt: 0,
                alertedThisOutage: false,
                lastReason: null
            });
        }
        return health.get(community);
    }

    function communityFor(guildId) {
        return communities.find(entry => entry.guildId === guildId)?.community || null;
    }

    function guildFor(community) {
        return communities.find(entry => entry.community === community)?.guildId || null;
    }

    // The last good body for a community, and whether the latest refresh failed. A body
    // read back from disk at boot is stale until this process has fetched one itself.
    function get(community) {
        const entry = cache.get(community);
        const h = healthFor(community);

        return {
            config: entry ? entry.body : null,
            fetchedAt: entry ? entry.fetchedAt : null,
            stale: !h.fresh
        };
    }

    function registerConsumer(fn) {
        consumers.push(fn);
    }

    async function recordFailure(community, reason, nowMs) {
        const h = healthFor(community);
        h.fresh = false;
        h.lastReason = reason;
        if (h.firstFailureAt === null) h.firstFailureAt = nowMs;

        const hasCopy = Boolean(cache.get(community));
        log.warn(`Remote config: ${community} unavailable (${reason}). ${hasCopy ? 'Using the last good copy.' : 'No good copy yet, so features that need it stay idle.'}`);

        if (nowMs - h.firstFailureAt < ALERT_AFTER_MS) return;
        if (h.lastAlertAt && nowMs - h.lastAlertAt < ALERT_EVERY_MS) return;

        h.lastAlertAt = nowMs;
        h.alertedThisOutage = true;

        const hours = Math.floor((nowMs - h.firstFailureAt) / HOUR_MS);

        await notifyStaff(guildFor(community), {
            color: LOG_COLORS.error,
            title: 'Bot Config Unreachable',
            description: `The bot has not been able to read its config from api.vicers.net for over ${hours} hour${hours === 1 ? '' : 's'}. Changes made in Django admin are not reaching Discord. ${hasCopy ? 'Features are running on the last good copy.' : 'There is no saved copy, so features that need it are idle.'}`,
            fields: [{ name: 'Last Error', value: reason }],
            footer: 'Repeats at most every 6 hours while the outage lasts.'
        });
    }

    async function recordSuccess(community, body, nowMs) {
        const h = healthFor(community);
        const wasAlerted = h.alertedThisOutage;

        cache.set(community, body, nowMs);
        h.fresh = true;
        h.lastOkAt = nowMs;
        h.firstFailureAt = null;
        h.alertedThisOutage = false;
        h.lastReason = null;

        if (wasAlerted) {
            log.log(`Remote config: ${community} reachable again.`);
            await notifyStaff(guildFor(community), {
                color: LOG_COLORS.remoteConfig,
                title: 'Bot Config Reachable Again',
                description: 'The bot is reading its config from api.vicers.net again. Django admin changes will reach Discord within about 10 minutes.'
            });
        }
    }

    async function runConsumers(guildId, community) {
        for (const consumer of consumers) {
            try {
                await consumer(guildId, community);
            } catch (error) {
                log.error(`Remote config consumer failed for ${community}:`, error);
            }
        }
    }

    // One pass: fetch every community, then run the consumers for each. Never throws.
    async function refresh(nowMs = Date.now()) {
        if (running) return;
        running = true;

        try {
            for (const { guildId, community } of communities) {
                try {
                    const result = await fetchConfig(community);

                    if (result && result.status === 'ok') {
                        await recordSuccess(community, result.body, nowMs);
                    } else {
                        await recordFailure(community, result?.reason || 'unknown error', nowMs);
                    }
                } catch (error) {
                    // fetchConfig is not supposed to throw; if it does, it is still an outage.
                    await recordFailure(community, error.message, nowMs);
                }

                await runConsumers(guildId, community);
            }
        } finally {
            running = false;
        }
    }

    function start() {
        cache.load();
        if (communities.length === 0) return;

        const names = communities.map(entry => entry.community).join(', ');
        const cached = communities.filter(entry => cache.get(entry.community)).length;
        log.log(`Remote config: polling ${names} every ${REMOTE_CONFIG_REFRESH_INTERVAL_MS / 60000} minutes (${cached} saved cop${cached === 1 ? 'y' : 'ies'} on disk).`);

        const first = setTimeout(() => {
            void refresh();
            const every = setInterval(() => { void refresh(); }, REMOTE_CONFIG_REFRESH_INTERVAL_MS);
            timers.push(every);
        }, REMOTE_CONFIG_START_DELAY_MS);
        timers.push(first);
    }

    function stop() {
        for (const timer of timers) {
            clearTimeout(timer);
            clearInterval(timer);
        }
        timers = [];
    }

    return { get, refresh, registerConsumer, communityFor, start, stop };
}

// The instance the bot runs. staff-log is required lazily so the tests can build their
// own instance without pulling in a Discord client.
const instance = createRemoteConfig({
    communities: REMOTE_CONFIG_COMMUNITIES,
    cache: createCache(REMOTE_CONFIG_CACHE_PATH),
    fetchConfig: community => api.fetchBotConfig(community),
    notifyStaff: (guildId, options) => {
        if (!guildId) return Promise.resolve();
        return require('../staff-log').sendStaffLog(guildId, options);
    }
});

module.exports = {
    ...instance,
    createRemoteConfig,
    ALERT_AFTER_MS,
    ALERT_EVERY_MS,
};
