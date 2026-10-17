// ---------------------------------------------------------------------------
// Slash command definitions, handlers and autocomplete
// ---------------------------------------------------------------------------

const {
    ApplicationCommandOptionType,
    ChannelType,
    MessageFlags,
    PermissionFlagsBits,
    ThreadAutoArchiveDuration
} = require('discord.js');
const {
    LOG_COLORS,
    SERVER_CONFIGS,
    LOBBY_DEFAULT_SEATS,
    LOBBY_GAME_MIN_SUBMITTERS,
    LOBBY_LENGTH_MINUTES,
    LOBBY_MAX_DAYS_AHEAD,
    LOBBY_MAX_GAMES_PER_PROFILE,
    LOBBY_MAX_OPEN_PER_HOST,
    LOBBY_MAX_OPEN_TOTAL,
    LOBBY_MAX_SEATS,
    LOBBY_MAX_SERIES_PER_HOST,
    LOBBY_MIN_LEAD_MINUTES,
    LOBBY_MIN_SEATS,
    LOBBY_NOW_EXPIRY_MINUTES,
    LOBBY_SERIES_LEAD_HOURS
} = require('../config');
const client = require('../client');
const { sendStaffLog, errorField } = require('../staff-log');
const { resolveGuild, guildLabel, respondWithError } = require('../utils');
const activity = require('../activity');
const state = require('./state');
const render = require('./render');
const games = require('./games');
const components = require('./components');
const board = require('./board');
const stats = require('./stats');
const copy = require('./copy');
const time = require('./time');
const { lobbyConfigFor } = require('./guilds');

const PLATFORM_CHOICES = render.PLATFORMS.map(p => ({ name: p.label, value: p.value }));
const LENGTH_CHOICES = [
    { name: 'Quick (1 hour)', value: 'quick' },
    { name: 'Standard (2 hours)', value: 'standard' },
    { name: 'Long (4 hours)', value: 'long' }
];

// Options shared by /lobby create and /lobby now. `when` is added only to create.
function sharedCreateOptions() {
    return [
        { name: 'seats', description: `How many can play (${LOBBY_MIN_SEATS}-${LOBBY_MAX_SEATS}, default ${LOBBY_DEFAULT_SEATS})`, type: ApplicationCommandOptionType.Integer, required: false, min_value: LOBBY_MIN_SEATS, max_value: LOBBY_MAX_SEATS },
        { name: 'platform', description: 'Platform this lobby is on', type: ApplicationCommandOptionType.String, required: false, choices: PLATFORM_CHOICES },
        { name: 'crossplay', description: 'Allow other platforms to join (default yes)', type: ApplicationCommandOptionType.Boolean, required: false },
        { name: 'length', description: 'Roughly how long', type: ApplicationCommandOptionType.String, required: false, choices: LENGTH_CHOICES },
        { name: 'min_players', description: 'Do not run below this many', type: ApplicationCommandOptionType.Integer, required: false, min_value: 2, max_value: LOBBY_MAX_SEATS },
        { name: 'crew', description: 'Invite one of your crews', type: ApplicationCommandOptionType.String, required: false, autocomplete: true },
        { name: 'template', description: 'Start from one of your templates', type: ApplicationCommandOptionType.String, required: false, autocomplete: true },
        { name: 'note', description: 'Anything else (140 characters)', type: ApplicationCommandOptionType.String, required: false, max_length: 140 }
    ];
}

