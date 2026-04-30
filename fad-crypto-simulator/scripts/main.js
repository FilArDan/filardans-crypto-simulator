// ===== ТОЧКА ВХОДА =====
import { registerSettings, updateCache, getPlayers, setPlayers,
         getMarket, setMarket, getBank, setBank } from './state.js';
import { setupSocket, emitToUser, emitToAll, MSG } from './socket.js';
import { tick, processTradeRequest } from './market.js';
import { GMApp }     from './ui/GMApp.js';
import { PlayerApp } from './ui/PlayerApp.js';

const MODULE = 'fad-crypto-simulator';
let _timer = null, _gm = null, _pl = null;

Hooks.once('init', () => {
  registerSettings();
  Handlebars.registerHelper('add', (a, b) => a + b);
  Handlebars.registerHelper('eq',  (a, b) => a === b);

  game.keybindings.register(MODULE, 'openGM', {
    name: 'ГМ-панель',
    editable: [{ key: 'KeyC', modifiers: ['Shift'] }],
    onDown: () => { if (game.user.isGM) _openGM(); },
  });
  game.keybindings.register(MODULE, 'openPlayer', {
    name: 'Торговый терминал',
    editable: [{ key: 'KeyC', modifiers: ['Alt'] }],
    onDown: () => { if (!game.user.isGM) _openPlayer(); },
  });
});

Hooks.once('ready', () => {
  setupSocket({

    [MSG.TRADE_REQUEST]: async (payload, senderId) => {
      if (!game.user.isGM) return;
      const market = getMarket();
      const bank   = getBank();
      const result = processTradeRequest(payload, market, bank);

      if (result.ok) {
        const players = getPlayers();
        players[payload.userId] = result.ps;
        await setPlayers(players);
        await setMarket(market);
        await setBank(bank);
        result.players = getPlayers();
        result.bank    = getBank();
      }

      // emitToUser — targetId на верхнем уровне, только нужный игрок увидит
      emitToUser(senderId, MSG.TRADE_RESULT, result);

      updateCache({ market: getMarket(), players: getPlayers(), bank: getBank() });
      _gm?.onTick();
    },

    [MSG.TRADE_RESULT]: (payload) => {
      if (game.user.isGM) return;
      updateCache({ players: payload.players, bank: payload.bank });
      _pl?.onUpdate({ type: MSG.TRADE_RESULT, msg: payload.msg, ok: payload.ok });
    },

    [MSG.TICK_UPDATE]: (payload) => {
      updateCache(payload);          // ← кеш ПЕРВЫМ, до любого рендера
      if (game.user.isGM) _gm?.onTick();
      else                _pl?.onTick();
    },

    [MSG.FORCE_REFRESH]: (payload) => {
      if (payload) updateCache(payload);
      if (game.user.isGM) _gm?.onTick();
      else                _pl?.onTick();
    },
  });

  if (game.user.isGM) {
    _startTick();
  } else {
    _openPlayer();
  }

  // Плавающая кнопка в интерфейсе
  Hooks.on('renderSidebar', () => {
    if (document.getElementById('cs-sidebar-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'cs-sidebar-btn';
    btn.title = game.user.isGM ? 'Крипто-симулятор (ГМ)' : 'Торговый терминал';
    btn.innerHTML = '<i class="fas fa-chart-line"></i>';
    Object.assign(btn.style, {
      position: 'fixed', bottom: '60px', left: '4px',
      width: '36px', height: '36px', borderRadius: '8px',
      border: '1px solid #3a3836', background: '#1c1b19',
      color: '#4f98a3', cursor: 'pointer', zIndex: '9999',
      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '16px',
    });
    btn.addEventListener('click', () => game.user.isGM ? _openGM() : _openPlayer());
    document.body.appendChild(btn);
  });
});

function _openGM()     { if (!_gm) _gm = new GMApp();    _gm.render(true); }
function _openPlayer() { if (!_pl) _pl = new PlayerApp(); _pl.render(true); }

function _startTick() {
  if (_timer) clearInterval(_timer);
  const ms = game.settings.get(MODULE, 'tickSpeed') ?? 1500;
  _timer = setInterval(async () => {
    if (!game.settings.get(MODULE, 'paused')) await tick();
  }, ms);
}