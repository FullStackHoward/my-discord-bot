// ---------------------------------------------------------------------------
// Every user-facing string for the LFG feature, in one place
// ---------------------------------------------------------------------------
//
// Kept separate so wording can be reworked without touching logic.

module.exports = {
    // --- availability ---
    availabilityIntro: 'Set when you are usually free, what you play on, and which games you play. Everything saves as you pick it.',
    availabilityNoTimezone: 'Set your time zone first with `/availability timezone` so lobby times show correctly for you.',
    availabilitySaved: 'Saved.',
    availabilityCleared: 'Your LFG profile has been deleted.',
    availabilityClearConfirm: 'This deletes your availability, platforms, games and gamertags. Your lobby history is not affected.',
    tagsIntro: 'These are shared only with people confirmed in the same lobby as you, and only when they press **Show tags**. Leave any blank.',
    tagsSaved: 'Gamertags saved. They are only shown to people in your lobbies.',
    addGameTitle: 'Add a game',
    addGameLabel: 'Game title',
    addGamePlaceholder: 'e.g. Helldivers 2',
    nudgesOn: 'Nudges are **on**. You will get a DM when someone opens a lobby for a game you play, at a time you are usually free.',
    nudgesOff: 'Nudges are **off**. Turn them on to get a DM when a lobby matches your games and availability.',

    // --- lobbies ---
    lobbyNoProfileHint: 'Tip: run `/availability set` so lobbies can match your platform and games.',
    lobbyPlatformMismatch: 'This lobby has crossplay off and none of your platforms match it.',
    lobbyFull: 'That lobby is full, so you have been added to the waitlist.',
    lobbyJoined: 'You are in.',
    lobbyMaybe: 'Marked as maybe. You do not hold a seat.',
    lobbyLeft: 'You have left the lobby.',
    lobbyAlreadyIn: 'You are already confirmed for this lobby.',
    lobbyNotIn: 'You are not in this lobby.',
    lobbyStale: 'This lobby has ended or no longer exists.',
    lobbyLocked: 'Attendance has been recorded, so this lobby is closed.',
    lobbyHostOnly: 'Only the host or staff can do that.',
    lobbyCancelled: 'Lobby cancelled.',
    lobbySeatsBelowConfirmed: 'You cannot set fewer seats than the number of people already confirmed.',
    lobbyNoTags: 'Nobody in this lobby has saved a gamertag for this platform yet.',
    lobbyTagsNotParticipant: 'Only people confirmed in this lobby can see gamertags.',
    lobbyNowExpired: 'Nobody joined, so this lobby has expired.',
    lobbyStartingNow: 'Starting now.',
    lobbyReminderAsk: 'Starting soon.',
    lobbyMinPlayersUnmet: 'This lobby is below its minimum player count.',
    lobbyPromoted: 'A seat opened up and you are in.',
    lobbyCapHost: 'You already have the maximum number of open lobbies. Cancel one first.',
    lobbyCapTotal: 'The server has hit its open lobby limit. Try again once one wraps up.',
    lobbyLeadTooSoon: 'Pick a start time a little further out.',
    lobbyTooFarAhead: 'Pick a start time closer than that.',
    lobbyBadTime: 'That start time could not be read. Pick one from the list.',

    // --- channel guard ---
    // Sent by DM, because Discord's ephemeral flag only exists on interaction responses
    // and a deleted plain message has no interaction to reply to.
    channelGuardDm: channelMention =>
        `Messages are not allowed in ${channelMention}, so yours was removed.\n\n`
        + 'To start a game, use `/lobby create`, or `/lobby now` to play straight away.\n'
        + 'To join one, press **Join** on its card.\n'
        + 'To talk about a game, use the thread attached to that card.\n'
        + 'To set up your profile, use `/availability set`.',

    // --- games ---
    gameRejected: 'That title cannot be used. Use plain text without links or mentions.',
    gameBlocked: 'That title is not available.',
    gameDidYouMean: 'Did you mean',
    gameAddedToProfile: 'Added to your games.',
    gameProfileFull: 'You already have the maximum number of games on your profile. Remove one first.',

    // --- crews ---
    crewFormed: 'crew formed',
    crewCapReached: 'You are already in the maximum number of crews.',
    crewLeft: 'You have left the crew.',

    // --- templates / series ---
    templateSaved: 'Template saved.',
    templateCapReached: 'You already have the maximum number of templates. Delete one first.',
    templateDeleted: 'Template deleted.',
    templateMissing: 'No template with that name.',
    seriesStopped: 'That repeating lobby has been stopped. Any lobby already posted stays as it is.',
    seriesCapReached: 'You already have the maximum number of repeating lobbies.',
    seriesNone: 'You have no repeating lobbies.',

    // --- board ---
    boardTitle: 'Looking for a game',
    boardEmpty: 'No open lobbies right now. Start one with `/lobby create`, or `/lobby now` to play straight away.',
    boardTonight: 'Tonight',
    boardThisWeek: 'This week',
    boardPlayingNow: 'Playing now',
    boardMore: n => `+${n} more`,

    // --- nudges / newcomer ---
    nudgeTitle: 'A lobby matches your games',
    nudgeFooter: 'You are getting this because nudges are on. Turn them off with the button or in /availability set.',
    newcomerTitle: 'Find people to play with',
    newcomerBody: 'Set your availability and the games you play, and the bot will point you at lobbies that fit. It takes about a minute.',
    newcomerButton: 'Set up LFG',

    // --- digest ---
    digestTitle: 'Last week',
};