const LOBBY_COMMAND = {
    name: 'lobby',
    description: 'Set up a game with other members',
    options: [
        {
            name: 'create',
            description: 'Open a lobby for a time you choose',
            type: ApplicationCommandOptionType.Subcommand,
            options: [
                { name: 'game', description: 'What are you playing?', type: ApplicationCommandOptionType.String, required: true, autocomplete: true },
                { name: 'when', description: 'When does it start?', type: ApplicationCommandOptionType.String, required: true, autocomplete: true },
                { name: 'where', description: 'In-game, or which voice channel?', type: ApplicationCommandOptionType.String, required: true, autocomplete: true },
                ...sharedCreateOptions(),
                { name: 'repeat', description: 'Repeat this every week', type: ApplicationCommandOptionType.String, required: false, choices: [{ name: 'No', value: 'none' }, { name: 'Weekly', value: 'weekly' }] }
            ]
        },
        {
            name: 'now',
            description: 'Open a lobby starting right now',
            type: ApplicationCommandOptionType.Subcommand,
            options: [
                { name: 'game', description: 'What are you playing?', type: ApplicationCommandOptionType.String, required: true, autocomplete: true },
                { name: 'where', description: 'In-game, or which voice channel?', type: ApplicationCommandOptionType.String, required: true, autocomplete: true },
                ...sharedCreateOptions()
            ]
        },
        { name: 'mine', description: 'Your open and joined lobbies', type: ApplicationCommandOptionType.Subcommand },
        {
            name: 'series',
            description: 'Manage your repeating lobbies',
            type: ApplicationCommandOptionType.Subcommand,
            options: [
                { name: 'action', description: 'What to do', type: ApplicationCommandOptionType.String, required: true, choices: [{ name: 'List', value: 'list' }, { name: 'Stop', value: 'stop' }] },
                { name: 'id', description: 'Which repeating lobby (for stop)', type: ApplicationCommandOptionType.String, required: false, autocomplete: true }
            ]
        },
        {
            name: 'template',
            description: 'Manage your lobby templates',
            type: ApplicationCommandOptionType.Subcommand,
            options: [
                { name: 'action', description: 'What to do', type: ApplicationCommandOptionType.String, required: true, choices: [{ name: 'List', value: 'list' }, { name: 'Delete', value: 'delete' }] },
                { name: 'name', description: 'Which template (for delete)', type: ApplicationCommandOptionType.String, required: false, autocomplete: true }
            ]
        }
    ]
};

const AVAILABILITY_COMMAND = {
    name: 'lfg-profile',
    description: 'Set up your LFG profile: when you are free and what you play',
    options: [
        { name: 'set', description: 'Open your LFG profile panel', type: ApplicationCommandOptionType.Subcommand },
        {
            name: 'timezone',
            description: 'Set your time zone, so lobby times make sense',
            type: ApplicationCommandOptionType.Subcommand,
            options: [{ name: 'zone', description: 'Your time zone', type: ApplicationCommandOptionType.String, required: true, autocomplete: true }]
        },
        { name: 'tags', description: 'Add your gamertags (shared only inside your lobbies)', type: ApplicationCommandOptionType.Subcommand },
        { name: 'view', description: 'See your LFG profile', type: ApplicationCommandOptionType.Subcommand },
        { name: 'clear', description: 'Delete your LFG profile', type: ApplicationCommandOptionType.Subcommand }
    ]
};

const LOBBY_STATS_COMMAND = {
    name: 'lobby-stats',
    description: 'LFG activity summary (owner only)',
    defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
    options: [{ name: 'days', description: 'How far back (default 30)', type: ApplicationCommandOptionType.Integer, required: false, min_value: 1, max_value: 365 }]
};

const LOBBY_GAMES_COMMAND = {
    name: 'lobby-games',
    description: 'Manage the game registry (owner only)',
    defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
    options: [
        { name: 'list', description: 'Show the registry', type: ApplicationCommandOptionType.Subcommand },
        {
            name: 'remove',
            description: 'Remove a game and block it from being re-added',
            type: ApplicationCommandOptionType.Subcommand,
            options: [{ name: 'key', description: 'Which game', type: ApplicationCommandOptionType.String, required: true, autocomplete: true }]
        }
    ]
};

const LOBBY_COMMANDS = [LOBBY_COMMAND, AVAILABILITY_COMMAND, LOBBY_STATS_COMMAND, LOBBY_GAMES_COMMAND];

function ephemeral(content) {
    return { content, flags: MessageFlags.Ephemeral };
}

// ---------------------------------------------------------------------------
// Where to play
// ---------------------------------------------------------------------------

const VENUE_IN_GAME_VALUE = 'ingame';
const VENUE_VOICE_PREFIX = 'voice:';

function voiceChannelsFor(guildId) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return [];

    // Cache only: autocomplete has about three seconds and must not make REST calls.
    return [...guild.channels.cache.values()]
        .filter(channel => channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice);
}

// One required field covering both answers, because a slash option cannot be "either a
// channel or a literal". In-game is offered first so it is never buried, then the
// configured default voice channel, then the rest.
function venueChoices(guildId, query) {
    const q = String(query || '').trim().toLowerCase();
    const config = lobbyConfigFor(guildId);
    const channels = voiceChannelsFor(guildId);

    const choices = [];
    const inGameLabel = `\uD83C\uDFAE ${copy.venueInGame}`;

    if (!q || copy.venueInGame.toLowerCase().includes(q) || 'in game'.includes(q)) {
        choices.push({ name: inGameLabel, value: VENUE_IN_GAME_VALUE });
    }

    const ordered = channels.sort((a, b) => {
        const aDefault = a.id === config?.defaultVoiceChannelId ? 0 : 1;
        const bDefault = b.id === config?.defaultVoiceChannelId ? 0 : 1;
        return aDefault - bDefault || (a.name || '').localeCompare(b.name || '');
    });

    for (const channel of ordered) {
        if (choices.length >= 25) break;
        if (q && !(channel.name || '').toLowerCase().includes(q)) continue;

        choices.push({
            name: `\uD83D\uDD0A ${channel.name}`.slice(0, 100),
            value: `${VENUE_VOICE_PREFIX}${channel.id}`
        });
    }

    return choices.slice(0, 25);
}

