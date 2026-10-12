/**
 * bot/commands/gachthe.js
 * ───────────────────────
 * Slash command /gachthe
 * Gạch thẻ cào tự động và lưu số tiền vào SỐ DƯ CÁ NHÂN của member.
 */

const {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
} = require('discord.js');
const { sendCard, getStatusDescription } = require('../../utils/cardService');
const { formatNumber } = require('../../utils/parser');
const { addBalance, getBalance } = require('../../utils/balanceManager');

const data = new SlashCommandBuilder()
  .setName('gachthe')
  .setDescription('💳 Gạch thẻ cào tự động để nạp tiền vào số dư tài khoản')
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
  );

async function execute(interaction) {
  // Trả lời riêng tư (Ephemeral) để bảo mật mã PIN thẻ
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const telco = interaction.options.getString('telco');
  const amount = interaction.options.getInteger('amount');
  const code = interaction.options.getString('code').trim();
  const serial = interaction.options.getString('serial').trim();

  // Validate mã thẻ và serial cơ bản (chỉ gồm chữ và số)
  if (!/^[a-zA-Z0-9]+$/.test(code) || !/^[a-zA-Z0-9]+$/.test(serial)) {
    return interaction.editReply({
      content: '❌ Mã thẻ (PIN) và số serial chỉ được chứa chữ cái và số, không chứa ký tự đặc biệt hoặc dấu cách.',
    });
  }

  // Tạo request_id duy nhất
  const requestId = `CARD_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

  // Ghi log ra web panel
  if (interaction.client.webLog) {
    interaction.client.webLog(
      `[Gạch Thẻ] ${interaction.user.tag} nạp thẻ ${telco} ${formatNumber(amount)}đ (Serial: ${serial})`,
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
    const currentBalance = getBalance(interaction.user.id);
    const embed = new EmbedBuilder()
      .setColor(0xfaa61a) // Vàng cam
      .setTitle('⏳ Thẻ Đang Chờ Xử Lý')
      .setDescription(
        [
          `Hệ thống đã tiếp nhận thẻ và gửi tới nhà mạng để thẩm định.`,
          `Khi duyệt thành công, tiền sẽ được tự động cộng vào **Số Dư Cá Nhân** của bạn!`,
          '',
          `**Nhà mạng:** \`${telco}\``,
          `**Mệnh giá khai báo:** \`${formatNumber(amount)} VNĐ\``,
          `**Mã serial:** \`${serial}\``,
          `**Số dư hiện tại của bạn:** \`${formatNumber(currentBalance)} VNĐ\``,
          `**Mã giao dịch (ID):** \`${requestId}\``,
          '',
          `💡 *Bạn có thể gõ lệnh \`/sodu\` để kiểm tra số dư bất cứ lúc nào.*`,
        ].join('\n')
      )
      .setFooter({ text: 'Vui lòng không gửi lại thẻ nhiều lần' })
      .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
  }

  // ── Trường hợp 1: Thành công ngay lập tức ──
  if (statusCode === 1) {
    // Cộng tiền vào số dư của member
    const depositResult = await addBalance(
      interaction.user.id,
      amount,
      'CARD_INSTANT',
      { telco, serial, requestId }
    );

    const newBalance = depositResult.success ? depositResult.newBalance : getBalance(interaction.user.id);

    const embed = new EmbedBuilder()
      .setColor(0x57f287) // Xanh lá
      .setTitle('✅ Nạp Thẻ Cào Thành Công!')
      .setDescription(
        [
          `Thẻ đã được gạch thành công và cộng vào số dư của bạn!`,
          '',
          `**Nhà mạng:** \`${telco}\``,
          `**Mệnh giá nạp:** \`+${formatNumber(amount)} VNĐ\``,
          `**Số dư hiện tại:** \`${formatNumber(newBalance)} VNĐ\``,
          '',
          `👉 *Bạn có thể dùng số dư này mua money in-game qua nút **💸 Mua Tiền** trên Discord!*`,
        ].join('\n')
      )
      .setTimestamp();

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
