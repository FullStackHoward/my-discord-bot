// ---------------------------------------------------------------------------
// Feature C: hourly reconciliation
// ---------------------------------------------------------------------------

const {
    VG_GUILD_ID,
    VC_GUILD_ID,
    APP_GUILD_ID,
    SERVER_CONFIGS,
    LOG_COLORS,
    tierLabel
} = require('./config');
const { sendStaffLog, sendStaffLogToAllServers, errorField } = require('./staff-log');
const {
    resolveGuild,
    fetchAllMembers,
    canManageRole,
    hasStaffPermission,
    guildLabel
} = require('./utils');
const { getMemberTier, applyTier } = require('./tier-sync');
const { isVerifiedElsewhere, maybeKickFromApplicationServer } = require('./verification');

let reconciliationRunning = false;

async function runReconciliation() {
    if (reconciliationRunning) {
        console.log('Reconciliation already running, skipping this pass.');
        return;
    }

    reconciliationRunning = true;

    try {
        // One full member fetch per guild, shared by both passes, instead of a
        // per-member fetch for every candidate.
        const guildMembers = new Map();

        for (const serverId of Object.keys(SERVER_CONFIGS)) {
            const guild = await resolveGuild(serverId);
            if (!guild) {
                console.log(`Guild ${serverId} not available for reconciliation`);
                continue;
            }

            let members = null;

            try {
                members = await fetchAllMembers(guild);
            } catch (error) {
                console.error(`Failed to fetch members for ${guild.name}:`, error);

                await sendStaffLog(serverId, {
                    color: LOG_COLORS.error,
                    title: '⚠️ Reconciliation Skipped',
                    description: `Could not fetch the member list for ${guildLabel(serverId)}, so this reconciliation pass skipped that server.`,
                    fields: [errorField(error)],
                    footer: 'The next pass retries in an hour.'
                });
            }

            if (members) {
                guildMembers.set(serverId, { guild, members });
            }
        }

        await reconcileMissingRoles(guildMembers);
        await reconcileTierRoles(guildMembers);
        await reconcileStaleApplicationServerMembers(guildMembers);
    } catch (error) {
        console.error('Error during reconciliation sweep:', error);

        await sendStaffLogToAllServers({
            color: LOG_COLORS.error,
            title: '⚠️ Reconciliation Sweep Failed',
            description: 'The reconciliation sweep stopped early, so some corrections may have been missed across the servers.',
            fields: [errorField(error)],
            footer: 'The next pass retries in an hour.'
        });
    } finally {
        reconciliationRunning = false;
    }
}

// Anyone accepted elsewhere but sitting without the verified role here - the
// same set as "stuck in the waiting room", since that channel is only visible
// to members lacking the verified role (see WAITING_ROOM_CHANNELS).
async function reconcileMissingRoles(guildMembers) {
    for (const guildId of [VG_GUILD_ID, VC_GUILD_ID]) {
        const entry = guildMembers.get(guildId);
        if (!entry) continue;

        const { guild, members } = entry;
        const config = SERVER_CONFIGS[guildId];

        const verifiedRole = guild.roles.cache.get(config.verifiedRoleId);
        if (!verifiedRole) {
            console.error(`Verified role not found for server ${guildId}, skipping reconciliation`);

            await sendStaffLog(guildId, {
                color: LOG_COLORS.error,
                title: '⚠️ Reconciliation Skipped',
                description: `The verified role configured for ${guildLabel(guildId)} no longer exists, so missing-role reconciliation was skipped.`,
                footer: 'Check the verified role ID in the bot config.'
            });
            continue;
        }

        if (!canManageRole(guild, config.verifiedRoleId)) {
            console.error(`Cannot assign the verified role in ${guild.name} - role hierarchy issue`);

            await sendStaffLog(guildId, {
                color: LOG_COLORS.error,
                title: '⚠️ Reconciliation Skipped',
                description: `The bot cannot assign the verified role in ${guildLabel(guildId)}, so missing-role reconciliation was skipped.`,
                fields: [
                    { name: 'Reason', value: 'The bot\'s highest role sits below the verified role.' }
                ],
                footer: 'Move the bot\'s role above the verified role in server settings.'
            });
            continue;
        }

        for (const member of members.values()) {
            if (member.user.bot) continue;
            if (member.id === guild.ownerId) continue;
            // Staff intentionally lack the verified role; skipping them keeps the log quiet.
            if (hasStaffPermission(member, member.id, config)) continue;
            if (member.roles.cache.has(config.verifiedRoleId)) continue;

            if (!isVerifiedElsewhere(member.id, guildId, guildMembers)) continue;

            try {
                await member.roles.add(verifiedRole, 'Reconciliation: verified in another Vice Community server');
            } catch (error) {
                console.error(`Reconciliation grant failed for ${member.user.tag}:`, error);

                await sendStaffLog(guildId, {
                    color: LOG_COLORS.error,
                    title: '⚠️ Reconciliation Grant Failed',
                    description: `**${member.user.tag}** (<@${member.id}>) is verified elsewhere but the verified role could not be granted to them in ${guildLabel(guildId)}.`,
                    fields: [errorField(error)],
                    footer: 'The next pass retries in an hour.'
                });
                continue;
            }

            console.log(`Reconciliation: corrected missing role for ${member.user.tag} in ${guild.name}`);

            await sendStaffLog(guildId, {
                color: LOG_COLORS.reconciliation,
                title: '🔄 Reconciliation: Verified Role Corrected',
                description: `**${member.user.tag}** (<@${member.id}>) was missing the verified role in ${guildLabel(guildId)} and has now been granted it.`,
                fields: [
                    { name: 'Reason', value: 'Already verified in another Vice Community server.' }
                ]
            });

            // Catches Feature A cases the live handlers missed.
            await maybeKickFromApplicationServer(member.id, guildId);
        }
    }
}

