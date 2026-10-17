// ---------------------------------------------------------------------------
// Buttons, selects and modals
// ---------------------------------------------------------------------------
//
// Every lobby component id starts with `lobby:`, so the router can claim it without
// touching the existing purge / exclear / gamerid branches.
//
// Two rules run through all of this:
//
//   1. Acknowledge fast. State is mutated synchronously, the interaction is answered,
//      and only then is the card edited - so a slow card edit can never make the
//      interaction time out.
//   2. A DM press has no guild and no member. Handlers therefore resolve the lobby by id
//      across guilds and fetch the member from the guild, never from interaction.member.

const {
    ActionRowBuilder,
    MessageFlags,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle
} = require('discord.js');
const {
    LOBBY_AGAIN_WINDOW_HOURS,
    LOBBY_MAX_GAMES_PER_PROFILE,
    LOBBY_MAX_SEATS,
    LOBBY_MIN_SEATS,
    LOBBY_MAX_TEMPLATES_PER_HOST,
    LOBBY_GAME_MIN_SUBMITTERS,
    LOG_COLORS
} = require('../config');
const { sendStaffLog } = require('../staff-log');
const { resolveGuild, hasStaffPermission, guildLabel } = require('../utils');
const { SERVER_CONFIGS } = require('../config');
const { RESTJSONErrorCodes } = require('discord-api-types/v10');
const state = require('./state');
const render = require('./render');
const games = require('./games');
const crews = require('./crews');
const board = require('./board');
const copy = require('./copy');
const { lobbyConfigFor } = require('./guilds');

const PREFIX = 'lobby:';

// Once attendance is settled, every lobby control is closed. Listed as a set so the
// "Play again stays live" variant is a one-line change: put 'again' in here.
//
// NOTE: with this empty, confirming attendance immediately also closes Play again, which
// means a crew can no longer form from that lobby (crew formation needs two presses).
const LOCK_EXEMPT_ACTIONS = new Set();

// Actions still accepted on an ended lobby whose attendance has NOT been settled yet:
// recording who showed, and voting for another round.
const POST_GAME_ACTIONS = new Set(['attconfirm', 'again', 'att']);

// The server-side half of the lock. Visual greying covers the card and the tracked
// thread prompts; this covers everything that cannot be greyed - nudge DMs, prompts
// posted before this change, and a modal opened just before the lock landed.
//
// Returns null when the action is allowed, or the message to answer with.
function lockReason(lobby, action) {
    if (!lobby) return copy.lobbyStale;

    if (lobby.status === 'open' || lobby.status === 'live') return null;
    if (lobby.status === 'cancelled' || lobby.status === 'expired') return copy.lobbyStale;

    // status === 'ended'
    if (state.isAttendanceFinal(lobby)) {
        return LOCK_EXEMPT_ACTIONS.has(action) ? null : copy.lobbyLocked;
    }

    return POST_GAME_ACTIONS.has(action) ? null : copy.lobbyStale;
}

// Shared by the Gamertags button on the panel and by /lfg-profile tags, so the two
// cannot drift apart.
function buildTagsModal(guildId, userId) {
    const profile = state.ensureProfile(guildId, userId);
    const tags = profile.tags || {};

    const input = (id, label) => new ActionRowBuilder().addComponents(
        new TextInputBuilder()
            .setCustomId(id)
            .setLabel(label)
            .setStyle(TextInputStyle.Short)
            .setValue(tags[id] || '')
            .setRequired(false)
            .setMaxLength(60));

    return new ModalBuilder()
        .setCustomId('lobby:mod:tags')
        .setTitle('Your gamertags')
        // Five text inputs is Discord's modal maximum, which is exactly this.
        .addComponents(
            input('steam', 'Steam'),
            input('playstation', 'PlayStation'),
            input('xbox', 'Xbox'),
            input('epic', 'Epic'),
            input('other', 'Other')
        );
}

function isLobbyComponent(customId) {
    return typeof customId === 'string' && customId.startsWith(PREFIX);
}

function ephemeral(content) {
    return { content, flags: MessageFlags.Ephemeral };
}

// ---------------------------------------------------------------------------
// Shared resolution
// ---------------------------------------------------------------------------

// Finds the lobby regardless of where the press came from. A DM carries no guildId, so
// the id is looked up across guilds.
function resolveLobby(interaction, lobbyId) {
    if (interaction.guildId) {
        const lobby = state.getLobby(interaction.guildId, lobbyId);
        if (lobby) return { guildId: interaction.guildId, lobby };
    }

    return state.findLobbyAnywhere(lobbyId);
}

