// ---------------------------------------------------------------------------
// Subscriber detection from tier roles. Used by the activity exemption and
// /purge. Tier roles are per server and are not synced between servers.
// ---------------------------------------------------------------------------

const { TIER_ORDER } = require('./config');

// Highest tier the member currently holds in this guild, or null.
function getMemberTier(member, tierRoleIds) {
    if (!tierRoleIds) return null;

    let found = null;
    for (const tierName of TIER_ORDER) {
        const roleId = tierRoleIds[tierName];
        if (roleId && member.roles.cache.has(roleId)) {
            found = tierName;
        }
    }
    return found;
}

module.exports = {
    getMemberTier,
};
