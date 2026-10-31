// ---------------------------------------------------------------------------
// The weekly digest: window maths, ranking, and the embed
// ---------------------------------------------------------------------------
//
// Pure, in the shape of lib/lobby/stages.js: the caller passes the clock in, so the
// DST cases can be tested with frozen instants instead of being waited for.
//
// The one rule that governs everything here: time zones are handled by scanning forward
// in UTC and asking Intl what the local clock says, never by adding a cached offset. A
// fixed -4 would have fired the first digest at 4 PM Eastern, because the clocks go back
// on the morning of Sunday Nov 1 2026. lib/lobby/time.js already does it the right way
// and is reused rather than reimplemented.

const { EmbedBuilder } = require('discord.js');
const time = require('../../lobby/time');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Sunday, 5:00 PM in the digest's zone.
const DIGEST_WEEKDAY = 0;
const DIGEST_HOUR = 17;
const DIGEST_MINUTE = 0;

// A member has to have been seen on a game for this long inside the window before they
// count toward it: three samples. Stops a glance at a launcher registering as "played".
const MIN_MINUTES_PER_PLAYER = 15;

// A game nobody else was playing is one person's evening, not something the server did,
// and naming it would single them out in a post that otherwise names nobody.
const MIN_UNIQUE_PLAYERS = 2;

const MAX_ROWS = 5;

const FOOTER = 'Counts members who share their activity on Discord.';
const TITLE = 'What the Lounge played this week';
const FIRST_WEEK_LABEL = 'First week, tracking started Saturday';
const EMPTY_FIRST_WEEK = 'Vice Radar is now tracking what the Lounge plays. First full top 5 drops next Sunday at 5 PM.';

// ---------------------------------------------------------------------------
// When the window opens and closes
// ---------------------------------------------------------------------------

// The most recent Sunday 5 PM at or before `nowMs`, or null if there has not been one
// within the last eight days. Used as the window end rather than the current time, so a
// catch-up post an hour late still reports the window that was meant to be reported.
function windowEndFor(nowMs, zone) {
    let cursor = time.nextWeeklyOccurrence(nowMs - 8 * DAY_MS, zone, DIGEST_WEEKDAY, DIGEST_HOUR, DIGEST_MINUTE);
    let latest = null;

    while (cursor && cursor <= nowMs) {
        latest = cursor;
        cursor = time.nextWeeklyOccurrence(cursor, zone, DIGEST_WEEKDAY, DIGEST_HOUR, DIGEST_MINUTE);
    }

    return latest;
}

// Seven calendar days before the end, which across a clock change is not 168 hours.
// Found by scanning forward from nine days back, so the answer is whatever instant
// carries the same local wall-clock time, whatever the offset did in between.
function windowStartFor(endMs, zone) {
    return time.nextWeeklyOccurrence(endMs - 9 * DAY_MS, zone, DIGEST_WEEKDAY, DIGEST_HOUR, DIGEST_MINUTE);
}

function nextPostAfter(nowMs, zone) {
    return time.nextWeeklyOccurrence(nowMs, zone, DIGEST_WEEKDAY, DIGEST_HOUR, DIGEST_MINUTE);
}

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

// Buckets are { hourStartUtc: { memberId: { gameKey: minutes } } }. Hourly, because the
// window boundaries land on the hour, so a window is a whole number of buckets and no
// sample is ever half in and half out.
//
// Returns gameKey -> (memberId -> minutes) for the window.
function tallyWindow(buckets, startMs, endMs) {
    const tally = new Map();

    for (const [hourKey, members] of Object.entries(buckets || {})) {
        const hourStart = Number(hourKey);
        if (!Number.isFinite(hourStart)) continue;
        if (hourStart < startMs || hourStart >= endMs) continue;

        for (const [memberId, games] of Object.entries(members || {})) {
            for (const [gameKey, minutes] of Object.entries(games || {})) {
                if (!Number.isFinite(minutes)) continue;

                let perMember = tally.get(gameKey);
                if (!perMember) {
                    perMember = new Map();
                    tally.set(gameKey, perMember);
                }

                perMember.set(memberId, (perMember.get(memberId) || 0) + minutes);
            }
        }
    }

    return tally;
}

