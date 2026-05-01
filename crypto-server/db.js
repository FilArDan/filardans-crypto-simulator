const NeDB  = require('@seald-io/nedb');
const path  = require('path');
const bcrypt = require('bcryptjs');

const dbDir = path.join(__dirname, 'data');

const db = {
  users:       new NeDB({ filename: path.join(dbDir, 'users.db'),       autoload: true }),
  wallets:     new NeDB({ filename: path.join(dbDir, 'wallets.db'),     autoload: true }),
  loans:       new NeDB({ filename: path.join(dbDir, 'loans.db'),       autoload: true }),
  events:      new NeDB({ filename: path.join(dbDir, 'events.db'),      autoload: true }),
  prices:      new NeDB({ filename: path.join(dbDir, 'prices.db'),      autoload: true }),
  customCoins: new NeDB({ filename: path.join(dbDir, 'customCoins.db'), autoload: true }),
  bots:        new NeDB({ filename: path.join(dbDir, 'bots.db'),        autoload: true }),
};

const DEFAULT_BOTS = [
  { name: 'Агрессор-1', type: 'bull', usd: 15000, held: {}, avgP: {}, target: {} },
  { name: 'Агрессор-2', type: 'bull', usd: 18000, held: {}, avgP: {}, target: {} },
  { name: 'Лис-1',      type: 'fox',  usd: 10000, held: {}, avgP: {}, target: {} },
  { name: 'Лис-2',      type: 'fox',  usd: 10000, held: {}, avgP: {}, target: {} },
  { name: 'Лис-3',      type: 'fox',  usd: 12000, held: {}, avgP: {}, target: {} },
  { name: 'Крок-1',     type: 'croc', usd: 20000, held: {}, avgP: {}, target: {} },
  { name: 'Крок-2',     type: 'croc', usd: 20000, held: {}, avgP: {}, target: {} },
  { name: 'Лис-4',      type: 'fox',  usd:  9000, held: {}, avgP: {}, target: {} },
  { name: 'Лис-5',      type: 'fox',  usd: 11000, held: {}, avgP: {}, target: {} },
  { name: 'Лис-6',      type: 'fox',  usd: 10000, held: {}, avgP: {}, target: {} },
];

const INITIAL_USERS = [
  { username: 'WARDEN',    password: 'sherpa', role: 'admin',  startUsd: 0     },
  { username: 'Артур',     password: '1m1',    role: 'player', startUsd: 10000 },
  { username: 'Даня',      password: '2m2',     role: 'player', startUsd: 12000 },
  { username: 'Злодей',    password: '3m3',    role: 'player', startUsd: 8000  },
  { username: 'Игорь',     password: '4m4',    role: 'player', startUsd: 15000 },
  { username: 'Лукашенко', password: '5m5',    role: 'player', startUsd: 15000 },
  { username: 'Миха',      password: '6m6',    role: 'player', startUsd: 15000 },
  { username: 'Серега',    password: '7m7',    role: 'player', startUsd: 15000 },
  { username: 'Юра',       password: '8m8',    role: 'player', startUsd: 15000 },
];

// Базовые монеты — список тикеров для инициализации и восстановления
const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'];

// Полные метаданные базовых монет (используются при создании/пересоздании)
const COIN_META = {
  BTC:  { name: 'Bitcoin',  emoji: '₿',  basePrice: 45000, vol: 0.030, drift: 0, supply: 21000000     },
  ETH:  { name: 'Ethereum', emoji: 'Ξ',  basePrice: 2800,  vol: 0.045, drift: 0, supply: 120000000    },
  SOL:  { name: 'Solana',   emoji: '◎',  basePrice: 120,   vol: 0.070, drift: 0, supply: 440000000    },
  XRP:  { name: 'XRP',      emoji: '✕',  basePrice: 0.52,  vol: 0.050, drift: 0, supply: 45000000000  },
  DOGE: { name: 'Dogecoin', emoji: '🐕', basePrice: 0.08,  vol: 0.060, drift: 0, supply: 140000000000 },
};

// Возвращает все монеты, активные в данный момент (те что есть в prices)
async function getAllCoins() {
  const docs = await db.prices.find({});
  return docs.map(d => d.coin);
}

async function initDb() {
  for (const u of INITIAL_USERS) {
    const exists = await db.users.findOne({ username: u.username });
    if (!exists) {
      const hash = bcrypt.hashSync(u.password, 10);
      await db.users.insert({ username: u.username, passwordHash: hash, role: u.role });
      if (u.role === 'player') {
        const walletDoc = { username: u.username, usd: u.startUsd };
        for (const coin of COINS) walletDoc[coin] = 0;
        await db.wallets.insert(walletDoc);
      }
    }
  }

  // Seed ботов (только если база пустая)
  const botCount = await db.bots.count({});
  if (botCount === 0) {
    for (const bot of DEFAULT_BOTS) {
      await db.bots.insert({ ...bot });
    }
  }

  // Инициализация базовых монет (только если ещё не существуют)
  for (const coin of COINS) {
    const exists = await db.prices.findOne({ coin });
    if (!exists) {
      const meta = COIN_META[coin];
      await db.prices.insert({
        coin,
        price:     meta.basePrice,
        basePrice: meta.basePrice,
        vol:       meta.vol,
        drift:     meta.drift,
        supply:    meta.supply,
      });
    } else {
      // Добавить недостающие поля если нужно
      const meta = COIN_META[coin];
      const patch = {};
      if (exists.basePrice == null) patch.basePrice = meta.basePrice;
      if (exists.vol       == null) patch.vol       = meta.vol;
      if (exists.drift     == null) patch.drift     = meta.drift;
      if (exists.supply    == null) patch.supply    = meta.supply;
      if (Object.keys(patch).length > 0) {
        await db.prices.update({ coin }, { $set: patch });
      }
    }
  }
}

module.exports = { db, initDb, COINS, COIN_META, getAllCoins };
