/* ===== СЕРВЕРНЫЕ БОТЫ (порт из singleplayer/js/bots.js) ===== */

const { db } = require('../db');

const FEE = 0.001; // 0.1% комиссия

// ── Начальные боты (идентичны singleplayer) ───────────────────────────────────
const BOTS = [
  { name: 'Агрессор-1', type: 'bull', usd: 15000, held: {}, avgP: {} },
  { name: 'Агрессор-2', type: 'bull', usd: 18000, held: {}, avgP: {} },
  { name: 'Лис-1',      type: 'fox',  usd: 10000, held: {}, avgP: {} },
  { name: 'Лис-2',      type: 'fox',  usd: 10000, held: {}, avgP: {} },
  { name: 'Лис-3',      type: 'fox',  usd: 12000, held: {}, avgP: {} },
  { name: 'Крок-1',     type: 'croc', usd: 20000, held: {}, avgP: {}, target: {} },
  { name: 'Крок-2',     type: 'croc', usd: 20000, held: {}, avgP: {}, target: {} },
  { name: 'Лис-4',      type: 'fox',  usd:  9000, held: {}, avgP: {} },
  { name: 'Лис-5',      type: 'fox',  usd: 11000, held: {}, avgP: {} },
  { name: 'Лис-6',      type: 'fox',  usd: 10000, held: {}, avgP: {} },
];

// ── История цен в памяти (30 тиков) ──────────────────────────────────────────
const priceHistory = {};
const HIST_LEN = 30;

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

// ── Ленивый импорт market (разрыв циклической зависимости) ───────────────────
async function applyTP(coin, amt, action) {
  const { applyTradePressure } = require('./market');
  return applyTradePressure(coin, amt, action);
}

// ── Стоимость портфеля бота ───────────────────────────────────────────────────
function botPortfolioValue(bot, prices) {
  let total = bot.usd;
  for (const [coin, amt] of Object.entries(bot.held)) {
    if (amt > 0 && prices[coin]) total += amt * prices[coin];
  }
  return total;
}

// ── 🐂 Агрессор ───────────────────────────────────────────────────────────────
async function bullTick(bot, coins, prices, basePrices) {
  const coin  = coins[Math.floor(Math.random() * coins.length)];
  const price = prices[coin];
  if (!price) return;

  const avgLong = getAvgPrice(coin, 20) || price;
  const roll    = Math.random();

  if (price < avgLong * 0.98 && roll < 0.85) {
    const spend = bot.usd * (0.30 + Math.random() * 0.30);
    if (spend < 1) return;
    const amt  = spend / price;
    const cost = amt * price * (1 + FEE);
    if (cost > bot.usd) return;
    const prevTotal     = (bot.held[coin] || 0) * (bot.avgP[coin] || 0);
    bot.usd            -= cost;
    bot.held[coin]      = (bot.held[coin] || 0) + amt;
    bot.avgP[coin]      = (prevTotal + amt * price) / bot.held[coin];
    const newP          = await applyTP(coin, amt, 'buy');
    prices[coin]        = newP;

  } else if (price > avgLong * 1.03 && (bot.held[coin] || 0) > 0 && roll < 0.80) {
    const frac     = 0.50 + Math.random() * 0.40;
    const amt      = (bot.held[coin] || 0) * frac;
    bot.usd       += amt * price * (1 - FEE);
    bot.held[coin] = (bot.held[coin] || 0) - amt;
    if (bot.held[coin] < 0.0001) bot.held[coin] = 0;
    const newP     = await applyTP(coin, amt, 'sell');
    prices[coin]   = newP;
  }
}

