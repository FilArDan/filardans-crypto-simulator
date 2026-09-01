/* ===== ГОСУДАРСТВЕННЫЕ КОМПАНИИ =====
 *
 * Компания технически — обычный тикер в db.prices (та же модель, что у монет),
 * поэтому торгуется через существующий /api/trade и лимитные ордера без единой
 * новой строчки в матчинге. db.companies хранит только то, чего у монет нет:
 * государство-учредителя и доход, который компания приносит держателям акций.
 */
const { db, getAllCoins, EXCHANGE_USERNAME, EXCHANGE_CUSTOM_COIN_SUPPLY } = require('../db');

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// ── Создание компании ────────────────────────────────────────────────────────
async function createCompany({ ticker, name, ownerNation, totalShares, startPrice, vol, drift, revenuePerTick, statePct }) {
  const cleanTicker = String(ticker || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  if (!cleanTicker) throw new Error('Укажи тикер (1–8 букв/цифр)');
  const allCoins = await getAllCoins();
  if (allCoins.includes(cleanTicker)) throw new Error(`Тикер ${cleanTicker} уже занят`);

  const cleanName = String(name || '').trim() || cleanTicker;

  const owner = String(ownerNation || '').trim();
  if (!owner) throw new Error('Укажи государство-владельца');
  const ownerUser = await db.users.findOne({ username: owner });
  if (!ownerUser) throw new Error('Государство-владелец не найдено');

  const shares = Math.max(1, Math.floor(Number(totalShares)) || 1000);
  const price  = Math.max(0.0001, Number(startPrice) || 1);
  const volume = Math.max(0.005, Math.min(0.30, Number(vol) || 0.03));
  const drft   = Math.max(-0.10, Math.min(0.10, Number(drift) || 0));
  const rev    = Math.max(0, Number(revenuePerTick) || 0);
  const pct    = Math.max(0, Math.min(100, Number(statePct) ?? 50));

  await db.prices.insert({ coin: cleanTicker, price, basePrice: price, vol: volume, drift: drft, supply: shares });
  await db.wallets.update({}, { $set: { [cleanTicker]: 0 } }, { multi: true });

  // Стартовый флоат: доля государства сразу зачисляется владельцу, остаток — в резерв биржи (публичный float)
  const stateShares    = Math.floor(shares * (pct / 100));
  const exchangeShares = shares - stateShares;
  if (stateShares > 0) {
    await db.wallets.update({ username: owner }, { $inc: { [cleanTicker]: stateShares } });
  }
  await db.wallets.update({ username: EXCHANGE_USERNAME }, { $set: { [cleanTicker]: exchangeShares || EXCHANGE_CUSTOM_COIN_SUPPLY } });

  await db.priceHistory.insert({ coin: cleanTicker, price, ts: Date.now() });

  await db.companies.insert({
    ticker: cleanTicker,
    name:   cleanName,
    ownerNation: owner,
    statePct: pct,
    revenuePerTick: rev,
    createdAt: Date.now(),
  });

  return db.companies.findOne({ ticker: cleanTicker });
}

// ── Правка компании (доход/владелец) ─────────────────────────────────────────
async function updateCompany(ticker, { revenuePerTick, ownerNation }) {
  const t = String(ticker || '').toUpperCase();
  const company = await db.companies.findOne({ ticker: t });
  if (!company) throw new Error('Компания не найдена');

  const patch = {};
  if (revenuePerTick != null) {
    const rev = Number(revenuePerTick);
    if (!Number.isFinite(rev) || rev < 0) throw new Error('Неверный доход за тик');
    patch.revenuePerTick = rev;
  }
  if (ownerNation != null && ownerNation !== '') {
    const owner = String(ownerNation).trim();
    const ownerUser = await db.users.findOne({ username: owner });
    if (!ownerUser) throw new Error('Государство-владелец не найдено');
    patch.ownerNation = owner;
  }
  if (Object.keys(patch).length) await db.companies.update({ ticker: t }, { $set: patch });
  return db.companies.findOne({ ticker: t });
}

// ── Удаление компании (акции выкупаются по рыночной цене, как обычная монета) ─
async function deleteCompany(ticker) {
  await db.companies.remove({ ticker: String(ticker || '').toUpperCase() }, {});
}

// ── Список компаний с рыночными данными ──────────────────────────────────────
async function listCompanies(prices, username) {
  const companies = await db.companies.find({});
  const wallet = username ? await db.wallets.findOne({ username }) : null;
  return companies.map(c => {
    const price = (prices && prices[c.ticker]) || 0;
    return {
      ticker:         c.ticker,
      name:           c.name,
      ownerNation:    c.ownerNation,
      revenuePerTick: c.revenuePerTick,
      price,
      myShares:       wallet ? (wallet[c.ticker] || 0) : 0,
    };
  });
}

async function getCompanySupply(ticker) {
  const doc = await db.prices.findOne({ coin: ticker });
  return doc ? (doc.supply || 0) : 0;
}

// ── Выплата дивидендов (вызывается из market.js#tick() после обновления цен) ──
async function payDividends(io) {
  const companies = await db.companies.find({ revenuePerTick: { $gt: 0 } });
  if (!companies.length) return;

  for (const company of companies) {
    const totalShares = await getCompanySupply(company.ticker);
    if (!totalShares) continue;

    const [wallets, bots] = await Promise.all([
      db.wallets.find({ [company.ticker]: { $gt: 0 }, username: { $ne: EXCHANGE_USERNAME } }),
      db.bots.find({ [`held.${company.ticker}`]: { $gt: 0 } }),
    ]);
    if (!wallets.length && !bots.length) continue;

    let totalHeld = 0;
    for (const w of wallets) totalHeld += w[company.ticker] || 0;
    for (const b of bots)    totalHeld += (b.held && b.held[company.ticker]) || 0;
    if (totalHeld <= 0) continue;

    const perShare = company.revenuePerTick / totalHeld;
    let paidOut = 0;

    for (const w of wallets) {
      const held = w[company.ticker] || 0;
      if (held <= 0) continue;
      const payout = round2(held * perShare);
      if (payout <= 0) continue;
      await db.wallets.update({ _id: w._id }, { $inc: { usd: payout } });
      paidOut += payout;
    }
    for (const b of bots) {
      const held = (b.held && b.held[company.ticker]) || 0;
      if (held <= 0) continue;
      const payout = round2(held * perShare);
      if (payout <= 0) continue;
      await db.bots.update({ _id: b._id }, { $inc: { usd: payout } });
      paidOut += payout;
    }

    if (paidOut > 0) {
      const ev = {
        ts: Date.now(),
        text: `${company.name} (${company.ticker}) выплатила дивиденды держателям: $${paidOut.toFixed(2)}`,
      };
      await db.events.insert(ev);
      if (io) io.emit('newEvent', ev);
    }
  }
}

module.exports = {
  createCompany,
  updateCompany,
  deleteCompany,
  listCompanies,
  payDividends,
};
