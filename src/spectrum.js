'use strict';
/* ---------- спектр: БПФ, усреднение, маркеры, пики, измерения, водопад ----------
 * Мощность каждого бина p[k] считается в В² СКЗ: синус с СКЗ U точно на бине
 * даёт p[k] = U². Мощность тона или шума в полосе = сумма p по бинам / ENBW,
 * поэтому уровни пиков и измерения не зависят от окна и от того, попал ли тон
 * точно на бин. */
const FFT_WINDOWS = {
  rect: ['Прямоугольное', 1, []],
  hann: ['Ханна', 2, [0.5, 0.5]],
  hamming: ['Хэмминга', 2, [0.54, 0.46]],
  blackman: ['Блэкмана', 3, [0.42, 0.5, 0.08]],
  bh: ['Блэкмана–Харриса', 4, [0.35875, 0.48829, 0.14128, 0.01168]],
  flat: ['Flat top', 5, [0.21557895, 0.41663158, 0.277263158, 0.083578947, 0.006947368]],
};
/* наибольший боковой лепесток, дБ, и его спад, дБ на октаву */
const FFT_SIDE = { rect: [-13.3, 6], hann: [-31.5, 18], hamming: [-42.7, 6], blackman: [-58.1, 18], bh: [-92, 6], flat: [-93, 6] };
function winCoef(id, L) {
  const a = (FFT_WINDOWS[id] || FFT_WINDOWS.hann)[2], w = new Float64Array(L);
  for (let i = 0; i < L; i++) {
    if (!a.length) { w[i] = 1; continue; }
    let s = a[0];
    for (let k = 1; k < a.length; k++) s += (k & 1 ? -1 : 1) * a[k] * Math.cos(2 * Math.PI * k * i / L);
    w[i] = s;
  }
  return w;
}
function fftInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let b = n >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let len = 2; len <= n; len <<= 1) {
    const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a), half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const j = i + k, m = j + half, tr = re[m] * cr - im[m] * ci, ti = re[m] * ci + im[m] * cr;
        re[m] = re[j] - tr; im[m] = im[j] - ti; re[j] += tr; im[j] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}
/* o: { win, pad, dc } */
function fftPower(v, dt, o) {
  const L = v.length, pad = o.pad || 1, win = FFT_WINDOWS[o.win] ? o.win : 'hann';
  let N = 2; while (N < L * pad) N <<= 1;
  const w = winCoef(win, L), re = new Float64Array(N), im = new Float64Array(N);
  let mean = 0; for (let i = 0; i < L; i++) mean += v[i]; mean /= L;
  const m = o.dc ? mean : 0; let s1 = 0, s2 = 0;
  for (let i = 0; i < L; i++) { re[i] = (v[i] - m) * w[i]; s1 += w[i]; s2 += w[i] * w[i]; }
  fftInPlace(re, im);
  const K = N / 2 + 1, p = new Float64Array(K), c = 2 / (s1 * s1);
  for (let k = 0; k < K; k++) p[k] = (re[k] * re[k] + im[k] * im[k]) * (k === 0 || k === N / 2 ? c / 2 : c);
  return { p, df: 1 / (N * dt), N, L, K, enbw: N * s2 / (s1 * s1), hw: Math.ceil(FFT_WINDOWS[win][1] * N / L) + 1, mean, win };
}
/* частота пика по параболе через три бина в логарифме */
function refineBin(p, k) {
  if (k <= 0 || k >= p.length - 1) return k;
  const a = Math.log(p[k - 1] + 1e-300), b = Math.log(p[k] + 1e-300), c = Math.log(p[k + 1] + 1e-300), d = a - 2 * b + c;
  return d < 0 ? k + clamp(0.5 * (a - c) / d, -0.5, 0.5) : k;
}
/* у Flat top вершина плоская, парабола врёт: центр масс лепестка */
function centroid(p, k, hw) { let s = 0, sk = 0; for (let i = Math.max(0, k - hw); i <= Math.min(p.length - 1, k + hw); i++) { s += p[i]; sk += p[i] * i; } return s ? sk / s : k; }
function lobePower(S, p, k) {
  let s = 0; for (let i = Math.max(0, k - S.hw); i <= Math.min(p.length - 1, k + S.hw); i++) s += p[i];
  return s / S.enbw;
}
function argMax(p, a, b) { let k = -1, m = -Infinity; for (let i = Math.max(0, a); i <= Math.min(p.length - 1, b); i++) if (p[i] > m) { m = p[i]; k = i; } return k; }

