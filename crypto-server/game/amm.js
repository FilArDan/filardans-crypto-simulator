/* ===== AMM — альтернативный (свободный) рынок ====================================
 * Второй, полностью независимый способ торговать теми же тикерами, что и на
 * "официальной" бирже (db.prices/EXCHANGE): вместо назначенной ГМом цены с
 * шумом/дрейфом, цена здесь — чистая функция резервов конкретного пула
 * (constant product, x*y=k), как в Uniswap v2. Пул торгует ТЕМ ЖЕ активом
 * (тот же тикер, тот же supply/wallet[ticker] у игроков) — просто ещё одна
 * площадка со своей ликвидностью и своей ценой, которая может разойтись с
 * официальной (это и есть смысл — арбитраж между двумя рынками).
 *
 * Резервы пула хранятся не в db.wallets (чтобы не путаться с портфелем/
 * лидербордом игроков), а прямо в самом документе db.ammPools.
 */

const { db, getAllCoins } = require('../db');

const AMM_FEE = 0.003; // 0.3% — комиссия остаётся в резервах пула, наращивая стоимость LP-долей

async function isAmmEnabled() {
  const doc = await db.settings.findOne({ _id: 'ammEnabled' });
  return !doc || doc.value !== false; // по умолчанию включён, пока ГМ явно не выключил
}

async function setAmmEnabled(enabled) {
  await db.settings.update({ _id: 'ammEnabled' }, { _id: 'ammEnabled', value: !!enabled }, { upsert: true });
}

function poolPrice(pool) {
  if (!pool || !pool.reserveCoin) return 0;
  return pool.reserveUsd / pool.reserveCoin;
}

async function listPools(username) {
  const pools = await db.ammPools.find({});
  return pools.map(p => {
    const myShares = (username && p.lpShares && p.lpShares[username]) || 0;
    return {
      ticker: p.ticker,
      reserveCoin: p.reserveCoin,
      reserveUsd: p.reserveUsd,
      totalShares: p.totalShares,
      price: poolPrice(p),
      myShares,
      myPct: p.totalShares > 0 ? (myShares / p.totalShares) * 100 : 0,
    };
  });
}

async function listPoolsAdmin() {
  const pools = await db.ammPools.find({});
  return pools.map(p => ({
    ticker: p.ticker,
    reserveCoin: p.reserveCoin,
    reserveUsd: p.reserveUsd,
    totalShares: p.totalShares,
    price: poolPrice(p),
    lpCount: Object.keys(p.lpShares || {}).length,
  }));
}

async function getPool(ticker) {
  return db.ammPools.findOne({ ticker });
}

async function createPool(ticker) {
  const clean = String(ticker || '').trim().toUpperCase();
  if (!clean) throw new Error('Укажите тикер');
  const allCoins = await getAllCoins();
  if (!allCoins.includes(clean)) throw new Error('Такого актива не существует на бирже');
  const exists = await db.ammPools.findOne({ ticker: clean });
  if (exists) throw new Error('Пул для этого актива уже создан');
  const pool = { ticker: clean, reserveCoin: 0, reserveUsd: 0, totalShares: 0, lpShares: {}, createdAt: Date.now() };
  await db.ammPools.insert(pool);
  return pool;
}

// Удалить можно только полностью пустой пул (без LP-долей) — иначе пришлось
// бы решать, кому и как принудительно возвращать чужую внесённую ликвидность.
async function deletePool(ticker) {
  const pool = await db.ammPools.findOne({ ticker });
  if (!pool) throw new Error('Пул не найден');
  if (pool.totalShares > 0) throw new Error('Нельзя удалить пул, пока в нём есть чужая ликвидность');
  await db.ammPools.remove({ ticker }, {});
}

// ── Ликвидность ──────────────────────────────────────────────────────────────
// Первый провайдер сам задаёт стартовую цену пула (вносит обе стороны в
// произвольном соотношении). Если резервы уже есть — вносить можно только в
// текущей пропорции, поэтому от игрока принимается только сумма в USC, а
// количество монеты сервер довычисляет сам по актуальному курсу пула (иначе
// клиент мог бы протащить произвольное соотношение и исказить цену).
async function addLiquidity(username, ticker, usdAmt, coinAmtForInitial) {
  const pool = await db.ammPools.findOne({ ticker });
  if (!pool) throw new Error('Пул не найден');
  usdAmt = Number(usdAmt);
  if (!Number.isFinite(usdAmt) || usdAmt <= 0) throw new Error('Неверная сумма USC');

  const wallet = await db.wallets.findOne({ username });
  if (!wallet) throw new Error('Кошелёк не найден');

  let coinAmt, sharesMinted;
  if (pool.totalShares <= 0) {
    coinAmt = Number(coinAmtForInitial);
    if (!Number.isFinite(coinAmt) || coinAmt <= 0)
      throw new Error('Для первого вклада в пустой пул укажите и сумму USC, и количество монеты — вместе они зададут стартовую цену');
    sharesMinted = usdAmt; // базовая единица LP-доли при основании пула — 1 доля ≈ 1 USC
  } else {
    coinAmt = usdAmt * (pool.reserveCoin / pool.reserveUsd);
    sharesMinted = pool.totalShares * (usdAmt / pool.reserveUsd);
  }

  if ((wallet.usd || 0) < usdAmt) throw new Error('Недостаточно USC');
  if ((wallet[ticker] || 0) < coinAmt) throw new Error(`Недостаточно ${ticker}`);

  // lpShares правится через read-modify-write целиком объектом (а не
  // dotted-path $inc по ключу username), т.к. username — свободный текст,
  // который в теории может содержать точку и сломать вложенный путь Mongo.
  const lpShares = { ...(pool.lpShares || {}) };
  lpShares[username] = (lpShares[username] || 0) + sharesMinted;

  await db.wallets.update({ username }, { $inc: { usd: -usdAmt, [ticker]: -coinAmt } });
  await db.ammPools.update({ ticker }, {
    $inc: { reserveUsd: usdAmt, reserveCoin: coinAmt, totalShares: sharesMinted },
    $set: { lpShares },
  });

  return { coinAmt, sharesMinted };
}

