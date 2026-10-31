// ---------------------------------------------------------------------------
// Feature E: Vice Radar (presence-based squad matching)
// ---------------------------------------------------------------------------

const {
    ActivityType,
    ApplicationCommandOptionType,
    ChannelType,
    EmbedBuilder,
    MessageFlags,
    ThreadAutoArchiveDuration
} = require('discord.js');
const { randomBytes } = require('node:crypto');
const { SERVER_CONFIGS, LOG_COLORS, RADAR_DM_IGNORED_GAMES } = require('../config');
const { sendStaffLog, errorField } = require('../staff-log');
const client = require('../client');
const { resolveGuild, canManageRole, guildLabel, respondWithError } = require('../utils');
const { pickPhrase } = require('./phrase-bank');
const {
    isDmExcludedGame,
    planRadarDms,
    buildSquadDm,
    buildSoloDm,
    GROUP_BUTTON_PREFIX
} = require('./dm-plan');

// Concurrent players (opted in or not) before Vice Radar DMs an opted-in member about it.
const RADAR_DM_MIN_SQUAD = 2;

// Concurrent players before the *public* callout posts. Higher than the DM threshold on
// purpose: a 2-person overlap is worth a private nudge to the people it's actually
// relevant to, but not worth a channel post everyone sees.
const RADAR_PUBLIC_MIN_SQUAD = 3;

// Absorbs a brief presence drop (a loading screen, a match transition, a game's Rich
// Presence hiccup) without treating it as the session actually ending. Tune down if
// resets feel sluggish, up if flicker still gets through.
const RADAR_RESET_GRACE_MS = 5 * 60 * 1000;

// Built per guild rather than held as a constant: a <#id> mention only renders as a
// link in the guild that owns the channel, so each server needs its own. Guilds without
// an opt-in channel configured fall back to plain text.
function radarCta(radar) {
    const optIn = radar.optInChannelId ? `<#${radar.optInChannelId}>` : '#opt-in';

    return `Use /vice-radar join or grab the role in ${optIn} to get pinged anytime someone's playing whatever you're playing.`;
}

// The custom radar emoji, looked up by name so no emoji ID is hardcoded. It resolves
// to a plain CDN image URL, so the emoji does not need to live in the guild being
// posted to - any guild the bot shares with it will do.
const RADAR_ICON_EMOJI_NAME = 'viceradar';
const RADAR_BRAND_NAME = 'Vice Radar';

// Application emojis belong to the bot rather than to any server, so they are in no
// guild cache and have to be listed from the API. Fetched once and remembered - the list
// is small and changes only when somebody uploads one - and a failure is remembered as
// "none" rather than retried on every post.
let applicationEmojiFetch = null;
let warnedAboutMissingIcon = false;

function applicationEmojis() {
    if (!client.application) return Promise.resolve(null);

    if (!applicationEmojiFetch) {
        applicationEmojiFetch = client.application.emojis.fetch().catch(error => {
            console.warn('Vice Radar: could not list application emojis:', error.message);
            return null;
        });
    }

    return applicationEmojiFetch;
}

// Returns the emoji's image URL, or null if it has been renamed or deleted, so a missing
// emoji costs the icon rather than the whole post. Requests 128px because the thumbnail
// renders around 80px, well above the ~24px an author icon would have needed.
//
// Checks server emojis first and application emojis second, because the Developer Portal
// and a server's emoji tab look equally plausible as the place to upload this and only
// one of them puts it in a guild cache.
async function radarIconURL() {
    const guildEmoji = client.emojis.cache.find(e => e.name === RADAR_ICON_EMOJI_NAME);
    if (guildEmoji) return guildEmoji.imageURL({ size: 128 });

    const appEmojis = await applicationEmojis();
    const appEmoji = appEmojis?.find(e => e.name === RADAR_ICON_EMOJI_NAME);
    if (appEmoji) return appEmoji.imageURL({ size: 128 });

    // Once per process: DMs are now edited as well as sent, so this would otherwise
    // repeat on every roster change for every match.
    if (!warnedAboutMissingIcon) {
        warnedAboutMissingIcon = true;
        console.warn(`Vice Radar: no :${RADAR_ICON_EMOJI_NAME}: emoji found in any shared server or on the application, posting without the radar icon`);
    }

    return null;
}

// Rotated per post so consecutive embeds don't look identical. Deliberately separate
// from LOG_COLORS: those carry staff-log meaning, these are just brand colors.
const RADAR_COLORS = [0xFFB570, 0x2ED9C3, 0xE0A9E8];
let radarColorIndex = 0;

