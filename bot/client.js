/**
 * bot/client.js
 * ─────────────
 * Tạo và khởi chạy Discord.js v14 client.
 * Đăng ký slash commands và kết nối interaction handler.
 */

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  Collection,
} = require('discord.js');

const autobuyCommand = require('./commands/autobuy');
const gachtheCommand = require('./commands/gachthe');
const soduCommand = require('./commands/sodu');
const { handleInteraction } = require('./handlers/interaction');

/**
 * Khởi động bot Discord và trả về client instance.
 * @param {import('socket.io').Server} io - Server Socket.io để phát log
 */
async function startDiscordBot(io) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
    ],
  });

  // ── Lưu trữ đơn hàng đang chờ: Map<discordUserId, orderData> ──
  client.pendingOrders = new Collection();
  // ── Lưu trữ thẻ cào đang chờ xử lý: Map<requestId, cardData> ──
  client.pendingCards = new Collection();

  // ── Hàm gửi log tới web panel console ──
  client.webLog = (message) => {
    const line = `[Discord] ${new Date().toLocaleTimeString()} — ${message}`;
    console.log(line);
    io.emit('log', line);
  };

  // ── Đăng ký slash commands với Discord API ──
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  const commands = [
    autobuyCommand.data.toJSON(),
    gachtheCommand.data.toJSON(),
    soduCommand.data.toJSON(),
  ];

  await rest.put(
    Routes.applicationGuildCommands(
      process.env.DISCORD_CLIENT_ID,
      process.env.GUILD_ID,
    ),
    { body: commands },
  );

  // ── Xử lý tương tác ──
  client.on('interactionCreate', (interaction) =>
    handleInteraction(interaction, client, io),
  );

  // ── Sự kiện bot sẵn sàng ──
  client.on('ready', () => {
    client.webLog(`Bot đã online: ${client.user.tag}`);
  });

  // ── Đăng nhập ──
  await client.login(process.env.DISCORD_TOKEN);

  return client;
}

module.exports = { startDiscordBot };
