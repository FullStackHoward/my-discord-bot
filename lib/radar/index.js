// ---------------------------------------------------------------------------
// Feature E: Vice Radar (presence-based squad matching)
// ---------------------------------------------------------------------------

const { ActivityType, ApplicationCommandOptionType, EmbedBuilder, MessageFlags } = require('discord.js');
const { SERVER_CONFIGS, LOG_COLORS } = require('../config');
const { sendStaffLog, errorField } = require('../staff-log');
const client = require('../client');
const { resolveGuild, canManageRole, guildLabel, respondWithError } = require('../utils');
const { pickPhrase } = require('./phrase-bank');

// Concurrent opted-in players before a game counts as a squad worth announcing.
const RADAR_MIN_SQUAD = 2;

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
const RADAR_ICON_EMOJI_NAME = '8bitradar';
const RADAR_BRAND_NAME = 'Vice Radar';

// Returns the emoji's image URL, or null if it has been renamed or deleted, so a
// missing emoji costs the icon rather than the whole post. Requests 128px because the
// thumbnail renders around 80px, well above the ~24px an author icon would have needed.
function radarIconURL() {
    const emoji = client.emojis.cache.find(e => e.name === RADAR_ICON_EMOJI_NAME);

    if (!emoji) {
        console.warn(`Vice Radar: no :${RADAR_ICON_EMOJI_NAME}: emoji found, posting without the radar icon`);
        return null;
    }

    return emoji.imageURL({ size: 128 });
}

// Rotated per post so consecutive embeds don't look identical. Deliberately separate
// from LOG_COLORS: those carry staff-log meaning, these are just brand colors.
const RADAR_COLORS = [0xFFB570, 0x2ED9C3, 0xE0A9E8];
let radarColorIndex = 0;

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

// guildId -> Map<gameName, { activeMembers: Set<userId>, peak: number, dmSent: boolean }>
// In-memory only, by design: presence rebuilds itself within seconds of a restart, so
// unlike the application sweep's multi-hour countdowns there's nothing worth persisting.
const radarState = new Map();

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

async function handlePresenceUpdate(newPresence) {
    try {
        const guildId = newPresence?.guild?.id;
        if (!guildId) return;

        const radar = radarConfigFor(guildId);
        if (!radar) return;

        const member = newPresence.member;
        if (!member || member.user.bot) return;

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
            entry = { activeMembers: new Set(), peak: 0, dmSent: false, resetTimer: null };
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

// Decides whether a game's current headcount is worth announcing. Runs after every
// change to that game's roster.
async function evaluateRadarGame(guildId, gameName) {
    const games = radarGamesFor(guildId);
    const entry = games.get(gameName);
    if (!entry) return;

    const count = entry.activeMembers.size;

    if (count < RADAR_MIN_SQUAD) {
        // Don't reset the instant the count dips. A member's activity can blink off for a
        // few seconds and come right back, and resetting on that made the same two people
        // re-announce as a brand new match. Schedule the reset instead, so a quick
        // recovery (below, in the at-or-above-threshold path) can cancel it.
        if (!entry.resetTimer) {
            entry.resetTimer = setTimeout(() => {
                const currentGames = radarGamesFor(guildId);
                const currentEntry = currentGames.get(gameName);
                if (!currentEntry) return;

                currentEntry.resetTimer = null;

                if (currentEntry.activeMembers.size === 0) {
                    // Nobody playing it at all: drop the entry so the map doesn't collect
                    // dead games.
                    currentGames.delete(gameName);
                } else if (currentEntry.activeMembers.size < RADAR_MIN_SQUAD) {
                    // Still short of a squad after the full grace period, so the session
                    // really did end. Keep the roster - the next person to start this game
                    // has to be able to see who's already on it - but forget the streak, so
                    // a rise back to 2+ counts as brand new.
                    currentEntry.peak = 0;
                    currentEntry.dmSent = false;
                }
                // else: recovered to threshold while this timer was pending. The recovering
                // presenceUpdate already cancelled it, so this shouldn't normally be
                // reached, but it's a safe no-op if the timing overlaps.
            }, RADAR_RESET_GRACE_MS);
        }

        return;
    }

    // Back at or above threshold: cancel any pending reset from a brief dip.
    if (entry.resetTimer) {
        clearTimeout(entry.resetTimer);
        entry.resetTimer = null;
    }

    const memberIds = [...entry.activeMembers];

    if (!entry.dmSent) {
        // Set both before awaiting: presence events keep arriving while the DMs go out,
        // and a re-entrant call here would otherwise DM the same squad twice.
        entry.dmSent = true;
        entry.peak = count;

        await dmRadarSquad(guildId, gameName, memberIds, count);
        await postRadarEmbed(guildId, gameName, count);
        return;
    }

    // Already announced this streak, so only a new high-water mark earns another post,
    // and never another round of DMs.
    if (count > entry.peak) {
        entry.peak = count;
        await postRadarEmbed(guildId, gameName, count);
    }
}

// One DM per opted-in member, once per streak. The public callout goes out for everyone
// who was counted; only the DM is gated on the Radar role, and it's filtered here at send
// time rather than upstream so non-opted-in players still count toward the match.
async function dmRadarSquad(guildId, gameName, memberIds, totalCount) {
    const radar = radarConfigFor(guildId);
    if (!radar) return;

    const guild = await resolveGuild(guildId);
    if (!guild) return;

    for (const userId of memberIds) {
        const member = await guild.members.fetch(userId).catch(() => null);
        if (!member) continue;
        if (!member.roles.cache.has(radar.roleId)) continue;

        // The full match size, not the opted-in subset, so "3 other Vicers are playing"
        // stays true even when only one of them is opted in to hear about it.
        const others = totalCount - 1;
        const othersText = others === 1 ? 'Another Vicer is' : `${others} other Vicers are`;

        try {
            await member.send(
                `🔔 **Vice Radar**\n\n` +
                `${othersText} playing **${gameName}** right now in **${guild.name}**.\n\n` +
                `Jump in and squad up. 🌴`
            );
        } catch (dmError) {
            // Closed DMs are normal, not a fault worth alerting staff about.
            console.log(`Could not send Vice Radar DM to ${member.user.tag}`);
        }
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

        const channel = await guild.channels.fetch(radar.channelId).catch(() => null);
        if (!channel || !channel.isTextBased()) {
            console.error(`Vice Radar channel ${radar.channelId} not found or not text-based in ${guild.name}`);
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
        const iconURL = radarIconURL();

        const embed = new EmbedBuilder()
            .setColor(RADAR_COLORS[radarColorIndex % RADAR_COLORS.length])
            .setAuthor({ name: iconURL ? RADAR_BRAND_NAME : `${RADAR_BRAND_NAME} 🌴` })
            .setDescription(`## ${pickPhrase(count, gameName)}\n${radarCta(radar)}`);

        if (iconURL) {
            embed.setThumbnail(iconURL);
        }

        radarColorIndex++;

        await channel.send({ embeds: [embed] });

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
    } catch (error) {
        console.error('Error clearing Vice Radar state on member leave:', error);
    }
}

// Deliberately no listener for losing the opt-in role: tracking is not tied to the role,
// so someone who opts out while playing stays counted toward the squad. The role only
// decides whether they get DM'd, and dmRadarSquad checks that at send time.

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
    dmRadarSquad,
    postRadarEmbed,
    handleGuildMemberRemove,
    handleViceRadarCommand,
};