// ── 🦊 Осторожный ─────────────────────────────────────────────────────────────
async function foxTick(bot, coins, prices, basePrices) {
  if (Math.random() > 0.40) return; // часто пропускает ход
  const coin  = coins[Math.floor(Math.random() * coins.length)];
  const price = prices[coin];
  if (!price) return;

  const avgLong = getAvgPrice(coin, 20) || price;
  const roll    = Math.random();

  if (price < avgLong * 0.97 && roll < 0.60) {
    const spend = bot.usd * (0.02 + Math.random() * 0.06);
    if (spend < 1) return;
    const amt  = spend / price;
    const cost = amt * price * (1 + FEE);
    if (cost > bot.usd) return;
    const prevTotal     = (bot.held[coin] || 0) * (bot.avgP[coin] || 0);
    bot.usd            -= cost;
    bot.held[coin]      = (bot.held[coin] || 0) + amt;
    bot.avgP[coin]      = (prevTotal + amt * price) / bot.held[coin];
    const newP          = await applyTP(coin, amt, 'buy');
    prices[coin]        = newP;

  } else if (price > avgLong * 1.05 && (bot.held[coin] || 0) > 0 && roll < 0.50) {
    const frac     = 0.10 + Math.random() * 0.20;
    const amt      = (bot.held[coin] || 0) * frac;
    bot.usd       += amt * price * (1 - FEE);
    bot.held[coin] = (bot.held[coin] || 0) - amt;
    if (bot.held[coin] < 0.0001) bot.held[coin] = 0;
    const newP     = await applyTP(coin, amt, 'sell');
    prices[coin]   = newP;
  }
}

// ── 🐊 Накопитель ─────────────────────────────────────────────────────────────
async function crocTick(bot, coins, prices, basePrices) {
  const coin  = coins[Math.floor(Math.random() * coins.length)];
  const price = prices[coin];
  if (!price) return;
  if (!bot.target)           bot.target           = {};
  if (!bot.target[coin])     bot.target[coin]      = 1.25 + Math.random() * 0.20;

  // Фаза накопления — покупает понемногу почти всегда
  if (Math.random() < 0.65) {
    const spend = bot.usd * (0.01 + Math.random() * 0.03);
    if (spend >= 1) {
      const amt  = spend / price;
      const cost = amt * price * (1 + FEE);
      if (cost <= bot.usd) {
        const prevTotal     = (bot.held[coin] || 0) * (bot.avgP[coin] || 0);
        bot.usd            -= cost;
        bot.held[coin]      = (bot.held[coin] || 0) + amt;
        bot.avgP[coin]      = (prevTotal + amt * price) / bot.held[coin];
        const newP          = await applyTP(coin, amt, 'buy');
        prices[coin]        = newP;
      }
    }
  }

  // Фаза сброса — ждёт цели и продаёт по 20% за тик
  const avg = bot.avgP[coin] || 0;
  if (avg > 0 && (bot.held[coin] || 0) > 0) {
    const targetMult = bot.target[coin] || 1.30;
    if (prices[coin] >= avg * targetMult) {
      const amt      = (bot.held[coin] || 0) * 0.20;
      bot.usd       += amt * prices[coin] * (1 - FEE);
      bot.held[coin] = (bot.held[coin] || 0) - amt;
      if (bot.held[coin] < 0.0001) {
        bot.held[coin] = 0;
        bot.avgP[coin] = 0;
      }
      bot.target[coin] = 1.25 + Math.random() * 0.20;
      const newP       = await applyTP(coin, amt, 'sell');
      prices[coin]     = newP;
    }
  }
}

// ── Главный тик всех ботов ────────────────────────────────────────────────────
async function botTick(io, currentPrices) {
  if (!currentPrices || Object.keys(currentPrices).length === 0) return;
  const coins  = Object.keys(currentPrices);
  const prices = { ...currentPrices }; // рабочая копия — изменяется по мере сделок

  // Кешируем базовые цены для belowBase проверок
  const basePrices = {};
  for (const coin of coins) {
    const doc = await db.prices.findOne({ coin });
    if (doc) basePrices[coin] = doc.basePrice || doc.price;
  }

  for (const bot of BOTS) {
    try {
      if      (bot.type === 'bull') await bullTick(bot, coins, prices, basePrices);
      else if (bot.type === 'fox')  await foxTick (bot, coins, prices, basePrices);
      else if (bot.type === 'croc') await crocTick(bot, coins, prices, basePrices);
    } catch (_) { /* не прерываем тик из-за ошибки одного бота */ }
  }
}

// ── Статистика для лидерборда / админки ──────────────────────────────────────
const BOT_EMOJI = { bull: '🐂', fox: '🦊', croc: '🐊' };

function getBotStats(prices) {
  return BOTS.map(bot => ({
    username:  bot.name,
    isBot:     true,
    botType:   bot.type,
    botEmoji:  BOT_EMOJI[bot.type] || '🤖',
    usd:       Math.round(bot.usd * 100) / 100,
    total:     Math.round(botPortfolioValue(bot, prices || {}) * 100) / 100,
    held:      { ...bot.held },
  }));
}

module.exports = { botTick, updatePriceHistory, getBotStats };
