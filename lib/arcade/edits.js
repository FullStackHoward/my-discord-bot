// ---------------------------------------------------------------------------
// Correcting daily boards that are already posted
// ---------------------------------------------------------------------------
//
// A posted board is a leaderboard, so when a player leaves it gets corrected rather
// than left to contradict the live boards. This is the one place the arcade edits
// history it has already published.
//
// Serial with a fixed gap, by construction. A /purge can touch many messages at once,
// and the concern is Discord's per-channel edit bucket; a queue that cannot overtake
// itself cannot burst into a rate limit, whereas a token bucket sized wrongly can. The
// cost is that a large correction takes a while, which nobody is watching.
//
// Removing a player can only shrink a board, never grow it, so extra messages are
// deleted and none are ever added.

const { ARCADE_EDIT_GAP_MS } = require('../config');
const { sleep } = require('../utils');

const api = require('./api');
const posts = require('./posts');

// One worker, started on demand. Everything queued while it runs joins the same pass.
const queue = [];
let working = false;

async function editBoard(channel, board) {
    // Re-read rather than trusting the event payload: by the time this runs, several
    // departures may have landed and the board on disk is the current truth.
    let fresh;

    try {
        fresh = await api.dailyBoard(board.game_slug, board.day);
    } catch (error) {
        console.error(`Vice Arcade: could not re-read the ${board.game_slug} board for ${board.day}: ${error.message}`);
        return;
    }

    const existing = (fresh.message_ids || board.message_ids || []).map(String);

    if (existing.length === 0) return;

    const entries = fresh.entries || [];

    // Nobody left on it. The post is deleted rather than left saying "Nobody played",
    // which would be a stranger artefact than its absence.
    if (entries.length === 0) {
        for (const id of existing) {
            await deleteMessage(channel, id);
            await sleep(ARCADE_EDIT_GAP_MS);
        }

        await recordIds(fresh.board_id, []);
        return;
    }

    const messages = posts.dailyBoardMessages({
        gameName: fresh.game?.display_name || board.game_display_name || board.game_slug,
        day: fresh.day || board.day,
        entries,
        resetsAt: fresh.resets_at || null
    });

    const kept = [];

    for (const [index, id] of existing.entries()) {
        if (index >= messages.length) {
            await deleteMessage(channel, id);
            await sleep(ARCADE_EDIT_GAP_MS);
            continue;
        }

        const edited = await editMessage(channel, id, messages[index]);
        if (edited) kept.push(id);

        await sleep(ARCADE_EDIT_GAP_MS);
    }

    if (kept.length !== existing.length) await recordIds(fresh.board_id, kept);
}

async function editMessage(channel, id, payload) {
    try {
        const message = await channel.messages.fetch(id);
        await message.edit(payload);
        return true;
    } catch (error) {
        // A message that is no longer there is skipped, not retried. Somebody deleted
        // it, and recreating it would be a surprise.
        return false;
    }
}

async function deleteMessage(channel, id) {
    try {
        const message = await channel.messages.fetch(id);
        await message.delete();
    } catch {
        // Already gone. Nothing to do.
    }
}

async function recordIds(boardId, ids) {
    if (!boardId) return;

    try {
        await api.recordPostedMessages(boardId, ids);
    } catch (error) {
        console.error(`Vice Arcade: could not record message ids for board ${boardId}: ${error.message}`);
    }
}

async function drain() {
    if (working) return;

    working = true;

    try {
        while (queue.length > 0) {
            const { channel, board } = queue.shift();
            await editBoard(channel, board);
        }
    } finally {
        working = false;
    }
}

// Boards from a daily_boards_changed event. Returns once they are queued, not once they
// are done: the poll loop must not be held up by a long correction.
function enqueue(channel, boards) {
    for (const board of boards) queue.push({ channel, board });

    void drain();

    return queue.length;
}

function pending() {
    return queue.length;
}

module.exports = { enqueue, pending, editBoard };
