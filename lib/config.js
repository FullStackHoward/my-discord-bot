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

// Reads a list of env var names into [{ envName, roleId }], dropping unset, blank and
// whitespace-only values plus duplicate IDs. The env var name is carried alongside the ID
// so startup validation can name the exact variable that is wrong, not just a bad ID.
function roleListFromEnv(envNames) {
    const seen = new Set();
    const list = [];

    for (const envName of envNames) {
        const roleId = (process.env[envName] || '').trim();
        if (!roleId || seen.has(roleId)) continue;

        seen.add(roleId);
        list.push({ envName, roleId });
    }

    return list;
}

// The spec named this VG_GAMER_ID_FORUM; the .env in use spells it VG_GAMER_ID_CHANNEL.
// Both are accepted rather than picking one, because getting it wrong would silently
// disable the whole feature with no error - the same failure mode that already bit the
// subscriber tier IDs and ACTIVITY_ROLES_ENABLED.
const GAMER_ID_FORUM_ENV_NAMES = ['VG_GAMER_ID_FORUM', 'VG_GAMER_ID_CHANNEL'];

function gamerIdForumIdFromEnv() {
    for (const name of GAMER_ID_FORUM_ENV_NAMES) {
        const value = (process.env[name] || '').trim();
        if (value) return value;
    }

    return undefined;
}

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

// Activity roles. Like Radar, a server opts in by having BOTH values set; leave either
// blank to keep labeling off there. The Application Server is never included.
SERVER_CONFIGS[VG_GUILD_ID].activity = {
    activeRoleId: process.env.VG_ACTIVE_ROLE,
    inactiveRoleId: process.env.VG_INACTIVE_ROLE
};

SERVER_CONFIGS[VC_GUILD_ID].activity = {
    activeRoleId: process.env.VC_ACTIVE_ROLE,
    inactiveRoleId: process.env.VC_INACTIVE_ROLE
};

// Roles that exempt their holder from activity labeling entirely, the same way staff and
// subscribers already do. Matched per guild and never across guilds: each role belongs to
// exactly one server. All of these are optional - an unset list just means fewer roles to
// match, which is a valid configuration.
// Gamer ID forum cleanup, Vice Gamers only. There is deliberately no Vice Creators or
// Application Server equivalent: the forum only exists on the gaming server.
SERVER_CONFIGS[VG_GUILD_ID].gamerId = {
    forumChannelId: gamerIdForumIdFromEnv()
};

SERVER_CONFIGS[VG_GUILD_ID].activityExceptionRoles = roleListFromEnv([
    'VG_EVENT_COORDINATOR_ROLE',
    'VG_RECRUITER_ROLE',
    'VG_CONTRIBUTOR_ROLE',
    'VG_CREATOR_ROLE'
]);

SERVER_CONFIGS[VC_GUILD_ID].activityExceptionRoles = roleListFromEnv([
    'VC_STAR_ARTIST_ROLE',
    'VC_STAR_DEV_ROLE',
    'VC_STAR_MUSICIAN_ROLE',
    'VC_STAR_CONTENT_CREATOR_ROLE',
    'VC_STAR_WRITER_ROLE',
    'VC_GAMER_ROLE'
]);

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
    error: 0xED4245,
    // Activity roles and purge. Kept visually distinct from each other so staff can scan
    // the log channel: neutral grey for informational, green up, yellow down, orange for
    // a removal, blue for an exemption.
    activity: 0x95A5A6,
    activityPromote: 0x57F287,
    activityDemote: 0xFEE75C,
    purge: 0xE67E22,
    exempt: 0x3498DB,
    // Gamer ID forum cleanup. Purple, so it never reads as an activity or purge event.
    gamerId: 0x9B59B6
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

// ---------------------------------------------------------------------------
// Activity roles (Active / Inactive) and the manual purge
// ---------------------------------------------------------------------------

// Reads an optional positive-integer env var, warning and falling back on bad input so a
// typo degrades to the documented default instead of silently breaking a threshold.
function positiveIntEnv(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;

    const parsed = Number(raw);

    if (!Number.isInteger(parsed) || parsed <= 0) {
        console.warn(`${name}="${raw}" is not a positive integer - using the default of ${fallback}.`);
        return fallback;
    }

    return parsed;
}

const ACTIVITY_THRESHOLD_DAYS = positiveIntEnv('ACTIVITY_THRESHOLD_DAYS', 30);
const ACTIVITY_NEW_MEMBER_GRACE_DAYS = positiveIntEnv('ACTIVITY_NEW_MEMBER_GRACE_DAYS', 14);
const ACTIVITY_VOICE_MIN_MINUTES = positiveIntEnv('ACTIVITY_VOICE_MIN_MINUTES', 5);
const ACTIVITY_LOG_INDIVIDUAL_MAX = positiveIntEnv('ACTIVITY_LOG_INDIVIDUAL_MAX', 10);

// Off by default: tracking-only mode records signals and reports what it *would* do
// without touching a single role. Flipping this to true is the deliberate step that lets
// the bot start labeling people.
const ACTIVITY_ROLES_ENABLED = process.env.ACTIVITY_ROLES_ENABLED === 'true';

