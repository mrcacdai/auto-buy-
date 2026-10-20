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
const { formatNumber, formatStock, parseAmount, calculatePrice } = require('../../utils/parser');
const { EmbedBuilder, MessageFlags } = require('discord.js');
const { verifyCallbackSign, checkCard, getStatusDescription, getCardFee } = require('../../utils/cardService');
const { addBalance, getBalance, logHistory } = require('../../utils/balanceManager');
const { sendFeedbackThanks } = require('../../utils/feedbackNotifier');
const { updateOrderStatus, readOrders, saveOrder, generateOrderId } = require('../../utils/orderManager');

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
/**
 * Trích xuất mảng giao dịch từ nhiều định dạng webhook ngân hàng khác nhau:
 *   • Casso: { error: 0, data: [ { id, description, amount, ... } ] }
 *   • SePay: { id, content, transferAmount, ... } hoặc mảng
 *   • PayOS: { code: "00", data: { ... } }
 *   • MBBank / VietQR Pro: { transactions: [ ... ] } hoặc [ { ... } ]
 * @param {any} body
 * @returns {Array<Object>}
 */
function extractTransactions(body) {
  if (!body) return [];
  if (Array.isArray(body)) return body;
  if (body.data) {
    if (Array.isArray(body.data)) return body.data;
    if (typeof body.data === 'object' && body.data !== null) return [body.data];
  }
  if (Array.isArray(body.transactions)) return body.transactions;
  if (Array.isArray(body.records)) return body.records;
  if (Array.isArray(body.TranList)) return body.TranList;
  if (
    body.content !== undefined ||
    body.transferAmount !== undefined ||
    body.description !== undefined ||
    body.amount !== undefined ||
    body.gateway !== undefined
  ) {
    return [body];
  }
  return [];
}

// ── Quản lý lưu trữ giao dịch ngân hàng đã hoàn thành (Chống xử lý trùng lặp & Khóa in-flight) ──
const COMPLETED_TX_FILE = path.join(__dirname, '..', '..', 'data', 'completed_transactions.json');

function loadCompletedTxs() {
  try {
    if (fs.existsSync(COMPLETED_TX_FILE)) {
      const arr = JSON.parse(fs.readFileSync(COMPLETED_TX_FILE, 'utf8'));
      if (Array.isArray(arr)) return new Set(arr.map(String));
    }
  } catch (_) {}
  return new Set();
}

function saveCompletedTx(txId) {
  if (!txId) return;
  try {
    let arr = [];
    if (fs.existsSync(COMPLETED_TX_FILE)) {
      arr = JSON.parse(fs.readFileSync(COMPLETED_TX_FILE, 'utf8')) || [];
    }
    const sId = String(txId);
    if (!arr.includes(sId)) {
      arr.push(sId);
      if (arr.length > 5000) arr = arr.slice(-5000);
      fs.writeFileSync(COMPLETED_TX_FILE, JSON.stringify(arr, null, 2), 'utf8');
    }
  } catch (_) {}
}

function removeCompletedTx(txId) {
  if (!txId) return;
  try {
    if (fs.existsSync(COMPLETED_TX_FILE)) {
      let arr = JSON.parse(fs.readFileSync(COMPLETED_TX_FILE, 'utf8')) || [];
      const sId = String(txId);
      if (arr.includes(sId)) {
        arr = arr.filter((id) => id !== sId);
        fs.writeFileSync(COMPLETED_TX_FILE, JSON.stringify(arr, null, 2), 'utf8');
      }
    }
  } catch (_) {}
}

function saveAllCompletedTxs(txSet) {
  if (!txSet) return;
  try {
    const arr = Array.from(txSet).slice(-5000);
    fs.writeFileSync(COMPLETED_TX_FILE, JSON.stringify(arr, null, 2), 'utf8');
  } catch (_) {}
}

const processedTxs = loadCompletedTxs();
const inFlightTxs = new Set();
const unmatchedTxs = new Map();
let isPolling = false;
let isFirstPoll = true;

/**
 * Xóa sạch lịch sử check API cũ và reset trạng thái polling
 */
function clearApiHistory() {
  processedTxs.clear();
  inFlightTxs.clear();
  unmatchedTxs.clear();
  try {
    if (fs.existsSync(COMPLETED_TX_FILE)) {
      fs.writeFileSync(COMPLETED_TX_FILE, JSON.stringify([], null, 2), 'utf8');
    }
  } catch (_) {}
  isFirstPoll = true;
  console.log('[Webhook/Bank] 🧹 Đã xóa sạch lịch sử check API cũ và đặt lại trạng thái khởi đầu.');
}

/**
 * Tìm đơn hàng chờ khớp với giao dịch chuyển khoản
 * @param {Array<Object>} candidateOrders
 * @param {string} actualDesc
 * @param {number} receivedAmount
 * @param {string} description
 * @returns {{ order: Object, matchType: string } | null}
 */
