const socket = io();
let myUsername = '';
let prices = {};
let currentCoins = [];

let lastPlayers = null;
let lastWallet  = null;
let lastDebt    = 0;

// Средства, зарезервированные под лимитные ордера (в кошельке их уже нет)
let lastLockedUsd   = 0;
let lastLockedCoins = {};

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
  loadState().then(() => { loadOrders(); loadOrderBook(); });
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
    const botBadge = pl.isBot ? ' <span style="font-size:11px;color:var(--mu);opacity:.7">[авт.]</span>' : '';
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
    o.disabled = true; o.textContent = 'Нет других государств';
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
      o.textContent = p.isBot ? `${p.username} [авт.]` : p.username;
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
  const rows = activeCoinsList
    .filter(c => (wallet[c] || 0) > 0 || (lastLockedCoins[c] || 0) > 0)
    .map(c => {
      const free   = wallet[c] || 0;
      const locked = lastLockedCoins[c] || 0;
      const val    = (free + locked) * (prices[c] || 0);
      const dec    = (prices[c] || 0) < 1 ? 4 : 2;
      const lockNote = locked > 0
        ? ` <span class="muted" title="Зарезервировано под лимитные ордера">🔒${fmt(locked, 4)}</span>`
        : '';
      return `<tr><td>${c}</td><td>${fmt(free, 5)}${lockNote}</td><td>$${fmt(prices[c] || 0, dec)}</td><td>$${fmt(val)}</td></tr>`;
    });
  body.innerHTML = rows.length
    ? rows.join('')
    : '<tr><td colspan="4" style="color:var(--mu);text-align:center;padding:16px">Резервы пусты</td></tr>';
  const el = document.getElementById('sCash');
  if (el) {
    el.textContent = '$' + fmt(wallet.usd);
    el.title = lastLockedUsd > 0.005 ? `+ $${fmt(lastLockedUsd)} в резерве под ордера` : '';
  }
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

// Крипторезервы = свободные монеты + зарезервированные под ордера
function portfolioCoinValue(wallet, p, coins) {
  return coins.reduce(
    (s, c) => s + ((wallet[c] || 0) + (lastLockedCoins[c] || 0)) * (p[c] || 0),
    0
  );
}

