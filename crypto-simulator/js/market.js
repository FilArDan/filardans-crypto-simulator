/* ===== РЫНОЧНАЯ ЛОГИКА: тик, drift, supply ===== */

/** Изменить supply монеты — цена пересчитывается обратно пропорционально */
function changeSupply(sym, newSupply){
  const c = COINS[sym];
  const oldMcap = c.price * c.supply;
  c.supply = Math.max(1, newSupply);
  c.price  = Math.max(0.01, +(oldMcap/c.supply).toFixed(2));
  st.pd[sym].push(c.price);
  if(st.pd[sym].length>40) st.pd[sym].shift();
}

/** Применить процентный шок к одной монете */
function applyShock(sym, pct){
  const c = COINS[sym];
  c.price = Math.max(0.01, +(c.price*(1+pct)).toFixed(2));
  st.pd[sym].push(c.price);
  if(st.pd[sym].length>40) st.pd[sym].shift();
  renderAll(); updateMcPrices();
}

/** Применить шок ко всем монетам */
function applyGlobal(pct){ SYMS.forEach(s=>applyShock(s,pct)); }

/** Обработчик ползунка тренда */
function onDrift(sym, val){
  st.drift[sym] = val/100*0.05;
  $(`driftLbl-${sym}`).textContent = (val>0?'+':'')+val+'%';
}

/** Обработчик ползунка волатильности */
function onVol(sym, val){
  st.vol[sym] = val/100;
  $(`volLbl-${sym}`).textContent = val+'%';
}

/** Задать цену вручную */
function setDirectPrice(sym){
  const inp = $(`direct-${sym}`), v = parseFloat(inp.value);
  if(!v||v<=0){ inp.style.borderColor='var(--dan)'; return; }
  inp.style.borderColor='';
  COINS[sym].price = +v.toFixed(2);
  st.pd[sym].push(COINS[sym].price);
  if(st.pd[sym].length>40) st.pd[sym].shift();
  inp.value=''; renderAll(); updateMcPrices();
}

/** Задать supply вручную */
function setSupply(sym){
  const inp = $(`supply-${sym}`), v = parseFloat(inp.value);
  if(!v||v<=0){ inp.style.borderColor='var(--dan)'; return; }
  inp.style.borderColor='';
  changeSupply(sym, v);
  inp.value='';
  inp.placeholder = fmtLarge(COINS[sym].supply);
  renderAll(); updateMcPrices();
}

/** Главный тик рынка (вызывается раз в 1.5 сек) */
function tick(){
  if(st.paused) return;
  SYMS.forEach(s=>{
    const c = COINS[s];
    const noise = (Math.random()-.5)*st.vol[s];
    const trend = st.drift[s];

    // Возврат к среднему — тянет цену к стартовой
    const mean      = COINS[s].basePrice; // стартовая цена (см. ниже)
    const pullStrength = 0.002;           // сила притяжения
    const pull      = (mean - c.price) / mean * pullStrength;

    c.price = Math.max(0.01, +(c.price*(1+noise+trend+pull)).toFixed(2));
    st.pd[s].push(c.price);
    if(st.pd[s].length>40) st.pd[s].shift();
  });
  botTick(); updateLoanRate(); accrueInterest(); renderBank();
  renderControls(); renderStats(); renderHoldings(); renderHistory();
  renderLeaderboard(); updateChartLive(); updateMcPrices(); updateBotCashes();
}

/** Сдвинуть цену от сделки игрока */
function applyTradePressure(sym, amount, action){
  const c = COINS[sym];
  // Сила влияния: объём сделки / supply * коэффициент
  const rawImpact = (amount / c.supply) * 100;
  const impact = Math.min(Math.log1p(rawImpact) * 0.015, 0.20); // максимум 20% за сделку
  if(action === 'buy'){
    c.price = Math.max(0.01, +(c.price * (1 + impact)).toFixed(2));
  } else {
    c.price = Math.max(0.01, +(c.price * (1 - impact)).toFixed(2));
  }
  st.pd[sym].push({ price: c.price, time: Date.now() });
  if(st.pd[sym].length > 1200) st.pd[sym].shift();
}