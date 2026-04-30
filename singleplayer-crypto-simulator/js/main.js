/* ===== ТОЧКА ВХОДА ===== */

/* Тема */
document.getElementById('themeBtn').onclick = ()=>{
  const h=document.documentElement;
  const n=h.getAttribute('data-theme')==='dark'?'light':'dark';
  h.setAttribute('data-theme',n);
  document.getElementById('themeBtn').textContent=n==='dark'?'☀️':'🌙';
  renderChart();
};

/* Глобальные события */
document.getElementById('evCrash').onclick  = ()=>applyGlobal(-0.40);
document.getElementById('evDip').onclick    = ()=>applyGlobal(-0.20);
document.getElementById('evBull').onclick   = ()=>applyGlobal(+0.40);
document.getElementById('evPump').onclick   = ()=>applyGlobal(+0.20);
document.getElementById('evFreeze').onclick = ()=>{ st.paused=true;  document.getElementById('pauseBadge').classList.add('visible'); };
document.getElementById('evResume').onclick = ()=>{ st.paused=false; document.getElementById('pauseBadge').classList.remove('visible'); };

/* Старт */
buildMarketPanel();
buildBotPanel();
renderAll();
function startTicker(){
  if(tickTimer) clearInterval(tickTimer);
  tickTimer = setInterval(tick, tickSpeed);
}

startTicker(); // вместо старого setInterval

/* --- Слайдер скорости --- */
document.getElementById('speedSlider').oninput = function(){
  tickSpeed = +this.value;
  const label = tickSpeed < 1000
    ? `${tickSpeed} мс/тик`
    : `${(tickSpeed/1000).toFixed(1)} сек/тик`;
  document.getElementById('speedLabel').textContent = label;
  startTicker(); // перезапускаем с новой скоростью
};