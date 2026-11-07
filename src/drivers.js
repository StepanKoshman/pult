'use strict';
/* Драйверы приборов: SCPI -> состояние + величины на шине Hub. */

class Device extends Emitter {
  constructor(link, idn) {
    super(); this.link = link; this.idn = idn; this.alive = false; this.s = {}; this.custom = [];
    this.demo = link.tr.kind === 'sim';
    const f = idn.split(','); this.maker = f[0] || ''; this.model = f[1] || ''; this.serial = f[2] || ''; this.fw = f[3] || '';
    this.state = 'ok'; this.lastErr = '';
    link.on('lost', e => this.lost(e));
  }
  get transport() { return this.link.tr.name; }
  get viaUsb() { return this.link.tr.kind === 'usb' || this.demo; }
  q(cmd, o) { return this.link.query(cmd, o); }
  w(cmd) { return this.link.write(cmd); }
  async n(cmd, o) { return parseFloat(await this.q(cmd, o)); }
  fail(e) {
    this.lastErr = e.message || String(e);
    this.state = 'warn'; this.emit('state');
  }
  lost(e) { if (!this.alive) return; toast(`${this.title}: связь потеряна. ${e?.message || ''}`, 'bad'); Devices.remove(this); }
  async stop() { this.alive = false; try { await this.link.tr.close(); } catch { } Hub.removeDev(this.id); }
  async pollCustom(now) {
    for (const c of this.custom) {
      if (now - (c.at || 0) < c.period) continue;
      c.at = now;
      const v = parseFloat(await this.q(c.query)) * (c.scale ?? 1);
      Hub.push(c.id, v);
    }
  }
  addCustom(c) { c.id = `${this.id}.x${Date.now().toString(36)}`; this.custom.push(c); Hub.define({ id: c.id, name: c.name, unit: c.unit, dev: this.id, group: 'Свои', custom: true }); store.set('custom.' + this.id, this.custom.map(({ at, id, ...x }) => x)); }
  dropCustom(id) { this.custom = this.custom.filter(c => c.id !== id); Hub.remove(id); store.set('custom.' + this.id, this.custom.map(({ at, id, ...x }) => x)); }
  restoreCustom() { for (const c of store.get('custom.' + this.id, [])) { c.id = `${this.id}.x${Math.random().toString(36).slice(2, 8)}`; this.custom.push(c); Hub.define({ id: c.id, name: c.name, unit: c.unit, dev: this.id, group: 'Свои', custom: true }); } }
}

