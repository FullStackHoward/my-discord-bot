// ---------------------------------------------------------------------------
// Vice Radar DM decisions and payloads
// ---------------------------------------------------------------------------
//
// Everything here is pure: no client, no config, no env, no network. The caller
// resolves the roster, the display names and the icon URL and hands them in, which is
// what lets the awkward parts (who gets a first DM, who gets an edit, what the buttons
// look like at the Discord limits) be tested without a gateway connection. Same shape
// as lib/lobby/stages.js and lib/lobby/render.js.

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');

// Discord's own ceilings, named so the reasons below read as reasons and not as magic.
const BUTTONS_PER_ROW = 5;
const EMBED_DESCRIPTION_MAX = 4096;

// Two rows of five. Past this people are still named in the list, just without their own
// button, which keeps room for the group-chat row inside the five-row message limit.
const PERSON_BUTTON_MAX = 10;

// Names listed before the line turns into "and N more". A big overlap on a popular game
// would otherwise push the description toward its 4096 limit.
const NAME_MAX = 10;

const GROUP_BUTTON_PREFIX = 'radar:group:';

// Game names arrive from presence payloads, so they are whatever the game calls itself.
// Escaped before going into bold or a list so a title containing * or _ cannot break the
// formatting around it.
function escapeName(value) {
    return String(value ?? '').replace(/([*_~`>|\\])/g, '\\$1');
}

function clamp(text, max) {
    return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

// ---------------------------------------------------------------------------
// B1: games that never earn a DM
// ---------------------------------------------------------------------------

// Discord Activities - Wordle and the rest - are played inside Discord, with whoever is
// already in the call. A DM telling you to go and find a squad for one is noise, so they
// are excluded from DMs only: the public callout and the board headcount still count
// them, because the headcount is true either way.
//
// Matched on the name rather than the Embedded activity flag because the flag has not
// been confirmed against a real payload, and entries are keyed by game name alone.
function isDmExcludedGame(gameName, ignoredNames) {
    if (!gameName) return false;

    const needle = String(gameName).trim().toLowerCase();
    if (!needle) return false;

    for (const ignored of ignoredNames || []) {
        if (String(ignored).trim().toLowerCase() === needle) return true;
    }

    return false;
}

// ---------------------------------------------------------------------------
// Who gets what
// ---------------------------------------------------------------------------

// A compact description of what one recipient's DM currently says, so an edit round can
// skip anyone whose message would come out identical. Sorted, because roster order is
// not stable across presence events and an order-only difference is not a difference.
function dmSignature({ otherOptedInIds = [], totalCount = 0 } = {}) {
    return `${[...otherOptedInIds].sort().join(',')}|${totalCount}`;
}

// Splits the opted-in roster into first-time DMs and edits to DMs already sent.
//
// `alreadyDmed` maps a recipient id to the signature of what they were last shown, or
// null when the send failed (closed DMs, blocked bot). A null is still a claim: it keeps
// that person out of `send` so a failing DM is not retried on every presence event.
//
// Nobody is ever in both lists, and nobody is sent a second DM for the same streak -
// that was the "no duplicate messages" half of the request. Keeping their one DM current
// is the other half, and that is what `update` is for.
function planRadarDms({ rosterIds = [], optedInIds = [], alreadyDmed = new Map() } = {}) {
    const optedIn = new Set(optedInIds);

    // Roster order, filtered to the opted-in: this is also the order names appear in.
    const recipients = rosterIds.filter(id => optedIn.has(id));
    const totalCount = rosterIds.length;

    const send = [];
    const update = [];

    for (const recipientId of recipients) {
        const otherOptedInIds = recipients.filter(id => id !== recipientId);
        const signature = dmSignature({ otherOptedInIds, totalCount });
        const item = { recipientId, otherOptedInIds, totalCount, signature };

        if (!alreadyDmed.has(recipientId)) {
            send.push(item);
            continue;
        }

        // Already holds a DM. Only worth an edit if it would actually read differently.
        if (alreadyDmed.get(recipientId) !== signature) update.push(item);
    }

    return { send, update };
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

function radarEmbed({ brandName, color, iconURL, description }) {
    const embed = new EmbedBuilder()
        .setColor(color)
        // The palm tree is the fallback mark: it only appears when the emoji could not
        // be resolved, so the post still carries something either way.
        .setAuthor({ name: iconURL ? brandName : `${brandName} \u{1F334}` })
        .setDescription(clamp(description, EMBED_DESCRIPTION_MAX));

    if (iconURL) embed.setThumbnail(iconURL);

    return embed;
}

function rowsOf(buttons) {
    const rows = [];

    for (let i = 0; i < buttons.length; i += BUTTONS_PER_ROW) {
        rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + BUTTONS_PER_ROW)));
    }

    return rows;
}

// A link button hands its URL straight to the client and never calls back, so there is
// no interaction to route and nothing to track. Discord has no profile-URL scheme, so
// /users/<id> is the closest thing, and it is the easier tap target on mobile than the
// mention chip in the text.
function personButtons(others) {
    return others.slice(0, PERSON_BUTTON_MAX).map(other =>
        new ButtonBuilder()
            .setLabel(clamp(`Message ${other.displayName || 'them'}`, 80))
            .setStyle(ButtonStyle.Link)
            .setURL(`https://discord.com/users/${other.id}`)
    );
}

// B4: at least one other person in the match is also on Radar, so the DM names them.
//
// `others` is [{ id, displayName }] in roster order. `matchToken` is the short id the
// group-chat button carries; omit it and the button is left off, which is what happens
// when the streak has already been reset out from under this payload.
function buildSquadDm({
    gameName,
    others = [],
    totalCount = 0,
    matchToken = null,
    brandName = 'Vice Radar',
    color = 0xFFB570,
    iconURL = null
} = {}) {
    const game = escapeName(gameName);

    const named = others.slice(0, NAME_MAX);
    const unnamed = others.length - named.length;
    const lines = named.map(other => `- <@${other.id}>`);

    if (unnamed > 0) {
        lines.push(`- and ${unnamed} more on Vice Radar`);
    }

    // The rest of the match who are not on Radar, so the recipient knows the real size
    // of it and not just the subset they can go and talk to.
    const remainder = Math.max(0, totalCount - 1 - others.length);
    const remainderLine = remainder > 0
        ? `\n(${remainder} more ${remainder === 1 ? 'person is' : 'people are'} in this match too, not yet on Vice Radar.)`
        : '';

    const embed = radarEmbed({
        brandName,
        color,
        iconURL,
        description:
            `## ${game}\n`
            + `The following people are also playing this game right now:\n`
            + `${lines.join('\n')}${remainderLine}\n\n`
            + `Say hi and jump in together. \u{1F334}`
    });

    const components = rowsOf(personButtons(others));

    if (matchToken) {
        // Not a link button: those take no style, and this one is meant to stand out.
        // It calls back to the bot, which is why it carries a custom id.
        components.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`${GROUP_BUTTON_PREFIX}${matchToken}`)
                .setLabel('Start a group chat')
                .setStyle(ButtonStyle.Success)
        ));
    }

    return { embeds: [embed], components };
}

