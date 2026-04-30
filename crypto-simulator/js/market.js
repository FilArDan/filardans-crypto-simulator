/* ===== РЫНОЧНАЯ ЛОГИКА: тик, drift, supply ===== */

const PD_MAX = 300; // единый лимит истории для всех

function changeSupply(sym, newSupply){
  const c = COINS[sym];
  const oldMcap = c.price * c.supply;
  c.supply = Math.max(1, newSupply);
  c.price  = Math.max(0.01, +(oldMcap/c.supply).toFixed(2));
  st.pd[sym].push(c.price);
  if(st.pd[sym].length > PD_MAX) st.pd[sym].shift();
}

function applyShock(sym, pct){
  const c = COINS[sym];
  c.price = Math.max(0.01, +(c.price*(1+pct)).toFixed(2));
  st.pd[sym].push(c.price);
  if(st.pd[sym].length > PD_MAX) st.pd[sym].shift();
  renderAll(); updateMcPrices();
}

function applyGlobal(pct){ SYMS.forEach(s=>applyShock(s,pct)); }

function onDrift(sym, val){
  st.drift[sym] = val/100*0.05;
  $(`driftLbl-${sym}`).textContent = (val>0?'+':'')+val+'%';
}

function onVol(sym, val){
  st.vol[sym] = val/100;
  $(`volLbl-${sym}`).textContent = val+'%';
}

function setDirectPrice(sym){
  const inp = $(`direct-${sym}`), v = parseFloat(inp.value);
  if(!v||v<=0){ inp.style.borderColor='var(--dan)'; return; }
  inp.style.borderColor='';
  COINS[sym].price = +v.toFixed(2);
  st.pd[sym].push(COINS[sym].price);
  if(st.pd[sym].length > PD_MAX) st.pd[sym].shift();
  inp.value=''; renderAll(); updateMcPrices();
}

function setSupply(sym){
  const inp = $(`supply-${sym}`), v = parseFloat(inp.value);
  if(!v||v<=0){ inp.style.borderColor='var(--dan)'; return; }
  inp.style.borderColor='';
  changeSupply(sym, v);
  inp.value='';
  inp.placeholder = fmtLarge(COINS[sym].supply);
  renderAll(); updateMcPrices();
}

function tick(){
  if(st.paused) return;
  SYMS.forEach(s=>{
    const c = COINS[s];
    const noise = (Math.random()-.5)*st.vol[s];
    const trend = st.drift[s];
    const mean  = COINS[s].basePrice;
    const pull  = (mean - c.price) / mean * 0.002;
    c.price = Math.max(0.01, +(c.price*(1+noise+trend+pull)).toFixed(2));
    st.pd[s].push(c.price);                              // ← всегда число
    if(st.pd[s].length > PD_MAX) st.pd[s].shift();
  });
  botTick(); updateLoanRate(); accrueInterest(); renderBank();
  renderControls(); renderStats(); renderHoldings(); renderHistory();
  renderLeaderboard(); updateChartLive(); updateMcPrices(); updateBotCashes();
}

function applyTradePressure(sym, amount, action){
  const c = COINS[sym];
  const rawImpact = (amount / c.supply) * 100;
  const impact = Math.min(Math.log1p(rawImpact) * 0.015, 0.20);
  if(action === 'buy'){
    c.price = Math.max(0.01, +(c.price * (1 + impact)).toFixed(2));
  } else {
    c.price = Math.max(0.01, +(c.price * (1 - impact)).toFixed(2));
  }
  st.pd[sym].push(c.price);                             // ← число, не объект
  if(st.pd[sym].length > PD_MAX) st.pd[sym].shift();
}