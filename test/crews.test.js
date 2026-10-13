const { test } = require('node:test');
const assert = require('node:assert');
const crews = require('../lib/lobby/crews');

function lobby(overrides = {}) {
    return {
        gameKey: 'g', gameLabel: 'G', platform: 'pc',
        players: ['a', 'b', 'c'],
        attendance: { source: null, showed: [] },
        againVotes: [],
        ...overrides
    };
}

test('with no attendance record everyone confirmed may vote', () => {
    const l = lobby();
    assert.deepEqual(crews.eligibleVoters(l), ['a', 'b', 'c']);
    assert.ok(crews.canVote(l, 'a'));
    assert.ok(!crews.canVote(l, 'stranger'));
});

test('with an attendance record only those who showed may vote', () => {
    const l = lobby({ attendance: { source: 'host', showed: ['a', 'b'] } });

    assert.deepEqual(crews.eligibleVoters(l), ['a', 'b']);
    assert.ok(!crews.canVote(l, 'c'), 'confirmed but did not show');
});

test('one vote is not a crew', () => {
    const l = lobby({ againVotes: ['a'] });
    const verdict = crews.evaluateCrewFormation(l, {}, {});

    assert.equal(verdict.shouldCreate, false);
    assert.equal(verdict.reason, 'notEnoughVotes');
});

test('two votes form a crew', () => {
    const l = lobby({ againVotes: ['a', 'b'] });
    const verdict = crews.evaluateCrewFormation(l, {}, {});

    assert.equal(verdict.shouldCreate, true);
    assert.deepEqual(verdict.members, ['a', 'b']);
});

test('votes from people who were not in the lobby are ignored', () => {
    const l = lobby({ againVotes: ['a', 'stranger'] });
    const verdict = crews.evaluateCrewFormation(l, {}, {});

    assert.equal(verdict.shouldCreate, false, 'only one real vote');
});

test('a crew is capped at six members, first pressers win', () => {
    const l = lobby({
        players: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
        againVotes: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    });

    const verdict = crews.evaluateCrewFormation(l, {}, {});
    assert.equal(verdict.members.length, 6);
    assert.deepEqual(verdict.members, ['a', 'b', 'c', 'd', 'e', 'f']);
});

test('members at their crew cap are left out', () => {
    const l = lobby({ againVotes: ['a', 'b', 'c'] });
    const verdict = crews.evaluateCrewFormation(l, {}, { a: 5, b: 5 });

    assert.equal(verdict.shouldCreate, false, 'only c is under the cap, which is not a crew');
    assert.equal(verdict.reason, 'capped');
});

test('the same members and game do not create a duplicate crew', () => {
    const existing = { c1: { gameKey: 'g', members: ['b', 'a'] } };
    const l = lobby({ againVotes: ['a', 'b'] });

    const verdict = crews.evaluateCrewFormation(l, existing, {});
    assert.equal(verdict.shouldCreate, false);
    assert.equal(verdict.reason, 'exists');
    assert.equal(verdict.existing.id, 'c1');
});

test('the same members on a different game do create a crew', () => {
    const existing = { c1: { gameKey: 'other', members: ['a', 'b'] } };
    const l = lobby({ againVotes: ['a', 'b'] });

    assert.equal(crews.evaluateCrewFormation(l, existing, {}).shouldCreate, true);
});

test('crew counting per member', () => {
    const counts = crews.countCrewsByMember({
        c1: { members: ['a', 'b'] },
        c2: { members: ['a'] }
    });

    assert.equal(counts.a, 2);
    assert.equal(counts.b, 1);
});
