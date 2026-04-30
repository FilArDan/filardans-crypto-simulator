const socket = io();
let myUsername = '';
let prices = {};

async function api(method, path, body) {
  const r = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  return r.json();
}

function fmt(n, dec = 2) {
  return Number(n || 0).toLocaleString('ru', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function showApp(username) {
  myUsername = username;
  document.getElementById('playerName').textContent = username;
  document.getElementById('loginScreen').classList.add('hidden');
  document.getElementById('appScreen').classList.remove('hidden');
  initChart();
  loadState();
}

// ── РЕНДЕР ──────────────────────────────────────────────────────────────────────────
function renderTicker(p, prev) {
  prices = p;
  const el = document.getElementById('ticker');
  if (!el) return;
  el.innerHTML = Object.entries(p).map(([coin, price]) => {
    const dec = (coin === 'DOGE' || coin === 'XRP') ? 4 : 2;
    const dir = prev && prev[coin] != null
      ? (price > prev[coin] ? 'up' : price < prev[coin] ? 'dn' : '')
      : '';
    return `<div class="tick ${dir}"><div class="coin">${coin}</div><div class="price">$${fmt(price, dec)}</div></div>`;
  }).join('');
}

// Список монет в форме торговли — заполняется динамически с сервера
function renderTradeAssets(coins) {
  const sel = document.getElementById('tradeAsset');
  if (!sel || !coins || !coins.length) return;
  const prev = sel.value;
  sel.innerHTML = coins.map(c => `<option value="${c}">${c}</option>`).join('');
  if (coins.includes(prev)) sel.value = prev;
}

// Таблица лидерборда — сортировка по usd, баланс виден
function renderLeaderboard(players) {
  const tbody = document.getElementById('leaderBody');
  if (!tbody || !players) return;
  const sorted = [...players].sort((a, b) => b.usd - a.usd);
  const maxUsd = sorted[0] ? sorted[0].usd : 1;
  tbody.innerHTML = '';
  sorted.forEach((p, i) => {
    const isMine = p.username === myUsername;
    const rank = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : i + 1;
    const barW = Math.round(p.usd / maxUsd * 100);
    const tr = document.createElement('tr');
    if (isMine) tr.className = 'me';
    tr.innerHTML = `
      <td><span class="rank">${rank}</span></td>
      <td><span class="${isMine ? 'inv-name me' : 'inv-name'}">${p.username}</span></td>
      <td>$${fmt(p.usd)}</td>
      <td><span class="bar-wrap"><span class="bar-fill" style="width:${barW}%"></span></span></td>`;
    tbody.appendChild(tr);
  });
}

// Селект перевода — только имя (без баланса)
function renderTransferSelect(players) {
  const sc = document.getElementById('transferTarget');
  if (!sc || !players) return;
  const others = players.filter(p => p.username !== myUsername);
  sc.innerHTML = '';
  if (!others.length) {
    const o = document.createElement('option');
    o.disabled = true; o.textContent = 'Нет других игроков';
    sc.appendChild(o);
    return;
  }
  others
    .sort((a, b) => a.username.localeCompare(b.username))
    .forEach(p => {
      const o = document.createElement('option');
      o.value = p.username;
      o.textContent = p.username;
      sc.appendChild(o);
    });
}

function renderPortfolio(wallet) {
  const coins = Object.keys(prices).length ? Object.keys(prices) : ['BTC','ETH','SOL','XRP','DOGE'];
  const body = document.getElementById('portfolioBody');
  if (!body) return;
  const rows = coins.filter(c => (wallet[c] || 0) > 0).map(c => {
    const val = (wallet[c] || 0) * (prices[c] || 0);
    const dec = (c === 'DOGE' || c === 'XRP') ? 4 : 2;
    return `<tr><td>${c}</td><td>${fmt(wallet[c], 5)}</td><td>$${fmt(prices[c] || 0, dec)}</td><td>$${fmt(val)}</td></tr>`;
  });
  body.innerHTML = rows.length
    ? rows.join('')
    : '<tr><td colspan="4" style="color:var(--mu);text-align:center;padding:16px">Нет активов</td></tr>';
  const el = document.getElementById('sCash');
  if (el) el.textContent = '$' + fmt(wallet.usd);
}

function renderFeed(events) {
  const feed = document.getElementById('activityFeed');
  if (!feed) return;
  feed.innerHTML = [...events].reverse().map(e => {
    const t = new Date(e.ts);
    const time = t.getHours().toString().padStart(2,'0') + ':' + t.getMinutes().toString().padStart(2,'0');
    return `<div class="feed-item"><span>${e.text}</span><span class="feed-time">${time}</span></div>`;
  }).join('');
}

// ── ЗАГРУЗКА СОСТОЯНИЯ ───────────────────────────────────────────────────────────────
async function loadState() {
  const data = await api('GET', '/api/state');
  if (data.error) return;

  renderTicker(data.prices);
  renderPortfolio(data.wallet);
  renderFeed(data.events || []);
  renderLeaderboard(data.players);
  renderTransferSelect(data.players);
  addPricePoint(data.prices);

  // Обновить список монет в форме торговли
  if (data.coins) renderTradeAssets(data.coins);

  const coinsVal = Object.keys(data.prices)
    .reduce((s, c) => s + (data.wallet[c] || 0) * (data.prices[c] || 0), 0);
  const debt = (data.loans || []).reduce((s, l) => s + l.due, 0);

  const elTotal = document.getElementById('sTotal');
  const elPort  = document.getElementById('sPort');
  const elDebt  = document.getElementById('sDebt');
  if (elTotal) elTotal.textContent = '$' + fmt(data.wallet.usd + coinsVal - debt);
  if (elPort)  elPort.textContent  = '$' + fmt(coinsVal);
  if (elDebt)  elDebt.textContent  = debt > 0 ? '$' + fmt(debt) : '—';
}

// ── ЛОГИН ──────────────────────────────────────────────────────────────────────────────────
document.getElementById('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const username = document.getElementById('usernameInput').value.trim();
  const password = document.getElementById('passwordInput').value;
  const err = document.getElementById('loginError');
  err.textContent = '';
  const res = await api('POST', '/auth/login', { username, password });
  if (res.error) { err.textContent = res.error; return; }
  // Админ переходит в админку только по прямому нажатию Кнопки входа
  if (res.role === 'admin') { window.location.href = '/admin.html'; return; }
  showApp(res.username);
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await api('POST', '/auth/logout');
  location.reload();
});

// ── ТОРГОВЛЯ ────────────────────────────────────────────────────────────────────────────
document.getElementById('tradeForm').addEventListener('submit', async e => {
  e.preventDefault();
  const coin   = document.getElementById('tradeAsset').value;
  const action = document.getElementById('tradeType').value;
  const amount = parseFloat(document.getElementById('tradeAmount').value);
  const err = document.getElementById('tradeError');
  err.textContent = '';
  const res = await api('POST', '/api/trade', { coin, amount, action });
  if (res.error) { err.textContent = res.error; return; }
  renderPortfolio(res.wallet);
  loadState();
});

// ── ПЕРЕВОД ─────────────────────────────────────────────────────────────────────────────
document.getElementById('transferForm').addEventListener('submit', async e => {
  e.preventDefault();
  const to     = document.getElementById('transferTarget').value;
  const amount = parseFloat(document.getElementById('transferAmount').value);
  const err = document.getElementById('transferError');
  err.textContent = '';
  if (!to) { err.textContent = 'Выберите получателя'; return; }
  const res = await api('POST', '/api/transfer', { to, amount });
  if (res.error) { err.textContent = res.error; return; }
  loadState();
});

// ── КРЕДИТ ─────────────────────────────────────────────────────────────────────────────────
document.getElementById('loanForm').addEventListener('submit', async e => {
  e.preventDefault();
  const amount = parseFloat(document.getElementById('loanAmount').value);
  const err = document.getElementById('loanError');
  err.textContent = '';
  const res = await api('POST', '/api/loan', { amount });
  if (res.error) { err.textContent = res.error; return; }
  loadState();
});

document.getElementById('repayBtn').addEventListener('click', async () => {
  const err = document.getElementById('loanError');
  err.textContent = '';
  const state = await api('GET', '/api/state');
  const loan = (state.loans || []).find(l => !l.paid);
  if (!loan) { err.textContent = 'Нет активных кредитов'; return; }
  const res = await api('POST', '/api/repay', { loanId: loan._id, amount: loan.due });
  if (res.error) { err.textContent = res.error; return; }
  loadState();
});

// ── SOCKET ────────────────────────────────────────────────────────────────────────────────────
let prevPrices = null;
socket.on('priceUpdate', p => {
  renderTicker(p, prevPrices);
  addPricePoint(p);
  prevPrices = { ...p };
});

socket.on('newEvent', ev => {
  const feed = document.getElementById('activityFeed');
  if (!feed) return;
  const t = new Date(ev.ts);
  const time = t.getHours().toString().padStart(2,'0') + ':' + t.getMinutes().toString().padStart(2,'0');
  feed.insertAdjacentHTML('afterbegin',
    `<div class="feed-item"><span>${ev.text}</span><span class="feed-time">${time}</span></div>`);
  if (feed.children.length > 40) feed.lastChild.remove();
});

socket.on('walletUpdate', data => {
  if (data.username === myUsername) renderPortfolio(data.wallet);
  loadState();
});

// Обновление списка монет в реалтайм (админ добавил / удалил монету)
socket.on('coinsUpdated', data => {
  if (data.coins) renderTradeAssets(data.coins);
});

// ── ТЕМА ────────────────────────────────────────────────────────────────────────────────────
(function() {
  const btn = document.getElementById('themeBtn');
  const html = document.documentElement;
  let dark = html.getAttribute('data-theme') === 'dark';
  if (btn) {
    btn.textContent = dark ? '☀️' : '🌙';
    btn.addEventListener('click', () => {
      dark = !dark;
      html.setAttribute('data-theme', dark ? 'dark' : 'light');
      btn.textContent = dark ? '☀️' : '🌙';
      renderChart();
    });
  }
})();

// ── ПРОВЕРКА СЕССИИ ─────────────────────────────────────────────────────────────────────
// Восстанавливаем сессию только для игроков — админ должен войти через форму входа вручную
api('GET', '/auth/me').then(res => {
  if (res.username && res.role !== 'admin') {
    showApp(res.username);
  }
});
