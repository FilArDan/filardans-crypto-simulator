/* ===== БАНК — серверная кредитная механика ===== */
const { db, getAllCoins } = require('../db');

const BASE_RATE        = 0.002;   // 0.2%/тик базовая
const MIN_RATE         = 0.0005;  // 0.05%/тик
const MAX_RATE         = 0.008;   // 0.8%/тик
const MAX_LOAN_RATIO   = 2.0;
const MARGIN_THRESHOLD = 0.80;
const FEE              = 0.001;

// ── Динамическая ставка ──────────────────────────────────────────────────────────────────────────
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

// ── Стоимость монет без USD ──────────────────────────────────────────────────────────────────────
function coinValue(wallet, prices, coins) {
  if (!wallet) return 0;
  let total = 0;
  for (const coin of coins) total += (wallet[coin] || 0) * (prices[coin] || 0);
  return total;
}

// ── Полная стоимость портфеля (USD + монеты) ─────────────────────────────────────────────────
function portfolioValue(wallet, prices, coins) {
  if (!wallet) return 0;
  return (wallet.usd || 0) + coinValue(wallet, prices, coins);
}

// ── Расчёт маржи ──────────────────────────────────────────────────────────────────────────
// Маржа = долг / полный портфель (USD + монеты)
// Разделить на 0 можно только если у игрока вообще нет ничего (USD=0 И монет=0)
// Если игрок только что взял кредит и не купил монеты — coinsVal=0, но usd>0,
// поэтому маржа = долг / usd — занимает нормальное значение
function computeMarginRatio(wallet, prices, coins, loanDue) {
  const total = portfolioValue(wallet, prices, coins);
  if (total <= 0) return loanDue > 0 ? 1 : 0;
  return loanDue / total;
}

// ── Начисление процентов (вызывается каждый тик из market.js) ─────────────────────
function accrueInterest(io, prices, priceHistory) {
  return new Promise(async (resolve) => {
    const coins = await getAllCoins();
    const loans = await db.loans.find({ paid: { $ne: true } });
    if (!loans.length) return resolve();

    const rate = computeLoanRate(priceHistory || {});

    for (const loan of loans) {
      const newDue = loan.due * (1 + rate);
      await db.loans.update({ _id: loan._id }, { $set: { due: newDue, rate } });

      const wallet = await db.wallets.findOne({ username: loan.username });
      if (!wallet) continue;

      const marginRatio = computeMarginRatio(wallet, prices, coins, newDue);

      if (io) {
        io.emit('loanUpdate', { username: loan.username, due: newDue, rate, marginRatio });
      }

      if (marginRatio >= MARGIN_THRESHOLD) {
        await executeMarginCall(loan.username, wallet, newDue, prices, coins, io);
      }
    }
    resolve();
  });
}

// ── Маржин-колл ──────────────────────────────────────────────────────────────────────────────────
async function executeMarginCall(username, wallet, loanDue, prices, coins, io) {
  let proceeds = 0;
  for (const coin of coins) {
    const amt = wallet[coin] || 0;
    if (amt > 0 && (prices[coin] || 0) > 0) {
      proceeds += amt * prices[coin] * (1 - FEE);
      await db.wallets.update({ username }, { $set: { [coin]: 0 } });
    }
  }
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
    text: `🚨 МАРЖИН-КОЛЛ! ${username} — активы принудительно проданы ($${proceeds.toFixed(2)}). Остаток долга: $${remaining.toFixed(2)}`
  };
  await db.events.insert(ev);
  if (io) {
    const finalWallet = await db.wallets.findOne({ username });
    io.emit('newEvent',     ev);
    io.emit('marginCall',   { username, remaining });
    io.emit('walletUpdate', { username, wallet: finalWallet });
    io.emit('loanUpdate',   { username, due: remaining, rate: 0, marginRatio: 0 });
  }
}

module.exports = { accrueInterest, computeLoanRate, computeMarginRatio, coinValue, portfolioValue, MARGIN_THRESHOLD, MAX_LOAN_RATIO };
