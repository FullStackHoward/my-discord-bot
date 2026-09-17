// Verification: who gets the verified role, and the Application Server exit that
// follows from it (Feature A).

const { MessageFlags } = require('discord.js');
const { APP_GUILD_ID, SERVER_CONFIGS, LOG_COLORS } = require('./config');
const { sendStaffLog, errorField } = require('./staff-log');
const {
    resolveGuild,
    canManageRole,
    hasStaffPermission,
    guildLabel,
    isMainServer,
    respondWithError
} = require('./utils');
const { syncTierRolesOnJoin } = require('./tier-sync');

// Handle member joining a server

async function handleGuildMemberAdd(member) {
    // Hoisted out of the try so the catch below knows which log channel to use.
    const guildId = member.guild.id;

    try {
        const serverConfig = SERVER_CONFIGS[guildId];

        if (!serverConfig) {
            console.log(`Member joined unconfigured server: ${guildId}`);
            return;
        }

        console.log(`${member.user.tag} joined ${member.guild.name} (${guildId})`);

        await sendStaffLog(guildId, {
            color: LOG_COLORS.join,
            title: '📥 Member Joined',
            description: `**${member.user.tag}** (<@${member.id}>) joined ${guildLabel(guildId)}.`,
            fields: [
                { name: 'Account Created', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true },
                { name: 'Member Count', value: `${member.guild.memberCount}`, inline: true }
            ]
        });

        const verificationSource = await checkAutoVerificationSource(member.user.id, guildId);

        if (verificationSource.shouldVerify && canManageRole(member.guild, serverConfig.verifiedRoleId)) {
            const verifiedRole = member.guild.roles.cache.get(serverConfig.verifiedRoleId);

            await member.roles.add(verifiedRole);
            console.log(`Auto-verified ${member.user.tag} in ${member.guild.name}`);

            let verificationBasis;
            if (verificationSource.fromServer3) {
                verificationBasis = 'an accepted application on the Application Server';
            } else if (verificationSource.fromOtherMainServer) {
                verificationBasis = 'being verified on the other main server';
            } else {
                verificationBasis = 'being verified in another Vice Community server';
            }

            await sendStaffLog(guildId, {
                color: LOG_COLORS.verifyAuto,
                title: '✅ Auto-Verified',
                description: `**${member.user.tag}** (<@${member.id}>) was auto-verified in ${guildLabel(guildId)} on join.`,
                fields: [
                    { name: 'Source', value: `Verified from ${verificationBasis}.` }
                ]
            });

            await maybeKickFromApplicationServer(member.user.id, guildId);

            try {
                let dmMessage = '';

                if (verificationSource.fromServer3) {
                    dmMessage = `🎉 **Welcome to The Vice Community!** 🎉\n\n` +
                        `Congratulations on becoming an official member! Your application has been accepted, ` +
                        `and you've been automatically verified in **${member.guild.name}**.\n\n` +
                        `We're thrilled to have you join our community. Enjoy your stay and feel free to ` +
                        `explore all the channels and connect with fellow members!\n\n` +
                        `Welcome aboard! 🚀`;
                } else if (verificationSource.fromOtherMainServer) {
                    dmMessage = `✅ You've been automatically verified in **${member.guild.name}** based on your verification status in another Vice Community server.`;
                }

                if (dmMessage) {
                    await member.send(dmMessage);
                }
            } catch (dmError) {
                console.log(`Could not send DM to ${member.user.tag}`);
            }
        } else if (verificationSource.shouldVerify) {
            console.error(`Cannot auto-verify ${member.user.tag} in ${member.guild.name} - missing verified role or role hierarchy issue`);

            await sendStaffLog(guildId, {
                color: LOG_COLORS.error,
                title: '⚠️ Auto-Verify Failed',
                description: `**${member.user.tag}** (<@${member.id}>) should have been auto-verified in ${guildLabel(guildId)}, but the role could not be granted.`,
                fields: [
                    { name: 'Reason', value: 'The verified role is missing, or the bot\'s highest role sits below it.' }
                ],
                footer: 'Fix the role setup, then verify this member manually with !verify.'
            });
        }

        // Independent of verification: carry any subscription tier over from the other main server.
        await syncTierRolesOnJoin(member);
    } catch (error) {
        console.error('Error in guildMemberAdd event:', error);

        await sendStaffLog(guildId, {
            color: LOG_COLORS.error,
            title: '⚠️ Join Handler Failed',
            description: `Something went wrong while processing **${member.user.tag}** (<@${member.id}>) joining ${guildLabel(guildId)}. They may not have been verified or given their tier roles.`,
            fields: [errorField(error)],
            footer: 'The hourly reconciliation pass will retry anything that was missed.'
        });
    }
}

