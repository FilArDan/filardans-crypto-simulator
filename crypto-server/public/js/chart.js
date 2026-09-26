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
let refreshLegendBox = null; // выставляется в setupTooltip(), дёргается из updateLiveSeries()

// ── Режим «Сравнение» ──────────────────────────────────────────────────────────
// Несколько монет на одном графике, нормализованные к 100% от первой точки
// загруженной истории — так сравнивается изменение в процентах, а не
// абсолютная цена (иначе BTC по $40000 визуально задавил бы DOGE по $0,07).
let compareCoins     = new Set();
let compareBaselines = {}; // coin -> цена первой точки, зафиксированная на момент rebuild

// ── Инструменты рисования (линия тренда, горизонтальная линия) ───────────────
// Lightweight Charts (в отличие от платной TradingView Charting Library) не
// даёт готовых инструментов рисования "из коробки" — рисуем сами: отдельный
// прозрачный canvas поверх графика, координаты переводим через встроенные
// series.priceToCoordinate()/chart.timeScale().timeToCoordinate() и обратно.
// Хранится в localStorage (per-браузер, per-монета) — переживает перезагрузку
// страницы, но не синхронизируется между игроками (это личная разметка).
const DRAW_STORAGE_KEY = 'cryptoSimDrawings_v1';
let drawings      = loadDrawingsFromStorage(); // coin -> [{type:'trend',p1:{ts,price},p2:{ts,price}} | {type:'hline',price}]
let drawTool      = null;   // null (курсор) | 'trend' | 'hline' | 'erase'
let pendingPoint  = null;   // первая точка линии тренда, ждём вторую
let hoverPoint     = null;  // текущая позиция мыши над графиком (для резинки/подсветки ластика)
let overlayCanvas = null;
let overlayCtx    = null;
let overlayResizeObserver = null;

