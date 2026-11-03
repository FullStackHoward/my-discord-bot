# Vice Arcade: the bot's half

The API owns the leaderboards, the rounds and who is on the podium. This module owns
everything that needs a Discord connection: the posts, the three roles, and telling the
API when somebody leaves the server.

Vice Gamers only. There is no Vice Creators arcade, deliberately, so there is no second
set of boards or roles to drift out of step. Leaving Vice Creators or the Application
Server has no effect on anybody's scores.

## Switching it on

Set these in the server `.env` and restart with PM2. The feature is inert without the
first one.

| Variable | What it is |
|---|---|
| `VG_ARCADE_CHANNEL_ID` | Where records and daily boards are posted, and the only channel play is allowed from. |
| `VG_CHAT_CHANNEL_ID` | Where the end-of-round callout goes. |
| `VG_ARCADE_ROLE_GOLD_ID` | Arcade Champion. |
| `VG_ARCADE_ROLE_SILVER_ID` | Arcade Silver. |
| `VG_ARCADE_ROLE_BRONZE_ID` | Arcade Bronze. |
| `BOT_API_SECRET` | Already present. Authenticates every call to the arcade API. |

Both spellings are read, with and without the `_ID` suffix, so the names in the server
`.env` do not have to be retyped to match the rest of `lib/config.js`.

The bot needs **Manage Roles**, and its own highest role must sit **above** all three
arcade roles. `canManageRole` fails closed: a role above the bot's is left alone and
complained about once an hour rather than attempted every ten minutes.

A missing channel or role is skipped and logged, never substituted. A leaderboard in the
wrong channel is worse than no leaderboard.

## Three loops

`arcade.start(client)` starts all of them.

**The event poll, every 30 seconds.** Drains the API's outbox and acts on each event.
This is the arcade's heartbeat in a stronger sense than it looks: the API opens and
closes rounds lazily, triggered by this very call, so if the poll stops then rounds stop
turning over as well as posts stopping. That is safe, because when the bot is down
nothing needs to turn over.

**Role reconciliation, every 10 minutes.** Makes each role's holders exactly the player
in that slot. Idempotent, which is why it is load-bearing rather than a safety net: at a
reset the new board is empty, the API reports no holders, and the roles come off because
of a pass like this, not because of an event. A missed event, a restart, a role edited by
hand and a holder leaving are all corrected the same way.

**The departure sweep, on boot and daily.** Compares the players the API still shows
against the real member list.

## Events

| Type | What the bot does |
|---|---|
| `new_alltime_record` | Posts in the arcade channel. Written on approval, so nothing is announced unreviewed. |
| `record_pending_review` | DMs the owner the run stats and the score id. Falls back to the staff log if DMs are closed. |
| `daily_board_closed` | Posts the finished day's board, then records the message ids so a departure can edit them. |
| `daily_boards_changed` | Queues edits to those posted messages. |
| `podium_changed` | Moves the roles. Posts nothing. |
| `season_closing` | Confirms the winners, then finalizes. |
| `season_awarded` | Posts the callout in `#chat`, or a correction if the result changed. |

An event type this bot does not know is **left pending**, not acked, and warned about
once. Acking it would lose whatever it was, and an unknown type means the API is ahead of
the bot, which is worth noticing. An event whose handler throws is also left unacked, so
a transient failure retries rather than silently swallowing a record post.

## Why finalizing a round is a handshake

The API cannot see Discord membership, so it closes a round and says so; this module
confirms each winner is still in Vice Gamers before anything is written or called out.

- A winner Discord reports as **Unknown Member** has left. They are reported, which
  recomputes the standings, and the next pass previews a different three. The round is
  not finalized on that pass.
- **Any other failure**, including a timeout, leaves them unresolved. Nothing is wiped
  and nothing is finalized. Calling out somebody who may not be there is worse than
  calling out nobody for another thirty seconds.

By the time the callout goes out, the boards have already reset and the roles have
already come off. The wording says the round has ended for that reason: without it,
members who watched the roles vanish would read the post as a bug.

## Departures, and the one thing to be careful about

Anyone not in the server appears on no leaderboard, which makes this the only destructive
path in the arcade. Everything here is shaped by one asymmetry:

> Failing to notice a departure leaves a stale name on a board for a while. Wrongly
> concluding somebody left wipes a real player's scores.

So every uncertainty resolves towards doing nothing. In particular, the sweep **abandons
itself** when the member list comes back short, because a truncated fetch makes every
current member look departed and would wipe the entire leaderboard. That check is shared
with Gamer ID, which needs it for the same reason, and lives in `lib/utils.js` as
`fetchMembersWithRatio`; the thresholds are kept separate so tuning one feature does not
silently retune the other.

Four ways a departure is caught:

1. The `guildMemberRemove` listener, reported at once with no debounce. A report that
   cannot be delivered is queued to `arcade-state.json` and retried on the next poll,
   because the event only happens once.
2. The boot sweep, so a departure during downtime does not wait for the daily run.
3. The daily sweep.
4. The winner check before a callout.

Posted daily boards are corrected rather than left to contradict the live boards. Those
edits run through a serial queue with a fixed gap: a `/purge` can touch many messages,
and a queue that cannot overtake itself cannot burst into a rate limit. A message that is
no longer there is skipped, not recreated.

## `/arcade-review`

`approve` lets a pending record count and posts it publicly. `remove` takes a score off
every board, and recomputes the result of a finished round if it was in one. Owner only,
checked in the handler rather than relying on the permission flag, since an Administrator
can still see a command hidden that way.

Named `arcade-review` rather than `arcade` because the Vice Arcade application owns
`/arcade` as its Entry Point command, which Discord requires to be global and
option-less.

## Tests

```
npm test
```

`test/arcade-posts.test.js` covers the embeds, which are pure builders. What it pins is
not the wording but the two rules easiest to break unnoticed: a long board splits without
repeating its reset note, and nothing except the three podium winners ever pings.

`test/arcade-wiring.test.js` covers the behaviour that only shows up under failure, with
Discord and the API stubbed: a short member list abandoning the sweep, a timeout during
the winner check wiping nobody, an unreachable API leaving the roles exactly as they are,
an unknown event type staying pending, and a queued departure being flushed before
anything is posted from the boards.
