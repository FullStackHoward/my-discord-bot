// ---------------------------------------------------------------------------
// Vice Radar: weekly "top 5 games" digest
// ---------------------------------------------------------------------------
//
// Vice Gamers only. Samples the guild presence cache every five minutes, credits five
// minutes per member per game, and posts a ranked embed to the callout channel every
// Sunday at 5 PM Eastern.
//
// Who is counted: every non-bot member whose Discord activity is visible. That is the
// same posture Radar has always had - the opt-in role decides who gets DM'd, never who
// is counted - and it is what makes the title of the post true. A member who does not
// want to be counted turns off Settings -> Activity Privacy -> "Display current activity
// as a status message", which is exactly what the footer tells them.
//
// What is stored: aggregates for the post, and per member, per game, per hour minute
// counts to compute them from. Those are deleted as soon as the digest that consumed
// them has posted - see store.js.

const https = require('node:https');
const { MessageFlags, PermissionFlagsBits, ApplicationCommandOptionType } = require('discord.js');
const { SERVER_CONFIGS, VG_GUILD_ID, LOG_COLORS, LOBBY_TZ } = require('../../config');
const { sendStaffLog, errorField } = require('../../staff-log');
const { resolveGuild, guildLabel } = require('../../utils');
const time = require('../../lobby/time');
const radar = require('../index');
const digest = require('./digest');
const store = require('./store');
const identity = require('./identity');
const gamesConfig = require('./games-config');

// Five-minute slots aligned to the wall clock, so twelve samples make an hour however
// the tick happens to land.
const SAMPLE_MINUTES = 5;
const SAMPLE_SLOT_MS = SAMPLE_MINUTES * 60 * 1000;

const COMMUNITY_SLUG = 'vicegamers';

// The history write is off until the endpoint exists. Results still queue locally, so
// nothing is lost by leaving it off, and nothing hammers a 404 by leaving it on.
const API_ENABLED = process.env.RADAR_DIGEST_API_ENABLED === 'true';
const API_HOST = 'api.vicers.net';
const API_PATH = '/api/gaming/weekly-game-stats/';

// At most one sampler error in the log per hour, per the spec: a presence cache the bot
// cannot read would otherwise write a line every five minutes forever.
const SAMPLER_ERROR_LOG_MS = 60 * 60 * 1000;
let lastSamplerErrorLoggedAt = 0;

// ---------------------------------------------------------------------------
// Which guilds run this
// ---------------------------------------------------------------------------

// Vice Gamers only, and only while Radar is configured there, so the digest can never
// be the thing that turns Radar's channel lookups on.
function digestGuildIds() {
    if (!VG_GUILD_ID) return [];
    if (!radar.radarConfigFor(VG_GUILD_ID)) return [];

    return [VG_GUILD_ID];
}