// Always fetched from the guild, never read off the interaction, so this works in a DM.
async function fetchMember(guildId, userId) {
    const guild = await resolveGuild(guildId);
    if (!guild) return null;

    return guild.members.cache.get(userId) || await guild.members.fetch(userId).catch(() => null);
}

async function isHostOrStaff(guildId, lobby, userId) {
    if (lobby.hostId === userId) return true;

    const member = await fetchMember(guildId, userId);
    if (!member) return false;

    const serverConfig = SERVER_CONFIGS[guildId];
    if (!serverConfig) return false;

    try {
        return hasStaffPermission(member, userId, serverConfig);
    } catch (error) {
        // A member object without a role cache would otherwise throw out of the handler,
        // leaving the press with no reply at all. Fail closed and say so in the log.
        console.error(`Could not read roles for ${userId} in ${guildId}:`, error.message);
        return false;
    }
}

// A lobby with crossplay off only accepts members whose profile lists a matching
// platform. No profile means no obstacle - they are let in and nudged to set one up.
function platformAllows(lobby, profile) {
    if (lobby.crossplay) return true;
    if (!lobby.platform) return true;
    if (!profile || !Array.isArray(profile.platforms) || profile.platforms.length === 0) return true;

    return profile.platforms.includes(lobby.platform);
}

// Card edits happen after the interaction is answered, so they are fire-and-forget.
async function refreshCard(guildId, lobby) {
    board.markBoardDirty(guildId);

    if (!lobby.cardChannelId || !lobby.cardMessageId || lobby.cardDeleted) return;

    try {
        const guild = await resolveGuild(guildId);
        if (!guild) return;

        const channel = guild.channels.cache.get(lobby.cardChannelId)
            || await guild.channels.fetch(lobby.cardChannelId).catch(() => null);
        if (!channel || !channel.isTextBased()) return;

        const message = await channel.messages.fetch(lobby.cardMessageId);
        await message.edit(render.lobbyCardPayload(lobby));
    } catch (error) {
        if (error.code === 10008) {
            // Staff deleted the card. An open lobby without a card is unmanageable, so
            // treat it as cancelled rather than leaving a ghost.
            lobby.cardDeleted = true;

            if (lobby.status === 'open') {
                state.setLobbyStatus(lobby, 'cancelled');
                // Same notice as any other cancellation: the people who signed up should
                // not be left waiting for a lobby that no longer exists. The host did not
                // do this either, so they are told as well.
                void notifyCancelled(guildId, lobby, copy.cancelReasonCardGone, {
                    notifyHost: true,
                    hostReason: copy.cancelReasonCardGone
                });

                await sendStaffLog(guildId, {
                    color: LOG_COLORS.lobby,
                    title: 'LFG Lobby Cancelled (Card Deleted)',
                    description: `Lobby #${lobby.number} in ${guildLabel(guildId)} was cancelled because its card message had been deleted.`
                });
            }

            state.markDirty();
            return;
        }

        console.error(`Could not refresh lobby card ${lobby.id}:`, error.message);
    }
}

async function postToThread(guildId, lobby, payload) {
    if (!lobby.threadId) return null;

    try {
        const guild = await resolveGuild(guildId);
        if (!guild) return null;

        const thread = await guild.channels.fetch(lobby.threadId).catch(() => null);
        if (!thread || !thread.isTextBased()) return null;

        return await thread.send(typeof payload === 'string' ? { content: payload } : payload);
    } catch (error) {
        console.error(`Could not post to lobby thread ${lobby.threadId}:`, error.message);
        return null;
    }
}

// Remembers a thread prompt that carries buttons, so lockLobbyUi can grey it later.
// Safe to call with null, which is what postToThread returns on failure.
function trackPrompt(lobby, message) {
    if (!message?.id) return;

    if (!Array.isArray(lobby.promptMessageIds)) lobby.promptMessageIds = [];
    if (lobby.promptMessageIds.includes(message.id)) return;

    lobby.promptMessageIds.push(message.id);
    state.markDirty();
}

