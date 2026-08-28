const express = require('express');
const router  = express.Router();
const { db, COINS, COIN_META, getAllCoins, EXCHANGE_USERNAME, EXCHANGE_CUSTOM_COIN_SUPPLY } = require('../db');
const { tick, applyTradePressure, deleteCoinHistory } = require('../game/market');
const { getBotStats, priceHistory, listBotsRaw, createBot, deleteBot, setBotCash, updateBotPreset } = require('../game/bots');
const { executeViaOrderBook } = require('../game/orderBook');

const TRADE_FEE = 0.004;   // 0.4% комиссия
const SPREAD    = 0.0015;  // ±0.15% спред (итого 0.3% между buy/sell ценой)
const USE_ORDER_BOOK = process.env.USE_ORDER_BOOK === 'true';

function auth(req, res, next) {
  if (!req.session.username) return res.status(401).json({ error: 'Не авторизован' });
  next();
}
function adminOnly(req, res, next) {
  if (req.session.role !== 'admin') return res.status(403).json({ error: 'Только для администратора' });
  next();
}

async function getAllPrices() {
  const docs = await db.prices.find({});
  const obj  = {};
  docs.forEach(d => { obj[d.coin] = d.price; });
  return obj;
}

async function emitBankUpdate(io) {
  try {
    const w = await db.wallets.findOne({ username: EXCHANGE_USERNAME });
    const loans = await db.loans.find({ paid: { $ne: true } });
    const totalIssued = loans.reduce((s, l) => s + (l.amount || 0), 0);
    const totalDebt   = loans.reduce((s, l) => s + (l.due    || 0), 0);
    if (w) io.emit('bankUpdate', { usd: w.usd || 0, totalIssued, totalDebt });
  } catch(_) {}
}

async function emitPlayersUpdate(io) {
  try {
    const prices     = await getAllPrices();
    const allWallets = await db.wallets.find({ username: { $ne: 'admin' } });
    const players = allWallets
      .filter(w => w.username !== EXCHANGE_USERNAME)
      .map(w => ({ username: w.username, usd: w.usd, coins: w, isBot: false }));
    const bots = (await getBotStats(prices)).map(b => ({
      username: b.username,
      usd:      b.usd,
      coins:    b.coins || {},
      isBot:    true,
      total:    b.total,
    }));
    players.push(...bots);
    io.emit('playersUpdate', players);
  } catch(_) {}
}

