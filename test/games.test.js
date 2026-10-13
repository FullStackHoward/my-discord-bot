const { test } = require('node:test');
const assert = require('node:assert');
const games = require('../lib/lobby/games');

test('normalization collapses spelling variants onto one key', () => {
    const variants = ['Helldivers 2', 'helldivers 2', 'HELLDIVERS  2!', '  Helldivers   2  ', 'Helldivers-2'];
    const keys = new Set(variants.map(games.normalizeGameKey));

    assert.equal(keys.size, 1, `expected one key, got ${[...keys].join(' / ')}`);
    assert.equal([...keys][0], 'helldivers-2');
});

test('normalization keeps letters and digits from other scripts', () => {
    assert.equal(games.normalizeGameKey('Café Racer'), 'café-racer');
    assert.equal(games.normalizeGameKey('???'), null);
    assert.equal(games.normalizeGameKey(''), null);
    assert.equal(games.normalizeGameKey(null), null);
});

test('titles with mentions, links or invites are rejected', () => {
    for (const bad of ['@everyone', 'see http://x.com', 'join discord.gg/abc', '<@123>', 'a <b>']) {
        assert.equal(games.validateGameTitle(bad).ok, false, `${bad} should be rejected`);
    }
});

test('titles that are too short or blocked are rejected', () => {
    assert.equal(games.validateGameTitle('a').ok, false);
    assert.equal(games.validateGameTitle('  ').ok, false);
    assert.equal(games.validateGameTitle('Halo', ['halo']).reason, 'blocked');
});

test('a valid title yields a key and keeps the first spelling as the label', () => {
    const r = games.validateGameTitle('  Rocket   League  ');
    assert.equal(r.ok, true);
    assert.equal(r.key, 'rocket-league');
    assert.equal(r.label, 'Rocket League');
});

test('escapeLabel neutralises markdown so labels cannot format a card', () => {
    assert.equal(games.escapeLabel('**bold** _x_'), '\\*\\*bold\\*\\* \\_x\\_');
});

test('edit distance is bounded and symmetric enough for typo detection', () => {
    assert.equal(games.editDistance('abc', 'abc'), 0);
    assert.equal(games.editDistance('helldivers', 'helldiver'), 1);
    assert.equal(games.editDistance('abc', 'xyz', 1), 2, 'bails out past the cap');
});

test('a one-character typo finds the near duplicate', () => {
    const registry = { 'helldivers-2': { label: 'Helldivers 2', submitters: ['a', 'b'] } };
    const visible = Object.keys(registry);

    assert.equal(games.findNearDuplicate('helldivers-1', registry, visible), 'helldivers-2');
    assert.equal(games.findNearDuplicate('helldiver-2', registry, visible), 'helldivers-2');
});

test('short keys use a tighter threshold, so different games stay distinct', () => {
    assert.equal(games.duplicateThreshold('lol'), 1);
    assert.equal(games.duplicateThreshold('helldivers'), 2);

    const registry = { lol: { label: 'LoL', submitters: ['a'] } };
    // Two edits away on a short key is a different game, not a typo.
    assert.equal(games.findNearDuplicate('wow', registry, ['lol']), null);
});

test('an exact match is not treated as a near duplicate', () => {
    const registry = { halo: { label: 'Halo', submitters: ['a'] } };
    assert.equal(games.findNearDuplicate('halo', registry, ['halo']), null);
});

test('the listing rule: one submitter stays private, two go public', () => {
    assert.equal(games.isListed({ submitters: ['a'], lobbyCount: 0 }, 2), false);
    assert.equal(games.isListed({ submitters: ['a', 'b'], lobbyCount: 0 }, 2), true);
    // A lobby makes it public regardless, since the card is already visible.
    assert.equal(games.isListed({ submitters: ['a'], lobbyCount: 1 }, 2), true);
});

