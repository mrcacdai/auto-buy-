/**
 * web/server.js
 * ─────────────
 * Server Express + Socket.io cho web panel quản trị.
 *
 * Các endpoint:
 *   GET  /                  → Giao diện admin panel
 *   GET  /api/config        → Đọc config hiện tại
 *   POST /api/config        → Cập nhật config (giá & kho hàng)
 *   POST /api/webhook/bank  → Webhook thanh toán ngân hàng (Casso...)
 *
 * Sự kiện Socket.io:
 *   'log'          → Server → Client: đẩy dòng log console
 *   'configUpdate' → Server → Client: đẩy config đã cập nhật
 */

const express = require('express');
const http = require('http');
const { Server: SocketIOServer } = require('socket.io');
const path = require('path');
const fs = require('fs');

const webhookRouter = require('./routes/webhook');
const { parseAmount } = require('../utils/parser');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

function loadConfig() {
  delete require.cache[CONFIG_PATH];
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

async function startWebPanel() {
  const app = express();
  const server = http.createServer(app);
  const io = new SocketIOServer(server);

  // ── Middleware ──
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(express.static(path.join(__dirname, 'public')));

  // ── API: Lấy config ──
  app.get('/api/config', (req, res) => {
    res.json(loadConfig());
  });

  // ── API: Cập nhật config ──
  app.post('/api/config', (req, res) => {
    try {
      const config = loadConfig();
      const { baseAmount, basePrice, currency, stock } = req.body;

      if (baseAmount !== undefined) {
        let parsedBase = Number(baseAmount);
        if (isNaN(parsedBase) && typeof baseAmount === 'string') {
          parsedBase = parseAmount(baseAmount);
        }
        if (parsedBase !== null && !isNaN(parsedBase)) config.price.baseAmount = parsedBase;
      }
      if (basePrice !== undefined) config.price.basePrice = Number(basePrice);
      if (currency !== undefined) config.price.currency = String(currency);
      if (stock !== undefined && stock !== '') {
        let parsedStock = Number(stock);
        if (isNaN(parsedStock) && typeof stock === 'string') {
          parsedStock = parseAmount(stock);
        }
        if (parsedStock !== null && !isNaN(parsedStock)) config.stock = parsedStock;
      }

      saveConfig(config);

      // Phát tới tất cả client đang kết nối panel
      io.emit('configUpdate', config);

      const line = `[WebPanel] ${new Date().toLocaleTimeString()} — Config đã cập nhật: ${JSON.stringify(config)}`;
      console.log(line);
      io.emit('log', line);

      // Tự động cập nhật Panel ở Discord
      if (global.discordClient && config.panelMessage) {
        (async () => {
          try {
            const autobuy = require('../bot/commands/autobuy');
            const ok = await autobuy.updatePanel(global.discordClient, config);
            if (ok) io.emit('log', `[Discord] ✅ Đã tự động cập nhật giá/kho trên Panel Discord.`);
          } catch (e) {
            io.emit('log', `[Discord] ⚠️ Không thể cập nhật Panel tự động: ${e.message}`);
          }
        })();
      }

      res.json({ success: true, config });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── API: Thêm tài khoản ──
  app.post('/api/accounts', (req, res) => {
    try {
      const config = loadConfig();
      if (!config.accounts) config.accounts = [];
      const { account } = req.body;
      if (account && !config.accounts.includes(account)) {
        config.accounts.push(account);
        saveConfig(config);
        io.emit('configUpdate', config);
        
        const line = `[WebPanel] ${new Date().toLocaleTimeString()} — Đã thêm tài khoản: ${account}`;
        console.log(line);
        io.emit('log', line);
      }
      res.json({ success: true, config });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── API: Xóa tài khoản ──
  app.delete('/api/accounts', (req, res) => {
    try {
      const config = loadConfig();
      if (!config.accounts) config.accounts = [];
      const { account } = req.body;
      if (account && config.accounts.includes(account)) {
        config.accounts = config.accounts.filter(a => a !== account);
        saveConfig(config);
        io.emit('configUpdate', config);
        
        const line = `[WebPanel] ${new Date().toLocaleTimeString()} — Đã xóa tài khoản: ${account}`;
        console.log(line);
        io.emit('log', line);
      }
      res.json({ success: true, config });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── API: Reconnect Bot ──
  app.post('/api/reconnect', (req, res) => {
    try {
      if (global.mcBot && typeof global.mcBot.reconnect === 'function') {
        global.mcBot.reconnect();
        res.json({ success: true, message: 'Đang ngắt kết nối và thử lại...' });
      } else {
        res.status(400).json({ success: false, error: 'Bot chưa sẵn sàng' });
      }
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── API: Gửi lệnh/chat vào game ──
  app.post('/api/chat', (req, res) => {
    try {
      const { message } = req.body;
      if (!message) return res.status(400).json({ success: false, error: 'Message is required' });
      
      if (global.mcBot && typeof global.mcBot.sendChat === 'function') {
        const success = global.mcBot.sendChat(message);
        if (success) {
          const line = `[WebPanel] ${new Date().toLocaleTimeString()} — Bạn gửi: ${message}`;
          io.emit('log', line);
          res.json({ success: true });
        } else {
          res.status(400).json({ success: false, error: 'Bot chưa kết nối' });
        }
      } else {
        res.status(400).json({ success: false, error: 'Hệ thống chưa sẵn sàng' });
      }
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── Route webhook ──
  app.use('/api/webhook', webhookRouter);
  app.use('/charge/callback', webhookRouter);

  // ── Kết nối Socket.io ──
  io.on('connection', (socket) => {
    const line = `[WebPanel] ${new Date().toLocaleTimeString()} — Admin panel đã kết nối`;
    console.log(line);
    socket.emit('log', line);

    // Gửi config hiện tại khi kết nối
    socket.emit('configUpdate', loadConfig());
  });

  // ── Bắt đầu lắng nghe ──
  const PORT = process.env.WEB_PORT || 3000;
  return new Promise((resolve) => {
    server.listen(PORT, () => {
      console.log(`\n🌐 Web Panel đang chạy tại http://localhost:${PORT}\n`);
      resolve({ io, app, server });
    });
  });
}

module.exports = { startWebPanel };
