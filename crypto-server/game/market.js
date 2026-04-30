const { db, COINS } = require('../db');

// Умное округление: сохраняет нужную точность в зависимости от масштаба цены
function roundPrice(p) {
  if (p >= 1000) return Math.round(p * 100)   / 100;
  if (p >= 10)   return Math.round(p * 1000)  / 1000;
  if (p >= 0.1)  return Math.round(p * 10000) / 10000;
  return           Math.round(p * 100000)     / 100000;
}

/**
 * Тик рынка:
 *   price *= (1 + noise + drift + pull)
 *   noise  — случайный шум, масштабируется на vol каждой монеты
 *   drift  — постоянный тренд ±%, задаётся администратором
 *   pull   — притяжение к basePrice (mean reversion)
 */
async function tick(io) {
  const prices = {};
  for (const coin of COINS) {
    const doc = await db.prices.findOne({ coin });
    const vol   = doc.vol       || 0.04;
    const drift = doc.drift     || 0;
    const base  = doc.basePrice || doc.price;

    const noise = (Math.random() - 0.5) * vol;
    const pull  = (base - doc.price) / base * 0.002;

    const newPrice = Math.max(0.0001, roundPrice(doc.price * (1 + noise + drift + pull)));
    await db.prices.update({ coin }, { $set: { price: newPrice } });
    prices[coin] = newPrice;
  }

  await db.events.insert({ ts: Date.now(), text: 'Рынок обновился 📈' });
  if (io) io.emit('priceUpdate', prices);
}

/**
 * Trade pressure: крупная сделка двигает цену.
 *   impact = min(log1p(amount / supply * 100) * 0.015, 0.20)
 *   Возвращает новую цену монеты.
 */
async function applyTradePressure(coin, amount, action) {
  const doc = await db.prices.findOne({ coin });
  if (!doc || !doc.supply || doc.supply <= 0) return doc ? doc.price : 0;

  const rawImpact = (amount / doc.supply) * 100;
  const impact    = Math.min(Math.log1p(rawImpact) * 0.015, 0.20);

  const newPrice = roundPrice(
    Math.max(0.0001,
      action === 'buy'
        ? doc.price * (1 + impact)
        : doc.price * (1 - impact)
    )
  );

  await db.prices.update({ coin }, { $set: { price: newPrice } });
  return newPrice;
}

module.exports = { tick, applyTradePressure };