// Re-validated on submit, because Discord accepts free text even with autocomplete on.
// Returns { ok, venue, voiceChannelId } or { ok: false }.
function resolveVenue(guildId, raw) {
    const value = String(raw || '').trim();

    if (value === VENUE_IN_GAME_VALUE) return { ok: true, venue: 'ingame', voiceChannelId: null };

    const id = value.startsWith(VENUE_VOICE_PREFIX)
        ? value.slice(VENUE_VOICE_PREFIX.length)
        // Tolerate a bare channel id, which is what pasting a channel gives.
        : (/^\d{17,20}$/.test(value) ? value : null);

    if (!id) return { ok: false };

    const channel = voiceChannelsFor(guildId).find(c => c.id === id);
    if (!channel) return { ok: false };

    return { ok: true, venue: 'voice', voiceChannelId: channel.id };
}

// ---------------------------------------------------------------------------
// Autocomplete
// ---------------------------------------------------------------------------

// Must stay synchronous-ish and allocation-light: Discord gives roughly three seconds
// and no REST call happens in here.
async function handleLobbyAutocomplete(interaction) {
    const guildId = interaction.guildId;
    if (!guildId || !lobbyConfigFor(guildId)) return interaction.respond([]);

    const focused = interaction.options.getFocused(true);
    const userId = interaction.user.id;
    const guild = state.guildState(guildId);
    const query = String(focused.value || '');

    try {
        if (focused.name === 'zone') {
            return interaction.respond(time.zoneChoices(query));
        }

        if (focused.name === 'game') {
            return interaction.respond(games.gameChoices(guild.games, {
                query,
                userId,
                minSubmitters: LOBBY_GAME_MIN_SUBMITTERS,
                blockedGames: guild.blockedGames
            }));
        }

        if (focused.name === 'key') {
            const keys = Object.keys(guild.games);
            const q = games.normalizeGameKey(query) || '';
            const matched = keys.filter(key => !q || key.includes(q)).slice(0, 25);

            return interaction.respond(matched.map(key => ({
                name: `${guild.games[key].label} (${key})`.slice(0, 100),
                value: key
            })));
        }

        if (focused.name === 'when') {
            const profile = state.getProfile(guildId, userId);

            if (!profile?.tz) {
                // The only way to surface this before submission.
                return interaction.respond([{ name: 'Set your time zone first: /lfg-profile timezone', value: 'notz' }]);
            }

            const slots = time.generateSlots(Date.now(), profile.tz, {
                maxDays: LOBBY_MAX_DAYS_AHEAD,
                minLeadMinutes: LOBBY_MIN_LEAD_MINUTES
            });

            const filtered = query.trim() ? time.filterSlots(slots, query) : time.defaultSlots(slots);

            return interaction.respond(filtered.slice(0, 25).map(slot => ({
                name: slot.label.slice(0, 100),
                value: slot.value
            })));
        }

        if (focused.name === 'where') {
            return interaction.respond(venueChoices(guildId, query));
        }

        if (focused.name === 'crew') {
            const mine = state.listCrews(guildId, userId);
            const q = query.toLowerCase();

            return interaction.respond(mine
                .filter(crew => !q || crew.name.toLowerCase().includes(q))
                .slice(0, 25)
                .map(crew => ({ name: crew.name.slice(0, 100), value: crew.id })));
        }

        if (focused.name === 'template') {
            const templates = Object.keys(state.getTemplates(guildId, userId));
            const q = query.toLowerCase();

            return interaction.respond(templates
                .filter(name => !q || name.toLowerCase().includes(q))
                .slice(0, 25)
                .map(name => ({ name: name.slice(0, 100), value: name })));
        }

        if (focused.name === 'id') {
            const series = state.listSeries(guildId, userId);

            return interaction.respond(series.slice(0, 25).map(s => ({
                name: `${s.params?.gameLabel || 'lobby'} · weekly`.slice(0, 100),
                value: s.id
            })));
        }

        if (focused.name === 'name') {
            const templates = Object.keys(state.getTemplates(guildId, userId));
            return interaction.respond(templates.slice(0, 25).map(name => ({ name, value: name })));
        }

        return interaction.respond([]);
    } catch (error) {
        console.error('Lobby autocomplete failed:', error);
        return interaction.respond([]).catch(() => {});
    }
}

