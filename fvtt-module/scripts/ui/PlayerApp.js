// ===== ОКНО ИГРОКА =====
import { getMarket, getPlayerState, savePlayerState } from '../state.js';
import { SYMS, FEE } from '../coins.js';
import { fmt, fmtC, portV } from '../utils.js';
import { emitToGM, setupSocket, MSG } from '../socket.js';

export class PlayerApp extends Application {

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id:        'crypto-player-panel',
      title:     '📈 Крипто-симулятор',
      template:  'modules/crypto-simulator/templates/player.hbs',
      width:     480,
      height:    620,
      resizable: true,
      tabs: [{ navSelector: '.cs-tabs', contentSelector: '.cs-body', initial: 'trade' }],
    });
  }

  // Последнее сообщение о сделке
  _msg = '';
  _msgOk = true;

  getData() {
    const market = getMarket();
    const ps     = getPlayerState(game.user.id);
    const coins  = market.coins;

    const total  = ps.cash + portV(ps.held, coins);
    const pnl    = total - 10000; // относительно старта

    const coinList = SYMS.map(s => {
      const own = ps.held[s] ?? 0;
      const avg = ps.avgP[s] ?? 0;
      const val = own * coins[s].price;
      const pnlH = own > 0 ? val - own * avg : 0;
      return {
        sym:      s,
        name:     coins[s].name,
        col:      coins[s].col,
        price:    fmt(coins[s].price),
        own:      fmtC(own),
        avg:      avg ? fmt(avg) : '—',
        val:      fmt(val),
        pnlH:     fmt(pnlH),
        pnlUp:    pnlH >= 0,
        sanctioned: !!ps.sanctions?.[s],
      };
    });

    // История — только сделки этого игрока
    const hist = [...(ps.hist ?? [])].reverse().slice(0, 50).map(h => ({
      buy:  h.t === 'B',
      sym:  h.s,
      amt:  fmtC(h.a),
      price: fmt(h.p),
      tot:  fmt(h.tot),
      time: h.time,
    }));

    return {
      frozen:   ps.frozen,
      cashFmt:  fmt(ps.cash),
      portFmt:  fmt(portV(ps.held, coins)),
      totalFmt: fmt(total),
      pnlFmt:   fmt(pnl),
      pnlUp:    pnl >= 0,
      loan:     ps.loan > 0,
      loanFmt:  fmt(ps.loan ?? 0),
      loanRate: market.loanRate ? (market.loanRate * 100).toFixed(3) + '%' : '—',
      coinList,
      hist,
      msg:      this._msg,
      msgOk:    this._msgOk,
      selSym:   this._selSym ?? SYMS[0],
    };
  }

  activateListeners(html) {
    super.activateListeners(html);
    const h = html[0];

    // Выбор монеты обновляет инфо
    h.querySelector('[data-action="sel-coin"]')?.addEventListener('change', e => {
      this._selSym = e.target.value;
      this.render();
    });

    // Купить
    h.querySelector('[data-action="buy"]')?.addEventListener('click', () => {
      this._sendTrade('buy', h);
    });

    // Продать
    h.querySelector('[data-action="sell"]')?.addEventListener('click', () => {
      this._sendTrade('sell', h);
    });

    // Продать всё по выбранной монете
    h.querySelector('[data-action="sell-all"]')?.addEventListener('click', () => {
      const sym = h.querySelector('[data-action="sel-coin"]')?.value ?? SYMS[0];
      const ps  = getPlayerState(game.user.id);
      const amt = ps.held[sym] ?? 0;
      if(amt <= 0) { this._setMsg('❌ Нечего продавать.', false); this.render(); return; }
      this._dispatch('sell', sym, amt);
    });
  }

  _sendTrade(action, h) {
    const sym = h.querySelector('[data-action="sel-coin"]')?.value ?? SYMS[0];
    const raw = parseFloat(h.querySelector('[data-trade-amt]')?.value);
    if(!raw || raw <= 0) { this._setMsg('❌ Введи количество больше нуля.', false); this.render(); return; }
    this._dispatch(action, sym, raw);
  }

  _dispatch(action, sym, amount) {
    const ps = getPlayerState(game.user.id);
    if(ps.frozen) { this._setMsg('❌ Счёт заморожен ГМом.', false); this.render(); return; }
    if(ps.sanctions?.[sym]) { this._setMsg(`❌ Торговля ${sym} заблокирована санкциями.`, false); this.render(); return; }

    emitToGM(MSG.TRADE_REQUEST, { userId: game.user.id, action, sym, amount });
    this._setMsg('⏳ Отправляем заявку...', true);
    this.render();
  }

  _setMsg(text, ok) { this._msg = text; this._msgOk = ok; }

  // Вызывается из main.js при получении TRADE_RESULT / TICK_UPDATE
  onUpdate(msg) {
    if(msg.type === MSG.TRADE_RESULT) {
      this._setMsg(msg.payload.msg, msg.payload.ok);
    }
    this.render();
  }
}
