// Announcements posted through to the Vicers site API.

const https = require('https');
const { MessageFlags } = require('discord.js');

// Post announcement to Django API
async function postAnnouncement(title, content, link = null) {
    const payload = JSON.stringify({
        title: title,
        content: content,
        link: link,
    });

    const options = {
        hostname: 'api.vicers.net',
        path: '/api/announcement/create/',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Bot-Secret': process.env.BOT_API_SECRET,
            'Content-Length': Buffer.byteLength(payload),
        }
    };

    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 201) {
                    resolve(JSON.parse(data));
                } else {
                    reject(new Error(`API responded with ${res.statusCode}: ${data}`));
                }
            });
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

// Slash-command form of !announce. postAnnouncement is untouched and still just
// receives the same three strings.
async function handleAnnounceCommand(interaction) {
    if (interaction.user.id !== process.env.VICER_ADMIN) {
        return interaction.reply({ content: '❌ You do not have permission to post announcements.', flags: MessageFlags.Ephemeral });
    }

    const title = interaction.options.getString('title');
    const content = interaction.options.getString('content');
    const link = interaction.options.getString('link') || null;

    // postAnnouncement calls api.vicers.net, which isn't guaranteed to answer inside
    // Discord's 3 second initial-response window.
    await interaction.deferReply();

    try {
        await postAnnouncement(title, content, link);
        await interaction.editReply('✅ Announcement posted successfully!');
    } catch (error) {
        console.error('Error posting announcement:', error);
        await interaction.editReply(`❌ Failed to post announcement. Error: ${error.message}`);
    }
}

module.exports = {
    postAnnouncement,
    handleAnnounceCommand,
};
