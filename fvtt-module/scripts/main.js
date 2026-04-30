// ===== ТОЧКА ВХОДА =====
import { registerSettings, getPlayerState } from './state.js';
import { setupSocket, MSG } from './socket.js';
import { tick } from './market.js';
import { GMApp } from './ui/GMApp.js';
import { PlayerApp } from './ui/PlayerApp.js';

const MODULE = 'crypto-simulator';
let _tickTimer  = null;
let _playerApp  = null;

Hooks.once('init', () => {
  registerSettings();
  Handlebars.registerHelper('add', (a, b) => a + b);
  Handlebars.registerHelper('eq',  (a, b) => a === b);
  console.log('Крипто-симулятор | init');
});

Hooks.once('ready', async () => {
  setupSocket({
    // ГМ получает запросы на сделку
    [MSG.TRADE_REQUEST]: (payload, senderId) => {
      if(!game.user.isGM) return;
      _handleTradeRequest(payload, senderId);
    },
    // Игрок получает результат сделки
    [MSG.TRADE_RESULT]: (payload) => {
      if(game.user.isGM) return;
      _playerApp?.onUpdate({ type: MSG.TRADE_RESULT, payload });
    },
    // Всем: обновление тика
    [MSG.TICK_UPDATE]: (payload) => {
      if(game.user.isGM) return;
      _playerApp?.onUpdate({ type: MSG.TICK_UPDATE, payload });
    },
    // Всем: принудительный рефреш (санкции, заморозка, баланс от ГМ)
    [MSG.FORCE_REFRESH]: () => {
      _playerApp?.render();
    },
  });

  if(game.user.isGM) {
    _startTick();

    // Кнопка ГМ-панели в тулбаре
    Hooks.on('getSceneControlButtons', controls => {
      const bar = controls.find(c => c.name === 'token');
      if(!bar) return;
      bar.tools.push({
        name:    'crypto-gm',
        title:   '🏦 Крипто-симулятор (ГМ)',
        icon:    'fas fa-chart-line',
        onClick: () => new GMApp().render(true),
        button:  true,
      });
    });

  } else {
    // Игрок: автоматически открываем окно
    _playerApp = new PlayerApp();
    _playerApp.render(true);

    // Кнопка для повторного открытия если закрыли
    Hooks.on('getSceneControlButtons', controls => {
      const bar = controls.find(c => c.name === 'token');
      if(!bar) return;
      bar.tools.push({
        name:    'crypto-player',
        title:   '📈 Мой торговый терминал',
        icon:    'fas fa-coins',
        onClick: () => {
          if(!_playerApp) _playerApp = new PlayerApp();
          _playerApp.render(true);
        },
        button: true,
      });
    });
  }

  console.log('Крипто-симулятор | ready');
});

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
