/**
 * bot/handlers/interaction.js
 * ───────────────────────────
 * Xử lý tương tác trung tâm cho:
 *   • Slash commands  (/autobuy)
 *   • Bấm nút        (buy_money)
 *   • Gửi Modal       (buy_money_modal)
 *
 * Luồng hoạt động:
 *   1. Người dùng bấm "Mua Tiền"  →  hiện Modal với 3 ô nhập
 *   2. Gửi Modal  →  tính giá, tạo QR, lưu đơn hàng chờ
 *   3. Webhook xác nhận thanh toán  →  Mineflayer thực hiện /pay (xử lý ở webhook route)
 */

const {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  EmbedBuilder,
  AttachmentBuilder,
  MessageFlags,
} = require('discord.js');

const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const { parseAmount, formatNumber, calculatePrice, formatStock } = require('../../utils/parser');

const CONFIG_PATH = path.join(__dirname, '..', '..', 'config.json');

function loadConfig() {
  delete require.cache[CONFIG_PATH];
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

// ── Cache thông tin Casso ──
let cachedCassoInfo = null;
async function getCassoInfo() {
  if (cachedCassoInfo) return cachedCassoInfo;
  const apiKey = process.env.BANK_API_KEY;
  if (!apiKey || apiKey.includes('YOUR_')) return null;

  try {
    const res = await fetch('https://oauth.casso.vn/v2/userInfo', {
      headers: { 'Authorization': `Apikey ${apiKey}` }
    });
    if (res.ok) {
      const json = await res.json();
      if (json.data && json.data.bankAccs && json.data.bankAccs.length > 0) {
        const acc = json.data.bankAccs[0];
        cachedCassoInfo = {
          bin: acc.bank?.bin,
          account: acc.bankSubAccId,
          name: acc.bankAccountName
        };
        return cachedCassoInfo;
      }
    }
  } catch (e) {
    console.error('[Casso] Lỗi lấy thông tin tài khoản:', e.message);
  }
  return null;
}

/**
 * Xử lý mọi tương tác mà bot nhận được.
 */
async function handleInteraction(interaction, client, io) {
  // ────────────────────────────────────────────
  // 1. Slash Commands (lệnh gạch chéo)
  // ────────────────────────────────────────────
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === 'autobuy') {
      const autobuy = require('../commands/autobuy');
      return autobuy.execute(interaction);
    }
  }

  // ────────────────────────────────────────────
  // 2. Nút "Mua Tiền"  →  Mở Modal
  // ────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId === 'buy_money') {
    const config = loadConfig();
    if ((config.stock || 0) <= 0) {
      return interaction.reply({
        content: '❌ **Hiện tại kho đã hết hàng! Vui lòng quay lại sau khi admin nạp thêm.**',
        flags: MessageFlags.Ephemeral,
      });
    }

    const modal = new ModalBuilder()
      .setCustomId('buy_money_modal')
      .setTitle('💰 Mua money donut');

    const amountInput = new TextInputBuilder()
      .setCustomId('amount')
      .setLabel('Số money muốn mua')
      .setPlaceholder('Ví dụ: 100m, 2.5b, 500k')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const paymentInput = new TextInputBuilder()
      .setCustomId('payment_method')
      .setLabel('Phương thức thanh toán')
      .setPlaceholder('Chuyển khoản ngân hàng / Momo')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const ignInput = new TextInputBuilder()
      .setCustomId('ign')
      .setLabel('Tên nhân vật (IGN)')
      .setPlaceholder('< nếu dùng tài khoản PE, thêm "." trước tên VD: .accounts1 >')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    // Mỗi TextInput phải nằm trong ActionRow riêng
    modal.addComponents(
      new ActionRowBuilder().addComponents(amountInput),
      new ActionRowBuilder().addComponents(paymentInput),
      new ActionRowBuilder().addComponents(ignInput),
    );

    return interaction.showModal(modal);
  }

  // ────────────────────────────────────────────
  // 3. Gửi Modal: "buy_money_modal"
  // ────────────────────────────────────────────
  if (interaction.isModalSubmit() && interaction.customId === 'buy_money_modal') {
    const rawAmount = interaction.fields.getTextInputValue('amount');
    const paymentMethod = interaction.fields.getTextInputValue('payment_method');
    const ign = interaction.fields.getTextInputValue('ign'); // Giữ nguyên chuỗi

    // ── Phân tích số tiền ──
    const parsed = parseAmount(rawAmount);
    if (parsed === null) {
      return interaction.reply({
        content: '❌ Số tiền không hợp lệ. Dùng định dạng: `100m`, `2.5b`, `500k`, hoặc `123456`.',
        flags: MessageFlags.Ephemeral,
      });
    }

    // ── Kiểm tra kho hàng ──
    const config = loadConfig();
    if (parsed > config.stock) {
      return interaction.reply({
        content: `❌ Không đủ hàng! Còn lại: **${formatStock(config.stock)}** (**${formatNumber(config.stock)}**). Bạn yêu cầu: **${formatStock(parsed)}** (**${formatNumber(parsed)}**).`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // ── Tính giá tiền ──
    const { baseAmount, basePrice, currency } = config.price;
    const totalPrice = calculatePrice(parsed, baseAmount, basePrice);

    // ── Tạo nội dung chuyển khoản (memo) ──
    // Lược bỏ ký tự đặc biệt khỏi IGN vì ngân hàng chỉ cho phép chữ cái và số
    const ignForMemo = ign.replace(/[^a-zA-Z0-9]/g, '');
    const memo = `muamon ${rawAmount.trim()} ${ignForMemo}`;

    // ── Tạo URL mã QR VietQR ──
    let bankBin = process.env.BANK_BIN;
    let bankAccount = process.env.BANK_ACCOUNT_NUMBER;
    let bankName = process.env.BANK_ACCOUNT_NAME;

    // Chỉ lấy từ Casso những trường bị thiếu
    if (!bankBin || bankBin.includes('YOUR_') || !bankAccount || bankAccount.includes('YOUR_') || !bankName || bankName.includes('YOUR_')) {
      const casso = await getCassoInfo();
      if (casso) {
        if (!bankBin || bankBin.includes('YOUR_')) bankBin = casso.bin || bankBin;
        if (!bankAccount || bankAccount.includes('YOUR_')) bankAccount = casso.account || bankAccount;
        if (!bankName || bankName.includes('YOUR_')) bankName = casso.name || bankName;
      }
    }

    // Fallback cuối cùng
    if (!bankBin || bankBin.includes('YOUR_')) bankBin = '970422'; // mặc định MB Bank
    if (!bankAccount || bankAccount.includes('YOUR_')) bankAccount = '0000000000';
    if (!bankName || bankName.includes('YOUR_')) bankName = 'AUTO BUY';

    const qrUrl = `https://img.vietqr.io/image/${bankBin}-${bankAccount}-compact2.png`
      + `?amount=${totalPrice}&addInfo=${encodeURIComponent(memo)}&accountName=${encodeURIComponent(bankName)}`;

    // ── Lưu đơn hàng chờ ──
    const orderData = {
      userId: interaction.user.id,
      userTag: interaction.user.tag,
      channelId: interaction.channelId,
      amount: parsed,
      rawAmount: rawAmount.trim(),
      totalPrice,
      currency,
      paymentMethod,
      ign,           // IGN gốc (có ký tự đặc biệt) → dùng để /pay
      ignForMemo,    // IGN đã lược bỏ ký tự đặc biệt → dùng để so khớp
      memo,
      interaction,   // Lưu interaction để xóa/sửa tin nhắn QR sau khi thanh toán
      createdAt: new Date().toISOString(),
    };
    client.pendingOrders.set(interaction.user.id, orderData);

    // ── Tự động hủy đơn sau 10 phút nếu chưa thanh toán ──
    const ORDER_TIMEOUT = 10 * 60 * 1000; // 10 phút
    setTimeout(async () => {
      const stillPending = client.pendingOrders.get(interaction.user.id);
      // Chỉ xóa nếu đơn vẫn còn tồn tại và đúng là đơn này (so sánh thời gian tạo)
      if (stillPending && stillPending.createdAt === orderData.createdAt) {
        client.pendingOrders.delete(interaction.user.id);
        client.webLog(`⏰ Đơn hàng của ${interaction.user.tag} đã hết hạn (10 phút). Tự động hủy.`);

        // Xóa tin nhắn QR nếu còn hiệu lực
        try { await interaction.deleteReply(); } catch (_) { }

        // Thông báo cho member qua DM
        try {
          const user = await client.users.fetch(interaction.user.id);
          await user.send('⏰ **Đơn hàng của bạn đã bị hủy do quá 10 phút không thanh toán.** Vui lòng tạo đơn mới nếu cần.');
        } catch (_) { }
      }
    }, ORDER_TIMEOUT);

    client.webLog(
      `Đơn hàng mới: ${interaction.user.tag} — ${formatNumber(parsed)} tiền game — ${formatNumber(totalPrice)} ${currency} — IGN: ${ign}`,
    );

    // ── Trả lời với embed QR (chỉ người dùng thấy) ──
    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('📲 Mã QR Thanh Toán')
      .setDescription(
        [
          `**Số tiền mua:** \`${formatNumber(parsed)}\` tiền game`,
          `**Tổng thanh toán:** \`${formatNumber(totalPrice)} ${currency}\``,
          `**Phương thức:** ${paymentMethod}`,
          `**IGN của bạn:** \`${ign}\``,
          '',
          `**Nội dung chuyển khoản:**`,
          `\`\`\`${memo}\`\`\``,
          '',
          '⚠️ **Bạn PHẢI ghi đúng nội dung chuyển khoản như trên, nếu không hệ thống sẽ không tự động phát hiện được.**',
          '',
          '⏳ Sau khi thanh toán được xác nhận, tiền sẽ tự động gửi vào game.',
        ].join('\n')
      )
      .setFooter({ text: 'QR bởi VietQR • Auto Buy Money' })
      .setTimestamp();

    // ── Gửi Embed và File ──
    try {
      const qrRes = await fetch(qrUrl);
      if (!qrRes.ok) throw new Error('Không thể tải QR từ VietQR');
      const arrayBuffer = await qrRes.arrayBuffer();
      const qrBuffer = Buffer.from(arrayBuffer);
      const attachment = new AttachmentBuilder(qrBuffer, { name: 'qr.png' });

      embed.setImage('attachment://qr.png');
      return interaction.reply({ embeds: [embed], files: [attachment], flags: MessageFlags.Ephemeral });
    } catch (err) {
      console.error('[Discord] Lỗi tải QR:', err);
      // Fallback lỡ như không tải được ảnh
      embed.setImage(qrUrl);
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }
  }
}

module.exports = { handleInteraction };
