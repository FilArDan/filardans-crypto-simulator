const socket = io();
let myUsername = '';
let prices = {};
let currentCoins = [];

let lastPlayers = null;
let lastWallet  = null;
let lastDebt    = 0;

// ── Константы торговли (должны совпадать с game.js на сервере) ────────────────
const TRADE_FEE = 0.004;   // 0.4% комиссия
const SPREAD    = 0.0015;  // ±0.15% спред

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

function renderLeaderboard(players, currentPrices) {
  const tbody = document.getElementById('leaderBody');
  if (!tbody || !players) return;
  const p = currentPrices || prices;
  const withTotal = players.map(pl => {
    let coinsVal = 0;
    const coinData = pl.coins || {};
    for (const [coin, amt] of Object.entries(coinData)) {
      if (coin === 'username' || coin === '_id' || coin === 'usd') continue;
      coinsVal += (amt || 0) * (p[coin] || 0);
    }
    const total = pl.total != null ? pl.total : (pl.usd || 0) + coinsVal;
    return { ...pl, total };
  });
  const sorted = [...withTotal].sort((a, b) => b.total - a.total);
  const maxTotal = sorted[0] ? sorted[0].total : 1;
  tbody.innerHTML = '';
  sorted.forEach((pl, i) => {
    const isMine = pl.username === myUsername;
    const rank = i + 1;
    const medal = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
    const barW = maxTotal > 0 ? Math.round(pl.total / maxTotal * 100) : 0;
    const botBadge = pl.isBot ? ' <span style="font-size:11px;color:var(--mu);opacity:.7">[бот]</span>' : '';
    const tr = document.createElement('tr');
    if (isMine) tr.className = 'me';
    tr.innerHTML = `
      <td><span class="rank ${medal}">${rank}</span></td>
      <td><span class="${isMine ? 'inv-name me' : 'inv-name'}">${pl.username}${botBadge}</span></td>
      <td>$${fmt(pl.total)}</td>
      <td><span class="bar-wrap"><span class="bar-fill" style="width:${barW}%"></span></span></td>`;
    tbody.appendChild(tr);
  });
}

function renderTransferSelect(players) {
  const sc = document.getElementById('transferTarget');
  if (!sc || !players) return;

  const prevValue = sc.value;

  const others = players.filter(p => p.username !== myUsername);
  sc.innerHTML = '';
  if (!others.length) {
    const o = document.createElement('option');
    o.disabled = true; o.textContent = 'Нет других игроков';
    sc.appendChild(o);
    return;
  }
  others
    .sort((a, b) => {
      if (a.isBot !== b.isBot) return a.isBot ? 1 : -1;
      return a.username.localeCompare(b.username);
    })
    .forEach(p => {
      const o = document.createElement('option');
      o.value = p.username;
      o.textContent = p.isBot ? `${p.username} [бот]` : p.username;
      sc.appendChild(o);
    });

  if (prevValue && [...sc.options].some(o => o.value === prevValue)) {
    sc.value = prevValue;
  }
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
  updateTradeHint();
}

// ── ТОРГОВАЯ ФОРМА: режим и подсказка ────────────────────────────────────────
let tradeMode = 'qty';

function updateTradeHint() {
  const hint   = document.getElementById('tradeHint');
  const coin   = document.getElementById('tradeAsset')?.value;
  const action = document.getElementById('tradeType')?.value;
  if (!hint || !coin) return;

  const price = prices[coin] || 0;

  if (tradeMode === 'usd') {
    const usdRaw = parseFloat(document.getElementById('tradeUsd')?.value) || 0;
    if (price > 0 && usdRaw > 0) {
      const askPrice = price * (1 + SPREAD);
      const bidPrice = price * (1 - SPREAD);
      const coinQty = action === 'buy'
        ? usdRaw / (askPrice * (1 + TRADE_FEE))
        : usdRaw / (bidPrice * (1 - TRADE_FEE));
      hint.textContent = `≈ ${fmt(coinQty, 6)} ${coin} по $${fmt(price, price < 1 ? 4 : 2)}`;
    } else {
      hint.textContent = '';
    }
  } else {
    const qty = parseFloat(document.getElementById('tradeAmount')?.value) || 0;
    if (price > 0 && qty > 0) {
      const askPrice = price * (1 + SPREAD);
      const bidPrice = price * (1 - SPREAD);
      const usdVal = action === 'buy'
        ? qty * askPrice * (1 + TRADE_FEE)
        : qty * bidPrice * (1 - TRADE_FEE);
      hint.textContent = `≈ $${fmt(usdVal)} (комиссия ${(TRADE_FEE * 100).toFixed(1)}% + спред ${(SPREAD * 100).toFixed(2)}%)`;
    } else {
      hint.textContent = '';
    }
  }
}

document.querySelectorAll('.trade-mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    tradeMode = btn.dataset.mode;
    document.querySelectorAll('.trade-mode-btn').forEach(b => b.classList.toggle('active', b === btn));
    document.getElementById('fieldQty').classList.toggle('hidden', tradeMode !== 'qty');
    document.getElementById('fieldUsd').classList.toggle('hidden', tradeMode !== 'usd');
    updateTradeHint();
  });
});

['tradeAsset','tradeType','tradeAmount','tradeUsd'].forEach(id => {
  document.getElementById(id)?.addEventListener('input', updateTradeHint);
  document.getElementById(id)?.addEventListener('change', updateTradeHint);
});

