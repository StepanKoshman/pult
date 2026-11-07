'use strict';
/* Общие окна: показание, таблица, тренд, запись, консоль, настройки, величины. */

function quantityOptions(selected) {
  const o = [];
  for (const q of Hub.list()) o.push([q.id, `${Devices.get(q.dev)?.title || q.dev} · ${q.name}`]);
  if (selected && !Hub.q.has(selected)) o.unshift([selected, `${selected} (нет прибора)`]);
  return o;
}
function qSelect(value, onchange) {
  const fill = () => { const v = s.value; s.replaceChildren(); for (const [id, t] of quantityOptions(v)) s.append(h('option', { value: id, text: t })); s.value = v; };
  const s = select(quantityOptions(value), value, onchange, 'Величина');
  s.fill = fill; return s;
}

function setDigits(el, text) {
  if (document.documentElement.dataset.seg === '1') {
    if (el.dataset.t !== text) { el.innerHTML = segSvg(text); el.dataset.t = text; }
  } else { el.dataset.t = ''; el.textContent = text; }
}

/* ---------- большое показание ---------- */
WM.define('reading', {
  title: 'Показание', w: 400, h: 248,
  make(win, _, cfg) {
    cfg.q ??= Hub.list()[0]?.id; cfg.digits ??= 6; cfg.stats ??= true; cfg.bar ??= true;
    const sel = qSelect(cfg.q, v => { cfg.q = v; WM.save(); bind(); });
    const dg = select([[4, '4 зн.'], [5, '5 зн.'], [6, '6 зн.'], [7, '7 зн.']], cfg.digits, v => { cfg.digits = +v; WM.save(); }, 'Разрядность');
    const stBtn = toggle('Стат.', cfg.stats, v => { cfg.stats = v; apply(); WM.save(); });
    win.toolbar.append(dg, stBtn);
    const num = h('div', { class: 'digits' }), unit = h('div', { class: 'unit' });
    const big = h('div', { class: 'big', role: 'status', 'aria-live': 'off' }, num, unit);
    const fill = h('i', { class: 'fill' }), bar = h('div', { class: 'bargraph' }, fill, h('span', { class: 'ticks' }));
    const cells = {}, stats = h('div', { class: 'stats' });
    for (const [k, t] of [['min', 'Мин'], ['max', 'Макс'], ['mean', 'Среднее'], ['sd', 'σ'], ['cnt', 'Счёт']]) { cells[k] = h('b'); stats.append(h('div', {}, h('span', { text: t }), cells[k])); }
    stats.append(h('button', { class: 'lnk', title: 'Сбросить статистику', onclick: () => q()?.resetStats() }, 'Сброс'));
    const box = h('div', { class: 'reading' }, h('div', { class: 'rd-head' }, sel), big, bar, stats);
    win.body.append(box);
    const q = () => Hub.q.get(cfg.q);
    function apply() { stats.hidden = !cfg.stats; }
    function bind() { const x = q(); win.title(x ? x.name : 'Показание'); }
    win.sub(Hub, 'defs', () => { sel.fill(); bind(); });
    apply(); bind();
    let shown = -1, rev = -1;
    return {
      tick() {
        const x = q(); if (!x) return;
        if (x.cnt === shown && x.n && rev === Theme.rev) return;
        shown = x.cnt; rev = Theme.rev;
        const p = siParts(x.last, x.unit, cfg.digits);
        setDigits(num, p.text); unit.textContent = p.unit;
        box.classList.toggle('over', !!p.over);
        if (x.full && Number.isFinite(x.last)) { fill.style.width = clamp(Math.abs(x.last) / x.full * 100, 0, 100) + '%'; bar.hidden = !cfg.bar; } else bar.hidden = true;
        if (cfg.stats) {
          const s = v => x.cnt ? fmtSI(v, x.unit, 5) : '–';
          cells.min.textContent = s(x.min); cells.max.textContent = s(x.max); cells.mean.textContent = s(x.mean); cells.sd.textContent = s(x.sd); cells.cnt.textContent = x.cnt;
        }
      },
    };
  },
});

