// ===== СОСТОЯНИЕ =====
import { COINS_DEFAULT, SYMS, START_CASH } from './coins.js';

export const SETTINGS = {
  MARKET:     'marketState',
  PLAYERS:    'playersState',
  BOTS:       'botsState',
  BANK:       'bankState',
  PAUSED:     'paused',
  TICK_SPEED: 'tickSpeed',
};

const ID = 'fad-crypto-simulator';

// ── In-memory кеш ────────────────────────────────────────────────
const C = { market: null, players: null, bank: null, bots: null };

/** Вызывается из main.js СРАЗУ при получении сокет-сообщения — ДО рендера */
export function updateCache(p = {}) {
  if (p.market)  C.market  = p.market;
  if (p.players) C.players = p.players;
  if (p.bank)    C.bank    = p.bank;
  if (p.bots)    C.bots    = p.bots;
}

export function registerSettings() {
  const S = game.settings, b = { scope: 'world', config: false };
  S.register(ID, SETTINGS.MARKET,     { ...b, type: Object,  default: buildDefaultMarket() });
  S.register(ID, SETTINGS.PLAYERS,    { ...b, type: Object,  default: {} });
  S.register(ID, SETTINGS.BOTS,       { ...b, type: Array,   default: buildDefaultBots() });
  S.register(ID, SETTINGS.BANK,       { ...b, type: Object,  default: { cash: 0, loan: 0, loanRate: 0.001 } });
  S.register(ID, SETTINGS.PAUSED,     { ...b, type: Boolean, default: false });
  S.register(ID, SETTINGS.TICK_SPEED, { ...b, type: Number,  default: 1500 });
}

// Геттеры: кеш → settings
export const getMarket  = () => C.market  ?? game.settings.get(ID, SETTINGS.MARKET);
export const getPlayers = () => C.players ?? game.settings.get(ID, SETTINGS.PLAYERS);
export const getBots    = () => C.bots    ?? game.settings.get(ID, SETTINGS.BOTS);
export const getBank    = () => C.bank    ?? game.settings.get(ID, SETTINGS.BANK);
export const isPaused   = () => game.settings.get(ID, SETTINGS.PAUSED);

// Сеттеры (только ГМ): обновляют кеш И settings
export const setMarket  = async v => { C.market  = v; await game.settings.set(ID, SETTINGS.MARKET,  v); };
export const setPlayers = async v => { C.players = v; await game.settings.set(ID, SETTINGS.PLAYERS, v); };
export const setBots    = async v => { C.bots    = v; await game.settings.set(ID, SETTINGS.BOTS,    v); };
export const setBank    = async v => { C.bank    = v; await game.settings.set(ID, SETTINGS.BANK,    v); };
export const setPaused  = v => game.settings.set(ID, SETTINGS.PAUSED, v);

export function getPlayerState(userId) {
  const all = getPlayers();
  if (!all[userId]) all[userId] = {
    cash: START_CASH,
    held: Object.fromEntries(SYMS.map(s => [s, 0])),
    avgP: Object.fromEntries(SYMS.map(s => [s, 0])),
    hist: [], loan: 0, sanctions: {}, frozen: false,
  };
  return all[userId];
}

export async function savePlayerState(uid, data) {
  const all = getPlayers();
  all[uid] = data;
  await setPlayers(all);
}

function buildDefaultMarket() {
  const coins = foundry.utils.deepClone(COINS_DEFAULT);
  const pd = {}, drift = {}, vol = {};
  SYMS.forEach(s => {
    let p = coins[s].price; pd[s] = [];
    for (let i = 0; i < 40; i++) {
      p = Math.max(1, p * (1 + (Math.random() - .5) * coins[s].vol));
      pd[s].push(+p.toFixed(2));
    }
    coins[s].price = pd[s].at(-1);
    drift[s] = 0; vol[s] = coins[s].vol;
  });
  return { coins, pd, drift, vol };
}

function buildDefaultBots() {
  const mk = (name, type, cash) => ({
    name, type, cash,
    held: Object.fromEntries(SYMS.map(s => [s, 0])),
    avgP: Object.fromEntries(SYMS.map(s => [s, 0])),
    ...(type === 'croc' ? { target: Object.fromEntries(SYMS.map(s => [s, 1.25 + Math.random() * 0.2])) } : {})
  });
  return [
    mk('Агрессор-1', 'bull', 15000), mk('Агрессор-2', 'bull', 18000),
    mk('Лис-1', 'fox', 10000),       mk('Лис-2', 'fox', 10000),
    mk('Крок-1', 'croc', 20000),
  ];
}