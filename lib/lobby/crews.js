// ---------------------------------------------------------------------------
// Crews: the "play again" group that forms itself
// ---------------------------------------------------------------------------
//
// Pure decision logic. The caller owns state mutation and Discord posting.

const { LOBBY_CREW_MAX_MEMBERS, LOBBY_MAX_CREWS_PER_MEMBER } = require('../config');

// Who is allowed to press Play again: whoever actually showed, or - when nobody
// confirmed attendance - everyone who was confirmed for the lobby.
function eligibleVoters(lobby) {
    const showed = lobby.attendance?.showed || [];
    if (lobby.attendance?.source && showed.length > 0) return showed;

    return lobby.players;
}

function canVote(lobby, userId) {
    return eligibleVoters(lobby).includes(userId);
}

// Same members and same game means the same crew, so pressing again after a rematch does
// not pile up duplicates.
function findExistingCrew(crews, gameKey, members) {
    const wanted = [...members].sort().join(',');

    for (const [id, crew] of Object.entries(crews || {})) {
        if (crew.gameKey !== gameKey) continue;
        if ([...crew.members].sort().join(',') === wanted) return { id, ...crew };
    }

    return null;
}

// { shouldCreate, members, reason }
function evaluateCrewFormation(lobby, crews, crewCountsByMember) {
    const votes = (lobby.againVotes || []).filter(userId => canVote(lobby, userId));

    if (votes.length < 2) return { shouldCreate: false, reason: 'notEnoughVotes', members: [] };

    // First six pressers, and only those still under their crew cap.
    const members = votes
        .filter(userId => (crewCountsByMember[userId] || 0) < LOBBY_MAX_CREWS_PER_MEMBER)
        .slice(0, LOBBY_CREW_MAX_MEMBERS);

    if (members.length < 2) return { shouldCreate: false, reason: 'capped', members: [] };

    const existing = findExistingCrew(crews, lobby.gameKey, members);
    if (existing) return { shouldCreate: false, reason: 'exists', members, existing };

    return { shouldCreate: true, reason: null, members };
}

function crewName(gameLabel) {
    return `${gameLabel} crew`.slice(0, 80);
}

function countCrewsByMember(crews) {
    const counts = {};

    for (const crew of Object.values(crews || {})) {
        for (const userId of crew.members || []) {
            counts[userId] = (counts[userId] || 0) + 1;
        }
    }

    return counts;
}

module.exports = {
    eligibleVoters,
    canVote,
    findExistingCrew,
    evaluateCrewFormation,
    crewName,
    countCrewsByMember,
};