// Picked from the game name rather than at random, so re-editing a DM never changes its
// colour under the reader and everyone in one match sees the same one.
function dmColorFor(gameName) {
    let hash = 0;
    for (const character of String(gameName)) hash = (hash * 31 + character.codePointAt(0)) % 99991;

    return RADAR_COLORS[hash % RADAR_COLORS.length];
}

// Several people starting the same game within a moment each change the roster, and each
// change would otherwise mean a round of edits to everyone's DM. First DMs are never
// delayed by this; only the edits that follow are gathered up.
const RADAR_DM_EDIT_DELAY_MS = 3 * 1000;

// token -> { guildId, gameName }, so a group-chat button can carry a short id instead of
// a game name that might not fit in a custom id. Cleared when the streak resets, which
// is what makes a button from a finished match answer "this match has ended".
const matchTokens = new Map();

const RADAR_GROUP_ENDED = 'That match has ended, so there is nobody left to group up with. Vice Radar will DM you the next time it finds one.';
const RADAR_GROUP_NOT_YOURS = 'You are not in that match any more, so there is nothing to join. Start the game again and Vice Radar will pick you up.';
const RADAR_GROUP_PENDING = 'Someone just pressed this too - give it a moment and the chat will appear.';
const RADAR_GROUP_FAILED = 'I could not start the group chat. Staff have been told, so try again shortly or say hi in the radar channel in the meantime.';

const RADAR_COMMAND = {
    name: 'vice-radar',
    description: 'Get notified when others are playing the same game as you',
    options: [
        {
            name: 'action',
            description: 'Turn Vice Radar on or off',
            type: ApplicationCommandOptionType.String,
            required: true,
            choices: [
                { name: 'Join', value: 'join' },
                { name: 'Leave', value: 'leave' }
            ]
        }
    ]
};

// guildId -> Map<gameName, entry>, where each entry tracks the DM and public sides
// independently - see applyRadarPresence for the shape, evaluateRadarGame for why.
// In-memory only, by design: presence rebuilds itself within seconds of a restart, so
// unlike the application sweep's multi-hour countdowns there's nothing worth persisting.
const radarState = new Map();

// Where the public callout and the weekly digest go. Falls back to the radar channel,
// so a server that has not split the two keeps its old behaviour exactly.
function calloutChannelIdFor(radar) {
    return radar.calloutChannelId || radar.channelId;
}

// Radar is on for a server only when both its role and its channel are configured.
function radarConfigFor(guildId) {
    const radar = SERVER_CONFIGS[guildId]?.radar;
    if (!radar || !radar.roleId || !radar.channelId) return null;
    return radar;
}

function radarGamesFor(guildId) {
    let games = radarState.get(guildId);
    if (!games) {
        games = new Map();
        radarState.set(guildId, games);
    }
    return games;
}

// Every game the member is showing as Playing. Streaming, Listening, Watching and
// Custom statuses deliberately don't count. Empty when they're offline or idle.
function playingGameNames(presence) {
    if (!presence) return new Set();

    return new Set(
        presence.activities
            .filter(activity => activity.type === ActivityType.Playing && activity.name)
            .map(activity => activity.name)
    );
}

// Off unless RADAR_PRESENCE_DEBUG=true. Exists to answer one question that cannot be
// answered from the documentation: how Discord Activities (Wordle and the rest) actually
// arrive in a presence payload. If they turn out to carry the Embedded activity flag
// reliably, the DM exclusion could key on that instead of on a list of names. Logs the
// member id rather than their tag, and never anything they have said.
function logPresenceActivities(member, presence) {
    if (process.env.RADAR_PRESENCE_DEBUG !== 'true') return;

    for (const activity of presence.activities || []) {
        console.log('Vice Radar presence:', JSON.stringify({
            member: member.id,
            name: activity.name,
            type: activity.type,
            applicationId: activity.applicationId,
            flags: activity.flags?.bitfield,
            flagNames: activity.flags?.toArray?.()
        }));
    }
}

async function handlePresenceUpdate(newPresence) {
    try {
        const guildId = newPresence?.guild?.id;
        if (!guildId) return;

        const radar = radarConfigFor(guildId);
        if (!radar) return;

        const member = newPresence.member;
        if (!member || member.user.bot) return;

        logPresenceActivities(member, newPresence);

        // Vice Radar tracks and publicly calls out everyone with visible activity status,
        // opted in or not. The role only controls whether they personally get DM'd about a
        // match, not whether they're counted, so intentionally no opt-in check here.
        const games = playingGameNames(newPresence);

        await applyRadarPresence(guildId, member, games);
    } catch (error) {
        console.error('Error in presenceUpdate event:', error);
    }
}

