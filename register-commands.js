// Run this ONCE to register slash commands with Discord:
//   node register-commands.js

const { REST, Routes, SlashCommandBuilder } = require('discord.js');

// Set these as environment variables or paste temporarily to register:
//   DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID
const DISCORD_TOKEN     = process.env.DISCORD_TOKEN     || 'YOUR_DISCORD_BOT_TOKEN';
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || 'YOUR_CLIENT_ID';
const DISCORD_GUILD_ID  = process.env.DISCORD_GUILD_ID  || 'YOUR_GUILD_ID';

const commands = [
  new SlashCommandBuilder()
    .setName('connect')
    .setDescription('Connect a Minecraft bot account to donutsmp.net')
    .addStringOption(o =>
      o.setName('account').setDescription('Account label (e.g. alt@outlook.com)').setRequired(true)),

  new SlashCommandBuilder()
    .setName('disconnect')
    .setDescription('Disconnect a Minecraft bot account')
    .addStringOption(o =>
      o.setName('account').setDescription('Account label').setRequired(true)),

  new SlashCommandBuilder()
    .setName('chat')
    .setDescription('Send a message or command in-game')
    .addStringOption(o =>
      o.setName('account').setDescription('Account label').setRequired(true))
    .addStringOption(o =>
      o.setName('message').setDescription('Message or /command to send').setRequired(true)),

  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show the status of all active bot sessions'),

  new SlashCommandBuilder()
    .setName('reconnect')
    .setDescription('Toggle or check auto-reconnect for an account')
    .addStringOption(o =>
      o.setName('account').setDescription('Account label').setRequired(true))
    .addBooleanOption(o =>
      o.setName('enabled').setDescription('Turn auto-reconnect on or off').setRequired(true)),
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

(async () => {
  try {
    console.log('Registering slash commands...');
    await rest.put(
      Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID),
      { body: commands }
    );
    console.log('✅ Slash commands registered successfully.');
  } catch (err) {
    console.error('❌ Failed to register commands:', err);
  }
})();
