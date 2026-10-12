/**
 * bot/commands/gachthe.js
 * ───────────────────────
 * Slash command /gachthe
 * Gạch thẻ cào tự động và nhận tiền game Minecraft.
 */

const {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const { sendCard, getStatusDescription } = require('../../utils/cardService');
const { formatNumber, formatStock } = require('../../utils/parser');

const CONFIG_PATH = path.join(__dirname, '..', '..', 'config.json');

function loadConfig() {
  delete require.cache[CONFIG_PATH];
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

const data = new SlashCommandBuilder()
  .setName('gachthe')
  .setDescription('💳 Gạch thẻ cào tự động để nạp tiền game')
  .addStringOption((option) =>
    option
      .setName('telco')
      .setDescription('Loại thẻ cào')
      .setRequired(true)
      .addChoices(
        { name: 'Viettel', value: 'VIETTEL' },
        { name: 'Vinaphone', value: 'VINAPHONE' },
        { name: 'Mobifone', value: 'MOBIFONE' },
        { name: 'Vietnamobile', value: 'VIETNAMOBILE' },
        { name: 'Zing', value: 'ZING' },
        { name: 'Gate', value: 'GATE' },
        { name: 'Garena', value: 'GARENA' },
      )
  )
  .addIntegerOption((option) =>
    option
      .setName('amount')
      .setDescription('Mệnh giá thẻ cào')
      .setRequired(true)
      .addChoices(
        { name: '10.000 VNĐ', value: 10000 },
        { name: '20.000 VNĐ', value: 20000 },
        { name: '30.000 VNĐ', value: 30000 },
        { name: '50.000 VNĐ', value: 50000 },
        { name: '100.000 VNĐ', value: 100000 },
        { name: '200.000 VNĐ', value: 200000 },
        { name: '300.000 VNĐ', value: 300000 },
        { name: '500.000 VNĐ', value: 500000 },
        { name: '1.000.000 VNĐ', value: 1000000 },
      )
  )
  .addStringOption((option) =>
    option
      .setName('code')
      .setDescription('Mã thẻ cào (mã PIN sau lớp tráng bạc)')
      .setRequired(true)
  )
  .addStringOption((option) =>
    option
      .setName('serial')
      .setDescription('Số serial in trên thẻ')
      .setRequired(true)
  )
  .addStringOption((option) =>
    option
      .setName('ign')
      .setDescription('Tên nhân vật Minecraft (IGN) nhận tiền game')
      .setRequired(true)
  );

async function execute(interaction) {
  // Trả lời riêng tư (Ephemeral) để tránh lộ mã PIN thẻ trong kênh chat
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const telco = interaction.options.getString('telco');
  const amount = interaction.options.getInteger('amount');
  const code = interaction.options.getString('code').trim();
  const serial = interaction.options.getString('serial').trim();
  const ign = interaction.options.getString('ign').trim();

  const config = loadConfig();
  const { baseAmount, basePrice } = config.price;

  // Tính số tiền game tương ứng với mệnh giá thẻ
  const estimatedGameMoney = Math.floor((amount / basePrice) * baseAmount);

  // Kiểm tra kho hàng
  if ((config.stock || 0) < estimatedGameMoney) {
    return interaction.editReply({
      content: `❌ **Kho hàng không đủ để giao dịch:** Cần \`${formatStock(estimatedGameMoney)}\` nhưng kho chỉ còn \`${formatStock(config.stock || 0)}\` tiền game. Vui lòng liên hệ Admin.`,
    });
  }

  // Tạo request_id duy nhất
  const requestId = `CARD_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

  // Ghi log ra web panel
  if (interaction.client.webLog) {
    interaction.client.webLog(
      `[Gạch Thẻ] Người dùng ${interaction.user.tag} gửi thẻ ${telco} ${formatNumber(amount)}đ (IGN: ${ign})`,
    );
  }

  // Lưu vào danh sách thẻ chờ duyệt của bot
  if (interaction.client.pendingCards) {
    interaction.client.pendingCards.set(requestId, {
      requestId,
      userId: interaction.user.id,
      userTag: interaction.user.tag,
      telco,
      code,
      serial,
      amount,
      ign,
      estimatedGameMoney,
      createdAt: Date.now(),
    });
  }

  // Gửi thẻ lên hệ thống gạch thẻ
  const result = await sendCard({ telco, code, serial, amount, requestId });

  if (!result.success && !result.data) {
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xed4245)
          .setTitle('❌ Gửi Thẻ Thất Bại')
          .setDescription(`Lỗi kết nối tới hệ thống gạch thẻ: \`${result.error}\`\nVui lòng thử lại sau ít phút hoặc báo Admin.`)
          .setTimestamp(),
      ],
    });
  }

  const responseData = result.data || {};
  const statusCode = Number(responseData.status);
  const statusMsg = responseData.message || getStatusDescription(statusCode);

  // ── Trường hợp 99: Đang chờ duyệt (Phổ biến nhất) ──
  if (statusCode === 99) {
    const embed = new EmbedBuilder()
      .setColor(0xfaa61a) // Vàng cam
      .setTitle('⏳ Thẻ Đang Chờ Xử Lý')
      .setDescription(
        [
          `Hệ thống đã tiếp nhận thẻ của bạn và đang gửi tới nhà mạng để thẩm định.`,
          `Khi duyệt thành công, tiền game sẽ được tự động chuyển qua lệnh \`/pay\` tới tài khoản Minecraft.`,
          '',
          `**Nhà mạng:** \`${telco}\``,
          `**Mệnh giá khai báo:** \`${formatNumber(amount)} VNĐ\``,
          `**Tiền game dự kiến:** \`${formatStock(estimatedGameMoney)}\``,
          `**Nhân vật nhận (IGN):** \`${ign}\``,
          `**Mã serial:** \`${serial}\``,
          `**Mã giao dịch (ID):** \`${requestId}\``,
        ].join('\n')
      )
      .setFooter({ text: 'Vui lòng không gửi lại thẻ nhiều lần' })
      .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
  }

  // ── Trường hợp 1: Thành công ngay lập tức ──
  if (statusCode === 1) {
    const embed = new EmbedBuilder()
      .setColor(0x57f287) // Xanh lá
      .setTitle('✅ Nạp Thẻ Thành Công!')
      .setDescription(
        [
          `Thẻ đã được gạch thành công đúng mệnh giá!`,
          '',
          `**Nhà mạng:** \`${telco}\``,
          `**Mệnh giá:** \`${formatNumber(amount)} VNĐ\``,
          `**Tiền game:** \`${formatStock(estimatedGameMoney)}\``,
          `**IGN:** \`${ign}\``,
        ].join('\n')
      )
      .setTimestamp();

    // Thực hiện /pay ngay
    const { mcBot } = global;
    if (mcBot && typeof mcBot.sendPayCommand === 'function') {
      mcBot.sendPayCommand(ign, estimatedGameMoney);
    }

    // Trừ kho
    config.stock = Math.max(0, config.stock - estimatedGameMoney);
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');

    return interaction.editReply({ embeds: [embed] });
  }

  // ── Trường hợp lỗi khác (3: Sai thẻ, 100: Thất bại...) ──
  const failEmbed = new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle('❌ Nạp Thẻ Không Thành Công')
    .setDescription(
      [
        `Hệ thống từ chối thẻ của bạn.`,
        '',
        `**Trạng thái:** \`${statusMsg}\` (Mã: ${statusCode})`,
        `**Nhà mạng:** \`${telco}\``,
        `**Serial:** \`${serial}\``,
        `**Mệnh giá:** \`${formatNumber(amount)} VNĐ\``,
        '',
        `*Gợi ý: Kiểm tra lại mã PIN và Serial trên thẻ hoặc xem thẻ đã từng sử dụng chưa.*`,
      ].join('\n')
    )
    .setTimestamp();

  return interaction.editReply({ embeds: [failEmbed] });
}

module.exports = { data, execute };
