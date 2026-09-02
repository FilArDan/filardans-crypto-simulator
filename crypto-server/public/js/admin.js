const socket = io();
let prices     = {};
let coinMeta   = {};
let allWallets = [];
let allLoans   = [];
let allBots    = [];
let allCurrencies = [];
let dealCount  = 0;
let COINS      = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'];
const BASE_COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'];

const PRESET_INFO = {
  bull: { label: '🐂 Агрессор',    desc: 'Крупные сделки, высокий риск' },
  fox:  { label: '🦊 Осторожный',  desc: 'Редкие небольшие сделки' },
  croc: { label: '🐊 Накопитель',  desc: 'Накапливает, фиксирует по цели' },
};

// ── БОКОВОЕ МЕНЮ ─────────────────────────────────────────────────────────────
(function initSidebarNav() {
  const links    = document.querySelectorAll('.side-link');
  const sections = document.querySelectorAll('.admin-section');
  if (!links.length || !sections.length) return;

  function activate(id) {
    let matched = false;
    sections.forEach(s => {
      const on = s.id === `section-${id}`;
      s.hidden = !on;
      if (on) matched = true;
    });
    if (!matched) return activate('overview');
    links.forEach(l => l.classList.toggle('active', l.dataset.section === id));
    try { localStorage.setItem('adminActiveSection', id); } catch (_) {}
  }

  links.forEach(l => l.addEventListener('click', () => activate(l.dataset.section)));

  let saved = 'overview';
  try { saved = localStorage.getItem('adminActiveSection') || 'overview'; } catch (_) {}
  activate(saved);
})();

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

// Юникод-безопасный id для DOM: сохраняет буквы/цифры любого алфавита (кириллица
// в том числе), вырезает только реально проблемные для id/селекторов символы —
// иначе разные игроки/боты с именами одной длины (напр. "Игорь" и "Артур")
// схлопываются в один и тот же id, и элементы начинают путаться местами.
function safeIdFor(str) { return String(str || '').replace(/[^\p{L}\p{N}]/gu, '_'); }

function coinDec(c)  { return BASE_COINS.includes(c) ? 5 : 3; }
function priceDec(c) {
  const p = prices[c] || 0;
  if (p >= 10000) return 2;
  if (p >= 100)   return 2;
  if (p >= 1)     return 3;
  if (p >= 0.01)  return 4;
  return 5;
}

// ── БАНК (EXCHANGE) ───────────────────────────────────────────────────────────
let exchangeUsd = 0;

function renderBankCard(usd, totalIssued, totalDebt) {
  if (usd !== undefined) exchangeUsd = usd;

  // Если значения не переданы явно — рассчитываем из allWallets/allLoans
  if (usd === undefined) {
    const exchange = allWallets.find(w => w.username === 'EXCHANGE');
    if (exchange) exchangeUsd = exchange.usd || 0;
  }
  const issued = totalIssued !== undefined
    ? totalIssued
    : allLoans.reduce((s, l) => s + (l.amount || 0), 0);
  const debt = totalDebt !== undefined
    ? totalDebt
    : allLoans.reduce((s, l) => s + (l.due || 0), 0);

  const elBal    = document.getElementById('bankBalance');
  const elIssued = document.getElementById('bankIssued');
  const elDebt   = document.getElementById('bankDebt');

  if (elBal)    elBal.textContent    = '$' + fmt(exchangeUsd);
  if (elIssued) elIssued.textContent = '$' + fmt(issued);
  if (elDebt)   elDebt.textContent   = '$' + fmt(debt);
}

// ── АКТИВЫ БИРЖИ ─────────────────────────────────────────────────────────────
async function loadExchangeAssets() {
  const res = await api('GET', '/api/admin/exchange-assets');
  if (res.error) return;

  const elUsd       = document.getElementById('exchUsd');
  const elCoinValue = document.getElementById('exchCoinValue');
  const elTotal     = document.getElementById('exchTotal');
  const tbody       = document.getElementById('exchangeAssetsBody');

  if (elUsd)       elUsd.textContent       = '$' + fmt(res.usd);
  if (elCoinValue) elCoinValue.textContent = '$' + fmt(res.totalCoinValue);
  if (elTotal)     elTotal.textContent     = '$' + fmt(res.totalAssets);

  if (!tbody) return;

  if (!res.coinAssets || !res.coinAssets.length) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--mu);padding:16px">Нет монет</td></tr>`;
    return;
  }

  tbody.innerHTML = res.coinAssets.map(a => {
    const dec      = priceDec(a.coin);
    const qtyDec   = BASE_COINS.includes(a.coin) ? 4 : 2;
    const qtyClass = a.qty <= 0 ? 'qty-zero' : '';
    return `<tr>
      <td>
        <div class="coin-cell">
          <strong>${a.coin}</strong>
          <span style="color:var(--mu);font-size:11px">${a.name}</span>
        </div>
      </td>
      <td style="text-align:right" class="${qtyClass}">${fmt(a.qty, qtyDec)}</td>
      <td style="text-align:right">$${fmt(a.price, dec)}</td>
      <td style="text-align:right">${a.usdValue > 0 ? '$' + fmt(a.usdValue) : '<span style="color:var(--fa)">—</span>'}</td>
    </tr>`;
  }).join('');
}