/* ---------- таблица величин ---------- */
WM.define('table', {
  title: 'Таблица величин', w: 560, h: 280,
  make(win, _, cfg) {
    cfg.ids ??= Hub.list().slice(0, 4).map(q => q.id);
    const tbody = h('tbody'), add = qSelect('', () => { });
    add.prepend(h('option', { value: '', text: 'Добавить величину…' })); add.value = '';
    add.addEventListener('change', () => { if (add.value && !cfg.ids.includes(add.value)) { cfg.ids.push(add.value); rows(); WM.save(); } add.value = ''; });
    win.toolbar.append(add);
    const tb = h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, ...['Величина', 'Значение', 'Мин', 'Макс', 'Среднее', 'σ', ''].map(t => h('th', { text: t })))), tbody);
    win.body.append(h('div', { class: 'scroll' }, tb));
    let map = [];
    function rows() {
      tbody.replaceChildren(); map = [];
      for (const id of cfg.ids) {
        const cols = [h('td'), h('td', { class: 'num strong' }), h('td', { class: 'num' }), h('td', { class: 'num' }), h('td', { class: 'num' }), h('td', { class: 'num' })];
        const del = h('button', { class: 'wbtn', 'aria-label': 'Убрать из таблицы', title: 'Убрать', onclick: () => { cfg.ids = cfg.ids.filter(x => x !== id); rows(); WM.save(); } }, '×');
        tbody.append(h('tr', {}, ...cols, h('td', {}, del)));
        map.push({ id, cols });
      }
    }
    rows();
    win.sub(Hub, 'defs', () => { add.fill(); rows(); });
    return {
      tick() {
        for (const { id, cols } of map) {
          const q = Hub.q.get(id);
          cols[0].textContent = q ? q.name : id;
          if (!q) continue;
          const s = v => q.cnt ? fmtSI(v, q.unit, 5) : '–';
          cols[1].textContent = fmtSI(q.last, q.unit, q.digits); cols[2].textContent = s(q.min); cols[3].textContent = s(q.max); cols[4].textContent = s(q.mean); cols[5].textContent = s(q.sd);
        }
      },
    };
  },
});

