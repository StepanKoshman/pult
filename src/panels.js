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
    const freq = seg(dev.freqs.map(f => [f, fmtSI(f, 'Hz', 3).replace('.00', '').replace('.0 ', ' ')]), c.freq, v => dev.set('freq', 'LCR:FREQ', +v).then(() => sleep(30)).then(() => dev.readState()).catch(errToast), 'Частота');
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
      const b = lev.btns.find(x => x.dataset.v === '1'); if (b) { const top = c.freq === dev.freqs[4]; b.disabled = top; b.title = top ? `На ${dev.freqs[4] / 1000} кГц уровень 1 В недоступен` : ''; }
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
    const F0 = 100;                     // 2.2 sweeps to 50 kHz, older firmware to 100 kHz: the axis follows the data
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
      const F1 = s.f[s.n - 1] > 50001 ? 100000 : 50000, X = f => L + Math.log10(f / F0) / Math.log10(F1 / F0) * (W - L - 12), laneH = (H - B - gap) / 2;
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

/* ALIENTEK C2 (Lite, Std, Pro). Драйвер на родном протоколе EE (тот же, что у ATK-C) и окна.
   Протокол разобран по прошивке 3.8.0 и проверен на C2 Pro:
     1 сведения; 2 экран; 3 частота измерений; 4 поток измерений вкл/выкл; 5 триггер протоколов;
     6 выход из триггера; 8 сводка офлайн-записей; 9 чтение записи; 10 сброс счётчиков;
     12 прослушка линии CC (PD); 22/23/24 e-marker; 32 пинг.
   Команда 0x1E есть только в прошивке 4.2.0 и новее: калибровки, усреднение, чтение памяти.
   Вход в обновление (15) отсюда не посылается. */

const C2_RATES = [[0, 2], [1, 4], [2, 20], [3, 50], [4, 200], [5, 500], [6, 1000]];
const C2_PROTOS = [[0, 'PD'], [1, 'QC2.0'], [2, 'QC3.0'], [3, 'FCP'], [4, 'SCP'], [5, 'AFC'], [6, 'VFCP'], [7, 'UFCS'], [8, 'VOOC'], [9, 'SVOOC']];
const C2_PAGES = [[0, 'Основной'], [1, 'Запись'], [2, 'Пульсации'], [3, 'Главное меню']];
const C2_CURVES = [
  ['v', 'Напряжение', 'V'], ['i', 'Ток', 'A'], ['p', 'Мощность', 'W'], ['wh', 'Энергия', 'Wh'], ['ah', 'Ёмкость', 'Ah'],
  ['r', 'Сопротивление', 'Ω'], ['dp', 'D+', 'V'], ['dn', 'D−', 'V'], ['cc1', 'CC1', 'V'], ['cc2', 'CC2', 'V'],
];
const C2_FIX_MV = { 7: 5000, 9: 7000, 10: 8000, 11: 9000, 12: 10000, 14: 12000, 15: 15000, 18: 20000, 19: 25000, 20: 28000, 21: 30000, 22: 36000, 23: 48000 };   // бит в коде режима -> напряжение фиксированного PDO (таблица прошивки)
const C2_PT = ['не дошёл', 'нет режима у источника', 'не установилось', 'измерено'];
const C2_SC_RESULT = ['ещё не запускалась', 'готово', 'журнал полон', 'нет данных', 'нет PD/PPS', 'мешает USB', 'остановлена', 'идёт'];
const c2u16 = (p, o) => p[o] | p[o + 1] << 8;
const c2u24 = (p, o) => p[o] | p[o + 1] << 8 | p[o + 2] << 16;
const c2u32 = (p, o) => (p[o] | p[o + 1] << 8 | p[o + 2] << 16 | p[o + 3] << 24) >>> 0;
const c2f32 = (p, o) => new DataView(p.buffer, p.byteOffset + o, 4).getFloat32(0, true);
const c2str = (p, a, b) => { let s = ''; for (let i = a; i < b && p[i]; i++) s += String.fromCharCode(p[i]); return s.trim(); };
const c2hex8 = v => '0x' + (v >>> 0).toString(16).toUpperCase().padStart(8, '0');

/* Ответ на команду 1: [0] аппаратная, [1..2] прошивка, [7..14] серийный номер текстом, [15..26] модель. */
function c2Info(p) {
  if (!p || p.length < 29) return null;
  const model = c2str(p, 15, 27);
  return { model: model || 'ATK-C2', fw: `${p[1]}.${(p[2] / 10) | 0}.${p[2] % 10}`, hw: p[0], lite: p[28] === 1, serial: c2str(p, 7, 15) || 'C2' };
}

/* ======================= хранилище кривых ======================= */
class C2Data {
  constructor(n = 1 << 19) {
    this.N = n; this.t = new Float64Array(n); this.v = new Float32Array(n); this.i = new Float32Array(n);
    this.dp = new Float32Array(n); this.dn = new Float32Array(n); this.cc1 = new Float32Array(n); this.cc2 = new Float32Array(n);
    this.wh = new Float64Array(n); this.ah = new Float64Array(n);
    this.clear();
  }
  clear() { this.total = 0; this.n = 0; this.head = 0; this.whAcc = 0; this.ahAcc = 0; this.lastT = 0; this.rev = (this.rev || 0) + 1; this.t0 = Date.now(); }
  push(t, v, i, dp, dn, cc1, cc2) {
    if (this.n && t > this.lastT) { const dt = (t - this.lastT) / 3600e3; this.whAcc += v * i * dt; this.ahAcc += i * dt; }
    this.lastT = t;
    const k = this.head;
    this.t[k] = t; this.v[k] = v; this.i[k] = i; this.dp[k] = dp; this.dn[k] = dn; this.cc1[k] = cc1; this.cc2[k] = cc2;
    this.wh[k] = this.whAcc; this.ah[k] = this.ahAcc;
    this.head = (k + 1) % this.N; if (this.n < this.N) this.n++;
    this.total++;
  }
  idx(j) { return (this.head - this.n + j + this.N) % this.N; }       // j-й по времени -> индекс в кольце
  T(j) { return this.t[this.idx(j)]; }
  val(key, j) {
    const k = this.idx(j);
    switch (key) {
      case 'p': return this.v[k] * this.i[k];
      case 'r': return this.i[k] > 1e-4 ? this.v[k] / this.i[k] : NaN;
      default: return this[key][k];
    }
  }
  /* первый отсчёт с t >= x (двоичный поиск по времени) */
  lower(x) { let a = 0, b = this.n; while (a < b) { const m = (a + b) >> 1; if (this.T(m) < x) a = m + 1; else b = m; } return a; }
  stats(key, ta, tb) {
    let a = this.lower(ta), b = this.lower(tb), mn = Infinity, mx = -Infinity, s = 0, c = 0;
    for (let j = a; j < b; j++) { const v = this.val(key, j); if (!Number.isFinite(v)) continue; if (v < mn) mn = v; if (v > mx) mx = v; s += v; c++; }
    return { min: mn, max: mx, avg: c ? s / c : NaN, pp: c ? mx - mn : NaN, n: c };
  }
  csv(keys = ['v', 'i', 'p', 'dp', 'dn', 'cc1', 'cc2', 'wh', 'ah']) {
    const head = ['Время, с', ...keys.map(k => { const c = C2_CURVES.find(x => x[0] === k); return `${c[1]}, ${c[2]}`; })];
    const out = [head.join(';')];
    for (let j = 0; j < this.n; j++) out.push([(this.T(j) / 1000).toFixed(4), ...keys.map(k => +this.val(k, j).toPrecision(7))].join(';'));
    return out.join('\n');
  }
}

