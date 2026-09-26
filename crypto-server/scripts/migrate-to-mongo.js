/* ===== ОДНОРАЗОВАЯ МИГРАЦИЯ NeDB → MongoDB =====
 *
 * Запускать ОДИН РАЗ на той машине, где лежат реальные файлы crypto-server/data/*.db
 * (то есть на проде), после того как там же поднят MongoDB и указан MONGODB_URI в .env.
 *
 *   node scripts/migrate-to-mongo.js            — перенести всё (пропускает
 *                                                   коллекции, которые в Mongo уже не пустые)
 *   node scripts/migrate-to-mongo.js --force     — перезаписать даже непустые
 *                                                   коллекции в Mongo (удаляет их перед переносом)
 *
 * Формат .db-файлов NeDB — обычный текст, по одному JSON-документу на строку,
 * плюс изредка служебные строки вида {"$$indexCreated":{...}} — их пропускаем.
 * Библиотека @seald-io/nedb для самого чтения не нужна, достаточно fs+JSON.parse.
 *
 * db.sessions.db (файловый стор сессий) намеренно НЕ переносится — сессии
 * эфемерны (маxAge 8ч), новый MongoStore заведёт их сам при следующем логине.
 */
require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');

const FORCE   = process.argv.includes('--force');
const DATA_DIR = path.join(__dirname, '..', 'data');

const MONGODB_URI     = process.env.MONGODB_URI;
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || 'mothership_crypto';

if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI не задан в .env — некуда переносить данные.');
  process.exit(1);
}

// Файл → имя коллекции (совпадает с ключами db в db.js)
const COLLECTIONS = [
  ['users.db',              'users'],
  ['wallets.db',            'wallets'],
  ['loans.db',              'loans'],
  ['events.db',             'events'],
  ['prices.db',             'prices'],
  ['customCoins.db',        'customCoins'],
  ['bots.db',               'bots'],
  ['priceHistory.db',       'priceHistory'],
  ['orders.db',             'orders'],
  ['companies.db',          'companies'],
  ['currencies.db',         'currencies'],
  ['unions.db',             'unions'],
  ['tradeRestrictions.db',  'tradeRestrictions'],
];

function readNedbFile(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  // .db-файл NeDB — это append-only лог операций, а не снимок текущего
  // состояния: insert/update дописывают строку с полным документом под
  // тем же _id (более новая строка — это более новая версия), а remove
  // дописывает строку-тумбстоун {"_id":"...", "$$deleted": true}. При
  // старте сама NeDB "проигрывает" файл по порядку и для каждого _id
  // оставляет только последнее состояние — повторяем эту же логику, иначе
  // в базу попадут все исторические версии документа как отдельные записи.
  const byId = new Map();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let doc;
    try {
      doc = JSON.parse(trimmed);
    } catch (e) {
      console.warn(`  ⚠️  Не удалось разобрать строку в ${path.basename(filePath)}, пропускаю:`, e.message);
      continue;
    }
    if (doc.$$indexCreated) continue; // служебная строка NeDB — не документ
    if (doc.$$deleted) {
      byId.delete(doc._id);
      continue;
    }
    byId.set(doc._id, doc); // более поздняя строка с тем же _id перезаписывает более раннюю
  }
  return Array.from(byId.values());
}

async function main() {
  console.log(`Подключаюсь к ${MONGODB_URI} (база: ${MONGODB_DB_NAME})...`);
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db(MONGODB_DB_NAME);

  let totalMigrated = 0;
  let totalSkipped   = 0;

  for (const [file, collName] of COLLECTIONS) {
    const filePath = path.join(DATA_DIR, file);
    const docs = readNedbFile(filePath);
    const coll = db.collection(collName);

    if (!docs.length) {
      console.log(`— ${collName}: файл пуст или не найден, пропускаю`);
      continue;
    }

    const existing = await coll.countDocuments({});
    if (existing > 0 && !FORCE) {
      console.log(`— ${collName}: в Mongo уже ${existing} записей, пропускаю (запусти с --force для перезаписи)`);
      totalSkipped += docs.length;
      continue;
    }
    if (existing > 0 && FORCE) {
      await coll.deleteMany({});
      console.log(`  (--force: удалил ${existing} существующих записей из ${collName})`);
    }

    // _id из NeDB — обычные строки, вставляем как есть, без преобразования в ObjectId.
    await coll.insertMany(docs, { ordered: false });
    console.log(`✅ ${collName}: перенесено ${docs.length} записей (из ${file})`);
    totalMigrated += docs.length;
  }

  console.log(`\nГотово. Перенесено: ${totalMigrated}, пропущено: ${totalSkipped}.`);
  console.log('Сессии (data/sessions.db) намеренно не переносились — они эфемерны, игроки перелогинятся.');

  await client.close();
}

main().catch(err => {
  console.error('❌ Ошибка миграции:', err);
  process.exit(1);
});
