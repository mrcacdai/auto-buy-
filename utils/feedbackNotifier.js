/**
 * utils/feedbackNotifier.js
 * ─────────────────────────
 * Gửi thông báo cảm ơn ẩn danh vào kênh feedback của Discord:
 * "Cảm ơn <@member> đã mua <số lượng mon>"
 * Ẩn danh IGN: ví dụ "hkyba" -> "hk***" hoặc "kurimeee" -> "ku***"
 * Sử dụng thumbnail ảnh từ thư mục assets/ (nếu có)
 */

const fs = require('fs');
const path = require('path');
const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { formatStock, formatNumber } = require('./parser');

const ASSETS_DIR = path.join(__dirname, '..', 'assets');

/**
 * Ẩn danh IGN (Ví dụ: "kurimeee" -> "ku***e", "hkyba" -> "hk***a", "abc" -> "a***")
 */
function maskIgn(ign) {
  if (!ign || typeof ign !== 'string') return '******';
  const str = ign.trim();
  if (str.length <= 2) return str[0] + '***';
  if (str.length <= 4) return str.slice(0, 1) + '***' + str.slice(-1);
  return str.slice(0, 2) + '***' + str.slice(-1);
}

/**
 * Tìm ảnh thumbnail trong thư mục assets
 * Ưu tiên các file thumbnail.png, thumbnail.jpg, feedback.png... hoặc file ảnh bất kỳ trong assets
 */
function getThumbnailAsset() {
  try {
    if (!fs.existsSync(ASSETS_DIR)) return null;
    const files = fs.readdirSync(ASSETS_DIR);
    const imageFiles = files.filter(f => /\.(png|jpe?g|webp|gif)$/i.test(f));
    if (!imageFiles.length) return null;

    // Ưu tiên thumbnail.* hoặc feedback.*
    let chosen = imageFiles.find(f => /thumbnail|feedback/i.test(f)) || imageFiles[0];
    const fullPath = path.join(ASSETS_DIR, chosen);
    return {
      fileName: chosen,
      filePath: fullPath,
      attachment: new AttachmentBuilder(fullPath, { name: chosen }),
    };
  } catch (err) {
    console.error('[Feedback] Lỗi tìm ảnh thumbnail:', err.message);
    return null;
  }
}

/**
 * Gửi lời cảm ơn vào kênh feedback
 * @param {import('discord.js').Client} client - Discord Client
 * @param {Object} orderInfo
 * @param {string} orderInfo.userId - ID của member Discord
 * @param {number} orderInfo.gameMoney - Số lượng mon đã mua
 * @param {string} orderInfo.ign - IGN của người mua (sẽ được ẩn danh)
 * @param {number} [orderInfo.vnd] - Số tiền VNĐ đã thanh toán
 * @param {string} [orderInfo.paymentMethod] - Phương thức thanh toán (Ngân hàng / Số dư / Momo...)
 */
async function sendFeedbackThanks(client, { userId, gameMoney, ign, vnd, paymentMethod }) {
  if (!client) return false;

  try {
    // 1. Tìm kênh feedback: Ưu tiên theo FEEDBACK_CHANNEL_ID trong .env, nếu không tìm channel tên "feedback"
    let feedbackChannel = null;
    const envChannelId = process.env.FEEDBACK_CHANNEL_ID;
    if (envChannelId && !envChannelId.includes('YOUR_')) {
      feedbackChannel = await client.channels.fetch(envChannelId).catch(() => null);
    }

    if (!feedbackChannel) {
      // Tìm channel có tên 'feedback' hoặc '⭐・vouches'
      feedbackChannel = client.channels.cache.find(
        c => c.isTextBased() && (c.name.includes('feedback') || c.name.includes('vouches'))
      );
    }

    if (!feedbackChannel) {
      client.webLog?.('[Feedback] ⚠️ Không tìm thấy kênh feedback để gửi thông báo.');
      return false;
    }

    const maskedIgn = maskIgn(ign);
    const monFormatted = formatStock(gameMoney);
    const monExact = formatNumber(gameMoney);

    // 2. Chuẩn bị ảnh thumbnail từ thư mục assets
    const asset = getThumbnailAsset();
    const files = [];

    const embed = new EmbedBuilder()
      .setColor(0x57f287) // Xanh lá nổi bật
      .setTitle('💖 Đơn Hàng Hoàn Tất — Cảm Ơn Bạn!')
      .setDescription(
        [
          `🎉 Cảm ơn <@${userId}> đã mua **${monFormatted}** mon!`,
          '',
          `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
          `💰 **Số lượng mon:** \`${monFormatted}\` (${monExact} in-game)`,
          `🎮 **IGN (Đã ẩn danh):** \`${maskedIgn}\``,
          vnd ? `💵 **Giá trị:** \`${formatNumber(vnd)} VNĐ\`` : null,
          paymentMethod ? `💳 **Phương thức:** \`${paymentMethod}\`` : null,
          `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
          `✨ *Cảm ơn bạn đã tin tưởng ủng hộ shop! Chúc bạn chơi game vui vẻ!*`,
        ].filter(Boolean).join('\n')
      )
      .setFooter({ text: 'Auto Buy Money • Đơn hàng tự động' })
      .setTimestamp();

    if (asset) {
      files.push(asset.attachment);
      embed.setThumbnail(`attachment://${asset.fileName}`);
    }

    await feedbackChannel.send({
      content: `🎉 Cảm ơn <@${userId}> đã mua **${monFormatted}** mon!`,
      embeds: [embed],
      files,
    });

    client.webLog?.(`[Feedback] ✅ Đã gửi lời cảm ơn tới <@${userId}> vào kênh #${feedbackChannel.name}`);
    return true;
  } catch (err) {
    console.error('[Feedback] Lỗi gửi thông báo cảm ơn:', err.message);
    return false;
  }
}

module.exports = {
  sendFeedbackThanks,
  maskIgn,
  getThumbnailAsset,
};
