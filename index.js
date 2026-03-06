require('dotenv').config();

const https = require('https');
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

// Configuration pulled from .env
const BOT_TOKEN = process.env.BOT_TOKEN;

const VG_GUILD_ID = process.env.VG_GUILD_ID;
const VC_GUILD_ID = process.env.VC_GUILD_ID;
const APP_GUILD_ID = process.env.APP_GUILD_ID;

const SERVER_CONFIGS = {};

SERVER_CONFIGS[VG_GUILD_ID] = {
    verifiedRoleId: process.env.VG_VERIFIED_ROLE,
    staffRoleIds: [
        process.env.VG_STAFF_ROLE_1,
        process.env.VG_STAFF_ROLE_2
    ],
    staffUserIds: [
        process.env.VG_STAFF_USER_1,
        process.env.VG_STAFF_USER_2
    ]
};

SERVER_CONFIGS[VC_GUILD_ID] = {
    verifiedRoleId: process.env.VC_VERIFIED_ROLE,
    staffRoleIds: [
        process.env.VC_STAFF_ROLE_1,
        process.env.VC_STAFF_ROLE_2
    ],
    staffUserIds: [
        process.env.VC_STAFF_USER_1,
        process.env.VC_STAFF_USER_2
    ]
};

SERVER_CONFIGS[APP_GUILD_ID] = {
    verifiedRoleId: process.env.APP_VERIFIED_ROLE,
    staffRoleIds: [
        process.env.APP_STAFF_ROLE_1
    ],
    staffUserIds: [
        process.env.APP_STAFF_USER_1
    ]
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

        if (!serverConfig) {
            console.log(`Member joined unconfigured server: ${guildId}`);
            return;
        }

        console.log(`${member.user.tag} joined ${member.guild.name} (${guildId})`);

        const verificationSource = await checkAutoVerificationSource(member.user.id, guildId);

        if (verificationSource.shouldVerify) {
            const verifiedRole = member.guild.roles.cache.get(serverConfig.verifiedRoleId);

            if (!verifiedRole) {
                console.error(`Verified role not found for server ${guildId}`);
                return;
            }

            const botMember = member.guild.members.cache.get(client.user.id);
            if (verifiedRole.position >= botMember.roles.highest.position) {
                console.error(`Cannot assign role in ${member.guild.name} - role hierarchy issue`);
                return;
            }

            await member.roles.add(verifiedRole);
            console.log(`Auto-verified ${member.user.tag} in ${member.guild.name}`);

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

        const mainServers = [process.env.VG_GUILD_ID, process.env.VC_GUILD_ID];
        const server3Id = process.env.APP_GUILD_ID;

        for (const [serverId, config] of Object.entries(SERVER_CONFIGS)) {
            if (serverId === joinedGuildId) continue;

            const guild = client.guilds.cache.get(serverId);
            if (!guild) {
                console.log(`Guild ${serverId} not found in cache`);
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
        return { shouldVerify: false, fromServer3: false, fromOtherMainServer: false };
    }
}

// Post announcement to Django API
async function postAnnouncement(title, content, link = null) {
    const payload = JSON.stringify({
        title: title,
        content: content,
        link: link,
    });

    const options = {
        hostname: 'api.vicers.net',
        path: '/api/announcement/create/',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Bot-Secret': process.env.BOT_API_SECRET,
            'Content-Length': Buffer.byteLength(payload),
        }
    };

    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 201) {
                    resolve(JSON.parse(data));
                } else {
                    reject(new Error(`API responded with ${res.statusCode}: ${data}`));
                }
            });
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

// Message handler
client.on('messageCreate', async (message) => {
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

            const botMember = message.guild.members.cache.get(client.user.id);
            if (verifiedRole.position >= botMember.roles.highest.position) {
                return message.reply('❌ I cannot assign this role. My role must be positioned above the verified role in server settings.');
            }

            if (targetUser.roles.cache.has(serverConfig.verifiedRoleId)) {
                return message.reply(`❌ ${targetUser.user.tag} is already verified.`);
            }

            await targetUser.roles.add(verifiedRole);
            message.reply(`✅ ${targetUser.user.tag} has been verified!`);
            console.log(`${message.author.tag} verified ${targetUser.user.tag} in ${message.guild.name} (${guildId})`);

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
});

// Function to auto-verify user in other servers after manual verification
async function autoVerifyInOtherServers(userId, verifiedInGuildId) {
    try {
        for (const [serverId, config] of Object.entries(SERVER_CONFIGS)) {
            if (serverId === verifiedInGuildId) continue;

            const guild = client.guilds.cache.get(serverId);
            if (!guild) continue;

            try {
                const member = await guild.members.fetch(userId);

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
    if (serverConfig.staffUserIds.includes(userId)) {
        return true;
    }
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