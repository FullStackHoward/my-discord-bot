// ---------------------------------------------------------------------------
// Member of the Week: announcement wording
// ---------------------------------------------------------------------------
//
// Every member-facing string lives here so wording changes need no logic edits, the same
// way lib/lobby/copy.js works. The announcement deliberately never mentions the role, so
// a role change that fails cannot make the post untrue.

const TITLE = '👑 Member of the Week';
const COLOR = 0xFFD700;
const FOOTER = 'Keep up the great work!';
const PARTIAL_FOOTER = 'First week, counting started partway through.';

function messages(n) {
    return `${n} message${n === 1 ? '' : 's'}`;
}

function congratulations(winnerId, count) {
    return `Congratulations to <@${winnerId}> for being the most active member this week with **${messages(count)}**!`;
}

// The sentence about the runner-up, or an empty string when there is none.
function leadSentence({ hasRunnerUp, lead }) {
    if (!hasRunnerUp) return '';
    if (lead === 0) return ' They tied the runner-up on messages and got there first.';

    return ` They were **${messages(lead)}** ahead of the runner-up!`;
}

function description({ winnerId, count, hasRunnerUp, lead }) {
    return congratulations(winnerId, count) + leadSentence({ hasRunnerUp, lead });
}

function footer(partial) {
    return partial ? PARTIAL_FOOTER : FOOTER;
}

module.exports = {
    TITLE,
    COLOR,
    FOOTER,
    PARTIAL_FOOTER,
    messages,
    congratulations,
    leadSentence,
    description,
    footer,
};
