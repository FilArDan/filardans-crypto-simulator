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

      // Проверяем запас монет у биржи
      const exchangeHas = exchangeWallet ? (exchangeWallet[coin] || 0) : 0;
      if (exchangeHas < amount) {
        return res.json({ error: `Биржа не располагает достаточным запасом ${coin} (доступно: ${exchangeHas.toFixed(4)})` });
      }

      // Игрок платит USD → биржа; биржа отдаёт монеты → игрок
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

      // Игрок отдаёт монеты → биржа; биржа платит USD → игрок
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

// ── ПЕРЕВОД ────────────────────────────────────────────────────────────────────
router.post('/transfer', auth, async (req, res) => {
  try {
    const { to } = req.body;
    const numAmount = parseFloat(req.body.amount);
    if (!Number.isFinite(numAmount) || numAmount <= 0)
      return res.json({ error: 'Неверная сумма' });
    if (to === req.session.username) return res.json({ error: 'Нельзя переводить себе' });
    if (to === EXCHANGE_USERNAME)    return res.json({ error: 'Нельзя переводить на системный счёт' });

    const from = await db.wallets.findOne({ username: req.session.username });
    if (from.usd < numAmount) return res.json({ error: 'Недостаточно USD' });

    const toUser = await db.wallets.findOne({ username: to });
    const toBot  = !toUser ? await db.bots.findOne({ name: to }) : null;
    if (!toUser && !toBot) return res.json({ error: 'Получатель не найден' });

    await db.wallets.update({ username: req.session.username }, { $inc: { usd: -numAmount } });
    if (toUser) {
      await db.wallets.update({ username: to }, { $inc: { usd: numAmount } });
    } else {
      await db.bots.update({ name: to }, { $inc: { usd: numAmount } });
    }

    const io = req.app.get('io');
    const ev = { ts: Date.now(), text: `${req.session.username} перевёл $${numAmount} → ${to}${toBot ? ' (бот)' : ''}` };
    await db.events.insert(ev);
    io.emit('newEvent', ev);
    await emitPlayersUpdate(io);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── КРЕДИТЫ ────────────────────────────────────────────────────────────────────
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

// ... остальной код из main должен быть ниже ...

// ── ADMIN: coins meta ────────────────────────────────────────────────────────
router.get('/admin/coins', (req, res) => {
  if (!req.session || req.session.role !== 'admin')
    return res.status(403).json({ error: 'Admin only' });
  try {
    const getCoinMeta = req.app.get('getCoinMeta');
    const coinMeta = typeof getCoinMeta === 'function'
      ? getCoinMeta()
      : (req.app.get('coinMeta') || {});
    res.json(coinMeta || {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ADMIN: tick speed ────────────────────────────────────────────────────────
router.get('/admin/tick-speed', (req, res) => {
  if (!req.session || req.session.role !== 'admin')
    return res.status(403).json({ error: 'Admin only' });
  try {
    const getTickSpeed = req.app.get('getTickSpeed');
    const ms = typeof getTickSpeed === 'function' ? getTickSpeed() : null;
    res.json({ ms });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/admin/set-tick-speed', (req, res) => {
  if (!req.session || req.session.role !== 'admin')
    return res.status(403).json({ error: 'Admin only' });
  try {
    const { ms } = req.body;
    if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) {
      return res.status(400).json({ error: 'Некорректная скорость' });
    }
    const setTickSpeed = req.app.get('setTickSpeed');
    if (typeof setTickSpeed !== 'function') {
      return res.status(500).json({ error: 'setTickSpeed недоступен' });
    }
    setTickSpeed(ms);
    res.json({ ok: true, ms });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ADMIN: exchange assets ───────────────────────────────────────────────────
router.get('/admin/exchange-assets', async (req, res) => {
  if (!req.session || req.session.role !== 'admin')
    return res.status(403).json({ error: 'Admin only' });
  try {
    const getPrices = req.app.get('getPrices');
    const getCoinMeta = req.app.get('getCoinMeta');
    const prices = typeof getPrices === 'function'
      ? (getPrices() || {})
      : (req.app.get('prices') || {});
    const coinMeta = typeof getCoinMeta === 'function'
      ? (getCoinMeta() || {})
      : (req.app.get('coinMeta') || {});

    const exchange = await db.wallets.findOne({ username: 'EXCHANGE' });
    if (!exchange) {
      return res.json({ usd: 0, totalCoinValue: 0, totalAssets: 0, coinAssets: [] });
    }

    const usd = exchange.usd || 0;
    const skipKeys = new Set(['username', '_id', 'usd', 'isBot', 'botType', 'botEmoji']);
    let totalCoinValue = 0;
    const coinAssets = [];

    Object.keys(exchange).forEach(key => {
      if (skipKeys.has(key)) return;
      const qty = exchange[key] || 0;
      const price = prices[key] || 0;
      const usdValue = qty * price;
      totalCoinValue += usdValue;
      const m = coinMeta[key] || {};
      coinAssets.push({
        coin: key,
        name: m.name || key,
        emoji: m.emoji || '🪙',
        qty,
        price,
        usdValue,
      });
    });

    coinAssets.sort((a, b) => b.usdValue - a.usdValue);

    res.json({
      usd,
      totalCoinValue,
      totalAssets: usd + totalCoinValue,
      coinAssets,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ADMIN: bots list ─────────────────────────────────────────────────────────
router.get('/admin/bots', async (req, res) => {
  if (!req.session || req.session.role !== 'admin')
    return res.status(403).json({ error: 'Admin only' });
  try {
    const getPrices = req.app.get('getPrices');
    const prices = typeof getPrices === 'function'
      ? (getPrices() || {})
      : (req.app.get('prices') || {});

    const bots = await db.wallets.find({ isBot: true });
    const skipKeys = new Set(['username', '_id', 'usd', 'isBot', 'botType', 'botEmoji']);

    const result = (bots || []).map(b => {
      const held = {};
      let coinValue = 0;
      Object.keys(b).forEach(key => {
        if (skipKeys.has(key)) return;
        const qty = b[key] || 0;
        held[key] = qty;
        coinValue += qty * (prices[key] || 0);
      });
      return {
        username: b.username,
        botType: b.botType || 'unknown',
        botEmoji: b.botEmoji || '🤖',
        usd: b.usd || 0,
        held,
        total: (b.usd || 0) + coinValue,
      };
    });

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ADMIN: set player cash ───────────────────────────────────────────────────
router.post('/admin/set-cash', async (req, res) => {
  if (!req.session || req.session.role !== 'admin')
    return res.status(403).json({ error: 'Admin only' });
  try {
    const { username, usd } = req.body;
    if (!username || typeof usd !== 'number' || !isFinite(usd) || usd < 0) {
      return res.status(400).json({ error: 'Некорректные данные' });
    }

    const wallet = await db.wallets.findOne({ username });
    if (!wallet) return res.status(404).json({ error: 'Игрок не найден' });

    await db.wallets.update({ username }, { $set: { usd } }, {});
    const updated = await db.wallets.findOne({ username });

    const io = req.app.get('io');
    if (io) io.emit('walletUpdate', { username, wallet: updated });

    res.json({ ok: true, wallet: updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
