// ---------------------------------------------------------------------------
// The three podium roles
// ---------------------------------------------------------------------------
//
// The roles follow the live standings, so there is no ceremony here: every pass makes
// each role's holders exactly the player in that slot, and a pass that finds nothing to
// change does nothing.
//
// That idempotence is why reconciliation is load-bearing rather than a safety net. At a
// reset the new board is empty, the API reports no holders, and the roles come off
// because of a pass like this one, not because of an event. A missed event, a restart, a
// role edited by hand and a holder leaving the server are all corrected the same way.
//
// `canManageRole` fails closed: a role above the bot's own is left alone and complained
// about once rather than attempted every ten minutes.

const { SERVER_CONFIGS, VG_GUILD_ID, ARCADE_MEMBER_FETCH_MIN_RATIO } = require('../config');
const { canManageRole, fetchAllMembers, resolveGuild } = require('../utils');

const PLACE_KEYS = ['gold', 'silver', 'bronze'];

// One complaint per role per hour, so a missing permission cannot flood the console.
const COMPLAINT_INTERVAL_MS = 60 * 60 * 1000;
const lastComplaint = new Map();

function complain(key, message) {
    const now = Date.now();

    if (now - (lastComplaint.get(key) || 0) < COMPLAINT_INTERVAL_MS) return;

    lastComplaint.set(key, now);
    console.warn(`Vice Arcade roles: ${message}`);
}

function arcadeConfig() {
    return SERVER_CONFIGS[VG_GUILD_ID]?.arcade || null;
}

function configuredRoleIds() {
    const config = arcadeConfig();

    if (!config) return [];

    return PLACE_KEYS.map(key => config.roles?.[key]).filter(Boolean);
}

// Members are only fetched when the cache looks cold. Removing a role needs to know who
// currently holds it, and that comes from the member cache; adding one does not. So a
// cold cache could leave a role on somebody, which is exactly the failure this module
// exists to prevent.
async function ensureMembersCached(guild) {
    const expected = guild.memberCount || 0;

    if (expected === 0) return;
    if (guild.members.cache.size >= expected * ARCADE_MEMBER_FETCH_MIN_RATIO) return;

    try {
        await fetchAllMembers(guild);
    } catch (error) {
        complain('fetch', `could not fetch the member list (${error.message}), so a stale role may survive this pass.`);
    }
}

// `holders` is [{ place, discord_user_id }], already in order, at most three.
async function applyHolders(guild, holders) {
    const config = arcadeConfig();

    if (!config) return { changed: 0, skipped: 'no arcade config' };

    const byPlace = new Map(holders.map(holder => [holder.place, String(holder.discord_user_id)]));
    let changed = 0;

    await ensureMembersCached(guild);

    for (const [index, key] of PLACE_KEYS.entries()) {
        const roleId = config.roles?.[key];

        if (!roleId) {
            complain(`missing:${key}`, `the ${key} role id is not set, so that place is not awarded.`);
            continue;
        }

        const role = guild.roles.cache.get(roleId);

        if (!role) {
            complain(`absent:${key}`, `role ${roleId} (${key}) is not in the server.`);
            continue;
        }

        if (!canManageRole(guild, roleId)) {
            complain(`above:${key}`, `${role.name} sits above the bot's highest role, so it cannot be moved. Drag it below.`);
            continue;
        }

        const wanted = byPlace.get(index + 1) || null;

        // Everyone who should not have it. Taken as a snapshot first, because removing
        // a role mutates the collection being iterated.
        for (const member of [...role.members.values()]) {
            if (member.id === wanted) continue;

            try {
                await member.roles.remove(roleId, 'Vice Arcade podium changed');
                changed += 1;
            } catch (error) {
                complain(`remove:${key}`, `could not take ${role.name} from ${member.id}: ${error.message}`);
            }
        }

        if (!wanted) continue;

        // A player holds at most one of the three, which falls out of each role being
        // reconciled against its own place.
        if (role.members.has(wanted)) continue;

        try {
            const member = await guild.members.fetch(wanted);
            await member.roles.add(roleId, 'Vice Arcade podium changed');
            changed += 1;
        } catch (error) {
            // An unknown member here is a player who left between the API computing the
            // standings and this call. The departure path will remove their scores and
            // the next pass will award the role to whoever moves up.
            complain(`add:${key}`, `could not give ${role.name} to ${wanted}: ${error.message}`);
        }
    }

    return { changed, skipped: null };
}

async function reconcile(api) {
    if (configuredRoleIds().length === 0) return { changed: 0, skipped: 'no roles configured' };

    const guild = await resolveGuild(VG_GUILD_ID);

    if (!guild) return { changed: 0, skipped: 'guild unavailable' };

    let podium;

    try {
        podium = await api.currentPodium();
    } catch (error) {
        // An unreachable API is not an empty podium. Leaving the roles exactly as they
        // are is the only safe reading, so this pass does nothing at all.
        complain('api', `could not read the podium (${error.message}); roles left as they are.`);
        return { changed: 0, skipped: 'api unreachable' };
    }

    return applyHolders(guild, podium?.holders || []);
}

module.exports = {
    PLACE_KEYS,
    arcadeConfig,
    configuredRoleIds,
    applyHolders,
    reconcile
};
