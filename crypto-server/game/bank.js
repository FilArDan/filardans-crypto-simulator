/* ===== БАНК — серверная логика кредитов ===== */

const { db, getAllCoins } = require('../db');

const BASE_RATE        = 0.002;   // 0.20 %/тик базовая ставка
const MIN_RATE         = 0.0005;  // 0.05 % минимум
const MAX_RATE         = 0.008;   // 0.80 % максимум
const MAX_LOAN_RATIO   = 2.0;     // max кредит = 2× стоимость портфеля
const MARGIN_THRESHOLD = 0.80;    // маржин-колл при долг > 80 % портфеля
const FEE              = 0.001;

/* ---------- Динамическая ставка ----------
   Растёт вместе с волатильностью рынка:
   смотрим изменение каждой монеты за 5 последних тиков,
   берём среднее по модулю и масштабируем ставку. */
function computeLoanRate(priceHistory) {
  const coins = Object.keys(priceHistory || {});
  if (!coins.length) return BASE_RATE;
  let totalVol = 0, count = 0;
  for (const coin of coins) {
    const hist = priceHistory[coin];
    if (!hist || hist.length < 5) continue;
    const p1 = hist[hist.length - 1];
    const p5 = hist[hist.length - Math.min(5, hist.length)];
    if (p5 > 0) { totalVol += Math.abs(p1 - p5) / p5; count++; }
  }
  const avgVol = count > 0 ? totalVol / count : 0;
  return Math.max(MIN_RATE, Math.min(MAX_RATE, BASE_RATE * (1 + avgVol * 8)));
}

/* ---------- Стоимость портфеля игрока ---------- */
function portfolioValue(wallet, prices, coins) {
  let total = Number(wallet.usd) || 0;
  for (const coin of coins) total += (wallet[coin] || 0) * (prices[coin] || 0);
  return total;
}

/* ---------- Маржин-колл ----------
   Принудительно продаём все крипто-активы игрока,
   выручку списываем в счёт долга. */
async function executeMarginCall(username, loanDue, prices, coins, io) {
  const wallet = await db.wallets.findOne({ username });
  if (!wallet) return;

  let proceeds = 0;
  for (const coin of coins) {
    const amt = wallet[coin] || 0;
    if (amt > 0 && prices[coin] > 0) {
      proceeds += amt * prices[coin] * (1 - FEE);
      await db.wallets.update({ username }, { $set: { [coin]: 0 } });
    }
  }

  // Зачислить выручку → списать на долг
  await db.wallets.update({ username }, { $inc: { usd: proceeds } });
  const fresh = await db.wallets.findOne({ username });
  const pay   = Math.min(fresh.usd || 0, loanDue);
  await db.wallets.update({ username }, { $inc: { usd: -pay } });
  const remaining = Math.max(0, loanDue - pay);

  if (remaining < 0.01) {
    await db.loans.update({ username, paid: { $ne: true } }, { $set: { due: 0, paid: true } });
  } else {
    await db.loans.update({ username, paid: { $ne: true } }, { $set: { due: remaining } });
  }

  const ev = {
    ts:   Date.now(),
    text: `🚨 МАРЖИН-КОЛЛ: ${username} — активы на $${proceeds.toFixed(2)} принудительно проданы. Остаток долга: $${remaining.toFixed(2)}`,
  };
  await db.events.insert(ev);

  if (io) {
    io.emit('newEvent',    ev);
    io.emit('marginCall',  { username, remaining });
    const updated = await db.wallets.findOne({ username });
    io.emit('walletUpdate', { username, wallet: updated });
  }
}

/* ---------- Начисление процентов каждый тик ----------
   Вызывается из market.js после botTick. */
async function accrueInterest(io, prices) {
  const coins = await getAllCoins();
  const { priceHistory } = require('./bots'); // lazy — избегаем циклического импорта
  const rate  = computeLoanRate(priceHistory);
  const loans = await db.loans.find({ paid: { $ne: true } });

  for (const loan of loans) {
    const newDue = loan.due * (1 + rate);
    await db.loans.update({ _id: loan._id }, { $set: { due: newDue, rate } });

    // Проверяем маржу после начисления
    const wallet  = await db.wallets.findOne({ username: loan.username });
    if (!wallet) continue;
    const portVal = portfolioValue(wallet, prices, coins);
    if (portVal > 0 && newDue > portVal * MARGIN_THRESHOLD) {
      await executeMarginCall(loan.username, newDue, prices, coins, io);
    }
  }
}

module.exports = {
  accrueInterest,
  computeLoanRate,
  portfolioValue,
  MARGIN_THRESHOLD,
  MAX_LOAN_RATIO,
  BASE_RATE,
  MIN_RATE,
  MAX_RATE,
};