// Reconciles one member's tracked games against what they're actually playing, then
// re-evaluates every game the change touched.
//
// oldPresence is deliberately ignored rather than diffed: it's null whenever the member
// wasn't already in the presence cache, which is exactly the case on the first event
// after a restart, so diffing against it would silently miss that first game start.
async function applyRadarPresence(guildId, member, currentGames) {
    const games = radarGamesFor(guildId);
    const touched = new Set();

    // Drop them from anything they're no longer playing.
    for (const [gameName, entry] of games.entries()) {
        if (currentGames.has(gameName)) continue;
        if (entry.activeMembers.delete(member.id)) touched.add(gameName);
    }

    // Add them to anything new.
    for (const gameName of currentGames) {
        let entry = games.get(gameName);

        if (!entry) {
            // The DM and public sides each carry their own fired-flag and debounce timer,
            // because a count of exactly 2 must arm the DM state while leaving the public
            // state unfired. One shared triple only worked while they shared a threshold.
            entry = {
                activeMembers: new Set(),

                // One DM per opted-in member per streak, kept current by editing it
                // rather than sending another: userId -> { message, signature }. A null
                // message is a send that failed (closed DMs, bot blocked), remembered
                // as a claim so it is not retried on every presence event. The
                // signature is what that person was last shown, so an edit round can
                // skip anyone whose DM would come out identical.
                dmMessages: new Map(),
                dmEditTimer: null,
                dmResetTimer: null,

                // Minted with the first DM that carries a group-chat button, and the
                // key the button press is resolved through.
                matchToken: null,
                groupThreadId: null,
                groupThreadPending: false,

                publicPosted: false,
                publicPeak: 0,
                publicResetTimer: null
            };
            games.set(gameName, entry);
        }

        if (!entry.activeMembers.has(member.id)) {
            entry.activeMembers.add(member.id);
            touched.add(gameName);
        }
    }

    for (const gameName of touched) {
        await evaluateRadarGame(guildId, gameName);
    }
}

// Decides whether a game's current headcount is worth DMing or announcing. Runs after
// every change to that game's roster. The two thresholds are independent: a count can
// clear the DM threshold without clearing the public one, and each has its own debounced
// reset so a brief presence dip doesn't wipe either state early.
async function evaluateRadarGame(guildId, gameName) {
    const games = radarGamesFor(guildId);
    const entry = games.get(gameName);
    if (!entry) return;

    await evaluateDmThreshold(guildId, gameName, entry);
    await evaluatePublicThreshold(guildId, gameName, entry);
}

// Forgets a streak: the DMs already sent, the pending edit round, the group-chat token
// and the thread it opened. The thread itself is deliberately left where it is - people
// may still be talking in it - it just stops being this match's thread.
function resetDmStreak(entry) {
    entry.dmMessages.clear();

    if (entry.dmEditTimer) {
        clearTimeout(entry.dmEditTimer);
        entry.dmEditTimer = null;
    }

    if (entry.matchToken) matchTokens.delete(entry.matchToken);
    entry.matchToken = null;
    entry.groupThreadId = null;
    entry.groupThreadPending = false;
}

async function evaluateDmThreshold(guildId, gameName, entry) {
    const count = entry.activeMembers.size;

    if (count < RADAR_DM_MIN_SQUAD) {
        // Don't reset the instant the count dips. A member's activity can blink off for a
        // few seconds and come right back, and resetting on that made the same two people
        // get re-DM'd as a brand new match. Schedule the reset instead, so a quick recovery
        // can cancel it, and decide what it does at fire time rather than now.
        if (!entry.dmResetTimer) {
            entry.dmResetTimer = setTimeout(() => {
                const currentGames = radarGamesFor(guildId);
                const currentEntry = currentGames.get(gameName);
                if (!currentEntry) return;

                currentEntry.dmResetTimer = null;

                if (currentEntry.activeMembers.size === 0) {
                    // Nobody playing it at all: drop the entry so the map doesn't collect
                    // dead games. Deletion lives here rather than in the public timer
                    // because the DM threshold is the lower of the two, so an empty roster
                    // is always below it too. A public timer still pending against the
                    // deleted entry no-ops on its own missing-entry guard.
                    resetDmStreak(currentEntry);
                    currentGames.delete(gameName);
                } else if (currentEntry.activeMembers.size < RADAR_DM_MIN_SQUAD) {
                    // Still short after the full grace period, so the session really ended.
                    // Keep the roster - the next person to start this game has to be able
                    // to see who's already on it - but forget the streak.
                    resetDmStreak(currentEntry);
                }
                // else: recovered while this timer was pending; the recovery already
                // cancelled it, so this is a safe no-op if the timing overlaps.
            }, RADAR_RESET_GRACE_MS);

            // Forgetting a streak is not worth holding the process open for five
            // minutes at shutdown. A restart forgets it anyway: radar state is in
            // memory only.
            entry.dmResetTimer.unref?.();
        }

        return;
    }

    // Back at or above threshold: cancel any pending reset from a brief dip.
    if (entry.dmResetTimer) {
        clearTimeout(entry.dmResetTimer);
        entry.dmResetTimer = null;
    }

    // Discord Activities never earn a DM, however many people are playing. This gate is
    // deliberately here and not in evaluatePublicThreshold: the public callout and the
    // board headcount still count them, because the headcount is true either way.
    if (isDmExcludedGame(gameName, RADAR_DM_IGNORED_GAMES)) return;

    await syncRadarDms(guildId, gameName, entry);
}

