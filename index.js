/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║          AUTO BUY MONEY — File Khởi Động Chính          ║
 * ╠══════════════════════════════════════════════════════════╣
 * ║  Khởi chạy 3 hệ thống cùng lúc:                       ║
 * ║   1. Express + Socket.io  Web Panel  (localhost:3000)   ║
 * ║   2. Discord.js v14  Bot                                ║
 * ║   3. Mineflayer  Bot Minecraft                          ║
 * ╚══════════════════════════════════════════════════════════╝
 */

require('dotenv').config();

// ── Polyfill BigInt.prototype.toJSON ngăn lỗi "Do not know how to serialize a BigInt" ──
if (!BigInt.prototype.toJSON) {
  BigInt.prototype.toJSON = function () {
    return this.toString();
  };
}

// ── Ẩn cảnh báo DEP0040 (punycode deprecated) của Node.js từ các thư viện ngoài ──
const originalEmitWarning = process.emitWarning;
process.emitWarning = function (warning, ...args) {
  if (
    (typeof warning === 'string' && warning.includes('punycode')) ||
    (typeof args[0] === 'string' && args[0] === 'DEP0040') ||
    (warning && warning.code === 'DEP0040')
  ) {
    return;
  }
  return originalEmitWarning.call(process, warning, ...args);
};

// ── Bảo vệ tiến trình không bị crash bởi lỗi packet hoặc network ──
process.on('uncaughtException', (err) => {
  const msg = err && err.message ? err.message : String(err);
  console.error('[Hệ thống] ⚠️ Ngoại lệ chưa bắt (Uncaught Exception):', msg);
  if (global.io) {
    global.io.emit('log', `[Hệ thống] ⚠️ Lỗi ngoại lệ: ${msg}`);
  }
});

process.on('unhandledRejection', (reason) => {
  const msg = reason && reason.message ? reason.message : String(reason);
  console.error('[Hệ thống] ⚠️ Promise Rejection chưa xử lý:', msg);
  if (global.io) {
    global.io.emit('log', `[Hệ thống] ⚠️ Lỗi Promise: ${msg}`);
  }
});

const dns = require('dns');
if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}
const readline = require('readline');

const { startWebPanel } = require('./web/server');
const { startDiscordBot } = require('./bot/client');
const { startMinecraftBot } = require('./minecraft/mineflayer');