// ── ПАУЗА ────────────────────────────────────────────────────────────────────
function applyPauseState(paused) {
  const statusEl  = document.getElementById('pauseStatus');
  const statusTxt = document.getElementById('pauseStatusText');
  const pauseBtn  = document.getElementById('pauseBtn');
  const resumeBtn = document.getElementById('resumeBtn');
  if (!statusEl) return;

  if (paused) {
    statusEl.classList.add('is-paused');
    statusTxt.textContent = 'На паузе';
    pauseBtn.disabled  = true;
    resumeBtn.disabled = false;
  } else {
    statusEl.classList.remove('is-paused');
    statusTxt.textContent = 'Игра идёт';
    pauseBtn.disabled  = false;
    resumeBtn.disabled = true;
  }
}

document.getElementById('pauseBtn').addEventListener('click', async () => {
  const res = await api('POST', '/api/admin/pause');
  if (res.error) { alert(res.error); return; }
  applyPauseState(true);
});

document.getElementById('resumeBtn').addEventListener('click', async () => {
  const res = await api('POST', '/api/admin/resume');
  if (res.error) { alert(res.error); return; }
  applyPauseState(false);
});

socket.on('pauseChanged', ({ paused }) => applyPauseState(paused));

// ── УДАЛЕНИЕ ИГРОКА ──────────────────────────────────────────────────────────
async function deletePlayer(username) {
  if (!confirm(`Удалить аккаунт "${username}"?\nКошелёк и все кредиты будут удалены безвозвратно.`)) return;
  const r = await fetch(`/api/admin/player/${encodeURIComponent(username)}`, { method: 'DELETE' });
  const data = await r.json();
  if (data.error) { alert(data.error); return; }
  await loadAdminData();
}

// ── СОЗДАНИЕ ИГРОКА ──────────────────────────────────────────────────────────
document.getElementById('createPlayerForm').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = document.getElementById('createPlayerBtn');
  btn.disabled = true; btn.textContent = '⏳...';
  const body = {
    username: document.getElementById('newPlayerName').value.trim(),
    password: document.getElementById('newPlayerPassword').value,
    startUsd: parseFloat(document.getElementById('newPlayerUsd').value) || 0,
  };
  const res = await api('POST', '/api/admin/player/create', body);
  if (res.error) {
    alert(res.error);
  } else {
    document.getElementById('createPlayerForm').reset();
    document.getElementById('newPlayerUsd').value = '10000';
    await loadAdminData();
  }
  btn.disabled = false; btn.textContent = 'Создать';
});

// ── СМЕНА ПАРОЛЯ ИГРОКА ──────────────────────────────────────────────────────
async function resetPlayerPassword(username) {
  const password = prompt(`Новый пароль для "${username}" (мин. 3 символа):`);
  if (!password) return;
  const res = await api('POST', '/api/admin/player/password', { username, password });
  if (res.error) { alert(res.error); return; }
  alert('Пароль обновлён ✓');
}

// ── СОЗДАНИЕ МОНЕТЫ ──────────────────────────────────────────────────────────
const BASE_COIN_DEFAULTS = {
  BTC:  { name: 'Bitcoin',  price: 45000, vol: 3,   supply: 21000000     },
  ETH:  { name: 'Ethereum', price: 2800,  vol: 4.5, supply: 120000000    },
  SOL:  { name: 'Solana',   price: 120,   vol: 7,   supply: 440000000    },
  XRP:  { name: 'XRP',      price: 0.52,  vol: 5,   supply: 45000000000  },
  DOGE: { name: 'Dogecoin', price: 0.08,  vol: 6,   supply: 140000000000 },
};

