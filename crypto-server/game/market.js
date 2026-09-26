const { db, getAllCoins, EXCHANGE_USERNAME, DEFAULT_LIQUIDITY } = require('../db');
const { updatePriceHistory, botTick, priceHistory, getBotStats } = require('./bots');
const { accrueInterest } = require('./bank');
const { getMarketStats } = require('./marketStats');
const { getVolume } = require('./volume');

function roundPrice(p) {
  if (p >= 1000) return Math.round(p * 100)   / 100;
  if (p >= 10)   return Math.round(p * 1000)  / 1000;
  if (p >= 0.1)  return Math.round(p * 10000) / 10000;
  return           Math.round(p * 100000)     / 100000;
}

async function emitPlayersUpdate(io, currentPrices) {
  try {
    const allWallets = await db.wallets.find({ username: { $ne: 'admin' } });
    const allUsers    = await db.users.find({});
    const profileByUsername = {};
    allUsers.forEach(u => {
      profileByUsername[u.username] = {
        displayName: u.displayName || u.username,
        avatarUrl:   u.avatarPath ? `/avatars/${u.avatarPath}` : null,
      };
    });
    const players = allWallets
      .filter(w => w.username !== EXCHANGE_USERNAME && !w.username.startsWith('UNION_'))
      .map(w => ({
        username: w.username,
        usd: w.usd,
        coins: w,
        isBot: false,
        ...(profileByUsername[w.username] || { displayName: w.username, avatarUrl: null }),
      }));
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

// ── Моментум и кластеризация волатильности ────────────────────────────────────
// Раньше шум каждого тика был независим от предыдущего — на графике не было
// вообще никакой инерции, поэтому любые "паттерны" (флаги, клинья) были чистой
// иллюзией, а не сигналом. Теперь:
//  1) MOMENTUM — доля предыдущего шага, переносимая в текущий: тренды реально
//     продолжаются несколько тиков подряд, а не гасятся случайностью тут же.
//  2) Кластеризация волатильности (GARCH-lite) — эффективный vol монеты сам
//     плавает вокруг базового значения, подскакивая после резких движений и
//     затухая на спокойном рынке (доп. поле volState в db.prices).
// Подобраны и проверены симуляцией на 5000+ тиков (autocorr шага ~0.35,
// autocorr |шага| ~0.15, цена не разбегается на реалистичных vol/drift).
const MOMENTUM           = 0.35;
const VOL_CLUSTER_DECAY  = 0.85;
const VOL_SHOCK_GAIN     = 2.2;
const VOL_MIN_MULT       = 0.3;
const VOL_MAX_MULT       = 3;
// Если по активу не было ни одной сделки за последнее окно объёма
// (game/volume.js, 10 тиков) — цена всё равно не должна блуждать так,
// будто рынок живой: движение цены должно быть следствием сделок, а не
// идти само по себе. Не гасим шум полностью (совсем плоский график
// выглядел бы подозрительно и терял инерцию/кластеризацию волатильности),
// а сильно уменьшаем его.
const DEAD_MARKET_NOISE_MULT = 0.12;

async function tick(io) {
  const coins  = await getAllCoins();
  const prices = {};

  for (const coin of coins) {
    const doc = await db.prices.findOne({ coin });
    if (!doc) continue;
    const baseVol = doc.vol       || 0.04;  // базовая нестабильность (задаётся ГМом)
    const drift   = doc.drift     || 0;     // тренд развития
    const base    = doc.basePrice || doc.price; // базовая стоимость

    const prevVolState = doc.volState > 0 ? doc.volState : baseVol;
    const noiseMult = getVolume(coin) > 0 ? 1 : DEAD_MARKET_NOISE_MULT;
    const rawNoise = (Math.random() - 0.5) * prevVolState * noiseMult;
    const momentum = (doc.momentum || 0) * MOMENTUM + rawNoise * (1 - MOMENTUM);

    const pull  = (base - doc.price) / base * 0.002;
    const newPrice = Math.max(0.0001, roundPrice(doc.price * (1 + momentum + drift + pull)));

    const shock = Math.abs(momentum);
    let nextVolState = prevVolState * VOL_CLUSTER_DECAY
      + (baseVol * 0.4 + shock * VOL_SHOCK_GAIN) * (1 - VOL_CLUSTER_DECAY);
    nextVolState = Math.min(Math.max(nextVolState, baseVol * VOL_MIN_MULT), baseVol * VOL_MAX_MULT);

    await db.prices.update({ coin }, { $set: { price: newPrice, momentum, volState: nextVolState } });
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

  // Δ1/Δ10/marketCap/volume в списке активов раньше пересчитывались у
  // клиента только при вызове /api/state (по клику игрока) — сама цена уже
  // обновлялась каждый тик через priceUpdate, а Δ так и оставалась
  // «замороженной» до следующего действия игрока. Шлём отдельным событием
  // на каждый тик — так же, как выше price/bank/players.
  if (io) io.emit('marketStats', await getMarketStats());

  // Снимок объёма торгов за этот тик (боты + матчинг лимитных ордеров уже
  // отработали выше) — в скользящее окно последних тиков для списка активов.
  require('./volume').rotateTick(coins);

  await accrueInterest(io, updatedPrices, priceHistory);

  // Выплата дивидендов держателям акций государственных компаний
  const { payDividends } = require('./companies');
  await payDividends(io);

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
  const liquidity = doc.liquidity > 0 ? doc.liquidity : DEFAULT_LIQUIDITY;
  const rawImpact = (amount / doc.supply) * 100;
  const impact    = Math.min(Math.log1p(rawImpact) * (0.015 / liquidity), 0.20);
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
