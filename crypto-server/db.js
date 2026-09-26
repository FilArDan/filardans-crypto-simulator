const { MongoClient } = require('mongodb');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const MONGODB_URI     = process.env.MONGODB_URI;
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || 'mothership_crypto';

if (!MONGODB_URI) {
  throw new Error(
    'MONGODB_URI не задан. Укажи строку подключения к MongoDB в .env, например:\n' +
    'MONGODB_URI=mongodb://localhost:27017'
  );
}

function genId() {
  // Непрозрачная строка, а не ObjectId — совместимо по типу с _id старых
  // документов, перенесённых из NeDB (там _id тоже строка), так что в одной
  // коллекции после переноса не окажется двух разных типов _id.
  return crypto.randomBytes(9).toString('base64url');
}

// ── Тонкая обёртка над коллекцией MongoDB, повторяющая API @seald-io/nedb
// (find/findOne/insert/update/remove/count/ensureIndex), которым пользуется
// весь остальной код проекта — так миграция не потребовала переписывать
// каждый вызов к базе в game/*.js и routes/*.js.
class Collection {
  constructor(raw) {
    this.raw = raw;
  }

  // NeDB: await db.x.find(q) либо await db.x.find(q).sort(...).limit(n) —
  // нужен объект, который одновременно и chainable, и awaitable (thenable).
  find(query = {}) {
    const cursor = this.raw.find(query);
    const chain = {
      sort:  (spec) => { cursor.sort(spec); return chain; },
      limit: (n)    => { cursor.limit(n);  return chain; },
      then:    (resolve, reject) => cursor.toArray().then(resolve, reject),
      catch:   (reject)          => cursor.toArray().catch(reject),
      finally: (fn)              => cursor.toArray().finally(fn),
    };
    return chain;
  }

  findOne(query = {}) {
    return this.raw.findOne(query);
  }

  async insert(doc) {
    if (Array.isArray(doc)) {
      if (!doc.length) return [];
      const docs = doc.map(d => (d._id ? d : { _id: genId(), ...d }));
      await this.raw.insertMany(docs);
      return docs;
    }
    const withId = doc._id ? doc : { _id: genId(), ...doc };
    await this.raw.insertOne(withId);
    return withId;
  }

  insertAsync(doc) {
    return this.insert(doc);
  }

  async update(query, update, options = {}) {
    const hasOperators = update && Object.keys(update).some(k => k.startsWith('$'));
    if (!hasOperators) {
      // Замена документа целиком (не $set/$inc) — как в NeDB. Используется,
      // например, стором сессий: полная перезапись документа по _id.
      await this.raw.replaceOne(query, update, { upsert: !!options.upsert });
      return;
    }
    if (options.multi) {
      await this.raw.updateMany(query, update, { upsert: !!options.upsert });
    } else {
      await this.raw.updateOne(query, update, { upsert: !!options.upsert });
    }
  }

  async remove(query, options = {}) {
    if (options.multi) return this.raw.deleteMany(query);
    return this.raw.deleteOne(query);
  }

  count(query = {}) {
    return this.raw.countDocuments(query);
  }

  countAsync(query = {}) {
    return this.count(query);
  }

  async ensureIndex({ fieldName, unique }) {
    await this.raw.createIndex({ [fieldName]: 1 }, { unique: !!unique });
  }
}

// Заполняется в initDb() после подключения — до этого момента запросы к db.*
// делать нельзя (то же ограничение, что и раньше: initDb() всегда ждали
// перед httpServer.listen() в server.js).
const db = {};
let mongoClient = null;

const COLLECTION_NAMES = [
  'users', 'wallets', 'loans', 'events', 'prices', 'customCoins', 'bots',
  'priceHistory', 'orders', 'companies', 'currencies', 'unions', 'tradeRestrictions',
];

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

// Дефолты спреда/ликвидности для активов, у которых ГМ не задал своих
// значений (в т.ч. все существующие монеты до этой фичи) — совпадают со
// старыми глобальными константами, так что ничего не меняется, пока ГМ
// сам не тронет ползунки конкретного актива.
const DEFAULT_SPREAD    = 0.0015; // ±0.15%
const DEFAULT_LIQUIDITY = 1;      // множитель глубины рынка (больше = меньше проскальзывание от объёма)

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
  mongoClient = new MongoClient(MONGODB_URI);
  await mongoClient.connect();
  const mongoDb = mongoClient.db(MONGODB_DB_NAME);

  for (const name of COLLECTION_NAMES) {
    db[name] = new Collection(mongoDb.collection(name));
  }

  // Индекс для быстрой фильтрации по монете
  await db.priceHistory.ensureIndex({ fieldName: 'coin' });

  // Индексы стакана лимитных ордеров
  await db.orders.ensureIndex({ fieldName: 'username' });
  await db.orders.ensureIndex({ fieldName: 'coin' });
  await db.orders.ensureIndex({ fieldName: 'status' });

  // Индекс компаний (акции — государственные и союзные активы)
  await db.companies.ensureIndex({ fieldName: 'ticker', unique: true });

  // Индекс локальных валют (курс отображения на игрока/государство)
  await db.currencies.ensureIndex({ fieldName: 'nation', unique: true });

  // Индексы союзов и точечных торговых запретов
  await db.unions.ensureIndex({ fieldName: 'code', unique: true });
  await db.tradeRestrictions.ensureIndex({ fieldName: 'username' });
  await db.tradeRestrictions.ensureIndex({ fieldName: 'ticker' });

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
    console.log(`📦 База данных найдена (MongoDB, ${MONGODB_DB_NAME}): загружено пользователей — ${existingUserCount}. Прогресс сохранён.`);
  } else {
    console.log(`🆕 База данных не найдена (MongoDB, ${MONGODB_DB_NAME}) — создаю аккаунты и монеты по умолчанию с нуля.`);
  }
}

async function closeDb() {
  if (mongoClient) await mongoClient.close();
}

module.exports = {
  db, initDb, closeDb, COINS, COIN_META, getAllCoins,
  EXCHANGE_USERNAME, EXCHANGE_CUSTOM_COIN_SUPPLY, DEFAULT_SPREAD, DEFAULT_LIQUIDITY,
  MONGODB_URI, MONGODB_DB_NAME,
};
