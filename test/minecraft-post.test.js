const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), `minecraft-post-${process.pid}-`));
process.env.MINECRAFT_STATE_PATH = path.join(TEMP, 'minecraft-state.json');
process.env.REMOTE_CONFIG_CACHE_PATH = path.join(TEMP, 'remote-config-cache.json');

const { test, after } = require('node:test');
const assert = require('node:assert');
const { MessageFlags } = require('discord.js');
const copy = require('../lib/minecraft/copy');
const decide = require('../lib/minecraft/decide');
const { createStateStore } = require('../lib/minecraft/state');

after(() => fs.rmSync(TEMP, { recursive: true, force: true }));

// Fake values only. Never commit the real link.
const LINK = 'https://realms.gg/EXAMPLE';
const CHANNEL = '123456789012345678';
const OTHER_CHANNEL = '876543210987654321';
const TZ = 'America/New_York';
const HOUR = 18;

// 2026-11-24 is EST (UTC-5), so 18:00 Eastern is 23:00 UTC.
function eastern(day, hour, minute = 0) {
    return Date.UTC(2026, 10, day, hour + 5, minute);
}

// ---------------------------------------------------------------------------
// buildPost
// ---------------------------------------------------------------------------

test('the link variant has the heading, five steps, the link once, and the PC note', () => {
    const post = copy.buildPost({ variant: 'link', inviteUrl: LINK });

    assert.ok(post.content.startsWith('## Want to Join our Minecraft Realm?\n'));
    for (let n = 1; n <= 5; n += 1) assert.ok(post.content.includes(`**${n}.**`), `step ${n}`);
    assert.equal(post.content.split(LINK).length - 1, 1);
    assert.ok(post.content.includes(`> 🔗 **Invite link:** ${LINK}`));
    assert.ok(post.content.includes('-# On PC you can also just click the link'));
    assert.ok(!post.content.includes(':link:'));
    assert.ok(post.content.length < 2000);
});

test('the dead link variant has the note, no link, and no PC line', () => {
    const post = copy.buildPost({ variant: 'unavailable', inviteUrl: LINK });

    assert.ok(post.content.startsWith('## Want to Join our Minecraft Realm?\n'));
    for (let n = 1; n <= 5; n += 1) assert.ok(post.content.includes(`**${n}.**`), `step ${n}`);
    assert.ok(!post.content.includes(LINK));
    assert.ok(!post.content.includes('realms.gg'));
    assert.ok(post.content.includes(`> ⚠️ **Invite link:** ${copy.DEAD_LINK_NOTE}`));
    assert.ok(!post.content.includes('-#'));
    assert.ok(!post.content.includes('🔗'));
    assert.ok(post.content.length < 2000);
});

test('the payload parses no mentions and suppresses embeds', () => {
    for (const variant of ['link', 'unavailable']) {
        const post = copy.buildPost({ variant, inviteUrl: LINK });
        assert.deepEqual(post.allowedMentions, { parse: [] });
        assert.equal(post.flags, MessageFlags.SuppressEmbeds);
    }
});

test('the link variant refuses to render without a link', () => {
    assert.throws(() => copy.buildPost({ variant: 'link' }));
});

test('the content hash changes with the variant and the link', () => {
    const a = copy.contentHash(copy.buildContent({ variant: 'link', inviteUrl: LINK }));
    const b = copy.contentHash(copy.buildContent({ variant: 'link', inviteUrl: 'https://realms.gg/OTHER' }));
    const c = copy.contentHash(copy.buildContent({ variant: 'unavailable' }));
    assert.notEqual(a, b);
    assert.notEqual(a, c);
    assert.equal(a, copy.contentHash(copy.buildContent({ variant: 'link', inviteUrl: LINK })));
});

// ---------------------------------------------------------------------------
// Validation and state derivation
// ---------------------------------------------------------------------------

function derive(section, lastGood = {}) {
    return decide.deriveState(section, decide.validateSection(section), lastGood);
}

function section(overrides = {}) {
    return { channel_id: CHANNEL, invite_url: LINK, link_unavailable: false, ...overrides };
}