/* ---------- тренд: у каждой величины своя дорожка ---------- */
WM.define('trend', {
  title: 'Тренд', w: 640, h: 340,
  make(win, _, cfg) {
    cfg.ids ??= Hub.list().slice(0, 2).map(q => q.id); cfg.span ??= 60;
    let frozenAt = null, hover = null;
    const box = h('div', { class: 'chart' }), legend = h('div', { class: 'legend' }), tip = h('div', { class: 'tip', hidden: true });
    const add = qSelect('', () => { });
    add.prepend(h('option', { value: '', text: 'Добавить…' })); add.value = '';
    add.addEventListener('change', () => { if (add.value && !cfg.ids.includes(add.value)) { cfg.ids.push(add.value); leg(); WM.save(); } add.value = ''; });
    const pause = toggle('Пауза', false, v => { frozenAt = v ? performance.now() : null; });
    win.toolbar.append(add, pause, h('button', { class: 'tbtn', onclick: exportCsv }, 'CSV'));
    win.body.append(legend, h('div', { class: 'chart-wrap' }, box, tip));
    const p = new Plot(box);
    function leg() {
      legend.replaceChildren();
      cfg.ids.forEach((id, i) => {
        const q = Hub.q.get(id);
        legend.append(h('span', { class: 'lg' }, h('i', { style: { background: Theme.colors.t[i % 4] } }), q ? q.name : id,
          h('button', { class: 'wbtn', 'aria-label': 'Убрать дорожку', onclick: () => { cfg.ids = cfg.ids.filter(x => x !== id); leg(); WM.save(); } }, '×')));
      });
    }
    leg();
    win.sub(Bus, 'theme', leg); win.sub(Hub, 'defs', () => { add.fill(); leg(); });
    function exportCsv() {
      const rows = [];
      for (const id of cfg.ids) { const q = Hub.q.get(id); if (!q) continue; for (let i = 0; i < q.n; i++) { const [t, v] = q.at(i); rows.push(`${q.name};${(t / 1000).toFixed(3)};${v}`); } }
      saveFile(`trend-${stamp()}.csv`, 'Величина;Время, с;Значение\n' + rows.join('\n'), 'text/csv');
    }
    box.addEventListener('wheel', e => { e.preventDefault(); cfg.span = clamp(cfg.span * (e.deltaY > 0 ? 1.25 : .8), 2, 7200); WM.save(); }, { passive: false });
    let drag = null;
    box.addEventListener('pointerdown', e => { if (!frozenAt) return; drag = { x: e.clientX, at: frozenAt }; box.setPointerCapture(e.pointerId); });
    box.addEventListener('pointermove', e => {
      const r = box.getBoundingClientRect(); hover = { x: e.clientX - r.left, y: e.clientY - r.top };
      if (drag) frozenAt = Math.min(performance.now(), drag.at - (e.clientX - drag.x) / (p.w - 72) * cfg.span * 1000);
    });
    box.addEventListener('pointerup', () => { drag = null; });
    box.addEventListener('pointerleave', () => { hover = null; tip.hidden = true; });

    function draw() {
      const g = p.g, W = p.w, H = p.h, c = Theme.colors, end = frozenAt ?? performance.now(), spanMs = cfg.span * 1000, start = end - spanMs;
      g.clearRect(0, 0, W, H);
      const ids = cfg.ids.filter(id => Hub.q.has(id)), n = ids.length, L = 62, R = 10, T = 4, B = 20, plotH = H - T - B, gap = 8;
      if (!n) { g.fillStyle = c.ink3; g.font = FONT(12); g.fillText('Добавьте величину в меню окна', 16, 24); return; }
      const laneH = (plotH - gap * (n - 1)) / n, X = t => L + (t - start) / spanMs * (W - L - R);
      g.font = FONT(10);
      // время
      g.textAlign = 'center'; g.fillStyle = c.ink3;
      const secs = niceTicks(0, cfg.span, Math.max(3, W / 110 | 0));
      for (const s of secs) { const x = X(end - s * 1000); g.strokeStyle = c.grid; g.lineWidth = 1; g.beginPath(); g.moveTo(x + .5, T); g.lineTo(x + .5, H - B); g.stroke(); g.fillText(s ? `−${s}с` : 'сейчас', x, H - 6); }
      const tipRows = [];
      ids.forEach((id, li) => {
        const q = Hub.q.get(id), y0 = T + li * (laneH + gap);
        let lo = Infinity, hi = -Infinity, first = -1;
        for (let i = 0; i < q.n; i++) { const [t, v] = q.at(i); if (t < start || t > end || !Number.isFinite(v) || Math.abs(v) > 9e37) continue; if (first < 0) first = i; if (v < lo) lo = v; if (v > hi) hi = v; }
        if (lo === Infinity) { lo = 0; hi = 1; }
        const m = (hi - lo) * .08 || Math.abs(hi) * .01 || 1; lo -= m; hi += m;
        const Y = v => y0 + laneH - (v - lo) / (hi - lo) * laneH;
        g.strokeStyle = c.line; g.lineWidth = 1; g.strokeRect(L + .5, y0 + .5, W - L - R, laneH);
        g.textAlign = 'right';
        for (const v of niceTicks(lo, hi, Math.max(2, laneH / 34 | 0))) { const y = Y(v); if (y < y0 + 6 || y > y0 + laneH - 4) continue; g.strokeStyle = c.grid; g.beginPath(); g.moveTo(L, y + .5); g.lineTo(W - R, y + .5); g.stroke(); g.fillStyle = c.ink3; g.fillText(fmtSI(v, q.unit, 3), L - 5, y + 3); }
        // по одному столбцу min-max на пиксель, иначе длинная история рисуется медленно
        g.save(); g.beginPath(); g.rect(L, y0, W - L - R, laneH); g.clip();
        const color = c.t[cfg.ids.indexOf(id) % 4]; g.strokeStyle = color; g.lineWidth = 2; g.lineJoin = 'round'; g.beginPath();
        let col = -1, mn = 0, mx = 0, pen = false, nearest = null;
        const hx = hover ? hover.x : -1;
        const flush = () => { if (col < 0) return; if (!pen) { g.moveTo(col, Y(mn)); pen = true; } g.lineTo(col, Y(mn)); if (mx !== mn) g.lineTo(col, Y(mx)); };
        for (let i = Math.max(0, first); first >= 0 && i < q.n; i++) {
          const [t, v] = q.at(i); if (t > end) break; if (!Number.isFinite(v) || Math.abs(v) > 9e37) { flush(); col = -1; pen = false; continue; }
          const x = Math.round(X(t));
          if (hover && (!nearest || Math.abs(X(t) - hx) < Math.abs(nearest[0] - hx))) nearest = [X(t), v, t];
          if (x !== col) { flush(); col = x; mn = mx = v; } else { if (v < mn) mn = v; if (v > mx) mx = v; }
        }
        flush(); g.stroke(); g.restore();
        if (nearest) {
          tipRows.push(h('div', {}, h('i', { style: { background: color } }), q.name, h('b', { text: fmtSI(nearest[1], q.unit, 6) })));
          g.fillStyle = color; g.strokeStyle = c.panel; g.lineWidth = 2; g.beginPath(); g.arc(nearest[0], Y(nearest[1]), 4, 0, 6.3); g.fill(); g.stroke();
        }
      });
      if (hover && hover.x >= L && tipRows.length) {
        g.strokeStyle = c.ink3; g.lineWidth = 1; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(hover.x + .5, T); g.lineTo(hover.x + .5, H - B); g.stroke(); g.setLineDash([]);
        tip.replaceChildren(...tipRows); tip.hidden = false;
        tip.style.left = Math.min(hover.x + 12, W - 180) + 'px'; tip.style.top = Math.min(hover.y + 12, H - 30 - tipRows.length * 18) + 'px';
      }
    }
    let lastDraw = 0;
    return { tick(now) { if (now - lastDraw > 66 || hover) { lastDraw = now; draw(); } }, dispose() { p.dispose(); } };
  },
});

