// ---------------------------------------------------------------------------
// Feature E: Vice Radar (presence-based squad matching)
// ---------------------------------------------------------------------------

const {
    ActionRowBuilder,
    ActivityType,
    ApplicationCommandOptionType,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags
} = require('discord.js');
const { SERVER_CONFIGS, LOG_COLORS } = require('../config');
const { sendStaffLog, errorField } = require('../staff-log');
const client = require('../client');
const { resolveGuild, canManageRole, guildLabel, respondWithError } = require('../utils');
const { pickPhrase } = require('./phrase-bank');

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

// guildId -> Map<gameName, entry>, where each entry tracks the DM and public sides
// independently - see applyRadarPresence for the shape, evaluateRadarGame for why.
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
            // The DM and public sides each carry their own fired-flag and debounce timer,
            // because a count of exactly 2 must arm the DM state while leaving the public
            // state unfired. One shared triple only worked while they shared a threshold.
            entry = {
                activeMembers: new Set(),
                dmSent: false,
                dmResetTimer: null,
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
                    currentGames.delete(gameName);
                } else if (currentEntry.activeMembers.size < RADAR_DM_MIN_SQUAD) {
                    // Still short after the full grace period, so the session really ended.
                    // Keep the roster - the next person to start this game has to be able
                    // to see who's already on it - but forget the streak.
                    currentEntry.dmSent = false;
                }
                // else: recovered while this timer was pending; the recovery already
                // cancelled it, so this is a safe no-op if the timing overlaps.
            }, RADAR_RESET_GRACE_MS);
        }

        return;
    }

    // Back at or above threshold: cancel any pending reset from a brief dip.
    if (entry.dmResetTimer) {
        clearTimeout(entry.dmResetTimer);
        entry.dmResetTimer = null;
    }

    if (!entry.dmSent) {
        // Set before awaiting: presence events keep arriving while the DMs go out, and a
        // re-entrant call here would otherwise DM the same squad twice.
        entry.dmSent = true;

        const memberIds = [...entry.activeMembers];
        await dmRadarSquad(guildId, gameName, memberIds, count);
    }

    // No growth-retrigger for DMs: once an opted-in member has been told about a match, a
    // third or fourth person joining doesn't earn them a second DM.
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

// One DM per opted-in member, once per streak. The public callout goes out for everyone
// who was counted; only the DM is gated on the Radar role, and it's filtered here at send
// time rather than upstream so non-opted-in players still count toward the match.
//
// When at least one other person in the match is also opted in, the DM names them with a
// clickable mention so the recipient can go say hi. When the recipient is the only
// opted-in person in the match there's nobody to name, so it stays the plain
// total-headcount version.
async function dmRadarSquad(guildId, gameName, memberIds, totalCount) {
    const radar = radarConfigFor(guildId);
    if (!radar) return;

    const guild = await resolveGuild(guildId);
    if (!guild) return;

    // Fetched once up front so the per-recipient loop below just filters an
    // already-resolved list instead of re-fetching the same members for each of them.
    const fetched = await Promise.all(
        memberIds.map(id => guild.members.fetch(id).catch(() => null))
    );
    const matched = fetched
        .filter(Boolean)
        .map(member => ({ member, optedIn: member.roles.cache.has(radar.roleId) }));

    for (const { member, optedIn } of matched) {
        if (!optedIn) continue;

        const otherOptedIn = matched.filter(m => m.optedIn && m.member.id !== member.id);

        if (otherOptedIn.length > 0) {
            await sendConnectDm(guild, member, gameName, otherOptedIn.map(m => m.member), totalCount);
        } else {
            await sendPlainRadarDm(guild, member, gameName, totalCount);
        }
    }
}

// Fallback DM: nobody else in the match is opted in, so there's no one to introduce and
// this stays the total-headcount line it has always been.
async function sendPlainRadarDm(guild, member, gameName, totalCount) {
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

// Enhanced DM: styled like the public callout, naming the other opted-in player(s).
//
// A mention inside a DM does not notify the person mentioned - they aren't in this DM
// channel - it just renders as a clickable chip that opens their profile card, which is
// what stands in for a profile link here since Discord has no separate profile-URL
// scheme. The buttons point at the same place and are the easier tap target on mobile.
async function sendConnectDm(guild, member, gameName, others, totalCount) {
    const mentionList = others.map(m => `<@${m.id}>`).join(', ');
    const alsoOnRadarLine = others.length === 1
        ? `<@${others[0].id}> is also on Vice Radar`
        : `${mentionList} are also on Vice Radar`;

    // The rest of the match who aren't on Radar, so the recipient still knows the real
    // size of it and not just the subset they can go talk to.
    const remainder = totalCount - 1 - others.length;
    const remainderLine = remainder > 0
        ? `\n(${remainder} more ${remainder === 1 ? 'person is' : 'people are'} in this match too, not yet on Vice Radar.)`
        : '';

    // Picked at random rather than from the public rotation, so a DM never consumes a
    // turn in the sequence the channel posts step through.
    const iconURL = radarIconURL();
    const embed = new EmbedBuilder()
        .setColor(RADAR_COLORS[Math.floor(Math.random() * RADAR_COLORS.length)])
        .setAuthor({ name: iconURL ? RADAR_BRAND_NAME : `${RADAR_BRAND_NAME} 🌴` })
        .setDescription(
            `## Squad up on ${gameName}\n` +
            `${alsoOnRadarLine} and playing **${gameName}** right now in **${guild.name}**.${remainderLine}\n\n` +
            `Say hi and jump in together. 🌴`
        );

    if (iconURL) {
        embed.setThumbnail(iconURL);
    }

    // One link button per other opted-in player, capped at Discord's 5-per-row limit. A
    // link button hands the URL straight to the client and never calls back to the bot,
    // so there's no interaction handler to add and nothing to track. Anyone past the cap
    // is still named in the embed text, just without their own button.
    const connectButtons = others.slice(0, 5).map(other =>
        new ButtonBuilder()
            .setLabel(`Message ${other.displayName}`)
            .setStyle(ButtonStyle.Link)
            .setURL(`https://discord.com/users/${other.id}`)
    );
    const components = connectButtons.length > 0
        ? [new ActionRowBuilder().addComponents(connectButtons)]
        : [];

    try {
        await member.send({ embeds: [embed], components });
    } catch (dmError) {
        console.log(`Could not send Vice Radar connect DM to ${member.user.tag}`);
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
