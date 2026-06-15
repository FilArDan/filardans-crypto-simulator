/* ===== СЕРВЕРНЫЕ БОТЫ (порт из singleplayer/js/bots.js) ===== */

const { db, EXCHANGE_USERNAME } = require('../db');

const FEE = 0.001;
const BOT_EMOJI = { bull: '\uD83D\uDC02', fox: '\uD83E\uDD8A', croc: '\uD83D\uDC0A' };
const HIST_LEN = 30;
const priceHistory = {};

// Кэш базовых цен монет (загружается один раз при первом тике)
const basePriceCache = {};

async function getBasePrice(coin) {
  if (basePriceCache[coin] !== undefined) return basePriceCache[coin];
  const doc = await db.prices.findOne({ coin });
  const base = (doc && doc.basePrice) ? doc.basePrice : (doc ? doc.price : null);
  if (base) basePriceCache[coin] = base;
  return base || null;
}

// Обновляет баланс EXCHANGE симметрично сделке бота:
//   buy  → бот платит cost USD, получает amt монет
//          EXCHANGE получает +cost USD, отдаёт -amt монет
//   sell → бот получает proc USD, отдаёт amt монет
//          EXCHANGE платит -proc USD, получает +amt монет
async function syncExchange(action, usdAmount, coin, coinAmt) {
  if (!usdAmount || usdAmount <= 0) return;
  const usdDelta  = action === 'buy' ? +usdAmount : -usdAmount;
  const coinDelta = coin && coinAmt > 0
    ? (action === 'buy' ? -coinAmt : +coinAmt)
    : null;

  const inc = { usd: usdDelta };
  if (coinDelta !== null) inc[coin] = coinDelta;

  await db.wallets.update(
    { username: EXCHANGE_USERNAME },
    { $inc: inc }
  );
}

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function sanitizeBot(bot) {
  return {
    name:   String(bot.name || '').trim(),
    type:   ['bull','fox','croc'].includes(bot.type) ? bot.type : 'fox',
    usd:    Number(bot.usd)  || 0,
    held:   (bot.held   && typeof bot.held   === 'object') ? bot.held   : {},
    avgP:   (bot.avgP   && typeof bot.avgP   === 'object') ? bot.avgP   : {},
    target: (bot.target && typeof bot.target === 'object') ? bot.target : {},
  };
}

function updatePriceHistory(prices) {
  for (const [coin, price] of Object.entries(prices)) {
    if (!priceHistory[coin]) priceHistory[coin] = [];
    priceHistory[coin].push(price);
    if (priceHistory[coin].length > HIST_LEN) priceHistory[coin].shift();
  }
}

function getAvgPrice(coin, n) {
  const hist = priceHistory[coin];
  if (!hist || hist.length === 0) return null;
  const slice = hist.slice(-Math.min(n, hist.length));
  return slice.reduce((s, p) => s + p, 0) / slice.length;
}

async function applyTP(coin, amt, action) {
  const { applyTradePressure } = require('./market');
  return applyTradePressure(coin, amt, action);
}

function botPortfolioValue(bot, prices) {
  let total = Number(bot.usd) || 0;
  for (const [coin, amt] of Object.entries(bot.held || {})) {
    if (amt > 0 && prices[coin]) total += amt * prices[coin];
  }
  return total;
}

// ── Кредиты ботов ─────────────────────────────────────────────────────────────
// Константы: максимальный кредит и минимальный порог USD для запроса
const BOT_LOAN_RATE      = 0.002;  // 0.2% долга в тик (выше, чем у игрока)
const BOT_MIN_USD_THRESH = 50;     // ниже этого порога бот рассматривает кредит
const BOT_LOAN_MULT      = 3;      // берёт до 3× текущего USD (но не более MAX)
const BOT_LOAN_MAX       = 5000;   // максимальный размер кредита бота
const BOT_LOAN_MIN       = 100;    // минимум — как у игрока

/**
 * Пытается выдать боту кредит из казны биржи.
 * bull  берёт кредит при сильном падении (belowBase).
 * croc  берёт кредит при глубокой просадке (belowBase).
 * fox   никогда не берёт.
 * Возвращает сумму выданного кредита (0 если отказано).
 */
