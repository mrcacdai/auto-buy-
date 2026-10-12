/**
 * web/public/script.js
 * ────────────────────
 * Client-side JavaScript for the Admin Panel.
 *
 * • Connects to Socket.io for real-time logs & config updates
 * • Handles form submissions (price + stock updates via API)
 * • Detects subsystem status from log messages
 */

// ── Socket.io connection ──
const socket = io();

// ── DOM elements ──
const $console = document.getElementById('console');
const $clearBtn = document.getElementById('clearConsole');
const $priceForm = document.getElementById('priceForm');
const $stockForm = document.getElementById('stockForm');
const $baseAmount = document.getElementById('baseAmount');
const $basePrice = document.getElementById('basePrice');
const $currency = document.getElementById('currency');
const $stockInput = document.getElementById('stockInput');
const $stockDisplay = document.getElementById('stockDisplay');
const $pricePreview = document.getElementById('pricePreview');
const $dotWeb = document.getElementById('pillWeb').querySelector('.pill-dot');
const $dotDiscord = document.getElementById('pillDiscord').querySelector('.pill-dot');
const $dotMinecraft = document.getElementById('pillMC').querySelector('.pill-dot');
const $accountForm = document.getElementById('accountForm');
const $accountInput = document.getElementById('accountInput');
const $accountList = document.getElementById('accountList');
const $currentAccount = document.getElementById('currentAccount');

// ── Format number with commas ──
function fmt(n) {
  return Number(n).toLocaleString('en-US');
}

// ── Format stock with k / m / b ──
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

// ══════════════════════════════════════════
//  LIVE CONSOLE
// ══════════════════════════════════════════

/** Determine CSS class from log line content */
function getLogClass(line) {
  if (line.includes('[Discord]'))   return 'discord';
  if (line.includes('[Minecraft]')) return 'minecraft';
  if (line.includes('[Webhook]'))   return 'webhook';
  if (line.includes('[WebPanel]'))  return 'webpanel';
  if (line.includes('❌') || line.includes('Error')) return 'error';
  return '';
}

/** Append a log line to the console */
function appendLog(line) {
  // Remove the placeholder "Waiting for logs …" if present
  const placeholder = $console.querySelector('.system');
  if (placeholder) placeholder.remove();

  const p = document.createElement('p');
  p.className = `console-line ${getLogClass(line)}`;
  p.textContent = line;
  $console.appendChild(p);

  // Auto-scroll to bottom
  $console.scrollTop = $console.scrollHeight;

  // ── Update status dots based on log content ──
  if (line.includes('[Discord]') && line.includes('Bot online')) {
    $dotDiscord.className = 'status-dot online';
  }
  if (line.includes('[Minecraft]') && line.includes('Đã vào server thành công')) {
    $dotMinecraft.className = 'status-dot online';
    const match = line.match(/với tên:\s*(.+)$/);
    if (match && match[1]) {
      $currentAccount.textContent = match[1].trim();
    }
  }
  if (line.includes('[Minecraft]') && (line.includes('Disconnected') || line.includes('Kicked') || line.includes('Mất kết nối'))) {
    $dotMinecraft.className = 'status-dot offline';
    $currentAccount.textContent = 'Chưa kết nối';
  }
}

socket.on('log', appendLog);

// Web panel is always online if we're connected
$dotWeb.className = 'status-dot online';
socket.on('disconnect', () => {
  $dotWeb.className = 'status-dot offline';
});
socket.on('connect', () => {
  $dotWeb.className = 'status-dot online';
});

// Clear console
$clearBtn.addEventListener('click', () => {
  $console.innerHTML = '<p class="console-line system">Console cleared.</p>';
});

// ══════════════════════════════════════════
//  CONFIG UPDATES
// ══════════════════════════════════════════

/** Update the UI with the latest config */
function applyConfig(config) {
  $baseAmount.value = config.price?.baseAmount || 0;
  $basePrice.value = config.price?.basePrice || 0;
  $currency.value = config.price?.currency || 'VND';
  $stockDisplay.textContent = formatStock(config.stock || 0);
  $stockDisplay.title = `${fmt(config.stock || 0)} tiền game`;

  const $stockSubtitle = document.querySelector('.stock-subtitle');
  if ($stockSubtitle) {
    $stockSubtitle.textContent = `${fmt(config.stock || 0)} tiền game có sẵn`;
  }

  const $dashStock = document.getElementById('dashStock');
  if ($dashStock) {
    $dashStock.textContent = formatStock(config.stock || 0);
    $dashStock.title = `${fmt(config.stock || 0)} tiền game`;
  }
  const $dashPrice = document.getElementById('dashPrice');
  if ($dashPrice) {
    $dashPrice.textContent = `${fmt(config.price?.basePrice || 0)} ${config.price?.currency || 'VND'}`;
  }
  const $dashCurrency = document.getElementById('dashCurrency');
  if ($dashCurrency) {
    $dashCurrency.textContent = config.price?.currency || 'VND';
  }
  
  // Render accounts
  $accountList.innerHTML = '';
  const accounts = config.accounts || [];
  if (accounts.length === 0) {
    $accountList.innerHTML = '<li style="color: rgba(255,255,255,0.5); font-style: italic;">Chưa có tài khoản nào.</li>';
  } else {
    accounts.forEach(acc => {
      const li = document.createElement('li');
      li.style.display = 'flex';
      li.style.justifyContent = 'space-between';
      li.style.alignItems = 'center';
      li.style.padding = '0.5rem';
      li.style.background = 'rgba(255,255,255,0.05)';
      li.style.borderRadius = '4px';
      li.style.marginBottom = '0.5rem';
      
      const emailSpan = document.createElement('span');
      emailSpan.textContent = acc;
      
      const delBtn = document.createElement('button');
      delBtn.className = 'btn btn-ghost btn-sm';
      delBtn.textContent = '❌';
      delBtn.onclick = () => deleteAccount(acc);
      
      li.appendChild(emailSpan);
      li.appendChild(delBtn);
      $accountList.appendChild(li);
    });
  }
  
  updatePreview();
}