// ── КРЕДИТ UI ─────────────────────────────────────────────────────────────────
function renderLoanInfo(info) {
  if (!info || info.error) return;

  const activePanel = document.getElementById('loanActivePanel');
  const newPanel    = document.getElementById('loanNewPanel');
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

    lastDebt = info.loan.due;

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
    if (elDebt)      elDebt.textContent         = '—';
    lastDebt = 0;

    const rateNote  = document.getElementById('loanRateNote');
    const limitBar  = document.getElementById('loanLimitBar');
    const limitFill = document.getElementById('loanLimitFill');
    const limitLbl  = document.getElementById('loanLimitLabel');
    const loanInput = document.getElementById('loanAmount');

    if (rateNote) rateNote.textContent = `Ставка: ${rateStr}`;

    const maxLoan = info.maxLoan || 0;
    const portVal = info.portVal || 0;

    if (limitLbl) {
      limitLbl.textContent = maxLoan > 0
        ? `Доступно: $${fmt(maxLoan, 0)} (портфель $${fmt(portVal, 0)})`
        : 'Нет активов для залога';
      limitLbl.style.color = maxLoan > 0 ? 'var(--ac)' : 'var(--mu)';
    }

    if (limitBar) limitBar.style.display = maxLoan > 0 ? 'block' : 'none';

    if (loanInput) {
      loanInput.max = maxLoan;
      loanInput.placeholder = maxLoan > 0 ? `до $${fmt(maxLoan, 0)}` : '0';

      const updateBar = () => {
        if (!limitFill) return;
        const val = parseFloat(loanInput.value) || 0;
        const pct = maxLoan > 0 ? Math.min(val / maxLoan * 100, 100) : 0;
        limitFill.style.width = pct + '%';
        limitFill.style.background = pct > 90 ? '#e05252' : pct > 60 ? '#f7931a' : '#4f98a3';
      };
      loanInput.removeEventListener('input', loanInput._barUpdate);
      loanInput._barUpdate = updateBar;
      loanInput.addEventListener('input', updateBar);
      updateBar();
    }
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

  lastDebt = data.due;

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

  lastPlayers = data.players;
  lastWallet  = data.wallet;

  renderTicker(data.prices);
  renderPortfolio(data.wallet, data.coins);
  renderFeed(data.events || []);
  renderLeaderboard(data.players, data.prices);
  renderTransferSelect(data.players);
  renderTradeAssets(data.coins || currentCoins);
  renderLoanInfo(loanInfo);
  addPricePoint(data.prices);
  updateTradeHint();

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

// ── ТОРГОВЛЯ: вычислить amount по режиму ──────────────────────────────────────
function resolveTradeAmount(coin, action) {
  const price = prices[coin] || 0;
  if (price <= 0) return null;

  if (tradeMode === 'usd') {
    const usd = parseFloat(document.getElementById('tradeUsd').value);
    if (!Number.isFinite(usd) || usd <= 0) return null;
    const askPrice = price * (1 + SPREAD);
    const bidPrice = price * (1 - SPREAD);
    return action === 'buy'
      ? usd / (askPrice * (1 + TRADE_FEE))
      : usd / (bidPrice * (1 - TRADE_FEE));
  } else {
    const qty = parseFloat(document.getElementById('tradeAmount').value);
    if (!Number.isFinite(qty) || qty <= 0) return null;
    return qty;
  }
}

// ── ТОРГОВЛЯ: основная форма ──────────────────────────────────────────────────
document.getElementById('tradeForm').addEventListener('submit', async e => {
  e.preventDefault();
  const coin   = document.getElementById('tradeAsset').value;
  const action = document.getElementById('tradeType').value;
  const err    = document.getElementById('tradeError');
  err.textContent = '';

  const amount = resolveTradeAmount(coin, action);
  if (!amount) { err.textContent = 'Введите корректное значение'; return; }

  const res = await api('POST', '/api/trade', { coin, amount, action });
  if (res.error) { err.textContent = res.error; return; }
  renderPortfolio(res.wallet);
  loadState();
});

// ── КУПИТЬ ВСЁ ────────────────────────────────────────────────────────────────
document.getElementById('buyAllBtn').addEventListener('click', async () => {
  const coin  = document.getElementById('tradeAsset').value;
  const err   = document.getElementById('tradeError');
  err.textContent = '';

  if (!lastWallet) { err.textContent = 'Данные кошелька не загружены'; return; }
  const usd   = lastWallet.usd || 0;
  const price = prices[coin] || 0;
  if (price <= 0) { err.textContent = 'Цена монеты неизвестна'; return; }
  if (usd < 0.01) { err.textContent = 'Недостаточно USD'; return; }

  const askPrice = price * (1 + SPREAD);
  const amount   = usd / (askPrice * (1 + TRADE_FEE));

  const res = await api('POST', '/api/trade', { coin, amount, action: 'buy' });
  if (res.error) { err.textContent = res.error; return; }
  renderPortfolio(res.wallet);
  loadState();
});

// ── ПРОДАТЬ ВСЁ ───────────────────────────────────────────────────────────────
document.getElementById('sellAllBtn').addEventListener('click', async () => {
  const coin = document.getElementById('tradeAsset').value;
  const err  = document.getElementById('tradeError');
  err.textContent = '';

  if (!lastWallet) { err.textContent = 'Данные кошелька не загружены'; return; }
  const amount = lastWallet[coin] || 0;
  if (amount <= 0) { err.textContent = `Нет ${coin} в кошельке`; return; }

  const res = await api('POST', '/api/trade', { coin, amount, action: 'sell' });
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
    lastWallet = data.wallet;
    renderPortfolio(data.wallet);
    loadState();
  }
});

socket.on('playersUpdate', players => {
  lastPlayers = players;
  renderLeaderboard(players, prices);
  renderTransferSelect(players);
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
