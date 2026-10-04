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
and `VICER_ADMIN`, staff, subscribers, anyone added with `/purge-exempt`, and members who
joined within `ACTIVITY_NEW_MEMBER_GRACE_DAYS`.

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
   processed.

**By design there is no automatic removal anywhere in this feature:** no timer, flag,
env var, or startup path can trigger a purge or skip the confirmation, and a bot restart
mid-purge does not resume it. Holding the Inactive role is a label and nothing more.

Related commands, both owner-only:

- `/activity summary [list]` — counts of active, inactive and exempt (by reason), seeding
  status, and how many members `/purge` would currently list.
- `/activity user <member>` — one member's status, last activity and last signal.
- `/purge-exempt add|remove|list` — an exempted member carries neither role and is never
  purged, exactly like staff.

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
- Attach Files (required in every log channel — long activity and purge lists are posted as `.txt` attachments)
- Connect / View Channels on voice and stage channels (so voice sessions are visible to activity tracking)

The bot currently has Administrator on the servers, which covers all of the above.
Administrator does **not** override role hierarchy, so the bot's own role must still sit
**above** the verified, tier, Vice Radar, and Active/Inactive roles for it to manage them,
and above a member's top role to remove them.

### Privileged Gateway Intents

Enabled on the Bot page of the Discord Developer Portal:

- **Server Members Intent** — member joins, role syncing, reconciliation, activity sweeps
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
│   └── activity/
│       ├── index.js                # State, signal capture, classification, role swaps
│       ├── seeding.js              # One-time message-history backfill (resumable)
│       ├── role-sweep.js           # Daily Active/Inactive labeling
│       ├── purge.js                # /purge and /purge-exempt (the only removal path)
│       └── report.js               # /activity
├── data/
│   └── radar-phrases.json          # Vice Radar copy (never committed; edit live on the server)
├── .env                            # Environment variables (never committed)
├── application-server-state.json   # Runtime reminder state (never committed)
├── event-reminder-state.json       # Runtime reminder state (never committed)
├── activity-state.json             # Activity timestamps and exemptions (never committed)
├── purge-log.jsonl                 # Permanent per-member purge record (never committed)
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
