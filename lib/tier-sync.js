// ---------------------------------------------------------------------------
// Feature B: cross-server subscription tier sync
// ---------------------------------------------------------------------------

const { SERVER_CONFIGS, TIER_ORDER, LOG_COLORS, tierLabel } = require('./config');
const { sendStaffLog, errorField } = require('./staff-log');
const {
    resolveGuild,
    canManageRole,
    guildLabel,
    isMainServer,
    otherMainServerId
} = require('./utils');

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

// Make the member's tier roles in this guild match `desiredTier` (null clears them).
// Returns true only if something actually changed, so callers can skip noisy logs.
async function applyTier(member, tierRoleIds, desiredTier) {
    if (!tierRoleIds) return false;

    const guild = member.guild;
    const toRemove = [];
    let toAdd = null;

    for (const tierName of TIER_ORDER) {
        const roleId = tierRoleIds[tierName];
        if (!roleId) continue;

        const has = member.roles.cache.has(roleId);
        if (tierName === desiredTier) {
            if (!has) toAdd = roleId;
        } else if (has) {
            toRemove.push(roleId);
        }
    }

    if (!toAdd && toRemove.length === 0) return false;

    let changed = false;

    // Remove first so an upgrade never leaves two tier roles on the member.
    if (toRemove.length > 0) {
        const removable = toRemove.filter(roleId => canManageRole(guild, roleId));

        if (removable.length !== toRemove.length) {
            console.error(`Cannot remove some tier roles from ${member.user.tag} in ${guild.name} - role hierarchy issue`);

            await sendStaffLog(guild.id, {
                color: LOG_COLORS.error,
                title: '⚠️ Tier Role Removal Blocked',
                description: `Some tier roles could not be removed from **${member.user.tag}** (<@${member.id}>) in ${guildLabel(guild.id)}, so their tiers are out of sync.`,
                fields: [
                    { name: 'Reason', value: 'The bot\'s highest role sits below one or more tier roles.' }
                ],
                footer: 'Move the bot\'s role above the tier roles in server settings.'
            });
        }

        if (removable.length > 0) {
            try {
                await member.roles.remove(removable, 'Cross-server tier sync');
                changed = true;
            } catch (error) {
                console.error(`Failed to remove tier roles from ${member.user.tag} in ${guild.name}:`, error);

                await sendStaffLog(guild.id, {
                    color: LOG_COLORS.error,
                    title: '⚠️ Tier Role Removal Failed',
                    description: `Could not remove tier roles from **${member.user.tag}** (<@${member.id}>) in ${guildLabel(guild.id)}, so their tiers are out of sync.`,
                    fields: [errorField(error)],
                    footer: 'The hourly reconciliation pass will retry.'
                });
            }
        }
    }

    if (toAdd) {
        if (!canManageRole(guild, toAdd)) {
            console.error(`Cannot assign tier role to ${member.user.tag} in ${guild.name} - role hierarchy issue`);

            await sendStaffLog(guild.id, {
                color: LOG_COLORS.error,
                title: '⚠️ Tier Role Grant Blocked',
                description: `Could not grant **${tierLabel(desiredTier)}** to **${member.user.tag}** (<@${member.id}>) in ${guildLabel(guild.id)}.`,
                fields: [
                    { name: 'Reason', value: 'The bot\'s highest role sits below that tier role.' }
                ],
                footer: 'Move the bot\'s role above the tier roles in server settings.'
            });
        } else {
            try {
                await member.roles.add(toAdd, 'Cross-server tier sync');
                changed = true;
            } catch (error) {
                console.error(`Failed to add tier role to ${member.user.tag} in ${guild.name}:`, error);

                await sendStaffLog(guild.id, {
                    color: LOG_COLORS.error,
                    title: '⚠️ Tier Role Grant Failed',
                    description: `Could not grant **${tierLabel(desiredTier)}** to **${member.user.tag}** (<@${member.id}>) in ${guildLabel(guild.id)}.`,
                    fields: [errorField(error)],
                    footer: 'The hourly reconciliation pass will retry.'
                });
            }
        }
    }

    return changed;
}

