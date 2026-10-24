const { test } = require('node:test');
const assert = require('node:assert');
const plan = require('../lib/radar/dm-plan');
const { RADAR_DM_IGNORED_GAMES } = require('../lib/config');

const IGNORED = ['Wordle'];

// `alreadyDmed` maps a recipient to the signature of what they were last shown. Built
// here the way the live code builds it, from what has actually gone out.
function dmed(...pairs) {
    return new Map(pairs);
}

function ids(items) {
    return items.map(item => item.recipientId);
}

// ---------------------------------------------------------------------------
// Who gets a DM, and who gets their existing one edited
// ---------------------------------------------------------------------------

test('two opted-in players each get one DM naming the other', () => {
    const { send, update } = plan.planRadarDms({
        rosterIds: ['a', 'b'], optedInIds: ['a', 'b'], alreadyDmed: dmed()
    });

    assert.deepEqual(ids(send), ['a', 'b']);
    assert.deepEqual(update, []);
    assert.deepEqual(send[0].otherOptedInIds, ['b']);
    assert.deepEqual(send[1].otherOptedInIds, ['a']);
});

test('a third player gets their own DM and the first two get edits, not seconds', () => {
    const first = plan.planRadarDms({
        rosterIds: ['a', 'b'], optedInIds: ['a', 'b'], alreadyDmed: dmed()
    });

    // What the live code records once those two DMs have gone out.
    const sent = dmed(...first.send.map(item => [item.recipientId, item.signature]));

    const second = plan.planRadarDms({
        rosterIds: ['a', 'b', 'c'], optedInIds: ['a', 'b', 'c'], alreadyDmed: sent
    });

    assert.deepEqual(ids(second.send), ['c'], 'only the newcomer is sent anything');
    assert.deepEqual(ids(second.update), ['a', 'b'], 'the other two have theirs brought up to date');
    assert.deepEqual(second.update[0].otherOptedInIds, ['b', 'c']);
});

test('nobody is ever in both lists', () => {
    const { send, update } = plan.planRadarDms({
        rosterIds: ['a', 'b', 'c'], optedInIds: ['a', 'b', 'c'], alreadyDmed: dmed(['a', 'stale'])
    });

    const overlap = ids(send).filter(id => ids(update).includes(id));
    assert.deepEqual(overlap, []);
});

test('a roster event that changes nothing plans nothing', () => {
    const { send, update } = plan.planRadarDms({
        rosterIds: ['a', 'b'],
        optedInIds: ['a', 'b'],
        alreadyDmed: dmed(['a', 'b|2'], ['b', 'a|2'])
    });

    assert.deepEqual(send, []);
    assert.deepEqual(update, [], 'an identical DM is not worth an edit');
});

test('somebody leaving the match earns the rest an edit', () => {
    const { send, update } = plan.planRadarDms({
        rosterIds: ['a', 'b'],
        optedInIds: ['a', 'b'],
        alreadyDmed: dmed(['a', 'b,c|3'], ['b', 'a,c|3'], ['c', 'a,b|3'])
    });

    assert.deepEqual(send, []);
    assert.deepEqual(ids(update), ['a', 'b']);
    assert.deepEqual(update[0].otherOptedInIds, ['b'], 'c is gone from the list');
});

test('the one who left is not edited, so their DM is left as they saw it', () => {
    const { update } = plan.planRadarDms({
        rosterIds: ['a', 'b'],
        optedInIds: ['a', 'b'],
        alreadyDmed: dmed(['a', 'x|9'], ['b', 'x|9'], ['gone', 'x|9'])
    });

    assert.ok(!ids(update).includes('gone'));
});

test('people who are not on Radar are counted but never DMed', () => {
    const { send } = plan.planRadarDms({
        rosterIds: ['a', 'b', 'lurker'], optedInIds: ['a', 'b'], alreadyDmed: dmed()
    });

    assert.deepEqual(ids(send), ['a', 'b']);
    assert.equal(send[0].totalCount, 3, 'the headcount still includes them');
    assert.deepEqual(send[0].otherOptedInIds, ['b'], 'but they are not somebody to be pointed at');
});

test('the only opted-in player gets a DM with nobody to name', () => {
    const { send } = plan.planRadarDms({
        rosterIds: ['a', 'lurker'], optedInIds: ['a'], alreadyDmed: dmed()
    });

    assert.deepEqual(ids(send), ['a']);
    assert.deepEqual(send[0].otherOptedInIds, [], 'which is what selects the solo layout');
    assert.equal(send[0].totalCount, 2);
});

