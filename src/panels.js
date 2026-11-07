'use strict';
/* Окна приборов. */

const errToast = e => toast(e.message || String(e), 'bad');
const fmtV = v => fmtSI(v, 'V', 3), fmtT = t => fmtSI(t, 's', 3);

/* ---------- DM40: мультиметр ---------- */
WM.define('dm40-dmm', {
  title: 'Мультиметр DM40', dev: 'dm40', devName: 'DM40', w: 520, h: 400,
  make(win, dev, cfg) {
    const c = dev.s, q = Hub.q.get('dm40.main');
    const num = h('div', { class: 'digits' }), unit = h('div', { class: 'unit' }), fnName = h('b'), rng = h('span'), alert = h('span', { class: 'chip bad', hidden: true });
    const fill = h('i', { class: 'fill' }), bar = h('div', { class: 'bargraph' }, fill, h('span', { class: 'ticks' }));
    const fn = h('div', { class: 'fn-grid', role: 'radiogroup', 'aria-label': 'Функция' }, ...DM_FUNCS.map(f => {
      const b = h('button', { title: f.name, onclick: () => dev.setFunc(f.id).catch(errToast) }, f.label); b.dataset.f = f.id; return b;
    }));
    const rangeBox = h('div', { class: 'seg wrap' }), rate = seg([['SLOW', 'Медленно'], ['MED', 'Средне'], ['FAST', 'Быстро']], c.rate, v => dev.w('RATE ' + v).catch(errToast), 'Скорость');
    const ahold = toggle('AutoHold', false, v => dev.w(`CALC:AHOL ${v ? 'ON' : 'OFF'}`).catch(errToast));
    const smooth = toggle('Сглаживание', false, v => dev.w(`CALC:SMO ${v ? 'ON' : 'OFF'}`).catch(errToast));
    const box = h('div', { class: 'reading dmm' },
      h('div', { class: 'rd-head' }, fnName, rng, alert), h('div', { class: 'big' }, num, unit), bar, fn, h('div', { class: 'row wrap' }, field('Предел', rangeBox)), h('div', { class: 'row wrap' }, field('Скорость', rate), ahold, smooth));
    win.body.append(box);
    function ui() {
      const f = dev.func();
      fnName.textContent = f.name;
      rng.textContent = c.rangeAuto ? 'Авто' + (Number.isFinite(c.range) ? ' · ' + fmtSI(c.range, f.unit, 3) : '') : Number.isFinite(c.range) ? fmtSI(c.range, f.unit, 3) : '';
      for (const b of fn.children) b.classList.toggle('on', b.dataset.f === c.func);
      rate.set(c.rate);
      rangeBox.replaceChildren(h('button', { class: c.rangeAuto ? 'on' : '', onclick: () => dev.setRange('AUTO').catch(errToast) }, 'Авто'));
      for (const r of f.r || []) rangeBox.append(h('button', { class: !c.rangeAuto && Math.abs(r / c.range - 1) < .01 ? 'on' : '', onclick: () => dev.setRange(r).catch(errToast) }, fmtSI(r, f.unit, 2).replace('.0 ', ' ')));
      rangeBox.parentElement.hidden = !f.r;
    }
    ui(); win.sub(dev, 'dmm', ui);
    win.sub(dev, 'sys', () => { const on = c.alert && c.alert !== 'NONE'; alert.hidden = !on; alert.textContent = 'Внимание: ' + c.alert; });
    dev.q('CALC:AHOL?;CALC:SMO:STAT?').then(r => { const [a, s] = r.split(';'); ahold.set(a === '1'); smooth.set(s === '1'); }).catch(() => { });
    let cnt = -1, rev = -1;
    return {
      tick() {
        if (q.cnt === cnt && rev === Theme.rev) return; cnt = q.cnt; rev = Theme.rev;
        const p = siParts(q.last, q.unit, 6); setDigits(num, p.text); unit.textContent = p.unit; box.classList.toggle('over', !!p.over);
        if (q.full && Number.isFinite(q.last)) { fill.style.width = clamp(Math.abs(q.last) / q.full * 100, 0, 100) + '%'; bar.hidden = false; } else bar.hidden = true;
      },
    };
  },
});

/* ---------- БПФ ---------- */
function fftDb(v, dt) {
  let n = 1; while (n < v.length) n <<= 1;
  const re = new Float64Array(n), im = new Float64Array(n), L = v.length;
  let mean = 0; for (let i = 0; i < L; i++) mean += v[i]; mean /= L;
  for (let i = 0; i < L; i++) re[i] = (v[i] - mean) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (L - 1)));
  for (let i = 1, j = 0; i < n; i++) { let b = n >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b; if (i < j) { const t = re[i]; re[i] = re[j]; re[j] = t; } }
  for (let len = 2; len <= n; len <<= 1) {
    const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const j = i + k, m = j + len / 2, tr = re[m] * cr - im[m] * ci, ti = re[m] * ci + im[m] * cr;
        re[m] = re[j] - tr; im[m] = im[j] - ti; re[j] += tr; im[j] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
  const out = new Float64Array(n / 2), k = 4 / L;
  for (let i = 0; i < n / 2; i++) out[i] = 20 * Math.log10(Math.hypot(re[i], im[i]) * k / Math.SQRT2 + 1e-9);
  return { db: out, df: 1 / (n * dt) };
}

/* ---------- цифровой фосфор (DPO) ----------
 * Каждая принятая осциллограмма добавляет единицу в каждый пиксель, через
 * который прошёл луч, по одному разу на столбец. Накопленное число затухает
 * по экспоненте с выбранной постоянной времени, «∞» хранит всё. Яркость или
 * цвет пикселя показывают, как часто сигнал там бывает: редкий выброс виден
 * тусклым или синим, основная линия яркой или красной. Одинаковые подряд
 * кадры (прибор ещё не снял новый) не считаются. */
const DPO_PERSIST = [[0.3, '0,3 с'], [1, '1 с'], [3, '3 с'], [10, '10 с'], [0, '∞']];
const rgbOf = (() => {
  let g = null;
  return s => {
    if (!g) { const cv = document.createElement('canvas'); cv.width = cv.height = 1; g = cv.getContext('2d', { willReadFrequently: true }); }
    g.clearRect(0, 0, 1, 1); g.fillStyle = '#000'; g.fillStyle = s; g.fillRect(0, 0, 1, 1);
    const d = g.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2]];
  };
})();
/* цветовая температура: от холодного (редко) к горячему (часто) */
const DPO_HEAT = [[0, [40, 40, 160]], [.16, [30, 110, 235]], [.33, [20, 200, 220]], [.5, [40, 210, 80]], [.66, [240, 230, 40]], [.82, [250, 120, 20]], [.94, [235, 30, 30]], [1, [255, 245, 235]]];