async function tryBotLoan(botName, currentUsd, requestAmount) {
  // Уже есть активный кредит — не выдаём второй
  const existing = await db.loans.findOne({ username: botName, paid: { $ne: true } });
  if (existing) return 0;

  const amount = Math.min(Math.max(Math.floor(requestAmount), BOT_LOAN_MIN), BOT_LOAN_MAX);
  if (amount < BOT_LOAN_MIN) return 0;

  // Проверяем, есть ли деньги в казне
  const exchWallet = await db.wallets.findOne({ username: EXCHANGE_USERNAME });
  if (!exchWallet || exchWallet.usd < amount) return 0;

  // Выдаём кредит: биржа отдаёт USD боту
  await db.loans.insert({
    username:  botName,
    principal: amount,
    due:       amount,
    rate:      BOT_LOAN_RATE,
    ts:        Date.now(),
    paid:      false,
    isBot:     true,
  });
  await db.wallets.update({ username: EXCHANGE_USERNAME }, { $inc: { usd: -amount } });
  return amount;
}

/**
 * Начисляет проценты по кредитам ботов и пополняет казну банка.
 * Вызывается из botTick() после всех сделок.
 */
async function accrueBotsInterest() {
  const botLoans = await db.loans.find({ isBot: true, paid: { $ne: true } });
  for (const loan of botLoans) {
    const interest = loan.due * (loan.rate || BOT_LOAN_RATE);
    const newDue   = loan.due + interest;
    await db.loans.update({ _id: loan._id }, { $set: { due: newDue } });
    // Банк получает проценты в казну
    await db.wallets.update({ username: EXCHANGE_USERNAME }, { $inc: { usd: interest } });

    // Авто-погашение: если у бота накопилось достаточно USD — гасим долг
    const bot = await db.bots.findOne({ name: loan.username });
    if (bot && (Number(bot.usd) || 0) >= newDue * 1.5) {
      const repay = Math.min(Number(bot.usd) * 0.4, newDue);
      await db.bots.update({ name: loan.username }, { $inc: { usd: -repay } });
      await db.wallets.update({ username: EXCHANGE_USERNAME }, { $inc: { usd: repay } });
      const remaining = newDue - repay;
      if (remaining < 0.01) {
        await db.loans.update({ _id: loan._id }, { $set: { due: 0, paid: true } });
      } else {
        await db.loans.update({ _id: loan._id }, { $set: { due: remaining } });
      }
    }
  }
}

// ── 🐂 Агрессор ────────────────────────────────────────────────────────────────────────────────────
async function bullTick(bot, coins, prices) {
  const coin = coins[Math.floor(Math.random() * coins.length)];
  const price = prices[coin];
  if (!price) return;
  const avgLong = getAvgPrice(coin, 20) || price;
  const base = await getBasePrice(coin);
  const roll = Math.random();

  const belowAvg  = price < avgLong * 0.98;
  const belowBase = base && price < base * 0.85;

  // Если USD почти кончился, а ситуация очень привлекательная — берём кредит
  if (belowBase && bot.usd < BOT_MIN_USD_THRESH && roll < 0.60) {
    const loanAmt = await tryBotLoan(bot.name, bot.usd, bot.usd * BOT_LOAN_MULT + BOT_LOAN_MIN);
    bot.usd += loanAmt;
  }

  if ((belowAvg || belowBase) && roll < 0.85) {
    const urgency = belowBase ? 1.5 : 1.0;
    const spend = Math.min(bot.usd, bot.usd * (0.30 + Math.random() * 0.30) * urgency);
    if (spend < 1) return;
    const amt  = spend / price;
    const cost = amt * price * (1 + FEE);
    if (cost > bot.usd) return;

    // Проверяем запас биржи
    const exchWallet = await db.wallets.findOne({ username: EXCHANGE_USERNAME });
    if (!exchWallet || (exchWallet[coin] || 0) < amt) return;

    const prevTotal = (bot.held[coin] || 0) * (bot.avgP[coin] || 0);
    bot.usd -= cost;
    bot.held[coin] = (bot.held[coin] || 0) + amt;
    bot.avgP[coin] = (prevTotal + amt * price) / bot.held[coin];
    await syncExchange('buy', cost, coin, amt);
    prices[coin] = await applyTP(coin, amt, 'buy');
  } else if (price > avgLong * 1.03 && (bot.held[coin] || 0) > 0 && roll < 0.80) {
    const frac     = 0.50 + Math.random() * 0.40;
    const amt      = (bot.held[coin] || 0) * frac;
    const proceeds = amt * price * (1 - FEE);
    bot.usd += proceeds;
    bot.held[coin] -= amt;
    if (bot.held[coin] < 0.0001) bot.held[coin] = 0;
    await syncExchange('sell', proceeds, coin, amt);
    prices[coin] = await applyTP(coin, amt, 'sell');
  }
}

