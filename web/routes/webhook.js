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
const { formatNumber } = require('../../utils/parser');
const { EmbedBuilder, MessageFlags } = require('discord.js');

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
        // Tùy theo API trả về amount hay creditAmount
        let amount = tx.amount ? parseFloat(tx.amount) : 0;
        if (tx.creditAmount) amount = parseFloat(tx.creditAmount);
        
        // Tùy theo trường ID giao dịch (refNo, tranId, id)
        const id = tx.refNo || tx.tranId || tx.id || tx.transactionId || String(Math.random());
        
        return {
          id: String(id),
          description: tx.description || tx.remark || '',
          amount: amount
        };
      }).filter(tx => tx.amount > 0); // Chỉ lấy giao dịch nhận tiền
      
      // Lọc các giao dịch mới (chưa có trong Set)
      const newTxs = normalizedTxs.filter(tx => !processedTxs.has(tx.id));
      
      if (newTxs.length > 0) {
        await processTransactions(newTxs);
        // Đánh dấu đã xử lý
        newTxs.forEach(tx => processedTxs.add(tx.id));
      }
    }
  } catch(e) {
    // Bỏ qua lỗi mạng khi poll
  } finally {
    isPolling = false;
  }
}

// Chạy polling mỗi 3 giây (Nhanh nhất có thể nhưng an toàn)
setInterval(pollBytemart, 3000);

module.exports = router;