/* ======================= USB Power Delivery: разбор захвата линии CC ======================= */
const PD_SYM = (() => { const t = new Int8Array(32).fill(-1); [0x1E, 0x09, 0x14, 0x15, 0x0A, 0x0B, 0x0E, 0x0F, 0x12, 0x13, 0x16, 0x17, 0x1A, 0x1B, 0x1C, 0x1D].forEach((c, i) => { t[c] = i; }); return t; })();
const PD_K = { S1: 0x18, S2: 0x11, S3: 0x06, R1: 0x07, R2: 0x19, EOP: 0x0D };
const PD_SOPS = [
  ['SOP', [0x18, 0x18, 0x18, 0x11]], ["SOP'", [0x18, 0x18, 0x06, 0x06]], ["SOP''", [0x18, 0x06, 0x18, 0x06]],
  ["SOP' Debug", [0x18, 0x19, 0x19, 0x06]], ["SOP'' Debug", [0x18, 0x19, 0x06, 0x11]],
  ['Hard Reset', [0x07, 0x07, 0x07, 0x19]], ['Cable Reset', [0x07, 0x18, 0x07, 0x06]],
];
const PD_CTRL = ['Резерв', 'GoodCRC', 'GotoMin', 'Accept', 'Reject', 'Ping', 'PS_RDY', 'Get_Source_Cap', 'Get_Sink_Cap', 'DR_Swap', 'PR_Swap', 'VCONN_Swap', 'Wait', 'Soft_Reset', 'Data_Reset', 'Data_Reset_Complete', 'Not_Supported', 'Get_Source_Cap_Extended', 'Get_Status', 'FR_Swap', 'Get_PPS_Status', 'Get_Country_Codes', 'Get_Sink_Cap_Extended', 'Get_Source_Info', 'Get_Revision'];
const PD_DATA = ['Резерв', 'Source_Capabilities', 'Request', 'BIST', 'Sink_Capabilities', 'Battery_Status', 'Alert', 'Get_Country_Info', 'Enter_USB', 'EPR_Request', 'EPR_Mode', 'Source_Info', 'Revision', 'Резерв', 'Резерв', 'Vendor_Defined'];
const PD_EXT = ['Резерв', 'Source_Capabilities_Extended', 'Status', 'Get_Battery_Cap', 'Get_Battery_Status', 'Battery_Capabilities', 'Get_Manufacturer_Info', 'Manufacturer_Info', 'Security_Request', 'Security_Response', 'Firmware_Update_Request', 'Firmware_Update_Response', 'PPS_Status', 'Country_Info', 'Country_Codes', 'Sink_Capabilities_Extended', 'Extended_Control', 'EPR_Source_Capabilities', 'EPR_Sink_Capabilities', ...Array(11).fill('Резерв'), 'Vendor_Defined_Extended'];
const PD_CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function pdCrc(bytes, n) { let c = 0xFFFFFFFF; for (let i = 0; i < n; i++) c = PD_CRC_T[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

const mvTxt = mv => (mv / 1000).toFixed(mv % 1000 ? 2 : 0) + ' В', maTxt = ma => (ma / 1000).toFixed(2) + ' А';
function pdoText(w, sink) {
  const t = w >>> 30;
  if (t === 0) return `Фикс. ${mvTxt((w >>> 10 & 0x3FF) * 50)} ${maTxt((w & 0x3FF) * 10)}${sink ? (w >>> 23 & 3 ? `, FRS ${['', 'по умолч.', '1.5 А', '3 А'][w >>> 23 & 3]}` : '') : w >>> 23 & 1 ? ', EPR' : ''}`;
  if (t === 1) return `Батарея ${mvTxt((w >>> 10 & 0x3FF) * 50)}…${mvTxt((w >>> 20 & 0x3FF) * 50)} ${((w & 0x3FF) * 0.25).toFixed(1)} Вт`;
  if (t === 2) return `Перем. ${mvTxt((w >>> 10 & 0x3FF) * 50)}…${mvTxt((w >>> 20 & 0x3FF) * 50)} ${maTxt((w & 0x3FF) * 10)}`;
  const st = w >>> 28 & 3;
  if (st === 0) return `PPS ${mvTxt((w >>> 8 & 0xFF) * 100)}…${mvTxt((w >>> 17 & 0xFF) * 100)} ${maTxt((w & 0x7F) * 50)}`;
  if (st === 1) return `AVS (EPR) ${mvTxt((w >>> 8 & 0xFF) * 100)}…${mvTxt((w >>> 17 & 0x1FF) * 100)} ${w & 0xFF} Вт`;
  if (st === 2) return `AVS (SPR) 15 В ${maTxt((w >>> 10 & 0x3FF) * 10)}, 20 В ${maTxt((w & 0x3FF) * 10)}`;
  return 'APDO резерв';
}
const pdoShort = w => { const t = w >>> 30; if (t === 0) return mvTxt((w >>> 10 & 0x3FF) * 50); if (t === 3 && (w >>> 28 & 3) === 0) return `PPS ${((w >>> 8 & 0xFF) / 10).toFixed(1)}–${mvTxt((w >>> 17 & 0xFF) * 100)}`; if (t === 3 && (w >>> 28 & 3) === 1) return `AVS ${((w >>> 8 & 0xFF) / 10).toFixed(0)}–${mvTxt((w >>> 17 & 0x1FF) * 100)}`; return pdoText(w).split(' ')[0]; };
function rdoText(w, caps, eprPdo) {
  const pos = w >>> 28 & 0xF, pdo = eprPdo ?? caps?.[pos - 1];
  let s = `объект №${pos}`;
  if (pdo === undefined) return s + `, поля ${c2hex8(w)} (возможности источника не видны)`;
  const t = pdo >>> 30, st = pdo >>> 28 & 3;
  if (t === 3 && st === 0) s += `: PPS ${mvTxt((w >>> 9 & 0xFFF) * 20)}, ${maTxt((w & 0x7F) * 50)}`;
  else if (t === 3) s += `: AVS ${mvTxt((w >>> 9 & 0xFFF) * 25)}, ${maTxt((w & 0x7F) * 50)}`;
  else if (t === 1) s += `: ${pdoShort(pdo)}, мощность ${((w >>> 10 & 0x3FF) * 0.25).toFixed(2)} Вт (макс. ${((w & 0x3FF) * 0.25).toFixed(2)} Вт)`;
  else s += `: ${pdoShort(pdo)}, ток ${maTxt((w >>> 10 & 0x3FF) * 10)} (макс. ${maTxt((w & 0x3FF) * 10)})`;
  if (w >>> 26 & 1) s += ', несоответствие возможностей';
  return s;
}
const VDM_CMD = ['?', 'Discover Identity', 'Discover SVIDs', 'Discover Modes', 'Enter Mode', 'Exit Mode', 'Attention'];
const VDM_TYPE = ['REQ', 'ACK', 'NAK', 'BUSY'];
function cableVdoText(w) {
  const v = ['20 В', '30 В', '40 В', '50 В'][w >>> 9 & 3], a = ['?', '3 А', '5 А', '?'][w >>> 5 & 3];
  const sp = ['USB 2.0', 'USB 3.2 Gen1', 'USB 3.2/USB4 Gen2', 'USB4 Gen3', 'USB4 Gen4'][w & 7] || '?';
  return `кабель ${a}, ${v}, ${sp}${w >>> 17 & 1 ? ', EPR' : ''}`;
}
function vdmText(objs) {
  const h0 = objs[0], svid = h0 >>> 16;
  if (!(h0 >>> 15 & 1)) return `Unstructured VDM, SVID ${c2hex8(svid).slice(6)}`;
  const cmd = h0 & 0x1F, ct = h0 >>> 6 & 3;
  let s = `${VDM_CMD[cmd] || 'SVID cmd ' + cmd} ${VDM_TYPE[ct]}, SVID 0x${svid.toString(16).toUpperCase().padStart(4, '0')}`;
  if (cmd === 1 && ct === 1 && objs.length >= 4) {
    const id = objs[1]; s += `; VID 0x${(id & 0xFFFF).toString(16).toUpperCase().padStart(4, '0')}, PID 0x${(objs[3] >>> 16).toString(16).toUpperCase().padStart(4, '0')}`;
    if ((id >>> 27 & 7) === 3 || (id >>> 27 & 7) === 4) { if (objs[4] !== undefined) s += '; ' + cableVdoText(objs[4]); }
  }
  return s;
}

function pdDecodeMsg(m, caps) {
  const b = m.bytes;
  if (m.kind) return m;                                                 // Hard/Cable Reset
  if (b.length < 2) { m.name = 'обрыв'; m.err = 'короткий'; return m; }
  const hdr = c2u16(b, 0), ext = hdr >>> 15 & 1, n = hdr >>> 12 & 7, type = hdr & 0x1F;
  Object.assign(m, { hdr, ext, n, type, id: hdr >>> 9 & 7, rev: ['1.0', '2.0', '3.x', '?'][hdr >>> 6 & 3] });
  m.role = m.sop === 'SOP' ? (hdr >>> 8 & 1 ? 'Источник' : 'Приёмник') : (hdr >>> 8 & 1 ? 'Кабель' : 'Порт');
  m.data = hdr >>> 5 & 1 ? 'DFP' : 'UFP';
  m.name = ext ? PD_EXT[type] || 'Ext ' + type : n ? PD_DATA[type] || 'Data ' + type : PD_CTRL[type] || 'Ctrl ' + type;
  m.objs = [];
  for (let i = 0; i < n && 2 + i * 4 + 4 <= b.length; i++) m.objs.push(c2u32(b, 2 + i * 4));
  m.lines = [];
  if (!ext && n) {
    if (type === 1 || type === 4) { m.lines = m.objs.map((w, i) => `${i + 1}: ${pdoText(w, type === 4)}`); m.sum = m.objs.map(pdoShort).join(', '); }
    else if (type === 2) { m.sum = rdoText(m.objs[0], caps); m.lines = [m.sum]; }
    else if (type === 9) { m.sum = rdoText(m.objs[0], caps, m.objs[1]); m.lines = [m.sum, m.objs[1] !== undefined ? 'копия PDO: ' + pdoText(m.objs[1]) : '']; }
    else if (type === 15) { m.sum = vdmText(m.objs); m.lines = [m.sum, ...m.objs.slice(1).map((w, i) => `VDO ${i + 1}: ${c2hex8(w)}`)]; }
    else if (type === 10) { const a = m.objs[0] >>> 24; m.sum = ['?', 'Enter', 'Enter Ack', 'Enter Succeeded', 'Enter Failed', 'Exit'][a] || '' ; }
    else m.lines = m.objs.map((w, i) => `объект ${i + 1}: ${c2hex8(w)}`);
  }
  if (ext && b.length >= 4) { const eh = c2u16(b, 2); m.sum = `данных ${eh & 0x1FF} байт${eh >>> 15 & 1 ? ', кусками' : ''}`; }
  return m;
}

class PdDecoder {
  constructor(fs = 3.75e6) { this.fs = fs; this.out = []; this.reset(); }
  reset() {
    this.level = -1; this.run = 0; this.pos = 0; this.ui = this.fs / 300e3; this.half = 0; this.preamble = 0;
    this.st = 0; this.win = 0; this.nb = 0; this.syms = []; this.bits = 0; this.bitn = 0; this.lastBit = -1; this.t0 = 0;
  }
  feed(u) {
    for (let x = 0; x < u.length; x++) {
      const b = u[x];
      if ((b === 0xFF && this.level === 1) || (b === 0 && this.level === 0)) { this.run += 8; this.pos += 8; if (this.st && this.run > this.ui * 3) this.gap(); continue; }
      for (let k = 0; k < 8; k++) {
        const s = b >> k & 1;
        if (s === this.level) this.run++;
        else { if (this.level >= 0) this.edge(this.run); this.level = s; this.run = 1; }
        this.pos++;
      }
    }
  }
  gap() { if (this.st >= 2) this.finish('обрыв пакета'); this.st = 0; this.preamble = 0; this.half = 0; }
  edge(r) {
    const ui = this.ui;
    if (r > ui * 1.6) { this.gap(); return; }
    if (r < ui * 0.75) {
      if (this.half) { this.half = 0; this.bit(1, r * 2); } else this.half = r;
    } else {
      if (this.half) { this.half = 0; this.lostSync(); }
      this.bit(0, r);
    }
  }
  lostSync() { if (this.st >= 2) this.finish('сбой BMC'); this.st = 0; this.preamble = 0; }
  bit(v, len) {
    if (this.st === 0 || this.st === 1) {                               // преамбула: 0101..., шаг подстраиваем
      if (v !== this.lastBit) { this.preamble++; this.ui += (len - this.ui) * 0.08; }
      else if (this.preamble < 20) this.preamble = 0;
      this.lastBit = v;
      if (this.preamble === 1) this.t0 = this.pos - len;
      this.win = ((this.win >>> 1) | (v << 4)) & 0x1F;
      if (this.preamble >= 20 && (this.win === PD_K.S1 || this.win === PD_K.R1)) {
        this.st = 2; this.syms = [this.win]; this.bitn = 0; this.bits = 0;
      }
      return;
    }
    this.bits |= v << this.bitn; this.bitn++;                            // символ 5 бит, младший первым
    if (this.bitn < 5) return;
    const sym = this.bits; this.bits = 0; this.bitn = 0;
    if (this.st === 2) {
      this.syms.push(sym);
      if (this.syms.length < 4) return;
      let best = null, score = 0;
      for (const [name, seq] of PD_SOPS) { const sc = seq.reduce((a, c, i) => a + (c === this.syms[i]), 0); if (sc > score) { score = sc; best = name; } }
      if (score < 3) { this.st = 0; this.preamble = 0; return; }
      this.sop = best;
      if (best === 'Hard Reset' || best === 'Cable Reset') { this.emit({ sop: best, kind: best, name: best, bytes: new Uint8Array(0), crcOk: true }); this.st = 0; this.preamble = 0; return; }
      this.st = 3; this.nib = []; this.need = -1;
      return;
    }
    if (sym === PD_K.EOP) { this.finish(); return; }
    const d = PD_SYM[sym];
    if (d < 0) { this.finish('ошибочный символ'); return; }
    this.nib.push(d);
    if (this.nib.length === 4 && this.need < 0) { const hdr = this.nib[0] | this.nib[1] << 4 | this.nib[2] << 8 | this.nib[3] << 12; this.need = (2 + (hdr >>> 12 & 7) * 4 + 4) * 2; }
    if (this.need > 0 && this.nib.length > this.need + 2) this.finish('нет EOP');
  }
  finish(err) {
    if (this.st !== 3) { this.st = 0; this.preamble = 0; return; }
    const nb = this.nib.length >> 1, bytes = new Uint8Array(nb);
    for (let i = 0; i < nb; i++) bytes[i] = this.nib[2 * i] | this.nib[2 * i + 1] << 4;
    let crcOk = false;
    if (nb >= 6) crcOk = pdCrc(bytes, nb - 4) === c2u32(bytes, nb - 4);
    this.emit({ sop: this.sop, bytes: crcOk ? bytes.subarray(0, nb - 4) : bytes, crc: nb >= 6 ? c2u32(bytes, nb - 4) : 0, crcOk, err: crcOk ? '' : (err || 'CRC') });
    this.st = 0; this.preamble = 0; this.half = 0;
  }
  emit(m) { m.t = this.t0 / this.fs; m.end = this.pos / this.fs; this.out.push(m); }
}

/* Кодер для симулятора и самопроверки: сообщение -> биты BMC -> байты захвата. */
function pdEncodeSamples(sopName, bytes, spb = 12.5, idleBits = 40) {
  const seq = PD_SOPS.find(s => s[0] === sopName)[1];
  const crc = pdCrc(bytes, bytes.length), all = new Uint8Array(bytes.length + 4); all.set(bytes); all.set([crc & 255, crc >> 8 & 255, crc >> 16 & 255, crc >>> 24], bytes.length);
  const enc = [0x1E, 0x09, 0x14, 0x15, 0x0A, 0x0B, 0x0E, 0x0F, 0x12, 0x13, 0x16, 0x17, 0x1A, 0x1B, 0x1C, 0x1D];
  const bits = [];
  for (let i = 0; i < 64; i++) bits.push(i & 1);
  const sym = s => { for (let k = 0; k < 5; k++) bits.push(s >> k & 1); };
  seq.forEach(sym);
  if (sopName !== 'Hard Reset') { for (const b of all) { sym(enc[b & 15]); sym(enc[b >> 4]); } sym(PD_K.EOP); }
  const out = []; let lvl = 1, acc = 0;
  const put = (n, l) => { for (let i = 0; i < n; i++) out.push(l); };
  put(idleBits * spb, 1);
  for (const b of bits) {
    lvl ^= 1; const a0 = Math.round(acc), a1 = Math.round(acc + spb / 2), a2 = Math.round(acc + spb); acc += spb;
    if (b) { put(a1 - a0, lvl); lvl ^= 1; put(a2 - a1, lvl); } else put(a2 - a0, lvl);
  }
  lvl ^= 1; put(Math.round(spb), lvl); put(idleBits * spb, 1);
  const bytesOut = new Uint8Array(Math.ceil(out.length / 8));
  out.forEach((s, i) => { if (s) bytesOut[i >> 3] |= 1 << (i & 7); });
  return bytesOut;
}

/* ======================= драйвер ======================= */
class C2 extends Device {
  id = 'c2'; title = 'C2';
  constructor(link, info) {
    super(link, `ALIENTEK,${info.model},${info.serial},${info.fw}`);
    this.info = info; this.title = info.model.replace(/^ATK-/, '') || 'C2';
  }
  get fwText() { return this.ext ? `прошивка с командами Пульта v${this.ext.proto}` : 'родная прошивка'; }
  async start() {
    const s = this.s;
    Object.assign(s, { rate: store.get('c2.rate', 2), page: null, dir: 0, temp: NaN, protos: [], frames: 0, fps: 0, bad: 0, listen: false, fsPd: 3.75e6, ccEvents: [] });
    this.data = new C2Data();
    this.pdo = []; this.trigLog = []; this.trigProto = null; this.pdDec = new PdDecoder(); this.pdMsgs = []; this.pdCaps = null; this.pdBytes = 0;
    this.stats = { on: true, ah: 0, wh: 0, sec: 0, lastT: 0, stopRule: store.get('c2.stopRule', { on: false, ma: 50, sec: 10, maxMin: 0 }), below: 0 };
    this.alarm = store.get('c2.alarm', { on: false, vHi: 21, vLo: 0, iHi: 5, iLo: 0, pHi: 100 }); this.alarmState = '';
    for (const [k, name, unit, d] of [['v', 'Напряжение VBUS', 'V', 5], ['i', 'Ток VBUS', 'A', 5], ['p', 'Мощность', 'W', 5], ['dp', 'D+', 'V', 4], ['dn', 'D−', 'V', 4],
      ['cc1', 'CC1', 'V', 4], ['cc2', 'CC2', 'V', 4], ['t', 'Температура', '°C', 3], ['ah', 'Ёмкость', 'Ah', 5], ['wh', 'Энергия', 'Wh', 5], ['r', 'Сопротивление нагрузки', 'Ω', 5]])
      Hub.define({ id: 'c2.' + k, name, unit, dev: this.id, group: 'C2', digits: d });
    this.alive = true;
    this.offFrame = this.link.on('frame', f => this.onFrame(f));
    this.ext = await this.extInfo().catch(() => null);
    if (this.ext) {                                                     // команда 1 в сборках до 4.2.3 всегда отвечает 3.8.0: берём строку версии из флеша
      try { const v = new TextDecoder().decode(await this.peek(0x16D88, 5)); if (/^\d\.\d\.\d$/.test(v)) { this.info.fw = v; this.fw = v; this.idn = `ALIENTEK,${this.info.model},${this.info.serial},${v}`; } } catch { }
    }
    await this.link.send(4, [1]);                                        // поток измерений
    await this.setRate(s.rate, true);
    this.watch();
  }
  async stop() {
    this.alive = false;
    if (!this.flashing) try { if (this.s.listen) await this.link.send(12, [0]); await this.link.send(4, [0]); } catch { }   // при входе в загрузчик молчим: любой кадр затрёт приёмный буфер, пока прибор не прочёл команду 15
    this.offFrame?.(); try { await this.link.close(); } catch { } Hub.removeDev(this.id);
  }
  async watch() {
    let base = 0, last = performance.now();
    while (this.alive) {
      await sleep(1000);
      const now = performance.now(), c = this.s;
      c.fps = (c.frames - base) / ((now - last) / 1000); base = c.frames; last = now;
      c.bad = this.link.tr.parser?.bad ?? 0;
      const st = c.fps > 0 ? 'ok' : 'warn';
      if (st !== this.state) { this.state = st; this.lastErr = st === 'ok' ? '' : 'Нет потока измерений'; this.emit('state'); }
      this.emit('rate');
    }
  }
  /* ---------- приём кадров ---------- */
  onFrame(f) {
    const p = f.payload, c = this.s;
    switch (f.cmd) {
      case 0x04: if (p.length >= 57) this.onSamples(p); break;
      case 0x19: if (p.length >= 55) { c.protos = [c2str(p, 0, 10), c2str(p, 10, 18), c2str(p, 18, 26), c2str(p, 26, 34), c2str(p, 34, 44), c2str(p, 44, 54)]; c.temp = p[54]; Hub.push('c2.t', c.temp); this.emit('protos'); } break;
      case 0x03: if (p.length >= 2) { c.rate = p[1]; this.emit('rate'); } break;
      case 0x02: c.page = p[0]; this.emit('page'); break;
      case 0x05: this.onPdo(p); break;
      case 0x06: this.onProtoText(p); break;
      case 0x0C: c.listen = p[0] === 1; if (p.length >= 6) { const fs = c2u32(p, 2); if (fs > 1e5 && fs < 2e7) { c.fsPd = fs; this.pdDec.fs = fs; } } this.emit('listen'); break;
      case 0x0D: this.pdBytes += p.length; this.pdDec.feed(p); if (this.pdDec.out.length) this.flushPd(); break;
      case 0x21: c.ccEvents.push({ t: performance.now(), cc: p[0], on: p[1] }); this.emit('cc'); break;
    }
  }
  onSamples(p) {
    const c = this.s, k = c.rate >= 5 ? 4 : 1, hz = (C2_RATES.find(r => r[0] === c.rate) || [0, 2])[1], now = performance.now(), dt = 1000 / hz;
    c.dir = p[56];
    // часы отсчётов: кадры приходят пачками, поэтому время ведём по периоду и подтягиваем к реальному
    let t0 = (this.tS ?? -Infinity) + dt;
    if (!(t0 > now - (k + 8) * dt && t0 < now + dt)) t0 = now - (k - 1) * dt;
    for (let j = 0; j < k; j++) {
      const t = t0 + j * dt; this.tS = t;
      const v = c2u24(p, j * 3) * 1e-5, i = c2u24(p, 12 + j * 3) * 1e-5;
      const dp = c2u16(p, 24 + j * 2) / 1000, dn = c2u16(p, 32 + j * 2) / 1000, cc1 = c2u16(p, 40 + j * 2) / 1000, cc2 = c2u16(p, 48 + j * 2) / 1000;
      this.data.push(t, v, i, dp, dn, cc1, cc2);
      this.accumulate(t, v, i);
      Hub.push('c2.v', v, t); Hub.push('c2.i', i, t); Hub.push('c2.p', v * i, t); Hub.push('c2.r', i > 1e-4 ? v / i : NaN, t);
      Hub.push('c2.dp', dp, t); Hub.push('c2.dn', dn, t); Hub.push('c2.cc1', cc1, t); Hub.push('c2.cc2', cc2, t);
    }
    Hub.push('c2.ah', this.stats.ah, now); Hub.push('c2.wh', this.stats.wh, now);
    c.frames++;
    this.checkAlarm(c2u24(p, 0) * 1e-5, c2u24(p, 12) * 1e-5);
  }
  accumulate(t, v, i) {
    const s = this.stats;
    if (s.lastT && s.on) {
      const dt = (t - s.lastT) / 1000;
      if (dt > 0 && dt < 5) { s.ah += i * dt / 3600; s.wh += v * i * dt / 3600; s.sec += dt; }
      const r = s.stopRule;
      if (r.on) {
        s.below = i * 1000 < r.ma ? s.below + dt : 0;
        if ((r.sec && s.below >= r.sec && s.sec > r.sec) || (r.maxMin && s.sec >= r.maxMin * 60)) { s.on = false; this.emit('statstop'); toast(`C2: счёт Ah/Wh остановлен по условию (${(s.ah * 1000).toFixed(1)} мАч, ${s.wh.toFixed(3)} Вт·ч)`, 'ok', 8000); }
      }
    }
    s.lastT = t;
  }
  resetStats() { Object.assign(this.stats, { ah: 0, wh: 0, sec: 0, lastT: 0, below: 0, on: true }); this.emit('statstop'); }
  checkAlarm(v, i) {
    const a = this.alarm; if (!a.on) { if (this.alarmState) { this.alarmState = ''; this.emit('alarm'); } return; }
    const p = v * i, msg = [];
    if (v > a.vHi) msg.push(`U > ${a.vHi} В`); if (a.vLo && v < a.vLo) msg.push(`U < ${a.vLo} В`);
    if (i > a.iHi) msg.push(`I > ${a.iHi} А`); if (a.iLo && i < a.iLo) msg.push(`I < ${a.iLo} А`);
    if (p > a.pHi) msg.push(`P > ${a.pHi} Вт`);
    const st = msg.join(', ');
    if (st !== this.alarmState) {
      this.alarmState = st; this.emit('alarm');
      if (st) { toast('C2, тревога: ' + st, 'bad', 6000); this.trigLog.push({ t: Date.now(), text: 'Тревога: ' + st }); this.emit('trig'); }
    }
  }
  onPdo(p) {
    if (p.length < 22) return;
    const e = { proto: p[0], code: p[1], lo: c2u32(p, 2), hi: c2u32(p, 6), flag: p[10], req: c2u16(p, 11), step: c2u16(p, 13), min: c2u16(p, 15), max: c2u16(p, 17), ma: c2u16(p, 19) };
    e.n = e.lo ? 31 - Math.clz32(e.lo) : e.hi ? 32 + 31 - Math.clz32(e.hi) : -1;
    e.kind = e.n >= 28 && e.n < 32 ? 'AVS' : e.n >= 24 && e.n < 28 ? 'PPS' : e.n >= 32 ? 'AVS' : 'FIX';
    if (e.kind === 'FIX' && !e.max) e.max = C2_FIX_MV[e.n] || e.req || e.min;
    const i = this.pdo.findIndex(x => x.n === e.n);
    if (i >= 0) this.pdo[i] = e; else this.pdo.push(e);
    this.pdo.sort((a, b) => a.n - b.n);
    this.emit('pdo');
  }
  onProtoText(p) {
    const text = c2str(p, 2, p.length);
    this.trigLog.push({ t: Date.now(), proto: p[0], code: p[1], text });
    this.emit('trig');
  }
  flushPd() {
    for (const m of this.pdDec.out.splice(0)) {
      pdDecodeMsg(m, this.pdCaps);
      if (m.sop === 'SOP' && m.n && m.type === 1 && m.crcOk) this.pdCaps = m.objs;
      m.no = this.pdMsgs.length + 1;
      this.pdMsgs.push(m);
      if (this.pdMsgs.length > 2e6) this.pdMsgs.splice(0, 5e5);
    }
    this.emit('pd');
  }
  /* ---------- команды ---------- */
  async setRate(mode, quiet) { this.s.rate = mode; store.set('c2.rate', mode); await this.link.send(3, [1, mode]); if (!quiet) this.emit('rate'); }
  setPage(p) { return this.link.send(2, [p, 1]); }
  clearDeviceCounters(ch = 0) { return this.link.send(10, [0, ch]); }
  trigger(proto) { this.pdo = []; this.trigProto = proto; this.emit('pdo'); this.trigLog.push({ t: Date.now(), text: `Запуск ${C2_PROTOS.find(x => x[0] === proto)?.[1]}` }); this.emit('trig'); return this.link.send(5, [1, proto]); }
  request(e, mv) { const flag = e.kind === 'FIX' ? 0 : 2; mv = Math.round(mv ?? e.req ?? 5000); this.trigLog.push({ t: Date.now(), text: `Запрос ${e.kind} ${(mv / 1000).toFixed(2)} В` }); this.emit('trig'); return this.link.send(5, [2, this.trigProto ?? 0, e.n, mv & 255, mv >> 8, flag]); }
  exitTrigger() { this.trigProto = null; this.trigLog.push({ t: Date.now(), text: 'Выход из триггера' }); this.emit('trig'); return this.link.send(6, [1]); }
  async listen(on) {
    if (on) { this.pdDec.reset(); this.pdDec.fs = this.s.fsPd; }
    const r = await this.link.request(12, [on ? 1 : 0], { timeout: 1500 }).catch(() => null);
    this.s.listen = r ? r[0] === 1 : on; this.emit('listen');
  }
  clearPd() { this.pdMsgs = []; this.pdCaps = null; this.pdBytes = 0; this.emit('pd'); }
  /* сбор нескольких кадров одной команды */
  collect(cmd, payload, { until, timeout = 1500, gap = 250 } = {}) {
    return new Promise((res, rej) => {
      const got = []; let tm, gt;
      const done = () => { off(); clearTimeout(tm); clearTimeout(gt); res(got); };
      const off = this.link.on('frame', f => { if (f.cmd !== cmd) return; got.push(f.payload.slice()); clearTimeout(gt); if (until?.(got)) done(); else gt = setTimeout(done, gap); });
      tm = setTimeout(() => { off(); got.length ? res(got) : rej(new TimeoutError()); }, timeout);
      this.link.send(cmd, payload).catch(e => { off(); clearTimeout(tm); rej(e); });
    });
  }
  /* Прибор молча теряет ответ, если его передатчик USB ещё занят (поток, прослушка):
     безопасные запросы повторяем. */
  async again(fn, n = 3) { let e; for (let k = 0; k < n; k++) { try { return await fn(); } catch (x) { e = x; await sleep(150); } } throw e; }
  async emarkerRead() {
    const fr = await this.again(() => this.collect(22, [0, 5], { until: g => g.length >= 2, timeout: 1500 }));
    return fr.map(p => ({ slot: p[1], valid: p[2], vdo: [c2u32(p, 3), c2u32(p, 7), c2u32(p, 11), c2u32(p, 15)] }));
  }
  async emarkerWrite(slot, vdo) {
    const b = new Uint8Array(18); b[0] = 0; b[1] = slot; b[2] = 1;
    vdo.forEach((w, i) => new DataView(b.buffer).setUint32(3 + i * 4, w >>> 0, true));
    return this.link.request(23, b, { timeout: 2000 });
  }
  emarkerClear(sub) { return this.link.request(24, [0, sub], { timeout: 2000 }); }
  async offlineGroups() {
    const fr = await this.again(() => this.collect(8, [], { until: g => g.length && g.length >= g[0][0], timeout: 1500 }));
    return fr.map(p => ({ count: p[0], ch: p[1], every: c2u32(p, 2), dur: c2u24(p, 6), n: c2u16(p, 10), a: c2f32(p, 12), b: c2f32(p, 16), flags: p[20] }));
  }
  async offlineRead(ch, n, onProgress) {
    const want = n * 4;
    const fr = await this.again(() => this.collect(9, [0, ch, n & 255, n >> 8], { until: g => g.reduce((a, x) => a + x.length, 0) >= want, timeout: 4000 + n, gap: 600 }));
    const all = new Uint8Array(fr.reduce((a, x) => a + x.length, 0)); let o = 0; for (const x of fr) { all.set(x, o); o += x.length; }
    const out = [];
    for (let j = 0; j + 4 <= all.length && j < want; j += 4) out.push([c2u16(all, j) / 1000, c2u16(all, j + 2) / 1000]);
    onProgress?.(1);
    return out;
  }
  /* ---------- команды Пульта (прошивка 4.2.0+) ---------- */
  async extq(sub, payload = [], timeout = 1500) {
    const r = await this.link.request(0x1E, [sub, ...payload], { timeout });
    if (r[0] !== sub) throw new Error('C2: чужой ответ');
    return r;
  }
  async extInfo() {
    const r = await this.again(() => this.extq(0, [], 600), 2);
    const x = { pts: r.length >= 47 ? [...r.subarray(39, 47)] : null, proto: r[2], flag: r[3], phase: r[4], result: r[5], npts: r[6], idx: r[7], level: r[8], avg: r[9], sc: c2u32(r, 10), uc: c2u32(r, 14), log0: c2u32(r, 18), logFree: c2u32(r, 22), logEnd: c2u32(r, 26), rawV: c2f32(r, 30), rawI: c2f32(r, 34), usb: r[38], duty: r.length >= 51 ? r[47] | r[48] << 8 : null, podrb: r.length >= 51 ? r[49] | r[50] << 8 : null, restarts: r.length >= 52 ? r[51] : null };
    this.ext = x; this.emit('ext');
    return x;
  }
  async peek(addr, len) {
    const out = new Uint8Array(len);
    for (let o = 0; o < len; o += 48) {
      const n = Math.min(48, len - o), a = addr + o;
      const r = await this.again(() => this.extq(1, [a & 255, a >> 8 & 255, a >> 16 & 255, a >>> 24, n]));
      if (r[1]) throw new Error(`C2: чтение 0x${a.toString(16)} запрещено`);
      out.set(r.subarray(6, 6 + n), o);
    }
    return out;
  }
  async setAvg(level) { const r = await this.extq(4, [level]); if (r[1]) throw new Error('C2: уровень усреднения не принят'); await this.extInfo(); }
  async writeRecord(type, body) {
    if (this.ext?.flag) throw new Error('C2 занят калибровкой');
    for (let o = 0; o < body.length; o += 40) {
      const r = await this.again(() => this.extq(5, [8 + o, ...body.subarray(o, o + 40)]));
      if (r[1]) throw new Error(`C2: запись в буфер отклонена (${r[1]})`);
    }
    const len = 8 + body.length;
    const r = await this.extq(6, [type, len & 255, len >> 8], 3000);
    if (r[1]) throw new Error(['', 'C2 занят', 'C2: запись не прошла проверку', 'C2: журнал калибровок полон, нужна прошивка новой версии'][r[1]] || 'C2: ошибка записи ' + r[1]);
    await this.extInfo();
    return c2u32(r, 2);
  }
  async readLog() {
    const x = await this.extInfo(), len = x.logFree - x.log0, recs = [];
    if (len <= 0) return recs;
    const b = await this.peek(x.log0, len);
    for (let o = 0; o + 8 <= b.length;) {
      if (c2u32(b, o) !== 0x58523243) break;
      const type = b[o + 4], n = c2u16(b, o + 6);
      if (n < 12 || o + n > b.length) break;
      recs.push({ addr: x.log0 + o, type, body: b.slice(o + 8, o + n) });
      o += n;
    }
    return recs;
  }
  windows() { return ['c2-main', 'c2-graph', 'c2-trigger', 'c2-pd', 'c2-emarker', 'c2-offline', 'c2-cal', 'c2-fw']; }
}

/* ======================= окна ======================= */
const c2Need = (win, dev) => { if (!dev.ext) { win.body.append(h('div', { class: 'nodev' }, h('p', { text: 'Нужна прошивка C2 4.2.0 или новее: в ней есть команды для Пульта. Сейчас стоит родная прошивка или более старая сборка.' }))); return true; } return false; };
const c2Ask = text => new Promise(res => { const d = App.dlg('Подтверждение', h('div', { class: 'col' }, h('p', { text }), h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => { d.close(); res(true); } }, 'Да'), h('button', { class: 'btn', onclick: () => { d.close(); res(false); } }, 'Нет')))); d.addEventListener('close', () => res(false)); });

