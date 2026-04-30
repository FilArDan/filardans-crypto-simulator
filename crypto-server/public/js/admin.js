const socket = io();
let prices     = {};
let coinMeta   = {};   // vol, drift, supply, basePrice, isCustom per coin
let allWallets = [];
let allLoans   = [];
let dealCount  = 0;
let COINS      = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE']; // обновляется динамически
const BASE_COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'];

// ── HELPERS ──────────────────────────────────────────────────────────────────
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
  return t.getHours().toString().padStart(2,'0') + ':' +
         t.getMinutes().toString().padStart(2,'0');
}

function coinDec(c)  { return BASE_COINS.includes(c) ? 5 : 3; }
function priceDec(c) {
  const p = prices[c] || 0;
  if (p >= 10000) return 2;
  if (p >= 100)   return 2;
  if (p >= 1)     return 3;
  if (p >= 0.01)  return 4;
  return 5;
}

// ── УДАЛЕНИЕ ИГРОКА ──────────────────────────────────────────────────────────
async function deletePlayer(username) {
  if (!confirm(`Удалить аккаунт "${username}"?\nКошелёк и все кредиты будут удалены безвозвратно.`)) return;
  const r = await fetch(`/api/admin/player/${encodeURIComponent(username)}`, { method: 'DELETE' });
  const data = await r.json();
  if (data.error) { alert(data.error); return; }
  await loadAdminData();
}

// ── СОЗДАНИЕ МОНЕТЫ ──────────────────────────────────────────────────────────
// Автозаполнение для базовых монет (подсказывает дефолтные параметры)
const BASE_COIN_DEFAULTS = {
  BTC:  { name: 'Bitcoin',  emoji: '₿',  price: 45000, vol: 3,   supply: 21000000     },
  ETH:  { name: 'Ethereum', emoji: 'Ξ',  price: 2800,  vol: 4.5, supply: 120000000    },
  SOL:  { name: 'Solana',   emoji: '◎',  price: 120,   vol: 7,   supply: 440000000    },
  XRP:  { name: 'XRP',      emoji: '✕',  price: 0.52,  vol: 5,   supply: 45000000000  },
  DOGE: { name: 'Dogecoin', emoji: '🐕', price: 0.08,  vol: 6,   supply: 140000000000 },
};

document.getElementById('newTicker').addEventListener('input', function () {
  const ticker = this.value.toUpperCase();
  const d = BASE_COIN_DEFAULTS[ticker];
  if (d) {
    document.getElementById('newName').value   = d.name;
    document.getElementById('newEmoji').value  = d.emoji;
    document.getElementById('newPrice').value  = d.price;
    document.getElementById('newVol').value    = d.vol;
    document.getElementById('newDrift').value  = 0;
    document.getElementById('newSupply').value = d.supply;
  }
});

document.getElementById('createCoinForm').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = document.getElementById('createCoinBtn');
  btn.disabled = true; btn.textContent = '⏳ Создание...';

  const body = {
    ticker: document.getElementById('newTicker').value.toUpperCase().trim(),
    name:   document.getElementById('newName').value.trim()   || undefined,
    emoji:  document.getElementById('newEmoji').value.trim()  || '🪙',
    price:  parseFloat(document.getElementById('newPrice').value),
    vol:    parseFloat(document.getElementById('newVol').value)   / 100,
    drift:  parseFloat(document.getElementById('newDrift').value) / 100,
    supply: parseFloat(document.getElementById('newSupply').value),
  };

  const res = await api('POST', '/api/admin/coin/create', body);
  if (res.error) {
    alert(res.error);
  } else {
    if (res.coins) COINS = res.coins;
    if (res.prices) prices = res.prices;
    document.getElementById('createCoinForm').reset();
    await loadAdminData();
  }
  btn.disabled = false; btn.textContent = '🚀 Создать монету';
});

// ── УДАЛЕНИЕ МОНЕТЫ (любой, включая базовые) ────────────────────────────────
async function deleteCoin(ticker) {
  const m = coinMeta[ticker] || {};
  const isBase = BASE_COINS.includes(ticker);
  const warn = isBase
    ? `\n\n⚠️ Это базовая монета. После удаления её можно восстановить через форму создания (тикер ${ticker}).`
    : '';
  if (!confirm(`Удалить монету ${m.emoji || '🪙'} ${ticker}?\n\nИгрокам будут возвращены USD по текущей цене.${warn}`)) return;
  const r = await fetch(`/api/admin/coin/${encodeURIComponent(ticker)}`, { method: 'DELETE' });
  const data = await r.json();
  if (data.error) { alert(data.error); return; }
  if (data.coins) COINS = data.coins;
  await loadAdminData();
}

