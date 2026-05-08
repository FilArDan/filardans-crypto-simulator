/**
 * FCS — Foundry Crypto Simulator bridge
 * Foundry VTT v13 / ApplicationV2
 *
 * Открывает внешний сайт симулятора в окне Foundry через iframe.
 * Никакой глубокой интеграции — сайт живёт отдельно на Railway.
 */

const MODULE_ID  = 'fcs-foundry';
const SITE_URL   = 'https://filardans-crypto-simulator-production.up.railway.app';

// ── Окно ─────────────────────────────────────────────────────────────────────
class CryptoSimApp extends foundry.applications.api.ApplicationV2 {

  static DEFAULT_OPTIONS = {
    id: 'crypto-sim-viewer',
    classes: ['fcs-window'],
    window: {
      title: '📈 Crypto Simulator',
      resizable: true,
      minimizable: true,
    },
    position: {
      width: 1280,
      height: 820,
      top: 40,
      left: 60,
    },
  };

  /** Передаём имя и роль игрока через query-параметры */
  _buildUrl() {
    const user = game.user;
    const params = new URLSearchParams({
      embedded: 'foundry',
      user:  user?.name  ?? '',
      role:  user?.role  ?? '',
    });
    return `${SITE_URL}?${params.toString()}`;
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

  /** postMessage-канал: Foundry → сайт */
  _onRender(context, options) {
    super._onRender(context, options);
    const iframe = this.element.querySelector('#fcs-iframe');
    if (!iframe) return;

    iframe.addEventListener('load', () => {
      try {
        iframe.contentWindow.postMessage({
          type:     'fcs:init',
          userName: game.user?.name ?? '',
          userRole: game.user?.role ?? '',
          world:    game.world?.title ?? '',
        }, SITE_URL);
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

// ── Кнопка в боковой панели (Scene Controls) ─────────────────────────────────
Hooks.on('getSceneControlButtons', (controls) => {
  // Добавляем отдельную группу инструментов «FCS»
  controls.push({
    name:  MODULE_ID,
    title: 'Crypto Simulator',
    icon:  'fas fa-chart-line',
    layer: 'controls',
    tools: [
      {
        name:    'open',
        title:   'Открыть симулятор',
        icon:    'fas fa-chart-line',
        button:  true,
        onClick: openCryptoSim,
      },
    ],
  });
});

// ── Горячая клавиша ───────────────────────────────────────────────────────────
Hooks.once('ready', () => {
  game.keybindings.register(MODULE_ID, 'open', {
    name:     'Открыть Crypto Simulator',
    hint:     'Открывает окно симулятора прямо в Foundry',
    editable: [{ key: 'KeyC', modifiers: ['Alt'] }],
    onDown:   openCryptoSim,
  });

  console.log(`[${MODULE_ID}] Готов. Alt+C — открыть симулятор.`);
});
