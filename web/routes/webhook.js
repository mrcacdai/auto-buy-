/**
 * web/routes/webhook.js
 * ─────────────────────
 * Route Express xử lý webhook ngân hàng (Casso / VietQR / tùy chỉnh).
 *
 * Payload mẫu từ Casso:
 * {
 *   "error": 0,
 *   "data": [
 *     {
 *       "id": 123,
 *       "tid": "FT123456",
 *       "description": "PAY 123456789012345678",
 *       "amount": 50000,
 *       "when": "2024-01-01 12:00:00",
 *       ...
 *     }
 *   ]
 * }
 *
 * Xử lý:
 *   1. Trích xuất Discord user ID từ memo ("PAY <ID>")
 *   2. Tìm đơn hàng đang chờ
 *   3. Xác minh số tiền khớp
 *   4. Kích hoạt Mineflayer /pay
 *   5. Thông báo cho người mua trên Discord
 *   6. Gửi log giao dịch tới admin webhook
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { formatNumber, formatStock } = require('../../utils/parser');
const { EmbedBuilder, MessageFlags } = require('discord.js');
const { verifyCallbackSign, checkCard, getStatusDescription } = require('../../utils/cardService');
const { addBalance, getBalance } = require('../../utils/balanceManager');

const CONFIG_PATH = path.join(__dirname, '..', '..', 'config.json');

function loadConfig() {
  delete require.cache[CONFIG_PATH];
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

/**
 * POST /api/webhook/bank
 * Nhận thông báo giao dịch từ API ngân hàng.
 */
