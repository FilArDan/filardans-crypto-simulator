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
  { username: 'trader01', password: 'alpha101', role: 'player', startUsd: 10000 },
  { username: 'trader02', password: 'beta202',  role: 'player', startUsd: 12000 },
  { username: 'trader03', password: 'gamma303', role: 'player', startUsd: 8000  },
  { username: 'trader04', password: 'delta404', role: 'player', startUsd: 15000 },
  { username: 'admin',    password: 'admin2025', role: 'admin', startUsd: 0     },
];

const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'];
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
    if (!exists) await db.prices.insert({ coin, price: INITIAL_PRICES[coin] });
  }
}

module.exports = { db, initDb, COINS };