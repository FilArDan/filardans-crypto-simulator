const NeDB = require('@seald-io/nedb');
const path = require('path');
const bcrypt = require('bcryptjs');

const dbDir = path.join(__dirname, 'data');

const db = {
  users:   new NeDB({ filename: path.join(dbDir, 'users.db'),   autoload: true }),
  wallets: new NeDB({ filename: path.join(dbDir, 'wallets.db'), autoload: true }),
  loans:   new NeDB({ filename: path.join(dbDir, 'loans.db'),   autoload: true }),
  events:  new NeDB({ filename: path.join(dbDir, 'events.db'),  autoload: true }),
  prices:  new NeDB({ filename: path.join(dbDir, 'prices.db'),  autoload: true }),
};

const INITIAL_USERS = [
  { username: 'WARDEN',    password: 'sherpaIsGay', role: 'admin',  startUsd: 0     },
  { username: 'Артур',     password: 'alpha101',    role: 'player', startUsd: 10000 },
  { username: 'Даня',      password: 'beta202',     role: 'player', startUsd: 12000 },
  { username: 'Злодей',    password: 'gamma303',    role: 'player', startUsd: 8000  },
  { username: 'Игорь',     password: 'delta404',    role: 'player', startUsd: 15000 },
  { username: 'Лукашенко', password: 'delta404',    role: 'player', startUsd: 15000 },
  { username: 'Миха',      password: 'delta404',    role: 'player', startUsd: 15000 },
  { username: 'Серега',    password: 'delta404',    role: 'player', startUsd: 15000 },
  { username: 'Юра',       password: 'delta404',    role: 'player', startUsd: 15000 },
];

const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'];

// Метаданные монет: якорная цена, волатильность, тренд, оборот
const COIN_META = {
  BTC:  { basePrice: 45000, vol: 0.030, drift: 0, supply: 21000000        },
  ETH:  { basePrice: 2800,  vol: 0.045, drift: 0, supply: 120000000       },
  SOL:  { basePrice: 120,   vol: 0.070, drift: 0, supply: 440000000       },
  XRP:  { basePrice: 0.52,  vol: 0.050, drift: 0, supply: 45000000000     },
  DOGE: { basePrice: 0.08,  vol: 0.060, drift: 0, supply: 140000000000    },
};

const INITIAL_PRICES = { BTC: 45000, ETH: 2800, SOL: 120, XRP: 0.52, DOGE: 0.08 };

async function initDb() {
  const fs = require('fs');
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

  for (const u of INITIAL_USERS) {
    const exists = await db.users.findOne({ username: u.username });
    if (!exists) {
      const hash = bcrypt.hashSync(u.password, 10);
      await db.users.insert({ username: u.username, passwordHash: hash, role: u.role });
      await db.wallets.insert({
        username: u.username, usd: u.startUsd,
        BTC: 0, ETH: 0, SOL: 0, XRP: 0, DOGE: 0
      });
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
      // Дополнить старые записи без метаданных
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

module.exports = { db, initDb, COINS, COIN_META };