test('validation of channel ids', () => {
    assert.equal(decide.checkChannelId(CHANNEL).status, 'valid');
    assert.equal(decide.checkChannelId('1'.repeat(17)).status, 'valid');
    assert.equal(decide.checkChannelId('1'.repeat(20)).status, 'valid');
    assert.equal(decide.checkChannelId('').status, 'blank');
    assert.equal(decide.checkChannelId(null).status, 'blank');
    for (const bad of ['1'.repeat(16), '1'.repeat(21), 'abc456789012345678', ` ${CHANNEL}`, 123456789012345678]) {
        assert.equal(decide.checkChannelId(bad).status, 'invalid', String(bad));
    }
});

test('validation of invite links', () => {
    assert.equal(decide.checkInviteUrl(LINK).status, 'valid');
    assert.equal(decide.checkInviteUrl('').status, 'blank');
    for (const bad of [
        'http://realms.gg/EXAMPLE',
        'realms.gg/EXAMPLE',
        'https://realms.gg/EX AMPLE',
        'https://realms.gg/<EXAMPLE>',
        `https://realms.gg/${'a'.repeat(300)}`,
        'javascript:alert(1)',
        42
    ]) {
        assert.equal(decide.checkInviteUrl(bad).status, 'invalid', String(bad));
    }
});

test('no section, or a blank channel, is idle', () => {
    assert.equal(derive(null).state, 'idle');
    assert.equal(derive(undefined).state, 'idle');
    assert.equal(derive(section({ channel_id: '' })).state, 'idle');
    assert.equal(derive(section({ channel_id: '', link_unavailable: true })).state, 'idle');
});

test('channel, valid link, switch off is the link state', () => {
    assert.deepEqual(derive(section()), { state: 'link', channelId: CHANNEL, inviteUrl: LINK, invalid: [] });
});

test('the switch on is the unavailable state, whatever the link', () => {
    assert.equal(derive(section({ link_unavailable: true })).state, 'unavailable');
    assert.equal(derive(section({ link_unavailable: true, invite_url: '' })).state, 'unavailable');
    const badLink = derive(section({ link_unavailable: true, invite_url: 'http://nope' }));
    assert.equal(badLink.state, 'unavailable');
    assert.deepEqual(badLink.invalid, []);
});

test('channel set, switch off, blank link is empty', () => {
    assert.deepEqual(derive(section({ invite_url: '' })), { state: 'empty', channelId: CHANNEL, invalid: [] });
});

test('a bad link falls back to the last good one, or does nothing without one', () => {
    const withLastGood = derive(section({ invite_url: 'http://bad' }), { inviteUrl: LINK });
    assert.equal(withLastGood.state, 'link');
    assert.equal(withLastGood.inviteUrl, LINK);
    assert.deepEqual(withLastGood.invalid, ['invite_url']);

    const without = derive(section({ invite_url: 'http://bad' }));
    assert.equal(without.state, 'empty');
    assert.deepEqual(without.invalid, ['invite_url']);
});

test('a bad channel id falls back to the last good one, or is idle without one', () => {
    const withLastGood = derive(section({ channel_id: 'not-a-channel' }), { channelId: OTHER_CHANNEL });
    assert.equal(withLastGood.state, 'link');
    assert.equal(withLastGood.channelId, OTHER_CHANNEL);
    assert.deepEqual(withLastGood.invalid, ['channel_id']);

    const without = derive(section({ channel_id: 'not-a-channel' }));
    assert.equal(without.state, 'idle');
    assert.deepEqual(without.invalid, ['channel_id']);
});

test('unknown keys in the section are ignored', () => {
    assert.equal(derive(section({ something_new: 'x' })).state, 'link');
});

// ---------------------------------------------------------------------------
// Repost window
// ---------------------------------------------------------------------------

test('the repost window runs from the post hour through hour plus three', () => {
    const due = (ms, last = null) => decide.isRepostDue(last, ms, HOUR, TZ);

    assert.equal(due(eastern(24, 17, 59)), false);
    assert.equal(due(eastern(24, 18, 0)), true);
    assert.equal(due(eastern(24, 21, 59)), true);
    assert.equal(due(eastern(24, 22, 0)), false);
    assert.equal(due(eastern(24, 18, 0), '2026-11-24'), false);
    assert.equal(due(eastern(24, 18, 0), '2026-11-23'), true);
});