async function evaluatePublicThreshold(guildId, gameName, entry) {
    const count = entry.activeMembers.size;

    if (count < RADAR_PUBLIC_MIN_SQUAD) {
        if (!entry.publicResetTimer) {
            entry.publicResetTimer = setTimeout(() => {
                const currentGames = radarGamesFor(guildId);
                const currentEntry = currentGames.get(gameName);
                if (!currentEntry) return;

                currentEntry.publicResetTimer = null;

                if (currentEntry.activeMembers.size < RADAR_PUBLIC_MIN_SQUAD) {
                    currentEntry.publicPosted = false;
                    currentEntry.publicPeak = 0;
                }
            }, RADAR_RESET_GRACE_MS);

            entry.publicResetTimer.unref?.();
        }

        return;
    }

    if (entry.publicResetTimer) {
        clearTimeout(entry.publicResetTimer);
        entry.publicResetTimer = null;
    }

    if (!entry.publicPosted) {
        entry.publicPosted = true;
        entry.publicPeak = count;
        await postRadarEmbed(guildId, gameName, count);
        return;
    }

    // Already posted this streak, so only a new high-water mark earns another post.
    if (count > entry.publicPeak) {
        entry.publicPeak = count;
        await postRadarEmbed(guildId, gameName, count);
    }
}

// ---------------------------------------------------------------------------
// DMs
// ---------------------------------------------------------------------------
//
// One DM per opted-in member per streak, and it is kept current by editing it rather
// than by sending another. Somebody joining a match that has already been announced
// therefore does not cost everyone else a second notification - they just see the list
// in the DM they already have grow by a name.
//
// Only the DM is gated on the Radar role, and that is filtered here at send time rather
// than upstream, so people who have not opted in still count toward the match.

// Resolves a match into the pieces every DM decision needs. Member lookups are
// cache-first because this now runs on every roster change rather than once per streak.
async function resolveMatch(guildId, entry) {
    const radar = radarConfigFor(guildId);
    if (!radar) return null;

    const guild = await resolveGuild(guildId);
    if (!guild) return null;

    const members = new Map();

    for (const userId of entry.activeMembers) {
        const member = guild.members.cache.get(userId)
            || await guild.members.fetch(userId).catch(() => null);

        if (member) members.set(userId, member);
    }

    // Anyone who could not be resolved is left out of both the roster and the count,
    // rather than inflating a headcount with somebody nobody can be pointed at.
    const rosterIds = [...entry.activeMembers].filter(userId => members.has(userId));
    const optedInIds = rosterIds.filter(userId => members.get(userId).roles.cache.has(radar.roleId));

    return { radar, guild, rosterIds, optedInIds, members };
}

// The short id a group-chat button carries. Minted lazily, because a match where only
// one person is on Radar has nobody to group up with and so never shows the button.
function ensureMatchToken(guildId, gameName, entry) {
    if (entry.matchToken) return entry.matchToken;

    const token = randomBytes(4).toString('hex');
    matchTokens.set(token, { guildId, gameName });
    entry.matchToken = token;

    return token;
}

function suggestionChannels(guildId, radar) {
    return {
        lfgId: SERVER_CONFIGS[guildId]?.lobby?.channelId,
        gameForumsId: radar.gameForumsChannelId,
        gameChatId: radar.gameChatChannelId
    };
}

