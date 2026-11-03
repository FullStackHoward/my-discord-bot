// The Vice Arcade bot's entrypoint, with Discord and lib/arcade stubbed out.
//
// arcade.js is wiring only, but one line of it can do real damage: the Vice Arcade
// application's single global command is /arcade, the Entry Point that launches the
// Activity, and registering /arcade-review with a global set() would replace that list
// and delete it. Nothing else in the repo would notice until members could not open the
// arcade.

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
const registrations = [];
const reviewed = [];
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
            set: async (commands, guildId) => { registrations.push({ commands, guildId }); }
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

stub('../lib/arcade/commands', {
    ARCADE_REVIEW_COMMAND: { name: 'arcade-review' },
    handleArcadeReviewCommand: async interaction => { reviewed.push(interaction.commandName); }
});

require('../arcade');

test('it logs in with the Vice Arcade token and marks itself as the arcade process', () => {
    assert.equal(loggedInWith, 'test-arcade-token');
    assert.equal(process.env.BOT_PROCESS, 'arcade');
});

test('/arcade-review is registered in Vice Gamers only, never globally', async () => {
    handlers.get('ready')();
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(registrations.length, 1);
    assert.equal(registrations[0].guildId, GUILD, 'a global set() would delete the /arcade Entry Point');
    assert.deepEqual(registrations[0].commands.map(command => command.name), ['arcade-review']);
    assert.equal(started, 1, 'the arcade loops start on ready');
});

test('only /arcade-review is routed to the review handler', async () => {
    const interaction = name => ({ isChatInputCommand: () => true, commandName: name });

    await handlers.get('interactionCreate')(interaction('arcade-review'));
    await handlers.get('interactionCreate')(interaction('lobby'));

    assert.deepEqual(reviewed, ['arcade-review']);
});

test('a departure is passed straight to the arcade', async () => {
    await handlers.get('guildMemberRemove')({ id: '42', guild: { id: GUILD } });

    assert.deepEqual(departures, ['42']);
});