// ── ПАРАМЕТРЫ МОНЕТ ──────────────────────────────────────────────────────────
function renderCoinParams() {
  const tbody = document.getElementById('coinParamsBody');
  if (!tbody) return;

  tbody.innerHTML = COINS.map(coin => {
    const m        = coinMeta[coin] || {};
    const volPct   = +(((m.vol   || 0.04) * 100).toFixed(1));
    const driftPct = +(((m.drift || 0)    * 100).toFixed(1));
    const supply   = m.supply    || '';
    const base     = m.basePrice || '';
    const driftCol = driftPct > 0 ? 'var(--up)' : driftPct < 0 ? 'var(--dn)' : 'var(--mu)';
    const isCustom = m.isCustom || !BASE_COINS.includes(coin);
    const isBase   = BASE_COINS.includes(coin) && !m.isCustom;
    const emoji    = m.emoji || (isBase ? '' : '🪙');
    const label    = isBase
      ? `<strong>${emoji ? emoji + ' ' : ''}${coin}</strong>`
      : `${emoji} ${coin} <span class="tag-custom">custom</span>`;

    return `<tr id="coin-row-${coin}">
      <td>${label}</td>
      <td style="font-variant-numeric:tabular-nums">$${fmt(prices[coin] || 0, priceDec(coin))}</td>

      <td>
        <div style="display:flex;align-items:center;gap:6px">
          <input type="range" min="0.5" max="30" step="0.5" value="${volPct}"
            class="coin-slider" id="vol-${coin}"
            oninput="document.getElementById('vol-lbl-${coin}').textContent=this.value+'%'">
          <span class="vol-lbl" id="vol-lbl-${coin}">${volPct}%</span>
        </div>
      </td>

      <td>
        <div style="display:flex;align-items:center;gap:6px">
          <input type="range" min="-10" max="10" step="0.1" value="${driftPct}"
            class="coin-slider" id="drift-${coin}"
            oninput="
              const v=parseFloat(this.value);
              const lbl=document.getElementById('drift-lbl-${coin}');
              lbl.textContent=(v>0?'+':'')+v.toFixed(1)+'%';
              lbl.style.color=v>0?'var(--up)':v<0?'var(--dn)':'var(--mu)';
            ">
          <span class="drift-lbl" id="drift-lbl-${coin}" style="color:${driftCol}">${driftPct > 0 ? '+' : ''}${driftPct}%</span>
        </div>
      </td>

      <td>
        <input type="number" class="coin-input" id="supply-${coin}"
          value="${supply}" min="1" step="1" placeholder="Supply">
      </td>

      <td>
        <input type="number" class="coin-input" id="base-${coin}"
          value="${base}" min="0.0001" step="any" placeholder="Базовая цена">
      </td>

      <td style="display:flex;gap:6px;align-items:center">
        <button class="btn btn-secondary btn-sm" onclick="saveCoinParams('${coin}')">
          Сохранить
        </button>
        <button class="btn btn-dan btn-sm" onclick="deleteCoin('${coin}')" title="Удалить монету">🗑️</button>
      </td>
    </tr>`;
  }).join('');
}

async function saveCoinParams(coin) {
  const vol       = parseFloat(document.getElementById(`vol-${coin}`).value)   / 100;
  const drift     = parseFloat(document.getElementById(`drift-${coin}`).value) / 100;
  const supplyVal = parseFloat(document.getElementById(`supply-${coin}`).value);
  const baseVal   = parseFloat(document.getElementById(`base-${coin}`).value);

  const body = { coin, vol, drift };
  if (!isNaN(supplyVal) && supplyVal > 0) body.supply    = supplyVal;
  if (!isNaN(baseVal)   && baseVal   > 0) body.basePrice = baseVal;

  const btn = document.querySelector(`#coin-row-${coin} .btn`);
  if (btn) { btn.disabled = true; btn.textContent = '⏳...'; }

  const res = await api('POST', '/api/admin/coin/params', body);
  if (res.error) alert(res.error);
  else {
    if (res.prices) prices = res.prices;
    await loadAdminData();
  }
  if (btn) { btn.disabled = false; btn.textContent = 'Сохранить'; }
}

