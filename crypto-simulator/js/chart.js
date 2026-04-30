/* ===== ГРАФИК (Chart.js) ===== */
let chrt;
let chartRange = 40; // текущий диапазон отображения

// Плагин: вертикальная линия при наведении
const crosshairPlugin = {
  id: 'crosshair',
  afterDraw(chart) {
    if (!chart._crosshairX) return;
    const { ctx, chartArea: { top, bottom } } = chart;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(chart._crosshairX, top);
    ctx.lineTo(chart._crosshairX, bottom);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(150,150,150,0.35)';
    ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.restore();
  }
};

function getChartData(sym){
  // Берём только числа, затем нарезаем по диапазону
  const raw = st.pd[sym].filter(v => typeof v === 'number' && isFinite(v));
  return chartRange === 0 ? raw : raw.slice(-chartRange);
}

function renderChart(){
  const s = st.sel, c = COINS[s];
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  const gc = dark ? 'rgba(255,255,255,.07)' : 'rgba(0,0,0,.07)';
  const tc = dark ? '#797876' : '#9a9790';

  const data = getChartData(s);

  if(chrt) chrt.destroy();
  chrt = new Chart(document.getElementById('chart'), {
    type: 'line',
    plugins: [crosshairPlugin],
    data: {
      labels: data.map((_,i) => i + 1),
      datasets: [{
        data,
        borderColor: c.col,
        backgroundColor: c.col + '28',
        borderWidth: 2.5,
        tension: .35,
        fill: true,
        pointRadius: 0,
        pointHoverRadius: 5,
        pointHoverBackgroundColor: c.col,
        pointHoverBorderColor: '#fff',
        pointHoverBorderWidth: 2,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,                // ← отключаем анимацию совсем, чтобы не дёргался масштаб
      interaction: { mode: 'index', intersect: false },
      onHover(_, __, chart) {
        const active = chart.tooltip?._active;
        chart._crosshairX = active?.length ? active[0].element.x : null;
        chart.draw();
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          mode: 'index',
          intersect: false,
          displayColors: false,
          callbacks: {
            title: items => `Тик ${items[0].label}`,
            label: x => `Цена: ${fmt(x.parsed.y)}`,
          },
          backgroundColor: dark ? '#23211f' : '#fff',
          titleColor: dark ? '#797876' : '#9a9790',
          bodyColor: dark ? '#cdccca' : '#28251d',
          bodyFont: { weight: '700', size: 13 },
          borderColor: gc,
          borderWidth: 1,
          padding: 10,
        }
      },
      scales: {
        x: { ticks: { color: tc, maxTicksLimit: 6 }, grid: { color: gc } },
        y: { ticks: { color: tc, callback: v => fmt(v) }, grid: { color: gc } }
      }
    }
  });
}

/** Плавное обновление без пересоздания */
function updateChartLive(){
  if(!chrt) return;
  const s = st.sel;
  const data = getChartData(s);
  chrt.data.labels = data.map((_,i) => i + 1);
  chrt.data.datasets[0].data = data;
  chrt.data.datasets[0].borderColor = COINS[s].col;
  chrt.data.datasets[0].backgroundColor = COINS[s].col + '28';
  chrt.update('none'); // ← 'none' = без анимации, без сброса масштаба
}

/** Переключить диапазон и перерисовать */
function setChartRange(n){
  chartRange = n;
  // Обновить активную кнопку
  document.querySelectorAll('.chart-range-btn').forEach(b => {
    b.classList.toggle('on', +b.dataset.range === n);
  });
  updateChartLive();
}