(async () => {
  // ── 1. Web Panel (khởi động trước để Socket.io sẵn sàng) ──
  const { io, app } = await startWebPanel();

  // ── 2. Bot Discord ──
  const discordClient = await startDiscordBot(io);

  // ── 3. Bot Minecraft ──
  const mcBot = startMinecraftBot(io);

  // Lưu vào biến toàn cục để webhook handler có thể gọi /pay
  global.mcBot = mcBot;
  global.discordClient = discordClient;
  global.io = io;

  // ── 3.1. Khởi động chu kỳ AFK (Treo 12h -> Out 1h & Khóa nút mua) ──
  const { initAfkCycle } = require('./utils/afkCycleManager');
  initAfkCycle(discordClient, io);

  // ── 4. Tự động đồng bộ và làm mới bảng Panel Discord mỗi 2 phút ──
  setInterval(async () => {
    try {
      const autobuy = require('./bot/commands/autobuy');
      await autobuy.updatePanel(discordClient);
    } catch (_) {}
  }, 2 * 60 * 1000);

  // ── 5. Lắng nghe lệnh từ CMD / Terminal ──
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) return;

    if (input === '/botoff' || input === 'botoff') {
      const fs = require('fs');
      const path = require('path');
      const CONFIG_PATH = path.join(__dirname, 'config.json');
      try {
        const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        config.botOff = true;
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
        if (global.mcBot && typeof global.mcBot.stopBot === 'function') {
          global.mcBot.stopBot();
        }
        if (global.io) global.io.emit('configUpdate', config);
        const autobuy = require('./bot/commands/autobuy');
        await autobuy.updatePanel(global.discordClient, config).catch(() => {});
        console.log('[CMD] 🛑 Đã tắt bot Minecraft và khóa nút mua trên Panel Discord.');
      } catch (e) {
        console.error('[CMD] ❌ Lỗi khi tắt bot:', e.message);
      }
    } else if (input === '/onbot' || input === 'onbot') {
      const fs = require('fs');
      const path = require('path');
      const CONFIG_PATH = path.join(__dirname, 'config.json');
      try {
        const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        config.botOff = false;
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
        if (global.mcBot && typeof global.mcBot.startBot === 'function') {
          global.mcBot.startBot();
        }
        if (global.io) global.io.emit('configUpdate', config);
        const autobuy = require('./bot/commands/autobuy');
        await autobuy.updatePanel(global.discordClient, config).catch(() => {});
        console.log('[CMD] 🟢 Đã khởi động bot Minecraft và mở lại nút mua trên Panel Discord.');
      } catch (e) {
        console.error('[CMD] ❌ Lỗi khi bật bot:', e.message);
      }
    } else if (input.startsWith('/stock') || input.startsWith('stock')) {
      const fs = require('fs');
      const path = require('path');
      const CONFIG_PATH = path.join(__dirname, 'config.json');
      try {
        const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        const parts = input.split(/\s+/);
        const stockArg = parts[1];
        const { parseStockInput } = require('./bot/commands/stock');
        const { formatStock, formatNumber } = require('./utils/parser');
        if (!stockArg) {
          console.log(`[CMD] 📦 Số mon hiện tại trên kho: ${formatStock(config.stock)} (${formatNumber(config.stock)} mon)`);
        } else {
          const oldStock = Number(config.stock) || 0;
          const newStock = parseStockInput(stockArg, oldStock);
          if (newStock === null) {
            console.log(`[CMD] ❌ Số lượng không hợp lệ! VD: /stock 500m, /stock 1b, /stock 100tr, /stock +50m, /stock -20m, /stock 0`);
          } else {
            config.stock = newStock;
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
            if (global.io) global.io.emit('configUpdate', config);
            const autobuy = require('./bot/commands/autobuy');
            await autobuy.updatePanel(global.discordClient, config).catch(() => {});
            console.log(`[CMD] 📦 Đã cập nhật kho: ${formatStock(oldStock)} ➔ ${formatStock(newStock)} (${formatNumber(newStock)} mon)`);
          }
        }
      } catch (e) {
        console.error('[CMD] ❌ Lỗi khi cập nhật kho:', e.message);
      }
    } else if (input.startsWith('/pay ') || input.startsWith('pay ')) {
      const parts = input.split(/\s+/);
      const rawIgn = parts[1];
      const rawAmount = parts[2];
      if (!rawIgn || !rawAmount) {
        console.log(`[CMD] ❌ Cú pháp: /pay <ign> <số_mon> (VD: /pay Steve 10m)`);
      } else {
        const { parseAmount, formatStock } = require('./utils/parser');
        const cleanAmount = parseAmount(rawAmount);
        if (!cleanAmount || cleanAmount <= 0) {
          console.log(`[CMD] ❌ Số mon không hợp lệ! VD: /pay ${rawIgn} 10m, 500k, 1.5b...`);
        } else {
          const { payAndVerify, resolvePendingRetry } = require('./utils/orderRetryManager');
          console.log(`[CMD] 🔄 Đang gửi /pay ${rawIgn} ${cleanAmount} vào Minecraft...`);
          payAndVerify(rawIgn, cleanAmount, 15000)
            .then((res) => {
              if (res.success) {
                const pending = resolvePendingRetry(rawIgn);
                console.log(`[CMD] 🎉 Pay thành công cho ${rawIgn} (${formatStock(cleanAmount)} mon)! ${res.paidInfo?.raw || ''}`);
                if (pending) {
                  console.log(`[CMD] 📋 Đã hoàn tất & xóa đơn chờ retry ID ${pending.id} của ${pending.userTag}`);
                }
              } else {
                console.log(`[CMD] ⚠️ Đã gửi lệnh pay nhưng chưa nhận được xác nhận từ server (Lý do: ${res.reason || 'Timeout'})`);
              }
            })
            .catch((e) => console.log(`[CMD] ❌ Lỗi: ${e.message}`));
        }
      }
    } else if (input.startsWith('/afk') || input.startsWith('afk')) {
      const parts = input.split(/\s+/);
      const sub = (parts[1] || '').toLowerCase();
      const { getAfkCycleStatus, forceStartRestNow, forceResumeOnline } = require('./utils/afkCycleManager');

      if (sub === 'rest') {
        console.log('[CMD] 💤 Yêu cầu cho bot out khỏi Minecraft nghỉ ngơi 1 giờ ngay lập tức...');
        await forceStartRestNow();
      } else if (sub === 'resume' || sub === 'on') {
        console.log('[CMD] 🟢 Yêu cầu kết thúc nghỉ ngơi, kết nối lại bot ngay lập tức...');
        await forceResumeOnline();
      } else {
        const status = getAfkCycleStatus();
        const minsRemaining = Math.round(status.remainingMs / 60000);
        const hoursRemaining = (status.remainingMs / 3600000).toFixed(1);
        const nextTimeStr = new Date(status.nextPhaseAt).toLocaleTimeString('vi-VN');
        console.log(`[CMD] ⏳ TRẠNG THÁI CHU KỲ AFK:`);
        console.log(`      • Trạng thái hiện tại: ${status.isResting ? '💤 ĐANG NGHỈ NGƠI (Out server, khóa nút mua)' : '🟢 ĐANG TREO ONLINE (Đang mở bán)'}`);
        console.log(`      • Đợt chuyển tiếp lúc: ${nextTimeStr} (Còn khoảng ${minsRemaining} phút / ~${hoursRemaining} giờ)`);
        console.log(`      • Gõ: /afk rest (nghỉ ngay) hoặc /afk resume (vào lại ngay)`);
      }
    } else {
      if (global.mcBot && typeof global.mcBot.sendChat === 'function') {
        const success = global.mcBot.sendChat(input);
        if (!success) {
          console.log(`[CMD] ❌ Không thể gửi: Bot chưa kết nối.`);
        }
      } else {
        console.log(`[CMD] ❌ Bot chưa sẵn sàng.`);
      }
    }
  });

  console.log(`\n> Bạn có thể gõ /pay [ign] [số_mon], /stock [số_mon], /botoff, /onbot, /afk để điều khiển bot, hoặc gõ tin nhắn/lệnh in-game (vd: /spawn)!\n`);

})();