/* автоматические измерения: основная, гармоники, шум */
function specMeasure(S, p, nh, f0v, f1v) {
  const K = p.length, hw = S.hw, df = S.df, mask = new Uint8Array(K), r = { dcV: S.mean };
  for (let i = 0; i <= Math.min(K - 1, hw); i++) mask[i] = 1;
  const k0 = argMax(p, hw + 1, K - 1);
  if (k0 < 0 || !(p[k0] > 0)) return r;
  // Порог шума по медиане. Лепесток тона закрывается дальше главного, пока
  // его склон выше шума: иначе боковые лепестки окна считались бы шумом.
  const srt = Array.from(p.subarray(hw + 1)).sort((a, b) => a - b), thr = srt[srt.length >> 1] / Math.LN2 * 4, lim = Math.max(hw * 2, K >> 4);
  const mark = k => {
    for (let i = Math.max(0, k - hw); i <= Math.min(K - 1, k + hw); i++) mask[i] = 1;
    for (let i = k + hw + 1; i < K && i - k < lim && p[i] > thr; i++) mask[i] = 1;
    for (let i = k - hw - 1; i > 0 && k - i < lim && p[i] > thr; i--) mask[i] = 1;
  };
  r.f0 = (S.win === 'flat' ? centroid(p, k0, hw) : refineBin(p, k0)) * df; r.P1 = lobePower(S, p, k0); r.k0 = k0; mark(k0);
  r.harm = []; let Ph = 0;
  for (let n = 2; n <= nh; n++) {
    const fh = n * r.f0, kc = Math.round(fh / df);
    if (kc + hw >= K) break;
    const kh = argMax(p, kc - hw, kc + hw), P = lobePower(S, p, kh);
    r.harm.push({ n, f: (S.win === 'flat' ? centroid(p, kh, hw) : refineBin(p, kh)) * df, P }); Ph += P; mark(kh);
  }
  let Pn = 0, cnt = 0, all = 0, spur = 0; const free = [];
  for (let k = hw + 1; k < K; k++) { all++; if (!mask[k]) { Pn += p[k]; cnt++; free.push(p[k]); } }
  for (let k = hw + 1; k < K; k++) if (Math.abs(k - k0) > hw && p[k] > spur) spur = p[k];
  Pn = cnt ? Pn / S.enbw * all / cnt : 0;          // шум и под замаскированными бинами
  r.Ph = Ph; r.Pn = Pn;
  r.thd = Math.sqrt(Ph / r.P1); r.thdn = Math.sqrt((Ph + Pn) / r.P1);
  r.snr = 10 * Math.log10(r.P1 / (Pn || 1e-300)); r.sinad = 10 * Math.log10(r.P1 / (Pn + Ph || 1e-300)); r.enob = (r.sinad - 1.76) / 6.02;
  r.sfdr = spur > 0 ? 10 * Math.log10(p[k0] / spur) : Infinity;
  if (free.length) { free.sort((a, b) => a - b); r.nd = free[free.length >> 1] / Math.LN2 / (S.enbw * df); }   // медиана хи-квадрат → среднее, В²/Гц
  let tot = 0; for (let k = hw + 1; k < K; k++) tot += p[k]; r.rms = Math.sqrt(tot / S.enbw);
  let band = 0; for (let k = Math.max(0, Math.ceil(f0v / df)); k <= Math.min(K - 1, Math.floor(f1v / df)); k++) band += p[k]; r.band = Math.sqrt(band / S.enbw);
  let acc = 0, fa = NaN, fb = NaN;
  for (let k = hw + 1; k < K; k++) { acc += p[k]; if (isNaN(fa) && acc >= tot * 0.005) fa = k * df; if (isNaN(fb) && acc >= tot * 0.995) fb = k * df; }
  r.obw = fb - fa;
  return r;
}
/* пики: локальные максимумы выше порога, не ближе ширины лепестка */
function specPeaks(S, p, n, thrP) {
  if (!n) return [];
  const c = [];
  for (let k = S.hw + 1; k < p.length - 1; k++) if (p[k] > thrP && p[k] > p[k - 1] && p[k] >= p[k + 1]) c.push(k);
  c.sort((a, b) => p[b] - p[a]);
  const out = [];
  // боковой лепесток окна рядом с бо́льшим пиком за пик не считается
  // огибающая лепестков: наибольший у края главного, дальше спад дБ на октаву, запас 6 дБ
  const [s0, slope] = FFT_SIDE[S.win] || FFT_SIDE.hann, perBin = S.L / S.N, edge = FFT_WINDOWS[S.win][1] + 0.5;
  const leak = d => 10 ** ((s0 - slope * Math.log2(Math.max(1, d * perBin / (edge * 3))) + 6) / 10);
  let dc = 0; for (let k = 0; k <= S.hw; k++) dc = Math.max(dc, p[k]);
  const near = (q, k) => Math.abs(q.k - k) <= S.hw * 2 || p[k] < p[q.k] * leak(Math.abs(q.k - k));
  for (const k of c) {
    if (k <= S.hw * 2 || p[k] < dc * leak(k)) continue;              // склон постоянной составляющей
    if (out.some(q => near(q, k))) continue; out.push({ k, f: (S.win === 'flat' ? centroid(p, k, S.hw) : refineBin(p, k)) * S.df, P: lobePower(S, p, k) }); if (out.length >= n) break; }
  return out;
}

