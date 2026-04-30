const { db, COINS } = require('../db');

async function tick(io) {
  const prices = {};
  for (const coin of COINS) {
    const doc = await new Promise((res,rej) => db.prices.findOne({ coin }, (e,d) => e?rej(e):res(d)));
    const change = 1 + (Math.random() - 0.48) * 0.06;
    const newPrice = Math.max(0.001, Math.round(doc.price * change * 10000) / 10000);
    await new Promise((res,rej) => db.prices.update({ coin }, { $set: { price: newPrice } }, {}, (e)=>e?rej(e):res()));
    prices[coin] = newPrice;
  }
  await new Promise((res,rej) => db.events.insert({ ts: Date.now(), text: 'Рынок обновился 📈' }, (e)=>e?rej(e):res()));
  if (io) io.emit('priceUpdate', prices);
}

module.exports = { tick };