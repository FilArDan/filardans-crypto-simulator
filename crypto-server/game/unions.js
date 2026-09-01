/* ===== СОЮЗЫ, СОЮЗНЫЕ ТОКЕНЫ И КОНТРОЛЬ ДОСТУПА =====
 *
 * Союзный токен — обычный тикер в db.prices (та же модель, что у монет и
 * компаний), поэтому торгуется через существующий /api/trade и лимитные
 * ордера. Отличия от обычной монеты — две вещи:
 *   1) кто может её торговать (canTrade) — только участники союза;
 *   2) кто выступает маркет-мейкером (resolveReserveAccount) — резерв
 *      союза (UNION_<code>, обычный кошелёк в db.wallets), а не общий EXCHANGE.
 * То же самое resolveReserveAccount/canTrade применяется к компании,
 * вынесенной на союзную биржу — тикер тот же, просто шире круг допущенных
 * и другой маркет-мейкер.
 */
const { db, getAllCoins, EXCHANGE_USERNAME, EXCHANGE_CUSTOM_COIN_SUPPLY } = require('../db');

function reserveUsernameFor(code) { return `UNION_${code}`; }

// ── Создание союза ────────────────────────────────────────────────────────────
async function createUnion({ code, name, members, tokenName, tokenSymbol, tokenSupply, tokenStartPrice, tokenVol, reserveUsd }) {
  const cleanCode = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
  if (!cleanCode) throw new Error('Укажи код союза (1–12 букв/цифр)');
  const exists = await db.unions.findOne({ code: cleanCode });
  if (exists) throw new Error(`Союз с кодом ${cleanCode} уже существует`);

  const cleanName = String(name || '').trim() || cleanCode;
  const memberList = Array.isArray(members) ? members : [];
  if (!memberList.length) throw new Error('Укажи хотя бы одно государство-участника');
  for (const m of memberList) {
    const user = await db.users.findOne({ username: m });
    if (!user) throw new Error(`Государство ${m} не найдено`);
  }

  const tokenTicker = `${cleanCode}_UT`; // NeDB не допускает точки в именах полей документа
  const allCoins = await getAllCoins();
  if (allCoins.includes(tokenTicker)) throw new Error(`Тикер ${tokenTicker} уже занят`);

  const supply = Math.max(1, Math.floor(Number(tokenSupply)) || 100000);
  const price  = Math.max(0.0001, Number(tokenStartPrice) || 1);
  const volume = Math.max(0.005, Math.min(0.30, Number(tokenVol) || 0.03));
  const reserve = Math.max(0, Number(reserveUsd) || 0);
  const reserveUsername = reserveUsernameFor(cleanCode);

  await db.prices.insert({ coin: tokenTicker, price, basePrice: price, vol: volume, drift: 0, supply });
  await db.wallets.update({}, { $set: { [tokenTicker]: 0 } }, { multi: true });

  // Резерв союза — обычный кошелёк, по образцу EXCHANGE: держит USD-запас и весь непроданный токен
  await db.wallets.insert({ username: reserveUsername, usd: reserve, [tokenTicker]: supply });

  await db.priceHistory.insert({ coin: tokenTicker, price, ts: Date.now() });

  await db.unions.insert({
    code: cleanCode,
    name: cleanName,
    members: memberList,
    tokenTicker,
    tokenName: String(tokenName || '').trim() || `Токен ${cleanName}`,
    tokenSymbol: String(tokenSymbol || cleanCode).trim().slice(0, 6),
    reserveUsername,
    createdAt: Date.now(),
  });

  return db.unions.findOne({ code: cleanCode });
}

async function addMember(code, username) {
  const c = String(code || '').toUpperCase();
  const union = await db.unions.findOne({ code: c });
  if (!union) throw new Error('Союз не найден');
  const user = await db.users.findOne({ username });
  if (!user) throw new Error('Государство не найдено');
  if (union.members.includes(username)) return union;
  await db.unions.update({ code: c }, { $set: { members: [...union.members, username] } });
  return db.unions.findOne({ code: c });
}

async function removeMember(code, username) {
  const c = String(code || '').toUpperCase();
  const union = await db.unions.findOne({ code: c });
  if (!union) throw new Error('Союз не найден');
  await db.unions.update({ code: c }, { $set: { members: union.members.filter(m => m !== username) } });
  return db.unions.findOne({ code: c });
}

async function deleteUnion(code) {
  await db.unions.remove({ code: String(code || '').toUpperCase() }, {});
}

// ── Публикация компании на союзные биржи ─────────────────────────────────────
// Компания может быть вынесена сразу на несколько союзов одновременно —
// доступ получают участники любого из перечисленных союзов (плюс само
// государство-владелец всегда имеет доступ). unionFloat — сколько акций
// перевести из кошелька владельца в резерв конкретного союза для мгновенной
// ликвидности (маркет-мейкер по этому союзу), опционально.
async function addCompanyUnionListing(ticker, unionCode, unionFloat) {
  const t = String(ticker || '').toUpperCase();
  const c = String(unionCode || '').toUpperCase();
  const company = await db.companies.findOne({ ticker: t });
  if (!company) throw new Error('Компания не найдена');
  const union = await db.unions.findOne({ code: c });
  if (!union) throw new Error('Союз не найден');

  const float = Math.max(0, Math.floor(Number(unionFloat) || 0));
  if (float > 0) {
    const ownerWallet = await db.wallets.findOne({ username: company.ownerNation });
    const have = ownerWallet ? (ownerWallet[t] || 0) : 0;
    if (have < float) throw new Error(`У ${company.ownerNation} есть только ${have} акций ${t}`);
    await db.wallets.update({ username: company.ownerNation }, { $inc: { [t]: -float } });
    await db.wallets.update({ username: union.reserveUsername }, { $inc: { [t]: +float } });
  }

  const current = new Set(company.unionCodes || []);
  current.add(c);
  await db.companies.update({ ticker: t }, { $set: { unionCodes: [...current] } });
  return db.companies.findOne({ ticker: t });
}

