/* ===== ЛИМИТНЫЕ ОРДЕРА — биржевой стакан и матчинг =====
 *
 * Модель:
 *  • При размещении ордера средства резервируются (эскроу): для покупки списывается
 *    USD (цена × объём + комиссия), для продажи — сами монеты. Резерв хранится
 *    в самом документе ордера (lockedUsd / lockedCoin) и возвращается при отмене
 *    или при закрытии ордера (остаток).
 *  • Матчинг двухступенчатый:
 *      1) P2P — встречные ордера игроков (приоритет цена → время);
 *      2) остаток исполняется об биржу (EXCHANGE) по рыночной цене со спредом,
 *         если лимит игрока это позволяет и у биржи хватает запаса.
 *  • Исполнение всегда по цене не хуже лимита: разница возвращается игроку.
 */
const { db, getAllCoins } = require('../db');

const TRADE_FEE       = 0.004;   // 0.4% комиссия (синхронизировано с routes/game.js)
const SPREAD          = 0.0015;  // ±0.15% спред биржи
const MAX_OPEN_ORDERS = 20;      // максимум активных ордеров на игрока
const QTY_EPS         = 1e-9;    // порог «нулевого» остатка по объёму

function remaining(order) {
  return Math.max(0, (order.amount || 0) - (order.filled || 0));
}

function sideLabel(side) {
  return side === 'buy' ? 'покупку' : 'продажу';
}

// ── Возврат зарезервированных средств ────────────────────────────────────────
async function refundEscrow(order) {
  const patch = {};
  if ((order.lockedUsd || 0) > 0)  patch.usd         = +order.lockedUsd;
  if ((order.lockedCoin || 0) > 0) patch[order.coin] = +order.lockedCoin;
  if (Object.keys(patch).length > 0) {
    await db.wallets.update({ username: order.username }, { $inc: patch });
  }
  order.lockedUsd  = 0;
  order.lockedCoin = 0;
}

// ── Сохранение состояния ордера после сделок ─────────────────────────────────
async function persistOrder(order) {
  const done = remaining(order) <= QTY_EPS;
  if (done) {
    // Излишек резерва (исполнение прошло по цене лучше лимита) возвращаем
    await refundEscrow(order);
    order.status   = 'filled';
    order.closedAt = Date.now();
  }
  await db.orders.update({ _id: order._id }, { $set: {
    filled:     order.filled,
    lockedUsd:  order.lockedUsd,
    lockedCoin: order.lockedCoin,
    execUsd:    order.execUsd || 0,
    status:     order.status,
    closedAt:   order.closedAt || null,
  } });
}

// ── Сделка между двумя игроками ──────────────────────────────────────────────
async function settleP2P(bid, ask, qty, execPrice, coin, reserveAccount) {
  const gross   = execPrice * qty;
  const feeBuy  = gross * TRADE_FEE;
  const feeSell = gross * TRADE_FEE;

  // Покупатель: списываем из эскроу, получает монеты
  bid.lockedUsd = Math.max(0, bid.lockedUsd - (gross + feeBuy));
  bid.filled   += qty;
  bid.execUsd   = (bid.execUsd || 0) + gross;
  await db.wallets.update({ username: bid.username }, { $inc: { [coin]: +qty } });

  // Продавец: монеты уходят из эскроу, получает USD за вычетом комиссии
  ask.lockedCoin = Math.max(0, ask.lockedCoin - qty);
  ask.filled    += qty;
  ask.execUsd    = (ask.execUsd || 0) + gross;
  await db.wallets.update({ username: ask.username }, { $inc: { usd: +(gross - feeSell) } });

  // Комиссии обеих сторон — маркет-мейкеру этого тикера (бирже или резерву союза)
  await db.wallets.update({ username: reserveAccount }, { $inc: { usd: +(feeBuy + feeSell) } });

  return gross;
}

// ── Сделка об биржу (маркет-мейкер) ──────────────────────────────────────────
async function settleWithExchange(order, qty, execPrice, coin, reserveAccount) {
  const gross = execPrice * qty;
  const fee   = gross * TRADE_FEE;

  if (order.side === 'buy') {
    order.lockedUsd = Math.max(0, order.lockedUsd - (gross + fee));
    await db.wallets.update({ username: order.username },   { $inc: { [coin]: +qty } });
    await db.wallets.update({ username: reserveAccount },   { $inc: { usd: +(gross + fee), [coin]: -qty } });
  } else {
    order.lockedCoin = Math.max(0, order.lockedCoin - qty);
    await db.wallets.update({ username: order.username },   { $inc: { usd: +(gross - fee) } });
    await db.wallets.update({ username: reserveAccount },   { $inc: { usd: -(gross - fee), [coin]: +qty } });
  }

  order.filled += qty;
  order.execUsd = (order.execUsd || 0) + gross;
  return gross;
}

