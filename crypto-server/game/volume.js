/* ===== ОБЪЁМ ТОРГОВ — скользящее окно за последние тики =====
 * Копится за текущий тик через recordTrade() — вызывается из каждой точки,
 * где реально исполняется сделка (боты, /api/trade, лимитные ордера P2P и
 * об биржу). На границе тика rotateTick() (вызывается из
 * game/market.js#tick()) снимок текущего тика попадает в скользящее окно
 * последних WINDOW тиков, а счётчик обнуляется.
 *
 * Только в памяти процесса, без персистентности — как и priceHistory в
 * game/bots.js: это вспомогательная метрика для отображения/сортировки в
 * списке активов, не критичное игровое состояние, восстанавливать после
 * рестарта не нужно (сразу набежит заново за WINDOW тиков).
 */
const WINDOW = 10;

const currentTick = {}; // coin -> накопленный объём (USD) с начала текущего тика
const history      = {}; // coin -> массив последних WINDOW тиковых объёмов

function recordTrade(coin, usdAmount) {
  if (!coin || !(usdAmount > 0)) return;
  currentTick[coin] = (currentTick[coin] || 0) + usdAmount;
}

// Вызывается ровно один раз за тик, уже после того как все сделки этого
// цикла (боты + матчинг лимитных ордеров) отработали.
function rotateTick(coins) {
  const known = new Set([...Object.keys(history), ...Object.keys(currentTick), ...(coins || [])]);
  known.forEach(coin => {
    if (!history[coin]) history[coin] = [];
    history[coin].push(currentTick[coin] || 0);
    if (history[coin].length > WINDOW) history[coin].shift();
    currentTick[coin] = 0;
  });
}

function getVolume(coin) {
  const arr = history[coin];
  return arr ? arr.reduce((s, v) => s + v, 0) : 0;
}

// "Мёртвый рынок" (см. game/market.js) должен давить шум только когда окно
// реально ПОЛНОЕ и сумма нулевая — а не сразу после рестарта сервера, когда
// история просто ещё не набралась (in-memory, обнуляется при каждом
// перезапуске). Без этого разграничения весь рынок ошибочно выглядел бы
// мёртвым первые WINDOW тиков (~4 минуты при тике 25с) после любого деплоя.
function hasConfirmedNoVolume(coin) {
  const arr = history[coin];
  if (!arr || arr.length < WINDOW) return false; // окно не набралось — не считаем мёртвым
  return arr.reduce((s, v) => s + v, 0) === 0;
}

module.exports = { recordTrade, rotateTick, getVolume, hasConfirmedNoVolume, WINDOW };
