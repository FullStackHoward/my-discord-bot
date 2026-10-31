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
// having BOTH the role and the channel set; leave either blank to keep Radar off there.
//
// The callout channel is where the public "N people are playing X" post goes, and now
// also the weekly digest. It is separate because VG_RADAR_CHANNEL feeds three different
// things - the callout, the group-chat threads a Radar DM can open, and the closed-DM
// notice in lib/events.js - so pointing the loud one at a busy channel should not drag
// the other two along with it. Unset means they all stay together, as before.
//
// The two game channels are optional and are used for one thing: when somebody is
// playing a game nobody else on Radar is playing, their DM points them at the places
// they could go and round up players. Without an id the DM still names the channel, as
// plain text instead of a link, so a missing one costs a link and nothing else. Radar
// is never disabled over them.
SERVER_CONFIGS[VG_GUILD_ID].radar = {
    roleId: process.env.VG_RADAR_ROLE,
    channelId: process.env.VG_RADAR_CHANNEL,
    optInChannelId: process.env.VG_OPTIN_CHANNEL,
    calloutChannelId: (process.env.VG_RADAR_CALLOUT_CHANNEL || '').trim() || undefined,
    gameForumsChannelId: (process.env.VG_GAME_FORUMS_CHANNEL || '').trim() || undefined,
    gameChatChannelId: (process.env.VG_GAME_CHAT_CHANNEL || '').trim() || undefined
};

SERVER_CONFIGS[VC_GUILD_ID].radar = {
    roleId: process.env.VC_RADAR_ROLE,
    channelId: process.env.VC_RADAR_CHANNEL,
    optInChannelId: process.env.VC_OPTIN_CHANNEL,
    calloutChannelId: (process.env.VC_RADAR_CALLOUT_CHANNEL || '').trim() || undefined,
    gameForumsChannelId: (process.env.VC_GAME_FORUMS_CHANNEL || '').trim() || undefined,
    gameChatChannelId: (process.env.VC_GAME_CHAT_CHANNEL || '').trim() || undefined
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

// LFG lobbies. A guild runs them only when its LFG channel is set, the same opt-in shape
// as Radar, activity and the gamer ID cleanup.
SERVER_CONFIGS[VG_GUILD_ID].lobby = {
    channelId: (process.env.VG_LFG_CHANNEL || '').trim() || undefined,
    defaultVoiceChannelId: (process.env.VG_LFG_DEFAULT_VOICE || '').trim() || undefined
};

SERVER_CONFIGS[VC_GUILD_ID].lobby = {
    channelId: (process.env.VC_LFG_CHANNEL || '').trim() || undefined,
    defaultVoiceChannelId: (process.env.VC_LFG_DEFAULT_VOICE || '').trim() || undefined
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
    gamerId: 0x9B59B6,
    // LFG lobbies. Teal was the one unused slot.
    lobby: 0x1ABC9C
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
// A comma-separated list of names, lower-cased for case-insensitive matching. Unlike
// most settings here, a variable that is present but empty means an empty list rather
// than the default: that is the only way to turn the list off from the env file.
function nameSetFromEnv(name, fallback) {
    const raw = process.env[name];
    const source = raw === undefined ? fallback : raw;

    return new Set(
        source.split(',').map(value => value.trim().toLowerCase()).filter(Boolean)
    );
}

// Games that never earn a Vice Radar DM, however many people are playing. Discord
// Activities are played inside Discord with whoever is already there, so a DM telling
// you to go and find a squad for one is noise. DMs only: the public callout and the
// board headcount still count them, because the headcount is true either way.
const RADAR_DM_IGNORED_GAMES = nameSetFromEnv('RADAR_DM_IGNORED_GAMES', 'Wordle');

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
// LFG lobbies
// ---------------------------------------------------------------------------

// positiveIntEnv rejects zero, which is a valid hour, so ranged integers get their own
// reader. Out-of-range or non-integer input warns and falls back rather than failing.
function intEnvInRange(name, fallback, min, max) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;

    const parsed = Number(raw);

    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
        console.warn(`${name}="${raw}" is not an integer between ${min} and ${max} - using the default of ${fallback}.`);
        return fallback;
    }

    return parsed;
}

// Validated here rather than at first use, so a bad zone is caught at boot.
function timeZoneEnv(name, fallback) {
    const raw = (process.env[name] || '').trim();
    if (!raw) return fallback;

    try {
        new Intl.DateTimeFormat('en-US', { timeZone: raw });
        return raw;
    } catch (error) {
        console.warn(`${name}="${raw}" is not a valid IANA time zone - using the default of ${fallback}.`);
        return fallback;
    }
}