// ── 🦊 Осторожный ──────────────────────────────────────────────────────────────────────────────────
async function foxTick(bot, coins, prices) {
  // fox никогда не берёт кредиты
  if (Math.random() > 0.40) return;
  const coin = coins[Math.floor(Math.random() * coins.length)];
  const price = prices[coin];
  if (!price) return;
  const avgLong = getAvgPrice(coin, 20) || price;
  const base = await getBasePrice(coin);
  const roll = Math.random();

  const belowAvg  = price < avgLong * 0.97;
  const belowBase = base && price < base * 0.80;

  if ((belowAvg || belowBase) && roll < 0.60) {
    const spend = bot.usd * (0.02 + Math.random() * 0.06);
    if (spend < 1) return;
    const amt  = spend / price;
    const cost = amt * price * (1 + FEE);
    if (cost > bot.usd) return;

    // Проверяем запас биржи
    const exchWallet = await db.wallets.findOne({ username: EXCHANGE_USERNAME });
    if (!exchWallet || (exchWallet[coin] || 0) < amt) return;

    const prevTotal = (bot.held[coin] || 0) * (bot.avgP[coin] || 0);
    bot.usd -= cost;
    bot.held[coin] = (bot.held[coin] || 0) + amt;
    bot.avgP[coin] = (prevTotal + amt * price) / bot.held[coin];
    await syncExchange('buy', cost, coin, amt);
    prices[coin] = await applyTP(coin, amt, 'buy');
  } else if (price > avgLong * 1.05 && (bot.held[coin] || 0) > 0 && roll < 0.50) {
    const frac     = 0.10 + Math.random() * 0.20;
    const amt      = (bot.held[coin] || 0) * frac;
    const proceeds = amt * price * (1 - FEE);
    bot.usd += proceeds;
    bot.held[coin] -= amt;
    if (bot.held[coin] < 0.0001) bot.held[coin] = 0;
    await syncExchange('sell', proceeds, coin, amt);
    prices[coin] = await applyTP(coin, amt, 'sell');
  }
}

// ── 🐊 Накопитель ───────────────────────────────────────────────────────────────────────────────────
async function crocTick(bot, coins, prices) {
  const coin = coins[Math.floor(Math.random() * coins.length)];
  const price = prices[coin];
  if (!price) return;
  if (!bot.target)        bot.target        = {};
  if (!bot.target[coin])  bot.target[coin]  = 1.25 + Math.random() * 0.20;

  const base = await getBasePrice(coin);

  const belowBase    = base && price < base * 0.75;
  const buyChance    = belowBase ? 0.85 : 0.65;
  const spendFraction = belowBase
    ? (0.03 + Math.random() * 0.05)
    : (0.01 + Math.random() * 0.03);

  // croc берёт кредит при очень глубокой просадке и пустом кармане
  if (belowBase && bot.usd < BOT_MIN_USD_THRESH && Math.random() < 0.50) {
    const loanAmt = await tryBotLoan(bot.name, bot.usd, bot.usd * BOT_LOAN_MULT + BOT_LOAN_MIN);
    bot.usd += loanAmt;
  }

  if (Math.random() < buyChance) {
    const spend = bot.usd * spendFraction;
    if (spend >= 1) {
      const amt  = spend / price;
      const cost = amt * price * (1 + FEE);
      if (cost <= bot.usd) {
        // Проверяем запас биржи
        const exchWallet = await db.wallets.findOne({ username: EXCHANGE_USERNAME });
        if (exchWallet && (exchWallet[coin] || 0) >= amt) {
          const prevTotal = (bot.held[coin] || 0) * (bot.avgP[coin] || 0);
          bot.usd -= cost;
          bot.held[coin] = (bot.held[coin] || 0) + amt;
          bot.avgP[coin] = (prevTotal + amt * price) / bot.held[coin];
          await syncExchange('buy', cost, coin, amt);
          prices[coin] = await applyTP(coin, amt, 'buy');
        }
      }
    }
  }

  const avg = bot.avgP[coin] || 0;
  if (avg > 0 && (bot.held[coin] || 0) > 0) {
    const targetMult = bot.target[coin] || 1.30;
    if (prices[coin] >= avg * targetMult) {
      const amt      = (bot.held[coin] || 0) * 0.20;
      const proceeds = amt * prices[coin] * (1 - FEE);
      bot.usd += proceeds;
      bot.held[coin] -= amt;
      if (bot.held[coin] < 0.0001) { bot.held[coin] = 0; bot.avgP[coin] = 0; }
      bot.target[coin] = 1.25 + Math.random() * 0.20;
      await syncExchange('sell', proceeds, coin, amt);
      prices[coin] = await applyTP(coin, amt, 'sell');
    }
  }
}

