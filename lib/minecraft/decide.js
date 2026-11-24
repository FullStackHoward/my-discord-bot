// ---------------------------------------------------------------------------
// Minecraft Realm post: the decisions, as pure functions
// ---------------------------------------------------------------------------
//
// No Discord, no I/O. Each pass goes: validate the remote config section, derive which
// state the post is in, then decide what to do given what was saved and what Discord
// reported. index.js carries the decision out.

const { localParts, localIsoDate } = require('../lobby/time');

const SNOWFLAKE = /^\d{17,20}$/;
const MAX_INVITE_URL_LENGTH = 300;

// The states in which a post is shown. The others leave any existing post alone.
const ACTING_STATES = new Set(['link', 'unavailable']);

function isBlank(value) {
    return value === undefined || value === null || value === '';
}

function checkChannelId(value) {
    if (isBlank(value)) return { status: 'blank' };
    if (typeof value === 'string' && SNOWFLAKE.test(value)) return { status: 'valid', value };
    return { status: 'invalid' };
}

function checkInviteUrl(value) {
    if (isBlank(value)) return { status: 'blank' };
    if (typeof value !== 'string') return { status: 'invalid' };
    if (value.length > MAX_INVITE_URL_LENGTH) return { status: 'invalid' };
    if (/[\s<>]/.test(value)) return { status: 'invalid' };

    try {
        const parsed = new URL(value);
        if (parsed.protocol !== 'https:') return { status: 'invalid' };
    } catch (error) {
        return { status: 'invalid' };
    }

    return { status: 'valid', value };
}

// null when there is no section at all.
function validateSection(section) {
    if (!section || typeof section !== 'object' || Array.isArray(section)) return null;

    return {
        channelId: checkChannelId(section.channel_id),
        inviteUrl: checkInviteUrl(section.invite_url),
        linkUnavailable: section.link_unavailable === true
    };
}

// -> { state, channelId?, inviteUrl?, invalid: [field names] }
//
// state is one of:
//   idle         no section, or no channel: do nothing, leave any existing post alone
//   link         the post with the invite link
//   unavailable  the post with the dead link note (the link is ignored, may be blank)
//   empty        channel set, switch off, no link: do nothing, create nothing
//
// A field that fails validation is treated like an outage for that field: the last good
// value (what the current post was built from) is used instead, so a bad admin entry
// never reaches the channel.
function deriveState(section, validation, lastGood = {}) {
    const invalid = [];
    if (!section || !validation) return { state: 'idle', invalid };

    let channelId;
    if (validation.channelId.status === 'blank') return { state: 'idle', invalid };

    if (validation.channelId.status === 'invalid') {
        invalid.push('channel_id');
        channelId = lastGood.channelId || null;
        if (!channelId) return { state: 'idle', invalid };
    } else {
        channelId = validation.channelId.value;
    }

    if (validation.linkUnavailable) return { state: 'unavailable', channelId, invalid };

    if (validation.inviteUrl.status === 'blank') return { state: 'empty', channelId, invalid };

    let inviteUrl;
    if (validation.inviteUrl.status === 'invalid') {
        invalid.push('invite_url');
        inviteUrl = lastGood.inviteUrl || null;
        if (!inviteUrl) return { state: 'empty', channelId, invalid };
    } else {
        inviteUrl = validation.inviteUrl.value;
    }

    return { state: 'link', channelId, inviteUrl, invalid };
}

// Once per local day, from the post hour through the post hour plus three, so a bot that
// was down at the hour still catches up but never posts at some unrelated time of day.
function isRepostDue(lastRepostDay, nowMs, postHour, tz) {
    if (lastRepostDay === localIsoDate(nowMs, tz)) return false;

    const hour = localParts(nowMs, tz).hour;
    return hour >= postHour && hour <= postHour + 3;
}

// What to do this pass.
//
//   derived       from deriveState
//   saved         this guild's saved state
//   contentHash   hash of the post as it should read now
//   messageExists true / false when the saved post was looked up, undefined when not
//   isNewest      whether the saved post is the newest message (only needed when due)
//
// -> { action, markDay?, reason? } where action is one of
//   none    not an acting state
//   post    no post yet, or the saved one was deleted: post, pin, save
//   move    the channel changed: post in the new one, pin, save, delete the old post
//   repost  the daily resurface: post a new copy, pin, save, delete the old one
//   edit    the post is current but reads differently: edit in place, keep it pinned
//   keep    nothing to change: make sure it is pinned
function decideAction({ derived, saved, contentHash, messageExists, isNewest, nowMs, postHour, tz }) {
    if (!ACTING_STATES.has(derived.state)) return { action: 'none' };

    if (!saved.messageId) return { action: 'post', reason: 'first' };
    if (saved.channelId !== derived.channelId) return { action: 'move' };
    if (messageExists === false) return { action: 'post', reason: 'deleted' };

    const changed = contentHash !== saved.contentHash;

    if (isRepostDue(saved.lastRepostDay, nowMs, postHour, tz)) {
        // Already the bottom of the channel: record the day and stop.
        if (isNewest) return { action: changed ? 'edit' : 'keep', markDay: true };
        return { action: 'repost' };
    }

    return { action: changed ? 'edit' : 'keep' };
}

// The bot's own "pinned a message" notice, in the current Minecraft channel only. Pins by
// staff, notices elsewhere, and notices left in an old channel after a move are ignored.
function pinNoticeDecision({ channelId, currentChannelId, isPinNotice, authorId, botId }) {
    if (!currentChannelId) return 'ignore';
    if (channelId !== currentChannelId) return 'ignore';
    if (!isPinNotice) return 'ignore';
    if (!botId || authorId !== botId) return 'ignore';
    return 'delete';
}

module.exports = {
    ACTING_STATES,
    MAX_INVITE_URL_LENGTH,
    checkChannelId,
    checkInviteUrl,
    validateSection,
    deriveState,
    isRepostDue,
    decideAction,
    pinNoticeDecision,
};
