const socket = io();
let myUsername = '';
let prices = {};
let dealCount = 0;

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
  document.getElementById('userName').textContent = username;
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('appScreen').style.display = '';
  loadState();
}

function renderTicker(p) {
  prices = p;
  const el = document.getElementById('ticker');
  el.innerHTML = Object.entries(p).map(([coin, price]) =>
    `<div class="tick-item"><span class="tick-coin">${coin}</span><span class="tick-price">$${fmt(price, coin === 'DOGE' || coin === 'XRP' ? 4 : 2)}</span></div>`
  ).join('');
}

function renderPortfolio(wallet) {
  const coins = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'];
  const body = document.getElementById('portfolioBody');
  let totalDebt = 0;
  body.innerHTML = coins.filter(c => wallet[c] > 0).map(c => {
    const val = (wallet[c] || 0) * (prices[c] || 0);
    return `<tr><td>${c}</td><td>${fmt(wallet[c], 5)}</td><td>$${fmt(prices[c] || 0)}</td><td>$${fmt(val)}</td></tr>`;
  }).join('') || '<tr><td colspan="4" style="color:var(--muted);text-align:center">Нет активов</td></tr>';

  document.getElementById('myCash').textContent = '$' + fmt(wallet.usd);
}

function renderLoans(loans) {
  const total = loans.reduce((s, l) => s + l.due, 0);
  document.getElementById('myDebt').textContent = '$' + fmt(total);
  const body = document.getElementById('loansBody');
  body.innerHTML = loans.length
    ? loans.map(l => `<tr><td>${l.username}</td><td>$${fmt(l.due)}</td><td>8%</td><td>${new Date(l.ts).toLocaleDateString('ru')}</td></tr>`).join('')
    : '<tr><td colspan="4" style="color:var(--muted);text-align:center">Нет кредитов</td></tr>';
  document.getElementById('loanCount').textContent = loans.length;
}

function renderPlayers(wallets) {
  const body = document.getElementById('playersBody');
  const select = document.getElementById('transferTarget');
  const others = wallets.filter(w => w.username !== myUsername && w.username !== 'admin');
  body.innerHTML = wallets.filter(w => w.username !== 'admin').map(w =>
    `<tr><td>${w.username === myUsername ? '<b>' + w.username + '</b>' : w.username}</td><td>$${fmt(w.usd)}</td><td>—</td><td><span class="badge ok">онлайн</span></td></tr>`
  ).join('');
  select.innerHTML = others.map(w => `<option value="${w.username}">${w.username}</option>`).join('');
}

function renderEvents(events) {
  const feed = document.getElementById('activityFeed');
  feed.innerHTML = events.map(e => {
    const t = new Date(e.ts);
    const time = t.getHours().toString().padStart(2,'0') + ':' + t.getMinutes().toString().padStart(2,'0');
    return `<div class="feed-item"><span>${e.text}</span><span class="muted" style="font-size:var(--text-xs)">${time}</span></div>`;
  }).join('');
}

async function loadState() {
  const data = await api('GET', '/api/state');
  if (data.error) return;
  renderTicker(data.prices);
  renderPortfolio(data.wallet);
  renderLoans(data.loans || []);
  renderEvents(data.events || []);

  // Обновляем net worth
  const coinsVal = ['BTC','ETH','SOL','XRP','DOGE'].reduce((s,c) => s + (data.wallet[c]||0)*(data.prices[c]||0), 0);
  const debt = (data.loans||[]).reduce((s,l) => s + l.due, 0);
  document.getElementById('netWorth').textContent = '$' + fmt(data.wallet.usd + coinsVal - debt);

  // Загружаем список игроков
  const pd = await api('GET', '/api/admin/players');
  if (!pd.error) renderPlayers(pd.wallets || []);
}

// --- ЛОГИН ---
document.getElementById('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const username = document.getElementById('usernameInput').value.trim();
  const password = document.getElementById('passwordInput').value;
  const err = document.getElementById('loginError');
  err.textContent = '';
  const res = await api('POST', '/auth/login', { username, password });
  if (res.error) { err.textContent = res.error; return; }
  if (res.role === 'admin') { window.location.href = '/admin.html'; return; }
  showApp(res.username);
});

// --- ВЫХОД ---
document.getElementById('logoutBtn').addEventListener('click', async () => {
  await api('POST', '/auth/logout');
  location.reload();
});

// --- ТОРГОВЛЯ ---
document.getElementById('tradeForm').addEventListener('submit', async e => {
  e.preventDefault();
  const coin   = document.getElementById('tradeAsset').value;
  const action = document.getElementById('tradeType').value;
  const amount = parseFloat(document.getElementById('tradeAmount').value);
  const err = document.getElementById('tradeError');
  err.textContent = '';
  const res = await api('POST', '/api/trade', { coin, amount, action });
  if (res.error) { err.textContent = res.error; return; }
  dealCount++;
  document.getElementById('dealCount').textContent = dealCount;
  renderPortfolio(res.wallet);
  document.getElementById('myCash').textContent = '$' + fmt(res.wallet.usd);
});

// --- ПЕРЕВОД ---
document.getElementById('transferForm').addEventListener('submit', async e => {
  e.preventDefault();
  const to     = document.getElementById('transferTarget').value;
  const amount = parseFloat(document.getElementById('transferAmount').value);
  const err = document.getElementById('transferError');
  err.textContent = '';
  const res = await api('POST', '/api/transfer', { to, amount });
  if (res.error) { err.textContent = res.error; return; }
  loadState();
});

// --- КРЕДИТ ---
document.getElementById('loanForm').addEventListener('submit', async e => {
  e.preventDefault();
  const amount = parseFloat(document.getElementById('loanAmount').value);
  const err = document.getElementById('loanError');
  err.textContent = '';
  const res = await api('POST', '/api/loan', { amount });
  if (res.error) { err.textContent = res.error; return; }
  renderPortfolio(res.wallet);
  loadState();
});

// --- ПОГАШЕНИЕ ---
document.getElementById('repayForm').addEventListener('submit', async e => {
  e.preventDefault();
  const amount = parseFloat(document.getElementById('repayAmount').value);
  const err = document.getElementById('repayError');
  err.textContent = '';
  // Берём первый активный кредит
  const state = await api('GET', '/api/state');
  const loan = (state.loans || []).find(l => !l.paid);
  if (!loan) { err.textContent = 'Нет активных кредитов'; return; }
  const res = await api('POST', '/api/repay', { loanId: loan._id, amount: loan.due });
  if (res.error) { err.textContent = res.error; return; }
  loadState();
});

// --- SOCKET EVENTS ---
socket.on('priceUpdate', p => renderTicker(p));
socket.on('newEvent', ev => {
  const feed = document.getElementById('activityFeed');
  if (!feed) return;
  const t = new Date(ev.ts);
  const time = t.getHours().toString().padStart(2,'0') + ':' + t.getMinutes().toString().padStart(2,'0');
  feed.insertAdjacentHTML('afterbegin',
    `<div class="feed-item"><span>${ev.text}</span><span class="muted" style="font-size:var(--text-xs)">${time}</span></div>`);
  if (feed.children.length > 30) feed.lastChild.remove();
});
socket.on('walletUpdate', data => {
  if (data.username === myUsername) {
    renderPortfolio(data.wallet);
    document.getElementById('myCash').textContent = '$' + fmt(data.wallet.usd);
  }
});

// Проверка сессии при загрузке страницы
api('GET', '/auth/me').then(res => {
  if (res.username) {
    if (res.role === 'admin') { window.location.href = '/admin.html'; return; }
    showApp(res.username);
  }
});