document.getElementById('newTicker').addEventListener('input', function () {
  const ticker = this.value.toUpperCase();
  const d = BASE_COIN_DEFAULTS[ticker];
  if (d) {
    document.getElementById('newName').value   = d.name;
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

// ── УДАЛЕНИЕ МОНЕТЫ ──────────────────────────────────────────────────────────
async function deleteCoin(ticker) {
  const isBase = BASE_COINS.includes(ticker);
  const warn = isBase
    ? `\n\n⚠️ Это базовая монета. После удаления её можно восстановить через форму создания (тикер ${ticker}).`
    : '';
  if (!confirm(`Удалить монету ${ticker}?\n\nИгрокам будут возвращены USD по текущей цене.${warn}`)) return;
  const r = await fetch(`/api/admin/coin/${encodeURIComponent(ticker)}`, { method: 'DELETE' });
  const data = await r.json();
  if (data.error) { alert(data.error); return; }
  if (data.coins) COINS = data.coins;
  await loadAdminData();
}

// ── ОЧИСТКА ИСТОРИИ ЦЕН ──────────────────────────────────────────────────────
async function clearCoinHistory(ticker) {
  if (!confirm(`Очистить историю цен для ${ticker}?\nЧарт этой монеты обнулится у всех игроков.`)) return;
  const r = await fetch(`/api/admin/price-history/${encodeURIComponent(ticker)}`, { method: 'DELETE' });
  const data = await r.json();
  if (data.error) { alert(data.error); return; }
}

async function clearAllHistory() {
  if (!confirm('Очистить историю цен ВСЕХ монет?\n\nЧарты обнулятся у всех игроков. Это действие нельзя отменить.')) return;
  const btn = document.getElementById('clearAllHistoryBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳...'; }
  const r = await fetch('/api/admin/price-history', { method: 'DELETE' });
  const data = await r.json();
  if (data.error) { alert(data.error); }
  if (btn) { btn.disabled = false; btn.textContent = '🗑️ Очистить всю историю цен'; }
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
    const driftCol = driftPct > 0 ? 'var(--ok)' : driftPct < 0 ? 'var(--dan)' : 'var(--mu)';
    const isCustom = m.isCustom || !BASE_COINS.includes(coin);
    const isBase   = BASE_COINS.includes(coin) && !m.isCustom;
    const label    = isBase
      ? `<strong>${coin}</strong>`
      : `${coin} <span class="tag-custom">custom</span>`;

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
              lbl.style.color=v>0?'var(--ok)':v<0?'var(--dan)':'var(--mu)';
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
        <button class="btn btn-warn btn-sm" onclick="clearCoinHistory('${coin}')" title="Очистить историю цен">📉</button>
        <button class="btn btn-dan btn-sm" onclick="deleteCoin('${coin}')" title="Удалить монету">🗑️</button>
      </td>
    </tr>`;
  }).join('');

  // Кнопка глобальной очистки (рендерим под таблицей если её ещё нет)
  const wrap = document.getElementById('coinParamsWrap');
  if (wrap && !document.getElementById('clearAllHistoryBtn')) {
    const div = document.createElement('div');
    div.style.cssText = 'margin-top:12px;display:flex;justify-content:flex-end';
    div.innerHTML = `<button id="clearAllHistoryBtn" class="btn btn-dan" onclick="clearAllHistory()">🗑️ Очистить всю историю цен</button>`;
    wrap.appendChild(div);
  }
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

// ── БОТЫ ─────────────────────────────────────────────────────────────────────
function renderBots() {
  const grid = document.getElementById('botsGrid');
  if (!grid) return;

  if (!allBots.length) {
    grid.innerHTML = `<div style="color:var(--mu);font-size:13px;padding:8px 0">Ботов пока нет. Создай через форму ниже.</div>`;
    return;
  }

  grid.innerHTML = allBots.map(bot => {
    const pInfo = PRESET_INFO[bot.botType] || { label: bot.botType, desc: '' };
    const presetBtns = Object.entries(PRESET_INFO).map(([key, info]) =>
      `<button class="preset-btn ${bot.botType === key ? 'active' : ''}" onclick="setBotPreset('${bot.username}','${key}')">${info.label}</button>`
    ).join('');
    const safeId = safeIdFor(bot.username);

    return `
    <div class="bot-card" id="bot-card-${safeId}">
      <div class="bot-avatar">${bot.botEmoji}</div>
      <div class="bot-info">
        <div class="bot-name">${bot.username}</div>
        <div class="bot-meta">${pInfo.desc}</div>
      </div>
      <div class="bot-total">$${fmt(bot.total)}</div>
      <div class="bot-actions">
        <div class="preset-group">${presetBtns}</div>
        <div style="display:flex;gap:6px;align-items:center">
          <input type="number" class="bot-cash-input" id="bot-cash-${safeId}"
            value="${bot.usd}" min="0" step="100" title="Установить USD">
          <button class="btn btn-secondary btn-sm" onclick="setBotCashAdmin('${bot.username}')">💰</button>
          <button class="btn btn-secondary btn-sm" onclick="toggleBotHoldings('${safeId}')" title="Редактировать монеты">Активы</button>
          <button class="btn btn-dan btn-sm" onclick="deleteBotAdmin('${bot.username}')" title="Удалить бота">🗑️</button>
        </div>
      </div>
      <div id="bot-holdings-${safeId}" style="display:none;width:100%;flex-wrap:wrap;gap:10px;align-items:flex-end;padding-top:10px;margin-top:6px;border-top:1px solid var(--bd)">
        ${COINS.map(c => `<label class="fld" style="margin:0">${c}
          <input type="number" class="coin-input" id="bot-held-${safeId}-${c}" value="${(bot.held && bot.held[c]) || 0}" min="0" step="any" style="width:110px">
        </label>`).join('')}
        <button class="btn btn-secondary btn-sm" onclick="saveBotHoldings('${bot.username}','${safeId}')">Сохранить</button>
      </div>
    </div>`;
  }).join('');
}

function toggleBotHoldings(safeId) {
  const el = document.getElementById(`bot-holdings-${safeId}`);
  if (el) el.style.display = el.style.display === 'none' ? 'flex' : 'none';
}

async function saveBotHoldings(name, safeId) {
  const held = {};
  COINS.forEach(c => {
    const input = document.getElementById(`bot-held-${safeId}-${c}`);
    if (input) held[c] = input.value;
  });
  const res = await api('POST', '/api/admin/bot/holdings', { name, held });
  if (res.error) { alert(res.error); return; }
  await loadBotsData();
}

function updateBotTotals() {
  allBots.forEach(bot => {
    const coinValue = Object.entries(bot.held || {}).reduce(
      (sum, [coin, amt]) => sum + (amt || 0) * (prices[coin] || 0), 0
    );
    bot.total = (bot.usd || 0) + coinValue;

    const safeId  = safeIdFor(bot.username);
    const card    = document.getElementById(`bot-card-${safeId}`);
    if (!card) return;
    const totalEl = card.querySelector('.bot-total');
    if (totalEl) totalEl.textContent = '$' + fmt(bot.total);
  });
}

async function setBotPreset(name, type) {
  const res = await api('POST', '/api/admin/bot/preset', { name, type });
  if (res.error) { alert(res.error); return; }
  await loadBotsData();
}

async function setBotCashAdmin(name) {
  const safeId = safeIdFor(name);
  const input  = document.getElementById(`bot-cash-${safeId}`);
  const usd    = parseFloat(input?.value);
  if (isNaN(usd) || usd < 0) return;
  const res = await api('POST', '/api/admin/bot/cash', { name, usd });
  if (res.error) { alert(res.error); return; }
  await loadBotsData();
}

async function deleteBotAdmin(name) {
  if (!confirm(`Удалить бота "${name}"?`)) return;
  const r   = await fetch(`/api/admin/bot/${encodeURIComponent(name)}`, { method: 'DELETE' });
  const res = await r.json();
  if (res.error) { alert(res.error); return; }
  await loadBotsData();
}

document.getElementById('createBotForm').addEventListener('submit', async e => {
  e.preventDefault();
  const btn  = document.getElementById('createBotBtn');
  btn.disabled = true; btn.textContent = '⏳...';
  const body = {
    name: document.getElementById('newBotName').value.trim(),
    type: document.getElementById('newBotType').value,
    usd:  parseFloat(document.getElementById('newBotUsd').value) || 0,
  };
  const res = await api('POST', '/api/admin/bot/create', body);
  if (res.error) {
    alert(res.error);
  } else {
    document.getElementById('createBotForm').reset();
    document.getElementById('newBotUsd').value = '10000';
    await loadBotsData();
  }
  btn.disabled = false; btn.textContent = 'Создать';
});

async function loadBotsData() {
  const res = await api('GET', '/api/admin/bots');
  if (!res.error) {
    allBots = res;
    renderBots();
  }
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

// ── ТАБЛИЦА ИГРОКОВ ──────────────────────────────────────────────────────────
function renderPlayers() {
  const thead = document.getElementById('playersHead');
  const tbody = document.getElementById('adminPlayersBody');
  if (!thead || !tbody) return;

  thead.innerHTML = `<tr>
    <th>Игрок</th>
    <th>Наличные</th>
    <th>Долг</th>
    ${COINS.map(c => {
      const m = coinMeta[c] || {};
      return `<th title="${m.name || c}">${c}</th>`;
    }).join('')}
    <th>Статус</th>
    <th>Действия</th>
  </tr>`;

  const players = allWallets.filter(w => w.username !== 'WARDEN' && w.username !== 'EXCHANGE' && !w.username.startsWith('UNION_'));

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
    const safeId   = safeIdFor(w.username);
    const cur      = allCurrencies.find(c => c.nation === w.username) || { code: 'USC', name: 'Единый кредит', symbol: 'USC ', rate: 1 };
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
      <td>${isSystem ? '' : `
        <button class="btn btn-secondary btn-sm" onclick="togglePlayerWallet('${safeId}')" title="Редактировать активы">Активы</button>
        <button class="btn btn-secondary btn-sm" onclick="resetPlayerPassword('${w.username}')" title="Сменить пароль">🔑</button>
        <button class="btn btn-dan btn-sm" onclick="deletePlayer('${w.username}')" title="Удалить аккаунт">🗑️</button>
      `}</td>
    </tr>
    ${isSystem ? '' : `
    <tr id="wallet-edit-${safeId}" ${expandedPlayer === safeId ? '' : 'hidden'}>
      <td colspan="${COINS.length + 5}">
        <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;padding:8px 0">
          <label class="fld" style="margin:0">USC
            <input type="number" class="coin-input" id="wallet-${safeId}-usd" value="${w.usd}" min="0" step="1" style="width:110px">
          </label>
          ${COINS.map(c => `<label class="fld" style="margin:0">${c}
            <input type="number" class="coin-input" id="wallet-${safeId}-${c}" value="${w[c] || 0}" min="0" step="any" style="width:110px">
          </label>`).join('')}
          <button class="btn btn-secondary btn-sm" onclick="savePlayerWallet('${w.username}','${safeId}')">Сохранить</button>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;padding:8px 0;border-top:1px dashed var(--bd);margin-top:4px">
          <div class="lbl" style="margin:0;width:100%">Местная валюта государства</div>
          <label class="fld" style="margin:0">Код
            <input type="text" maxlength="8" id="cur-${safeId}-code" value="${cur.code}" style="width:70px;text-transform:uppercase">
          </label>
          <label class="fld" style="margin:0">Название
            <input type="text" maxlength="32" id="cur-${safeId}-name" value="${cur.name}" style="width:130px">
          </label>
          <label class="fld" style="margin:0">Символ
            <input type="text" maxlength="4" id="cur-${safeId}-symbol" value="${cur.symbol}" style="width:55px">
          </label>
          <label class="fld" style="margin:0">Курс (1 своя = X общих)
            <input type="number" min="0.0001" step="any" id="cur-${safeId}-rate" value="${cur.rate}" style="width:110px">
          </label>
          <button class="btn btn-secondary btn-sm" onclick="saveCurrency('${w.username}','${safeId}')">Сохранить валюту</button>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;padding:8px 0;border-top:1px dashed var(--bd);margin-top:4px">
          <div class="lbl" style="margin:0;width:100%">Точечные запреты на торговлю</div>
          <label class="fld" style="margin:0">Тикер
            <input type="text" maxlength="12" id="ban-${safeId}-ticker" placeholder="BTC" style="width:90px;text-transform:uppercase">
          </label>
          <label class="fld" style="margin:0">Причина
            <input type="text" maxlength="60" id="ban-${safeId}-reason" placeholder="по просьбе игрока" style="width:180px">
          </label>
          <button class="btn btn-dan btn-sm" onclick="addRestriction('${w.username}','${safeId}')">Запретить</button>
          ${allRestrictions.filter(r => r.username === w.username).map(r =>
            `<button class="btn btn-secondary btn-sm" onclick="removeRestriction('${r._id}')" title="${r.reason || ''} — снять запрет">✕${r.ticker}</button>`
          ).join('')}
        </div>
      </td>
    </tr>`}
    `;
  }).join('');
}

// Какая строка "Активы" сейчас развёрнута — переживает перерисовку таблицы
// (сокет-события могут дёргать renderPlayers() в фоне, пока админ её редактирует)
let expandedPlayer = null;

function togglePlayerWallet(safeId) {
  expandedPlayer = expandedPlayer === safeId ? null : safeId;
  const row = document.getElementById(`wallet-edit-${safeId}`);
  if (row) row.hidden = !row.hidden;
}

async function saveCurrency(username, safeId) {
  const body = {
    nation: username,
    code:   document.getElementById(`cur-${safeId}-code`).value,
    name:   document.getElementById(`cur-${safeId}-name`).value,
    symbol: document.getElementById(`cur-${safeId}-symbol`).value,
    rate:   document.getElementById(`cur-${safeId}-rate`).value,
  };
  const res = await api('POST', '/api/admin/currency/params', body);
  if (res.error) { alert(res.error); return; }
  await loadCurrenciesData();
  renderPlayers();
}

async function loadCurrenciesData() {
  const res = await api('GET', '/api/admin/currencies');
  if (!res.error) allCurrencies = res;
}

// ── ТОЧЕЧНЫЕ ЗАПРЕТЫ НА ТОРГОВЛЮ ─────────────────────────────────────────────
let allRestrictions = [];

async function loadRestrictionsData() {
  const res = await api('GET', '/api/admin/restrictions');
  if (!res.error) allRestrictions = res;
}

async function addRestriction(username, safeId) {
  const ticker = document.getElementById(`ban-${safeId}-ticker`).value.trim();
  const reason = document.getElementById(`ban-${safeId}-reason`).value.trim();
  if (!ticker) return;
  const res = await api('POST', '/api/admin/restriction', { username, ticker, reason });
  if (res.error) { alert(res.error); return; }
  await loadRestrictionsData();
  renderPlayers();
}

async function removeRestriction(id) {
  const r = await fetch(`/api/admin/restriction/${encodeURIComponent(id)}`, { method: 'DELETE' });
  const res = await r.json();
  if (res.error) { alert(res.error); return; }
  await loadRestrictionsData();
  renderPlayers();
}

async function savePlayerWallet(username, safeId) {
  const patch = { usd: document.getElementById(`wallet-${safeId}-usd`).value };
  COINS.forEach(c => {
    const input = document.getElementById(`wallet-${safeId}-${c}`);
    if (input) patch[c] = input.value;
  });
  const res = await api('POST', '/api/admin/player/wallet', { username, patch });
  if (res.error) { alert(res.error); return; }
  await loadAdminData();
}

// ── ТАБЛИЦА КРЕДИТОВ ─────────────────────────────────────────────────────────
function renderLoans() {
  const tbody = document.getElementById('adminLoansBody');
  if (!tbody) return;
  const el = document.getElementById('loanCount');
  if (el) el.textContent = allLoans.length;
  if (!allLoans.length) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--mu);padding:20px">Активных кредитов нет</td></tr>`;
    return;
  }
  tbody.innerHTML = allLoans.map(l => `
    <tr>
      <td><strong>${l.username}</strong>${l.isBot ? ' <span class="tag-custom">бот</span>' : ''}</td>
      <td class="up">$${fmt(l.principal)}</td>
      <td class="dn">$${fmt(l.due)}</td>
      <td style="color:var(--mu);font-size:12px">${fmtTime(l.ts)}</td>
      <td>
        <button class="btn btn-secondary btn-sm" onclick="repayLoan('${l.username}')" title="Погасить с баланса должника">Погасить</button>
        <button class="btn btn-dan btn-sm" onclick="forgiveLoan('${l.username}')" title="Списать долг без изменения баланса">Списать</button>
      </td>
    </tr>
  `).join('');
}

