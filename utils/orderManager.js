/**
 * utils/orderManager.js
 * ──────────────────────
 * Quản lý đơn hàng mua tiền game (mon):
 *   • Tạo mã ID duy nhất cho mỗi đơn hàng (VD: DH123456)
 *   • Lưu trữ và cập nhật trạng thái đơn hàng vào data/orders.json (ghi nguyên tử)
 *   • Cung cấp hàm tra cứu đơn hàng theo ID / IGN / User
 *   • Xử lý hủy đơn hàng an toàn theo yêu cầu của Admin:
 *     - Hủy đơn đang chờ chuyển khoản (xóa pendingOrders & cập nhật giao diện QR)
 *     - Hủy đơn trong hàng đợi retry (xóa khỏi pending_retries.json)
 *     - Tự động hoàn tiền về số dư cá nhân nếu khách mua bằng số dư thẻ cào
 *     - Ghi nhận lịch sử và trạng thái hủy chi tiết
 */

const fs = require('fs');
const path = require('path');
const { addBalance, getBalance } = require('./balanceManager');
const { formatNumber, formatStock } = require('./parser');
const { resolvePendingRetry, readPendingRetries } = require('./orderRetryManager');

const DATA_DIR = path.join(__dirname, '..', 'data');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');

// Polyfill BigInt toJSON phòng ngừa bất kỳ trường hợp nào gọi JSON.stringify với BigInt
if (!BigInt.prototype.toJSON) {
  BigInt.prototype.toJSON = function () {
    return this.toString();
  };
}

// Đảm bảo thư mục data tồn tại
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * Đọc toàn bộ danh sách đơn hàng từ data/orders.json
 * @returns {Record<string, Object>} Map orderId -> orderData
 */
function readOrders() {
  try {
    if (!fs.existsSync(ORDERS_FILE)) {
      return {};
    }
    const raw = fs.readFileSync(ORDERS_FILE, 'utf8');
    return JSON.parse(raw) || {};
  } catch (err) {
    console.error('[OrderManager] Lỗi đọc orders.json:', err.message);
    return {};
  }
}

/**
 * Làm sạch dữ liệu đơn hàng trước khi lưu vào disk (loại bỏ interaction, client, chuyển BigInt -> string)
 * @param {Object} data
 * @returns {Object}
 */
