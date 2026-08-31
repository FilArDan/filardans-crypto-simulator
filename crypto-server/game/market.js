const { db, getAllCoins, EXCHANGE_USERNAME } = require('../db');
const { updatePriceHistory, botTick, priceHistory, getBotStats } = require('./bots');
const { accrueInterest } = require('./bank');

function roundPrice(p) {
  if (p >= 1000) return Math.round(p * 100)   / 100;
  if (p >= 10)   return Math.round(p * 1000)  / 1000;
  if (p >= 0.1)  return Math.round(p * 10000) / 10000;
  return           Math.round(p * 100000)     / 100000;
}

async function emitPlayersUpdate(io, currentPrices) {
  try {
    const allWallets = await db.wallets.find({ username: { $ne: 'admin' } });
    const players = allWallets
      .filter(w => w.username !== EXCHANGE_USERNAME)
      .map(w => ({ username: w.username, usd: w.usd, coins: w, isBot: false }));
    const bots = (await getBotStats(currentPrices)).map(b => ({
      username: b.username,
      usd:      b.usd,
      coins:    b.coins || {},
      isBot:    true,
      total:    b.total,
    }));
    players.push(...bots);
    io.emit('playersUpdate', players);
  } catch (_) {}
}

// Сохраняет историю торгового цикла (безограничная история котировок)
async function savePriceHistoryTick(prices) {
  const ts = Date.now();
  for (const [coin, price] of Object.entries(prices)) {
    if (typeof price !== 'number' || !isFinite(price)) continue;
    await db.priceHistory.insert({ coin, price, ts });
  }
}

// Удаляет историю актива (при удалении актива или по запросу ГМ)
async function deleteCoinHistory(coin) {
  await db.priceHistory.remove({ coin }, { multi: true });
}

async function tick(io) {
  const coins  = await getAllCoins();
  const prices = {};

  for (const coin of coins) {
    const doc = await db.prices.findOne({ coin });
    if (!doc) continue;
    const vol   = doc.vol       || 0.04;  // нестабильность рынка
    const drift = doc.drift     || 0;    // тренд развития
    const base  = doc.basePrice || doc.price; // базовая стоимость
    const noise = (Math.random() - 0.5) * vol;
    const pull  = (base - doc.price) / base * 0.002;
    const newPrice = Math.max(0.0001, roundPrice(doc.price * (1 + noise + drift + pull)));
    await db.prices.update({ coin }, { $set: { price: newPrice } });
    prices[coin] = newPrice;
  }

  await db.events.insert({ ts: Date.now(), text: 'Торговый цикл завершён 📈' });
  if (io) io.emit('priceUpdate', prices);

  updatePriceHistory(prices);

  // Сохраняем тик в persistent DB для чарта
  await savePriceHistoryTick(prices);

  await botTick(io, prices);

  let updatedDocs = await db.prices.find({});
  let updatedPrices = {};
  updatedDocs.forEach(d => { updatedPrices[d.coin] = d.price; });

  // Исполняем лимитные ордера по новым котировкам
  const { runMatching } = require('./orders');
  const matched = await runMatching(io, updatedPrices);
  if (matched.fills > 0) {
    updatedDocs   = await db.prices.find({});
    updatedPrices = {};
    updatedDocs.forEach(d => { updatedPrices[d.coin] = d.price; });
  }

  if (io) io.emit('priceUpdate', updatedPrices);

  await accrueInterest(io, updatedPrices, priceHistory);

  // Заставляем резервный фонд МТП после каждого цикла
  if (io) {
    try {
      const exchWallet = await db.wallets.findOne({ username: EXCHANGE_USERNAME });
      const loans = await db.loans.find({ paid: { $ne: true } });
      const totalIssued = loans.reduce((s, l) => s + (l.amount || 0), 0);
      const totalDebt   = loans.reduce((s, l) => s + (l.due    || 0), 0);
      if (exchWallet) io.emit('bankUpdate', { usd: exchWallet.usd || 0, totalIssued, totalDebt });
    } catch (_) {}
  }

  if (io) await emitPlayersUpdate(io, updatedPrices);
}

async function applyTradePressure(coin, amount, action) {
  const doc = await db.prices.findOne({ coin });
  if (!doc || !doc.supply || doc.supply <= 0) return doc ? doc.price : 0;
  const rawImpact = (amount / doc.supply) * 100;
  const impact    = Math.min(Math.log1p(rawImpact) * 0.015, 0.20);
  const newPrice  = roundPrice(
    Math.max(0.0001,
      action === 'buy'
        ? doc.price * (1 + impact)
        : doc.price * (1 - impact)
    )
  );
  await db.prices.update({ coin }, { $set: { price: newPrice } });
  return newPrice;
}

module.exports = { tick, applyTradePressure, deleteCoinHistory };
