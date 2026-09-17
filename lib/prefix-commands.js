// The original !verify / !announce prefix commands. These run alongside the slash
// command versions; the two systems are independent by design.

const { SERVER_CONFIGS, LOG_COLORS } = require('./config');
const { sendStaffLog } = require('./staff-log');
const { hasStaffPermission, canManageRole, guildLabel } = require('./utils');
const { maybeKickFromApplicationServer, autoVerifyInOtherServers } = require('./verification');
const { postAnnouncement } = require('./announcements');

async function handleMessageCreate(message) {
    if (message.author.bot) return;

    // !verify command
    if (message.content.startsWith('!verify')) {
        try {
            const guildId = message.guild.id;
            const serverConfig = SERVER_CONFIGS[guildId];

            if (!serverConfig) {
                return message.reply('❌ This bot is not configured for this server.');
            }

            if (!hasStaffPermission(message.member, message.author.id, serverConfig)) {
                return message.reply('❌ You don\'t have permission to verify users.');
            }

            const targetUser = message.mentions.members.first();
            if (!targetUser) {
                return message.reply('❌ Please mention a user to verify. Usage: `!verify @user`');
            }

            const verifiedRole = message.guild.roles.cache.get(serverConfig.verifiedRoleId);
            if (!verifiedRole) {
                return message.reply('❌ Verified role not found. Please check the role ID configuration for this server.');
            }

            if (!canManageRole(message.guild, serverConfig.verifiedRoleId)) {
                return message.reply('❌ I cannot assign this role. My role must be positioned above the verified role in server settings.');
            }

            if (targetUser.roles.cache.has(serverConfig.verifiedRoleId)) {
                return message.reply(`❌ ${targetUser.user.tag} is already verified.`);
            }

            await targetUser.roles.add(verifiedRole);
            message.reply(`✅ ${targetUser.user.tag} has been verified!`);
            console.log(`${message.author.tag} verified ${targetUser.user.tag} in ${message.guild.name} (${guildId})`);

            await sendStaffLog(guildId, {
                color: LOG_COLORS.verifyManual,
                title: '✅ Manually Verified',
                description: `**${targetUser.user.tag}** (<@${targetUser.id}>) was verified in ${guildLabel(guildId)}.`,
                fields: [
                    { name: 'Verified By', value: `**${message.author.tag}** (<@${message.author.id}>)` }
                ]
            });

            await maybeKickFromApplicationServer(targetUser.user.id, guildId);
            await autoVerifyInOtherServers(targetUser.user.id, guildId);

        } catch (error) {
            console.error('Error during verification:', error);
            message.reply('❌ An error occurred while verifying the user. Please check bot permissions.');
        }
    }

    // !announce command
    if (message.content.startsWith('!announce')) {
        if (message.author.id !== process.env.VICER_ADMIN) {
            return message.reply('❌ You do not have permission to post announcements.');
        }

        // Usage: !announce Title | Content | optional link
        const args = message.content.slice('!announce '.length).split('|').map(s => s.trim());

        if (args.length < 2) {
            return message.reply('❌ Correct usage: `!announce Title | Content | optional link`');
        }

        const title = args[0];
        const content = args[1];
        const link = args[2] || null;

        try {
            await postAnnouncement(title, content, link);
            message.reply(`✅ Announcement posted successfully!`);
        } catch (error) {
            console.error('Error posting announcement:', error);
            message.reply(`❌ Failed to post announcement. Error: ${error.message}`);
        }
    }
}

module.exports = {
    handleMessageCreate,
};
