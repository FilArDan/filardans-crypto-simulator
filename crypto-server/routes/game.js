const express = require('express');
const router = express.Router();
const { db, COINS } = require('../db');

function auth(req, res, next) {
  if (!req.session.username) return res.status(401).json({ error: 'Не авторизован' });
  next();
}
function adminOnly(req, res, next) {
  if (req.session.role !== 'admin') return res.status(403).json({ error: 'Только для администратора' });
  next();
}

// Состояние — единый источник данных для клиента
router.get('/state', auth, async (req, res) => {
  try {
    const priceDocs = await db.prices.find({});
    const prices = {};
    priceDocs.forEach(d => { prices[d.coin] = d.price; });

    const wallet = await db.wallets.findOne({ username: req.session.username });
    const loans  = await db.loans.find({ username: req.session.username, paid: { $ne: true } });
    const events = await db.events.find({}).sort({ ts: -1 }).limit(25);

    const allWallets = await db.wallets.find({ username: { $ne: 'admin' } });
    const players = allWallets.map(w => ({ username: w.username, usd: w.usd }));

    res.json({ prices, wallet, loans, events, players });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/trade', auth, async (req, res) => {
  try {
    const { coin, amount, action } = req.body;
    if (!COINS.includes(coin)) return res.json({ error: 'Неизвестная монета' });
    if (!amount || amount <= 0) return res.json({ error: 'Неверное количество' });
    const priceDoc = await db.prices.findOne({ coin });
    const wallet   = await db.wallets.findOne({ username: req.session.username });
    const cost = priceDoc.price * amount;
    if (action === 'buy') {
      if (wallet.usd < cost) return res.json({ error: 'Недостаточно USD' });
      await db.wallets.update({ username: req.session.username }, { $inc: { usd: -cost, [coin]: amount } });
    } else {
      if ((wallet[coin] || 0) < amount) return res.json({ error: `Недостаточно ${coin}` });
      await db.wallets.update({ username: req.session.username }, { $inc: { usd: cost, [coin]: -amount } });
    }
    const updated = await db.wallets.findOne({ username: req.session.username });
    const txt = action === 'buy'
      ? `${req.session.username} купил ${amount} ${coin} за $${cost.toFixed(2)}`
      : `${req.session.username} продал ${amount} ${coin} за $${cost.toFixed(2)}`;
    const ev = { ts: Date.now(), text: txt };
    await db.events.insert(ev);
    req.app.get('io').emit('newEvent', ev);
    req.app.get('io').emit('walletUpdate', { username: req.session.username, wallet: updated });
    res.json({ wallet: updated });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/transfer', auth, async (req, res) => {
  try {
    const { to, amount } = req.body;
    if (!amount || amount <= 0) return res.json({ error: 'Неверная сумма' });
    if (to === req.session.username) return res.json({ error: 'Нельзя переводить себе' });
    const toUser = await db.wallets.findOne({ username: to });
    if (!toUser) return res.json({ error: 'Получатель не найден' });
    const from = await db.wallets.findOne({ username: req.session.username });
    if (from.usd < amount) return res.json({ error: 'Недостаточно USD' });
    await db.wallets.update({ username: req.session.username }, { $inc: { usd: -amount } });
    await db.wallets.update({ username: to }, { $inc: { usd: amount } });
    const ev = { ts: Date.now(), text: `${req.session.username} перевёл $${amount} → ${to}` };
    await db.events.insert(ev);
    req.app.get('io').emit('newEvent', ev);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

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

// Только для админа
router.get('/admin/players', auth, adminOnly, async (req, res) => {
  try {
    const wallets = await db.wallets.find({});
    const loans   = await db.loans.find({ paid: { $ne: true } });
    res.json({ wallets, loans });
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

router.post('/admin/tick', auth, adminOnly, async (req, res) => {
  try {
    await require('../game/market').tick(req.app.get('io'));
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Управление скоростью тика
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

module.exports = router;