async function repayLoan(username) {
  const res = await api('POST', '/api/admin/loan/repay', { username });
  if (res.error) { alert(res.error); return; }
  await loadAdminData();
}

async function forgiveLoan(username) {
  if (!confirm(`Списать весь долг игрока/бота "${username}"?\nБаланс не изменится — задолженность просто аннулируется.`)) return;
  const res = await api('POST', '/api/admin/loan/forgive', { username });
  if (res.error) { alert(res.error); return; }
  await loadAdminData();
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
    return `<tr>
      <td><strong>${c}</strong></td>
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
    .filter(w => w.username !== 'WARDEN' && w.username !== 'EXCHANGE' && !w.username.startsWith('UNION_'))
    .sort((a, b) => a.username.localeCompare(b.username));
  sel.innerHTML = players.length
    ? players.map(w => `<option value="${w.username}">${w.username} (баланс: $${fmt(w.usd)})</option>`).join('')
    : '<option disabled>Нет игроков</option>';
}

// ── КОМПАНИИ ─────────────────────────────────────────────────────────────────
let allCompanies = [];

function fillCompanyOwnerSelect() {
  const sel = document.getElementById('newCompanyOwner');
  if (!sel) return;
  const players = allWallets
    .filter(w => w.username !== 'WARDEN' && w.username !== 'EXCHANGE' && !w.username.startsWith('UNION_'))
    .sort((a, b) => a.username.localeCompare(b.username));
  sel.innerHTML = players.length
    ? players.map(w => `<option value="${w.username}">${w.username}</option>`).join('')
    : '<option disabled>Нет государств</option>';
}

function renderCompanies() {
  const tbody = document.getElementById('companiesBody');
  if (!tbody) return;
  if (!allCompanies.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--mu);padding:16px">Компаний пока нет. Основай через форму ниже.</td></tr>`;
    return;
  }
  const unionOptions = allUnions.map(u => `<option value="${u.code}">${u.code}</option>`).join('');

  tbody.innerHTML = allCompanies.map(c => {
    const supply = (coinMeta[c.ticker] && coinMeta[c.ticker].supply) || 0;
    const mcap   = supply * (c.price || 0);
    const unionCodes = c.unionCodes || [];
    const accessBadge = unionCodes.length
      ? `<span class="tag-custom">${unionCodes.join(', ')}</span>`
      : `<span class="lbl-inline">приватная</span>`;
    const removeBtns = unionCodes.map(code =>
      `<button class="btn btn-dan btn-sm" onclick="removeCompanyListing('${c.ticker}','${code}')" title="Снять с биржи союза ${code}">✕${code}</button>`
    ).join('');
    return `<tr>
      <td><strong>${c.ticker}</strong></td>
      <td>${c.name}</td>
      <td>${c.ownerNation}</td>
      <td>${accessBadge}</td>
      <td>$${fmt(c.price, priceDec(c.ticker))}</td>
      <td>$${fmt(mcap)}</td>
      <td>
        <input type="number" class="coin-input" id="company-rev-${c.ticker}" value="${c.revenuePerTick}" min="0" step="any" style="width:90px">
      </td>
      <td>
        <button class="btn btn-secondary btn-sm" onclick="saveCompanyParams('${c.ticker}')">Сохранить</button>
        <button class="btn btn-dan btn-sm" onclick="deleteCompany('${c.ticker}')" title="Ликвидировать компанию">🗑️</button>
      </td>
    </tr>
    <tr>
      <td colspan="8" style="padding-top:0">
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:4px 0 10px">
          <span class="lbl-inline">Листинг на союз:</span>
          <select id="company-union-${c.ticker}" style="width:140px">${unionOptions || '<option disabled>Нет союзов</option>'}</select>
          <input type="number" id="company-float-${c.ticker}" placeholder="акций в резерв" min="0" step="1" style="width:130px">
          <button class="btn btn-secondary btn-sm" onclick="addCompanyListing('${c.ticker}')" ${allUnions.length ? '' : 'disabled'}>Вынести</button>
          ${removeBtns}
        </div>
      </td>
    </tr>`;
  }).join('');
}

