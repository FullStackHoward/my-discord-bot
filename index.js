require('dotenv').config();

const { Client, GatewayIntentBits, PermissionFlagsBits } = require('discord.js');

// Create a new client instance
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

// Configuration - Replace these with your actual IDs
const BOT_TOKEN = process.env.BOT_TOKEN;
const VG_GUILD_ID = process.env.VG_GUILD_ID;
const VC_GUILD_ID = process.env.VC_GUILD_ID;
const APP_GUILD_ID = process.env.APP_GUILD_ID;

// Server-specific configurations
const SERVER_CONFIGS = {};

SERVER_CONFIGS[VG_GUILD_ID] = {
    verifiedRoleId: process.env.VG_VERIFIED_ROLE,
    staffRoleIds: [
        process.env.VG_STAFF_ROLE_1,
        process.env.VG_STAFF_ROLE_2
    ].filter(Boolean),
    staffUserIds: [
        process.env.VG_STAFF_USER_1,
        process.env.VG_STAFF_USER_2
    ].filter(Boolean)
};

SERVER_CONFIGS[VC_GUILD_ID] = {
    verifiedRoleId: process.env.VC_VERIFIED_ROLE,
    staffRoleIds: [
        process.env.VC_STAFF_ROLE_1,
        process.env.VC_STAFF_ROLE_2
    ].filter(Boolean),
    staffUserIds: [
        process.env.VC_STAFF_USER_1,
        process.env.VC_STAFF_USER_2
    ].filter(Boolean)
};

SERVER_CONFIGS[APP_GUILD_ID] = {
    verifiedRoleId: process.env.APP_VERIFIED_ROLE,
    staffRoleIds: [
        process.env.APP_STAFF_ROLE_1
    ].filter(Boolean),
    staffUserIds: [
        process.env.APP_STAFF_USER_1
    ].filter(Boolean)
};

// Bot ready event
client.once('ready', () => {
    console.log(`${client.user.tag} is now online and ready!`);
    console.log(`Configured for ${Object.keys(SERVER_CONFIGS).length} server(s)`);
});

// Handle member joining a server
client.on('guildMemberAdd', async (member) => {
    try {
        const guildId = member.guild.id;
        const serverConfig = SERVER_CONFIGS[guildId];

        // Only process if this is a configured server
        if (!serverConfig) {
            console.log(`Member joined unconfigured server: ${guildId}`);
            return;
        }

        console.log(`${member.user.tag} joined ${member.guild.name} (${guildId})`);

        // Check if user should be auto-verified and from which server
        const verificationSource = await checkAutoVerificationSource(member.user.id, guildId);

        if (verificationSource.shouldVerify) {
            // Get the verified role for this server
            const verifiedRole = member.guild.roles.cache.get(serverConfig.verifiedRoleId);

            if (!verifiedRole) {
                console.error(`Verified role not found for server ${guildId}`);
                return;
            }

            // Check bot's permissions and role hierarchy
            const botMember = member.guild.members.cache.get(client.user.id);
            if (verifiedRole.position >= botMember.roles.highest.position) {
                console.error(`Cannot assign role in ${member.guild.name} - role hierarchy issue`);
                return;
            }

            // Assign the verified role
            await member.roles.add(verifiedRole);
            console.log(`Auto-verified ${member.user.tag} in ${member.guild.name}`);

            // Send appropriate DM based on where they're coming from
            try {
                let dmMessage = '';

                if (verificationSource.fromServer3) {
                    // User is coming from Server 3 (application server)
                    dmMessage = `🎉 **Welcome to The Vice Community!** 🎉\n\n` +
                        `Congratulations on becoming an official member! Your application has been accepted, ` +
                        `and you've been automatically verified in **${member.guild.name}**.\n\n` +
                        `We're thrilled to have you join our community. Enjoy your stay and feel free to ` +
                        `explore all the channels and connect with fellow members!\n\n` +
                        `Welcome aboard! 🚀`;
                } else if (verificationSource.fromOtherMainServer) {
                    // User is coming from Server 1 to Server 2 or vice versa
                    dmMessage = `✅ You've been automatically verified in **${member.guild.name}** based on your verification status in another Vice Community server.`;
                }

                // Only send DM if we have a message to send
                if (dmMessage) {
                    await member.send(dmMessage);
                }
            } catch (dmError) {
                // User might have DMs disabled, that's okay
                console.log(`Could not send DM to ${member.user.tag}`);
            }
        }
    } catch (error) {
        console.error('Error in guildMemberAdd event:', error);
    }
});

