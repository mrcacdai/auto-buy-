/**
 * utils/parser.js
 * ───────────────
 * Các hàm tiện ích để xử lý số tiền có hậu tố k / m / b.
 *
 * Ví dụ:
 *   parseAmount("100m")   → 100.000.000
 *   parseAmount("2.5b")   → 2.500.000.000
 *   parseAmount("500k")   → 500.000
 *   parseAmount("123456") → 123.456
 */

// Bảng quy đổi hậu tố
const SUFFIX_MAP = {
  k: 1_000,          // ngàn
  m: 1_000_000,      // triệu
  b: 1_000_000_000,  // tỷ
};

/**
 * Chuyển đổi chuỗi số tiền thân thiện thành số nguyên.
 * Chấp nhận: "100m", "2.5b", "500k", "123456", "1,000,000"
 * Trả về: Number (số nguyên) hoặc null nếu không hợp lệ.
 */
function parseAmount(input) {
  if (!input || typeof input !== 'string') return null;

  // Xóa khoảng trắng và chuyển thành chữ thường
  let str = input.trim().toLowerCase();

  // Xóa dấu phẩy (ví dụ: "1,000,000" → "1000000")
  str = str.replace(/,/g, '');

  // Regex: số (nguyên hoặc thập phân) + hậu tố tùy chọn (k, m, b)
  // Mẫu: ^(\d+\.?\d*)\s*(k|m|b)?$
  const match = str.match(/^(\d+\.?\d*)\s*(k|m|b)?$/);
  if (!match) return null;

  const num = parseFloat(match[1]);
  const suffix = match[2];

  if (isNaN(num) || num <= 0) return null;

  const multiplier = suffix ? SUFFIX_MAP[suffix] : 1;
  return Math.floor(num * multiplier);
}

/**
 * Định dạng số thành chuỗi có dấu phẩy ngăn cách hàng nghìn.
 * Ví dụ: 100000000 → "100,000,000"
 */
function formatNumber(n) {
  return Number(n).toLocaleString('en-US');
}

/**
 * Tính tổng tiền người mua phải trả.
 * @param {number} amount    - Số tiền in-game đã parse
 * @param {number} baseAmount - Ví dụ: 1.000.000 (1m)
 * @param {number} basePrice  - Ví dụ: 1000 (VND)
 * @returns {number} tổng tiền phải trả
 */
function calculatePrice(amount, baseAmount, basePrice) {
  return Math.ceil((amount / baseAmount) * basePrice);
}

/**
 * Định dạng số thành chuỗi thu gọn có hậu tố k / m / b.
 * Ví dụ:
 *   1_000_000_000 → "1b"
 *   1_000_000     → "1m"
 *   1_000         → "1k"
 *   1_500_000     → "1.5m"
 */
function formatStock(n) {
  const num = Number(n);
  if (isNaN(num) || num === 0) return '0';
  if (num < 0) return '-' + formatStock(-num);

  if (num >= 1_000_000_000) {
    const val = num / 1_000_000_000;
    return `${parseFloat(val.toFixed(2))}b`;
  }
  if (num >= 1_000_000) {
    const val = num / 1_000_000;
    return `${parseFloat(val.toFixed(2))}m`;
  }
  if (num >= 1_000) {
    const val = num / 1_000;
    return `${parseFloat(val.toFixed(2))}k`;
  }
  return num.toLocaleString('en-US');
}

module.exports = { parseAmount, formatNumber, calculatePrice, formatStock };

