const express    = require('express');
const { createClient } = require('bedrock-protocol');
const EventEmitter = require('events');
const path       = require('path');

const {
  Client: DiscordClient,
  GatewayIntentBits,
  EmbedBuilder,
  ActivityType,
} = require('discord.js');

// ─────────────────────────────────────────────
//  Config — Railway environment variables
//  Set these in your Railway service settings:
//    DISCORD_TOKEN, DISCORD_CLIENT_ID,
//    DISCORD_GUILD_ID, DISCORD_CHANNEL_ID
// ─────────────────────────────────────────────
const DISCORD_TOKEN      = process.env.DISCORD_TOKEN;
const DISCORD_CLIENT_ID  = process.env.DISCORD_CLIENT_ID;
const DISCORD_GUILD_ID   = process.env.DISCORD_GUILD_ID;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;

const DISCORD_ENABLED = !!DISCORD_TOKEN;

// ─────────────────────────────────────────────
//  Express
// ─────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────
//  Global SSE emitter
// ─────────────────────────────────────────────
const globalEmitter = new EventEmitter();
globalEmitter.setMaxListeners(50);

// ─────────────────────────────────────────────
//  Account sessions
// ─────────────────────────────────────────────
const accountData = new Map();

// ─────────────────────────────────────────────
//  Discord client
// ─────────────────────────────────────────────
let discord = null;
let discordChannel = null;

async function initDiscord() {
  discord = new DiscordClient({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
    ],
  });

  discord.once('ready', async () => {
    console.log(`🤖 Discord bot ready: ${discord.user.tag}`);
    discord.user.setActivity('donutsmp.net', { type: ActivityType.Watching });

    try {
      discordChannel = await discord.channels.fetch(DISCORD_CHANNEL_ID);
      discordChannel.send({
        embeds: [makeEmbed('🟢 Bot Manager Online', 'DonutSMP bot dashboard is running.', 0x00ff87)],
      }).catch(() => {});
    } catch (_) {
      console.warn('⚠️  Could not fetch Discord channel — check channelId in config.json');
    }
  });

  // ── Slash command handler ──────────────────
  discord.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const { commandName } = interaction;
    await interaction.deferReply();

    if (commandName === 'connect') {
      const email = interaction.options.getString('account');
      const existing = accountData.get(email);
      if (existing && ['Connecting', 'Online', 'Auth Required'].includes(existing.status)) {
        return interaction.editReply({ embeds: [makeEmbed('⚠️ Already Active', `\`${email}\` is already ${existing.status}.`, 0xffb830)] });
      }
      startBot(email, false);
      return interaction.editReply({ embeds: [makeEmbed('🚀 Connecting', `Starting connection for \`${email}\`...`, 0x00c6ff)] });
    }

    if (commandName === 'disconnect') {
      const email = interaction.options.getString('account');
      const bot = accountData.get(email);
      if (!bot) return interaction.editReply({ embeds: [makeEmbed('❌ Not Found', `No session for \`${email}\`.`, 0xff4560)] });
      bot.manualDisconnect = true;
      bot.disconnectHandled = true;
      bot.autoReconnect = false;
      clearTimeout(bot.reconnectTimer);
      if (bot.client) { try { bot.client.disconnect(); } catch (_) {} bot.client = null; }
      bot.status = 'Offline';
      addLog(email, '🔌 Disconnected via Discord.');
      broadcastUpdate(email);
      return interaction.editReply({ embeds: [makeEmbed('🔌 Disconnected', `\`${email}\` has been disconnected.`, 0xff4560)] });
    }

    if (commandName === 'chat') {
      const email   = interaction.options.getString('account');
      const message = interaction.options.getString('message');
      const bot = accountData.get(email);
      if (!bot?.client || bot.status !== 'Online') {
        return interaction.editReply({ embeds: [makeEmbed('❌ Bot Offline', `\`${email}\` is not online.`, 0xff4560)] });
      }
      bot.client.queue('text', {
        type: 'raw', needs_translation: false,
        source_name: '', message: String(message),
        xuid: '', platform_chat_id: '',
      });
      addLog(email, `📤 Discord -> Game: ${message}`);
      return interaction.editReply({ embeds: [makeEmbed('📤 Sent', `\`${message}\` -> \`${email}\``, 0x00ff87)] });
    }

    if (commandName === 'status') {
      if (accountData.size === 0) {
        return interaction.editReply({ embeds: [makeEmbed('📊 Status', 'No active sessions.', 0x5865f2)] });
      }
      const lines = [];
      for (const [email, d] of accountData.entries()) {
        const icon = { Online:'🟢', Connecting:'🟡', 'Auth Required':'🔵', Error:'🔴', Offline:'⚫' }[d.status] ?? '⚫';
        lines.push(`${icon} **${email}** — ${d.status} (reconnects: ${d.reconnectAttempts})`);
      }
      return interaction.editReply({ embeds: [makeEmbed('📊 Session Status', lines.join('\n'), 0x5865f2)] });
    }

    if (commandName === 'reconnect') {
      const email   = interaction.options.getString('account');
      const enabled = interaction.options.getBoolean('enabled');
      const bot = accountData.get(email);
      if (!bot) return interaction.editReply({ embeds: [makeEmbed('❌ Not Found', `No session for \`${email}\`.`, 0xff4560)] });
      bot.autoReconnect = enabled;
      addLog(email, `🔁 Auto-reconnect set to ${enabled ? 'ON' : 'OFF'} via Discord.`);
      broadcastUpdate(email);
      return interaction.editReply({ embeds: [makeEmbed('🔁 Auto-Reconnect', `Set to **${enabled ? 'ON' : 'OFF'}** for \`${email}\`.`, 0x00ff87)] });
    }
  });

  await discord.login(DISCORD_TOKEN);
}