// Greys out every control for a lobby: the card, then each tracked thread prompt.
// Never throws, and one failed edit never stops the others - a half-greyed lobby is
// still backed by the server-side lockReason gate.
async function lockLobbyUi(guildId, lobby) {
    try {
        await refreshCard(guildId, lobby);
    } catch (error) {
        console.error(`Could not grey the card for lobby ${lobby.id}:`, error.message);
    }

    const ids = lobby.promptMessageIds || [];
    if (ids.length === 0 || !lobby.threadId) return;

    let thread = null;

    try {
        const guild = await resolveGuild(guildId);
        thread = guild ? await guild.channels.fetch(lobby.threadId).catch(() => null) : null;
    } catch (error) {
        return;
    }

    if (!thread || !thread.isTextBased()) return;

    let unarchivedByUs = false;

    for (const messageId of ids) {
        try {
            const message = await thread.messages.fetch(messageId);

            // Only the bot's own prompts, and only if they still carry components.
            if (message.author?.id !== require('../client').user?.id) continue;
            if (!message.components || message.components.length === 0) continue;

            await message.edit({ components: render.disableComponents(message.components) });
        } catch (error) {
            if (error.code === RESTJSONErrorCodes.UnknownMessage) continue;

            // The voice fallback runs about 24 hours after the end and threads
            // auto-archive after a day, so this path is the normal case rather than an
            // edge one. Unarchive once, retry once, then give up quietly.
            if (error.code === RESTJSONErrorCodes.InvalidActionOnArchivedThread && !unarchivedByUs) {
                try {
                    await thread.setArchived(false, 'Closing out an LFG lobby');
                    unarchivedByUs = true;

                    const message = await thread.messages.fetch(messageId);
                    await message.edit({ components: render.disableComponents(message.components) });
                    continue;
                } catch (retryError) {
                    console.error(`Could not grey prompt ${messageId} after unarchiving:`, retryError.message);
                    continue;
                }
            }

            console.error(`Could not grey prompt ${messageId}:`, error.message);
        }
    }

    if (unarchivedByUs) {
        await thread.setArchived(true, 'LFG lobby closed').catch(() => {});
    }
}

// Everyone who had signed up in any way, minus the host. Confirmed players obviously,
// but maybes and the waitlist too: they were all holding time for this.
function cancelRecipients(lobby) {
    const everyone = [
        ...(lobby.players || []),
        ...(lobby.maybes || []),
        ...(lobby.waitlist || [])
    ];

    // The host is never in this list. They are notified separately, and only when
    // somebody else cancelled their lobby - see notifyCancelled's notifyHost.
    return [...new Set(everyone)].filter(userId => userId !== lobby.hostId);
}

// Tells the people who signed up that a lobby is off. Posts one thread notice mentioning
// them all, then DMs each one.
//
// The thread mention is the notice that cannot fail; the DM is the courtesy on top, and a
// closed DM is never reported anywhere public - the same rule the nudges and waitlist
// promotions already follow.
// `notifyHost` is set when somebody other than the host ended their lobby - staff
// pressing Cancel, or the card being deleted. They get their own wording, since the
// shared copy ("nothing else is needed from you") is wrong for the person whose lobby it
// was, and they already know they did not cancel it themselves. `hostReason` lets that
// message name the real cause rather than the hedged "host or staff" wording members see.
//
// It is deliberately NOT set when the host leaves the server: they are gone, and they did
// not need telling about a consequence of their own departure.
async function notifyCancelled(guildId, lobby, reason, { notifyHost = false, hostReason = null } = {}) {
    const recipients = cancelRecipients(lobby);
    const mentioned = notifyHost ? [lobby.hostId, ...recipients] : recipients;

    try {
        const mentions = mentioned.length > 0 ? render.mentionList(mentioned) : '';
        await postToThread(guildId, lobby, copy.cancelledThreadNotice(mentions, reason));
    } catch (error) {
        console.error(`Could not post the cancellation notice for lobby ${lobby.id}:`, error.message);
    }

    if (mentioned.length === 0) return;

    let guildName = guildLabel(guildId);

    try {
        const guild = await resolveGuild(guildId);
        if (guild?.name) guildName = guild.name;
    } catch (error) {
        // Fall back to the label.
    }

    const gameLabel = games.escapeLabel(lobby.gameLabel);
    const startsAtSeconds = Math.floor(lobby.startsAt / 1000);

    if (notifyHost) {
        await dmUser(lobby.hostId, copy.cancelledHostDm(
            gameLabel,
            guildName,
            hostReason || reason,
            startsAtSeconds
        ));
    }

    const message = copy.cancelledDm(gameLabel, guildName, reason, startsAtSeconds);

    for (const userId of recipients) {
        await dmUser(userId, message);
    }
}

async function dmUser(userId, payload) {
    try {
        const user = await require('../client').users.fetch(userId);
        await user.send(payload);
        return true;
    } catch (error) {
        return false;
    }
}

// ---------------------------------------------------------------------------
// Button router
// ---------------------------------------------------------------------------