async function addCompanyListing(ticker) {
  const unionCode = document.getElementById(`company-union-${ticker}`).value;
  const unionFloat = document.getElementById(`company-float-${ticker}`).value;
  const res = await api('POST', '/api/admin/company/listing', { ticker, unionCode, unionFloat });
  if (res.error) { alert(res.error); return; }
  await loadCompaniesData();
}

async function removeCompanyListing(ticker, unionCode) {
  const res = await api('POST', '/api/admin/company/listing', { ticker, unionCode, remove: true });
  if (res.error) { alert(res.error); return; }
  await loadCompaniesData();
}

async function saveCompanyParams(ticker) {
  const input = document.getElementById(`company-rev-${ticker}`);
  const revenuePerTick = input ? input.value : undefined;
  const res = await api('POST', '/api/admin/company/params', { ticker, revenuePerTick });
  if (res.error) { alert(res.error); return; }
  await loadCompaniesData();
}

async function deleteCompany(ticker) {
  if (!confirm(`Ликвидировать компанию ${ticker}?\nАкции будут выкуплены у держателей по текущей рыночной цене.`)) return;
  const r   = await fetch(`/api/admin/company/${encodeURIComponent(ticker)}`, { method: 'DELETE' });
  const res = await r.json();
  if (res.error) { alert(res.error); return; }
  await loadAdminData();
}

