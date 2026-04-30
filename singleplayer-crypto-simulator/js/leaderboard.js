/* ===== ЛИДЕРБОРД И КАПИТАЛИЗАЦИЯ ===== */

function renderLeaderboard(){
  const all = [
    {name:'Ты', isMe:true,  total:totalV(st.cash, st.held)},
    ...bots.map(b=>({name:b.name, isMe:false, total:totalV(b.cash, b.held)}))
  ];
  const totalMcap = SYMS.reduce((s,k)=>s+COINS[k].price*COINS[k].supply, 0);
  all.sort((a,b)=>b.total-a.total);
  const maxTotal = all[0].total;

  const tbody=$('lbBody'); tbody.innerHTML='';
  all.forEach((inv,i)=>{
    const share  = (inv.total/totalMcap*100).toFixed(2);
    const barW   = Math.round(inv.total/maxTotal*100);
    const rankCls= i===0?'rank-1':i===1?'rank-2':i===2?'rank-3':'';
    const tr=document.createElement('tr');
    if(inv.isMe) tr.className='me';
    tr.innerHTML=`
      <td><span class="rank ${rankCls}">${i===0?'🥇':i===1?'🥈':i===2?'🥉':i+1}</span></td>
      <td><span class="inv-name${inv.isMe?' me':''}">${inv.name}</span></td>
      <td>${fmt(inv.total)}</td>
      <td>${share}%<span class="bar-wrap"><span class="bar-fill" style="width:${barW}%"></span></span></td>`;
    tbody.appendChild(tr);
  });

  /* --- Market Cap list --- */
  const mcl=$('mcapList'); mcl.innerHTML='';
  SYMS.forEach(s=>{
    const c=COINS[s];
    const mcap  = c.price*c.supply;
    const share = (mcap/totalMcap*100).toFixed(1);
    const d=document.createElement('div'); d.className='item';
    d.innerHTML=`<div class="ir"><strong><span style="color:${c.col}">●</span> ${c.name}</strong><span>${fmtLarge(mcap)}</span></div>
    <div class="sm">Цена: ${fmt(c.price)} &nbsp;|&nbsp; Supply: ${fmtLarge(c.supply)} &nbsp;|&nbsp; Доля рынка: <b>${share}%</b></div>`;
    mcl.appendChild(d);
  });

  // где-нибудь в renderAll() или updateBotCashes()
  const bankEl = $('bankCash');
  if(bankEl) bankEl.textContent = `Банк: ${fmt(bank.cash)}`;
  
}