const FX_DEFAULT = { win: 'hann', pad: 2, dc: true, avg: 'none', avgN: 8, unit: 'dBV', ref: 20, refV: 2, div: 10, xlog: false, f0: 0, f1: 0, fill: true, maxTrace: false, snap: true, markers: [], peaksN: 5, peakThr: -70, nh: 7, meas: ['f0', 'a0', 'thd', 'snr', 'sfdr'], wf: false, wfShare: 0.5, wfPal: 'sdr', wfSpeed: 1, wfAuto: true, wfMin: -90, wfMax: 10 };
const FX_UNITS = { dBV: ['дБВ', 0], dBu: ['дБu', 2.2185], dBm: ['дБм 50 Ом', 13.0103], dBc: ['дБн', 0], V: ['В СКЗ', 0] };
const FX_MEAS = { f0: 'Основная', a0: 'Уровень основной', thd: 'THD', thdn: 'THD+N', snr: 'SNR', sinad: 'SINAD', enob: 'ENOB', sfdr: 'SFDR', harm: 'Гармоники', noise: 'Шумовая полка', rms: 'СКЗ без постоянной', band: 'СКЗ в окне', dc: 'Постоянная', obw: 'Полоса 99 %' };
const WF_PAL = {
  sdr: ['Трансивер', [[0, [4, 6, 30]], [.22, [10, 40, 150]], [.45, [0, 170, 220]], [.65, [235, 230, 40]], [.82, [250, 120, 20]], [1, [255, 40, 40]]]],
  heat: ['Температура', [[0, [20, 20, 90]], [.16, [30, 110, 235]], [.33, [20, 200, 220]], [.5, [40, 210, 80]], [.66, [240, 230, 40]], [.82, [250, 120, 20]], [.94, [235, 30, 30]], [1, [255, 245, 235]]]],
  green: ['Зелёный', [[0, [0, 8, 0]], [.6, [30, 200, 60]], [1, [230, 255, 230]]]],
  gray: ['Серый', [[0, [0, 0, 0]], [1, [255, 255, 255]]]],
};
function palLut(stops) {
  const L = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    const t = i / 255; let j = 1; while (j < stops.length - 1 && stops[j][0] < t) j++;
    const [ta, ca] = stops[j - 1], [tb, cb] = stops[j], u = clamp((t - ta) / (tb - ta || 1), 0, 1), c = ca.map((x, m) => Math.round(x + (cb[m] - x) * u));
    L[i] = (255 << 24 | c[2] << 16 | c[1] << 8 | c[0]) >>> 0;
  }
  return L;
}
const parseSI = s => {
  const m = String(s).trim().replace(',', '.').match(/^([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\s*([pnuµmkKMGкМ]?)/);
  if (!m) return NaN;
  return parseFloat(m[1]) * ({ p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6, m: 1e-3, k: 1e3, K: 1e3, 'к': 1e3, M: 1e6, 'М': 1e6, G: 1e9 }[m[2]] || 1);
};
const DB_DIV = [1, 2, 5, 10, 20];

class Spectrum {
  constructor(box, cfg, save) {
    this.o = cfg.fx = Object.assign({}, FX_DEFAULT, cfg.fx || {});
    this.o.markers = (this.o.markers || []).filter(m => Number.isFinite(m.f));
    this.box = box; this.save = save; this.S = null; this.P = null; this.mx = null; this.m = {}; this.peaks = []; this.dirty = true;
    this.hover = null; this.wfHover = null; this.wfTimes = []; this.resAt = 0; this.resKey = '';
    this.spBox = h('div', { class: 'fx-sp' }); this.wfBox = h('div', { class: 'fx-wf' }); this.res = h('div', { class: 'fx-res' });
    box.append(this.spBox, this.wfBox, this.res);
    this.p = new Plot(this.spBox); this.pw = new Plot(this.wfBox);
    this.wfc = document.createElement('canvas'); this.wg = this.wfc.getContext('2d', { willReadFrequently: true });
    this.p.onresize = () => { this.dirty = true; }; this.pw.onresize = () => { this.wfClear(); this.dirty = true; };
    this.layout(); this.events(this.spBox, false); this.events(this.wfBox, true); this.ctl = this.controls();
  }
  layout() {
    this.wfBox.hidden = !this.o.wf;
    this.box.style.flex = this.o.wf ? '3.6' : '2.2';
    this.spBox.style.flex = String(this.o.wf ? 1 - this.o.wfShare : 1); this.wfBox.style.flex = String(this.o.wfShare);
    this.dirty = true;
  }
  setO(k, v) { this.o[k] = v; this.save(); this.dirty = true; }
  resetAvg() { this.P = null; this.mx = null; this.k = 0; this.dirty = true; }
  wfClear() { this.wfc.width = Math.max(1, this.pw.w); this.wfc.height = Math.max(1, this.pw.h); this.wfTimes = []; this.wfKey = ''; }

  /* ---- данные ---- */
  update(v, dt) {
    if (!v || v.length < 16 || !(dt > 0)) return;
    const o = this.o, S = fftPower(v, dt, o), key = `${S.N}|${S.df}|${o.win}|${o.pad}|${o.dc}|${o.avg}`;
    if (key !== this.key) { this.key = key; this.resetAvg(); }
    const p = S.p, N = Math.max(1, o.avgN | 0);
    if (!this.P || o.avg === 'none') { this.P = p.slice(); this.k = 1; }
    else {
      const A = this.P; this.k++;
      if (o.avg === 'rms') { const w = 1 / Math.min(this.k, N); for (let i = 0; i < A.length; i++) A[i] += (p[i] - A[i]) * w; }
      else if (o.avg === 'exp') { const w = 2 / (N + 1); for (let i = 0; i < A.length; i++) A[i] += (p[i] - A[i]) * w; }
      else if (o.avg === 'max') { for (let i = 0; i < A.length; i++) if (p[i] > A[i]) A[i] = p[i]; }
      else if (o.avg === 'min') { for (let i = 0; i < A.length; i++) if (p[i] < A[i]) A[i] = p[i]; }
    }
    if (o.maxTrace) { if (!this.mx || this.mx.length !== p.length) this.mx = p.slice(); else for (let i = 0; i < p.length; i++) if (p[i] > this.mx[i]) this.mx[i] = p[i]; }
    this.S = S;
    const [f0, f1] = this.range();
    this.m = specMeasure(S, this.P, o.nh, f0, f1);
    this.peaks = specPeaks(S, this.P, o.peaksN, this.toP(o.peakThr));
    for (const mk of o.markers) if (mk.track) mk.f = this.snapF(mk.f, S.hw * 3);
    this.wfPush();
    this.dirty = true;
  }
  fmax() { return this.S ? this.S.df * this.S.N / 2 : 1; }
  range() {
    const fm = this.fmax(), o = this.o; let a = clamp(o.f0 || 0, 0, fm), b = o.f1 > 0 ? Math.min(o.f1, fm) : fm;
    if (o.xlog) a = Math.max(a, this.S ? this.S.df : 1);
    if (!(b > a)) { a = o.xlog ? (this.S?.df || 1) : 0; b = fm; }
    return [a, b];
  }
  /* уровни */
  off() { const u = this.o.unit; return u === 'dBc' ? -(this.m.P1 ? 10 * Math.log10(this.m.P1) : 0) : FX_UNITS[u][1]; }
  lv(P) { return this.o.unit === 'V' ? Math.sqrt(P) : 10 * Math.log10(P + 1e-30) + this.off(); }
  toP(L) { return this.o.unit === 'V' ? L * L : 10 ** ((L - this.off()) / 10); }
  uname() { return FX_UNITS[this.o.unit][0]; }
  fmtP(P, d = 2) { return this.o.unit === 'V' ? fmtSI(Math.sqrt(P), 'V', 4) : `${this.lv(P).toFixed(d)} ${this.uname()}`; }
  yOf(L, H) { const o = this.o; return o.unit === 'V' ? (1 - L / o.refV) * H : (o.ref - L) / (o.div * 10) * H; }
  /* частота ↔ пиксель области графика шириной w */
  xOf(f, w) { const [a, b] = this.range(); return this.o.xlog ? Math.log(f / a) / Math.log(b / a) * w : (f - a) / (b - a) * w; }
  fOf(x, w) { const [a, b] = this.range(); return this.o.xlog ? a * (b / a) ** (x / w) : a + (b - a) * x / w; }
  /* мощность на каждый пиксель: максимум бинов столбца, между редкими бинами линейно */
  cols(P, w) {
    const out = new Float64Array(w), df = this.S.df, K = P.length;
    for (let x = 0; x < w; x++) {
      const ka = this.fOf(x, w) / df, kb = this.fOf(x + 1, w) / df;
      if (kb - ka >= 1) { let m = 0; for (let k = Math.max(0, Math.floor(ka)); k <= Math.min(K - 1, Math.ceil(kb)); k++) if (P[k] > m) m = P[k]; out[x] = m; }
      else { const kc = (ka + kb) / 2, i = clamp(Math.floor(kc), 0, K - 2), u = clamp(kc - i, 0, 1); out[x] = P[i] + (P[i + 1] - P[i]) * u; }
    }
    return out;
  }
  snapF(f, rad) {
    if (!this.S) return f;
    const k = Math.round(f / this.S.df), j = argMax(this.P, k - Math.max(1, rad | 0), k + Math.max(1, rad | 0));
    return j < 0 ? f : refineBin(this.P, j) * this.S.df;
  }
  levelAt(f) { if (!this.S) return NaN; const k = clamp(Math.round(f / this.S.df), 0, this.P.length - 1); return this.P[k]; }

  /* ---- маркеры ---- */
  addMarker(f) {
    const o = this.o; if (o.markers.length >= 8) { toast('Не больше 8 маркеров'); return; }
    o.markers.push({ f: o.snap ? this.snapF(f, this.pxBins(8)) : f, delta: false, track: false }); this.save(); this.dirty = true; this.resKey = '';
  }
  pxBins(px) { if (!this.S) return 1; const [a, b] = this.range(), w = Math.max(10, this.p.w - 54); return Math.max(1, (b - a) / w * px / this.S.df); }
  toPeak(i) { const mk = this.o.markers[i]; if (!mk || !this.peaks.length) return; mk.f = this.peaks[0].f; this.save(); this.dirty = true; }
  nextPeak(i) {
    const mk = this.o.markers[i]; if (!mk) return;
    const cur = this.levelAt(mk.f), q = this.peaks.find(pk => this.P[pk.k] < cur * 0.999 && Math.abs(pk.f - mk.f) > this.S.df * this.S.hw);
    if (q) { mk.f = q.f; this.save(); this.dirty = true; } else toast('Ниже пиков нет: увеличьте число пиков или снизьте порог');
  }
  autoset() {
    if (!this.S || !this.m.f0) { toast('Нет сигнала для настройки'); return; }
    const o = this.o, top = this.lv(this.P[this.m.k0]);
    if (o.unit === 'V') o.refV = niceUp(top * 1.25); else o.ref = Math.ceil((top + 5) / 10) * 10;
    o.f0 = 0; o.f1 = Math.min(this.fmax(), this.m.f0 * (o.nh + 1.5)); o.xlog = false;
    if (!o.markers.length) o.markers.push({ f: this.m.f0, delta: false, track: true }); else { o.markers[0].f = this.m.f0; o.markers[0].track = true; }
    this.save(); this.wfClear(); this.resKey = ''; this.syncCtl(); this.dirty = true;
  }

  /* ---- водопад ---- */
  wfRange() {
    const o = this.o;
    if (!o.wfAuto) return [o.wfMin, o.wfMax];
    if (o.unit === 'V') { const t = 20 * Math.log10(o.refV); return [t - 80, t]; }
    const off = this.off(); return [o.ref - o.div * 10 - off, o.ref - off];    // в дБВ
  }
  wfPush() {
    if (!this.o.wf || !this.S || this.wfBox.hidden) return;
    const W = Math.max(1, this.pw.w), H = Math.max(1, this.pw.h), L = 48, w = Math.max(10, W - L - 6), [a, b] = this.range();
    const key = `${W}|${H}|${a}|${b}|${this.o.xlog}`;
    if (this.wfc.width !== W || this.wfc.height !== H || key !== this.wfKey) { this.wfClear(); this.wfKey = key; }
    const rows = this.o.wfSpeed | 0 || 1, g = this.wg;
    if (H > rows) g.putImageData(g.getImageData(0, 0, W, H - rows), 0, rows);    const img = g.createImageData(W, rows), px = new Uint32Array(img.data.buffer), lut = this.lut || (this.lut = palLut((WF_PAL[this.o.wfPal] || WF_PAL.sdr)[1]));
    const [lo, hi] = this.wfRange(), c = this.cols(this.P, w), bg = lut[0];
    for (let x = 0; x < W; x++) {
      const xi = x - L; let u = bg;
      if (xi >= 0 && xi < w) u = lut[clamp(((10 * Math.log10(c[xi] + 1e-30) - lo) / (hi - lo) * 255) | 0, 0, 255)];
      for (let r = 0; r < rows; r++) px[r * W + x] = u;
    }
    g.putImageData(img, 0, 0);
    const now = performance.now(); for (let r = 0; r < rows; r++) this.wfTimes.unshift(now);
    if (this.wfTimes.length > H) this.wfTimes.length = H;
  }

  /* ---- рисование ---- */
  tick() { if (this.dirty) { this.dirty = false; this.draw(); if (this.o.wf) this.drawWf(); } const t = performance.now(); if (t - this.resAt > 250) { this.resAt = t; this.drawRes(); } }
  axesX(g, w, x0, y, col) {
    const [a, b] = this.range(); g.fillStyle = col.ink3; g.textAlign = 'center'; g.font = FONT(10);
    let ticks;
    if (this.o.xlog) { ticks = []; for (let d = 10 ** Math.floor(Math.log10(a)); d <= b; d *= 10) for (const m of [1, 2, 5]) { const f = d * m; if (f >= a && f <= b) ticks.push(f); } }
    else ticks = niceTicks(a, b, Math.max(3, w / 95 | 0));
    return ticks.map(f => { const x = x0 + this.xOf(f, w); if (y != null) g.fillText(fmtSI(f, 'Hz', 3), x, y); return x; });
  }
  draw() {
    const p = this.p, g = p.g, W = p.w, H = p.h, col = Theme.colors, o = this.o, L = 48, B = 16, T = 4, w = Math.max(10, W - L - 6), hh = Math.max(10, H - B - T);
    g.fillStyle = col.screen; g.fillRect(0, 0, W, H);
    // сетка
    g.strokeStyle = col.grid; g.lineWidth = 1; g.beginPath();
    for (const x of this.axesX(g, w, L, H - 4, col)) { g.moveTo(Math.round(x) + .5, T); g.lineTo(Math.round(x) + .5, T + hh); }
    g.textAlign = 'right'; g.fillStyle = col.ink3;
    for (let i = 0; i <= 10; i++) {
      const y = Math.round(T + i * hh / 10) + .5; g.moveTo(L, y); g.lineTo(L + w, y);
      if (i % (hh < 140 ? 2 : 1) === 0) { const v = o.unit === 'V' ? o.refV * (1 - i / 10) : o.ref - i * o.div; g.fillText(o.unit === 'V' ? fmtSI(v, '', 3) : v.toFixed(o.div < 2 ? 1 : 0), L - 4, y + 3); }
    }
    g.stroke();
    if (!this.S) { g.textAlign = 'center'; g.fillStyle = col.ink3; g.fillText('Ждём осциллограмму…', L + w / 2, T + hh / 2); return; }
    g.save(); g.beginPath(); g.rect(L, T, w, hh); g.clip();
    const Y = P => T + this.yOf(this.lv(P), hh);
    const trace = (P, color, lw, fill) => {
      const c = this.cols(P, w); g.beginPath();
      for (let x = 0; x < w; x++) { const y = Y(c[x]); if (x) g.lineTo(L + x + .5, y); else g.moveTo(L + .5, y); }
      if (fill) { g.save(); g.lineTo(L + w, T + hh); g.lineTo(L, T + hh); g.closePath(); g.globalAlpha = .16; g.fillStyle = color; g.fill(); g.restore(); g.beginPath(); for (let x = 0; x < w; x++) { const y = Y(c[x]); if (x) g.lineTo(L + x + .5, y); else g.moveTo(L + .5, y); } }
      g.strokeStyle = color; g.lineWidth = lw; g.lineJoin = 'round'; g.stroke();
    };
    if (o.maxTrace && this.mx) trace(this.mx, col.t[2], 1, false);
    trace(this.P, col.t[1], 1.4, o.fill);
    // пики
    g.font = FONT(10, 600); g.textAlign = 'center';
    this.peaks.forEach((pk, i) => {
      const x = L + this.xOf(pk.f, w), y = Y(this.P[pk.k]); if (x < L || x > L + w) return;
      g.fillStyle = col.ink2; g.beginPath(); g.moveTo(x, y - 3); g.lineTo(x - 4, y - 10); g.lineTo(x + 4, y - 10); g.fill(); g.fillText(String(i + 1), x, y - 13);
    });
    // маркеры
    o.markers.forEach((mk, i) => {
      const x = L + this.xOf(mk.f, w); if (x < L - 1 || x > L + w + 1) return;
      const y = Y(this.levelAt(mk.f));
      g.strokeStyle = col.accent; g.globalAlpha = .4; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(x + .5, T); g.lineTo(x + .5, T + hh); g.stroke(); g.setLineDash([]); g.globalAlpha = 1;
      g.fillStyle = col.accent; g.beginPath(); g.moveTo(x, y - 6); g.lineTo(x + 6, y); g.lineTo(x, y + 6); g.lineTo(x - 6, y); g.closePath(); g.fill();
      g.fillStyle = col.ink; g.textAlign = 'left'; g.fillText(`M${i + 1}${mk.delta ? 'Δ' : ''}`, x + 8, Math.max(T + 10, y - 6));
    });
    // наведение
    if (this.hover && this.hover.x >= L && this.hover.x <= L + w) {
      const x = this.hover.x, f = this.fOf(x - L, w), P = this.levelAt(f);
      g.strokeStyle = col.ink3; g.globalAlpha = .6; g.beginPath(); g.moveTo(x + .5, T); g.lineTo(x + .5, T + hh); g.stroke(); g.globalAlpha = 1;
      const t = `${fmtSI(f, 'Hz', 5)}  ${this.fmtP(P)}`; g.font = FONT(10, 600); const tw = g.measureText(t).width + 10, bx = x + tw + 12 > L + w ? x - tw - 6 : x + 6;
      g.fillStyle = col.raised; g.fillRect(bx, T + 4, tw, 16); g.fillStyle = col.ink; g.textAlign = 'left'; g.fillText(t, bx + 5, T + 15);
    }
    g.restore();
    // подпись
    const S = this.S, rbw = S.enbw * S.df, avg = o.avg === 'none' ? '' : ` · ${{ rms: 'ср.', exp: 'эксп.', max: 'макс.', min: 'мин.' }[o.avg]} ${o.avg === 'rms' ? Math.min(this.k, o.avgN) + '/' + o.avgN : this.k}`;
    g.font = FONT(10); g.textAlign = 'right'; g.fillStyle = col.ink2;
    g.fillText(`${FFT_WINDOWS[S.win][0]} · ${S.L} → ${S.N} точек · RBW ${fmtSI(rbw, 'Hz', 3)}${avg} · ${this.uname()}`, L + w - 4, T + 12);
  }
  drawWf() {
    const p = this.pw, g = p.g, W = p.w, H = p.h, col = Theme.colors, L = 48, w = Math.max(10, W - L - 6);
    g.fillStyle = col.screen; g.fillRect(0, 0, W, H);
    g.imageSmoothingEnabled = false; g.drawImage(this.wfc, 0, 0, W, H); g.imageSmoothingEnabled = true;
    g.fillStyle = col.screen; g.fillRect(0, 0, L, H);
    g.font = FONT(10); g.textAlign = 'right'; g.fillStyle = col.ink3;
    const now = this.wfTimes[0];
    for (let y = 12; y < H; y += 36) { const t = this.wfTimes[y]; if (t != null) g.fillText(`−${((now - t) / 1000).toFixed(1)} с`, L - 4, y + 3); }
    g.strokeStyle = col.grid; g.globalAlpha = .5; g.beginPath();
    for (const x of this.axesX(g, w, L, null, col)) { g.moveTo(Math.round(x) + .5, 0); g.lineTo(Math.round(x) + .5, H); }
    g.stroke(); g.globalAlpha = 1;
    this.o.markers.forEach((mk, i) => { const x = L + this.xOf(mk.f, w); if (x < L || x > L + w) return; g.strokeStyle = col.accent; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(x + .5, 0); g.lineTo(x + .5, H); g.stroke(); g.setLineDash([]); g.fillStyle = col.accent; g.textAlign = 'left'; g.fillText(`M${i + 1}`, x + 3, 10); });
    // шкала палитры
    const [lo, hi] = this.wfRange(), lut = this.lut || (this.lut = palLut((WF_PAL[this.o.wfPal] || WF_PAL.sdr)[1])), bw = 80, bx = L + w - bw - 4;
    for (let i = 0; i < bw; i++) { const u = lut[i / (bw - 1) * 255 | 0]; g.fillStyle = `rgb(${u & 255},${u >> 8 & 255},${u >> 16 & 255})`; g.fillRect(bx + i, H - 12, 1, 6); }
    g.fillStyle = col.ink2; g.textAlign = 'right'; g.fillText(`${lo.toFixed(0)} дБВ`, bx - 4, H - 5); g.textAlign = 'left'; g.fillText(`${hi.toFixed(0)}`, bx + bw + 2, H - 5);
    if (this.wfHover && this.wfHover.x >= L && this.wfHover.x <= L + w) {
      const { x, y } = this.wfHover, f = this.fOf(x - L, w), t = this.wfTimes[Math.floor(y)], s = `${fmtSI(f, 'Hz', 5)}${t != null ? ` · −${((now - t) / 1000).toFixed(2)} с` : ''}`;
      g.strokeStyle = col.ink; g.globalAlpha = .5; g.beginPath(); g.moveTo(x + .5, 0); g.lineTo(x + .5, H); g.stroke(); g.globalAlpha = 1;
      g.font = FONT(10, 600); const tw = g.measureText(s).width + 10, bx2 = x + tw + 12 > L + w ? x - tw - 6 : x + 6;
      g.fillStyle = col.raised; g.fillRect(bx2, y - 8, tw, 16); g.fillStyle = col.ink; g.textAlign = 'left'; g.fillText(s, bx2 + 5, y + 3);
    }
  }

  /* ---- строка результатов: маркеры, пики, измерения ---- */
  measText(k) {
    const m = this.m, pct = x => `${(x * 100).toPrecision(3)} % (${(20 * Math.log10(x)).toFixed(1)} дБ)`;
    if (k === 'dc') return fmtSI(m.dcV, 'V', 4);
    if (!m.P1) return '—';
    switch (k) {
      case 'f0': return fmtSI(m.f0, 'Hz', 6);
      case 'a0': return `${this.o.unit === 'V' || this.o.unit === 'dBc' ? (10 * Math.log10(m.P1)).toFixed(2) + ' дБВ' : this.fmtP(m.P1)} · ${fmtSI(Math.sqrt(m.P1), 'V', 4)}`;
      case 'thd': return m.harm.length ? pct(m.thd) : 'нет гармоник ниже fs/2';
      case 'thdn': return pct(m.thdn);
      case 'snr': return `${m.snr.toFixed(1)} дБ`;
      case 'sinad': return `${m.sinad.toFixed(1)} дБ`;
      case 'enob': return `${m.enob.toFixed(2)} бит`;
      case 'sfdr': return Number.isFinite(m.sfdr) ? `${m.sfdr.toFixed(1)} дБ` : '—';
      case 'harm': return m.harm.length ? m.harm.map(x => `H${x.n} ${(10 * Math.log10(x.P / m.P1)).toFixed(1)}`).join(' · ') + ' дБн' : '—';
      case 'noise': return m.nd ? `${(10 * Math.log10(m.nd)).toFixed(1)} дБВ/√Гц · ${fmtSI(Math.sqrt(m.nd), 'V', 3)}/√Гц` : '—';
      case 'rms': return fmtSI(m.rms, 'V', 4);
      case 'band': return fmtSI(m.band, 'V', 4);
      case 'obw': return fmtSI(m.obw, 'Hz', 4);
    }
    return '';
  }
  drawRes() {
    const o = this.o, key = `${o.markers.length}|${o.markers.map(m => m.delta + '' + m.track).join()}|${o.meas.join()}|${o.peaksN}`;
    if (key !== this.resKey) {
      this.resKey = key; this.res.replaceChildren(); this.cells = { mk: [], pk: [], ms: {} };
      o.markers.forEach((mk, i) => {
        const v = h('b'), btn = (t, title, f, on) => h('button', { class: 'wbtn' + (on ? ' on' : ''), title, 'aria-label': title, onclick: () => { f(); this.save(); this.resKey = ''; this.dirty = true; } }, t);
        this.res.append(h('span', { class: 'mchip mk' }, `M${i + 1}`, v,
          btn('▲', 'На самый высокий пик', () => this.toPeak(i)), btn('↓', 'На следующий пик ниже', () => this.nextPeak(i)),
          btn('⌖', 'Следить за пиком', () => { mk.track = !mk.track; }, mk.track),
          i ? btn('Δ', 'Разность с M1', () => { mk.delta = !mk.delta; }, mk.delta) : null,
          btn('×', 'Убрать маркер', () => { o.markers.splice(i, 1); })));
        this.cells.mk.push(v);
      });
      for (const k of o.meas) {
        const v = h('b'); this.cells.ms[k] = v;
        this.res.append(h('span', { class: 'mchip' }, FX_MEAS[k], ' ', v, h('button', { class: 'wbtn', 'aria-label': 'Убрать измерение', onclick: () => { o.meas = o.meas.filter(x => x !== k); this.save(); this.resKey = ''; } }, '×')));
      }
      if (o.peaksN) { this.cells.pk = h('span', { class: 'mchip pk' }); this.res.append(this.cells.pk); }
    }
    if (!this.S) return;
    o.markers.forEach((mk, i) => {
      const P = this.levelAt(mk.f), m1 = o.markers[0], c = this.cells.mk[i]; if (!c) return;
      if (mk.delta && i && m1) {
        const P1 = this.levelAt(m1.f), d = o.unit === 'V' ? fmtSI(Math.sqrt(P) - Math.sqrt(P1), 'V', 4) : `${(10 * Math.log10(P / P1)).toFixed(2)} дБ`;
        c.textContent = `Δf ${fmtSI(mk.f - m1.f, 'Hz', 5)} ${d}`;
      } else c.textContent = `${fmtSI(mk.f, 'Hz', 6)} ${this.fmtP(P)}`;
    });
    for (const k in this.cells.ms) this.cells.ms[k].textContent = this.measText(k);
    if (this.cells.pk?.nodeType) this.cells.pk.textContent = this.peaks.length ? 'Пики: ' + this.peaks.map((q, i) => `${i + 1}) ${fmtSI(q.f, 'Hz', 5)} ${this.fmtP(q.P, 1)}`).join('  ') : 'Пиков выше порога нет';
  }

  /* ---- мышь ---- */
  events(box, wf) {
    const L = 48, plotW = () => Math.max(10, (wf ? this.pw : this.p).w - L - 6), pos = e => { const r = box.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    let drag = null;
    const nearMk = x => this.o.markers.findIndex(mk => Math.abs(L + this.xOf(mk.f, plotW()) - x) < 7);
    box.addEventListener('pointerdown', e => {
      if (!this.S || e.button) return;
      const { x } = pos(e), i = nearMk(x), [a, b] = this.range();
      drag = i >= 0 ? { mk: i } : { x, a, b }; box.setPointerCapture(e.pointerId);
    });
    box.addEventListener('pointermove', e => {
      const { x, y } = pos(e);
      if (wf) this.wfHover = { x, y }; else this.hover = { x, y };
      if (drag && this.S) {
        const w = plotW();
        if (drag.mk != null) { const mk = this.o.markers[drag.mk], f = clamp(this.fOf(x - L, w), 0, this.fmax()); mk.f = this.o.snap ? this.snapF(f, this.pxBins(6)) : f; mk.track = false; }
        else if (Math.abs(x - drag.x) > 2) {
          const fm = this.fmax();
          if (this.o.xlog) { const r = (drag.b / drag.a) ** (-(x - drag.x) / w); let a = drag.a * r, b = drag.b * r; if (a < this.S.df) { b *= this.S.df / a; a = this.S.df; } if (b > fm) { a *= fm / b; b = fm; } this.o.f0 = a; this.o.f1 = b; }
          else { const d = -(x - drag.x) / w * (drag.b - drag.a); let a = drag.a + d, b = drag.b + d; if (a < 0) { b -= a; a = 0; } if (b > fm) { a -= b - fm; b = fm; } this.o.f0 = Math.max(0, a); this.o.f1 = b; }
          this.syncCtl();
        }
      }
      this.dirty = true;
    });
    box.addEventListener('pointerup', () => { if (drag) { drag = null; this.save(); this.resKey = ''; } });
    box.addEventListener('pointerleave', () => { this.hover = null; this.wfHover = null; this.dirty = true; });
    box.addEventListener('dblclick', e => { if (!this.S) return; const { x } = pos(e); if (x >= L) this.addMarker(this.fOf(x - L, plotW())); });
    box.addEventListener('contextmenu', e => { const i = nearMk(pos(e).x); if (i >= 0) { e.preventDefault(); this.o.markers.splice(i, 1); this.save(); this.resKey = ''; this.dirty = true; } });
    box.addEventListener('wheel', e => {
      e.preventDefault(); if (!this.S) return;
      const dir = e.deltaY > 0 ? 1 : -1, o = this.o;
      if (e.shiftKey) { if (o.unit === 'V') o.refV = niceUp(o.refV * (dir > 0 ? 1.25 : 0.8)); else o.ref += -dir * o.div; }
      else if (e.ctrlKey) { const i = DB_DIV.indexOf(o.div); o.div = DB_DIV[clamp((i < 0 ? 3 : i) + dir, 0, DB_DIV.length - 1)]; }
      else {
        const { x } = pos(e), w = plotW(), u = clamp((x - L) / w, 0, 1), [a, b] = this.range(), fm = this.fmax(), k = dir > 0 ? 1.25 : 0.8;
        if (o.xlog) { const c = Math.log(a) + Math.log(b / a) * u, s = Math.log(b / a) * k; let na = Math.exp(c - s * u), nb = Math.exp(c + s * (1 - u)); na = Math.max(na, this.S.df); nb = Math.min(nb, fm); if (nb / na > 1.05) { o.f0 = na; o.f1 = nb; } }
        else { const c = a + (b - a) * u, s = Math.max((b - a) * k, this.S.df * 8); let na = c - s * u, nb = c + s * (1 - u); if (na < 0) { nb -= na; na = 0; } if (nb > fm) { na = Math.max(0, na - (nb - fm)); nb = fm; } o.f0 = na; o.f1 = nb; }
      }
      this.save(); this.syncCtl(); this.dirty = true;
    }, { passive: false });
  }

  /* ---- настройки ---- */
  controls() {
    const o = this.o, set = (k, after) => v => { o[k] = v; this.save(); after?.(); this.dirty = true; };
    const num = (label, get, put, title) => { const i = h('input', { type: 'text', inputmode: 'decimal', 'aria-label': label, title, onchange: () => { const v = parseSI(i.value); if (Number.isFinite(v)) put(v); else i.value = get(); this.save(); this.syncCtl(); this.dirty = true; } }); i.get = get; return i; };
    const u = {};
    u.win = select(Object.entries(FFT_WINDOWS).map(([k, v]) => [k, v[0]]), o.win, set('win'), 'Окно');
    u.pad = seg([[1, 'Нет'], [2, '×2'], [4, '×4'], [8, '×8']], o.pad, v => set('pad')(+v), 'Дополнение нулями');
    u.dc = toggle('Без постоянной', o.dc, set('dc'));
    u.avg = select([['none', 'Нет'], ['rms', 'Среднее по N'], ['exp', 'Экспоненциальное'], ['max', 'Удержание максимума'], ['min', 'Удержание минимума']], o.avg, set('avg', () => this.resetAvg()), 'Усреднение');
    u.avgN = num('Число кадров усреднения', () => o.avgN, v => { o.avgN = clamp(Math.round(v), 2, 1024); });
    u.unit = select(Object.entries(FX_UNITS).map(([k, v]) => [k, v[0]]), o.unit, set('unit', () => this.syncCtl()), 'Единицы');
    u.ref = num('Опорный уровень', () => o.unit === 'V' ? +o.refV.toPrecision(4) : o.ref, v => { if (o.unit === 'V') o.refV = Math.max(1e-6, v); else o.ref = v; }, 'Верх шкалы');
    u.div = select(DB_DIV.map(d => [d, `${d} дБ/дел`]), o.div, v => set('div')(+v), 'Масштаб');
    u.xlog = seg([[false, 'Лин.'], [true, 'Лог.']], o.xlog, v => { o.xlog = v === true || v === 'true'; this.save(); this.dirty = true; }, 'Ось частот');
    u.f0 = num('Начало, Гц', () => +this.range()[0].toPrecision(6), v => { o.f0 = Math.max(0, v); });
    u.f1 = num('Конец, Гц', () => +this.range()[1].toPrecision(6), v => { o.f1 = v; });
    u.fill = toggle('Заливка', o.fill, set('fill'));
    u.maxT = toggle('След максимума', o.maxTrace, set('maxTrace', () => { this.mx = null; }));
    u.snap = toggle('Привязка к пикам', o.snap, set('snap'));
    u.pkN = select([0, 1, 2, 3, 4, 5, 6, 8, 10].map(n => [n, n ? String(n) : 'Нет']), o.peaksN, v => { o.peaksN = +v; this.save(); this.resKey = ''; }, 'Число пиков');
    u.pkThr = num('Порог пиков', () => o.peakThr, v => { o.peakThr = v; }, 'В единицах шкалы');
    u.nh = select([3, 5, 7, 9, 11, 15, 20].map(n => [n, `до H${n}`]), o.nh, v => set('nh')(+v), 'Гармоник в THD');
    u.addM = select([['', 'Добавить измерение…'], ...Object.entries(FX_MEAS).map(([k, v]) => [k, v])], '', v => { if (v && !o.meas.includes(v)) { o.meas.push(v); this.save(); this.resKey = ''; } u.addM.value = ''; }, 'Добавить измерение');
    u.wf = toggle('Водопад', o.wf, v => { o.wf = v; this.save(); this.layout(); this.wfClear(); u.wfBox.hidden = !v; });
    u.wfPal = select(Object.entries(WF_PAL).map(([k, v]) => [k, v[0]]), o.wfPal, v => { o.wfPal = v; this.lut = null; this.save(); this.dirty = true; }, 'Палитра');
    u.wfSpeed = seg([[1, '1'], [2, '2'], [4, '4']], o.wfSpeed, v => set('wfSpeed')(+v), 'Строк на кадр');
    u.wfShare = seg([[0.3, 'Мало'], [0.5, 'Поровну'], [0.7, 'Много']], o.wfShare, v => { o.wfShare = +v; this.save(); this.layout(); }, 'Высота водопада');
    u.wfAuto = toggle('Диапазон как у спектра', o.wfAuto, v => { o.wfAuto = v; this.save(); u.wfMan.hidden = v; this.dirty = true; });
    u.wfMin = num('Низ водопада, дБВ', () => o.wfMin, v => { o.wfMin = v; });
    u.wfMax = num('Верх водопада, дБВ', () => o.wfMax, v => { o.wfMax = v; });
    u.wfMan = h('div', { class: 'col', hidden: o.wfAuto }, field('Низ, дБВ', u.wfMin), field('Верх, дБВ', u.wfMax));
    u.wfBox = h('div', { class: 'col', hidden: !o.wf }, field('Палитра', u.wfPal), field('Скорость, строк на кадр', u.wfSpeed), field('Высота', u.wfShare), u.wfAuto, u.wfMan,
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => { this.wfClear(); this.dirty = true; } }, 'Очистить водопад')));
    const btn = (t, f, title) => h('button', { class: 'btn', title, onclick: f }, t);
    this.u = u;
    const el = h('div', { class: 'col fx-ctl' },
      h('h4', { text: 'Спектр' }),
      h('div', { class: 'row' }, btn('Авто', () => this.autoset(), 'Шкала по сигналу, окно до последней гармоники, M1 на основной'), btn('Сброс', () => this.resetAvg(), 'Сбросить усреднение и след максимума')),
      h('div', { class: 'row' }, btn('CSV', () => this.saveCsv()), btn('Снимок', () => this.p.c.toBlob(b => saveFile(`dm40-spectrum-${stamp()}.png`, b)))),
      field('Окно', u.win), field('Дополнение нулями', u.pad), u.dc, field('Усреднение', u.avg), field('Кадров N', u.avgN),
      h('h4', { text: 'Шкалы спектра' }), field('Единицы', u.unit), field('Опорный уровень (верх)', u.ref), field('Масштаб', u.div),
      field('Ось частот', u.xlog), field('Начало', u.f0), field('Конец', u.f1),
      h('div', { class: 'row' }, btn('Весь диапазон', () => { o.f0 = 0; o.f1 = 0; this.save(); this.syncCtl(); this.dirty = true; })),
      h('div', { class: 'row wrap' }, u.fill, u.maxT),
      h('h4', { text: 'Маркеры и пики' }),
      h('div', { class: 'row' }, btn('+ Маркер', () => { if (this.S) this.addMarker(this.peaks[0]?.f ?? this.range()[0]); }, 'Новый маркер на самом высоком пике. Двойной щелчок по спектру тоже ставит маркер'), btn('Убрать все', () => { o.markers = []; this.save(); this.resKey = ''; this.dirty = true; })),
      u.snap, field('Число пиков', u.pkN), field('Порог пиков', u.pkThr),
      h('h4', { text: 'Измерения' }), field('Гармоники', u.nh), u.addM,
      h('h4', { text: 'Водопад' }), u.wf, u.wfBox,
      h('p', { class: 'note', text: 'Колесо мыши: масштаб частот. Shift + колесо: опорный уровень. Ctrl + колесо: дБ на деление. Перетаскивание: сдвиг. Двойной щелчок: маркер, правый щелчок по маркеру: убрать.' }));
    this.syncCtl();
    return el;
  }
  syncCtl() {
    const u = this.u; if (!u) return;
    for (const k of ['avgN', 'ref', 'f0', 'f1', 'pkThr', 'wfMin', 'wfMax']) if (document.activeElement !== u[k]) u[k].value = u[k].get();
    u.div.value = this.o.div; u.unit.value = this.o.unit; u.xlog.set?.(this.o.xlog);
  }
  saveCsv() {
    if (!this.S) return;
    const r = [`Частота, Гц;Уровень, ${this.uname()}`];
    for (let k = 0; k < this.P.length; k++) r.push(`${(k * this.S.df).toPrecision(8)};${this.lv(this.P[k]).toPrecision(6)}`);
    saveFile(`dm40-spectrum-${stamp()}.csv`, r.join('\n'), 'text/csv');
  }
  dispose() { this.p.dispose(); this.pw.dispose(); }
}
function niceUp(v) { const m = 10 ** Math.floor(Math.log10(v || 1)); return [1, 2, 2.5, 5, 10].find(x => x * m >= v) * m; }