document.getElementById('createCompanyForm').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = document.getElementById('createCompanyBtn');
  btn.disabled = true; btn.textContent = '⏳...';
  const body = {
    ticker:         document.getElementById('newCompanyTicker').value.trim(),
    name:           document.getElementById('newCompanyName').value.trim(),
    ownerNation:    document.getElementById('newCompanyOwner').value,
    totalShares:    document.getElementById('newCompanyShares').value,
    startPrice:     document.getElementById('newCompanyPrice').value,
    statePct:       document.getElementById('newCompanyStatePct').value,
    revenuePerTick: document.getElementById('newCompanyRevenue').value,
    vol:            parseFloat(document.getElementById('newCompanyVol').value) / 100,
  };
  const res = await api('POST', '/api/admin/company/create', body);
  if (res.error) {
    alert(res.error);
  } else {
    document.getElementById('createCompanyForm').reset();
    await loadAdminData();
  }
  btn.disabled = false; btn.textContent = '🏢 Основать компанию';
});

async function loadCompaniesData() {
  const res = await api('GET', '/api/admin/companies');
  if (!res.error) {
    allCompanies = res;
    renderCompanies();
  }
}

// ── СОЮЗЫ ────────────────────────────────────────────────────────────────────
let allUnions = [];

function fillUnionMembersSelect() {
  const sel = document.getElementById('newUnionMembers');
  if (!sel) return;
  const players = allWallets
    .filter(w => w.username !== 'WARDEN' && w.username !== 'EXCHANGE' && !w.username.startsWith('UNION_'))
    .sort((a, b) => a.username.localeCompare(b.username));
  sel.innerHTML = players.length
    ? players.map(w => `<option value="${w.username}">${w.username}</option>`).join('')
    : '<option disabled>Нет государств</option>';
}

