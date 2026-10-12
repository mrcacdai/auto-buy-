/**
 * minecraft/mineflayer.js
 * ───────────────────────
 * Tạo và quản lý bot Mineflayer kết nối tới donutsmp.net.
 *
 * Tính năng:
 *   • Xác thực Microsoft (MSA)
 *   • Tự động kết nối lại khi bị ngắt
 *   • Phát sự kiện join/disconnect/chat tới web panel qua Socket.io
 *   • Cung cấp hàm sendPayCommand() để webhook handler gọi
 */

const mineflayer = require('mineflayer');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

function getConfig() {
  try {
    const data = fs.readFileSync(CONFIG_PATH, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    return { accounts: [] };
  }
}

/** @type {import('mineflayer').Bot | null} */
let bot = null;

/** @type {import('socket.io').Server | null} */
let socketIO = null;

/** Gửi dòng log tới web panel */
function webLog(message) {
  const line = `[Minecraft] ${new Date().toLocaleTimeString()} — ${message}`;
  console.log(line);
  if (socketIO) socketIO.emit('log', line);
}

/**
 * Tạo (hoặc tạo lại) bot Mineflayer.
 * @param {import('socket.io').Server} io
 */
function startMinecraftBot(io) {
  socketIO = io;

  function createBot() {
    const config = getConfig();
    let accountEmail = process.env.MC_EMAIL || 'bot@outlook.com';
    
    // Ưu tiên tài khoản cấu hình trong web panel (lấy tài khoản đầu tiên)
    if (config.accounts && config.accounts.length > 0) {
      accountEmail = config.accounts[0];
    }
    
    webLog(`Đang kết nối tới donutsmp.net bằng tài khoản: ${accountEmail} …`);

    bot = mineflayer.createBot({
      host: process.env.MC_SERVER_HOST || 'donutsmp.net',
      port: parseInt(process.env.MC_SERVER_PORT, 10) || 25565,
      username: accountEmail,
      auth: 'microsoft', // Xác thực MSA
      version: '1.21.1',
      profilesFolder: path.join(__dirname, '..', 'auth-cache'), // Lưu cache tại thư mục dự án
      onMsaCode: (data) => {
        console.log(`\n======================================================`);
        console.log(`⚠️ YÊU CẦU XÁC THỰC MICROSOFT ⚠️`);
        console.log(data.message || `Truy cập: ${data.verification_uri} và nhập mã: ${data.user_code}`);
        console.log(`======================================================\n`);
        if (socketIO) {
          socketIO.emit('log', `[Minecraft] ⚠️ YÊU CẦU XÁC THỰC MICROSOFT ⚠️`);
          socketIO.emit('log', `[Minecraft] ${data.message || `Truy cập: ${data.verification_uri} và nhập mã: ${data.user_code}`}`);
        }
      }
    });

    // ── Sự kiện spawn: bot đã vào thế giới hoàn toàn ──
    bot.once('spawn', () => {
      webLog(`✅ Đã vào server thành công với tên: ${bot.username}`);
    });

    // ── Tin nhắn chat (để debug / theo dõi) ──
    bot.on('message', (jsonMsg) => {
      const text = jsonMsg.toString();
      if (text.trim()) {
        webLog(`Chat: ${text}`);
      }
    });

    // ── Bị kick ──
    bot.on('kicked', (reason) => {
      webLog(`⚠️ Bị kick: ${reason}`);
    });

    // ── Lỗi ──
    bot.on('error', (err) => {
      webLog(`❌ Lỗi: ${err.message}`);
    });

    // ── Mất kết nối — tự động kết nối lại sau 10 giây ──
    bot.on('end', (reason) => {
      // Nếu là tự ngắt thủ công thì không chờ 10s
      if (reason === 'manual_reconnect') {
        webLog(`🔄 Đang ngắt kết nối để đổi tài khoản...`);
        bot = null;
        setTimeout(createBot, 2000);
      } else {
        webLog(`🔌 Mất kết nối: ${reason || 'không rõ'}. Kết nối lại sau 10 giây …`);
        bot = null;
        setTimeout(createBot, 10_000);
      }
    });
  }

  createBot();

  // Trả về object với các hàm tiện ích
  return {
    /** Gửi lệnh `/pay <ign> <amount>` trong game */
    sendPayCommand(ign, amount) {
      if (!bot) {
        webLog('❌ Không thể /pay — bot chưa kết nối!');
        return false;
      }
      const cmd = `/pay ${ign} ${amount}`;
      webLog(`Thực thi lệnh: ${cmd}`);
      bot.chat(cmd);
      return true;
    },

    /** Kiểm tra bot có đang kết nối không */
    isConnected() {
      return bot !== null;
    },

    /** Ngắt kết nối và thử kết nối lại */
    reconnect() {
      // Xóa cache cũ để ép tạo link mới
      const cachePath = path.join(__dirname, '..', 'auth-cache');
      try {
        if (fs.existsSync(cachePath)) {
          fs.rmSync(cachePath, { recursive: true, force: true });
          webLog('🗑️ Đã xóa liên kết cũ (cache).');
        }
      } catch (err) {
        webLog(`Lỗi khi xóa cache: ${err.message}`);
      }

      if (bot) {
        bot.end('manual_reconnect');
      } else {
        createBot();
      }
    },

    /** Gửi tin nhắn hoặc lệnh bất kỳ vào game */
    sendChat(message) {
      if (!bot) {
        webLog('❌ Không thể gửi lệnh — bot chưa kết nối!');
        return false;
      }
      bot.chat(message);
      return true;
    },

    /** Lấy instance bot gốc */
    getBot() {
      return bot;
    },
  };
}

module.exports = { startMinecraftBot };