/** Update the price preview text */
function updatePreview() {
  const a = Number($baseAmount.value) || 0;
  const p = Number($basePrice.value) || 0;
  const c = $currency.value || '—';
  $pricePreview.textContent = `${fmt(a)} money = ${fmt(p)} ${c}`;
}

// Listen for live config changes (from other tabs or webhook deductions)
socket.on('configUpdate', applyConfig);

// Recalculate preview on input change
$baseAmount.addEventListener('input', updatePreview);
$basePrice.addEventListener('input', updatePreview);
$currency.addEventListener('input', updatePreview);

// ── Toast helper ──
function showToast(message) {
  let toast = document.querySelector('.toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2500);
}

// ── Price form submit ──
$priceForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    baseAmount: Number($baseAmount.value),
    basePrice: Number($basePrice.value),
    currency: $currency.value,
  };
  const res = await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.ok) showToast('✅ Price updated!');
  else showToast('❌ Failed to update price');
});

// ── Stock form submit ──
$stockForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const val = $stockInput.value.trim();
  if (!val) return;
  const body = { stock: val };
  const res = await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.ok) {
    showToast('✅ Stock updated!');
    $stockInput.value = '';
  } else {
    showToast('❌ Failed to update stock');
  }
});

// ── Account management ──
$accountForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const account = $accountInput.value.trim();
  if (!account) return;
  
  const res = await fetch('/api/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account }),
  });
  
  if (res.ok) {
    showToast('✅ Đã thêm tài khoản!');
    $accountInput.value = '';
  } else {
    showToast('❌ Lỗi khi thêm tài khoản');
  }
});

async function deleteAccount(account) {
  if (!confirm(`Bạn có chắc muốn xóa tài khoản ${account}?`)) return;
  const res = await fetch('/api/accounts', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account }),
  });
  
  if (res.ok) {
    showToast('✅ Đã xóa tài khoản!');
  } else {
    showToast('❌ Lỗi khi xóa tài khoản');
  }
}

const $reconnectBtn = document.getElementById('reconnectBtn');
if ($reconnectBtn) {
  $reconnectBtn.addEventListener('click', async () => {
    if (!confirm('Bạn có muốn ngắt kết nối bot hiện tại và đăng nhập bằng tài khoản (hoặc thêm) đầu tiên trong danh sách không?')) return;
    const res = await fetch('/api/reconnect', { method: 'POST' });
    if (res.ok) {
      showToast('🔄 Đang khởi động lại bot...');
    } else {
      showToast('❌ Không thể khởi động lại bot');
    }
  });
}

// ── Chat / Command Submit ──
const $chatForm = document.getElementById('chatForm');
const $chatInput = document.getElementById('chatInput');
if ($chatForm && $chatInput) {
  $chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const message = $chatInput.value.trim();
    if (!message) return;
    
    $chatInput.value = ''; // clear immediately
    
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message })
    });
    
    if (!res.ok) {
      const data = await res.json();
      showToast(`❌ Lỗi: ${data.error || 'Không thể gửi lệnh'}`);
    }
  });
}

// ── Fetch initial config on page load ──
(async () => {
  try {
    const res = await fetch('/api/config');
    const config = await res.json();
    applyConfig(config);
  } catch (err) {
    console.error('Failed to load config:', err);
  }
})();

// ── Sidebar Navigation ──
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', (e) => {
    e.preventDefault();
    const sectionId = item.getAttribute('data-section');
    if (!sectionId) return;

    // Update nav items
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    item.classList.add('active');

    // Update sections
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    document.getElementById(`section-${sectionId}`).classList.add('active');
    
    // Update topbar title
    const titleText = item.textContent.trim();
    document.getElementById('pageTitle').textContent = `${item.querySelector('.nav-icon').textContent} ${titleText}`;
  });
});