function loadDrawingsFromStorage() {
  try {
    const raw = localStorage.getItem(DRAW_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch (_) { return {}; }
}

function saveDrawingsToStorage() {
  try { localStorage.setItem(DRAW_STORAGE_KEY, JSON.stringify(drawings)); } catch (_) { /* приватный режим/квота — просто не сохраняем */ }
}

function drawingsFor(coin) {
  if (!drawings[coin]) drawings[coin] = [];
  return drawings[coin];
}

function updateChartCoins(coins) {
  const prev = chartCoins;
  chartCoins = coins;
  // Новые тикеры (в первую очередь кастомные монеты/компании — initChart()
  // при входе подгружает сохранённую историю только для дефолтного набора
  // из 5 базовых монет, остальные становятся известны клиенту только тут,
  // позже) — раньше просто заводили пустой массив и график по ним рисовал
  // лишь то, что накопилось "вживую" с момента открытия вкладки, хотя на
  // сервере вся история давно сохранена. Подгружаем её так же, как
  // loadSavedHistory() делает при старте.
  const newCoins = coins.filter(c => !priceHistory[c]);
  newCoins.forEach(c => { priceHistory[c] = []; });
  if (newCoins.length) {
    Promise.all(newCoins.map(c => fetchCoinHistory(c).then(hist => {
      if (hist) priceHistory[c] = hist;
    }))).then(() => { if (chart) rebuildAllSeriesData(); });
  }
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

// ── Загрузка сохранённой истории с сервера (одна монета) ─────────────────────
async function fetchCoinHistory(coin) {
  try {
    const resp = await fetch(`/api/price-history?coin=${coin}&limit=500`);
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!Array.isArray(data) || !data.length) return null;
    return data.map((d, i) => {
      if (typeof d === 'number') {
        return { price: d, ts: Date.now() - (data.length - i) * 1000 };
      }
      return { price: Number(d.price), ts: Number(d.ts) };
    }).filter(d => Number.isFinite(d.price) && Number.isFinite(d.ts));
  } catch (_) {
    return null; // нет доступа — пропускаем
  }
}

async function loadSavedHistory() {
  for (const coin of chartCoins) {
    const hist = await fetchCoinHistory(coin);
    if (hist) priceHistory[coin] = hist;
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
  if (mode === 'compare') { drawTool = null; cancelPendingDrawing(); } // рисование недоступно в "Сравнении"
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
  cancelPendingDrawing();
  renderDrawToolbar();
  redrawOverlay();
  if (refreshLegendBox) refreshLegendBox();
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
      // Цена показывается штатной плашкой на ценовой оси справа (как в
      // TradingView/CMC) — не плавающей подсказкой за курсором.
      horzLine: { labelVisible: true },
    },
    autoSize: true,
  });

  ensureAllSeries();
  rebuildAllSeriesData();
  setupTooltip(container, dark, gc);
  setupDrawing(container);
  renderDrawToolbar();
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
    redrawOverlay();
    if (refreshLegendBox) refreshLegendBox();
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
  redrawOverlay();
  if (refreshLegendBox) refreshLegendBox();
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
  redrawOverlay();
  if (refreshLegendBox) refreshLegendBox();
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
// ── Легенда в углу графика (не следует за курсором) ──────────────────────────
// Раньше цена/OHLC показывались плавающей подсказкой прямо у курсора — как
// в TradingView/CMC, переносим это в закреплённую плашку в углу (обновляется
// при наведении, а без наведения показывает последние данные) и отдаём
// цену под курсором штатной плашке на ценовой оси (crosshair.horzLine).
function setupTooltip(container, dark, gc) {
  if (!tooltipEl || !container.contains(tooltipEl)) {
    tooltipEl = document.createElement('div');
    tooltipEl.id = 'lwcTooltip';
    tooltipEl.className = 'chart-compare-box';
    container.appendChild(tooltipEl);
  }
  tooltipEl.style.background = dark ? '#23211f' : '#fff';
  tooltipEl.style.color      = dark ? '#cdccca' : '#28251d';
  tooltipEl.style.border     = `1px solid ${gc}`;
  tooltipEl.style.boxShadow  = '0 4px 12px rgba(0,0,0,.15)';

  const fmtPrice = v => Number(v).toLocaleString('ru', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function renderLegend(param) {
    const hovering = !!(param && param.point && param.time);

    if (chartMode === 'compare') {
      const rows = [];
      compareCoins.forEach(c => {
        const s = seriesMap[c];
        const data = hovering && s ? param.seriesData.get(s) : null;
        const pct = data && data.value != null
          ? data.value - 100
          : (compareBaselines[c] > 0 && getHistory(c).length
              ? (getHistory(c)[getHistory(c).length - 1].price / compareBaselines[c] - 1) * 100
              : null);
        if (pct == null) return;
        rows.push(`<span style="color:${coinColor(c)}">${c} ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%</span>`);
      });
      if (!rows.length) { tooltipEl.style.display = 'none'; return; }
      const timeStr = hovering ? formatTickTime(param.time * 1000) : '';
      tooltipEl.innerHTML = rows.join('<br>') + (timeStr ? `<div style="opacity:.65;font-weight:400;margin-top:3px">${timeStr}</div>` : '');
      tooltipEl.style.display = 'block';
      return;
    }

    const activeSeries = seriesMap[selectedCoin];
    const hist = getHistory(selectedCoin);
    const hoverData = hovering && activeSeries ? param.seriesData.get(activeSeries) : null;

    if (!hoverData && !hist.length) { tooltipEl.style.display = 'none'; return; }

    const timeStr = hovering ? formatTickTime(param.time * 1000) : '';
    let text;
    if (chartMode === 'candles') {
      const last = hist[hist.length - 1];
      const bucket = hoverData || (last && { open: last.price, high: last.price, low: last.price, close: last.price });
      if (!bucket) { tooltipEl.style.display = 'none'; return; }
      text = `<strong>${selectedCoin}</strong><br>O ${fmtPrice(bucket.open)} H ${fmtPrice(bucket.high)} L ${fmtPrice(bucket.low)} C ${fmtPrice(bucket.close)}`
        + (timeStr ? `<div style="opacity:.65;font-weight:400;margin-top:3px">${timeStr}</div>` : '');
    } else {
      const price = hoverData ? (hoverData.value !== undefined ? hoverData.value : hoverData.close) : (hist.length ? hist[hist.length - 1].price : null);
      if (price == null) { tooltipEl.style.display = 'none'; return; }
      text = `<strong>${selectedCoin}</strong> · USC ${fmtPrice(price)}`
        + (timeStr ? `<div style="opacity:.65;font-weight:400;margin-top:3px">${timeStr}</div>` : '');
    }
    tooltipEl.innerHTML = text;
    tooltipEl.style.display = 'block';
  }

  chart.subscribeCrosshairMove(renderLegend);
  refreshLegendBox = () => renderLegend(null); // для вызова из updateLiveSeries() на каждый тик
  renderLegend(null); // сразу показать последние данные, не дожидаясь наведения
}

// ── ИНСТРУМЕНТЫ РИСОВАНИЯ ────────────────────────────────────────────────────
// В режиме "Сравнение" рисование отключено — там серия в процентах от
// базовой точки, а не в абсолютной цене, привязка линий к цене там не имеет
// смысла (и меняется от состава/порядка выбранных монет).
const DRAW_HIT_PX = 6; // порог "попадания" ластиком по линии, в пикселях

function drawingModeAvailable() {
  return chartMode !== 'compare';
}

function armTool(tool) {
  drawTool = (drawTool === tool) ? null : tool;
  pendingPoint = null;
  hoverPoint = null;
  if (overlayCanvas) overlayCanvas.style.pointerEvents = drawTool ? 'auto' : 'none';
  renderDrawToolbar();
  redrawOverlay();
}

function cancelPendingDrawing() {
  pendingPoint = null;
  hoverPoint = null;
}

function clearCurrentDrawings() {
  if (!drawingModeAvailable()) return;
  if (!drawingsFor(selectedCoin).length) return;
  if (!confirm(`Стереть все линии для ${selectedCoin}? Это нельзя отменить.`)) return;
  drawings[selectedCoin] = [];
  saveDrawingsToStorage();
  redrawOverlay();
}

function renderDrawToolbar() {
  const wrap = document.getElementById('drawToolbar');
  if (!wrap) return;
  if (!drawingModeAvailable()) { wrap.innerHTML = ''; return; }
  const btn = (tool, label, title) =>
    `<button type="button" class="draw-tool-btn${drawTool === tool ? ' on' : ''}" title="${title}" onclick="armTool('${tool}')">${label}</button>`;
  wrap.innerHTML = [
    btn('trend', '／ Линия тренда', 'Провести линию тренда: клик — первая точка, клик — вторая'),
    btn('hline', '─ Горизонталь', 'Поставить горизонтальный уровень: один клик'),
    btn('erase', '🩹 Ластик', 'Клик по линии — удалить её'),
    `<button type="button" class="draw-tool-btn" title="Стереть все линии для ${selectedCoin}" onclick="clearCurrentDrawings()">🗑️ Очистить</button>`,
  ].join('');
}

// ── Overlay-canvas поверх графика ─────────────────────────────────────────────
function setupDrawing(container) {
  ensureOverlayCanvas(container);
  chart.timeScale().subscribeVisibleTimeRangeChange(redrawOverlay);
}

function ensureOverlayCanvas(container) {
  if (overlayResizeObserver) { overlayResizeObserver.disconnect(); overlayResizeObserver = null; }
  // createChartInstance() пересоздаёт весь график (в т.ч. при смене режима
  // Линия/Свечи/Сравнение) — chart.remove() чистит только сам чарт, наш
  // canvas в него не входит и без явного удаления копился бы поверх старого.
  if (overlayCanvas && overlayCanvas.parentNode) overlayCanvas.parentNode.removeChild(overlayCanvas);

  overlayCanvas = document.createElement('canvas');
  overlayCanvas.className = 'draw-overlay';
  overlayCanvas.style.pointerEvents = drawTool ? 'auto' : 'none';
  container.style.position = 'relative';
  container.appendChild(overlayCanvas);
  overlayCtx = overlayCanvas.getContext('2d');

  resizeOverlayCanvas(container);
  overlayResizeObserver = new ResizeObserver(() => { resizeOverlayCanvas(container); redrawOverlay(); });
  overlayResizeObserver.observe(container);

  overlayCanvas.addEventListener('click', onOverlayClick);
  overlayCanvas.addEventListener('mousemove', onOverlayMouseMove);
  overlayCanvas.addEventListener('mouseleave', () => { hoverPoint = null; redrawOverlay(); });
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && (drawTool || pendingPoint)) {
    armTool(null);
  }
});

