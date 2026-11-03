// ---------------------------------------------------------------------------
// Catching players who leave Vice Gamers
// ---------------------------------------------------------------------------
//
// Anyone not in the server appears on no leaderboard, which makes this the only
// destructive path in the arcade. Everything here is shaped by one asymmetry: failing
// to notice a departure leaves a stale name on a board for a while, while wrongly
// concluding somebody left wipes a real player's scores. The second is far worse, so
// every uncertainty resolves towards doing nothing.
//
// Four ways a departure is caught, per the amendment:
//
//   1. The guildMemberRemove listener, reported immediately with no debounce. A failed
//      report is queued to disk and retried, because the event happens once.
//   2. The startup sweep, so a departure during downtime does not wait for the daily run.
//   3. The daily sweep, comparing the API's visible players against the real member list.
//   4. The winner check before a round callout, so a leaver is never called out.
//
// Vice Gamers only. Leaving Vice Creators or the Application Server changes nothing.

const {
    VG_GUILD_ID,
    ARCADE_MEMBER_FETCH_MIN_RATIO
} = require('../config');
const { fetchMembersWithRatio, resolveGuild } = require('../utils');

const api = require('./api');
const state = require('./state');

// Discord's error code for a member or user that is not there. The one reply that means
// "this player has really gone"; every other failure means we do not know.
const UNKNOWN_MEMBER = 10007;
const UNKNOWN_USER = 10013;

function isUnknownMember(error) {
    return error?.code === UNKNOWN_MEMBER || error?.code === UNKNOWN_USER;
}

function entry(discordUserId, leftAt = new Date()) {
    return { discord_user_id: String(discordUserId), left_at: new Date(leftAt).toISOString() };
}

// Reports a batch, queueing it for retry if the API could not be reached. Returns what
// happened so a caller can log it.
async function report(entries) {
    if (entries.length === 0) return { reported: 0, queued: 0 };

    try {
        const result = await api.reportDepartures(entries);

        return {
            reported: entries.length,
            queued: 0,
            scoresRemoved: result?.scores_removed ?? 0,
            boardsChanged: result?.boards_changed ?? 0
        };
    } catch (error) {
        // The call is safe to repeat, so queueing a report that may actually have
        // landed costs nothing.
        state.queueDepartures(entries);
        console.error(`Vice Arcade: could not report ${entries.length} departure(s), queued for retry: ${error.message}`);

        return { reported: 0, queued: entries.length };
    }
}

// 1. The listener. No debounce: a burst of leaves is a burst of reports, and the API
// handles each one idempotently. Debouncing here would only delay the boards catching up.
async function handleGuildMemberRemove(member) {
    if (member?.guild?.id !== VG_GUILD_ID) return;

    await report([entry(member.id)]);
}

// Retried on every poll. Cheap when the queue is empty, which it almost always is.
async function flushQueue() {
    const queued = state.takeDepartures();

    if (queued.length === 0) return { reported: 0, queued: 0 };

    return report(queued);
}

// 3. The sweep. Asks the API who it still shows, compares against the real member list,
// and reports the difference.
//
// The guard is the whole point: if the member list comes back short, every current
// member looks departed and the sweep would wipe the entire leaderboard. It abandons
// instead, and says so loudly enough to be noticed.
async function runSweep({ dryRun = false } = {}) {
    const guild = await resolveGuild(VG_GUILD_ID);

    if (!guild) return { aborted: true, reason: 'Vice Gamers is not available to the bot.' };

    let active;

    try {
        const payload = await api.activePlayers();
        active = payload?.discord_user_ids || [];
    } catch (error) {
        return { aborted: true, reason: `The arcade API could not be read (${error.message}), so nothing was swept.` };
    }

    if (active.length === 0) return { aborted: false, departed: [], checked: 0, dryRun };

    const fetched = await fetchMembersWithRatio(guild, ARCADE_MEMBER_FETCH_MIN_RATIO);

    if (fetched.error) {
        return { aborted: true, reason: `The member list could not be fetched (${fetched.error.message}), so nothing was swept.` };
    }

    if (!fetched.ok) {
        return {
            aborted: true,
            reason: `The member list came back short (${fetched.fetched} of about ${fetched.expected}, `
                + `${Math.round(fetched.ratio * 100)}%). Treating current members as departed would wipe `
                + 'real scores, so the sweep was abandoned.'
        };
    }

    const departed = active.filter(id => !fetched.members.has(id));

    if (departed.length === 0 || dryRun) {
        return { aborted: false, departed, checked: active.length, dryRun };
    }

    const outcome = await report(departed.map(id => entry(id)));

    return { aborted: false, departed, checked: active.length, dryRun, ...outcome };
}

// 4. The winner check, run before a round is finalized and called out.
//
// A player Discord says is unknown has left: report them and let the caller ask the API
// for fresh standings. Any other failure, including a timeout, leaves them as unresolved
// and the round is not finalized this pass. Nothing is wiped on an outage, and nobody is
// called out who might not be there.
async function confirmWinners(top) {
    const guild = await resolveGuild(VG_GUILD_ID);

    if (!guild) return { ready: false, winners: [], departed: [], unresolved: top.map(row => row.discord_user_id) };

    const winners = [];
    const departed = [];
    const unresolved = [];

    for (const row of top) {
        try {
            await guild.members.fetch(String(row.discord_user_id));
            winners.push(row);
        } catch (error) {
            if (isUnknownMember(error)) departed.push(String(row.discord_user_id));
            else unresolved.push(String(row.discord_user_id));
        }
    }

    if (departed.length > 0) await report(departed.map(id => entry(id)));

    return {
        // Only safe to finalize when every place resolved one way or the other.
        ready: unresolved.length === 0 && departed.length === 0,
        winners,
        departed,
        unresolved
    };
}

module.exports = {
    UNKNOWN_MEMBER,
    UNKNOWN_USER,
    isUnknownMember,
    entry,
    report,
    handleGuildMemberRemove,
    flushQueue,
    runSweep,
    confirmWinners
};
