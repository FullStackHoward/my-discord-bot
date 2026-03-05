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
VG_VERIFIED_ROLE=
VG_STAFF_ROLE_1=
VG_STAFF_ROLE_2=
VG_STAFF_USER_1=
VG_STAFF_USER_2=

# Vice Creators
VC_GUILD_ID=
VC_VERIFIED_ROLE=
VC_STAFF_ROLE_1=
VC_STAFF_ROLE_2=
VC_STAFF_USER_1=
VC_STAFF_USER_2=

# Application Server
APP_GUILD_ID=
APP_VERIFIED_ROLE=
APP_STAFF_ROLE_1=
APP_STAFF_USER_1=
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

---

## Deployment

The bot runs on an AlmaLinux server managed with PM2. Deployments are handled via a GitHub pipeline — pushing to the main branch triggers a pull on the server and restarts the PM2 process automatically.

---

## Bot Permissions Required

When inviting the bot to a server, the following permissions are required:

- Manage Roles
- View Channels
- Send Messages
- Read Message History
- Manage Events (required for planned event sync feature)

---

## Project Structure

```
vice-community-bot/
├── index.js        # Main bot file
├── .env            # Environment variables (never committed)
├── .gitignore
├── package.json
└── README.md
```

---

## Built By

[FullStackHoward](https://www.fullstackhoward.com)
