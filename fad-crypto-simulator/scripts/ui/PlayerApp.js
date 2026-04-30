// ===== ОКНО ИГРОКА =====
import { getMarket, getPlayerState } from '../state.js';
import { SYMS } from '../coins.js';
import { fmt, fmtC, portV } from '../utils.js';
import { emitToGM, MSG } from '../socket.js';

const CHART_CDN = 'https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js';

export class PlayerApp extends Application {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: 'crypto-player-panel',
      title: "📈 FilArDan's Crypto Simulator",
      template: 'modules/fad-crypto-simulator/templates/player.hbs',
      width: 560, height: 680, resizable: true,
    });
  }

  _chart = null; _chartSym = SYMS[0]; _chartRange = 40;

  getData() {
    const market = getMarket();
    return { coinList: SYMS.map(s => ({ sym: s, name: market.coins[s].name })) };
  }

  async activateListeners(html) {
    super.activateListeners(html);
    const h = html[0];

    // Табы
    h.querySelectorAll('.csp-tab').forEach(btn =>
      btn.addEventListener('click', () => {
        h.querySelectorAll('.csp-tab, .csp-pane').forEach(e => e.classList.remove('active'));
        btn.classList.add('active');
        h.querySelector(`#csp-tab-${btn.dataset.tab}`)?.classList.add('active');
        if (btn.dataset.tab === 'chart') this._renderChart();
      })
    );

    // Торговля
    h.querySelector('#csp-buy')?.addEventListener('click', () => this._trade('buy', h));
    h.querySelector('#csp-sell')?.addEventListener('click', () => this._trade('sell', h));
    h.querySelector('#csp-sell-all')?.addEventListener('click', () => {
      const sym = h.querySelector('#csp-coin')?.value ?? SYMS[0];
      const amt = getPlayerState(game.user.id).held[sym] ?? 0;
      if (amt <= 0) { this._setMsg('❌ Нечего продавать.', false); return; }
      this._dispatch('sell', sym, amt);
    });

    await this._loadChartJs();
    this._buildChartTabs(h);
    h.querySelectorAll('.csp-rbtn').forEach(btn =>
      btn.addEventListener('click', () => {
        h.querySelectorAll('.csp-rbtn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this._chartRange = +btn.dataset.range;
        this._updateChartLive();
      })
    );

    this._updateDOM();
  }

  // Вызывается из main.js при TICK_UPDATE
  onTick() { this._updateDOM(); this._updateChartLive(); }

  // Вызывается при TRADE_RESULT
  onUpdate({ type, msg, ok }) {
    if (type === MSG.TRADE_RESULT) this._setMsg(msg, ok);
    this._updateDOM();
  }

  _updateDOM() {
    const $ = id => document.getElementById(id);
    const market = getMarket();
    const ps     = getPlayerState(game.user.id);
    const coins  = market.coins;
    if (!$('csp-cash')) return;

    const pv    = portV(ps.held, coins);
    const total = ps.cash + pv;
    const pnl   = total - 10000;

    $('csp-cash').textContent  = fmt(ps.cash);
    $('csp-port').textContent  = fmt(pv);
    $('csp-total').textContent = fmt(total);
    $('csp-pnl').textContent   = fmt(pnl);
    $('csp-pnl').className     = 'csp-val ' + (pnl >= 0 ? 'csp-up' : 'csp-dn');

    const fb = $('csp-frozen-bar');
    if (fb) fb.style.display = ps.frozen ? 'block' : 'none';
    const lb = $('csp-loan-bar');
    if (lb) { lb.style.display = (ps.loan ?? 0) > 0 ? 'flex' : 'none'; }
    const lv = $('csp-loan-val');
    if (lv) lv.textContent = fmt(ps.loan ?? 0);

    ['csp-buy','csp-sell','csp-sell-all'].forEach(id => {
      const b = $(id); if (b) b.disabled = !!ps.frozen;
    });

    // Цены в select
    const sel = $('csp-coin');
    if (sel) [...sel.options].forEach(opt => {
      const s = opt.value; if (!coins[s]) return;
      opt.textContent = `${coins[s].name} (${s}) — ${fmt(coins[s].price)}`;
      opt.disabled = !!ps.sanctions?.[s];
      if (ps.sanctions?.[s]) opt.textContent += ' 🚫';
    });

    // Цены на кнопках чарта
    document.querySelectorAll('[data-cprice]').forEach(el => {
      const s = el.dataset.cprice;
      if (coins[s]) el.textContent = fmt(coins[s].price);
    });

    // Портфель
    const hld = $('csp-holdings');
    if (hld) hld.innerHTML = SYMS.map(s => {
      const own = ps.held[s] ?? 0, avg = ps.avgP[s] ?? 0;
      const val = own * coins[s].price;
      const ph  = own > 0 ? val - own * avg : 0;
      return `<div class="csp-item${ps.sanctions?.[s] ? ' csp-sanc' : ''}">
        <div class="csp-ir"><b><span style="color:${coins[s].col}">●</span> ${coins[s].name} (${s})</b><span>${fmt(coins[s].price)}</span></div>
        <div class="csp-sm">У тебя: <b>${fmtC(own)} ${s}</b> · Ср: ${avg ? fmt(avg) : '—'}<br>
        Стоимость: <b>${fmt(val)}</b> · P/L: <span class="${ph>=0?'csp-up':'csp-dn'}">${fmt(ph)}</span>
        ${ps.sanctions?.[s]?'<span style="color:#dd6974"> 🚫</span>':''}</div></div>`;
    }).join('');

    // История
    const hst = $('csp-history');
    if (hst) {
      const e = [...(ps.hist ?? [])].reverse().slice(0, 50);
      hst.innerHTML = e.length
        ? e.map(h => `<div class="csp-item">
            <div class="csp-ir"><span class="${h.t==='B'?'csp-blbl':'csp-slbl'}">${h.t==='B'?'📈 Покупка':'📉 Продажа'} ${h.s}</span>
            <span class="csp-time">${h.time}</span></div>
            <div class="csp-sm">${fmtC(h.a)} × ${fmt(h.p)} = <b>${fmt(h.tot)}</b></div></div>`).join('')
        : '<div class="csp-item csp-empty">Пока нет сделок.</div>';
    }
  }

  // ── Чарт ──────────────────────────────────────────────────────────────────
  async _loadChartJs() {
    if (window.Chart) return;
    return new Promise(res => {
      const s = document.createElement('script');
      s.src = CHART_CDN; s.onload = res;
      s.onerror = () => console.warn('[CSP] Chart.js не загрузился');
      document.head.appendChild(s);
    });
  }

  _buildChartTabs(h) {
    const ct = h.querySelector('#csp-ctabs'); if (!ct) return;
    const market = getMarket();
    ct.innerHTML = SYMS.map((s, i) =>
      `<button class="csp-ctab${i===0?' active':''}" data-sym="${s}">
        <span style="color:${market.coins[s].col}">●</span> ${s}
        <span data-cprice="${s}">${fmt(market.coins[s].price)}</span>
      </button>`).join('');
    ct.querySelectorAll('.csp-ctab').forEach(btn =>
      btn.addEventListener('click', () => {
        ct.querySelectorAll('.csp-ctab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this._chartSym = btn.dataset.sym;
        this._renderChart();
      })
    );
  }

  _chartData() {
    const raw = (getMarket().pd[this._chartSym] ?? []).filter(Number.isFinite);
    return this._chartRange === 0 ? raw : raw.slice(-this._chartRange);
  }

  _renderChart() {
    if (!window.Chart) return;
    const canvas = document.getElementById('csp-chart'); if (!canvas) return;
    const c = getMarket().coins[this._chartSym];
    const d = this._chartData();
    const gc = 'rgba(255,255,255,.07)', tc = '#797876';
    if (this._chart) this._chart.destroy();
    this._chart = new Chart(canvas, {
      type: 'line',
      data: {
        labels: d.map((_,i) => i+1),
        datasets: [{ data: d, borderColor: c.col, backgroundColor: c.col+'28',
          borderWidth: 2.5, tension: .35, fill: true,
          pointRadius: 0, pointHoverRadius: 5,
          pointHoverBackgroundColor: c.col, pointHoverBorderColor: '#fff', pointHoverBorderWidth: 2 }]
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: { displayColors: false,
            callbacks: { title: i=>`Тик ${i[0].label}`, label: x=>`Цена: ${fmt(x.parsed.y)}` },
            backgroundColor: '#1c1b19', titleColor: '#797876', bodyColor: '#cdccca',
            bodyFont: { weight:'700', size:13 }, borderColor: gc, borderWidth: 1, padding: 10 }
        },
        scales: {
          x: { ticks: { color: tc, maxTicksLimit: 6 }, grid: { color: gc } },
          y: { ticks: { color: tc, callback: v => fmt(v) }, grid: { color: gc } }
        }
      }
    });
    const info = document.getElementById('csp-chart-info');
    if (info) info.textContent = `${c.name}: ${fmt(c.price)}`;
  }

  _updateChartLive() {
    if (!this._chart || !window.Chart) return;
    const d = this._chartData();
    const c = getMarket().coins[this._chartSym];
    this._chart.data.labels = d.map((_,i) => i+1);
    this._chart.data.datasets[0].data = d;
    this._chart.data.datasets[0].borderColor = c.col;
    this._chart.data.datasets[0].backgroundColor = c.col + '28';
    this._chart.update('none');
    const info = document.getElementById('csp-chart-info');
    if (info) info.textContent = `${c.name}: ${fmt(c.price)}`;
  }

  _trade(action, h) {
    const sym = h.querySelector('#csp-coin')?.value ?? SYMS[0];
    const raw = parseFloat(h.querySelector('#csp-amt')?.value);
    if (!raw || raw <= 0) { this._setMsg('❌ Введи количество больше нуля.', false); return; }
    this._dispatch(action, sym, raw);
  }

  _dispatch(action, sym, amount) {
    const ps = getPlayerState(game.user.id);
    if (ps.frozen)           { this._setMsg('❌ Счёт заморожен.', false); return; }
    if (ps.sanctions?.[sym]) { this._setMsg(`❌ Торговля ${sym} заблокирована.`, false); return; }
    emitToGM(MSG.TRADE_REQUEST, { userId: game.user.id, action, sym, amount });
    this._setMsg('⏳ Отправляем заявку...', true);
  }

  _setMsg(text, ok) {
    const el = document.getElementById('csp-msg'); if (!el) return;
    el.textContent = text;
    el.style.color = ok ? 'var(--csp-ok)' : 'var(--csp-dan)';
  }

  close(o) { 