/* ===== CHART — Multiplayer ===== */
const COIN_COLORS = {
  BTC:  '#f7931a',
  ETH:  '#627eea',
  SOL:  '#9945ff',
  XRP:  '#00aae4',
  DOGE: '#c2a633'
};
const COINS_LIST = ['BTC','ETH','SOL','XRP','DOGE'];

const priceHistory = {};
COINS_LIST.forEach(c => priceHistory[c] = []);

let selectedCoin = 'BTC';
let chartRange   = 40;
let chrt         = null;

// ── Добавить новую точку (вызывается из app.js при priceUpdate) ──────────
function addPricePoint(prices) {
  COINS_LIST.forEach(c => {
    if (prices[c] != null) priceHistory[c].push(prices[c]);
  });
  updateChartLive();
}

// ── Инициализация: рисуем табы и первый чарт ───────────────────────────
function initChart() {
  const tabs = document.getElementById('chartTabs');
  if (!tabs) return;
  tabs.innerHTML = COINS_LIST.map(c =>
    `<button class="ctab${c === selectedCoin ? ' on' : ''}" data-coin="${c}" onclick="selectCoin('${c}')">${c}</button>`
  ).join('');
  renderChart();
}

function selectCoin(coin) {
  selectedCoin = coin;
  document.querySelectorAll('.ctab').forEach(b =>
    b.classList.toggle('on', b.dataset.coin === coin));
  renderChart();
}

function getHistory(coin) {
  const raw = priceHistory[coin].filter(v => typeof v === 'number' && isFinite(v));
  return chartRange === 0 ? raw : raw.slice(-chartRange);
}

function renderChart() {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  const gc   = dark ? 'rgba(255,255,255,.07)' : 'rgba(0,0,0,.07)';
  const tc   = dark ? '#797876' : '#9a9790';
  const col  = COIN_COLORS[selectedCoin];
  const data = getHistory(selectedCoin);

  const info = document.getElementById('cinfo');
  if (info) {
    const last = data.length ? data[data.length - 1] : null;
    info.textContent = last != null
      ? `${selectedCoin} · текущая цена: $${Number(last).toLocaleString('ru', {minimumFractionDigits:2,maximumFractionDigits:2})} · ${data.length} тиков`
      : `${selectedCoin} · ожидание данных…`;
  }

  if (chrt) chrt.destroy();
  chrt = new Chart(document.getElementById('chart'), {
    type: 'line',
    data: {
      labels: data.map((_, i) => i + 1),
      datasets: [{
        data,
        borderColor: col,
        backgroundColor: col + '28',
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
            label: x => `Цена: $${Number(x.parsed.y).toLocaleString('ru',{minimumFractionDigits:2,maximumFractionDigits:2})}`
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
        y: { ticks: { color: tc, callback: v => '$' + Number(v).toLocaleString('ru',{maximumFractionDigits:2}) }, grid: { color: gc } }
      }
    }
  });
}

function updateChartLive() {
  if (!chrt) return;
  const data = getHistory(selectedCoin);
  const col  = COIN_COLORS[selectedCoin];
  chrt.data.labels = data.map((_, i) => i + 1);
  chrt.data.datasets[0].data = data;
  chrt.data.datasets[0].borderColor = col;
  chrt.data.datasets[0].backgroundColor = col + '28';
  chrt.update('none');

  const info = document.getElementById('cinfo');
  if (info && data.length) {
    const last = data[data.length - 1];
    info.textContent = `${selectedCoin} · текущая цена: $${Number(last).toLocaleString('ru',{minimumFractionDigits:2,maximumFractionDigits:2})} · ${data.length} тиков`;
  }
}

function setChartRange(n) {
  chartRange = n;
  document.querySelectorAll('.chart-range-btn').forEach(b =>
    b.classList.toggle('on', +b.dataset.range === n));
  updateChartLive();
}