function isDigestGuild(guildId) {
    return digestGuildIds().includes(guildId);
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

function logSamplerError(error) {
    const now = Date.now();
    if (now - lastSamplerErrorLoggedAt < SAMPLER_ERROR_LOG_MS) return;

    lastSamplerErrorLoggedAt = now;
    console.error('Radar digest: sampler failed, will try again next slot:', error.message);
}

// One pass over the presence cache. Returns counts only - never who, never what - so
// the log line it feeds cannot leak a roster.
async function sampleGuild(guildId, nowMs) {
    const guild = await resolveGuild(guildId);
    if (!guild) return { members: 0, credits: 0 };

    const compiled = identity.compileGameConfig(gamesConfig.loadGameConfig());

    let members = 0;
    let credits = 0;

    for (const presence of guild.presences.cache.values()) {
        // Invisible is reported as offline, so this covers both, and somebody who is
        // offline is not playing anything the server can see.
        if (!presence.status || presence.status === 'offline') continue;

        const userId = presence.userId || presence.user?.id;
        if (!userId) continue;

        const user = presence.user || guild.members.cache.get(userId)?.user;
        if (user?.bot) continue;

        const games = identity.gamesForPresence(presence, compiled);
        if (games.size === 0) continue;

        members += 1;

        for (const [gameKey, displayName] of games) {
            store.credit(guildId, nowMs, userId, gameKey, displayName, SAMPLE_MINUTES);
            credits += 1;
        }
    }

    return { members, credits };
}

// ---------------------------------------------------------------------------
// Building the week
// ---------------------------------------------------------------------------

// A custom alias key, as opposed to one the identity rules generated. Anything still
// carrying a raw prefix has not been curated, which is what the preview surfaces.
function isUnmapped(gameKey) {
    return gameKey.startsWith(identity.NAME_PREFIX) || gameKey.startsWith(identity.APP_PREFIX);
}

// Everything the post and the preview both need. Pure apart from reading state.
// `windowStartMs` is only passed by the preview, which reports the last seven days up
// to now rather than a scheduled Sunday-to-Sunday window.
function buildReport(guildId, windowEndMs, { windowStartMs = null } = {}) {
    const guild = store.guildState(guildId);
    const windowStart = windowStartMs ?? digest.windowStartFor(windowEndMs, LOBBY_TZ);

    // On the first run there is no data as far back as the window reaches, so the window
    // opens at the first sample instead and the post says as much.
    const firstSampleAt = guild.firstSampleAt;
    const partial = !firstSampleAt || firstSampleAt > windowStart;
    const effectiveStart = partial && firstSampleAt ? firstSampleAt : windowStart;

    const tally = digest.tallyWindow(guild.buckets, effectiveStart, windowEndMs);
    const { rows, belowPlayerFloor, qualifyingGames } = digest.rankGames(tally);

    // Curation help for the preview: titles with enough players to matter that are still
    // on a generated key. Names only, no members.
    const unmapped = [...tally.entries()]
        .filter(([key]) => isUnmapped(key))
        .map(([key, perMember]) => ({ key, name: guild.labels[key] || key, players: perMember.size }))
        .sort((a, b) => b.players - a.players)
        .slice(0, 10);

    return {
        windowStart: effectiveStart,
        windowEnd: windowEndMs,
        partial,
        rows: digest.withChange(rows, guild.lastResult),
        labels: guild.labels,
        belowPlayerFloor,
        qualifyingGames,
        unmapped
    };
}

async function digestEmbedFor(guildId, report) {
    const radarConfig = radar.radarConfigFor(guildId);

    return digest.buildDigestEmbed({
        rows: report.rows,
        labels: report.labels,
        firstWeek: report.partial,
        color: radar.RADAR_COLORS[0],
        iconURL: await radar.radarIconURL(),
        ctaChannelId: radarConfig?.optInChannelId || null
    });
}

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------

async function resolveCalloutChannel(guildId) {
    const radarConfig = radar.radarConfigFor(guildId);
    if (!radarConfig) return null;

    const guild = await resolveGuild(guildId);
    if (!guild) return null;

    const channelId = radar.calloutChannelIdFor(radarConfig);
    const channel = await guild.channels.fetch(channelId).catch(() => null);

    return channel?.isTextBased() ? channel : null;
}

// Returns true when the week is settled, which is the only thing that marks it handled.
// A channel the bot cannot reach deliberately leaves the week unhandled, so the next
// tick tries again rather than silently skipping a week.
async function postWeekly(guildId, nowMs, windowEndMs, weekKey) {
    const report = buildReport(guildId, windowEndMs);
    const channel = await resolveCalloutChannel(guildId);

    if (!channel) {
        await sendStaffLog(guildId, {
            color: LOG_COLORS.error,
            title: '⚠️ Weekly Game Digest Could Not Post',
            description: `The callout channel for ${guildLabel(guildId)} is missing or the bot cannot post in it, so this week's top 5 was not posted. It will be retried on the next pass.`,
            footer: 'Check VG_RADAR_CALLOUT_CHANNEL (or VG_RADAR_CHANNEL) and the bot permissions there.'
        });

        return false;
    }

    // Nothing qualified. On the first run that is worth saying out loud, because the
    // feature has just been announced and silence reads as broken. From week two it is
    // a quiet week, and a post saying so every time would be noise.
    if (report.rows.length === 0) {
        if (!report.partial) {
            console.log(`Radar digest: nothing qualified for ${guildLabel(guildId)} this week, skipping the post.`);

            await sendStaffLog(guildId, {
                color: LOG_COLORS.lobby,
                title: '\u{1F4C5} Weekly Game Digest Skipped',
                description: `No game reached ${digest.MIN_UNIQUE_PLAYERS} players for ${digest.MIN_MINUTES_PER_PLAYER} minutes in ${guildLabel(guildId)} this week, so nothing was posted.`
            });

            store.setHandledWeek(guildId, weekKey, { lastResult: [] });
            return true;
        }

        const sent = await channel.send({
            content: digest.EMPTY_FIRST_WEEK,
            allowedMentions: { parse: [] }
        });

        store.setHandledWeek(guildId, weekKey, { lastPostedMessageId: sent.id, lastResult: [] });
        return true;
    }

    const embed = await digestEmbedFor(guildId, report);

    // No member names, no mentions, and the payload cannot parse one even if a game
    // title somehow contained one.
    const sent = await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });

    // Aggregates only: what is kept for next week's up/down/new is the ranking, and no
    // member ID is in it.
    const carried = report.rows.map(row => ({
        key: row.key,
        name: report.labels[row.key] || row.key,
        uniquePlayers: row.uniquePlayers,
        hours: row.hours
    }));

    store.setHandledWeek(guildId, weekKey, { lastPostedMessageId: sent.id, lastResult: carried });

    console.log(`Radar digest: posted the top ${report.rows.length} for ${guildLabel(guildId)} (week ${weekKey}).`);

    queueHistory(guildId, weekKey, report);

    // Consumed, so gone. Everything before the window just reported can no longer
    // affect any future post.
    const dropped = store.pruneBuckets(guildId, report.windowStart);
    if (dropped > 0) console.log(`Radar digest: pruned ${dropped} consumed hourly bucket(s) for ${guildLabel(guildId)}.`);

    return true;
}