async function processTransactions(transactions) {
  const { io, discordClient, mcBot } = global;

  const webLog = (msg) => {
    const line = `[Webhook/Casso] ${new Date().toLocaleTimeString()} — ${msg}`;
    console.log(line);
    if (io) io.emit('log', line);
  };

  if (!transactions || !transactions.length) {
    return;
  }

  for (const tx of transactions) {
    const description = (tx.description || '').trim();
    const receivedAmount = Math.abs(tx.amount || 0);

    webLog(`Giao dịch nhận được: ${receivedAmount} — Nội dung: "${description}"`);

      // ── Tìm đơn hàng khớp với nội dung CK ──
      let order = null;
      let discordUserId = null;
      
      // Xóa TẤT CẢ ký tự không phải chữ/số để so sánh linh hoạt
      // VD: "ZIONO5CH7KP90F01-muamon 10m hexdelusion" → "ziono5ch7kp90f01muamon10mhexdelusion"
      const actualDesc = description.toLowerCase().replace(/[^a-z0-9]/g, '');

      if (discordClient && discordClient.pendingOrders) {
        for (const [uid, pending] of discordClient.pendingOrders.entries()) {
          // Dùng ignForMemo (đã lược bỏ ký tự đặc biệt) nếu có, fallback về ign gốc
          const cleanIgn = (pending.ignForMemo || pending.ign.replace(/[^a-zA-Z0-9]/g, '')).toLowerCase();
          const expectedMemo = `muamon${pending.rawAmount}${cleanIgn}`.toLowerCase().replace(/[^a-z0-9]/g, '');
          
          // Chỉ cần nội dung CK CHỨA đoạn memo là khớp (không cần giống 100%)
          if (actualDesc.includes(expectedMemo)) {
            order = pending;
            discordUserId = uid;
            webLog(`✅ Khớp đơn hàng: memo="${expectedMemo}" tìm thấy trong "${description}"`);
            break;
          }
        }
      }

      if (!order) {
        webLog(`⚠️ Không tìm thấy đơn hàng nào khớp với nội dung CK: "${description}". Bỏ qua.`);
        continue;
      }

      // ── Xác minh số tiền ──
      if (receivedAmount < order.totalPrice) {
        webLog(
          `⚠️ Số tiền không khớp: nhận ${receivedAmount}, cần ${order.totalPrice}. Bỏ qua.`,
        );
        continue;
      }

      webLog(`✅ Thanh toán xác nhận cho ${order.userTag} — ${formatNumber(order.totalPrice)} ${order.currency}`);

      // ── Thực hiện /pay trong Minecraft ──
      let executedCommand = 'Bot chưa kết nối (Không thể gửi lệnh)';
      if (mcBot) {
        executedCommand = `/pay ${order.ign} ${order.amount}`;
        const success = mcBot.sendPayCommand(order.ign, order.amount);
        if (!success) {
          executedCommand = 'Lỗi: Bot chưa kết nối';
          webLog('❌ Không thể gửi lệnh /pay. Bot chưa kết nối.');
        }
      }

      // ── Trừ kho hàng ──
      const config = loadConfig();
      config.stock = Math.max(0, config.stock - order.amount);
      saveConfig(config);
      if (io) io.emit('configUpdate', config);

      const autobuy = require('../../bot/commands/autobuy');

      // Nếu hết kho, cập nhật Panel ngay để chuyển nút sang màu đỏ và khóa sử dụng
      if (config.stock <= 0 && discordClient) {
        (async () => {
          try {
            await autobuy.updatePanel(discordClient, config);
            webLog('[Discord] ⚠️ Kho đã hết! Đã chuyển nút sang màu đỏ và khóa sử dụng.');
          } catch (e) {
            webLog(`⚠️ Không thể cập nhật Panel khi hết kho: ${e.message}`);
          }
        })();
      }

      // Tự động cập nhật lại bảng Panel Discord sau 2 phút (120 giây)
      setTimeout(async () => {
        try {
          const currentConfig = loadConfig();
          const ok = await autobuy.updatePanel(discordClient, currentConfig);
          if (ok) {
            webLog('[Discord] 🔄 Đã tự động cập nhật lại Panel sau 2 phút.');
          }
        } catch (e) {
          webLog(`⚠️ Lỗi cập nhật Panel sau 2 phút: ${e.message}`);
        }
      }, 2 * 60 * 1000);

      // ── Xóa tin nhắn QR cũ & thông báo cho người mua ──
      try {
        // Xóa tin nhắn QR đang hiển thị với member
        if (order.interaction) {
          try {
            await order.interaction.deleteReply();
            webLog(`🗑️ Đã xóa tin nhắn QR của ${order.userTag}`);
          } catch (e) {
            webLog(`⚠️ Không thể xóa tin nhắn QR (có thể đã hết hạn): ${e.message}`);
          }

          // Gửi tin nhắn xác nhận tạm thời (chỉ member thấy) rồi tự xóa sau 5s
          try {
            const confirmMsg = await order.interaction.followUp({
              content: '✅ **ĐƠN HÀNG CỦA BẠN XÁC NHẬN HỢP LỆ VÀ ĐÃ HOÀN THÀNH. NẾU CÓ BẤT CỨ VẤN ĐỀ GÌ KHÁC HÃY LIÊN HỆ ADMIN.**',
              flags: MessageFlags.Ephemeral,
            });
            // Tự xóa sau 5 giây
            setTimeout(async () => {
              try { await order.interaction.deleteReply(confirmMsg); } catch (_) {}
            }, 5000);
          } catch (e) {
            webLog(`⚠️ Không thể gửi tin nhắn xác nhận qua interaction: ${e.message}`);
          }
        }

        // Gửi DM cho member
        const user = await discordClient.users.fetch(discordUserId);
        const successEmbed = new EmbedBuilder()
          .setColor(0x57f287)
          .setTitle('✅ Thanh Toán Thành Công!')
          .setDescription(
            [
              `Đơn hàng của bạn đã được xử lý thành công.`,
              '',
              `**Số tiền:** \`${formatNumber(order.amount)}\` tiền game`,
              `**Gửi tới IGN:** \`${order.ign}\``,
              `**Đã thanh toán:** \`${formatNumber(order.totalPrice)} ${order.currency}\``,
              '',
              `Tiền đã được gửi qua lệnh \`/pay\`. Chúc bạn chơi vui! 🎉`,
            ].join('\n'),
          )
          .setTimestamp();

        await user.send({ embeds: [successEmbed] }).catch(() => {
          webLog(`Không thể DM ${order.userTag}.`);
        });
      } catch (err) {
        webLog(`❌ Không thể thông báo cho người dùng: ${err.message}`);
      }

      // ── Gửi log tới admin webhook ──
      try {
        const webhookUrl = process.env.ADMIN_WEBHOOK_URL;
        if (webhookUrl && !webhookUrl.includes('YOUR_WEBHOOK_ID')) {
          const logEmbed = {
            title: '📋 Nhật Ký Giao Dịch',
            color: 0x5865f2,
            fields: [
              { name: '🕐 Thời gian', value: new Date().toISOString(), inline: true },
              { name: '👤 Người mua', value: `${order.userTag} (${order.userId})`, inline: true },
              { name: '💰 Số tiền game', value: formatNumber(order.amount), inline: true },
              { name: '💵 Đã thanh toán', value: `${formatNumber(order.totalPrice)} ${order.currency}`, inline: true },
              { name: '🎮 IGN', value: `\`${order.ign}\``, inline: true },
              { name: '💳 Phương thức', value: order.paymentMethod, inline: true },
              { name: '📝 Nội dung CK', value: `\`${description}\``, inline: false },
              { name: '🤖 Lệnh đã chạy', value: `\`${executedCommand}\``, inline: false },
            ],
            timestamp: new Date().toISOString(),
          };

          await axios.post(webhookUrl, {
            embeds: [logEmbed],
          });
        } else {
          webLog('⚠️ Bỏ qua gửi webhook log vì ADMIN_WEBHOOK_URL chưa được cài đặt trong .env');
        }
      } catch (err) {
        webLog(`❌ Không thể gửi admin webhook: ${err.message}`);
      }

      // ── Xóa khỏi danh sách chờ ──
      discordClient.pendingOrders.delete(discordUserId);
      webLog(`Đơn hàng của ${order.userTag} đã hoàn thành và xóa khỏi danh sách chờ.`);
  }
}

