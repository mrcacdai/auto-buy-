<div align="center">

# 🛒 Auto-Buy System (Hệ Thống Nạp & Mua Hàng Tự Động)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![PHP](https://img.shields.io/badge/PHP-Backend-777BB4?style=for-the-badge&logo=php&logoColor=white)](https://www.php.net/)
[![PM2](https://img.shields.io/badge/PM2-Process_Manager-2B037A?style=for-the-badge&logo=pm2&logoColor=white)](https://pm2.keymetrics.io/)

**🌐 Ngôn ngữ / Language:**  
[🇻🇳 Tiếng Việt](#-tiếng-việt) | [🇺🇸 English](#-english)

</div>

---

## 🇻🇳 Tiếng Việt

### 📖 Giới thiệu
**Auto-Buy** là hệ thống tự động hóa giao dịch, xử lý thanh toán ngân hàng và trả vật phẩm/dịch vụ tự động tích hợp đa nền tảng (**Discord Bot**, **Web Dashboard** và **Minecraft Server**). Hệ thống giúp tối ưu hóa quy trình nạp tiền, kiểm tra biến động số dư và giao hàng theo thời gian thực mà không cần sự can thiệp thủ công của quản trị viên.

### ✨ Tính năng nổi bật
* 🤖 **Tích hợp Bot Tự Động (`bot/`):** Tương tác trực tiếp với người dùng, tạo đơn hàng, gửi mã QR thanh toán và thông báo trạng thái giao dịch tức thì.
* 🎮 **Kết nối Máy chủ Minecraft (`minecraft/`):** Tự động thực thi lệnh trong game (RCON / Plugin / Bot client) để trao vật phẩm, rank hoặc điểm nạp ngay khi thanh toán thành công.
* 🏦 **Xử lý Giao dịch Ngân hàng (`bank.php`):** Kiểm tra lịch sử giao dịch, đối soát nội dung chuyển khoản và xác nhận đơn hàng tự động 24/7.
* 🌐 **Giao diện Web (`web/`):** Cung cấp trang quản trị hoặc cổng thanh toán trực tuyến trực quan cho người dùng.
* ⚙️ **Quản lý Tiến trình Chuyên nghiệp (`ecosystem.config.js`):** Hỗ trợ chạy nền ổn định, tự động khởi động lại khi gặp sự cố thông qua **PM2**.

### 📂 Cấu trúc thư mục
```text
auto-buy-/
├── 📁 assets/              # Tài nguyên tĩnh (hình ảnh, banner, icon...)
├── 📁 bot/                 # Mã nguồn xử lý Bot (Discord/Telegram...)
├── 📁 minecraft/           # Module kết nối & gửi lệnh tới server Minecraft
├── 📁 utils/               # Các hàm tiện ích dùng chung (format, logger, API...)
├── 📁 web/                 # Giao diện & xử lý phía Web
├── 📄 .env.example         # File mẫu cấu hình biến môi trường
├── 📄 bank.php             # Script kiểm tra & xử lý API ngân hàng
├── 📄 config.json          # File cấu hình chung của hệ thống
├── 📄 ecosystem.config.js  # Cấu hình chạy tiến trình với PM2
├── 📄 index.js             # Điểm khởi chạy chính của ứng dụng Node.js
├── 📄 package.json         # Danh sách thư viện & dependencies
└── 📄 LICENSE              # Giấy phép mã nguồn mở MIT
