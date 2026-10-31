// ---------------------------------------------------------------------------
// /radar-digest-preview and /radar-games
// ---------------------------------------------------------------------------
//
// Both owner only, through the same VICER_ADMIN check /purge and the gamer ID sweep
// use. The preview exists so the alias and exclude lists can be curated against real
// data before a post goes out; it writes nothing and marks no week as handled.

const { ApplicationCommandOptionType, MessageFlags, PermissionFlagsBits } = require('discord.js');
const { LOBBY_TZ } = require('../../config');
const activity = require('../../activity');
const time = require('../../lobby/time');
const digest = require('./digest');
const gamesConfig = require('./games-config');
const gameDigest = require('./index');

const DIGEST_PREVIEW_COMMAND = {
    name: 'radar-digest-preview',
    description: 'Preview the weekly top 5 games for the last 7 days without posting (owner only)',
    defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
    options: []
};

const stringOption = (name, description) => ({
    name,
    description,
    type: ApplicationCommandOptionType.String,
    required: true
});

const RADAR_GAMES_COMMAND = {
    name: 'radar-games',
    description: 'Curate how the weekly digest groups and ignores games (owner only)',
    defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
    options: [
        {
            name: 'alias',
            description: 'Merge several reported names into one entry',
            type: ApplicationCommandOptionType.SubcommandGroup,
            options: [
                {
                    name: 'add',
                    description: 'Point a reported key at a grouped entry',
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        stringOption('match', 'The reported key, e.g. name:gta v or app:123456789'),
                        stringOption('key', 'The grouped key everything collapses to, e.g. game:gta'),
                        stringOption('name', 'What the digest prints, e.g. Grand Theft Auto')
                    ]
                },
                {
                    name: 'remove',
                    description: 'Stop mapping a reported key',
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [stringOption('match', 'The reported key to unmap')]
                },
                { name: 'list', description: 'Show every alias', type: ApplicationCommandOptionType.Subcommand }
            ]
        },
        {
            name: 'exclude',
            description: 'Ignore an app that reports as Playing but is not a game',
            type: ApplicationCommandOptionType.SubcommandGroup,
            options: [
                {
                    name: 'add',
                    description: 'Ignore a reported key',
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [stringOption('key', 'The reported key, e.g. name:visual studio code')]
                },
                {
                    name: 'remove',
                    description: 'Stop ignoring a reported key',
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [stringOption('key', 'The reported key to stop ignoring')]
                },
                { name: 'list', description: 'Show every exclude', type: ApplicationCommandOptionType.Subcommand }
            ]
        }
    ]
};

function ephemeral(content) {
    return { content, flags: MessageFlags.Ephemeral };
}

async function refuseStranger(interaction) {
    await interaction.reply(ephemeral('❌ This command is owner only.'));
    console.warn(`Unauthorized ${interaction.commandName} attempt by ${interaction.user.tag} (${interaction.user.id})`);
}

const DAY_MS = 24 * 60 * 60 * 1000;

function describeWindow(startMs, endMs) {
    const stamp = ms => `<t:${Math.floor(ms / 1000)}:f>`;
    return `${stamp(startMs)} to ${stamp(endMs)}`;
}

