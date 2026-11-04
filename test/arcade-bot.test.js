// The Vice Arcade bot's entrypoint, with Discord and lib/arcade stubbed out.
//
// arcade.js is wiring only. It registers no slash commands; on login it deletes the
// retired /arcade-review from Vice Gamers by name, and must never touch any other
// command: the Vice Arcade application's global list holds /arcade, the Entry Point
// that launches the Activity, and other guild commands may belong to the arcade API.

const GUILD = '800000000000000001';

process.env.VG_GUILD_ID = GUILD;
process.env.VICE_ARCADE_BOT_TOKEN = 'test-arcade-token';

const { test } = require('node:test');
const assert = require('node:assert');

function stub(request, exports) {
    const filename = require.resolve(request);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const handlers = new Map();
const deleted = [];
const registered = new Map([
    ['1', { id: '1', name: 'arcade-review' }],
    ['2', { id: '2', name: 'arcade-wipe' }]
]);
const departures = [];
let loggedInWith = null;
let started = 0;

stub('../lib/client', {
    once: (event, handler) => handlers.set(event, handler),
    on: (event, handler) => handlers.set(event, handler),
    login: token => { loggedInWith = token; },
    user: { tag: 'Vice Arcade#0000' },
    application: {
        commands: {
            fetch: async ({ guildId }) => (guildId === GUILD ? registered : new Map()),
            delete: async (id, guildId) => { deleted.push({ id, guildId }); },
            set: async () => { throw new Error('arcade.js must not bulk-overwrite commands'); }
        }
    }
});

stub('../lib/staff-log', {
    sendStaffLog: async () => {},
    sendStaffLogToAllServers: async () => {},
    errorField: () => ({})
});

stub('../lib/arcade', {
    arcadeConfigFor: guildId => (guildId === GUILD ? { channelId: '1' } : null),
    start: () => { started += 1; },
    stop: () => {},
    handleGuildMemberRemove: async member => { departures.push(member.id); }
});

require('../arcade');

test('it logs in with the Vice Arcade token and marks itself as the arcade process', () => {
    assert.equal(loggedInWith, 'test-arcade-token');
    assert.equal(process.env.BOT_PROCESS, 'arcade');
});

test('on login the retired /arcade-review is deleted from Vice Gamers, and nothing else', async () => {
    handlers.get('ready')();
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(deleted, [{ id: '1', guildId: GUILD }]);
    assert.equal(started, 1, 'the arcade loops start on ready');
});

test('it no longer listens for slash commands at all', () => {
    assert.equal(handlers.has('interactionCreate'), false);
});

test('a departure is passed straight to the arcade', async () => {
    await handlers.get('guildMemberRemove')({ id: '42', guild: { id: GUILD } });

    assert.deepEqual(departures, ['42']);
});