async function handleLobbyButton(interaction) {
    const [, action, arg] = interaction.customId.split(':');

    // Availability-panel buttons carry no lobby id.
    if (action === 'av') return handleAvailabilityButton(interaction, arg);
    if (action === 'nc') return handleNewcomerButton(interaction, arg);
    if (action === 'crewleave') return handleCrewLeave(interaction, arg);

    const found = resolveLobby(interaction, arg);
    if (!found) return interaction.reply(ephemeral(copy.lobbyStale));

    const { guildId, lobby } = found;
    const userId = interaction.user.id;

    const blocked = lockReason(lobby, action);
    if (blocked) return interaction.reply(ephemeral(blocked));

    switch (action) {
        case 'join': return handleJoin(interaction, guildId, lobby, userId);
        case 'maybe': return handleMaybe(interaction, guildId, lobby, userId);
        case 'leave': return handleLeave(interaction, guildId, lobby, userId);
        case 'yes': return handleStillIn(interaction, lobby, userId);
        case 'tags': return handleShowTags(interaction, guildId, lobby, userId);
        case 'edit': return handleEditOpen(interaction, guildId, lobby, userId);
        case 'crossplay': return handleCrossplayToggle(interaction, guildId, lobby, userId);
        case 'template': return handleSaveTemplate(interaction, guildId, lobby, userId);
        case 'cancel': return handleCancel(interaction, guildId, lobby, userId);
        case 'runanyway': return handleRunAnyway(interaction, guildId, lobby, userId);
        case 'again': return handlePlayAgain(interaction, guildId, lobby, userId);
        case 'attconfirm': return handleAttendanceConfirm(interaction, guildId, lobby, userId);
        default: return interaction.reply(ephemeral(copy.lobbyStale));
    }
}

async function handleJoin(interaction, guildId, lobby, userId) {
    const profile = state.getProfile(guildId, userId);

    // Synchronous from here to the state change: no await between the seat check and
    // the push, so two simultaneous presses cannot both take the last seat.
    const result = state.joinLobby(lobby, userId, { platformOk: platformAllows(lobby, profile) });

    if (!result.ok) {
        const message = {
            closed: copy.lobbyStale,
            already: copy.lobbyAlreadyIn,
            platform: copy.lobbyPlatformMismatch
        }[result.result] || copy.lobbyStale;

        return interaction.reply(ephemeral(message));
    }

    if (result.result === 'joined') state.noteFilled(lobby);

    const hint = profile ? '' : `\n${copy.lobbyNoProfileHint}`;
    await interaction.reply(ephemeral(`${result.result === 'joined' ? copy.lobbyJoined : copy.lobbyFull}${hint}`));

    void refreshCard(guildId, lobby);
    return undefined;
}

async function handleMaybe(interaction, guildId, lobby, userId) {
    const result = state.maybeLobby(lobby, userId);

    if (!result.ok) {
        return interaction.reply(ephemeral(result.result === 'already' ? copy.lobbyMaybe : copy.lobbyStale));
    }

    await interaction.reply(ephemeral(copy.lobbyMaybe));
    void refreshCard(guildId, lobby);
    return undefined;
}

async function handleLeave(interaction, guildId, lobby, userId) {
    const result = state.leaveLobby(lobby, userId);
    if (!result.ok) return interaction.reply(ephemeral(copy.lobbyNotIn));

    await interaction.reply(ephemeral(copy.lobbyLeft));

    if (result.promoted) {
        // Thread mention first, because it is the notice that cannot fail. The DM is a
        // courtesy on top, and a closed DM is not reported anywhere public.
        void postToThread(guildId, lobby, `${render.mention(result.promoted)} a seat opened up and you are in.`);
        void dmUser(result.promoted, `${copy.lobbyPromoted} **${games.escapeLabel(lobby.gameLabel)}** starts <t:${Math.floor(lobby.startsAt / 1000)}:R>.`);
    }

    void refreshCard(guildId, lobby);
    return undefined;
}

// The "still in?" stage was removed, so nothing posts this prompt any more. The handler
// stays so that a press on one already sitting in a live thread gets a sensible answer
// rather than falling through to "this lobby has ended".
async function handleStillIn(interaction, lobby, userId) {
    if (!lobby.players.includes(userId)) return interaction.reply(ephemeral(copy.lobbyNotIn));

    return interaction.reply(ephemeral('Good to know, you are still counted.'));
}