// Function to check if a user should be auto-verified and identify the source
async function checkAutoVerificationSource(userId, joinedGuildId) {
    try {
        let fromServer3 = false;
        let fromOtherMainServer = false;
        let shouldVerify = false;

        const mainServers = [process.env.VG_GUILD_ID, process.env.VC_GUILD_ID];
        const server3Id = process.env.APP_GUILD_ID;

        for (const [serverId, config] of Object.entries(SERVER_CONFIGS)) {
            if (serverId === joinedGuildId) continue;

            const guild = await resolveGuild(serverId);
            if (!guild) {
                console.log(`Guild ${serverId} not found`);
                continue;
            }

            try {
                const member = await guild.members.fetch(userId);

                if (member && member.roles.cache.has(config.verifiedRoleId)) {
                    console.log(`User ${userId} is verified in ${guild.name}`);
                    shouldVerify = true;

                    if (serverId === server3Id) {
                        fromServer3 = true;
                    } else if (mainServers.includes(serverId) && mainServers.includes(joinedGuildId)) {
                        fromOtherMainServer = true;
                    }
                }
            } catch (fetchError) {
                // User is not in this guild, continue checking others
            }
        }

        return {
            shouldVerify,
            fromServer3,
            fromOtherMainServer
        };
    } catch (error) {
        console.error('Error checking auto-verification:', error);

        await sendStaffLog(joinedGuildId, {
            color: LOG_COLORS.error,
            title: '⚠️ Verification Check Failed',
            description: `Could not work out whether <@${userId}> should be auto-verified in ${guildLabel(joinedGuildId)}, so they were left unverified.`,
            fields: [errorField(error)],
            footer: 'The hourly reconciliation pass will retry.'
        });

        return { shouldVerify: false, fromServer3: false, fromOtherMainServer: false };
    }
}

// Slash-command form of !verify. Same checks, same order, same downstream calls.
async function handleVerifyCommand(interaction) {
    try {
        const guildId = interaction.guildId;
        const serverConfig = SERVER_CONFIGS[guildId];

        if (!serverConfig) {
            return interaction.reply({ content: '❌ This bot is not configured for this server.', flags: MessageFlags.Ephemeral });
        }

        if (!hasStaffPermission(interaction.member, interaction.user.id, serverConfig)) {
            return interaction.reply({ content: '❌ You don\'t have permission to verify users.', flags: MessageFlags.Ephemeral });
        }

        // Unlike a mention, the user option can resolve someone who isn't in this server.
        const targetUser = interaction.options.getMember('user');
        if (!targetUser) {
            return interaction.reply({ content: '❌ That user is not a member of this server.', flags: MessageFlags.Ephemeral });
        }

        const verifiedRole = interaction.guild.roles.cache.get(serverConfig.verifiedRoleId);
        if (!verifiedRole) {
            return interaction.reply({ content: '❌ Verified role not found. Please check the role ID configuration for this server.', flags: MessageFlags.Ephemeral });
        }

        if (!canManageRole(interaction.guild, serverConfig.verifiedRoleId)) {
            return interaction.reply({ content: '❌ I cannot assign this role. My role must be positioned above the verified role in server settings.', flags: MessageFlags.Ephemeral });
        }

        if (targetUser.roles.cache.has(serverConfig.verifiedRoleId)) {
            return interaction.reply({ content: `❌ ${targetUser.user.tag} is already verified.`, flags: MessageFlags.Ephemeral });
        }

        await targetUser.roles.add(verifiedRole);
        // Public, like the old message.reply, so the rest of staff sees the action.
        await interaction.reply(`✅ ${targetUser.user.tag} has been verified!`);
        console.log(`${interaction.user.tag} verified ${targetUser.user.tag} in ${interaction.guild.name} (${guildId})`);

        await sendStaffLog(guildId, {
            color: LOG_COLORS.verifyManual,
            title: '✅ Manually Verified',
            description: `**${targetUser.user.tag}** (<@${targetUser.id}>) was verified in ${guildLabel(guildId)}.`,
            fields: [
                { name: 'Verified By', value: `**${interaction.user.tag}** (<@${interaction.user.id}>)` }
            ]
        });

        await maybeKickFromApplicationServer(targetUser.user.id, guildId);
        await autoVerifyInOtherServers(targetUser.user.id, guildId);

    } catch (error) {
        console.error('Error during verification:', error);
        await respondWithError(interaction, '❌ An error occurred while verifying the user. Please check bot permissions.');
    }
}