function renderUnions() {
  const tbody = document.getElementById('unionsBody');
  if (!tbody) return;
  if (!allUnions.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--mu);padding:16px">Союзов пока нет. Создай через форму ниже.</td></tr>`;
    return;
  }
  const playerOptions = allWallets
    .filter(w => w.username !== 'WARDEN' && w.username !== 'EXCHANGE' && !w.username.startsWith('UNION_'))
    .sort((a, b) => a.username.localeCompare(b.username));

  tbody.innerHTML = allUnions.map(u => `
    <tr>
      <td><strong>${u.code}</strong></td>
      <td>${u.name}</td>
      <td>${u.members.map(m => `<span class="tag-custom">${m}</span>`).join(' ')}</td>
      <td>${u.tokenSymbol} <span class="lbl-inline">(${u.tokenTicker})</span></td>
      <td>$${fmt(u.price, priceDec(u.tokenTicker))}</td>
      <td>$${fmt(u.reserveUsd)}</td>
      <td><button class="btn btn-dan btn-sm" onclick="deleteUnion('${u.code}')" title="Распустить союз">🗑️</button></td>
    </tr>
    <tr>
      <td colspan="7" style="padding-top:0">
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:4px 0 10px">
          <span class="lbl-inline">Участники:</span>
          <select id="union-member-${u.code}" style="width:160px">
            ${playerOptions.map(w => `<option value="${w.username}">${w.username}</option>`).join('')}
          </select>
          <button class="btn btn-secondary btn-sm" onclick="addUnionMember('${u.code}')">Добавить</button>
          ${u.members.map(m => `<button class="btn btn-dan btn-sm" onclick="removeUnionMember('${u.code}','${m}')" title="Исключить ${m}">✕${m}</button>`).join('')}
        </div>
      </td>
    </tr>
  `).join('');
}

async function addUnionMember(code) {
  const username = document.getElementById(`union-member-${code}`).value;
  const res = await api('POST', '/api/admin/union/member', { code, username, action: 'add' });
  if (res.error) { alert(res.error); return; }
  await loadUnionsData();
}

async function removeUnionMember(code, username) {
  const res = await api('POST', '/api/admin/union/member', { code, username, action: 'remove' });
  if (res.error) { alert(res.error); return; }
  await loadUnionsData();
}