test('the day is the Eastern day, not the UTC one', () => {
    // 21:30 Eastern on the 24th is 02:30 UTC on the 25th.
    const late = eastern(24, 21, 30);
    assert.equal(new Date(late).getUTCDate(), 25);
    assert.equal(decide.isRepostDue('2026-11-24', late, HOUR, TZ), false);
    assert.equal(decide.isRepostDue('2026-11-23', late, HOUR, TZ), true);

    // The next Eastern evening is due again.
    assert.equal(decide.isRepostDue('2026-11-24', eastern(25, 18, 0), HOUR, TZ), true);
});

test('hour zero is a valid post hour', () => {
    assert.equal(decide.isRepostDue(null, eastern(24, 0, 30), 0, TZ), true);
    assert.equal(decide.isRepostDue(null, eastern(24, 4, 0), 0, TZ), false);
});

// ---------------------------------------------------------------------------
// Action decision
// ---------------------------------------------------------------------------

const LINK_STATE = { state: 'link', channelId: CHANNEL, inviteUrl: LINK, invalid: [] };
const HASH = 'hash-now';
const MIDDAY = eastern(24, 12, 0);
const EVENING = eastern(24, 18, 30);

function savedPost(overrides = {}) {
    return { channelId: CHANNEL, messageId: 'm1', contentHash: HASH, inviteUrl: LINK, lastRepostDay: '2026-11-23', checkedAt: null, ...overrides };
}

function act(overrides = {}) {
    return decide.decideAction({
        derived: LINK_STATE,
        saved: savedPost(),
        contentHash: HASH,
        messageExists: true,
        isNewest: undefined,
        nowMs: MIDDAY,
        postHour: HOUR,
        tz: TZ,
        ...overrides
    });
}

test('idle and empty never act, even with a post saved', () => {
    assert.equal(act({ derived: { state: 'idle', invalid: [] } }).action, 'none');
    assert.equal(act({ derived: { state: 'empty', channelId: CHANNEL, invalid: [] } }).action, 'none');
    assert.equal(act({ derived: { state: 'empty', channelId: CHANNEL, invalid: [] }, nowMs: EVENING }).action, 'none');
});

test('no post yet: post', () => {
    assert.deepEqual(act({ saved: savedPost({ messageId: null, channelId: null }), messageExists: undefined }), { action: 'post', reason: 'first' });
});

test('a deleted post is posted again', () => {
    assert.deepEqual(act({ messageExists: false }), { action: 'post', reason: 'deleted' });
});

test('a changed channel moves the post', () => {
    assert.equal(act({ saved: savedPost({ channelId: OTHER_CHANNEL }), messageExists: undefined }).action, 'move');
});

test('a changed link or variant edits in place', () => {
    assert.equal(act({ contentHash: 'different' }).action, 'edit');
    assert.equal(act({ derived: { state: 'unavailable', channelId: CHANNEL, invalid: [] }, contentHash: 'dead' }).action, 'edit');
});

test('nothing changed outside the window: keep', () => {
    assert.deepEqual(act(), { action: 'keep' });
});

test('in the window and not the newest: repost', () => {
    assert.deepEqual(act({ nowMs: EVENING, isNewest: false }), { action: 'repost' });
});

test('in the window and already the newest: record the day only', () => {
    assert.deepEqual(act({ nowMs: EVENING, isNewest: true }), { action: 'keep', markDay: true });
    assert.deepEqual(act({ nowMs: EVENING, isNewest: true, contentHash: 'different' }), { action: 'edit', markDay: true });
});

test('already resurfaced today: no second repost', () => {
    assert.deepEqual(act({ nowMs: EVENING, isNewest: false, saved: savedPost({ lastRepostDay: '2026-11-24' }) }), { action: 'keep' });
});

test('the dead link state acts like the link state', () => {
    const dead = { state: 'unavailable', channelId: CHANNEL, invalid: [] };
    assert.equal(act({ derived: dead, saved: savedPost({ messageId: null }) }).action, 'post');
    assert.equal(act({ derived: dead, nowMs: EVENING, isNewest: false }).action, 'repost');
});