// ---------------------------------------------------------------------------
// /lfg-profile
// ---------------------------------------------------------------------------

async function handleAvailabilityCommand(interaction) {
    const guildId = interaction.guildId;
    if (!guildId || !lobbyConfigFor(guildId)) return interaction.reply(ephemeral(copy.lobbyStale));

    const sub = interaction.options.getSubcommand();
    const userId = interaction.user.id;

    if (sub === 'set') {
        const payload = components.buildPanel(guildId, userId);
        return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
    }

    if (sub === 'timezone') {
        const raw = interaction.options.getString('zone');
        // Discord accepts free text even with autocomplete on, so this is re-validated.
        const zone = time.resolveZone(raw);

        if (!zone) {
            return interaction.reply(ephemeral(`\`${String(raw).slice(0, 60)}\` is not a time zone I recognise. Try a city name like \`America/New_York\`, or "eastern".`));
        }

        state.updateProfile(guildId, userId, { tz: zone });
        const nowLabel = time.formatClock(time.localParts(Date.now(), zone));

        return interaction.reply(ephemeral(`Time zone set to **${zone}**. It is **${nowLabel}** for you right now.`));
    }

    if (sub === 'tags') {
        return interaction.showModal(components.buildTagsModal(guildId, userId));
    }

    if (sub === 'view') {
        const profile = state.getProfile(guildId, userId);
        if (!profile) return interaction.reply(ephemeral('You have no LFG profile yet. Run `/lfg-profile set`.'));

        const guild = state.guildState(guildId);
        const labels = (profile.games || []).map(key => guild.games[key]?.label || key);

        return interaction.reply({ embeds: [render.profileSummary(profile, labels)], flags: MessageFlags.Ephemeral });
    }

    if (sub === 'clear') {
        const deleted = state.deleteProfile(guildId, userId);
        return interaction.reply(ephemeral(deleted ? copy.availabilityCleared : 'You had no LFG profile to delete.'));
    }

    return interaction.reply(ephemeral(copy.lobbyStale));
}

// ---------------------------------------------------------------------------
// /lobby
// ---------------------------------------------------------------------------

// Resolves the `game` option into a registry entry, creating one if the host typed
// something new. Everything is re-validated, because Discord lets a user submit text
// that was never offered as a choice.
function resolveGameOption(guildId, userId, raw) {
    const guild = state.guildState(guildId);

    if (typeof raw === 'string' && raw.startsWith('new:')) {
        const check = games.validateGameTitle(raw.slice(4), guild.blockedGames);
        if (!check.ok) return { ok: false, reason: check.reason };

        state.registerGame(guildId, check.key, check.label, userId);
        return { ok: true, key: check.key, label: check.label, created: true };
    }

    const key = games.normalizeGameKey(raw);
    if (!key) return { ok: false, reason: 'empty' };
    if (guild.blockedGames.includes(key)) return { ok: false, reason: 'blocked' };

    if (guild.games[key]) {
        return { ok: true, key, label: guild.games[key].label, created: false };
    }

    // Typed a title that is not in the registry: treat it as a submission.
    const check = games.validateGameTitle(raw, guild.blockedGames);
    if (!check.ok) return { ok: false, reason: check.reason };

    state.registerGame(guildId, check.key, check.label, userId);
    return { ok: true, key: check.key, label: check.label, created: true };
}

function buildLobbyFields(interaction, guildId, { template, now }) {
    const get = (name, fallback) => {
        const value = interaction.options.get(name)?.value;
        return value === undefined || value === null ? fallback : value;
    };

    const base = template || {};

    return {
        seats: get('seats', base.seats ?? LOBBY_DEFAULT_SEATS),
        platform: get('platform', base.platform ?? null),
        crossplay: get('crossplay', base.crossplay ?? true),
        length: get('length', base.length ?? 'standard'),
        minPlayers: get('min_players', base.minPlayers ?? null),
        // venue and voiceChannelId come from the required `where` option, resolved in
        // createLobby, so they are deliberately not set here.
        note: String(get('note', base.note ?? '')).slice(0, 140),
        isNow: Boolean(now)
    };
}