// Ranked by how many people played it, because that is what makes something the
// server's game rather than one person's. Hours break the tie, and the key breaks that,
// so the same input always produces the same order.
function rankGames(tally, options = {}) {
    const minMinutes = options.minMinutes ?? MIN_MINUTES_PER_PLAYER;
    const minPlayers = options.minPlayers ?? MIN_UNIQUE_PLAYERS;
    const limit = options.limit ?? MAX_ROWS;

    const qualified = [];
    let belowPlayerFloor = 0;

    for (const [key, perMember] of tally) {
        let uniquePlayers = 0;
        let totalMinutes = 0;

        for (const minutes of perMember.values()) {
            if (minutes < minMinutes) continue;
            uniquePlayers += 1;
            totalMinutes += minutes;
        }

        if (uniquePlayers === 0) continue;

        if (uniquePlayers < minPlayers) {
            belowPlayerFloor += 1;
            continue;
        }

        qualified.push({ key, uniquePlayers, totalMinutes, hours: Math.round(totalMinutes / 6) / 10 });
    }

    qualified.sort((a, b) =>
        b.uniquePlayers - a.uniquePlayers
        || b.totalMinutes - a.totalMinutes
        || a.key.localeCompare(b.key));

    return { rows: qualified.slice(0, limit), belowPlayerFloor, qualifyingGames: qualified.length };
}

// Where each game sat last week, as a word rather than a number, since "up 2" reads and
// "+2" invites arithmetic. Absent from last week's post means new.
function withChange(rows, previousRows) {
    const previousRank = new Map((previousRows || []).map((row, index) => [row.key, index + 1]));

    return rows.map((row, index) => {
        const rank = index + 1;
        const before = previousRank.get(row.key);

        let change = null;
        if (!previousRows || previousRows.length === 0) change = null;
        else if (before === undefined) change = 'new';
        else if (before > rank) change = `up ${before - rank}`;
        else if (before < rank) change = `down ${rank - before}`;

        return { ...row, rank, change };
    });
}

// ---------------------------------------------------------------------------
// The post
// ---------------------------------------------------------------------------

function escapeLabel(value) {
    return String(value ?? '').replace(/([*_~`>|\\])/g, '\\$1');
}

function plural(count, word) {
    return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function digestLine(row, labels) {
    const name = escapeLabel(labels?.[row.key] || row.key);
    const parts = [`**${row.rank}.** ${name}`, plural(row.uniquePlayers, 'player'), `${row.hours.toFixed(1)} hours`];

    if (row.change) parts.push(row.change);

    return parts.join(' · ');
}

// `extraLine` is the hook the Arcade Champion line will use later. Nothing builds it
// today; it is here so adding it is one argument rather than a restructure.
function buildDigestEmbed({
    rows = [],
    labels = {},
    firstWeek = false,
    color = 0xFFB570,
    iconURL = null,
    ctaChannelId = null,
    extraLine = null
} = {}) {
    const embed = new EmbedBuilder().setColor(color).setTitle(TITLE).setFooter({ text: FOOTER });

    if (iconURL) embed.setThumbnail(iconURL);

    const lines = [];

    if (firstWeek) lines.push(`*${FIRST_WEEK_LABEL}*`, '');

    lines.push(...rows.map(row => digestLine(row, labels)));

    if (extraLine) lines.push('', extraLine);

    const optIn = ctaChannelId ? `<#${ctaChannelId}>` : '`/vice-radar join`';
    lines.push('', `Playing one of these? Drop a callout. Join Vice Radar from ${optIn} and it will tell the others for you.`);

    embed.setDescription(lines.join('\n'));

    return embed;
}

module.exports = {
    windowEndFor,
    windowStartFor,
    nextPostAfter,
    tallyWindow,
    rankGames,
    withChange,
    buildDigestEmbed,
    digestLine,
    DIGEST_WEEKDAY,
    DIGEST_HOUR,
    MIN_MINUTES_PER_PLAYER,
    MIN_UNIQUE_PLAYERS,
    MAX_ROWS,
    FOOTER,
    TITLE,
    FIRST_WEEK_LABEL,
    EMPTY_FIRST_WEEK,
    HOUR_MS,
    DAY_MS,
};