// ─────────────────────────────────────────────
//  Discord helpers
// ─────────────────────────────────────────────
function makeEmbed(title, description, color = 0x00ff87) {
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color)
    .setTimestamp()
    .setFooter({ text: 'DonutSMP Bot Manager' });
}

function discordNotify(title, description, color) {
  if (!discordChannel) return;
  discordChannel.send({ embeds: [makeEmbed(title, description, color)] }).catch(() => {});
}

function discordUpdateActivity() {
  if (!discord?.user) return;
  const online = [...accountData.values()].filter(b => b.status === 'Online').length;
  const total  = accountData.size;
  discord.user.setActivity(
    total === 0 ? 'donutsmp.net' : `${online}/${total} bots online`,
    { type: ActivityType.Watching }
  );
}

// ─────────────────────────────────────────────
//  SSE
// ─────────────────────────────────────────────
app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  globalEmitter.on('update', send);
  req.on('close', () => { clearInterval(heartbeat); globalEmitter.off('update', send); });
});

// ─────────────────────────────────────────────
//  GET /status
// ─────────────────────────────────────────────
app.get('/status', (req, res) => {
  const out = {};
  for (const [email, d] of accountData.entries()) {
    out[email] = {
      status: d.status, logs: d.logs.slice(-80),
      autoReconnect: d.autoReconnect,
      reconnectAttempts: d.reconnectAttempts,
      deviceCode: d.deviceCode,
    };
  }
  res.json(out);
});

// ─────────────────────────────────────────────
//  GET /discord-status
// ─────────────────────────────────────────────
app.get('/discord-status', (req, res) => {
  res.json({
    enabled: DISCORD_ENABLED,
    connected: discord?.isReady() ?? false,
    tag: discord?.user?.tag ?? null,
  });
});

// ─────────────────────────────────────────────
//  POST /connect
// ─────────────────────────────────────────────
app.post('/connect', (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });
  const existing = accountData.get(email);
  if (existing && ['Connecting', 'Online', 'Auth Required'].includes(existing.status)) {
    return res.status(400).json({ error: 'Already connecting or connected' });
  }
  startBot(email, false);
  res.json({ success: true });
});

// ─────────────────────────────────────────────
//  POST /disconnect
// ─────────────────────────────────────────────
app.post('/disconnect', (req, res) => {
  const { email } = req.body;
  const bot = accountData.get(email);
  if (!bot) return res.status(400).json({ error: 'Session not found' });
  bot.manualDisconnect = true;
  bot.disconnectHandled = true;
  bot.autoReconnect = false;
  clearTimeout(bot.reconnectTimer);
  bot.reconnectTimer = null;
  if (bot.client) { try { bot.client.disconnect(); } catch (_) {} bot.client = null; }
  bot.status = 'Offline';
  addLog(email, '🔌 Manually disconnected.');
  broadcastUpdate(email);
  res.json({ success: true });
});

// ─────────────────────────────────────────────
//  GET /chat
// ─────────────────────────────────────────────
app.get('/chat', (req, res) => {
  const { email, message } = req.query;
  const bot = accountData.get(email);
  if (bot?.client && bot.status === 'Online') {
    bot.client.queue('text', {
      type: 'raw', needs_translation: false,
      source_name: '', message: String(message),
      xuid: '', platform_chat_id: '',
    });
    addLog(email, `📤 You: ${message}`);
    res.send('OK');
  } else {
    res.status(400).send('Bot offline');
  }
});