class Phosphor {
  constructor(cfg) { this.cfg = cfg; this.W = 0; this.H = 0; this.acc = null; this.cv = document.createElement('canvas'); this.cg = this.cv.getContext('2d'); this.lutKey = ''; this.clear(); }
  /* буфер в пикселях устройства, как холст окна */
  alloc(W, H) {
    if (W === this.W && H === this.H && this.acc) return;
    this.W = W; this.H = H; this.acc = new Float32Array(W * H); this.lo = new Float32Array(W); this.hi = new Float32Array(W);
    this.cv.width = W; this.cv.height = H; this.img = this.cg.createImageData(W, H); this.px = new Uint32Array(this.img.data.buffer);
    this.clear();
  }
  clear() { this.acc?.fill(0); this.n = 0; this.last = null; this.tLast = 0; this.rate = 0; this.rn = 0; this.rt = performance.now(); }
  key(k) { if (k !== this.k) { this.k = k; this.clear(); } }
  /* y(v) даёт долю высоты экрана (0 сверху, 1 снизу) */
  add(v, y) {
    const n = v.length; if (n < 2 || !this.acc) return;
    const L = this.last;
    if (L && L.length === n) { let same = true; for (let i = 0; i < n; i++) if (L[i] !== v[i]) { same = false; break; } if (same) return; }
    this.last = v.slice();
    const W = this.W, H = this.H, acc = this.acc, now = performance.now(), tau = this.cfg.dpoTau;
    if (tau > 0 && this.tLast) {
      const k = Math.exp(-Math.min(5, (now - this.tLast) / 1000) / tau);
      for (let i = 0; i < acc.length; i++) acc[i] *= k;
    }
    this.tLast = now;
    const lo = this.lo, hi = this.hi; lo.fill(Infinity); hi.fill(-Infinity);
    const sx = (W - 1) / (n - 1);
    let x0 = 0, y0 = y(v[0]) * H;
    for (let i = 1; i < n; i++) {
      const x1 = i * sx, y1 = y(v[i]) * H, c0 = Math.max(0, Math.round(x0)), c1 = Math.min(W - 1, Math.round(x1));
      for (let cx = c0; cx <= c1; cx++) {
        // часть отрезка, которая лежит в этом столбце
        const ta = clamp((cx - .5 - x0) / (x1 - x0), 0, 1), tb = clamp((cx + .5 - x0) / (x1 - x0), 0, 1);
        const ya = y0 + (y1 - y0) * ta, yb = y0 + (y1 - y0) * tb;
        const a = Math.min(ya, yb), b = Math.max(ya, yb);
        if (a < lo[cx]) lo[cx] = a; if (b > hi[cx]) hi[cx] = b;
      }
      x0 = x1; y0 = y1;
    }
    const half = Math.max(0, (devicePixelRatio || 1) - 1) / 2;
    for (let cx = 0; cx < W; cx++) {
      if (lo[cx] === Infinity) continue;
      const a = Math.max(0, Math.round(lo[cx] - half)), b = Math.min(H - 1, Math.round(hi[cx] + half));
      for (let r = a; r <= b; r++) acc[r * W + cx] += 1;
    }
    this.n++; this.rn++;
    if (now - this.rt >= 1000) { this.rate = this.rn * 1000 / (now - this.rt); this.rn = 0; this.rt = now; }
  }
  lut(col) {
    const k = `${this.cfg.dpoMode}|${Theme.rev}`;
    if (k === this.lutKey) return this.L;
    this.lutKey = k; const L = this.L = new Uint32Array(256), pack = (r, g, b, a) => (a << 24 | b << 16 | g << 8 | r) >>> 0;
    if (this.cfg.dpoMode === 'temp') {
      for (let i = 0; i < 256; i++) {
        const t = i / 255; let j = 1; while (j < DPO_HEAT.length - 1 && DPO_HEAT[j][0] < t) j++;
        const [ta, ca] = DPO_HEAT[j - 1], [tb, cb] = DPO_HEAT[j], u = (t - ta) / (tb - ta || 1);
        L[i] = pack(...ca.map((x, m) => Math.round(x + (cb[m] - x) * u)), 255);
      }
    } else {
      const [r, g, b] = rgbOf(col.t[0]);
      for (let i = 0; i < 256; i++) {
        const t = i / 255, w = Math.max(0, (t - .8) / .2) * .7;   // самые частые точки уходят в белый, как у люминофора
        L[i] = pack(Math.round(r + (255 - r) * w), Math.round(g + (255 - g) * w), Math.round(b + (255 - b) * w), Math.round(70 + 185 * t));
      }
    }
    return L;
  }
  draw(g, W, H, col) {
    if (!this.acc) return;
    const acc = this.acc, px = this.px, L = this.lut(col), lg = this.cfg.dpoScale === 'log', gain = this.cfg.dpoGain || 1;
    let m = 0; for (let i = 0; i < acc.length; i++) if (acc[i] > m) m = acc[i];
    if (m > 0) {
      const lm = Math.log1p(m);
      for (let i = 0; i < acc.length; i++) {
        const a = acc[i];
        if (a < .02) { px[i] = 0; continue; }
        const t = Math.min(1, (lg ? Math.log1p(a) / lm : a / m) * gain);
        px[i] = L[Math.max(1, t * 255 | 0)];
      }
    } else px.fill(0);
    this.cg.putImageData(this.img, 0, 0);
    g.drawImage(this.cv, 0, 0, W, H);
    // подпись и шкала
    g.font = FONT(10, 600); g.textAlign = 'left'; g.fillStyle = col.ink2;
    g.fillText(`DPO · ${this.n} осц. · ${this.rate.toFixed(0)} осц/с`, 16, 28);
    const bw = 90, bx = W - bw - 50, by = H - 16;
    for (let i = 0; i < bw; i++) { const u = L[Math.max(1, i / (bw - 1) * 255 | 0)]; g.fillStyle = `rgba(${u & 255},${u >> 8 & 255},${u >> 16 & 255},${(u >>> 24) / 255})`; g.fillRect(bx + i, by, 1, 6); }
    g.fillStyle = col.ink3; g.textAlign = 'right'; g.fillText('редко', bx - 4, by + 7); g.textAlign = 'left'; g.fillText('часто', bx + bw + 4, by + 7);
  }
}

/* ---------- DM40: осциллограф ---------- */
const MEAS = { vpp: ['Размах', 'V'], vmax: ['Макс', 'V'], vmin: ['Мин', 'V'], vavg: ['Среднее', 'V'], vrms: ['СКЗ', 'V'], vac: ['СКЗ AC', 'V'], freq: ['Частота', 'Hz'], period: ['Период', 's'], duty: ['Скважность', '%'], rise: ['Фронт', 's'] };