// Which of the two layouts one recipient sees: the squad list when there is somebody to
// name, and otherwise the solo version, which points them at the places they can go and
// round up players themselves.
function dmPayloadFor({ guildId, gameName, entry, match, item, iconURL }) {
    const others = item.otherOptedInIds.map(userId => ({
        id: userId,
        displayName: match.members.get(userId)?.displayName
    }));

    const color = dmColorFor(gameName);

    if (others.length === 0) {
        return buildSoloDm({
            gameName,
            guildId,
            guildName: match.guild.name,
            totalCount: item.totalCount,
            channels: suggestionChannels(guildId, match.radar),
            brandName: RADAR_BRAND_NAME,
            color,
            iconURL
        });
    }

    return buildSquadDm({
        gameName,
        others,
        totalCount: item.totalCount,
        matchToken: ensureMatchToken(guildId, gameName, entry),
        brandName: RADAR_BRAND_NAME,
        color,
        iconURL
    });
}

function signaturesOf(entry) {
    return new Map([...entry.dmMessages].map(([userId, record]) => [userId, record.signature]));
}

// First DMs, which go out immediately, and then a coalesced round of edits for anyone
// already holding one whose list has changed.
async function syncRadarDms(guildId, gameName, entry) {
    const match = await resolveMatch(guildId, entry);
    if (!match) return;

    const { send, update } = planRadarDms({
        rosterIds: match.rosterIds,
        optedInIds: match.optedInIds,
        alreadyDmed: signaturesOf(entry)
    });

    // Claimed synchronously, before the first await below: presence events keep arriving
    // while DMs go out, and a re-entrant call would otherwise DM the same person twice.
    for (const item of send) {
        entry.dmMessages.set(item.recipientId, { message: null, signature: item.signature });
    }

    if (update.length > 0) scheduleDmEdits(guildId, gameName);
    if (send.length === 0) return;

    const iconURL = await radarIconURL();

    for (const item of send) {
        const member = match.members.get(item.recipientId);
        const record = entry.dmMessages.get(item.recipientId);
        if (!member || !record) continue;

        const payload = dmPayloadFor({ guildId, gameName, entry, match, item, iconURL });

        try {
            record.message = await member.send(payload);
        } catch (error) {
            // Closed DMs are normal, not a fault worth alerting staff about. The claim
            // stays behind so this is not attempted again every time the roster moves.
            console.log(`Could not send Vice Radar DM to ${member.user.tag}`);
        }
    }
}

function scheduleDmEdits(guildId, gameName) {
    const entry = radarGamesFor(guildId).get(gameName);
    if (!entry || entry.dmEditTimer) return;

    entry.dmEditTimer = setTimeout(() => {
        const current = radarGamesFor(guildId).get(gameName);
        if (current) current.dmEditTimer = null;

        void runDmEdits(guildId, gameName);
    }, RADAR_DM_EDIT_DELAY_MS);

    entry.dmEditTimer.unref?.();
}

// Brings every DM already sent for this match up to date. Recomputed from the live roster
// at fire time rather than from whatever it looked like when the edit was scheduled, so a
// burst of starts and stops costs one round of edits and lands on the truth.
async function runDmEdits(guildId, gameName) {
    const entry = radarGamesFor(guildId).get(gameName);
    if (!entry || entry.dmMessages.size === 0) return;

    // On its way below the threshold: the streak is about to be forgotten, and an
    // emptied-out list is worse reading than the one they already have.
    if (entry.activeMembers.size < RADAR_DM_MIN_SQUAD) return;
    if (isDmExcludedGame(gameName, RADAR_DM_IGNORED_GAMES)) return;

    const match = await resolveMatch(guildId, entry);
    if (!match) return;

    const { update } = planRadarDms({
        rosterIds: match.rosterIds,
        optedInIds: match.optedInIds,
        alreadyDmed: signaturesOf(entry)
    });

    if (update.length === 0) return;

    const iconURL = await radarIconURL();

    for (const item of update) {
        const record = entry.dmMessages.get(item.recipientId);
        if (!record) continue;

        // The new signature is recorded either way. A DM that cannot be edited is not
        // worth re-attempting on every later roster change, and the claim has to stay
        // behind: dropping it would put this person back in `send` and earn them the
        // duplicate DM the whole arrangement exists to avoid.
        record.signature = item.signature;

        if (!record.message) continue;

        try {
            await record.message.edit(dmPayloadFor({ guildId, gameName, entry, match, item, iconURL }));
        } catch (error) {
            console.log(`Could not update the Vice Radar DM for ${item.recipientId} on ${gameName}: ${error.message}`);
            record.message = null;
        }
    }

    await addLateJoinersToGroupThread(entry, match);
}

