const socket = io();
let prices = {};
let allWallets = [];
let allLoans = [];
let dealCount = 0;
const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'];

// ── HELPERS ───────────────────────────────────────────────────────────────────
async function api(method, path, body) {
  const r = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  return r.json();
}

function fmt(n, dec = 2) {
  return Number(n || 0).toLocaleString('ru', {
    minimumFractionDigits: dec,
    maximumFractionDigits: dec
  });
}

function fmtTime(ts) {
  const t = new Date(ts);
  return t.getHours().toString().padStart(2, '0') + ':' +
         t.getMinutes().toString().padStart(2, '0');
}

function coinDec(c) {
  return (c === 'DOGE' || c === 'XRP') ? 4 : 5;
}

// ── ТАБЛИЦА ИГРОКОВ ─────────────────────────────────────────────────────────
function renderPlayers() {
  const tbody = document.getElementById('adminPlayersBody');
  if (!tbody) return;

  const players = allWallets.filter(w => w.username !== 'WARDEN');

  if (!players.length) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:var(--mu);padding:20px">
      Данных пока нет. Игроки ещё не регистрировались.
    </td></tr>`;
    return;
  }

  const sorted = [...players].sort((a, b) => {
    const totalA = a.usd + COINS.reduce((s, c) => s + (a[c] || 0) * (prices[c] || 0), 0);
    const totalB = b.usd + COINS.reduce((s, c) => s + (b[c] || 0) * (prices[c] || 0), 0);
    return totalB - totalA;
  });

  tbody.innerHTML = sorted.map(w => {
    const debt = allLoans
      .filter(l => l.username === w.username)
      .reduce((s, l) => s + l.due, 0);
    const portVal = COINS.reduce((s, c) => s + (w[c] || 0) * (prices[c] || 0), 0);

    return `<tr>
      <td><strong>${w.username}</strong></td>
      <td class="up">$${fmt(w.usd)}</td>
      <td class="${debt > 0 ? 'dn' : ''}">$${fmt(debt)}</td>
      ${COINS.map(c => `<td style="font-size:12px;color:var(--mu);font-variant-numeric:tabular-nums">
        ${(w[c] || 0) > 0 ? fmt(w[c], coinDec(c)) : '<span style="color:var(--fa)">—</span>'}
      </td>`).join('')}
      <td><span class="badge ${debt > 0 ? 'badge-warn' : 'badge-ok'}">
        ${debt > 0 ? 'Долг $' + fmt(debt) : 'ОК ✓'}
      </span></td>
    </tr>`;
  }).join('');
}

// ── ТАБЛИЦА КРЕДИТОВ ─────────────────────────────────────────────────────────
function renderLoans() {
  const tbody = document.getElementById('adminLoansBody');
  if (!tbody) return;

  const el = document.getElementById('loanCount');
  if (el) el.textContent = allLoans.length;

  if (!allLoans.length) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--mu);padding:20px">
      Активных кредитов нет
    </td></tr>`;
    return;
  }

  tbody.innerHTML = allLoans.map(l => `
    <tr>
      <td><strong>${l.username}</strong></td>
      <td class="up">$${fmt(l.amount)}</td>
      <td class="dn">$${fmt(l.due)}</td>
      <td style="color:var(--mu);font-size:12px">${fmtTime(l.ts)}</td>
    </tr>
  `).join('');
}

// ── КОТИРОВКИ ──────────────────────────────────────────────────────────────────────
function renderPrices() {
  const tbody = document.getElementById('priceRows');
  if (!tbody) return;
  tbody.innerHTML = COINS.map(c => {
    const dec = (c === 'DOGE' || c === 'XRP') ? 4 : 2;
    return `<tr>
      <td><strong>${c}</strong></td>
      <td style="font-variant-numeric:tabular-nums">$${fmt(prices[c] || 0, dec)}</td>
      <td></td>
    </tr>`;
  }).join('');
}

// ── ЛЕНТА ────────────────────────────────────────────────────────────────────────────
function renderFeed(events) {
  const feed = document.getElementById('adminFeed');
  if (!feed) return;
  if (!events || !events.length) {
    feed.innerHTML = `<div style="color:var(--mu);text-align:center;padding:20px">Нет событий</div>`;
    return;
  }
  feed.innerHTML = events.map(e => `
    <div class="feed-item">
      <span>${e.text}</span>
      <span class="feed-time">${fmtTime(e.ts)}</span>
    </div>
  `).join('');
}

