// ===== ПАНЕЛЬ ГМ =====
import { getMarket, setMarket, getPlayers, setPlayers, getBots, setBots, getBank, isPaused, setPaused, savePlayerState, getPlayerState } from '../state.js';
import { SYMS, FEE, START_CASH } from '../coins.js';
import { fmt, fmtC, fmtLarge, portV } from '../utils.js';
import { emitToAll, MSG } from '../socket.js';
import { tick } from '../market.js';

export class GMApp extends Application {

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id:        'crypto-gm-panel',
      title:     '🏦 Крипто-симулятор — Панель ГМ',
      template:  'modules/fad-crypto-simulator/templates/gm.hbs',
      width:     900,
      height:    700,
      resizable: true,
      tabs: [{ navSelector: '.cs-tabs', contentSelector: '.cs-body', initial: 'market' }],
    });
  }

  // ---------- данные для шаблона ----------
  getData() {
    const market  = getMarket();
    const players = getPlayers();
    const bots    = getBots();
    const bank    = getBank();

    // Собираем список реальных игроков мира
    const userList = game.users.filter(u => !u.isGM).map(u => {
      const ps = getPlayerState(u.id);
      return {
        id:       u.id,
        name:     u.name,
        color:    u.color,
        online:   u.active,
        cash:     ps.cash,
        cashFmt:  fmt(ps.cash),
        portFmt:  fmt(portV(ps.held, market.coins)),
        loan:     ps.loan,
        loanFmt:  fmt(ps.loan),
        frozen:   ps.frozen,
        sanctions: ps.sanctions,
        held:     SYMS.map(s => ({
          sym: s, name: market.coins[s].name,
          col: market.coins[s].col,
          amt: fmtC(ps.held[s]),
          val: fmt(ps.held[s] * market.coins[s].price),
          sanctioned: !!ps.sanctions?.[s],
        })),
      };
    });

    // Монеты для рыночной панели
    const coinList = SYMS.map(s => ({
      sym:      s,
      name:     market.coins[s].name,
      col:      market.coins[s].col,
      price:    fmt(market.coins[s].price),
      supply:   fmtLarge(market.coins[s].supply),
      vol:      Math.round(market.vol[s] * 100),
      drift:    Math.round(market.drift[s] / 0.05 * 100),
    }));

    // Лидерборд (игроки + боты)
    const leaderboard = [
      ...userList.map(u => ({
        name:  u.name,
        total: fmt(u.cash + portV(
          Object.fromEntries(SYMS.map(s => [s, getPlayerState(u.id).held[s]])),
          market.coins
        )),
        isPlayer: true,
      })),
      ...bots.map(b => ({
        name:  b.name + ' [бот]',
        total: fmt(b.cash + portV(b.held, market.coins)),
        isPlayer: false,
      })),
    ].sort((a, b) => parseFloat(b.total.replace(/[^0-9.-]/g,'')) - parseFloat(a.total.replace(/[^0-9.-]/g,'')));

    return {
      paused:      isPaused(),
      bankCash:    fmt(bank.cash),
      bankRate:    (bank.loanRate * 100).toFixed(3) + '%',
      coinList,
      userList,
      bots,
      botsJson:    JSON.stringify(bots),
      leaderboard,
    };
  }

  // ---------- события ----------
  activateListeners(html) {
    super.activateListeners(html);
    const $ = sel => html[0].querySelector(sel);
    const $$ = sel => html[0].querySelectorAll(sel);

    // Пауза / старт
    $('[data-action="toggle-pause"]')?.addEventListener('click', async () => {
      await setPaused(!isPaused());
      this.render();
    });

    // Сброс рынка
    $('[data-action="reset-market"]')?.addEventListener('click', async () => {
      if(!confirm('Сбросить рынок к начальным ценам?')) return;
      const m = getMarket();
      SYMS.forEach(s => { m.coins[s].price = m.coins[s].basePrice; });
      await setMarket(m);
      emitToAll(MSG.FORCE_REFRESH, {});
      this.render();
    });

    // Шоки
    $$('[data-action="shock"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const sym = btn.dataset.sym;
        const pct = parseFloat(btn.dataset.pct);
        const m   = getMarket();
        m.coins[sym].price = Math.max(0.01, +(m.coins[sym].price * (1 + pct)).toFixed(2));
        m.pd[sym].push(m.coins[sym].price);
        if(m.pd[sym].length > 300) m.pd[sym].shift();
        await setMarket(m);
        emitToAll(MSG.TICK_UPDATE, { market: m, bank: getBank(), bots: getBots() });
        this.render();
      });
    });

    // Тренд
    $$('[data-action="drift"]').forEach(inp => {
      inp.addEventListener('input', async () => {
        const sym = inp.dataset.sym;
        const m   = getMarket();
        m.drift[sym] = (inp.value / 100) * 0.05;
        inp.nextElementSibling.textContent = (inp.value > 0 ? '+' : '') + inp.value + '%';
        await setMarket(m);
      });
    });

    // Волатильность
    $$('[data-action="vol"]').forEach(inp => {
      inp.addEventListener('input', async () => {
        const sym = inp.dataset.sym;
        const m   = getMarket();
        m.vol[sym] = inp.value / 100;
        inp.nextElementSibling.textContent = inp.value + '%';
        await setMarket(m);
      });
    });

    // Прямое задание цены
    $$('[data-action="set-price"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const sym = btn.dataset.sym;
        const inp = html[0].querySelector(`[data-price-input="${sym}"]`);
        const v   = parseFloat(inp.value);
        if(!v || v <= 0) return;
        const m = getMarket();
        m.coins[sym].price = +v.toFixed(2);
        m.pd[sym].push(m.coins[sym].price);
        if(m.pd[sym].length > 300) m.pd[sym].shift();
        await setMarket(m);
        inp.value = '';
        emitToAll(MSG.TICK_UPDATE, { market: m, bank: getBank(), bots: getBots() });
        this.render();
      });
    });

    // ---- Вкладка ИГРОКИ ----

    // Задать баланс игрока
    $$('[data-action="set-cash"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const uid = btn.dataset.uid;
        const inp = html[0].querySelector(`[data-cash-input="${uid}"]`);
        const v   = parseFloat(inp.value);
        if(isNaN(v) || v < 0) return;
        const ps  = getPlayerState(uid);
        ps.cash   = v;
        await savePlayerState(uid, ps);
        inp.value = '';
        emitToAll(MSG.FORCE_REFRESH, {});
        this.render();
      });
    });

    // Заморозить / разморозить счёт
    $$('[data-action="toggle-freeze"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const uid = btn.dataset.uid;
        const ps  = getPlayerState(uid);
        ps.frozen = !ps.frozen;
        await savePlayerState(uid, ps);
        emitToAll(MSG.FORCE_REFRESH, {});
        this.render();
      });
    });

    // Санкция по активу
    $$('[data-action="toggle-sanction"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const uid = btn.dataset.uid;
        const sym = btn.dataset.sym;
        const ps  = getPlayerState(uid);
        if(!ps.sanctions) ps.sanctions = {};
        ps.sanctions[sym] = !ps.sanctions[sym];
        await savePlayerState(uid, ps);
        emitToAll(MSG.FORCE_REFRESH, {});
        this.render();
      });
    });

    // Конфисковать актив
    $$('[data-action="confiscate"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const uid = btn.dataset.uid;
        const sym = btn.dataset.sym;
        const ps  = getPlayerState(uid);
        const m   = getMarket();
        const val = ps.held[sym] * m.coins[sym].price;
        ps.held[sym] = 0; ps.avgP[sym] = 0;
        ui.notifications.info(`Конфисковано ${sym} у ${game.users.get(uid)?.name} (стоимость: ${fmt(val)})`);
        await savePlayerState(uid, ps);
        emitToAll(MSG.FORCE_REFRESH, {});
        this.render();
      });
    });

    // Перевод между игроками
    $('[data-action="transfer"]')?.addEventListener('click', async () => {
      const fromId = $('[data-transfer="from"]').value;
      const toId   = $('[data-transfer="to"]').value;
      const amount = parseFloat($('[data-transfer="amount"]').value);
      if(!fromId || !toId || fromId === toId || !amount || amount <= 0) return;
      const from = getPlayerState(fromId);
      const to   = getPlayerState(toId);
      if(from.cash < amount) { ui.notifications.warn('Недостаточно средств у отправителя.'); return; }
      from.cash -= amount;
      to.cash   += amount;
      await savePlayerState(fromId, from);
      await savePlayerState(toId, to);
      ui.notifications.info(`Переведено ${fmt(amount)} от ${game.users.get(fromId)?.name} → ${game.users.get(toId)?.name}`);
      emitToAll(MSG.FORCE_REFRESH, {});
      this.render();
    });

    // ---- Вкладка БОТЫ ----
    $('[data-action="add-bot"]')?.addEventListener('click', async () => {
      const name = $('[data-bot-input="name"]').value.trim() || 'Бот';
      const type = $('[data-bot-input="type"]').value;
      const cash = parseFloat($('[data-bot-input="cash"]').value) || 10000;
      const bots = getBots();
      bots.push({
        name, type, cash,
        held: Object.fromEntries(SYMS.map(s => [s, 0])),
        avgP: Object.fromEntries(SYMS.map(s => [s, 0])),
        ...(type === 'croc' ? { target: Object.fromEntries(SYMS.map(s => [s, 1.25 + Math.random() * 0.2])) } : {})
      });
      await setBots(bots);
      this.render();
    });

    $$('[data-action="remove-bot"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const i    = parseInt(btn.dataset.idx);
        const bots = getBots();
        bots.splice(i, 1);
        await setBots(bots);
        this.render();
      });
    });

    $$('[data-action="set-bot-cash"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const i   = parseInt(btn.dataset.idx);
        const inp = html[0].querySelector(`[data-bot-cash-input="${i}"]`);
        const v   = parseFloat(inp.value);
        if(isNaN(v) || v < 0) return;
        const bots  = getBots();
        bots[i].cash = v;
        await setBots(bots);
        inp.value = '';
        this.render();
      });
    });
  }
}
