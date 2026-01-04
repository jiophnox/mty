const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const { Innertube } = require('youtubei.js');

dotenv.config();

// ================== Config ==================
const token = process.env.TOKEN;
const bot = new TelegramBot(token, { polling: true });
const channelId = process.env.CHANNEL_ID;
const MONGO_URI = process.env.MONGO_URI;
const baseurl = process.env.BASE_URL; // https://342702a1-c71c-4858-8bd8-d9c58a2f2730-00-31ql65i7jsual.sisko.replit.dev
const MAX_SIZE = 20 * 1024 * 1024;

// ================== MongoDB ==================
mongoose.connect(MONGO_URI);
mongoose.connection.once('open', () => console.log('✅ MongoDB connected'));

const Music = mongoose.model('Music', new mongoose.Schema({
  videoId: { type: String, required: true, unique: true, index: true },
  title: String,
  artist: String,
  messageId: Number,
  createdAt: { type: Date, default: Date.now }
}));

// ================== YouTube ==================
let yt = null;
async function getYT() {
  if (!yt) yt = await Innertube.create({ cache: new Map(), generate_session_locally: true });
  return yt;
}

async function getChannelVideos(handle) {
  const youtube = await getYT();
  const cleanHandle = handle.replace('@', '');

  console.log(`🔍 Fetching: ${cleanHandle}`);

  let channelPage;
  try {
    const resolved = await youtube.resolveURL(`https://www.youtube.com/@${cleanHandle}`);
    if (resolved?.payload?.browseId) {
      channelPage = await youtube.getChannel(resolved.payload.browseId);
    }
  } catch (e) {
    const search = await youtube.search(`@${cleanHandle}`, { type: 'channel' });
    const ch = search.results?.find(r => r.author?.id || r.id);
    if (!ch) throw new Error('Channel not found');
    channelPage = await youtube.getChannel(ch.author?.id || ch.id);
  }

  const channelName = channelPage.metadata?.title || cleanHandle;

  let videos = [];
  let tab = await channelPage.getVideos();

  while (tab) {
    if (tab.videos?.length) {
      videos.push(...tab.videos);
      console.log(`📥 Loaded ${videos.length} videos...`);
    }
    if (tab.has_continuation) tab = await tab.getContinuation();
    else break;
  }

  console.log(`✅ Total: ${videos.length} videos`);

  return {
    channelName,
    videos: videos.map((v, i) => ({
      id: v.id,
      index: i + 1,
      title: v.title?.text || v.title || 'Unknown'
    }))
  };
}

// ================== Progress ==================
class Progress {
  constructor(bot, chatId, total) {
    this.bot = bot;
    this.chatId = chatId;
    this.total = total;
    this.current = 0;
    this.success = 0;
    this.failed = 0;
    this.skipped = 0;
    this.msgId = null;
    this.lastUpdate = 0;
  }

  async init() {
    const msg = await this.bot.sendMessage(this.chatId, this.format(), { parse_mode: 'Markdown' });
    this.msgId = msg.message_id;
  }

  format() {
    const pct = Math.round((this.current / this.total) * 100) || 0;
    const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
    return `📊 *Processing*\n\n${bar} ${pct}%\n\n` +
      `✅ ${this.success} | ❌ ${this.failed} | ⏭️ ${this.skipped}\n` +
      `🔄 ${this.current}/${this.total}`;
  }

  async update(status) {
    this.current++;
    if (status === 'success') this.success++;
    else if (status === 'failed') this.failed++;
    else this.skipped++;

    if (Date.now() - this.lastUpdate > 2000 || this.current === this.total) {
      this.lastUpdate = Date.now();
      await this.bot.editMessageText(this.format(), {
        chat_id: this.chatId,
        message_id: this.msgId,
        parse_mode: 'Markdown'
      }).catch(() => {});
    }
  }

  async complete() {
    await this.bot.editMessageText(
      `✅ *Complete!*\n\n✅ ${this.success} | ❌ ${this.failed} | ⏭️ ${this.skipped}`,
      { chat_id: this.chatId, message_id: this.msgId, parse_mode: 'Markdown' }
    ).catch(() => {});
  }
}

