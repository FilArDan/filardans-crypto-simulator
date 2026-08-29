/* ===== CHART — Multiplayer (TradingView Lightweight Charts) ===== */
const BASE_COIN_COLORS = {
  BTC:  '#f7931a',
  ETH:  '#627eea',
  SOL:  '#9945ff',
  XRP:  '#00aae4',
  DOGE: '#c2a633'
};

// Длительность одной свечи в миллисекундах (агрегация тиков в OHLC-бар)
const CANDLE_INTERVAL_MS = 30_000;
const MAX_HISTORY_POINTS = 3000; // ~хватает на много часов при обычной скорости тиков

function coinColor(ticker) {
  if (BASE_COIN_COLORS[ticker]) return BASE_COIN_COLORS[ticker];
  let hash = 0;
  for (let i = 0; i < ticker.length; i++) {
    hash = ticker.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = ((hash % 360) + 360) % 360;
  return `hsl(${hue}, 65%, 58%)`;
}

// Храним полную историю: { price, ts }
const priceHistory = {};
let selectedCoin = 'BTC';
let chart        = null;
let series       = null;
let chartMode    = 'line'; // 'line' | 'candles'
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
  const now = Date.now();
  chartCoins.forEach(c => {
    if (prices[c] != null) {
      if (!priceHistory[c]) priceHistory[c] = [];
      priceHistory[c].push({ price: prices[c], ts: now });
      if (priceHistory[c].length > MAX_HISTORY_POINTS) {
        priceHistory[c].splice(0, priceHistory[c].length - MAX_HISTORY_POINTS);
      }
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
        priceHistory[coin] = data.map((d, i) => {
          if (typeof d === 'number') {
            return { price: d, ts: Date.now() - (data.length - i) * 1000 };
          }
          return { price: Number(d.price), ts: Number(d.ts) };
        }).filter(d => Number.isFinite(d.price) && Number.isFinite(d.ts));
      }
    } catch (_) { /* нет доступа — пропускаем */ }
  }
}

