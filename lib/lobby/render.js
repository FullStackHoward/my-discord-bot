// ---------------------------------------------------------------------------
// Embed and component builders
// ---------------------------------------------------------------------------
//
// Pure: takes plain data, returns builders. No state reads, no Discord calls, so every
// surface here is unit-testable.

const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder
} = require('discord.js');
const { LOG_COLORS, LOBBY_LENGTH_MINUTES } = require('../config');
const copy = require('./copy');
const { escapeLabel } = require('./games');
const { BLOCK_LABELS, BLOCKS } = require('./time');
const { isAttendanceFinal, venueOf } = require('./state');

// Discord's own limits, applied here so a long list can never make the API reject a post.
const EMBED_DESCRIPTION_MAX = 4096;
const FIELD_VALUE_MAX = 1024;

const PLATFORMS = [
    { value: 'pc', label: 'PC' },
    { value: 'playstation', label: 'PlayStation' },
    { value: 'xbox', label: 'Xbox' },
    { value: 'switch', label: 'Switch' },
    { value: 'mobile', label: 'Mobile' }
];

const PLATFORM_LABELS = Object.fromEntries(PLATFORMS.map(p => [p.value, p.label]));

const LENGTH_LABELS = { quick: 'Quick (1h)', standard: 'Standard (2h)', long: 'Long (4h)' };

const STATUS_COLORS = {
    open: LOG_COLORS.lobby,
    live: 0x57F287,
    ended: 0x4F545C,
    cancelled: 0x4F545C,
    expired: 0x4F545C
};

