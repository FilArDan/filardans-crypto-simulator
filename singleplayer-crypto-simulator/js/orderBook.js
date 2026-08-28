/* ===== УПРОЩЁННЫЙ ОРДЕРБУК ДЛЯ ОДНОЙ МОНЕТЫ ===== */

// В этом файле реализован минимальный стакан заявок и движок матчинга,
// который интегрируется с существующей логикой applyTradePressure()
// и не трогает текущую механику тик/дрифт/волатильность.

/**
 * Типы
 */

/** @typedef {'buy'|'sell'} Side */
/** @typedef {'market'|'limit'} OrderType */

/**
 * @typedef {Object} Order
 * @property {string} id
 * @property {string} userId
 * @property {Side} side
 * @property {OrderType} type
 * @property {number} [price]   // только для лимитных ордеров
 * @property {number} amount    // исходный объём
 * @property {number} remaining // сколько ещё не исполнено
 * @property {number} createdAt
 */

/**
 * @typedef {Object} PriceLevel
 * @property {number} price
 * @property {Order[]} orders   // FIFO внутри уровня
 */

/**
 * @typedef {Object} Trade
 * @property {string} buyOrderId
 * @property {string} sellOrderId
 * @property {string} sym
 * @property {number} price
 * @property {number} amount
 * @property {number} timestamp
 */

/**
 * Класс простого ордербука для одного символа.
 * В симуляторе можно создавать отдельный экземпляр на каждый sym,
 * либо один общий на всё (если хочешь глобальный стакан).
 */
class OrderBook {
  constructor(sym) {
    this.sym = sym;
    /** @type {PriceLevel[]} */ this.bids = []; // buy, сортировка по убыванию цены
    /** @type {PriceLevel[]} */ this.asks = []; // sell, сортировка по возрастанию цены
    /** @type {Trade[]} */ this.trades = [];
    this.lastPrice = COINS[sym]?.price || null;
  }

  /**
   * Общая точка входа для любых ордеров.
   * Возвращает массив сделок, которые были совершены.
   * Важно: сам код торговли (trade.js) отвечает за списание/зачисление денег
   * и монет игроку/боту, а OrderBook только считает сделки и обновляет цены.
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

    // сохраняем сделки в историю для графика/аналитики
    if (trades.length) {
      this.trades.push(...trades);
      // обновляем lastPrice до цены последней сделки
      this.lastPrice = trades[trades.length - 1].price;
      // дополнительно подталкиваем существующую историю цен симулятора
      st.pd[this.sym].push(this.lastPrice);
      if (st.pd[this.sym].length > PD_MAX) st.pd[this.sym].shift();
    }

    return trades;
  }

  /**
   * Матчинг для ордеров на покупку (потребляет asks).
   * @param {Order} order
   * @param {Trade[]} trades
   */
  _matchBuy(order, trades) {
    while (order.remaining > 0 && this.asks.length > 0) {
      const bestAsk = this.asks[0];

      // Для лимитки: если желаемая цена ниже лучшего аска — прекращаем матчинг.
      if (order.type === 'limit' && order.price < bestAsk.price) break;

      const maker = bestAsk.orders[0];
      const fillAmount = Math.min(order.remaining, maker.remaining);

      maker.remaining -= fillAmount;
      order.remaining -= fillAmount;

      const trade = {
        buyOrderId: order.side === 'buy' ? order.id : maker.id,
        sellOrderId: order.side === 'sell' ? order.id : maker.id,
        sym: this.sym,
        price: bestAsk.price,
        amount: fillAmount,
        timestamp: Date.now(),
      };
      trades.push(trade);

      if (maker.remaining <= 0) {
        bestAsk.orders.shift();
      }
      if (bestAsk.orders.length === 0) {
        this.asks.shift();
      }
    }
  }

