// ===== РЫНОЧНАЯ ЛОГИКА (только ГМ запускает tick) =====
import { SYMS, FEE, PD_MAX } from './coins.js';
import { getMarket, setMarket, getBank, setBank, getBots, setBots, getPlayers } from './state.js';
import { emitToAll, MSG } from './socket.js';

export function tick() {
  const market = getMarket();
  const bank   = getBank();

  SYMS.forEach(s => {
    const c     = market.coins[s];
    const noise = (Math.random() - .5) * market.vol[s];
    const trend = market.drift[s];
    const pull  = (c.basePrice - c.price) / c.basePrice * 0.002;
    c.price = Math.max(0.01, +(c.price * (1 + noise + trend + pull)).toFixed(2));
    market.pd[s].push(c.price);
    if(market.pd[s].length > PD_MAX) market.pd[s].shift();
  });

  // Боты
  const bots = getBots();
  bots.forEach(bot => {
    if(bot.type === 'bull')      bullTick(bot, market, bank);
    else if(bot.type === 'fox')  foxTick(bot, market, bank);
    else if(bot.type === 'croc') crocTick(bot, market, bank);
  });
  setBots(bots);

  // Банк: начисляем проценты игрокам с долгом
  updateLoanRate(market, bank);
  accrueInterestAll(bank);
  setBank(bank);
  setMarket(market);

  // Рассылаем всем клиентам
  emitToAll(MSG.TICK_UPDATE, { market, bank, bots });
}

function applyPressure(market, sym, amount, action) {
  const c = market.coins[sym];
  const rawImpact = (amount / c.supply) * 100;
  const impact = Math.min(Math.log1p(rawImpact) * 0.015, 0.20);
  c.price = Math.max(0.01, +(c.price * (action === 'buy' ? 1 + impact : 1 - impact)).toFixed(2));
  market.pd[sym].push(c.price);
  if(market.pd[sym].length > PD_MAX) market.pd[sym].shift();
}

// ---- Обработка сделки игрока (вызывается у ГМ) ----
export function processTradeRequest({ userId, action, sym, amount }, market, bank) {
  const FmtErr = msg => ({ ok: false, msg });
  const players = getPlayers();
  const player  = players[userId];
  if(!player) return FmtErr('Игрок не найден.');
  if(player.frozen) return FmtErr('❌ Счёт заморожен.');
  if(player.sanctions?.[sym]) return FmtErr(`❌ Торговля ${sym} заблокирована санкциями.`);

  const c = market.coins[sym];
  if(action === 'buy') {
    const cost = amount * c.price * (1 + FEE);
    if(player.cash < cost) return FmtErr(`❌ Не хватает. Нужно $${cost.toFixed(2)}, есть $${player.cash.toFixed(2)}.`);
    const prev = player.held[sym] * player.avgP[sym];
    bank.cash     += amount * c.price * FEE;
    player.cash   -= cost;
    player.held[sym] += amount;
    player.avgP[sym]  = (prev + amount * c.price) / player.held[sym];
    applyPressure(market, sym, amount, 'buy');
  } else {
    if(player.held[sym] < amount) return FmtErr(`❌ Только ${player.held[sym].toFixed(4)} ${sym}.`);
    const proceeds = amount * c.price * (1 - FEE);
    bank.cash     += amount * c.price * FEE;
    player.cash   += proceeds;
    player.held[sym] -= amount;
    if(player.held[sym] < 0.0001) { player.held[sym] = 0; player.avgP[sym] = 0; }
    applyPressure(market, sym, amount, 'sell');
  }

  player.hist.push({
    t: action === 'buy' ? 'B' : 'S', s: sym, a: amount,
    p: c.price, tot: amount * c.price,
    time: new Date().toLocaleTimeString('ru-RU')
  });
  if(player.hist.length > 500) player.hist.shift();

  players[userId] = player;
  return { ok: true, player, msg: action === 'buy'
    ? `✅ Куплено ${amount.toFixed(4)} ${sym} по $${c.price}`
    : `✅ Продано ${amount.toFixed(4)} ${sym} по $${c.price}` };
}

function updateLoanRate(market, bank) {
  const avgChange = SYMS.reduce((sum, s) => {
    const hist = market.pd[s];
    if(hist.length < 5) return sum;
    const p1 = hist.at(-1), p2 = hist.at(-5);
    return sum + (p1 - p2) / p2;
  }, 0) / SYMS.length;
  bank.loanRate = Math.max(0.0005, Math.min(0.005,
    0.001 * (1 + avgChange * 10) * (bank.cash > 50000 ? 0.8 : 1.2)
  ));
}