// ── СЛАЙДЕР СКОРОСТИ ТИКА ────────────────────────────────────────────────────
let sliderDebounce = null;

function updateSpeedLabel(ms) {
  const sec   = Math.round(ms / 1000);
  const label = ms < 1000 ? ms + ' мс'
    : sec >= 60 ? (sec / 60).toFixed(1).replace('.0','') + ' мин'
    : sec + ' сек';
  const el   = document.getElementById('speedLabel');
  const stat = document.getElementById('tickSpeedStat');
  if (el)   el.textContent   = label + '/тик';
  if (stat) stat.textContent = label;
}

function setSliderValue(ms) {
  const s = document.getElementById('speedSlider');
  if (s) s.value = ms;
  updateSpeedLabel(ms);
}

async function loadTickSpeed() {
  const data = await api('GET', '/api/admin/tick-speed');
  if (data.ms) setSliderValue(data.ms);
}

document.getElementById('speedSlider').addEventListener('input', function () {
  updateSpeedLabel(parseInt(this.value));
  clearTimeout(sliderDebounce);
  sliderDebounce = setTimeout(async () => {
    await api('POST', '/api/admin/set-tick-speed', { ms: parseInt(this.value) });
  }, 400);
});

socket.on('tickSpeedChanged', ({ ms }) => setSliderValue(ms));