function resizeOverlayCanvas(container) {
  if (!overlayCanvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = container.clientWidth;
  const h = container.clientHeight;
  overlayCanvas.width  = Math.max(1, Math.round(w * dpr));
  overlayCanvas.height = Math.max(1, Math.round(h * dpr));
  overlayCanvas.style.width  = w + 'px';
  overlayCanvas.style.height = h + 'px';
  if (overlayCtx) overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// (time_ms, price) -> координаты канваса, или null если точка сейчас не видна
function pointToCoords(ts, price) {
  const s = seriesMap[selectedCoin];
  if (!chart || !s) return null;
  const x = chart.timeScale().timeToCoordinate(toLwcTime(ts));
  const y = s.priceToCoordinate(price);
  if (x == null || y == null) return null;
  return { x, y };
}

// Только цена -> y. В отличие от pointToCoords не зависит от того, видно ли
// сейчас конкретное время — горизонтальная линия висит на всей ширине
// графика независимо от того, куда игрок проскроллил ось времени, и не
// должна исчезать только потому, что "сейчас" (или момент проведения линии)
// временно не в кадре.
function priceToY(price) {
  const s = seriesMap[selectedCoin];
  if (!chart || !s) return null;
  return s.priceToCoordinate(price);
}

// координаты канваса -> (time_ms, price), или null вне графика/шкалы
function coordsToPoint(x, y) {
  const s = seriesMap[selectedCoin];
  if (!chart || !s) return null;
  const t = chart.timeScale().coordinateToTime(x);
  const price = s.coordinateToPrice(y);
  if (t == null || price == null) return null;
  return { ts: t * 1000, price };
}

function mousePos(e) {
  const rect = overlayCanvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function onOverlayMouseMove(e) {
  if (!drawTool) return;
  const { x, y } = mousePos(e);
  hoverPoint = { x, y };
  redrawOverlay();
}

function onOverlayClick(e) {
  if (!drawTool || !drawingModeAvailable()) return;
  const { x, y } = mousePos(e);

  if (drawTool === 'erase') {
    const idx = hitTestDrawing(x, y);
    if (idx >= 0) {
      drawingsFor(selectedCoin).splice(idx, 1);
      saveDrawingsToStorage();
      redrawOverlay();
    }
    return;
  }

  const point = coordsToPoint(x, y);
  if (!point) return;

  if (drawTool === 'hline') {
    drawingsFor(selectedCoin).push({ type: 'hline', price: point.price });
    saveDrawingsToStorage();
    armTool('hline'); // возвращаемся к курсору — один клик и готово
    return;
  }

  if (drawTool === 'trend') {
    if (!pendingPoint) {
      pendingPoint = point;
    } else {
      drawingsFor(selectedCoin).push({ type: 'trend', p1: pendingPoint, p2: point });
      saveDrawingsToStorage();
      pendingPoint = null;
      armTool('trend'); // завершили линию — возвращаемся к курсору
    }
    redrawOverlay();
  }
}

// Расстояние от точки (px,py) до отрезка (x1,y1)-(x2,y2)
function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq > 0 ? ((px - x1) * dx + (py - y1) * dy) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx, cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function hitTestDrawing(x, y) {
  const list = drawingsFor(selectedCoin);
  for (let i = list.length - 1; i >= 0; i--) {
    const d = list[i];
    if (d.type === 'hline') {
      const ly = priceToY(d.price);
      if (ly != null && Math.abs(y - ly) <= DRAW_HIT_PX) return i;
    } else if (d.type === 'trend') {
      const c1 = pointToCoords(d.p1.ts, d.p1.price);
      const c2 = pointToCoords(d.p2.ts, d.p2.price);
      if (c1 && c2 && distToSegment(x, y, c1.x, c1.y, c2.x, c2.y) <= DRAW_HIT_PX) return i;
    }
  }
  return -1;
}

function redrawOverlay() {
  if (!overlayCtx || !overlayCanvas) return;
  const w = overlayCanvas.clientWidth;
  const h = overlayCanvas.clientHeight;
  overlayCtx.clearRect(0, 0, w, h);
  if (!drawingModeAvailable()) return;

  const cs = getComputedStyle(document.documentElement);
  const lineColor  = cs.getPropertyValue('--pri').trim() || '#3b82f6';
  const eraseColor = cs.getPropertyValue('--dan').trim() || '#ef5350';

  const list = drawingsFor(selectedCoin);
  const hoverIdx = (drawTool === 'erase' && hoverPoint) ? hitTestDrawing(hoverPoint.x, hoverPoint.y) : -1;

  list.forEach((d, i) => {
    const highlighted = i === hoverIdx;
    overlayCtx.strokeStyle = highlighted ? eraseColor : lineColor;
    overlayCtx.lineWidth   = highlighted ? 2.5 : 1.5;
    overlayCtx.setLineDash(d.type === 'hline' ? [5, 4] : []);

    if (d.type === 'hline') {
      const ly = priceToY(d.price);
      if (ly == null) return;
      overlayCtx.beginPath();
      overlayCtx.moveTo(0, ly);
      overlayCtx.lineTo(w, ly);
      overlayCtx.stroke();
    } else if (d.type === 'trend') {
      const c1 = pointToCoords(d.p1.ts, d.p1.price);
      const c2 = pointToCoords(d.p2.ts, d.p2.price);
      if (!c1 || !c2) return;
      overlayCtx.beginPath();
      overlayCtx.moveTo(c1.x, c1.y);
      overlayCtx.lineTo(c2.x, c2.y);
      overlayCtx.stroke();
      [c1, c2].forEach(c => {
        overlayCtx.beginPath();
        overlayCtx.arc(c.x, c.y, 3, 0, Math.PI * 2);
        overlayCtx.fillStyle = highlighted ? eraseColor : lineColor;
        overlayCtx.fill();
      });
    }
  });

  // Резинка — линия тренда в процессе рисования, от первой точки до курсора
  if (drawTool === 'trend' && pendingPoint && hoverPoint) {
    const c1 = pointToCoords(pendingPoint.ts, pendingPoint.price);
    if (c1) {
      overlayCtx.setLineDash([4, 4]);
      overlayCtx.strokeStyle = lineColor;
      overlayCtx.lineWidth = 1.5;
      overlayCtx.beginPath();
      overlayCtx.moveTo(c1.x, c1.y);
      overlayCtx.lineTo(hoverPoint.x, hoverPoint.y);
      overlayCtx.stroke();
    }
  }
  overlayCtx.setLineDash([]);
}