// Overridable so the unit tests can point it at a temp file instead of the repo root.
const LOBBY_STATE_PATH = (process.env.LOBBY_STATE_PATH || '').trim()
    || path.join(__dirname, '..', 'lobby-state.json');
const LOBBY_STATE_FLUSH_INTERVAL_MS = 60 * 1000;

// Mutations coalesce into one write about a second later, so a join that also promotes a
// waitlister writes once.
const LOBBY_STATE_COALESCE_MS = 1000;

const LOBBY_SWEEP_INTERVAL_MS = 60 * 1000;

// Offset from the other periodic jobs, which start at boot, +5, +20 and +35 minutes.
const LOBBY_SWEEP_START_DELAY_MS = 45 * 1000;

const LOBBY_TZ = timeZoneEnv('LOBBY_TZ', 'America/New_York');
const LOBBY_BOARD_POST_HOUR = intEnvInRange('LOBBY_BOARD_POST_HOUR', 17, 0, 23);

const LOBBY_MAX_OPEN_PER_HOST = positiveIntEnv('LOBBY_MAX_OPEN_PER_HOST', 3);
const LOBBY_MAX_OPEN_TOTAL = positiveIntEnv('LOBBY_MAX_OPEN_TOTAL', 30);
const LOBBY_MAX_DAYS_AHEAD = positiveIntEnv('LOBBY_MAX_DAYS_AHEAD', 14);
const LOBBY_MIN_LEAD_MINUTES = positiveIntEnv('LOBBY_MIN_LEAD_MINUTES', 10);
// One reminder an hour out, then the start post. There is deliberately no third
// "still in?" stage any more.
const LOBBY_REMINDER_MINUTES = positiveIntEnv('LOBBY_REMINDER_MINUTES', 60);
const LOBBY_NOW_EXPIRY_MINUTES = positiveIntEnv('LOBBY_NOW_EXPIRY_MINUTES', 45);
const LOBBY_SHOW_MIN_MINUTES = positiveIntEnv('LOBBY_SHOW_MIN_MINUTES', 10);
const LOBBY_RETENTION_DAYS = positiveIntEnv('LOBBY_RETENTION_DAYS', 90);
const LOBBY_BOARD_DEBOUNCE_SECONDS = positiveIntEnv('LOBBY_BOARD_DEBOUNCE_SECONDS', 15);
const LOBBY_BOARD_RADAR_MIN = positiveIntEnv('LOBBY_BOARD_RADAR_MIN', 2);
// A lobby that actually ran leaves a card worth reading for a day.
const LOBBY_CARD_CLEANUP_HOURS = positiveIntEnv('LOBBY_CARD_CLEANUP_HOURS', 24);

// A lobby that never ran - cancelled, or expired with nobody joining - is just dead
// weight in the channel, so it goes much sooner. Not instant: a short window lets
// anyone who clicks through still see that it was cancelled rather than finding
// nothing. The thread survives either way.
const LOBBY_DEAD_CARD_CLEANUP_MINUTES = positiveIntEnv('LOBBY_DEAD_CARD_CLEANUP_MINUTES', 10);
const LOBBY_NUDGE_DAILY_CAP = positiveIntEnv('LOBBY_NUDGE_DAILY_CAP', 2);
const LOBBY_SERIES_LEAD_HOURS = positiveIntEnv('LOBBY_SERIES_LEAD_HOURS', 72);
const LOBBY_NEWCOMER_PROMPT_HOURS = positiveIntEnv('LOBBY_NEWCOMER_PROMPT_HOURS', 24);
const LOBBY_DEFAULT_SEATS = positiveIntEnv('LOBBY_DEFAULT_SEATS', 4);
const LOBBY_GAME_MIN_SUBMITTERS = positiveIntEnv('LOBBY_GAME_MIN_SUBMITTERS', 2);
const LOBBY_GAME_PRUNE_DAYS = positiveIntEnv('LOBBY_GAME_PRUNE_DAYS', 60);

