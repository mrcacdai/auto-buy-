/**
 * bot/commands/sodu.js
 * ────────────────────
 * Slash command /sodu
 * Cho phép thành viên kiểm tra số dư cá nhân đã nạp qua thẻ cào.
 */

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { getBalance } = require('../../utils/balanceManager');
const { formatNumber, formatStock } = require('../../utils/parser');

const CONFIG_PATH = path.join(__dirname, '..', '..', 'config.json');

function loadConfig() {
  delete require.cache[CONFIG_PATH];
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

const data = new SlashCommandBuilder()
  .setName('sodu')
  .setDescription('💳 Xem số dư tài khoản của bạn (đã nạp qua thẻ cào)');

async function execute(interaction) {
  const balance = getBalance(interaction.user.id);
  const config = loadConfig();
  const { baseAmount, basePrice } = config.price;

  // Tính số tiền game có thể đổi được với số dư này
  const convertibleGameMoney = balance > 0
    ? Math.floor((balance / basePrice) * baseAmount)
    : 0;

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('💳 Số Dư Tài Khoản')
    .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
    .setDescription(
      [
        `Xin chào **${interaction.user.username}**, đây là số dư tài khoản của bạn:`,
        '',
        `💵 **Số dư hiện có:** \`${formatNumber(balance)} VNĐ\``,
        `💰 **Quy đổi tiền game:** \`~${formatStock(convertibleGameMoney)}\` in-game money`,
        '',
        `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `💡 **Hướng dẫn:**`,
        `• Nạp thêm số dư: Dùng lệnh \`/gachthe\``,
        `• Mua tiền game: Bấm **💸 Mua Tiền** trên bảng Panel và nhập phương thức là \`card\` hoặc \`thẻ cào\`.`,
      ].join('\n')
    )
    .setFooter({ text: 'Auto Buy Money • Số dư được bảo mật an toàn' })
    .setTimestamp();

  return interaction.reply({
    embeds: [embed],
    flags: MessageFlags.Ephemeral,
  });
}

module.exports = { data, execute };