// Function to auto-verify user in other servers after manual verification
async function autoVerifyInOtherServers(userId, verifiedInGuildId) {
    try {
        for (const [serverId, config] of Object.entries(SERVER_CONFIGS)) {
            if (serverId === verifiedInGuildId) continue;

            const guild = await resolveGuild(serverId);
            if (!guild) continue;

            try {
                const member = await guild.members.fetch(userId);

                if (member && !member.roles.cache.has(config.verifiedRoleId) && canManageRole(guild, config.verifiedRoleId)) {
                    const verifiedRole = guild.roles.cache.get(config.verifiedRoleId);

                    await member.roles.add(verifiedRole);
                    console.log(`Auto-verified ${member.user.tag} in ${guild.name} after manual verification`);

                    await sendStaffLog(serverId, {
                        color: LOG_COLORS.verifyAuto,
                        title: '✅ Auto-Verified',
                        description: `**${member.user.tag}** (<@${member.id}>) was auto-verified in ${guildLabel(serverId)}.`,
                        fields: [
                            { name: 'Source', value: `Manually verified on ${guildLabel(verifiedInGuildId)}.` }
                        ]
                    });

                    await maybeKickFromApplicationServer(userId, serverId);
                }
            } catch (fetchError) {
                // User is not in this guild, continue
            }
        }
    } catch (error) {
        console.error('Error auto-verifying in other servers:', error);
    }
}

// ---------------------------------------------------------------------------
// Feature A: leave the Application Server once access is confirmed elsewhere
// ---------------------------------------------------------------------------

async function maybeKickFromApplicationServer(userId, guildIdJustVerifiedIn) {
    try {
        // Only relevant once someone has been verified in a MAIN server.
        if (!isMainServer(guildIdJustVerifiedIn)) return;

        const appConfig = SERVER_CONFIGS[APP_GUILD_ID];
        if (!appConfig || !appConfig.verifiedRoleId) return;

        const appGuild = await resolveGuild(APP_GUILD_ID);
        if (!appGuild) return;

        const appMember = await appGuild.members.fetch(userId).catch(() => null);
        if (!appMember) return; // already gone, or never joined - nothing to do

        // Not accepted on the Application Server, so this isn't a completed application cycle.
        if (!appMember.roles.cache.has(appConfig.verifiedRoleId)) return;

        // Never kick staff or the owner: they hold the verified role for their own access.
        if (appMember.id === appGuild.ownerId) return;
        if (hasStaffPermission(appMember, appMember.id, appConfig)) return;

        if (!appMember.kickable) {
            console.error(`Cannot kick ${appMember.user.tag} from the Application Server - missing permission or role hierarchy issue`);

            await sendStaffLog(APP_GUILD_ID, {
                color: LOG_COLORS.error,
                title: '⚠️ Auto-Kick Failed',
                description: `**${appMember.user.tag}** (<@${appMember.id}>) could not be removed from the Application Server after being verified on ${guildLabel(guildIdJustVerifiedIn)}.`,
                fields: [
                    { name: 'Reason', value: 'Missing the Kick Members permission, or the bot\'s highest role sits below theirs.' }
                ],
                footer: 'Remove this member manually once the permission or role position is fixed.'
            });
            return;
        }

        await appMember.kick('Verified in a main Vice Community server - application cycle complete');
        console.log(`Kicked ${appMember.user.tag} from Application Server after verification in ${guildLabel(guildIdJustVerifiedIn)}`);

        await sendStaffLog(APP_GUILD_ID, {
            color: LOG_COLORS.kick,
            title: '👢 Auto-Kicked from Application Server',
            description: `**${appMember.user.tag}** (<@${appMember.id}>) was removed from the Application Server.`,
            fields: [
                { name: 'Reason', value: `Verified on ${guildLabel(guildIdJustVerifiedIn)} - application cycle complete.` }
            ]
        });
    } catch (error) {
        console.error(`Could not kick ${userId} from Application Server:`, error);

        await sendStaffLog(APP_GUILD_ID, {
            color: LOG_COLORS.error,
            title: '⚠️ Auto-Kick Error',
            description: `An error occurred while removing <@${userId}> from the Application Server after they were verified on ${guildLabel(guildIdJustVerifiedIn)}.`,
            fields: [errorField(error)],
            footer: 'Check whether this member is still on the Application Server.'
        });
    }
}

// In-memory equivalent of checkAutoVerificationSource, using the member lists
// already fetched for this sweep.
function isVerifiedElsewhere(userId, currentGuildId, guildMembers) {
    for (const [serverId, entry] of guildMembers.entries()) {
        if (serverId === currentGuildId) continue;

        const member = entry.members.get(userId);
        if (member && member.roles.cache.has(SERVER_CONFIGS[serverId].verifiedRoleId)) {
            return true;
        }
    }
    return false;
}

module.exports = {
    handleGuildMemberAdd,
    checkAutoVerificationSource,
    handleVerifyCommand,
    autoVerifyInOtherServers,
    maybeKickFromApplicationServer,
    isVerifiedElsewhere,
};