WM.define('dm40-scope', {
  title: 'Осциллограф DM40', dev: 'dm40', devName: 'DM40', w: 860, h: 520,
  make(win, dev, cfg) {
    const c = dev.s;
    Object.assign(cfg, { dpo: cfg.dpo ?? false, dpoMode: cfg.dpoMode ?? 'int', dpoTau: cfg.dpoTau ?? 1, dpoScale: cfg.dpoScale ?? 'log', dpoGain: cfg.dpoGain ?? 1 });
    Object.assign(cfg, { meas: cfg.meas ?? ['vpp', 'vrms', 'freq', 'duty'], persist: cfg.persist ?? 0, fft: cfg.fft ?? false, cursors: cfg.cursors ?? false, dots: cfg.dots ?? false, cur: cfg.cur ?? { t1: .3, t2: .7, v1: .35, v2: .65 } });
    c.scopeUsers++;
    let frame = null, stats = {}, dirty = true, view = { a: 0, b: 1 };
    const scr = h('div', { class: 'sc-screen' }), ffb = h('div', { class: 'sc-fft', hidden: !cfg.fft });
    const measBox = h('div', { class: 'sc-meas' }), info = h('div', { class: 'sc-info' }), tip = h('span', { class: 'sc-state' });
    const ctl = h('div', { class: 'sc-ctl' });
    win.body.append(h('div', { class: 'scope' }, h('div', { class: 'sc-main' }, scr, ffb, measBox, info), ctl));
    const p = new Plot(scr), sp = new Spectrum(ffb, cfg, () => WM.save());
    sp.ctl.hidden = !cfg.fft;
    const trail = document.createElement('canvas'), tg = trail.getContext('2d');
    p.onresize = () => { trail.width = p.c.width; trail.height = p.c.height; tg.setTransform(devicePixelRatio || 1, 0, 0, devicePixelRatio || 1, 0, 0); dpo.alloc(p.c.width, p.c.height); dirty = true; };
    const dpo = new Phosphor(cfg);
    p.onresize();

    /* управление */
    const runBtn = h('button', { class: 'btn primary', onclick: () => dev.setRun(!c.run).catch(errToast) });
    const single = h('button', { class: 'btn', onclick: () => dev.single().catch(errToast) }, 'Один');
    const auto = h('button', { class: 'btn', title: 'Подобрать развёртку, чувствительность и уровень', onclick: autoset }, 'Авто');
    const stepIn = (list, v, d) => { let i = list.findIndex(x => x >= v * .999); if (i < 0) i = list.length - 1; return list[clamp(i + d, 0, list.length - 1)]; };
    const stT = stepper(c.ts, fmtT, d => { const v = stepIn(TIME_STEPS, c.ts, d); dev.scope(`TIM:SCAL ${v}`, { ts: v }).catch(errToast); }, 'Развёртка');
    const stV = stepper(c.vs, fmtV, d => { const v = stepIn(VOLT_STEPS, c.vs, d); dev.scope(`CHAN1:SCAL ${v}`, { vs: v }).catch(errToast); }, 'Чувствительность');
    const coup = seg([['DC', 'DC'], ['AC', 'AC']], c.coup, v => dev.scope(`CHAN1:COUP ${v}`, { coup: v }).catch(errToast), 'Связь');
    const offs = h('input', { type: 'text', inputmode: 'decimal', 'aria-label': 'Смещение, В', onchange: () => { const v = parseFloat(offs.value.replace(',', '.')) || 0; dev.scope(`CHAN1:OFFS ${v}`, { offs: v }).catch(errToast); } });
    const lvl = h('input', { type: 'text', inputmode: 'decimal', 'aria-label': 'Уровень запуска, В', onchange: () => { const v = parseFloat(lvl.value.replace(',', '.')) || 0; dev.scope(`TRIG:LEV ${v}`, { tl: v }).catch(errToast); } });
    const slope = seg([['POS', 'Фронт ↗'], ['NEG', 'Спад ↘']], c.slope, v => dev.scope(`TRIG:SLOP ${v}`, { slope: v }).catch(errToast), 'Перепад');
    const sweep = seg([['AUTO', 'Авто'], ['NORM', 'Ждущий'], ['SING', 'Один']], c.sweep, v => dev.scope(`TRIG:SWE ${v}`, { sweep: v }).catch(errToast), 'Режим запуска');
    const src = seg([['CHAN1', 'CH1'], ['GEN', 'GEN'], ['CHAN2', 'DMM']], c.src, v => dev.scope(`TRIG:SOUR ${v}`, { src: v }).catch(errToast), 'Источник запуска');
    const persist = seg([[0, 'Нет'], [1, 'Кратко'], [2, 'Долго']], cfg.persist, v => { cfg.persist = +v; tg.clearRect(0, 0, p.w, p.h); WM.save(); }, 'Послесвечение');
    const showDots = toggle('Точки', cfg.dots, v => { cfg.dots = v; WM.save(); dirty = true; });
    const showFft = toggle('Спектр', cfg.fft, v => { cfg.fft = v; ffb.hidden = !v; sp.ctl.hidden = !v; fedF = null; dirty = true; WM.save(); });
    const showCur = toggle('Курсоры', cfg.cursors, v => { cfg.cursors = v; WM.save(); dirty = true; });
    const rec = h('button', { class: 'btn', title: 'Остановить и прочитать всю запись прибора', onclick: fetchRec }, 'Вся запись');
    const live = h('button', { class: 'btn', hidden: true, onclick: () => { c.record = null; view = { a: 0, b: 1 }; live.hidden = true; dirty = true; dev.setRun(true).catch(errToast); } }, 'К живому сигналу');
    /* цифровой фосфор */
    const dpoBtn = toggle('DPO · цифровой фосфор', cfg.dpo, v => { cfg.dpo = v; dpoBox.hidden = !v; dpo.clear(); WM.save(); dirty = true; });
    dpoBtn.title = 'Цифровой фосфор: яркость или цвет показывают, как часто луч проходит через точку';
    const dpoMode = seg([['int', 'Яркость'], ['temp', 'Температура']], cfg.dpoMode, v => { cfg.dpoMode = v; WM.save(); dirty = true; }, 'Градация');
    const dpoTau = seg(DPO_PERSIST, cfg.dpoTau, v => { cfg.dpoTau = +v; WM.save(); }, 'Послесвечение фосфора');
    const dpoScale = seg([['lin', 'Линейная'], ['log', 'Логарифм']], cfg.dpoScale, v => { cfg.dpoScale = v; WM.save(); dirty = true; }, 'Шкала');
    const dpoGain = h('input', { type: 'range', min: 1, max: 20, step: 0.5, value: cfg.dpoGain, 'aria-label': 'Усиление яркости', oninput: () => { cfg.dpoGain = +dpoGain.value; dirty = true; }, onchange: () => WM.save() });
    const dpoClr = h('button', { class: 'btn', onclick: () => { dpo.clear(); dirty = true; } }, 'Очистить');
    const dpoBox = h('div', { class: 'col', hidden: !cfg.dpo },
      h('h4', { text: 'Цифровой фосфор' }), field('Градация', dpoMode), field('Послесвечение', dpoTau), field('Шкала', dpoScale), field('Усиление', dpoGain), h('div', { class: 'row' }, dpoClr));
    const addM = select([['', 'Добавить меру…'], ...Object.entries(MEAS).map(([k, v]) => [k, v[0]])], '', v => { if (v && !cfg.meas.includes(v)) { cfg.meas.push(v); drawMeas(); WM.save(); } addM.value = ''; }, 'Добавить меру');
    ctl.append(
      h('div', { class: 'row' }, runBtn, single, auto), tip, h('div', { class: 'row' }, dpoBtn), dpoBox,
      h('h4', { text: 'По времени' }), stT,
      h('h4', { text: 'По напряжению' }), stV, h('div', { class: 'row' }, coup), field('Смещение, В', offs),
      h('h4', { text: 'Запуск' }), field('Уровень, В', lvl), slope, sweep, src,
      h('h4', { text: 'Экран' }), h('div', { class: 'row wrap' }, showFft, showCur, showDots), field('Послесвечение', persist), addM, sp.ctl,
      h('h4', { text: 'Данные' }), h('div', { class: 'row wrap' }, rec, live, h('button', { class: 'btn', onclick: saveCsv }, 'CSV'), h('button', { class: 'btn', onclick: savePng }, 'Снимок')));

    function ui() {
      runBtn.textContent = c.run ? 'Стоп' : 'Пуск'; runBtn.classList.toggle('danger', c.run);
      stT.set(c.ts); stV.set(c.vs); coup.set(c.coup); slope.set(c.slope); sweep.set(c.sweep); src.set(c.src);
      if (document.activeElement !== offs) offs.value = +(+c.offs).toFixed(4);
      if (document.activeElement !== lvl) lvl.value = +(+c.tl).toFixed(4);
      dirty = true;
    }
    ui(); win.sub(dev, 'scope', ui);
    const stName = { STOP: 'Остановлен', WAIT: 'Ждёт запуска', AUTO: 'Авто', TD: 'Запущен', RUN: 'Самописец' };
    win.sub(dev, 'trig', () => { tip.textContent = stName[c.trig] || c.trig; tip.dataset.s = c.trig; });
    win.sub(dev, 'wave', f => { frame = f; dirty = true; stats = waveStats(f.v, f.xinc); if (cfg.dpo && !c.record) dpo.add(f.v, v => Yv(v, 1)); feedFft(); });
    win.sub(dev, 'record', () => { frame = { v: c.record.v, xinc: c.record.xinc, xorig: c.record.xorig, screen: false }; stats = waveStats(c.record.v, c.record.xinc); view = { a: 0, b: 1 }; live.hidden = false; dirty = true; });
    win.sub(dev, 'rate', () => { info.textContent = `${c.fps.toFixed(0)} кадр/с · ${c.kbps.toFixed(1)} кБ/с · ${fmtSI(c.srate, 'S/s', 3)}`; });

    async function fetchRec() {
      rec.disabled = true;
      try { const r = await dev.fetchRecord(s => { info.textContent = s; }); info.textContent = `Запись: ${r.n} точек за ${(r.ms / 1000).toFixed(1)} с. Колесо мыши меняет масштаб, перетаскивание двигает.`; }
      catch (e) { errToast(e); } rec.disabled = false;
    }
    async function autoset() {
      if (!stats.vpp) return;
      const v = VOLT_STEPS.find(x => x * 6 >= stats.vpp) ?? 10, t = stats.freq > 0 ? TIME_STEPS.find(x => x * 10 >= 3 / stats.freq) ?? 1e-3 : c.ts;
      try {
        await dev.scope(`CHAN1:SCAL ${v};TIM:SCAL ${t};CHAN1:OFFS ${-stats.vavg.toPrecision(3)};TRIG:LEV ${stats.vavg.toPrecision(3)}`, { vs: v, ts: t, offs: -stats.vavg, tl: stats.vavg });
      } catch (e) { errToast(e); }
    }
    function saveCsv() {
      if (!frame) return;
      const rows = ['Время, с;Напряжение, В'];
      for (let i = 0; i < frame.v.length; i++) rows.push(`${((i - (frame.xref || 0)) * frame.xinc + frame.xorig).toExponential(6)};${frame.v[i].toPrecision(6)}`);
      saveFile(`dm40-${stamp()}.csv`, rows.join('\n'), 'text/csv');
    }
    function savePng() { p.c.toBlob(b => saveFile(`dm40-${stamp()}.png`, b)); }

    function drawMeas() {
      measBox.replaceChildren();
      for (const k of cfg.meas) {
        const v = h('b'); v.dataset.k = k;
        measBox.append(h('span', { class: 'mchip' }, MEAS[k][0], ' ', v, h('button', { class: 'wbtn', 'aria-label': 'Убрать меру', onclick: () => { cfg.meas = cfg.meas.filter(x => x !== k); drawMeas(); WM.save(); } }, '×')));
      }
      curBox = h('span', { class: 'mchip cur', hidden: true }); measBox.append(curBox);
    }
    let curBox; drawMeas();

    /* рисование */
    const Yv = (v, H) => H / 2 - (v + c.offs) / c.vs * (H / 8);
    function graticule(g, W, H, col) {
      g.strokeStyle = col.grid; g.lineWidth = 1; g.beginPath();
      for (let i = 1; i < 10; i++) { const x = Math.round(i * W / 10) + .5; g.moveTo(x, 0); g.lineTo(x, H); }
      for (let i = 1; i < 8; i++) { const y = Math.round(i * H / 8) + .5; g.moveTo(0, y); g.lineTo(W, y); }
      g.stroke();
      g.strokeStyle = col.ink3; g.globalAlpha = .55; g.beginPath(); g.moveTo(W / 2 + .5, 0); g.lineTo(W / 2 + .5, H); g.moveTo(0, H / 2 + .5); g.lineTo(W, H / 2 + .5);
      for (let i = 0; i <= 50; i++) { const x = Math.round(i * W / 50) + .5; g.moveTo(x, H / 2 - 3); g.lineTo(x, H / 2 + 4); }
      for (let i = 0; i <= 40; i++) { const y = Math.round(i * H / 40) + .5; g.moveTo(W / 2 - 3, y); g.lineTo(W / 2 + 4, y); }
      g.stroke(); g.globalAlpha = 1;
    }
    function trace(g, W, H, col) {
      const v = frame.v, n = v.length, a = view.a * n, b = view.b * n, m = b - a;
      g.strokeStyle = col.t[0]; g.fillStyle = col.t[0]; g.lineWidth = 1.6; g.lineJoin = 'round';
      if (document.documentElement.dataset.glow === '1') { g.shadowColor = col.t[0]; g.shadowBlur = 6; }
      g.beginPath();
      if (m > W * 2) {                                   // больше точек, чем пикселей: столбики мин-макс
        for (let x = 0; x < W; x++) {
          const i0 = a + m * x / W | 0, i1 = Math.max(i0 + 1, a + m * (x + 1) / W | 0); let lo = Infinity, hi = -Infinity;
          for (let i = i0; i < i1 && i < n; i++) { if (v[i] < lo) lo = v[i]; if (v[i] > hi) hi = v[i]; }
          if (lo === Infinity) continue;
          g.moveTo(x + .5, Yv(lo, H)); g.lineTo(x + .5, Yv(hi, H) - .5);
        }
      } else {
        const X = i => (i - a) / (m - 1) * W;
        if (cfg.dots) for (let i = a | 0; i < b && i < n; i++) g.rect(X(i) - 1, Yv(v[i], H) - 1, 2.2, 2.2);
        else { let pen = false; for (let i = Math.max(0, a - 1 | 0); i < Math.min(n, b + 2); i++) { const x = X(i), y = Yv(v[i], H); if (!pen) { g.moveTo(x, y); pen = true; } else g.lineTo(x, y); } }
      }
      if (cfg.dots && m <= W * 2) g.fill(); else g.stroke();
      g.shadowBlur = 0;
    }
    function draw() {
      const g = p.g, W = p.w, H = p.h, col = Theme.colors;
      g.fillStyle = col.screen; g.fillRect(0, 0, W, H);
      graticule(g, W, H, col);
      dpo.key(`${c.ts}|${c.vs}|${c.offs}|${c.coup}`);
      if (frame && cfg.dpo && frame.screen) {
        dpo.draw(g, W, H, col);
      } else if (frame) {
        if (cfg.persist && frame.screen) {
          tg.globalCompositeOperation = 'destination-out'; tg.fillStyle = `rgba(0,0,0,${cfg.persist === 1 ? .22 : .06})`; tg.fillRect(0, 0, W, H);
          tg.globalCompositeOperation = 'source-over'; tg.globalAlpha = .9; trace(tg, W, H, col); tg.globalAlpha = 1;
          g.drawImage(trail, 0, 0, W, H);
        } else trace(g, W, H, col);
      }
      // маркеры смещения и уровня запуска
      g.font = FONT(10, 600);
      const y0 = Yv(0, H), yt = Yv(c.tl, H);
      g.fillStyle = col.t[0]; g.beginPath(); g.moveTo(0, y0 - 6); g.lineTo(10, y0); g.lineTo(0, y0 + 6); g.fill();
      g.fillStyle = col.accent; g.beginPath(); g.moveTo(W, yt - 6); g.lineTo(W - 10, yt); g.lineTo(W, yt + 6); g.fill();
      g.setLineDash([4, 4]); g.strokeStyle = col.accent; g.globalAlpha = .45; g.beginPath(); g.moveTo(0, yt + .5); g.lineTo(W, yt + .5); g.stroke(); g.setLineDash([]); g.globalAlpha = 1;
      g.fillStyle = col.ink2; g.textAlign = 'left';
      g.fillText(`${fmtV(c.vs)}/дел`, 16, 14); g.textAlign = 'right'; g.fillText(`${fmtT(c.ts)}/дел`, W - 16, 14); g.textAlign = 'left';
      if (cfg.cursors) {
        const u = cfg.cur, x1 = u.t1 * W, x2 = u.t2 * W, y1 = u.v1 * H, y2 = u.v2 * H;
        g.strokeStyle = col.t[1]; g.lineWidth = 1; g.setLineDash([5, 3]); g.beginPath();
        for (const x of [x1, x2]) { g.moveTo(x + .5, 0); g.lineTo(x + .5, H); }
        for (const y of [y1, y2]) { g.moveTo(0, y + .5); g.lineTo(W, y + .5); }
        g.stroke(); g.setLineDash([]);
        const dt = Math.abs(u.t2 - u.t1) * 10 * c.ts * (view.b - view.a), dv = Math.abs(u.v2 - u.v1) * 8 * c.vs;
        curBox.hidden = false; curBox.textContent = `Δt ${fmtSI(dt, 's', 4)} · 1/Δt ${fmtSI(1 / dt, 'Hz', 4)} · ΔV ${fmtSI(dv, 'V', 4)}`;
      } else if (curBox) curBox.hidden = true;
      for (const b of measBox.querySelectorAll('b[data-k]')) b.textContent = fmtSI(stats[b.dataset.k], MEAS[b.dataset.k][1], 4);
      feedFft();
    }
    /* спектр считается по новому кадру; у записи прибора по видимой части */
    let fedF = null, fedA = -1, fedB = -1;
    function feedFft() {
      if (!cfg.fft || !frame || (frame === fedF && view.a === fedA && view.b === fedB)) return;
      fedF = frame; fedA = view.a; fedB = view.b;
      const n = frame.v.length, a = frame.screen ? 0 : view.a * n | 0, b = frame.screen ? n : Math.max(a + 16, view.b * n | 0);
      sp.update(frame.v.subarray(a, Math.min(b, a + 65536)), frame.xinc);
    }

    /* мышь: перетаскивание маркеров, курсоров, масштаб */
    let drag = null, sendAt = 0;
    scr.addEventListener('pointerdown', e => {
      const r = scr.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, W = p.w, H = p.h, u = cfg.cur;
      if (x > W - 22) drag = { k: 'tl' };
      else if (x < 22) drag = { k: 'off', y, o: c.offs };
      else if (cfg.cursors) {
        for (const [k, px, ax] of [['t1', u.t1 * W, x], ['t2', u.t2 * W, x], ['v1', u.v1 * H, y], ['v2', u.v2 * H, y]]) if (Math.abs(px - ax) < 7) { drag = { k }; break; }
      }
      if (!drag && !frame?.screen && frame) drag = { k: 'pan', x, a: view.a, b: view.b };
      if (drag) scr.setPointerCapture(e.pointerId);
    });
    scr.addEventListener('pointermove', e => {
      if (!drag) return;
      const r = scr.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, W = p.w, H = p.h, now = performance.now();
      if (drag.k === 'tl') { c.tl = +((H / 2 - y) / (H / 8) * c.vs - c.offs).toPrecision(3); lvl.value = c.tl; if (now - sendAt > 90) { sendAt = now; dev.w(`TRIG:LEV ${c.tl}`).catch(() => { }); } }
      else if (drag.k === 'off') { c.offs = +(drag.o + (drag.y - y) / (H / 8) * c.vs).toPrecision(3); offs.value = c.offs; if (now - sendAt > 90) { sendAt = now; dev.w(`CHAN1:OFFS ${c.offs}`).catch(() => { }); } }
      else if (drag.k === 'pan') { const sp = drag.b - drag.a, d = -(x - drag.x) / W * sp, a = clamp(drag.a + d, 0, 1 - sp); view = { a, b: a + sp }; }
      else if (drag.k[0] === 't') cfg.cur[drag.k] = clamp(x / W, 0, 1); else cfg.cur[drag.k] = clamp(y / H, 0, 1);
      dirty = true;
    });
    scr.addEventListener('pointerup', () => { if (drag?.k === 'tl') dev.w(`TRIG:LEV ${c.tl}`).catch(() => { }); if (drag?.k === 'off') dev.w(`CHAN1:OFFS ${c.offs}`).catch(() => { }); drag = null; WM.save(); });
    scr.addEventListener('wheel', e => {
      e.preventDefault();
      const dir = e.deltaY > 0 ? 1 : -1;
      if (frame && !frame.screen) {
        const r = scr.getBoundingClientRect(), f = (e.clientX - r.left) / p.w, sp = view.b - view.a, ns = clamp(sp * (dir > 0 ? 1.3 : .77), 8 / frame.v.length, 1), c0 = view.a + sp * f, a = clamp(c0 - ns * f, 0, 1 - ns);
        view = { a, b: a + ns }; dirty = true; return;
      }
      if (e.ctrlKey || e.shiftKey) { const v = stepIn(VOLT_STEPS, c.vs, dir); dev.scope(`CHAN1:SCAL ${v}`, { vs: v }).catch(errToast); }
      else { const v = stepIn(TIME_STEPS, c.ts, dir); dev.scope(`TIM:SCAL ${v}`, { ts: v }).catch(errToast); }
    }, { passive: false });
    return { tick() { if (dirty) { dirty = false; draw(); } if (cfg.fft) sp.tick(); }, dispose() { c.scopeUsers--; p.dispose(); sp.dispose(); } };
  },
});