test('a second opted-in player moves that solo DM to the squad layout by edit', () => {
    const solo = plan.planRadarDms({
        rosterIds: ['a', 'lurker'], optedInIds: ['a'], alreadyDmed: dmed()
    });

    const { send, update } = plan.planRadarDms({
        rosterIds: ['a', 'lurker', 'b'],
        optedInIds: ['a', 'b'],
        alreadyDmed: dmed([ 'a', solo.send[0].signature ])
    });

    assert.deepEqual(ids(send), ['b']);
    assert.deepEqual(ids(update), ['a'], 'a is edited, not sent a second DM');
    assert.deepEqual(update[0].otherOptedInIds, ['b']);
});

test('a failed send still counts as a claim, so it is not retried forever', () => {
    // The live code stores a null message with its signature when a DM bounces.
    const { send } = plan.planRadarDms({
        rosterIds: ['a', 'b'], optedInIds: ['a', 'b'], alreadyDmed: dmed(['a', 'b|2'])
    });

    assert.deepEqual(ids(send), ['b']);
});

test('the signature ignores the order the roster arrived in', () => {
    assert.equal(
        plan.dmSignature({ otherOptedInIds: ['b', 'c'], totalCount: 3 }),
        plan.dmSignature({ otherOptedInIds: ['c', 'b'], totalCount: 3 })
    );

    assert.notEqual(
        plan.dmSignature({ otherOptedInIds: ['b'], totalCount: 2 }),
        plan.dmSignature({ otherOptedInIds: ['b'], totalCount: 3 }),
        'the headcount is part of what they were shown'
    );
});

// ---------------------------------------------------------------------------
// B1: Discord games
// ---------------------------------------------------------------------------

test('Wordle is excluded whatever the casing', () => {
    for (const name of ['Wordle', 'wordle', 'WORDLE', '  Wordle  ']) {
        assert.equal(plan.isDmExcludedGame(name, IGNORED), true, name);
    }
});

test('a real game is not excluded', () => {
    assert.equal(plan.isDmExcludedGame('Helldivers 2', IGNORED), false);
    assert.equal(plan.isDmExcludedGame('Word', IGNORED), false, 'not a substring match');
    assert.equal(plan.isDmExcludedGame('Wordle Peaks', IGNORED), false);
});

test('an empty or missing name is not excluded', () => {
    for (const name of [undefined, null, '', '   ']) {
        assert.equal(plan.isDmExcludedGame(name, IGNORED), false);
    }
});

test('the list is configurable, and empty means exclude nothing', () => {
    assert.equal(plan.isDmExcludedGame('Chess In The Park', ['wordle', 'chess in the park']), true);
    assert.equal(plan.isDmExcludedGame('Wordle', []), false);
    assert.equal(plan.isDmExcludedGame('Wordle', undefined), false);
});

test('Wordle is excluded out of the box', () => {
    assert.ok(RADAR_DM_IGNORED_GAMES.has('wordle'), 'RADAR_DM_IGNORED_GAMES defaults to Wordle');
    assert.equal(plan.isDmExcludedGame('Wordle', RADAR_DM_IGNORED_GAMES), true);
});

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

const people = n => Array.from({ length: n }, (unused, i) => ({ id: `u${i}`, displayName: `Player ${i}` }));

function squad(overrides = {}) {
    const payload = plan.buildSquadDm({
        gameName: 'Helldivers 2', others: people(2), totalCount: 3, matchToken: 'ab12cd34',
        ...overrides
    });

    return {
        description: payload.embeds[0].toJSON().description,
        embed: payload.embeds[0].toJSON(),
        rows: payload.components.map(row => row.toJSON())
    };
}

test('the squad DM names everyone and says so in Howard words', () => {
    const { description } = squad();

    assert.match(description, /The following people are also playing this game right now/);
    assert.match(description, /- <@u0>/);
    assert.match(description, /- <@u1>/);
});

test('the squad DM counts the rest of the match without naming them', () => {
    assert.match(squad({ totalCount: 5 }).description, /2 more people are in this match too/);
    assert.match(squad({ totalCount: 4 }).description, /1 more person is in this match too/);
    assert.ok(!/more people are in this match/.test(squad({ totalCount: 3 }).description),
        'nothing to add when everybody in the match is named');
});

test('a message button per person, five to a row, ten at most', () => {
    const { rows } = squad({ others: people(12) });
    const buttons = rows.flatMap(row => row.components).filter(c => c.style === 5);

    assert.equal(buttons.length, plan.PERSON_BUTTON_MAX);
    assert.match(buttons[0].label, /^Message Player 0$/);
    assert.match(buttons[0].url, /^https:\/\/discord\.com\/users\/u0$/);
    assert.ok(rows.every(row => row.components.length <= 5), 'Discord allows five per row');
});