/* ---------- Тестер: показания, протоколы, статистика, тревоги ---------- */
WM.define('c2-main', {
  title: 'C2: тестер', dev: 'c2', devName: 'C2', w: 560, h: 470,
  make(win, dev) {
    const cells = {}, big = h('div', { class: 'c2-big' });
    for (const [k, n] of [['v', 'Напряжение'], ['i', 'Ток'], ['p', 'Мощность']]) { cells[k] = h('b', { class: 'digits' }); big.append(h('div', { class: 'c2-cell' }, h('span', { text: n }), cells[k])); }
    const small = h('div', { class: 'stats' });
    for (const [k, n] of [['dp', 'D+'], ['dn', 'D−'], ['cc1', 'CC1'], ['cc2', 'CC2'], ['t', 'Темп.'], ['r', 'R нагрузки'], ['dir', 'Ток идёт']]) { cells[k] = h('b'); small.append(h('div', {}, h('span', { text: n }), cells[k])); }
    const protos = h('div', { class: 'note' });
    const rate = select(C2_RATES.map(([m, hz]) => [m, hz + ' Гц']), dev.s.rate, v => dev.setRate(+v).catch(errToast), 'Частота измерений');
    const page = select([['', 'Экран прибора…'], ...C2_PAGES], '', v => { if (v !== '') dev.setPage(+v).catch(errToast); page.value = ''; }, 'Экран прибора');
    win.toolbar.append(rate);
    const st = { ah: h('b'), wh: h('b'), time: h('b'), st: h('span', { class: 'tag' }) };
    const r = dev.stats.stopRule, a = dev.alarm;
    const num = (obj, k, store_k, w = 60) => h('input', { type: 'number', value: obj[k], step: 'any', style: { width: w + 'px' }, onchange: e => { obj[k] = +e.target.value; store.set(store_k, obj); } });
    const ruleOn = toggle('Стоп по условию', r.on, v => { r.on = v; store.set('c2.stopRule', r); });
    const alarmOn = toggle('Тревоги', a.on, v => { a.on = v; store.set('c2.alarm', a); });
    const alarmText = h('span', { class: 'note c2-warn' });
    win.body.append(h('div', { class: 'col pad scroll' },
      h('div', { class: 'note', text: `${dev.info.model}, серийный ${dev.info.serial}, прошивка ${dev.info.fw} (${dev.fwText})` }),
      big, small, protos,
      h('h4', { text: 'Счёт на ПК' }), h('div', { class: 'row wrap' }, field('Ёмкость', st.ah), field('Энергия', st.wh), field('Время', st.time), st.st,
        h('button', { class: 'btn', onclick: () => { dev.stats.on = !dev.stats.on; upd(); } }, 'Пауза/продолжить'), h('button', { class: 'btn', onclick: () => dev.resetStats() }, 'Сбросить')),
      h('div', { class: 'row wrap' }, ruleOn, field('ток ниже, мА', num(r, 'ma', 'c2.stopRule')), field('дольше, с', num(r, 'sec', 'c2.stopRule')), field('или через, мин', num(r, 'maxMin', 'c2.stopRule'))),
      h('h4', { text: 'Тревоги' }), h('div', { class: 'row wrap' }, alarmOn, field('U выше, В', num(a, 'vHi', 'c2.alarm')), field('U ниже, В', num(a, 'vLo', 'c2.alarm')), field('I выше, А', num(a, 'iHi', 'c2.alarm')), field('I ниже, А', num(a, 'iLo', 'c2.alarm')), field('P выше, Вт', num(a, 'pHi', 'c2.alarm'))), alarmText,
      h('h4', { text: 'Прибор' }), h('div', { class: 'row wrap' }, page)));
    function upd() { st.st.textContent = dev.stats.on ? 'идёт' : 'стоит'; }
    upd(); win.sub(dev, 'statstop', upd);
    win.sub(dev, 'rate', () => { rate.value = dev.s.rate; });
    win.sub(dev, 'protos', () => { const p = dev.s.protos.filter(x => x && !/^-+NA-+$|^Protocols?$/i.test(x)); protos.textContent = p.length ? 'Протоколы зарядника: ' + p.join(', ') : 'Протоколы зарядника не определены'; });
    win.sub(dev, 'alarm', () => { alarmText.textContent = dev.alarmState ? 'Сработало: ' + dev.alarmState : ''; win.el.classList.toggle('rec', !!dev.alarmState); });
    let lastN = -1;
    return {
      tick() {
        const d = dev.data; if (!d.n || d.total === lastN) return; lastN = d.total;
        const j = d.n - 1, set = (k, v, u, dg) => { cells[k].textContent = fmtSI(v, u, dg); };
        set('v', d.val('v', j), 'V', 5); set('i', d.val('i', j), 'A', 5); set('p', d.val('p', j), 'W', 5);
        set('dp', d.val('dp', j), 'V', 4); set('dn', d.val('dn', j), 'V', 4); set('cc1', d.val('cc1', j), 'V', 4); set('cc2', d.val('cc2', j), 'V', 4);
        cells.t.textContent = Number.isFinite(dev.s.temp) ? dev.s.temp + ' °C' : '–'; set('r', d.val('r', j), 'Ω', 4);
        cells.dir.textContent = dev.s.dir & 1 ? 'с заднего гнезда' : 'с переднего гнезда';
        st.ah.textContent = fmtSI(dev.stats.ah, 'Ah', 5); st.wh.textContent = fmtSI(dev.stats.wh, 'Wh', 5);
        const s = dev.stats.sec | 0; st.time.textContent = `${pad(s / 3600 | 0)}:${pad(s / 60 % 60 | 0)}:${pad(s % 60)}`;
      },
    };
  },
});