/* ---------- DM40 ---------- */
const V_R = [.06, .6, 6, 60, 600, 1000], A_R = [.0006, .006, .06, .6, 6, 10];
const DM_FUNCS = [
  { id: 'VOLT', hdr: 'VOLT', conf: 'CONF:VOLT:DC', label: 'V ⎓', name: 'Постоянное напряжение', unit: 'V', r: V_R },
  { id: 'VOLT:AC', hdr: 'VOLT:AC', conf: 'CONF:VOLT:AC', label: 'V ∿', name: 'Переменное напряжение', unit: 'V', r: V_R },
  { id: 'VOLT:ACDC', hdr: 'VOLT:ACDC', conf: 'CONF:VOLT:ACDC', label: 'V ∿+⎓', name: 'Напряжение AC+DC', unit: 'V', r: V_R },
  { id: 'VOLT:AUTO', hdr: 'VOLT:AUTO', conf: 'CONF:VOLT:AUTO', label: 'V авто', name: 'Напряжение, род тока сам', unit: 'V', r: V_R },
  { id: 'CURR', hdr: 'CURR', conf: 'CONF:CURR:DC', label: 'A ⎓', name: 'Постоянный ток', unit: 'A', r: A_R },
  { id: 'CURR:AC', hdr: 'CURR:AC', conf: 'CONF:CURR:AC', label: 'A ∿', name: 'Переменный ток', unit: 'A', r: A_R },
  { id: 'CURR:ACDC', hdr: 'CURR:ACDC', conf: 'CONF:CURR:ACDC', label: 'A ∿+⎓', name: 'Ток AC+DC', unit: 'A', r: A_R },
  { id: 'CURR:AUTO', hdr: 'CURR:AUTO', conf: 'CONF:CURR:AUTO', label: 'A авто', name: 'Ток, род тока сам', unit: 'A', r: A_R },
  { id: 'RES', hdr: 'RES', conf: 'CONF:RES', label: 'Ом', name: 'Сопротивление', unit: 'Ω', r: [60, 600, 6e3, 6e4, 6e5, 6e6, 6e7] },
  { id: 'CONT', conf: 'CONF:CONT', label: 'Прозвонка', name: 'Прозвонка', unit: 'Ω' },
  { id: 'DIOD', conf: 'CONF:DIOD', label: 'Диод', name: 'Диод', unit: 'V' },
  { id: 'CAP', hdr: 'CAP', conf: 'CONF:CAP', label: 'Ёмкость', name: 'Ёмкость', unit: 'F', r: [6e-8, 6e-7, 6e-6, 6e-5, 6e-4, 6e-3, 6e-2] },
  { id: 'FREQ', conf: 'CONF:FREQ', label: 'Частота', name: 'Частота', unit: 'Hz' },
  { id: 'TEMP', conf: 'CONF:TEMP', label: 'Темп.', name: 'Температура', unit: '°C' },
  { id: 'POW', conf: 'CONF:POW', label: 'Мощность', name: 'Ваттметр', unit: 'W' },
];
const TIME_STEPS = (() => { const o = []; for (let e = -7; e <= 1; e++) for (const m of [1, 2, 5]) o.push(m * 10 ** e); return o.filter(v => v >= 1e-7 * .99 && v <= 50.1); })();
const VOLT_STEPS = [.002, .005, .01, .02, .05, .1, .2, .5, 1, 2, 5, 10];