// A Sunday that passed while the bot was down. Recorded so it is not chased forever,
// and logged so Howard knows a week is missing rather than wondering.
async function noteMissedWeek(guildId, nowMs) {
    const missedEnd = digest.windowEndFor(nowMs, LOBBY_TZ);
    if (!missedEnd) return;

    const key = time.localIsoDate(missedEnd, LOBBY_TZ);
    const guild = store.guildState(guildId);

    if (guild.lastHandledWeek === key) return;

    // Still the same Eastern day: the posting path below is allowed to catch up, so
    // this is not a miss yet.
    if (time.localIsoDate(nowMs, LOBBY_TZ) === key) return;

    // Predates any data, which is every Sunday before the feature was deployed. Recorded
    // silently rather than reported as a failure.
    if (!guild.firstSampleAt || missedEnd < guild.firstSampleAt) {
        store.setHandledWeek(guildId, key);
        return;
    }

    store.setHandledWeek(guildId, key);

    await sendStaffLog(guildId, {
        color: LOG_COLORS.mismatch,
        title: '\u{1F4C5} Weekly Game Digest Missed',
        description: `The 5 PM Sunday digest for ${key} did not post in ${guildLabel(guildId)}, and the Eastern day has rolled over, so it has been skipped rather than posted late. Sampling was unaffected and next Sunday is unchanged.`
    });
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

async function maybePostWeekly(guildId, nowMs) {
    const parts = time.localParts(nowMs, LOBBY_TZ);

    if (parts.weekday !== digest.DIGEST_WEEKDAY || parts.hour < digest.DIGEST_HOUR) {
        await noteMissedWeek(guildId, nowMs);
        return;
    }

    const todayKey = time.localIsoDate(nowMs, LOBBY_TZ);
    if (store.guildState(guildId).lastHandledWeek === todayKey) return;

    const windowEnd = digest.windowEndFor(nowMs, LOBBY_TZ);
    if (!windowEnd) return;

    // Any tick after 5 PM on the day covers the catch-up case on its own: the window end
    // is the scheduled instant, not now, so a post an hour late still reports the right
    // seven days.
    await postWeekly(guildId, nowMs, windowEnd, todayKey);
}

// Called once a minute. Sampling is gated on the five-minute slot rather than the tick,
// so the interval can drift or restart without changing what gets credited.
async function runDigestTick(nowMs = Date.now()) {
    const slot = Math.floor(nowMs / SAMPLE_SLOT_MS);

    for (const guildId of digestGuildIds()) {
        try {
            if (store.claimSlot(guildId, slot)) {
                const counts = await sampleGuild(guildId, nowMs);

                if (counts.credits > 0 && slot % 12 === 0) {
                    // Once an hour, counts only.
                    console.log(`Radar digest: sampled ${counts.members} member(s) across ${counts.credits} game credit(s) in ${guildLabel(guildId)}.`);
                }
            }
        } catch (error) {
            logSamplerError(error);
        }

        try {
            await maybePostWeekly(guildId, nowMs);
        } catch (error) {
            console.error(`Radar digest: the weekly post failed for ${guildLabel(guildId)}:`, error.message);
        }

        try {
            // Safety net beside the prune at post time, so a guild that somehow never
            // posts cannot accumulate member data indefinitely.
            store.pruneBuckets(guildId, nowMs - store.RETENTION_MS);
        } catch (error) {
            console.error('Radar digest: pruning failed:', error.message);
        }

        try {
            await flushHistoryQueue(guildId);
        } catch (error) {
            console.error('Radar digest: the history queue could not be flushed:', error.message);
        }
    }
}

// ---------------------------------------------------------------------------
// History, for the site to use later
// ---------------------------------------------------------------------------

// Aggregates only. No member IDs, no names, nothing that identifies anybody.
function historyRecord(weekKey, report) {
    return {
        community: COMMUNITY_SLUG,
        weekStart: weekKey,
        windowStart: new Date(report.windowStart).toISOString(),
        windowEnd: new Date(report.windowEnd).toISOString(),
        isFirstWeekPartial: report.partial,
        games: report.rows.map(row => ({
            game_key: row.key,
            display_name: report.labels[row.key] || row.key,
            unique_players: row.uniquePlayers,
            total_hours: Number(row.hours.toFixed(1)),
            rank: row.rank
        }))
    };
}

function queueHistory(guildId, weekKey, report) {
    store.queueApiWrite(guildId, historyRecord(weekKey, report));
}

function postHistory(record) {
    const payload = JSON.stringify(record);

    const options = {
        hostname: API_HOST,
        path: API_PATH,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Bot-Secret': process.env.BOT_API_SECRET,
            'Content-Length': Buffer.byteLength(payload)
        }
    };

    return new Promise((resolve, reject) => {
        const request = https.request(options, response => {
            let body = '';
            response.on('data', chunk => { body += chunk; });
            response.on('end', () => {
                // The endpoint upserts on (community, week_start, game_key), so a retry
                // of a write that actually landed is harmless either way.
                if (response.statusCode === 200 || response.statusCode === 201) resolve(body);
                else reject(new Error(`API responded with ${response.statusCode}: ${body}`));
            });
        });

        request.on('error', reject);
        request.write(payload);
        request.end();
    });
}

// Never blocks a post: the digest goes out first and the history follows whenever the
// API is reachable.
async function flushHistoryQueue(guildId) {
    const queued = store.takeApiQueue(guildId);
    if (queued.length === 0) return;

    if (!API_ENABLED) return;

    for (const record of queued) {
        try {
            await postHistory(record);
            store.clearQueuedWrite(guildId, record.weekStart);
            console.log(`Radar digest: stored the ${record.weekStart} history record.`);
        } catch (error) {
            console.warn(`Radar digest: history write for ${record.weekStart} failed, staying queued: ${error.message}`);
            return;
        }
    }
}

module.exports = {
    SAMPLE_MINUTES,
    SAMPLE_SLOT_MS,
    digestGuildIds,
    isDigestGuild,
    sampleGuild,
    buildReport,
    digestEmbedFor,
    postWeekly,
    maybePostWeekly,
    noteMissedWeek,
    runDigestTick,
    historyRecord,
    flushHistoryQueue,
    startFlushing: store.startFlushing,
    flush: store.flush,
    forgetMember: store.forgetMember,
};
