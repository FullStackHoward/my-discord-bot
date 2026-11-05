// The arcade's embeds. Pure builders, so these run with no Discord and no API.
//
// What is worth pinning here is not the wording but the two rules that are easy to
// break without noticing: a long board must split without repeating its reset note, and
// nothing except the three podium winners may ever ping.

const { test } = require('node:test');
const assert = require('node:assert');

const posts = require('../lib/arcade/posts');

function entries(count, { pending = false } = {}) {
    return Array.from({ length: count }, (_, index) => ({
        place: index + 1,
        discord_user_id: `${1000 + index}`,
        display_name: `Player ${index}`,
        score: 5000 - index,
        pending
    }));
}

test('a short daily board is one message carrying the reset note', () => {
    const messages = posts.dailyBoardMessages({
        gameName: 'Vetrix',
        day: '2026-11-10',
        entries: entries(3),
        resetsAt: '2026-11-15T22:00:00Z'
    });

    assert.equal(messages.length, 1);

    const body = messages[0].embeds[0].data.description;
    assert.match(body, /Leaderboards reset <t:\d+:F> \(<t:\d+:R>\)\./);
    assert.match(messages[0].embeds[0].data.title, /Vetrix/);
});

test('the reset note uses discord timestamps so everyone sees their own clock', () => {
    const line = posts.resetLine('2026-11-15T22:00:00Z');

    // 2026-11-15T22:00:00Z as a unix second. Hard-coded so a change of format is a
    // visible decision rather than a silent one.
    assert.match(line, /<t:1794780000:F>/);
    assert.match(line, /<t:1794780000:R>/);
});

test('an unparseable reset time produces no note rather than a broken one', () => {
    assert.equal(posts.resetLine('whenever'), null);

    const messages = posts.dailyBoardMessages({
        gameName: 'Vetrix', day: '2026-11-10', entries: entries(2), resetsAt: null
    });

    assert.doesNotMatch(messages[0].embeds[0].data.description, /reset/);
});

test('a long board splits, and only the last message carries the reset note', () => {
    const messages = posts.dailyBoardMessages({
        gameName: 'Vetrix',
        day: '2026-11-10',
        entries: entries(400),
        resetsAt: '2026-11-15T22:00:00Z'
    });

    assert.ok(messages.length > 1, 'four hundred players do not fit one embed');

    const withNote = messages.filter(message => /Leaderboards reset/.test(message.embeds[0].data.description));
    assert.equal(withNote.length, 1, 'the note appears once');
    assert.equal(
        messages[messages.length - 1].embeds[0].data.description.includes('Leaderboards reset'),
        true,
        'and it is on the last message'
    );

    for (const message of messages) {
        assert.ok(
            message.embeds[0].data.description.length <= 4096,
            'and every message is inside the embed description limit'
        );
        assert.match(message.embeds[0].data.title, /\d+\/\d+/, 'and says which part it is');
    }
});

test('a daily board pings nobody, however many people are on it', () => {
    const messages = posts.dailyBoardMessages({
        gameName: 'Vetrix', day: '2026-11-10', entries: entries(80), resetsAt: null
    });

    for (const message of messages) {
        assert.deepEqual(message.allowedMentions, { parse: [] });
        assert.doesNotMatch(message.embeds[0].data.description, /<@/, 'names are plain text, not mentions');
    }
});

test('a pending score keeps its marker on the posted board', () => {
    const messages = posts.dailyBoardMessages({
        gameName: 'Vetrix', day: '2026-11-10', entries: entries(1, { pending: true })
    });

    assert.match(messages[0].embeds[0].data.description, /pending/);
});

test('an empty board still renders rather than throwing', () => {
    const messages = posts.dailyBoardMessages({ gameName: 'Vetrix', day: '2026-11-10', entries: [] });

    assert.equal(messages.length, 1);
    assert.match(messages[0].embeds[0].data.description, /Nobody played/);
});

test('the day is formatted from the eastern date the api sent, not shifted again', () => {
    // 2026-11-10 is a Tuesday. Formatting it in a local zone west of UTC would show
    // Monday, which would quietly mislabel every board.
    assert.match(posts.formatDay('2026-11-10'), /Tuesday/);
    assert.match(posts.formatDay('2026-11-10'), /Nov 10/);
});

test('a record post names the displaced player without pinging them', () => {
    const message = posts.recordMessage({
        gameName: 'Vetrix',
        displayName: 'Howard',
        score: 12000,
        previousBest: 9000,
        previousHolder: '42',
        scoreId: 77
    });

    assert.match(message.embeds[0].data.description, /Howard/);
    assert.match(message.embeds[0].data.description, /12,000/);
    assert.match(message.embeds[0].data.description, /9,000/);
    assert.equal(message.embeds[0].data.footer.text, 'Score 77');
    assert.deepEqual(message.allowedMentions, { parse: [] });
});

test('the season callout mentions exactly the three winners and nobody else', () => {
    const message = posts.podiumMessage({
        winners: [
            { place: 1, discord_user_id: '1', display_name: 'A', average_placement: 1 },
            { place: 2, discord_user_id: '2', display_name: 'B', average_placement: 2 },
            { place: 3, discord_user_id: '3', display_name: 'C', average_placement: 3 }
        ],
        arcadeChannelId: '555'
    });

    assert.deepEqual(message.allowedMentions, { users: ['1', '2', '3'] });
    assert.match(message.embeds[0].data.description, /<@1>/);
    assert.match(message.embeds[0].data.description, /<#555>/, 'and points at the arcade channel');
});

test('the callout says the season has ended, because the roles are already off by then', () => {
    const message = posts.podiumMessage({
        winners: [{ place: 1, discord_user_id: '1', display_name: 'A', average_placement: 1 }],
        arcadeChannelId: '555'
    });

    assert.match(message.embeds[0].data.title, /ended/i);
    assert.match(message.embeds[0].data.description, /new season has started/i);
});

test('fewer than three winners calls out only the places there are', () => {
    const message = posts.podiumMessage({
        winners: [{ place: 1, discord_user_id: '1', display_name: 'A', average_placement: 1 }]
    });

    assert.deepEqual(message.allowedMentions, { users: ['1'] });
    assert.doesNotMatch(message.embeds[0].data.description, /Silver|Bronze/);
});

test('a season nobody played produces no callout at all', () => {
    assert.equal(posts.podiumMessage({ winners: [] }), null);
    assert.equal(posts.correctionMessage({ winners: [] }), null);
});

test('with one game live the callout leaves the average placing out', () => {
    const one = posts.podiumMessage({
        winners: [{ place: 1, discord_user_id: '1', display_name: 'A', average_placement: 1 }],
        oneGame: true
    });
    const many = posts.podiumMessage({
        winners: [{ place: 1, discord_user_id: '1', display_name: 'A', average_placement: 2.5 }],
        oneGame: false
    });

    assert.doesNotMatch(one.embeds[0].data.description, /average/);
    assert.match(many.embeds[0].data.description, /average placing 2\.50/);
});

test('a correction names the winners without pinging them a second time', () => {
    const message = posts.correctionMessage({
        winners: [{ place: 1, discord_user_id: '1', display_name: 'A', average_placement: 1 }]
    });

    assert.match(message.embeds[0].data.title, /corrected/i);
    assert.deepEqual(message.allowedMentions, { parse: [] });
    assert.doesNotMatch(message.embeds[0].data.description, /<@/);
});
