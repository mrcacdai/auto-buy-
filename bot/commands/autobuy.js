/**
 * bot/commands/autobuy.js
 * ───────────────────────
 */

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
} = require('discord.js');

const fs = require('fs');
const path = require('path');
const { formatNumber, formatStock } = require('../../utils/parser');

const CONFIG_PATH = path.join(__dirname, '..', '..', 'config.json');

function loadConfig() {
  delete require.cache[CONFIG_PATH];
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

const data = new SlashCommandBuilder()
  .setName('autobuy')
  .setDescription('Hiển thị bảng mua tiền in-game')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

function buildPanel(config) {
  const { baseAmount, basePrice, currency } = config.price;
  const stock = Number(config.stock) || 0;
  const isOutOfStock = stock <= 0;

  const embed = new EmbedBuilder()
    .setColor(isOutOfStock ? 0xed4245 : 0x2b2d31)
    .setTitle('💰 Auto Buy Money ')
    .setDescription(
      [
        '```',
        '',
        '     DONUT SMP — MUA TIỀN GAME     ',
        '',
        '```',
      ].join('\n')
    )
    .addFields(
      {
        name: '🏷️ Giá Tiền',
        value: `\`${formatStock(baseAmount)}\` tiền game = **${formatNumber(basePrice)} ${currency}**`,
        inline: true,
      },
      {
        name: '📦 Kho Hàng',
        value: isOutOfStock
          ? '`❌ Hết Hàng`'
          : `\`${formatStock(stock)}\` tiền game còn lại`,
        inline: true,
      },
      {
        name: '📋 Hướng Dẫn Mua',
        value: [
          '1️⃣ Bấm nút **Mua Tiền** bên dưới',
          '2️⃣ Điền số tiền, phương thức & IGN',
          '• **Ngân hàng / Momo**: Quét mã QR chuyển khoản',
          '• **Thẻ cào / Card**: Dùng lệnh `/gachthe` nạp vào số dư trước, sau đó điền `Card` để mua bằng số dư!',
          '3️⃣ Chờ hệ thống tự động giao tiền in-game qua `/pay`!',
        ].join('\n'),
      },
      {
        name: '⚠️ Lưu Ý',
        value: [
          '🔴 Đọc kỹ hướng dẫn trước khi giao dịch',
          '🚫 Không spam hoặc tạo đơn sai mục đích',
          '🔴 nhập đúng ign sai không hoàn tiền',
        ].join('\n'),
      }
    )
    .setImage('https://media.discordapp.net/attachments/1526667286377922560/1558526049569210429/075f9ecdc07f5d25d3d0bb778be8c609.jpg?ex=6acbc1fe&is=6aca707e&hm=95e4e4b19918b28e12f51a1dcb7995d57b7c723ad8c8f67c0865a7afcbfa9c75&=&format=webp')
    .setThumbnail('https://i.imgur.com/3Y7yZ1c.png')
    .setFooter({ text: 'Auto Buy Money • make by Maivs' })
    .setTimestamp();

  const buyButton = new ButtonBuilder()
    .setCustomId('buy_money');

  if (isOutOfStock) {
    buyButton
      .setLabel('❌ Hết Hàng')
      .setStyle(ButtonStyle.Danger) // Màu đỏ
      .setDisabled(true);           // Khóa sử dụng
  } else {
    buyButton
      .setLabel('💸 Mua Tiền')
      .setStyle(ButtonStyle.Success) // Màu xanh
      .setDisabled(false);
  }

  const row = new ActionRowBuilder().addComponents(buyButton);

  return { embeds: [embed], components: [row] };
}

async function updatePanel(client, customConfig = null) {
  try {
    const config = customConfig || loadConfig();
    if (!config.panelMessage) return false;
    const { channelId, messageId } = config.panelMessage;
    if (!channelId || !messageId) return false;

    const discord = client || global.discordClient;
    if (!discord) return false;

    const channel = await discord.channels.fetch(channelId);
    if (!channel) return false;
    const msg = await channel.messages.fetch(messageId);
    if (!msg) return false;

    const panelData = buildPanel(config);
    await msg.edit(panelData);
    return true;
  } catch (err) {
    console.error('[Discord] Lỗi updatePanel:', err.message);
    return false;
  }
}

async function execute(interaction) {
  const config = loadConfig();
  const panelData = buildPanel(config);

  const reply = await interaction.reply({ ...panelData, fetchReply: true });

  config.panelMessage = {
    channelId: reply.channelId,
    messageId: reply.id
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

module.exports = { data, execute, buildPanel, updatePanel };