function clamp(text, max) {
    const value = String(text ?? '');
    return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function mention(userId) {
    return `<@${userId}>`;
}

// Mentions, truncated with a count rather than cut mid-list.
function mentionList(userIds, max = FIELD_VALUE_MAX) {
    if (!userIds || userIds.length === 0) return '—';

    const parts = [];
    let length = 0;

    for (const userId of userIds) {
        const piece = mention(userId);
        // +2 for the separator, +20 for the "+N more" tail.
        if (length + piece.length + 2 > max - 20) {
            parts.push(copy.boardMore(userIds.length - parts.length));
            break;
        }
        parts.push(piece);
        length += piece.length + 2;
    }

    return parts.join(' ');
}

function lengthLabel(length) {
    return LENGTH_LABELS[length] || length;
}

// ---------------------------------------------------------------------------
// Lobby card
// ---------------------------------------------------------------------------

function lobbyCardEmbed(lobby) {
    const seconds = Math.floor(lobby.startsAt / 1000);
    const closed = lobby.status !== 'open' && lobby.status !== 'live';

    const titleBits = [escapeLabel(lobby.gameLabel)];
    if (lobby.platform) titleBits.push(PLATFORM_LABELS[lobby.platform] || lobby.platform);

    const statusNote = {
        live: '**Live now.**',
        ended: '**This lobby has finished.**',
        cancelled: '**This lobby was cancelled.**',
        expired: '**This lobby expired - nobody joined.**'
    }[lobby.status];

    const descriptionLines = [];
    if (statusNote) descriptionLines.push(statusNote);
    // <t:...:F> and :R> are rendered by each viewer's own client in their local time, so
    // no per-member formatting is needed here.
    descriptionLines.push(`<t:${seconds}:F> · <t:${seconds}:R>`);
    if (lobby.note) descriptionLines.push(`> ${clamp(escapeLabel(lobby.note), 300)}`);

    const embed = new EmbedBuilder()
        .setColor(STATUS_COLORS[lobby.status] || LOG_COLORS.lobby)
        .setTitle(clamp(`LFG #${lobby.number} · ${titleBits.join(' · ')}`, 256))
        .setDescription(clamp(descriptionLines.join('\n'), EMBED_DESCRIPTION_MAX))
        .addFields(
            { name: 'Host', value: mention(lobby.hostId), inline: true },
            { name: 'Seats', value: `${lobby.players.length}/${lobby.seats}`, inline: true },
            { name: 'Length', value: lengthLabel(lobby.length), inline: true }
        );

    const meta = [];
    meta.push(lobby.crossplay ? 'Crossplay on' : 'Crossplay off');
    if (lobby.minPlayers) meta.push(`Needs ${lobby.minPlayers}+`);
    // Where to play is always set, so it always shows.
    meta.push(venueOf(lobby) === 'ingame' ? `\uD83C\uDFAE ${copy.venueInGame}` : `\uD83D\uDD0A <#${lobby.voiceChannelId}>`);
    embed.addFields({ name: 'Details', value: meta.join(' · '), inline: false });

    embed.addFields({ name: `Players (${lobby.players.length})`, value: mentionList(lobby.players), inline: false });

    if (lobby.maybes.length > 0) {
        embed.addFields({ name: `Maybe (${lobby.maybes.length})`, value: mentionList(lobby.maybes), inline: true });
    }
    if (lobby.waitlist.length > 0) {
        embed.addFields({ name: `Waitlist (${lobby.waitlist.length})`, value: `${lobby.waitlist.length} waiting`, inline: true });
    }

    embed.setFooter({ text: closed ? `Lobby ${lobby.status}` : `Lobby ${lobby.id}` });

    return embed;
}

// customId shape: lobby:<action>:<lobbyId>. Parsed in components.js.
function lobbyButton(action, lobbyId, label, style, disabled = false) {
    return new ButtonBuilder()
        .setCustomId(`lobby:${action}:${lobbyId}`)
        .setLabel(clamp(label, 80))
        .setStyle(style)
        .setDisabled(disabled);
}

// Two rows: participant actions, then host actions. Host rights are re-checked on click,
// so showing the row to everyone is safe.
function lobbyCardComponents(lobby) {
    // Once attendance is settled the rows stay visible but every control is greyed, so
    // the card plainly reads as closed rather than silently losing its buttons.
    if (isAttendanceFinal(lobby)) return lobbyCardRows(lobby, true);

    if (lobby.status !== 'open' && lobby.status !== 'live') return [];

    return lobbyCardRows(lobby, false);
}

function lobbyCardRows(lobby, disabled) {

    return [
        new ActionRowBuilder().addComponents(
            lobbyButton('join', lobby.id, 'Join', ButtonStyle.Success, disabled),
            lobbyButton('maybe', lobby.id, 'Maybe', ButtonStyle.Secondary, disabled),
            lobbyButton('leave', lobby.id, 'Leave', ButtonStyle.Secondary, disabled),
            lobbyButton('tags', lobby.id, 'Show tags', ButtonStyle.Secondary, disabled)
        ),
        new ActionRowBuilder().addComponents(
            lobbyButton('edit', lobby.id, 'Edit', ButtonStyle.Primary, disabled),
            lobbyButton('crossplay', lobby.id, `Crossplay: ${lobby.crossplay ? 'On' : 'Off'}`, ButtonStyle.Secondary, disabled),
            lobbyButton('template', lobby.id, 'Save template', ButtonStyle.Secondary, disabled),
            lobbyButton('cancel', lobby.id, 'Cancel', ButtonStyle.Danger, disabled)
        )
    ];
}

// Rebuilds a fetched message's component rows with everything disabled.
//
// Goes through ActionRowBuilder.from() rather than spreading raw API objects: the
// round-trip produces real builders, so discord.js validates the result and
// message.edit accepts it without relying on raw rows being passed through untouched.
// Never mutates its input.
function disableComponents(rows) {
    return (rows || []).map(row => {
        const json = typeof row?.toJSON === 'function' ? row.toJSON() : row;
        const rebuilt = ActionRowBuilder.from(json);

        for (const component of rebuilt.components) {
            if (typeof component.setDisabled === 'function') component.setDisabled(true);
        }

        return rebuilt;
    });
}

function lobbyCardPayload(lobby) {
    return { embeds: [lobbyCardEmbed(lobby)], components: lobbyCardComponents(lobby) };
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

function lobbyLine(lobby, channelId) {
    const seconds = Math.floor(lobby.startsAt / 1000);
    const left = Math.max(0, lobby.seats - lobby.players.length);
    const link = lobby.cardMessageId && channelId
        ? `[#${lobby.number}](https://discord.com/channels/${lobby.guildIdForLink}/${channelId}/${lobby.cardMessageId})`
        : `#${lobby.number}`;

    const seatText = left === 0 ? 'full' : `${left} seat${left === 1 ? '' : 's'} left`;

    return `• <t:${seconds}:t> · **${escapeLabel(lobby.gameLabel)}** · ${seatText} · ${link}`;
}

function boardEmbed({ tonight, thisWeek, playingNow, channelId, guildId }) {
    const embed = new EmbedBuilder()
        .setColor(LOG_COLORS.lobby)
        .setTitle(copy.boardTitle)
        .setTimestamp();

    const withGuild = lobby => ({ ...lobby, guildIdForLink: guildId });

    const sections = [];

    if (tonight.length === 0 && thisWeek.length === 0) {
        sections.push(copy.boardEmpty);
    }

    embed.setDescription(clamp(sections.join('\n') || copy.boardEmpty, EMBED_DESCRIPTION_MAX));

    const addListField = (name, lobbies) => {
        if (lobbies.length === 0) return;

        const lines = [];
        let length = 0;

        for (const lobby of lobbies) {
            const line = lobbyLine(withGuild(lobby), channelId);
            if (length + line.length + 1 > FIELD_VALUE_MAX - 20) {
                lines.push(copy.boardMore(lobbies.length - lines.length));
                break;
            }
            lines.push(line);
            length += line.length + 1;
        }

        embed.addFields({ name, value: lines.join('\n'), inline: false });
    };

    addListField(copy.boardTonight, tonight);
    addListField(copy.boardThisWeek, thisWeek);

    if (playingNow.length > 0) {
        // Counts only, never names: the public Radar post already handles naming, and
        // the board must not expose who is playing what.
        const lines = playingNow
            .slice(0, 10)
            .map(entry => `• **${escapeLabel(entry.gameName)}** · ${entry.count} playing`);

        embed.addFields({ name: copy.boardPlayingNow, value: clamp(lines.join('\n'), FIELD_VALUE_MAX), inline: false });
    }

    return embed;
}

function digestEmbed({ lobbies, showRate, topGames, openCount }) {
    const embed = new EmbedBuilder()
        .setColor(LOG_COLORS.lobby)
        .setTitle(copy.digestTitle)
        .addFields(
            { name: 'Lobbies', value: `${lobbies}`, inline: true },
            { name: 'Show rate', value: showRate === null ? '—' : `${Math.round(showRate * 100)}%`, inline: true },
            { name: 'Open now', value: `${openCount}`, inline: true }
        );

    if (topGames.length > 0) {
        embed.addFields({
            name: 'Most played',
            value: clamp(topGames.map((g, i) => `${i + 1}. **${escapeLabel(g.label)}** · ${g.count}`).join('\n'), FIELD_VALUE_MAX)
        });
    }

    return embed;
}

// ---------------------------------------------------------------------------
// Availability panel
// ---------------------------------------------------------------------------

function blockSelect(customId, placeholder, selected) {
    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(customId)
            .setPlaceholder(clamp(placeholder, 150))
            .setMinValues(0)
            .setMaxValues(BLOCKS.length)
            .addOptions(BLOCKS.map(block =>
                new StringSelectMenuOptionBuilder()
                    .setLabel(BLOCK_LABELS[block])
                    .setValue(block)
                    // setDefault is what makes the panel re-render with the member's
                    // existing choices still ticked.
                    .setDefault(selected.includes(block))))
    );
}

function platformSelect(selected) {
    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('lobby:sel:platforms')
            .setPlaceholder('Platforms you play on')
            .setMinValues(0)
            .setMaxValues(PLATFORMS.length)
            .addOptions(PLATFORMS.map(p =>
                new StringSelectMenuOptionBuilder()
                    .setLabel(p.label)
                    .setValue(p.value)
                    .setDefault(selected.includes(p.value))))
    );
}