// ── DB helpers ────────────────────────────────────────────────────────────────────────────────────
function listBotsRaw() {
  return db.bots.find({});
}

async function replaceBotState(name, state) {
  const clean = sanitizeBot(state);
  await db.bots.update({ name }, { $set: { usd: clean.usd, held: clean.held, avgP: clean.avgP, target: clean.target } });
}

// ── Главный тик ──────────────────────────────────────────────────────────────────────────────────────
async function botTick(io, currentPrices) {
  if (!currentPrices || Object.keys(currentPrices).length === 0) return;
  const coins  = Object.keys(currentPrices);
  const prices = { ...currentPrices };
  const bots   = await listBotsRaw();

  for (const bot of bots) {
    const b = sanitizeBot(bot);
    try {
      if      (b.type === 'bull') await bullTick(b, coins, prices);
      else if (b.type === 'fox')  await foxTick (b, coins, prices);
      else if (b.type === 'croc') await crocTick(b, coins, prices);
      await replaceBotState(b.name, b);
    } catch (_) {}
  }

  // Начисляем проценты по кредитам ботов и возвращаем деньги в казну
  try { await accrueBotsInterest(); } catch (_) {}
}

// ── Статистика ──────────────────────────────────────────────────────────────────────────────────────
async function getBotStats(prices) {
  const bots = await listBotsRaw();
  return bots.map(bot => {
    const b = sanitizeBot(bot);
    return {
      username: b.name,
      isBot:    true,
      botType:  b.type,
      botEmoji: BOT_EMOJI[b.type] || '\uD83E\uDD16',
      usd:      round2(b.usd),
      total:    round2(botPortfolioValue(b, prices || {})),
      held:     { ...(b.held || {}) },
    };
  });
}

// ── CRUD ─────────────────────────────────────────────────────────────────────────────────────────
async function createBot({ name, type, usd }) {
  const cleanName = String(name || '').trim();
  if (!cleanName) throw new Error('Укажите имя бота');
  if (!['bull','fox','croc'].includes(type)) throw new Error('Неизвестный пресет');
  const exists = await db.bots.findOne({ name: cleanName });
  if (exists) throw new Error('Бот с таким именем уже существует');
  const bot = sanitizeBot({ name: cleanName, type, usd: Number(usd) || 0, held: {}, avgP: {}, target: {} });
  await db.bots.insert(bot);
  return bot;
}

async function deleteBot(name) {
  // При удалении бота гасим его кредиты (списываем)
  await db.loans.remove({ username: String(name || '').trim(), isBot: true }, { multi: true });
  return db.bots.remove({ name: String(name || '').trim() }, {});
}

async function setBotCash(name, usd) {
  const n = String(name || '').trim();
  await db.bots.update({ name: n }, { $set: { usd: Number(usd) || 0 } });
  return db.bots.findOne({ name: n });
}

async function updateBotPreset(name, type) {
  const n = String(name || '').trim();
  if (!['bull','fox','croc'].includes(type)) throw new Error('Неизвестный пресет');
  await db.bots.update({ name: n }, { $set: { type, target: {} } });
  return db.bots.findOne({ name: n });
}

module.exports = {
  botTick,
  updatePriceHistory,
  getBotStats,
  listBotsRaw,
  createBot,
  deleteBot,
  setBotCash,
  updateBotPreset,
  priceHistory,
};