function sanitizeOrderData(data) {
  if (!data || typeof data !== 'object') return {};

  const {
    interaction,
    client,
    guild,
    channel,
    member,
    user,
    message,
    ...rest
  } = data;

  const result = {};
  for (const [key, value] of Object.entries(rest)) {
    if (typeof value === 'bigint') {
      result[key] = value.toString();
    } else if (value && typeof value === 'object') {
      if (typeof value.bitfield === 'bigint') {
        result[key] = value.bitfield.toString();
      } else if (Array.isArray(value)) {
        result[key] = value.map((item) =>
          typeof item === 'bigint' ? item.toString() : item
        );
      } else {
        const {
          interaction: _i,
          client: _c,
          guild: _g,
          channel: _ch,
          member: _m,
          ...cleanObj
        } = value;
        result[key] = cleanObj;
      }
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Ghi dữ liệu đơn hàng nguyên tử (Atomic write)
 * @param {Record<string, Object>} orders
 * @returns {boolean}
 */
function writeOrders(orders) {
  const tmpFile = `${ORDERS_FILE}.tmp.${Date.now()}`;
  try {
    const jsonString = JSON.stringify(
      orders,
      (key, value) => {
        if (
          key === 'interaction' ||
          key === 'client' ||
          key === 'guild' ||
          key === 'channel' ||
          key === 'member' ||
          key === 'user' ||
          key === 'message'
        ) {
          return undefined;
        }
        if (typeof value === 'bigint') {
          return value.toString();
        }
        return value;
      },
      2
    );
    fs.writeFileSync(tmpFile, jsonString, 'utf8');
    fs.renameSync(tmpFile, ORDERS_FILE);
    return true;
  } catch (err) {
    console.error('[OrderManager] Lỗi ghi orders.json:', err.message);
    if (fs.existsSync(tmpFile)) {
      try { fs.unlinkSync(tmpFile); } catch (_) {}
    }
    return false;
  }
}

/**
 * Tạo mã ID đơn hàng duy nhất có định dạng: DH + 6 chữ số ngẫu nhiên (VD: DH839120)
 * Kiểm tra trùng lặp trong cả orders.json và pending_retries.json
 * @returns {string}
 */
function generateOrderId() {
  const orders = readOrders();
  const retries = readPendingRetries();

  let id;
  let attempts = 0;
  do {
    // 6 chữ số ngẫu nhiên từ 100000 đến 999999
    const rand = Math.floor(100000 + Math.random() * 900000);
    id = `DH${rand}`;
    attempts++;
  } while (
    (orders[id] || retries.some((r) => r.id === id || r.orderId === id)) &&
    attempts < 100
  );

  // Dự phòng nếu quá 100 lần (cực kỳ hiếm): thêm timestamp
  if (attempts >= 100) {
    id = `DH${Date.now().toString().slice(-6)}${Math.floor(10 + Math.random() * 90)}`;
  }

  return id;
}

/**
 * Lưu hoặc cập nhật một đơn hàng vào data/orders.json
 * @param {Object} orderData
 * @returns {Object} Đơn hàng đã lưu
 */
function saveOrder(orderData) {
  if (!orderData) return null;
  const orders = readOrders();
  const id = orderData.orderId || orderData.id || generateOrderId();

  const existing = orders[id] || {};
  const cleanedExisting = sanitizeOrderData(existing);
  const cleanedOrder = sanitizeOrderData(orderData);

  const updatedOrder = {
    ...cleanedExisting,
    ...cleanedOrder,
    id,
    orderId: id,
    updatedAt: new Date().toISOString(),
  };

  if (!updatedOrder.createdAt) {
    updatedOrder.createdAt = new Date().toISOString();
  }

  orders[id] = updatedOrder;
  writeOrders(orders);
  return updatedOrder;
}

/**
 * Cập nhật trạng thái của một đơn hàng
 * @param {string} orderId
 * @param {string} status PENDING_PAYMENT | PROCESSING | WAITING_RETRY | COMPLETED | CANCELLED | EXPIRED | FAILED_NEEDS_ADMIN
 * @param {Object} extra Các trường bổ sung
 * @returns {Object|null}
 */
function updateOrderStatus(orderId, status, extra = {}) {
  if (!orderId) return null;
  const orders = readOrders();
  const cleanId = String(orderId).trim().toUpperCase();

  // Tìm theo key hoặc thuộc tính orderId/id
  let foundKey = Object.keys(orders).find(
    (k) => k.toUpperCase() === cleanId || orders[k].id?.toUpperCase() === cleanId
  );

  // Nếu chưa có trong orders.json, tìm từ in-memory / retry để khởi tạo
  if (!foundKey) {
    const fallback = getOrder(cleanId);
    if (fallback) {
      foundKey = fallback.orderId || fallback.id || cleanId;
      orders[foundKey] = sanitizeOrderData(fallback);
    }
  }

  if (foundKey && orders[foundKey]) {
    orders[foundKey].status = status;
    orders[foundKey].updatedAt = new Date().toISOString();
    Object.assign(orders[foundKey], sanitizeOrderData(extra));
    writeOrders(orders);
    return orders[foundKey];
  }

  return null;
}

/**
 * Tìm kiếm đơn hàng theo OrderId, IGN hoặc UserId
 * Tra cứu theo thứ tự: orders.json -> pending_retries.json -> client.pendingOrders
 * @param {string} searchKey
 * @param {import('discord.js').Client} [client]
 * @returns {Object|null}
 */
function getOrder(searchKey, client) {
  if (!searchKey) return null;
  const clean = String(searchKey).trim();
  const cleanUpper = clean.toUpperCase();
  const cleanLower = clean.toLowerCase();

  // 1. Tìm trong orders.json
  const orders = readOrders();
  for (const [k, ord] of Object.entries(orders)) {
    if (
      k.toUpperCase() === cleanUpper ||
      (ord.orderId && ord.orderId.toUpperCase() === cleanUpper) ||
      (ord.id && ord.id.toUpperCase() === cleanUpper)
    ) {
      return ord;
    }
  }

  // 2. Tìm trong pending_retries.json
  const retries = readPendingRetries();
  const retryMatch = retries.find(
    (r) =>
      (r.orderId && r.orderId.toUpperCase() === cleanUpper) ||
      (r.id && r.id.toUpperCase() === cleanUpper) ||
      (r.ign && r.ign.toLowerCase() === cleanLower)
  );
  if (retryMatch) {
    return {
      ...retryMatch,
      orderId: retryMatch.orderId || retryMatch.id,
      status: retryMatch.status || 'WAITING_RETRY',
    };
  }

  // 3. Tìm trong client.pendingOrders (in-memory)
  const discordClient = client || global.discordClient;
  if (discordClient && discordClient.pendingOrders) {
    for (const [, pending] of discordClient.pendingOrders.entries()) {
      if (
        (pending.orderId && pending.orderId.toUpperCase() === cleanUpper) ||
        (pending.id && pending.id.toUpperCase() === cleanUpper) ||
        pending.userId === clean ||
        (pending.ign && pending.ign.toLowerCase() === cleanLower)
      ) {
        return {
          ...pending,
          orderId: pending.orderId || pending.id,
          status: 'PENDING_PAYMENT',
        };
      }
    }
  }

  return null;
}

/**
 * Lấy danh sách các đơn hàng có thể hủy (dành cho Autocomplete / UI)
 * @param {import('discord.js').Client} [client]
 * @returns {Array<Object>}
 */
function listCancelableOrders(client) {
  const result = new Map();

  // 1. Đơn đang chờ thanh toán QR (in-memory)
  const discordClient = client || global.discordClient;
  if (discordClient && discordClient.pendingOrders) {
    for (const [, pending] of discordClient.pendingOrders.entries()) {
      const id = pending.orderId || pending.id;
      if (id) {
        result.set(id.toUpperCase(), {
          orderId: id,
          id,
          userId: pending.userId,
          userTag: pending.userTag,
          ign: pending.ign,
          amount: pending.amount,
          gameMoney: pending.amount,
          amountVnd: pending.totalPrice,
          paymentMethod: pending.paymentMethod || 'Ngân Hàng / VietQR',
          status: 'PENDING_PAYMENT',
          createdAt: pending.createdAt,
        });
      }
    }
  }

  // 2. Đơn đang chờ retry trong pending_retries.json
  const retries = readPendingRetries();
  for (const r of retries) {
    const id = r.orderId || r.id;
    if (id && !result.has(id.toUpperCase())) {
      result.set(id.toUpperCase(), {
        orderId: id,
        id,
        userId: r.userId,
        userTag: r.userTag,
        ign: r.ign,
        amount: r.gameMoney,
        gameMoney: r.gameMoney,
        amountVnd: r.amountVnd,
        paymentMethod: r.paymentMethod || 'Không rõ',
        status: r.status === 'failed_needs_admin' ? 'FAILED_NEEDS_ADMIN' : 'WAITING_RETRY',
        createdAt: r.createdAt,
      });
    }
  }

  // 3. Đơn trong orders.json có trạng thái chờ (PENDING_PAYMENT, WAITING_RETRY, FAILED_NEEDS_ADMIN)
  const orders = readOrders();
  for (const [k, ord] of Object.entries(orders)) {
    const id = ord.orderId || ord.id || k;
    const canCancel =
      ord.status === 'PENDING_PAYMENT' ||
      ord.status === 'WAITING_RETRY' ||
      ord.status === 'FAILED_NEEDS_ADMIN' ||
      ord.status === 'PROCESSING';

    if (canCancel && !result.has(id.toUpperCase())) {
      result.set(id.toUpperCase(), {
        orderId: id,
        id,
        userId: ord.userId,
        userTag: ord.userTag,
        ign: ord.ign,
        amount: ord.amount || ord.gameMoney,
        gameMoney: ord.gameMoney || ord.amount,
        amountVnd: ord.amountVnd || ord.totalPrice,
        paymentMethod: ord.paymentMethod || 'Không rõ',
        status: ord.status,
        createdAt: ord.createdAt,
      });
    }
  }

  return Array.from(result.values());
}

/**
 * Hủy một đơn hàng theo lệnh của Admin (/huydon)
 * @param {Object} params
 * @param {string} params.orderId - Mã đơn hàng cần hủy
 * @param {string} params.adminId - Discord ID của Admin hủy
 * @param {string} params.adminTag - Discord Tag của Admin hủy
 * @param {string} [params.reason] - Lý do hủy
 * @param {boolean} [params.refund=true] - Có hoàn tiền (nếu đơn đã trừ tiền/đã thanh toán)
 * @param {import('discord.js').Client} [params.client] - Discord client
 * @returns {Promise<{ success: boolean, order?: Object, refundInfo?: Object, error?: string }>}
 */
async function cancelOrder({ orderId, adminId, adminTag, reason = '', refund = true, client }) {
  if (!orderId) {
    return { success: false, error: 'Mã đơn hàng không được để trống!' };
  }

  const discordClient = client || global.discordClient;
  const cleanId = String(orderId).trim();
  const order = getOrder(cleanId, discordClient);

  if (!order) {
    return {
      success: false,
      error: `Không tìm thấy đơn hàng nào với mã: \`${cleanId}\`! Vui lòng kiểm tra lại mã đơn.`,
    };
  }

  const effectiveId = order.orderId || order.id || cleanId;

  // Kiểm tra nếu đơn đã bị hủy trước đó
  if (order.status === 'CANCELLED') {
    const cancelTime = order.cancelledAt
      ? `<t:${Math.floor(new Date(order.cancelledAt).getTime() / 1000)}:F>`
      : 'trước đó';
    return {
      success: false,
      error: `Đơn hàng **\`${effectiveId}\`** đã bị hủy từ ${cancelTime}! Lý do: \`${order.cancelReason || 'Không có'}\``,
    };
  }

  // Kiểm tra nếu đơn đã hoàn thành (tiền game đã gửi vào Minecraft)
  if (order.status === 'COMPLETED') {
    return {
      success: false,
      error: `Đơn hàng **\`${effectiveId}\`** đã **HOÀN THÀNH** (tiền game đã được chuyển tới IGN \`${order.ign}\`). Hệ thống không hỗ trợ hủy đơn đã chuyển tiền game thành công!`,
    };
  }

  const cleanReason = reason && reason.trim() ? reason.trim() : 'Admin đã hủy đơn hàng';
  const refundInfo = {
    needed: false,
    refunded: false,
    amount: 0,
    type: 'NONE',
    message: '',
    newBalance: null,
  };

  // ── 1. NẾU ĐƠN ĐANG CHỜ QUÉT MÃ QR (PENDING_PAYMENT / client.pendingOrders) ──
  let wasInPendingOrders = false;
  if (discordClient && discordClient.pendingOrders) {
    // Tìm kiếm trong pendingOrders theo userId hoặc orderId
    for (const [uid, pending] of discordClient.pendingOrders.entries()) {
      if (
        (pending.orderId && pending.orderId.toUpperCase() === effectiveId.toUpperCase()) ||
        uid === order.userId
      ) {
        wasInPendingOrders = true;
        discordClient.pendingOrders.delete(uid);

        // Cập nhật hoặc xóa tin nhắn QR nếu còn tương tác
        if (pending.interaction) {
          try {
            await pending.interaction.editReply({
              content: `❌ **Đơn hàng \`${effectiveId}\` đã bị Admin hủy.**\n⚠️ Lý do: \`${cleanReason}\``,
              embeds: [],
              files: [],
              components: [],
            }).catch(() => {});
          } catch (_) {}
        }
        break;
      }
    }
  }

  // ── 2. NẾU ĐƠN ĐANG TRONG HÀNG ĐỢI RETRY (pending_retries.json) ──
  const removedFromRetry = resolvePendingRetry(effectiveId) || resolvePendingRetry(order.ign);

  // ── 3. XỬ LÝ HOÀN TIỀN (REFUND) ──
  const isPaidOrder = !!removedFromRetry || order.status === 'WAITING_RETRY' || order.status === 'FAILED_NEEDS_ADMIN';
  const isBalancePayment =
    /s[oố]\s*d[uư]|card|th[eẻ]/i.test(order.paymentMethod || '') ||
    order.paymentMethod === 'Số Dư Thẻ Cào';

  const amountToRefund = Math.floor(Number(order.amountVnd || order.totalPrice || 0));

  if (isPaidOrder && amountToRefund > 0 && refund) {
    refundInfo.needed = true;
    refundInfo.amount = amountToRefund;

    if (isBalancePayment) {
      // Hoàn lại tiền vào số dư cá nhân của thành viên
      const refundResult = await addBalance(
        order.userId,
        amountToRefund,
        'ORDER_CANCELLED_REFUND',
        {
          orderId: effectiveId,
          ign: order.ign,
          reason: cleanReason,
          cancelledBy: adminId,
        }
      );

      if (refundResult.success) {
        refundInfo.refunded = true;
        refundInfo.type = 'BALANCE_REFUNDED';
        refundInfo.newBalance = refundResult.newBalance;
        refundInfo.message = `Đã hoàn lại **${formatNumber(amountToRefund)} VNĐ** vào số dư tài khoản của thành viên (Số dư mới: **${formatNumber(refundResult.newBalance)} VNĐ**).`;
      } else {
        refundInfo.refunded = false;
        refundInfo.type = 'BALANCE_FAILED';
        refundInfo.message = `Lỗi hoàn số dư: ${refundResult.error}`;
      }
    } else {
      // Thanh toán qua ngân hàng / VietQR
      refundInfo.refunded = false;
      refundInfo.type = 'MANUAL_BANK_REFUND';
      refundInfo.message = `Khách hàng đã chuyển khoản **${formatNumber(amountToRefund)} VNĐ** qua Ngân hàng. Admin vui lòng kiểm tra và chuyển khoản hoàn tiền thủ công cho khách!`;
    }
  } else if (!isPaidOrder) {
    refundInfo.needed = false;
    refundInfo.message = 'Đơn hàng chưa thanh toán tiền (Không cần hoàn tiền).';
  } else if (!refund) {
    refundInfo.needed = false;
    refundInfo.message = 'Admin đã chọn không hoàn tiền cho đơn này.';
  }

  // ── 4. CẬP NHẬT TRẠNG THÁI TRONG DATA/ORDERS.JSON ──
  const updatedOrder = saveOrder({
    ...order,
    orderId: effectiveId,
    id: effectiveId,
    status: 'CANCELLED',
    cancelledAt: new Date().toISOString(),
    cancelledBy: {
      id: String(adminId),
      tag: String(adminTag),
    },
    cancelReason: cleanReason,
    refundInfo,
  });

  return {
    success: true,
    order: updatedOrder,
    refundInfo,
  };
}

module.exports = {
  generateOrderId,
  readOrders,
  writeOrders,
  saveOrder,
  updateOrderStatus,
  getOrder,
  listCancelableOrders,
  cancelOrder,
};