async function handleLobbyCommand(interaction) {
    const guildId = interaction.guildId;
    if (!guildId || !lobbyConfigFor(guildId)) return interaction.reply(ephemeral(copy.lobbyStale));

    const sub = interaction.options.getSubcommand();

    try {
        if (sub === 'create') return await createLobby(interaction, guildId, { now: false });
        if (sub === 'now') return await createLobby(interaction, guildId, { now: true });
        if (sub === 'mine') return await showMine(interaction, guildId);
        if (sub === 'series') return await handleSeries(interaction, guildId);
        if (sub === 'template') return await handleTemplate(interaction, guildId);
    } catch (error) {
        console.error(`Error in /lobby ${sub}:`, error);
        await respondWithError(interaction, 'Something went wrong with that. Nothing was changed.');
    }

    return undefined;
}

async function createLobby(interaction, guildId, { now }) {
    const userId = interaction.user.id;
    const guild = state.guildState(guildId);

    // Caps first, so a host at the limit is told before anything else happens.
    const open = state.allLobbies(guildId).filter(l => l.status === 'open');

    if (open.filter(l => l.hostId === userId && !l.seriesId).length >= LOBBY_MAX_OPEN_PER_HOST) {
        return interaction.reply(ephemeral(copy.lobbyCapHost));
    }
    if (open.length >= LOBBY_MAX_OPEN_TOTAL) {
        return interaction.reply(ephemeral(copy.lobbyCapTotal));
    }

    const templateName = interaction.options.getString('template');
    const template = templateName ? state.getTemplates(guildId, userId)[templateName] : null;
    if (templateName && !template) return interaction.reply(ephemeral(copy.templateMissing));

    const gameRaw = interaction.options.getString('game') || template?.gameKey;
    const resolved = resolveGameOption(guildId, userId, gameRaw);

    if (!resolved.ok) {
        return interaction.reply(ephemeral(resolved.reason === 'blocked' ? copy.gameBlocked : copy.gameRejected));
    }

    let startsAt;

    if (now) {
        startsAt = Date.now();
    } else {
        const raw = interaction.options.getString('when');
        const profile = state.getProfile(guildId, userId);

        if (!profile?.tz) return interaction.reply(ephemeral(copy.availabilityNoTimezone));
        if (!/^\d+$/.test(String(raw))) return interaction.reply(ephemeral(copy.lobbyBadTime));

        startsAt = Number(raw) * 1000;

        if (!Number.isFinite(startsAt)) return interaction.reply(ephemeral(copy.lobbyBadTime));
        if (startsAt < Date.now() + LOBBY_MIN_LEAD_MINUTES * 60 * 1000) return interaction.reply(ephemeral(copy.lobbyLeadTooSoon));
        if (startsAt > Date.now() + LOBBY_MAX_DAYS_AHEAD * 24 * 60 * 60 * 1000) return interaction.reply(ephemeral(copy.lobbyTooFarAhead));
    }

    // Required, so Discord guarantees a value; still re-validated because free text is
    // accepted even with autocomplete on.
    const venue = resolveVenue(guildId, interaction.options.getString('where'));
    if (!venue.ok) return interaction.reply(ephemeral(copy.lobbyBadVenue));

    const fields = buildLobbyFields(interaction, guildId, { template, now });
    fields.venue = venue.venue;
    fields.voiceChannelId = venue.voiceChannelId;

    if (fields.seats < LOBBY_MIN_SEATS || fields.seats > LOBBY_MAX_SEATS) {
        return interaction.reply(ephemeral(`Seats must be between ${LOBBY_MIN_SEATS} and ${LOBBY_MAX_SEATS}.`));
    }
    if (fields.minPlayers && fields.minPlayers > fields.seats) {
        return interaction.reply(ephemeral('The minimum player count cannot be higher than the number of seats.'));
    }

    const crewId = interaction.options.getString('crew') || null;
    const crew = crewId ? state.listCrews(guildId, userId).find(c => c.id === crewId) : null;

    if (crew) {
        fields.platform = fields.platform || crew.platform;
    }

    const lengthMinutes = LOBBY_LENGTH_MINUTES[fields.length] || LOBBY_LENGTH_MINUTES.standard;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const lobby = state.createLobby(guildId, {
        hostId: userId,
        gameKey: resolved.key,
        gameLabel: resolved.label,
        startsAt,
        endsAt: startsAt + lengthMinutes * 60 * 1000,
        crewId: crew?.id || null,
        ...fields
    });

    state.noteGameUsed(guildId, resolved.key);

    const posted = await postLobbyCard(guildId, lobby);

    if (!posted.ok) {
        state.deleteLobby(guildId, lobby.id);
        return interaction.editReply(`Could not post the lobby card: ${posted.error}. Nothing was created.`);
    }

    // Weekly repeat: the first lobby exists, now record the series.
    let seriesNote = '';
    const repeat = interaction.options.getString('repeat');

    if (!now && repeat === 'weekly') {
        const profile = state.getProfile(guildId, userId);
        const activeSeries = state.listSeries(guildId, userId);

        if (activeSeries.length >= LOBBY_MAX_SERIES_PER_HOST) {
            seriesNote = `\n${copy.seriesCapReached}`;
        } else {
            const parts = time.localParts(startsAt, profile.tz);
            const series = state.createSeries(guildId, {
                hostId: userId,
                tz: profile.tz,
                weekday: parts.weekday,
                hour: parts.hour,
                minute: parts.minute,
                params: { ...fields, gameKey: resolved.key, gameLabel: resolved.label },
                nextStartsAt: time.nextWeeklyOccurrence(startsAt, profile.tz, parts.weekday, parts.hour, parts.minute) || startsAt + 7 * 24 * 60 * 60 * 1000
            });

            lobby.seriesId = series.id;
            state.markDirty();
            seriesNote = '\nThis repeats weekly. Stop it any time with `/lobby series action:Stop`.';
        }
    }

    if (crew) {
        void components.postToThread(guildId, lobby,
            `${render.mentionList(crew.members.filter(id => id !== userId))} a **${games.escapeLabel(crew.name)}** lobby is up.`);
    }

    // Fired here rather than from the sweep, so a member whose games and availability
    // match hears about it while the lobby is still fresh.
    void require('./sweep').dispatchNudges(guildId, lobby);

    board.markBoardDirty(guildId);

    const nowNote = now ? `\nIf nobody joins within ${LOBBY_NOW_EXPIRY_MINUTES} minutes it expires on its own.` : '';
    const newGameNote = resolved.created ? `\nAdded **${games.escapeLabel(resolved.label)}** to the server's game list.` : '';

    return interaction.editReply(`Lobby **#${lobby.number}** is up in <#${lobby.cardChannelId}>.${nowNote}${seriesNote}${newGameNote}`);
}

