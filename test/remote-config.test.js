const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), `remote-config-${process.pid}-`));
process.env.REMOTE_CONFIG_CACHE_PATH = path.join(TEMP, 'default-cache.json');

const { test, after } = require('node:test');
const assert = require('node:assert');
const api = require('../lib/remote-config/api');
const { createCache } = require('../lib/remote-config/cache');
const { createRemoteConfig, ALERT_AFTER_MS, ALERT_EVERY_MS } = require('../lib/remote-config');

after(() => fs.rmSync(TEMP, { recursive: true, force: true }));

const COMMUNITY = 'vicegamers';
const GOOD_BODY = {
    community: COMMUNITY,
    minecraft: { channel_id: '123456789012345678', invite_url: 'https://realms.gg/EXAMPLE', link_unavailable: false }
};

const quietLog = { log() {}, warn() {}, error() {} };

let fileCounter = 0;
function tempPath() {
    fileCounter += 1;
    return path.join(TEMP, `cache-${fileCounter}.json`);
}

// ---------------------------------------------------------------------------
// interpretResponse / fetchBotConfig
// ---------------------------------------------------------------------------

test('a 200 JSON body for the right community is ok', () => {
    const result = api.interpretResponse(COMMUNITY, 200, JSON.stringify(GOOD_BODY));
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.body, GOOD_BODY);
});

test('refusals, errors, bad JSON and the wrong community are all unavailable', () => {
    const cases = [
        [401, JSON.stringify(GOOD_BODY)],
        [403, JSON.stringify(GOOD_BODY)],
        [500, 'oops'],
        [200, '<html>not json</html>'],
        [200, '[]'],
        [200, 'null'],
        [200, JSON.stringify({ ...GOOD_BODY, community: 'vicecreators' })],
        [200, JSON.stringify({ minecraft: null })]
    ];

    for (const [status, text] of cases) {
        assert.equal(api.interpretResponse(COMMUNITY, status, text).status, 'unavailable', `${status} ${text}`);
    }
});

test('fetchBotConfig maps a stubbed transport and sends the secret', async () => {
    const previous = process.env.BOT_API_SECRET;
    process.env.BOT_API_SECRET = 'test-secret';

    try {
        let seen;
        const ok = await api.fetchBotConfig(COMMUNITY, {
            transport: async options => {
                seen = options;
                return { statusCode: 200, text: JSON.stringify(GOOD_BODY) };
            }
        });
        assert.equal(ok.status, 'ok');
        assert.equal(seen.headers['X-Bot-Secret'], 'test-secret');
        assert.equal(seen.path, '/api/bot-config/?community=vicegamers');
        assert.equal(seen.hostname, 'api.vicers.net');

        const refused = await api.fetchBotConfig(COMMUNITY, { transport: async () => ({ statusCode: 401, text: '' }) });
        assert.equal(refused.status, 'unavailable');

        const thrown = await api.fetchBotConfig(COMMUNITY, { transport: async () => { throw new Error('ECONNRESET'); } });
        assert.equal(thrown.status, 'unavailable');
        assert.match(thrown.reason, /ECONNRESET/);
    } finally {
        if (previous === undefined) delete process.env.BOT_API_SECRET;
        else process.env.BOT_API_SECRET = previous;
    }
});

test('fetchBotConfig without a secret never calls the API', async () => {
    const previous = process.env.BOT_API_SECRET;
    delete process.env.BOT_API_SECRET;

    try {
        let called = false;
        const result = await api.fetchBotConfig(COMMUNITY, { transport: async () => { called = true; } });
        assert.equal(result.status, 'unavailable');
        assert.equal(called, false);
    } finally {
        if (previous !== undefined) process.env.BOT_API_SECRET = previous;
    }
});

// The real transport, against a local plain-http server.
function withServer(handler, run) {
    return new Promise((resolve, reject) => {
        const server = http.createServer(handler);
        server.listen(0, '127.0.0.1', async () => {
            try {
                resolve(await run(server.address().port));
            } catch (error) {
                reject(error);
            } finally {
                server.closeAllConnections?.();
                server.close();
            }
        });
    });
}

test('the real transport reads a body and gives up on a slow server', async () => {
    const previous = process.env.BOT_API_SECRET;
    process.env.BOT_API_SECRET = 'test-secret';

    const transport = options => api.httpsTransport({ ...options, lib: http });

    try {
        await withServer((req, res) => {
            assert.equal(req.headers['x-bot-secret'], 'test-secret');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(GOOD_BODY));
        }, async port => {
            const result = await api.fetchBotConfig(COMMUNITY, { transport, hostname: '127.0.0.1', port });
            assert.equal(result.status, 'ok');
        });

        await withServer(() => { /* never answers */ }, async port => {
            const result = await api.fetchBotConfig(COMMUNITY, { transport, hostname: '127.0.0.1', port, timeoutMs: 100 });
            assert.equal(result.status, 'unavailable');
            assert.match(result.reason, /did not answer/);
        });
    } finally {
        if (previous === undefined) delete process.env.BOT_API_SECRET;
        else process.env.BOT_API_SECRET = previous;
    }
});

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

test('the cache round-trips through disk', () => {
    const file = tempPath();
    const first = createCache(file);
    first.load();
    assert.equal(first.get(COMMUNITY), null);

    first.set(COMMUNITY, GOOD_BODY, 1000);

    const second = createCache(file);
    second.load();
    assert.deepEqual(second.get(COMMUNITY), { body: GOOD_BODY, fetchedAt: 1000 });
    assert.equal(fs.existsSync(`${file}.tmp`), false);
});