async function removeCompanyUnionListing(ticker, unionCode) {
  const t = String(ticker || '').toUpperCase();
  const c = String(unionCode || '').toUpperCase();
  const company = await db.companies.findOne({ ticker: t });
  if (!company) throw new Error('Компания не найдена');
  const remaining = (company.unionCodes || []).filter(code => code !== c);
  await db.companies.update({ ticker: t }, { $set: { unionCodes: remaining } });
  return db.companies.findOne({ ticker: t });
}

// ── Точечные запреты (бан игрока по активу) ──────────────────────────────────
async function banAsset(username, ticker, reason) {
  const t = String(ticker || '').toUpperCase();
  if (!username || !t) throw new Error('Укажи игрока и тикер');
  const exists = await db.tradeRestrictions.findOne({ username, ticker: t });
  if (exists) return exists;
  const doc = { username, ticker: t, reason: String(reason || '').trim(), createdAt: Date.now() };
  await db.tradeRestrictions.insert(doc);
  return doc;
}

async function unbanAsset(id) {
  await db.tradeRestrictions.remove({ _id: id }, {});
}

async function listRestrictions() {
  return db.tradeRestrictions.find({}).sort({ createdAt: -1 });
}

// ── Резолвинг маркет-мейкера и допуска ────────────────────────────────────────
// Кэшируется на время одного вызова не нужно — коллекции маленькие, поиск дешёвый.
async function findUnionByToken(ticker) {
  return db.unions.findOne({ tokenTicker: ticker });
}

async function resolveReserveAccount(ticker) {
  const union = await findUnionByToken(ticker);
  if (union) return union.reserveUsername;

  const company = await db.companies.findOne({ ticker });
  if (company && company.unionCodes && company.unionCodes.length) {
    // Маркет-мейкером выступает резерв первого союза, на который вынесена
    // компания — P2P между участниками разных союзов при этом не ограничен,
    // резерв нужен только для мгновенной ликвидности «остатка об биржу».
    const companyUnion = await db.unions.findOne({ code: company.unionCodes[0] });
    if (companyUnion) return companyUnion.reserveUsername;
  }
  return EXCHANGE_USERNAME;
}

async function canTrade(username, ticker) {
  const banned = await db.tradeRestrictions.findOne({ username, ticker });
  if (banned) return { ok: false, reason: 'Торговля этим активом вам запрещена' };

  const union = await findUnionByToken(ticker);
  if (union) {
    if (!union.members.includes(username)) {
      return { ok: false, reason: `Доступно только участникам союза «${union.name}»` };
    }
    return { ok: true };
  }

  const company = await db.companies.findOne({ ticker });
  if (company) {
    if (company.ownerNation === username) return { ok: true };
    const unionCodes = company.unionCodes || [];
    if (company.visibility === 'private' && !unionCodes.length) {
      return { ok: false, reason: `Акции ${ticker} доступны только государству-владельцу` };
    }
    if (unionCodes.length) {
      const unions = await Promise.all(unionCodes.map(c => db.unions.findOne({ code: c })));
      const isMember = unions.some(u => u && u.members.includes(username));
      if (isMember) return { ok: true };
      return { ok: false, reason: `Доступно только государству-владельцу и участникам союзов: ${unionCodes.join(', ')}` };
    }
    // visibility не задан (компании Фазы 1, созданные до этого правила) — публично, как раньше
    return { ok: true };
  }

  return { ok: true };
}

// ── Списки для UI ─────────────────────────────────────────────────────────────
async function listUnions(prices, username) {
  const unions = await db.unions.find({});
  const wallet = username ? await db.wallets.findOne({ username }) : null;
  return unions
    .filter(u => !username || u.members.includes(username))
    .map(u => ({
      code: u.code,
      name: u.name,
      members: u.members,
      tokenTicker: u.tokenTicker,
      tokenName: u.tokenName,
      tokenSymbol: u.tokenSymbol,
      price: (prices && prices[u.tokenTicker]) || 0,
      myTokens: wallet ? (wallet[u.tokenTicker] || 0) : 0,
    }));
}

async function listUnionsAdmin(prices) {
  const unions = await db.unions.find({});
  const reserves = await Promise.all(unions.map(u => db.wallets.findOne({ username: u.reserveUsername })));
  return unions.map((u, i) => ({
    code: u.code,
    name: u.name,
    members: u.members,
    tokenTicker: u.tokenTicker,
    tokenName: u.tokenName,
    tokenSymbol: u.tokenSymbol,
    price: (prices && prices[u.tokenTicker]) || 0,
    reserveUsd: reserves[i] ? (reserves[i].usd || 0) : 0,
    reserveTokens: reserves[i] ? (reserves[i][u.tokenTicker] || 0) : 0,
  }));
}

module.exports = {
  createUnion,
  addMember,
  removeMember,
  deleteUnion,
  addCompanyUnionListing,
  removeCompanyUnionListing,
  banAsset,
  unbanAsset,
  listRestrictions,
  resolveReserveAccount,
  canTrade,
  listUnions,
  listUnionsAdmin,
};