async function handleShowTags(interaction, guildId, lobby, userId) {
    if (!lobby.players.includes(userId)) return interaction.reply(ephemeral(copy.lobbyTagsNotParticipant));

    const platform = lobby.platform;
    const lines = [];

    for (const participantId of lobby.players) {
        const profile = state.getProfile(guildId, participantId);
        const tags = profile?.tags || {};
        // The lobby's own platform first, then anything else they saved.
        const tag = (platform && tags[platform]) || tags.other || Object.values(tags).find(Boolean);

        if (tag) lines.push(`${render.mention(participantId)} — \`${String(tag).slice(0, 80)}\``);
    }

    if (lines.length === 0) {
        return interaction.reply(ephemeral(`${copy.lobbyNoTags}\nYou can also check the gamer ID forum.`));
    }

    return interaction.reply(ephemeral(`**Gamertags for this lobby**\n${lines.join('\n')}`));
}

async function handleEditOpen(interaction, guildId, lobby, userId) {
    if (!await isHostOrStaff(guildId, lobby, userId)) return interaction.reply(ephemeral(copy.lobbyHostOnly));

    const modal = new ModalBuilder()
        .setCustomId(`lobby:mod:edit:${lobby.id}`)
        .setTitle(`Edit lobby #${lobby.number}`.slice(0, 45))
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('seats')
                    .setLabel(`Seats (${LOBBY_MIN_SEATS}-${LOBBY_MAX_SEATS})`)
                    .setStyle(TextInputStyle.Short)
                    .setValue(String(lobby.seats))
                    .setRequired(true)
                    .setMaxLength(2)),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('note')
                    .setLabel('Note')
                    .setStyle(TextInputStyle.Paragraph)
                    .setValue(lobby.note || '')
                    .setRequired(false)
                    .setMaxLength(140))
        );

    return interaction.showModal(modal);
}

async function handleCrossplayToggle(interaction, guildId, lobby, userId) {
    if (!await isHostOrStaff(guildId, lobby, userId)) return interaction.reply(ephemeral(copy.lobbyHostOnly));

    lobby.crossplay = !lobby.crossplay;
    state.markDirty();

    await interaction.reply(ephemeral(`Crossplay is now **${lobby.crossplay ? 'on' : 'off'}**. Players already seated keep their seats.`));

    void postToThread(guildId, lobby, `Crossplay turned **${lobby.crossplay ? 'on' : 'off'}** by the host. This applies to new joins only.`);
    void refreshCard(guildId, lobby);
    return undefined;
}

async function handleSaveTemplate(interaction, guildId, lobby, userId) {
    if (!await isHostOrStaff(guildId, lobby, userId)) return interaction.reply(ephemeral(copy.lobbyHostOnly));

    const modal = new ModalBuilder()
        .setCustomId(`lobby:mod:template:${lobby.id}`)
        .setTitle('Save as template')
        .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('name')
                .setLabel('Template name')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('e.g. Friday squad')
                .setRequired(true)
                .setMaxLength(40)));

    return interaction.showModal(modal);
}

async function handleCancel(interaction, guildId, lobby, userId) {
    if (!await isHostOrStaff(guildId, lobby, userId)) return interaction.reply(ephemeral(copy.lobbyHostOnly));
    if (lobby.status !== 'open' && lobby.status !== 'live') return interaction.reply(ephemeral(copy.lobbyStale));

    // Staff can cancel somebody else's lobby, in which case the host is told too.
    const byStaff = userId !== lobby.hostId;
    const notifying = cancelRecipients(lobby).length + (byStaff ? 1 : 0);

    state.setLobbyStatus(lobby, 'cancelled');

    await interaction.reply(ephemeral(
        notifying > 0
            ? `${copy.lobbyCancelled} ${notifying} ${notifying === 1 ? 'person has' : 'people have'} been told`
                + `${byStaff ? ', including the host' : ''}.`
            : copy.lobbyCancelled));

    // Mutate, acknowledge, then notify, so a slow set of DMs cannot time the press out.
    void notifyCancelled(guildId, lobby, copy.cancelReasonHost, {
        notifyHost: byStaff,
        hostReason: copy.cancelReasonStaff
    });
    void refreshCard(guildId, lobby);
    return undefined;
}

async function handleRunAnyway(interaction, guildId, lobby, userId) {
    if (!await isHostOrStaff(guildId, lobby, userId)) return interaction.reply(ephemeral(copy.lobbyHostOnly));

    lobby.minPlayers = null;
    state.markDirty();

    await interaction.reply(ephemeral('Running it. The minimum player count has been cleared for this lobby.'));
    void refreshCard(guildId, lobby);
    return undefined;
}