// Posts the card and starts its thread. A thread failure is not fatal: the lobby still
// works, it just has nowhere to post reminders.
async function postLobbyCard(guildId, lobby) {
    const config = lobbyConfigFor(guildId);

    try {
        const guild = await resolveGuild(guildId);
        if (!guild) return { ok: false, error: 'server unavailable' };

        const channel = guild.channels.cache.get(config.channelId)
            || await guild.channels.fetch(config.channelId).catch(() => null);

        if (!channel || !channel.isTextBased()) return { ok: false, error: 'LFG channel not found' };

        const message = await channel.send(render.lobbyCardPayload(lobby));

        lobby.cardChannelId = channel.id;
        lobby.cardMessageId = message.id;
        state.markDirty();

        try {
            const thread = await message.startThread({
                name: `LFG #${lobby.number} ${lobby.gameLabel}`.slice(0, 100),
                autoArchiveDuration: ThreadAutoArchiveDuration.OneDay
            });

            lobby.threadId = thread.id;
            state.markDirty();
        } catch (error) {
            console.error(`Could not start a thread for lobby ${lobby.id}:`, error.message);
            void throttledThreadError(guildId, error);
        }

        return { ok: true };
    } catch (error) {
        console.error(`Could not post lobby card for ${lobby.id}:`, error);
        return { ok: false, error: error.message };
    }
}

// One embed per guild per hour at most, so a permissions problem does not flood the log.
const lastThreadErrorAt = new Map();

async function throttledThreadError(guildId, error) {
    const now = Date.now();
    if (now - (lastThreadErrorAt.get(guildId) || 0) < 60 * 60 * 1000) return;
    lastThreadErrorAt.set(guildId, now);

    await sendStaffLog(guildId, {
        color: LOG_COLORS.error,
        title: 'LFG Thread Creation Failed',
        description: `A lobby card in ${guildLabel(guildId)} was posted but its thread could not be created, so that lobby has no reminders.`,
        fields: [errorField(error), { name: 'Likely Cause', value: 'The bot needs Create Public Threads and Send Messages in Threads in the LFG channel.' }]
    });
}

