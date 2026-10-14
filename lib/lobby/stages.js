// ---------------------------------------------------------------------------
// Reminder stage decisions
// ---------------------------------------------------------------------------
//
// Pure, so the timing rules can be tested as a table rather than by waiting on a sweep.
//
// There are two stages now, not three: one reminder an hour before the start, then the
// start post itself.

// 'none'  the reminder has already been handled
// 'wait'  too early; the sweep will come back
// 'post'  send it
// 'skip'  mark it handled but send nothing
//
// 'skip' covers two cases that both deserve silence rather than a message:
//   - the start time has already passed, so a reminder would be noise
//   - the lobby was created inside the reminder window, so a reminder would arrive
//     within moments of the card itself. /lobby now always lands here.
function reminderAction(lobby, now, reminderMinutes) {
    if (!lobby || !lobby.stages) return 'none';
    if (lobby.stages.reminded) return 'none';

    const windowMs = reminderMinutes * 60 * 1000;
    const remindAt = lobby.startsAt - windowMs;

    if (now < remindAt) return 'wait';
    if (now >= lobby.startsAt) return 'skip';

    // Booked with less lead time than the reminder window itself.
    if (lobby.startsAt - lobby.createdAt < windowMs) return 'skip';

    return 'post';
}

module.exports = { reminderAction };
