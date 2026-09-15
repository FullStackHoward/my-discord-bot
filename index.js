require('dotenv').config();

const fs = require('fs');
const https = require('https');
const path = require('path');
const { ApplicationCommandOptionType, Client, EmbedBuilder, GatewayIntentBits, GuildScheduledEventStatus, MessageFlags } = require('discord.js');

// Create a new client instance
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

// Conf pulled from .env
const BOT_TOKEN = process.env.BOT_TOKEN;

const VG_GUILD_ID = process.env.VG_GUILD_ID;
const VC_GUILD_ID = process.env.VC_GUILD_ID;
const APP_GUILD_ID = process.env.APP_GUILD_ID;

const EVENT_CHANNELS = [
    { guildId: VG_GUILD_ID, channelId: process.env.VG_EVENT_CHANNEL },
    { guildId: VC_GUILD_ID, channelId: process.env.VC_EVENT_CHANNEL }
];

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

// Appy (the third-party application bot) owns these three roles and assigns
// exactly one as staff review an application. verifiedRoleId is Appy's Accepted role.
SERVER_CONFIGS[APP_GUILD_ID] = {
    verifiedRoleId: process.env.APP_VERIFIED_ROLE,
    pendingRoleId: process.env.APP_PENDING_ROLE,
    deniedRoleId: process.env.APP_DENIED_ROLE,
    staffRoleIds: [
        process.env.APP_STAFF_ROLE_1
    ],
    staffUserIds: [
        process.env.APP_STAFF_USER_1
    ]
};

// Subscription tier roles, lowest to highest. Order matters: getMemberTier()
// resolves a member holding several tier roles to the highest one.
const TIER_ORDER = ['vicerPlus', 'vicerPlusPlus', 'superVicer'];

SERVER_CONFIGS[VG_GUILD_ID].tierRoleIds = {
    vicerPlus: process.env.VG_TIER_VICER_PLUS,
    vicerPlusPlus: process.env.VG_TIER_VICER_PLUS_PLUS,
    superVicer: process.env.VG_TIER_SUPER_VICER
};

SERVER_CONFIGS[VC_GUILD_ID].tierRoleIds = {
    vicerPlus: process.env.VC_TIER_VICER_PLUS,
    vicerPlusPlus: process.env.VC_TIER_VICER_PLUS_PLUS,
    superVicer: process.env.VC_TIER_SUPER_VICER
};

// Bot log channels, one per server.
const LOG_CHANNELS = {
    [VG_GUILD_ID]: process.env.VG_LOG_CHANNEL,
    [VC_GUILD_ID]: process.env.VC_LOG_CHANNEL,
    [APP_GUILD_ID]: process.env.APP_LOG_CHANNEL
};

// Embed colors by event category, so staff can scan a log channel at a glance.
const LOG_COLORS = {
    join: 0x5865F2,
    verifyAuto: 0x57F287,
    verifyManual: 0x57F287,
    kick: 0xE67E22,
    tierGrant: 0xEB459E,
    tierRemove: 0x992D22,
    mismatch: 0xFEE75C,
    // Deliberately the same blue as join; reconciliation entries are told apart by the 🔄 in the title.
    reconciliation: 0x5865F2,
    error: 0xED4245
};

// Staff never see the raw TIER_ORDER keys; every log goes through tierLabel().
const TIER_DISPLAY_NAMES = {
    vicerPlus: 'Vicer+',
    vicerPlusPlus: 'Vicer++',
    superVicer: 'Super Vicer'
};

function tierLabel(tierName) {
    return TIER_DISPLAY_NAMES[tierName] || tierName;
}

// Reference only: the reconciliation job queries by role, not channel visibility.
// Kept here so the "who is stuck in the waiting room" mapping is documented in code.
const WAITING_ROOM_CHANNELS = {
    [VG_GUILD_ID]: process.env.VG_WAITING_ROOM_CHANNEL,
    [VC_GUILD_ID]: process.env.VC_WAITING_ROOM_CHANNEL
};

// Application Server channels. APP_SUBMIT_CHANNEL only drives a channel mention in
// the apply reminder, so a missing value degrades to plain text rather than failing.
const APP_CHAT_CHANNEL_ID = process.env.APP_CHAT;
const APP_SUBMIT_CHANNEL_ID = process.env.APP_SUBMIT_CHANNEL;

