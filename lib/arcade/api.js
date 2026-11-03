// ---------------------------------------------------------------------------
// The arcade's side of the Vicers API
// ---------------------------------------------------------------------------
//
// Raw https with the shared X-Bot-Secret header, matching lib/announcements.js and
// lib/radar/game-digest. No new dependency for what is a dozen calls.
//
// One distinction is load-bearing throughout this module: a refusal and an outage are
// not the same event. A 404 for a score means the score is gone; a timeout means we do
// not know. The departure path in particular must never read "could not reach the API"
// as "nothing to remove", so every caller gets told which happened.

const https = require('https');

const API_HOST = 'api.vicers.net';
const BASE_PATH = '/api/arcade';

// Long enough for a cold Gunicorn worker, short enough that a dead API cannot stall the
// poll loop into overlapping with itself.
const TIMEOUT_MS = 15000;

class ArcadeApiError extends Error {
    constructor(message, { status = 0, body = '' } = {}) {
        super(message);
        this.name = 'ArcadeApiError';
        this.status = status;
        this.body = body;
        // A status means the API answered and said no. No status means it never answered,
        // which is never grounds for acting as though the answer were negative.
        this.answered = status > 0;
    }
}

function request(method, path, payload = null) {
    const body = payload === null ? null : JSON.stringify(payload);

    const headers = { 'X-Bot-Secret': process.env.BOT_API_SECRET };

    if (body !== null) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(body);
    }

    const options = { hostname: API_HOST, path: `${BASE_PATH}${path}`, method, headers };

    return new Promise((resolve, reject) => {
        const call = https.request(options, response => {
            let text = '';

            response.on('data', chunk => { text += chunk; });
            response.on('end', () => {
                const ok = response.statusCode >= 200 && response.statusCode < 300;

                if (!ok) {
                    reject(new ArcadeApiError(
                        `The arcade API answered ${response.statusCode}`,
                        { status: response.statusCode, body: text.slice(0, 500) }
                    ));
                    return;
                }

                if (!text) {
                    resolve(null);
                    return;
                }

                try {
                    resolve(JSON.parse(text));
                } catch (error) {
                    reject(new ArcadeApiError('The arcade API returned a body that is not JSON'));
                }
            });
        });

        call.setTimeout(TIMEOUT_MS, () => {
            call.destroy(new ArcadeApiError('The arcade API timed out'));
        });

        call.on('error', error => {
            reject(error instanceof ArcadeApiError
                ? error
                : new ArcadeApiError(`Could not reach the arcade API: ${error.message}`));
        });

        if (body !== null) call.write(body);
        call.end();
    });
}

module.exports = {
    ArcadeApiError,

    pendingEvents: () => request('GET', '/events/pending'),
    ackEvent: (id) => request('POST', `/events/${id}/ack`),

    currentPodium: () => request('GET', '/podium/current'),
    liveStandings: () => request('GET', '/standings/live'),

    closingSeasons: () => request('GET', '/seasons/closing'),
    seasonPreview: (id) => request('GET', `/seasons/${id}/preview`),
    finalizeSeason: (id, winners) => request('POST', `/seasons/${id}/finalize`, { winners }),

    dailyBoard: (slug, day) => request('GET', `/daily/${encodeURIComponent(slug)}/${encodeURIComponent(day)}`),
    recordPostedMessages: (boardId, messageIds) =>
        request('POST', `/daily/${boardId}/posted`, { message_ids: messageIds }),

    approveScore: (id) => request('POST', `/scores/${id}/approve`),
    removeScore: (id) => request('POST', `/scores/${id}/remove`),

    reportDepartures: (departures) => request('POST', '/members/departed', { departures }),
    activePlayers: () => request('GET', '/players/active')
};
