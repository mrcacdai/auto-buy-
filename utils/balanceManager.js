/**
 * utils/balanceManager.js
 * ────────────────────────
 * Quản lý số dư cá nhân của thành viên an toàn và bảo mật:
 *   • Chống Race Condition (User-level mutex lock)
 *   • Ghi file nguyên tử (Atomic write to disk)
 *   • Kiểm tra chặt chẽ số âm, NaN, số thực, chống member buff tiền
 *   • Ghi log lịch sử biến động số dư (Audit trail)
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const BALANCES_FILE = path.join(DATA_DIR, 'balances.json');
const HISTORY_FILE = path.join(DATA_DIR, 'balance_history.json');

// Khóa chống Race Condition theo userId
const userLocks = new Map();

// Đảm bảo thư mục data tồn tại
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * Đọc dữ liệu số dư từ file
 * @returns {Record<string, number>} Map userId -> số dư (VNĐ)
 */
function readBalances() {
  try {
    if (!fs.existsSync(BALANCES_FILE)) {
      return {};
    }
    const raw = fs.readFileSync(BALANCES_FILE, 'utf8');
    return JSON.parse(raw) || {};
  } catch (err) {
    console.error('[BalanceManager] Lỗi đọc balances.json:', err.message);
    return {};
  }
}

/**
 * Ghi dữ liệu số dư nguyên tử (Atomic write)
 */
function writeBalances(balances) {
  const tmpFile = `${BALANCES_FILE}.tmp.${Date.now()}`;
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(balances, null, 2), 'utf8');
    fs.renameSync(tmpFile, BALANCES_FILE);
    return true;
  } catch (err) {
    console.error('[BalanceManager] Lỗi ghi balances.json:', err.message);
    if (fs.existsSync(tmpFile)) {
      try { fs.unlinkSync(tmpFile); } catch (_) {}
    }
    return false;
  }
}

/**
 * Ghi log biến động số dư
 */
function logHistory(entry) {
  try {
    let history = [];
    if (fs.existsSync(HISTORY_FILE)) {
      try {
        history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')) || [];
      } catch (_) {
        history = [];
      }
    }
    history.push({
      id: `TX_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
      timestamp: new Date().toISOString(),
      ...entry,
    });
    // Giữ tối đa 5000 giao dịch gần nhất
    if (history.length > 5000) {
      history = history.slice(-5000);
    }
    const tmp = `${HISTORY_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(history, null, 2), 'utf8');
    fs.renameSync(tmp, HISTORY_FILE);
  } catch (err) {
    console.error('[BalanceManager] Lỗi ghi balance_history.json:', err.message);
  }
}

/**
 * Cơ chế Lock tránh nhiều thao tác song song cho cùng 1 user (chống double-spend)
 */
async function acquireLock(userId) {
  while (userLocks.has(userId)) {
    await userLocks.get(userId);
  }
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  userLocks.set(userId, promise);
  return () => {
    userLocks.delete(userId);
    release();
  };
}

/**
 * Lấy số dư hiện tại của người dùng (VNĐ)
 * @param {string} userId
 * @returns {number}
 */
function getBalance(userId) {
  if (!userId) return 0;
  const balances = readBalances();
  const val = Number(balances[userId]);
  return !isNaN(val) && val > 0 ? Math.floor(val) : 0;
}

/**
 * Cộng số dư an toàn
 * @param {string} userId - Discord User ID
 * @param {number} amount - Số tiền VNĐ cần cộng (phải > 0)
 * @param {string} reason - Lý do (CARD_DEPOSIT, ADMIN_REFUND...)
 * @param {Object} meta - Thông tin bổ sung
 * @returns {Promise<{ success: boolean, newBalance: number, oldBalance: number, error?: string }>}
 */
async function addBalance(userId, amount, reason = 'CARD_DEPOSIT', meta = {}) {
  const numericAmount = Math.floor(Number(amount));
  if (isNaN(numericAmount) || numericAmount <= 0 || !Number.isFinite(numericAmount)) {
    return { success: false, error: 'Số tiền nạp không hợp lệ (phải là số nguyên > 0)' };
  }

  const release = await acquireLock(userId);
  try {
    const balances = readBalances();
    const oldBalance = balances[userId] ? Math.floor(Number(balances[userId])) : 0;
    const newBalance = oldBalance + numericAmount;

    balances[userId] = newBalance;
    const ok = writeBalances(balances);
    if (!ok) {
      return { success: false, error: 'Lỗi ghi cơ sở dữ liệu số dư' };
    }

    logHistory({
      userId,
      type: 'ADD',
      amount: numericAmount,
      oldBalance,
      newBalance,
      reason,
      meta,
    });

    return { success: true, oldBalance, newBalance };
  } finally {
    release();
  }
}

/**
 * Trừ số dư an toàn (Chống âm tiền, chống buff tiền, chống double spend)
 * @param {string} userId - Discord User ID
 * @param {number} amount - Số tiền VNĐ cần trừ (phải > 0)
 * @param {string} reason - Lý do (BUY_MONEY, ADMIN_DEDUCT...)
 * @param {Object} meta - Thông tin bổ sung
 * @returns {Promise<{ success: boolean, newBalance: number, oldBalance: number, error?: string }>}
 */
async function deductBalance(userId, amount, reason = 'BUY_MONEY', meta = {}) {
  const numericAmount = Math.floor(Number(amount));
  if (isNaN(numericAmount) || numericAmount <= 0 || !Number.isFinite(numericAmount)) {
    return { success: false, error: 'Số tiền trừ không hợp lệ (phải là số nguyên > 0)' };
  }

  const release = await acquireLock(userId);
  try {
    const balances = readBalances();
    const oldBalance = balances[userId] ? Math.floor(Number(balances[userId])) : 0;

    // Kiểm tra bảo mật: Không được phép trừ vượt quá số dư hiện có
    if (oldBalance < numericAmount) {
      return {
        success: false,
        oldBalance,
        error: `Số dư không đủ! Hiện có ${oldBalance.toLocaleString('vi-VN')} VNĐ, cần ${numericAmount.toLocaleString('vi-VN')} VNĐ.`,
      };
    }

    const newBalance = oldBalance - numericAmount;
    if (newBalance < 0) {
      return { success: false, oldBalance, error: 'Phát hiện lỗi số dư âm. Giao dịch bị hủy.' };
    }

    balances[userId] = newBalance;
    const ok = writeBalances(balances);
    if (!ok) {
      return { success: false, error: 'Lỗi ghi cơ sở dữ liệu số dư' };
    }

    logHistory({
      userId,
      type: 'DEDUCT',
      amount: numericAmount,
      oldBalance,
      newBalance,
      reason,
      meta,
    });

    return { success: true, oldBalance, newBalance };
  } finally {
    release();
  }
}

module.exports = {
  getBalance,
  addBalance,
  deductBalance,
  acquireLock,
};