const RECONCILIATION_INTERVAL_MS = 60 * 60 * 1000;
const APPLICATION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

// Offset from the reconciliation pass so the two hourly jobs never request the full
// Application Server member list at the same instant.
const APPLICATION_SWEEP_START_DELAY_MS = 5 * 60 * 1000;

// A full member fetch is a fire-and-forget gateway request: if the shard is
// reconnecting when it goes out, no chunks come back and discord.js gives up after
// 120s of silence. One retry turns that transient failure into a non-event.
const MEMBER_FETCH_ATTEMPTS = 2;
const MEMBER_FETCH_RETRY_MS = 15 * 1000;

// How long someone may sit in the Application Server without starting an application
// before they are reminded, and how long any reminder stands before they are removed.
const APPLY_NUDGE_DELAY_MS = 8 * 60 * 60 * 1000;
const NUDGE_KICK_GRACE_MS = 24 * 60 * 60 * 1000;

// Nudge timestamps live on disk so a deploy doesn't silently restart every 24h clock.
const APPLICATION_STATE_PATH = path.join(__dirname, 'application-server-state.json');

let applicationState = { applyNudges: {}, joinNudges: {} };

let eventChannelSyncRunning = false;
let reconciliationRunning = false;
let applicationSweepRunning = false;

// Bot ready event
client.once('ready', () => {
    console.log(`${client.user.tag} is now online and ready!`);
    console.log(`Configured for ${Object.keys(SERVER_CONFIGS).length} server(s)`);

    warnAboutMissingConfig();
    loadApplicationState();

    void registerSlashCommands();

    void syncEventChannels();
    setInterval(() => {
        void syncEventChannels();
    }, 15 * 60 * 1000);

    void runReconciliation();
    setInterval(() => {
        void runReconciliation();
    }, RECONCILIATION_INTERVAL_MS);

    setTimeout(() => {
        void runApplicationSweep();
        setInterval(() => {
            void runApplicationSweep();
        }, APPLICATION_SWEEP_INTERVAL_MS);
    }, APPLICATION_SWEEP_START_DELAY_MS);
});

// Handle member joining a server
client.on('guildMemberAdd', async (member) => {
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

async function syncEventChannels() {
    if (eventChannelSyncRunning) {
        return;
    }

    eventChannelSyncRunning = true;

    try {
        await Promise.all(EVENT_CHANNELS.map(async ({ guildId, channelId }) => {
            try {
                await syncEventChannel(guildId, channelId);
            } catch (error) {
                console.error(`Error syncing events for guild ${guildId}:`, error);

                await sendStaffLog(guildId, {
                    color: LOG_COLORS.error,
                    title: '⚠️ Event Sync Failed',
                    description: `The scheduled-event sync for ${guildLabel(guildId)} did not finish, so the events channel may be out of date.`,
                    fields: [errorField(error)],
                    footer: 'The next sync runs in 15 minutes.'
                });
            }
        }));
    } finally {
        eventChannelSyncRunning = false;
    }
}

async function syncEventChannel(guildId, channelId) {
    if (!guildId || !channelId) {
        return;
    }

    const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) {
        console.log(`Guild not found for event sync: ${guildId}`);
        return;
    }

    const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
        console.log(`Events channel not found or not text-based for guild ${guildId}: ${channelId}`);

        await sendStaffLog(guildId, {
            color: LOG_COLORS.error,
            title: '⚠️ Events Channel Misconfigured',
            description: `The events channel configured for ${guildLabel(guildId)} is missing, not visible to the bot, or not a text channel.`,
            fields: [
                { name: 'Configured Channel ID', value: `${channelId}` }
            ],
            footer: 'Scheduled events are not being mirrored until this is fixed.'
        });
        return;
    }

    let scheduledEvents;

    try {
        scheduledEvents = await guild.scheduledEvents.fetch();
    } catch (error) {
        console.error(`Failed to fetch scheduled events for ${guild.name}:`, error);

        await sendStaffLog(guildId, {
            color: LOG_COLORS.error,
            title: '⚠️ Event Fetch Failed',
            description: `Could not fetch the scheduled events for ${guildLabel(guildId)}, so the events channel was left untouched this pass.`,
            fields: [errorField(error)],
            footer: 'The next sync runs in 15 minutes.'
        });
        return;
    }

    const messages = await fetchRecentChannelMessages(channel);
    const botUserId = client.user.id;
    const eventMessageMap = new Map();

    for (const message of messages.values()) {
        if (message.author?.id !== botUserId) {
            continue;
        }

        const eventId = extractEventIdFromMessage(message, guildId);
        if (eventId) {
            eventMessageMap.set(eventId, message);
        }
    }

    for (const scheduledEvent of scheduledEvents.values()) {
        if (scheduledEvent.status !== GuildScheduledEventStatus.Scheduled && scheduledEvent.status !== GuildScheduledEventStatus.Active) {
            continue;
        }

        if (!eventMessageMap.has(scheduledEvent.id)) {
            try {
                await channel.send(`https://discord.com/events/${guildId}/${scheduledEvent.id}`);
            } catch (error) {
                console.error(`Failed to post event ${scheduledEvent.id} in ${guild.name}:`, error);

                await sendStaffLog(guildId, {
                    color: LOG_COLORS.error,
                    title: '⚠️ Event Post Failed',
                    description: `Could not post the event **${scheduledEvent.name}** to the events channel in ${guildLabel(guildId)}.`,
                    fields: [errorField(error)],
                    footer: 'Check the bot\'s Send Messages permission in that channel.'
                });
            }
        }
    }

    for (const [eventId, message] of eventMessageMap.entries()) {
        const currentEvent = scheduledEvents.get(eventId);

        if (currentEvent && (currentEvent.status === GuildScheduledEventStatus.Scheduled || currentEvent.status === GuildScheduledEventStatus.Active)) {
            continue;
        }

        try {
            await message.delete();
        } catch (error) {
            console.log(`Could not delete event post ${eventId} in ${guild.name}:`, error.message);
        }
    }
}