// ================== Send Audio ==================
async function sendAudio(videoId, title, channelName) {
  try {
    // Check exists
    if (await Music.findOne({ videoId })) {
      console.log(`⏭️ [${videoId}] Already exists`);
      return 'skipped';
    }

    console.log(`⬇️ [${videoId}] Downloading...`);

    // Call API
    const { data } = await axios.get(`${baseurl}/api/download/${videoId}`, { timeout: 180000 });

    if (!data.success || !data.downloadUrl) {
      console.log(`❌ [${videoId}] API failed`);
      return 'failed';
    }

    // ✅ FIXED: Build full URL correctly
    const downloadUrl = `${baseurl}${data.downloadUrl}`;
    console.log(`🔗 [${videoId}] URL: ${downloadUrl}`);

    // Check size from API response (no need for HEAD request)
    const filesize = data.filesize || 0;
    if (filesize > MAX_SIZE) {
      console.log(`⏭️ [${videoId}] Too large: ${data.filesizeMB}MB`);
      // Cleanup
      axios.get(`${baseurl}/api/delete/${data.filename}`).catch(() => {});
      return 'skipped';
    }

    console.log(`📊 [${videoId}] Size: ${data.filesizeMB}MB`);
    console.log(`📤 [${videoId}] Sending...`);

    // Send to Telegram
    const sent = await bot.sendAudio(channelId, downloadUrl, {
      caption: `🎵 ${data.title}\n👤 ${data.artist}`,
      title: data.title,
      performer: data.artist,
      duration: data.duration
    });

    // Save to DB
    await Music.create({
      videoId,
      title: data.title,
      artist: data.artist,
      messageId: sent.message_id
    });

    // Cleanup server file
    axios.get(`${baseurl}/api/delete/${data.filename}`).catch(() => {});

    console.log(`✅ [${videoId}] Done!`);
    return 'success';

  } catch (err) {
    console.error(`❌ [${videoId}] ${err.message}`);
    return 'failed';
  }
}

// ================== Active Ops ==================
const activeOps = new Map();

// ================== Commands ==================
bot.onText(/^\/start$/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `🎵 *YouTube Music Bot*\n\n` +
    `• Send YouTube URL\n` +
    `• \`/channel @name\`\n` +
    `• \`/channel @name | 10\`\n` +
    `• \`/channel @name | 10-50\`\n` +
    `• \`/stats\` • \`/cancel\``,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/^\/start (.+)/, async (msg, match) => {
  const music = await Music.findOne({ videoId: match[1] });
  if (music) await bot.copyMessage(msg.chat.id, channelId, music.messageId);
  else bot.sendMessage(msg.chat.id, '❌ Not found');
});

bot.onText(/^\/stats$/, async (msg) => {
  const total = await Music.countDocuments();
  const today = await Music.countDocuments({
    createdAt: { $gte: new Date(new Date().setHours(0,0,0,0)) }
  });
  bot.sendMessage(msg.chat.id, `📊 Total: ${total} | Today: ${today}`);
});

bot.onText(/^\/cancel$/, (msg) => {
  const op = activeOps.get(msg.chat.id);
  if (op) { op.cancelled = true; bot.sendMessage(msg.chat.id, '🛑 Cancelling...'); }
  else bot.sendMessage(msg.chat.id, 'ℹ️ Nothing to cancel');
});

// ================== Channel - ONE BY ONE ==================
bot.onText(/^\/channel\s+(.+)$/, async (msg, match) => {
  const chatId = msg.chat.id;

  if (activeOps.has(chatId)) return bot.sendMessage(chatId, '⚠️ Already running');

  const input = match[1].trim();
  let handle, start = null, end = null;

  if (input.includes('|')) {
    const [h, range] = input.split('|').map(s => s.trim());
    handle = h;
    if (range.includes('-')) [start, end] = range.split('-').map(n => parseInt(n));
    else start = parseInt(range);
  } else handle = input;

  const op = { cancelled: false };
  activeOps.set(chatId, op);

  try {
    const statusMsg = await bot.sendMessage(chatId, `🔍 Fetching ${handle}...`);
    const { channelName, videos } = await getChannelVideos(handle);

    if (!videos.length) {
      await bot.editMessageText('❌ No videos', { chat_id: chatId, message_id: statusMsg.message_id });
      return;
    }

    let list = videos;
    if (start) {
      const s = Math.max(1, start) - 1;
      const e = end ? Math.min(videos.length, end) : videos.length;
      list = videos.slice(s, e);
    }

    await bot.editMessageText(`📺 *${channelName}*\n📊 ${list.length} videos`, 
      { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'Markdown' });

    const progress = new Progress(bot, chatId, list.length);
    await progress.init();

    // ✅ ONE BY ONE
    for (const video of list) {
      if (op.cancelled) { await bot.sendMessage(chatId, '🛑 Cancelled'); break; }
      const status = await sendAudio(video.id, video.title, channelName);
      await progress.update(status);
    }

    await progress.complete();

  } catch (err) {
    console.error(err);
    bot.sendMessage(chatId, `❌ ${err.message}`);
  } finally {
    activeOps.delete(chatId);
  }
});

// ================== Single URL ==================
bot.on('message', async (msg) => {
  const text = msg.text;
  if (!text || text.startsWith('/') || !text.startsWith('http')) return;

  const match = text.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  if (!match) return bot.sendMessage(msg.chat.id, '❌ Invalid URL');

  const statusMsg = await bot.sendMessage(msg.chat.id, '⏳ Processing...');
  const result = await sendAudio(match[1], '', '');

  await bot.editMessageText(
    result === 'success' ? '✅ Sent!' : result === 'skipped' ? '⏭️ Exists/Too large' : '❌ Failed',
    { chat_id: msg.chat.id, message_id: statusMsg.message_id }
  );
});

bot.on('polling_error', (err) => console.error('Polling:', err.message));
console.log('🤖 Bot running...');