async function handlePlayAgain(interaction, guildId, lobby, userId) {
    if (lobby.againClosesAt && Date.now() > lobby.againClosesAt) {
        return interaction.reply(ephemeral('That window has closed.'));
    }
    if (!crews.canVote(lobby, userId)) {
        return interaction.reply(ephemeral('Only people who were in this lobby can press that.'));
    }
    if (lobby.againVotes.includes(userId)) {
        return interaction.reply(ephemeral('You have already pressed that.'));
    }

    lobby.againVotes.push(userId);
    state.markDirty();

    await interaction.reply(ephemeral('Noted. If someone else wants another round too, a crew gets created.'));

    const guild = state.guildState(guildId);
    const counts = crews.countCrewsByMember(guild.crews);
    const verdict = crews.evaluateCrewFormation(lobby, guild.crews, counts);

    if (verdict.shouldCreate) {
        const crew = state.createCrew(guildId, {
            name: crews.crewName(lobby.gameLabel),
            gameKey: lobby.gameKey,
            gameLabel: lobby.gameLabel,
            platform: lobby.platform,
            members: verdict.members
        });

        void postToThread(guildId, lobby,
            `**${games.escapeLabel(crew.name)}** ${copy.crewFormed}: ${render.mentionList(crew.members)}\n`
            + 'Any of you can start a lobby for it with `/lobby create crew:` and the rest get pinged.');
    }

    return undefined;
}

async function handleAttendanceConfirm(interaction, guildId, lobby, userId) {
    if (!await isHostOrStaff(guildId, lobby, userId)) return interaction.reply(ephemeral(copy.lobbyHostOnly));

    lobby.attendance.source = 'host';
    lobby.attendance.confirmedAt = Date.now();
    state.snapshotResult(lobby);

    // Mutate, acknowledge, then edit - the same order the rest of the module uses, so a
    // slow set of edits can never make the press time out.
    await interaction.reply(ephemeral(
        `Recorded ${lobby.attendance.showed.length} of ${lobby.players.length} as showing up.`
        + ' This lobby is now closed and its buttons are greyed out.'));

    void lockLobbyUi(guildId, lobby);
    return undefined;
}

// ---------------------------------------------------------------------------
// Availability panel buttons
// ---------------------------------------------------------------------------

async function handleAvailabilityButton(interaction, which) {
    // The panel only exists in a guild, except the nudges-off button which also arrives
    // from a nudge DM.
    if (which === 'nudgesoff') {
        const guildIds = require('./guilds').configuredLobbyGuildIds();
        let changed = false;

        for (const guildId of guildIds) {
            const profile = state.getProfile(guildId, interaction.user.id);
            if (profile?.nudges) {
                state.updateProfile(guildId, interaction.user.id, { nudges: false });
                changed = true;
            }
        }

        return interaction.reply(ephemeral(changed ? copy.nudgesOff : 'Nudges are already off.'));
    }

    const guildId = interaction.guildId;
    if (!guildId || !lobbyConfigFor(guildId)) return interaction.reply(ephemeral(copy.lobbyStale));

    if (which === 'done') {
        return interaction.update({ content: copy.availabilitySaved, embeds: [], components: [] });
    }

    if (which === 'nudges') {
        const profile = state.ensureProfile(guildId, interaction.user.id);
        state.updateProfile(guildId, interaction.user.id, { nudges: !profile.nudges });

        return rerenderPanel(interaction, guildId);
    }

    if (which === 'addgame') {
        const modal = new ModalBuilder()
            .setCustomId('lobby:mod:addgame')
            .setTitle(copy.addGameTitle)
            .addComponents(new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('title')
                    .setLabel(copy.addGameLabel)
                    .setStyle(TextInputStyle.Short)
                    .setPlaceholder(copy.addGamePlaceholder)
                    .setRequired(true)
                    .setMinLength(games.MIN_LABEL_LENGTH)
                    .setMaxLength(games.MAX_LABEL_LENGTH)));

        return interaction.showModal(modal);
    }

    if (which === 'tags') {
        return interaction.showModal(buildTagsModal(guildId, interaction.user.id));
    }

    return interaction.reply(ephemeral(copy.lobbyStale));
}

// Shared by every panel interaction, so the panel always re-renders from stored state
// rather than from whatever the last click happened to know.
function buildPanel(guildId, userId) {
    const profile = state.ensureProfile(guildId, userId);
    const guild = state.guildState(guildId);

    const options = games.gameSelectOptions(guild.games, {
        userId,
        minSubmitters: LOBBY_GAME_MIN_SUBMITTERS,
        selected: profile.games || []
    });

    return render.availabilityPanel(profile, options, { zoneMissing: !profile.tz });
}

