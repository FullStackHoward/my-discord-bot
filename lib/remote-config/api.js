// ---------------------------------------------------------------------------
// Remote config: the one call to the Vicers API
// ---------------------------------------------------------------------------
//
// GET /api/bot-config/?community=<slug>, with the shared X-Bot-Secret header. Raw https,
// matching lib/announcements.js and the arcade bot's client.
//
// The rule that matters, carried over from the arcade bot: a refusal and an outage are
// both "unavailable" here, and neither is ever an empty config. Only a 2xx JSON body for
// the community that was asked for is "ok". Never throws.

const https = require('https');

const API_HOST = 'api.vicers.net';
const API_PATH = '/api/bot-config/';

// Long enough for a cold Gunicorn worker, short enough that a dead API cannot stall the
// poller into overlapping with itself.
const TIMEOUT_MS = 15000;

// The real body is a few hundred bytes. Anything enormous is not our API.
const MAX_BODY_BYTES = 1024 * 1024;

// Pure: maps what the API said onto ok / unavailable.
function interpretResponse(community, statusCode, text) {
    if (!(statusCode >= 200 && statusCode < 300)) {
        return { status: 'unavailable', reason: `the API answered ${statusCode}` };
    }

    let body;
    try {
        body = JSON.parse(text);
    } catch (error) {
        return { status: 'unavailable', reason: 'the API returned a body that is not JSON' };
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return { status: 'unavailable', reason: 'the API returned an unexpected body' };
    }

    if (body.community !== community) {
        return { status: 'unavailable', reason: `the API answered for "${body.community}", not "${community}"` };
    }

    return { status: 'ok', body };
}

// Resolves { statusCode, text } or rejects. `lib` and `port` exist so the tests can point
// it at a local plain-http server.
function httpsTransport({ hostname, port, path, headers, timeoutMs = TIMEOUT_MS, lib = https }) {
    return new Promise((resolve, reject) => {
        let call;

        try {
            call = lib.request({ hostname, port, path, method: 'GET', headers }, response => {
                let text = '';
                let bytes = 0;

                response.setEncoding('utf8');
                response.on('data', chunk => {
                    bytes += Buffer.byteLength(chunk);
                    if (bytes > MAX_BODY_BYTES) {
                        call.destroy(new Error('the API response was too large'));
                        return;
                    }
                    text += chunk;
                });
                response.on('end', () => resolve({ statusCode: response.statusCode, text }));
                response.on('error', reject);
            });
        } catch (error) {
            reject(error);
            return;
        }

        call.setTimeout(timeoutMs, () => {
            call.destroy(new Error(`the API did not answer within ${Math.round(timeoutMs / 1000)} seconds`));
        });
        call.on('error', reject);
        call.end();
    });
}

async function fetchBotConfig(community, { transport = httpsTransport, hostname = API_HOST, port, timeoutMs } = {}) {
    const secret = process.env.BOT_API_SECRET;
    if (!secret) return { status: 'unavailable', reason: 'BOT_API_SECRET is not set' };

    try {
        const { statusCode, text } = await transport({
            hostname,
            port,
            path: `${API_PATH}?community=${encodeURIComponent(community)}`,
            headers: { 'X-Bot-Secret': secret, Accept: 'application/json' },
            timeoutMs
        });

        return interpretResponse(community, statusCode, text);
    } catch (error) {
        return { status: 'unavailable', reason: `could not reach the API: ${error.message}` };
    }
}

module.exports = {
    API_HOST,
    API_PATH,
    TIMEOUT_MS,
    interpretResponse,
    httpsTransport,
    fetchBotConfig,
};
