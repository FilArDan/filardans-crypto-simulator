/* ===== БАНК — серверная кредитная механика ===== */
const { db, getAllCoins } = require('../db');

const BASE_RATE        = 0.002;  // 0.2%/тик базовая
const MIN_RATE         = 0.0005; // 0.05%/тик минимум
const MAX_RATE         = 0.008;  // 0.8%/тик максимум
const MAX_LOAN_RATIO   = 2.0;    // кредит не более 2× стоимости портфеля
const MARGIN_THRESHOLD = 0.80;   // маржин-колл когда долг > 80% портфеля
const FEE              = 0.001;  // комиссия при принудительной продаже

// ── Динамическая ставка — растёт при высокой волатильности рынка ─────────────
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
  return Math.max(MIN_RATE, Math.min(MAX_RATE, BASE_RATE * (1 + avgVol * 5)));
}

// ── Полная стоимость портфеля игрока ─────────────────────────────────────────
function portfolioValue(wallet, prices, coins) {
  if (!wallet) return 0;
  let total = wallet.usd || 0;
  for (const coin of coins) {
    total += (wallet[coin] || 0) * (prices[coin] || 0);
  }
  return total;
}

// ── Начисление процентов + проверка маржин-колла (вызывается каждый тик) ─────
async function accrueInterest(io, prices) {
  const coins = await getAllCoins();
  const loans = await db.loans.find({ paid: { $ne: true } });
  if (!loans.length) return;

  const { priceHistory } = require('./bots');
  const rate = computeLoanRate(priceHistory);

  for (const loan of loans) {
    const newDue = loan.due * (1 + rate);
    await db.loans.update({ _id: loan._id }, { $set: { due: newDue, rate } });

    const wallet = await db.wallets.findOne({ username: loan.username });
    if (!wallet) continue;

    const portVal = portfolioValue(wallet, prices, coins);
    if (portVal > 0 && newDue / portVal >= MARGIN_THRESHOLD) {
      await executeMarginCall(loan.username, wallet, newDue, prices, coins, io);
    }
  }
}

// ── Маржин-колл: принудительная продажа всех активов ─────────────────────────
async function executeMarginCall(username, wallet, loanDue, prices, coins, io) {
  let proceeds = 0;

  for (const coin of coins) {
    const amt = wallet[coin] || 0;
    if (amt > 0 && (prices[coin] || 0) > 0) {
      proceeds += amt * prices[coin] * (1 - FEE);
      await db.wallets.update({ username }, { $set: { [coin]: 0 } });
    }
  }

  // Зачисляем выручку и списываем максимум возможного
  await db.wallets.update({ username }, { $inc: { usd: proceeds } });
  const freshWallet = await db.wallets.findOne({ username });
  const pay = Math.min(Math.max(freshWallet.usd, 0), loanDue);
  await db.wallets.update({ username }, { $inc: { usd: -pay } });

  const remaining = Math.max(0, loanDue - pay);
  if (remaining < 0.01) {
    await db.loans.update({ username, paid: { $ne: true } }, { $set: { due: 0, paid: true } });
  } else {
    await db.loans.update({ username, paid: { $ne: true } }, { $set: { due: remaining } });
  }

  const ev = {
    ts:   Date.now(),
    text: `🚨 МАРЖИН-КОЛЛ! ${username} — все активы принудительно проданы ($${proceeds.toFixed(2)}). Остаток долга: $${remaining.toFixed(2)}`
  };
  await db.events.insert(ev);

  if (io) {
    const finalWallet = await db.wallets.findOne({ username });
    io.emit('newEvent',     ev);
    io.emit('marginCall',   { username, remaining });
    io.emit('walletUpdate', { username, wallet: finalWallet });
  }
}

module.exports = {
  accrueInterest,
  computeLoanRate,
  portfolioValue,
  MARGIN_THRESHOLD,
  MAX_LOAN_RATIO,
};