async function rerenderPanel(interaction, guildId) {
    const payload = buildPanel(guildId, interaction.user.id);
    return interaction.update({ ...payload, content: '' });
}

async function handleNewcomerButton(interaction, guildId) {
    if (!lobbyConfigFor(guildId)) return interaction.reply(ephemeral(copy.lobbyStale));

    // Arrives from a DM, so the panel is sent as a fresh ephemeral-style DM reply.
    const payload = buildPanel(guildId, interaction.user.id);
    return interaction.reply({ ...payload });
}

async function handleCrewLeave(interaction, crewId) {
    const guildIds = require('./guilds').configuredLobbyGuildIds();

    for (const guildId of guildIds) {
        const result = state.removeFromCrew(guildId, crewId, interaction.user.id);
        if (result.ok) return interaction.reply(ephemeral(copy.crewLeft));
    }

    return interaction.reply(ephemeral('You are not in that crew.'));
}

// ---------------------------------------------------------------------------
// Select menus
// ---------------------------------------------------------------------------

async function handleLobbySelect(interaction) {
    const [, kind, arg] = interaction.customId.split(':');

    if (kind === 'att') {
        const found = resolveLobby(interaction, arg);
        if (!found) return interaction.reply(ephemeral(copy.lobbyStale));

        const { guildId, lobby } = found;

        const blocked = lockReason(lobby, 'att');
        if (blocked) return interaction.reply(ephemeral(blocked));

        if (!await isHostOrStaff(guildId, lobby, interaction.user.id)) {
            return interaction.reply(ephemeral(copy.lobbyHostOnly));
        }

        // Stored as a draft; nothing is final until Confirm.
        lobby.attendance.showed = interaction.values.filter(userId => lobby.players.includes(userId));
        state.markDirty();

        return interaction.deferUpdate();
    }

    if (kind !== 'sel') return interaction.reply(ephemeral(copy.lobbyStale));

    const guildId = interaction.guildId;
    if (!guildId || !lobbyConfigFor(guildId)) return interaction.reply(ephemeral(copy.lobbyStale));

    const userId = interaction.user.id;
    const field = arg;

    if (field === 'weekday' || field === 'weekend') {
        state.updateProfile(guildId, userId, { [field]: interaction.values });
    } else if (field === 'platforms') {
        state.updateProfile(guildId, userId, { platforms: interaction.values });
    } else if (field === 'games') {
        const profile = state.ensureProfile(guildId, userId);
        const guild = state.guildState(guildId);

        // The select can only show 25 options, so anything of theirs that was not shown
        // has to be merged back in or saving would silently drop it.
        const shown = new Set(games.gameSelectOptions(guild.games, {
            userId,
            minSubmitters: LOBBY_GAME_MIN_SUBMITTERS,
            selected: profile.games || []
        }).map(option => option.value));

        const hidden = (profile.games || []).filter(key => !shown.has(key));
        const merged = [...new Set([...interaction.values, ...hidden])].slice(0, LOBBY_MAX_GAMES_PER_PROFILE);

        // Deselecting a game gives up being one of its submitters.
        for (const key of profile.games || []) {
            if (!merged.includes(key)) state.removeGameSubmitter(guildId, key, userId);
        }
        for (const key of merged) {
            if (guild.games[key]) state.registerGame(guildId, key, guild.games[key].label, userId);
        }

        state.updateProfile(guildId, userId, { games: merged });
    } else {
        return interaction.reply(ephemeral(copy.lobbyStale));
    }

    return rerenderPanel(interaction, guildId);
}

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------

async function handleLobbyModal(interaction) {
    const [, , kind, arg] = interaction.customId.split(':');

    if (kind === 'addgame') return handleAddGameModal(interaction);
    if (kind === 'tags') return handleTagsModal(interaction);
    if (kind === 'edit') return handleEditModal(interaction, arg);
    if (kind === 'template') return handleTemplateModal(interaction, arg);

    return interaction.reply(ephemeral(copy.lobbyStale));
}