// ── Учёт сделок для итоговых событий ─────────────────────────────────────────
function trackFill(fills, order, qty, gross) {
  let rec = fills.get(order._id);
  if (!rec) {
    rec = { order, qty: 0, gross: 0 };
    fills.set(order._id, rec);
  }
  rec.qty   += qty;
  rec.gross += gross;
  rec.order  = order;
}

// ── Матчинг одной монеты ─────────────────────────────────────────────────────
async function matchCoin(coin, marketPrice, fills) {
  const openOrders = await db.orders.find({ coin, status: 'open' });
  if (!openOrders.length) return marketPrice;

  const { resolveReserveAccount } = require('./unions');
  const reserveAccount = await resolveReserveAccount(coin);

  const bids = openOrders.filter(o => o.side === 'buy' ).sort((a, b) => b.price - a.price || a.ts - b.ts);
  const asks = openOrders.filter(o => o.side === 'sell').sort((a, b) => a.price - b.price || a.ts - b.ts);

  const touched = new Set();

  // ── 1. Встречные ордера игроков ────────────────────────────────────────────
  let bi = 0, ai = 0;
  while (bi < bids.length && ai < asks.length) {
    const bid = bids[bi];
    const ask = asks[ai];

    if (remaining(bid) <= QTY_EPS) { bi++; continue; }
    if (remaining(ask) <= QTY_EPS) { ai++; continue; }
    if (bid.price < ask.price) break;

    // Самосделки запрещены — пропускаем более новый ордер игрока
    if (bid.username === ask.username) {
      if (bid.ts <= ask.ts) ai++; else bi++;
      continue;
    }

    const qty = Math.min(remaining(bid), remaining(ask));
    // Цена «стоявшего в стакане» ордера — приоритет по времени
    const execPrice = bid.ts <= ask.ts ? bid.price : ask.price;

    const gross = await settleP2P(bid, ask, qty, execPrice, coin, reserveAccount);
    trackFill(fills, bid, qty, gross);
    trackFill(fills, ask, qty, gross);
    touched.add(bid).add(ask);
  }

  // ── 2. Остаток — об биржу по рыночной цене ─────────────────────────────────
  let price = marketPrice;
  if (Number.isFinite(price) && price > 0) {
    const rest = [...bids, ...asks].filter(o => remaining(o) > QTY_EPS);
    for (const order of rest) {
      const exch = await db.wallets.findOne({ username: reserveAccount });
      if (!exch) break;

      let qty = 0, execPrice = 0;
      if (order.side === 'buy') {
        execPrice = price * (1 + SPREAD);
        if (execPrice > order.price) continue;               // рынок дороже лимита
        qty = Math.min(remaining(order), exch[coin] || 0);   // запас биржи
      } else {
        execPrice = price * (1 - SPREAD);
        if (execPrice < order.price) continue;               // рынок дешевле лимита
        const affordable = execPrice > 0
          ? Math.max(0, exch.usd || 0) / (execPrice * (1 - TRADE_FEE))
          : 0;
        qty = Math.min(remaining(order), affordable);
      }
      if (qty <= QTY_EPS) continue;

      const gross = await settleWithExchange(order, qty, execPrice, coin, reserveAccount);
      trackFill(fills, order, qty, gross);
      touched.add(order);

      // Сделка давит на курс так же, как обычная рыночная операция
      const { applyTradePressure } = require('./market');
      price = await applyTradePressure(coin, qty, order.side);
    }
  }

  for (const order of touched) await persistOrder(order);
  return price;
}

