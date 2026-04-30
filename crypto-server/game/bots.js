/* ===== \u0421\u0415\u0420\u0412\u0415\u0420\u041d\u042b\u0415 \u0411\u041e\u0422\u042b (\u043f\u043e\u0440\u0442 \u0438\u0437 singleplayer/js/bots.js) ===== */

const { db } = require('../db');

const FEE = 0.001;
const BOT_EMOJI = { bull: '\uD83D\uDC02', fox: '\uD83E\uDD8A', croc: '\uD83D\uDC0A' };
const HIST_LEN = 30;
const priceHistory = {};

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

// \u2500\u2500 \uD83D\uDC02 \u0410\u0433\u0440\u0435\u0441\u0441\u043e\u0440 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
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
    bot.held[coin] -= amt;
    if (bot.held[coin] < 0.0001) bot.held[coin] = 0;
    prices[coin] = await applyTP(coin, amt, 'sell');
  }
}

// \u2500\u2500 \uD83E\uDD8A \u041e\u0441\u0442\u043e\u0440\u043e\u0436\u043d\u044b\u0439 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
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
    bot.held[coin] -= amt;
    if (bot.held[coin] < 0.0001) bot.held[coin] = 0;
    prices[coin] = await applyTP(coin, amt, 'sell');
  }
}

// \u2500\u2500 \uD83D\uDC0A \u041d\u0430\u043a\u043e\u043f\u0438\u0442\u0435\u043b\u044c \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
async function crocTick(bot, coins, prices) {
  const coin = coins[Math.floor(Math.random() * coins.length)];
  const price = prices[coin];
  if (!price) return;
  if (!bot.target)        bot.target        = {};
  if (!bot.target[coin])  bot.target[coin]  = 1.25 + Math.random() * 0.20;

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
      bot.held[coin] -= amt;
      if (bot.held[coin] < 0.0001) { bot.held[coin] = 0; bot.avgP[coin] = 0; }
      bot.target[coin] = 1.25 + Math.random() * 0.20;
      prices[coin] = await applyTP(coin, amt, 'sell');
    }
  }
}

// \u2500\u2500 DB helpers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nfunction listBotsRaw() {
  return db.bots.find({});
}

async function replaceBotState(name, state) {
  const clean = sanitizeBot(state);
  await db.bots.update({ name }, { $set: { usd: clean.usd, held: clean.held, avgP: clean.avgP, target: clean.target } });
}

// \u2500\u2500 \u0413\u043b\u0430\u0432\u043d\u044b\u0439 \u0442\u0438\u043a \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
async function botTick(io, currentPrices) {
  if (!currentPrices || Object.keys(currentPrices).length === 0) return;
  const coins = Object.keys(currentPrices);
  const prices = { ...currentPrices };
  const bots = await listBotsRaw();

  for (const bot of bots) {
    const b = sanitizeBot(bot);
    try {
      if      (b.type === 'bull') await bullTick(b, coins, prices);
      else if (b.type === 'fox')  await foxTick (b, coins, prices);
      else if (b.type === 'croc') await crocTick(b, coins, prices);
      await replaceBotState(b.name, b);
    } catch (_) {}
  }
}

// \u2500\u2500 \u0421\u0442\u0430\u0442\u0438\u0441\u0442\u0438\u043a\u0430 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
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

// \u2500\u2500 CRUD (\u0434\u043b\u044f \u0430\u0434\u043c\u0438\u043d\u043a\u0438) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
async function createBot({ name, type, usd }) {
  const cleanName = String(name || '').trim();
  if (!cleanName) throw new Error('\u0423\u043a\u0430\u0436\u0438\u0442\u0435 \u0438\u043c\u044f \u0431\u043e\u0442\u0430');
  if (!['bull','fox','croc'].includes(type)) throw new Error('\u041d\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043d\u044b\u0439 \u043f\u0440\u0435\u0441\u0435\u0442');
  const exists = await db.bots.findOne({ name: cleanName });
  if (exists) throw new Error('\u0411\u043e\u0442 \u0441 \u0442\u0430\u043a\u0438\u043c \u0438\u043c\u0435\u043d\u0435\u043c \u0443\u0436\u0435 \u0441\u0443\u0449\u0435\u0441\u0442\u0432\u0443\u0435\u0442');
  const bot = sanitizeBot({ name: cleanName, type, usd: Number(usd) || 0, held: {}, avgP: {}, target: {} });
  await db.bots.insert(bot);
  return bot;
}

async function deleteBot(name) {
  return db.bots.remove({ name: String(name || '').trim() }, {});
}

async function setBotCash(name, usd) {
  const n = String(name || '').trim();
  await db.bots.update({ name: n }, { $set: { usd: Number(usd) || 0 } });
  return db.bots.findOne({ name: n });
}

async function updateBotPreset(name, type) {
  const n = String(name || '').trim();
  if (!['bull','fox','croc'].includes(type)) throw new Error('\u041d\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043d\u044b\u0439 \u043f\u0440\u0435\u0441\u0435\u0442');
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
};