async function handleDigestPreview(interaction) {
    if (!activity.isActivityOwner(interaction.user.id)) return refuseStranger(interaction);

    if (!gameDigest.isDigestGuild(interaction.guildId)) {
        return interaction.reply(ephemeral('The weekly game digest does not run in this server.'));
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const now = Date.now();
    // The last seven days up to now, rather than the scheduled window, so a preview run
    // on a Wednesday shows what is actually being collected.
    const report = gameDigest.buildReport(interaction.guildId, now, { windowStartMs: now - 7 * DAY_MS });
    const embed = await gameDigest.digestEmbedFor(interaction.guildId, report);

    const notes = [
        `**Preview only.** Nothing was posted and no week was recorded.`,
        `Window: ${describeWindow(report.windowStart, report.windowEnd)}`,
        `${report.qualifyingGames} game(s) qualified; ${report.belowPlayerFloor} were held back by the ${digest.MIN_UNIQUE_PLAYERS}-player rule.`
    ];

    if (report.unmapped.length > 0) {
        notes.push(
            '',
            'Not yet grouped by an alias, most played first:',
            ...report.unmapped.map(entry => `\`${entry.key}\` (${entry.players} player${entry.players === 1 ? '' : 's'})`)
        );
    }

    const nextPost = digest.nextPostAfter(now, LOBBY_TZ);
    if (nextPost) notes.push('', `Next scheduled post: <t:${Math.floor(nextPost / 1000)}:F>`);

    return interaction.editReply({ content: notes.join('\n').slice(0, 2000), embeds: [embed] });
}

function normalizeKeyInput(value) {
    return String(value || '').trim().toLowerCase();
}

async function handleRadarGames(interaction) {
    if (!activity.isActivityOwner(interaction.user.id)) return refuseStranger(interaction);

    const group = interaction.options.getSubcommandGroup();
    const action = interaction.options.getSubcommand();
    const config = gamesConfig.loadGameConfig();

    if (group === 'alias' && action === 'list') {
        if (config.aliases.length === 0) return interaction.reply(ephemeral('No aliases are set.'));

        const lines = config.aliases.map(entry =>
            `**${entry.name}** (\`${entry.key}\`)\n${entry.match.map(m => `· \`${m}\``).join('\n')}`);

        return interaction.reply(ephemeral(lines.join('\n').slice(0, 1900)));
    }

    if (group === 'exclude' && action === 'list') {
        if (config.excludes.length === 0) return interaction.reply(ephemeral('Nothing is excluded.'));

        return interaction.reply(ephemeral(config.excludes.map(key => `· \`${key}\``).join('\n').slice(0, 1900)));
    }

    if (group === 'alias' && action === 'add') {
        const match = normalizeKeyInput(interaction.options.getString('match'));
        const key = normalizeKeyInput(interaction.options.getString('key'));
        const name = String(interaction.options.getString('name')).trim();

        gamesConfig.mutateGameConfig(next => {
            // One reported key maps to exactly one entry, so adding it again moves it
            // rather than leaving it in two places.
            for (const entry of next.aliases) entry.match = entry.match.filter(existing => existing !== match);

            const target = next.aliases.find(entry => entry.key === key);
            if (target) {
                target.name = name;
                target.match.push(match);
            } else {
                next.aliases.push({ key, name, match: [match] });
            }

            next.aliases = next.aliases.filter(entry => entry.match.length > 0);
        });

        return interaction.reply(ephemeral(`\`${match}\` now counts as **${name}** (\`${key}\`). It applies to the next sample.`));
    }

    if (group === 'alias' && action === 'remove') {
        const match = normalizeKeyInput(interaction.options.getString('match'));
        let removed = false;

        gamesConfig.mutateGameConfig(next => {
            for (const entry of next.aliases) {
                const before = entry.match.length;
                entry.match = entry.match.filter(existing => existing !== match);
                if (entry.match.length !== before) removed = true;
            }

            next.aliases = next.aliases.filter(entry => entry.match.length > 0);
        });

        return interaction.reply(ephemeral(removed
            ? `\`${match}\` is no longer aliased.`
            : `\`${match}\` was not aliased, so nothing changed.`));
    }

    if (group === 'exclude' && action === 'add') {
        const key = normalizeKeyInput(interaction.options.getString('key'));

        gamesConfig.mutateGameConfig(next => {
            if (!next.excludes.includes(key)) next.excludes.push(key);
        });

        return interaction.reply(ephemeral(`\`${key}\` will be ignored from the next sample. Time already credited to it stays until those buckets age out.`));
    }

    if (group === 'exclude' && action === 'remove') {
        const key = normalizeKeyInput(interaction.options.getString('key'));
        let removed = false;

        gamesConfig.mutateGameConfig(next => {
            const before = next.excludes.length;
            next.excludes = next.excludes.filter(existing => existing !== key);
            removed = next.excludes.length !== before;
        });

        return interaction.reply(ephemeral(removed
            ? `\`${key}\` is no longer excluded.`
            : `\`${key}\` was not excluded, so nothing changed.`));
    }

    return interaction.reply(ephemeral('Unknown subcommand.'));
}

module.exports = {
    DIGEST_PREVIEW_COMMAND,
    RADAR_GAMES_COMMAND,
    handleDigestPreview,
    handleRadarGames,
};
