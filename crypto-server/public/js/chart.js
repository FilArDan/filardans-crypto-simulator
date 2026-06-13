/* ===== CHART — Multiplayer ===== */
const BASE_COIN_COLORS = {
  BTC:  '#f7931a',
  ETH:  '#627eea',
  SOL:  '#9945ff',
  XRP:  '#00aae4',
  DOGE: '#c2a633'
};

function coinColor(ticker) {
  if (BASE_COIN_COLORS[ticker]) return BASE_COIN_COLORS[ticker];
  let hash = 0;
  for (let i = 0; i < ticker.length; i++) {
    hash = ticker.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = ((hash % 360) + 360) % 360;
  return `hsl(${hue}, 65%, 58%)`;
}

const priceHistory = {};
let selectedCoin = 'BTC';
let chartRange   = 40;
let chrt         = null;
let chartCoins   = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'];

function updateChartCoins(coins) {
  const prev = chartCoins;
  chartCoins = coins;
  coins.forEach(c => { if (!priceHistory[c]) priceHistory[c] = []; });
  if (!coins.includes(selectedCoin)) selectedCoin = coins[0] || 'BTC';
  const changed = prev.length !== coins.length || prev.some((c, i) => c !== coins[i]);
  if (changed) renderChartTabs();
}

function addPricePoint(prices) {
  chartCoins.forEach(c => {
    if (prices[c] != null) {
      if (!priceHistory[c]) priceHistory[c] = [];
      priceHistory[c].push(prices[c]);
    }
  });
  updateChartLive();
}

// ── Загрузка сохранённой истории с сервера ────────────────────────────────────
async function loadSavedHistory() {
  for (const coin of chartCoins) {
    try {
      const resp = await fetch(`/api/price-history?coin=${coin}&limit=500`);
      if (!resp.ok) continue;
      const data = await resp.json();
      if (Array.isArray(data) && data.length > 0) {
        priceHistory[coin] = data;
      }
    } catch (_) { /* нет доступа — пропускаем */ }
  }
}

// ── Обработка события очистки истории от сервера ─────────────────────────────
function handlePriceHistoryCleared(coin) {
  if (coin === null) {
    // Очищена вся история
    chartCoins.forEach(c => { priceHistory[c] = []; });
  } else {
    priceHistory[coin] = [];
  }
  updateChartLive();
}

// ── Табы монет (выше графика) ──────────────────────────────────────────────────
function renderChartTabs() {
  const legend = document.getElementById('chartLegend');
  if (!legend) return;

  const coinBtns = chartCoins.map(c =>
    `<button class="ctab${c === selectedCoin ? ' on' : ''}" data-coin="${c}" onclick="selectCoin('${c}')">${c}</button>`
  ).join('');

  legend.innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:8px">${coinBtns}</div>`;
}

// ── Кнопки диапазона (ниже графика) ─────────────────────────────────────────
function renderChartRanges() {
  const wrap = document.getElementById('chartRanges');
  if (!wrap) return;
  const ranges = [[20,'20'],[40,'40'],[100,'100'],[0,'Всё']];
  wrap.innerHTML = ranges.map(([n, label]) =>
    `<button class="chart-range-btn${chartRange === n ? ' on' : ''}" data-range="${n}" onclick="setChartRange(${n})">${label}</button>`
  ).join('');
}

async function initChart() {
  // Загружаем сохранённую историю перед рендером
  await loadSavedHistory();
  renderChartTabs();
  renderChartRanges();
  renderChart();
}

function selectCoin(coin) {
  selectedCoin = coin;
  document.querySelectorAll('.ctab').forEach(b =>
    b.classList.toggle('on', b.dataset.coin === coin));
  renderChart();
}

function getHistory(coin) {
  const raw = (priceHistory[coin] || []).filter(v => typeof v === 'number' && isFinite(v));
  return chartRange === 0 ? raw : raw.slice(-chartRange);
}

function renderChart() {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  const gc   = dark ? 'rgba(255,255,255,.07)' : 'rgba(0,0,0,.07)';
  const tc   = dark ? '#797876' : '#9a9790';
  const col  = coinColor(selectedCoin);
  const data = getHistory(selectedCoin);

  const info = document.getElementById('cinfo');
  if (info) {
    const last = data.length ? data[data.length - 1] : null;
    info.textContent = last != null
      ? `${selectedCoin} · $${Number(last).toLocaleString('ru',{minimumFractionDigits:2,maximumFractionDigits:2})} · ${data.length} тиков`
      : `${selectedCoin} · ожидание данных…`;
  }

  const canvas = document.getElementById('priceChart');
  if (!canvas) return;
  if (chrt) chrt.destroy();

  chrt = new Chart(canvas, {
    type: 'line',
    data: {
      labels: data.map((_, i) => i + 1),
      datasets: [{
        data,
        borderColor: col,
        backgroundColor: col.startsWith('hsl')
          ? col.replace(')', ', 0.15)').replace('hsl(', 'hsla(')
          : col + '28',
        borderWidth: 2.5,
        tension: 0.35,
        fill: true,
        pointRadius: 0,
        pointHoverRadius: 5,
        pointHoverBackgroundColor: col,
        pointHoverBorderColor: '#fff',
        pointHoverBorderWidth: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          mode: 'index',
          intersect: false,
          displayColors: false,
          callbacks: {
            title: items => `Тик ${items[0].label}`,
            label: x => `$${Number(x.parsed.y).toLocaleString('ru',{minimumFractionDigits:2,maximumFractionDigits:2})}`
          },
          backgroundColor: dark ? '#23211f' : '#fff',
          titleColor: tc,
          bodyColor: dark ? '#cdccca' : '#28251d',
          bodyFont: { weight: '700', size: 13 },
          borderColor: gc,
          borderWidth: 1,
          padding: 10
        }
      },
      scales: {
        x: { ticks: { color: tc, maxTicksLimit: 7 }, grid: { color: gc } },
        y: {
          ticks: { color: tc, callback: v => '$' + Number(v).toLocaleString('ru',{maximumFractionDigits:2}) },
          grid: { color: gc }
        }
      }
    }
  });
}

function updateChartLive() {
  if (!chrt) return;
  const data = getHistory(selectedCoin);
  const col  = coinColor(selectedCoin);
  chrt.data.labels = data.map((_, i) => i + 1);
  chrt.data.datasets[0].data = data;
  chrt.data.datasets[0].borderColor = col;
  chrt.data.datasets[0].backgroundColor = col.startsWith('hsl')
    ? col.replace(')', ', 0.15)').replace('hsl(', 'hsla(')
    : col + '28';
  chrt.update('none');

  const info = document.getElementById('cinfo');
  if (info && data.length) {
    const last = data[data.length - 1];
    info.textContent = `${selectedCoin} · $${Number(last).toLocaleString('ru',{minimumFractionDigits:2,maximumFractionDigits:2})} · ${data.length} тиков`;
  }
}

function setChartRange(n) {
  chartRange = n;
  document.querySelectorAll('.chart-range-btn').forEach(b =>
    b.classList.toggle('on', +b.dataset.range === n));
  updateChartLive();
}
