const socket = io();
let myUsername = '';
let prices = {};
let currentCoins = [];

// Кэш для пересчёта рейтинга / портфеля при обновлении цен без HTTP-запроса
let lastPlayers = null; // сирые данные игроков из /api/state (usd + количество монет)
let lastWallet  = null; // кошелёк текущего игрока
let lastDebt    = 0;    // актуальный долг (обновляется через loanUpdate)

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

// ── РЕНДЕР ────────────────────────────────────────────────────────────────────
function renderTicker(p, prev) {
  prices = p;
  const el = document.getElementById('ticker');
  if (!el) return;
  el.innerHTML = Object.entries(p).map(([coin, price]) => {
    const dec = price < 1 ? 4 : 2;
    const dir = prev && prev[coin] != null
      ? (price > prev[coin] ? 'up' : price < prev[coin] ? 'dn' : '')
      : '';
    return `<div class="tick ${dir}"><div class="coin">${coin}</div><div class="price">$${fmt(price, dec)}</div></div>`;
  }).join('');
}

// renderLeaderboard принимает плейеров в формате { username, usd, coins?, isBot }
// если есть поле coins — пересчитываем полный капитал по актуальным ценам
function renderLeaderboard(players, currentPrices) {
  const tbody = document.getElementById('leaderBody');
  if (!tbody || !players) return;
  const p = currentPrices || prices;

  // Считаем total для каждого: usd + стоимость монет по текущим ценам
  const withTotal = players.map(pl => {
    let coinsVal = 0;
    if (pl.coins) {
      for (const [coin, amt] of Object.entries(pl.coins)) {
        coinsVal += (amt || 0) * (p[coin] || 0);
      }
    }
    return { ...pl, total: (pl.usd || 0) + coinsVal };
  });

  const sorted = [...withTotal].sort((a, b) => b.total - a.total);
  const maxTotal = sorted[0] ? sorted[0].total : 1;
  tbody.innerHTML = '';
  sorted.forEach((pl, i) => {
    const isMine = pl.username === myUsername;
    const rank = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : i + 1;
    const barW = maxTotal > 0 ? Math.round(pl.total / maxTotal * 100) : 0;
    const tr = document.createElement('tr');
    if (isMine) tr.className = 'me';
    tr.innerHTML = `
      <td><span class="rank">${rank}</span></td>
      <td><span class="${isMine ? 'inv-name me' : 'inv-name'}">${pl.username}</span></td>
      <td>$${fmt(pl.total)}</td>
      <td><span class="bar-wrap"><span class="bar-fill" style="width:${barW}%"></span></span></td>`;
    tbody.appendChild(tr);
  });
}

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