// ─────────────────────────────────────────────
//  POST /toggle-reconnect
// ─────────────────────────────────────────────
app.post('/toggle-reconnect', (req, res) => {
  const { email } = req.body;
  const bot = accountData.get(email);
  if (!bot) return res.status(400).json({ error: 'Session not found' });
  bot.autoReconnect = !bot.autoReconnect;
  addLog(email, `🔁 Auto-reconnect ${bot.autoReconnect ? 'ENABLED' : 'DISABLED'}`);
  broadcastUpdate(email);
  res.json({ autoReconnect: bot.autoReconnect });
});

// ─────────────────────────────────────────────
//  POST /test-reconnect
// ─────────────────────────────────────────────
app.post('/test-reconnect', (req, res) => {
  const { email } = req.body;
  const bot = accountData.get(email);
  if (!bot) return res.status(400).json({ error: 'Session not found' });
  if (!bot.client || bot.status !== 'Online') {
    return res.status(400).json({ error: 'Bot must be online to test reconnect' });
  }
  addLog(email, '⚡ TEST: Forcing disconnect to verify reconnect logic...');
  broadcastUpdate(email);
  try { bot.client.disconnect(); } catch (_) {}
  res.json({ success: true });
});

// ─────────────────────────────────────────────
//  POST /set-reconnect
// ─────────────────────────────────────────────
app.post('/set-reconnect', (req, res) => {
  const { email, enabled } = req.body;
  const bot = accountData.get(email);
  if (!bot) return res.status(400).json({ error: 'Session not found' });
  bot.autoReconnect = !!enabled;
  addLog(email, `🔁 Auto-reconnect set to ${bot.autoReconnect ? 'ON' : 'OFF'}`);
  broadcastUpdate(email);
  res.json({ autoReconnect: bot.autoReconnect });
});

// ─────────────────────────────────────────────
//  Internal helpers
// ─────────────────────────────────────────────
function addLog(email, message) {
  const bot = accountData.get(email);
  if (!bot) return;
  bot.logs.push({ time: new Date().toLocaleTimeString('en-US', { hour12: false }), message });
  if (bot.logs.length > 200) bot.logs.shift();
  broadcastUpdate(email);
}

function broadcastUpdate(email) {
  const bot = accountData.get(email);
  if (!bot) return;
  globalEmitter.emit('update', {
    type: 'update', email,
    status: bot.status, logs: bot.logs.slice(-30),
    autoReconnect: bot.autoReconnect,
    reconnectAttempts: bot.reconnectAttempts,
    deviceCode: bot.deviceCode,
  });
  discordUpdateActivity();
}

// ─────────────────────────────────────────────
//  handleSessionEnd
// ─────────────────────────────────────────────
function handleSessionEnd(email, reason, isError = false) {
  const bot = accountData.get(email);
  if (!bot || bot.disconnectHandled) return;
  bot.disconnectHandled = true;
  bot.status = isError ? 'Error' : 'Offline';
  bot.client = null;

  addLog(email, `${isError ? '❌' : '🔌'} ${reason}`);
  broadcastUpdate(email);

  discordNotify(
    isError ? '❌ Bot Error' : '🔌 Bot Disconnected',
    `\`${email}\` — ${reason}${bot.autoReconnect && !bot.manualDisconnect ? '\n🔁 Auto-reconnect is scheduled.' : ''}`,
    isError ? 0xff4560 : 0xffb830
  );

  if (!bot.manualDisconnect && bot.autoReconnect) {
    scheduleReconnect(email);
  }
}

