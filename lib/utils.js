// Small helpers shared across features. Nothing here knows about any one feature.

const { MessageFlags } = require('discord.js');
const client = require('./client');
const {
    VG_GUILD_ID,
    VC_GUILD_ID,
    APP_GUILD_ID,
    SERVER_CONFIGS,
    LOG_CHANNELS,
    TIER_ORDER,
    MEMBER_FETCH_ATTEMPTS,
    MEMBER_FETCH_RETRY_MS,
    APP_CHAT_CHANNEL_ID,
    APP_SUBMIT_CHANNEL_ID
} = require('./config');

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

// Permission check function
function hasStaffPermission(member, userId, serverConfig) {
    if (serverConfig.staffUserIds.includes(userId)) {
        return true;
    }
    return serverConfig.staffRoleIds.some(roleId => member.roles.cache.has(roleId));
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

    for (const guildId of [VG_GUILD_ID, VC_GUILD_ID]) {
        const radar = SERVER_CONFIGS[guildId]?.radar || {};
        if (!radar.roleId && !radar.channelId) continue; // Radar deliberately off here
        if (!radar.roleId || !radar.channelId) {
            console.warn(`Vice Radar is half-configured for ${guildLabel(guildId)} - both the role and the channel are required, so Radar is disabled there.`);
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

module.exports = {
    resolveGuild,
    sleep,
    fetchAllMembers,
    canManageRole,
    hasStaffPermission,
    isMainServer,
    otherMainServerId,
    guildLabel,
    warnAboutMissingConfig,
    respondWithError,
};