// Function to check if a user should be auto-verified and identify the source
async function checkAutoVerificationSource(userId, joinedGuildId) {
    try {
        let fromServer3 = false;
        let fromOtherMainServer = false;
        let shouldVerify = false;

        // Define which servers are the main servers (Vice Gamers and Vice Creators)
        const mainServers = [VG_GUILD_ID, VC_GUILD_ID];
        const server3Id = APP_GUILD_ID;

        // Iterate through all configured servers
        for (const [serverId, config] of Object.entries(SERVER_CONFIGS)) {
            // Skip the server they just joined
            if (serverId === joinedGuildId) continue;

            // Try to get the guild
            const guild = client.guilds.cache.get(serverId);
            if (!guild) {
                console.log(`Guild ${serverId} not found in cache`);
                continue;
            }

            // Try to get the member in that guild
            try {
                const member = await guild.members.fetch(userId);

                // Check if the member has the verified role in that guild
                if (member && member.roles.cache.has(config.verifiedRoleId)) {
                    console.log(`User ${userId} is verified in ${guild.name}`);
                    shouldVerify = true;

                    // Determine the source
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
        return { shouldVerify: false, fromServer3: false, fromOtherMainServer: false };
    }
}

// Message handler (existing !verify command)
client.on('messageCreate', async (message) => {
    // Ignore bot messages and messages that don't start with !verify
    if (message.author.bot || !message.content.startsWith('!verify')) return;

    try {
        // Get server configuration
        const guildId = message.guild.id;
        const serverConfig = SERVER_CONFIGS[guildId];

        if (!serverConfig) {
            return message.reply('❌ This bot is not configured for this server.');
        }

        // Check if user has permission
        if (!hasStaffPermission(message.member, message.author.id, serverConfig)) {
            return message.reply('❌ You don\'t have permission to verify users.');
        }

        // Check if user mentioned someone
        const targetUser = message.mentions.members.first();
        if (!targetUser) {
            return message.reply('❌ Please mention a user to verify. Usage: `!verify @user`');
        }

        // Get the verified role for this server
        const verifiedRole = message.guild.roles.cache.get(serverConfig.verifiedRoleId);
        if (!verifiedRole) {
            return message.reply('❌ Verified role not found. Please check the role ID configuration for this server.');
        }

        // Check bot's permissions and role hierarchy
        const botMember = message.guild.members.cache.get(client.user.id);
        if (verifiedRole.position >= botMember.roles.highest.position) {
            return message.reply('❌ I cannot assign this role. My role must be positioned above the verified role in server settings.');
        }

        // Check if user already has the role
        if (targetUser.roles.cache.has(serverConfig.verifiedRoleId)) {
            return message.reply(`❌ ${targetUser.user.tag} is already verified.`);
        }

        // Assign the verified role
        await targetUser.roles.add(verifiedRole);

        // Success message
        message.reply(`✅ ${targetUser.user.tag} has been verified!`);

        // Log the verification
        console.log(`${message.author.tag} verified ${targetUser.user.tag} in ${message.guild.name} (${guildId})`);

        // Check if we should auto-verify this user in other servers they're in
        await autoVerifyInOtherServers(targetUser.user.id, guildId);

    } catch (error) {
        console.error('Error during verification:', error);
        message.reply('❌ An error occurred while verifying the user. Please check bot permissions.');
    }
});

// Function to auto-verify user in other servers after manual verification
async function autoVerifyInOtherServers(userId, verifiedInGuildId) {
    try {
        for (const [serverId, config] of Object.entries(SERVER_CONFIGS)) {
            // Skip the server where they were just verified
            if (serverId === verifiedInGuildId) continue;

            const guild = client.guilds.cache.get(serverId);
            if (!guild) continue;

            try {
                const member = await guild.members.fetch(userId);

                // If they're in the server but not verified, verify them
                if (member && !member.roles.cache.has(config.verifiedRoleId)) {
                    const verifiedRole = guild.roles.cache.get(config.verifiedRoleId);

                    if (verifiedRole) {
                        const botMember = guild.members.cache.get(client.user.id);
                        if (verifiedRole.position < botMember.roles.highest.position) {
                            await member.roles.add(verifiedRole);
                            console.log(`Auto-verified ${member.user.tag} in ${guild.name} after manual verification`);
                        }
                    }
                }
            } catch (fetchError) {
                // User is not in this guild, continue

            }
        }
    } catch (error) {
        console.error('Error auto-verifying in other servers:', error);
    }
}

// Permission check function
function hasStaffPermission(member, userId, serverConfig) {
    // Check if user ID is in server's staff list
    if (serverConfig.staffUserIds.includes(userId)) {
        return true;
    }

    // Check if user has any of the server's staff roles
    return serverConfig.staffRoleIds.some(roleId => member.roles.cache.has(roleId));
}

// Error handling
client.on('error', error => {
    console.error('Client error:', error);
});

process.on('unhandledRejection', error => {
    console.error('Unhandled promise rejection:', error);
});

// Login to Discord
client.login(BOT_TOKEN);