async function handleAddGameModal(interaction) {
    const guildId = interaction.guildId;
    if (!guildId || !lobbyConfigFor(guildId)) return interaction.reply(ephemeral(copy.lobbyStale));

    const userId = interaction.user.id;
    const guild = state.guildState(guildId);
    const check = games.validateGameTitle(interaction.fields.getTextInputValue('title'), guild.blockedGames);

    if (!check.ok) {
        return interaction.reply(ephemeral(check.reason === 'blocked' ? copy.gameBlocked : copy.gameRejected));
    }

    const profile = state.ensureProfile(guildId, userId);

    if ((profile.games || []).length >= LOBBY_MAX_GAMES_PER_PROFILE && !profile.games.includes(check.key)) {
        return interaction.reply(ephemeral(copy.gameProfileFull));
    }

    state.registerGame(guildId, check.key, check.label, userId);

    if (!profile.games.includes(check.key)) {
        state.updateProfile(guildId, userId, { games: [...profile.games, check.key] });
    }

    // Re-renders the panel underneath, so the new game appears ticked straight away.
    await interaction.reply(ephemeral(`${copy.gameAddedToProfile} **${games.escapeLabel(check.label)}**. Reopen \`/lfg-profile set\` to see it in the list.`));
    return undefined;
}

async function handleTagsModal(interaction) {
    const guildId = interaction.guildId;
    if (!guildId || !lobbyConfigFor(guildId)) return interaction.reply(ephemeral(copy.lobbyStale));

    const tags = {};
    for (const id of ['steam', 'playstation', 'xbox', 'epic', 'other']) {
        const value = (interaction.fields.getTextInputValue(id) || '').trim();
        if (value) tags[id] = value.slice(0, 60);
    }

    state.updateProfile(guildId, interaction.user.id, { tags });
    return interaction.reply(ephemeral(copy.tagsSaved));
}

async function handleEditModal(interaction, lobbyId) {
    const found = resolveLobby(interaction, lobbyId);
    if (!found) return interaction.reply(ephemeral(copy.lobbyStale));

    const { guildId, lobby } = found;

    // A modal opened just before the lock landed can still be submitted after it.
    const blocked = lockReason(lobby, 'edit');
    if (blocked) return interaction.reply(ephemeral(blocked));

    if (!await isHostOrStaff(guildId, lobby, interaction.user.id)) {
        return interaction.reply(ephemeral(copy.lobbyHostOnly));
    }

    const seatsRaw = Number(interaction.fields.getTextInputValue('seats'));
    const note = (interaction.fields.getTextInputValue('note') || '').trim().slice(0, 140);

    if (!Number.isInteger(seatsRaw) || seatsRaw < LOBBY_MIN_SEATS || seatsRaw > LOBBY_MAX_SEATS) {
        return interaction.reply(ephemeral(`Seats must be a whole number between ${LOBBY_MIN_SEATS} and ${LOBBY_MAX_SEATS}.`));
    }

    const result = state.setSeats(lobby, seatsRaw);
    if (!result.ok) return interaction.reply(ephemeral(copy.lobbySeatsBelowConfirmed));

    lobby.note = note;
    state.markDirty();

    await interaction.reply(ephemeral('Lobby updated.'));
    void refreshCard(guildId, lobby);
    return undefined;
}

async function handleTemplateModal(interaction, lobbyId) {
    const found = resolveLobby(interaction, lobbyId);
    if (!found) return interaction.reply(ephemeral(copy.lobbyStale));

    const { guildId, lobby } = found;

    const blocked = lockReason(lobby, 'template');
    if (blocked) return interaction.reply(ephemeral(blocked));

    const name = (interaction.fields.getTextInputValue('name') || '').trim().slice(0, 40);
    if (!name) return interaction.reply(ephemeral('Give the template a name.'));

    const result = state.saveTemplate(guildId, interaction.user.id, name, {
        gameKey: lobby.gameKey,
        gameLabel: lobby.gameLabel,
        platform: lobby.platform,
        crossplay: lobby.crossplay,
        seats: lobby.seats,
        minPlayers: lobby.minPlayers,
        length: lobby.length,
        venue: state.venueOf(lobby),
        voiceChannelId: lobby.voiceChannelId,
        note: lobby.note
    }, LOBBY_MAX_TEMPLATES_PER_HOST);

    if (!result.ok) return interaction.reply(ephemeral(copy.templateCapReached));

    return interaction.reply(ephemeral(`${copy.templateSaved} Use it with \`/lobby create template:${name}\`.`));
}

module.exports = {
    isLobbyComponent,
    notifyCancelled,
    cancelRecipients,
    lockReason,
    lockLobbyUi,
    trackPrompt,
    LOCK_EXEMPT_ACTIONS,
    POST_GAME_ACTIONS,
    buildTagsModal,
    handleLobbyButton,
    handleLobbySelect,
    handleLobbyModal,
    buildPanel,
    refreshCard,
    postToThread,
    dmUser,
    fetchMember,
    isHostOrStaff,
    platformAllows,
    resolveLobby,
    LOBBY_AGAIN_WINDOW_HOURS,
};
