// ===== SERVER-SIDE ORDER BOOK ENGINE =====
// Упрощённый ордербук для интеграции с crypto-server.
// Хранит стакан в памяти процесса и позволяет матчить рыночные/лимитные ордера.
// Первичная цель — не ломая текущую механику tick/applyTradePressure,
// добавить более реалистичный режим торговли, где цена — результат сделок.

const { db, EXCHANGE_USERNAME } = require('../db');

// Типы через JSDoc для читабельности и IDE
/** @typedef {'buy'|'sell'} Side */
/** @typedef {'market'|'limit'} OrderType */

/**
 * @typedef {Object} Order
 * @property {string} id
 * @property {string} username
 * @property {string} coin
 * @property {Side}   side
 * @property {OrderType} type
 * @property {number} [price]    // только для лимитных ордеров
 * @property {number} amount     // исходный объём
 * @property {number} remaining  // сколько ещё не исполнено
 * @property {number} createdAt
 */

/**
 * @typedef {Object} PriceLevel
 * @property {number} price
 * @property {Order[]} orders  // FIFO внутри уровня
 */

/**
 * @typedef {Object} Trade
 * @property {string} coin
 * @property {string} buyUsername
 * @property {string} sellUsername
 * @property {number} price
 * @property {number} amount
 * @property {number} ts
 */

class OrderBook {
  constructor(coin) {
    this.coin = coin;
    /** @type {PriceLevel[]} */ this.bids = []; // buy, сортировка по убыванию цены
    /** @type {PriceLevel[]} */ this.asks = []; // sell, сортировка по возрастанию цены
    /** @type {Trade[]} */ this.trades = [];
  }

  /**
   * Основной метод: разместить ордер в стакане.
   * Возвращает массив совершённых сделок.
   * Важно: изменение кошельков и запись в db.events/db.priceHistory
   * остаются на стороне маршрута /api/trade. Здесь только микроструктура.
   * @param {Order} order
   * @returns {Trade[]}
   */
  placeOrder(order) {
    const trades = [];

    if (order.side === 'buy') {
      this._matchBuy(order, trades);
      if (order.type === 'limit' && order.remaining > 0) {
        this._addToBook(this.bids, order, 'desc');
      }
    } else {
      this._matchSell(order, trades);
      if (order.type === 'limit' && order.remaining > 0) {
        this._addToBook(this.asks, order, 'asc');
      }
    }

    if (trades.length) {
      this.trades.push(...trades);
    }

    return trades;
  }

  _matchBuy(order, trades) {
    while (order.remaining > 0 && this.asks.length > 0) {
      const bestAsk = this.asks[0];

      // Лимитка не поднимается выше своей цены
      if (order.type === 'limit' && order.price < bestAsk.price) break;

      const maker = bestAsk.orders[0];
      const fillAmount = Math.min(order.remaining, maker.remaining);

      maker.remaining -= fillAmount;
      order.remaining -= fillAmount;

      trades.push({
        coin: this.coin,
        buyUsername: order.side === 'buy' ? order.username : maker.username,
        sellUsername: order.side === 'sell' ? order.username : maker.username,
        price: bestAsk.price,
        amount: fillAmount,
        ts: Date.now(),
      });

      if (maker.remaining <= 0) bestAsk.orders.shift();
      if (bestAsk.orders.length === 0) this.asks.shift();
    }
  }

  _matchSell(order, trades) {
    while (order.remaining > 0 && this.bids.length > 0) {
      const bestBid = this.bids[0];

      if (order.type === 'limit' && order.price > bestBid.price) break;

      const maker = bestBid.orders[0];
      const fillAmount = Math.min(order.remaining, maker.remaining);

      maker.remaining -= fillAmount;
      order.remaining -= fillAmount;

      trades.push({
        coin: this.coin,
        buyUsername: order.side === 'buy' ? order.username : maker.username,
        sellUsername: order.side === 'sell' ? order.username : maker.username,
        price: bestBid.price,
        amount: fillAmount,
        ts: Date.now(),
      });

      if (maker.remaining <= 0) bestBid.orders.shift();
      if (bestBid.orders.length === 0) this.bids.shift();
    }
  }

  _addToBook(book, order, sort) {
    const level = book.find(l => l.price === order.price);
    if (level) {
      level.orders.push(order);
    } else {
      book.push({ price: order.price, orders: [order] });
      book.sort((a, b) => sort === 'asc' ? a.price - b.price : b.price - a.price);
    }
  }

  /**
   * Глубина стакана: для каждой стороны отдаём уровни цены и суммарный объём.
   */
  getDepth() {
    const sumLevels = (levels) =>
      levels.map(l => ({
        price: l.price,
        volume: l.orders.reduce((acc, o) => acc + o.remaining, 0),
      }));
    return {
      coin: this.coin,
      bids: sumLevels(this.bids),
      asks: sumLevels(this.asks),
    };
  }
}

// Хранилище ордербуков по монетам.
const ORDER_BOOKS = new Map();

function getOrderBook(coin) {
  if (!ORDER_BOOKS.has(coin)) {
    ORDER_BOOKS.set(coin, new OrderBook(coin));
  }
  return ORDER_BOOKS.get(coin);
}

/**
 * Опциональный режим: выполнить сделку через ордербук.
 * Возвращает:
 *   - trades: массив сделок
 *   - avgPrice: средняя цена исполнения (если были сделки)
 */
async function executeViaOrderBook({ coin, username, action, amount }) {
  const ob = getOrderBook(coin);

  const order = {
    id: 'srv-' + Date.now() + '-' + Math.random().toString(16).slice(2),
    username,
    coin,
    side: action,
    type: 'market',
    price: undefined,
    amount,
    remaining: amount,
    createdAt: Date.now(),
  };

  const trades = ob.placeOrder(order);

  if (!trades.length) {
    return { trades: [], avgPrice: null };
  }

  const totalNotional = trades.reduce((s, t) => s + t.price * t.amount, 0);
  const totalAmount   = trades.reduce((s, t) => s + t.amount, 0);
  const avgPrice      = totalNotional / totalAmount;

  // Обновляем db.prices для этой монеты до средней цены исполнения
  // (не меняем остальной код tick/applyTradePressure).
  await db.prices.update({ coin }, { $set: { price: avgPrice } });

  return { trades, avgPrice };
}

module.exports = { getOrderBook, executeViaOrderBook };