// ── ТАБЛИЦА ИГРОКОВ (динамические колонки) ───────────────────────────────────
function renderPlayers() {
  const thead = document.getElementById('playersHead');
  const tbody = document.getElementById('adminPlayersBody');
  if (!thead || !tbody) return;

  // Заголовок — динамический по COINS
  thead.innerHTML = `<tr>
    <th>Игрок</th>
    <th>Наличные</th>
    <th>Долг</th>
    ${COINS.map(c => {
      const m = coinMeta[c] || {};
      const isCustom = m.isCustom || !BASE_COINS.includes(c);
      return `<th title="${m.name || c}">${isCustom ? (m.emoji || '🪙') + ' ' : ''}${c}</th>`;
    }).join('')}
    <th>Статус</th>
    <th>Действия</th>
  </tr>`;

  const players = allWallets.filter(w => w.username !== 'WARDEN');

  if (!players.length) {
    tbody.innerHTML = `<tr><td colspan="${COINS.length + 5}" style="text-align:center;color:var(--mu);padding:20px">
      Данных пока нет. Игроки ещё не зарегистрировались.
    </td></tr>`;
    return;
  }

  const sorted = [...players].sort((a, b) => {
    const tA = a.usd + COINS.reduce((s,c) => s + (a[c]||0)*(prices[c]||0), 0);
    const tB = b.usd + COINS.reduce((s,c) => s + (b[c]||0)*(prices[c]||0), 0);
    return tB - tA;
  });

  tbody.innerHTML = sorted.map(w => {
    const debt     = allLoans.filter(l => l.username === w.username).reduce((s,l) => s + l.due, 0);
    const isSystem = w.username === 'admin';
    return `<tr>
      <td><strong>${w.username}</strong></td>
      <td class="up">$${fmt(w.usd)}</td>
      <td class="${debt > 0 ? 'dn' : ''}">$${fmt(debt)}</td>
      ${COINS.map(c => `<td style="font-size:12px;color:var(--mu);font-variant-numeric:tabular-nums">
        ${(w[c]||0) > 0 ? fmt(w[c], coinDec(c)) : '<span style="color:var(--fa)">—</span>'}
      </td>`).join('')}
      <td><span class="badge ${debt > 0 ? 'badge-warn' : 'badge-ok'}">
        ${debt > 0 ? 'Долг $' + fmt(debt) : 'OK ✓'}
      </span></td>
      <td>${isSystem ? '' : `<button class="btn btn-dan btn-sm" onclick="deletePlayer('${w.username}')" title="Удалить аккаунт">🗑️</button>`}</td>
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
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--mu);padding:20px">Активных кредитов нет</td></tr>`;
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

// ── КОТИРОВКИ ────────────────────────────────────────────────────────────────
function renderPrices() {
  const tbody = document.getElementById('priceRows');
  if (!tbody) return;
  tbody.innerHTML = COINS.map(c => {
    const m        = coinMeta[c] || {};
    const dec      = priceDec(c);
    const driftPct = (m.drift || 0) * 100;
    const driftStr = driftPct === 0 ? '—'
      : `<span class="${driftPct > 0 ? 'up' : 'dn'}">${driftPct > 0 ? '+' : ''}${driftPct.toFixed(1)}%</span>`;
    const isCustom = m.isCustom || !BASE_COINS.includes(c);
    return `<tr>
      <td><strong>${isCustom ? (m.emoji || '🪙') + ' ' : ''}${c}</strong></td>
      <td style="font-variant-numeric:tabular-nums">$${fmt(prices[c] || 0, dec)}</td>
      <td>${driftStr}</td>
    </tr>`;
  }).join('');
}

// ── ЛЕНТА ────────────────────────────────────────────────────────────────────
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

// ── SELECT ИГРОКОВ ───────────────────────────────────────────────────────────
function fillPlayerSelect() {
  const sel = document.getElementById('cashUsername');
  if (!sel) return;
  const players = allWallets
    .filter(w => w.username !== 'WARDEN')
    .sort((a, b) => a.username.localeCompare(b.username));
  sel.innerHTML = players.length
    ? players.map(w => `<option value="${w.username}">${w.username} (баланс: $${fmt(w.usd)})</option>`).join('')
    : '<option disabled>Нет игроков</option>';
}

// ── ЗАГРУЗКА ВСЕХ ДАННЫХ ─────────────────────────────────────────────────────
async function loadAdminData() {
  const [adminData, stateData, coinsData] = await Promise.all([
    api('GET', '/api/admin/players'),
    api('GET', '/api/state'),
    api('GET', '/api/admin/coins'),
  ]);

  if (!adminData.error) {
    allWallets = adminData.wallets || [];
    allLoans   = adminData.loans   || [];
  }

  if (!coinsData.error) {
    coinMeta = coinsData;
  }

  if (!stateData.error) {
    prices = stateData.prices || {};
    if (stateData.coins) COINS = stateData.coins;
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
  renderCoinParams();
  fillPlayerSelect();
}

// ── КНОПКИ ───────────────────────────────────────────────────────────────────
document.getElementById('tickBtn').addEventListener('click', async () => {
  const btn = document.getElementById('tickBtn');
  btn.disabled = true; btn.textContent = '⏳ Обновление...';
  await api('POST', '/api/admin/tick');
  await loadAdminData();
  btn.disabled = false; btn.textContent = '🔄 Принудительно обновить цены';
});

document.getElementById('resetBtn').addEventListener('click', () => {
  if (confirm('Сброс рынка не реализован на сервере. Хотите сделать принудительный тик вместо?')) {
    document.getElementById('tickBtn').click();
  }
});

document.getElementById('setCashForm').addEventListener('submit', async e => {
  e.preventDefault();
  const username = document.getElementById('cashUsername').value;
  const usd      = parseFloat(document.getElementById('cashAmount').value);
  if (!username || isNaN(usd)) return;
  const btn = e.submitter;
  btn.disabled = true; btn.textContent = '⏳...';
  await api('POST', '/api/admin/set-cash', { username, usd });
  await loadAdminData();
  btn.disabled = false; btn.textContent = 'Применить';
});

document.getElementById('adminLogoutBtn').addEventListener('click', async () => {
  await api('POST', '/auth/logout');
  window.location.href = '/';
});

// ── SOCKET ───────────────────────────────────────────────────────────────────
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
  renderPlayers();
  COINS.forEach(coin => {
    const row = document.getElementById(`coin-row-${coin}`);
    if (row && row.cells[1]) {
      row.cells[1].textContent = '$' + fmt(prices[coin] || 0, priceDec(coin));
    }
  });
});

socket.on('coinsUpdated', ({ coins }) => {
  COINS = coins;
  loadAdminData();
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
  loadAdminData();
});

socket.on('walletUpdate', () => loadAdminData());

// ── ИНИЦИАЛИЗАЦИЯ ─────────────────────────────────────────────────────────────
api('GET', '/auth/me').then(res => {
  if (!res.username || res.role !== 'admin') {
    window.location.href = '/';
    return;
  }
  const el = document.getElementById('adminName');
  if (el) el.textContent = res.username;
  loadAdminData();
  loadTickSpeed();
});
