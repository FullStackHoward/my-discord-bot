const os = require('node:os');
const path = require('node:path');
process.env.LOBBY_STATE_PATH = path.join(os.tmpdir(), `lobby-cancel-test-${process.pid}.json`);
process.env.VG_GUILD_ID = '900000000000000001';
process.env.VG_LFG_CHANNEL = '900000000000000002';

const { test } = require('node:test');
const assert = require('node:assert');
const components = require('../lib/lobby/components');
const copy = require('../lib/lobby/copy');
const config = require('../lib/config');

function lobby(overrides = {}) {
    return {
        id: 'abc123', number: 3, hostId: 'host', gameLabel: 'Helldivers 2',
        startsAt: Date.UTC(2026, 9, 20, 23, 0),
        players: ['host'], maybes: [], waitlist: [],
        ...overrides
    };
}

test('everyone who signed up is told, not just confirmed players', () => {
    const recipients = components.cancelRecipients(lobby({
        players: ['host', 'a'], maybes: ['b'], waitlist: ['c']
    }));

    assert.deepEqual(recipients.sort(), ['a', 'b', 'c']);
});

test('the host is never notified about their own cancellation', () => {
    assert.deepEqual(components.cancelRecipients(lobby({ players: ['host'] })), []);
    assert.ok(!components.cancelRecipients(lobby({ players: ['host', 'a'] })).includes('host'));
});

test('someone listed twice is only told once', () => {
    // A maybe who later joined could appear in both lists on an older record.
    const recipients = components.cancelRecipients(lobby({
        players: ['host', 'a'], maybes: ['a'], waitlist: ['a']
    }));

    assert.deepEqual(recipients, ['a']);
});

test('an empty lobby yields nobody to notify', () => {
    assert.deepEqual(components.cancelRecipients(lobby()), []);
    assert.deepEqual(components.cancelRecipients({ hostId: 'h' }), [], 'missing arrays do not throw');
});

test('the thread notice names the reason and mentions people', () => {
    const notice = copy.cancelledThreadNotice('<@a> <@b>', copy.cancelReasonHost);

    assert.match(notice, /<@a>/);
    assert.match(notice, /the host or staff cancelled it/);
    assert.match(notice, /Nothing else is needed/);
});

test('the thread notice is tidy when there is nobody to mention', () => {
    assert.ok(!copy.cancelledThreadNotice('', copy.cancelReasonHostLeft).startsWith('\n'),
        'no leading blank line when the mention list is empty');
});

test('the DM carries the game, server, reason and a relative start time', () => {
    const dm = copy.cancelledDm('Helldivers 2', 'Vice Gamers', copy.cancelReasonHostLeft, 1792000000);

    assert.match(dm, /Helldivers 2/);
    assert.match(dm, /Vice Gamers/);
    assert.match(dm, /the host left the server/);
    assert.match(dm, /<t:1792000000:R>/, 'rendered in each reader own local clock');
    assert.match(dm, /\/lobby create/, 'points them at what to do next');
});

test('all three reasons read as a sentence fragment', () => {
    for (const reason of [copy.cancelReasonHost, copy.cancelReasonHostLeft, copy.cancelReasonCardGone]) {
        assert.match(copy.cancelledDm('G', 'S', reason, 1), /has been cancelled because \w/);
    }
});

test('a lobby that never ran is cleaned up in minutes, not a day', () => {
    assert.ok(config.LOBBY_DEAD_CARD_CLEANUP_MINUTES > 0);
    assert.ok(
        config.LOBBY_DEAD_CARD_CLEANUP_MINUTES * 60 * 1000
        < config.LOBBY_CARD_CLEANUP_HOURS * 60 * 60 * 1000,
        'the dead-lobby window must be shorter than the ran-to-completion one'
    );
});

test('the DM says the host or staff, not just the host', () => {
    // Previously only the host-left reason was covered here, so a staff cancel could have
    // gone out saying the host did it without any test noticing.
    const dm = copy.cancelledDm('G', 'S', copy.cancelReasonHost, 1);

    assert.match(dm, /host or staff/);
    // Pinned exactly, so a staff cancel can never again be attributed to the host.
    assert.equal(copy.cancelReasonHost, 'the host or staff cancelled it');
});

test('the thread notice and the DM agree on the reason', () => {
    for (const reason of [copy.cancelReasonHost, copy.cancelReasonHostLeft, copy.cancelReasonCardGone]) {
        assert.ok(copy.cancelledThreadNotice('<@a>', reason).includes(reason));
        assert.ok(copy.cancelledDm('G', 'S', reason, 1).includes(reason));
    }
});

test('the profile command is registered as /lfg-profile, not /availability', () => {
    const { LOBBY_COMMANDS } = require('../lib/lobby/commands');
    const names = LOBBY_COMMANDS.map(c => c.name);

    assert.ok(names.includes('lfg-profile'), `expected lfg-profile in ${names.join(', ')}`);
    assert.ok(!names.includes('availability'), 'the old name must be gone');
});

test('/lfg-profile keeps all five subcommands', () => {
    const { LOBBY_COMMANDS } = require('../lib/lobby/commands');
    const profile = LOBBY_COMMANDS.find(c => c.name === 'lfg-profile');

    assert.deepEqual(profile.options.map(o => o.name).sort(), ['clear', 'set', 'tags', 'timezone', 'view']);
});

test('no user-facing string still points at the old command name', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = path.join(__dirname, '..', 'lib');

    const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(d, entry.name);
        return entry.isDirectory() ? walk(full) : (entry.name.endsWith('.js') ? [full] : []);
    });

    const offenders = walk(dir).filter(file => fs.readFileSync(file, 'utf8').includes('/availability'));
    assert.deepEqual(offenders, [], 'these files still name /availability');
});