/* ---------- DM40: генератор ---------- */
WM.define('dm40-gen', {
  title: 'Генератор DM40', dev: 'dm40', devName: 'DM40', w: 400, h: 330,
  make(win, dev) {
    const s = dev.s;
    const send = (cmd, then) => dev.w(cmd).then(then).catch(errToast);
    const wave = seg([['SIN', 'Синус'], ['SQU', 'Меандр'], ['TRI', 'Треугольник'], ['RAMP', 'Пила']], 'SIN', v => { send('SOUR:FUNC ' + v); duty.hidden = v !== 'SQU'; }, 'Форма сигнала');
    const num = (label, cmd, fix) => {
      const i = h('input', { type: 'text', inputmode: 'decimal', 'aria-label': label, onchange: () => { const v = parseFloat(i.value.replace(',', '.')); if (Number.isFinite(v)) send(`${cmd} ${v}`, read); } });
      const f = field(label, i); f.input = i; f.show = x => { if (document.activeElement !== i) i.value = +(+x).toFixed(fix); }; return f;
    };
    const freq = num('Частота, Гц', 'SOUR:FREQ', 3), vpp = num('Размах, В', 'SOUR:VOLT', 3), off = num('Центр, В', 'SOUR:VOLT:OFFS', 3), duty = num('Заполнение, %', 'SOUR:FUNC:SQU:DCYC', 2);
    const output = toggle('Выход включён', false, v => send(`OUTP ${v ? 'ON' : 'OFF'}`));
    const fast = h('div', { class: 'row wrap' }, ...[10, 100, 1000, 10000, 50000].map(f => h('button', { class: 'tbtn', onclick: () => send(`SOUR:FREQ ${f}`, read) }, fmtSI(f, 'Hz', 3))));
    win.body.append(h('div', { class: 'col pad' }, wave, freq, fast, h('div', { class: 'row' }, vpp, off), duty, output, h('small', { class: 'note', text: 'Синус, треугольник и пила до 50 кГц, меандр до 10 МГц, размах до 3 В.' })));
    async function read() {
      try {
        const r = (await dev.q('SOUR:FUNC?;SOUR:FREQ?;SOUR:VOLT?;SOUR:VOLT:OFFS?;SOUR:FUNC:SQU:DCYC?;OUTP?')).split(';');
        wave.set(r[0]); duty.hidden = r[0] !== 'SQU'; freq.show(+r[1]); vpp.show(+r[2]); off.show(+r[3]); duty.show(+r[4]); output.set(r[5] === '1');
      } catch (e) { errToast(e); }
    }
    read();
  },
});

