/**
 * FCS — Foundry Crypto Simulator bridge
 * Foundry VTT v13 / v14  (ApplicationV2)
 */

const MODULE_ID   = 'fcs-foundry';
const DEFAULT_URL = 'https://filardans-crypto-simulator-production.up.railway.app';

// ── Настройки модуля ─────────────────────────────────────────────────────────
Hooks.once('init', () => {

  game.settings.register(MODULE_ID, 'siteUrl', {
    name:    'Адрес сайта',
    hint:    'URL сервера Crypto Simulator. Можно поменять на свой хост.',
    scope:   'world',
    config:  true,
    type:    String,
    default: DEFAULT_URL,
    onChange: () => {
      if (_app && _app._state > 0) {
        _app.close();
        _app = null;
        openCryptoSim();
      }
    },
  });

  game.settings.register(MODULE_ID, 'windowWidth', {
    name:    'Ширина окна',
    hint:    'Ширина окна в пикселях.',
    scope:   'client',
    config:  true,
    type:    Number,
    default: 1280,
    range:   { min: 600, max: 2560, step: 40 },
  });

  game.settings.register(MODULE_ID, 'windowHeight', {
    name:    'Высота окна',
    hint:    'Высота окна в пикселях.',
    scope:   'client',
    config:  true,
    type:    Number,
    default: 820,
    range:   { min: 400, max: 1600, step: 40 },
  });

});

// ── Окно ─────────────────────────────────────────────────────────────────────
class CryptoSimApp extends foundry.applications.api.ApplicationV2 {

  static DEFAULT_OPTIONS = {
    id:      'crypto-sim-viewer',
    classes: ['fcs-window'],
    window: {
      title:       '📈 Crypto Simulator',
      resizable:   true,
      minimizable: true,
    },
    position: { width: 1280, height: 820, top: 40, left: 60 },
  };

  _getInitialPosition(options) {
    const w = game.settings.get(MODULE_ID, 'windowWidth');
    const h = game.settings.get(MODULE_ID, 'windowHeight');
    return { ...super._getInitialPosition(options), width: w, height: h };
  }

  _buildUrl() {
    const base = (game.settings.get(MODULE_ID, 'siteUrl') || DEFAULT_URL).replace(/\/$/, '');
    const params = new URLSearchParams({
      embedded: 'foundry',
      user:     game.user?.name ?? '',
      role:     game.user?.role ?? '',
    });
    return `${base}?${params.toString()}`;
  }

  async _renderHTML(context, options) {
    const url = this._buildUrl();
    return `
      <div class="fcs-iframe-wrap">
        <iframe
          id="fcs-iframe"
          src="${url}"
          allow="clipboard-read; clipboard-write"
          allowfullscreen
        ></iframe>
      </div>
    `;
  }

  _replaceHTML(result, content, options) {
    content.innerHTML = result;
  }

  _onRender(context, options) {
    super._onRender(context, options);
    const iframe = this.element.querySelector('#fcs-iframe');
    if (!iframe) return;
    iframe.addEventListener('load', () => {
      const base = (game.settings.get(MODULE_ID, 'siteUrl') || DEFAULT_URL).replace(/\/$/, '');
      try {
        iframe.contentWindow.postMessage({
          type:     'fcs:init',
          userName: game.user?.name ?? '',
          userRole: game.user?.role ?? '',
          world:    game.world?.title ?? '',
        }, base);
      } catch (_) {}
    });
  }
}

// ── Синглтон ─────────────────────────────────────────────────────────────────
let _app = null;
function openCryptoSim() {
  if (!_app || _app._state <= 0) _app = new CryptoSimApp();
  _app.render(true);
}

// ── Кнопка в Scene Controls ──────────────────────────────────────────────────
//
// В Foundry v13+ аргумент хука getSceneControlButtons — это объект вида:
//   { token: { tools: { ... } }, measure: { ... }, ... }
// Поэтому controls.push() не работает — его здесь нет.
// Правильный способ: добавить инструмент в уже существующую группу.
// Мы добавляем кнопку-действие (button: true) в группу «token».
//
Hooks.on('getSceneControlButtons', (controls) => {
  // Работает и в v13, и в v14
  const tokenGroup = controls.token ?? controls.tokens;
  if (!tokenGroup?.tools) return;

  tokenGroup.tools.fcsOpen = {
    name:    'fcsOpen',
    title:   'Открыть Crypto Simulator',
    icon:    'fas fa-chart-line',
    button:  true,
    // visible всем игрокам (включая не-GM)
    visible: true,
    onChange: () => openCryptoSim(),
  };
});

// ── Горячая клавиша ───────────────────────────────────────────────────────────
Hooks.once('ready', () => {
  game.keybindings.register(MODULE_ID, 'open', {
    name:     'Открыть Crypto Simulator',
    hint:     'Открывает окно симулятора в Foundry',
    editable: [{ key: 'KeyC', modifiers: ['Alt'] }],
    onDown:   openCryptoSim,
  });
  console.log(`[${MODULE_ID}] Готов. Alt+C — открыть симулятор.`);
});