test('an unlisted game is visible to its own submitter only', () => {
    const registry = {
        mine: { label: 'Mine', submitters: ['me'], lobbyCount: 0 },
        shared: { label: 'Shared', submitters: ['x', 'y'], lobbyCount: 0 },
        theirs: { label: 'Theirs', submitters: ['them'], lobbyCount: 0 }
    };

    assert.deepEqual(games.visibleGameKeys(registry, 'me', 2).sort(), ['mine', 'shared']);
    assert.deepEqual(games.visibleGameKeys(registry, 'them', 2).sort(), ['shared', 'theirs']);
    assert.deepEqual(games.visibleGameKeys(registry, 'nobody', 2), ['shared']);
});

test('ranking puts starts-with above contains, then popularity', () => {
    const registry = {
        'halo-infinite': { label: 'Halo Infinite', submitters: ['a'], lobbyCount: 0 },
        'super-halo': { label: 'Super Halo', submitters: ['a', 'b', 'c'], lobbyCount: 5 },
        'destiny-2': { label: 'Destiny 2', submitters: ['a', 'b'], lobbyCount: 0 }
    };

    const ranked = games.rankGames(registry, Object.keys(registry), 'halo', 'a');

    assert.equal(ranked[0].key, 'halo-infinite', 'starts-with wins despite being less popular');
    assert.equal(ranked[1].key, 'super-halo');
    assert.ok(!ranked.some(r => r.key === 'destiny-2'), 'non-matches are dropped');
});

test('autocomplete offers Add when nothing matches', () => {
    const choices = games.gameChoices({}, { query: 'Brand New Game', userId: 'u', minSubmitters: 2 });

    assert.equal(choices.length, 1);
    assert.equal(choices[0].value, 'new:Brand New Game');
    assert.match(choices[0].name, /^Add "/);
});

test('autocomplete does not offer Add for a game that already exists', () => {
    const registry = { halo: { label: 'Halo', submitters: ['a', 'b'], lobbyCount: 0 } };
    const choices = games.gameChoices(registry, { query: 'Halo', userId: 'u', minSubmitters: 2 });

    assert.ok(!choices.some(c => String(c.value).startsWith('new:')));
    assert.equal(choices[0].value, 'halo');
});

test('autocomplete never returns more than 25 choices', () => {
    const registry = {};
    for (let i = 0; i < 60; i++) registry[`game-${i}`] = { label: `Game ${i}`, submitters: ['a', 'b'], lobbyCount: 0 };

    assert.ok(games.gameChoices(registry, { query: 'game', userId: 'u', minSubmitters: 2 }).length <= 25);
    assert.ok(games.gameChoices(registry, { query: '', userId: 'u', minSubmitters: 2 }).length <= 25);
});

test('autocomplete respects the blocked list', () => {
    const choices = games.gameChoices({}, { query: 'Banned Game', userId: 'u', minSubmitters: 2, blockedGames: ['banned-game'] });
    assert.equal(choices.length, 0, 'no Add offer for a blocked key');
});

test('the games select caps at 25 and puts the member own games first', () => {
    const registry = { mine: { label: 'Mine', submitters: ['me'], lobbyCount: 0 } };
    for (let i = 0; i < 40; i++) registry[`pop-${i}`] = { label: `Pop ${i}`, submitters: ['a', 'b'], lobbyCount: i };

    const options = games.gameSelectOptions(registry, { userId: 'me', minSubmitters: 2, selected: ['mine'] });

    assert.ok(options.length <= 25);
    assert.equal(options[0].value, 'mine');
    assert.equal(options[0].default, true, 'already-chosen games come back ticked');
});

test('pruning only removes entries with no submitters and no use', () => {
    const old = Date.now() - 100 * 24 * 60 * 60 * 1000;
    const registry = {
        orphan: { submitters: [], lobbyCount: 0, createdAt: old, lastUsedAt: old },
        recent: { submitters: [], lobbyCount: 0, createdAt: Date.now(), lastUsedAt: Date.now() },
        used: { submitters: [], lobbyCount: 3, createdAt: old, lastUsedAt: old },
        owned: { submitters: ['a'], lobbyCount: 0, createdAt: old, lastUsedAt: old }
    };

    assert.deepEqual(games.prunableGameKeys(registry, Date.now(), 60), ['orphan']);
});
