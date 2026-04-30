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
  { name: '\u0410\u0433\u0440\u0435\u0441\u0441\u043e\u0440-1', type: 'bull', usd: 15000, held: {}, avgP: {}, target: {} },
  { name: '\u0410\u0433\u0440\u0435\u0441\u0441\u043e\u0440-2', type: 'bull', usd: 18000, held: {}, avgP: {}, target: {} },
  { name: '\u041b\u0438\u0441-1',      type: 'fox',  usd: 10000, held: {}, avgP: {}, target: {} },
  { name: '\u041b\u0438\u0441-2',      type: 'fox',  usd: 10000, held: {}, avgP: {}, target: {} },
  { name: '\u041b\u0438\u0441-3',      type: 'fox',  usd: 12000, held: {}, avgP: {}, target: {} },
  { name: '\u041a\u0440\u043e\u043a-1',     type: 'croc', usd: 20000, held: {}, avgP: {}, target: {} },
  { name: '\u041a\u0440\u043e\u043a-2',     type: 'croc', usd: 20000, held: {}, avgP: {}, target: {} },
  { name: '\u041b\u0438\u0441-4',      type: 'fox',  usd:  9000, held: {}, avgP: {}, target: {} },
  { name: '\u041b\u0438\u0441-5',      type: 'fox',  usd: 11000, held: {}, avgP: {}, target: {} },
  { name: '\u041b\u0438\u0441-6',      type: 'fox',  usd: 10000, held: {}, avgP: {}, target: {} },
];

const INITIAL_USERS = [
  { username: 'WARDEN',      password: 'sherpaIsGay', role: 'admin',  startUsd: 0     },
  { username: '\u0410\u0440\u0442\u0443\u0440',       password: 'alpha101',    role: 'player', startUsd: 10000 },
  { username: '\u0414\u0430\u043d\u044f',        password: 'beta202',     role: 'player', startUsd: 12000 },
  { username: '\u0417\u043b\u043e\u0434\u0435\u0439',      password: 'gamma303',    role: 'player', startUsd: 8000  },
  { username: '\u0418\u0433\u043e\u0440\u044c',       password: 'delta404',    role: 'player', startUsd: 15000 },
  { username: '\u041b\u0443\u043a\u0430\u0448\u0435\u043d\u043a\u043e',   password: 'delta404',    role: 'player', startUsd: 15000 },
  { username: '\u041c\u0438\u0445\u0430',        password: 'delta404',    role: 'player', startUsd: 15000 },
  { username: '\u0421\u0435\u0440\u0435\u0433\u0430',      password: 'delta404',    role: 'player', startUsd: 15000 },
  { username: '\u042e\u0440\u0430',         password: 'delta404',    role: 'player', startUsd: 15000 },
];

// \u0411\u0430\u0437\u043e\u0432\u044b\u0435 (\u043d\u0435\u0441\u044a\u0451\u043c\u043d\u044b\u0435) \u043c\u043e\u043d\u0435\u0442\u044b
const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'];

const COIN_META = {
  BTC:  { basePrice: 45000, vol: 0.030, drift: 0, supply: 21000000        },
  ETH:  { basePrice: 2800,  vol: 0.045, drift: 0, supply: 120000000       },
  SOL:  { basePrice: 120,   vol: 0.070, drift: 0, supply: 440000000       },
  XRP:  { basePrice: 0.52,  vol: 0.050, drift: 0, supply: 45000000000     },
  DOGE: { basePrice: 0.08,  vol: 0.060, drift: 0, supply: 140000000000    },
};

const INITIAL_PRICES = Object.fromEntries(
  Object.entries(COIN_META).map(([coin, meta]) => [coin, meta.basePrice])
);

async function getAllCoins() {
  const base   = [...COINS];
  const custom = await db.customCoins.find({});
  return [...base, ...custom.map(c => c.ticker)];
}

async function initDb() {
  for (const u of INITIAL_USERS) {
    const exists = await db.users.findOne({ username: u.username });
    if (!exists) {
      const hash = bcrypt.hashSync(u.password, 10);
      await db.users.insert({ username: u.username, passwordHash: hash, role: u.role });
      if (u.role === 'player') {
        await db.wallets.insert({
          username: u.username,
          usd: u.startUsd,
          holdings: {}
        });
      }
    }
  }

  // Seed \u0431\u043e\u0442\u043e\u0432 (\u0442\u043e\u043b\u044c\u043a\u043e \u0435\u0441\u043b\u0438 \u0431\u0430\u0437\u0430 \u043f\u0443\u0441\u0442\u0430\u044f)
  const botCount = await db.bots.count({});
  if (botCount === 0) {
    for (const bot of DEFAULT_BOTS) {
      await db.bots.insert({ ...bot });
    }
  }

  for (const coin of COINS) {
    const exists = await db.prices.findOne({ coin });
    if (!exists) {
      const meta = COIN_META[coin];
      await db.prices.insert({
        coin,
        price:     INITIAL_PRICES[coin],
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
}

module.exports = { db, initDb, COINS, COIN_META, getAllCoins };