function gameSelect(options) {
    // An empty select is rejected by Discord, so an empty registry gets a disabled
    // placeholder row instead.
    if (options.length === 0) {
        return new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('lobby:sel:games')
                .setPlaceholder('No games listed yet - use Add a game')
                .setDisabled(true)
                .addOptions(new StringSelectMenuOptionBuilder().setLabel('none').setValue('none'))
        );
    }

    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('lobby:sel:games')
            .setPlaceholder('Games you play')
            .setMinValues(0)
            .setMaxValues(options.length)
            .addOptions(options.map(option =>
                new StringSelectMenuOptionBuilder()
                    .setLabel(option.label)
                    .setValue(option.value)
                    .setDefault(Boolean(option.default))))
    );
}

function availabilityButtons(nudgesOn) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('lobby:av:addgame').setLabel('Add a game').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('lobby:av:tags').setLabel('Gamertags').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('lobby:av:nudges').setLabel(`Nudges: ${nudgesOn ? 'On' : 'Off'}`).setStyle(nudgesOn ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('lobby:av:done').setLabel('Done').setStyle(ButtonStyle.Primary)
    );
}

function availabilityPanel(profile, gameOptions, { zoneMissing }) {
    const lines = [copy.availabilityIntro];
    if (zoneMissing) lines.push(`\n⚠️ ${copy.availabilityNoTimezone}`);
    else lines.push(`\nTime zone: **${profile.tz}**`);

    const embed = new EmbedBuilder()
        .setColor(LOG_COLORS.lobby)
        .setTitle('Your LFG profile')
        .setDescription(clamp(lines.join('\n'), EMBED_DESCRIPTION_MAX));

    // Five rows is Discord's maximum per message, which is exactly what this uses.
    return {
        embeds: [embed],
        components: [
            blockSelect('lobby:sel:weekday', 'Weekday times you are usually free', profile.weekday || []),
            blockSelect('lobby:sel:weekend', 'Weekend times you are usually free', profile.weekend || []),
            platformSelect(profile.platforms || []),
            gameSelect(gameOptions),
            availabilityButtons(profile.nudges)
        ]
    };
}

