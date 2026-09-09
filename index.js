require('dotenv').config();

const https = require('https');
const { Client, GatewayIntentBits, GuildScheduledEventStatus } = require('discord.js');

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

SERVER_CONFIGS[APP_GUILD_ID] = {
    verifiedRoleId: process.env.APP_VERIFIED_ROLE,
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

// Bot log channels, one per main server.
const LOG_CHANNELS = {
    [VG_GUILD_ID]: process.env.VG_LOG_CHANNEL,
    [VC_GUILD_ID]: process.env.VC_LOG_CHANNEL
};

// Reference only: the reconciliation job queries by role, not channel visibility.
// Kept here so the "who is stuck in the waiting room" mapping is documented in code.
const WAITING_ROOM_CHANNELS = {
    [VG_GUILD_ID]: process.env.VG_WAITING_ROOM_CHANNEL,
    [VC_GUILD_ID]: process.env.VC_WAITING_ROOM_CHANNEL
};

const RECONCILIATION_INTERVAL_MS = 60 * 60 * 1000;

let eventChannelSyncRunning = false;
let reconciliationRunning = false;

// Bot ready event
client.once('ready', () => {
    console.log(`${client.user.tag} is now online and ready!`);
    console.log(`Configured for ${Object.keys(SERVER_CONFIGS).length} server(s)`);

    warnAboutMissingConfig();

    void syncEventChannels();
    setInterval(() => {
        void syncEventChannels();
    }, 15 * 60 * 1000);

    void runReconciliation();
    setInterval(() => {
        void runReconciliation();
    }, RECONCILIATION_INTERVAL_MS);
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

        if (verificationSource.shouldVerify && canManageRole(member.guild, serverConfig.verifiedRoleId)) {
            const verifiedRole = member.guild.roles.cache.get(serverConfig.verifiedRoleId);

            await member.roles.add(verifiedRole);
            console.log(`Auto-verified ${member.user.tag} in ${member.guild.name}`);

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
        }

        // Independent of verification: carry any subscription tier over from the other main server.
        await syncTierRolesOnJoin(member);
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
        return;
    }

    const scheduledEvents = await guild.scheduledEvents.fetch().catch(error => {
        console.error(`Failed to fetch scheduled events for ${guild.name}:`, error);
        return null;
    });

    if (!scheduledEvents) {
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

// Post to the server's bot log channel. Never throws: logging must not break the caller.
async function sendStaffLog(guildId, message) {
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

        await channel.send(message);
    } catch (error) {
        console.error('Failed to send staff log message:', error);
    }
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
    for (const guildId of [VG_GUILD_ID, VC_GUILD_ID]) {
        if (!LOG_CHANNELS[guildId]) {
            console.warn(`No bot log channel configured for ${guildLabel(guildId)} - staff logs will be skipped.`);
        }

        const tiers = SERVER_CONFIGS[guildId]?.tierRoleIds || {};
        const missing = TIER_ORDER.filter(tierName => !tiers[tierName]);
        if (missing.length > 0) {
            console.warn(`Missing tier role IDs for ${guildLabel(guildId)}: ${missing.join(', ')} - those tiers will not sync.`);
        }
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
            return;
        }

        await appMember.kick('Verified in a main Vice Community server - application cycle complete');
        console.log(`Kicked ${appMember.user.tag} from Application Server after verification in ${guildLabel(guildIdJustVerifiedIn)}`);
        await sendStaffLog(guildIdJustVerifiedIn, `Auto-kicked **${appMember.user.tag}** from the Application Server after verification here.`);
    } catch (error) {
        console.error(`Could not kick ${userId} from Application Server:`, error);
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
        }

        if (removable.length > 0) {
            try {
                await member.roles.remove(removable, 'Cross-server tier sync');
                changed = true;
            } catch (error) {
                console.error(`Failed to remove tier roles from ${member.user.tag} in ${guild.name}:`, error);
            }
        }
    }

    if (toAdd) {
        if (!canManageRole(guild, toAdd)) {
            console.error(`Cannot assign tier role to ${member.user.tag} in ${guild.name} - role hierarchy issue`);
        } else {
            try {
                await member.roles.add(toAdd, 'Cross-server tier sync');
                changed = true;
            } catch (error) {
                console.error(`Failed to add tier role to ${member.user.tag} in ${guild.name}:`, error);
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
            await sendStaffLog(otherGuildId, `Synced tier role **${newTier}** to **${otherMember.user.tag}** (granted on ${guildLabel(guildId)}).`);
        } else {
            console.log(`Removed tier roles from ${otherMember.user.tag} in ${otherGuild.name}`);
            await sendStaffLog(otherGuildId, `Removed tier role from **${otherMember.user.tag}** (subscription ended on ${guildLabel(guildId)}).`);
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
        await sendStaffLog(guildId, `Granted tier role **${tier}** to **${member.user.tag}** on join (already held on ${guildLabel(otherGuildId)}).`);
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

            const members = await guild.members.fetch().catch(error => {
                console.error(`Failed to fetch members for ${guild.name}:`, error);
                return null;
            });

            if (members) {
                guildMembers.set(serverId, { guild, members });
            }
        }

        await reconcileMissingRoles(guildMembers);
        await reconcileTierRoles(guildMembers);
    } catch (error) {
        console.error('Error during reconciliation sweep:', error);
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
            continue;
        }

        if (!canManageRole(guild, config.verifiedRoleId)) {
            console.error(`Cannot assign the verified role in ${guild.name} - role hierarchy issue`);
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
                continue;
            }

            console.log(`Reconciliation: corrected missing role for ${member.user.tag} in ${guild.name}`);
            await sendStaffLog(guildId, `Reconciliation: corrected missing verified role for **${member.user.tag}**.`);

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
                await sendStaffLog(VC_GUILD_ID, `Reconciliation: synced tier **${vgTier}** to **${vcMember.user.tag}** from Vice Gamers.`);
            }
        } else if (vcTier && !vgTier) {
            if (await applyTier(vgMember, vgTiers, vcTier)) {
                console.log(`Reconciliation: synced tier ${vcTier} to ${vgMember.user.tag} in Vice Gamers`);
                await sendStaffLog(VG_GUILD_ID, `Reconciliation: synced tier **${vcTier}** to **${vgMember.user.tag}** from Vice Creators.`);
            }
        } else {
            // Both sides have a tier and they disagree. Never auto-corrected:
            // guessing either upgrades someone for free or downgrades a paying member.
            const msg = `⚠️ Tier mismatch for **${vgMember.user.tag}**: **${vgTier}** on Vice Gamers vs **${vcTier}** on Vice Creators. Needs manual review, not auto-corrected.`;
            console.warn(`Tier mismatch for ${vgMember.user.tag}: ${vgTier} (VG) vs ${vcTier} (VC)`);
            await sendStaffLog(VG_GUILD_ID, msg);
            await sendStaffLog(VC_GUILD_ID, msg);
        }
    }
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