/* ---------- Графики: кривые, масштаб, курсоры, пульсации ---------- */
WM.define('c2-graph', {
  title: 'C2: графики', dev: 'c2', devName: 'C2', w: 900, h: 560,
  make(win, dev, cfg) {
    cfg.keys ??= ['v', 'i']; cfg.span ??= 30;
    let src = 'live';
    const d = () => src === 'file' && dev.loaded ? dev.loaded : dev.data;
    let view = null, hover = null, cur = { a: null, b: null }, drag = null, autoSave = null;
    const box = h('div', { class: 'chart' }), tip = h('div', { class: 'tip', hidden: true }), info = h('div', { class: 'c2-cursors note' });
    const pick = h('div', { class: 'row wrap c2-keys' });
    for (const [k, n] of C2_CURVES) pick.append(h('label', {}, h('input', { type: 'checkbox', checked: cfg.keys.includes(k), onchange: e => { cfg.keys = e.target.checked ? [...cfg.keys, k] : cfg.keys.filter(x => x !== k); cfg.keys.sort((a, b) => C2_CURVES.findIndex(c => c[0] === a) - C2_CURVES.findIndex(c => c[0] === b)); WM.save(); } }), ' ' + n));
    const pause = toggle('Пауза', false, v => { if (v) { const D = d(); view = { end: D.n ? D.T(D.n - 1) : performance.now(), span: cfg.span * 1000 }; } else view = null; });
    const rate = select(C2_RATES.map(([m, hz]) => [m, hz + ' Гц']), dev.s.rate, v => dev.setRate(+v).catch(errToast), 'Частота');
    const fileIn = h('input', { type: 'file', accept: '.csv,text/csv', hidden: true, onchange: e => loadCsv(e.target.files[0]) });
    const asBtn = toggle('Автосохранение', false, v => v ? startAuto().catch(e => { asBtn.set(false); errToast(e); }) : stopAuto());
    const srcSel = seg([['live', 'Живые'], ['file', 'Файл']], src, v => { if (v === 'file' && !dev.loaded) { toast('Файла нет: загрузите CSV или запись из прибора', 'warn'); srcSel.set(src); return; } src = v; cur = { a: null, b: null }; pause.set(v === 'file'); const D = d(); view = v === 'file' && D.n ? { end: D.T(D.n - 1), span: Math.max(1000, D.T(D.n - 1) - D.T(0)) } : null; }, 'Источник данных');
    win.sub(dev, 'loaded', () => { src = 'file'; srcSel.set('file'); pause.set(true); const D = d(); cur = { a: null, b: null }; view = { end: D.T(D.n - 1), span: Math.max(1000, D.T(D.n - 1) - D.T(0)) }; });
    win.toolbar.append(srcSel, rate, pause,
      h('button', { class: 'tbtn', title: 'Начать заново: очистить живые кривые и счёт', onclick: () => { dev.data.clear(); cur = { a: null, b: null }; } }, 'Заново'),
      h('button', { class: 'tbtn', onclick: () => saveFile(`c2-${stamp()}.csv`, '﻿' + d().csv(), 'text/csv') }, 'CSV'),
      h('button', { class: 'tbtn', onclick: () => fileIn.click() }, 'Загрузить'), asBtn, fileIn);
    win.body.append(pick, h('div', { class: 'chart-wrap' }, box, tip), info);
    win.sub(dev, 'rate', () => { rate.value = dev.s.rate; });
    const p = new Plot(box);
    async function startAuto() {
      if (!window.showSaveFilePicker) throw new Error('Автосохранение работает в Chrome и Edge');
      const fh = await showSaveFilePicker({ suggestedName: `c2-${stamp()}.csv`, types: [{ description: 'CSV', accept: { 'text/csv': ['.csv'] } }] });
      const w = await fh.createWritable(); await w.write('﻿Время, с;Напряжение, V;Ток, A;D+, V;D−, V;CC1, V;CC2, V\n');
      const D0 = dev.data; let written = D0.total, rev = D0.rev;
      autoSave = { w, timer: setInterval(async () => {
        const D = dev.data, rows = [];
        if (D.rev !== rev) { rev = D.rev; written = 0; }
        const fresh = Math.min(D.total - written, D.n);
        for (let m = D.n - fresh; m < D.n; m++) rows.push([(D.T(m) / 1000).toFixed(4), D.val('v', m), D.val('i', m), D.val('dp', m), D.val('dn', m), D.val('cc1', m), D.val('cc2', m)].join(';'));
        written = D.total;
        if (rows.length) await w.write(rows.join('\n') + '\n');
      }, 1000) };
      toast('Автосохранение в файл включено', 'ok');
    }
    async function stopAuto() { if (!autoSave) return; clearInterval(autoSave.timer); try { await autoSave.w.close(); } catch { } autoSave = null; toast('Файл автосохранения закрыт', 'ok'); }
    async function loadCsv(file) {
      if (!file) return;
      const lines = (await file.text()).replace(/^﻿/, '').split(/\r?\n/).filter(Boolean), head = lines.shift().split(';');
      const col = re => head.findIndex(x => re.test(x));
      const ct = col(/Время/), cv = col(/Напряжение/), ci = col(/^Ток/), cdp = col(/^D\+/), cdn = col(/^D−/), c1 = col(/CC1/), c2c = col(/CC2/);
      if (ct < 0 || cv < 0) { toast('В файле нет столбцов «Время» и «Напряжение»', 'bad'); return; }
      const D = new C2Data(1 << Math.max(10, Math.ceil(Math.log2(lines.length + 1))));
      for (const ln of lines) { const f = ln.split(';').map(x => Number(x.replace(',', '.'))); D.push(f[ct] * 1000, f[cv], ci >= 0 ? f[ci] : 0, cdp >= 0 ? f[cdp] : 0, cdn >= 0 ? f[cdn] : 0, c1 >= 0 ? f[c1] : 0, c2c >= 0 ? f[c2c] : 0); }
      D.title = file.name; dev.loaded = D; dev.emit('loaded');
      toast(`Загружено ${D.n} точек из ${file.name}`, 'ok');
    }
    const L = 70, R = 12, T = 6, B = 22;
    const range = () => { const D = d(); if (view) return [view.end - view.span, view.end]; const end = D.n ? D.T(D.n - 1) : performance.now(); return [end - cfg.span * 1000, end]; };
    const tOf = x => { const [a, b] = range(); return a + (x - L) / (p.w - L - R) * (b - a); };
    box.addEventListener('wheel', e => {
      e.preventDefault(); const k = e.deltaY > 0 ? 1.25 : 0.8;
      if (!view) { cfg.span = clamp(cfg.span * k, 0.05, 86400); WM.save(); return; }
      const tm = tOf(e.offsetX), [a, b] = range(), na = tm - (tm - a) * k, nb = tm + (b - tm) * k;
      view = { end: nb, span: Math.max(5, nb - na) };
    }, { passive: false });
    box.addEventListener('pointerdown', e => {
      const t = tOf(e.offsetX);
      if (e.shiftKey || e.button === 2) { cur.b = t; return; }
      if (e.altKey || e.ctrlKey) { cur.a = t; return; }
      if (!view) { pause.set(true); const [a, b] = range(); view = { end: b, span: b - a }; }
      drag = { x: e.clientX, end: view.end, moved: false }; box.setPointerCapture(e.pointerId);
    });
    box.addEventListener('contextmenu', e => e.preventDefault());
    box.addEventListener('pointermove', e => {
      hover = { x: e.offsetX, y: e.offsetY };
      if (drag) { const dx = e.clientX - drag.x; if (Math.abs(dx) > 3) drag.moved = true; view.end = drag.end - dx / (p.w - L - R) * view.span; }
    });
    box.addEventListener('pointerup', e => { if (drag && !drag.moved) { const t = tOf(e.offsetX); if (cur.a === null || (cur.b !== null)) { cur.a = t; cur.b = null; } else cur.b = t; } drag = null; });
    box.addEventListener('pointerleave', () => { hover = null; tip.hidden = true; });
    box.addEventListener('dblclick', () => { cur = { a: null, b: null }; });
    function draw() {
      const g = p.g, W = p.w, H = p.h, c = Theme.colors, D = d(), [ta, tb] = range(), keys = cfg.keys;
      g.clearRect(0, 0, W, H);
      if (!keys.length) { g.fillStyle = c.ink3; g.font = FONT(12); g.fillText('Отметьте кривые сверху', 16, 24); return; }
      const n = keys.length, gap = 6, laneH = (H - T - B - gap * (n - 1)) / n, X = t => L + (t - ta) / (tb - ta) * (W - L - R);
      g.font = FONT(10); g.textAlign = 'center'; g.fillStyle = c.ink3;
      const span = (tb - ta) / 1000;
      for (const s of niceTicks(0, span, Math.max(3, W / 110 | 0))) { const x = X(ta + s * 1000); g.strokeStyle = c.grid; g.lineWidth = 1; g.beginPath(); g.moveTo(x + .5, T); g.lineTo(x + .5, H - B); g.stroke(); g.fillText(view ? fmtSI((ta + s * 1000 - (D.n ? D.T(0) : 0)) / 1000, 's', 3) : `−${fmtSI(span - s, 's', 3)}`, x, H - 7); }
      const a = D.lower(ta), b = D.lower(tb + 1e-9);
      const tipRows = [];
      keys.forEach((key, li) => {
        const meta = C2_CURVES.find(x => x[0] === key), y0 = T + li * (laneH + gap);
        let lo = Infinity, hi = -Infinity;
        for (let j = a; j < b; j++) { const v = D.val(key, j); if (!Number.isFinite(v)) continue; if (v < lo) lo = v; if (v > hi) hi = v; }
        if (lo === Infinity) { lo = 0; hi = 1; }
        const m = (hi - lo) * .08 || Math.abs(hi) * .01 || 1e-3; lo -= m; hi += m;
        const Y = v => y0 + laneH - (v - lo) / (hi - lo) * laneH;
        g.strokeStyle = c.line; g.lineWidth = 1; g.strokeRect(L + .5, y0 + .5, W - L - R, laneH);
        g.textAlign = 'right';
        for (const v of niceTicks(lo, hi, Math.max(2, laneH / 30 | 0))) { const y = Y(v); if (y < y0 + 6 || y > y0 + laneH - 4) continue; g.strokeStyle = c.grid; g.beginPath(); g.moveTo(L, y + .5); g.lineTo(W - R, y + .5); g.stroke(); g.fillStyle = c.ink3; g.fillText(fmtSI(v, meta[2], 3), L - 5, y + 3); }
        g.textAlign = 'left'; g.fillStyle = c.ink2; g.fillText(meta[1], L + 6, y0 + 12);
        const color = c.t[C2_CURVES.findIndex(x => x[0] === key) % 4];
        g.save(); g.beginPath(); g.rect(L, y0, W - L - R, laneH); g.clip();
        g.strokeStyle = color; g.lineWidth = 1.6; g.beginPath();
        let col = -1, mn = 0, mx = 0, pen = false;
        const flush = () => { if (col < 0) return; if (!pen) { g.moveTo(col, Y(mn)); pen = true; } g.lineTo(col, Y(mn)); if (mx !== mn) g.lineTo(col, Y(mx)); };
        for (let j = Math.max(0, a - 1); j < Math.min(D.n, b + 1); j++) {
          const v = D.val(key, j); if (!Number.isFinite(v)) { flush(); col = -1; pen = false; continue; }
          const x = Math.round(X(D.T(j)));
          if (x !== col) { flush(); col = x; mn = mx = v; } else { if (v < mn) mn = v; if (v > mx) mx = v; }
        }
        flush(); g.stroke(); g.restore();
        if (hover && hover.x > L && D.n) {
          const j = clamp(D.lower(tOf(hover.x)), 0, D.n - 1), v = D.val(key, j);
          tipRows.push(h('div', {}, h('i', { style: { background: color } }), meta[1], h('b', { text: fmtSI(v, meta[2], 5) })));
          g.fillStyle = color; g.beginPath(); g.arc(X(D.T(j)), Y(v), 3.5, 0, 6.3); g.fill();
        }
      });
      for (const [k, t] of [['A', cur.a], ['B', cur.b]]) {
        if (t === null || t < ta || t > tb) continue;
        const x = X(t); g.strokeStyle = k === 'A' ? c.t[0] : c.t[1]; g.lineWidth = 1.5; g.setLineDash([5, 3]); g.beginPath(); g.moveTo(x + .5, T); g.lineTo(x + .5, H - B); g.stroke(); g.setLineDash([]);
        g.fillStyle = g.strokeStyle; g.textAlign = 'center'; g.fillText(k, x, T + 10);
      }
      if (hover && hover.x > L && tipRows.length) {
        g.strokeStyle = c.ink3; g.lineWidth = 1; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(hover.x + .5, T); g.lineTo(hover.x + .5, H - B); g.stroke(); g.setLineDash([]);
        tip.replaceChildren(...tipRows); tip.hidden = false; tip.style.left = Math.min(hover.x + 12, W - 190) + 'px'; tip.style.top = Math.min(hover.y + 12, H - 30 - tipRows.length * 18) + 'px';
      }
      // курсоры и пульсации
      const parts = [];
      if (cur.a !== null && cur.b !== null) {
        const t1 = Math.min(cur.a, cur.b), t2 = Math.max(cur.a, cur.b);
        parts.push(`ΔT ${fmtSI((t2 - t1) / 1000, 's', 4)}, 1/ΔT ${fmtSI(1000 / Math.max(1e-9, t2 - t1), 'Hz', 4)}`);
        for (const key of keys) {
          const meta = C2_CURVES.find(x => x[0] === key), s = D.stats(key, t1, t2);
          const ja = clamp(D.lower(t1), 0, D.n - 1), jb = clamp(D.lower(t2), 0, D.n - 1);
          parts.push(`${meta[1]}: A ${fmtSI(D.val(key, ja), meta[2], 5)}, B ${fmtSI(D.val(key, jb), meta[2], 5)}, Δ ${fmtSI(D.val(key, jb) - D.val(key, ja), meta[2], 4)}, ср. ${fmtSI(s.avg, meta[2], 5)}, размах ${fmtSI(s.pp, meta[2], 4)}`);
        }
        if (D.n) { const ja = clamp(D.lower(t1), 0, D.n - 1), jb = clamp(D.lower(t2), 0, D.n - 1); parts.push(`между курсорами: ${fmtSI(D.val('ah', jb) - D.val('ah', ja), 'Ah', 4)}, ${fmtSI(D.val('wh', jb) - D.val('wh', ja), 'Wh', 4)}`); }
      } else {
        const sv = D.stats('v', ta, tb), si = D.stats('i', ta, tb);
        parts.push(`На экране: U ср. ${fmtSI(sv.avg, 'V', 5)}, пульсации Vpp ${fmtSI(sv.pp, 'V', 4)}; I ср. ${fmtSI(si.avg, 'A', 5)}, размах ${fmtSI(si.pp, 'A', 4)}; точек ${sv.n}`);
        parts.push('Щелчок ставит курсор A, второй щелчок B, двойной щелчок убирает. Колесо: масштаб времени, перетаскивание: сдвиг (ставит паузу).');
      }
      info.replaceChildren(...parts.map(t => h('div', { text: t })));
    }
    let last = 0;
    return { tick(now) { if (now - last > 50 || hover) { last = now; draw(); } }, dispose() { p.dispose(); stopAuto(); } };
  },
});

