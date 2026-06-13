const express = require('express');
const router  = express.Router();
const { db, COINS, COIN_META, getAllCoins, EXCHANGE_USERNAME, EXCHANGE_CUSTOM_COIN_SUPPLY } = require('../db');
const { tick, applyTradePressure, deleteCoinHistory } = require('../game/market');
const { getBotStats, priceHistory, listBotsRaw, createBot, deleteBot, setBotCash, updateBotPreset } = require('../game/bots');

const TRADE_FEE = 0.004;   // 0.4% комиссия
const SPREAD    = 0.0015;  // ±0.15% спред (итого 0.3% между buy/sell ценой)

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
    res.json(docs.map(d => d.price));
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

      const newCoinPrice  = await applyTradePressure(coin, amount, action);
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

      const newCoinPrice  = await applyTradePressure(coin, amount, action);
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

router.post('/loan', auth, async (req, res) => {
  try {
    const num = parseFloat(req.body.amount);
    if (!num || num < 100) return res.json({ error: 'Минимум $100' });
    const existing = await db.loans.findOne({ username: req.session.username, paid: { $ne: true } });
    if (existing) return res.json({ error: `Сначала погаси текущий долг ($${existing.due.toFixed(2)})` });
    const { computeLoanRate, portfolioValue, MAX_LOAN_RATIO } = require('../game/bank');
    const wallet  = await db.wallets.findOne({ username: req.session.username });
    const prices  = await getAllPrices();
    const coins   = await getAllCoins();
    const portVal = portfolioValue(wallet, prices, coins);
    const maxLoan = Math.floor(portVal * MAX_LOAN_RATIO);
    if (num > maxLoan) return res.json({ error: `Максимум $${maxLoan.toLocaleString('ru')} (${MAX_LOAN_RATIO}× портфель $${portVal.toFixed(0)})` });
    const exchangeWallet = await db.wallets.findOne({ username: EXCHANGE_USERNAME });
    if (!exchangeWallet || exchangeWallet.usd < num) {
      return res.json({ error: 'Биржа временно не может выдать кредит. Попробуй позже.' });
    }
    const rate = computeLoanRate(priceHistory);
    await db.loans.insert({ username: req.session.username, principal: num, due: num, rate, ts: Date.now(), paid: false });
    await db.wallets.update({ username: req.session.username }, { $inc: { usd: +num } });
    await db.wallets.update({ username: EXCHANGE_USERNAME },    { $inc: { usd: -num } });
    const updated = await db.wallets.findOne({ username: req.session.username });
    const io = req.app.get('io');
    const ev = { ts: Date.now(), text: `${req.session.username} взял кредит $${num.toFixed(2)} (ставка ${(rate * 100).toFixed(3)}%/тик)` };
    await db.events.insert(ev);
    io.emit('newEvent', ev);
    await emitBankUpdate(io);
    res.json({ wallet: updated, rate, due: num });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/repay', auth, async (req, res) => {
  try {
    const loan = await db.loans.findOne({ username: req.session.username, paid: { $ne: true } });
    if (!loan) return res.json({ error: 'Нет активного кредита' });
    const wallet   = await db.wallets.findOne({ username: req.session.username });
    const wantPay  = req.body.amount
      ? Math.min(parseFloat(req.body.amount), loan.due)
      : loan.due;
    if (!wantPay || wantPay <= 0) return res.json({ error: 'Неверная сумма' });
    if (wallet.usd < wantPay) return res.json({ error: `Недостаточно USD. Нужно $${wantPay.toFixed(2)}, есть $${wallet.usd.toFixed(2)}` });
    await db.wallets.update({ username: req.session.username }, { $inc: { usd: -wantPay } });
    await db.wallets.update({ username: EXCHANGE_USERNAME },    { $inc: { usd: +wantPay } });
    const remaining = loan.due - wantPay;
    if (remaining < 0.01) {
      await db.loans.update({ _id: loan._id }, { $set: { due: 0, paid: true } });
    } else {
      await db.loans.update({ _id: loan._id }, { $set: { due: remaining } });
    }
    const updated = await db.wallets.findOne({ username: req.session.username });
    const io = req.app.get('io');
    const ev = { ts: Date.now(), text: `${req.session.username} погасил $${wantPay.toFixed(2)} (остаток: $${Math.max(0, remaining).toFixed(2)})` };
    await db.events.insert(ev);
    io.emit('newEvent', ev);
    await emitBankUpdate(io);
    res.json({ wallet: updated, remaining: Math.max(0, remaining) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── АДМИН: игроки ──────────────────────────────────────────────────────────────
router.get('/admin/players', auth, adminOnly, async (req, res) => {
  try {
    const wallets = await db.wallets.find({});
    const loans   = await db.loans.find({ paid: { $ne: true } });
    const prices  = await getAllPrices();
    const bots    = await getBotStats(prices);
    res.json({ wallets, loans, bots });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/admin/set-cash', auth, adminOnly, async (req, res) => {
  try {
    const { username, usd } = req.body;
    if (username === EXCHANGE_USERNAME) return res.status(403).json({ error: 'Нельзя менять баланс EXCHANGE вручную' });
    await db.wallets.update({ username }, { $set: { usd: parseFloat(usd) } });
    const ev = { ts: Date.now(), text: `Админ установил баланс ${username}: $${usd}` };
    await db.events.insert(ev);
    req.app.get('io').emit('newEvent', ev);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/admin/player/:username', auth, adminOnly, async (req, res) => {
  try {
    const { username } = req.params;
    if (username === 'admin' || username === 'WARDEN' || username === EXCHANGE_USERNAME)
      return res.status(403).json({ error: 'Системные аккаунты нельзя удалять' });
    const user = await db.users.findOne({ username });
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    await db.users.remove({ username }, {});
    await db.wallets.remove({ username }, {});
    await db.loans.remove({ username }, { multi: true });
    const ev = { ts: Date.now(), text: `Админ удалил аккаунт: ${username}` };
    await db.events.insert(ev);
    req.app.get('io').emit('newEvent', ev);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── АДМИН: пауза ───────────────────────────────────────────────────────────────
router.get('/admin/pause-status', auth, adminOnly, (req, res) => {
  res.json({ paused: req.app.get('isPaused')() });
});

router.post('/admin/pause', auth, adminOnly, async (req, res) => {
  try {
    req.app.get('setPaused')(true);
    const ev = { ts: Date.now(), text: '⏸️ Админ поставил игру на паузу' };
    await db.events.insert(ev);
    req.app.get('io').emit('newEvent', ev);
    res.json({ ok: true, paused: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/admin/resume', auth, adminOnly, async (req, res) => {
  try {
    req.app.get('setPaused')(false);
    const ev = { ts: Date.now(), text: '▶️ Админ возобновил игру' };
    await db.events.insert(ev);
    req.app.get('io').emit('newEvent', ev);
    res.json({ ok: true, paused: false });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── АДМИН: боты ────────────────────────────────────────────────────────────────
router.get('/admin/bots', auth, adminOnly, async (req, res) => {
  try {
    const prices = await getAllPrices();
    const stats  = await getBotStats(prices);
    res.json(stats);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/admin/bot/preset', auth, adminOnly, async (req, res) => {
  try {
    const { name, type } = req.body;
    if (!name) return res.json({ error: 'Укажи имя бота' });
    const updated = await updateBotPreset(name, type);
    const PRESET_LABELS = { bull: '🐂 Агрессор', fox: '🦊 Осторожный', croc: '🐊 Накопитель' };
    const ev = { ts: Date.now(), text: `Админ изменил пресет бота ${name}: ${PRESET_LABELS[type] || type}` };
    await db.events.insert(ev);
    req.app.get('io').emit('newEvent', ev);
    res.json({ ok: true, bot: updated });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/admin/bot/cash', auth, adminOnly, async (req, res) => {
  try {
    const { name, usd } = req.body;
    if (!name) return res.json({ error: 'Укажи имя бота' });
    const updated = await setBotCash(name, usd);
    const ev = { ts: Date.now(), text: `Админ установил баланс бота ${name}: $${parseFloat(usd).toFixed(2)}` };
    await db.events.insert(ev);
    req.app.get('io').emit('newEvent', ev);
    res.json({ ok: true, bot: updated });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/admin/bot/create', auth, adminOnly, async (req, res) => {
  try {
    const { name, type, usd } = req.body;
    const bot = await createBot({ name, type, usd });
    const PRESET_LABELS = { bull: '🐂 Агрессор', fox: '🦊 Осторожный', croc: '🐊 Накопитель' };
    const ev = { ts: Date.now(), text: `Админ создал бота: ${name} (${PRESET_LABELS[type] || type})` };
    await db.events.insert(ev);
    req.app.get('io').emit('newEvent', ev);
    res.json({ ok: true, bot });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/admin/bot/:name', auth, adminOnly, async (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    await deleteBot(name);
    const ev = { ts: Date.now(), text: `Админ удалил бота: ${name}` };
    await db.events.insert(ev);
    req.app.get('io').emit('newEvent', ev);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── АДМИН: параметры монет ─────────────────────────────────────────────────────
router.get('/admin/coins', auth, adminOnly, async (req, res) => {
  try {
    const docs   = await db.prices.find({});
    const custom = await db.customCoins.find({});
    const customTickers = new Set(custom.map(c => c.ticker));
    const meta = {};
    docs.forEach(d => {
      const isBase = COINS.includes(d.coin);
      meta[d.coin] = {
        price:     d.price,
        basePrice: d.basePrice,
        vol:       d.vol,
        drift:     d.drift,
        supply:    d.supply,
        isCustom:  customTickers.has(d.coin),
        isBase,
        name:  isBase ? (COIN_META[d.coin]?.name  || d.coin) : (custom.find(c => c.ticker === d.coin)?.name  || d.coin),
        emoji: isBase ? (COIN_META[d.coin]?.emoji || '🪙') : (custom.find(c => c.ticker === d.coin)?.emoji || '🪙'),
      };
    });
    res.json(meta);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/admin/coin/params', auth, adminOnly, async (req, res) => {
  try {
    const { coin, vol, drift, supply, basePrice } = req.body;
    const allCoins = await getAllCoins();
    if (!allCoins.includes(coin)) return res.json({ error: 'Неизвестная монета' });
    const doc   = await db.prices.findOne({ coin });
    const patch = {};
    if (vol       != null) patch.vol       = Math.max(0.005, Math.min(0.30, parseFloat(vol)));
    if (drift     != null) patch.drift     = Math.max(-0.10, Math.min(0.10, parseFloat(drift)));
    if (basePrice != null) patch.basePrice = Math.max(0.0001, parseFloat(basePrice));
    if (supply != null && parseFloat(supply) > 0) {
      const oldMcap   = doc.price * (doc.supply || 1);
      const newSupply = parseFloat(supply);
      patch.supply = newSupply;
      patch.price  = Math.max(0.0001, oldMcap / newSupply);
    }
    await db.prices.update({ coin }, { $set: patch });
    const updatedPrices = await getAllPrices();
    const parts = [];
    if (patch.vol   != null) parts.push(`vol=${(patch.vol*100).toFixed(1)}%`);
    if (patch.drift != null) parts.push(`drift=${patch.drift>=0?'+':''}${(patch.drift*100).toFixed(1)}%`);
    if (patch.supply!= null) parts.push(`supply=${patch.supply.toLocaleString('ru')}`);
    const ev = { ts: Date.now(), text: `Админ изменил параметры ${coin}: ${parts.join(', ')}` };
    await db.events.insert(ev);
    const io = req.app.get('io');
    io.emit('newEvent', ev);
    io.emit('priceUpdate', updatedPrices);
    res.json({ ok: true, prices: updatedPrices });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/admin/coin/create', auth, adminOnly, async (req, res) => {
  try {
    let { ticker, name, emoji, price, vol, drift, supply } = req.body;
    ticker = (ticker || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    if (!ticker || ticker.length < 1) return res.json({ error: 'Укажи тикер (1–8 букв/цифр)' });
    const allCoins = await getAllCoins();
    if (allCoins.includes(ticker)) return res.json({ error: `Монета ${ticker} уже существует` });
    const isBase = COINS.includes(ticker);
    const baseMeta = isBase ? COIN_META[ticker] : null;
    const startPrice  = Math.max(0.0001, parseFloat(price)  || (baseMeta?.basePrice ?? 1));
    const startVol    = Math.max(0.005, Math.min(0.30, parseFloat(vol) || (baseMeta?.vol ?? 0.05)));
    const startDrift  = Math.max(-0.10, Math.min(0.10, parseFloat(drift) || 0));
    const startSupply = Math.max(1, parseFloat(supply) || (baseMeta?.supply ?? 1000000));
    const coinName    = name  || (baseMeta?.name  ?? ticker);
    const coinEmoji   = emoji || (baseMeta?.emoji ?? '🪙');
    await db.prices.insert({ coin: ticker, price: startPrice, basePrice: startPrice, vol: startVol, drift: startDrift, supply: startSupply });
    await db.wallets.update({}, { $set: { [ticker]: 0 } }, { multi: true });
    if (!isBase) await db.customCoins.insert({ ticker, name: coinName, emoji: coinEmoji, createdAt: Date.now() });

    // Выдаём бирже начальный запас новой монеты
    const exchangeReserve = EXCHANGE_CUSTOM_COIN_SUPPLY;
    await db.wallets.update({ username: EXCHANGE_USERNAME }, { $set: { [ticker]: exchangeReserve } });

    // Записываем первую точку в историю цен
    await db.priceHistory.insert({ coin: ticker, price: startPrice, ts: Date.now() });

    const allCoinsNew   = await getAllCoins();
    const updatedPrices = await getAllPrices();
    const ev = { ts: Date.now(), text: `Админ создал монету: ${coinEmoji} ${ticker} (${coinName}), цена $${startPrice}` };
    await db.events.insert(ev);
    const io = req.app.get('io');
    io.emit('newEvent', ev);
    io.emit('priceUpdate', updatedPrices);
    io.emit('coinsUpdated', { coins: allCoinsNew });
    res.json({ ok: true, ticker, coins: allCoinsNew, prices: updatedPrices });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/admin/coin/:ticker', auth, adminOnly, async (req, res) => {
  try {
    const ticker = (req.params.ticker || '').toUpperCase();
    const priceDoc = await db.prices.findOne({ coin: ticker });
    if (!priceDoc) return res.status(404).json({ error: 'Монета не найдена' });
    const curPrice = priceDoc.price || 0;
    const wallets  = await db.wallets.find({ username: { $ne: EXCHANGE_USERNAME } });
    for (const w of wallets) {
      const holding = w[ticker] || 0;
      if (holding > 0 && curPrice > 0) {
        // Выкупаем монеты у игроков за USD биржи
        await db.wallets.update({ _id: w._id }, { $inc: { usd: holding * curPrice }, $set: { [ticker]: 0 } });
        await db.wallets.update({ username: EXCHANGE_USERNAME }, { $inc: { usd: -(holding * curPrice) }, $set: { [ticker]: 0 } });
      }
    }
    // Обнуляем запас биржи по этой монете
    await db.wallets.update({ username: EXCHANGE_USERNAME }, { $set: { [ticker]: 0 } });
    await db.prices.remove({ coin: ticker }, {});
    await db.customCoins.remove({ ticker }, {});
    await deleteCoinHistory(ticker);
    const allCoinsNew   = await getAllCoins();
    const updatedPrices = await getAllPrices();
    const ev = { ts: Date.now(), text: `Админ удалил монету: ${ticker}` };
    await db.events.insert(ev);
    const io = req.app.get('io');
    io.emit('newEvent', ev);
    io.emit('priceUpdate', updatedPrices);
    io.emit('coinsUpdated', { coins: allCoinsNew });
    res.json({ ok: true, coins: allCoinsNew });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── АДМИН: очистка истории цен ─────────────────────────────────────────────────
router.delete('/admin/price-history/:coin', auth, adminOnly, async (req, res) => {
  try {
    const coin = (req.params.coin || '').toUpperCase();
    if (!coin) return res.status(400).json({ error: 'Укажи тикер монеты' });
    await deleteCoinHistory(coin);
    const ev = { ts: Date.now(), text: `Админ очистил историю цен: ${coin}` };
    await db.events.insert(ev);
    req.app.get('io').emit('newEvent', ev);
    req.app.get('io').emit('priceHistoryCleared', { coin });
    res.json({ ok: true, coin });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/admin/price-history', auth, adminOnly, async (req, res) => {
  try {
    await db.priceHistory.remove({}, { multi: true });
    const ev = { ts: Date.now(), text: 'Админ очистил историю цен всех монет 🗑️' };
    await db.events.insert(ev);
    req.app.get('io').emit('newEvent', ev);
    req.app.get('io').emit('priceHistoryCleared', { coin: null });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── АДМИН: тик, скорость ───────────────────────────────────────────────────────
router.post('/admin/tick', auth, adminOnly, async (req, res) => {
  try {
    await tick(req.app.get('io'));
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/admin/tick-speed', auth, adminOnly, (req, res) => {
  res.json({ ms: req.app.get('getTickSpeed')() });
});

router.post('/admin/set-tick-speed', auth, adminOnly, (req, res) => {
  try {
    const ms = Math.max(500, Math.min(120000, parseInt(req.body.ms) || 25000));
    req.app.get('setTickSpeed')(ms);
    const label = ms < 1000 ? ms + 'мс' : (ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1) + 'с';
    const ev = { ts: Date.now(), text: `Админ изменил скорость тика: ${label}` };
    db.events.insert(ev);
    req.app.get('io').emit('newEvent', ev);
    res.json({ ok: true, ms });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── АДМИН: баланс биржи ────────────────────────────────────────────────────────
router.get('/admin/exchange', auth, adminOnly, async (req, res) => {
  try {
    const wallet = await db.wallets.findOne({ username: EXCHANGE_USERNAME });
    res.json({ usd: wallet ? wallet.usd : 0 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── АДМИН: все активы биржи (USD + монеты) ─────────────────────────────────────
router.get('/admin/exchange-assets', auth, adminOnly, async (req, res) => {
  try {
    const wallet   = await db.wallets.findOne({ username: EXCHANGE_USERNAME });
    const prices   = await getAllPrices();
    const allCoins = await getAllCoins();
    const custom   = await db.customCoins.find({});
    const customMap = {};
    custom.forEach(c => { customMap[c.ticker] = { name: c.name, emoji: c.emoji }; });

    const coinAssets = allCoins.map(coin => {
      const qty      = wallet ? (wallet[coin] || 0) : 0;
      const price    = prices[coin] || 0;
      const usdValue = qty * price;
      const isBase   = COINS.includes(coin);
      const name     = isBase ? (COIN_META[coin]?.name || coin) : (customMap[coin]?.name || coin);
      const emoji    = isBase ? (COIN_META[coin]?.emoji || '🪙') : (customMap[coin]?.emoji || '🪙');
      return { coin, name, emoji, qty, price, usdValue };
    });

    const totalCoinValue = coinAssets.reduce((s, a) => s + a.usdValue, 0);
    const usd = wallet ? (wallet.usd || 0) : 0;

    res.json({ usd, coinAssets, totalCoinValue, totalAssets: usd + totalCoinValue });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
