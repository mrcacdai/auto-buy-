/**
 * bot/handlers/interaction.js
 * ───────────────────────────
 * Xử lý tương tác trung tâm cho:
 *   • Slash commands  (/autobuy, /gachthe, /sodu)
 *   • Bấm nút        (buy_money, card_open_modal_*, card_instant_*)
 *   • Gửi Modal       (buy_money_modal, card_balance_modal_*)
 */

const {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  AttachmentBuilder,
  MessageFlags,
} = require('discord.js');

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const QRCode = require('qrcode');
const { parseAmount, formatNumber, calculatePrice, formatStock } = require('../../utils/parser');
const { getBalance, deductBalance, addBalance, acquireLock } = require('../../utils/balanceManager');
const { sendFeedbackThanks } = require('../../utils/feedbackNotifier');

const CONFIG_PATH = path.join(__dirname, '..', '..', 'config.json');

function loadConfig() {
  delete require.cache[CONFIG_PATH];
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

// ── Cache thông tin Casso ──
let cachedCassoInfo = null;
async function getCassoInfo() {
  if (cachedCassoInfo) return cachedCassoInfo;
  const apiKey = process.env.BANK_API_KEY;
  if (!apiKey || apiKey.includes('YOUR_')) return null;

  try {
    const res = await fetch('https://oauth.casso.vn/v2/userInfo', {
      headers: { 'Authorization': `Apikey ${apiKey}` },
    });
    if (res.ok) {
      const json = await res.json();
      if (json.data && json.data.bankAccs && json.data.bankAccs.length > 0) {
        const acc = json.data.bankAccs[0];
        cachedCassoInfo = {
          bin: acc.bank?.bin,
          account: acc.bankSubAccId,
          name: acc.bankAccountName,
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
 * Xử lý mua mon an toàn bằng số dư cá nhân (Chống buff tiền, chống race condition)
 */
async function executeBalancePurchase(interaction, amountVnd, ign, client, io) {
  const userId = interaction.user.id;
  const release = await acquireLock(userId);

  try {
    const config = loadConfig();
    const { baseAmount, basePrice } = config.price;

    const numericVnd = Math.floor(Number(amountVnd));
    if (isNaN(numericVnd) || numericVnd <= 0 || !Number.isFinite(numericVnd)) {
      return interaction.reply({
        content: '❌ **Số tiền không hợp lệ!** Vui lòng nhập số tiền VNĐ hợp lệ (ví dụ: `10000`, `20k`, `50k`, `100k`...).',
        flags: MessageFlags.Ephemeral,
      });
    }

    // ── 1. Kiểm tra số dư cá nhân ──
    const currentBalance = getBalance(userId);
    if (currentBalance < numericVnd) {
      return interaction.reply({
        content: `❌ **Số dư của bạn không đủ!**\n💵 Hiện có: **${formatNumber(currentBalance)} VNĐ**\n💸 Cần thanh toán: **${formatNumber(numericVnd)} VNĐ**\n👉 Dùng lệnh \`/gachthe\` để nạp thêm thẻ cào!`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // ── 2. Tính số tiền game (mon) ──
    // Lấy số tiền đấy chia cho giá mon: (numericVnd / basePrice) * baseAmount
    const gameMoney = Math.floor((numericVnd / basePrice) * baseAmount);
    if (gameMoney <= 0) {
      return interaction.reply({
        content: `❌ Số tiền **${formatNumber(numericVnd)} VNĐ** không đủ để mua tối thiểu 1 mon theo tỷ giá hiện tại.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // ── 3. Kiểm tra kho hàng ──
    if (gameMoney > (config.stock || 0)) {
      return interaction.reply({
        content: `❌ **Kho hàng không đủ!**\nSố mon yêu cầu: **${formatStock(gameMoney)}** (${formatNumber(gameMoney)})\nKho hiện còn: **${formatStock(config.stock || 0)}**. Vui lòng liên hệ Admin nạp thêm kho.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // ── 4. Kiểm tra trạng thái Minecraft Bot ──
    const { mcBot } = global;
    if (!mcBot || !mcBot.bot) {
      return interaction.reply({
        content: '❌ **Bot giao tiền in-game hiện đang ngoại tuyến.** Vui lòng thử lại sau ít phút hoặc báo Admin.',
        flags: MessageFlags.Ephemeral,
      });
    }

    // ── 5. Trừ số dư an toàn trước khi gửi lệnh ──
    const deductResult = await deductBalance(userId, numericVnd, 'BUY_MONEY', {
      ign,
      gameMoney,
    });
    if (!deductResult.success) {
      return interaction.reply({
        content: `❌ ${deductResult.error}`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // ── 6. Bot thực hiện lệnh /pay trong Minecraft ──
    const paySuccess = mcBot.sendPayCommand(ign, gameMoney);
    if (!paySuccess) {
      // ⚠️ ROLLBACK TỰ ĐỘNG NẾU GỬI LỆNH /PAY THẤT BẠI
      await addBalance(userId, numericVnd, 'ROLLBACK_PAY_FAILED', {
        ign,
        gameMoney,
      });

      const line = `[Balance/Lỗi] ❌ /pay ${ign} ${gameMoney} thất bại. Đã hoàn ${formatNumber(numericVnd)}đ cho ${interaction.user.tag}`;
      console.error(line);
      if (io) io.emit('log', line);

      return interaction.reply({
        content: '❌ **Bot in-game chưa sẵn sàng gửi lệnh.** Hệ thống đã **tự động hoàn lại tiền** vào số dư của bạn.',
        flags: MessageFlags.Ephemeral,
      });
    }

    // ── 7. Trừ kho hàng & Cập nhật Panel ──
    config.stock = Math.max(0, config.stock - gameMoney);
    saveConfig(config);
    if (io) io.emit('configUpdate', config);

    const autobuy = require('../commands/autobuy');
    autobuy.updatePanel(client, config).catch(() => {});

    const logLine = `[Balance] ✅ ${interaction.user.tag} mua thành công ${formatStock(gameMoney)} mon (${formatNumber(numericVnd)} VNĐ) — IGN: ${ign}`;
    console.log(logLine);
    if (io) io.emit('log', logLine);

    // ── 8. Trả lời thông báo thành công cho member ──
    const successEmbed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('🎉 Mua Tiền Game Thành Công!')
      .setDescription(
        [
          `Giao dịch thanh toán bằng **Số Dư Thẻ Cào** đã hoàn tất!`,
          '',
          `💰 **Số mon nhận được:** \`${formatStock(gameMoney)}\` (${formatNumber(gameMoney)} in-game)`,
          `💵 **Đã trừ số dư:** \`-${formatNumber(numericVnd)} VNĐ\``,
          `💳 **Số dư còn lại:** \`${formatNumber(deductResult.newBalance)} VNĐ\``,
          `🎮 **Nhân vật nhận (IGN):** \`${ign}\``,
          `🤖 **Lệnh đã thực thi:** \`/pay ${ign} ${gameMoney}\``,
          '',
          `*Chúc bạn chơi game vui vẻ! Nếu có bất kỳ vấn đề gì hãy liên hệ Admin.*`,
        ].join('\n')
      )
      .setFooter({ text: 'Auto Buy Money • Thanh toán bằng số dư' })
      .setTimestamp();

    await interaction.reply({
      embeds: [successEmbed],
      flags: MessageFlags.Ephemeral,
    });

    // Gửi DM cho member
    try {
      const user = await client.users.fetch(userId);
      await user.send({ embeds: [successEmbed] }).catch(() => {});
    } catch (_) {}

    // Gửi Admin Webhook Log
    try {
      const webhookUrl = process.env.ADMIN_WEBHOOK_URL;
      if (webhookUrl && !webhookUrl.includes('YOUR_WEBHOOK_ID')) {
        const adminEmbed = {
          title: '📋 Nhật Ký Mua Mon Bằng Số Dư Thẻ Cào',
          color: 0x57f287,
          fields: [
            { name: '🕐 Thời gian', value: new Date().toISOString(), inline: true },
            { name: '👤 Người mua', value: `${interaction.user.tag} (${userId})`, inline: true },
            { name: '🎮 IGN', value: `\`${ign}\``, inline: true },
            { name: '💵 Tiền VNĐ trừ', value: `-${formatNumber(numericVnd)} VNĐ`, inline: true },
            { name: '💰 Tiền game nhận', value: `${formatStock(gameMoney)} (${formatNumber(gameMoney)})`, inline: true },
            { name: '💳 Số dư còn lại', value: `${formatNumber(deductResult.newBalance)} VNĐ`, inline: true },
            { name: '🤖 Lệnh đã chạy', value: `\`/pay ${ign} ${gameMoney}\``, inline: false },
          ],
          timestamp: new Date().toISOString(),
        };
        await axios.post(webhookUrl, { embeds: [adminEmbed] });
      }
    } catch (_) {}

    // ── 9. Gửi lời cảm ơn vào kênh feedback ──
    try {
      await sendFeedbackThanks(client, {
        userId,
        gameMoney,
        ign,
        vnd: numericVnd,
        paymentMethod: 'Số Dư Thẻ Cào',
      });
    } catch (fbErr) {
      console.error('[Feedback] Lỗi gửi feedback:', fbErr.message);
    }
  } finally {
    release();
  }
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
    if (interaction.commandName === 'gachthe') {
      const gachthe = require('../commands/gachthe');
      return gachthe.execute(interaction);
    }
    if (interaction.commandName === 'sodu') {
      const sodu = require('../commands/sodu');
      return sodu.execute(interaction);
    }
  }

  // ────────────────────────────────────────────
  // 2. Nút "Mua Tiền" từ Panel  →  Mở Modal ban đầu
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
      .setPlaceholder('Ngân hàng / Momo / Thẻ cào / Card')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const ignInput = new TextInputBuilder()
      .setCustomId('ign')
      .setLabel('Tên nhân vật (IGN)')
      .setPlaceholder('< nếu dùng tài khoản PE, thêm "." trước tên VD: .accounts1 >')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    modal.addComponents(
      new ActionRowBuilder().addComponents(amountInput),
      new ActionRowBuilder().addComponents(paymentInput),
      new ActionRowBuilder().addComponents(ignInput),
    );

    return interaction.showModal(modal);
  }

  // ────────────────────────────────────────────
  // 3. Nút mở Modal nhập số tiền VNĐ khi mua bằng số dư
  // ────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith('card_open_modal_')) {
    const ign = decodeURIComponent(interaction.customId.replace('card_open_modal_', ''));
    const balance = getBalance(interaction.user.id);

    const modal = new ModalBuilder()
      .setCustomId(`card_balance_modal_${encodeURIComponent(ign)}`)
      .setTitle('💳 Mua Mon Bằng Số Dư');

    const amountVndInput = new TextInputBuilder()
      .setCustomId('amount_vnd')
      .setLabel(`Số tiền VNĐ muốn mua (Số dư: ${formatNumber(balance)}đ)`)
      .setPlaceholder('Ví dụ: 10000, 20k, 50k, 100000')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const ignInput = new TextInputBuilder()
      .setCustomId('ign')
      .setLabel('Tên nhân vật (IGN) nhận mon')
      .setValue(ign || '')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    modal.addComponents(
      new ActionRowBuilder().addComponents(amountVndInput),
      new ActionRowBuilder().addComponents(ignInput),
    );

    return interaction.showModal(modal);
  }

  // ────────────────────────────────────────────
  // 4. Nút mua nhanh bằng số dư: card_instant_...
  // ────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith('card_instant_')) {
    const parts = interaction.customId.split('_');
    const priceVnd = Number(parts[2]);
    const ign = decodeURIComponent(parts.slice(3).join('_'));
    return executeBalancePurchase(interaction, priceVnd, ign, client, io);
  }

  // ────────────────────────────────────────────
  // 5. Gửi Modal: "card_balance_modal_..."
  // ────────────────────────────────────────────
  if (interaction.isModalSubmit() && interaction.customId.startsWith('card_balance_modal_')) {
    const rawVnd = interaction.fields.getTextInputValue('amount_vnd');
    const ign = interaction.fields.getTextInputValue('ign');
    const parsedVnd = parseAmount(rawVnd);
    if (!parsedVnd || parsedVnd <= 0) {
      return interaction.reply({
        content: '❌ **Số tiền VNĐ không hợp lệ!** Vui lòng nhập định dạng số như: `10000`, `20k`, `50k`, `100k`...',
        flags: MessageFlags.Ephemeral,
      });
    }
    return executeBalancePurchase(interaction, parsedVnd, ign, client, io);
  }

  // ────────────────────────────────────────────
  // 6. Gửi Modal ban đầu: "buy_money_modal"
  // ────────────────────────────────────────────
  if (interaction.isModalSubmit() && interaction.customId === 'buy_money_modal') {
    const rawAmount = interaction.fields.getTextInputValue('amount');
    const paymentMethod = interaction.fields.getTextInputValue('payment_method');
    const ign = interaction.fields.getTextInputValue('ign');

    // ── Phân tích số tiền ──
    const parsed = parseAmount(rawAmount);
    if (parsed === null) {
      return interaction.reply({
        content: '❌ Số tiền không hợp lệ. Dùng định dạng: `100m`, `2.5b`, `500k`, hoặc `123456`.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const config = loadConfig();

    // ────────────────────────────────────────────────────────
    // NẾU PHƯƠNG THỨC THANH TOÁN LÀ CARD / THẺ CÀO / SỐ DƯ
    // ────────────────────────────────────────────────────────
    const isCard = /card|th[eẻ]\s*c[aà]o|s[oố]\s*d[uư]/i.test(paymentMethod);
    if (isCard) {
      const balance = getBalance(interaction.user.id);
      if (balance <= 0) {
        return interaction.reply({
          content: `❌ **Bạn hiện không có số dư thẻ cào!**\n💵 Số dư hiện tại: **0 VNĐ**\n👉 Vui lòng dùng lệnh \`/gachthe\` để nạp thẻ cào vào tài khoản trước khi mua.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      const { baseAmount, basePrice } = config.price;
      const priceForMon = calculatePrice(parsed, baseAmount, basePrice);

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`card_open_modal_${encodeURIComponent(ign)}`)
          .setLabel('💰 Nhập Số Tiền VNĐ Muốn Mua Mon')
          .setStyle(ButtonStyle.Primary),
      );

      // Nếu số mon member đã nhập có giá <= số dư hiện tại, thêm nút mua luôn
      if (priceForMon <= balance) {
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`card_instant_${priceForMon}_${encodeURIComponent(ign)}`)
            .setLabel(`⚡ Mua Luôn ${formatStock(parsed)} Mon (${formatNumber(priceForMon)}đ)`)
            .setStyle(ButtonStyle.Success),
        );
      }

      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('💳 Thanh Toán Bằng Số Dư Thẻ Cào')
        .setDescription(
          [
            `Chào **${interaction.user.username}**, bạn đã chọn thanh toán bằng **Số Dư Thẻ Cào / Card**:`,
            '',
            `💵 **Số dư hiện có của bạn:** \`${formatNumber(balance)} VNĐ\``,
            `🏷️ **Tỷ giá:** \`${formatStock(baseAmount)}\` mon = \`${formatNumber(basePrice)} VNĐ\``,
            `🎮 **Tên nhân vật (IGN):** \`${ign}\``,
            '',
            priceForMon <= balance
              ? `💡 *Bạn có thể bấm **⚡ Mua Luôn** để mua ngay \`${formatStock(parsed)}\` mon với giá \`${formatNumber(priceForMon)} VNĐ\`, hoặc bấm nút nhập số tiền VNĐ khác tùy thích.*`
              : `💡 *Số dư hiện tại (${formatNumber(balance)}đ) không đủ mua ${formatStock(parsed)} mon (${formatNumber(priceForMon)}đ). Bấm nút bên dưới để nhập số tiền VNĐ bạn muốn chi!*`,
          ].join('\n')
        )
        .setFooter({ text: 'Auto Buy Money • Số dư bảo mật an toàn' });

      return interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });
    }

    // ────────────────────────────────────────────────────────
    // PHƯƠNG THỨC CHUYỂN KHOẢN NGÂN HÀNG / MOMO (VIETQR)
    // ────────────────────────────────────────────────────────
    if (parsed > config.stock) {
      return interaction.reply({
        content: `❌ Không đủ hàng! Còn lại: **${formatStock(config.stock)}** (**${formatNumber(config.stock)}**). Bạn yêu cầu: **${formatStock(parsed)}** (**${formatNumber(parsed)}**).`,
        flags: MessageFlags.Ephemeral,
      });
    }

    const { baseAmount, basePrice, currency } = config.price;
    const totalPrice = calculatePrice(parsed, baseAmount, basePrice);

    const ignForMemo = ign.replace(/[^a-zA-Z0-9]/g, '');
    const memo = `muamon ${rawAmount.trim()} ${ignForMemo}`;

    let bankBin = process.env.BANK_BIN;
    let bankAccount = process.env.BANK_ACCOUNT_NUMBER;
    let bankName = process.env.BANK_ACCOUNT_NAME;

    if (!bankBin || bankBin.includes('YOUR_') || !bankAccount || bankAccount.includes('YOUR_') || !bankName || bankName.includes('YOUR_')) {
      const casso = await getCassoInfo();
      if (casso) {
        if (!bankBin || bankBin.includes('YOUR_')) bankBin = casso.bin || bankBin;
        if (!bankAccount || bankAccount.includes('YOUR_')) bankAccount = casso.account || bankAccount;
        if (!bankName || bankName.includes('YOUR_')) bankName = casso.name || bankName;
      }
    }

    if (!bankBin || bankBin.includes('YOUR_')) bankBin = '970422';
    if (!bankAccount || bankAccount.includes('YOUR_')) bankAccount = '0000000000';
    if (!bankName || bankName.includes('YOUR_')) bankName = 'AUTO BUY';

    const qrUrl = `https://img.vietqr.io/image/${bankBin}-${bankAccount}-compact2.png`
      + `?amount=${totalPrice}&addInfo=${encodeURIComponent(memo)}&accountName=${encodeURIComponent(bankName)}`;

    const orderData = {
      userId: interaction.user.id,
      userTag: interaction.user.tag,
      channelId: interaction.channelId,
      amount: parsed,
      rawAmount: rawAmount.trim(),
      totalPrice,
      currency,
      paymentMethod,
      ign,
      ignForMemo,
      memo,
      interaction,
      createdAt: new Date().toISOString(),
    };
    client.pendingOrders.set(interaction.user.id, orderData);

    const ORDER_TIMEOUT = 10 * 60 * 1000;
    setTimeout(async () => {
      const stillPending = client.pendingOrders.get(interaction.user.id);
      if (stillPending && stillPending.createdAt === orderData.createdAt) {
        client.pendingOrders.delete(interaction.user.id);
        client.webLog(`⏰ Đơn hàng của ${interaction.user.tag} đã hết hạn (10 phút). Tự động hủy.`);

        try { await interaction.deleteReply(); } catch (_) {}

        try {
          const user = await client.users.fetch(interaction.user.id);
          await user.send('⏰ **Đơn hàng của bạn đã bị hủy do quá 10 phút không thanh toán.** Vui lòng tạo đơn mới nếu cần.');
        } catch (_) {}
      }
    }, ORDER_TIMEOUT);

    client.webLog(
      `Đơn hàng mới: ${interaction.user.tag} — ${formatNumber(parsed)} tiền game — ${formatNumber(totalPrice)} ${currency} — IGN: ${ign}`,
    );

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
      embed.setImage(qrUrl);
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }
  }
}

module.exports = { handleInteraction };