/* ---------- DM40: ваттметр ---------- */
WM.define('dm40-power', {
  title: 'Ваттметр DM40', dev: 'dm40', devName: 'DM40', w: 520, h: 300,
  make(win, dev) {
    const list = [['p', 'P', 'W'], ['s', 'S', 'VA'], ['r', 'Q', 'var'], ['pf', 'PF', ''], ['v', 'U', 'V'], ['i', 'I', 'A'], ['f', 'f', 'Hz'], ['e', 'E', 'Wh']], cells = {};
    const grid = h('div', { class: 'tiles' });
    for (const [k, t] of list) { cells[k] = h('b'); grid.append(h('div', { class: 'tile' }, h('span', { text: t }), cells[k])); }
    const coup = seg([['DC', 'DC'], ['AC', 'AC'], ['ACDC', 'AC+DC']], 'AC', v => dev.w('POW:COUP ' + v).catch(errToast), 'Род тока');
    win.body.append(h('div', { class: 'col pad' }, h('div', { class: 'row wrap' }, h('button', { class: 'btn primary', onclick: () => dev.setFunc('POW').catch(errToast) }, 'Включить ваттметр'), coup, h('button', { class: 'btn', onclick: () => dev.w('POW:ENER:RES').catch(errToast) }, 'Сбросить энергию')), grid));
    return { tick() { for (const [k, , u] of list) { const q = Hub.q.get('dm40.pw_' + k); cells[k].textContent = q && q.n ? fmtSI(q.last, u, 4) : '–'; } } };
  },
});

/* ---------- DM40: быстрый поток ---------- */
WM.define('dm40-stream', {
  title: 'Поток преобразователя DM40', dev: 'dm40', devName: 'DM40', w: 620, h: 380,
  make(win, dev, cfg) {
    cfg.src ??= 'AD1'; cfg.osr ??= 3; cfg.rate ??= 4800;
    let run = false, data = new Float64Array(1 << 18), n = 0, a = 0, b = 1, dirty = true, got = 0, t0 = 0;
    const box = h('div', { class: 'chart' }), note = h('span', { class: 'note' });
    const src = seg([['AD1', 'AD1 (DC)'], ['AD2', 'AD2 (быстрый)']], cfg.src, v => { cfg.src = v; ui(); WM.save(); }, 'Источник');
    const osr = select([[0, '320/с'], [1, '160/с'], [2, '80/с'], [3, '40/с'], [4, '20/с'], [5, '10/с'], [6, '5/с'], [7, '2,5/с']], cfg.osr, v => { cfg.osr = +v; WM.save(); }, 'Скорость AD1');
    const rate = select([1200, 2400, 4800, 9600, 19200, 38400, 76800].map(v => [v, v + ' /с']), cfg.rate, v => { cfg.rate = +v; WM.save(); }, 'Скорость AD2');
    const go = h('button', { class: 'btn primary', onclick: () => run ? stop() : start() }, 'Пуск');
    const sv = h('button', { class: 'btn', onclick: () => { const r = ['Отсчёт;Значение']; for (let i = 0; i < n; i++) r.push(`${i};${data[i]}`); saveFile(`dm40-potok-${stamp()}.csv`, r.join('\n'), 'text/csv'); } }, 'CSV');
    win.body.append(h('div', { class: 'col' }, h('div', { class: 'row wrap pad' }, src, osr, rate, go, sv, note), h('div', { class: 'chart-wrap' }, box)));
    const p = new Plot(box);
    function ui() { osr.hidden = cfg.src !== 'AD1'; rate.hidden = cfg.src !== 'AD2'; }
    ui();
    async function start() {
      try {
        await dev.w(`LOG:SOUR ${cfg.src};LOG:OSR ${cfg.osr};LOG:SRAT ${cfg.rate};LOG:DEST HOST;LOG:FORM ROWS`);
        await dev.w('LOG:STAT ON');
        const sc = (await dev.q('LOG:SCAL?')).split(',').map(parseFloat);
        a = sc[0] || 0; b = sc[1] || 1;
        run = true; n = 0; got = 0; t0 = performance.now(); go.textContent = 'Стоп';
        while (run && dev.alive) {
          const d = await dev.link.block('LOG:DATA?', { timeout: 3000 });
          const k = Math.floor(d.length / 12), v = new DataView(d.buffer, d.byteOffset, d.length);
          for (let i = 0; i < k; i++) { const x = a + b * v.getInt32(i * 12 + 8, true); data[n % data.length] = x; n++; }
          got += k; dirty = true;
          note.textContent = `${n} отсчётов · ${(got / ((performance.now() - t0) / 1000)).toFixed(0)} /с`;
          if (!k) await sleep(30);
        }
      } catch (e) { errToast(e); }
      run = false; go.textContent = 'Пуск';
      await dev.w('LOG:STAT OFF').catch(() => { });
    }
    function stop() { run = false; }
    return {
      tick() {
        if (!dirty) return; dirty = false;
        const g = p.g, W = p.w, H = p.h, col = Theme.colors, L = 62, c = Math.min(n, W * 40), s = Math.max(0, n - c);
        g.clearRect(0, 0, W, H); if (!c) return;
        let lo = Infinity, hi = -Infinity;
        for (let i = s; i < n; i++) { const v = data[i % data.length]; if (v < lo) lo = v; if (v > hi) hi = v; }
        const m = (hi - lo) * .06 || 1; lo -= m; hi += m; const Y = v => 6 + (hi - v) / (hi - lo) * (H - 12);
        g.font = FONT(10); g.textAlign = 'right'; g.fillStyle = col.ink3; g.strokeStyle = col.grid;
        for (const v of niceTicks(lo, hi, 5)) { const y = Y(v); g.beginPath(); g.moveTo(L, y + .5); g.lineTo(W, y + .5); g.stroke(); g.fillText(v.toPrecision(5), L - 4, y + 3); }
        g.strokeStyle = col.t[0]; g.lineWidth = 1.5; g.beginPath();
        for (let x = 0; x < W - L; x++) {
          const i0 = s + (c * x / (W - L) | 0), i1 = s + (c * (x + 1) / (W - L) | 0); let a2 = Infinity, b2 = -Infinity;
          for (let i = i0; i <= i1 && i < n; i++) { const v = data[i % data.length]; if (v < a2) a2 = v; if (v > b2) b2 = v; }
          if (a2 === Infinity) continue; g.moveTo(L + x + .5, Y(a2)); g.lineTo(L + x + .5, Y(b2) - .5);
        }
        g.stroke();
      },
      dispose() { run = false; p.dispose(); },
    };
  },
});