function findMatchingPendingOrder(candidateOrders, actualDesc, receivedAmount, description) {
  for (const pending of candidateOrders) {
    const cleanIgn = String(
      pending.ignForMemo ||
      (pending.ign ? pending.ign.replace(/[^a-zA-Z0-9]/g, '') : '')
    ).toLowerCase();

    const orderIdStr = String(pending.orderId || pending.id || '').toLowerCase();
    const orderIdClean = orderIdStr.replace(/[^a-z0-9]/g, ''); // VD: dh839120
    const orderIdNumOnly = orderIdClean.replace(/^dh/, '');    // VD: 839120

    const rawAmountClean = String(pending.rawAmount || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const numericAmountStr = pending.amount ? String(pending.amount) : '';

    // Các biến thể memo hợp lệ
    const expectedMemo = `hpbirthday${cleanIgn}${rawAmountClean}`;
    const altExpectedMemo = `hpbirthday${rawAmountClean}${cleanIgn}`;
    const numericMemo = `hpbirthday${cleanIgn}${numericAmountStr}`;
    const altNumericMemo = `hpbirthday${numericAmountStr}${cleanIgn}`;

    const legacyMemo = `muamon${rawAmountClean}${cleanIgn}`;
    const legacyMemo2 = `muamon${cleanIgn}${rawAmountClean}`;
    const legacyMemo3 = `muamon${cleanIgn}${numericAmountStr}`;

    // Khớp theo mã đơn hàng
    const matchOrderId =
      (orderIdClean && actualDesc.includes(orderIdClean)) ||
      (orderIdNumOnly && orderIdNumOnly.length >= 6 && actualDesc.includes(orderIdNumOnly));

    // Khớp theo cú pháp đầy đủ
    const matchFullMemo =
      (expectedMemo && actualDesc.includes(expectedMemo)) ||
      (altExpectedMemo && actualDesc.includes(altExpectedMemo)) ||
      (numericMemo && actualDesc.includes(numericMemo)) ||
      (altNumericMemo && actualDesc.includes(altNumericMemo)) ||
      (legacyMemo && actualDesc.includes(legacyMemo)) ||
      (legacyMemo2 && actualDesc.includes(legacyMemo2)) ||
      (legacyMemo3 && actualDesc.includes(legacyMemo3));

    // Khớp linh hoạt: Có IGN và từ khóa giao dịch
    const hasIgn = cleanIgn && cleanIgn.length >= 3 && actualDesc.includes(cleanIgn);
    const hasKeyword =
      actualDesc.includes('hpbirthday') ||
      actualDesc.includes('muamon') ||
      actualDesc.includes('autobuy') ||
      actualDesc.includes('donutsmp') ||
      actualDesc.includes('mon');

    // Khớp số tiền
    const expectedVnd = Number(pending.totalPrice || pending.amountVnd || 0);
    const amountMatches = expectedVnd > 0 && receivedAmount >= expectedVnd;

    if (matchOrderId && amountMatches) {
      return { order: pending, matchType: `mã đơn hàng: \`${orderIdClean}\`` };
    }
    if (matchFullMemo && amountMatches) {
      return { order: pending, matchType: `cú pháp memo: \`${expectedMemo}\`` };
    }
    if (hasIgn && hasKeyword && amountMatches) {
      return { order: pending, matchType: `IGN [${cleanIgn}] và từ khóa hợp lệ` };
    }
    if (hasIgn && expectedVnd > 0 && receivedAmount === expectedVnd) {
      return { order: pending, matchType: `IGN [${cleanIgn}] và số tiền chính xác ${receivedAmount}` };
    }
  }

  return null;
}

/**
 * Tự động phân tích IGN và số lượng mon từ nội dung chuyển khoản
 * Hỗ trợ các cú pháp:
 *   • hpbirthday <ign> <số_mon> (hoặc ngược lại)
 *   • muamon <ign> <số_mon> (hoặc ngược lại)
 * Xử lý khoảng trắng xen giữa số/chữ do ngân hàng chèn vào (vd: '100 m', '1 50m', 'ferisnotdev il')
 */
function parseMemoDirect(text) {
  if (!text) return null;
  const clean = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();

  // Pattern 1: (hpbirthday|muamon) <ign> <amount> (IGN đứng trước)
  const match1 = clean.match(
    /(?:hpbirthday|muamon)\s+([a-zA-Z0-9_\s]{2,25}?)\s+(\d+(?:\s*\d+)*\s*(?:m|b|k|tr|trieu)?)(?:[^a-zA-Z0-9]|$)/i
  );
  if (match1) {
    const rawIgn = match1[1].replace(/\s+/g, '');
    const rawAmt = match1[2].replace(/\s+/g, '');
    const amt = parseAmount(rawAmt);
    if (rawIgn.length >= 3 && amt && amt > 0) {
      return { ign: rawIgn, rawAmount: rawAmt, amount: amt };
    }
  }

  // Pattern 2: (hpbirthday|muamon) <amount> <ign> (Amount đứng trước)
  const match2 = clean.match(
    /(?:hpbirthday|muamon)\s+(\d+(?:\s*\d+)*\s*(?:m|b|k|tr|trieu)?)\s+([a-zA-Z0-9_\s]{2,25}?)(?:(?:\.|\s+TU:|\s+FT|\s+k2|\s+-|\s+Ma\s+GD)|$)/i
  );
  if (match2) {
    const rawAmt = match2[1].replace(/\s+/g, '');
    const rawIgn = match2[2].replace(/\s+/g, '');
    const amt = parseAmount(rawAmt);
    if (rawIgn.length >= 3 && amt && amt > 0) {
      return { ign: rawIgn, rawAmount: rawAmt, amount: amt };
    }
  }

  return null;
}

/**
 * Trích xuất mã giao dịch duy nhất hoặc tạo fingerprint cố định (không bao giờ dùng random)
 * @param {Object} tx
 * @returns {string}
 */
function getTransactionId(tx) {
  if (!tx || typeof tx !== 'object') return '';
  const candidate = tx.id || tx.tranId || tx.refNo || tx.transactionId || tx.SeqNo || tx.seqNo || tx.transactionNumber || tx.transId || tx.docId;
  if (candidate !== undefined && candidate !== null && String(candidate).trim() !== '') {
    return String(candidate).trim();
  }
  // Deterministic fingerprint dựa trên số tiền, nội dung và ngày giao dịch - TUYỆT ĐỐI KHÔNG dùng Math.random()!
  let amount = tx.amount !== undefined ? tx.amount : tx.creditAmount !== undefined ? tx.creditAmount : tx.transferAmount || 0;
  amount = Math.abs(parseFloat(amount) || 0);
  const desc = String(tx.description || tx.remark || tx.content || tx.memo || '').trim();
  const date = String(tx.transactionDate || tx.date || tx.time || tx.create_time || '').trim();
  return `tx_${amount}_${desc}_${date}`.replace(/[\s\.]+/g, '_');
}

/**
 * Xử lý các giao dịch chuyển khoản ngân hàng nhận được
 * @param {Array<Object>} transactions
 */
async function processTransactions(transactions) {
  const { io, discordClient, mcBot } = global;

  const webLog = (msg) => {
    const line = `[Webhook/Bank] ${new Date().toLocaleTimeString()} — ${msg}`;
    console.log(line);
    if (io) io.emit('log', line);
  };

  if (!transactions || !transactions.length) {
    return;
  }

  for (const tx of transactions) {
    const txId = getTransactionId(tx);
    if (!txId) continue;

    // 1. Trích xuất nội dung CK từ nhiều trường khả dĩ (description, content, remark, memo, addInfo...)
    const description = String(
      tx.description ||
      tx.content ||
      tx.remark ||
      tx.desc ||
      tx.memo ||
      tx.addInfo ||
      tx.message ||
      ''
    ).trim();

    // 2. Trích xuất số tiền nhận được (amount, transferAmount, creditAmount, soTien...)
    const rawAmountVal =
      tx.amount !== undefined
        ? tx.amount
        : tx.transferAmount !== undefined
        ? tx.transferAmount
        : tx.creditAmount !== undefined
        ? tx.creditAmount
        : tx.soTien;

    const receivedAmount = Math.abs(parseFloat(rawAmountVal) || 0);

    // 3. Chuẩn hóa nội dung CK để so sánh (xóa dấu tiếng Việt & ký tự đặc biệt)
    const normalizedDesc = description
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
    const actualDesc = normalizedDesc.replace(/[^a-z0-9]/g, '');

    // 4. KIỂM TRA ĐƠN HÀNG TRÊN DISK: Nếu giao dịch này thuộc về đơn hàng ĐÃ HOÀN THÀNH -> BỎ QUA NGAY!
    const persistedOrders = readOrders();
    let alreadyCompletedOrder = null;

    for (const [k, ord] of Object.entries(persistedOrders)) {
      if (ord.status === 'COMPLETED') {
        const ordId = String(ord.orderId || ord.id || k).toLowerCase().replace(/[^a-z0-9]/g, '');
        const ordNum = ordId.replace(/^dh/, '');

        // Khớp mã đơn hàng đã hoàn thành (VD: dh839120 hoặc 839120)
        if (
          (ordId && ordId.length >= 6 && actualDesc.includes(ordId)) ||
          (ordNum && ordNum.length >= 6 && actualDesc.includes(ordNum))
        ) {
          alreadyCompletedOrder = ord;
          break;
        }

        // Khớp mã ngân hàng bankTxId đã từng ghi nhận
        if (ord.bankTxId && String(ord.bankTxId) === txId) {
          alreadyCompletedOrder = ord;
          break;
        }
      }
    }

    if (alreadyCompletedOrder) {
      webLog(`⚠️ Bỏ qua: Giao dịch này thuộc về đơn hàng [${alreadyCompletedOrder.orderId || alreadyCompletedOrder.id}] ĐÃ HOÀN THÀNH trước đó (${alreadyCompletedOrder.userTag || alreadyCompletedOrder.ign}). Tuyệt đối không xử lý lại!`);
      processedTxs.add(txId);
      saveCompletedTx(txId);
      continue;
    }

    // 5. Kiểm tra inFlight: nếu giao dịch này đang được xử lý ở luồng khác -> bỏ qua lần gọi trùng
    if (inFlightTxs.has(txId)) {
      continue;
    }

    // 6. Tập hợp danh sách đơn hàng chờ thanh toán từ CẢ RAM (pendingOrders) VÀ Disk (orders.json)
    const candidateOrders = [];
    const seenOrderIds = new Set();

    // 6.1. Từ client.pendingOrders (in-memory)
    if (discordClient && discordClient.pendingOrders) {
      for (const [uid, pending] of discordClient.pendingOrders.entries()) {
        const id = (pending.orderId || pending.id || '').toUpperCase();
        if (id) seenOrderIds.add(id);
        candidateOrders.push({
          ...pending,
          _source: 'memory',
          _uid: uid,
          userId: pending.userId || uid,
        });
      }
    }

    // 6.2. Từ data/orders.json (disk): CHỈ lấy các đơn ĐANG CHỜ THANH TOÁN (PENDING_PAYMENT) hoặc mới EXPIRED trong 2h
    try {
      for (const [k, ord] of Object.entries(persistedOrders)) {
        const id = (ord.orderId || ord.id || k).toUpperCase();
        if (seenOrderIds.has(id)) continue;

        const isPending = ord.status === 'PENDING_PAYMENT';
        const isRecentExpired =
          ord.status === 'EXPIRED' &&
          ord.createdAt &&
          Date.now() - new Date(ord.createdAt).getTime() < 2 * 60 * 60 * 1000;

        if (!isPending && !isRecentExpired) continue;

        candidateOrders.push({
          ...ord,
          _source: 'disk',
          _uid: ord.userId,
          userId: ord.userId,
        });
      }
    } catch (e) {
      webLog(`⚠️ Lỗi đọc đơn hàng từ disk: ${e.message}`);
    }

    // 7. Tìm đơn hàng khớp
    let matchResult = findMatchingPendingOrder(candidateOrders, actualDesc, receivedAmount, description);
    let order = matchResult ? matchResult.order : null;
    let discordUserId = order ? (order._uid || order.userId) : null;

    if (matchResult) {
      webLog(`🎯 Khớp đơn theo ${matchResult.matchType}`);
    }

    // 7.1. Nếu không tìm thấy trong candidateOrders -> Thử parseMemoDirect
    if (!order) {
      const directInfo = parseMemoDirect(description);
      if (directInfo) {
        const isAlreadyDone = Object.values(persistedOrders).some(o => {
          if (o.status !== 'COMPLETED') return false;
          const cleanOrdIgn = String(o.ign || '').toLowerCase().replace(/[^a-z0-9]/g, '');
          const cleanDescIgn = String(directInfo.ign || '').toLowerCase().replace(/[^a-z0-9]/g, '');
          if (cleanOrdIgn !== cleanDescIgn) return false;
          return Number(o.amount || o.gameMoney || 0) === Number(directInfo.amount);
        });

        if (isAlreadyDone) {
          webLog(`⚠️ Bỏ qua: Đã có đơn hàng [COMPLETED] của IGN [${directInfo.ign}] với số lượng ${formatStock(directInfo.amount)}. Không tự động tạo lại đơn cũ!`);
          processedTxs.add(txId);
          saveCompletedTx(txId);
          continue;
        }

        const config = loadConfig();
        const { baseAmount, basePrice, currency } = config.price;
        const expectedPrice = calculatePrice(directInfo.amount, baseAmount, basePrice);

        if (receivedAmount >= expectedPrice) {
          const autoOrderId = generateOrderId();
          order = {
            id: autoOrderId,
            orderId: autoOrderId,
            userId: null,
            userTag: directInfo.ign,
            ign: directInfo.ign,
            amount: directInfo.amount,
            gameMoney: directInfo.amount,
            rawAmount: directInfo.rawAmount,
            totalPrice: expectedPrice,
            amountVnd: receivedAmount,
            currency: currency || 'VNĐ',
            paymentMethod: 'Ngân Hàng (Tự động nhận diện nội dung)',
            status: 'PROCESSING',
            memo: description,
            createdAt: new Date().toISOString(),
          };
          saveOrder(order);
          discordUserId = null;
          webLog(`🎯 TỰ ĐỘNG KHỚP ĐƠN TỪ NỘI DUNG CK: IGN=${directInfo.ign}, Số mon=${formatStock(directInfo.amount)}, Nhận=${receivedAmount.toLocaleString('vi-VN')} VNĐ (Giá cần: ${expectedPrice.toLocaleString('vi-VN')} VNĐ). Mã đơn: [${autoOrderId}]`);
        } else {
          webLog(`⚠️ Nhận diện được cú pháp (${directInfo.ign} ${directInfo.rawAmount}) nhưng số tiền thiếu: nhận ${receivedAmount.toLocaleString('vi-VN')} VNĐ, cần ${expectedPrice.toLocaleString('vi-VN')} VNĐ. Bỏ qua.`);
        }
      }
    }

    // 8. KIỂM TRA processedTxs (VÀ TỰ ĐỘNG PHỤC HỒI NẾU BỊ CHẶN NHẦM)
    if (processedTxs.has(txId)) {
      if (order) {
        webLog(`🔄 Phát hiện giao dịch [${txId}] có đơn hàng ĐANG CHỜ [${order.orderId || order.id}]. Tự động gỡ chặn và tiếp tục xử lý thanh toán ngay!`);
        processedTxs.delete(txId);
        removeCompletedTx(txId);
      } else {
        webLog(`⚠️ Bỏ qua giao dịch đã xử lý trước đó: [${txId}]`);
        continue;
      }
    }

    // 9. Nếu không tìm thấy đơn hàng nào khớp
    if (!order) {
      if (!unmatchedTxs.has(txId)) {
        unmatchedTxs.set(txId, Date.now());
        webLog(`⚠️ Bỏ qua: Không tìm thấy đơn hàng chờ nào khớp với "${description}" (Số tiền: ${receivedAmount.toLocaleString('vi-VN')} VNĐ). Sẽ chờ thêm 5 phút nếu khách tạo đơn.`);
      } else {
        const firstSeen = unmatchedTxs.get(txId);
        if (Date.now() - firstSeen > 5 * 60 * 1000) {
          processedTxs.add(txId);
          saveCompletedTx(txId);
          unmatchedTxs.delete(txId);
          webLog(`⏰ Giao dịch [${txId}] quá 5 phút không có đơn hàng khớp nào. Bỏ qua hoàn toàn.`);
        }
      }
      continue;
    }

    // Đã tìm thấy đơn hàng -> Xóa khỏi unmatchedTxs
    unmatchedTxs.delete(txId);

    // Xác minh số tiền
    const requiredAmount = Number(order.totalPrice || order.amountVnd || 0);
    if (receivedAmount < requiredAmount) {
      webLog(`⚠️ Số tiền không khớp: nhận ${receivedAmount.toLocaleString('vi-VN')} VNĐ, cần ${requiredAmount.toLocaleString('vi-VN')} VNĐ. Bỏ qua.`);
      continue;
    }

    webLog(`🔔 Giao dịch ngân hàng đến: ${receivedAmount.toLocaleString('vi-VN')} VNĐ — Nội dung: "${description}"`);
    webLog(`✅ Thanh toán xác nhận cho ${order.userTag} — ${formatNumber(requiredAmount)} ${order.currency || 'VNĐ'}`);

    inFlightTxs.add(txId);
    try {

      // ── Kiểm tra nếu server Minecraft đang update ──
      const { isServerUpdating, addPendingRetry } = require('../../utils/orderRetryManager');
      if (isServerUpdating()) {
        webLog(`⚠️ Đơn [${order.orderId || 'N/A'}] của ${order.userTag} đã nhận tiền nhưng server đang UPDATE. Đã đưa vào hàng đợi pay lại sau 30p.`);

        addPendingRetry({
          orderId: order.orderId,
          id: order.orderId,
          userId: discordUserId,
          userTag: order.userTag,
          ign: order.ign,
          gameMoney: order.amount,
          amountVnd: order.totalPrice,
          paymentMethod: order.paymentMethod || 'Ngân Hàng / VietQR',
        });
        if (order.orderId) updateOrderStatus(order.orderId, 'WAITING_RETRY');
        if (txId) {
          processedTxs.add(txId);
          saveCompletedTx(txId);
        }

        // Xóa tin nhắn QR cũ & thông báo
        try {
          if (order.interaction) {
            try {
              await order.interaction.deleteReply();
            } catch (_) {}
            try {
              const msg = await order.interaction.followUp({
                content: 'bot đã nhận được tiền nhưng server đang update bot sẽ pay lại sau 30p',
                flags: MessageFlags.Ephemeral,
              });
              setTimeout(async () => {
                try { await order.interaction.deleteReply(msg); } catch (_) {}
              }, 10000);
            } catch (_) {}
          }

          // Gửi DM cho member
          const user = await discordClient.users.fetch(discordUserId);
          if (user) {
            const updateEmbed = new EmbedBuilder()
              .setColor(0xfaa61a)
              .setTitle('⏳ bot đã nhận được tiền nhưng server đang update bot sẽ pay lại sau 30p')
              .setDescription(
                [
                  `Chào **${order.userTag}**, hệ thống đã nhận được tiền thanh toán của bạn!`,
                  '',
                  order.orderId ? `🆔 **Mã đơn hàng:** \`${order.orderId}\`` : '',
                  `💵 **Số tiền đã chuyển:** \`${formatNumber(order.totalPrice)} ${order.currency}\``,
                  `💰 **Số mon cần nhận:** \`${formatStock(order.amount)}\` (${formatNumber(order.amount)})`,
                  `🎮 **IGN nhận:** \`${order.ign}\``,
                  '',
                  `⚠️ **Server Minecraft hiện đang cập nhật (updating)!**`,
                  `🤖 **bot đã nhận được tiền nhưng server đang update bot sẽ pay lại sau 30p**`,
                  '',
                  `*Đơn hàng của bạn đã được bảo lưu an toàn 100%. Bot sẽ tự động thực hiện lệnh /pay sau 30 phút!*`,
                ].filter(Boolean).join('\n')
              )
              .setFooter({ text: `Mã đơn: ${order.orderId || 'N/A'} • Auto Buy Money • Đơn đã được bảo lưu an toàn` })
              .setTimestamp();

            await user.send({
              content: 'bot đã nhận được tiền nhưng server đang update bot sẽ pay lại sau 30p',
              embeds: [updateEmbed],
            }).catch(() => {
              webLog(`Không thể DM ${order.userTag}.`);
            });
          }
        } catch (notifyErr) {
          webLog(`Lỗi thông báo cho ${order.userTag}: ${notifyErr.message}`);
        }

        // Gửi admin log webhook
        try {
          const webhookUrl = process.env.ADMIN_WEBHOOK_URL;
          if (webhookUrl && !webhookUrl.includes('YOUR_WEBHOOK_ID')) {
            const logEmbed = {
              title: '📋 Nhật Ký Giao Dịch Chờ Pay (Server Đang Update)',
              color: 0xfaa61a,
              fields: [
                { name: '🕐 Thời gian', value: new Date().toISOString(), inline: true },
                { name: '🆔 Mã đơn hàng', value: `\`${order.orderId || 'N/A'}\``, inline: true },
                { name: '👤 Người mua', value: `${order.userTag} (${order.userId})`, inline: true },
                { name: '💰 Số tiền game', value: formatNumber(order.amount), inline: true },
                { name: '💵 Số tiền VNĐ', value: `${formatNumber(order.totalPrice)} ${order.currency}`, inline: true },
                { name: '🎮 IGN', value: `\`${order.ign}\``, inline: true },
                { name: '⏳ Trạng thái', value: 'Server updating - Chờ retry sau 30p', inline: false },
              ],
              timestamp: new Date().toISOString(),
            };
            await axios.post(webhookUrl, { embeds: [logEmbed] });
          }
        } catch (_) {}

        // Xóa khỏi danh sách đơn chờ thanh toán
        discordClient.pendingOrders.delete(discordUserId);
        continue;
      }

      // ── Thực hiện /pay trong Minecraft & Xác nhận bằng tin nhắn chat "You paid" ──
      const { payAndVerify } = require('../../utils/orderRetryManager');
      const { beginOrderProcessing, finishOrderProcessing } = require('../../utils/afkCycleManager');
      webLog(`🔄 Đang gửi /pay ${order.ign} ${order.amount} và đợi server xác nhận "You paid"...`);
      beginOrderProcessing();
      let verifyResult;
      try {
        verifyResult = await payAndVerify(order.ign, order.amount, 15000);
      } finally {
        finishOrderProcessing();
      }

      if (!verifyResult.success) {
        webLog(`⚠️ Không nhận được xác nhận "You paid" cho ${order.ign} (${verifyResult.reason || 'Timeout'}). Đơn đã thanh toán nên đưa vào hàng đợi pay lại sau 30p.`);

        addPendingRetry({
          orderId: order.orderId,
          id: order.orderId,
          userId: discordUserId,
          userTag: order.userTag,
          ign: order.ign,
          gameMoney: order.amount,
          amountVnd: order.totalPrice,
          paymentMethod: order.paymentMethod || 'Ngân Hàng / VietQR',
        });
        if (order.orderId) updateOrderStatus(order.orderId, 'WAITING_RETRY');
        if (txId) {
          processedTxs.add(txId);
          saveCompletedTx(txId);
        }

        // Xóa tin nhắn QR cũ & thông báo cho member
        try {
          if (order.interaction) {
            try { await order.interaction.deleteReply(); } catch (_) {}
            try {
              const msg = await order.interaction.followUp({
                content: 'bot đã nhận được tiền nhưng server đang update bot sẽ pay lại sau 30p',
                flags: MessageFlags.Ephemeral,
              });
              setTimeout(async () => {
                try { await order.interaction.deleteReply(msg); } catch (_) {}
              }, 10000);
            } catch (_) {}
          }

          // Gửi DM cho member
          const user = await discordClient.users.fetch(discordUserId);
          if (user) {
            const updateEmbed = new EmbedBuilder()
              .setColor(0xfaa61a)
              .setTitle('⏳ bot đã nhận được tiền nhưng server đang update bot sẽ pay lại sau 30p')
              .setDescription(
                [
                  `Chào **${order.userTag}**, hệ thống đã nhận được tiền thanh toán của bạn!`,
                  '',
                  order.orderId ? `🆔 **Mã đơn hàng:** \`${order.orderId}\`` : '',
                  `💵 **Số tiền đã chuyển:** \`${formatNumber(order.totalPrice)} ${order.currency}\``,
                  `💰 **Số mon cần nhận:** \`${formatStock(order.amount)}\` (${formatNumber(order.amount)})`,
                  `🎮 **IGN nhận:** \`${order.ign}\``,
                  '',
                  `⚠️ **Server Minecraft chưa xác nhận lệnh chuyển tiền (hoặc đang update)!**`,
                  `🤖 **bot đã nhận được tiền nhưng server đang update bot sẽ pay lại sau 30p**`,
                  '',
                  `*Đơn hàng của bạn đã được bảo lưu an toàn 100%. Bot sẽ tự động thực hiện lệnh /pay sau 30 phút!*`,
                ].filter(Boolean).join('\n')
              )
              .setFooter({ text: `Mã đơn: ${order.orderId || 'N/A'} • Auto Buy Money • Đơn đã được bảo lưu an toàn` })
              .setTimestamp();

            await user.send({
              content: 'bot đã nhận được tiền nhưng server đang update bot sẽ pay lại sau 30p',
              embeds: [updateEmbed],
            }).catch(() => {
              webLog(`Không thể DM ${order.userTag}.`);
            });
          }
        } catch (notifyErr) {
          webLog(`Lỗi thông báo cho ${order.userTag}: ${notifyErr.message}`);
        }

        // Gửi admin log webhook
        try {
          const webhookUrl = process.env.ADMIN_WEBHOOK_URL;
          if (webhookUrl && !webhookUrl.includes('YOUR_WEBHOOK_ID')) {
            const logEmbed = {
              title: '📋 Nhật Ký Giao Dịch Chờ Pay (Chưa Nhận Được Xác Nhận /Pay)',
              color: 0xfaa61a,
              fields: [
                { name: '🕐 Thời gian', value: new Date().toISOString(), inline: true },
                { name: '🆔 Mã đơn hàng', value: `\`${order.orderId || 'N/A'}\``, inline: true },
                { name: '👤 Người mua', value: `${order.userTag} (${order.userId})`, inline: true },
                { name: '💰 Số tiền game', value: formatNumber(order.amount), inline: true },
                { name: '💵 Đã thanh toán', value: `${formatNumber(order.totalPrice)} ${order.currency}`, inline: true },
                { name: '🎮 IGN', value: `\`${order.ign}\``, inline: true },
                { name: '💳 Phương thức', value: order.paymentMethod, inline: true },
                { name: '📝 Nội dung CK', value: `\`${description}\``, inline: false },
                { name: '⏳ Trạng thái', value: 'Chờ bot pay lại sau 30p (Không thấy "You paid")', inline: false },
              ],
              timestamp: new Date().toISOString(),
            };
            await axios.post(webhookUrl, { embeds: [logEmbed] });
          }
        } catch (_) {}

        // Xóa khỏi danh sách đơn chờ thanh toán
        discordClient.pendingOrders.delete(discordUserId);
        continue;
      }

      webLog(`✅ ĐÃ XÁC NHẬN PAY THÀNH CÔNG TỪ MINECRAFT: "${verifyResult.paidInfo?.raw || 'You paid'}"`);
      const executedCommand = `/pay ${order.ign} ${order.amount} (Đã xác nhận: ${verifyResult.paidInfo?.raw || 'You paid'})`;

      // Cập nhật trạng thái COMPLETED ngay lập tức vào orders.json để chống trùng lặp
      if (order.orderId) {
        updateOrderStatus(order.orderId, 'COMPLETED', {
          completedAt: new Date().toISOString(),
          bankTxId: txId,
          paidInfo: verifyResult.paidInfo?.raw,
        });
      }
      if (txId) {
        processedTxs.add(txId);
        saveCompletedTx(txId);
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
        if (discordUserId && discordClient) {
          try {
            const user = await discordClient.users.fetch(discordUserId);
            const successEmbed = new EmbedBuilder()
              .setColor(0x57f287)
              .setTitle('✅ Thanh Toán Thành Công!')
              .setDescription(
                [
                  `Đơn hàng của bạn đã được xử lý thành công.`,
                  '',
                  order.orderId ? `🆔 **Mã đơn hàng:** \`${order.orderId}\`` : '',
                  `**Số tiền:** \`${formatNumber(order.amount)}\` tiền game`,
                  `**Gửi tới IGN:** \`${order.ign}\``,
                  `**Đã thanh toán:** \`${formatNumber(order.totalPrice)} ${order.currency}\``,
                  `**Xác nhận server:** \`${verifyResult.paidInfo?.raw || `You paid ${order.ign} $${formatNumber(order.amount)}`}\``,
                  '',
                  `Tiền đã được gửi qua lệnh \`/pay\`. Chúc bạn chơi vui! 🎉`,
                ].filter(Boolean).join('\n'),
              )
              .setFooter({ text: `Mã đơn: ${order.orderId || 'N/A'} • Auto Buy Money` })
              .setTimestamp();

            await user.send({ embeds: [successEmbed] }).catch(() => {
              webLog(`Không thể DM ${order.userTag}.`);
            });
          } catch (_) {}
        }
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
              { name: '🆔 Mã đơn hàng', value: `\`${order.orderId || 'N/A'}\``, inline: true },
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

      // ── Gửi lời cảm ơn vào kênh feedback ──
      try {
        await sendFeedbackThanks(discordClient, {
          userId: order.userId,
          gameMoney: order.amount,
          ign: order.ign,
          vnd: order.totalPrice,
          paymentMethod: order.paymentMethod,
        });
      } catch (fbErr) {
        webLog(`⚠️ Lỗi gửi feedback: ${fbErr.message}`);
      }

      // ── Xóa khỏi danh sách chờ ──
      if (discordUserId && discordClient && discordClient.pendingOrders) {
        discordClient.pendingOrders.delete(discordUserId);
      }
      webLog(`Đơn hàng của ${order.userTag} đã hoàn thành và xóa khỏi danh sách chờ.`);
    } finally {
      inFlightTxs.delete(txId);
    }
  }
}

/**
 * POST & GET /api/webhook/bank
 * Nhận thông báo giao dịch từ API ngân hàng (Casso, SePay, PayOS, VietQR Pro...).
 */
router.all('/bank', async (req, res) => {
  try {
    const transactions = extractTransactions(req.body);
    if (!transactions.length) {
      console.log('[Webhook/Bank] Nhận request nhưng không trích xuất được giao dịch:', JSON.stringify(req.body));
      return res.json({ success: true, message: 'Không có giao dịch' });
    }
    await processTransactions(transactions);
    return res.json({ success: true });
  } catch (err) {
    console.error('Lỗi webhook bank:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Endpoint gọi xóa lịch sử check API cũ
router.all('/clear-history', (req, res) => {
  try {
    clearApiHistory();
    return res.json({ success: true, message: 'Đã xóa toàn bộ lịch sử check API cũ thành công!' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

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
        
        const id = getTransactionId(tx);
        
        return {
          id: String(id),
          description: tx.description || tx.remark || '',
          amount: amount,
          transactionDate: tx.transactionDate || tx.date || tx.time || ''
        };
      }).filter(tx => tx.amount > 0 && tx.id);

      // Nếu là lần đầu tiên poll sau khi bot khởi động:
      if (isFirstPoll) {
        // Thu thập các mã đơn hàng đang PENDING_PAYMENT để KHÔNG đánh dấu nhầm đơn mới là "đã cũ"
        const persistedOrders = readOrders();
        const pendingDescList = [];
        const { discordClient } = global;
        if (discordClient && discordClient.pendingOrders) {
          for (const [, p] of discordClient.pendingOrders.entries()) {
            if (p.orderId) pendingDescList.push(String(p.orderId).toLowerCase().replace(/[^a-z0-9]/g, ''));
            if (p.ign) pendingDescList.push(String(p.ign).toLowerCase().replace(/[^a-z0-9]/g, ''));
          }
        }
        for (const [k, ord] of Object.entries(persistedOrders)) {
          if (ord.status === 'PENDING_PAYMENT') {
            const ordId = String(ord.orderId || ord.id || k).toLowerCase().replace(/[^a-z0-9]/g, '');
            if (ordId) pendingDescList.push(ordId);
            if (ord.ign) pendingDescList.push(String(ord.ign).toLowerCase().replace(/[^a-z0-9]/g, ''));
          }
        }

        let markedCount = 0;
        normalizedTxs.forEach(tx => {
          const sId = String(tx.id);
          const cleanDesc = String(tx.description || '').toLowerCase().replace(/[^a-z0-9]/g, '');
          
          // Nếu giao dịch khớp với đơn PENDING_PAYMENT thì TUYỆT ĐỐI KHÔNG đánh dấu là cũ!
          const matchesPending = pendingDescList.some(kw => kw && kw.length >= 3 && cleanDesc.includes(kw));
          if (!matchesPending && !processedTxs.has(sId)) {
            processedTxs.add(sId);
            markedCount++;
          }
        });
        saveAllCompletedTxs(processedTxs);
        isFirstPoll = false;
        console.log(`[Webhook/Bank] 🚀 Đã đồng bộ & đánh dấu ${markedCount} giao dịch cũ từ lịch sử ngân hàng. Các đơn hàng đang chờ (nếu có) được giữ lại để xử lý.`);
      }
      
      const newTxs = normalizedTxs.filter(tx => {
        const sId = String(tx.id);
        if (inFlightTxs.has(sId)) return false;
        if (!processedTxs.has(sId)) return true;
        // Nếu trong processedTxs nhưng có đơn hàng đang chờ, vẫn cho vào để auto-recover
        const cleanDesc = String(tx.description || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const persisted = readOrders();
        const hasPendingOrder = Object.values(persisted).some(o => 
          o.status === 'PENDING_PAYMENT' && 
          (cleanDesc.includes(String(o.orderId || o.id || '').toLowerCase().replace(/[^a-z0-9]/g, '')) ||
           (o.ign && cleanDesc.includes(String(o.ign).toLowerCase().replace(/[^a-z0-9]/g, ''))))
        );
        return hasPendingOrder;
      });
      
      if (newTxs.length > 0) {
        // Khóa inFlightTxs để chu kỳ poll tiếp theo không chạy lặp (TUYỆT ĐỐI KHÔNG cho vào processedTxs ở đây!)
        newTxs.forEach(tx => inFlightTxs.add(String(tx.id)));

        try {
          await processTransactions(newTxs);
        } finally {
          newTxs.forEach(tx => inFlightTxs.delete(String(tx.id)));
        }
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

  // Không tìm thấy đơn thẻ chờ -> Tự động bỏ qua không cần thông báo
  if (!order) {
    return;
  }

  webLog(`Kết quả thẻ [${telco} ${serial}]: Trạng thái ${statusCode} (${message}) - Thực nhận: ${actualValue}`);

  const config = loadConfig();
  const { baseAmount, basePrice } = config.price;

  // status 1: Thành công đúng mệnh giá | status 2: Thành công sai mệnh giá
  if (statusCode === 1 || statusCode === 2) {
    const cardFaceValue = Number(data.value || declaredValue || order.amount || 0);

    // Xác định số tiền thực nhận sau chiết khấu
    let cardMoney = 0;
    let fees = 0;

    // 1. Kiểm tra nếu đối tác gửi sẵn số tiền thực nhận sau chiết khấu
    if (data.amount_receive && Number(data.amount_receive) > 0) {
      cardMoney = Math.round(Number(data.amount_receive));
    } else if (data.real_received && Number(data.real_received) > 0) {
      cardMoney = Math.round(Number(data.real_received));
    } else if (data.amount && Number(data.amount) > 0 && Number(data.amount) < cardFaceValue) {
      cardMoney = Math.round(Number(data.amount));
    }

    // 2. Nếu không có trường thực nhận riêng, tính toán chính xác theo biểu phí chiết khấu API
    if (!cardMoney || cardMoney <= 0) {
      const feeInfo = await getCardFee(telco || order.telco, cardFaceValue);
      fees = feeInfo.fees;
      cardMoney = feeInfo.receivedAmount;
    } else {
      fees = Number((((cardFaceValue - cardMoney) / cardFaceValue) * 100).toFixed(2));
    }

    // Cộng số tiền sau chiết khấu vào số dư cá nhân của member
    const depositRes = await addBalance(order.userId, cardMoney, 'CARD_WEBHOOK', {
      telco: telco || order.telco,
      serial: serial || order.serial,
      requestId: order.requestId,
      faceValue: cardFaceValue,
      fees,
      receivedAmount: cardMoney,
    });
    const newBalance = depositRes.success ? depositRes.newBalance : getBalance(order.userId);

    webLog(
      `✅ Nạp thẻ thành công cho ${order.userTag} — Mệnh giá ${formatNumber(cardFaceValue)}đ, Chiết khấu ${fees}% → Thực nhận +${formatNumber(cardMoney)}đ (Số dư: ${formatNumber(newBalance)}đ)`
    );

    // ── Xóa tin nhắn cũ và gửi tin nhắn mới xác nhận (chỉ member nạp thấy), tự xóa sau 5s ──
    const successEmbed = new EmbedBuilder()
      .setColor(statusCode === 1 ? 0x57f287 : 0xfaa61a)
      .setTitle(statusCode === 1 ? '✅ Nạp Thẻ Cào Thành Công!' : '⚠️ Nạp Thẻ Thành Công (Sai Mệnh Giá)')
      .setDescription(
        [
          statusCode === 1
            ? 'Thẻ cào của bạn đã được duyệt thành công đúng mệnh giá.'
            : 'Thẻ của bạn đã được duyệt nhưng **sai mệnh giá khai báo**. Hệ thống đã cộng tiền theo mệnh giá thực sau chiết khấu.',
          '',
          `**Nhà mạng:** \`${telco || order.telco}\``,
          `**Mệnh giá thẻ:** \`${formatNumber(cardFaceValue)} VNĐ\``,
          `**Chiết khấu:** \`${fees}%\``,
          `**Thực nhận cộng vào ví:** \`+${formatNumber(cardMoney)} VNĐ\``,
          `**Số dư hiện tại của bạn:** \`${formatNumber(newBalance)} VNĐ\``,
          `**Mã giao dịch:** \`${order.requestId}\``,
          '',
          `👉 *Bạn có thể dùng số dư này mua money in-game qua nút **💸 Mua Tiền** trên Discord!*`,
        ].join('\n')
      )
      .setFooter({ text: 'Tin nhắn sẽ tự động biến mất sau 5 giây' })
      .setTimestamp();

    if (order.interaction) {
      try {
        await order.interaction.editReply({
          embeds: [successEmbed],
        });
        setTimeout(async () => {
          try { await order.interaction.deleteReply(); } catch (_) {}
        }, 5000);
      } catch (e) {
        webLog(`Không thể cập nhật interaction cho ${order.userTag}: ${e.message}`);
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
            { name: '💵 Mệnh giá thẻ', value: `${formatNumber(cardFaceValue)} VNĐ`, inline: true },
            { name: '🏷️ Chiết khấu', value: `${fees}%`, inline: true },
            { name: '💰 Thực nhận (Cộng ví)', value: `+${formatNumber(cardMoney)} VNĐ`, inline: true },
            { name: '📊 Số dư sau nạp', value: `${formatNumber(newBalance)} VNĐ`, inline: true },
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
    logHistory({
      userId: order.userId,
      type: 'CARD_FAILED',
      amount: order.amount,
      oldBalance: getBalance(order.userId),
      newBalance: getBalance(order.userId),
      reason: `Thẻ bị từ chối: ${message}`,
      meta: {
        telco: telco || order.telco,
        serial: serial || order.serial,
        requestId: order.requestId,
        status: statusCode,
      },
    });

    webLog(`❌ Thẻ bị từ chối cho ${order.userTag}: ${message}`);

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
      .setFooter({ text: 'Tin nhắn sẽ tự động biến mất sau 5 giây' })
      .setTimestamp();

    if (order.interaction) {
      try {
        await order.interaction.editReply({
          embeds: [failEmbed],
        });
        setTimeout(async () => {
          try { await order.interaction.deleteReply(); } catch (_) {}
        }, 5000);
      } catch (e) {
        webLog(`Không thể cập nhật interaction cho ${order.userTag}: ${e.message}`);
      }
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
    if (!data || (data.status === undefined && !data.request_id)) {
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

// ── Tiếp nhận callback từ mọi đường dẫn phổ biến ──
router.all('/', async (req, res, next) => {
  const txs = extractTransactions(req.body);
  if (txs.length > 0) {
    try {
      await processTransactions(txs);
      return res.json({ success: true });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }
  return handleCardCallback(req, res);
});
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
module.exports.handleCardCallback = handleCardCallback;
module.exports.clearApiHistory = clearApiHistory;