// B2: the recipient is the only person in the match who is on Radar. There is nobody to
// introduce them to, so instead of a bare headcount the DM points them at the three
// places where they can go and find players themselves.
//
// `channels` carries the ids where they are known. A <#id> mention only renders as a
// link in the guild that owns the channel, and how that behaves inside a DM is not
// something to rely on, so every suggestion also gets a jump-link button.
function buildSoloDm({
    gameName,
    guildId,
    guildName,
    totalCount = 0,
    channels = {},
    brandName = 'Vice Radar',
    color = 0xFFB570,
    iconURL = null
} = {}) {
    const game = escapeName(gameName);
    const others = Math.max(0, totalCount - 1);
    const headline = others === 1
        ? `1 other Vicer is playing ${game} right now`
        : `${others} other Vicers are playing ${game} right now`;

    const ref = (id, fallback) => (id ? `<#${id}>` : fallback);
    const lfg = ref(channels.lfgId, '#lfg');
    const forums = ref(channels.gameForumsId, '#game-forums');
    const chat = ref(channels.gameChatId, '#game-chat');

    const embed = radarEmbed({
        brandName,
        color,
        iconURL,
        description:
            `## ${headline}\n`
            + `Nobody else playing it has opted in to Vice Radar yet, so there is no one to `
            + `point you to directly. A few ways to get a squad going in **${escapeName(guildName)}**:\n`
            + `- Start a lobby in ${lfg} with \`/lobby now\` or \`/lobby create\`\n`
            + `- Find ${game} in ${forums} and ask for players\n`
            + `- Or ask around in ${chat} \u{1F334}`
    });

    const jump = (id, label) => (id && guildId
        ? new ButtonBuilder()
            .setLabel(label)
            .setStyle(ButtonStyle.Link)
            .setURL(`https://discord.com/channels/${guildId}/${id}`)
        : null);

    const buttons = [
        jump(channels.lfgId, 'Go to LFG'),
        jump(channels.gameForumsId, 'Game forums'),
        jump(channels.gameChatId, 'Game chat')
    ].filter(Boolean);

    return { embeds: [embed], components: rowsOf(buttons) };
}

module.exports = {
    isDmExcludedGame,
    dmSignature,
    planRadarDms,
    buildSquadDm,
    buildSoloDm,
    escapeName,
    GROUP_BUTTON_PREFIX,
    PERSON_BUTTON_MAX,
    NAME_MAX,
};
