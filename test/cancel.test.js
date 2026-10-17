const os = require('node:os');
const path = require('node:path');
process.env.LOBBY_STATE_PATH = path.join(os.tmpdir(), `lobby-cancel-test-${process.pid}.json`);
process.env.VG_GUILD_ID = '900000000000000001';
process.env.VG_LFG_CHANNEL = '900000000000000002';

const { test } = require('node:test');
const assert = require('node:assert');

// Stand in for lib/client before anything can require the real one: dmUser resolves it
// lazily, so a cache entry here is enough to watch who gets told what. Lobbies in these
// tests carry no threadId, which makes postToThread a no-op and keeps the guild out of it.
const sent = [];
require.cache[require.resolve('../lib/client')] = {
    id: require.resolve('../lib/client'),
    filename: require.resolve('../lib/client'),
    loaded: true,
    exports: {
        users: {
            fetch: async userId => ({
                id: userId,
                send: async payload => { sent.push({ userId, payload }); }
            })
        }
    }
};

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

// ---------------------------------------------------------------------------
// Who gets a DM when a lobby ends: the host is told only when they did not do it.
// ---------------------------------------------------------------------------

function signedUp(overrides = {}) {
    // No threadId: postToThread returns early, so these cases exercise the DMs alone.
    return lobby({ threadId: null, players: ['host', 'a'], maybes: ['b'], ...overrides });
}

async function cancelAs(actorId, l = signedUp()) {
    sent.length = 0;

    // handleCancel's own split, kept in one place so the test cannot drift from it.
    const byStaff = actorId !== l.hostId;
    await components.notifyCancelled('900000000000000001', l, copy.cancelReasonHost, {
        notifyHost: byStaff,
        hostReason: copy.cancelReasonStaff
    });

    return sent;
}

test('a host cancelling their own lobby is not DMed about it', async () => {
    const dms = await cancelAs('host');

    assert.deepEqual(dms.map(d => d.userId).sort(), ['a', 'b']);
    assert.ok(!dms.some(d => d.userId === 'host'), 'the host pressed the button themselves');
});

test('staff cancelling someone else lobby DMs the host too', async () => {
    const dms = await cancelAs('staff-member');

    assert.deepEqual(dms.map(d => d.userId).sort(), ['a', 'b', 'host']);
});

test('the host DM names staff, while members still see the hedged wording', async () => {
    const dms = await cancelAs('staff-member');
    const toHost = dms.find(d => d.userId === 'host').payload;
    const toMember = dms.find(d => d.userId === 'a').payload;

    assert.match(toHost, /a staff member cancelled it/);
    assert.match(toHost, /Your lobby was cancelled/);
    assert.ok(!/host or staff/.test(toHost), 'the host knows they did not do it');

    assert.match(toMember, /the host or staff cancelled it/,
        'members are not told which of the two it was');
});

test('the host DM does not tell the host nothing is needed from them', async () => {
    const dms = await cancelAs('staff-member');
    const toHost = dms.find(d => d.userId === 'host').payload;

    assert.ok(!/Nothing else is needed from you/.test(toHost));
    assert.match(toHost, /\/lobby create/, 'points them at starting another');
});

test('a deleted card tells the host, who did not delete it either', async () => {
    sent.length = 0;
    await components.notifyCancelled('900000000000000001', signedUp(), copy.cancelReasonCardGone, {
        notifyHost: true, hostReason: copy.cancelReasonCardGone
    });

    assert.ok(sent.some(d => d.userId === 'host'));
    assert.match(sent.find(d => d.userId === 'host').payload, /its card was deleted/);
});

test('a host who left the server is not DMed', async () => {
    sent.length = 0;
    await components.notifyCancelled('900000000000000001', signedUp(), copy.cancelReasonHostLeft);

    assert.ok(!sent.some(d => d.userId === 'host'), 'they are gone, and it followed from their own leaving');
    assert.deepEqual(sent.map(d => d.userId).sort(), ['a', 'b']);
});

test('omitting the options notifies nobody extra, so old call sites keep their behaviour', async () => {
    sent.length = 0;
    await components.notifyCancelled('900000000000000001', signedUp(), copy.cancelReasonHost);

    assert.ok(!sent.some(d => d.userId === 'host'));
});

test('a lobby nobody joined still reaches the host when staff cancels it', async () => {
    sent.length = 0;
    await components.notifyCancelled(
        '900000000000000001',
        signedUp({ players: ['host'], maybes: [], waitlist: [] }),
        copy.cancelReasonHost,
        { notifyHost: true, hostReason: copy.cancelReasonStaff }
    );

    assert.deepEqual(sent.map(d => d.userId), ['host'],
        'the early return on an empty recipient list must not skip the host');
});

test('the host reason reads as a sentence fragment like the others', () => {
    assert.match(copy.cancelledHostDm('G', 'S', copy.cancelReasonStaff, 1), /cancelled because \w/);
    assert.equal(copy.cancelReasonStaff, 'a staff member cancelled it');
});