/* ---------- Триггер и автоопределение протоколов ---------- */
WM.define('c2-trigger', {
  title: 'C2: триггер и протоколы', dev: 'c2', devName: 'C2', w: 640, h: 560,
  make(win, dev) {
    const warn = h('p', { class: 'note c2-warn', text: 'Триггер поднимает напряжение на всех гнёздах C2, кроме порта для ПК. Перед запросом отключите всё, кроме нагрузки, рассчитанной на это напряжение.' });
    const btns = h('div', { class: 'row wrap' }, ...C2_PROTOS.map(([id, n]) => h('button', { class: 'btn', onclick: async () => { if (!(await armed())) return; dev.trigger(id).catch(errToast); } }, n)));
    const gears = h('div', { class: 'col' }), log = h('div', { class: 'cons-log scroll', role: 'log' }), scanOut = h('div', { class: 'note' });
    let ok = false;
    async function armed() { if (ok) return true; ok = await c2Ask('Триггер может поднять напряжение до 48 В на всех гнёздах тестера. Подключены только источник и нагрузка, рассчитанная на это? Продолжить?'); return ok; }
    function drawGears() {
      gears.replaceChildren();
      if (!dev.pdo.length) { gears.append(h('p', { class: 'note', text: dev.trigProto === null ? 'Выберите протокол. Список режимов придёт от прибора.' : 'Ждём список режимов от прибора…' })); return; }
      for (const e of dev.pdo) {
        const isVar = e.kind !== 'FIX';
        const inp = isVar ? h('input', { type: 'number', min: e.min / 1000, max: e.max / 1000, step: (e.step || 20) / 1000, value: ((e.req || e.min) / 1000).toFixed(2), style: { width: '84px' } }) : null;
        const label = isVar ? `${e.kind} ${(e.min / 1000).toFixed(1)}…${(e.max / 1000).toFixed(1)} В, ${(e.ma / 1000).toFixed(2)} А` : `${(e.max || e.req || e.min) ? ((e.max || e.req || e.min) / 1000).toFixed(1) + ' В' : 'режим ' + e.n}, ${(e.ma / 1000).toFixed(2)} А`;
        gears.append(h('div', { class: 'row wrap' + (e.flag ? ' on' : '') }, h('span', { text: label }), inp,
          h('button', { class: 'btn', onclick: async () => { if (!(await armed())) return; dev.request(e, isVar ? +inp.value * 1000 : undefined).catch(errToast); } }, isVar ? 'Установить' : 'Запросить')));
      }
    }
    function drawLog() { log.replaceChildren(...dev.trigLog.slice(-300).map(x => h('div', { text: `${fmtClock(x.t)}  ${x.text}` }))); log.scrollTop = log.scrollHeight; }
    async function scan() {
      if (!(await armed())) return;
      const res = [];
      for (const [id, name] of C2_PROTOS) {
        scanOut.textContent = `Проверяю ${name}…`;
        const before = dev.trigLog.length; dev.pdo = [];
        await dev.trigger(id); await sleep(4500);
        const said = dev.trigLog.slice(before).filter(x => x.proto !== undefined).map(x => x.text).join('; ');
        const ok2 = dev.pdo.length > 0 || /exist(?! *!)|support/i.test(said) && !/not exist/i.test(said);
        res.push(`${name}: ${ok2 ? 'есть' : 'нет'}${dev.pdo.length ? ` (${dev.pdo.length} режимов)` : ''}`);
        await dev.exitTrigger(); await sleep(800);
      }
      scanOut.textContent = 'Итог: ' + res.join(', ');
      dev.trigLog.push({ t: Date.now(), text: 'Автоопределение: ' + res.join(', ') }); drawLog();
    }
    win.body.append(h('div', { class: 'col pad scroll' }, warn,
      h('h4', { text: 'Протокол' }), btns,
      h('div', { class: 'row wrap' }, h('button', { class: 'btn', onclick: () => dev.exitTrigger().catch(errToast) }, 'Выйти из триггера'), h('button', { class: 'btn', onclick: () => scan().catch(errToast) }, 'Автоопределение протоколов'), scanOut),
      h('h4', { text: 'Режимы источника' }), gears, h('h4', { text: 'Журнал' }), log));
    drawGears(); drawLog();
    win.sub(dev, 'pdo', drawGears); win.sub(dev, 'trig', drawLog);
    return {};
  },
});

