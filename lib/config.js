// Everything derived from .env. No behavior lives here, only values.
//
// Note the '..' in the two state-file paths: __dirname is lib/ now, and both files
// are deliberately kept at the repo root where they already live on the server.

const path = require('path');

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

// Vice Radar (presence-based squad matching). A server is opted into the feature by
// having BOTH of these set; leave either blank to keep Radar off in that server.
SERVER_CONFIGS[VG_GUILD_ID].radar = {
    roleId: process.env.VG_RADAR_ROLE,
    channelId: process.env.VG_RADAR_CHANNEL,
    optInChannelId: process.env.VG_OPTIN_CHANNEL
};

SERVER_CONFIGS[VC_GUILD_ID].radar = {
    roleId: process.env.VC_RADAR_ROLE,
    channelId: process.env.VC_RADAR_CHANNEL,
    optInChannelId: process.env.VC_OPTIN_CHANNEL
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
const APPLICATION_STATE_PATH = path.join(__dirname, '..', 'application-server-state.json');

// Event RSVP reminders. Checked every minute so the 15-minute mark is caught within a
// tight window; reminded occurrences are dropped a day past their start so the state
// file doesn't grow forever.
const EVENT_REMINDER_CHECK_INTERVAL_MS = 60 * 1000;
const EVENT_REMINDER_WINDOW_MS = 15 * 60 * 1000;
const EVENT_REMINDER_PRUNE_AGE_MS = 24 * 60 * 60 * 1000;
const EVENT_REMINDER_STATE_PATH = path.join(__dirname, '..', 'event-reminder-state.json');

// Discord's error code for a closed DM or a blocked bot, as opposed to a transient
// failure. Only this one earns a public callout.
const DM_CLOSED_ERROR_CODE = 50007;

module.exports = {
    BOT_TOKEN,
    VG_GUILD_ID,
    VC_GUILD_ID,
    APP_GUILD_ID,
    EVENT_CHANNELS,
    SERVER_CONFIGS,
    TIER_ORDER,
    LOG_CHANNELS,
    LOG_COLORS,
    TIER_DISPLAY_NAMES,
    tierLabel,
    WAITING_ROOM_CHANNELS,
    APP_CHAT_CHANNEL_ID,
    APP_SUBMIT_CHANNEL_ID,
    RECONCILIATION_INTERVAL_MS,
    APPLICATION_SWEEP_INTERVAL_MS,
    APPLICATION_SWEEP_START_DELAY_MS,
    MEMBER_FETCH_ATTEMPTS,
    MEMBER_FETCH_RETRY_MS,
    APPLY_NUDGE_DELAY_MS,
    NUDGE_KICK_GRACE_MS,
    APPLICATION_STATE_PATH,
    EVENT_REMINDER_CHECK_INTERVAL_MS,
    EVENT_REMINDER_WINDOW_MS,
    EVENT_REMINDER_PRUNE_AGE_MS,
    EVENT_REMINDER_STATE_PATH,
    DM_CLOSED_ERROR_CODE,
};
