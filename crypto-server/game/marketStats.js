const { db } = require('../db');
const { priceHistory } = require('./bots');
const { getVolume } = require('./volume');

// Сводка для сортировки/отображения в списке активов: изменение цены за
// последний тик и за последние 10 тиков, Market Cap и Circulating supply
// (прямо из db.prices) и объём торгов за последние 10 тиков (game/volume.js).
//
// Вынесено из routes/game.js в отдельный модуль, чтобы им мог пользоваться
// и market.js#tick() — раньше Δ1/Δ10 обновлялись только при вызове /api/state
// (по клику игрока), а не каждый тик, поэтому на экране они «зависали» между
// действиями игрока, хотя сама цена (через сокет priceUpdate) обновлялась
// исправно.
//
// Δ1/Δ10 читаются из уже существующего in-memory кэша последних тиковых
// цен (game/bots.js#priceHistory — тот же, которым пользуются сами боты для
// своих скользящих средних, обновляется ровно раз за тик в market.js#tick()).
// РАНЬШЕ здесь был db.priceHistory.find({coin}).sort({ts:-1}).limit(11) —
// при разработке казалось безобидным, но на реальной базе (814k+ записей
// истории цен, накопленных за долгую игру) это полное сканирование+сортировка
// в JS на каждый /api/state, умноженное на число монет — легло сервером на
// ~3-4с каждые несколько секунд. Кэш в памяти убирает обращение к БД для
// этой метрики вовсе.
async function getMarketStats() {
  const docs  = await db.prices.find({});
  const stats = {};
  for (const d of docs) {
    const hist = priceHistory[d.coin] || []; // цены за последние тики, от старых к новым
    const n    = hist.length;
    const cur    = n > 0 ? hist[n - 1] : null;
    const prev1  = n > 1 ? hist[n - 2] : null;
    const prev10 = n > 1 ? hist[Math.max(0, n - 11)] : null;
    stats[d.coin] = {
      supply:    d.supply || 0,
      marketCap: (d.supply || 0) * d.price,
      change1:   (cur != null && prev1  > 0) ? (cur - prev1)  / prev1  * 100 : null,
      change10:  (cur != null && prev10 > 0 && n >= 3) ? (cur - prev10) / prev10 * 100 : null,
      volume10:  getVolume(d.coin),
    };
  }
  return stats;
}

module.exports = { getMarketStats };