async function reconcileTierRoles(guildMembers) {
    const vgEntry = guildMembers.get(VG_GUILD_ID);
    const vcEntry = guildMembers.get(VC_GUILD_ID);
    if (!vgEntry || !vcEntry) return;

    const vgTiers = SERVER_CONFIGS[VG_GUILD_ID].tierRoleIds;
    const vcTiers = SERVER_CONFIGS[VC_GUILD_ID].tierRoleIds;

    for (const vgMember of vgEntry.members.values()) {
        if (vgMember.user.bot) continue;

        const vcMember = vcEntry.members.get(vgMember.id);
        if (!vcMember) continue; // not in both servers, nothing to reconcile

        const vgTier = getMemberTier(vgMember, vgTiers);
        const vcTier = getMemberTier(vcMember, vcTiers);

        if (vgTier === vcTier) continue; // in sync, including the no-subscription case

        if (vgTier && !vcTier) {
            if (await applyTier(vcMember, vcTiers, vgTier)) {
                console.log(`Reconciliation: synced tier ${vgTier} to ${vcMember.user.tag} in Vice Creators`);

                await sendStaffLog(VC_GUILD_ID, {
                    color: LOG_COLORS.reconciliation,
                    title: '🔄 Reconciliation: Subscription Synced',
                    description: `**${vcMember.user.tag}** (<@${vcMember.id}>) was granted **${tierLabel(vgTier)}** in Vice Creators.`,
                    fields: [
                        { name: 'Source', value: 'Already held on Vice Gamers.' }
                    ]
                });
            }
        } else if (vcTier && !vgTier) {
            if (await applyTier(vgMember, vgTiers, vcTier)) {
                console.log(`Reconciliation: synced tier ${vcTier} to ${vgMember.user.tag} in Vice Gamers`);

                await sendStaffLog(VG_GUILD_ID, {
                    color: LOG_COLORS.reconciliation,
                    title: '🔄 Reconciliation: Subscription Synced',
                    description: `**${vgMember.user.tag}** (<@${vgMember.id}>) was granted **${tierLabel(vcTier)}** in Vice Gamers.`,
                    fields: [
                        { name: 'Source', value: 'Already held on Vice Creators.' }
                    ]
                });
            }
        } else {
            // Both sides have a tier and they disagree. Never auto-corrected:
            // guessing either upgrades someone for free or downgrades a paying member.
            const mismatchLog = {
                color: LOG_COLORS.mismatch,
                title: '⚠️ Subscription Mismatch',
                description: `**${vgMember.user.tag}** (<@${vgMember.id}>) holds a different tier on each main server. Nothing was changed - this needs manual review.`,
                fields: [
                    { name: 'Vice Gamers', value: tierLabel(vgTier), inline: true },
                    { name: 'Vice Creators', value: tierLabel(vcTier), inline: true }
                ],
                footer: 'Auto-correcting would either upgrade someone for free or downgrade a paying member.'
            };

            console.warn(`Tier mismatch for ${vgMember.user.tag}: ${vgTier} (VG) vs ${vcTier} (VC)`);
            await sendStaffLog(VG_GUILD_ID, mismatchLog);
            await sendStaffLog(VC_GUILD_ID, mismatchLog);
        }
    }
}

// Anyone still sitting in the Application Server, holding the Accepted role,
// who is ALREADY verified in Vice Gamers or Vice Creators. reconcileMissingRoles
// doesn't catch this case: it only grants roles that are missing, so it has no
// reason to look at someone who's already fully verified elsewhere. This is
// the only thing that catches it after the fact if the live kick in
// maybeKickFromApplicationServer ever fails, gets skipped, or never had a
// reason to fire in the first place.
async function reconcileStaleApplicationServerMembers(guildMembers) {
    const appConfig = SERVER_CONFIGS[APP_GUILD_ID];
    const appEntry = guildMembers.get(APP_GUILD_ID);
    if (!appConfig || !appConfig.verifiedRoleId || !appEntry) return;

    for (const appMember of appEntry.members.values()) {
        if (appMember.user.bot) continue;
        if (appMember.id === appEntry.guild.ownerId) continue;
        if (hasStaffPermission(appMember, appMember.id, appConfig)) continue;
        if (!appMember.roles.cache.has(appConfig.verifiedRoleId)) continue;

        for (const mainGuildId of [VG_GUILD_ID, VC_GUILD_ID]) {
            const mainEntry = guildMembers.get(mainGuildId);
            if (!mainEntry) continue;

            const mainMember = mainEntry.members.get(appMember.id);
            if (mainMember && mainMember.roles.cache.has(SERVER_CONFIGS[mainGuildId].verifiedRoleId)) {
                console.log(`Reconciliation: found stale Application Server membership for ${appMember.user.tag}, already verified on ${guildLabel(mainGuildId)}`);
                await maybeKickFromApplicationServer(appMember.id, mainGuildId);
                break;
            }
        }
    }
}

module.exports = {
    runReconciliation,
    reconcileMissingRoles,
    reconcileTierRoles,
    reconcileStaleApplicationServerMembers,
};
