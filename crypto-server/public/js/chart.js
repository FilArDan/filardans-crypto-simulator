/* ===== CHART — Multiplayer (TradingView Lightweight Charts) ===== */
const BASE_COIN_COLORS = {
  BTC:  '#f7931a',
  ETH:  '#627eea',
  SOL:  '#9945ff',
  XRP:  '#00aae4',
  DOGE: '#c2a633'
};

const CANDLE_INTERVAL_MS = 30_000;
const MAX_HISTORY_POINTS = 3000;

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
let seriesMap     = {}; // coin -> ISeriesApi (одна серия на монету, живёт постоянно)
let chartMode    = 'line'; // 'line' | 'candles' | 'compare'
let chartCoins   = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'];
let tooltipEl    = null;

// ── Режим «Сравнение» ──────────────────────────────────────────────────────────
// Несколько монет на одном графике, нормализованные к 100% от первой точки
// загруженной истории — так сравнивается изменение в процентах, а не
// абсолютная цена (иначе BTC по $40000 визуально задавил бы DOGE по $0,07).
let compareCoins     = new Set();
let compareBaselines = {}; // coin -> цена первой точки, зафиксированная на момент rebuild

function updateChartCoins(coins) {
  const prev = chartCoins;
  chartCoins = coins;
  coins.forEach(c => { if (!priceHistory[c]) priceHistory[c] = []; });
  if (!coins.includes(selectedCoin)) selectedCoin = coins[0] || 'BTC';
  const changed = prev.length !== coins.length || prev.some((c, i) => c !== coins[i]);
  if (changed) {
    renderChartTabs();
    if (chart) ensureAllSeries(); // создать серии для новых монет, если появились
  }
}