async function deleteUnion(code) {
  if (!confirm(`Распустить союз ${code}?\nТокен будет выкуплен у держателей резервом союза, остаток резерва вернётся на биржу.`)) return;
  const r   = await fetch(`/api/admin/union/${encodeURIComponent(code)}`, { method: 'DELETE' });
  const res = await r.json();
  if (res.error) { alert(res.error); return; }
  await loadAdminData();
}

document.getElementById('createUnionForm').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = document.getElementById('createUnionBtn');
  btn.disabled = true; btn.textContent = '⏳...';
  const members = [...document.getElementById('newUnionMembers').selectedOptions].map(o => o.value);
  const body = {
    code:            document.getElementById('newUnionCode').value.trim(),
    name:            document.getElementById('newUnionName').value.trim(),
    tokenName:       document.getElementById('newUnionTokenName').value.trim(),
    tokenSymbol:     document.getElementById('newUnionTokenSymbol').value.trim(),
    tokenSupply:     document.getElementById('newUnionTokenSupply').value,
    tokenStartPrice: document.getElementById('newUnionTokenPrice').value,
    reserveUsd:      document.getElementById('newUnionReserve').value,
    members,
  };
  const res = await api('POST', '/api/admin/union/create', body);
  if (res.error) {
    alert(res.error);
  } else {
    document.getElementById('createUnionForm').reset();
    await loadAdminData();
  }
  btn.disabled = false; btn.textContent = '🤝 Создать союз';
});

async function loadUnionsData() {
  const res = await api('GET', '/api/admin/unions');
  if (!res.error) {
    allUnions = res;
    renderUnions();
    renderCompanies(); // список компаний зависит от списка союзов (select листинга)
  }
}

// ── ЗАГРУЗКА ВСЕХ ДАННЫХ ─────────────────────────────────────────────────────
// Сокет-события (walletUpdate/coinsUpdated) прилетают часто и пачками —
// особенно от торговли ботов. Без дебаунса каждое из них по отдельности
// дёргает полный набор GET-запросов ниже, что и забивает rate limiter,
// и постоянно перерисовывает таблицу игроков (схлопывая открытые панели).
let reloadDebounce = null;
function debouncedReload() {
  clearTimeout(reloadDebounce);
  reloadDebounce = setTimeout(loadAdminData, 800);
}

async function loadAdminData() {
  const [adminData, stateData, coinsData, currenciesData] = await Promise.all([
    api('GET', '/api/admin/players'),
    api('GET', '/api/state'),
    api('GET', '/api/admin/coins'),
    api('GET', '/api/admin/currencies'),
  ]);

  if (!adminData.error) {
    allWallets = adminData.wallets || [];
    allLoans   = adminData.loans   || [];
  }

  if (!currenciesData.error) allCurrencies = currenciesData;

  if (!coinsData.error) {
    coinMeta = coinsData;
  }

  if (!stateData.error) {
    prices = stateData.prices || {};
    if (stateData.coins) COINS = stateData.coins;
    if (stateData.paused !== undefined) applyPauseState(stateData.paused);
    const trades = (stateData.events || []).filter(e =>
      e.text.includes('купил') || e.text.includes('продал')
    );
    dealCount = trades.length;
    const elDeal = document.getElementById('dealCount');
    if (elDeal) elDeal.textContent = dealCount;
    renderFeed(stateData.events || []);
  }

  renderPrices();
  renderCoinParams();
  fillPlayerSelect();
  fillCompanyOwnerSelect();
  fillUnionMembersSelect();
  renderBankCard();  // без аргументов — возьмёт из allWallets/allLoans
  await loadExchangeAssets();
  await loadBotsData();
  await loadRestrictionsData();
  await loadUnionsData();
  await loadCompaniesData();
  renderPlayers();
  renderLoans();
}

// ── КНОПКИ ───────────────────────────────────────────────────────────────────
document.getElementById('tickBtn').addEventListener('click', async () => {
  const btn = document.getElementById('tickBtn');
  btn.disabled = true; btn.textContent = '⏳ Обновление...';
  await api('POST', '/api/admin/tick');
  await loadAdminData();
  btn.disabled = false; btn.textContent = '🔄 Принудительно обновить цены';
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
  updateBotTotals();
  loadExchangeAssets();
  COINS.forEach(coin => {
    const row = document.getElementById(`coin-row-${coin}`);
    if (row && row.cells[1]) {
      row.cells[1].textContent = '$' + fmt(prices[coin] || 0, priceDec(coin));
    }
  });
});

// Казна обновляется динамически на каждый тик и после любой операции с кредитами/торговлей
socket.on('bankUpdate', ({ usd, totalIssued, totalDebt }) => {
  renderBankCard(usd, totalIssued, totalDebt);
  loadExchangeAssets();
});

socket.on('coinsUpdated', ({ coins }) => {
  COINS = coins;
  debouncedReload();
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
  // Полную перезагрузку не дёргаем здесь — за реальные изменения баланса/цен
  // уже отвечают свои события (walletUpdate/priceUpdate); лента и так обновилась выше.
});

socket.on('walletUpdate', () => debouncedReload());

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