/* ---------- DM40: декодер ---------- */
WM.define('dm40-decode', {
  title: 'Декодер DM40', dev: 'dm40', devName: 'DM40', w: 640, h: 360,
  make(win, dev, cfg) {
    const sw = (cmd, v) => dev.w(`${cmd} ${v}`).catch(errToast);
    const prot = seg([['OFF', 'Выкл'], ['UART', 'UART / Modbus'], ['DALI', 'DALI']], 'OFF', v => sw('DEC:PROT', v), 'Протокол');
    const baud = h('input', { value: 'AUTO', 'aria-label': 'Скорость', onchange: () => sw('DEC:BAUD', baud.value) });
    const form = select(['8N1', '8E1', '8O1', '7E1'].map(x => [x, x]), '8N1', v => sw('DEC:FORM', v), 'Формат');
    const pol = seg([['NORM', 'Прямая'], ['INV', 'Инверсия']], 'NORM', v => sw('DEC:POL', v), 'Полярность');
    const tb = h('tbody'), autoR = toggle('Обновлять', true, () => { });
    win.body.append(h('div', { class: 'col' }, h('div', { class: 'row wrap pad' }, prot, field('Бод', baud), form, pol, autoR), h('div', { class: 'scroll' }, h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, ...['№', 'Время, с', 'Тип', 'Данные', 'Статус', 'Разбор'].map(t => h('th', { text: t })))), tb))));
    let timer = setInterval(async () => {
      if (!autoR.getAttribute('aria-pressed') || autoR.getAttribute('aria-pressed') === 'false' || document.hidden) return;
      try {
        const d = await dev.link.block('DEC:FRAM?', { timeout: 2000 }), lines = dec.decode(d).trim().split('\n').filter(Boolean);
        tb.replaceChildren(...lines.slice(-200).map(l => h('tr', {}, ...l.split(',').map(x => h('td', { text: x })))));
      } catch { }
    }, 1000);
    dev.q('DEC:PROT?;DEC:BAUD?;DEC:FORM?;DEC:POL?').then(r => { const a = r.split(';'); prot.set(a[0]); baud.value = a[1]; form.value = a[2]; pol.set(a[3]); }).catch(() => { });
    return { dispose() { clearInterval(timer); } };
  },
});

/* ---------- DM40: пусковой ток ---------- */
WM.define('dm40-inrush', {
  title: 'Пусковой ток DM40', dev: 'dm40', devName: 'DM40', w: 560, h: 360,
  make(win, dev) {
    const box = h('div', { class: 'chart' }), st = h('span', { class: 'chip' }), res = h('span', { class: 'note' }), thr = h('input', { value: '1', inputmode: 'decimal', 'aria-label': 'Порог, А', onchange: () => dev.w(`INR:THR ${thr.value.replace(',', '.')}`).catch(errToast) });
    const go = h('button', { class: 'btn primary', onclick: () => dev.w('INR ON;INR:ARM').catch(errToast) }, 'Взвести'), off = h('button', { class: 'btn', onclick: () => dev.w('INR OFF').catch(errToast) }, 'Закрыть страницу');
    const load = h('button', { class: 'btn', onclick: read }, 'Прочитать кривую');
    win.body.append(h('div', { class: 'col' }, h('div', { class: 'row wrap pad' }, go, off, load, field('Порог, А', thr), st, res), h('div', { class: 'chart-wrap' }, box)));
    const p = new Plot(box); let wave = null;
    const ids = { OFF: 'Выкл', IDLE: 'Готов', ARMING: 'Взводится', ARMED: 'Ждёт', TRIGGERED: 'Сработал', SAVING: 'Сохраняет', DONE: 'Готово' };
    const t = setInterval(async () => { if (document.hidden) return; try { const r = await dev.q('INR:COND?'); st.textContent = ids[r] || r; } catch { } }, 700);
    async function read() {
      try {
        const pre = (await dev.q('INR:PRE?')).split(',').map(parseFloat), cnt = pre[1] || 0, v = new Float32Array(cnt);
        for (let i = 0; i < cnt; i += 3000) {
          const d = await dev.link.block(`INR:DATA? ${i},3000`, { timeout: 3000 }), dv = new DataView(d.buffer, d.byteOffset, d.length);
          for (let k = 0; k < d.length >> 1; k++) v[i + k] = pre[3] + pre[4] * dv.getUint16(k * 2, true);
          res.textContent = `Читаю ${i} из ${cnt}`;
        }
        const f = (await dev.q('INR:FETC?')).split(',').map(parseFloat);
        res.textContent = `Iпик ${fmtSI(f[1], 'A', 4)} · I за 100 мс ${fmtSI(f[0], 'A', 4)} · покой ${fmtSI(f[2], 'A', 4)}`;
        wave = v; draw();
      } catch (e) { errToast(e); }
    }
    function draw() {
      if (!wave) return;
      const g = p.g, W = p.w, H = p.h, col = Theme.colors, L = 56; g.clearRect(0, 0, W, H);
      let lo = Infinity, hi = -Infinity; for (const v of wave) { if (v < lo) lo = v; if (v > hi) hi = v; }
      const Y = v => 6 + (hi - v) / (hi - lo || 1) * (H - 12); g.font = FONT(10); g.textAlign = 'right'; g.fillStyle = col.ink3; g.strokeStyle = col.grid;
      for (const v of niceTicks(lo, hi, 5)) { const y = Y(v); g.beginPath(); g.moveTo(L, y + .5); g.lineTo(W, y + .5); g.stroke(); g.fillText(fmtSI(v, 'A', 3), L - 4, y + 3); }
      g.strokeStyle = col.t[0]; g.lineWidth = 1.5; g.beginPath(); const n = wave.length;
      for (let x = 0; x < W - L; x++) { const i0 = n * x / (W - L) | 0, i1 = n * (x + 1) / (W - L) | 0; let a = Infinity, b = -Infinity; for (let i = i0; i <= i1 && i < n; i++) { if (wave[i] < a) a = wave[i]; if (wave[i] > b) b = wave[i]; } g.moveTo(L + x + .5, Y(a)); g.lineTo(L + x + .5, Y(b)); }
      g.stroke();
    }
    p.onresize = draw;
    return { dispose() { clearInterval(t); p.dispose(); } };
  },
});

/* ---------- DM40: файлы ---------- */
WM.define('dm40-files', {
  title: 'Файлы DM40', dev: 'dm40', devName: 'DM40', w: 560, h: 360,
  make(win, dev) {
    const tb = h('tbody'), info = h('span', { class: 'note' }), preview = h('div', { class: 'preview', hidden: true });
    win.toolbar.append(h('button', { class: 'tbtn', onclick: list }, 'Обновить'));
    win.body.append(h('div', { class: 'col' }, h('div', { class: 'pad' }, info), h('div', { class: 'scroll' }, h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, ...['Файл', 'Размер', ''].map(t => h('th', { text: t })))), tb)), preview));
    async function fetchFile(name, size) {
      const parts = []; let off = 0;
      while (off < size || !size) {
        const d = await dev.link.block(`MMEM:DATA? "${name}",${off},6000`, { timeout: 5000 });
        parts.push(d.slice()); off += d.length; info.textContent = `${name}: ${off} из ${size}`;
        if (d.length < 6000) break;
      }
      return new Blob(parts);
    }
    async function list() {
      try {
        const r = await dev.q('MMEM:CAT?', { timeout: 5000 }), m = r.match(/^(\d+),(\d+)/), files = [...r.matchAll(/"([^,"]+),BIN,(\d+)"/g)];
        if (m) info.textContent = `Занято ${fmtSI(+m[1], 'B', 3)}, свободно ${fmtSI(+m[2], 'B', 3)}`;
        tb.replaceChildren(...files.map(([, name, size]) => h('tr', {}, h('td', { text: name }), h('td', { class: 'num', text: fmtSI(+size, 'B', 3) }), h('td', { class: 'row' },
          h('button', { class: 'tbtn', onclick: async () => { try { saveFile(name.split('/').pop(), await fetchFile(name, +size)); } catch (e) { errToast(e); } } }, 'Скачать'),
          /\.BMP$/i.test(name) && h('button', { class: 'tbtn', onclick: async () => { try { const b = await fetchFile(name, +size); preview.replaceChildren(h('img', { src: URL.createObjectURL(b), alt: name })); preview.hidden = false; } catch (e) { errToast(e); } } }, 'Показать'),
          dev.viaUsb && h('button', { class: 'tbtn', onclick: e => { const b = e.target; if (b.dataset.sure) { dev.w(`MMEM:DEL "${name}"`).then(list).catch(errToast); } else { b.dataset.sure = 1; b.textContent = 'Точно удалить?'; } } }, 'Удалить')))));
      } catch (e) { errToast(e); }
    }
    list();
  },
});