// ── Обработка события очистки истории от сервера ─────────────────────────────
function handlePriceHistoryCleared(coin) {
  if (coin === null) {
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

// ── Переключатель режима (Линия / Свечи) ──────────────────────────────────────
function renderChartModeToggle() {
  const wrap = document.getElementById('chartModeToggle');
  if (!wrap) return;
  wrap.innerHTML = `
    <button class="chart-mode-btn${chartMode === 'line' ? ' on' : ''}" onclick="setChartMode('line')">Линия</button>
    <button class="chart-mode-btn${chartMode === 'candles' ? ' on' : ''}" onclick="setChartMode('candles')">Свечи</button>
  `;
}

function setChartMode(mode) {
  if (mode === chartMode) return;
  chartMode = mode;
  renderChartModeToggle();
  createChartInstance();
  renderChart();
}

async function initChart() {
  await loadSavedHistory();
  renderChartTabs();
  renderChartModeToggle();
  createChartInstance();
  renderChart();
}

function selectCoin(coin) {
  selectedCoin = coin;
  document.querySelectorAll('.ctab').forEach(b =>
    b.classList.toggle('on', b.dataset.coin === coin));
  renderChart();
}

function getHistory(coin) {
  return (priceHistory[coin] || []).filter(d => typeof d.price === 'number' && isFinite(d.price));
}

function toLwcTime(ts) {
  return Math.floor(ts / 1000);
}

function formatTickTime(ts) {
  const d = new Date(ts);
  return d.toLocaleString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ── Агрегация тиков в OHLC-свечи ───────────────────────────────────────────────
function aggregateCandles(history, bucketMs) {
  if (!history.length) return [];
  const buckets = new Map();

  history.forEach(d => {
    const bucketStart = Math.floor(d.ts / bucketMs) * bucketMs;
    let bar = buckets.get(bucketStart);
    if (!bar) {
      bar = { time: toLwcTime(bucketStart), open: d.price, high: d.price, low: d.price, close: d.price };
      buckets.set(bucketStart, bar);
    } else {
      bar.high = Math.max(bar.high, d.price);
      bar.low  = Math.min(bar.low, d.price);
      bar.close = d.price;
    }
  });

  return Array.from(buckets.values()).sort((a, b) => a.time - b.time);
}

function getUpDownColors() {
  const cs = getComputedStyle(document.documentElement);
  const up = cs.getPropertyValue('--ok').trim()  || '#26a69a';
  const dn = cs.getPropertyValue('--dan').trim() || '#ef5350';
  return { up, dn };
}

// ── Создание инстанса графика ──────────────────────────────────────────────────
function createChartInstance() {
  const container = document.getElementById('priceChart');
  if (!container) return;

  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  const gc   = dark ? 'rgba(255,255,255,.07)' : 'rgba(0,0,0,.07)';
  const tc   = dark ? '#797876' : '#9a9790';

  if (chart) { chart.remove(); chart = null; series = null; }

  chart = LightweightCharts.createChart(container, {
    layout: {
      background: { type: 'solid', color: 'transparent' },
      textColor: tc,
    },
    grid: {
      vertLines: { color: gc },
      horzLines: { color: gc },
    },
    rightPriceScale: { borderColor: gc },
    timeScale: {
      borderColor: gc,
      timeVisible: true,
      secondsVisible: chartMode === 'line',
      tickMarkFormatter: (time) => {
        const d = new Date(time * 1000);
        return d.getHours().toString().padStart(2,'0') + ':' +
               d.getMinutes().toString().padStart(2,'0');
      },
    },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    autoSize: true,
  });

  const col = coinColor(selectedCoin);

  if (chartMode === 'candles') {
    const { up, dn } = getUpDownColors();
    series = chart.addSeries(LightweightCharts.CandlestickSeries, {
      upColor: up,
      downColor: dn,
      borderUpColor: up,
      borderDownColor: dn,
      wickUpColor: up,
      wickDownColor: dn,
      priceFormat: {
        type: 'custom',
        formatter: (v) => '$' + Number(v).toLocaleString('ru', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      },
    });
  } else {
    series = chart.addSeries(LightweightCharts.AreaSeries, {
      lineColor: col,
      topColor: col.startsWith('hsl') ? col.replace(')', ', 0.25)').replace('hsl(', 'hsla(') : col + '40',
      bottomColor: col.startsWith('hsl') ? col.replace(')', ', 0.02)').replace('hsl(', 'hsla(') : col + '05',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      priceFormat: {
        type: 'custom',
        formatter: (v) => '$' + Number(v).toLocaleString('ru', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      },
    });
  }

  // Свой тултип поверх canvas
  let tooltip = container.querySelector('#lwcTooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.id = 'lwcTooltip';
    container.style.position = 'relative';
    container.appendChild(tooltip);
  }
  tooltip.style.cssText = `
    position:absolute; display:none; pointer-events:none; z-index:20;
    padding:8px 10px; border-radius:8px; font-size:13px; font-weight:700;
    background:${dark ? '#23211f' : '#fff'}; color:${dark ? '#cdccca' : '#28251d'};
    border:1px solid ${gc}; box-shadow:0 4px 12px rgba(0,0,0,.15);
  `;

  chart.subscribeCrosshairMove(param => {
    if (!param.point || !param.time || !series) {
      tooltip.style.display = 'none';
      return;
    }
    const data = param.seriesData.get(series);
    if (!data) { tooltip.style.display = 'none'; return; }

    const timeStr = formatTickTime(param.time * 1000);
    let text;
    if (chartMode === 'candles') {
      const fmt = v => Number(v).toLocaleString('ru', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      text = `${selectedCoin} · O ${fmt(data.open)} H ${fmt(data.high)} L ${fmt(data.low)} C ${fmt(data.close)} · ${timeStr}`;
    } else {
      const price = data.value !== undefined ? data.value : data.close;
      text = `${selectedCoin} · $${Number(price).toLocaleString('ru',{minimumFractionDigits:2,maximumFractionDigits:2})} · ${timeStr}`;
    }
    tooltip.innerHTML = text;
    tooltip.style.display = 'block';

    const x = Math.min(Math.max(param.point.x, 0), container.clientWidth - tooltip.offsetWidth - 10);
    const y = Math.max(param.point.y - 40, 0);
    tooltip.style.left = x + 'px';
    tooltip.style.top  = y + 'px';
  });
}

function renderChart() {
  if (!chart || !series) createChartInstance();

  const hist = getHistory(selectedCoin);

  if (chartMode === 'candles') {
    const bars = aggregateCandles(hist, CANDLE_INTERVAL_MS);
    series.setData(bars);
  } else {
    const col = coinColor(selectedCoin);
    series.applyOptions({
      lineColor: col,
      topColor: col.startsWith('hsl') ? col.replace(')', ', 0.25)').replace('hsl(', 'hsla(') : col + '40',
      bottomColor: col.startsWith('hsl') ? col.replace(')', ', 0.02)').replace('hsl(', 'hsla(') : col + '05',
    });

    const points = hist.map(d => ({ time: toLwcTime(d.ts), value: d.price }));
    const dedup = [];
    let lastTime = -Infinity;
    points.forEach(p => {
      if (p.time <= lastTime) p.time = lastTime + 1;
      dedup.push(p);
      lastTime = p.time;
    });
    series.setData(dedup);
  }

  chart.timeScale().fitContent();

  const info = document.getElementById('cinfo');
  if (info) {
    const last = hist.length ? hist[hist.length - 1] : null;
    info.textContent = last != null
      ? `${selectedCoin} · $${Number(last.price).toLocaleString('ru',{minimumFractionDigits:2,maximumFractionDigits:2})} · ${hist.length} тиков`
      : `${selectedCoin} · ожидание данных…`;
  }
}

function updateChartLive() {
  if (!series || !chart) return;
  const hist = getHistory(selectedCoin);
  if (!hist.length) return;
  const last = hist[hist.length - 1];

  if (chartMode === 'candles') {
    const bucketStart = Math.floor(last.ts / CANDLE_INTERVAL_MS) * CANDLE_INTERVAL_MS;
    const time = toLwcTime(bucketStart);
    const inBucket = hist.filter(d => Math.floor(d.ts / CANDLE_INTERVAL_MS) * CANDLE_INTERVAL_MS === bucketStart);
    const bar = {
      time,
      open: inBucket[0].price,
      high: Math.max(...inBucket.map(d => d.price)),
      low:  Math.min(...inBucket.map(d => d.price)),
      close: inBucket[inBucket.length - 1].price,
    };
    series.update(bar);
  } else {
    series.update({ time: toLwcTime(last.ts), value: last.price });
  }

  const info = document.getElementById('cinfo');
  if (info) {
    info.textContent = `${selectedCoin} · $${Number(last.price).toLocaleString('ru',{minimumFractionDigits:2,maximumFractionDigits:2})} · ${hist.length} тиков`;
  }
}