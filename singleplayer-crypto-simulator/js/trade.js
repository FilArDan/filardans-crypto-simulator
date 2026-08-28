/* ===== ТОРГОВЛЯ ИГРОКА (добавлена возможность включать ордербук) ===== */

document.getElementById('buyBtn').onclick = ()=>{
  const s = $('sCoin').value, a = +$('sAmt').value, c = COINS[s];
  if(!a||a<=0){ $('msgBox').textContent='Введи количество монет больше нуля.'; return; }
  const sub=a*c.price, fee=sub*FEE, tot=sub+fee;
  if(st.cash<tot){ $('msgBox').textContent=`Не хватает денег. Нужно ${fmt(tot)}, у тебя ${fmt(st.cash)}.`; return; }
  const pc = st.held[s]*st.avgP[s];
  bank.cash+=fee;
  st.cash   -= tot;
  st.held[s]+=a;

  // Если включён режим ордербука — используем его, иначе старую механику.
  if (st.useOrderBook) {
    executeViaOrderBook(s, a, 'buy');
  } else {
    applyTradePressure(s, a, 'buy');
  }

  st.avgP[s]=(pc+sub)/st.held[s];
  st.hist.push({t:'B',s,a,p:c.price,tot,time:new Date().toLocaleTimeString('ru-RU')});
  $('msgBox').textContent=`✅ Куплено ${fmtC(a)} ${s} по ${fmt(c.price)}. Комиссия: ${fmt(fee)}.`;
  renderAll();
};

document.getElementById('sellBtn').onclick = ()=>{
  const s = $('sCoin').value, a = +$('sAmt').value, c = COINS[s];
  if(!a||a<=0){ $('msgBox').textContent='Введи количество монет больше нуля.'; return; }
  if(st.held[s]<a){ $('msgBox').textContent=`У тебя только ${fmtC(st.held[s])} ${s}.`; return; }
  const sub=a*c.price, fee=sub*FEE, tot=sub-fee;
  st.held[s]-=a;

  if (st.useOrderBook) {
    executeViaOrderBook(s, a, 'sell');
  } else {
    applyTradePressure(s, a, 'sell');
  }

  if(st.held[s]===0) st.avgP[s]=0;
  st.cash   += tot;
  bank.cash+=fee;
  st.hist.push({t:'S',s,a,p:c.price,tot,time:new Date().toLocaleTimeString('ru-RU')});
  $('msgBox').textContent=`✅ Продано ${fmtC(a)} ${s} по ${fmt(c.price)}. Комиссия: ${fmt(fee)}.`;
  renderAll();
};

document.getElementById('sCoin').onchange = e=>{ st.sel=e.target.value; renderAll(); };

document.getElementById('loanTakeBtn').onclick = () => {
  const amount = +document.getElementById('loanAmt').value;
  $('loanMsg').textContent = takeLoan(amount);
  renderAll();
};

document.getElementById('loanRepayBtn').onclick = () => {
  const amount = +document.getElementById('loanAmt').value;
  $('loanMsg').textContent = repayLoan(amount);
  renderAll();
};

document.getElementById('loanRepayMaxBtn').onclick = () => {
  const max = Math.min(st.cash, bank.loan);
  if(max <= 0){ $('loanMsg').textContent = '❌ Нечего погашать.'; return; }
  $('loanMsg').textContent = repayLoan(max);
  renderAll();
};