async function removeLiquidity(username, ticker, shares) {
  const pool = await db.ammPools.findOne({ ticker });
  if (!pool) throw new Error('Пул не найден');
  shares = Number(shares);
  const myShares = (pool.lpShares && pool.lpShares[username]) || 0;
  if (!Number.isFinite(shares) || shares <= 0) throw new Error('Неверное количество долей');
  if (shares > myShares + 1e-9) throw new Error('У вас нет столько LP-долей');

  const frac    = shares / pool.totalShares;
  const coinOut = pool.reserveCoin * frac;
  const usdOut  = pool.reserveUsd  * frac;

  const lpShares = { ...(pool.lpShares || {}) };
  const remaining = myShares - shares;
  if (remaining <= 1e-9) delete lpShares[username];
  else lpShares[username] = remaining;

  await db.ammPools.update({ ticker }, {
    $inc: { reserveUsd: -usdOut, reserveCoin: -coinOut, totalShares: -shares },
    $set: { lpShares },
  });
  await db.wallets.update({ username }, { $inc: { usd: +usdOut, [ticker]: +coinOut } });

  return { coinOut, usdOut };
}

// ── Своп (constant product, формула Uniswap v2 с комиссией) ──────────────────
// amountInWithFee = amountIn * (1 - AMM_FEE); выход считается по кривой от
// урезанной на комиссию суммы, а в резерв (reserveIn) добавляется ПОЛНАЯ
// сумма входа — комиссия остаётся в пуле и достаётся держателям LP-долей
// пропорционально, без отдельного учёта.
function swapOut(reserveIn, reserveOut, amountIn) {
  const amountInWithFee = amountIn * (1 - AMM_FEE);
  return (amountInWithFee * reserveOut) / (reserveIn + amountInWithFee);
}

async function swap(username, ticker, action, amount) {
  const pool = await db.ammPools.findOne({ ticker });
  if (!pool) throw new Error('Пул не найден');
  amount = Number(amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Неверное количество');
  if (pool.reserveCoin <= 0 || pool.reserveUsd <= 0) throw new Error('В пуле пока нет ликвидности');

  const wallet = await db.wallets.findOne({ username });
  if (!wallet) throw new Error('Кошелёк не найден');

  if (action === 'buy') {
    // amount — сколько USC тратим, получаем монету
    if ((wallet.usd || 0) < amount) throw new Error('Недостаточно USC');
    const coinOut = swapOut(pool.reserveUsd, pool.reserveCoin, amount);
    if (coinOut >= pool.reserveCoin) throw new Error('Слишком крупная сделка для этого пула');
    await db.wallets.update({ username }, { $inc: { usd: -amount, [ticker]: +coinOut } });
    await db.ammPools.update({ ticker }, { $inc: { reserveUsd: +amount, reserveCoin: -coinOut } });
    return { spent: amount, received: coinOut };
  }

  if (action === 'sell') {
    // amount — сколько монеты продаём, получаем USC
    if ((wallet[ticker] || 0) < amount) throw new Error(`Недостаточно ${ticker}`);
    const usdOut = swapOut(pool.reserveCoin, pool.reserveUsd, amount);
    if (usdOut >= pool.reserveUsd) throw new Error('Слишком крупная сделка для этого пула');
    await db.wallets.update({ username }, { $inc: { [ticker]: -amount, usd: +usdOut } });
    await db.ammPools.update({ ticker }, { $inc: { reserveCoin: +amount, reserveUsd: -usdOut } });
    return { spent: amount, received: usdOut };
  }

  throw new Error('Неизвестное действие');
}

module.exports = {
  AMM_FEE,
  isAmmEnabled,
  setAmmEnabled,
  listPools,
  listPoolsAdmin,
  getPool,
  createPool,
  deletePool,
  addLiquidity,
  removeLiquidity,
  swap,
};
