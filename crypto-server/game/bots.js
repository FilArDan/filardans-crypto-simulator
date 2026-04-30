/* ===== СЕРВЕРНЫЕ БОТЫ (порт из singleplayer/js/bots.js) ===== */

const { db } = require('../db');

const FEE = 0.001;
const BOT_EMOJI = { bull: '🐂', fox: '🦊', croc: '🐊' };
const HIST_LEN = 30;
const priceHistory = {};

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function sanitizeBot(bot) {
  return {
    name: String(bot.name || '').trim(),
    type: ['bull', 'fox', 'croc'].includes(bot.type) ? bot.type : 'fox',
    usd: Number(bot.usd) || 0,
    held: bot.held && typeof bot.held === 'object' ? bot.held : {},
    avgP: bot.avgP && typeof bot.avgP === 'object' ? bot.avgP : {},
    target: bot.target && typeof bot.target === 'object' ? bot.target : {},
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

async function bullTick(bot, coins, prices) {
  const coin = coins[Math.floor(Math.random() * coins.length)];
  const price = prices[coin];
  if (!price) return;
  const avgLong = getAvgPrice(coin, 20) || price;
  const roll = Math.random();

  if (price < avgLong * 0.98 && roll < 0.85) {
    const spend = bot.usd * (0.30 + Math.random() * 0.30);
    if (spend < 1) return;
    const amt = spend / price;
    const cost = amt * price * (1 + FEE);
    if (cost > bot.usd) return;
    const prevTotal = (bot.held[coin] || 0) * (bot.avgP[coin] || 0);
    bot.usd -= cost;
    bot.held[coin] = (bot.held[coin] || 0) + amt;
    bot.avgP[coin] = (prevTotal + amt * price) / bot.held[coin];
    prices[coin] = await applyTP(coin, amt, 'buy');
  } else if (price > avgLong * 1.03 && (bot.held[coin] || 0) > 0 && roll < 0.80) {
    const frac = 0.50 + Math.random() * 0.40;
    const amt = (bot.held[coin] || 0) * frac;
    bot.usd += amt * price * (1 - FEE);
    bot.held[coin] = (bot.held[coin] || 0) - amt;
    if (bot.held[coin] < 0.0001) bot.held[coin] = 0;
    prices[coin] = await applyTP(coin, amt, 'sell');
  }
}

async function foxTick(bot, coins, prices) {
  if (Math.random() > 0.40) return;
  const coin = coins[Math.floor(Math.random() * coins.length)];
  const price = prices[coin];
  if (!price) return;
  const avgLong = getAvgPrice(coin, 20) || price;
  const roll = Math.random();

  if (price < avgLong * 0.97 && roll < 0.60) {
    const spend = bot.usd * (0.02 + Math.random() * 0.06);
    if (spend < 1) return;
    const amt = spend / price;
    const cost = amt * price * (1 + FEE);
    if (cost > bot.usd) return;
    const prevTotal = (bot.held[coin] || 0) * (bot.avgP[coin] || 0);
    bot.usd -= cost;
    bot.held[coin] = (bot.held[coin] || 0) + amt;
    bot.avgP[coin] = (prevTotal + amt * price) / bot.held[coin];
    prices[coin] = await applyTP(coin, amt, 'buy');
  } else if (price > avgLong * 1.05 && (bot.held[coin] || 0) > 0 && roll < 0.50) {
    const frac = 0.10 + Math.random() * 0.20;
    const amt = (bot.held[coin] || 0) * frac;
    bot.usd += amt * price * (1 - FEE);
    bot.held[coin] = (bot.held[coin] || 0) - amt;
    if (bot.held[coin] < 0.0001) bot.held[coin] = 0;
    prices[coin] = await applyTP(coin, amt, 'sell');
  }
}

async function crocTick(bot, coins, prices) {
  const coin = coins[Math.floor(Math.random() * coins.length)];
  const price = prices[coin];
  if (!price) return;
  if (!bot.target) bot.target = {};
  if (!bot.target[coin]) bot.target[coin] = 1.25 + Math.random() * 0.20;

  if (Math.random() < 0.65) {
    const spend = bot.usd * (0.01 + Math.random() * 0.03);
    if (spend >= 1) {
      const amt = spend / price;
      const cost = amt * price * (1 + FEE);
      if (cost <= bot.usd) {
        const prevTotal = (bot.held[coin] || 0) * (bot.avgP[coin] || 0);
        bot.usd -= cost;
        bot.held[coin] = (bot.held[coin] || 0) + amt;
        bot.avgP[coin] = (prevTotal + amt * price) / bot.held[coin];
        prices[coin] = await applyTP(coin, amt, 'buy');
      }
    }
  }

  const avg = bot.avgP[coin] || 0;
  if (avg > 0 && (bot.held[coin] || 0) > 0) {
    const targetMult = bot.target[coin] || 1.30;
    if (prices[coin] >= avg * targetMult) {
      const amt = (bot.held[coin] || 0) * 0.20;
      bot.usd += amt * prices[coin] * (1 - FEE);
      bot.held[coin] = (bot.held[coin] || 0) - amt;
      if (bot.held[coin] < 0.0001) {
        bot.held[coin] = 0;
        bot.avgP[coin] = 0;
      }
      bot.target[coin] = 1.25 + Math.random() * 0.20;
      prices[coin] = await applyTP(coin, amt, 'sell');
    }
  }
}

async function listBotsRaw() {
  const bots = await db.bots.find({}).sort({ name: 1 });
  return bots.map(sanitizeBot);
}

async function replaceBotState(name, state) {
  await db.bots.update({ name }, { $set: sanitizeBot(state) });
}

async function botTick(io, currentPrices) {
  if (!currentPrices || Object.keys(currentPrices).length === 0) return;
  const coins = Object.keys(currentPrices);
  const prices = { ...currentPrices };
  const bots = await listBotsRaw();

  for (const bot of bots) {
    try {
      if (bot.type === 'bull') await bullTick(bot, coins, prices);
      else if (bot.type === 'fox') await foxTick(bot, coins, prices);
      else if (bot.type === 'croc') await crocTick(bot, coins, prices);
      await replaceBotState(bot.name, bot);
    } catch (_) {}
  }
}

async function getBotStats(prices) {
  const bots = await listBotsRaw();
  return bots.map(bot => ({
    username: bot.name,
    isBot: true,
    botType: bot.type,
    botEmoji: BOT_EMOJI[bot.type] || '🤖',
    usd: round2(bot.usd),
    total: round2(botPortfolioValue(bot, prices || {})),
    held: { ...(bot.held || {}) },
  }));
}

async function createBot({ name, type, usd }) {
  const cleanName = String(name || '').trim();
  if (!cleanName) throw new Error('Укажите имя бота');
  if (!['bull', 'fox', 'croc'].includes(type)) throw new Error('Неизвестный пресет');
  const exists = await db.bots.findOne({ name: cleanName });
  if (exists) throw new Error('Бот с таким именем уже существует');
  const bot = sanitizeBot({ name: cleanName, type, usd: Number(usd) || 0, held: {}, avgP: {}, target: {} });
  await db.bots.insert(bot);
  return bot;
}

async function deleteBot(name) {
  return db.bots.remove({ name: String(name || '').trim() }, {});
}

async function setBotCash(name, usd) {
  const cleanName = String(name || '').trim();
  await db.bots.update({ name: cleanName }, { $set: { usd: Number(usd) || 0 } });
  return db.bots.findOne({ name: cleanName });
}

async function updateBotPreset(name, type) {
  const cleanName = String(name || '').trim();
  if (!['bull', 'fox', 'croc'].includes(type)) throw new Error('Неизвестный пресет');
  await db.bots.update({ name: cleanName }, { $set: { type, target: {} } });
  return db.bots.findOne({ name: cleanName });
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
};