test('the group chat button is highlighted, carries a custom id, and sits last', () => {
    const { rows } = squad();
    const last = rows[rows.length - 1];

    assert.equal(last.components.length, 1, 'on its own row');
    assert.equal(last.components[0].style, 3, 'Success: a link button takes no style at all');
    assert.equal(last.components[0].custom_id, 'radar:group:ab12cd34');
    assert.ok(last.components[0].custom_id.length <= 100, 'inside the custom id limit');
    assert.equal(last.components[0].label, 'Start a group chat');
});

test('no token means no group button, rather than a button that cannot work', () => {
    const { rows } = squad({ matchToken: null });

    assert.ok(!rows.some(row => row.components.some(c => c.custom_id)));
});

test('a 50-person match stays inside every Discord limit', () => {
    const { description, rows } = squad({ others: people(50), totalCount: 60 });

    assert.ok(description.length < 4096, `description was ${description.length}`);
    assert.ok(rows.length <= 5, `${rows.length} action rows`);
    assert.match(description, /and 40 more on Vice Radar/, 'the names are capped, not dropped');
});

test('a game name cannot break the formatting around it', () => {
    assert.match(squad({ gameName: 'Halo **Infinite**' }).description, /Halo \\\*\\\*Infinite\\\*\\\*/);
});

test('the icon becomes a thumbnail, and its absence costs only the icon', () => {
    assert.equal(squad({ iconURL: 'https://cdn/icon.png' }).embed.thumbnail.url, 'https://cdn/icon.png');
    assert.equal(squad().embed.thumbnail, undefined);
    assert.match(squad().embed.author.name, /Vice Radar \u{1F334}/u, 'the palm tree is the fallback mark');
    assert.equal(squad({ iconURL: 'https://cdn/icon.png' }).embed.author.name, 'Vice Radar');
});

function solo(overrides = {}) {
    const payload = plan.buildSoloDm({
        gameName: 'Helldivers 2', guildId: 'g1', guildName: 'Vice Gamers', totalCount: 3,
        channels: { lfgId: 'lfg1', gameForumsId: 'for1', gameChatId: 'chat1' },
        ...overrides
    });

    return {
        description: payload.embeds[0].toJSON().description,
        rows: payload.components.map(row => row.toJSON())
    };
}

test('the solo DM leads with how many others are playing', () => {
    assert.match(solo({ totalCount: 3 }).description, /^## 2 other Vicers are playing Helldivers 2 right now/);
    assert.match(solo({ totalCount: 2 }).description, /^## 1 other Vicer is playing/);
});

test('the solo DM offers all three ways to find players', () => {
    const { description } = solo();

    assert.match(description, /Start a lobby in <#lfg1> with `\/lobby now` or `\/lobby create`/);
    assert.match(description, /Find Helldivers 2 in <#for1> and ask for players/);
    assert.match(description, /ask around in <#chat1>/);
    assert.match(description, /Nobody else playing it has opted in to Vice Radar yet/);
    assert.match(description, /Vice Gamers/, 'and names the server it is talking about');
});

test('an unconfigured channel falls back to plain text rather than breaking the DM', () => {
    const { description, rows } = solo({ channels: { lfgId: 'lfg1' } });

    assert.match(description, /<#lfg1>/);
    assert.match(description, /#game-forums/);
    assert.match(description, /#game-chat/);
    assert.equal(rows.flatMap(row => row.components).length, 1, 'only the known channel gets a button');
});

test('each known channel also gets a jump button, since a DM mention may not link', () => {
    const buttons = solo().rows.flatMap(row => row.components);

    assert.deepEqual(buttons.map(b => b.label), ['Go to LFG', 'Game forums', 'Game chat']);
    assert.equal(buttons[0].url, 'https://discord.com/channels/g1/lfg1');
    assert.ok(buttons.every(b => b.style === 5), 'all links');
});

test('the solo DM has no group chat button, there being nobody to chat with', () => {
    assert.ok(!solo().rows.some(row => row.components.some(c => c.custom_id)));
});

test('dm-plan pulls in nothing that needs a gateway or an env file', () => {
    const source = require('node:fs').readFileSync(require.resolve('../lib/radar/dm-plan'), 'utf8');
    const requires = [...source.matchAll(/require\('([^']+)'\)/g)].map(m => m[1]);

    assert.deepEqual(requires, ['discord.js'], `dm-plan requires ${requires.join(', ')}`);
});
