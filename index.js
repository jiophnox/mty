const {app, PORT, DOWNLOAD_DIR, YTDLP, exec}  = require('./download');
const bot = require('./telegram');

// Start server
app.listen(PORT, () => {
    console.log(`
    🎵 YouTube Audio Downloader
    ============================
    🌐 http://localhost:${PORT}

    📡 API Endpoints:
    • GET /api/download/:videoId - Download with metadata
    • GET /api/info/:videoId     - Get info only
    • GET /api/stream/:videoId   - Stream audio
    • GET /api/list              - List downloaded files
    • DELETE /api/delete/:file   - Delete file

    📁 Downloads: ${DOWNLOAD_DIR}
    ============================
    `);

    exec(`${YTDLP} --version`, (err, stdout) => {
        if (err) {
            console.log('❌ yt-dlp not found!');
        } else {
            console.log(`✅ yt-dlp: ${stdout.trim()}`);
        }
    });

    exec('ffmpeg -version', (err, stdout) => {
        if (err) {
            console.log('❌ ffmpeg not found! (Required for MP3)');
        } else {
            console.log('✅ ffmpeg: installed');
        }
    });
});
