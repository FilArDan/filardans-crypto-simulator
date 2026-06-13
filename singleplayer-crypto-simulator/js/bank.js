/* ===== БАНК ===== */

const bank = {
  cash:     0,
  loan:     0,
  loanRate: 0.001,
};

/* --- Динамическая ставка --- */
function updateLoanRate(){
  const avgChange = SYMS.reduce((sum, s) => {
    const hist = st.pd[s];
    if(hist.length < 5) return sum;
    const p1 = hist.at(-1).price ?? hist.at(-1);
    const p2 = hist.at(-5).price ?? hist.at(-5);
    return sum + (p1 - p2) / p2;
  }, 0) / SYMS.length;

  const bankFactor = bank.cash > 50000 ? 0.8 : 1.2;
  bank.loanRate = Math.max(0.0005,
    Math.min(0.005, 0.001 * (1 + avgChange * 10) * bankFactor)
  );
}

/* --- Взять кредит --- */
function takeLoan(amount){
  if(amount <= 0)        { return '❌ Сумма должна быть больше нуля.'; }
  if(bank.loan > 0)      { return '❌ Сначала погаси текущий кредит.'; }
  if(bank.cash < amount) { return '❌ В банке недостаточно средств.'; }
  if(amount > 500_000)   { return '❌ Максимум кредита — $500,000.'; }

  bank.cash -= amount;
  bank.loan += amount;
  st.cash   += amount;
  return `✅ Кредит ${fmt(amount)} выдан. Ставка: ${(bank.loanRate * 100).toFixed(3)}%/тик`;
}

/* --- Погасить кредит --- */
function repayLoan(amount){
  if(amount <= 0)      { return '❌ Сумма должна быть больше нуля.'; }
  if(bank.loan <= 0)   { return '❌ У тебя нет долга.'; }
  if(st.cash < amount) { return '❌ Недостаточно средств.'; }

  const pay  = Math.min(amount, bank.loan);
  st.cash   -= pay;
  bank.cash += pay;
  bank.loan -= pay;
  if(bank.loan < 0.01) bank.loan = 0;
  return `✅ Погашено ${fmt(pay)}. Остаток долга: ${fmt(bank.loan)}`;
}

/* --- Начисление процентов (вызывать в tick()) --- */
function accrueInterest(){
  if(bank.loan <= 0) return;
  const interest = bank.loan * bank.loanRate;
  bank.loan += interest;   // долг игрока растёт
  bank.cash += interest;   // банк получает эти проценты в казну

  if(bank.loan > totalV(st.cash, st.held) * 0.9){
    marginCall();
  }
}

/* --- Маржин-колл --- */
function marginCall(){
  SYMS.forEach(s => {
    if(st.held[s] > 0){
      const proceeds = st.held[s] * COINS[s].price * (1 - FEE);
      bank.cash     += st.held[s] * COINS[s].price * FEE;
      st.cash       += proceeds;
      st.held[s]     = 0;
      st.avgP[s]     = 0;
    }
  });

  const pay  = Math.min(st.cash, bank.loan);
  st.cash   -= pay;
  bank.cash += pay;
  bank.loan -= pay;
  if(bank.loan < 0.01) bank.loan = 0;

  $('msgBox').textContent = '🚨 МАРЖИН-КОЛЛ! Все активы принудительно проданы для погашения долга.';
}
