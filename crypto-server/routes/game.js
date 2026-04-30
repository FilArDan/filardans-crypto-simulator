const express = require('express');
const router  = express.Router();
const { db, COINS, getAllCoins } = require('../db');
const { tick, applyTradePressure } = require('../game/market');
const { getBotStats } = require('../game/bots');

function auth(req, res, next) {
  if (!req.session.username) return res.status(401).json({ error: 'Не авторизован' });
  next();
}
function adminOnly(req, res, next) {
  if (req.session.role !== 'admin') return res.status(403).json({ error: 'Только для администратора' });
  next();
}

// ── Вспомогательная: получить все цены ───────────────────────────────────────
async function getAllPrices() {
  const docs = await db.prices.find({});
  const obj  = {};
  docs.forEach(d => { obj[d.coin] = d.price; });
  return obj;
}

// ── СОСТОЯНИЕ ────────────────────────────────────────────────────────────────
router.get('/state', auth, async (req, res) => {
  try {
    const prices     = await getAllPrices();
    const wallet     = await db.wallets.findOne({ username: req.session.username });
    const loans      = await db.loans.find({ username: req.session.username, paid: { $ne: true } });
    const events     = await db.events.find({}).sort({ ts: -1 }).limit(25);
    const allWallets = await db.wallets.find({ username: { $ne: 'admin' } });
    const allCoins   = await getAllCoins();

    // Реальные игроки
    const players = allWallets.map(w => ({ username: w.username, usd: w.usd, isBot: false }));

    // Боты — добавляем в общий список (видны всем как конкуренты)
    const bots = (await getBotStats(prices)).map(b => ({
      username: `${b.botEmoji} ${b.username}`,
      usd:      b.usd,
      isBot:    true,
    }));
    players.push(...bots);

    res.json({ prices, wallet, loans, events, players, coins: allCoins });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ТОРГОВЛЯ ─────────────────────────────────────────────────────────────────
router.post('/trade', auth, async (req, res) => {
  try {
    const { coin, amount, action } = req.body;
    const allCoins = await getAllCoins();
    if (!allCoins.includes(coin))   return res.json({ error: 'Неизвестная монета' });
    if (!amount || amount <= 0)     return res.json({ error: 'Неверное количество' });

    const priceDoc = await db.prices.findOne({ coin });
    const wallet   = await db.wallets.findOne({ username: req.session.username });
    const cost     = priceDoc.price * amount;

    if (action === 'buy') {
      if (wallet.usd < cost) return res.json({ error: 'Недостаточно USD' });
      await db.wallets.update({ username: req.session.username }, { $inc: { usd: -cost, [coin]: amount } });
    } else {
      if ((wallet[coin] || 0) < amount) return res.json({ error: `Недостаточно ${coin}` });
      await db.wallets.update({ username: req.session.username }, { $inc: { usd: cost, [coin]: -amount } });
    }

    const newCoinPrice  = await applyTradePressure(coin, amount, action);
    const updatedPrices = await getAllPrices();
    const updated       = await db.wallets.findOne({ username: req.session.username });

    const txt = action === 'buy'
      ? `${req.session.username} купил ${amount} ${coin} за $${cost.toFixed(2)} (цена: $${newCoinPrice})`
      : `${req.session.username} продал ${amount} ${coin} за $${cost.toFixed(2)} (цена: $${newCoinPrice})`;
    const ev = { ts: Date.now(), text: txt };
    await db.events.insert(ev);

    const io = req.app.get('io');
    io.emit('newEvent', ev);
    io.emit('walletUpdate', { username: req.session.username, wallet: updated });
    io.emit('priceUpdate', updatedPrices);

    res.json({ wallet: updated, prices: updatedPrices });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ПЕРЕВОД ──────────────────────────────────────────────────────────────────
router.post('/transfer', auth, async (req, res) => {
  try {
    const { to, amount } = req.body;
    const numAmount = parseFloat(amount);
    if (!numAmount || numAmount <= 0) return res.json({ error: 'Неверная сумма' });
    if (to === req.session.username) return res.json({ error: 'Нельзя переводить себе' });
    const toUser = await db.wallets.findOne({ username: to });
    if (!toUser) return res.json({ error: 'Получатель не найден' });
    const from = await db.wallets.findOne({ username: req.session.username });
    if (from.usd < numAmount) return res.json({ error: 'Недостаточно USD' });
    await db.wallets.update({ username: req.session.username }, { $inc: { usd: -numAmount } });
    await db.wallets.update({ username: to },                   { $inc: { usd: numAmount } });
    const ev = { ts: Date.now(), text: `${req.session.username} перевёл $${numAmount} → ${to}` };
    await db.events.insert(ev);
    req.app.get('io').emit('newEvent', ev);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── КРЕДИТЫ ──────────────────────────────────────────────────────────────────
router.post('/loan', auth, async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || amount < 100) return res.json({ error: 'Минимум $100' });
    const due = Math.round(amount * 1.08 * 100) / 100;
    await db.loans.insert({ username: req.session.username, amount, due, ts: Date.now(), paid: false });
    await db.wallets.update({ username: req.session.username }, { $inc: { usd: amount } });
    const wallet = await db.wallets.findOne({ username: req.session.username });
    const ev = { ts: Date.now(), text: `${req.session.username} взял кредит $${amount} (долг $${due})` };
    await db.events.insert(ev);
    req.app.get('io').emit('newEvent', ev);
    res.json({ wallet });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/repay', auth, async (req, res) => {
  try {
    const { loanId, amount } = req.body;
    const loan = await db.loans.findOne({ _id: loanId, username: req.session.username, paid: { $ne: true } });
    if (!loan) return res.json({ error: 'Кредит не найден' });
    const wallet = await db.wallets.findOne({ username: req.session.username });
    if (wallet.usd < amount) return res.json({ error: 'Недостаточно USD для погашения' });
    await db.wallets.update({ username: req.session.username }, { $inc: { usd: -amount } });
    await db.loans.update({ _id: loanId }, { $set: { paid: true } });
    const updated = await db.wallets.findOne({ username: req.session.username });
    const ev = { ts: Date.now(), text: `${req.session.username} погасил кредит $${amount}` };
    await db.events.insert(ev);
    req.app.get('io').emit('newEvent', ev);
    res.json({ wallet: updated });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── АДМИН: игроки ─────────────────────────────────────────────────────────────
router.get('/admin/players', auth, adminOnly, async (req, res) => {
  try {
    const wallets    = await db.wallets.find({});
    const loans      = await db.loans.find({ paid: { $ne: true } });
    const prices     = await getAllPrices();
    const bots       = await getBotStats(prices);
    res.json({ wallets, loans, bots });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/admin/set-cash', auth, adminOnly, async (req, res) => {
  try {
    const { username, usd } = req.body;
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
    if (username === 'admin' || username === 'WARDEN')
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

// ── АДМИН: параметры монет ────────────────────────────────────────────────────
router.get('/admin/coins', auth, adminOnly, async (req, res) => {
  try {
    const docs   = await db.prices.find({});
    const custom = await db.customCoins.find({});
    const customTickers = new Set(custom.map(c => c.ticker));
    const meta = {};
    docs.forEach(d => {
      meta[d.coin] = {
        price:     d.price,
        basePrice: d.basePrice,
        vol:       d.vol,
        drift:     d.drift,
        supply:    d.supply,
        isCustom:  customTickers.has(d.coin),
        name:      custom.find(c => c.ticker === d.coin)?.name || d.coin,
        emoji:     custom.find(c => c.ticker === d.coin)?.emoji || '🪙',
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
    if (vol       != null) patch.vol       = Math.max(0.005, Math.min(0.30,  parseFloat(vol)));
    if (drift     != null) patch.drift     = Math.max(-0.10, Math.min(0.10,  parseFloat(drift)));
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

// ── АДМИН: создание кастомной монеты ─────────────────────────────────────────
router.post('/admin/coin/create', auth, adminOnly, async (req, res) => {
  try {
    let { ticker, name, emoji, price, vol, drift, supply } = req.body;

    ticker = (ticker || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    if (!ticker || ticker.length < 1) return res.json({ error: 'Укажи тикер (1–8 букв/цифр)' });

    const allCoins = await getAllCoins();
    if (allCoins.includes(ticker)) return res.json({ error: `Монета ${ticker} уже существует` });

    const startPrice  = Math.max(0.0001, parseFloat(price)  || 1);
    const startVol    = Math.max(0.005, Math.min(0.30, parseFloat(vol)   || 0.05));
    const startDrift  = Math.max(-0.10, Math.min(0.10, parseFloat(drift) || 0));
    const startSupply = Math.max(1, parseFloat(supply) || 1000000);

    await db.customCoins.insert({ ticker, name: name || ticker, emoji: emoji || '🪙', createdAt: Date.now() });
    await db.prices.insert({ coin: ticker, price: startPrice, basePrice: startPrice, vol: startVol, drift: startDrift, supply: startSupply });
    await db.wallets.update({}, { $set: { [ticker]: 0 } }, { multi: true });

    const allCoinsNew   = await getAllCoins();
    const updatedPrices = await getAllPrices();

    const ev = { ts: Date.now(), text: `Админ создал новую монету: ${emoji || '🪙'} ${ticker} (${name || ticker}), цена $${startPrice}` };
    await db.events.insert(ev);

    const io = req.app.get('io');
    io.emit('newEvent', ev);
    io.emit('priceUpdate', updatedPrices);
    io.emit('coinsUpdated', { coins: allCoinsNew });

    res.json({ ok: true, ticker, coins: allCoinsNew, prices: updatedPrices });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── АДМИН: удаление кастомной монеты ─────────────────────────────────────────
router.delete('/admin/coin/:ticker', auth, adminOnly, async (req, res) => {
  try {
    const ticker = (req.params.ticker || '').toUpperCase();
    if (COINS.includes(ticker))
      return res.status(403).json({ error: 'Базовые монеты (BTC/ETH/SOL/XRP/DOGE) нельзя удалять' });

    const existing = await db.customCoins.findOne({ ticker });
    if (!existing) return res.status(404).json({ error: 'Кастомная монета не найдена' });

    const priceDoc = await db.prices.findOne({ coin: ticker });
    const curPrice = priceDoc ? priceDoc.price : 0;
    const wallets  = await db.wallets.find({});
    for (const w of wallets) {
      const holding = w[ticker] || 0;
      if (holding > 0 && curPrice > 0) {
        const refund = holding * curPrice;
        await db.wallets.update({ _id: w._id }, { $inc: { usd: refund }, $set: { [ticker]: 0 } });
      }
    }

    await db.customCoins.remove({ ticker }, {});
    await db.prices.remove({ coin: ticker }, {});

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

// ── АДМИН: тик, скорость ──────────────────────────────────────────────────────
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
    req.app.get('io').emit('tickSpeedChanged', { ms });
    res.json({ ok: true, ms });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
