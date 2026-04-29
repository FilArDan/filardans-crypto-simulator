/* ===== РЕНДЕР: статистика, монеты, история, панели ===== */

function renderStats(){
  const p=portV(st.held), t=st.cash+p, pnl=t-START;
  $('sCash').textContent  = fmt(st.cash);
  $('sPort').textContent  = fmt(p);
  $('sTotal').textContent = fmt(t);
  $('sPnl').textContent   = fmt(pnl);
  $('sPnl').className = 'val '+(pnl>=0?'up':'dn');
}

function renderControls(){
  const tb=$('tabs'), sc=$('sCoin');
  tb.innerHTML=''; sc.innerHTML='';
  SYMS.forEach(s=>{
    const c=COINS[s];
    const b=document.createElement('button');
    b.className='ctab'+(st.sel===s?' on':'');
    b.innerHTML=`<span style="color:${c.col}">●</span> ${s} ${fmt(c.price)}`;
    b.onclick=()=>{ st.sel=s; $('sCoin').value=s; renderAll(); };
    tb.appendChild(b);
    const o=document.createElement('option');
    o.value=s; o.textContent=`${c.name} (${s})`;
    sc.appendChild(o);
  });
  sc.value=st.sel;
  $('cinfo').textContent=`${COINS[st.sel].name}: текущая цена ${fmt(COINS[st.sel].price)} · Supply: ${fmtLarge(COINS[st.sel].supply)}`;
}

function renderHoldings(){
  const w=$('holdings'); w.innerHTML='';
  SYMS.forEach(s=>{
    const c=COINS[s], own=st.held[s], avg=st.avgP[s];
    const val=own*c.price, pnl=own>0?val-(own*avg):0;
    const d=document.createElement('div'); d.className='item';
    d.innerHTML=`<div class="ir"><strong><span style="color:${c.col}">●</span> ${c.name} (${s})</strong><span>${fmt(c.price)}</span></div>
    <div class="sm">У тебя: <b>${fmtC(own)} ${s}</b> &nbsp;|&nbsp; Средняя цена: ${avg?fmt(avg):'—'}<br>
    Стоимость: <b>${fmt(val)}</b> &nbsp;|&nbsp; P/L: <span class="${pnl>=0?'up':'dn'}">${fmt(pnl)}</span></div>`;
    w.appendChild(d);
  });
}

function renderHistory(){
  const w=$('history'); w.innerHTML='';
  if(!st.hist.length){ w.innerHTML='<div class="item" style="color:var(--mu)">Пока нет сделок.</div>'; return; }
  [...st.hist].reverse().forEach(h=>{
    const d=document.createElement('div'); d.className='item';
    d.innerHTML=`<div class="ir"><span class="${h.t==='B'?'bla':'sla'}">${h.t==='B'?'📈 Покупка':'📉 Продажа'} ${h.s}</span>
    <span style="font-size:12px;color:var(--mu)">${h.time}</span></div>
    <div class="sm">Кол-во: ${fmtC(h.a)} &nbsp;|&nbsp; Цена: ${fmt(h.p)} &nbsp;|&nbsp; Итого: <b>${fmt(h.tot)}</b></div>`;
    w.appendChild(d);
  });
}

function updateMcPrices(){
  SYMS.forEach(s=>{ const el=$(`mcp-${s}`); if(el) el.textContent=fmt(COINS[s].price); });
}

function buildMarketPanel(){
  const grid=$('mpGrid'); grid.innerHTML='';
  SYMS.forEach(s=>{
    const c=COINS[s];
    const div=document.createElement('div'); div.className='mc'; div.id=`mc-${s}`;
    div.innerHTML=`
      <div class="mc-head">
        <div class="mc-name"><span style="color:${c.col};font-size:16px">●</span> ${c.name} (${s})</div>
        <div class="mc-price" id="mcp-${s}">${fmt(c.price)}</div>
      </div>
      <div class="shock-row">
        <button class="shock shock-up" data-sym="${s}" data-pct="0.30">▲+30%</button>
        <button class="shock shock-up" data-sym="${s}" data-pct="0.10">▲+10%</button>
        <button class="shock shock-dn" data-sym="${s}" data-pct="-0.10">▼−10%</button>
        <button class="shock shock-dn" data-sym="${s}" data-pct="-0.30">▼−30%</button>
      </div>
      <div class="sl-row">
        <div class="sl-label"><span>Тренд</span><span id="driftLbl-${s}">0%</span></div>
        <input type="range" id="drift-${s}" min="-100" max="100" value="0" oninput="onDrift('${s}',this.value)"/>
        <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--fa);"><span>← Падение</span><span>Рост →</span></div>
      </div>
      <div class="sl-row" style="margin-top:10px;">
        <div class="sl-label"><span>Волатильность</span><span id="volLbl-${s}">${Math.round(st.vol[s]*100)}%</span></div>
        <input type="range" class="danger" id="vol-${s}" min="0" max="30" value="${Math.round(st.vol[s]*100)}" oninput="onVol('${s}',this.value)"/>
        <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--fa);"><span>← Стабильно</span><span>Хаос →</span></div>
      </div>
      <div class="mp-direct">
        <input type="number" id="direct-${s}" placeholder="Задать цену" min="0.01" step="0.01"/>
        <button onclick="setDirectPrice('${s}')">Задать</button>
      </div>
      <div class="supply-row">
        <label>Эмиссия (supply) — влияет на цену</label>
        <div class="mp-direct">
          <input type="number" id="supply-${s}" placeholder="${fmtLarge(c.supply)}" min="1" step="1"/>
          <button onclick="setSupply('${s}')">Задать</button>
        </div>
      </div>`;
    grid.appendChild(div);
  });
  document.querySelectorAll('.shock').forEach(btn=>{
    btn.onclick=()=>applyShock(btn.dataset.sym, parseFloat(btn.dataset.pct));
  });
}

function buildBotPanel(){
  const grid=$('botGrid'); grid.innerHTML='';
  bots.forEach((bot,i)=>{
    const div=document.createElement('div'); div.className='bot-card';
    div.innerHTML=`
      <div class="bot-name">🤖 ${bot.name}</div>
      <div class="bot-cash" id="botCash-${i}">Баланс: ${fmt(bot.cash)}</div>
      <label style="margin-top:8px;">Задать бюджет (USD)</label>
      <div class="bot-inp-row">
        <input type="number" id="botInp-${i}" placeholder="Сумма" min="0" step="100"/>
        <button onclick="setBotBudget(${i})">Задать</button>
      </div>`;
    grid.appendChild(div);
  });
}

function renderBank(){
  const bankEl = $('bankCash');
  const loanEl = $('bankLoan');
  const rateEl = $('bankRate');

  if(bankEl) bankEl.textContent = fmt(bank.cash);

  if(loanEl){
    loanEl.textContent = fmt(bank.loan);
    loanEl.style.color = bank.loan > 0 ? 'var(--dan)' : '';
  }

  if(rateEl) rateEl.textContent = bank.loan > 0
    ? `${(bank.lockedRate * 100).toFixed(3)}% (зафикс.)`
    : `${(bank.loanRate  * 100).toFixed(3)}%`;
}

function renderAll(){
  renderControls(); renderStats(); renderHoldings(); renderHistory(); renderBank();
  renderLeaderboard(); renderChart(); updateMcPrices(); updateBotCashes();
}