/* ---------- DM40: экран прибора. Любая функция доступна касанием ---------- */
WM.define('dm40-screen', {
  title: 'Экран DM40', dev: 'dm40', devName: 'DM40', w: 560, h: 440,
  make(win, dev, cfg) {
    const cv = h('canvas', { width: 480, height: 320, class: 'lcd', title: 'Нажатие передаётся на экран прибора' }), ctx = cv.getContext('2d', { willReadFrequently: true });
    const bar = h('i', { class: 'fill' }), prog = h('div', { class: 'bargraph thin' }, bar);
    let busy = false, auto = false;
    const shot = async () => {
      if (busy) return; busy = true;
      try { await dev.readScreen(ctx, f => { bar.style.width = f * 100 + '%'; }); } catch (e) { errToast(e); auto = false; autoB.set(false); }
      busy = false; bar.style.width = '0';
    };
    const autoB = toggle('Обновлять', false, v => { auto = v; });
    const keys = [['MENU', 0], ['RUN', 1], ['AUTO', 2], ['MF', 3]].map(([t, k]) => h('button', { class: 'tbtn', onclick: () => dev.w(`DBG:KEY ${k}`).catch(errToast) }, t));
    const sw = [['← жест', 'L'], ['жест →', 'R']].map(([t, k]) => h('button', { class: 'tbtn', onclick: () => dev.w(`DBG:SWIPE ${k}`).catch(errToast) }, t));
    cv.addEventListener('click', e => { const r = cv.getBoundingClientRect(), x = Math.round((e.clientX - r.left) / r.width * 480), y = Math.round((e.clientY - r.top) / r.height * 320); dev.w(`DBG:TAP ${x},${y}`).then(() => sleep(350)).then(shot).catch(errToast); });
    const note = !dev.viaUsb && h('p', { class: 'note', text: 'Экран читается только через USB: по Bluetooth отладочные команды закрыты.' });
    win.body.append(h('div', { class: 'col pad' }, h('div', { class: 'row wrap' }, h('button', { class: 'btn primary', onclick: shot }, 'Снимок'), autoB, ...keys, ...sw), prog, note, h('div', { class: 'lcd-wrap' }, cv)));
    const t = setInterval(() => { if (auto && !document.hidden) shot(); }, 2500);
    return { dispose() { clearInterval(t); } };
  },
});

/* ---------- LT1: измеритель ---------- */
const LT1_MAIN = { 1: ['r', 'R'], 2: ['c', 'C'], 3: ['l', 'L'] };
WM.define('lt1-lcr', {
  title: 'Измеритель LT1', dev: 'lt1', devName: 'LT1', w: 560, h: 440,
  make(win, dev, cfg) {
    const c = dev.s;
    cfg.sec ??= ['d', 'q', 'theta', 'z'];
    const num = h('div', { class: 'digits' }), unit = h('div', { class: 'unit' }), kind = h('b'), meta = h('span'), secBox = h('div', { class: 'tiles small' });
    const ALL = [['z', '|Z|'], ['r', 'R'], ['x', 'X'], ['theta', 'θ'], ['d', 'D'], ['q', 'Q'], ['c', 'C'], ['l', 'L'], ['rp', 'Rp'], ['cp', 'Cp'], ['lp', 'Lp'], ['y', '|Y|']];
    const mode = seg([['AUTO', 'Авто'], ['R', 'R'], ['C', 'C'], ['L', 'L'], ['D', 'Диод']], c.mode, v => dev.set('mode', 'LCR:MODE', v).catch(errToast), 'Режим');
    const freq = seg(LT1_FREQ.map(f => [f, fmtSI(f, 'Hz', 3).replace('.00', '').replace('.0 ', ' ')]), c.freq, v => dev.set('freq', 'LCR:FREQ', +v).then(() => sleep(30)).then(() => dev.readState()).catch(errToast), 'Частота');
    const lev = seg(LT1_LEV.map(l => [l, l.toFixed(1).replace('.', ',') + ' В']), c.lev, v => dev.set('lev', 'LCR:LEV', +v).catch(errToast), 'Уровень');
    const circ = seg([[0, 'Послед.'], [1, 'Парал.'], [2, 'Обе']], c.circ, v => dev.set('circ', 'LCR:CIRC', +v).catch(errToast), 'Схема');
    const aver = seg([[0, 'Выкл'], [1, 'Слабое'], [2, 'Среднее'], [3, 'Сильное']], c.aver, v => dev.set('aver', 'LCR:AVER', +v).catch(errToast), 'Усреднение');
    const ah = seg([[0, 'Выкл'], [1, '0,1 %'], [2, '0,5 %'], [3, '2 %']], c.ah, v => dev.set('ah', 'LCR:AHOLD', +v).catch(errToast), 'Auto Hold');
    const hold = toggle('Hold', !!c.hold, v => dev.set('hold', 'LCR:HOLD', v ? 1 : 0).catch(errToast));
    const pick = select([['', 'Добавить показание…'], ...ALL], '', v => { if (v && !cfg.sec.includes(v)) { cfg.sec.push(v); tiles(); WM.save(); } pick.value = ''; }, 'Добавить показание');
    const info = h('span', { class: 'note' });
    win.toolbar.append(pick);
    const box = h('div', { class: 'reading dmm' }, h('div', { class: 'rd-head' }, kind, meta), h('div', { class: 'big' }, num, unit), secBox,
      h('div', { class: 'ctl-grid' }, field('Режим', mode), field('Частота', freq), field('Уровень', lev), field('Схема', circ), field('Усреднение', aver), field('Auto Hold', ah)), h('div', { class: 'row' }, hold, info));
    win.body.append(box);
    let cells = [];
    function tiles() {
      secBox.replaceChildren(); cells = [];
      for (const k of cfg.sec) {
        const b = h('b'), name = ALL.find(a => a[0] === k)?.[1] || k;
        secBox.append(h('div', { class: 'tile' }, h('span', {}, name, h('button', { class: 'wbtn', 'aria-label': 'Убрать показание', onclick: () => { cfg.sec = cfg.sec.filter(x => x !== k); tiles(); WM.save(); } }, '×')), b));
        cells.push([k, b]);
      }
    }
    tiles();
    function ui() {
      mode.set(c.mode); freq.set(c.freq); lev.set(c.lev); circ.set(c.circ); aver.set(c.aver); ah.set(c.ah); hold.set(!!c.hold);
      const b = lev.btns.find(x => x.dataset.v === '1'); if (b) { b.disabled = c.freq === 100000; b.title = c.freq === 100000 ? 'На 100 кГц выход ограничен примерно 0,57 В' : ''; }
    }
    ui(); win.sub(dev, 'lcr', ui);
    win.sub(dev, 'rate', () => { info.textContent = `${c.rate.toFixed(1)} изм/с · усиления ${c.vg} / ${c.ig}`; });
    let seq = -1, rev = -1;
    return {
      tick() {
        if (seq === c.seq && rev === Theme.rev) return; seq = c.seq; rev = Theme.rev;
        const [k, sym] = LT1_MAIN[c.type] || LT1_MAIN[1], q = Hub.q.get('lt1.' + (c.mode === 'AUTO' || c.mode === 'D' ? k : ({ R: 'r', C: 'c', L: 'l' })[c.mode]));
        if (!q) return;
        const p = siParts(q.last, q.unit, 6); setDigits(num, p.text); unit.textContent = p.unit; kind.textContent = q.name;
        meta.textContent = `${fmtSI(c.mfreq ?? c.freq, 'Hz', 3)} · ${String(c.mlev ?? c.lev).replace('.', ',')} В${c.hold ? ' · HOLD' : ''}`;
        for (const [id, b] of cells) { const x = Hub.q.get('lt1.' + id); b.textContent = x ? fmtSI(x.last, x.unit, 5) : '–'; }
      },
    };
  },
});

/* ---------- LT1: АЧХ и ФЧХ. Две дорожки, общая ось частоты ---------- */
const SW_Q = [['z', '|Z|', 'Ω'], ['theta', 'θ', '°'], ['r', 'R', 'Ω'], ['x', 'X', 'Ω'], ['d', 'D', ''], ['q', 'Q', ''], ['c', 'C', 'F'], ['l', 'L', 'H'], ['y', '|Y|', 'S']];

