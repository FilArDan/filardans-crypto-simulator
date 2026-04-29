/* ===== СОСТОЯНИЕ ИГРЫ ===== */

/* --- Игрок --- */
const st = {
  cash: START,
  sel:  SYMS[0],
  held: Object.fromEntries(SYMS.map(s=>[s,0])),
  avgP: Object.fromEntries(SYMS.map(s=>[s,0])),
  hist: [],
  pd:   Object.fromEntries(SYMS.map(s=>[s,[]])),
  paused: false,
  drift:  Object.fromEntries(SYMS.map(s=>[s,0])),
  vol:    Object.fromEntries(SYMS.map(s=>[s,COINS[s].vol])),
};



/* --- Утилиты --- */
const $ = id => document.getElementById(id);

const fmt = n => new Intl.NumberFormat('en-US',{
  style:'currency', currency:'USD',
  minimumFractionDigits:2, maximumFractionDigits:2
}).format(n);

const fmtC = n => Number(n).toFixed(4);

const fmtLarge = n => {
  if(n>=1e12) return (n/1e12).toFixed(2)+'T';
  if(n>=1e9)  return (n/1e9).toFixed(2)+'B';
  if(n>=1e6)  return (n/1e6).toFixed(2)+'M';
  return fmt(n);
};

const portV = held => SYMS.reduce((s,k)=>s+held[k]*COINS[k].price, 0);
const totalV = (cash,held) => cash + portV(held);

/* --- Начальная история цен --- */
SYMS.forEach(s => {
  let p = COINS[s].price;
  for(let i=0;i<30;i++){
    p = Math.max(1, p*(1+(Math.random()-.5)*COINS[s].vol));
    st.pd[s].push(+p.toFixed(2));
  }
  COINS[s].price = st.pd[s].at(-1);
});

/* --- Переменная скорости --- */
let tickSpeed = 1500; // мс между тиками (по умолчанию)
let tickTimer  = null;