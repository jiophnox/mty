const express = require('express');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const https = require('https');

const execPromise = promisify(exec);
const app = express();
const PORT = 3000;

// yt-dlp path
const YTDLP = 'yt-dlp';

// Download folder
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');

// Create downloads folder if not exists
if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

// Serve static files
app.use(express.static('public'));
app.use('/downloads', express.static(DOWNLOAD_DIR));

// ============ MAIN DOWNLOAD FUNCTION ============

async function downloadAudio(videoId) {
    const url = `https://www.youtube.com/watch?v=${videoId}`;

    console.log(`\n🎵 Processing: ${videoId}`);

    try {
        // Step 1: Get video info
        console.log('📋 Getting info...');
        const { stdout: infoJson } = await execPromise(`${YTDLP} -j "${url}"`);
        const info = JSON.parse(infoJson);

        const title = info.title;
        const artist = info.uploader || info.channel || 'Unknown Artist';
        const thumbnail = info.thumbnail;
        const duration = info.duration;

        console.log(`   Title: ${title}`);
        console.log(`   Artist: ${artist}`);

        // Clean filename
        const safeTitle = title.replace(/[<>:"/\\|?*]/g, '').substring(0, 100);
        const filename = `${safeTitle}.mp3`;
        const filepath = path.join(DOWNLOAD_DIR, filename);
        const thumbnailPath = path.join(DOWNLOAD_DIR, `${videoId}_thumb.jpg`);

        // Step 2: Download thumbnail
        console.log('🖼️ Downloading thumbnail...');
        await downloadThumbnail(thumbnail, thumbnailPath);

        // Step 3: Download audio with metadata
        console.log('⬇️ Downloading audio with metadata...');

        const ytdlpCommand = `${YTDLP} -x --audio-format mp3 --audio-quality 0 \
            --embed-thumbnail \
            --add-metadata \
            --parse-metadata "uploader:%(artist)s" \
            --parse-metadata "title:%(title)s" \
            --ppa "ffmpeg:-metadata artist='${artist.replace(/'/g, "").replace(/"/g, "")}' -metadata title='${title.replace(/'/g, "").replace(/"/g, "")}'" \
            -o "${filepath}" \
            --no-playlist \
            "${url}"`;

        await execPromise(ytdlpCommand);

        // Check if file exists
        if (!fs.existsSync(filepath)) {
            throw new Error('Download failed - file not created');
        }

        const stats = fs.statSync(filepath);

        // Clean up thumbnail temp file
        if (fs.existsSync(thumbnailPath)) {
            fs.unlinkSync(thumbnailPath);
        }

        console.log(`✅ Downloaded: ${filename}`);
        console.log(`📁 Size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

        // Return result
        return {
            success: true,
            videoId: videoId,
            title: title,
            artist: artist,
            thumbnail: thumbnail,
            duration: duration,
            filename: filename,
            filepath: filepath,
            filesize: stats.size,
            filesizeMB: (stats.size / 1024 / 1024).toFixed(2),
            downloadUrl: `/downloads/${encodeURIComponent(filename)}`,
            streamUrl: `/downloads/${encodeURIComponent(filename)}`
        };

    } catch (error) {
        console.error(`❌ Error: ${error.message}`);
        return {
            success: false,
            videoId: videoId,
            error: error.message
        };
    }
}

// Download thumbnail helper
function downloadThumbnail(url, filepath) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(filepath);
        https.get(url, (response) => {
            if (response.statusCode === 302 || response.statusCode === 301) {
                https.get(response.headers.location, (res) => {
                    res.pipe(file);
                    file.on('finish', () => { file.close(); resolve(); });
                }).on('error', reject);
            } else {
                response.pipe(file);
                file.on('finish', () => { file.close(); resolve(); });
            }
        }).on('error', reject);
    });
}

// ============ API ROUTES ============

// Download and get info
app.get('/api/download/:videoId', async (req, res) => {
    const { videoId } = req.params;
    const result = await downloadAudio(videoId);
    res.json(result);
});

// Get info only (no download)
app.get('/api/info/:videoId', async (req, res) => {
    try {
        const { videoId } = req.params;
        const url = `https://www.youtube.com/watch?v=${videoId}`;

        const { stdout } = await execPromise(`${YTDLP} -j "${url}"`);
        const info = JSON.parse(stdout);

        res.json({
            success: true,
            videoId: videoId,
            title: info.title,
            artist: info.uploader || info.channel,
            thumbnail: info.thumbnail,
            duration: info.duration,
            views: info.view_count
        });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Stream directly (without saving)
app.get('/api/stream/:videoId', async (req, res) => {
    try {
        const { videoId } = req.params;
        const url = `https://www.youtube.com/watch?v=${videoId}`;

        const { spawn } = require('child_process');

        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Transfer-Encoding', 'chunked');

        const ytdlp = spawn(YTDLP, [
            '-f', 'bestaudio',
            '-x', '--audio-format', 'mp3',
            '-o', '-',
            '--no-warnings',
            '--no-playlist',
            url
        ]);

        ytdlp.stdout.pipe(res);

        ytdlp.on('error', (err) => {
            if (!res.headersSent) res.status(500).json({ error: err.message });
        });

        req.on('close', () => ytdlp.kill());

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// List all downloaded files
app.get('/api/list', (req, res) => {
    const files = fs.readdirSync(DOWNLOAD_DIR)
        .filter(f => f.endsWith('.mp3'))
        .map(f => {
            const stats = fs.statSync(path.join(DOWNLOAD_DIR, f));
            return {
                filename: f,
                size: stats.size,
                sizeMB: (stats.size / 1024 / 1024).toFixed(2),
                downloadUrl: `/downloads/${encodeURIComponent(f)}`,
                createdAt: stats.birthtime
            };
        });

    res.json({ count: files.length, files });
});

// Delete a file
// Delete a file (using GET)
app.get('/api/delete/:filename', (req, res) => {
    try {
        // Decode the URL-encoded filename
        const filename = decodeURIComponent(req.params.filename);
        const filepath = path.join(DOWNLOAD_DIR, filename);

        console.log(`🗑️ Deleting: ${filename}`);

        if (fs.existsSync(filepath)) {
            fs.unlinkSync(filepath);
            console.log(`✅ Deleted: ${filename}`);
            res.json({ success: true, message: 'File deleted', filename: filename });
        } else {
            console.log(`❌ Not found: ${filename}`);
            res.status(404).json({ success: false, error: 'File not found' });
        }
    } catch (error) {
        console.error(`❌ Delete error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});



module.exports = { app, PORT, DOWNLOAD_DIR, YTDLP, exec };