WM.define('lt1-sweep', {
  title: 'АЧХ и ФЧХ LT1', dev: 'lt1', devName: 'LT1', w: 760, h: 500,
  make(win, dev, cfg) {
    const c = dev.s;
    cfg.top ??= 'z'; cfg.bot ??= 'theta'; cfg.speed ??= 1;
    let ref = null, hover = null, tableOn = false;
    const box = h('div', { class: 'chart' }), tip = h('div', { class: 'tip', hidden: true }), prog = h('i', { class: 'fill' }), status = h('span', { class: 'note' });
    const tbl = h('div', { class: 'scroll', hidden: true });
    const go = h('button', { class: 'btn primary', onclick: () => c.swRun ? dev.stopSweep().catch(errToast) : dev.sweep(cfg.speed).catch(errToast) });
    const speed = seg([[2, 'Быстро'], [1, 'Обычно'], [0, 'Точно']], cfg.speed, v => { cfg.speed = +v; WM.save(); }, 'Скорость скана');
    const sel = (k, label) => select(SW_Q.map(q => [q[0], q[1]]), cfg[k], v => { cfg[k] = v; dirty = true; WM.save(); fillTable(); }, label);
    const refB = h('button', { class: 'btn', onclick: () => { ref = c.sweep; dirty = true; } }, 'Запомнить кривую');
    const asTable = toggle('Таблица', false, v => { tableOn = v; tbl.hidden = !v; box.parentElement.hidden = v; fillTable(); });
    const csv = h('button', { class: 'btn', onclick: saveCsv }, 'CSV');
    win.body.append(h('div', { class: 'col' }, h('div', { class: 'row wrap pad' }, go, speed, field('Верх', sel('top', 'Верхняя дорожка')), field('Низ', sel('bot', 'Нижняя дорожка')), refB, asTable, csv, status), h('div', { class: 'bargraph thin' }, prog), h('div', { class: 'chart-wrap' }, box, tip), tbl));
    const p = new Plot(box); let dirty = true;
    const val = (s, i, k) => dev.derive(s.f[i], s.re[i], s.im[i])[k];
    function ui() {
      go.textContent = c.swRun ? 'Остановить' : 'Снять 100 точек'; prog.style.width = c.swDone + '%';
      status.textContent = c.swRun ? `Точка ${c.swDone} из 100` : c.sweep ? `Снято ${c.sweep.n} точек` : '';
      dirty = true; if (tableOn) fillTable();
    }
    ui(); win.sub(dev, 'sweep', ui); win.sub(Bus, 'theme', () => { dirty = true; });
    function fillTable() {
      if (!tableOn || !c.sweep) return;
      const s = c.sweep, ks = [cfg.top, cfg.bot];
      const uk = k => SW_Q.find(q => q[0] === k);
      const rows = []; for (let i = 0; i < s.n; i++) rows.push(h('tr', {}, h('td', { class: 'num', text: fmtSI(s.f[i], 'Hz', 4) }), ...ks.map(k => h('td', { class: 'num', text: fmtSI(val(s, i, k), uk(k)[2], 5) }))));
      tbl.replaceChildren(h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, h('th', { text: 'Частота' }), ...ks.map(k => h('th', { text: uk(k)[1] })))), h('tbody', {}, ...rows)));
    }
    function saveCsv() {
      const s = c.sweep; if (!s) return;
      const r = ['Частота, Гц;Re Z, Ом;Im Z, Ом;|Z|, Ом;Фаза, °;D;Q;Cs, Ф;Ls, Гн'];
      for (let i = 0; i < s.n; i++) { const d = dev.derive(s.f[i], s.re[i], s.im[i]); r.push([s.f[i], s.re[i], s.im[i], d.z, d.theta, d.d, d.q, d.c, d.l].map(x => (+x).toPrecision(7)).join(';')); }
      saveFile(`lt1-sweep-${stamp()}.csv`, '﻿' + r.join('\n'), 'text/csv');
    }
    box.addEventListener('pointermove', e => { const r = box.getBoundingClientRect(); hover = { x: e.clientX - r.left, y: e.clientY - r.top }; dirty = true; });
    box.addEventListener('pointerleave', () => { hover = null; tip.hidden = true; dirty = true; });
    const F0 = 100, F1 = 100000;
    function lane(g, s, r, k, y0, H, L, W, col, X) {
      const q = SW_Q.find(x => x[0] === k), vals = []; for (let i = 0; i < s.n; i++) vals.push(val(s, i, k));
      const fin = vals.filter(v => Number.isFinite(v));
      let lo = Math.min(...fin), hi = Math.max(...fin);
      const log = lo > 0 && hi / lo > 20;
      if (!(hi > lo)) { hi = lo + 1; lo -= 1; }
      if (!log) { const m = (hi - lo) * .08; lo -= m; hi += m; }
      const Y = log ? v => y0 + H - (Math.log10(v) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo)) * H : v => y0 + H - (v - lo) / (hi - lo) * H;
      g.strokeStyle = col.line; g.lineWidth = 1; g.strokeRect(L + .5, y0 + .5, W - L - 12, H);
      g.font = FONT(10); g.textAlign = 'right'; g.fillStyle = col.ink3;
      if (log) { for (const t of logTicks(lo, hi)) { if (!t.major && hi / lo > 3000) continue; const y = Y(t.v); g.strokeStyle = col.grid; g.beginPath(); g.moveTo(L, y + .5); g.lineTo(W - 12, y + .5); g.stroke(); g.fillText(fmtSI(t.v, q[2], 2), L - 5, y + 3); } }
      else for (const v of niceTicks(lo, hi, Math.max(3, H / 38 | 0))) { const y = Y(v); if (y < y0 + 5 || y > y0 + H - 3) continue; g.strokeStyle = col.grid; g.beginPath(); g.moveTo(L, y + .5); g.lineTo(W - 12, y + .5); g.stroke(); g.fillText(fmtSI(v, q[2], 3), L - 5, y + 3); }
      g.textAlign = 'left'; g.fillStyle = col.ink2; g.font = FONT(11, 600); g.fillText(q[1], L + 8, y0 + 15);
      g.save(); g.beginPath(); g.rect(L, y0, W - L - 12, H); g.clip();
      if (r) {
        g.strokeStyle = col.ink3; g.lineWidth = 1.5; g.setLineDash([5, 4]); g.beginPath(); let pen = false;
        for (let i = 0; i < r.n; i++) { const v = val(r, i, k), x = X(r.f[i]); if (!Number.isFinite(v) || (log && v <= 0)) { pen = false; continue; } const y = Y(v); if (pen) g.lineTo(x, y); else g.moveTo(x, y); pen = true; }
        g.stroke(); g.setLineDash([]);
      }
      g.strokeStyle = col.t[0]; g.lineWidth = 2; g.lineJoin = 'round'; g.beginPath(); let pen = false;
      for (let i = 0; i < s.n; i++) { const v = vals[i], x = X(s.f[i]); if (!Number.isFinite(v) || (log && v <= 0)) { pen = false; continue; } const y = Y(v); if (pen) g.lineTo(x, y); else g.moveTo(x, y); pen = true; }
      g.stroke(); g.restore();
      return { Y, vals, q };
    }
    function draw() {
      const g = p.g, W = p.w, H = p.h, col = Theme.colors, L = 66, B = 22, gap = 10, s = c.sweep; g.clearRect(0, 0, W, H);
      if (!s || !s.n) { g.fillStyle = col.ink3; g.font = FONT(12); g.fillText('Подключите деталь и нажмите «Снять 100 точек»', L, 30); return; }
      const X = f => L + Math.log10(f / F0) / Math.log10(F1 / F0) * (W - L - 12), laneH = (H - B - gap) / 2;
      g.font = FONT(10);
      for (const t of logTicks(F0, F1)) { const x = X(t.v); g.strokeStyle = col.grid; g.beginPath(); g.moveTo(x + .5, 0); g.lineTo(x + .5, H - B); g.stroke(); g.fillStyle = col.ink3; g.textAlign = 'center'; if (t.major || W > 620) g.fillText(fmtSI(t.v, 'Hz', 2).replace('.0 ', ' '), x, H - 7); }
      const a = lane(g, s, ref, cfg.top, 0, laneH, L, W, col, X), b = lane(g, s, ref, cfg.bot, laneH + gap, laneH, L, W, col, X);
      if (hover && hover.x > L) {
        let i = 0, d = 1e9; for (let k = 0; k < s.n; k++) { const e = Math.abs(X(s.f[k]) - hover.x); if (e < d) { d = e; i = k; } }
        const x = X(s.f[i]); g.strokeStyle = col.ink3; g.setLineDash([3, 3]); g.lineWidth = 1; g.beginPath(); g.moveTo(x + .5, 0); g.lineTo(x + .5, H - B); g.stroke(); g.setLineDash([]);
        for (const l of [a, b]) { const v = l.vals[i]; if (!Number.isFinite(v)) continue; g.fillStyle = col.t[0]; g.strokeStyle = col.panel; g.lineWidth = 2; g.beginPath(); g.arc(x, l.Y(v), 4, 0, 6.3); g.fill(); g.stroke(); }
        tip.replaceChildren(h('div', {}, 'Частота', h('b', { text: fmtSI(s.f[i], 'Hz', 4) })), ...[a, b].map(l => h('div', {}, l.q[1], h('b', { text: fmtSI(l.vals[i], l.q[2], 5) }))));
        tip.hidden = false; tip.style.left = Math.min(x + 12, W - 170) + 'px'; tip.style.top = Math.min(hover.y + 10, H - 90) + 'px';
      }
    }
    return { tick() { if (dirty) { dirty = false; draw(); } }, dispose() { p.dispose(); } };
  },
});
