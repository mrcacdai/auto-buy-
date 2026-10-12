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

  rl.on('line', (line) => {
    const input = line.trim();
    if (input) {
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

  console.log(`\n> Bạn có thể gõ lệnh (vd: /spawn) hoặc tin nhắn trực tiếp vào đây để gửi qua bot!\n`);

})();