/* ---------- запись выбранных величин ---------- */
const Recorder = new (class extends Emitter {
  on_ = false; rows = []; ids = []; every = 0; t0 = 0; last = 0;
  start(ids, every) { this.ids = ids; this.every = every; this.rows = []; this.t0 = Date.now(); this.last = 0; this.on_ = true; this.off = Hub.on('sample', q => this.sample(q)); this.emit('state'); }
  sample(q) {
    if (!this.ids.includes(q.id)) return;
    const now = performance.now();
    if (this.every && now - this.last < this.every) return;
    if (!this.every && q.id !== this.ids[0]) return;
    this.last = now;
    this.rows.push([Date.now() - this.t0, ...this.ids.map(id => Hub.q.get(id)?.last ?? NaN)]);
    if (this.rows.length > 2e6) this.stop();
  }
  stop() { this.on_ = false; this.off?.(); this.emit('state'); }
  csv() {
    const names = this.ids.map(id => { const q = Hub.q.get(id); return q ? `${q.name}, ${q.unit}` : id; });
    return ['Время, с;' + names.join(';'), ...this.rows.map(r => [(r[0] / 1000).toFixed(3), ...r.slice(1)].join(';'))].join('\n');
  }
})();

WM.define('recorder', {
  title: 'Запись данных', w: 380, h: 300,
  make(win, _, cfg) {
    cfg.ids ??= Hub.list().slice(0, 3).map(q => q.id); cfg.every ??= 0;
    const list = h('div', { class: 'checks scroll' });
    function fill() {
      list.replaceChildren();
      for (const q of Hub.list()) list.append(h('label', {}, h('input', { type: 'checkbox', checked: cfg.ids.includes(q.id), onchange: e => { cfg.ids = e.target.checked ? [...cfg.ids, q.id] : cfg.ids.filter(x => x !== q.id); WM.save(); } }), ` ${Devices.get(q.dev)?.title || q.dev} · ${q.name}`));
    }
    fill(); win.sub(Hub, 'defs', fill);
    const go = h('button', { class: 'btn primary', onclick: () => { if (Recorder.on_) Recorder.stop(); else if (cfg.ids.length) Recorder.start(cfg.ids.filter(i => Hub.q.has(i)), cfg.every); } });
    const save = h('button', { class: 'btn', onclick: () => saveFile(`zapis-${stamp()}.csv`, '﻿' + Recorder.csv(), 'text/csv') }, 'Сохранить CSV');
    const info = h('span', { class: 'note' });
    const rate = select([[0, 'Каждый отсчёт'], [100, '10 раз в секунду'], [1000, 'Раз в секунду'], [10000, 'Раз в 10 с'], [60000, 'Раз в минуту']], cfg.every, v => { cfg.every = +v; WM.save(); }, 'Период записи');
    win.body.append(h('div', { class: 'col pad' }, field('Период', rate), list, h('div', { class: 'row' }, go, save, info)));
    const upd = () => { go.textContent = Recorder.on_ ? 'Остановить' : 'Начать запись'; win.el.classList.toggle('rec', Recorder.on_); };
    upd(); win.sub(Recorder, 'state', upd);
    return { tick() { info.textContent = `${Recorder.rows.length} строк`; } };
  },
});