// ── ИСТОРИЯ ЦЕН ДЛЯ ЧАРТА ────────────────────────────────────────────────────
router.get('/price-history', auth, async (req, res) => {
  try {
    const coin  = (req.query.coin || '').toUpperCase();
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 500, 1), 500);
    if (!coin) return res.json([]);
    const docs = await db.priceHistory
      .find({ coin })
      .sort({ ts: 1 })
      .limit(limit);
    res.json(docs.map(d => ({ price: d.price, ts: d.ts })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── СОСТОЯНИЕ ──────────────────────────────────────────────────────────────────
router.get('/state', auth, async (req, res) => {
  try {
    const prices     = await getAllPrices();
    const wallet     = await db.wallets.findOne({ username: req.session.username });
    const loans      = await db.loans.find({ username: req.session.username, paid: { $ne: true } });
    const events     = await db.events.find({}).sort({ ts: -1 }).limit(25);
    const allWallets = await db.wallets.find({ username: { $ne: 'admin' } });
    const allCoins   = await getAllCoins();
    const players = allWallets
      .filter(w => w.username !== EXCHANGE_USERNAME)
      .map(w => ({ username: w.username, usd: w.usd, coins: w, isBot: false }));
    const bots = (await getBotStats(prices)).map(b => ({
      username: b.username,
      usd:      b.usd,
      coins:    b.coins || {},
      isBot:    true,
      total:    b.total,
    }));
    players.push(...bots);
    const paused = req.app.get('isPaused')();
    res.json({ prices, wallet, loans, events, players, coins: allCoins, paused, spread: SPREAD, tradeFee: TRADE_FEE });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ТОРГОВЛЯ ───────────────────────────────────────────────────────────────────
router.post('/trade', auth, async (req, res) => {
  try {
    const { coin, action } = req.body;
    const amount = parseFloat(req.body.amount);
    if (!Number.isFinite(amount) || amount <= 0)
      return res.json({ error: 'Неверное количество' });

    const allCoins = await getAllCoins();
    if (!allCoins.includes(coin)) return res.json({ error: 'Неизвестная монета' });

    const priceDoc       = await db.prices.findOne({ coin });
    const wallet         = await db.wallets.findOne({ username: req.session.username });
    const exchangeWallet = await db.wallets.findOne({ username: EXCHANGE_USERNAME });
    const midPrice       = priceDoc.price;
    const io             = req.app.get('io');

    if (action === 'buy') {
      const askPrice  = midPrice * (1 + SPREAD);
      const baseValue = askPrice * amount;
      const feeAmount = baseValue * TRADE_FEE;
      const cost      = baseValue + feeAmount;

      if (wallet.usd < cost) return res.json({ error: `Недостаточно USD (нужно $${cost.toFixed(2)})` });

      const exchangeHas = exchangeWallet ? (exchangeWallet[coin] || 0) : 0;
      if (exchangeHas < amount) {
        return res.json({ error: `Биржа не располагает достаточным запасом ${coin} (доступно: ${exchangeHas.toFixed(4)})` });
      }

      await db.wallets.update({ username: req.session.username }, { $inc: { usd: -cost,   [coin]: +amount } });
      await db.wallets.update({ username: EXCHANGE_USERNAME },    { $inc: { usd: +cost,   [coin]: -amount } });

      let newCoinPrice;
      if (USE_ORDER_BOOK) {
        const { avgPrice } = await executeViaOrderBook({ coin, username: req.session.username, action, amount });
        newCoinPrice = avgPrice || (await applyTradePressure(coin, amount, action));
      } else {
        newCoinPrice = await applyTradePressure(coin, amount, action);
      }

      const updatedPrices = await getAllPrices();
      const updated       = await db.wallets.findOne({ username: req.session.username });
      const txt = `${req.session.username} купил ${amount} ${coin} за $${cost.toFixed(2)} (ask: $${askPrice.toFixed(4)}, комиссия: $${feeAmount.toFixed(2)})`;
      const ev  = { ts: Date.now(), text: txt };
      await db.events.insert(ev);
      io.emit('newEvent', ev);
      io.emit('walletUpdate', { username: req.session.username, wallet: updated });
      io.emit('priceUpdate', updatedPrices);
      await emitBankUpdate(io);
      res.json({ wallet: updated, prices: updatedPrices });

    } else {
      const bidPrice  = midPrice * (1 - SPREAD);
      const baseValue = bidPrice * amount;
      const feeAmount = baseValue * TRADE_FEE;
      const proceeds  = baseValue - feeAmount;

      if ((wallet[coin] || 0) < amount) return res.json({ error: `Недостаточно ${coin}` });

      await db.wallets.update({ username: req.session.username }, { $inc: { usd: +proceeds, [coin]: -amount } });
      await db.wallets.update({ username: EXCHANGE_USERNAME },    { $inc: { usd: -proceeds, [coin]: +amount } });

      let newCoinPrice;
      if (USE_ORDER_BOOK) {
        const { avgPrice } = await executeViaOrderBook({ coin, username: req.session.username, action, amount });
        newCoinPrice = avgPrice || (await applyTradePressure(coin, amount, action));
      } else {
        newCoinPrice = await applyTradePressure(coin, amount, action);
      }

      const updatedPrices = await getAllPrices();
      const updated       = await db.wallets.findOne({ username: req.session.username });
      const txt = `${req.session.username} продал ${amount} ${coin} за $${proceeds.toFixed(2)} (bid: $${bidPrice.toFixed(4)}, комиссия: $${feeAmount.toFixed(2)})`;
      const ev  = { ts: Date.now(), text: txt };
      await db.events.insert(ev);
      io.emit('newEvent', ev);
      io.emit('walletUpdate', { username: req.session.username, wallet: updated });
      io.emit('priceUpdate', updatedPrices);
      await emitBankUpdate(io);
      res.json({ wallet: updated, prices: updatedPrices });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Остальной код маршрутов game.js остаётся без изменений

// ── КРЕДИТЫ, АДМИН, БОТЫ, КОЙНЫ и т.д. ────────────────────────────────────────
// (ниже идёт оригинальное содержимое файла)

router.get('/loan/info', auth, async (req, res) => {
  try {
    const { computeLoanRate, computeMarginRatio, portfolioValue, MAX_LOAN_RATIO, MARGIN_THRESHOLD } = require('../game/bank');
    const rate    = computeLoanRate(priceHistory);
    const wallet  = await db.wallets.findOne({ username: req.session.username });
    const prices  = await getAllPrices();
    const coins   = await getAllCoins();
    const portVal = portfolioValue(wallet, prices, coins);
    const maxLoan = Math.floor(portVal * MAX_LOAN_RATIO);
    const loan    = await db.loans.findOne({ username: req.session.username, paid: { $ne: true } });
    const marginRatio = loan ? computeMarginRatio(wallet, prices, coins, loan.due) : 0;
    res.json({ loan: loan || null, rate, maxLoan, portVal, marginThreshold: MARGIN_THRESHOLD, marginRatio });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ... (остальной исходный код game.js без изменений) ...

module.exports = router;