test('a corrupt cache is set aside, not overwritten', () => {
    const file = tempPath();
    fs.writeFileSync(file, '{ not json');

    const cache = createCache(file);
    const result = cache.load();

    assert.equal(result.ok, false);
    assert.equal(cache.get(COMMUNITY), null);
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.readFileSync(result.movedTo, 'utf8'), '{ not json');
});

// ---------------------------------------------------------------------------
// The poller
// ---------------------------------------------------------------------------

function build({ results, file = tempPath(), notes = [] }) {
    const cache = createCache(file);
    cache.load();

    let call = 0;
    const consumed = [];

    const rc = createRemoteConfig({
        communities: [{ guildId: 'guild-vg', community: COMMUNITY }],
        cache,
        fetchConfig: async () => results[Math.min(call++, results.length - 1)],
        notifyStaff: async (guildId, options) => { notes.push({ guildId, ...options }); },
        log: quietLog
    });
    rc.registerConsumer((guildId, community) => {
        consumed.push({ guildId, community, view: rc.get(community) });
    });

    return { rc, cache, consumed, notes, file };
}

const OK = { status: 'ok', body: GOOD_BODY };
const DOWN = { status: 'unavailable', reason: 'timeout' };

test('a good refresh is fresh, cached, and runs the consumers', async () => {
    const { rc, consumed, file } = build({ results: [OK] });
    await rc.refresh(0);

    assert.deepEqual(rc.get(COMMUNITY).config, GOOD_BODY);
    assert.equal(rc.get(COMMUNITY).stale, false);
    assert.equal(consumed.length, 1);
    assert.equal(consumed[0].guildId, 'guild-vg');
    assert.ok(fs.existsSync(file));
});

test('an outage serves the last good copy, flagged stale, and still runs the consumers', async () => {
    const { rc, consumed } = build({ results: [OK, DOWN] });
    await rc.refresh(0);
    await rc.refresh(1);

    const view = rc.get(COMMUNITY);
    assert.deepEqual(view.config, GOOD_BODY);
    assert.equal(view.stale, true);
    assert.equal(consumed.length, 2);
});

test('an outage with no copy is null, never an empty config', async () => {
    const { rc, consumed } = build({ results: [DOWN] });
    await rc.refresh(0);

    assert.equal(rc.get(COMMUNITY).config, null);
    assert.equal(consumed.length, 1);
    assert.equal(consumed[0].view.config, null);
});

test('a refusal does not replace the last good copy either', async () => {
    const { rc } = build({ results: [OK, { status: 'unavailable', reason: 'the API answered 403' }] });
    await rc.refresh(0);
    await rc.refresh(1);
    assert.deepEqual(rc.get(COMMUNITY).config, GOOD_BODY);
});

test('a restart during an outage still runs from the disk cache', async () => {
    const file = tempPath();
    const before = build({ results: [OK], file });
    await before.rc.refresh(0);

    const restarted = build({ results: [DOWN], file });
    // Before any fetch: the copy from disk, stale.
    assert.deepEqual(restarted.rc.get(COMMUNITY).config, GOOD_BODY);
    assert.equal(restarted.rc.get(COMMUNITY).stale, true);

    await restarted.rc.refresh(10);
    assert.deepEqual(restarted.consumed[0].view.config, GOOD_BODY);
});

test('a consumer that throws does not stop the others', async () => {
    const { rc, consumed } = build({ results: [OK] });
    rc.registerConsumer(() => { throw new Error('boom'); });
    rc.registerConsumer(() => { consumed.push('after'); });

    await rc.refresh(0);
    assert.deepEqual(consumed.slice(1), ['after']);
});

test('staff hear about an outage after an hour, then at most every six hours, then the recovery', async () => {
    const { rc, notes } = build({ results: [DOWN, DOWN, DOWN, DOWN, DOWN, OK] });
    const MIN = 60 * 1000;

    await rc.refresh(0);
    await rc.refresh(30 * MIN);
    assert.equal(notes.length, 0);

    await rc.refresh(ALERT_AFTER_MS + MIN);
    assert.equal(notes.length, 1);
    assert.equal(notes[0].title, 'Bot Config Unreachable');
    assert.equal(notes[0].guildId, 'guild-vg');

    await rc.refresh(ALERT_AFTER_MS + 2 * 60 * MIN);
    assert.equal(notes.length, 1);

    await rc.refresh(ALERT_AFTER_MS + MIN + ALERT_EVERY_MS);
    assert.equal(notes.length, 2);

    await rc.refresh(ALERT_AFTER_MS + MIN + ALERT_EVERY_MS + 10 * MIN);
    assert.equal(notes.length, 3);
    assert.equal(notes[2].title, 'Bot Config Reachable Again');
});

test('a short blip is never reported', async () => {
    const { rc, notes } = build({ results: [DOWN, OK] });
    await rc.refresh(0);
    await rc.refresh(10 * 60 * 1000);
    assert.equal(notes.length, 0);
});

test('communityFor maps only the configured guild', () => {
    const { rc } = build({ results: [OK] });
    assert.equal(rc.communityFor('guild-vg'), COMMUNITY);
    assert.equal(rc.communityFor('guild-vc'), null);
});
