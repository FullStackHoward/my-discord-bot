// Introductions forum cleanup, with Discord stubbed out. Covers the predicate, the
// persisted toggle, the delete loop and the two ways absence is decided.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), `introductions-${process.pid}-`));
const GUILD = '910000000000000001';
const FORUM = '910000000000000050';

process.env.VG_GUILD_ID = GUILD;
// The alias spelling, so the fallback is exercised too.
process.env.VG_INTRODUCTIONS_CHANNEL = FORUM;
process.env.INTRO_STATE_PATH = path.join(TEMP, 'introductions-state.json');
process.env.INTRO_LOG_PATH = path.join(TEMP, 'introductions-log.jsonl');

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const { ChannelType } = require('discord.js');

function stub(request, exports) {
    const filename = require.resolve(request);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const staffLogs = [];
let memberList = { members: new Map(), ok: true, fetched: 0, expected: 0, ratio: 1, error: null };
let presentIds = new Set();
let forumThreads = [];

function unknownMember() {
    const error = new Error('Unknown Member');
    error.code = 10007;
    return error;
}

const forum = {
    id: FORUM,
    name: 'introductions',
    type: ChannelType.GuildForum,
    permissionsFor: () => ({ has: () => true }),
    threads: {
        fetchActive: async () => ({ threads: new Map(forumThreads.filter(t => !t.archived).map(t => [t.id, t])) }),
        fetchArchived: async () => ({ threads: new Map(forumThreads.filter(t => t.archived).map(t => [t.id, t])), hasMore: false })
    }
};

const guild = {
    id: GUILD,
    name: 'Vice Gamers',
    memberCount: 0,
    channels: { cache: new Map([[FORUM, forum]]), fetch: async () => null },
    members: {
        me: { id: 'bot' },
        fetch: async id => {
            if (presentIds.has(id)) return { id };
            throw unknownMember();
        }
    }
};

stub('../lib/client', { guilds: { cache: new Map() }, user: { id: 'bot' } });
stub('../lib/utils', {
    resolveGuild: async id => (id === GUILD ? guild : null),
    fetchMembersWithRatio: async () => memberList,
    guildLabel: () => 'Vice Gamers',
    sleep: () => Promise.resolve(),
    canManageRole: () => true,
    hasStaffPermission: () => false,
    isMainServer: () => true,
    otherMainServerId: () => null,
    fetchAllMembers: async () => new Map(),
    respondWithError: async () => {}
});
stub('../lib/staff-log', {
    sendStaffLog: async (guildId, embed) => { staffLogs.push(embed); },
    errorField: error => ({ name: 'Error', value: String(error?.message || error) })
});

const introductions = require('../lib/introductions');
const state = require('../lib/introductions/state');

after(() => fs.rmSync(TEMP, { recursive: true, force: true }));

function thread(id, ownerId, { pinned = false, archived = false, parentId = FORUM, deleteImpl, created = 1, messageCount = 0 } = {}) {
    const calls = { delete: 0, setArchived: [] };

    return {
        id,
        name: `Intro ${id}`,
        parentId,
        ownerId,
        archived,
        createdTimestamp: created,
        messageCount,
        flags: { has: flag => pinned && flag === 2 },
        calls,
        async delete() {
            calls.delete++;
            if (deleteImpl) return deleteImpl(calls.delete, this);
        },
        async setArchived(value) {
            calls.setArchived.push(value);
            this.archived = value;
        }
    };
}

function discordError(code, message = 'error') {
    const error = new Error(message);
    error.code = code;
    return error;
}

function setMembers(...ids) {
    const members = new Map(ids.map(id => [id, { id }]));
    memberList = { members, ok: true, fetched: members.size, expected: members.size, ratio: 1, error: null };
}

beforeEach(() => {
    staffLogs.length = 0;
    forumThreads = [];
    presentIds = new Set();
    setMembers('here');
    try { fs.unlinkSync(process.env.INTRO_STATE_PATH); } catch {}
    try { fs.unlinkSync(process.env.INTRO_LOG_PATH); } catch {}
    state.loadIntroductionsState();
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

test('the alias env name configures the guild, and other guilds stay inert', () => {
    assert.deepEqual(introductions.configuredIntroductionsGuildIds(), [GUILD]);
    assert.equal(introductions.introductionsConfigFor('somewhere-else'), null);
});

// ---------------------------------------------------------------------------
// The predicate
// ---------------------------------------------------------------------------

test('shouldDeleteThread: an absent owner qualifies', () => {
    assert.equal(introductions.shouldDeleteThread(thread('t', 'gone'), new Set(['gone']), FORUM), true);
});

test('shouldDeleteThread: a present owner does not', () => {
    assert.equal(introductions.shouldDeleteThread(thread('t', 'here'), new Set(['gone']), FORUM), false);
});

test('shouldDeleteThread: a missing ownerId never means departed', () => {
    assert.equal(introductions.shouldDeleteThread(thread('t', undefined), new Set(['gone', undefined]), FORUM), false);
    assert.equal(introductions.shouldDeleteThread(thread('t', ''), new Set(['gone', '']), FORUM), false);
});

test('shouldDeleteThread: a pinned thread is kept', () => {
    assert.equal(introductions.shouldDeleteThread(thread('t', 'gone', { pinned: true }), new Set(['gone']), FORUM), false);
});

test('shouldDeleteThread: a thread in a different forum is not touched', () => {
    assert.equal(introductions.shouldDeleteThread(thread('t', 'gone', { parentId: 'other' }), new Set(['gone']), FORUM), false);
});

// ---------------------------------------------------------------------------
// The persisted toggle
// ---------------------------------------------------------------------------

test('state: defaults to off with no file', () => {
    assert.equal(fs.existsSync(process.env.INTRO_STATE_PATH), false);
    assert.equal(state.isCleanupEnabled(GUILD), false);
    assert.equal(state.cleanupStatus(GUILD).everSet, false);
});

test('state: enabling persists across a reload', () => {
    const result = state.setCleanupEnabled(GUILD, true, { id: 'owner', tag: 'owner#0' });
    assert.deepEqual({ changed: result.changed, saved: result.saved }, { changed: true, saved: true });

    state.loadIntroductionsState();
    assert.equal(state.isCleanupEnabled(GUILD), true);
    assert.equal(state.cleanupStatus(GUILD).changedByTag, 'owner#0');

    assert.equal(state.setCleanupEnabled(GUILD, true, null).changed, false);
});

test('state: an unreadable file falls back to off', () => {
    state.setCleanupEnabled(GUILD, true, null);
    fs.writeFileSync(process.env.INTRO_STATE_PATH, '{ not json');

    state.loadIntroductionsState();
    assert.equal(state.isCleanupEnabled(GUILD), false);
});

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

test('a dry run deletes nothing, even with cleanup on', async () => {
    state.setCleanupEnabled(GUILD, true, null);
    const t = thread('t1', 'gone');
    forumThreads = [t, thread('t2', 'here')];

    const report = await introductions.runCleanup(GUILD, { trigger: 'sweep', mode: 'full', dryRun: true, delayMs: 0 });

    assert.equal(report.live, false);
    assert.deepEqual(report.matches.map(m => m.id), ['t1']);
    assert.equal(t.calls.delete, 0);
});

test('an automatic run with cleanup off reports and deletes nothing', async () => {
    const t = thread('t1', 'gone');
    forumThreads = [t];

    const report = await introductions.runCleanup(GUILD, { trigger: 'reconcile', mode: 'full', delayMs: 0 });
    assert.equal(report.live, false);
    assert.equal(report.matches.length, 1);
    assert.equal(t.calls.delete, 0);

    await introductions.reportCleanup(report);
    assert.equal(staffLogs.length, 1);
    assert.match(staffLogs[0].title, /Report-Only/);
});

test('forceLive deletes while cleanup is off, logs IDs only, and keeps pinned threads', async () => {
    const gone = thread('t1', 'gone', { created: 100 });
    const pinned = thread('t2', 'gone', { pinned: true });
    const kept = thread('t3', 'here');
    const ownerless = thread('t4', undefined);
    forumThreads = [gone, pinned, kept, ownerless];

    const report = await introductions.runCleanup(GUILD, { trigger: 'sweep', mode: 'full', forceLive: true, delayMs: 0 });

    assert.equal(report.live, true);
    assert.equal(gone.calls.delete, 1);
    assert.equal(pinned.calls.delete, 0);
    assert.equal(kept.calls.delete, 0);
    assert.equal(ownerless.calls.delete, 0);
    assert.equal(report.pinnedKept, 1);
    assert.equal(report.noOwner, 1);
    assert.equal(report.paths.direct, 1);

    const lines = fs.readFileSync(process.env.INTRO_LOG_PATH, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(lines.length, 1);
    assert.deepEqual(Object.keys(lines[0]).sort(), ['createdAt', 'deletedAt', 'guildId', 'ownerId', 'threadId', 'trigger']);
    assert.equal(lines[0].threadId, 't1');
    assert.equal(lines[0].createdAt, 100);

    // The staff-log report carries no title anywhere.
    await introductions.reportCleanup(report, { force: true });
    assert.doesNotMatch(JSON.stringify(staffLogs), /Intro t1/);
});

test('a short member list aborts a full run before anything is considered', async () => {
    const t = thread('t1', 'gone');
    forumThreads = [t];
    memberList = { members: new Map(), ok: false, fetched: 10, expected: 100, ratio: 0.1, error: null };

    const report = await introductions.runCleanup(GUILD, { trigger: 'sweep', mode: 'full', forceLive: true, delayMs: 0 });

    assert.equal(report.aborted, true);
    assert.match(report.abortReason, /threads/);
    assert.equal(t.calls.delete, 0);
    assert.match(staffLogs[0].description, /No threads were deleted/);
});

// ---------------------------------------------------------------------------
// The delete loop
// ---------------------------------------------------------------------------

test('five consecutive failures stop the run', async () => {
    const failing = Array.from({ length: 8 }, (_, i) => thread(`f${i}`, 'gone', {
        created: i,
        deleteImpl: () => { throw discordError(50013, 'Missing Permissions'); }
    }));
    forumThreads = failing;

    const report = await introductions.runCleanup(GUILD, { trigger: 'sweep', mode: 'full', forceLive: true, delayMs: 0 });

    assert.equal(report.failures.length, 5);
    assert.equal(report.aborted, true);
    assert.equal(failing.filter(t => t.calls.delete > 0).length, 5);
});

test('Unknown Channel counts as already gone, not a failure', async () => {
    const t = thread('t1', 'gone', { deleteImpl: () => { throw discordError(10003, 'Unknown Channel'); } });
    forumThreads = [t];

    const report = await introductions.runCleanup(GUILD, { trigger: 'sweep', mode: 'full', forceLive: true, delayMs: 0 });

    assert.equal(report.failures.length, 0);
    assert.equal(report.deleted.length, 1);
    assert.equal(report.paths.alreadyGone, 1);
});

test('an archived rejection unarchives exactly once and retries exactly once', async () => {
    const t = thread('t1', 'gone', {
        archived: true,
        deleteImpl: attempt => {
            if (attempt === 1) throw discordError(50083, 'Thread is archived');
        }
    });
    forumThreads = [t];

    const report = await introductions.runCleanup(GUILD, { trigger: 'sweep', mode: 'full', forceLive: true, delayMs: 0 });

    assert.equal(t.calls.delete, 2);
    assert.deepEqual(t.calls.setArchived, [false]);
    assert.equal(report.deleted.length, 1);
    assert.equal(report.paths.afterUnarchive, 1);
});

test('an archived thread that deletes directly is recorded as such, with no unarchive', async () => {
    const t = thread('t1', 'gone', { archived: true });
    forumThreads = [t];

    const report = await introductions.runCleanup(GUILD, { trigger: 'sweep', mode: 'full', forceLive: true, delayMs: 0 });

    assert.equal(t.calls.delete, 1);
    assert.deepEqual(t.calls.setArchived, []);
    assert.equal(report.paths.archivedDirect, 1);
});

test('a retry that still fails re-archives the thread it unarchived', async () => {
    const t = thread('t1', 'gone', {
        archived: true,
        deleteImpl: attempt => {
            if (attempt === 1) throw discordError(50083, 'Thread is archived');
            throw discordError(50013, 'Missing Permissions');
        }
    });
    forumThreads = [t];

    const report = await introductions.runCleanup(GUILD, { trigger: 'sweep', mode: 'full', forceLive: true, delayMs: 0 });

    assert.equal(t.calls.delete, 2);
    assert.deepEqual(t.calls.setArchived, [false, true]);
    assert.equal(report.failures.length, 1);
});

// ---------------------------------------------------------------------------
// Targeted mode
// ---------------------------------------------------------------------------

test('targeted: a queued member who fetches successfully has rejoined and keeps their thread', async () => {
    state.setCleanupEnabled(GUILD, true, null);
    const back = thread('t1', 'returner');
    const gone = thread('t2', 'leaver');
    forumThreads = [back, gone];
    presentIds = new Set(['returner']);

    const report = await introductions.runCleanup(GUILD, {
        trigger: 'leave', mode: 'targeted', queuedIds: ['returner', 'leaver'], delayMs: 0
    });

    assert.equal(back.calls.delete, 0);
    assert.equal(gone.calls.delete, 1);
    assert.deepEqual(report.rejoined, ['returner']);
});

test('targeted: nobody confirmed absent returns quietly without scanning', async () => {
    presentIds = new Set(['returner']);
    forumThreads = [thread('t1', 'returner')];

    const report = await introductions.runCleanup(GUILD, { trigger: 'leave', mode: 'targeted', queuedIds: ['returner'], delayMs: 0 });

    assert.equal(report.threadsScanned, 0);
    await introductions.reportCleanup(report);
    assert.equal(staffLogs.length, 0);
});

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

test('the preview clamps sample titles and counts threads with replies', async () => {
    const long = thread('t1', 'gone', { messageCount: 3 });
    long.name = 'x'.repeat(200);
    forumThreads = [long, thread('t2', 'gone', { messageCount: 0 })];

    const report = await introductions.runCleanup(GUILD, { trigger: 'sweep', mode: 'full', dryRun: true, delayMs: 0 });
    const { buildPreviewBody, sampleTitle } = require('../lib/introductions/command');

    assert.equal(sampleTitle(long.name).length, 80);
    const body = buildPreviewBody(report, GUILD);
    assert.match(body, /About \*\*1\*\* of them have replies/);
    assert.match(body, /\*\*2\*\* thread\(s\)/);
});

test('command definitions fit Discord\'s limits, or registration fails for the whole server', () => {
    const { INTROS_SWEEP_COMMAND, INTROS_CLEANUP_COMMAND } = require('../lib/introductions/command');

    for (const command of [INTROS_SWEEP_COMMAND, INTROS_CLEANUP_COMMAND]) {
        assert.ok(command.name.length <= 32, command.name);
        assert.ok(command.description.length <= 100, `${command.name}: ${command.description.length}`);
        for (const option of command.options) assert.ok(option.description.length <= 100, option.name);
    }
});