async function fetchRecentChannelMessages(channel, maxMessages = 500) {
    const allMessages = new Map();
    let before;

    while (allMessages.size < maxMessages) {
        const fetchOptions = { limit: Math.min(100, maxMessages - allMessages.size) };

        if (before) {
            fetchOptions.before = before;
        }

        const messages = await channel.messages.fetch(fetchOptions);

        if (messages.size === 0) {
            break;
        }

        for (const [messageId, message] of messages.entries()) {
            allMessages.set(messageId, message);
        }

        before = messages.last().id;

        if (messages.size < fetchOptions.limit) {
            break;
        }
    }

    return allMessages;
}

function extractEventIdFromMessage(message, guildId) {
    const match = message.content.match(new RegExp(`https?:\\/\\/discord\\.com\\/events\\/${escapeRegex(guildId)}\\/(\\d+)`));
    return match ? match[1] : null;
}

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
});

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

// These run alongside the !verify / !announce prefix handlers above. The two systems
// are independent, so the old commands stay live until the slash versions are
// confirmed working in production.
const SLASH_COMMANDS = [
    {
        name: 'verify',
        description: 'Manually verify a member in this server',
        options: [
            {
                name: 'user',
                description: 'The member to verify',
                type: ApplicationCommandOptionType.User,
                required: true
            }
        ]
    },
    {
        name: 'announce',
        description: 'Post an announcement to the Vicers community site',
        options: [
            {
                name: 'title',
                description: 'Announcement title',
                type: ApplicationCommandOptionType.String,
                required: true
            },
            {
                name: 'content',
                description: 'Announcement body',
                type: ApplicationCommandOptionType.String,
                required: true
            },
            {
                name: 'link',
                description: 'Optional link to include with the announcement',
                type: ApplicationCommandOptionType.String,
                required: false
            }
        ]
    }
];

// Guild-scoped rather than global: guild commands appear instantly and only show up
// in our three servers. Re-registering an identical definition is a no-op on Discord's
// side, so running this on every startup needs no separate deploy step.
async function registerSlashCommands() {
    for (const guildId of [VG_GUILD_ID, VC_GUILD_ID, APP_GUILD_ID]) {
        if (!guildId) continue;

        try {
            await client.application.commands.set(SLASH_COMMANDS, guildId);
            console.log(`Registered ${SLASH_COMMANDS.length} slash command(s) in ${guildLabel(guildId)}`);
        } catch (error) {
            // A bot invited without the applications.commands scope fails here. The bot
            // keeps running and the !verify / !announce prefix commands still work.
            console.error(`Failed to register slash commands in ${guildLabel(guildId)}:`, error);

            void sendStaffLog(guildId, {
                color: LOG_COLORS.error,
                title: '⚠️ Slash Command Registration Failed',
                description: `Slash commands could not be registered in ${guildLabel(guildId)}.`,
                fields: [errorField(error)],
                footer: 'Check that the bot was invited with the applications.commands scope.'
            });
        }
    }
}

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    try {
        if (interaction.commandName === 'verify') {
            await handleVerifyCommand(interaction);
        } else if (interaction.commandName === 'announce') {
            await handleAnnounceCommand(interaction);
        }
    } catch (error) {
        // Safety net for anything the handlers below don't catch themselves, e.g. the
        // interaction expiring before we could respond to it at all.
        console.error(`Error handling /${interaction.commandName}:`, error);
    }
});

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

