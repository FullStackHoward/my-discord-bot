// ---------------------------------------------------------------------------
// What the arcade puts in channels
// ---------------------------------------------------------------------------
//
// Pure builders: they take data and return embeds and message options. Nothing here
// sends anything, which is what lets the splitting and the wording be tested without a
// Discord connection.
//
// Two rules the spec is explicit about and that are easy to get wrong:
//
// Nothing pings except the three podium winners. Daily boards use the display names
// stored at score time, so a long leaderboard cannot turn into eighty notifications.
//
// Reset times use Discord's own timestamp markup, so every member sees their local
// clock. It goes at the end of the description rather than in the footer, because
// [Unverified] whether the markup renders in a footer and the description certainly
// works.

const { EmbedBuilder } = require('discord.js');

// The arcade's accent, matching the weekly digest so the server's posts look like one
// thing.
const ARCADE_COLOR = 0xFFB570;
const PODIUM_COLOR = 0xEB459E;

// Discord's limit is about 4096 characters of embed description. Split well short of
// it: a board that renders at 4090 today grows by one long display name tomorrow.
const DESCRIPTION_BUDGET = 3600;

const MEDALS = ['🥇', '🥈', '🥉'];

function unix(iso) {
    const ms = Date.parse(iso);

    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

// "Leaderboards reset Sunday, Nov 8 at 5:00 PM (in 5 days)", in each reader's own zone.
function resetLine(resetsAt) {
    const stamp = unix(resetsAt);

    if (stamp === null) return null;

    return `Leaderboards reset <t:${stamp}:F> (<t:${stamp}:R>).`;
}

function entryLine(entry) {
    const medal = entry.place <= MEDALS.length ? `${MEDALS[entry.place - 1]} ` : `**${entry.place}.** `;
    const pending = entry.pending ? ' *(pending)*' : '';

    return `${medal}${entry.display_name} · ${Number(entry.score).toLocaleString()}${pending}`;
}

// ---------------------------------------------------------------------------
// Daily boards
// ---------------------------------------------------------------------------

// One or more messages. The reset note lands on the last one only, so a split board
// does not repeat it.
function dailyBoardMessages({ gameName, day, entries = [], resetsAt = null }) {
    const chunks = [];
    let current = [];
    let size = 0;

    for (const entry of entries) {
        const line = entryLine(entry);

        if (size + line.length + 1 > DESCRIPTION_BUDGET && current.length > 0) {
            chunks.push(current);
            current = [];
            size = 0;
        }

        current.push(line);
        size += line.length + 1;
    }

    if (current.length > 0 || chunks.length === 0) chunks.push(current);

    const note = resetLine(resetsAt);
    const dayLabel = formatDay(day);

    return chunks.map((lines, index) => {
        const last = index === chunks.length - 1;
        const body = lines.length > 0 ? lines.join('\n') : 'Nobody played.';

        const embed = new EmbedBuilder()
            .setColor(ARCADE_COLOR)
            .setTitle(chunks.length > 1
                ? `${gameName} · ${dayLabel} (${index + 1}/${chunks.length})`
                : `${gameName} · ${dayLabel}`)
            .setDescription(last && note ? `${body}\n\n${note}` : body);

        return { embeds: [embed], allowedMentions: { parse: [] } };
    });
}

function formatDay(day) {
    // `day` is an ISO date from the API, already the Eastern calendar day the board
    // covers. Formatted in UTC on purpose: shifting it into a local zone here would
    // move it to the wrong date.
    const parsed = new Date(`${day}T12:00:00Z`);

    if (Number.isNaN(parsed.getTime())) return day;

    return parsed.toLocaleDateString('en-US', {
        timeZone: 'UTC', weekday: 'long', month: 'short', day: 'numeric'
    });
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

function recordMessage({ gameName, displayName, score, previousBest, previousHolder, scoreId }) {
    const embed = new EmbedBuilder()
        .setColor(ARCADE_COLOR)
        .setTitle(`New ${gameName} record`)
        .setDescription(
            `**${displayName}** takes the all-time top spot with `
            + `**${Number(score).toLocaleString()}**, past ${Number(previousBest).toLocaleString()}.`
        )
        .setFooter({ text: `Score ${scoreId}` });

    // Names only, no mention: the displaced player does not need a notification about
    // losing a record.
    return { embeds: [embed], allowedMentions: { parse: [] } };
}

// ---------------------------------------------------------------------------
// The round callout
// ---------------------------------------------------------------------------

const PLACE_NAMES = ['Arcade Champion', 'Arcade Silver', 'Arcade Bronze'];

// Goes in #chat. The only post in the arcade that pings anyone, and only these three.
//
// The wording says the round has ended, because by the time this goes out the boards
// have already reset and the roles have already come off. Without that, members who
// watched the roles vanish would read this as a bug.
function podiumMessage({ winners = [], arcadeChannelId = null, oneGame = true }) {
    if (winners.length === 0) return null;

    const lines = winners.map(winner => {
        const place = PLACE_NAMES[winner.place - 1] || `Place ${winner.place}`;
        const figure = oneGame
            ? ''
            : ` (average placing ${Number(winner.average_placement).toFixed(2)})`;

        return `${MEDALS[winner.place - 1] || ''} **${place}**: <@${winner.discord_user_id}>${figure}`;
    });

    const pointer = arcadeChannelId
        ? `\n\nA new round has started. <#${arcadeChannelId}> is where you play.`
        : '\n\nA new round has started.';

    const embed = new EmbedBuilder()
        .setColor(PODIUM_COLOR)
        .setTitle('The arcade round just ended')
        .setDescription(`${lines.join('\n')}${pointer}`);

    return {
        embeds: [embed],
        // Restricted to exactly these three. Nothing else in the post can ping, whatever
        // ends up in a display name.
        allowedMentions: { users: winners.map(winner => winner.discord_user_id) }
    };
}

function correctionMessage({ winners = [] }) {
    if (winners.length === 0) return null;

    const lines = winners.map(winner => {
        const place = PLACE_NAMES[winner.place - 1] || `Place ${winner.place}`;

        return `${MEDALS[winner.place - 1] || ''} **${place}**: ${winner.display_name}`;
    });

    const embed = new EmbedBuilder()
        .setColor(PODIUM_COLOR)
        .setTitle('Podium corrected')
        .setDescription(`A score from that round was removed, so the result has changed.\n\n${lines.join('\n')}`);

    // A correction names people without pinging them. They were already told once.
    return { embeds: [embed], allowedMentions: { parse: [] } };
}

module.exports = {
    ARCADE_COLOR,
    PODIUM_COLOR,
    DESCRIPTION_BUDGET,
    PLACE_NAMES,
    resetLine,
    entryLine,
    formatDay,
    dailyBoardMessages,
    recordMessage,
    podiumMessage,
    correctionMessage
};
