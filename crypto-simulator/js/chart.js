/* ===== ГРАФИК (Chart.js) ===== */
let chrt;

// Плагин: вертикальная линия-прицел при наведении
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
    ctx.strokeStyle = 'rgba(150,150,150,0.4)';
    ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.restore();
  }
};

function renderChart(){
  const s=st.sel, c=COINS[s];
  const dark = document.documentElement.getAttribute('data-theme')==='dark';
  const gc = dark?'rgba(255,255,255,.07)':'rgba(0,0,0,.07)';
  const tc = dark?'#797876':'#9a9790';
  if(chrt) chrt.destroy();

  const canvas = document.getElementById('chart');

  chrt = new Chart(canvas, {
    type: 'line',
    plugins: [crosshairPlugin],
    data: {
      labels: st.pd[s].map((_,i) => i+1),
      datasets: [{
        data: st.pd[s],
        borderColor: c.col,
        backgroundColor: c.col+'28',
        borderWidth: 2.5,
        tension: .35,
        fill: true,
        pointRadius: 0,
        pointHoverRadius: 5,          // ← точка появляется при наведении
        pointHoverBackgroundColor: c.col,
        pointHoverBorderColor: '#fff',
        pointHoverBorderWidth: 2,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 250 },
      interaction: {
        mode: 'index',                // ← tooltip следует за курсором по оси X
        intersect: false,             // ← не нужно попадать точно в точку
      },
      onHover(_, __, chart) {
        // Запоминаем X курсора для crosshair-плагина
        const active = chart.tooltip?._active;
        if (active && active.length) {
          chart._crosshairX = active[0].element.x;
        } else {
          chart._crosshairX = null;
        }
        chart.draw();
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          mode: 'index',
          intersect: false,
          displayColors: false,       // ← убирает цветной квадратик
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
          caretSize: 5,
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
  if(!st.pd[s] || st.pd[s].length === 0) return;
  const clean = st.pd[s].filter(v => isFinite(v));
  chrt.data.labels = clean.map((_,i) => i+1);
  chrt.data.datasets[0].data = clean;
  chrt.update('none');
}