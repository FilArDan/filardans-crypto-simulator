/* ===== МИРОВОЙ БАНК — кредитная механика межгосударственного рынка ===== */
const { db, getAllCoins, EXCHANGE_USERNAME } = require('../db');

const BASE_RATE        = 0.002;   // 0.2%/цикл базовая ключевая ставка
const MIN_RATE         = 0.0005;  // 0.05%/цикл минимум
const MAX_RATE         = 0.008;   // 0.8%/цикл максимум
const MAX_LOAN_RATIO   = 2.0;     // максимум займа = 2× национальные активы
const MARGIN_THRESHOLD = 0.80;    // порог долговой нагрузки → дефолт
const FEE              = 0.004;   // синхронизировано с TRADE_FEE в game.js

// ── Динамическая ключевая ставка МВФ ────────────────────────────────────────
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

// ── Стоимость активов без кредитов ───────────────────────────────────────────
function coinValue(wallet, prices, coins) {
  if (!wallet) return 0;
  let total = 0;
  for (const coin of coins) total += (wallet[coin] || 0) * (prices[coin] || 0);
  return total;
}

// ── Полный объём национальных активов (кредиты + ресурсы) ────────────────────
function portfolioValue(wallet, prices, coins) {
  if (!wallet) return 0;
  return (wallet.usd || 0) + coinValue(wallet, prices, coins);
}

// ── Расчёт долговой нагрузки ─────────────────────────────────────────────────
function computeMarginRatio(wallet, prices, coins, loanDue) {
  if (!loanDue || loanDue <= 0) return 0;
  const total = portfolioValue(wallet, prices, coins);
  if (total <= 0) return 1;
  return loanDue / total;
}

// ── Начисление процентов (вызывается каждый торговый цикл из market.js) ──────
// Начисленные проценты физически зачисляются в Резервный фонд МТП
async function accrueInterest(io, prices, priceHistory) {
  const coins = await getAllCoins();
  const loans = await db.loans.find({ paid: { $ne: true } });
  if (!loans.length) return;

  const rate = computeLoanRate(priceHistory || {});
  let totalInterestEarned = 0;

  for (const loan of loans) {
    const interest = loan.due * rate;          // начислено за цикл
    const newDue   = loan.due + interest;
    await db.loans.update({ _id: loan._id }, { $set: { due: newDue, rate } });
    totalInterestEarned += interest;

    const wallet = await db.wallets.findOne({ username: loan.username });
    if (!wallet) continue;

    const marginRatio = computeMarginRatio(wallet, prices, coins, newDue);

    if (io) {
      io.emit('loanUpdate', { username: loan.username, due: newDue, rate, marginRatio });
    }

    if (marginRatio >= MARGIN_THRESHOLD) {
      await executeDefault(loan.username, wallet, newDue, prices, coins, io);
    }
  }

  // Зачисляем проценты в Резервный фонд МТП
  // Проценты — это плата за пользование деньгами биржи, поэтому USD создаётся здесь обоснованно
  if (totalInterestEarned > 0) {
    await db.wallets.update({ username: EXCHANGE_USERNAME }, { $inc: { usd: +totalInterestEarned } });
    if (io) {
      const exchWallet = await db.wallets.findOne({ username: EXCHANGE_USERNAME });
      if (exchWallet) io.emit('bankUpdate', { usd: exchWallet.usd });
    }
  }
}

// ── Государственный дефолт ────────────────────────────────────────────────────
async function executeDefault(username, wallet, loanDue, prices, coins, io) {
  // Снимаем лимитные ордера: активы в резерве тоже подлежат реализации,
  // иначе долг можно было бы «спрятать» в стакане
  const { cancelOrdersForUser } = require('./orders');
  await cancelOrdersForUser(username, io);
  const freed = await db.wallets.findOne({ username });
  if (freed) wallet = freed;

  // Принудительно продаём все монеты игрока — они физически переходят на счёт биржи
  let proceeds = 0;
  for (const coin of coins) {
    const amt   = wallet[coin] || 0;
    const price = prices[coin] || 0;
    if (amt > 0 && price > 0) {
      const coinProceeds = amt * price * (1 - FEE);
      proceeds += coinProceeds;
      // Монеты переходят к бирже, биржа платит игроку USD (минус комиссия)
      await db.wallets.update({ username },            { $set:  { [coin]: 0 } });
      await db.wallets.update({ username: EXCHANGE_USERNAME }, { $inc: { [coin]: +amt, usd: -coinProceeds } });
    }
  }
  // Зачисляем вырученное игроку
  await db.wallets.update({ username }, { $inc: { usd: proceeds } });

  const freshWallet = await db.wallets.findOne({ username });
  const pay = Math.min(freshWallet.usd || 0, loanDue);
  if (pay > 0) {
    await db.wallets.update({ username },            { $inc: { usd: -pay } });
    await db.wallets.update({ username: EXCHANGE_USERNAME }, { $inc: { usd: +pay } });
  }
  const remaining = Math.max(0, loanDue - pay);

  if (remaining < 0.01) {
    await db.loans.update({ username, paid: { $ne: true } }, { $set: { due: 0, paid: true } });
  } else {
    await db.loans.update({ username, paid: { $ne: true } }, { $set: { due: remaining } });
  }

  const ev = {
    ts:   Date.now(),
    text: `⚠️ ГОСУДАРСТВЕННЫЙ ДЕФОЛТ! ${username} — национальные активы принудительно реализованы ($${proceeds.toFixed(2)}). Остаток задолженности: $${remaining.toFixed(2)}`
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

module.exports = {
  accrueInterest,
  computeLoanRate,
  computeMarginRatio,
  coinValue,
  portfolioValue,
  MARGIN_THRESHOLD,
  MAX_LOAN_RATIO,
};