// ── Полный проход матчинга (вызывается из tick() и после размещения ордера) ──
async function runMatching(io, prices) {
  const fills  = new Map();
  const priced = prices || {};
  const coins  = Object.keys(priced).length ? Object.keys(priced) : await getAllCoins();
  const newPrices = { ...priced };

  for (const coin of coins) {
    let mp = priced[coin];
    if (mp == null) {
      const doc = await db.prices.findOne({ coin });
      mp = doc ? doc.price : null;
    }
    try {
      const finalPrice = await matchCoin(coin, mp, fills);
      if (Number.isFinite(finalPrice)) newPrices[coin] = finalPrice;
    } catch (e) {
      console.error('[orders] ошибка матчинга', coin, e.message);
    }
  }

  if (fills.size === 0) return { fills: 0, prices: newPrices };

  const users = new Set();
  const books = new Set();

  for (const { order, qty, gross } of fills.values()) {
    const avg  = qty > 0 ? gross / qty : order.price;
    const dec  = avg < 1 ? 5 : 2;
    const done = order.status === 'filled';
    const ev = {
      ts: Date.now(),
      text: `${order.username} ${order.side === 'buy' ? 'купил' : 'продал'} ${qty.toFixed(6)} ${order.coin} ` +
            `по лимиту $${order.price} (средняя $${avg.toFixed(dec)})${done ? ' — ордер исполнен ✅' : ' — частично'}`,
    };
    await db.events.insert(ev);
    if (io) io.emit('newEvent', ev);
    users.add(order.username);
    books.add(order.coin);
  }

  if (io) {
    for (const username of users) {
      const wallet = await db.wallets.findOne({ username });
      if (wallet) io.emit('walletUpdate', { username, wallet });
      io.emit('orderUpdate', { username });
    }
    for (const coin of books) io.emit('orderbookUpdate', { coin });
  }

  return { fills: fills.size, prices: newPrices };
}

// ── Размещение ордера ────────────────────────────────────────────────────────
async function placeOrder({ username, coin, side, price, amount }, io) {
  const allCoins = await getAllCoins();
  if (!allCoins.includes(coin)) return { error: 'Неизвестная монета' };
  if (side !== 'buy' && side !== 'sell') return { error: 'Неверный тип ордера' };

  const { canTrade } = require('./unions');
  const access = await canTrade(username, coin);
  if (!access.ok) return { error: access.reason };

  const limitPrice = parseFloat(price);
  const qty        = parseFloat(amount);
  if (!Number.isFinite(limitPrice) || limitPrice <= 0) return { error: 'Неверная цена' };
  if (!Number.isFinite(qty) || qty <= 0)               return { error: 'Неверный объём' };

  const openCount = await db.orders.count({ username, status: 'open' });
  if (openCount >= MAX_OPEN_ORDERS)
    return { error: `Достигнут лимит активных ордеров (${MAX_OPEN_ORDERS})` };

  const wallet = await db.wallets.findOne({ username });
  if (!wallet) return { error: 'Кошелёк не найден' };

  const doc = {
    username, coin, side,
    price:      limitPrice,
    amount:     qty,
    filled:     0,
    execUsd:    0,
    lockedUsd:  0,
    lockedCoin: 0,
    status:     'open',
    ts:         Date.now(),
    closedAt:   null,
  };

  if (side === 'buy') {
    const need = limitPrice * qty * (1 + TRADE_FEE);
    if ((wallet.usd || 0) < need)
      return { error: `Недостаточно USD для резерва (нужно $${need.toFixed(2)})` };
    await db.wallets.update({ username }, { $inc: { usd: -need } });
    doc.lockedUsd = need;
  } else {
    if ((wallet[coin] || 0) < qty)
      return { error: `Недостаточно ${coin} для резерва (есть ${(wallet[coin] || 0).toFixed(6)})` };
    await db.wallets.update({ username }, { $inc: { [coin]: -qty } });
    doc.lockedCoin = qty;
  }

  // insert() в @seald-io/nedb не возвращает документ — нужен insertAsync
  const inserted = await db.orders.insertAsync(doc);

  const ev = {
    ts: Date.now(),
    text: `${username} выставил лимитный ордер на ${sideLabel(side)} ${qty} ${coin} по $${limitPrice}`,
  };
  await db.events.insert(ev);
  if (io) {
    io.emit('newEvent', ev);
    io.emit('orderbookUpdate', { coin });
  }

  // Агрессивный ордер должен исполниться сразу, не дожидаясь тика
  const priceDoc = await db.prices.findOne({ coin });
  const result   = await runMatching(io, { [coin]: priceDoc ? priceDoc.price : null });

  if (io && result.fills > 0) {
    const docs = await db.prices.find({});
    const upd  = {};
    docs.forEach(d => { upd[d.coin] = d.price; });
    io.emit('priceUpdate', upd);
  }

  const order   = await db.orders.findOne({ _id: inserted._id });
  const updated = await db.wallets.findOne({ username });
  if (io) io.emit('walletUpdate', { username, wallet: updated });

  return { order, wallet: updated };
}

