// The intents each process logs in with.
//
// Two Discord applications share lib/client: Vice Verify Bot and the Vice Arcade bot. An
// intent the application has not been granted in the Developer Portal fails the login,
// so the arcade asking for the verify bot's Presence or Message Content intent would stop
// the whole arcade bot from coming up, with nothing in this repo to catch it.

const { test } = require('node:test');
const assert = require('node:assert');
const { GatewayIntentBits, Partials } = require('discord.js');

async function clientFor(botProcess) {
    const filename = require.resolve('../lib/client');
    delete require.cache[filename];

    if (botProcess) process.env.BOT_PROCESS = botProcess;
    else delete process.env.BOT_PROCESS;

    const client = require('../lib/client');
    const options = { intents: client.options.intents, partials: client.options.partials };

    // Constructing a client starts its cache sweepers, which would hold the test open.
    await client.destroy();
    delete require.cache[filename];

    return options;
}

test('the arcade bot asks for Server Members and nothing else privileged', async () => {
    const { intents } = await clientFor('arcade');

    assert.ok(intents.has(GatewayIntentBits.Guilds));
    assert.ok(intents.has(GatewayIntentBits.GuildMembers), 'departures and the role reconcile need it');
    assert.ok(!intents.has(GatewayIntentBits.GuildPresences), 'Presence is not granted to the arcade');
    assert.ok(!intents.has(GatewayIntentBits.MessageContent), 'Message Content is not granted to the arcade');
});

test('the arcade bot sees a departure of a member it never cached', async () => {
    const { partials } = await clientFor('arcade');

    assert.ok(partials.includes(Partials.GuildMember));
});

test('the verify bot keeps every intent its features rely on', async () => {
    const { intents, partials } = await clientFor(undefined);

    for (const intent of ['Guilds', 'GuildMessages', 'MessageContent', 'GuildMembers',
        'GuildPresences', 'GuildScheduledEvents', 'GuildVoiceStates']) {
        assert.ok(intents.has(GatewayIntentBits[intent]), `${intent} is missing`);
    }

    assert.ok(partials.includes(Partials.User), 'RSVPs from uncached users would be dropped');
});