// Not env-tunable: these are safety rails rather than preferences.
const LOBBY_MAX_SEATS = 16;
const LOBBY_MIN_SEATS = 2;
const LOBBY_MAX_TEMPLATES_PER_HOST = 5;
const LOBBY_MAX_SERIES_PER_HOST = 2;
const LOBBY_MAX_CREWS_PER_MEMBER = 5;
const LOBBY_MAX_GAMES_PER_PROFILE = 10;
const LOBBY_MAX_NUDGES_PER_LOBBY = 10;
const LOBBY_LATE_GRACE_MS = 10 * 60 * 1000;
const LOBBY_AGAIN_WINDOW_HOURS = 48;
const LOBBY_CREW_MAX_MEMBERS = 6;
const LOBBY_NUDGE_QUIET_START_HOUR = 8;
const LOBBY_NUDGE_QUIET_END_HOUR = 22;

const LOBBY_LENGTH_MINUTES = { quick: 60, standard: 120, long: 240 };

// The LFG channel is meant to carry lobby cards and slash commands only, with all
// chatter in the per-lobby threads. Discord permissions do the real work; this flag turns
// on the code backstop that deletes anything which gets through anyway.
//
// Off unless it is exactly the string "true", matching the convention the gamer ID
// cleanup already uses for a feature that deletes things.
const LOBBY_CHANNEL_GUARD_ENABLED = process.env.LOBBY_CHANNEL_GUARD_ENABLED === 'true';

// One explanatory DM per person per this many minutes, so a burst of posts does not
// produce a burst of DMs.
const LOBBY_CHANNEL_REMINDER_COOLDOWN_MINUTES = positiveIntEnv('LOBBY_CHANNEL_REMINDER_COOLDOWN_MINUTES', 10);

// ---------------------------------------------------------------------------
// Gamer ID forum cleanup (Vice Gamers only)
// ---------------------------------------------------------------------------

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

// Whether the automatic cleanup deletes is toggled with /gamer-id-cleanup and persisted
// here, rather than being an env var that needs a redeploy to change.
const GAMER_ID_STATE_PATH = path.join(__dirname, '..', 'gamer-id-state.json');

// A truncated member list is the one dangerous failure here: it would make current members
// look departed. A full run aborts rather than deleting when the fetch comes back this far
// short of the guild's own count.
const GAMER_ID_MEMBER_FETCH_MIN_RATIO = 0.9;

module.exports = {
    RADAR_DM_IGNORED_GAMES,
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
    GAMER_ID_STATE_PATH,
    LOBBY_STATE_PATH,
    LOBBY_STATE_FLUSH_INTERVAL_MS,
    LOBBY_STATE_COALESCE_MS,
    LOBBY_SWEEP_INTERVAL_MS,
    LOBBY_SWEEP_START_DELAY_MS,
    LOBBY_TZ,
    LOBBY_BOARD_POST_HOUR,
    LOBBY_MAX_OPEN_PER_HOST,
    LOBBY_MAX_OPEN_TOTAL,
    LOBBY_MAX_DAYS_AHEAD,
    LOBBY_MIN_LEAD_MINUTES,
    LOBBY_REMINDER_MINUTES,
    LOBBY_NOW_EXPIRY_MINUTES,
    LOBBY_SHOW_MIN_MINUTES,
    LOBBY_RETENTION_DAYS,
    LOBBY_BOARD_DEBOUNCE_SECONDS,
    LOBBY_BOARD_RADAR_MIN,
    LOBBY_CARD_CLEANUP_HOURS,
    LOBBY_DEAD_CARD_CLEANUP_MINUTES,
    LOBBY_NUDGE_DAILY_CAP,
    LOBBY_SERIES_LEAD_HOURS,
    LOBBY_NEWCOMER_PROMPT_HOURS,
    LOBBY_DEFAULT_SEATS,
    LOBBY_GAME_MIN_SUBMITTERS,
    LOBBY_GAME_PRUNE_DAYS,
    LOBBY_MAX_SEATS,
    LOBBY_MIN_SEATS,
    LOBBY_MAX_TEMPLATES_PER_HOST,
    LOBBY_MAX_SERIES_PER_HOST,
    LOBBY_MAX_CREWS_PER_MEMBER,
    LOBBY_MAX_GAMES_PER_PROFILE,
    LOBBY_MAX_NUDGES_PER_LOBBY,
    LOBBY_LATE_GRACE_MS,
    LOBBY_AGAIN_WINDOW_HOURS,
    LOBBY_CREW_MAX_MEMBERS,
    LOBBY_NUDGE_QUIET_START_HOUR,
    LOBBY_NUDGE_QUIET_END_HOUR,
    LOBBY_LENGTH_MINUTES,
    LOBBY_CHANNEL_GUARD_ENABLED,
    LOBBY_CHANNEL_REMINDER_COOLDOWN_MINUTES,
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