function profileSummary(profile, gameLabels) {
    const fmt = blocks => (blocks && blocks.length > 0 ? blocks.map(b => BLOCK_LABELS[b] || b).join(', ') : '—');

    return new EmbedBuilder()
        .setColor(LOG_COLORS.lobby)
        .setTitle('Your LFG profile')
        .addFields(
            { name: 'Time zone', value: profile.tz || '— (set with /lfg-profile timezone)' },
            { name: 'Weekdays', value: fmt(profile.weekday), inline: true },
            { name: 'Weekends', value: fmt(profile.weekend), inline: true },
            { name: 'Platforms', value: (profile.platforms || []).map(p => PLATFORM_LABELS[p] || p).join(', ') || '—' },
            { name: 'Games', value: clamp(gameLabels.map(escapeLabel).join(', ') || '—', FIELD_VALUE_MAX) },
            { name: 'Gamertags saved', value: `${Object.values(profile.tags || {}).filter(Boolean).length}`, inline: true },
            { name: 'Nudges', value: profile.nudges ? 'On' : 'Off', inline: true }
        );
}

// ---------------------------------------------------------------------------
// Nudge and newcomer DMs
// ---------------------------------------------------------------------------

function nudgeDm(lobby, guildName) {
    const seconds = Math.floor(lobby.startsAt / 1000);

    const embed = new EmbedBuilder()
        .setColor(LOG_COLORS.lobby)
        .setTitle(copy.nudgeTitle)
        .setDescription(`**${escapeLabel(lobby.gameLabel)}** in **${guildName}**\n<t:${seconds}:F> · <t:${seconds}:R>`)
        .addFields(
            { name: 'Host', value: mention(lobby.hostId), inline: true },
            { name: 'Seats', value: `${lobby.players.length}/${lobby.seats}`, inline: true }
        )
        .setFooter({ text: copy.nudgeFooter });

    const row = new ActionRowBuilder().addComponents(
        lobbyButton('join', lobby.id, 'Join', ButtonStyle.Success),
        lobbyButton('maybe', lobby.id, 'Maybe', ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('lobby:av:nudgesoff').setLabel('Turn off nudges').setStyle(ButtonStyle.Secondary)
    );

    return { embeds: [embed], components: [row] };
}

function newcomerDm(guildId, guildName) {
    const embed = new EmbedBuilder()
        .setColor(LOG_COLORS.lobby)
        .setTitle(copy.newcomerTitle)
        .setDescription(`${copy.newcomerBody}\n\nServer: **${guildName}**`);

    const row = new ActionRowBuilder().addComponents(
        // Carries the guild id, because a DM press has no guild context of its own.
        new ButtonBuilder().setCustomId(`lobby:nc:${guildId}`).setLabel(copy.newcomerButton).setStyle(ButtonStyle.Primary)
    );

    return { embeds: [embed], components: [row] };
}

// ---------------------------------------------------------------------------
// Thread prompts
// ---------------------------------------------------------------------------

function reminderPrompt(lobby, { minPlayersUnmet }) {
    const lines = [mentionList(lobby.players), `${copy.lobbyReminderAsk} <t:${Math.floor(lobby.startsAt / 1000)}:R>`];

    if (lobby.maybes.length > 0) {
        lines.push(`Maybes: ${mentionList(lobby.maybes)} — room if you want it.`);
    }
    if (minPlayersUnmet) {
        lines.push(`⚠️ ${copy.lobbyMinPlayersUnmet} (${lobby.players.length}/${lobby.minPlayers})`);
    }

    const row = new ActionRowBuilder().addComponents(
        lobbyButton('join', lobby.id, 'Join', ButtonStyle.Success),
        lobbyButton('leave', lobby.id, 'Leave', ButtonStyle.Secondary)
    );

    const rows = [row];

    if (minPlayersUnmet) {
        rows.push(new ActionRowBuilder().addComponents(
            lobbyButton('runanyway', lobby.id, 'Run anyway', ButtonStyle.Primary),
            lobbyButton('cancel', lobby.id, 'Cancel lobby', ButtonStyle.Danger)
        ));
    }

    return { content: clamp(lines.join('\n'), 1900), components: rows };
}

function startPrompt(lobby) {
    const lines = [mentionList(lobby.players), copy.lobbyStartingNow];
    lines.push(venueOf(lobby) === 'ingame'
        ? `Meet up **in-game**.`
        : `Voice: <#${lobby.voiceChannelId}>`);

    return { content: clamp(lines.join('\n'), 1900) };
}

function attendancePrompt(lobby, memberLabels) {
    const options = lobby.players.slice(0, 25).map(userId =>
        new StringSelectMenuOptionBuilder()
            .setLabel(clamp(memberLabels[userId] || userId, 100))
            .setValue(userId)
            .setDefault((lobby.attendance.showed || []).includes(userId)));

    const rows = [];

    if (options.length > 0) {
        rows.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(`lobby:att:${lobby.id}`)
                .setPlaceholder('Who showed up?')
                .setMinValues(0)
                .setMaxValues(options.length)
                .addOptions(options)
        ));
    }

    rows.push(new ActionRowBuilder().addComponents(
        lobbyButton('attconfirm', lobby.id, 'Confirm attendance', ButtonStyle.Primary),
        lobbyButton('again', lobby.id, 'Play again', ButtonStyle.Success)
    ));

    return {
        content: `${mention(lobby.hostId)} that is a wrap. Mark who showed, and anyone who wants another round can press **Play again**.`,
        components: rows
    };
}

module.exports = {
    PLATFORMS,
    PLATFORM_LABELS,
    LENGTH_LABELS,
    LOBBY_LENGTH_MINUTES,
    clamp,
    mention,
    mentionList,
    lobbyCardEmbed,
    lobbyCardComponents,
    lobbyCardPayload,
    disableComponents,
    lobbyButton,
    boardEmbed,
    digestEmbed,
    availabilityPanel,
    profileSummary,
    nudgeDm,
    newcomerDm,
    reminderPrompt,
    startPrompt,
    attendancePrompt,
};