/* ---------- Анализатор PD ---------- */
WM.define('c2-pd', {
  title: 'C2: анализатор PD', dev: 'c2', devName: 'C2', w: 900, h: 560,
  make(win, dev, cfg) {
    cfg.hideCrc ??= true;
    const run = toggle('Слушать линию CC', dev.s.listen, v => dev.listen(v).catch(errToast));
    const hide = toggle('Скрыть GoodCRC', cfg.hideCrc, v => { cfg.hideCrc = v; WM.save(); dirty = true; });
    const status = h('span', { class: 'note' });
    win.toolbar.append(run, hide,
      h('button', { class: 'tbtn', onclick: () => dev.clearPd() }, 'Очистить'),
      h('button', { class: 'tbtn', onclick: () => saveFile(`c2-pd-${stamp()}.csv`, '﻿№;Время, с;SOP;От кого;Сообщение;Подробно;CRC;Байты\n' + dev.pdMsgs.map(m => [m.no, m.t.toFixed(6), m.sop, m.role || '', m.name, (m.sum || '').replace(/;/g, ','), m.crcOk ? 'ok' : m.err, [...m.bytes].map(b => b.toString(16).padStart(2, '0')).join(' ')].join(';')).join('\n'), 'text/csv') }, 'CSV'));
    const list = h('div', { class: 'c2-pdlist scroll' }), det = h('div', { class: 'c2-pddet scroll' }), sizer = h('div'), rowsBox = h('div', { class: 'c2-rows' });
    list.append(sizer, rowsBox);
    win.body.append(h('div', { class: 'row pad c2-status' }, status), h('div', { class: 'c2-pdsplit' }, list, det));
    const RH = 22; let view = [], dirty = true, sel = null, follow = true;
    function filtered() { return cfg.hideCrc ? dev.pdMsgs.filter(m => !(m.n === 0 && m.type === 1 && !m.ext && !m.kind)) : dev.pdMsgs; }
    function render() {
      const top = list.scrollTop, hgt = list.clientHeight, first = Math.max(0, (top / RH | 0) - 5), last = Math.min(view.length, first + (hgt / RH | 0) + 12);
      sizer.style.height = view.length * RH + 'px'; rowsBox.style.transform = `translateY(${first * RH}px)`;
      const out = [];
      for (let k = first; k < last; k++) {
        const m = view[k];
        out.push(h('div', { class: 'c2-pdrow' + (m === sel ? ' on' : '') + (m.crcOk ? '' : ' bad'), onclick: () => { sel = m; follow = false; details(); render(); } },
          h('span', { text: m.no }), h('span', { text: m.t.toFixed(6) }), h('span', { text: m.sop }), h('span', { text: m.role || '' }), h('b', { text: m.name }), h('span', { text: m.sum || (m.crcOk ? '' : m.err) })));
      }
      rowsBox.replaceChildren(...out);
    }
    function details() {
      const m = sel; if (!m) { det.replaceChildren(h('p', { class: 'note', text: 'Выберите сообщение.' })); return; }
      const rows = [['Сообщение', m.name], ['SOP', m.sop], ['Время', m.t.toFixed(6) + ' с'], ['CRC', m.crcOk ? 'верная ' + c2hex8(m.crc) : m.err]];
      if (m.hdr !== undefined) rows.push(['Заголовок', `${c2hex8(m.hdr).slice(6)}: ${m.role}, ${m.data}, PD ${m.rev}, ID ${m.id}, объектов ${m.n}${m.ext ? ', расширенное' : ''}`]);
      det.replaceChildren(h('table', { class: 'grid' }, h('tbody', {}, ...rows.map(([k, v]) => h('tr', {}, h('td', { text: k }), h('td', { text: v }))))),
        ...(m.lines || []).map(t => h('div', { text: t })), h('pre', { text: [...m.bytes].map(b => b.toString(16).padStart(2, '0')).join(' ') }));
    }
    list.addEventListener('scroll', () => { follow = list.scrollTop + list.clientHeight >= list.scrollHeight - RH * 2; render(); });
    win.sub(dev, 'pd', () => { dirty = true; }); win.sub(dev, 'listen', () => run.set(dev.s.listen));
    details();
    let lastN = -1, lastT = 0, lastB = 0, bps = 0;
    return {
      tick(now) {
        if (now - lastT > 1000) { bps = (dev.pdBytes - lastB) * 8; lastB = dev.pdBytes; lastT = now; }
        const cc = dev.s.ccEvents.at(-1);
        status.textContent = `${dev.s.listen ? 'слушаю' : 'стоп'}; частота выборки ${(dev.s.fsPd / 1e6).toFixed(3)} МГц; поток ${(bps / 1e6).toFixed(2)} Мбит/с (${(bps / dev.s.fsPd * 100 || 0).toFixed(0)} %); ${cc ? `CC${cc.cc} ${cc.on ? 'подключена' : 'свободна'}; ` : ''}сообщений ${dev.pdMsgs.length}`;
        if (!dirty && dev.pdMsgs.length === lastN) return;
        dirty = false; lastN = dev.pdMsgs.length; view = filtered();
        if (follow) list.scrollTop = view.length * RH;
        render();
      },
    };
  },
});

/* ---------- E-marker ---------- */
WM.define('c2-emarker', {
  title: 'C2: e-marker', dev: 'c2', devName: 'C2', w: 640, h: 500,
  make(win, dev) {
    const out = h('div', { class: 'col' });
    let slots = [{ slot: 0, valid: 0, vdo: [0, 0, 0, 0] }, { slot: 1, valid: 0, vdo: [0, 0, 0, 0] }];
    const names = ['ID Header', 'Cert Stat (XID)', 'Product (PID, bcdDevice)', 'Cable VDO'];
    const fileIn = h('input', { type: 'file', accept: '.json', hidden: true, onchange: async e => { try { slots = JSON.parse(await e.target.files[0].text()); draw(); } catch { toast('Это не файл e-marker', 'bad'); } } });
    win.toolbar.append(h('button', { class: 'tbtn', onclick: read }, 'Прочитать'), h('button', { class: 'tbtn', onclick: () => saveFile(`c2-emarker-${stamp()}.json`, JSON.stringify(slots, null, 1), 'application/json') }, 'Экспорт'), h('button', { class: 'tbtn', onclick: () => fileIn.click() }, 'Импорт'), fileIn);
    function decode(v) {
      const id = v[0], typ = id >>> 27 & 7;
      return `VID 0x${(id & 0xFFFF).toString(16).toUpperCase().padStart(4, '0')}, PID 0x${(v[2] >>> 16).toString(16).toUpperCase().padStart(4, '0')}, тип ${['?', 'хаб', 'устройство', 'пассивный кабель', 'активный кабель', 'AMA', 'VPD', '?'][typ]}; ${cableVdoText(v[3])}`;
    }
    function draw() {
      out.replaceChildren();
      for (const s of slots) {
        const ins = s.vdo.map((w, i) => h('input', { value: c2hex8(w), style: { width: '110px', fontFamily: 'var(--f-mono)' }, 'aria-label': names[i] }));
        out.append(h('h4', { text: `Ячейка ${s.slot + 1}${s.valid ? '' : ' (пусто)'}` }), h('p', { class: 'note', text: decode(s.vdo) }),
          h('div', { class: 'row wrap' }, ...ins.map((x, i) => field(names[i], x))),
          h('div', { class: 'row wrap' }, h('button', { class: 'btn', onclick: async () => { const v = ins.map(x => parseInt(x.value, 16) >>> 0); if (v.some(Number.isNaN)) { toast('Нужны шестнадцатеричные числа', 'bad'); return; } try { await dev.emarkerWrite(s.slot, v); toast('E-marker записан в прибор', 'ok'); read(); } catch (e) { errToast(e); } } }, 'Записать в прибор'),
            h('button', { class: 'btn', onclick: async () => { if (!(await c2Ask(`Удалить e-marker из ячейки ${s.slot + 1}?`))) return; try { await dev.emarkerClear(s.slot); read(); } catch (e) { errToast(e); } } }, 'Удалить')));
      }
    }
    async function read() { try { const r = await dev.emarkerRead(); for (const x of r) slots[x.slot] = x; draw(); } catch (e) { errToast(e); } }
    win.body.append(h('div', { class: 'col pad scroll' }, h('p', { class: 'note', text: 'Прибор хранит две ячейки e-marker: прочитанные с кабеля и свои. Их же он подставляет при имитации кабеля.' }), out));
    draw(); read();
    return {};
  },
});