/**
 * POST /api/webhook/bank
 * Nhận thông báo giao dịch từ API ngân hàng.
 */
router.post('/bank', async (req, res) => {
  try {
    const transactions = req.body?.data || [];
    if (!transactions.length) {
      return res.json({ success: true, message: 'Không có giao dịch' });
    }
    await processTransactions(transactions);
    return res.json({ success: true });
  } catch (err) {
    console.error('Lỗi webhook:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── Tự động Polling Bytemart (Dành cho chạy Local) ──
const processedTxs = new Set();
let isPolling = false;

async function pollBytemart() {
  if (isPolling) return;
  const apiKey = process.env.BANK_API_KEY;
  if (!apiKey || apiKey.includes('YOUR_')) return;
  
  isPolling = true;
  try {
    const url = `https://api.bytemart.io.vn/historyapimbbank/${apiKey}`;
    const res = await axios.get(url);
    
    if (res.data && res.data.status === 'success' && Array.isArray(res.data.TranList)) {
      const records = res.data.TranList;
      
      // Chuyển đổi định dạng của Bytemart/MBBank về định dạng chung để xử lý
      const normalizedTxs = records.map(tx => {
        let amount = tx.amount ? parseFloat(tx.amount) : 0;
        if (tx.creditAmount) amount = parseFloat(tx.creditAmount);
        
        const id = tx.refNo || tx.tranId || tx.id || tx.transactionId || String(Math.random());
        
        return {
          id: String(id),
          description: tx.description || tx.remark || '',
          amount: amount
        };
      }).filter(tx => tx.amount > 0);
      
      const newTxs = normalizedTxs.filter(tx => !processedTxs.has(tx.id));
      
      if (newTxs.length > 0) {
        await processTransactions(newTxs);
        newTxs.forEach(tx => processedTxs.add(tx.id));
      }
    }
  } catch(e) {
  } finally {
    isPolling = false;
  }
}

// Chạy polling mỗi 3 giây
setInterval(pollBytemart, 3000);

// ────────────────────────────────────────────────────────────
// ── XỬ LÝ GẠCH THẺ CÀO (Card Partner API / trumthengon.com) ──
// ────────────────────────────────────────────────────────────

async function processCardTransaction(data) {
  const { io, discordClient, mcBot } = global;

  const webLog = (msg) => {
    const line = `[Webhook/GạchThẻ] ${new Date().toLocaleTimeString()} — ${msg}`;
    console.log(line);
    if (io) io.emit('log', line);
  };

  const requestId = data.request_id;
  const statusCode = Number(data.status);
  const declaredValue = Number(data.declared_value || data.amount || 0);
  const actualValue = Number(data.value || declaredValue);
  const serial = data.serial || '';
  const telco = data.telco || '';
  const message = data.message || getStatusDescription(statusCode);

  webLog(`Kết quả thẻ [${telco} ${serial}]: Trạng thái ${statusCode} (${message}) - Thực nhận: ${actualValue}`);

  let order = null;
  if (discordClient && discordClient.pendingCards) {
    order = discordClient.pendingCards.get(requestId);
    if (!order) {
      for (const [, pending] of discordClient.pendingCards.entries()) {
        if (pending.serial === serial) {
          order = pending;
          break;
        }
      }
    }
  }

  if (!order) {
    webLog(`⚠️ Không tìm thấy đơn thẻ chờ cho ID: ${requestId} (serial: ${serial}).`);
    return;
  }

  const config = loadConfig();
  const { baseAmount, basePrice } = config.price;

  // status 1: Thành công đúng mệnh giá | status 2: Thành công sai mệnh giá
  if (statusCode === 1 || statusCode === 2) {
    const cardMoney = actualValue > 0 ? actualValue : order.amount;

    // Cộng tiền vào số dư cá nhân của member
    const depositRes = await addBalance(order.userId, cardMoney, 'CARD_WEBHOOK', {
      telco: telco || order.telco,
      serial: serial || order.serial,
      requestId: order.requestId,
    });
    const newBalance = depositRes.success ? depositRes.newBalance : getBalance(order.userId);

    webLog(`✅ Nạp thẻ thành công cho ${order.userTag} — Đã cộng +${formatNumber(cardMoney)}đ vào số dư (Hiện có: ${formatNumber(newBalance)}đ)`);

    // Gửi DM cho người dùng
    if (discordClient) {
      try {
        const user = await discordClient.users.fetch(order.userId);
        const successEmbed = new EmbedBuilder()
          .setColor(statusCode === 1 ? 0x57f287 : 0xfaa61a)
          .setTitle(statusCode === 1 ? '✅ Nạp Thẻ Cào Thành Công!' : '⚠️ Nạp Thẻ Thành Công (Sai Mệnh Giá)')
          .setDescription(
            [
              statusCode === 1
                ? 'Thẻ cào của bạn đã được duyệt thành công đúng mệnh giá.'
                : 'Thẻ của bạn đã được duyệt nhưng **sai mệnh giá khai báo**. Hệ thống đã cộng tiền theo mệnh giá thực.',
              '',
              `**Nhà mạng:** \`${telco || order.telco}\``,
              `**Số tiền nạp:** \`+${formatNumber(cardMoney)} VNĐ\``,
              `**Số dư hiện tại của bạn:** \`${formatNumber(newBalance)} VNĐ\``,
              `**Mã giao dịch:** \`${order.requestId}\``,
              '',
              `👉 **Cách mua tiền game:** Bấm nút **💸 Mua Tiền** trên bảng Panel và điền phương thức là \`card\` hoặc \`thẻ cào\` để dùng số dư này mua money! 🎉`,
            ].join('\n')
          )
          .setTimestamp();

        await user.send({ embeds: [successEmbed] }).catch(() => {});
      } catch (e) {
        webLog(`Không thể gửi DM tới ${order.userTag}: ${e.message}`);
      }
    }

    // Gửi Admin webhook log
    try {
      const webhookUrl = process.env.ADMIN_WEBHOOK_URL;
      if (webhookUrl && !webhookUrl.includes('YOUR_WEBHOOK_ID')) {
        const logEmbed = {
          title: '📋 Nhật Ký Nạp Thẻ Cào (Cộng Số Dư)',
          color: statusCode === 1 ? 0x57f287 : 0xfaa61a,
          fields: [
            { name: '🕐 Thời gian', value: new Date().toISOString(), inline: true },
            { name: '👤 Người nạp', value: `${order.userTag} (${order.userId})`, inline: true },
            { name: '💳 Loại thẻ', value: `${telco || order.telco}`, inline: true },
            { name: '💵 Tiền nạp', value: `+${formatNumber(cardMoney)} VNĐ`, inline: true },
            { name: '💰 Số dư sau nạp', value: `${formatNumber(newBalance)} VNĐ`, inline: true },
            { name: '🔢 Serial', value: `\`${serial || order.serial}\``, inline: true },
            { name: '🆔 Request ID', value: `\`${order.requestId}\``, inline: false },
          ],
          timestamp: new Date().toISOString(),
        };
        await axios.post(webhookUrl, { embeds: [logEmbed] });
      }
    } catch (e) {
      webLog(`Lỗi gửi admin webhook thẻ cào: ${e.message}`);
    }
  } else if (statusCode === 3 || statusCode === 100) {
    // Thẻ lỗi
    webLog(`❌ Thẻ bị từ chối cho ${order.userTag}: ${message}`);
    if (discordClient) {
      try {
        const user = await discordClient.users.fetch(order.userId);
        const failEmbed = new EmbedBuilder()
          .setColor(0xed4245)
          .setTitle('❌ Nạp Thẻ Cào Thất Bại')
          .setDescription(
            [
              `Thẻ cào của bạn đã bị nhà mạng từ chối.`,
              '',
              `**Lý do:** \`${message}\``,
              `**Nhà mạng:** \`${telco || order.telco}\``,
              `**Serial:** \`${serial || order.serial}\``,
              `**Mã giao dịch:** \`${order.requestId}\``,
              '',
              `Nếu có nhầm lẫn, vui lòng liên hệ Admin để được hỗ trợ.`,
            ].join('\n')
          )
          .setTimestamp();

        await user.send({ embeds: [failEmbed] }).catch(() => {});
      } catch (e) {}
    }
  }

  // Xóa khỏi danh sách chờ nếu đã có kết quả cuối cùng
  if ([1, 2, 3, 100].includes(statusCode) && discordClient && discordClient.pendingCards) {
    discordClient.pendingCards.delete(order.requestId);
  }
}

/**
 * Route nhận callback thẻ cào từ cổng gạch thẻ (POST & GET)
 * Endpoint: /api/webhook/card hoặc /api/webhook/callback
 */
async function handleCardCallback(req, res) {
  try {
    const data = Object.keys(req.body || {}).length ? req.body : req.query;
    if (!data || (!data.status && !data.request_id)) {
      return res.status(400).json({ status: 0, message: 'Dữ liệu không hợp lệ' });
    }

    // Xác minh chữ ký nếu có callback_sign
    if (data.callback_sign && data.code && data.serial) {
      const isValid = verifyCallbackSign(data.code, data.serial, data.callback_sign);
      if (!isValid) {
        console.warn('[Webhook/Card] Chữ ký callback không hợp lệ!');
        return res.status(400).json({ status: 0, message: 'Sai chữ ký callback' });
      }
    }

    await processCardTransaction(data);
    return res.json({ status: 1, message: 'Thành công' });
  } catch (err) {
    console.error('[Webhook/Card] Lỗi xử lý callback:', err);
    return res.status(500).json({ status: 0, error: err.message });
  }
}

router.all('/card', handleCardCallback);
router.all('/callback', handleCardCallback);

// ── Tự động Polling kiểm tra thẻ đang chờ (Backup khi webhook không gọi tới được) ──
let isCardPolling = false;
async function pollPendingCards() {
  if (isCardPolling) return;
  const { discordClient } = global;
  if (!discordClient || !discordClient.pendingCards || discordClient.pendingCards.size === 0) return;

  isCardPolling = true;
  try {
    for (const [requestId, order] of discordClient.pendingCards.entries()) {
      // Chỉ poll các đơn tạo quá 10 giây và dưới 10 phút
      const age = Date.now() - order.createdAt;
      if (age < 10000 || age > 10 * 60 * 1000) {
        if (age > 10 * 60 * 1000) discordClient.pendingCards.delete(requestId);
        continue;
      }

      const res = await checkCard({
        telco: order.telco,
        code: order.code,
        serial: order.serial,
        amount: order.amount,
        requestId: order.requestId,
      });

      if (res.success && res.data && res.data.status !== undefined) {
        const checkStatus = Number(res.data.status);
        if (checkStatus !== 99) {
          // Thẻ đã có kết quả (1, 2, 3...)
          await processCardTransaction({ ...res.data, request_id: requestId });
        }
      }
    }
  } catch (e) {
  } finally {
    isCardPolling = false;
  }
}

// Kiểm tra thẻ chờ mỗi 10 giây
setInterval(pollPendingCards, 10000);

module.exports = router;