/* ---------- консоль SCPI ---------- */
const SCPI_HINTS = ['*IDN?', '*CLS', 'SYST:ERR?', 'SYST:TEMP?', 'FUNC?', 'CONF?', 'READ?', 'FETC?', 'RATE?', 'RATE FAST', 'CALC:AHOL ON', 'CALC:AVER?', 'TIM:SCAL?', 'CHAN1:SCAL?', 'TRIG:STAT?', 'WAV:PRE?', 'SOUR:FREQ 1000', 'OUTP ON', 'MMEM:CAT?', 'LCR:FREQ?', 'LCR:LEV?', 'LCR:AVER?', 'FETC?'];

WM.define('console', {
  title: 'Консоль SCPI', w: 520, h: 320,
  make(win, _, cfg) {
    const devSel = h('select', { 'aria-label': 'Прибор' });
    const fillDev = () => { const v = devSel.value; devSel.replaceChildren(...Devices.list.map(d => h('option', { value: d.id, text: d.title }))); if (v) devSel.value = v; };
    fillDev(); win.sub(Devices, 'change', fillDev);
    const log = h('div', { class: 'cons-log scroll', role: 'log', 'aria-live': 'polite' }), hist = store.get('consHist', []);
    const dl = h('datalist', { id: 'scpiHints' }, ...SCPI_HINTS.map(s => h('option', { value: s })));
    let hi = hist.length;
    const inp = h('input', { class: 'cons-in', list: 'scpiHints', placeholder: 'Команда, например *IDN?', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Команда SCPI' });
    const add = (cls, t) => { log.append(h('div', { class: cls, text: t })); log.scrollTop = 1e9; while (log.childElementCount > 500) log.firstChild.remove(); };
    async function run() {
      const s = inp.value.trim(); if (!s) return;
      inp.value = ''; hist.push(s); if (hist.length > 80) hist.shift(); hi = hist.length; store.set('consHist', hist);
      const d = Devices.get(devSel.value); add('c-in', '> ' + s);
      if (!d) { add('c-err', 'Нет подключённого прибора'); return; }
      try {
        if (s.includes('?')) {
          const b = await d.link.run(async () => { await d.link.tx(s); return d.link.rx(5000); }, 0);
          const t = b[0] === 0x23 ? `[блок ${parseBlock(b).length} байт] ${[...parseBlock(b).subarray(0, 16)].map(x => x.toString(16).padStart(2, '0')).join(' ')}…` : dec.decode(b).trim();
          add('c-out', t);
        } else { await d.w(s); const e = await d.q('SYST:ERR?', { prio: 0 }).catch(() => ''); if (e && !e.startsWith('0,')) add('c-err', e); else add('c-ok', 'выполнено'); }
      } catch (e) { add('c-err', e.message); }
    }
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') run();
      else if (e.key === 'ArrowUp') { hi = Math.max(0, hi - 1); inp.value = hist[hi] ?? ''; e.preventDefault(); }
      else if (e.key === 'ArrowDown') { hi = Math.min(hist.length, hi + 1); inp.value = hist[hi] ?? ''; e.preventDefault(); }
    });
    win.toolbar.append(devSel);
    win.body.append(h('div', { class: 'cons' }, log, h('div', { class: 'row' }, inp, dl, h('button', { class: 'btn', onclick: run }, 'Отправить'))));
    add('c-ok', 'Стрелки вверх и вниз листают историю. Ошибки прибора показываются после каждой команды.');
  },
});