/* ---------- Офлайн-записи прибора ---------- */
WM.define('c2-offline', {
  title: 'C2: записи в приборе', dev: 'c2', devName: 'C2', w: 640, h: 440,
  make(win, dev) {
    const list = h('div', { class: 'col' }), note = h('p', { class: 'note' });
    async function refresh() {
      list.replaceChildren(h('p', { class: 'note', text: 'Читаю…' }));
      try {
        const g = await dev.offlineGroups(); list.replaceChildren();
        if (!g.length || !g.some(x => x.n)) { list.append(h('p', { class: 'note', text: 'В приборе нет записей.' })); return; }
        for (const x of g) {
          list.append(h('div', { class: 'row wrap' }, h('b', { text: `Группа ${x.ch + 1}` }), h('span', { text: `${x.n} точек через ${x.every} мс, ${x.dur} с; ${x.a.toFixed(3)} мА·ч, ${x.b.toFixed(3)} мВт·ч` }),
            h('button', { class: 'btn', onclick: () => load(x, 'graph') }, 'В графики'), h('button', { class: 'btn', onclick: () => load(x, 'csv') }, 'CSV')));
        }
      } catch (e) { list.replaceChildren(h('p', { class: 'note', text: 'Прибор не ответил: ' + e.message })); }
    }
    async function load(x, to) {
      note.textContent = 'Читаю точки…';
      try {
        const pts = await dev.offlineRead(x.ch, x.n);
        note.textContent = `Прочитано ${pts.length} точек из ${x.n}.`;
        if (to === 'csv') { saveFile(`c2-zapis-${x.ch + 1}-${stamp()}.csv`, '﻿Время, с;Напряжение, V;Ток, A\n' + pts.map(([v, i], k) => [(k * x.every / 1000).toFixed(3), v, i].join(';')).join('\n'), 'text/csv'); return; }
        const D = new C2Data(1 << Math.max(10, Math.ceil(Math.log2(pts.length + 1)))); pts.forEach(([v, i], k) => D.push(k * x.every, v, i, 0, 0, 0, 0));
        D.title = `запись ${x.ch + 1} из прибора`; dev.loaded = D; dev.emit('loaded');
        if (!WM.desk.wins.some(w => w.type === 'c2-graph')) WM.open('c2-graph');
        toast('Запись показана в окне графиков (режим «Файл»)', 'ok');
      } catch (e) { note.textContent = 'Ошибка: ' + e.message; }
    }
    win.toolbar.append(h('button', { class: 'tbtn', onclick: refresh }, 'Обновить'));
    win.body.append(h('div', { class: 'col pad scroll' }, list, note));
    refresh();
    return {};
  },
});

/* ---------- Калибровка: самопотребление, усреднение, V/I по DM40, резервная копия ---------- */
WM.define('c2-cal', {
  title: 'C2: калибровка', dev: 'c2', devName: 'C2', w: 760, h: 620,
  make(win, dev, cfg) {
    if (c2Need(win, dev)) return {};
    const st = h('div', { class: 'note' }), tbl = h('div', {}), pts = h('tbody'), live = h('div', { class: 'stats' });
    cfg.qty ??= 'v'; cfg.ref ??= 'dm40';
    let points = store.get(`c2.cal.${dev.info.serial}.points`, { v: [], i: [] });
    const avgSel = select([[0, 'Выкл'], [1, '×2'], [2, '×4'], [3, '×8'], [4, '×16'], [5, '×32']], dev.ext.avg, v => dev.setAvg(+v).then(() => toast('Усреднение экрана Basic изменено', 'ok')).catch(errToast), 'Усреднение');
    const qSel = seg([['v', 'Напряжение'], ['i', 'Ток']], cfg.qty, v => { cfg.qty = v; rawAvg = []; WM.save(); drawPts(); }, 'Что калибруем');
    const refSel = select([['dm40', 'DM40 (основное показание)'], ['manual', 'Ввести вручную']], cfg.ref, v => { cfg.ref = v; WM.save(); }, 'Эталон');
    const manual = h('input', { type: 'number', step: 'any', placeholder: 'эталон', style: { width: '110px' } });
    const cells = { raw: h('b'), ref: h('b'), k: h('b') };
    live.append(h('div', {}, h('span', { text: 'C2 без поправки' }), cells.raw), h('div', {}, h('span', { text: 'Эталон' }), cells.ref), h('div', {}, h('span', { text: 'Отношение' }), cells.k));
    let rawAvg = [], polling = true;
    async function poll() {
      while (polling && dev.alive) {
        try { const x = await dev.extInfo(); rawAvg.push(cfg.qty === 'v' ? x.rawV : x.rawI); if (rawAvg.length > 15) rawAvg.shift(); status(x); } catch { }
        await sleep(220);
      }
    }
    const mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);
    const refNow = () => cfg.ref === 'manual' ? +manual.value : Hub.q.get('dm40.main')?.last;
    function status(x) {
      st.textContent = `Самокалибровка: ${C2_SC_RESULT[x.flag ? 7 : x.result] || x.result}${x.result === 1 && !x.flag ? `, точек ${x.npts}` : ''}. Таблица ${x.sc ? 'есть' : 'нет'}, калибровка V/I ${x.uc ? 'есть' : 'нет'}. Журнал занят ${x.logFree - x.log0} из ${x.logEnd - x.log0} байт. ${x.usb === 3 ? 'C2 питается от USB: самопотребление сейчас не вычитается.' : ''}${x.duty != null ? ` ШИМ подсветки ${x.duty}.` : ''}${x.pts ? ' Точки прогона: ' + [5, 7, 9, 12, 15, 20, 24, 28].map((v, k) => `${v} В ${C2_PT[x.pts[k]] || '?'}`).join(', ') + '.' : ''}`;
    }
    async function addPoint() {
      const raw = mean(rawAvg), ref = refNow();
      if (!Number.isFinite(ref) || !Number.isFinite(raw) || Math.abs(raw) < 1e-4) { toast('Нет показаний эталона или C2', 'bad'); return; }
      const list = points[cfg.qty];
      if (list.length >= 8) { toast('Не больше 8 точек на величину', 'bad'); return; }
      list.push({ x: raw, k: ref / raw, ref }); list.sort((a, b) => a.x - b.x);
      store.set(`c2.cal.${dev.info.serial}.points`, points); drawPts();
    }
    function drawPts() {
      const list = points[cfg.qty], u = cfg.qty === 'v' ? 'V' : 'A';
      pts.replaceChildren(...list.map((p, i) => h('tr', {}, h('td', { text: fmtSI(p.x, u, 6) }), h('td', { text: fmtSI(p.ref, u, 6) }), h('td', { text: ((p.k - 1) * 100).toFixed(3) + ' %' }),
        h('td', {}, h('button', { class: 'wbtn', 'aria-label': 'Убрать точку', onclick: () => { list.splice(i, 1); store.set(`c2.cal.${dev.info.serial}.points`, points); drawPts(); } }, '×')))));
    }
    async function writeCal(clear) {
      const v = clear ? [] : points.v, i = clear ? [] : points.i;
      const body = new Uint8Array(4 + 8 * (v.length + i.length)), dv = new DataView(body.buffer);
      body[0] = v.length; body[1] = i.length;
      [...v, ...i].forEach((p, k) => { dv.setFloat32(4 + k * 8, p.x, true); dv.setFloat32(8 + k * 8, p.k, true); });
      try { const a = await dev.writeRecord(2, body); toast(clear ? 'Калибровка V/I в приборе сброшена' : `Калибровка записана в прибор (0x${a.toString(16)})`, 'ok'); backupLocal(); } catch (e) { errToast(e); }
    }
    async function showTable() {
      try {
        const x = await dev.extInfo(); if (!x.sc) { tbl.replaceChildren(h('p', { class: 'note', text: 'Таблицы самопотребления нет.' })); return; }
        const b = await dev.peek(x.sc, 96), vs = [5, 7, 9, 12, 15, 20, 24, 28];
        tbl.replaceChildren(h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, h('th', { text: 'Подсветка' }), ...vs.map(v => h('th', { text: v + ' В' })))),
          h('tbody', {}, ...[0, 1, 2, 3, 4, 5].map(l => h('tr', {}, h('td', { text: 'уровень ' + l }), ...vs.map((v, i) => { const w = c2u16(b, l * 16 + i * 2) / 10; return h('td', { class: 'num', text: `${w.toFixed(1)} мВт / ${(w / v).toFixed(1)} мА` }); }))))));
      } catch (e) { errToast(e); }
    }
    async function backupLocal(download) {
      try {
        const recs = await dev.readLog(), last = t => recs.filter(r => r.type === t).at(-1);
        const bk = { serial: dev.info.serial, at: new Date().toISOString(), selfcal: last(1) && [...last(1).body], usercal: last(2) && [...last(2).body] };
        store.set(`c2.backup.${dev.info.serial}`, bk);
        if (download) saveFile(`c2-calibrovka-${dev.info.serial}-${stamp()}.json`, JSON.stringify(bk), 'application/json');
        return bk;
      } catch (e) { errToast(e); return null; }
    }
    async function restore(bk) {
      bk ??= store.get(`c2.backup.${dev.info.serial}`, null);
      if (!bk) { toast('Резервной копии для этого прибора нет', 'bad'); return; }
      try {
        if (bk.selfcal) await dev.writeRecord(1, Uint8Array.from(bk.selfcal));
        if (bk.usercal) await dev.writeRecord(2, Uint8Array.from(bk.usercal));
        toast('Калибровки восстановлены в приборе', 'ok'); showTable();
      } catch (e) { errToast(e); }
    }
    const fileIn = h('input', { type: 'file', accept: '.json', hidden: true, onchange: async e => { try { restore(JSON.parse(await e.target.files[0].text())); } catch { toast('Это не файл калибровки', 'bad'); } } });
    win.body.append(h('div', { class: 'col pad scroll' }, st,
      h('h4', { text: 'Самопотребление тестера' }),
      h('p', { class: 'note', text: 'Запускается на самом приборе: More → Self-cal. Нужен источник PD с PPS в заднем гнезде, USB к ПК отключён, нагрузки нет. По USB прибор питается от ПК, поэтому отсюда калибровку не запустить.' }),
      h('div', { class: 'row wrap' }, h('button', { class: 'btn', onclick: showTable }, 'Показать таблицу'), field('Усреднение на экране Basic', avgSel)), tbl,
      h('h4', { text: 'Напряжение и ток по эталону' }),
      h('p', { class: 'note', text: 'Подайте напряжение (или пустите ток) так, чтобы его видели и C2, и эталон. Для тока DM40 ставится последовательно с нагрузкой. Нажмите «Добавить точку», повторите для 2–8 значений по всему диапазону, затем «Записать в прибор». Между точками прибор интерполирует поправку линейно.' }),
      h('div', { class: 'row wrap' }, qSel, field('Эталон', refSel), manual), live,
      h('div', { class: 'row wrap' }, h('button', { class: 'btn primary', onclick: addPoint }, 'Добавить точку'), h('button', { class: 'btn', onclick: () => writeCal(false) }, 'Записать в прибор'), h('button', { class: 'btn', onclick: async () => { if (await c2Ask('Сбросить калибровку V и I в приборе?')) writeCal(true); } }, 'Сбросить в приборе')),
      h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, ...['C2 без поправки', 'Эталон', 'Поправка', ''].map(t => h('th', { text: t })))), pts),
      h('h4', { text: 'Резервная копия' }),
      h('p', { class: 'note', text: 'Прошивка стирает калибровки при обновлении. Пульт хранит последнюю копию для каждого прибора и может вернуть её одной кнопкой.' }),
      h('div', { class: 'row wrap' }, h('button', { class: 'btn', onclick: () => backupLocal(true) }, 'Сохранить копию в файл'), h('button', { class: 'btn', onclick: () => restore() }, 'Восстановить из Пульта'), h('button', { class: 'btn', onclick: () => fileIn.click() }, 'Восстановить из файла'), fileIn)));
    drawPts(); poll();
    return {
      tick() {
        const raw = mean(rawAvg), ref = refNow(), u = cfg.qty === 'v' ? 'V' : 'A';
        cells.raw.textContent = fmtSI(raw, u, 6); cells.ref.textContent = Number.isFinite(ref) ? fmtSI(ref, u, 6) : '–'; cells.k.textContent = Number.isFinite(ref) && raw ? ((ref / raw - 1) * 100).toFixed(3) + ' %' : '–';
      },
      dispose() { polling = false; },
    };
  },
});

/* ---------- Прошивка ---------- */
/* ---------- обновление прошивки через загрузчик C2 (разбор: C2\C2_LOADER_PROTOCOL.md) ----------
   Вход: команда 15 [1] в приложении стирает сектор 0x8000 и перезапускает прибор в загрузчик
   (тот же VID:PID). Загрузчик: кадры AF cmd seq len payload ck, ответы DF cmd seq len payload ck.
   0x10 сведения, 0x11 = 13 байт заголовка .atk (A0 = область приложения, [6..9] длина),
   0x12 начало, 0x13 данные (по 56 байт, каждое слово зашифровано обратным к FUN_0x22E6
   преобразованием), 0x14 конец (сектор 0x8000 пишется последним), 0x15 перезапуск. */