// ─────────────────────────────────────────────
//  startBot
// ─────────────────────────────────────────────
function startBot(email, isReconnect = false) {
  if (!accountData.has(email)) {
    accountData.set(email, {
      client: null, status: 'Connecting', logs: [],
      autoReconnect: true, reconnectAttempts: 0,
      manualDisconnect: false, deviceCode: null,
      reconnectTimer: null, disconnectHandled: false,
    });
  }

  const bot = accountData.get(email);
  bot.status = 'Connecting';
  bot.deviceCode = null;
  bot.manualDisconnect = false;
  bot.disconnectHandled = false;

  if (isReconnect) {
    bot.reconnectAttempts += 1;
    addLog(email, `🔄 Reconnect attempt #${bot.reconnectAttempts} — connecting to donutsmp.net...`);
  } else {
    bot.reconnectAttempts = 0;
    addLog(email, '🚀 Starting connection to donutsmp.net:19132...');
    discordNotify('🚀 Connecting', `\`${email}\` is connecting to donutsmp.net...`, 0x00c6ff);
  }

  broadcastUpdate(email);

  let client;
  try {
    client = createClient({
      host: 'donutsmp.net',
      port: 19132,
      username: email.includes('@') ? email.split('@')[0] : email,
      offline: false,
      onMsaCode(data) {
        bot.deviceCode = {
          userCode: data.user_code,
          verificationUri: data.verification_uri,
          expiresIn: data.expires_in,
        };
        bot.status = 'Auth Required';
        addLog(email, `🔑 Microsoft auth required!`);
        addLog(email, `   -> Visit: ${data.verification_uri}`);
        addLog(email, `   -> Code:  ${data.user_code}  (expires in ${Math.round(data.expires_in / 60)} min)`);
        broadcastUpdate(email);

        // Send auth code to Discord so you can auth from your phone
        discordNotify(
          '🔑 Microsoft Auth Required',
          `**Account:** \`${email}\`\n**Code:** \`${data.user_code}\`\n**URL:** ${data.verification_uri}\n**Expires in:** ${Math.round(data.expires_in / 60)} minutes`,
          0x00c6ff
        );
      },
    });
  } catch (err) {
    bot.status = 'Error';
    addLog(email, `❌ Client creation failed: ${err.message}`);
    broadcastUpdate(email);
    scheduleReconnect(email);
    return;
  }

  bot.client = client;

  client.on('spawn', () => {
    bot.status = 'Online';
    bot.reconnectAttempts = 0;
    bot.deviceCode = null;
    bot.disconnectHandled = false;
    addLog(email, '✅ Spawned! Connected to donutsmp.net.');
    broadcastUpdate(email);
    discordNotify('✅ Bot Online', `\`${email}\` has spawned on donutsmp.net.`, 0x00ff87);

    try {
      client.queue('text', {
        type: 'raw', needs_translation: false,
        source_name: '', message: '/home 1',
        xuid: '', platform_chat_id: '',
      });
      addLog(email, '🏠 Sent: /home 1');
    } catch (err) {
      addLog(email, `⚠️ Failed to send /home 1 — ${err.message}`);
    }
  });

  client.on('join', () => {
    addLog(email, '📶 Joined server — waiting for spawn...');
  });

  // Mirror in-game chat to the Discord channel
  client.on('text', (packet) => {
    const msg = packet.message || packet.parameters?.join(' ');
    if (!msg) return;
    addLog(email, `💬 ${msg}`);
    if (discordChannel && msg.trim()) {
      discordChannel.send(`💬 \`${email}\` **[in-game]:** ${msg.slice(0, 1900)}`).catch(() => {});
    }
  });

  // PRIMARY: packet 0x05
  client.on('disconnect', (packet) => {
    const reason = packet?.message
      ? `Disconnected by server — ${packet.message}`
      : 'Disconnected by server (packet 0x05)';
    handleSessionEnd(email, reason);
  });

  // FALLBACK 1: clean TCP close
  client.on('end', () => {
    handleSessionEnd(email, 'Connection ended (socket closed by server)');
  });

  // FALLBACK 2: abrupt socket close
  client.on('close', (hadError) => {
    handleSessionEnd(email, hadError ? 'Connection lost (socket error)' : 'Connection closed', hadError);
  });

  // FALLBACK 3: errors
  client.on('error', (err) => {
    handleSessionEnd(email, `Error — ${err.message}`, true);
  });
}

// ─────────────────────────────────────────────
//  Reconnect scheduler
// ─────────────────────────────────────────────
function scheduleReconnect(email) {
  const bot = accountData.get(email);
  if (!bot || bot.manualDisconnect || !bot.autoReconnect) return;

  const delay = Math.min(5000 * Math.pow(1.5, Math.min(bot.reconnectAttempts, 12)), 60000);
  const secs  = (delay / 1000).toFixed(1);

  addLog(email, `⏱️  Auto-reconnect in ${secs}s (attempt ${bot.reconnectAttempts + 1})`);
  broadcastUpdate(email);

  clearTimeout(bot.reconnectTimer);
  bot.reconnectTimer = setTimeout(() => {
    if (!bot.manualDisconnect && bot.autoReconnect) startBot(email, true);
  }, delay);
}

// ─────────────────────────────────────────────
//  Start — Express binds first so Railway health
//  checks pass, then Discord initialises async
// ─────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  🍩  DonutSMP Bot GUI  ->  http://0.0.0.0:${PORT}`);
  console.log(`  🤖  Discord bot: ${DISCORD_ENABLED ? 'ENABLED' : 'DISABLED (set DISCORD_TOKEN env var)'}\n`);

  // Start Discord AFTER Express is bound so a Discord crash can't block the port
  if (DISCORD_ENABLED) {
    initDiscord().catch(err => console.error('Discord init failed:', err.message));
  }
});