const ACTIVITY_IGNORED_CHANNELS = (process.env.ACTIVITY_IGNORED_CHANNELS || '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean);

const PURGE_REAPPLY_URL = process.env.PURGE_REAPPLY_URL || 'https://discord.vicers.net';

const ACTIVITY_STATE_PATH = path.join(__dirname, '..', 'activity-state.json');
const PURGE_LOG_PATH = path.join(__dirname, '..', 'purge-log.jsonl');

const ACTIVITY_STATE_FLUSH_INTERVAL_MS = 60 * 1000;
const ACTIVITY_VOICE_TICK_INTERVAL_MS = 60 * 1000;
const ACTIVITY_ROLE_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

// 20 minutes keeps the sweep clear of the reconciliation boot run and the application
// sweep's 5-minute offset; all three request a full member list.
const ACTIVITY_ROLE_SWEEP_START_DELAY_MS = 20 * 60 * 1000;

const SEED_PAGE_DELAY_MS = 250;
const SEED_CHANNEL_DELAY_MS = 1000;
const SEED_MAX_MESSAGES_PER_CHANNEL = 100000;
const SEED_PROGRESS_EVERY_CHANNELS = 10;
const SEED_PROGRESS_EVERY_MS = 10 * 60 * 1000;

// A pending purge preview expires rather than sitting armed indefinitely.
const PURGE_CONFIRM_TIMEOUT_MS = 5 * 60 * 1000;
const PURGE_ACTION_DELAY_MS = 2000;

// Stop a run that is clearly failing rather than grinding through the whole list.
const PURGE_MAX_CONSECUTIVE_FAILURES = 5;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Gamer ID forum cleanup (Vice Gamers only)
// ---------------------------------------------------------------------------

// Must be the literal string "true" before anything is actually deleted. Anything else,
// including unset, means report-only: scan and report, delete nothing.
const GAMER_ID_CLEANUP_ENABLED = process.env.GAMER_ID_CLEANUP_ENABLED === 'true';

// A leaver is queued and the scan runs once the queue has been quiet this long, so a burst
// of departures (a /purge run, for instance) produces one scan rather than one per person.
const GAMER_ID_LEAVE_DEBOUNCE_MS = 60 * 1000;

const GAMER_ID_DELETE_DELAY_MS = 1000;
const GAMER_ID_PAGE_DELAY_MS = 250;
const GAMER_ID_RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000;

// The other full-member-list jobs start at boot, +5 min and +20 min; 35 keeps this clear.
const GAMER_ID_RECONCILE_START_DELAY_MS = 35 * 60 * 1000;

const GAMER_ID_MAX_CONSECUTIVE_FAILURES = 5;
const GAMER_ID_PREVIEW_TIMEOUT_MS = 5 * 60 * 1000;
const GAMER_ID_LOG_PATH = path.join(__dirname, '..', 'gamer-id-log.jsonl');

// A truncated member list is the one dangerous failure here: it would make current members
// look departed. A full run aborts rather than deleting when the fetch comes back this far
// short of the guild's own count.
const GAMER_ID_MEMBER_FETCH_MIN_RATIO = 0.9;

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
    ACTIVITY_THRESHOLD_DAYS,
    ACTIVITY_NEW_MEMBER_GRACE_DAYS,
    ACTIVITY_VOICE_MIN_MINUTES,
    ACTIVITY_LOG_INDIVIDUAL_MAX,
    ACTIVITY_ROLES_ENABLED,
    ACTIVITY_IGNORED_CHANNELS,
    PURGE_REAPPLY_URL,
    ACTIVITY_STATE_PATH,
    PURGE_LOG_PATH,
    ACTIVITY_STATE_FLUSH_INTERVAL_MS,
    ACTIVITY_VOICE_TICK_INTERVAL_MS,
    ACTIVITY_ROLE_SWEEP_INTERVAL_MS,
    ACTIVITY_ROLE_SWEEP_START_DELAY_MS,
    SEED_PAGE_DELAY_MS,
    SEED_CHANNEL_DELAY_MS,
    SEED_MAX_MESSAGES_PER_CHANNEL,
    SEED_PROGRESS_EVERY_CHANNELS,
    SEED_PROGRESS_EVERY_MS,
    PURGE_CONFIRM_TIMEOUT_MS,
    PURGE_ACTION_DELAY_MS,
    PURGE_MAX_CONSECUTIVE_FAILURES,
    MS_PER_DAY,
    GAMER_ID_FORUM_ENV_NAMES,
    GAMER_ID_CLEANUP_ENABLED,
    GAMER_ID_LEAVE_DEBOUNCE_MS,
    GAMER_ID_DELETE_DELAY_MS,
    GAMER_ID_PAGE_DELAY_MS,
    GAMER_ID_RECONCILE_INTERVAL_MS,
    GAMER_ID_RECONCILE_START_DELAY_MS,
    GAMER_ID_MAX_CONSECUTIVE_FAILURES,
    GAMER_ID_PREVIEW_TIMEOUT_MS,
    GAMER_ID_LOG_PATH,
    GAMER_ID_MEMBER_FETCH_MIN_RATIO,
};