async function showMine(interaction, guildId) {
    const userId = interaction.user.id;
    const lobbies = state.allLobbies(guildId)
        .filter(l => (l.status === 'open' || l.status === 'live')
            && (l.hostId === userId || l.players.includes(userId) || l.maybes.includes(userId) || l.waitlist.includes(userId)))
        .sort((a, b) => a.startsAt - b.startsAt);

    const crewList = state.listCrews(guildId, userId);

    if (lobbies.length === 0 && crewList.length === 0) {
        return interaction.reply(ephemeral('You have no open lobbies and are not in any crews. Start one with `/lobby create`.'));
    }

    const lines = lobbies.map(lobby => {
        const role = lobby.hostId === userId ? 'hosting'
            : lobby.players.includes(userId) ? 'playing'
                : lobby.maybes.includes(userId) ? 'maybe' : 'waitlisted';

        const link = lobby.cardMessageId
            ? `https://discord.com/channels/${guildId}/${lobby.cardChannelId}/${lobby.cardMessageId}`
            : '(card missing)';

        return `• **#${lobby.number}** ${games.escapeLabel(lobby.gameLabel)} · <t:${Math.floor(lobby.startsAt / 1000)}:R> · ${role} · ${link}`;
    });

    if (crewList.length > 0) {
        lines.push('', '**Your crews**');
        for (const crew of crewList) {
            lines.push(`• ${games.escapeLabel(crew.name)} · ${crew.members.length} members · \`${crew.id}\``);
        }
        lines.push('_Leave a crew by starting a lobby for it and saying so, or ask staff to remove you._');
    }

    return interaction.reply(ephemeral(render.clamp(lines.join('\n'), 1900)));
}

async function handleSeries(interaction, guildId) {
    const userId = interaction.user.id;
    const action = interaction.options.getString('action');

    if (action === 'list') {
        const series = state.listSeries(guildId, userId);
        if (series.length === 0) return interaction.reply(ephemeral(copy.seriesNone));

        const lines = series.map(s => {
            const label = s.params?.gameLabel || 'lobby';
            return `• **${games.escapeLabel(label)}** · weekly · next <t:${Math.floor(s.nextStartsAt / 1000)}:F> · \`${s.id}\``;
        });

        return interaction.reply(ephemeral(`**Your repeating lobbies**\n${lines.join('\n')}`));
    }

    const id = interaction.options.getString('id');
    if (!id) return interaction.reply(ephemeral('Pick which repeating lobby to stop.'));

    const series = state.getSeries(guildId, id);
    if (!series || series.hostId !== userId) return interaction.reply(ephemeral('That is not one of your repeating lobbies.'));

    state.stopSeries(guildId, id);
    return interaction.reply(ephemeral(copy.seriesStopped));
}

async function handleTemplate(interaction, guildId) {
    const userId = interaction.user.id;
    const action = interaction.options.getString('action');
    const templates = state.getTemplates(guildId, userId);

    if (action === 'list') {
        const names = Object.keys(templates);
        if (names.length === 0) return interaction.reply(ephemeral('You have no templates. Save one from a lobby card.'));

        const lines = names.map(name => {
            const t = templates[name];
            return `• **${name}** · ${games.escapeLabel(t.gameLabel || t.gameKey || '?')} · ${t.seats} seats`;
        });

        return interaction.reply(ephemeral(`**Your templates**\n${lines.join('\n')}`));
    }

    const name = interaction.options.getString('name');
    if (!name) return interaction.reply(ephemeral('Pick which template to delete.'));

    return interaction.reply(ephemeral(state.deleteTemplate(guildId, userId, name) ? copy.templateDeleted : copy.templateMissing));
}

// ---------------------------------------------------------------------------
// Owner commands
// ---------------------------------------------------------------------------

