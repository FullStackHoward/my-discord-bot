// The intents the bot logs in with. Dropping one silently breaks the feature that
// relies on it, with nothing else in this repo to catch it.

const { test } = require('node:test');
const assert = require('node:assert');
const { GatewayIntentBits, Partials } = require('discord.js');

async function clientOptions() {
    const filename = require.resolve('../lib/client');
    delete require.cache[filename];

    const client = require('../lib/client');
    const options = { intents: client.options.intents, partials: client.options.partials };

    // Constructing a client starts its cache sweepers, which would hold the test open.
    await client.destroy();
    delete require.cache[filename];

    return options;
}

test('the bot keeps every intent its features rely on', async () => {
    const { intents, partials } = await clientOptions();

    for (const intent of ['Guilds', 'GuildMessages', 'MessageContent', 'GuildMembers',
        'GuildPresences', 'GuildScheduledEvents', 'GuildVoiceStates']) {
        assert.ok(intents.has(GatewayIntentBits[intent]), `${intent} is missing`);
    }

    assert.ok(partials.includes(Partials.User), 'RSVPs from uncached users would be dropped');
});