// ---------------------------------------------------------------------------
// The group chat
// ---------------------------------------------------------------------------
//
// A bot cannot open a real group DM: that endpoint belongs to the retired GameBridge SDK
// and needs an OAuth2 token from every person who would be in it. A private thread in the
// radar channel is the closest thing on offer - one shared room, visible only to the
// people added to it.

function groupThreadLink(guildId, threadId) {
    return `https://discord.com/channels/${guildId}/${threadId}`;
}

function isRadarButton(customId) {
    return typeof customId === 'string' && customId.startsWith('radar:');
}

// At most one staff log per guild per hour: a radar channel the bot cannot create threads
// in would otherwise log on every press.
const groupThreadErrorLogged = new Map();
const GROUP_THREAD_ERROR_LOG_MS = 60 * 60 * 1000;

async function logGroupThreadFailure(guildId, gameName, error) {
    console.error(`Vice Radar: could not open a group chat for ${gameName} in ${guildLabel(guildId)}:`, error.message);

    const last = groupThreadErrorLogged.get(guildId) || 0;
    if (Date.now() - last < GROUP_THREAD_ERROR_LOG_MS) return;
    groupThreadErrorLogged.set(guildId, Date.now());

    await sendStaffLog(guildId, {
        color: LOG_COLORS.error,
        title: '⚠️ Vice Radar Group Chat Failed',
        description: `Somebody pressed **Start a group chat** for **${gameName}** in ${guildLabel(guildId)} and the thread could not be created.`,
        fields: [errorField(error)],
        footer: 'The bot needs Create Private Threads and Send Messages in Threads in the radar channel.'
    });
}

async function createGroupThread(guild, radar, gameName, entry) {
    const channel = await guild.channels.fetch(radar.channelId).catch(() => null);

    if (!channel?.threads) {
        throw new Error(`radar channel ${radar.channelId} cannot hold threads`);
    }

    const thread = await channel.threads.create({
        name: `${gameName} squad`.slice(0, 100),
        type: ChannelType.PrivateThread,
        invitable: false,
        // Short on purpose: this is a room for one session, not a channel.
        autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
        reason: 'Vice Radar group chat'
    });

    const added = [];

    for (const userId of entry.activeMembers) {
        const member = guild.members.cache.get(userId)
            || await guild.members.fetch(userId).catch(() => null);

        // Only the opted-in: being counted in a match is not consent to being put into a
        // chat about it.
        if (!member || !member.roles.cache.has(radar.roleId)) continue;

        const ok = await thread.members.add(userId).then(() => true).catch(() => false);
        if (ok) added.push(userId);
    }

    const mentions = added.map(userId => `<@${userId}>`).join(' ');

    await thread.send(
        `${mentions}\n\n\u{1F334} You are all playing **${gameName}** right now. Squad up here.`
    ).catch(error => {
        console.log(`Vice Radar: group chat opened but the welcome message failed: ${error.message}`);
    });

    return thread;
}

// Keeps an open group chat in step with the match, so somebody who started the game after
// the thread was created is not left out of it.
async function addLateJoinersToGroupThread(entry, match) {
    if (!entry.groupThreadId) return;

    const thread = await match.guild.channels.fetch(entry.groupThreadId).catch(() => null);

    if (!thread?.members || thread.archived) {
        entry.groupThreadId = null;
        return;
    }

    const existing = await thread.members.fetch()
        .then(members => new Set(members.keys()))
        .catch(() => null);

    if (!existing) return;

    for (const userId of match.optedInIds) {
        if (existing.has(userId)) continue;
        await thread.members.add(userId).catch(() => null);
    }
}