async function handleLobbyStatsCommand(interaction) {
    if (!activity.isActivityOwner(interaction.user.id)) {
        await activity.logUnauthorizedAttempt(interaction);
        return interaction.reply(ephemeral('You do not have permission to view LFG stats.'));
    }

    const guildId = interaction.guildId;
    if (!guildId || !lobbyConfigFor(guildId)) return interaction.reply(ephemeral(copy.lobbyStale));

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const days = interaction.options.getInteger('days') || 30;
    const guild = state.guildState(guildId);
    const summary = stats.summarize(guild, { nowMs: Date.now(), days });
    const overlap = stats.availabilityOverlap(guild, { nowMs: Date.now() });

    const pct = value => (value === null ? '—' : `${Math.round(value * 100)}%`);
    const mins = value => (value === null ? '—' : `${Math.round(value / 60000)} min`);

    const lines = [
        `**LFG stats · last ${days} days · ${guildLabel(guildId)}**`,
        '',
        `Lobbies created: **${summary.created}** (viable, 2+ confirmed: **${summary.viable}**)`,
        `Fill rate: **${pct(summary.fillRate)}** · show rate: **${pct(summary.showRate)}** (from ${summary.attendanceRecords} record(s))`,
        `Median time to fill: **${mins(summary.medianTimeToFillMs)}**`,
        `Unique hosts: **${summary.uniqueHosts}** · participants: **${summary.uniqueParticipants}** · repeat: **${summary.repeatParticipants}**`,
        `Nudges sent: **${summary.nudgesSent}** · joined after one: **${summary.nudgesJoined}**`,
        `Crews: **${summary.crews}** · active series: **${summary.activeSeries}** · open now: **${summary.openLobbies}**`,
        `Games: **${summary.gamesListed}** listed of **${summary.gamesTotal}** submitted`
    ];

    if (summary.topGames.length > 0) {
        lines.push('', '**Most lobbies**', ...summary.topGames.map((g, i) => `${i + 1}. ${games.escapeLabel(g.label)} · ${g.count}`));
    }

    if (overlap.length > 0) {
        lines.push('', '**Best overlapping times**');
        for (const entry of overlap) {
            const slots = entry.top.map(t => `<t:${Math.floor(t.instant / 1000)}:F> (${t.count})`).join(', ');
            lines.push(`• ${games.escapeLabel(entry.label)} · ${entry.members} with it on their profile · ${slots}`);
        }
    }

    return interaction.editReply(render.clamp(lines.join('\n'), 1900));
}

async function handleLobbyGamesCommand(interaction) {
    if (!activity.isActivityOwner(interaction.user.id)) {
        await activity.logUnauthorizedAttempt(interaction);
        return interaction.reply(ephemeral('You do not have permission to manage the game registry.'));
    }

    const guildId = interaction.guildId;
    if (!guildId || !lobbyConfigFor(guildId)) return interaction.reply(ephemeral(copy.lobbyStale));

    const guild = state.guildState(guildId);
    const sub = interaction.options.getSubcommand();

    if (sub === 'list') {
        const entries = Object.entries(guild.games)
            .sort((a, b) => ((b[1].submitters?.length || 0) + (b[1].lobbyCount || 0)) - ((a[1].submitters?.length || 0) + (a[1].lobbyCount || 0)))
            .slice(0, 40);

        if (entries.length === 0) return interaction.reply(ephemeral('The game registry is empty. It fills up as members add games and hosts create lobbies.'));

        const lines = entries.map(([key, entry]) => {
            const listed = games.isListed(entry, LOBBY_GAME_MIN_SUBMITTERS) ? '' : ' _(unlisted)_';
            return `• **${games.escapeLabel(entry.label)}** \`${key}\` · ${(entry.submitters || []).length} submitter(s) · ${entry.lobbyCount || 0} lobby/ies${listed}`;
        });

        if (guild.blockedGames.length > 0) {
            lines.push('', `Blocked: ${guild.blockedGames.map(k => `\`${k}\``).join(', ')}`);
        }

        return interaction.reply(ephemeral(render.clamp(lines.join('\n'), 1900)));
    }

    const key = interaction.options.getString('key');
    if (!guild.games[key]) return interaction.reply(ephemeral('No game with that key.'));

    const label = guild.games[key].label;
    state.blockGame(guildId, key);

    await sendStaffLog(guildId, {
        color: LOG_COLORS.lobby,
        title: 'LFG Game Removed',
        description: `**${games.escapeLabel(label)}** (\`${key}\`) was removed from the game registry in ${guildLabel(guildId)} and cannot be re-added.`,
        fields: [{ name: 'Removed By', value: `**${interaction.user.tag}** (<@${interaction.user.id}>)` }],
        footer: `Owner command (${interaction.user.tag})`
    });

    return interaction.reply(ephemeral(`Removed **${games.escapeLabel(label)}** and blocked the key. Existing lobbies keep their label.`));
}

module.exports = {
    LOBBY_COMMANDS,
    venueChoices,
    resolveVenue,
    VENUE_IN_GAME_VALUE,
    VENUE_VOICE_PREFIX,
    LOBBY_COMMAND,
    AVAILABILITY_COMMAND,
    LOBBY_STATS_COMMAND,
    LOBBY_GAMES_COMMAND,
    handleLobbyCommand,
    handleAvailabilityCommand,
    handleLobbyStatsCommand,
    handleLobbyGamesCommand,
    handleLobbyAutocomplete,
    postLobbyCard,
    resolveGameOption,
};
