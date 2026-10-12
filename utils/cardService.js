/**
 * utils/cardService.js
 * ────────────────────
 * Xử lý giao tiếp với API gạch thẻ cào (Card Partner API - trumthengon.com)
 *
 * Chữ ký mã hóa: md5(partner_key + code + serial)
 * Endpoint: POST /chargingws/v2
 */

const axios = require('axios');
const crypto = require('crypto');

function getCardConfig() {
  const domain = (process.env.CARD_DOMAIN || 'https://trumthengon.com').replace(/\/+$/, '');
  const partnerId = process.env.CARD_PARTNER_ID || '7393801035';
  const partnerKey = process.env.CARD_PARTNER_KEY || '29693886e58f702441c012a4eeb4a245';
  return { domain, partnerId, partnerKey };
}

/**
 * Tạo chữ ký md5(partner_key + code + serial)
 */
function createSignature(partnerKey, code, serial) {
  return crypto
    .createHash('md5')
    .update(`${partnerKey}${code}${serial}`)
    .digest('hex');
}

/**
 * Gửi thẻ cào lên hệ thống gạch thẻ
 * @param {Object} cardData
 * @param {string} cardData.telco - Nhà mạng: VIETTEL, MOBIFONE, VINAPHONE, ZING, GATE...
 * @param {string} cardData.code - Mã nạp (PIN)
 * @param {string} cardData.serial - Số serial thẻ
 * @param {number} cardData.amount - Mệnh giá khai báo
 * @param {string} cardData.requestId - Mã giao dịch duy nhất
 */
async function sendCard({ telco, code, serial, amount, requestId }) {
  const { domain, partnerId, partnerKey } = getCardConfig();
  const sign = createSignature(partnerKey, code, serial);

  const payload = new URLSearchParams();
  payload.append('telco', String(telco).toUpperCase());
  payload.append('code', String(code).trim());
  payload.append('serial', String(serial).trim());
  payload.append('amount', String(amount));
  payload.append('request_id', String(requestId));
  payload.append('partner_id', String(partnerId));
  payload.append('sign', sign);
  payload.append('command', 'charging');

  const apiUrl = `${domain}/chargingws/v2`;

  try {
    const res = await axios.post(apiUrl, payload, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
      timeout: 15000,
    });

    const data = res.data;
    return {
      success: true,
      data,
    };
  } catch (err) {
    const errorMsg = err.response?.data?.message || err.message;
    return {
      success: false,
      error: errorMsg,
      data: err.response?.data || null,
    };
  }
}

/**
 * Xác minh chữ ký callback gửi về từ hệ thống gạch thẻ
 */
function verifyCallbackSign(code, serial, callbackSign) {
  const { partnerKey } = getCardConfig();
  const expectedSign = createSignature(partnerKey, code, serial);
  return expectedSign.toLowerCase() === String(callbackSign).toLowerCase();
}

/**
 * Kiểm tra trạng thái thẻ theo request_id
 */
async function checkCard({ telco, code, serial, amount, requestId }) {
  const { domain, partnerId, partnerKey } = getCardConfig();
  const sign = createSignature(partnerKey, code, serial);

  const payload = new URLSearchParams();
  payload.append('telco', String(telco).toUpperCase());
  payload.append('code', String(code).trim());
  payload.append('serial', String(serial).trim());
  payload.append('amount', String(amount));
  payload.append('request_id', String(requestId));
  payload.append('partner_id', String(partnerId));
  payload.append('sign', sign);
  payload.append('command', 'check');

  const apiUrl = `${domain}/chargingws/v2`;

  try {
    const res = await axios.post(apiUrl, payload, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: 15000,
    });
    return { success: true, data: res.data };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Lấy mô tả trạng thái mã lỗi
 */
function getStatusDescription(status) {
  switch (Number(status)) {
    case 1:
      return 'Thẻ thành công đúng mệnh giá';
    case 2:
      return 'Thẻ thành công sai mệnh giá';
    case 3:
      return 'Thẻ lỗi / Sai mã thẻ hoặc serial';
    case 4:
      return 'Hệ thống nhà mạng đang bảo trì';
    case 99:
      return 'Thẻ đang chờ xử lý trên hệ thống (Pending)';
    case 100:
      return 'Gửi thẻ thất bại';
    default:
      return `Trạng thái: ${status}`;
  }
}

module.exports = {
  sendCard,
  checkCard,
  verifyCallbackSign,
  createSignature,
  getStatusDescription,
  getCardConfig,
};