async function handleRadarButton(interaction) {
    // Deferred because creating a thread and adding everyone to it can outrun the three
    // seconds Discord allows for a first response.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // The group chat is the only radar button there has ever been. Anything else routed
    // here is answered rather than dropped, so a press can never hang.
    if (!interaction.customId.startsWith(GROUP_BUTTON_PREFIX)) {
        return interaction.editReply(RADAR_GROUP_ENDED);
    }

    const token = interaction.customId.slice(GROUP_BUTTON_PREFIX.length);

    const match = matchTokens.get(token);
    if (!match) return interaction.editReply(RADAR_GROUP_ENDED);

    const entry = radarGamesFor(match.guildId).get(match.gameName);
    if (!entry || entry.matchToken !== token) return interaction.editReply(RADAR_GROUP_ENDED);

    const radar = radarConfigFor(match.guildId);
    if (!radar) return interaction.editReply(RADAR_GROUP_ENDED);

    if (!entry.activeMembers.has(interaction.user.id)) {
        return interaction.editReply(RADAR_GROUP_NOT_YOURS);
    }

    // Claimed with no await in between, so two presses landing together cannot both
    // decide to create a thread. Released in the finally below on every path.
    if (entry.groupThreadPending) return interaction.editReply(RADAR_GROUP_PENDING);
    entry.groupThreadPending = true;

    try {
        const guild = await resolveGuild(match.guildId);
        if (!guild) return interaction.editReply(RADAR_GROUP_FAILED);

        const presser = guild.members.cache.get(interaction.user.id)
            || await guild.members.fetch(interaction.user.id).catch(() => null);

        if (!presser || !presser.roles.cache.has(radar.roleId)) {
            return interaction.editReply(RADAR_GROUP_NOT_YOURS);
        }

        if (entry.groupThreadId) {
            const existing = await guild.channels.fetch(entry.groupThreadId).catch(() => null);

            if (existing && !existing.archived) {
                await existing.members.add(interaction.user.id).catch(() => null);

                return interaction.editReply(
                    `\u{1F334} The group chat is open: ${groupThreadLink(match.guildId, existing.id)}`
                );
            }

            // Archived or deleted: open a fresh one rather than point at a dead room.
            entry.groupThreadId = null;
        }

        const thread = await createGroupThread(guild, radar, match.gameName, entry);
        entry.groupThreadId = thread.id;

        return interaction.editReply(
            `\u{1F334} Group chat ready: ${groupThreadLink(match.guildId, thread.id)}\n`
            + 'Everyone in this match who is on Vice Radar has been added.'
        );
    } catch (error) {
        await logGroupThreadFailure(match.guildId, match.gameName, error);

        return interaction.editReply(RADAR_GROUP_FAILED);
    } finally {
        entry.groupThreadPending = false;
    }
}

// The public, user-facing post. Intentionally not routed through sendStaffLog: that
// only ever posts to staff log channels, and this is community-facing copy.
async function postRadarEmbed(guildId, gameName, count) {
    try {
        const radar = radarConfigFor(guildId);
        if (!radar) return;

        const guild = await resolveGuild(guildId);
        if (!guild) return;

        const channelId = calloutChannelIdFor(radar);
        const channel = await guild.channels.fetch(channelId).catch(() => null);
        if (!channel || !channel.isTextBased()) {
            console.error(`Vice Radar callout channel ${channelId} not found or not text-based in ${guild.name}`);
            return;
        }

        // The radar icon goes in the thumbnail (top-right, ~80px and not circle-cropped)
        // rather than the author icon, which Discord pins to a fixed ~24px circle. The
        // author line is the plain brand name as a result; it keeps the palm tree only as
        // a fallback, so the post still carries a mark when the emoji can't be resolved.
        //
        // The CTA sits in the description rather than addFields because Discord puts a
        // fixed, larger gap above a fields section than between lines of the description.
        // Folding it in behind a single \n is the only lever that tightens that gap.
        const iconURL = await radarIconURL();

        const embed = new EmbedBuilder()
            .setColor(RADAR_COLORS[radarColorIndex % RADAR_COLORS.length])
            .setAuthor({ name: iconURL ? RADAR_BRAND_NAME : `${RADAR_BRAND_NAME} 🌴` })
            .setDescription(`## ${pickPhrase(count, gameName)}\n${radarCta(radar)}`);

        if (iconURL) {
            embed.setThumbnail(iconURL);
        }

        radarColorIndex++;

        // Mentions inside an embed never notify anybody, so this cannot mass-ping as it
        // stands. Set anyway, and asserted in the tests: the phrase bank is an editable
        // file on the server, and the day somebody moves a phrase into message content
        // is not the day to discover there was nothing stopping an @everyone.
        await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });

        console.log(`Vice Radar: posted ${gameName} (${count} playing) in ${guild.name}`);
    } catch (error) {
        console.error('Error posting Vice Radar embed:', error);

        await sendStaffLog(guildId, {
            color: LOG_COLORS.error,
            title: '⚠️ Vice Radar Post Failed',
            description: `A squad match for **${gameName}** could not be posted in ${guildLabel(guildId)}.`,
            fields: [errorField(error)],
            footer: 'Check the radar channel ID and that the bot can post embeds there.'
        });
    }
}

// Leaving the server pulls the member out of every game they were counted in, exactly
// as if they'd stopped playing.