function renderPortfolio(wallet, coins) {
  const activeCoinsList = coins || currentCoins;
  const body = document.getElementById('portfolioBody');
  if (!body) return;
  const rows = activeCoinsList.filter(c => (wallet[c] || 0) > 0).map(c => {
    const val = (wallet[c] || 0) * (prices[c] || 0);
    const dec = (prices[c] || 0) < 1 ? 4 : 2;
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

function renderTradeAssets(coins) {
  const sel = document.getElementById('tradeAsset');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = coins.map(c => `<option value="${c}">${c}</option>`).join('');
  if (coins.includes(prev)) sel.value = prev;
}

// Пересчитываем портфель, статистику и рейтинг по новым ценам (без HTTP)
function recalcByPrices(p) {
  if (lastWallet) {
    renderPortfolio(lastWallet, currentCoins);
    const coinsVal = currentCoins.reduce((s, c) => s + (lastWallet[c] || 0) * (p[c] || 0), 0);
    const elTotal = document.getElementById('sTotal');
    const elPort  = document.getElementById('sPort');
    if (elTotal) elTotal.textContent = '$' + fmt(lastWallet.usd + coinsVal - lastDebt);
    if (elPort)  elPort.textContent  = '$' + fmt(coinsVal);
  }
  if (lastPlayers) renderLeaderboard(lastPlayers, p);
}

// ── КРЕДИТ UI ─────────────────────────────────────────────────────────────────
function renderLoanInfo(info) {
  if (!info || info.error) return;

  const activePanel = document.getElementById('loanActivePanel');
  const newPanel    = document.getElementById('loanNewPanel');
  const rateNote    = document.getElementById('loanRateNote');
  const elDebt      = document.getElementById('sDebt');

  const rateStr = `${(info.rate * 100).toFixed(3)}%/тик`;

  if (info.loan) {
    if (activePanel) activePanel.style.display = 'block';
    if (newPanel)    newPanel.style.display    = 'none';

    const due  = document.getElementById('loanDueDisplay');
    const rate = document.getElementById('loanRateDisplay');
    const bar  = document.getElementById('marginBarFill');
    const lbl  = document.getElementById('marginLabel');

    if (due)    due.textContent  = '$' + fmt(info.loan.due);
    if (rate)   rate.textContent = rateStr;
    if (elDebt) elDebt.textContent = '$' + fmt(info.loan.due);

    lastDebt = info.loan.due; // кэшируем долг

    const pct    = Math.min(Math.round(info.marginRatio * 100), 100);
    const danger = pct >= 70;
    const warn   = pct >= 50;
    if (bar) {
      bar.style.width      = pct + '%';
      bar.style.background = danger ? '#e05252' : warn ? '#f7931a' : '#4f98a3';
    }
    if (lbl) {
      lbl.textContent = `Маржа: ${pct}% (маржин-колл при 80%)`;
      lbl.style.color = danger ? '#e05252' : warn ? '#f7931a' : '';
    }
  } else {
    if (activePanel) activePanel.style.display = 'none';
    if (newPanel)    newPanel.style.display    = 'block';
    if (rateNote)    rateNote.textContent       = `Ставка: ${rateStr} · Максимум: $${fmt(info.maxLoan, 0)}`;
    if (elDebt)      elDebt.textContent         = '—';
    lastDebt = 0;
  }
}

function applyLoanUpdate(data) {
  if (data.username !== myUsername) return;

  const activePanel = document.getElementById('loanActivePanel');
  const newPanel    = document.getElementById('loanNewPanel');
  const due         = document.getElementById('loanDueDisplay');
  const rateEl      = document.getElementById('loanRateDisplay');
  const bar         = document.getElementById('marginBarFill');
  const lbl         = document.getElementById('marginLabel');
  const elDebt      = document.getElementById('sDebt');

  if (activePanel) activePanel.style.display = 'block';
  if (newPanel)    newPanel.style.display    = 'none';

  if (due)    due.textContent    = '$' + fmt(data.due);
  if (rateEl) rateEl.textContent = `${(data.rate * 100).toFixed(3)}%/тик`;
  if (elDebt) elDebt.textContent = '$' + fmt(data.due);

  lastDebt = data.due; // обновляем кэш долга

  const pct    = Math.min(Math.round((data.marginRatio || 0) * 100), 100);
  const danger = pct >= 70;
  const warn   = pct >= 50;
  if (bar) {
    bar.style.width      = pct + '%';
    bar.style.background = danger ? '#e05252' : warn ? '#f7931a' : '#4f98a3';
  }
  if (lbl) {
    lbl.textContent = `Маржа: ${pct}% (маржин-колл при 80%)`;
    lbl.style.color = danger ? '#e05252' : warn ? '#f7931a' : '';
  }

  loadState();
}

// ── ЗАГРУЗКА СОСТОЯНИЯ ────────────────────────────────────────────────────────
async function loadState() {
  const [data, loanInfo] = await Promise.all([
    api('GET', '/api/state'),
    api('GET', '/api/loan/info'),
  ]);
  if (data.error) return;

  if (data.coins) {
    currentCoins = data.coins;
    updateChartCoins(data.coins);
  }

  // Кэшируем плейеров с полными данными кошельков (wallet.*) для пересчёта
  // Сервер присылает players с usd+total, но не с coins игроков —
  // поэтому добавляем coins из wallets
  lastPlayers = data.players; // { username, usd, isBot } — без coins, но достаточно для рейтинга
  lastWallet  = data.wallet;

  renderTicker(data.prices);
  renderPortfolio(data.wallet, data.coins);
  renderFeed(data.events || []);
  renderLeaderboard(data.players, data.prices);
  renderTransferSelect(data.players);
  renderTradeAssets(data.coins || currentCoins);
  renderLoanInfo(loanInfo);
  addPricePoint(data.prices);

  const coinsVal = (data.coins || currentCoins)
    .reduce((s, c) => s + (data.wallet[c] || 0) * (data.prices[c] || 0), 0);
  const debt = loanInfo && loanInfo.loan ? loanInfo.loan.due : 0;
  lastDebt = debt;

  const elTotal = document.getElementById('sTotal');
  const elPort  = document.getElementById('sPort');
  if (elTotal) elTotal.textContent = '$' + fmt(data.wallet.usd + coinsVal - debt);
  if (elPort)  elPort.textContent  = '$' + fmt(coinsVal);
}

// ── ЛОГИН ─────────────────────────────────────────────────────────────────────
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

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await api('POST', '/auth/logout');
  location.reload();
});

// ── ТОРГОВЛЯ ──────────────────────────────────────────────────────────────────
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

// ── ПЕРЕВОД ───────────────────────────────────────────────────────────────────
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

// ── КРЕДИТ: взять ─────────────────────────────────────────────────────────────
document.getElementById('loanForm').addEventListener('submit', async e => {
  e.preventDefault();
  const amount = parseFloat(document.getElementById('loanAmount').value);
  const err = document.getElementById('loanError');
  err.textContent = '';
  const res = await api('POST', '/api/loan', { amount });
  if (res.error) { err.textContent = res.error; return; }
  loadState();
});

// ── КРЕДИТ: погасить ──────────────────────────────────────────────────────────
document.getElementById('repayBtn').addEventListener('click', async () => {
  const err        = document.getElementById('loanError');
  const repayInput = document.getElementById('repayAmount');
  err.textContent  = '';
  const amount = repayInput && repayInput.value ? parseFloat(repayInput.value) : undefined;
  const res = await api('POST', '/api/repay', amount ? { amount } : {});
  if (res.error) { err.textContent = res.error; return; }
  if (repayInput) repayInput.value = '';
  loadState();
});

// ── SOCKET ────────────────────────────────────────────────────────────────────
let prevPrices = null;
socket.on('priceUpdate', p => {
  renderTicker(p, prevPrices);
  addPricePoint(p);
  prevPrices = { ...p };
  // Без HTTP: пересчитываем портфель и рейтинг если есть кэш
  recalcByPrices(p);
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
  if (data.username === myUsername) {
    lastWallet = data.wallet; // сразу обновляем кэш
    renderPortfolio(data.wallet);
    loadState();
  }
});

socket.on('loanUpdate', applyLoanUpdate);

socket.on('marginCall', ({ username, remaining }) => {
  if (username !== myUsername) return;
  const msg = remaining > 0.01
    ? `🚨 МАРЖИН-КОЛЛ!\nВсе активы принудительно проданы.\nОсталось долга: $${fmt(remaining)}`
    : `🚨 МАРЖИН-КОЛЛ!\nВсе активы проданы — долг полностью погашен.`;
  alert(msg);
  loadState();
});

socket.on('coinsUpdated', ({ coins }) => {
  currentCoins = coins;
  updateChartCoins(coins);
  renderTradeAssets(coins);
  loadState();
});

// ── ТЕМА ──────────────────────────────────────────────────────────────────────
(function() {
  const btn  = document.getElementById('themeBtn');
  const html = document.documentElement;
  let dark = false;
  if (btn) {
    btn.textContent = '🌙';
    btn.addEventListener('click', () => {
      dark = !dark;
      html.setAttribute('data-theme', dark ? 'dark' : 'light');
      btn.textContent = dark ? '☀️' : '🌙';
      renderChart();
    });
  }
})();

// ── ПРОВЕРКА СЕССИИ ───────────────────────────────────────────────────────────
api('GET', '/auth/me').then(res => {
  if (res.username) {
    if (res.role === 'admin') { window.location.href = '/admin.html'; return; }
    showApp(res.username);
  }
});