class DM40 extends Device {
  static probe(idn) { return /DM40|opendm40/i.test(idn); }
  id = 'dm40'; title = 'DM40';
  async start() {
    const c = this.s;
    Object.assign(c, { func: 'VOLT', range: NaN, rangeAuto: true, alert: 'NONE', pollMs: store.get('dm40.poll', 100), run: true, scopeUsers: 0, wavePoints: 400, fps: 0, kbps: 0, trig: 'STOP' });
    Hub.define({ id: 'dm40.main', name: 'Мультиметр', unit: 'V', dev: this.id, group: 'Мультиметр', digits: 6 });
    for (const [k, name, unit] of [['vpp', 'Размах', 'V'], ['vmax', 'Максимум', 'V'], ['vmin', 'Минимум', 'V'], ['vavg', 'Среднее', 'V'], ['vrms', 'СКЗ', 'V'], ['freq', 'Частота', 'Hz'], ['period', 'Период', 's'], ['duty', 'Скважность', '%']])
      Hub.define({ id: 'dm40.' + k, name, unit, dev: this.id, group: 'Осциллограф', digits: 5 });
    for (const [k, name, unit] of [['p', 'Активная мощность', 'W'], ['s', 'Полная мощность', 'VA'], ['r', 'Реактивная мощность', 'var'], ['pf', 'Коэффициент мощности', ''], ['v', 'Напряжение СКЗ', 'V'], ['i', 'Ток СКЗ', 'A'], ['f', 'Частота сети', 'Hz'], ['e', 'Энергия', 'Wh']])
      Hub.define({ id: 'dm40.pw_' + k, name, unit, dev: this.id, group: 'Ваттметр', digits: 5 });
    this.restoreCustom();
    this.alive = true;
    await this.readDmmState();
    await this.readScopeState();
    this.dmmLoop();
    this.scopeLoop();
  }
  func() { return DM_FUNCS.find(f => f.id === this.s.func) || DM_FUNCS[0]; }
  async readDmmState() {
    const c = this.s;
    try {
      const f = (await this.q('FUNC?')).replace(/"/g, '');
      if (f && f !== c.func) { c.func = f; }
      const fn = this.func(), q = Hub.q.get('dm40.main');
      q.unit = fn.id === 'TEMP' && c.tempUnit === 'F' ? '°F' : fn.unit; q.name = fn.name;
      if (fn.hdr) {
        c.range = await this.n(`${fn.hdr}:RANG?`);
        c.rangeAuto = (await this.q(`${fn.hdr}:RANG:AUTO?`)) === '1';
        q.full = c.range;
      } else { c.range = NaN; c.rangeAuto = true; q.full = 0; }
      c.rate = await this.q('RATE?');
      this.emit('dmm');
    } catch (e) { this.fail(e); }
  }
  async readScopeState() {
    const c = this.s;
    try {
      const r = (await this.q('TIM:SCAL?;CHAN1:SCAL?;CHAN1:COUP?;CHAN1:OFFS?;TRIG:LEV?;TRIG:SLOP?;TRIG:SWE?;TRIG:SOUR?;TRIG:STAT?;ACQ:SRAT?')).split(';');
      if (r.length >= 10) {
        Object.assign(c, { ts: +r[0], vs: +r[1], coup: r[2], offs: +r[3], tl: +r[4], slope: r[5], sweep: r[6], src: r[7], trig: r[8], srate: +r[9] });
        c.run = c.trig !== 'STOP';
      }
      this.emit('scope');
    } catch (e) { this.fail(e); }
  }
  async setFunc(f) {
    const fn = DM_FUNCS.find(x => x.id === f); if (!fn) return;
    await this.w(fn.conf);
    Hub.q.get('dm40.main').clear();
    this.s.func = f;
    await this.readDmmState();
  }
  async setRange(v) {
    const fn = this.func(); if (!fn.hdr) return;
    await this.w(v === 'AUTO' ? `${fn.hdr}:RANG:AUTO ON` : `${fn.hdr}:RANG ${v}`);
    await sleep(40); await this.readDmmState();
  }
  async dmmLoop() {
    let n = 0;
    while (this.alive) {
      const t0 = performance.now(), c = this.s;
      try {
        const v = await this.n('FETC?', { timeout: 2500 });
        Hub.push('dm40.main', v);
        if (this.state !== 'ok') { this.state = 'ok'; this.emit('state'); }
        n++;
        if (n % 8 === 0) await this.readDmmState();
        if (n % 16 === 3) { c.alert = await this.q('SYST:ALER?'); c.temp = await this.n('SYST:TEMP?'); this.emit('sys'); }
        if (c.func === 'POW') {
          const a = (await this.q('FETC:POW:ALL?')).split(',').map(parseFloat);
          if (a.length >= 8) for (const [i, k] of [[0, 'p'], [1, 's'], [2, 'r'], [3, 'pf'], [4, 'v'], [5, 'i'], [6, 'f'], [7, 'e']].map(x => x)) Hub.push('dm40.pw_' + k, a[i] >= 9e37 ? NaN : a[i]);
        }
        await this.pollCustom(t0);
      } catch (e) { if (!this.alive) return; this.fail(e); await sleep(400); }
      await sleep(Math.max(0, c.pollMs - (performance.now() - t0)));
    }
  }
  /* Живая осциллограмма: экранные 400 точек идут в работе прибора и быстрее всего. */
  async scopeLoop() {
    const c = this.s; let frames = 0, bytes = 0, t0 = performance.now(), pre = null, age = 0;
    while (this.alive) {
      if (!c.scopeUsers || !c.run || c.record) { await sleep(120); if (c.scopeUsers && !c.record) { try { c.trig = await this.q('TRIG:STAT?'); this.emit('trig'); } catch { } await sleep(380); } continue; }
      try {
        if (!pre || age++ > 24 || c.preDirty) {
          c.preDirty = false; age = 0;
          await this.link.run(async () => { await this.link.tx('WAV:SOUR CHAN1;WAV:POIN SCR;WAV:FORM BYTE'); });
          pre = this.parsePre(await this.q('WAV:PRE?'));
          c.trig = await this.q('TRIG:STAT?'); c.srate = await this.n('ACQ:SRAT?'); this.emit('trig');
        }
        const d = await this.link.block('WAV:DATA?', { timeout: 2500 });
        if (!d.length) { await sleep(20); continue; }
        const v = new Float32Array(d.length);
        for (let i = 0; i < d.length; i++) v[i] = (d[i] - pre.yref) * pre.yinc + pre.yorig;
        frames++; bytes += d.length + 6;
        this.emit('wave', { v, xinc: pre.xinc, xorig: pre.xorig, xref: pre.xref, t: performance.now(), screen: true });
        if (frames % 4 === 0) this.measure(v, pre.xinc);
      } catch (e) { if (!this.alive) return; this.fail(e); pre = null; await sleep(300); }
      const now = performance.now();
      if (now - t0 >= 1000) { c.fps = frames / ((now - t0) / 1000); c.kbps = bytes / (now - t0); frames = 0; bytes = 0; t0 = now; this.emit('rate'); }
    }
  }
  parsePre(s) {
    const a = s.split(',').map(parseFloat);
    return { format: a[0], type: a[1], points: a[2], xinc: a[4], xorig: a[5], xref: a[6], yinc: a[7], yorig: a[8], yref: a[9] };
  }
  measure(v, dt) { const m = waveStats(v, dt); for (const k of ['vpp', 'vmax', 'vmin', 'vavg', 'vrms', 'freq', 'period', 'duty']) Hub.push('dm40.' + k, m[k]); }
  async scope(cmd, patch) { Object.assign(this.s, patch); this.s.preDirty = true; await this.w(cmd); this.emit('scope'); }
  async setRun(on) {
    const c = this.s;
    c.record = null;
    if (on) { await this.w('RUN'); c.run = true; c.preDirty = true; } else { await this.w('STOP'); c.run = false; }
    this.emit('scope');
  }
  async single() { const c = this.s; await this.w('SING'); c.run = false; this.emit('scope'); }
  /* Полная запись: только на остановленной развёртке. */
  async fetchRecord(onStatus) {
    const c = this.s;
    if (c.run) await this.setRun(false);
    for (let i = 0; i < 60; i++) { c.trig = await this.q('TRIG:STAT?'); if (c.trig === 'STOP') break; await sleep(100); }
    await this.w('WAV:POIN MAX;WAV:FORM WORD');
    const pre = this.parsePre(await this.q('WAV:PRE?'));
    onStatus?.(`Читаю ${pre.points} точек…`);
    const t0 = performance.now();
    const d = await this.link.block('WAV:DATA?', { timeout: 30000, prio: 0 });
    await this.w('WAV:POIN SCR;WAV:FORM BYTE'); c.preDirty = true;
    const n = d.length >> 1, u = new DataView(d.buffer, d.byteOffset, d.length), v = new Float32Array(n);
    for (let i = 0; i < n; i++) v[i] = (u.getUint16(i * 2, true) - pre.yref) * pre.yinc + pre.yorig;
    const ms = performance.now() - t0;
    c.record = { v, xinc: pre.xinc, xorig: pre.xorig, xref: pre.xref, n, ms };
    this.emit('record');
    return c.record;
  }
  /* Экран прибора: DBG:LCD? отдаёт сырые слова дисплея, 18 бит на точку. Только USB. */
  async readScreen(ctx, onLine) {
    const W = 480, H = 320, rows = 4, img = ctx.createImageData(W, rows);
    for (let y = 0; y < H && this.alive; y += rows) {
      const hgt = Math.min(rows, H - y), words = 1 + Math.ceil(W * hgt * 3 / 2);
      const d = await this.link.block(`DBG:LCD? 0,${y},${W},${hgt},${words}`, { timeout: 2000 });
      const b = new Uint8Array(d.length);
      for (let i = 0; i + 1 < d.length; i += 2) { b[i] = d[i + 1]; b[i + 1] = d[i]; }     // слова little-endian, байты цвета big-endian
      let o = 2;
      for (let p = 0; p < W * hgt; p++, o += 3) { img.data[p * 4] = b[o]; img.data[p * 4 + 1] = b[o + 1]; img.data[p * 4 + 2] = b[o + 2]; img.data[p * 4 + 3] = 255; }
      ctx.putImageData(img, 0, y, 0, 0, W, hgt);
      onLine?.(y / H);
    }
  }
  windows() { return ['dm40-dmm', 'reading', 'dm40-scope', 'dm40-gen', 'dm40-power', 'dm40-stream', 'dm40-decode', 'dm40-inrush', 'dm40-files', 'dm40-screen', 'settings']; }
}

/* Скорость, амплитуда и прочее считаются здесь же, чтобы набор мер не зависел от прибора. */
function waveStats(v, dt) {
  const n = v.length; if (!n) return {};
  let lo = Infinity, hi = -Infinity, sum = 0, sq = 0;
  for (let i = 0; i < n; i++) { const x = v[i]; if (x < lo) lo = x; if (x > hi) hi = x; sum += x; sq += x * x; }
  const avg = sum / n, rms = Math.sqrt(sq / n), mid = (lo + hi) / 2, hyst = (hi - lo) * 0.1;
  let rise = [], fall = 0, high = 0, state = v[0] > mid;
  for (let i = 1; i < n; i++) {
    const x = v[i];
    if (x > mid) high++;
    if (!state && x > mid + hyst) { state = true; const p = v[i - 1], t = i - 1 + (mid - p) / (x - p || 1); rise.push(t); }
    else if (state && x < mid - hyst) { state = false; fall++; }
  }
  let period = NaN;
  if (rise.length >= 2) period = (rise[rise.length - 1] - rise[0]) / (rise.length - 1) * dt;
  const lo10 = lo + (hi - lo) * .1, hi90 = lo + (hi - lo) * .9;
  let riseT = NaN;
  if (rise.length) {
    const c = Math.round(rise[0]); let a = c, b = c;
    while (a > 0 && v[a] > lo10) a--; while (b < n - 1 && v[b] < hi90) b++;
    if (b > a) riseT = (b - a) * dt;
  }
  return { vpp: hi - lo, vmax: hi, vmin: lo, vavg: avg, vrms: rms, vac: Math.sqrt(Math.max(0, sq / n - avg * avg)), freq: 1 / period, period, duty: high / n * 100, rise: riseT };
}

/* ---------- LT1 ---------- */
const LT1_FREQ = [100, 120, 1000, 10000, 100000];
const LT1_LEV = [0.1, 0.3, 0.6, 1.0];

class LT1 extends Device {
  static probe(idn) { return /PTLT1|LT1/i.test(idn); }
  id = 'lt1'; title = 'LT1';
  async start() {
    const c = this.s;
    Object.assign(c, { pollMs: store.get('lt1.poll', 33), mode: 'AUTO', freq: 1000, lev: .6, circ: 0, aver: 2, hold: 0, ah: 0, seq: -1, type: 0, vg: 1, ig: 1000, rate: 0, swRun: 0, swDone: 0, swSpeed: 1, sweep: null });
    const D = [
      ['z', '|Z| импеданс', 'Ω', 'Импеданс'], ['theta', 'θ фаза', '°', 'Импеданс'], ['r', 'R посл. сопротивление', 'Ω', 'Последовательная схема'], ['x', 'X реактанс', 'Ω', 'Последовательная схема'],
      ['c', 'C посл. ёмкость', 'F', 'Последовательная схема'], ['l', 'L посл. индуктивность', 'H', 'Последовательная схема'], ['d', 'D потери', '', 'Качество'], ['q', 'Q добротность', '', 'Качество'],
      ['rp', 'Rp парал. сопротивление', 'Ω', 'Параллельная схема'], ['cp', 'Cp парал. ёмкость', 'F', 'Параллельная схема'], ['lp', 'Lp парал. индуктивность', 'H', 'Параллельная схема'],
      ['y', '|Y| проводимость', 'S', 'Параллельная схема'], ['g', 'G активная проводимость', 'S', 'Параллельная схема'], ['b', 'B реактивная проводимость', 'S', 'Параллельная схема'],
    ];
    for (const [k, name, unit, group] of D) Hub.define({ id: 'lt1.' + k, name, unit, dev: this.id, group, digits: 6 });
    this.restoreCustom();
    this.alive = true;
    await this.readState();
    this.loop();
  }
  async readState() {
    const c = this.s;
    try {
      const r = (await this.q('LCR:MODE?;LCR:FREQ?;LCR:LEV?;LCR:CIRC?;LCR:AVER?;LCR:HOLD?;LCR:AHOLD?;SWE:SPEED?')).split(';');
      if (r.length >= 8) Object.assign(c, { mode: r[0], freq: +r[1], lev: +r[2], circ: +r[3], aver: +r[4], hold: +r[5], ah: +r[6], swSpeed: +r[7] });
      this.emit('lcr');
    } catch (e) { this.fail(e); }
  }
  async set(k, cmd, v) { this.s[k] = v; await this.w(`${cmd} ${v}`); this.emit('lcr'); }
  derive(f, re, im) {
    const w = 2 * Math.PI * f, m2 = re * re + im * im, z = Math.sqrt(m2), g = re / m2, b = -im / m2;
    return { z, theta: Math.atan2(im, re) * 180 / Math.PI, r: re, x: im, c: -1 / (w * im), l: im / w, d: Math.abs(re / im), q: Math.abs(im / re), rp: 1 / g, cp: b / w, lp: -1 / (w * b), y: 1 / z, g, b };
  }
  async loop() {
    const c = this.s; let n = 0, last = performance.now(), got = 0;
    while (this.alive) {
      const t0 = performance.now();
      try {
        const a = (await this.q('FETC?', { timeout: 2500 })).split(',');
        if (a.length >= 9 && +a[0] !== c.seq) {
          c.seq = +a[0]; c.type = +a[1]; c.mfreq = +a[2]; c.mlev = +a[3]; c.vg = +a[6]; c.ig = +a[7]; c.flags = +a[8];
          const d = this.derive(+a[2], +a[4], +a[5]);
          for (const k in d) Hub.push('lt1.' + k, d[k]);
          got++;
        }
        if (this.state !== 'ok') { this.state = 'ok'; this.emit('state'); }
        n++;
        if (n % 64 === 0) await this.readState();
        if (t0 - last >= 1000) { c.rate = got / ((t0 - last) / 1000); got = 0; last = t0; this.emit('rate'); }
        await this.pollCustom(t0);
      } catch (e) { if (!this.alive) return; this.fail(e); await sleep(400); }
      await sleep(Math.max(0, c.pollMs - (performance.now() - t0)));
    }
  }
  async sweep(speed) {
    const c = this.s;
    if (c.swRun) return;
    c.swRun = 1; c.swDone = 0; c.swSpeed = speed; this.emit('sweep');
    await this.w(`SWE:SPEED ${speed};SWE:START`);
    try {
      while (this.alive && c.swRun) {
        await sleep(160);
        const st = (await this.q('SWE:STAT?')).split(',');
        const run = +st[0], done = +st[1];
        if (done !== c.swDone || !run) {
          c.swDone = done;
          const d = await this.link.block('SWE:DATA?', { timeout: 4000 });
          const n = Math.floor(d.length / 12), v = new DataView(d.buffer, d.byteOffset, d.length);
          const f = new Float64Array(n), re = new Float64Array(n), im = new Float64Array(n);
          for (let i = 0; i < n; i++) { f[i] = v.getFloat32(i * 12, true); re[i] = v.getFloat32(i * 12 + 4, true); im[i] = v.getFloat32(i * 12 + 8, true); }
          c.sweep = { f, re, im, n, t: Date.now() };
          this.emit('sweep');
        }
        if (!run) break;
      }
    } catch (e) { this.fail(e); }
    c.swRun = 0; this.emit('sweep');
  }
  async stopSweep() { this.s.swRun = 0; await this.w('SWE:STOP'); this.emit('sweep'); }
  windows() { return ['lt1-lcr', 'reading', 'lt1-sweep', 'settings']; }
}

/* ---------- любой SCPI-прибор ---------- */
class GenericScpi extends Device {
  static probe() { return true; }
  id = 'scpi'; title = 'SCPI';
  async start() {
    this.title = this.model || 'SCPI';
    this.id = 'scpi' + Math.random().toString(36).slice(2, 6);
    this.alive = true;
    this.restoreCustom();
    this.loop();
  }
  async loop() {
    while (this.alive) {
      try { await this.pollCustom(performance.now()); } catch (e) { if (!this.alive) return; this.fail(e); await sleep(500); }
      await sleep(50);
    }
  }
  windows() { return ['reading', 'console']; }
}

/* ---------- подключённые приборы ---------- */
const Devices = new (class extends Emitter {
  list = [];
  get(id) { return this.list.find(d => d.id === id); }
  async attach(tr) {
    await tr.open();
    const link = new Link(tr);
    let idn;
    try { idn = await link.query('*IDN?', { timeout: 2500 }); }
    catch (e) { await tr.close(); throw new Error('Прибор не ответил на *IDN?. Проверьте кабель и что в приборе включён нужный режим.'); }
    const Cls = [DM40, LT1].find(c => c.probe(idn)) || GenericScpi;
    const dev = new Cls(link, idn);
    const same = this.get(dev.id);
    if (same) await this.remove(same);
    await dev.start();
    this.list.push(dev);
    this.emit('change');
    return dev;
  }
  async remove(dev) {
    this.list = this.list.filter(d => d !== dev);
    await dev.stop();
    this.emit('change');
  }
})();

/* Настройки, которые просто читаются и пишутся одной командой. */
const OnOff = { 1: 'Вкл', 0: 'Выкл' };
const SETTINGS = {
  dm40: [
    ['Мультиметр', [
      ['RATE', 'Скорость измерений', { SLOW: 'Медленно', MED: 'Средне', FAST: 'Быстро' }, 'FAST: 10 отсчётов в секунду и 60000 единиц, SLOW усредняет 16 преобразований'],
      ['CALC:AHOL', 'AutoHold', OnOff], ['CALC:SMO:STAT', 'Сглаживание', OnOff], ['CALC:SMO:RESP', 'Сила сглаживания', { FAST: 'Слабое', SLOW: 'Сильное' }],
      ['CALC:AVER:STAT', 'Запись статистики', OnOff], ['RES:NEG', 'Отрицательные омы', OnOff], ['DISP:BURD', 'Падение на шунте на экране', OnOff],
    ]],
    ['Пределы', [['CALC:LIM:STAT', 'Проверка пределов', OnOff], ['CALC:LIM:LOW', 'Нижний предел', 'num'], ['CALC:LIM:UPP', 'Верхний предел', 'num']]],
    ['Температура', [
      ['UNIT:TEMP', 'Единица', { C: '°C', F: '°F' }],
      ['TEMP:TRAN', 'Датчик', { TCK: 'Термопара K', PT100: 'PT100', PT1000: 'PT1000', NTC10K3950: 'NTC 10k 3950', NTC10K3435: 'NTC 10k 3435', NTC100K3950: 'NTC 100k 3950', NTCUSER: 'NTC свой' }],
      ['TEMP:OFFS', 'Поправка, °C', 'num'],
    ]],
    ['Прибор', [
      ['SYST:RAIL', 'Питание мультиметра и осциллографа', { AUTO: 'Только нужное', BOTH: 'Оба сразу' }, 'BOTH позволяет мерить мультиметром во время работы осциллографа'],
      ['SYST:BEEP:VOL', 'Громкость, %', 'num'], ['SYST:ALER:ENAB', 'Маска предупреждений', 'num'],
      ['SYST:ALER:ALAR', 'Сирена', { LOUD: 'Громко', VOL: 'Как звук кнопок', OFF: 'Выкл' }], ['MEM:STAT:REC:AUTO', 'Помнить режим', OnOff],
      ['SYST:IDN:EMUL', 'Представляться как', { OFF: 'DM40', '34401A': '34401A' }],
    ]],
  ],
  lt1: [
    ['Измерение', [
      ['LCR:AVER', 'Усреднение', { 0: 'Выкл', 1: 'Слабое', 2: 'Среднее', 3: 'Сильное' }], ['LCR:AHOLD', 'Auto Hold', { 0: 'Выкл', 1: '±0,1 %', 2: '±0,5 %', 3: '±2 %' }],
      ['LCR:CIRC', 'Эквивалентная схема', { 0: 'Последовательная', 1: 'Параллельная', 2: 'Обе' }],
    ]],
  ],
};
