// ---------------------------------------------------------------------------
// /arcade-review
// ---------------------------------------------------------------------------
//
// Owner review of a flagged record. A score that beats the all-time best is saved
// pending: it shows on the boards with a marker and holds no role until it is approved
// here, which is what keeps an unreviewed record out of the public record post.
//
// Named `arcade-review` rather than `arcade` deliberately. This bot is the Vice Arcade
// application, whose `/arcade` is the Entry Point command that launches the Activity.
// Discord requires that one to be global and option-less, so it cannot carry these
// subcommands, and a second `/arcade` beside it would show members two of them.

const { ApplicationCommandOptionType, MessageFlags, PermissionFlagsBits } = require('discord.js');

const activity = require('../activity');

const api = require('./api');

const ARCADE_REVIEW_COMMAND = {
    name: 'arcade-review',
    description: 'Approve or remove a Vice Arcade score (owner only)',
    // Hides it from regular members. The real gate is the owner check in the handler,
    // because an Administrator can still see a command restricted this way.
    defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
    options: [
        {
            name: 'approve',
            description: 'Let a pending record count, and post it publicly',
            type: ApplicationCommandOptionType.Subcommand,
            options: [
                {
                    name: 'score_id',
                    description: 'The score id from the DM or the embed footer',
                    type: ApplicationCommandOptionType.Integer,
                    required: true,
                    min_value: 1
                }
            ]
        },
        {
            name: 'remove',
            description: 'Take a score off every leaderboard',
            type: ApplicationCommandOptionType.Subcommand,
            options: [
                {
                    name: 'score_id',
                    description: 'The score id from the DM or the embed footer',
                    type: ApplicationCommandOptionType.Integer,
                    required: true,
                    min_value: 1
                }
            ]
        }
    ]
};

async function handleArcadeReviewCommand(interaction) {
    if (!activity.isActivityOwner(interaction.user.id)) {
        await activity.logUnauthorizedAttempt(interaction);

        return interaction.reply({
            content: '❌ You do not have permission to review arcade scores.',
            flags: MessageFlags.Ephemeral
        });
    }

    const action = interaction.options.getSubcommand();
    const scoreId = interaction.options.getInteger('score_id');

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
        if (action === 'approve') {
            const result = await api.approveScore(scoreId);

            return interaction.editReply(result?.announced
                ? `✅ Score ${scoreId} is approved and the record has been posted.`
                : `✅ Score ${scoreId} is approved. Nothing was posted, because it displaced nobody.`);
        }

        await api.removeScore(scoreId);

        return interaction.editReply(
            `✅ Score ${scoreId} is removed from every board. `
            + 'If it was in a finished round, that round\'s result has been recomputed.'
        );
    } catch (error) {
        // A 404 means the id was wrong, which is the likeliest mistake here, so it is
        // told apart from the arcade being unreachable.
        if (error.status === 404) {
            return interaction.editReply(`❌ There is no score ${scoreId}.`);
        }

        return interaction.editReply(error.answered
            ? `❌ The arcade refused that: ${error.message}`
            : '❌ Could not reach the arcade API. Nothing was changed.');
    }
}

module.exports = { ARCADE_REVIEW_COMMAND, handleArcadeReviewCommand };
