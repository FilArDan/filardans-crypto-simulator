/* ===== СОЮЗЫ И КОНТРОЛЬ ДОСТУПА =====
 *
 * Союз — просто группа государств-участников. Сам по себе он не торгуется и
 * не имеет своего кошелька/токена (эта часть была временно убрана — при
 * необходимости её можно вернуть отдельно). Единственная функция союза —
 * контроль доступа: компания, вынесенная на союзную биржу (company.unionCodes),
 * становится видна и торгуема для всех участников перечисленных союзов
 * (плюс государству-владельцу всегда доступна), поверх обычного
 * государству-владельцу-only доступа. Маркет-мейкером для таких компаний
 * остаётся общий EXCHANGE — своего резерва у союза нет.
 */
const { db } = require('../db');

// ── Создание союза ────────────────────────────────────────────────────────────
async function createUnion({ code, name, members, botMembers }) {
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

  const botMemberList = Array.isArray(botMembers) ? botMembers : [];
  for (const b of botMemberList) {
    const bot = await db.bots.findOne({ name: b });
    if (!bot) throw new Error(`Бот ${b} не найден`);
  }

  await db.unions.insert({
    code: cleanCode,
    name: cleanName,
    members: memberList,
    botMembers: botMemberList,
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

// ── Боты в союзе ──────────────────────────────────────────────────────────────
// Отдельно от db.users-участников: боты живут в db.bots, а не в db.users.
// Единственный эффект членства — доступ к компаниям, вынесенным на биржу
// этого союза (см. canBotTrade в game/bots.js): без этого боты либо вообще
// не различали приватные/союзные компании, либо не могли участвовать в них.
async function addBotMember(code, botName) {
  const c = String(code || '').toUpperCase();
  const union = await db.unions.findOne({ code: c });
  if (!union) throw new Error('Союз не найден');
  const bot = await db.bots.findOne({ name: botName });
  if (!bot) throw new Error('Бот не найден');
  const botMembers = union.botMembers || [];
  if (botMembers.includes(botName)) return union;
  await db.unions.update({ code: c }, { $set: { botMembers: [...botMembers, botName] } });
  return db.unions.findOne({ code: c });
}

async function removeBotMember(code, botName) {
  const c = String(code || '').toUpperCase();
  const union = await db.unions.findOne({ code: c });
  if (!union) throw new Error('Союз не найден');
  const botMembers = (union.botMembers || []).filter(b => b !== botName);
  await db.unions.update({ code: c }, { $set: { botMembers } });
  return db.unions.findOne({ code: c });
}

async function deleteUnion(code) {
  const c = String(code || '').toUpperCase();
  await db.unions.remove({ code: c }, {});
  // Снимаем листинг с компаний, которые ссылались на распущенный союз —
  // иначе они молча пропадают из интерфейса (доступ считался бы только
  // владельцу, а на клиенте — не показывались бы нигде вообще).
  const listed = await db.companies.find({ unionCodes: c });
  for (const company of listed) {
    const remaining = (company.unionCodes || []).filter(code2 => code2 !== c);
    await db.companies.update({ ticker: company.ticker }, { $set: { unionCodes: remaining } });
  }
}

// ── Публикация компании на союзные биржи ─────────────────────────────────────
// Компания может быть вынесена сразу на несколько союзов одновременно —
// доступ получают участники любого из перечисленных союзов (плюс само
// государство-владелец всегда имеет доступ).
async function addCompanyUnionListing(ticker, unionCode) {
  const t = String(ticker || '').toUpperCase();
  const c = String(unionCode || '').toUpperCase();
  const company = await db.companies.findOne({ ticker: t });
  if (!company) throw new Error('Компания не найдена');
  const union = await db.unions.findOne({ code: c });
  if (!union) throw new Error('Союз не найден');

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
// Своего резерва у союза больше нет — маркет-мейкером для любого актива
// (включая компании, вынесенные на союзную биржу) остаётся общий EXCHANGE.
async function resolveReserveAccount(ticker) {
  const { EXCHANGE_USERNAME } = require('../db');
  return EXCHANGE_USERNAME;
}

// ── Возврат активов на резерв (удаление игрока/бота) ─────────────────────────
// При удалении аккаунта его баланс просто стирался вместе с записью — монеты
// и акции компаний исчезали насовсем, а не возвращались в оборот. Для
// активов с ограниченным supply (см. фикс "резерв биржи не должен продавать
// сверх supply") это означало, что удалённый холдинг навсегда выпадает из
// обращения. holdings — плоская карта {тикер: количество} (поля кошелька
// игрока за вычетом usd/_id/username, либо bot.held).
async function returnHoldingsToReserve(holdings) {
  if (!holdings) return;
  for (const [ticker, amount] of Object.entries(holdings)) {
    if (!(amount > 0)) continue;
    const reserveAccount = await resolveReserveAccount(ticker);
    await db.wallets.update({ username: reserveAccount }, { $inc: { [ticker]: amount } });
  }
}

async function canTrade(username, ticker) {
  const banned = await db.tradeRestrictions.findOne({ username, ticker });
  if (banned) return { ok: false, reason: 'Торговля этим активом вам запрещена' };

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

// ── Допуск ботов к компаниям ──────────────────────────────────────────────────
// Боты компаниями не владеют и точечных банов (tradeRestrictions) не имеют —
// проверяем только видимость: приватная компания без союзного листинга для
// бота недоступна вообще (нечего проверять на владение), а листинг на союз
// открывает доступ ботам-участникам этого союза так же, как игрокам.
async function canBotTrade(botName, ticker) {
  const company = await db.companies.findOne({ ticker });
  if (!company) return true;

  const unionCodes = company.unionCodes || [];
  if (unionCodes.length) {
    const unions = await db.unions.find({ code: { $in: unionCodes } });
    return unions.some(u => (u.botMembers || []).includes(botName));
  }
  if (company.visibility === 'private') return false;
  return true; // legacy без visibility — публично, как раньше
}

// ── Списки для UI ─────────────────────────────────────────────────────────────
async function listUnions(username) {
  const unions = await db.unions.find({});
  return unions
    .filter(u => !username || u.members.includes(username))
    .map(u => ({ code: u.code, name: u.name, members: u.members, botMembers: u.botMembers || [] }));
}

async function listUnionsAdmin() {
  const unions = await db.unions.find({});
  return unions.map(u => ({ code: u.code, name: u.name, members: u.members, botMembers: u.botMembers || [] }));
}

module.exports = {
  createUnion,
  addMember,
  removeMember,
  addBotMember,
  removeBotMember,
  deleteUnion,
  addCompanyUnionListing,
  removeCompanyUnionListing,
  banAsset,
  unbanAsset,
  listRestrictions,
  resolveReserveAccount,
  returnHoldingsToReserve,
  canTrade,
  canBotTrade,
  listUnions,
  listUnionsAdmin,
};
