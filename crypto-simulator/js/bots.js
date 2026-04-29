/* ===== БОТЫ С ХАРАКТЕРАМИ ===== */

const BOT_COUNT = 10;
const bots = [
  /* 🐂 Агрессоры */
  { name:'Агрессор-1', type:'bull', cash:15000, held:Object.fromEntries(SYMS.map(s=>[s,0])), avgP:Object.fromEntries(SYMS.map(s=>[s,0])) },
  { name:'Агрессор-2', type:'bull', cash:18000, held:Object.fromEntries(SYMS.map(s=>[s,0])), avgP:Object.fromEntries(SYMS.map(s=>[s,0])) },

  /* 🦊 Осторожные */
  { name:'Лис-1',      type:'fox',  cash:10000, held:Object.fromEntries(SYMS.map(s=>[s,0])), avgP:Object.fromEntries(SYMS.map(s=>[s,0])) },
  { name:'Лис-2',      type:'fox',  cash:10000, held:Object.fromEntries(SYMS.map(s=>[s,0])), avgP:Object.fromEntries(SYMS.map(s=>[s,0])) },
  { name:'Лис-3',      type:'fox',  cash:12000, held:Object.fromEntries(SYMS.map(s=>[s,0])), avgP:Object.fromEntries(SYMS.map(s=>[s,0])) },

  /* 🐊 Накопители */
  { name:'Крок-1',     type:'croc', cash:20000, held:Object.fromEntries(SYMS.map(s=>[s,0])), avgP:Object.fromEntries(SYMS.map(s=>[s,0])), target:Object.fromEntries(SYMS.map(s=>[s, 1.25 + Math.random()*0.20])) },
  { name:'Крок-2',     type:'croc', cash:20000, held:Object.fromEntries(SYMS.map(s=>[s,0])), avgP:Object.fromEntries(SYMS.map(s=>[s,0])), target:Object.fromEntries(SYMS.map(s=>[s, 1.25 + Math.random()*0.20])) },

  /* 🦊 Осторожные */
  { name:'Лис-4',      type:'fox',  cash:9000,  held:Object.fromEntries(SYMS.map(s=>[s,0])), avgP:Object.fromEntries(SYMS.map(s=>[s,0])) },
  { name:'Лис-5',      type:'fox',  cash:11000, held:Object.fromEntries(SYMS.map(s=>[s,0])), avgP:Object.fromEntries(SYMS.map(s=>[s,0])) },
  { name:'Лис-6',      type:'fox',  cash:10000, held:Object.fromEntries(SYMS.map(s=>[s,0])), avgP:Object.fromEntries(SYMS.map(s=>[s,0])) },
];

/* --- Утилита: средняя цена за N тиков --- */
function getAvgPrice(sym, n){
  const hist = st.pd[sym];
  if(!hist || hist.length < 2) return COINS[sym].price;
  const slice = hist.slice(-n);
  return slice.reduce((s, p) => s + (p.price !== undefined ? p.price : p), 0) / slice.length;
}

/* --- 🐂 Агрессор --- */
function bullTick(bot){
  const sym = SYMS[Math.floor(Math.random() * SYMS.length)];
  const c   = COINS[sym];
  const avgLong = getAvgPrice(sym, 20);
  const roll    = Math.random();

// Бонус шанса если цена ниже базовой
  const belowBase = c.price < c.basePrice;
  const buyChance = belowBase ? 0.95 : 0.85; // было просто 0.85

  if(c.price < avgLong * 0.98 && roll < 0.85){
    // Дёшево — покупаем агрессивно
    const spend = bot.cash * (0.30 + Math.random() * 0.30);
    if(spend < 1) return;
    const amt  = spend / c.price;
    const cost = amt * c.price * (1 + FEE);
    if(cost > bot.cash) return;
    const prev    = bot.held[sym] * bot.avgP[sym];
    bot.cash     -= cost;
    bank.cash += amt * c.price * FEE;
    bot.held[sym] += amt;
    bot.avgP[sym]  = (prev + amt * c.price) / bot.held[sym];
    applyTradePressure(sym, amt, 'buy');

  } else if(c.price > avgLong * 1.03 && bot.held[sym] > 0 && roll < 0.80){
    // Дорого — сбрасываем большую часть
    const frac     = 0.50 + Math.random() * 0.40;
    const amt      = bot.held[sym] * frac;
    bot.held[sym] -= amt;
    bot.cash      += amt * c.price * (1 - FEE);
    bank.cash     += amt * c.price * FEE;
    if(bot.held[sym] < 0.0001) bot.held[sym] = 0;
    applyTradePressure(sym, amt, 'sell');
  }
}