const C2FW = {
  busy: false,
  K: [0xB894EB63, 0x8B7265D0, 0x297EDB67, 0xFEFFC7E8],
  sw(y, a, b, inv) { const B = [y & 255, y >>> 8 & 255, y >>> 16 & 255, y >>> 24 & 255], t = B[a]; B[a] = inv ? ~B[b] & 255 : B[b]; B[b] = inv ? ~t & 255 : t; return (B[0] | B[1] << 8 | B[2] << 16 | B[3] << 24) >>> 0; },
  enc(y) {
    const [K3, K4, K5, K6] = C2FW.K;
    y = (C2FW.sw(y, 0, 3) ^ K3) >>> 0; y = (C2FW.sw(y, 1, 2) ^ K4) >>> 0;
    y = (C2FW.sw(y, 0, 3, true) ^ K5) >>> 0; return (C2FW.sw(y, 1, 2, true) ^ K6) >>> 0;
  },
  parse(a) {
    if (a.length < 0x20000 || a[0] !== 0x0A || a[1] !== 3 || a[2] !== 0x0A || a[4] !== 0xA0) throw new Error('Это не файл прошивки C2 (.atk).');
    const n = (a[6] | a[7] << 8 | a[8] << 16 | a[9] << 24) >>> 0;
    if (n !== a.length - 13 || n % 4 || n >= 0x7F000) throw new Error(`Файл повреждён: в заголовке ${n} байт, тело ${a.length - 13}.`);
    const X = [0x43, 0xDF, 0x2A, 0x9B], raw = new Uint8Array(n);
    for (let i = 0; i < n; i++) raw[i] = a[13 + i] ^ X[i & 3];
    const dv = new DataView(raw.buffer), sp = dv.getUint32(0, true), rv = dv.getUint32(4, true);
    if (sp < 0x1FFF8000 || sp > 0x20027000 || rv < 0x8000 || rv > 0x80000) throw new Error('В файле не приложение C2 (неверная таблица векторов).');
    const v = String.fromCharCode(...raw.subarray(0x16D88 - 0x8000, 0x16D88 - 0x8000 + 5));
    return { hdr: a.slice(0, 13), raw, ver: /^\d\.\d\.\d$/.test(v) ? v : '?', size: n };
  },
  frame(cmd, seq, p = new Uint8Array(0)) {
    const f = new Uint8Array(5 + p.length); f[0] = 0xAF; f[1] = cmd; f[2] = seq; f[3] = p.length; f.set(p, 4);
    f[4 + p.length] = C2P.cksum(f, 4 + p.length); return f;
  },
  chunks(raw) {
    const out = [], dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    for (let o = 0; o < raw.length; o += 56) {
      const n = Math.min(56, raw.length - o), c = new Uint8Array(n), cv = new DataView(c.buffer);
      for (let k = 0; k < n; k += 4) cv.setUint32(k, C2FW.enc(dv.getUint32(o + k, true)), true);
      out.push(c);
    }
    return out;
  },
};
/* Ответы загрузчика DF … вместо кадров EE. */
class C2AfParser extends C2Frame {
  take() {
    for (; ;) {
      let i = 0;
      while (i < this.len && this.buf[i] !== 0xDF) i++;
      if (i) this.drop(i);
      if (this.len < 4) return null;
      const L = this.buf[3], need = 5 + L;
      if (L > 0x3B || this.buf[1] < 0x10 || this.buf[1] > 0x16) { this.drop(1); continue; }
      if (this.len < need) return null;
      if (this.buf[4 + L] !== C2P.cksum(this.buf, 4 + L)) { this.bad++; this.drop(1); continue; }
      const out = this.buf.slice(0, need); this.drop(need); return out;
    }
  }
}
async function c2AfTx(tr, cmd, seq, payload, timeout = 1500, tries = 5) {
  const f = C2FW.frame(cmd, seq, payload);
  for (let k = 0; k < tries; k++) {
    await tr.send(f);
    const end = performance.now() + timeout;
    for (; ;) {
      let m;
      try { m = await tr.recv(Math.max(1, end - performance.now())); } catch (e) { if (e instanceof TimeoutError) break; throw e; }
      if (m[1] === cmd && m[2] === seq) return { r: m.subarray(4, 4 + m[3]), retry: k > 0 };
    }
  }
  return null;
}
const c2LoaderTr = (kind, src) => { const tr = kind === 'usb' ? new UsbVendor(src) : new WsLink(src); tr.parser = new C2AfParser(); return tr; };
/* Ждёт, пока прибор появится в режиме загрузчика, и отдаёт открытый транспорт. */
async function c2LoaderWait(kind, url, ui, ms = 30000) {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    let tr = null;
    try {
      let src = url;
      if (kind === 'usb') { src = (await navigator.usb.getDevices()).find(d => UsbVendor.match(d)); if (!src) { await sleep(500); continue; } }
      tr = c2LoaderTr(kind, src); await tr.open();
      if (await c2AfTx(tr, 0x10, 0, undefined, 600, 2)) return tr;
    } catch { }
    await tr?.close().catch(() => { }); await sleep(700);
    ui.say(`Жду загрузчик C2… ${((performance.now() - t0) / 1000) | 0} с`);
  }
  throw new Error(kind === 'usb' ? 'Загрузчик C2 не появился за 30 с. Если на экране прибора «UPGRADE / Ready», нажмите «Подключить» на карточке C2 по USB и выберите прибор: Пульт предложит дошить прошивку.' : 'Загрузчик C2 не появился за 30 с. Проверьте, что мост запущен.');
}
async function c2LoaderRun(tr, img, ui) {
  let seq = 0;
  const step = async (cmd, p, to = 1500) => {
    const x = await c2AfTx(tr, cmd, seq, p, to);
    if (!x) throw new Error(`Загрузчик не ответил на команду 0x${cmd.toString(16)}.`);
    seq = (seq + 1) & 255; if (seq === 0xFF) seq = 0;
    return x;
  };
  ui.say('Загрузчик на связи, начинаю запись…');
  await step(0x10);
  await step(0x11, img.hdr);
  if ((await step(0x12)).r[0]) throw new Error('Загрузчик отклонил размер образа.');
  const ch = C2FW.chunks(img.raw), t0 = performance.now();
  for (let i = 0; i < ch.length; i++) {
    const x = await step(0x13, ch[i], 2000);
    if (x.r[0]) throw new Error(`Загрузчик сообщил ошибку на пакете ${i + 1} из ${ch.length}.`);
    if (i % 32 === 0 || i === ch.length - 1) { ui.prog((i + 1) / ch.length); ui.say(`Запись ${((i + 1) / ch.length * 100) | 0} % (${(Math.min(img.size, (i + 1) * 56) / 1024) | 0} из ${(img.size / 1024) | 0} КБ, ${((performance.now() - t0) / 1000) | 0} с)`); }
  }
  const fin = await step(0x14, undefined, 5000);
  if (fin.r[0] && !fin.retry) throw new Error('Загрузчик не смог дописать первый сектор (0x8000).');
  await tr.send(C2FW.frame(0x15, seq, Uint8Array.of(0)));
}
/* Полный цикл: dev — подключённый C2 (или null, если прибор уже в загрузчике: тогда kind и src). */
async function c2Flash(img, ui, o = {}) {
  if (C2FW.busy) throw new Error('Прошивка уже идёт.');
  C2FW.busy = true;
  try { return await c2Flash1(img, ui, o); } finally { C2FW.busy = false; }
}
async function c2Flash1(img, ui, { dev = null, kind, src } = {}) {
  if (dev) {
    const tr0 = dev.link.tr; kind = tr0.kind; src = tr0.url;
    if (kind !== 'usb' && kind !== 'ws') throw new Error('Прошивать можно по USB или через мост. По Bluetooth прибор в загрузчик не переводится.');
    ui.say('Перевожу C2 в режим загрузчика…');
    dev.alive = false;                                                 // дальше отключение прибора ожидаемо
    await dev.link.send(4, [0]).catch(() => { });
    if (kind === 'ws') await tr0.send('!update');                          // мост пропускает команду 15 только после этого
    await sleep(300);                                                  // поток остановлен, хвост кадров дошёл
    dev.flashing = true;
    const ack = await dev.link.request(15, [1], { timeout: 2000 }).catch(e => e);   // прибор отвечает EE 0F, через 20 мс читает [1] из приёмного буфера и стирает
    if (ack instanceof Error) {
      dev.alive = true; dev.flashing = false; dev.watch?.();
      await dev.link.send(4, [1]).catch(() => { });
      throw new Error(kind === 'ws' ? 'C2 не подтвердил вход в загрузчик: мост не пропустил команду. Перезапустите мост новым bridge.py.' : `C2 не подтвердил вход в загрузчик (${ack.message || 'нет ответа'}). Переподключите C2 и попробуйте ещё раз.`);
    }
    dev.link.send = async () => { throw new Error('C2 перешёл в загрузчик'); };   // ни одного кадра больше: окна ещё могут опрашивать прибор
    await Devices.remove(dev).catch(() => { });
    await sleep(1500);
  }
  const tr = kind === 'usb' && src && !dev ? await (async () => { const t = c2LoaderTr('usb', src); await t.open(); return t; })() : await c2LoaderWait(kind, src, ui);
  try { await c2LoaderRun(tr, img, ui); } finally { await tr.close().catch(() => { }); }
  ui.prog(1); ui.say(`Прошивка ${img.ver} записана, C2 перезапускается…`);
  await sleep(3500);
  for (let k = 0; k < 10; k++) {
    try {
      let t;
      if (kind === 'usb') { const d = (await navigator.usb.getDevices()).find(x => UsbVendor.match(x)); if (!d) throw 0; t = new UsbVendor(d); }
      else t = new WsLink(src);
      const nd = await Devices.attachC2(t);
      ui.say(`Готово: C2 снова на связи, прошивка ${nd.info.fw}.`); return nd;
    } catch { await sleep(1500); }
  }
  ui.say(`Прошивка ${img.ver} записана. Пульт не смог подключиться сам — подключите C2 заново.`);
  return null;
}
/* Окно выбора файла и прошивки; используется и из окна «C2: прошивка», и когда прибор найден в загрузчике. */
function c2FlashUi(target) {
  const note = h('p', { class: 'note' }), bar = h('progress', { max: 1, value: 0, style: { width: '100%' } }), info = h('p', {});
  let img = null, busy = false;
  const go = h('button', { class: 'btn primary', disabled: true, onclick: async () => {
    if (busy || !img) return;
    const dev = target.dev && (Devices.list.find(d => d.id === target.dev.id && d.alive) || target.dev);
    if (target.dev && !dev.alive) { note.textContent = 'C2 сейчас не подключён. Подключите его и откройте это окно заново.'; return; }
    if (dev && !await c2Ask(`Записать в C2 прошивку ${img.ver} (${(img.size / 1024) | 0} КБ)? Текущая прошивка будет стёрта сразу. Не отключайте кабель до конца записи (около минуты). Если запись прервётся, прибор останется в загрузчике, и её можно будет повторить.`)) return;
    busy = true; go.disabled = true; file.disabled = true;
    try { await c2Flash(img, { say: t => { note.textContent = t; }, prog: x => { bar.value = x; } }, dev ? { dev } : target); }
    catch (e) { note.textContent = 'Не удалось: ' + (e.message || e); }
    busy = false; file.disabled = false; go.disabled = false;
  } }, 'Прошить');
  const file = h('input', { type: 'file', accept: '.atk', onchange: async e => {
    const f = e.target.files[0]; img = null; go.disabled = true; if (!f) return;
    try { img = C2FW.parse(new Uint8Array(await f.arrayBuffer())); info.textContent = `${f.name}: прошивка ${img.ver}, ${img.size} байт.`; go.disabled = false; }
    catch (err) { info.textContent = err.message; }
  } });
  return h('div', { class: 'col' }, h('div', { class: 'row wrap' }, file, go), info, bar, note);
}
/* Прибор ответил загрузчиком (прошивка стёрта или прервана): предложить дописать. */
async function c2LoaderFound(kind, src) {
  App.dlg('C2 в режиме загрузчика', h('div', { class: 'col pad' },
    h('p', { text: 'C2 сейчас в загрузчике: прошивки в нём нет или прошлая запись прервалась. Выберите файл .atk, и Пульт запишет его.' }),
    c2FlashUi({ dev: null, kind, src })));
}

WM.define('c2-fw', {
  title: 'C2: прошивка', dev: 'c2', devName: 'C2', w: 600, h: 380,
  make(win, dev) {
    const note = h('p', { class: 'note' }), bar = h('progress', { max: 1, value: 0, style: { width: '100%' } });
    async function dump(addr, len, name) {
      if (!dev.ext) { note.textContent = 'Нужна прошивка 4.2.0 или новее.'; return; }
      try {
        const out = new Uint8Array(len), step = 0x600;
        for (let o = 0; o < len; o += step) { out.set(await dev.peek(addr + o, Math.min(step, len - o)), o); bar.value = (o + step) / len; note.textContent = `Читаю… ${Math.min(100, ((o + step) / len * 100) | 0)} %`; }
        saveFile(name, new Blob([out])); note.textContent = `Готово: ${name}, ${len} байт.`;
      } catch (e) { note.textContent = 'Не удалось: ' + (e.message || e); }
    }
    win.body.append(h('div', { class: 'col pad' },
      h('p', { text: `${dev.info.model}, серийный ${dev.info.serial}: прошивка ${dev.info.fw}, ${dev.fwText}.` }),
      h('h4', { text: 'Обновление прошивки' }),
      h('p', { class: 'note', text: 'Подходит любой файл .atk для C2: фирменный или сборка Пульта. Прошивка идёт по USB или через мост (по Bluetooth нельзя). Версию загрузчик не проверяет, так что можно вернуться и на старую.' }),
      c2FlashUi({ dev }),
      h('h4', { text: 'Дампы' }),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn', onclick: () => dump(0, 0x6000, `c2-loader-${dev.info.serial}.bin`) }, 'Дамп загрузчика (24 КБ)'),
        h('button', { class: 'btn', onclick: () => dump(0, 0x80000, `c2-flash-${dev.info.serial}-${stamp()}.bin`) }, 'Полный дамп flash (512 КБ)')),
      bar, note));
    return {};
  },
});