async function handleGuildMemberRemove(member) {
    try {
        if (!radarConfigFor(member.guild.id)) return;
        await applyRadarPresence(member.guild.id, member, new Set());

        // Somebody who has left the server should not still be in next Sunday's numbers.
        // Required lazily: the digest requires this module, so a top-level require here
        // would be a cycle.
        require('./game-digest').forgetMember(member.guild.id, member.id);
    } catch (error) {
        console.error('Error clearing Vice Radar state on member leave:', error);
    }
}

// Opting in while already playing should not mean waiting for the next presence event to
// hear about the game you are in the middle of. Nothing about the roster changes here -
// tracking is not tied to the role, see below - so this just re-runs the DM decisions for
// the games this member is already counted in, which sends them theirs and folds them
// into everyone else's on the next round of edits.
async function handleGuildMemberUpdate(oldMember, newMember) {
    try {
        const radar = radarConfigFor(newMember?.guild?.id);
        if (!radar) return;

        const had = Boolean(oldMember?.roles?.cache?.has(radar.roleId));
        const has = Boolean(newMember?.roles?.cache?.has(radar.roleId));

        // Only a fresh opt-in. Opting out is handled where it is decided: by the role
        // check in resolveMatch, which runs every time the roster moves.
        if (had || !has) return;

        for (const [gameName, entry] of radarGamesFor(newMember.guild.id)) {
            if (!entry.activeMembers.has(newMember.id)) continue;
            await evaluateRadarGame(newMember.guild.id, gameName);
        }
    } catch (error) {
        console.error('Error handling a Vice Radar role change:', error);
    }
}

// Deliberately no listener for losing the opt-in role: tracking is not tied to the role,
// so someone who opts out while playing stays counted toward the squad. The role only
// decides whether they get DM'd, and resolveMatch checks that every time the roster
// moves - so somebody who opts out mid-match drops out of the next round of edits.

async function handleViceRadarCommand(interaction) {
    try {
        const radar = radarConfigFor(interaction.guildId);
        if (!radar) {
            return interaction.reply({ content: '❌ Vice Radar is not configured for this server.', flags: MessageFlags.Ephemeral });
        }

        if (!canManageRole(interaction.guild, radar.roleId)) {
            return interaction.reply({ content: '❌ I cannot manage the Vice Radar role. My role must be positioned above it in server settings.', flags: MessageFlags.Ephemeral });
        }

        const action = interaction.options.getString('action');
        const member = interaction.member;

        if (action === 'join') {
            if (member.roles.cache.has(radar.roleId)) {
                return interaction.reply({ content: '🔔 You\'re already on Vice Radar.', flags: MessageFlags.Ephemeral });
            }

            await member.roles.add(radar.roleId);
            console.log(`Vice Radar: ${interaction.user.tag} opted in via /vice-radar in ${interaction.guild.name}`);

            return interaction.reply({
                content: '🔔 You\'re on **Vice Radar**. You\'ll get a DM when other Vicers are playing the same game as you.\n\n' +
                    'One thing: Discord only shows what you\'re playing if **Settings → Activity Privacy → "Display current activity as a status message"** is on. With it off, nobody can match with you.',
                flags: MessageFlags.Ephemeral
            });
        }

        if (!member.roles.cache.has(radar.roleId)) {
            return interaction.reply({ content: 'You\'re not on Vice Radar right now.', flags: MessageFlags.Ephemeral });
        }

        await member.roles.remove(radar.roleId);
        // The guildMemberUpdate listener above also clears this; doing it here too just
        // means the count is correct immediately rather than an event later. Idempotent.
        await applyRadarPresence(interaction.guildId, member, new Set());
        console.log(`Vice Radar: ${interaction.user.tag} opted out via /vice-radar in ${interaction.guild.name}`);

        return interaction.reply({ content: 'You\'re off **Vice Radar**. Run `/vice-radar join` any time to come back.', flags: MessageFlags.Ephemeral });
    } catch (error) {
        console.error('Error handling /vice-radar:', error);
        await respondWithError(interaction, '❌ Something went wrong updating your Vice Radar role. Please try again.');
    }
}

module.exports = {
    RADAR_COMMAND,
    radarConfigFor,
    radarGamesFor,
    playingGameNames,
    radarCta,
    handlePresenceUpdate,
    applyRadarPresence,
    evaluateRadarGame,
    syncRadarDms,
    runDmEdits,
    postRadarEmbed,
    isRadarButton,
    handleRadarButton,
    handleGuildMemberRemove,
    handleGuildMemberUpdate,
    handleViceRadarCommand,
    calloutChannelIdFor,
    RADAR_COLORS,
    radarIconURL,
    RADAR_BRAND_NAME,
    RADAR_DM_MIN_SQUAD,
    RADAR_PUBLIC_MIN_SQUAD,
};