/* --- 🦊 Осторожный --- */
function foxTick(bot){
  if(Math.random() > 0.40) return; // часто пропускает ход
  const sym     = SYMS[Math.floor(Math.random() * SYMS.length)];
  const c       = COINS[sym];
  const avgShort = getAvgPrice(sym, 5);
  const avgLong  = getAvgPrice(sym, 20);
  const roll     = Math.random();
  
  const belowBase = c.price < c.basePrice;
  const buyChance = belowBase ? 0.80 : 0.60; // было 0.60

  if(c.price < avgLong * 0.97 && roll < 0.60){
    // Чуть дешевле нормы — маленькая покупка
    const spend = bot.cash * (0.02 + Math.random() * 0.06);
    if(spend < 1) return;
    const amt  = spend / c.price;
    const cost = amt * c.price * (1 + FEE);
    if(cost > bot.cash) return;
    const prev    = bot.held[sym] * bot.avgP[sym];
    bot.cash     -= cost;
    bank.cash += amt * c.price * FEE;
    bot.held[sym] += amt;
    bot.avgP[sym]  = (prev + amt * c.price) / bot.held[sym];
    applyTradePressure(sym, amt, 'buy');

  } else if(c.price > avgLong * 1.05 && bot.held[sym] > 0 && roll < 0.50){
    // Заметно дороже нормы — фиксируем небольшую часть
    const frac     = 0.10 + Math.random() * 0.20;
    const amt      = bot.held[sym] * frac;
    bot.held[sym] -= amt;
    bot.cash      += amt * c.price * (1 - FEE);
    bank.cash     += amt * c.price * FEE;
    if(bot.held[sym] < 0.0001) bot.held[sym] = 0;
    applyTradePressure(sym, amt, 'sell');
  }
}

/* --- 🐊 Накопитель --- */
function crocTick(bot){
  const sym = SYMS[Math.floor(Math.random() * SYMS.length)];
  const c   = COINS[sym];
  const avg = bot.avgP[sym];

  const belowBase = c.price < c.basePrice;
  const buyProb   = belowBase ? 0.85 : 0.65; // было 0.65

  // Фаза накопления — покупает понемногу почти всегда
  if(Math.random() < 0.65){
    const spend = bot.cash * (0.01 + Math.random() * 0.03);
    if(spend < 1) return;
    const amt  = spend / c.price;
    const cost = amt * c.price * (1 + FEE);
    if(cost > bot.cash) return;
    const prev    = bot.held[sym] * bot.avgP[sym];
    bot.cash     -= cost;
    bot.held[sym] += amt;
    bank.cash += amt * c.price * FEE;
    bot.avgP[sym]  = (prev + amt * c.price) / bot.held[sym];
    applyTradePressure(sym, amt, 'buy');
  }

  // Фаза сброса — ждёт цели и продаёт ВСЁ сразу
  if(avg > 0 && bot.held[sym] > 0){
    const targetMult = bot.target[sym] || 1.30;
    if(c.price >= avg * targetMult){
      // Вместо одного дампа — продаём по 20% за тик
      const dumpFrac = Math.min(1, 0.20);
      const amt      = bot.held[sym] * dumpFrac;
      bot.cash      += amt * c.price * (1 - FEE);
      bank.cash     += amt * c.price * FEE;
      bot.held[sym] -= amt;
      if(bot.held[sym] < 0.0001){
        bot.held[sym] = 0;
        bot.avgP[sym] = 0;
        bot.target[sym] = 1.25 + Math.random() * 0.20;
      } 
applyTradePressure(sym, amt, 'sell');
      // Сброс цели — ждём следующего цикла
      bot.target[sym] = 1.25 + Math.random() * 0.20;
      applyTradePressure(sym, amt, 'sell');
    }
  }
}

/* --- Главный тик всех ботов --- */
function botTick(){
  bots.forEach(bot => {
    if(bot.type === 'bull') bullTick(bot);
    else if(bot.type === 'fox')  foxTick(bot);
    else if(bot.type === 'croc') crocTick(bot);
  });
}

/* --- Установить бюджет бота из панели настроек --- */
function setBotBudget(i){
  const inp = $(`botInp-${i}`), v = parseFloat(inp.value);
  if(isNaN(v) || v < 0){ inp.style.borderColor='var(--dan)'; return; }
  inp.style.borderColor = '';
  bots[i].cash = v;
  inp.value = '';
  $(`botCash-${i}`).textContent = `Баланс: ${fmt(bots[i].cash)}`;
}

/* --- Обновить отображение балансов ботов --- */
function updateBotCashes(){
  bots.forEach((bot, i) => {
    const el = $(`botCash-${i}`);
    if(el) el.textContent = `Баланс: ${fmt(bot.cash)} | Портфель: ${fmt(portV(bot.held))}`;
  });
}