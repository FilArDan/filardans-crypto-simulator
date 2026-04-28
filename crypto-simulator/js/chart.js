/* ===== ГРАФИК (Chart.js) ===== */
let chrt;

function renderChart(){
  const s=st.sel, c=COINS[s];
  const dark = document.documentElement.getAttribute('data-theme')==='dark';
  const gc = dark?'rgba(255,255,255,.07)':'rgba(0,0,0,.07)';
  const tc = dark?'#797876':'#9a9790';
  if(chrt) chrt.destroy();
  chrt = new Chart(document.getElementById('chart'),{
    type:'line',
    data:{
      labels: st.pd[s].map((_,i)=>i+1),
      datasets:[{data:st.pd[s], borderColor:c.col, backgroundColor:c.col+'28',
                 borderWidth:2.5, tension:.35, fill:true, pointRadius:0}]
    },
    options:{
      responsive:true, maintainAspectRatio:false, animation:{duration:250},
      plugins:{
        legend:{display:false},
        tooltip:{callbacks:{label:x=>fmt(x.parsed.y)},
          backgroundColor:dark?'#23211f':'#fff',
          titleColor:dark?'#cdccca':'#28251d',
          bodyColor:dark?'#cdccca':'#28251d',
          borderColor:gc, borderWidth:1}
      },
      scales:{
        x:{ticks:{color:tc,maxTicksLimit:6},grid:{color:gc}},
        y:{ticks:{color:tc,callback:v=>fmt(v)},grid:{color:gc}}
      }
    }
  });
}

/** Плавное обновление без пересоздания */
function updateChartLive(){
  if(!chrt) return;
  const s = st.sel;
  // защита от NaN — если данные испорчены, пропускаем тик
  if(!st.pd[s] || st.pd[s].length === 0) return;
  const clean = st.pd[s].filter(v => isFinite(v));
  chrt.data.labels = clean.map((_,i)=>i+1);
  chrt.data.datasets[0].data = clean;
  chrt.update('none');
}