// ── SELECT ИГРОКОВ ДЛЯ УСТАНОВКИ БАЛАНСА ──────────────────────────────────────────
function fillPlayerSelect() {
  const sel = document.getElementById('cashUsername');
  if (!sel) return;
  const players = allWallets
    .filter(w => w.username !== 'WARDEN')
    .sort((a, b) => a.username.localeCompare(b.username));
  sel.innerHTML = players.length
    ? players.map(w =>
        `<option value="${w.username}">${w.username} (баланс: $${fmt(w.usd)})</option>`
      ).join('')
    : '<option disabled>Нет игроков</option>';
}

// ── ЗАГРУЗКА ВСЕХ ДАННЫХ ────────────────────────────────────────────────────────
async function loadAdminData() {
  const [adminData, stateData] = await Promise.all([
    api('GET', '/api/admin/players'),
    api('GET', '/api/state')
  ]);

  if (!adminData.error) {
    allWallets = adminData.wallets || [];
    allLoans   = adminData.loans   || [];
  }

  if (!stateData.error) {
    prices = stateData.prices || {};

    const trades = (stateData.events || []).filter(e =>
      e.text.includes('купил') || e.text.includes('продал')
    );
    dealCount = trades.length;
    const elDeal = document.getElementById('dealCount');
    if (elDeal) elDeal.textContent = dealCount;

    renderFeed(stateData.events || []);
  }

  renderPrices();
  renderPlayers();
  renderLoans();
  fillPlayerSelect();
}

// ── КНОПКИ ─────────────────────────────────────────────────────────────────────────────
document.getElementById('tickBtn').addEventListener('click', async () => {
  const btn = document.getElementById('tickBtn');
  btn.disabled = true;
  btn.textContent = '⏳ Обновление...';
  await api('POST', '/api/admin/tick');
  await loadAdminData();
  btn.disabled = false;
  btn.textContent = '🔄 Принудительно обновить цены';
});

document.getElementById('resetBtn').addEventListener('click', () => {
  if (confirm('Сброс рынка не реализован на сервере. Хотите сделать принудительный тик вместо?')) {
    document.getElementById('tickBtn').click();
  }
});

document.getElementById('setCashForm').addEventListener('submit', async e => {
  e.preventDefault();
  const username = document.getElementById('cashUsername').value;
  const usd = parseFloat(document.getElementById('cashAmount').value);
  if (!username || isNaN(usd)) return;
  const btn = e.submitter;
  btn.disabled = true;
  btn.textContent = '⏳...';
  await api('POST', '/api/admin/set-cash', { username, usd });
  await loadAdminData();
  btn.disabled = false;
  btn.textContent = 'Применить';
});

document.getElementById('adminLogoutBtn').addEventListener('click', async () => {
  await api('POST', '/auth/logout');
  window.location.href = '/';
});

// ── SOCKET ──────────────────────────────────────────────────────────────────────────────
let connectedSockets = 0;
socket.on('connect', () => {
  connectedSockets++;
  const el = document.getElementById('onlineCount');
  if (el) el.textContent = connectedSockets;
});
socket.on('disconnect', () => {
  connectedSockets = Math.max(0, connectedSockets - 1);
  const el = document.getElementById('onlineCount');
  if (el) el.textContent = connectedSockets;
});

socket.on('priceUpdate', p => {
  prices = p;
  renderPrices();
  renderPlayers(); // стоимость портфелей меняется
});

socket.on('newEvent', ev => {
  const feed = document.getElementById('adminFeed');
  if (feed) {
    feed.insertAdjacentHTML('afterbegin', `
      <div class="feed-item">
        <span>${ev.text}</span>
        <span class="feed-time">${fmtTime(ev.ts)}</span>
      </div>
    `);
    if (feed.children.length > 50) feed.lastChild.remove();
  }
  if (ev.text.includes('купил') || ev.text.includes('продал')) {
    dealCount++;
    const el = document.getElementById('dealCount');
    if (el) el.textContent = dealCount;
  }
  // Перезагрузить кошельки для актуальных балансов
  loadAdminData();
});

socket.on('walletUpdate', () => {
  loadAdminData();
});

// ── ИНИЦИАЛИЗАЦИЯ ───────────────────────────────────────────────────────────────────
api('GET', '/auth/me').then(res => {
  if (!res.username || res.role !== 'admin') {
    window.location.href = '/';
    return;
  }
  const el = document.getElementById('adminName');
  if (el) el.textContent = res.username;
  loadAdminData();
});