/* ---------- все настройки прибора одним списком ---------- */
WM.define('settings', {
  title: 'Настройки прибора', w: 420, h: 440, dev: 'dm40', devName: 'Прибор',
  make(win, dev, cfg) {
    const devSel = h('select', { 'aria-label': 'Прибор', onchange: () => { cfg.dev = devSel.value; WM.save(); win.rebuild(); } }, ...Devices.list.map(d => h('option', { value: d.id, text: d.title })));
    devSel.value = dev.id; win.toolbar.append(devSel);
    win.title('Настройки ' + dev.title);
    const box = h('div', { class: 'col pad scroll' }), rows = [], list = SETTINGS[dev.id] || [];
    if (!list.length) box.append(h('p', { class: 'note', text: 'Для этого прибора список настроек не описан. Пользуйтесь консолью SCPI.' }));
    for (const [title, items] of list) {
      box.append(h('h4', { text: title }));
      for (const [cmd, label, kind, hint] of items) {
        let ctl, get;
        if (kind === 'num') {
          const inp = h('input', { type: 'text', inputmode: 'decimal', 'aria-label': label, onchange: () => { const v = inp.value.trim().replace(',', '.'); if (v) dev.w(`${cmd} ${v}`).catch(e => toast(e.message, 'bad')); } });
          ctl = inp; get = r => { const n = parseFloat(r); inp.value = Number.isFinite(n) && n < 9e37 ? String(+n.toPrecision(6)) : ''; };
        } else {
          const opt = Object.entries(kind);
          ctl = opt.length <= 3 ? seg(opt, '', v => dev.w(`${cmd} ${v}`).catch(e => toast(e.message, 'bad')), label) : select(opt, '', v => dev.w(`${cmd} ${v}`).catch(e => toast(e.message, 'bad')), label);
          get = r => { if (ctl.set) ctl.set(r); else ctl.value = r; };
        }
        const line = h('div', { class: 'set-row' }, h('div', {}, h('span', { text: label }), hint && h('small', { text: hint })), ctl);
        box.append(line); rows.push({ cmd, get });
      }
    }
    const refresh = async () => {
      for (const r of rows) { try { r.get((await dev.q(r.cmd + '?')).replace(/"/g, '')); } catch { } }
    };
    win.toolbar.append(h('button', { class: 'tbtn', onclick: refresh }, 'Обновить'));
    win.body.append(box);
    refresh();
  },
});

/* ---------- величины: добавить, изменить, убрать ---------- */
WM.define('quantities', {
  title: 'Величины', w: 480, h: 420,
  make(win) {
    const list = h('div', { class: 'scroll qlist' });
    function fill() {
      list.replaceChildren();
      for (const q of Hub.list()) {
        const dev = Devices.get(q.dev);
        list.append(h('div', { class: 'qrow' },
          h('div', {}, h('b', { text: q.name }), h('small', { text: `${dev?.title || q.dev}${q.group ? ' · ' + q.group : ''}${q.unit ? ' · ' + q.unit : ''}` })),
          h('button', { class: 'tbtn', onclick: () => WM.open('reading', { q: q.id }) }, 'Показание'),
          h('button', { class: 'tbtn', onclick: () => WM.open('trend', { ids: [q.id] }) }, 'Тренд'),
          (q.custom || q.calc) && h('button', { class: 'wbtn', 'aria-label': 'Удалить величину', title: 'Удалить', onclick: () => { if (q.calc) { Calc.items = Calc.items.filter(i => i.id !== q.id); Calc.save(); Hub.remove(q.id); } else dev?.dropCustom(q.id); } }, '×')));
      }
    }
    const nm = h('input', { placeholder: 'Название', 'aria-label': 'Название' }), un = h('input', { placeholder: 'Единица: V, A, Ω, °C', 'aria-label': 'Единица' });
    const src = h('input', { placeholder: 'SCPI-запрос или формула: dm40.main*2', spellcheck: 'false', 'aria-label': 'Запрос или формула' });
    const per = h('input', { value: '500', inputmode: 'numeric', 'aria-label': 'Период опроса, мс' });
    const devSel = h('select', { 'aria-label': 'Прибор' }); const fd = () => devSel.replaceChildren(h('option', { value: '', text: 'Формула' }), ...Devices.list.map(d => h('option', { value: d.id, text: d.title })));
    fd(); win.sub(Devices, 'change', fd);
    const addBtn = h('button', { class: 'btn primary', onclick() {
      const name = nm.value.trim(), s = src.value.trim(); if (!name || !s) { toast('Заполните название и запрос', 'warn'); return; }
      try {
        if (devSel.value) Devices.get(devSel.value).addCustom({ name, unit: un.value.trim(), query: s, period: Math.max(20, +per.value || 500), scale: 1 });
        else { Calc.compile(s); App.addCalc({ id: 'calc.' + Date.now().toString(36), name, unit: un.value.trim(), expr: s }); }
        nm.value = src.value = ''; fill();
      } catch (e) { toast(e.message, 'bad'); }
    } }, 'Добавить');
    win.body.append(h('div', { class: 'col' }, list, h('div', { class: 'qform' }, nm, un, devSel, src, per, addBtn)));
    fill(); win.sub(Hub, 'defs', fill);
  },
});