// ---------------------------------------------------------------------------
// Pin notice cleanup
// ---------------------------------------------------------------------------

function notice(overrides = {}) {
    return { channelId: CHANNEL, currentChannelId: CHANNEL, isPinNotice: true, authorId: 'bot', botId: 'bot', ...overrides };
}

test('the bot\'s own pin notice in the current channel is deleted', () => {
    assert.equal(decide.pinNoticeDecision(notice()), 'delete');
});

test('a pin notice from a person is left alone', () => {
    assert.equal(decide.pinNoticeDecision(notice({ authorId: 'staff' })), 'ignore');
});

test('a bot pin notice in another channel is left alone', () => {
    assert.equal(decide.pinNoticeDecision(notice({ channelId: '999999999999999999' })), 'ignore');
});

test('a bot pin notice in the old channel after a move is left alone', () => {
    assert.equal(decide.pinNoticeDecision(notice({ channelId: OTHER_CHANNEL, currentChannelId: CHANNEL })), 'ignore');
});

test('nothing is deleted with no current channel or no bot id', () => {
    assert.equal(decide.pinNoticeDecision(notice({ currentChannelId: null })), 'ignore');
    assert.equal(decide.pinNoticeDecision(notice({ botId: undefined, authorId: undefined })), 'ignore');
});

test('a normal message is never a pin notice', () => {
    assert.equal(decide.pinNoticeDecision(notice({ isPinNotice: false })), 'ignore');
});

// ---------------------------------------------------------------------------
// State file
// ---------------------------------------------------------------------------

test('the state file round-trips and has no temp file left behind', () => {
    const file = path.join(TEMP, 'state-roundtrip.json');
    const a = createStateStore(file);
    a.load();
    assert.equal(a.getGuild('g').messageId, null);

    a.updateGuild('g', { channelId: CHANNEL, messageId: 'm1', contentHash: HASH });
    a.updateGuild('g', { lastRepostDay: '2026-11-24' });

    const b = createStateStore(file);
    b.load();
    assert.deepEqual(
        { ...b.getGuild('g') },
        { channelId: CHANNEL, messageId: 'm1', contentHash: HASH, inviteUrl: null, lastRepostDay: '2026-11-24', checkedAt: null }
    );
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 1);
    assert.equal(fs.existsSync(`${file}.tmp`), false);
});

test('an unreadable state file is set aside and the module starts empty', () => {
    const file = path.join(TEMP, 'state-corrupt.json');
    fs.writeFileSync(file, 'nope');

    const store = createStateStore(file);
    const result = store.load();

    assert.equal(result.ok, false);
    assert.equal(fs.existsSync(file), false);
    assert.ok(fs.existsSync(result.movedTo));
    assert.equal(store.getGuild('g').messageId, null);
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function configValue(env, name) {
    const result = spawnSync(process.execPath, ['-e', `process.stdout.write(JSON.stringify(require('./lib/config').${name}))`], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, ...env },
        encoding: 'utf8'
    });
    return JSON.parse(result.stdout);
}

test('an invalid post hour falls back to 18, and zero is kept', () => {
    assert.equal(configValue({ MINECRAFT_POST_HOUR: '25' }, 'MINECRAFT_POST_HOUR'), 18);
    assert.equal(configValue({ MINECRAFT_POST_HOUR: 'six' }, 'MINECRAFT_POST_HOUR'), 18);
    assert.equal(configValue({ MINECRAFT_POST_HOUR: '0' }, 'MINECRAFT_POST_HOUR'), 0);
    assert.equal(configValue({ MINECRAFT_POST_HOUR: '' }, 'MINECRAFT_POST_HOUR'), 18);
});

test('an invalid time zone falls back to Eastern', () => {
    assert.equal(configValue({ MINECRAFT_TZ: 'Not/AZone' }, 'MINECRAFT_TZ'), 'America/New_York');
});

test('only Vice Gamers is mapped to a community', () => {
    assert.deepEqual(
        configValue({ VG_GUILD_ID: '111111111111111111', VC_GUILD_ID: '222222222222222222' }, 'REMOTE_CONFIG_COMMUNITIES'),
        [{ guildId: '111111111111111111', community: 'vicegamers' }]
    );
});
