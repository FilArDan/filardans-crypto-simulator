const NeDB  = require('@seald-io/nedb');
const path  = require('path');
const bcrypt = require('bcryptjs');

const dbDir = path.join(__dirname, 'data');

const db = {
  users:        new NeDB({ filename: path.join(dbDir, 'users.db'),        autoload: true }),
  wallets:      new NeDB({ filename: path.join(dbDir, 'wallets.db'),      autoload: true }),
  loans:        new NeDB({ filename: path.join(dbDir, 'loans.db'),        autoload: true }),
  events:       new NeDB({ filename: path.join(dbDir, 'events.db'),       autoload: true }),
  prices:       new NeDB({ filename: path.join(dbDir, 'prices.db'),       autoload: true }),
  customCoins:  new NeDB({ filename: path.join(dbDir, 'customCoins.db'),  autoload: true }),
  bots:         new NeDB({ filename: path.join(dbDir, 'bots.db'),         autoload: true }),
  priceHistory: new NeDB({ filename: path.join(dbDir, 'priceHistory.db'), autoload: true }),
  orders:       new NeDB({ filename: path.join(dbDir, 'orders.db'),       autoload: true }),
  companies:    new NeDB({ filename: path.join(dbDir, 'companies.db'),    autoload: true }),
  currencies:   new NeDB({ filename: path.join(dbDir, 'currencies.db'),   autoload: true }),
  unions:       new NeDB({ filename: path.join(dbDir, 'unions.db'),       autoload: true }),
  tradeRestrictions: new NeDB({ filename: path.join(dbDir, 'tradeRestrictions.db'), autoload: true }),
};

// Индекс для быстрой фильтрации по монете
db.priceHistory.ensureIndex({ fieldName: 'coin' });

// Индексы стакана лимитных ордеров
db.orders.ensureIndex({ fieldName: 'username' });
db.orders.ensureIndex({ fieldName: 'coin' });
db.orders.ensureIndex({ fieldName: 'status' });

// Индекс компаний (акции — государственные и союзные активы)
db.companies.ensureIndex({ fieldName: 'ticker', unique: true });

// Индекс локальных валют (курс отображения на игрока/государство)
db.currencies.ensureIndex({ fieldName: 'nation', unique: true });

// Индексы союзов и точечных торговых запретов
db.unions.ensureIndex({ fieldName: 'code', unique: true });
db.tradeRestrictions.ensureIndex({ fieldName: 'username' });
db.tradeRestrictions.ensureIndex({ fieldName: 'ticker' });

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
];

const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'];

const COIN_META = {
  BTC:  { name: 'Bitcoin',  basePrice: 45000, vol: 0.030, drift: 0, supply: 21000000     },
  ETH:  { name: 'Ethereum', basePrice: 2800,  vol: 0.045, drift: 0, supply: 120000000    },
  SOL:  { name: 'Solana',   basePrice: 120,   vol: 0.070, drift: 0, supply: 440000000    },
  XRP:  { name: 'XRP',      basePrice: 0.52,  vol: 0.050, drift: 0, supply: 45000000000  },
  DOGE: { name: 'Dogecoin', basePrice: 0.08,  vol: 0.060, drift: 0, supply: 140000000000 },
};

const EXCHANGE_RESERVE     = 1_200_000;
// Начальный запас монет биржи: игроки смогут купить не более этого количества
const EXCHANGE_COIN_SUPPLY = {
  BTC:  500,
  ETH:  5000,
  SOL:  50000,
  XRP:  10000000,
  DOGE: 50000000,
};
const EXCHANGE_CUSTOM_COIN_SUPPLY = 1_000_000; // запас для кастомных монет по умолчанию

const EXCHANGE_USERNAME = 'EXCHANGE';

async function getAllCoins() {
  const docs = await db.prices.find({});
  return docs.map(d => d.coin);
}

async function initDb() {
  const existingUserCount = await db.users.count({});

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

  const botCount = await db.bots.count({});
  if (botCount === 0) {
    for (const bot of DEFAULT_BOTS) {
      await db.bots.insert({ ...bot });
    }
  }

  // Инициализация кошелька биржи с запасами монет
  const exchangeWallet = await db.wallets.findOne({ username: EXCHANGE_USERNAME });
  if (!exchangeWallet) {
    const exchDoc = { username: EXCHANGE_USERNAME, usd: EXCHANGE_RESERVE };
    for (const coin of COINS) {
      exchDoc[coin] = EXCHANGE_COIN_SUPPLY[coin] || EXCHANGE_CUSTOM_COIN_SUPPLY;
    }
    await db.wallets.insert(exchDoc);
  } else {
    // Добавляем поля монет если их нет (миграция)
    const patch = {};
    for (const coin of COINS) {
      if (exchangeWallet[coin] == null) {
        patch[coin] = EXCHANGE_COIN_SUPPLY[coin] || EXCHANGE_CUSTOM_COIN_SUPPLY;
      }
    }
    if (Object.keys(patch).length > 0) {
      await db.wallets.update({ username: EXCHANGE_USERNAME }, { $set: patch });
    }
  }

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

  if (existingUserCount > 0) {
    console.log(`📦 База данных найдена (${dbDir}): загружено пользователей — ${existingUserCount}. Прогресс сохранён.`);
  } else {
    console.log(`🆕 База данных не найдена (${dbDir}) — создаю аккаунты и монеты по умолчанию с нуля.`);
  }
}

module.exports = { db, initDb, COINS, COIN_META, getAllCoins, EXCHANGE_USERNAME, EXCHANGE_CUSTOM_COIN_SUPPLY };