  /**
   * Матчинг для ордеров на продажу (потребляет bids).
   * @param {Order} order
   * @param {Trade[]} trades
   */
  _matchSell(order, trades) {
    while (order.remaining > 0 && this.bids.length > 0) {
      const bestBid = this.bids[0];

      if (order.type === 'limit' && order.price > bestBid.price) break;

      const maker = bestBid.orders[0];
      const fillAmount = Math.min(order.remaining, maker.remaining);

      maker.remaining -= fillAmount;
      order.remaining -= fillAmount;

      const trade = {
        buyOrderId: order.side === 'buy' ? order.id : maker.id,
        sellOrderId: order.side === 'sell' ? order.id : maker.id,
        sym: this.sym,
        price: bestBid.price,
        amount: fillAmount,
        timestamp: Date.now(),
      };
      trades.push(trade);

      if (maker.remaining <= 0) {
        bestBid.orders.shift();
      }
      if (bestBid.orders.length === 0) {
        this.bids.shift();
      }
    }
  }

  /**
   * Добавление лимитного ордера в стакан.
   * @param {PriceLevel[]} book
   * @param {Order} order
   * @param {'asc'|'desc'} sort
   */
  _addToBook(book, order, sort) {
    const level = book.find((lvl) => lvl.price === order.price);
    if (level) {
      level.orders.push(order);
    } else {
      book.push({ price: order.price, orders: [order] });
      book.sort((a, b) => (sort === 'asc' ? a.price - b.price : b.price - a.price));
    }
  }

  /**
   * Вспомогательная функция: отдать «глубину рынка» для визуализации.
   * Возвращает массив с уровнями цен и суммой объёма на каждой цене.
   */
  getDepth() {
    const sumLevels = (levels) =>
      levels.map((lvl) => ({
        price: lvl.price,
        volume: lvl.orders.reduce((acc, o) => acc + o.remaining, 0),
      }));

    return {
      bids: sumLevels(this.bids),
      asks: sumLevels(this.asks),
      lastPrice: this.lastPrice,
    };
  }
}

// ==== ГЛОБАЛЬНАЯ ИНТЕГРАЦИЯ С УЖЕ СУЩЕСТВУЮЩИМ КОДОМ ==== //

/**
 * Один общий ордербук на все монеты — упрощённая модель.
 * Если захочешь сделать отдельный стакан для каждой монеты,
 * можно хранить их в объекте: const ORDER_BOOKS = { BTC: new OrderBook('BTC'), ... }.
 */
const GLOBAL_ORDER_BOOK = new OrderBook('BTC'); // по умолчанию для BTC

/**
 * Обёртки над существующей торговой логикой: вместо прямого вызова
 * applyTradePressure() можно (по желанию) использовать order book.
 * Пока в симуляторе всё остаётся как есть, поэтому эти функции
 * используются только если явно включить соответствующий режим.
 */

/**
 * Выполнить сделку через ордербук, затем применить существующий
 * эффект давления на цену (applyTradePressure) для сохранения ощущений.
 * @param {string} sym
 * @param {number} amount
 * @param {'buy'|'sell'} action
 */
function executeViaOrderBook(sym, amount, action) {
  // Для простоты сейчас используем один глобальный стакан для BTC.
  // Если торгуем другой монетой — fallback на старую механику.
  if (sym !== GLOBAL_ORDER_BOOK.sym) {
    applyTradePressure(sym, amount, action);
    return;
  }

  const basePrice = COINS[sym].price;
  const order = {
    id: 'local-' + Date.now() + '-' + Math.random().toString(16).slice(2),
    userId: 'player',
    side: action,
    type: 'market',
    price: undefined,
    amount,
    remaining: amount,
    createdAt: Date.now(),
  };

  const trades = GLOBAL_ORDER_BOOK.placeOrder(order);

  if (!trades.length) {
    // Если стакан пустой, чтобы ничего не сломать, используем текущую механику
    applyTradePressure(sym, amount, action);
    return;
  }

  // Уже lastPrice обновлён внутри OrderBook, а st.pd[sym] пополнен.
  // Дополнительно слегка сгладим, чтобы не ломать ощущения:
  const avgPrice = trades.reduce((acc, t) => acc + t.price * t.amount, 0) /
                   trades.reduce((acc, t) => acc + t.amount, 0);

  COINS[sym].price = +avgPrice.toFixed(2);
  st.pd[sym].push(COINS[sym].price);
  if (st.pd[sym].length > PD_MAX) st.pd[sym].shift();
}