// Slash-command form of !announce. postAnnouncement is untouched and still just
// receives the same three strings.
async function handleAnnounceCommand(interaction) {
    if (interaction.user.id !== process.env.VICER_ADMIN) {
        return interaction.reply({ content: '❌ You do not have permission to post announcements.', flags: MessageFlags.Ephemeral });
    }

    const title = interaction.options.getString('title');
    const content = interaction.options.getString('content');
    const link = interaction.options.getString('link') || null;

    // postAnnouncement calls api.vicers.net, which isn't guaranteed to answer inside
    // Discord's 3 second initial-response window.
    await interaction.deferReply();

    try {
        await postAnnouncement(title, content, link);
        await interaction.editReply('✅ Announcement posted successfully!');
    } catch (error) {
        console.error('Error posting announcement:', error);
        await interaction.editReply(`❌ Failed to post announcement. Error: ${error.message}`);
    }
}

// An interaction may already have been replied to or deferred by the time an error
// lands, and each of those needs a different call. Never throws.
async function respondWithError(interaction, content) {
    const payload = { content, flags: MessageFlags.Ephemeral };

    try {
        if (interaction.deferred || interaction.replied) {
            await interaction.followUp(payload);
        } else {
            await interaction.reply(payload);
        }
    } catch (error) {
        console.error('Failed to send interaction error reply:', error);
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

// Permission check function
function hasStaffPermission(member, userId, serverConfig) {
    if (serverConfig.staffUserIds.includes(userId)) {
        return true;
    }
    return serverConfig.staffRoleIds.some(roleId => member.roles.cache.has(roleId));
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// Guild lookup that falls back to a fetch when the guild isn't warm in cache.
async function resolveGuild(guildId) {
    if (!guildId) return null;
    return client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Full guild member fetch with a retry. Throws the last error if every attempt fails,
// so callers keep their existing "skip this guild and log it" handling.
async function fetchAllMembers(guild) {
    let lastError;

    for (let attempt = 1; attempt <= MEMBER_FETCH_ATTEMPTS; attempt++) {
        try {
            return await guild.members.fetch();
        } catch (error) {
            lastError = error;
            console.warn(`Member fetch for ${guild.name} failed (attempt ${attempt}/${MEMBER_FETCH_ATTEMPTS}): ${error.message}`);

            if (attempt < MEMBER_FETCH_ATTEMPTS) {
                await sleep(MEMBER_FETCH_RETRY_MS);
            }
        }
    }

    throw lastError;
}

// True when the bot's highest role sits above the target role, i.e. it can grant/revoke it.
function canManageRole(guild, roleId) {
    if (!roleId) return false;

    const role = guild.roles.cache.get(roleId);
    if (!role) {
        console.error(`Role ${roleId} not found in ${guild.name}`);
        return false;
    }

    const botMember = guild.members.me;
    if (!botMember) return false;

    return role.position < botMember.roles.highest.position;
}

// Post an embed to the server's bot log channel, built from
// { color, title, description?, fields?, footer? }.
// Never throws: logging must not break the caller.
async function sendStaffLog(guildId, options) {
    try {
        const channelId = LOG_CHANNELS[guildId];
        if (!channelId) return;

        const guild = await resolveGuild(guildId);
        if (!guild) return;

        const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
        if (!channel || !channel.isTextBased()) {
            console.log(`Log channel not found or not text-based for guild ${guildId}: ${channelId}`);
            return;
        }

        const embed = new EmbedBuilder()
            .setColor(options.color)
            .setTitle(options.title)
            .setTimestamp();

        if (options.description) {
            embed.setDescription(options.description);
        }

        if (options.fields && options.fields.length > 0) {
            embed.addFields(options.fields);
        }

        if (options.footer) {
            embed.setFooter({ text: options.footer });
        }

        await channel.send({ embeds: [embed] });
    } catch (error) {
        console.error('Failed to send staff log message:', error);
    }
}

// For problems that aren't tied to one server. Best effort: sendStaffLog already
// swallows a channel that is missing or unreachable.
async function sendStaffLogToAllServers(options) {
    for (const guildId of [VG_GUILD_ID, VC_GUILD_ID, APP_GUILD_ID]) {
        await sendStaffLog(guildId, options);
    }
}

// Discord rejects empty embed field values, and truncates anything past 1024 chars.
function errorField(error) {
    const text = String(error && error.message ? error.message : error) || 'Unknown error';
    return { name: 'Error', value: text.slice(0, 1000) };
}

function isMainServer(guildId) {
    return guildId === VG_GUILD_ID || guildId === VC_GUILD_ID;
}

function otherMainServerId(guildId) {
    return guildId === VG_GUILD_ID ? VC_GUILD_ID : VG_GUILD_ID;
}

function guildLabel(guildId) {
    if (guildId === VG_GUILD_ID) return 'Vice Gamers';
    if (guildId === VC_GUILD_ID) return 'Vice Creators';
    if (guildId === APP_GUILD_ID) return 'the Application Server';
    return guildId;
}

// Warn once at startup about config the new features depend on, so a missing
// .env entry shows up in the PM2 log instead of silently disabling a feature.
function warnAboutMissingConfig() {
    for (const guildId of [VG_GUILD_ID, VC_GUILD_ID, APP_GUILD_ID]) {
        if (!LOG_CHANNELS[guildId]) {
            console.warn(`No bot log channel configured for ${guildLabel(guildId)} - staff logs will be skipped.`);
        }
    }

    for (const guildId of [VG_GUILD_ID, VC_GUILD_ID]) {
        const tiers = SERVER_CONFIGS[guildId]?.tierRoleIds || {};
        const missing = TIER_ORDER.filter(tierName => !tiers[tierName]);
        if (missing.length > 0) {
            console.warn(`Missing tier role IDs for ${guildLabel(guildId)}: ${missing.join(', ')} - those tiers will not sync.`);
        }
    }

    const appConfig = SERVER_CONFIGS[APP_GUILD_ID] || {};

    if (!appConfig.pendingRoleId) {
        console.warn('No APP_PENDING_ROLE configured - applicants under review cannot be told apart from people who never applied, so apply reminders and their kicks are disabled.');
    }

    if (!appConfig.deniedRoleId) {
        console.warn('No APP_DENIED_ROLE configured - denied applicants will not be removed, and apply reminders are disabled.');
    }

    if (!APP_CHAT_CHANNEL_ID) {
        console.warn('No APP_CHAT configured - application reminders will be skipped, so nobody will be removed for not applying or not joining.');
    }

    if (!APP_SUBMIT_CHANNEL_ID) {
        console.warn('No APP_SUBMIT_CHANNEL configured - the apply reminder will say #submit-your-application as plain text instead of linking the channel.');
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

// ---------------------------------------------------------------------------
// Feature B: cross-server subscription tier sync
// ---------------------------------------------------------------------------

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
client.on('guildMemberUpdate', async (oldMember, newMember) => {
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
});

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

// ---------------------------------------------------------------------------
// Feature C: hourly reconciliation
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Feature D: Application Server lifecycle sweep
// ---------------------------------------------------------------------------

// Appy DMs an accepted applicant their invite link, so this bot never needs to know
// which main server someone applied to - only whether they have joined either one.

function loadApplicationState() {
    try {
        const parsed = JSON.parse(fs.readFileSync(APPLICATION_STATE_PATH, 'utf8'));

        applicationState = {
            applyNudges: parsed.applyNudges || {},
            joinNudges: parsed.joinNudges || {}
        };

        console.log(`Loaded application state: ${Object.keys(applicationState.applyNudges).length} apply reminder(s), ${Object.keys(applicationState.joinNudges).length} join reminder(s) outstanding`);
    } catch (error) {
        // A missing file is the normal first-run case; anything else is worth seeing.
        if (error.code !== 'ENOENT') {
            console.error('Could not read application state, starting from empty:', error);
        }

        applicationState = { applyNudges: {}, joinNudges: {} };
    }
}

async function saveApplicationState() {
    try {
        fs.writeFileSync(APPLICATION_STATE_PATH, JSON.stringify(applicationState, null, 2));
    } catch (error) {
        console.error('Failed to save application state:', error);

        // Worth surfacing: if this keeps failing, every 24h clock resets on each
        // restart and nobody is ever removed.
        await sendStaffLog(APP_GUILD_ID, {
            color: LOG_COLORS.error,
            title: '⚠️ Application State Not Saved',
            description: 'Reminder timestamps could not be written to disk. They will be lost if the bot restarts, which resets the 24-hour removal clocks.',
            fields: [errorField(error)],
            footer: 'Check the file permissions on application-server-state.json.'
        });
    }
}

// Returns true when the entry existed, so callers can tell whether to re-save.
function clearNudge(nudges, userId) {
    if (nudges[userId] === undefined) return false;

    delete nudges[userId];
    return true;
}

function clearAllNudges(userId) {
    const hadApply = clearNudge(applicationState.applyNudges, userId);
    const hadJoin = clearNudge(applicationState.joinNudges, userId);
    return hadApply || hadJoin;
}

// Drop timestamps for anyone no longer in the server so the file can't grow forever.
function pruneApplicationState(members) {
    let changed = false;

    for (const nudges of [applicationState.applyNudges, applicationState.joinNudges]) {
        for (const userId of Object.keys(nudges)) {
            if (!members.has(userId)) {
                delete nudges[userId];
                changed = true;
            }
        }
    }

    return changed;
}

async function runApplicationSweep() {
    if (applicationSweepRunning) {
        console.log('Application sweep already running, skipping this pass.');
        return;
    }

    applicationSweepRunning = true;

    try {
        const appConfig = SERVER_CONFIGS[APP_GUILD_ID];
        if (!appConfig) return;

        const appGuild = await resolveGuild(APP_GUILD_ID);
        if (!appGuild) {
            console.log('Application Server not available for the lifecycle sweep');
            return;
        }

        let members;

        try {
            members = await fetchAllMembers(appGuild);
        } catch (error) {
            console.error('Failed to fetch Application Server members:', error);

            await sendStaffLog(APP_GUILD_ID, {
                color: LOG_COLORS.error,
                title: '⚠️ Application Sweep Skipped',
                description: 'Could not fetch the Application Server member list, so this sweep did nothing.',
                fields: [errorField(error)],
                footer: 'The next sweep runs in an hour.'
            });
            return;
        }

        // Resolved at most once per pass, and only if a reminder is actually due, so a
        // misconfigured channel doesn't post an error every hour for nothing. Null only
        // disables reminders: removals already past their 24 hours still go ahead.
        const getChatChannel = makeChatChannelResolver(appGuild);

        let stateChanged = pruneApplicationState(members);
        const now = Date.now();

        for (const member of members.values()) {
            if (member.user.bot) continue;
            if (member.id === appGuild.ownerId) continue;
            // Staff hold their own roles for access and are never applicants.
            if (hasStaffPermission(member, member.id, appConfig)) continue;

            try {
                const changed = await handleApplicant(member, appConfig, getChatChannel, now);
                if (changed) stateChanged = true;
            } catch (error) {
                console.error(`Application sweep failed for ${member.user.tag}:`, error);
            }
        }

        if (stateChanged) {
            await saveApplicationState();
        }
    } catch (error) {
        console.error('Error during application sweep:', error);

        await sendStaffLog(APP_GUILD_ID, {
            color: LOG_COLORS.error,
            title: '⚠️ Application Sweep Failed',
            description: 'The Application Server sweep stopped early, so some reminders or removals may have been missed.',
            fields: [errorField(error)],
            footer: 'The next sweep runs in an hour.'
        });
    } finally {
        applicationSweepRunning = false;
    }
}

// One member, in priority order: denied, then accepted, then pending, then never applied.
// Returns true if the on-disk nudge state changed.
async function handleApplicant(member, appConfig, getChatChannel, now) {
    const userId = member.id;

    // 1. Denied - removed straight away, no grace period.
    if (appConfig.deniedRoleId && member.roles.cache.has(appConfig.deniedRoleId)) {
        const changed = clearAllNudges(userId);

        await kickApplicant(member, 'Application denied', {
            title: '👢 Denied Applicant Removed',
            reason: 'Their application was denied.'
        });

        return changed;
    }

    // 2. Accepted - Appy has sent them an invite, so the clock is on using it.
    if (appConfig.verifiedRoleId && member.roles.cache.has(appConfig.verifiedRoleId)) {
        if (await isInEitherMainServer(userId)) {
            // maybeKickFromApplicationServer owns them from here.
            return clearNudge(applicationState.joinNudges, userId);
        }

        const nudgedAt = applicationState.joinNudges[userId];

        if (!nudgedAt) {
            const sent = await sendApplicationNudge(await getChatChannel(), `🎉 <@${userId}>, congrats on being accepted! Don't forget to check your DMs for the invite link from our application bot and join up. If you haven't joined within 24 hours, you'll be removed from here.`);
            if (!sent) return false;

            console.log(`Application sweep: reminded ${member.user.tag} to join a main server`);

            await sendStaffLog(APP_GUILD_ID, {
                color: LOG_COLORS.reconciliation,
                title: '🔄 Join Reminder Sent',
                description: `**${member.user.tag}** (<@${userId}>) was accepted but has not joined Vice Gamers or Vice Creators, so they were reminded in the application chat.`,
                footer: 'They will be removed if they still have not joined 24 hours from now.'
            });

            applicationState.joinNudges[userId] = now;
            return true;
        }

        if (now - nudgedAt >= NUDGE_KICK_GRACE_MS) {
            const kicked = await kickApplicant(member, 'Accepted but did not join a main server within 24 hours of the reminder', {
                title: '👢 Accepted Applicant Removed',
                reason: 'Did not join Vice Gamers or Vice Creators within 24 hours of their reminder.'
            });

            // Left in place on failure so the next sweep retries the removal.
            return kicked ? clearNudge(applicationState.joinNudges, userId) : false;
        }

        return false;
    }

    // 3. Pending - mid-review, nothing to do. They clearly applied, so drop any reminder.
    if (appConfig.pendingRoleId && member.roles.cache.has(appConfig.pendingRoleId)) {
        return clearNudge(applicationState.applyNudges, userId);
    }

    // 4. None of the three. Without both role IDs configured we cannot prove that,
    // and guessing would nudge and then remove people who are mid-review.
    if (!appConfig.pendingRoleId || !appConfig.deniedRoleId) return false;

    if (!member.joinedTimestamp) return false;
    if (now - member.joinedTimestamp < APPLY_NUDGE_DELAY_MS) return false;

    const nudgedAt = applicationState.applyNudges[userId];

    if (!nudgedAt) {
        const submitChannel = APP_SUBMIT_CHANNEL_ID ? `<#${APP_SUBMIT_CHANNEL_ID}>` : '#submit-your-application';
        const sent = await sendApplicationNudge(await getChatChannel(), `👋 <@${userId}>, we noticed you haven't applied yet! Head over to ${submitChannel} to get started, it only takes about 60 seconds.`);
        if (!sent) return false;

        console.log(`Application sweep: reminded ${member.user.tag} to apply`);

        await sendStaffLog(APP_GUILD_ID, {
            color: LOG_COLORS.reconciliation,
            title: '🔄 Apply Reminder Sent',
            description: `**${member.user.tag}** (<@${userId}>) has been here over 8 hours without starting an application, so they were reminded in the application chat.`,
            footer: 'They will be removed if they still have not applied 24 hours from now.'
        });

        applicationState.applyNudges[userId] = now;
        return true;
    }

    if (now - nudgedAt >= NUDGE_KICK_GRACE_MS) {
        const kicked = await kickApplicant(member, 'Did not apply within 24 hours of the reminder', {
            title: '👢 Inactive Applicant Removed',
            reason: 'Never started an application, and did not apply within 24 hours of their reminder.'
        });

        return kicked ? clearNudge(applicationState.applyNudges, userId) : false;
    }

    return false;
}

// Appy sends the right invite link, so either main server counts as having joined.
async function isInEitherMainServer(userId) {
    for (const guildId of [VG_GUILD_ID, VC_GUILD_ID]) {
        const guild = await resolveGuild(guildId);
        if (!guild) continue;

        const member = await guild.members.fetch(userId).catch(() => null);
        if (member) return true;
    }

    return false;
}

function makeChatChannelResolver(appGuild) {
    let resolved;

    return async () => {
        if (resolved === undefined) {
            resolved = await resolveApplicationChatChannel(appGuild);
        }

        return resolved;
    };
}

async function resolveApplicationChatChannel(appGuild) {
    if (!APP_CHAT_CHANNEL_ID) return null;

    const channel = appGuild.channels.cache.get(APP_CHAT_CHANNEL_ID) || await appGuild.channels.fetch(APP_CHAT_CHANNEL_ID).catch(() => null);

    if (!channel || !channel.isTextBased()) {
        console.log(`Application chat channel not found or not text-based: ${APP_CHAT_CHANNEL_ID}`);

        await sendStaffLog(APP_GUILD_ID, {
            color: LOG_COLORS.error,
            title: '⚠️ Application Chat Misconfigured',
            description: 'The application chat channel is missing, not visible to the bot, or not a text channel, so no reminders were sent this pass.',
            fields: [
                { name: 'Configured Channel ID', value: `${APP_CHAT_CHANNEL_ID}` }
            ],
            footer: 'Nobody is being removed for not applying or not joining until this is fixed.'
        });

        return null;
    }

    return channel;
}

// Returns false when nothing was posted, so the caller does not start a 24-hour
// clock for a reminder the member never saw.
async function sendApplicationNudge(channel, content) {
    if (!channel) return false;

    try {
        await channel.send(content);
        return true;
    } catch (error) {
        console.error('Failed to post an application reminder:', error);

        await sendStaffLog(APP_GUILD_ID, {
            color: LOG_COLORS.error,
            title: '⚠️ Application Reminder Failed',
            description: 'Could not post a reminder in the application chat channel.',
            fields: [errorField(error)],
            footer: 'Check the bot\'s Send Messages permission in that channel.'
        });

        return false;
    }
}

// Shared removal path for all three sweep outcomes. Returns true only if the kick landed.
async function kickApplicant(member, kickReason, log) {
    if (!member.kickable) {
        console.error(`Cannot kick ${member.user.tag} from the Application Server - missing permission or role hierarchy issue`);

        await sendStaffLog(APP_GUILD_ID, {
            color: LOG_COLORS.error,
            title: '⚠️ Applicant Removal Blocked',
            description: `**${member.user.tag}** (<@${member.id}>) should have been removed from the Application Server, but the bot could not do it.`,
            fields: [
                { name: 'Why They Were Due Removal', value: log.reason },
                { name: 'Blocked By', value: 'Missing the Kick Members permission, or the bot\'s highest role sits below theirs.' }
            ],
            footer: 'Remove them manually, or fix the permission and the next sweep will retry.'
        });

        return false;
    }

    try {
        await member.kick(kickReason);
    } catch (error) {
        console.error(`Failed to kick ${member.user.tag} from the Application Server:`, error);

        await sendStaffLog(APP_GUILD_ID, {
            color: LOG_COLORS.error,
            title: '⚠️ Applicant Removal Failed',
            description: `**${member.user.tag}** (<@${member.id}>) could not be removed from the Application Server.`,
            fields: [
                { name: 'Why They Were Due Removal', value: log.reason },
                errorField(error)
            ],
            footer: 'The next sweep retries in an hour.'
        });

        return false;
    }

    console.log(`Application sweep: kicked ${member.user.tag} from the Application Server (${kickReason})`);

    await sendStaffLog(APP_GUILD_ID, {
        color: LOG_COLORS.kick,
        title: log.title,
        description: `**${member.user.tag}** (<@${member.id}>) was removed from the Application Server.`,
        fields: [
            { name: 'Reason', value: log.reason }
        ]
    });

    return true;
}

// Error handling
client.on('error', error => {
    console.error('Client error:', error);

    void sendStaffLogToAllServers({
        color: LOG_COLORS.error,
        title: '⚠️ Bot Client Error',
        description: 'The bot reported a Discord client error and may have briefly lost its connection.',
        fields: [errorField(error)],
        footer: 'If this repeats, check the PM2 log on the server.'
    });
});

process.on('unhandledRejection', error => {
    console.error('Unhandled promise rejection:', error);

    void sendStaffLogToAllServers({
        color: LOG_COLORS.error,
        title: '⚠️ Unhandled Error',
        description: 'The bot hit an unhandled error. Whatever action triggered it may not have completed.',
        fields: [errorField(error)],
        footer: 'If this repeats, check the PM2 log on the server.'
    });
});

// Login to Discord
client.login(BOT_TOKEN);