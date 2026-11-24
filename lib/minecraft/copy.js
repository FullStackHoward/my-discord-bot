// ---------------------------------------------------------------------------
// Minecraft Realm post: the words
// ---------------------------------------------------------------------------
//
// Plain message content, not an embed, because it is written as message markdown
// (##, -#, >). The link comes from remote config at runtime; nothing else here does.
//
// 🔗 and ⚠️ are the Unicode characters. Discord turns :link: into the emoji only while a
// person is typing; a bot sending the literal text shows ":link:".

const crypto = require('crypto');
const { MessageFlags } = require('discord.js');

const HEADING = '## Want to Join our Minecraft Realm?';

const STEPS = [
    '**1.** Launch Minecraft and select **Play**.',
    '**2.** Open the **Realms** tab.',
    '**3.** Select **+ Add/join Realm**, then **Join an existing Realm**.',
    '**4.** Paste the invite link below and select **Join**.',
    '**5.** The Realm is now in your Realms list. Select it any time to jump in.'
];

const PC_NOTE = '-# On PC you can also just click the link and Minecraft will open and add the Realm for you.';

// Shown in place of the link while the dead link switch is ticked in Django admin.
const DEAD_LINK_NOTE = 'This link is not working right now. Admins will update it soon.';

const MAX_CONTENT_LENGTH = 2000;

// variant: 'link' (needs inviteUrl) or 'unavailable'.
function buildContent({ variant, inviteUrl }) {
    const lines = [HEADING, ...STEPS, ''];

    if (variant === 'unavailable') {
        lines.push(`> ⚠️ **Invite link:** ${DEAD_LINK_NOTE}`);
    } else {
        if (!inviteUrl) throw new Error('The link variant of the Minecraft post needs an invite link.');
        lines.push(`> 🔗 **Invite link:** ${inviteUrl}`, '', PC_NOTE);
    }

    return lines.join('\n');
}

// The full send/edit payload. Nothing can ping, and no preview card appears under the link.
function buildPost({ variant, inviteUrl }) {
    const content = buildContent({ variant, inviteUrl });

    if (content.length > MAX_CONTENT_LENGTH) {
        throw new Error(`The Minecraft post is ${content.length} characters, over Discord's ${MAX_CONTENT_LENGTH}.`);
    }

    return {
        content,
        flags: MessageFlags.SuppressEmbeds,
        allowedMentions: { parse: [] }
    };
}

// Covers the rendered text, so a change of variant or of link edits the post.
function contentHash(content) {
    return crypto.createHash('sha256').update(content).digest('hex');
}

module.exports = {
    HEADING,
    STEPS,
    PC_NOTE,
    DEAD_LINK_NOTE,
    MAX_CONTENT_LENGTH,
    buildContent,
    buildPost,
    contentHash,
};
