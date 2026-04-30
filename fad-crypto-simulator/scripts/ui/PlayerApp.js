// ===== ОКНО ИГРОКА — прямые DOM-обновления =====
import { getMarket, getPlayerState } from '../state.js';
import { SYMS } from '../coins.js';
import { fmt, fmtC, portV } from '../utils.js';
import { emitToGM, MSG } from '../socket.js';

let _marketCache = null;

export class PlayerApp extends Application {

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id:        'crypto-player-panel',
      title:     "📈 FilArDan's Crypto Simulator",
      template:  'modules/fad-crypto-simulator/templates/player.hbs',
      width:     520,
      height:    640,
      resizable: true,
    });
  }

  // getData нужен только для первого рендера — передаём список монет для <select>
  getData() {
    const market = _marketCache ?? getMarket();
    return {
      coinList: SYMS.map(s => ({
        sym:  s,
        name: market.coins[s].name,
      }))
    };
  }

  activateListeners(html) {
    super.activateListeners(html);
    const h = html[0];

    h.querySelector('#csp-buy')?.addEventListener('click', () => this._trade('buy', h));
    h.querySelector('#csp-sell')?.addEventListener('click', () => this._trade('sell', h));
    h.querySelector('#csp-sell-all')?.addEventListener('click', () => {
      const sym = h.querySelector('#csp-coin')?.value ?? SYMS[0];
      const ps  = getPlayerState(game.user.id);
      const amt = ps.held[sym] ?? 0;
      if(amt <= 0) { this._setMsg('❌ Нечего продавать.', false); return; }
      this._dispatch('sell', sym, amt);
    });

    // Первый рендер данных
    this._updateDOM();
  }

  // Вызывается из main.js при любом обновлении
  onUpdate({ type, payload }) {
    if(type === MSG.TICK_UPDATE && payload?.market) {
      _marketCache = payload.market;
    }
    if(type === MSG.TRADE_RESULT) {
      this._setMsg(payload.msg, payload.ok);
    }
    this._updateDOM();
  }

  // ===== ПРЯМОЕ ОБНОВЛЕНИЕ DOM — без перерисовки =====
  _updateDOM() {
    const el = id => document.querySelector(`#${id}`);
    const market = _marketCache ?? getMarket();
    const ps     = getPlayerState(game.user.id);
    const coins  = market.coins;

    if(!el('csp-cash')) return; // окно ещё не отрисовано

    const portVal = portV(ps.held, coins);
    const total   = ps.cash + portVal;
    const pnl     = total - 10000;

    // Статы
    el('csp-cash').textContent  = fmt(ps.cash);
    el('csp-port').textContent  = fmt(portVal);
    el('csp-total').textContent = fmt(total);
    el('csp-pnl').textContent   = fmt(pnl);
    el('csp-pnl').className     = 'csp-val ' + (pnl >= 0 ? 'csp-up' : 'csp-dn');

    // Заморозка
    const frozenBar = el('csp-frozen-bar');
    if(frozenBar) frozenBar.style.display = ps.frozen ? 'block' : 'none';

    // Долг
    const loanBar = el('csp-loan-bar');
    if(loanBar) {
      loanBar.style.display = (ps.loan > 0) ? 'flex' : 'none';
      if(ps.loan > 0) {
        const lv = el('csp-loan-val');
        if(lv) lv.textContent = fmt(ps.loan);
      }
    }

    // Кнопки — дизейблим если заморожен
    ['csp-buy','csp-sell','csp-sell-all'].forEach(id => {
      const btn = el(id);
      if(btn) btn.disabled = !!ps.frozen;
    });

    // Обновляем цены в select
    const sel = el('csp-coin');
    if(sel) {
      [...sel.options].forEach(opt => {
        const s = opt.value;
        if(coins[s]) opt.textContent = `${coins[s].name} (${s}) — ${fmt(coins[s].price)}`;
        if(ps.sanctions?.[s]) {
          opt.textContent += ' 🚫';
          opt.disabled = true;
        } else {
          opt.disabled = false;
        }
      });
    }

    // Монеты
    const holdings = el('csp-holdings');
    if(holdings) {
      holdings.innerHTML = SYMS.map(s => {
        const own  = ps.held[s] ?? 0;
        const avg  = ps.avgP[s] ?? 0;
        const val  = own * coins[s].price;
        const pnlH = own > 0 ? val - own * avg : 0;
        const sanctioned = ps.sanctions?.[s] ? 'csp-item-sanctioned' : '';
        return `<div class="csp-item ${sanctioned}">
          <div class="csp-ir">
            <strong><span style="color:${coins[s].col}">●</span> ${coins[s].name} (${s})</strong>
            <span>${fmt(coins[s].price)}</span>
          </div>
          <div class="csp-sm">
            У тебя: <b>${fmtC(own)} ${s}</b> &nbsp;|&nbsp; Ср. цена: ${avg ? fmt(avg) : '—'}<br>
            Стоимость: <b>${fmt(val)}</b> &nbsp;|&nbsp;
            P/L: <span class="${pnlH >= 0 ? 'csp-up' : 'csp-dn'}">${fmt(pnlH)}</span>
            ${ps.sanctions?.[s] ? '&nbsp;<span style="color:var(--csp-dan)">🚫 Санкции</span>' : ''}
          </div>
        </div>`;
      }).join('');
    }

    // История
    const hist = el('csp-history');
    if(hist) {
      const entries = [...(ps.hist ?? [])].reverse().slice(0, 40);
      hist.innerHTML = entries.length
        ? entries.map(h => `<div class="csp-item">
            <div class="csp-ir">
              <span class="${h.t === 'B' ? 'csp-buy-lbl' : 'csp-sell-lbl'}">
                ${h.t === 'B' ? '📈 Покупка' : '📉 Продажа'} ${h.s}
              </span>
              <span style="font-size:11px;color:var(--csp-mu)">${h.time}</span>
            </div>
            <div class="csp-sm">
              ${fmtC(h.a)} × ${fmt(h.p)} = <b>${fmt(h.tot)}</b>
            </div>
          </div>`).join('')
        : '<div class="csp-item" style="color:var(--csp-mu)">Пока нет сделок.</div>';
    }
  }

  _trade(action, h) {
    const sym = h.querySelector('#csp-coin')?.value ?? SYMS[0];
    const raw = parseFloat(h.querySelector('#csp-amt')?.value);
    if(!raw || raw <= 0) { this._setMsg('❌ Введи количество больше нуля.', false); return; }
    this._dispatch(action, sym, raw);
  }

  _dispatch(action, sym, amount) {
    const ps = getPlayerState(game.user.id);
    if(ps.frozen)           { this._setMsg('❌ Счёт заморожен ГМом.', false); return; }
    if(ps.sanctions?.[sym]) { this._setMsg(`❌ Торговля ${sym} заблокирована.`, false); return; }
    emitToGM(MSG.TRADE_REQUEST, { userId: game.user.id, action, sym, amount });
    this._setMsg('⏳ Отправляем заявку...', true);
  }

  _setMsg(text, ok) {
    const el = document.querySelector('#csp-msg');
    if(!el) return;
    el.textContent = text;
    el.style.color = ok ? 'var(--csp-ok)' : 'var(--csp-dan)';
  }
}