// Mirror a tier change on one main server onto the other.

async function handleGuildMemberUpdate(oldMember, newMember) {
    try {
        const guildId = newMember.guild.id;
        if (!isMainServer(guildId)) return;

        const myTiers = SERVER_CONFIGS[guildId]?.tierRoleIds;
        if (!myTiers) return;

        // A partial oldMember can't be diffed; fall through and let applyTier no-op if already in sync.
        const oldTier = oldMember.partial ? undefined : getMemberTier(oldMember, myTiers);
        const newTier = getMemberTier(newMember, myTiers);
        if (oldTier === newTier) return; // this update didn't touch tier roles

        const otherGuildId = otherMainServerId(guildId);
        const otherGuild = await resolveGuild(otherGuildId);
        if (!otherGuild) return;

        const otherMember = await otherGuild.members.fetch(newMember.id).catch(() => null);
        if (!otherMember) return; // not in the other server; the join handler will catch them later

        const changed = await applyTier(otherMember, SERVER_CONFIGS[otherGuildId].tierRoleIds, newTier);
        if (!changed) return;

        if (newTier) {
            console.log(`Synced tier ${newTier} to ${otherMember.user.tag} in ${otherGuild.name}`);

            await sendStaffLog(otherGuildId, {
                color: LOG_COLORS.tierGrant,
                title: '💎 Subscription Synced',
                description: `**${otherMember.user.tag}** (<@${otherMember.id}>) was granted **${tierLabel(newTier)}** in ${guildLabel(otherGuildId)}.`,
                fields: [
                    { name: 'Source', value: `Tier granted on ${guildLabel(guildId)}.` }
                ]
            });
        } else {
            console.log(`Removed tier roles from ${otherMember.user.tag} in ${otherGuild.name}`);

            await sendStaffLog(otherGuildId, {
                color: LOG_COLORS.tierRemove,
                title: '💔 Subscription Removed',
                description: `Tier roles were removed from **${otherMember.user.tag}** (<@${otherMember.id}>) in ${guildLabel(otherGuildId)}.`,
                fields: [
                    { name: 'Source', value: `Subscription ended on ${guildLabel(guildId)}.` }
                ]
            });
        }
    } catch (error) {
        console.error('Error in guildMemberUpdate event:', error);
    }
}

// Grant the tier someone already holds on the other main server when they join this one.
async function syncTierRolesOnJoin(member) {
    try {
        const guildId = member.guild.id;
        if (!isMainServer(guildId)) return;

        const otherGuildId = otherMainServerId(guildId);
        const otherGuild = await resolveGuild(otherGuildId);
        if (!otherGuild) return;

        const otherMember = await otherGuild.members.fetch(member.id).catch(() => null);
        if (!otherMember) return;

        const tier = getMemberTier(otherMember, SERVER_CONFIGS[otherGuildId]?.tierRoleIds);
        if (!tier) return;

        const changed = await applyTier(member, SERVER_CONFIGS[guildId].tierRoleIds, tier);
        if (!changed) return;

        console.log(`Granted tier ${tier} to ${member.user.tag} on join to ${member.guild.name}`);

        await sendStaffLog(guildId, {
            color: LOG_COLORS.tierGrant,
            title: '💎 Subscription Carried Over',
            description: `**${member.user.tag}** (<@${member.id}>) was granted **${tierLabel(tier)}** in ${guildLabel(guildId)} on join.`,
            fields: [
                { name: 'Source', value: `Already held on ${guildLabel(otherGuildId)}.` }
            ]
        });
    } catch (error) {
        console.error('Error syncing tier roles on join:', error);
    }
}

module.exports = {
    getMemberTier,
    applyTier,
    syncTierRolesOnJoin,
    handleGuildMemberUpdate,
};