function accrueInterestAll(bank) {
  // Проценты по долгу банка (игрок берёт через UI)
  if(bank.loan > 0) bank.loan *= (1 + bank.loanRate);
}

// ---- Боты ----
function getAvg(market, sym, n) {
  const h = market.pd[sym];
  if(!h || h.length < 2) return market.coins[sym].price;
  return h.slice(-n).reduce((s, v) => s + v, 0) / Math.min(h.length, n);
}

function bullTick(bot, market, bank) {
  const sym = SYMS[Math.floor(Math.random() * SYMS.length)];
  const c   = market.coins[sym];
  const avg = getAvg(market, sym, 20);
  if(c.price < avg * 0.98 && Math.random() < 0.85) {
    const spend = bot.cash * (0.3 + Math.random() * 0.3);
    if(spend < 1) return;
    const amt = spend / c.price, cost = amt * c.price * (1 + FEE);
    if(cost > bot.cash) return;
    const prev = bot.held[sym] * bot.avgP[sym];
    bot.cash -= cost; bank.cash += amt * c.price * FEE;
    bot.held[sym] += amt;
    bot.avgP[sym] = (prev + amt * c.price) / bot.held[sym];
    applyPressure(market, sym, amt, 'buy');
  } else if(c.price > avg * 1.03 && bot.held[sym] > 0 && Math.random() < 0.8) {
    const amt = bot.held[sym] * (0.5 + Math.random() * 0.4);
    bot.held[sym] -= amt; bot.cash += amt * c.price * (1 - FEE);
    bank.cash += amt * c.price * FEE;
    if(bot.held[sym] < 0.0001) bot.held[sym] = 0;
    applyPressure(market, sym, amt, 'sell');
  }
}

function foxTick(bot, market, bank) {
  if(Math.random() > 0.4) return;
  const sym = SYMS[Math.floor(Math.random() * SYMS.length)];
  const c   = market.coins[sym];
  const avg = getAvg(market, sym, 20);
  if(c.price < avg * 0.97 && Math.random() < 0.6) {
    const spend = bot.cash * (0.02 + Math.random() * 0.06);
    if(spend < 1) return;
    const amt = spend / c.price, cost = amt * c.price * (1 + FEE);
    if(cost > bot.cash) return;
    const prev = bot.held[sym] * bot.avgP[sym];
    bot.cash -= cost; bank.cash += amt * c.price * FEE;
    bot.held[sym] += amt;
    bot.avgP[sym] = (prev + amt * c.price) / bot.held[sym];
    applyPressure(market, sym, amt, 'buy');
  } else if(c.price > avg * 1.05 && bot.held[sym] > 0 && Math.random() < 0.5) {
    const amt = bot.held[sym] * (0.1 + Math.random() * 0.2);
    bot.held[sym] -= amt; bot.cash += amt * c.price * (1 - FEE);
    bank.cash += amt * c.price * FEE;
    if(bot.held[sym] < 0.0001) bot.held[sym] = 0;
    applyPressure(market, sym, amt, 'sell');
  }
}

function crocTick(bot, market, bank) {
  const sym = SYMS[Math.floor(Math.random() * SYMS.length)];
  const c   = market.coins[sym];
  if(Math.random() < 0.65) {
    const spend = bot.cash * (0.01 + Math.random() * 0.03);
    if(spend < 1) return;
    const amt = spend / c.price, cost = amt * c.price * (1 + FEE);
    if(cost > bot.cash) return;
    const prev = bot.held[sym] * bot.avgP[sym];
    bot.cash -= cost; bank.cash += amt * c.price * FEE;
    bot.held[sym] += amt;
    bot.avgP[sym] = (prev + amt * c.price) / bot.held[sym];
    applyPressure(market, sym, amt, 'buy');
  }
  const avg = bot.avgP[sym];
  if(avg > 0 && bot.held[sym] > 0 && c.price >= avg * (bot.target?.[sym] ?? 1.3)) {
    const amt = bot.held[sym] * 0.2;
    bot.cash += amt * c.price * (1 - FEE);
    bank.cash += amt * c.price * FEE;
    bot.held[sym] -= amt;
    if(bot.held[sym] < 0.0001) { bot.held[sym] = 0; bot.avgP[sym] = 0; }
    if(bot.target) bot.target[sym] = 1.25 + Math.random() * 0.2;
    applyPressure(market, sym, amt, 'sell');
  }
}
