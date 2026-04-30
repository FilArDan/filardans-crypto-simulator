// ===== УПРАВЛЕНИЕ СОСТОЯНИЕМ ЧЕРЕЗ game.settings =====
import { COINS_DEFAULT, SYMS, PD_MAX, START_CASH } from './coins.js';

export const SETTINGS = {
  MARKET:  'marketState',   // цены, история, волатильность, дрейф
  PLAYERS: 'playersState',  // балансы игроков {userId: {cash, held, avgP, hist, loan, sanctions}}
  BOTS:    'botsState',     // массив ботов
  BANK:    'bankState',     // банк
  PAUSED:  'paused',
  TICK_SPEED: 'tickSpeed',
};

export function registerSettings() {
  const S = game.settings;
  const base = { scope:'world', config:false };

  S.register('fad-crypto-simulator', SETTINGS.MARKET, {
    ...base, type: Object,
    default: buildDefaultMarket()
  });
  S.register('fad-crypto-simulator', SETTINGS.PLAYERS, {
    ...base, type: Object, default: {}
  });
  S.register('fad-crypto-simulator', SETTINGS.BOTS, {
    ...base, type: Array, default: buildDefaultBots()
  });
  S.register('fad-crypto-simulator', SETTINGS.BANK, {
    ...base, type: Object, default: { cash: 0, loan: 0, loanRate: 0.001 }
  });
  S.register('fad-crypto-simulator', SETTINGS.PAUSED, {
    ...base, type: Boolean, default: false
  });
  S.register('fad-crypto-simulator', SETTINGS.TICK_SPEED, {
    ...base, type: Number, default: 1500
  });
}

function buildDefaultMarket() {
  const coins = foundry.utils.deepClone(COINS_DEFAULT);
  const pd    = {};
  const drift = {};
  const vol   = {};
  SYMS.forEach(s => {
    let p = coins[s].price;
    pd[s] = [];
    for(let i = 0; i < 30; i++){
      p = Math.max(1, p * (1 + (Math.random() - .5) * coins[s].vol));
      pd[s].push(+p.toFixed(2));
    }
    coins[s].price = pd[s].at(-1);
    drift[s] = 0;
    vol[s]   = coins[s].vol;
  });
  return { coins, pd, drift, vol };
}

function buildDefaultBots() {
  const mkBot = (name, type, cash) => ({
    name, type, cash,
    held: Object.fromEntries(SYMS.map(s => [s, 0])),
    avgP: Object.fromEntries(SYMS.map(s => [s, 0])),
    ...(type === 'croc' ? { target: Object.fromEntries(SYMS.map(s => [s, 1.25 + Math.random() * 0.2])) } : {})
  });
  return [
    mkBot('Агрессор-1','bull',15000), mkBot('Агрессор-2','bull',18000),
    mkBot('Лис-1','fox',10000),       mkBot('Лис-2','fox',10000),
    mkBot('Крок-1','croc',20000),
  ];
}

// ---- Геттеры/сеттеры ----
export const getMarket  = () => game.settings.get('fad-crypto-simulator', SETTINGS.MARKET);
export const getPlayers = () => game.settings.get('fad-crypto-simulator', SETTINGS.PLAYERS);
export const getBots    = () => game.settings.get('fad-crypto-simulator', SETTINGS.BOTS);
export const getBank    = () => game.settings.get('fad-crypto-simulator', SETTINGS.BANK);
export const isPaused   = () => game.settings.get('fad-crypto-simulator', SETTINGS.PAUSED);

export const setMarket  = v => game.settings.set('fad-crypto-simulator', SETTINGS.MARKET,  v);
export const setPlayers = v => game.settings.set('fad-crypto-simulator', SETTINGS.PLAYERS, v);
export const setBots    = v => game.settings.set('fad-crypto-simulator', SETTINGS.BOTS,    v);
export const setBank    = v => game.settings.set('fad-crypto-simulator', SETTINGS.BANK,    v);
export const setPaused  = v => game.settings.set('fad-crypto-simulator', SETTINGS.PAUSED,  v);

/** Получить или создать состояние конкретного игрока */
export function getPlayerState(userId) {
  const all = getPlayers();
  if(!all[userId]) {
    all[userId] = {
      cash:  START_CASH,
      held:  Object.fromEntries(SYMS.map(s => [s, 0])),
      avgP:  Object.fromEntries(SYMS.map(s => [s, 0])),
      hist:  [],
      loan:  0,
      sanctions: {},   // { sym: true } — заморожена торговля активом
      frozen: false,   // полная заморозка счёта
    };
  }
  return all[userId];
}

export async function savePlayerState(userId, data) {
  const all = getPlayers();
  all[userId] = data;
  await setPlayers(all);
}
