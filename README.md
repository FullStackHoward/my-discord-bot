# Vice Community Bot

A Discord bot that manages member verification and cross-server access across the Vice Community servers. Built with [discord.js](https://discord.js.org/).

---

## Servers

The bot is configured for three Discord servers:

- **Vice Gamers** — 25+ gaming community
- **Vice Creators** — 25+ creative community for artists, developers, musicians, and writers
- **Application Server** — Entry point where prospective members apply to join the Vice Community

---

## Current Features

### Member Verification

Staff members can manually verify a user using the `!verify` command. Once verified, the user receives the designated verified role for that server, granting them access to the full community.

**Usage:**
```
!verify @username
```

**Who can use this command:**
- Users listed as staff by user ID in the server config
- Users with a designated staff role in the server config

---

### Auto-Verification Across Servers

When a verified member joins a second Vice Community server, the bot automatically grants them the verified role without requiring manual staff action.

There are two auto-verification scenarios:

**From the Application Server to a Main Server:**
When a member's application is accepted and they join Vice Gamers or Vice Creators, they are automatically verified and receive a welcome DM.

**Between Main Servers:**
If a verified member of Vice Gamers joins Vice Creators (or vice versa), they are automatically verified in the new server based on their existing status.

---

### Welcome DMs

When a member is auto-verified, the bot sends them a direct message. The message content varies depending on the verification source:

- Members coming from the Application Server receive a full welcome message acknowledging their accepted application.
- Members transferring between main servers receive a brief confirmation of their auto-verification.

---

## Planned Features

### Discord Event Sync with Django Backend

The bot will sync scheduled events from both the Vice Gamers and Vice Creators Discord servers to a shared Django REST API backend. This allows both community websites to display live event calendars without manual data entry.

**How it will work:**

- When a scheduled event is created in either Discord server, the bot detects which server it came from and tags it with the correct community
- The event is saved to the Django database and immediately available via the API
- The corresponding website fetches and displays the event automatically

**Sync is one-way from Discord to the API by default.** Events created directly in Discord are the source of truth.

---

### Django Admin to Discord Event Creation

Staff will also be able to create events directly from the Django admin panel. When creating an event, staff can choose which Discord server to post it to. The bot will create the scheduled event in Discord automatically, keeping both the website and Discord in sync from a single action.

---

### Community Tagging

Every event is tagged by community at the point of creation:

- Events from the Vice Gamers server only appear on ViceGamers.com
- Events from the Vice Creators server only appear on ViceCreators.com

---

## Setup

### Requirements

- Node.js 16+
- npm
- A Discord bot token with the following Privileged Gateway Intents enabled:
  - Server Members Intent
  - Message Content Intent

### Installation

```bash
git clone https://github.com/yourusername/vice-community-bot.git
cd vice-community-bot
npm install
```

### Environment Variables

Create a `.env` file in the root of the project:

```
BOT_TOKEN=your-bot-token-here

# Vice Gamers
VG_GUILD_ID=
VG_EVENT_CHANNEL=
VG_VERIFIED_ROLE=
VG_STAFF_ROLE_1=
VG_STAFF_ROLE_2=
VG_STAFF_USER_1=
VG_STAFF_USER_2=

# Vice Creators
VC_GUILD_ID=
VC_EVENT_CHANNEL=
VC_VERIFIED_ROLE=
VC_STAFF_ROLE_1=
VC_STAFF_ROLE_2=
VC_STAFF_USER_1=
VC_STAFF_USER_2=

# Application Server
APP_GUILD_ID=
APP_VERIFIED_ROLE=
APP_PENDING_ROLE=
APP_DENIED_ROLE=
APP_STAFF_ROLE_1=
APP_STAFF_USER_1=
APP_CHAT=
APP_SUBMIT_CHANNEL=

# Subscription tier roles (Vicer+, Vicer++, Super Vicer)
VG_TIER_VICER_PLUS=
VG_TIER_VICER_PLUS_PLUS=
VG_TIER_SUPER_VICER=
VC_TIER_VICER_PLUS=
VC_TIER_VICER_PLUS_PLUS=
VC_TIER_SUPER_VICER=

# Bot log channels
VG_LOG_CHANNEL=
VC_LOG_CHANNEL=
APP_LOG_CHANNEL=

# Vice Radar (squad matching)
# A server only runs Vice Radar if BOTH of its entries are filled in.
# Leave a pair blank to keep Radar off in that server.
VG_RADAR_ROLE=
VG_RADAR_CHANNEL=
VC_RADAR_ROLE=
VC_RADAR_CHANNEL=

# Activity roles (Active / Inactive labeling and /purge)
# A server only labels activity if BOTH of its entries are filled in.
# Leave a pair blank to keep activity labeling off in that server.
VG_ACTIVE_ROLE=
VG_INACTIVE_ROLE=
VC_ACTIVE_ROLE=
VC_INACTIVE_ROLE=

# Activity tuning. All optional; the defaults shown are used when unset.
# ACTIVITY_ROLES_ENABLED must be the literal string "true" before any role is applied.
ACTIVITY_ROLES_ENABLED=false
ACTIVITY_THRESHOLD_DAYS=30
ACTIVITY_NEW_MEMBER_GRACE_DAYS=14
ACTIVITY_VOICE_MIN_MINUTES=5
ACTIVITY_LOG_INDIVIDUAL_MAX=10
ACTIVITY_IGNORED_CHANNELS=
PURGE_REAPPLY_URL=https://discord.vicers.net

# Activity exception roles. Holding any of these exempts a member from activity labeling
# entirely, like staff. All optional; each role belongs to exactly one server and is only
# matched in that server.
VG_EVENT_COORDINATOR_ROLE=
VG_RECRUITER_ROLE=
VG_CONTRIBUTOR_ROLE=
VG_CREATOR_ROLE=
VC_STAR_ARTIST_ROLE=
VC_STAR_DEV_ROLE=
VC_STAR_MUSICIAN_ROLE=
VC_STAR_CONTENT_CREATOR_ROLE=
VC_STAR_WRITER_ROLE=
VC_GAMER_ROLE=

# Gamer ID forum cleanup (Vice Gamers only). Off entirely if the forum is unset.
# VG_GAMER_ID_CHANNEL is accepted as an alias for VG_GAMER_ID_FORUM.
VG_GAMER_ID_FORUM=

# LFG lobbies. A server runs them only when its LFG channel is set; with it blank the
# whole feature is dormant and registers no commands.
VG_LFG_CHANNEL=
# Listed first in the "where are you playing" picker. No longer a silent fallback: the
# host always chooses, and In-game is always an option.
VG_LFG_DEFAULT_VOICE=
VC_LFG_CHANNEL=
VC_LFG_DEFAULT_VOICE=

# LFG tuning. All optional; defaults shown.
LOBBY_TZ=America/New_York
LOBBY_BOARD_POST_HOUR=17
LOBBY_DEFAULT_SEATS=4
LOBBY_MAX_OPEN_PER_HOST=3
LOBBY_MAX_OPEN_TOTAL=30
LOBBY_MAX_DAYS_AHEAD=14
LOBBY_MIN_LEAD_MINUTES=10
LOBBY_REMINDER_MINUTES=60

# The LFG channel backstop. Must be exactly "true" to delete non-command posts there.
# Discord permissions do the real enforcement; this catches what gets through.
LOBBY_CHANNEL_GUARD_ENABLED=false
LOBBY_CHANNEL_REMINDER_COOLDOWN_MINUTES=10
LOBBY_NOW_EXPIRY_MINUTES=45
LOBBY_SHOW_MIN_MINUTES=10
LOBBY_RETENTION_DAYS=90
LOBBY_CARD_CLEANUP_HOURS=24
# How long a cancelled or expired card lingers. Much shorter, since it never ran.
LOBBY_DEAD_CARD_CLEANUP_MINUTES=10
LOBBY_NUDGE_DAILY_CAP=2
LOBBY_NEWCOMER_PROMPT_HOURS=24
LOBBY_GAME_MIN_SUBMITTERS=2
LOBBY_GAME_PRUNE_DAYS=60
LOBBY_BOARD_RADAR_MIN=2
LOBBY_BOARD_DEBOUNCE_SECONDS=15
LOBBY_SERIES_LEAD_HOURS=72

# Reference only, not read by the reconciliation logic
VG_WAITING_ROOM_CHANNEL=
VC_WAITING_ROOM_CHANNEL=
```

Never commit the `.env` file to version control.

### Running the Bot

**Development:**
```bash
node index.js
```

**Production (PM2):**
```bash
pm2 start index.js --name vice-bot
pm2 save
```

### Event Channel Auto-Posting

The bot automatically mirrors active scheduled events into each server's dedicated events channel and removes the post once the event is completed, canceled, or deleted.

Make sure the bot has `Send Messages` and `Read Message History` permission in each events channel.

### Application Server Auto-Kick

Once a member is verified in Vice Gamers or Vice Creators, the bot removes them from the Application Server if they still hold the accepted role there. Staff and the server owner are never kicked. If the member already left, or the bot lacks the permission or role position to kick them, the attempt is logged and skipped.

### Application Server Lifecycle Sweep

A third-party bot, **Appy**, owns the application flow on the Application Server. As staff review each application, Appy assigns the applicant one of three roles — Pending, Accepted, or Denied — and DMs accepted applicants an invite link to whichever main server they applied to.

Every hour (and once at startup) this bot sweeps the Application Server and acts on those roles:

| State | Action |
|---|---|
| **Denied** | Removed immediately, no grace period. |
| **Accepted**, already in Vice Gamers or Vice Creators | Nothing. The auto-kick above already handles them. |
| **Accepted**, in neither main server | Reminded once in `#application-chat` to check their DMs for the invite. Removed if they still haven't joined 24 hours later. |
| **Pending** | Nothing. Their application is mid-review. |
| **No application role**, joined over 8 hours ago | Reminded once in `#application-chat` to start an application. Removed if they still haven't applied 24 hours later. |

Bots, staff, and the server owner are excluded from all of it. Each member gets one reminder per condition, never a second, and reminders are posted in the channel — the bot never DMs as part of this. Every reminder and removal posts to `APP_LOG_CHANNEL`.

The bot does not track *which* main server an accepted applicant was invited to. Appy already sent the right link; this bot only checks whether they joined either one.

Reminder timestamps are stored in `application-server-state.json` next to `index.js`, so the 24-hour clocks survive a restart or deploy instead of resetting. The file is created on first write, pruned each sweep of anyone who has left, and is not committed to version control.

Two config notes:

- If `APP_PENDING_ROLE` or `APP_DENIED_ROLE` is unset, the bot cannot tell an applicant under review apart from someone who never applied, so the apply reminder and its removal are disabled rather than risk removing people mid-review. Denied removals and the accepted/join track are unaffected.
- If `APP_CHAT` is unset or the channel is unreachable, no reminders are sent, and because nobody can be removed without first being reminded, only the Denied removals still run. Both cases warn at startup.

### Subscription Tier Sync

Vicer+, Vicer++, and Super Vicer are kept in sync between Vice Gamers and Vice Creators:

- Gaining, changing, or losing a tier on one server mirrors it on the other.
- Joining a server grants whatever tier the member already holds on the other one.
- A member holding two tier roles at once resolves to the highest.
- If both servers show a *different* tier for the same member, the bot logs it for manual review and changes nothing — auto-correcting would either upgrade someone for free or downgrade a paying member.

### Hourly Reconciliation

Every hour (and once at startup) the bot sweeps both main servers to catch anything the live event handlers missed during downtime or a transient API failure:

- Members accepted elsewhere but missing the verified role get it granted, then the auto-kick above runs for them.
- Tier roles are compared across both servers and synced or flagged as above.

Bots, staff, and server owners are skipped. Every correction posts to the server's bot log channel.

### Vice Radar (Squad Matching)

Opt-in presence matching, so squads form without anyone having to ask "who's on?".

- Members opt in with `/vice-radar join`, or by reacting 🔔 to any Vice Radar post. `/vice-radar leave` opts back out.
- When **two or more** opted-in members are playing the same game at the same time, the bot DMs each of them once and posts a public embed to the radar channel.
- Only activities Discord reports as *Playing* count. Streaming, Listening (Spotify), Watching, and custom statuses are ignored. Games are matched on their exact activity name.
- While a squad stays together, the post repeats only when the headcount reaches a **new high**, and the DMs never repeat. Once the count falls below two, the streak resets — the next time it reaches two, it's treated as brand new.
- Runs per server: Vice Gamers, Vice Creators, or both, depending on which `*_RADAR_ROLE` / `*_RADAR_CHANNEL` pairs are set. `/vice-radar` is only registered in servers where Radar is configured.

State is held in memory only and rebuilds itself within seconds of a restart as presence events arrive, so nothing is persisted to disk.

**Two things gate this feature outside the code:**

1. The **Presence Intent** must be enabled on the Bot page of the Discord Developer Portal. Without it presence events never fire — silently, with no error.
2. Each member must have **Settings → Activity Privacy → "Display current activity as a status message"** turned on. With it off, Discord shows nobody what they're playing, the bot included. There is no way to detect or work around this from the bot side.

### Activity Roles (Active / Inactive)

A daily sweep labels every eligible member on the two main servers with one of two
hoisted roles, so active members group above inactive ones on the member list.

**What counts as activity:** messages in guild channels (threads and forum posts
included), and voice or stage sessions of at least `ACTIVITY_VOICE_MIN_MINUTES`. A voice
session in the channel of a currently running scheduled event is recorded as event
attendance. Presence, reactions, slash commands, Vice Radar, and marking "Interested" on
an event all deliberately **do not** count.

**Who is exempt** (checked in this order, carrying neither role): bots, the server owner
and `VICER_ADMIN`, staff, subscribers, boosters, holders of a configured **exception role**,
anyone added with `/purge-exempt`, and members who joined within
`ACTIVITY_NEW_MEMBER_GRACE_DAYS`.

**Exception roles** are the ten `VG_*` / `VC_*` role IDs above — Event Coordinator, Recruiter,
Star Artist and so on. Each is matched only in its own server, never across servers. Because
ten IDs are entered by hand, every configured ID is checked at boot: anything that is not a
valid snowflake, or does not resolve to a role in that server, is named by its exact env var in
a staff-log warning — including when the ID turns out to be a role in the *other* server, which
is the likeliest mistake. `/activity user` names which role granted the exemption.

**Active in either server counts as active in both.** A member active in one main server within
the window is exempt in the other rather than labeled Inactive there, so they are never listed
by `/purge` in the server they happen to be quiet in. Someone active in *both* keeps the Active
role in both — the check runs after their own activity, not before it, so it never strips a
label they earned. Someone quiet in both is Inactive in both and purgeable in both. The check
reads the other server's raw activity record, never its classification, so the two servers
cannot end up asking each other in a loop.

`/purge` **refuses to run** when the other main server cannot be reached, its member list cannot
be fetched, or its seeding is not complete — being wrong there would mean removing someone who
is active. The daily sweep instead warns and carries on, since the worst a sweep can do is leave
an Inactive label in place.

Boosting is read live off the member on every classification (`premiumSince`, falling back
to the guild's managed booster role), so a member who stops boosting is classified on
activity again from their next evaluation — there is nothing to persist or clean up.
Subscriber exemption depends on the `VG_TIER_*` / `VC_TIER_*` role IDs being set:
`/purge` refuses to run in a server where none of them are configured, because
subscribers could not be recognized and would appear purgeable.

**Seeding:** on first run the bot backfills message history back to the label window, so
labels are meaningful on day one. It is resumable, checkpointing after every channel.
Discord exposes no voice history, so voice activity cannot be backfilled — a member whose
only recent activity was voice will look inactive until live tracking catches them.

**Tracking-only mode** is the default (`ACTIVITY_ROLES_ENABLED=false`): signals are
recorded and the daily sweep posts what it *would* do, without touching a single role.
Set the flag to `true` and restart to let it label for real.

**Instant labeling:** a member who posts or completes a qualifying voice session is
labeled within seconds rather than waiting for the next daily sweep. This covers both a
member carrying Inactive (moved back to Active) and a member carrying no label yet
(labeled for the first time). Exempt members are left alone, and anyone already carrying
Active short-circuits on a single cache lookup, so ordinary chatter costs no API calls.

### Inactive Purge (`/purge`)

Owner-only, discretionary, and **never automatic**. `/purge` removes members who
currently hold that server's Inactive role — there is no separate purge window and no
`days` option. The 30-day label is the only time-based rule; when to act on it is the
owner's call.

Nothing is removed without an explicit confirmation:

1. `/purge` always produces a **dry run** first, listing candidates longest-inactive
   first, with each skip category counted.
2. Exempt members, anyone who now reads as active despite a stale Inactive role, and
   anyone the bot cannot remove are all held back and listed separately.
3. A danger-styled **Confirm** button (plus Cancel) is attached, usable only by the owner
   who generated that preview, expiring after 5 minutes.
4. On confirm, candidates are **recomputed** and only the intersection with the preview is
   acted on, so anyone who became active, got exempted, or left in between is dropped.
5. Each member is DM'd (by default), then removed, with a log line written as they are
   processed. The `send_dm` option on `/purge` is **required**, so whether to DM is an
   explicit decision on every run rather than a default that can be forgotten — and it needs
   no restart or config change. The preview always states which way it is set.

**By design there is no automatic removal anywhere in this feature:** no timer, flag,
env var, or startup path can trigger a purge or skip the confirmation, and a bot restart
mid-purge does not resume it. Holding the Inactive role is a label and nothing more.

Related commands, both owner-only:

- `/activity summary [list]` — counts of active, inactive and exempt (by reason), seeding
  status, and how many members `/purge` would currently list.
- `/activity user <member>` — one member's status, last activity and last signal.
- `/purge-exempt add|remove|list` — an exempted member carries neither role and is never
  purged, exactly like staff.
- `/purge-exempt clear [note_contains]` — the bulk undo. Removes manual exemptions and returns
  those members to normal labeling, with a preview and a Confirm press, exactly like `/purge`.
  Use `note_contains` to clear a temporary batch (say everything noted "oct purge hold") while
  keeping long-term exemptions. This changes **labels only**: members who come back as Inactive
  stay in the server until a later `/purge` you confirm. The run posts a report plus a recovery
  JSON of the removed entries, so any of them can be re-added with `/purge-exempt add`.

### Gamer ID Forum Cleanup

Gamer IDs live in a locked forum channel on Vice Gamers, one thread per platform, where members
post their IDs as replies. When someone is no longer in the server their replies are removed, so
the threads stay useful.

This deletes **messages only** — never a member, never a role. Three triggers reach the same code:

1. **A member leaving.** Their ID is queued and the scan runs after 60 seconds of quiet, so a
   burst of departures (a `/purge` run, for instance) produces one scan rather than one per
   person. Each queued member is re-checked against Discord first, so anyone who rejoined during
   that window is left alone.
2. **A daily reconcile**, 35 minutes after boot and every 24 hours after. This is the safety net
   for leaves the bot was offline for or restarted through, since the listener only fires while
   connected.
3. **`/gamer-id-sweep`** (owner only), the one-time retroactive pass for everyone who had already
   left before the feature existed. Never needed again after rollout.

`/gamer-id-cleanup enable|disable|status` (owner only) controls whether triggers 1 and 2 actually
delete. Trigger 3 always previews and always deletes on Confirm, whatever that is set to.

Safeguards:

- **Automatic cleanup is off until you switch it on**, with `/gamer-id-cleanup enable`. While
  it is off, the leave listener and the daily reconcile scan and report what they *would*
  delete, and delete nothing. The setting is persisted, so it survives restarts, and
  `/gamer-id-cleanup status` shows the current state and who last changed it. It defaults to
  off whenever there is no state to read — a fresh server, a deleted or unreadable file —
  since report-only is always the safe direction.
- **`/gamer-id-sweep` always previews first**, with a per-thread breakdown and an attached list,
  and deletes nothing without a Confirm press from the owner who generated it. On confirm the
  scan is re-run rather than trusting the preview, so anyone who rejoined in between keeps their
  posts. Cancel and the 5-minute expiry both delete nothing. It **does** delete on Confirm even
  while automatic cleanup is off — that is the point of the one-time retroactive pass: you review
  it and run it before ever switching the automatic paths on.
- **A short member list aborts the run.** If the member fetch fails, or comes back below 90% of
  the server's own count, the run stops without deleting — a truncated list would make current
  members look departed, which is the one genuinely dangerous failure here.
- **Bots, webhooks and system messages are never touched.** Pinned replies from departed members
  are removed like any other.
- **Message content is never logged.** The staff-log embeds and `gamer-id-log.jsonl` record author,
  thread and message IDs only, because the content is the thing being removed.

### LFG Lobbies

Helps members with awkward schedules line up games together. Everything is bot-side: the
feature stores its own state in `lobby-state.json` and makes no calls to the Vicers API or
anything else outside Discord.

**`/lfg-profile`** is each member's profile — weekday and weekend time blocks, platforms,
games, gamertags, and whether they want nudges. The panel saves as you pick, so there is no
Save button. `/lfg-profile timezone` is the one thing that has to be set first: every time
in the feature is stored as an instant and rendered in each viewer's own local clock, and
without a zone the bot cannot offer sensible start times.

**`/lobby create`** opens a seat-limited lobby for a time you pick from a list, and
`/lobby now` opens one starting immediately. Both **require** you to say where you are
playing: either **In-game** (meet up in the game itself) or one of the server's voice
channels, picked from a list. There is no silent default, so a card never claims a voice
channel the host did not choose. Each lobby gets a card in the LFG channel with
Join, Maybe, Leave and Show tags, plus host controls for seats, note, crossplay, saving a
template and cancelling. Every card gets its own thread, which is where reminders and
chatter go.

- **Seats and the waitlist.** Once the seats are gone, joining puts you on the waitlist. If
  somebody leaves, the first person waiting is moved in, mentioned in the thread and DM'd.
  Raising the seat count absorbs the waitlist in order.
- **Maybe** holds no seat and can be upgraded to Join later.
- **If a lobby is cancelled**, everyone who had signed up — confirmed players, maybes and
  the waitlist — gets a thread mention and a DM saying which lobby, when it was due and
  why. This covers all three ways a lobby can end up cancelled: the host or staff pressing
  Cancel, the host leaving the server, or the card being deleted. A cancelled or expired
  card is removed after `LOBBY_DEAD_CARD_CLEANUP_MINUTES` rather than the full day a
  completed lobby gets, since it is only clutter.
- **The host is told when somebody else ended their lobby** — staff pressing Cancel, or the
  card being deleted — in a DM of its own, naming the real cause rather than the "host or
  staff" wording members see. A host who presses Cancel themselves gets nothing, and
  neither does a host whose lobby ended because they left the server. The staff member's
  confirmation says how many people were told, and that the host was among them.
- **Crossplay off** means a lobby only accepts members whose profile lists its platform.
  Turning it off later applies to new joins only; anyone already seated keeps their seat.
- **Gamertags** are opt-in and are shown only to people confirmed in the same lobby, through
  the Show tags button. They never appear on the public card.

**Reminders** go in the lobby thread, never as DMs: a thread mention cannot produce a
closed-DM callout. There are two: one `LOBBY_REMINDER_MINUTES` before the start (an hour by
default), then a "starting now" at the start. A lobby booked inside that window — including
anything from `/lobby now` — skips the reminder and gets only the start post, since a
reminder arriving moments after the card is just noise. If a lobby has a minimum player
count and it is unmet at the reminder, the host gets Run anyway and Cancel buttons — nothing
is ever cancelled automatically. DMs are used only for waitlist promotion, nudges and the
newcomer prompt.

**The board** is one message in the LFG channel showing what is on tonight and this week,
plus a counts-only "Playing now" read from Vice Radar. It is **pinned**, edited in place as
lobbies change, and re-posted once a day at `LOBBY_BOARD_POST_HOUR` so it does not get
buried, with the weekly digest folded into the Sunday re-post. Each re-post is pinned and
the previous board deleted, so exactly one board is ever pinned. Discord's "pinned a
message" notice is cleaned up automatically.

**The LFG channel is slash-commands only.** Conversation belongs in the per-lobby threads,
which stay open to everyone. Enforcement is Discord permissions — deny Send Messages on
`@everyone`, keep Use Application Commands and Send Messages in Threads allowed — and
`LOBBY_CHANNEL_GUARD_ENABLED=true` turns on a code backstop that deletes anything which gets
through anyway and DMs the poster what to use instead, at most once per person per
`LOBBY_CHANNEL_REMINDER_COOLDOWN_MINUTES`. Bots, webhooks, system messages and `VICER_ADMIN`
are exempt. A DM rather than an ephemeral reply, because Discord's ephemeral flag only
exists on interaction responses and a deleted plain message has no interaction to answer.

**Nudges** are off by default. With them on, a member gets one DM when a lobby is opened for
a game on their profile at a time inside their availability — capped per day, held outside
their local 08:00-22:00, and switched off automatically if their DMs are closed.

**Once attendance is recorded** the lobby is closed: the card keeps its two button rows but
every control is greyed out, and the tracked thread prompts are greyed too. Anything that
cannot be greyed — an old nudge DM, a prompt posted before this behaviour existed — is still
refused server-side with a message saying attendance has been recorded. Attendance counts as
recorded whether the host confirmed it or the 24-hour voice fallback settled it.

**After a lobby ends** the host is asked who showed up, pre-filled from who the bot saw in
the voice channel. An **in-game** lobby has no voice channel to watch, so there is nothing
to pre-fill and attendance rests on the host confirming it (or the 24-hour fallback
recording it as unconfirmed). Anyone who was there can press Play again, and two or more presses create
a crew — a small named group you can invite in one go next time with `/lobby create crew:`.

**Games come only from what members submit.** There is no curated list and nothing to
maintain. A title typed into `/lobby create` or added from the availability panel joins the
server's registry; spelling variants collapse onto one key, a near-miss asks "did you mean",
and a title stays private to its submitter until a second member adds it or a lobby uses it.
`/lobby-games` (owner only) exists for typos and abuse, not routine upkeep.

Owner-only: `/lobby-stats [days]` for fill rate, show rate, repeat participation, nudge
conversion and the best overlapping availability per game — counts only, no names.

**This feature never moderates anyone.** It creates, edits and deletes messages and threads
and keeps its own state file. With the channel guard on it deletes non-command posts in the
LFG channel, which is message handling rather than action against the member. It contains no
kick, ban, timeout or role change and does not touch `lib/activity`.

One caveat worth knowing: a message deleted by the guard has already been counted by the
activity tracker, which runs on every message. If that matters, add the LFG channel id to
`ACTIVITY_IGNORED_CHANNELS` — that is a change to the activity and purge system, so it is a
deliberate decision rather than something this feature does on its own.

### Staff Activity Log

Each of the three servers has its own bot log channel (`VG_LOG_CHANNEL`, `VC_LOG_CHANNEL`, `APP_LOG_CHANNEL`). Member lifecycle events are posted there as color-coded embeds so staff can scan a channel at a glance:

| Color | Events |
|---|---|
| Blurple | Member joined |
| Green | Auto-verified, manually verified |
| Orange | Auto-kicked from the Application Server |
| Pink | Subscription tier granted or synced |
| Dark red | Subscription tier removed |
| Yellow | Tier mismatch needing manual review |
| Red | Operational problems staff need to act on |

Reconciliation entries reuse the join color and are marked with a 🔄 in the title.

Red entries cover anything that silently failed: a verification or auto-kick the bot could not carry out, a tier role it could not grant or remove, a misconfigured events channel, a reconciliation pass that was skipped or crashed, and any unhandled error. Problems that aren't specific to one server — a client error, an unhandled rejection, a reconciliation sweep that crashed — are posted to all three channels. Most red entries name the cause (usually a missing permission or the bot's role sitting too low) so the fix is visible without opening the PM2 log.

Notes on coverage:

- Application Server activity — joins, auto-kicks, and kick failures — goes to `APP_LOG_CHANNEL`, not to the main server the member was verified in.
- Members leaving a server are **not** logged, in any of the three servers.
- A reconciliation pass that finds nothing to correct posts nothing.

Deliberately console-only, to keep the channels scannable:

- Failed welcome DMs (a member with DMs closed) — common, and not actionable.
- A guild the bot cannot resolve at all — the log channel lookup would fail the same way.
- A member joining a server with no config entry — there is no log channel to post to.
- Per-check tracing inside the verification lookup — fires on every join across all three servers.
- A failed cleanup of an expired event post, and a reconciliation pass skipped because one is already running.
- `!verify` and `!announce` failures — these already reply in the channel where the command was run.

Logging never interrupts the action that triggered it: if a log channel is missing or misconfigured, the bot writes a console warning and carries on.

---

## Deployment

The bot runs on an AlmaLinux server managed with PM2. Deployments are handled via a GitHub pipeline — pushing to the main branch triggers a pull on the server and restarts the PM2 process automatically.

---

## Bot Permissions Required

When inviting the bot to a server, the following permissions are required:

- Manage Roles
- View Channels
- Send Messages
- Embed Links (required in every log channel — all staff logs are embeds)
- Read Message History
- Manage Events (required for planned event sync feature)
- Kick Members (required on the Application Server for the auto-kick, and on the main servers for `/purge`)
- Attach Files (required in every log channel — long activity, purge and gamer ID lists are posted as `.txt` attachments)
- Manage Messages in the gamer ID forum (to delete departed members' posts), plus Manage Threads if a thread has to be unarchived to delete in it
- In the LFG channel: Send Messages, Embed Links, Create Public Threads, Send Messages in Threads, Read Message History, and Manage Messages — which covers editing the board, deleting finished cards, pinning the board, and removing stray posts when the channel guard is on (plus Pin Messages, if Discord lists it as a separate permission)
- Connect / View Channels on voice and stage channels (so voice sessions are visible to activity tracking)

The bot currently has Administrator on the servers, which covers all of the above.
Administrator does **not** override role hierarchy, so the bot's own role must still sit
**above** the verified, tier, Vice Radar, and Active/Inactive roles for it to manage them,
and above a member's top role to remove them.

### Privileged Gateway Intents

Enabled on the Bot page of the Discord Developer Portal:

- **Server Members Intent** — member joins, role syncing, reconciliation, activity sweeps, LFG cleanup
- **Message Content Intent** — prefix commands and activity message tracking
- **Presence Intent** — Vice Radar only; leave it off and the rest of the bot is unaffected

`GuildVoiceStates` (activity voice tracking) and `GuildScheduledEvents` are **not**
privileged and need no Developer Portal toggle — the code requesting them is enough.

### Server setup for activity roles (manual, not code)

1. Create the Active and Inactive roles with **Display role members separately** on for
   both, and place Active above Inactive.
2. Discord groups each member under their highest hoisted role, so where Active and
   Inactive sit relative to staff, tier, verified and Radar roles decides which heading
   people appear under. Place them deliberately.
3. The bot's top role must sit above both.
4. Add the activity env vars to the server `.env` by hand — it is not in version control.

---

## Project Structure

```
vice-community-bot/
├── index.js                        # Entrypoint: client login and listener wiring only
├── lib/
│   ├── client.js                   # The shared Client instance (intents, partials)
│   ├── config.js                   # Everything derived from .env
│   ├── utils.js                    # Guild/role/permission helpers
│   ├── staff-log.js                # Staff log channel embeds
│   ├── verification.js             # Verification + Application Server exit (Feature A)
│   ├── tier-sync.js                # Cross-server subscription tiers (Feature B)
│   ├── reconciliation.js           # Hourly reconciliation (Feature C)
│   ├── application-sweep.js        # Application Server lifecycle (Feature D)
│   ├── announcements.js            # Posting to the Vicers site API
│   ├── events.js                   # Event mirroring, RSVP DMs, 15-minute reminders
│   ├── slash-commands.js           # Slash command definitions and routing
│   ├── prefix-commands.js          # !verify / !announce routing
│   ├── radar/
│   │   ├── index.js                # Vice Radar (Feature E)
│   │   └── phrase-bank.js          # Loads data/radar-phrases.json on every pick
│   ├── activity/
│   │   ├── index.js                # State, signal capture, classification, role swaps
│   │   ├── seeding.js              # One-time message-history backfill (resumable)
│   │   ├── role-sweep.js           # Daily Active/Inactive labeling
│   │   ├── purge.js                # /purge and /purge-exempt (the only removal path)
│   │   └── report.js               # /activity
│   ├── gamer-id/
│   │   ├── index.js                # Forum scan, delete logic, leave debounce, reconcile
│   │   ├── state.js                # Persisted on/off setting for the automatic paths
│   │   └── command.js              # /gamer-id-sweep and /gamer-id-cleanup
│   └── lobby/
│       ├── index.js                # Public surface, listeners, boot announcement
│       ├── guilds.js               # Which guilds run lobbies
│       ├── state.js                # Persisted state and the seat/waitlist machine
│       ├── time.js                 # Zones, slot generation, blocks, weekly recurrence
│       ├── games.js                # Member-submitted game registry rules
│       ├── render.js               # Cards, board, panels, DMs (pure builders)
│       ├── components.js           # Buttons, selects, modals
│       ├── commands.js             # Command definitions, handlers, autocomplete
│       ├── stages.js               # Pure reminder-timing decisions
│       ├── channel-guard.js        # Keeps the LFG channel to slash commands only
│       ├── sweep.js                # Minute sweep: stages, nudges, series, pruning
│       ├── board.js                # Board upsert and the daily re-post
│       ├── crews.js                # Play-again crew formation
│       ├── stats.js                # /lobby-stats aggregation
│       └── copy.js                 # Every user-facing string
├── data/
│   └── radar-phrases.json          # Vice Radar copy (never committed; edit live on the server)
├── .env                            # Environment variables (never committed)
├── application-server-state.json   # Runtime reminder state (never committed)
├── event-reminder-state.json       # Runtime reminder state (never committed)
├── activity-state.json             # Activity timestamps and exemptions (never committed)
├── purge-log.jsonl                 # Permanent per-member purge record (never committed)
├── gamer-id-log.jsonl              # Permanent per-message deletion record (never committed)
├── gamer-id-state.json             # Gamer ID cleanup on/off setting (never committed)
├── lobby-state.json                # LFG profiles, lobbies, crews, series (never committed)
├── test/                           # node:test unit tests for the pure LFG modules
├── .gitignore
├── package.json
└── README.md
```

`data/radar-phrases.json` is read fresh on every Vice Radar post, so editing it on the
server changes the copy on the next post with no restart and no redeploy. It is not in
version control, so keep a master copy elsewhere; if it is missing or malformed, Radar
logs a warning and falls back to three built-in phrases rather than going silent.

---

## Built By

[FullStackHoward](https://www.fullstackhoward.com)