function addPricePoint(prices) {
  const now = Date.now();
  chartCoins.forEach(c => {
    if (prices[c] == null) return;
    if (!priceHistory[c]) priceHistory[c] = [];
    priceHistory[c].push({ price: prices[c], ts: now });
    if (priceHistory[c].length > MAX_HISTORY_POINTS) {
      priceHistory[c].splice(0, priceHistory[c].length - MAX_HISTORY_POINTS);
    }
  });
  // Обновляем ВСЕ серии (даже скрытые) — точечно, без setData, поэтому дёшево
  updateLiveSeries();
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

function handlePriceHistoryCleared(coin) {
  if (coin === null) {
    chartCoins.forEach(c => { priceHistory[c] = []; });
  } else {
    priceHistory[coin] = [];
  }
  // Полностью пересобрать серии — здесь setData ок, это редкое разовое действие
  if (chart) rebuildAllSeriesData();
}

// ── Табы монет (выше графика) ──────────────────────────────────────────────────
// В режиме «Сравнение» табы работают как чекбоксы (мультивыбор), а не
// переключатель одной активной монеты.
function renderChartTabs() {
  const legend = document.getElementById('chartLegend');
  if (!legend) return;
  const compare = chartMode === 'compare';
  // Табы монет раньше были всегда скрыты (страница актива держит фокус на
  // одной монете) — единственный режим, где выбор нескольких монет вообще
  // имеет смысл, это сравнение, поэтому показываем панель только тогда.
  legend.style.display = compare ? '' : 'none';
  const coinBtns = chartCoins.map(c => {
    const on      = compare ? compareCoins.has(c) : c === selectedCoin;
    const handler = compare ? `toggleCompareCoin('${c}')` : `selectCoin('${c}')`;
    return `<button class="ctab${on ? ' on' : ''}" data-coin="${c}" onclick="${handler}">${c}</button>`;
  }).join('');
  legend.innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:8px">${coinBtns}</div>`;
}

// ── Переключатель режима (Линия / Свечи / Сравнение) ──────────────────────────
function renderChartModeToggle() {
  const wrap = document.getElementById('chartModeToggle');
  if (!wrap) return;
  wrap.innerHTML = `
    <button class="chart-mode-btn${chartMode === 'line' ? ' on' : ''}" onclick="setChartMode('line')">Линия</button>
    <button class="chart-mode-btn${chartMode === 'candles' ? ' on' : ''}" onclick="setChartMode('candles')">Свечи</button>
    <button class="chart-mode-btn${chartMode === 'compare' ? ' on' : ''}" onclick="setChartMode('compare')">Сравнение</button>
  `;
}

function setChartMode(mode) {
  if (mode === chartMode) return;
  chartMode = mode;
  if (mode === 'compare' && compareCoins.size === 0) compareCoins.add(selectedCoin);
  renderChartModeToggle();
  renderChartTabs(); // смысл "on"/клика на табах меняется вместе с режимом
  createChartInstance(); // пересоздаём все серии, т.к. тип серии зависит от режима
}

// ── Переключение монеты в режиме «Сравнение»: мультивыбор, минимум одна ──────
function toggleCompareCoin(coin) {
  if (compareCoins.has(coin)) {
    if (compareCoins.size <= 1) return; // держим на графике хотя бы одну монету
    compareCoins.delete(coin);
  } else {
    compareCoins.add(coin);
  }
  renderChartTabs();
  Object.entries(seriesMap).forEach(([c, s]) => s.applyOptions({ visible: compareCoins.has(c) }));
  rebuildAllSeriesData(); // набор монет поменялся — пересчитываем нормализацию
  updateInfoLabel();
}

async function initChart() {
  await loadSavedHistory();
  renderChartTabs();
  renderChartModeToggle();
  createChartInstance();
}

// ── Переключение монеты: ТОЛЬКО смена видимости, без setData ─────────────────
function selectCoin(coin) {
  selectedCoin = coin;
  document.querySelectorAll('.ctab').forEach(b =>
    b.classList.toggle('on', b.dataset.coin === coin));

  Object.entries(seriesMap).forEach(([c, s]) => {
    s.applyOptions({ visible: c === coin });
  });

  if (chart) chart.timeScale().fitContent();
  updateInfoLabel();
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

// Схлопывает точки в одну секунду в одну (берём последнюю цену в секунде).
// Важно: НЕ сдвигаем время вперёд искусственно (как раньше), иначе время в
// setData() расходится с реальным временем, которое шлёт updateLiveSeries()
// через series.update() — а Lightweight Charts требует строго неубывающее
// время и кидает исключение, если live-апдейт приходит с временем меньше
// уже отрисованного. Именно это "ронял" линейный график после переключения
// с свечей на линию.
function dedupAscending(points) {
  const out = [];
  points.forEach(p => {
    const point = { ...p };
    const last = out[out.length - 1];
    if (last && point.time === last.time) {
      out[out.length - 1] = point; // та же секунда — просто обновляем значение
    } else if (last && point.time < last.time) {
      // время не может идти назад (ts монотонны), но на всякий случай не ломаем порядок
      return;
    } else {
      out.push(point);
    }
  });
  return out;
}

// ── Создание графика и ВСЕХ серий (вызывается редко: старт + смена режима) ───
function createChartInstance() {
  const container = document.getElementById('priceChart');
  if (!container) return;

  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  const gc   = dark ? 'rgba(255,255,255,.07)' : 'rgba(0,0,0,.07)';
  const tc   = dark ? '#797876' : '#9a9790';

  if (chart) { chart.remove(); chart = null; }
  seriesMap = {};

  chart = LightweightCharts.createChart(container, {
    layout: { background: { type: 'solid', color: 'transparent' }, textColor: tc },
    grid: { vertLines: { color: gc }, horzLines: { color: gc } },
    rightPriceScale: { borderColor: gc },
    timeScale: {
      borderColor: gc,
      timeVisible: true,
      secondsVisible: chartMode !== 'candles',
      tickMarkFormatter: (time) => {
        const d = new Date(time * 1000);
        return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
      },
    },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal,
      // Свой тултип уже показывает цену серии в точке — встроенный лейбл
      // на оси дублирует его, но по Y-координате курсора (не по кривой),
      // из-за чего числа расходятся и выглядят как баг.
      horzLine: { labelVisible: false },
    },
    autoSize: true,
  });

  ensureAllSeries();
  rebuildAllSeriesData();
  setupTooltip(container, dark, gc);
  updateInfoLabel();
}

// ── Гарантирует, что для каждой монеты есть своя серия ────────────────────────
function ensureAllSeries() {
  chartCoins.forEach(c => {
    if (seriesMap[c]) return;
    seriesMap[c] = createSeriesForCoin(c);
  });
  // Удаляем серии монет, которых больше нет в chartCoins (удалённые кастомные монеты)
  Object.keys(seriesMap).forEach(c => {
    if (!chartCoins.includes(c)) {
      chart.removeSeries(seriesMap[c]);
      delete seriesMap[c];
    }
  });
}

function createSeriesForCoin(c) {
  const col = coinColor(c);

  if (chartMode === 'compare') {
    const percentFormat = {
      type: 'custom',
      formatter: (v) => (v - 100 >= 0 ? '+' : '') + (v - 100).toFixed(2) + '%',
    };
    return chart.addSeries(LightweightCharts.LineSeries, {
      visible: compareCoins.has(c),
      color: col,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      priceFormat: percentFormat,
    });
  }

  const visible = c === selectedCoin;
  const priceFormat = {
    type: 'custom',
    formatter: (v) => 'USC ' + Number(v).toLocaleString('ru', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  };

  if (chartMode === 'candles') {
    const { up, dn } = getUpDownColors();
    return chart.addSeries(LightweightCharts.CandlestickSeries, {
      visible,
      upColor: up, downColor: dn,
      borderUpColor: up, borderDownColor: dn,
      wickUpColor: up, wickDownColor: dn,
      priceFormat,
    });
  }
  return chart.addSeries(LightweightCharts.AreaSeries, {
    visible,
    lineColor: col,
    topColor: col.startsWith('hsl') ? col.replace(')', ', 0.25)').replace('hsl(', 'hsla(') : col + '40',
    bottomColor: col.startsWith('hsl') ? col.replace(')', ', 0.02)').replace('hsl(', 'hsla(') : col + '05',
    lineWidth: 2,
    priceLineVisible: false,
    lastValueVisible: true,
    priceFormat,
  });
}

// ── Полная перезаливка данных во все серии (редкая операция) ─────────────────
function rebuildAllSeriesData() {
  if (chartMode === 'compare') {
    compareBaselines = {};
    chartCoins.forEach(c => {
      const s = seriesMap[c];
      if (!s) return;
      const hist = getHistory(c);
      const baseline = hist.length ? hist[0].price : 0;
      if (!(baseline > 0)) { s.setData([]); return; }
      compareBaselines[c] = baseline;
      const points = hist.map(d => ({ time: toLwcTime(d.ts), value: (d.price / baseline) * 100 }));
      s.setData(dedupAscending(points));
    });
    if (chart) chart.timeScale().fitContent();
    return;
  }

  chartCoins.forEach(c => {
    const s = seriesMap[c];
    if (!s) return;
    const hist = getHistory(c);
    if (chartMode === 'candles') {
      s.setData(aggregateCandles(hist, CANDLE_INTERVAL_MS));
    } else {
      s.setData(dedupAscending(hist.map(d => ({ time: toLwcTime(d.ts), value: d.price }))));
    }
  });
  if (chart) chart.timeScale().fitContent();
}

// ── Точечное обновление всех серий на каждый тик (дёшево, без setData) ───────
function updateLiveSeries() {
  chartCoins.forEach(c => {
    const s = seriesMap[c];
    if (!s) return;
    const hist = getHistory(c);
    if (!hist.length) return;
    const last = hist[hist.length - 1];

    if (chartMode === 'compare') {
      const baseline = compareBaselines[c];
      if (!(baseline > 0)) return; // серии ещё не хватило точки для нормализации
      s.update({ time: toLwcTime(last.ts), value: (last.price / baseline) * 100 });
      return;
    }

    if (chartMode === 'candles') {
      const bucketStart = Math.floor(last.ts / CANDLE_INTERVAL_MS) * CANDLE_INTERVAL_MS;
      const time = toLwcTime(bucketStart);
      const inBucket = hist.filter(d => Math.floor(d.ts / CANDLE_INTERVAL_MS) * CANDLE_INTERVAL_MS === bucketStart);
      s.update({
        time,
        open: inBucket[0].price,
        high: Math.max(...inBucket.map(d => d.price)),
        low:  Math.min(...inBucket.map(d => d.price)),
        close: inBucket[inBucket.length - 1].price,
      });
    } else {
      s.update({ time: toLwcTime(last.ts), value: last.price });
    }
  });
  updateInfoLabel();
}

function updateInfoLabel() {
  const info = document.getElementById('cinfo');
  if (!info) return;

  if (chartMode === 'compare') {
    const parts = [...compareCoins].map(c => {
      const baseline = compareBaselines[c];
      const hist = getHistory(c);
      if (!(baseline > 0) || !hist.length) return null;
      const pct = (hist[hist.length - 1].price / baseline - 1) * 100;
      return `${c} ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
    }).filter(Boolean);
    info.textContent = parts.length
      ? parts.join(' · ') + ' · от начала загруженной истории'
      : 'Выбери монеты для сравнения (клик по тикеру выше)';
    return;
  }

  const hist = getHistory(selectedCoin);
  const last = hist.length ? hist[hist.length - 1] : null;
  info.textContent = last != null
    ? `${selectedCoin} · USC ${Number(last.price).toLocaleString('ru',{minimumFractionDigits:2,maximumFractionDigits:2})} · ${hist.length} тиков`
    : `${selectedCoin} · ожидание данных…`;
}

// ── Тултип поверх canvas ───────────────────────────────────────────────────────
function setupTooltip(container, dark, gc) {
  if (!tooltipEl || !container.contains(tooltipEl)) {
    tooltipEl = document.createElement('div');
    tooltipEl.id = 'lwcTooltip';
    container.style.position = 'relative';
    container.appendChild(tooltipEl);
  }
  tooltipEl.style.cssText = `
    position:absolute; display:none; pointer-events:none; z-index:20;
    padding:8px 10px; border-radius:8px; font-size:13px; font-weight:700;
    background:${dark ? '#23211f' : '#fff'}; color:${dark ? '#cdccca' : '#28251d'};
    border:1px solid ${gc}; box-shadow:0 4px 12px rgba(0,0,0,.15);
  `;

  chart.subscribeCrosshairMove(param => {
    if (chartMode === 'compare') {
      if (!param.point || !param.time) { tooltipEl.style.display = 'none'; return; }
      const timeStr = formatTickTime(param.time * 1000);
      const rows = [];
      compareCoins.forEach(c => {
        const s = seriesMap[c];
        const data = s && param.seriesData.get(s);
        if (!data || data.value == null) return;
        const pct = data.value - 100;
        rows.push(`<span style="color:${coinColor(c)}">${c} ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%</span>`);
      });
      if (!rows.length) { tooltipEl.style.display = 'none'; return; }
      tooltipEl.innerHTML = rows.join('<br>') + `<div style="opacity:.65;font-weight:400;margin-top:3px">${timeStr}</div>`;
      tooltipEl.style.display = 'block';
      const x = Math.min(Math.max(param.point.x, 0), container.clientWidth - tooltipEl.offsetWidth - 10);
      const y = Math.max(param.point.y - 40, 0);
      tooltipEl.style.left = x + 'px';
      tooltipEl.style.top  = y + 'px';
      return;
    }

    const activeSeries = seriesMap[selectedCoin];
    if (!param.point || !param.time || !activeSeries) {
      tooltipEl.style.display = 'none';
      return;
    }
    const data = param.seriesData.get(activeSeries);
    if (!data) { tooltipEl.style.display = 'none'; return; }

    const timeStr = formatTickTime(param.time * 1000);
    let text;
    if (chartMode === 'candles') {
      const fmt = v => Number(v).toLocaleString('ru', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      text = `${selectedCoin} · O ${fmt(data.open)} H ${fmt(data.high)} L ${fmt(data.low)} C ${fmt(data.close)} · ${timeStr}`;
    } else {
      const price = data.value !== undefined ? data.value : data.close;
      text = `${selectedCoin} · USC ${Number(price).toLocaleString('ru',{minimumFractionDigits:2,maximumFractionDigits:2})} · ${timeStr}`;
    }
    tooltipEl.innerHTML = text;
    tooltipEl.style.display = 'block';

    const x = Math.min(Math.max(param.point.x, 0), container.clientWidth - tooltipEl.offsetWidth - 10);
    const y = Math.max(param.point.y - 40, 0);
    tooltipEl.style.left = x + 'px';
    tooltipEl.style.top  = y + 'px';
  });
}