// ── Отмена ордера ────────────────────────────────────────────────────────────
async function cancelOrder(username, id, io) {
  const order = await db.orders.findOne({ _id: id });
  if (!order)                     return { error: 'Ордер не найден' };
  if (order.username !== username) return { error: 'Это не твой ордер' };
  if (order.status !== 'open')     return { error: 'Ордер уже закрыт' };

  await refundEscrow(order);
  await db.orders.update({ _id: id }, { $set: {
    status: 'cancelled', lockedUsd: 0, lockedCoin: 0, closedAt: Date.now(),
  } });

  const wallet = await db.wallets.findOne({ username });
  const ev = {
    ts: Date.now(),
    text: `${username} отменил лимитный ордер на ${sideLabel(order.side)} ${remaining(order).toFixed(6)} ${order.coin} по $${order.price}`,
  };
  await db.events.insert(ev);
  if (io) {
    io.emit('newEvent', ev);
    io.emit('walletUpdate', { username, wallet });
    io.emit('orderUpdate', { username });
    io.emit('orderbookUpdate', { coin: order.coin });
  }
  return { ok: true, wallet };
}

// ── Ордера игрока + сводка по резервам ───────────────────────────────────────
async function listUserOrders(username, includeClosed) {
  const open = await db.orders.find({ username, status: 'open' }).sort({ ts: -1 });
  let closed = [];
  if (includeClosed) {
    closed = await db.orders.find({ username, status: { $ne: 'open' } }).sort({ closedAt: -1 }).limit(15);
  }
  const lockedUsd   = open.reduce((s, o) => s + (o.lockedUsd || 0), 0);
  const lockedCoins = {};
  for (const o of open) {
    if ((o.lockedCoin || 0) > 0) lockedCoins[o.coin] = (lockedCoins[o.coin] || 0) + o.lockedCoin;
  }
  return { open, closed, lockedUsd, lockedCoins, maxOpen: MAX_OPEN_ORDERS };
}

// ── Стакан по монете ─────────────────────────────────────────────────────────
async function getOrderBook(coin, username) {
  const priceDoc = await db.prices.findOne({ coin });
  if (!priceDoc) return { error: 'Неизвестная монета' };

  const orders = await db.orders.find({ coin, status: 'open' });

  const levels = { buy: new Map(), sell: new Map() };
  for (const o of orders) {
    const rest = remaining(o);
    if (rest <= QTY_EPS) continue;
    const map = levels[o.side];
    if (!map) continue;
    const cur = map.get(o.price) || { price: o.price, amount: 0, count: 0, mine: false };
    cur.amount += rest;
    cur.count  += 1;
    if (o.username === username) cur.mine = true;
    map.set(o.price, cur);
  }

  const bids = [...levels.buy.values() ].sort((a, b) => b.price - a.price).slice(0, 12);
  const asks = [...levels.sell.values()].sort((a, b) => a.price - b.price).slice(0, 12);

  return {
    coin,
    price:     priceDoc.price,
    askPrice:  priceDoc.price * (1 + SPREAD),
    bidPrice:  priceDoc.price * (1 - SPREAD),
    spread:    SPREAD,
    tradeFee:  TRADE_FEE,
    bids,
    asks,
    bestBid:   bids[0] ? bids[0].price : null,
    bestAsk:   asks[0] ? asks[0].price : null,
  };
}

// ── Массовая отмена (удаление монеты / игрока админом) ───────────────────────
async function cancelOrdersForCoin(coin, io) {
  const open = await db.orders.find({ coin, status: 'open' });
  for (const order of open) {
    await refundEscrow(order);
    await db.orders.update({ _id: order._id }, { $set: {
      status: 'cancelled', lockedUsd: 0, lockedCoin: 0, closedAt: Date.now(),
    } });
    if (io) io.emit('orderUpdate', { username: order.username });
  }
  if (io && open.length) io.emit('orderbookUpdate', { coin });
  return open.length;
}

async function cancelOrdersForUser(username, io) {
  const open = await db.orders.find({ username, status: 'open' });
  for (const order of open) {
    await refundEscrow(order);
    await db.orders.update({ _id: order._id }, { $set: {
      status: 'cancelled', lockedUsd: 0, lockedCoin: 0, closedAt: Date.now(),
    } });
    if (io) io.emit('orderbookUpdate', { coin: order.coin });
  }
  if (io && open.length) io.emit('orderUpdate', { username });
  return open.length;
}

module.exports = {
  runMatching,
  placeOrder,
  cancelOrder,
  listUserOrders,
  getOrderBook,
  cancelOrdersForCoin,
  cancelOrdersForUser,
  TRADE_FEE,
  SPREAD,
  MAX_OPEN_ORDERS,
};