function recalcByPrices(p) {
  if (lastWallet) {
    renderPortfolio(lastWallet, currentCoins);
    const coinsVal = portfolioCoinValue(lastWallet, p, currentCoins);
    const elTotal = document.getElementById('sTotal');
    const elPort  = document.getElementById('sPort');
    if (elTotal) elTotal.textContent = '$' + fmt(lastWallet.usd + lastLockedUsd + coinsVal - lastDebt);
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

// ── ЛИМИТНЫЕ ОРДЕРА ───────────────────────────────────────────────────────────
let lastBook   = null;
let maxOpenOrders = 20;

// Троттлинг сетевых обновлений: не чаще раза в 1.2с, с «хвостовым» вызовом
function throttled(fn, ms) {
  let last = 0, timer = null;
  return () => {
    const now = Date.now();
    if (now - last >= ms) { last = now; fn(); return; }
    if (timer) return;
    timer = setTimeout(() => { timer = null; last = Date.now(); fn(); }, ms - (now - last));
  };
}

function renderOrderAssets(coins) {
  for (const id of ['orderAsset', 'obAsset']) {
    const sel = document.getElementById(id);
    if (!sel) continue;
    const prev = sel.value;
    sel.innerHTML = coins.map(c => `<option value="${c}">${c}</option>`).join('');
    if (coins.includes(prev)) sel.value = prev;
  }
}

function currentBookCoin() {
  return document.getElementById('obAsset')?.value || currentCoins[0] || '';
}

function updateOrderHint() {
  const hint   = document.getElementById('orderHint');
  const coin   = document.getElementById('orderAsset')?.value;
  const side   = document.getElementById('orderSide')?.value;
  if (!hint || !coin) return;

  const price  = parseFloat(document.getElementById('orderPrice')?.value) || 0;
  const amount = parseFloat(document.getElementById('orderAmount')?.value) || 0;
  const market = prices[coin] || 0;

  if (price <= 0 || amount <= 0) {
    hint.textContent = market > 0
      ? `Рынок: $${fmt(market, market < 1 ? 4 : 2)} — ордер сработает, когда курс дойдёт до лимита`
      : '';
    return;
  }

  if (side === 'buy') {
    const need = price * amount * (1 + TRADE_FEE);
    hint.textContent = `Резерв: $${fmt(need)} (с комиссией ${(TRADE_FEE * 100).toFixed(1)}%)` +
      (market > 0 && price >= market * (1 + SPREAD) ? ' · исполнится сразу' : '');
  } else {
    const get = price * amount * (1 - TRADE_FEE);
    hint.textContent = `Резерв: ${fmt(amount, 6)} ${coin} → ≈ $${fmt(get)}` +
      (market > 0 && price <= market * (1 - SPREAD) ? ' · исполнится сразу' : '');
  }
}

function renderOrders(data) {
  const body = document.getElementById('ordersBody');
  const cnt  = document.getElementById('ordersCount');
  const lock = document.getElementById('ordersLocked');
  if (!body || !data || data.error) return;

  if (data.maxOpen) maxOpenOrders = data.maxOpen;

  const open   = data.open   || [];
  const closed = data.closed || [];

  if (cnt) cnt.textContent = `${open.length} / ${maxOpenOrders}`;

  if (lock) {
    const parts = [];
    if ((data.lockedUsd || 0) > 0.005) parts.push(`$${fmt(data.lockedUsd)}`);
    for (const [coin, amt] of Object.entries(data.lockedCoins || {})) {
      if (amt > 0) parts.push(`${fmt(amt, 6)} ${coin}`);
    }
    lock.textContent = parts.length ? `🔒 В резерве под ордера: ${parts.join(' · ')}` : '';
  }

  const rows = [];
  for (const o of open) {
    const dec  = o.price < 1 ? 5 : 2;
    const pct  = o.amount > 0 ? Math.min(100, Math.round(o.filled / o.amount * 100)) : 0;
    rows.push(`<tr>
      <td>${o.coin}</td>
      <td><span class="${o.side === 'buy' ? 'ord-side-buy' : 'ord-side-sell'}">${o.side === 'buy' ? 'Покупка' : 'Продажа'}</span></td>
      <td>$${fmt(o.price, dec)}</td>
      <td>${fmt(o.filled, 4)} / ${fmt(o.amount, 4)}<span class="ord-fill"><span style="width:${pct}%"></span></span></td>
      <td><button class="ord-cancel" data-cancel="${o._id}">✕</button></td>
    </tr>`);
  }
  for (const o of closed.slice(0, 5)) {
    const dec = o.price < 1 ? 5 : 2;
    const st  = o.status === 'filled' ? 'исполнен ✅' : 'отменён';
    rows.push(`<tr class="ord-done">
      <td>${o.coin}</td>
      <td>${o.side === 'buy' ? 'Покупка' : 'Продажа'}</td>
      <td>$${fmt(o.price, dec)}</td>
      <td>${fmt(o.filled, 4)} / ${fmt(o.amount, 4)}</td>
      <td>${st}</td>
    </tr>`);
  }

  body.innerHTML = rows.length
    ? rows.join('')
    : '<tr><td colspan="5" style="color:var(--mu);text-align:center;padding:14px">Активных ордеров нет</td></tr>';
}

function renderOrderBook(book) {
  const asksEl = document.getElementById('obAsks');
  const bidsEl = document.getElementById('obBids');
  const midEl  = document.getElementById('obMid');
  if (!asksEl || !bidsEl || !midEl || !book || book.error) return;

  lastBook = book;
  const dec = book.price < 1 ? 5 : 2;
  const maxAmt = Math.max(
    ...(book.bids || []).map(l => l.amount),
    ...(book.asks || []).map(l => l.amount),
    0.000001
  );

  const row = (lvl, cls) => {
    const w = Math.min(100, Math.round(lvl.amount / maxAmt * 100));
    return `<div class="ob-row ${cls}${lvl.mine ? ' mine' : ''}" data-price="${lvl.price}">
      <span class="ob-depth" style="width:${w}%"></span>
      <span class="ob-price">$${fmt(lvl.price, dec)}</span>
      <span>${fmt(lvl.amount, 4)}${lvl.count > 1 ? ` <span class="muted">×${lvl.count}</span>` : ''}</span>
    </div>`;
  };

  asksEl.innerHTML = (book.asks || []).length
    ? [...book.asks].reverse().map(l => row(l, 'ask')).join('')
    : '<div class="ob-empty">Нет заявок на продажу</div>';
  bidsEl.innerHTML = (book.bids || []).length
    ? book.bids.map(l => row(l, 'bid')).join('')
    : '<div class="ob-empty">Нет заявок на покупку</div>';

  midEl.innerHTML =
    `<span class="ob-last">$${fmt(book.price, dec)}</span>` +
    `<span class="muted">биржа: $${fmt(book.bidPrice, dec)} / $${fmt(book.askPrice, dec)}</span>`;
}

async function loadOrders() {
  const data = await api('GET', '/api/orders');
  renderOrders(data);
}

async function loadOrderBook() {
  const coin = currentBookCoin();
  if (!coin) return;
  const book = await api('GET', '/api/orderbook?coin=' + encodeURIComponent(coin));
  if (book && !book.error) renderOrderBook(book);
}

const refreshOrders   = throttled(loadOrders,   1200);
const refreshOrderBook = throttled(loadOrderBook, 1200);

// Обновляем только строку рыночной цены при тике — без лишнего запроса
function updateBookMid(p) {
  const midEl = document.getElementById('obMid');
  const coin  = currentBookCoin();
  if (!midEl || !lastBook || !coin || p[coin] == null) return;
  lastBook.price    = p[coin];
  lastBook.bidPrice = p[coin] * (1 - SPREAD);
  lastBook.askPrice = p[coin] * (1 + SPREAD);
  const dec = lastBook.price < 1 ? 5 : 2;
  midEl.innerHTML =
    `<span class="ob-last">$${fmt(lastBook.price, dec)}</span>` +
    `<span class="muted">биржа: $${fmt(lastBook.bidPrice, dec)} / $${fmt(lastBook.askPrice, dec)}</span>`;
}

document.getElementById('orderForm')?.addEventListener('submit', async e => {
  e.preventDefault();
  const err = document.getElementById('orderError');
  err.textContent = '';
  const coin   = document.getElementById('orderAsset').value;
  const side   = document.getElementById('orderSide').value;
  const price  = parseFloat(document.getElementById('orderPrice').value);
  const amount = parseFloat(document.getElementById('orderAmount').value);
  if (!Number.isFinite(price) || price <= 0)   { err.textContent = 'Укажи цену исполнения'; return; }
  if (!Number.isFinite(amount) || amount <= 0) { err.textContent = 'Укажи объём'; return; }

  const res = await api('POST', '/api/orders', { coin, side, price, amount });
  if (res.error) { err.textContent = res.error; return; }
  document.getElementById('orderAmount').value = '';
  updateOrderHint();
  await Promise.all([loadOrders(), loadOrderBook()]);
  loadState();
});

document.getElementById('ordersBody')?.addEventListener('click', async e => {
  const btn = e.target.closest('[data-cancel]');
  if (!btn) return;
  const err = document.getElementById('orderError');
  err.textContent = '';
  btn.disabled = true;
  const res = await api('DELETE', '/api/orders/' + encodeURIComponent(btn.dataset.cancel));
  if (res.error) { err.textContent = res.error; btn.disabled = false; return; }
  await Promise.all([loadOrders(), loadOrderBook()]);
  loadState();
});

document.getElementById('obAsset')?.addEventListener('change', loadOrderBook);

document.getElementById('obAsks')?.addEventListener('click', e => pickBookPrice(e));
document.getElementById('obBids')?.addEventListener('click', e => pickBookPrice(e));

function pickBookPrice(e) {
  const row = e.target.closest('[data-price]');
  if (!row) return;
  const priceInput = document.getElementById('orderPrice');
  const assetSel   = document.getElementById('orderAsset');
  const coin       = currentBookCoin();
  if (assetSel && [...assetSel.options].some(o => o.value === coin)) assetSel.value = coin;
  if (priceInput) priceInput.value = row.dataset.price;
  const sideSel = document.getElementById('orderSide');
  if (sideSel) sideSel.value = row.classList.contains('ask') ? 'buy' : 'sell';
  updateOrderHint();
}

['orderAsset','orderSide','orderPrice','orderAmount'].forEach(id => {
  document.getElementById(id)?.addEventListener('input', updateOrderHint);
  document.getElementById(id)?.addEventListener('change', updateOrderHint);
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
      lbl.textContent = `Долговая нагрузка: ${pct}% (дефолт при 80%)`;
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

    if (rateNote) rateNote.textContent = `Ставка МВФ: ${rateStr}`;

    const maxLoan = info.maxLoan || 0;
    const portVal = info.portVal || 0;

    if (limitLbl) {
      limitLbl.textContent = maxLoan > 0
        ? `Лимит: $${fmt(maxLoan, 0)} (резервы $${fmt(portVal, 0)})`
        : 'Нет резервов для залога';
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
    lbl.textContent = `Долговая нагрузка: ${pct}% (дефолт при 80%)`;
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

  lastPlayers     = data.players;
  lastWallet      = data.wallet;
  lastLockedUsd   = data.lockedUsd   || 0;
  lastLockedCoins = data.lockedCoins || {};

  renderTicker(data.prices);
  renderPortfolio(data.wallet, data.coins);
  renderFeed(data.events || []);
  renderLeaderboard(data.players, data.prices);
  renderTransferSelect(data.players);
  renderTradeAssets(data.coins || currentCoins);
  renderOrderAssets(data.coins || currentCoins);
  renderLoanInfo(loanInfo);
  addPricePoint(data.prices);
  updateTradeHint();
  updateOrderHint();

  if (data.maxOpenOrders) maxOpenOrders = data.maxOpenOrders;

  const coinsVal = portfolioCoinValue(data.wallet, data.prices, data.coins || currentCoins);
  const debt = loanInfo && loanInfo.loan ? loanInfo.loan.due : 0;
  lastDebt = debt;

  const elTotal = document.getElementById('sTotal');
  const elPort  = document.getElementById('sPort');
  if (elTotal) elTotal.textContent = '$' + fmt(data.wallet.usd + lastLockedUsd + coinsVal - debt);
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

  if (!lastWallet) { err.textContent = 'Данные казны не загружены'; return; }
  const usd   = lastWallet.usd || 0;
  const price = prices[coin] || 0;
  if (price <= 0) { err.textContent = 'Курс актива неизвестен'; return; }
  if (usd < 0.01) { err.textContent = 'Недостаточно резервов'; return; }

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

  if (!lastWallet) { err.textContent = 'Данные казны не загружены'; return; }
  const amount = lastWallet[coin] || 0;
  if (amount <= 0) { err.textContent = `Актив ${coin} отсутствует в резервах`; return; }

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
  if (!to) { err.textContent = 'Выберите государство-получателя'; return; }
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
  updateBookMid(p);
  updateOrderHint();
});

socket.on('orderUpdate', ({ username }) => {
  if (username !== myUsername) return;
  refreshOrders();
  loadState();
});

socket.on('orderbookUpdate', ({ coin }) => {
  if (coin === currentBookCoin()) refreshOrderBook();
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
    ? `🚨 ДЕФОЛТ!\nВсе резервы принудительно ликвидированы.\nОсталось госдолга: $${fmt(remaining)}`
    : `🚨 ДЕФОЛТ!\nВсе резервы ликвидированы — долг полностью погашен.`;
  alert(msg);
  loadState();
});

socket.on('coinsUpdated', ({ coins }) => {
  currentCoins = coins;
  updateChartCoins(coins);
  renderTradeAssets(coins);
  renderOrderAssets(coins);
  loadState();
  loadOrders();
  loadOrderBook();
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
      if (typeof createChartInstance === 'function') createChartInstance();
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
