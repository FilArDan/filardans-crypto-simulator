// ===== ТОЧКА ВХОДА =====
import { registerSettings } from './state.js';
import { setupSocket, MSG } from './socket.js';
import { tick } from './market.js';
import { GMApp } from './ui/GMApp.js';
import { PlayerApp } from './ui/PlayerApp.js';

const MODULE = 'fad-crypto-simulator';
let _tickTimer = null;
let _playerApp = null;
let _gmApp     = null;

Hooks.once('init', () => {
  registerSettings();

  Handlebars.registerHelper('add', (a, b) => a + b);
  Handlebars.registerHelper('eq',  (a, b) => a === b);

  game.keybindings.register(MODULE, 'openGM', {
    name: 'Открыть панель ГМ',
    hint: 'Крипто-симулятор',
    editable: [{ key: 'KeyC', modifiers: ['Shift'] }],
    onDown: () => { if(game.user.isGM) _openGM(); },
  });

  game.keybindings.register(MODULE, 'openPlayer', {
    name: 'Открыть торговый терминал',
    hint: 'Крипто-симулятор',
    editable: [{ key: 'KeyC', modifiers: ['Alt'] }],
    onDown: () => { if(!game.user.isGM) _openPlayer(); },
  });

  console.log('Крипто-симулятор | init');
});

Hooks.once('ready', async () => {
  setupSocket({
    // ГМ обрабатывает запросы на сделку
    [MSG.TRADE_REQUEST]: (payload, senderId) => {
      if(!game.user.isGM) return;
      _handleTradeRequest(payload, senderId);
    },
    // Игрок: результат сделки
    [MSG.TRADE_RESULT]: (payload) => {
      if(game.user.isGM) return;
      _playerApp?.onUpdate({ type: MSG.TRADE_RESULT, payload });
    },
    // Все клиенты получают свежий market из тика
    [MSG.TICK_UPDATE]: (payload) => {
      if(game.user.isGM) {
        // ГМ перерисовывает свою панель
        _gmApp?.render();
      } else {
        // Игрок получает payload с рынком и сразу рисует
        _playerApp?.onUpdate({ type: MSG.TICK_UPDATE, payload });
      }
    },
    // Принудительный рефреш (санкции, заморозка, баланс)
    [MSG.FORCE_REFRESH]: () => {
      _playerApp?.render();
      _gmApp?.render();
    },
  });

  if(game.user.isGM) {
    _startTick();
  } else {
    _openPlayer();
  }

  // Плавающая кнопка (работает в v13/v14)
  Hooks.on('renderSidebar', () => {
    if(document.querySelector('#cs-sidebar-btn')) return;
    const btn = document.createElement('button');
    btn.id    = 'cs-sidebar-btn';
    btn.title = game.user.isGM ? 'Крипто-симулятор (ГМ)' : 'Мой торговый терминал';
    btn.innerHTML = '<i class="fas fa-chart-line"></i>';
    Object.assign(btn.style, {
      position: 'fixed', bottom: '60px', left: '4px',
      width: '36px', height: '36px', borderRadius: '8px',
      border: '1px solid #3a3836', background: '#222120',
      color: '#cdccca', cursor: 'pointer', zIndex: '9999',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: '15px',
    });
    btn.addEventListener('click', () => game.user.isGM ? _openGM() : _openPlayer());
    document.body.appendChild(btn);
  });

  console.log('Крипто-симулятор | ready');
});

function _openGM() {
  if(!_gmApp) _gmApp = new GMApp();
  _gmApp.render(true);
}

function _openPlayer() {
  if(!_playerApp) _playerApp = new PlayerApp();
  _playerApp.render(true);
}

function _startTick() {
  if(_tickTimer) clearInterval(_tickTimer);
  const speed = game.settings.get(MODULE, 'tickSpeed') ?? 1500;
  _tickTimer = setInterval(async () => {
    if(!game.settings.get(MODULE, 'paused')) await tick();
  }, speed);
}

async function _handleTradeRequest(payload, senderId) {
  const { getMarket, setMarket, getBank, setBank, savePlayerState } = await import('./state.js');
  const { processTradeRequest } = await import('./market.js');
  const { emitToUser } = await import('./socket.js');

  const market = getMarket();
  const bank   = getBank();
  const result = processTradeRequest(payload, market, bank);

  if(result.ok) {
    await savePlayerState(payload.userId, result.player);
    await setMarket(market);
    await setBank(bank);
  }

  emitToUser(senderId, MSG.TRADE_RESULT, result);
}
