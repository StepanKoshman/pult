'use strict';
/* Симуляторы: отвечают тем же SCPI, что и настоящие приборы, поэтому драйверы и окна
   работают одинаково. Значения вымышленные, в интерфейсе они помечены как демо. */

class SimLink extends Emitter {
  constructor(sim, latency = 3) { super(); this.sim = sim; this.out = []; this.latency = latency; this.kind = 'sim'; this.name = 'Демо'; }
  async open() { } async close() { } abort() { this.out = []; }
  async send(data) {
    const s = typeof data === 'string' ? data : dec.decode(data);
    const reply = this.sim.message(s.trim());
    if (reply !== null) this.out.push(reply);
  }
  async recv(timeout = 3000) {
    await sleep(this.latency);
    if (!this.out.length) throw new TimeoutError();
    const r = this.out.shift();
    return typeof r === 'string' ? enc.encode(r + '\n') : r;
  }
}

function block(u) {
  const n = String(u.length), head = enc.encode(`#${n.length}${n}`), o = new Uint8Array(head.length + u.length + 1);
  o.set(head); o.set(u, head.length); o[o.length - 1] = 10; return o;
}
const nr3 = v => (v >= 0 ? '+' : '') + v.toExponential(6).replace('e+', 'E+').replace('e-', 'E-').replace(/E([+-])(\d)$/, 'E$10$2');
const rnd = s => (Math.random() + Math.random() + Math.random() - 1.5) * s;

class SimBase {
  message(s) {
    const out = [];
    for (const c of s.split(';')) {
      const r = this.cmd(c.trim());
      if (r !== undefined && r !== null) out.push(r);
    }
    if (!out.length) return s.includes('?') ? '' : null;
    if (out.length === 1) return out[0];
    return out.map(x => typeof x === 'string' ? x : dec.decode(x)).join(';');
  }
}

/* ---------- DM40 ---------- */
const SIM_FUNCS = {
  VOLT: () => 3.29872 + rnd(2e-4), 'VOLT:AC': () => 1.20213 + rnd(4e-4), 'VOLT:ACDC': () => 3.5099 + rnd(5e-4), 'VOLT:AUTO': () => 3.2987 + rnd(2e-4),
  CURR: () => 0.024816 + rnd(3e-6), 'CURR:AC': () => 0.01275 + rnd(5e-6), 'CURR:ACDC': () => 0.02793 + rnd(5e-6), 'CURR:AUTO': () => 0.024816 + rnd(3e-6),
  RES: () => 4698.3 + rnd(0.4), CONT: () => 0.183 + rnd(0.01), DIOD: () => 0.6512 + rnd(1e-4), CAP: () => 9.87e-6 + rnd(2e-9),
  FREQ: () => 1000.02 + rnd(0.01), TEMP: () => 24.6 + rnd(0.05), POW: () => 12.41 + rnd(0.02),
};

class SimDM40 extends SimBase {
  constructor() {
    super();
    this.f = 'VOLT'; this.rate = 'FAST'; this.ahold = 0; this.smooth = 0; this.smoothR = 'FAST'; this.limit = [null, null]; this.limitOn = 0; this.neg = 0;
    this.rangeAuto = true; this.range = 6; this.stat = 0; this.bt = 1;
    this.run = true; this.ts = 1e-3; this.vs = 1; this.coup = 'DC'; this.offs = 0; this.tl = 0; this.slope = 'POS'; this.sweep = 'AUTO'; this.src = 'CHAN1'; this.status = 'TD';
    this.wform = 'BYTE'; this.wpts = 'SCR'; this.gf = 'SIN'; this.gfreq = 1000; this.gv = 3; this.goffs = 1.5; this.gduty = 50; this.gout = 1;
    this.frozen = null; this.ph = 0; this.dec = 'OFF'; this.baud = 'AUTO'; this.errors = []; this.temp = 'C'; this.beep = 40; this.logOn = 0;
    this.gensc = 1; this.gendisp = 0;
    this.pow = { p: 12.41, s: 13.9, q: 6.2, pf: 0.893, v: 229.8, i: 0.0605, f: 50.01, e: 0.0351, sec: 102 };
    this.files = [['SHOTS/S000.BMP', 230454], ['LOGS/LOG000.DLG', 18432], ['LOGS/LOG000.CSV', 40210], ['SCOPE/SCOP000.DLG', 53124]];
  }
  srate() { return Math.min(5e7, 40 / this.ts); }
  wave(t) {
    const w = 2 * Math.PI * this.gfreq * t, c = this.gv / 2, d = this.gduty / 100, x = w / (2 * Math.PI) % 1;
    let v = this.gf === 'SIN' ? Math.sin(w) : this.gf === 'SQU' ? (x < d ? 1 : -1) : this.gf === 'TRI' ? (x < .5 ? 4 * x - 1 : 3 - 4 * x) : 2 * x - 1;
    return this.gout ? this.goffs + c * v : 0;
  }
  grab(n) {
    const dt = this.ts * 10 / n, o = new Float64Array(n), T = 1 / this.gfreq;
    let t0 = this.ph;
    if (this.run) { this.ph += 0.0137 * T; if (this.sweep !== 'AUTO' || true) { t0 = (this.tl + this.vs * 0 - this.goffs) / (this.gv / 2 || 1); t0 = Math.asin(clamp(t0, -1, 1)) / (2 * Math.PI) * T; } }
    const jitter = rnd(dt * 0.3);
    // редкий выброс, чтобы в режиме DPO было что найти
    const gl = Math.random() < 0.04 ? { at: Math.random() * n | 0, w: 2 + Math.random() * 6, a: (Math.random() < .5 ? -1 : 1) * this.vs * (1 + Math.random() * 1.5) } : null;
    for (let i = 0; i < n; i++) {
      let v = this.wave(t0 + jitter + (i - n / 2) * dt);
      if (this.coup === 'AC') v -= this.gout ? this.goffs : 0;
      if (gl) v += gl.a * Math.exp(-(((i - gl.at) / gl.w) ** 2));
      o[i] = v + rnd(this.vs * 0.012);
    }
    return o;
  }
  pre(points, type) {
    const n = points, x = this.ts * 10 / n;
    return [this.wform === 'WORD' ? 1 : 0, type, n, 1, nr3(x), nr3(-this.ts * 5), 0, nr3(this.vs * 8 / (this.wform === 'WORD' ? 1024 : 256)), nr3(-this.offs), this.wform === 'WORD' ? 512 : 128].join(',');
  }
  cmd(c) {
    const m = c.match(/^:?(\S+)\s*(.*)$/); if (!m) return null;
    const hd = m[1].toUpperCase(), arg = m[2].trim(), q = hd.endsWith('?'), k = hd.replace(/\?$/, '');
    const a = arg.replace(/"/g, '').toUpperCase(), num = parseFloat(arg);
    const sw = v => /^(ON|1)$/.test(a) ? 1 : /^(OFF|0)$/.test(a) ? 0 : v;
    if (k === '*IDN') return 'Alientek,DM40C,0123456789ABCDEF01234567,opendm40 0.4.16-S2084';
    if (k === 'SYST:ERR') return this.errors.shift() || '0,"No error"';
    if (k === 'SYST:MOD') return 'DM40C,3,60000';
    if (k === 'SYST:TEMP') return nr3(31.2 + rnd(.1));
    if (k === 'SYST:ALER') return 'NONE';
    if (k === 'SYST:ALER:ENAB') return q ? '7' : null;
    if (k === 'SYST:ALER:ALAR') return q ? 'LOUD' : null;
    if (k === 'SYST:RAIL') return q ? 'AUTO' : null;
    if (k === 'SYST:BEEP:VOL') { if (q) return String(this.beep); this.beep = num; return null; }
    if (k === 'MEM:STAT:REC:AUTO') return q ? '0' : null;
    if (k === 'UNIT:TEMP') { if (q) return this.temp; this.temp = a[0]; return null; }
    if (k === 'RATE') { if (q) return this.rate; this.rate = a.slice(0, 4).replace('MEDI', 'MED'); return null; }
    if (k === 'RATE:PER') return nr3(this.rate === 'FAST' ? .1 : this.rate === 'MED' ? .2 : .4);
    if (k === 'FUNC') { if (q) return `"${this.f}"`; this.setF(a); return null; }
    if (k.startsWith('CONF')) {
      if (q) return `"${this.f} ${nr3(this.range)},${nr3(1e-4)}"`;
      this.setF(k.slice(k.indexOf(':') + 1).replace(/^VOLT:DC$/, 'VOLT').replace(/^CURR:DC$/, 'CURR')); return null;
    }
    if (k === 'READ' || k === 'FETC' || k === 'FETCH') return nr3(this.reading());
    if (k.startsWith('MEAS:') && q && !k.startsWith('MEAS:POW')) return nr3(this.reading());
    if (k === 'FETC:BURD') return nr3(0.0124);
    if (k === 'FETC:POW:ALL') {
      const p = this.pow, w = () => rnd(.01);
      return [p.p + w(), p.s + w(), p.q + w(), p.pf, p.v + w() * 8, p.i, p.f, p.e, p.sec, 0.02, 0.001, p.e * 1.12, 0.0124].map(nr3).join(',');
    }
    if (/:RANG:AUTO$/.test(k)) { if (q) return this.rangeAuto ? '1' : '0'; this.rangeAuto = sw(this.rangeAuto) === 1; return null; }
    if (/:RANG$/.test(k)) { if (q) return nr3(this.range); if (a === 'AUTO') this.rangeAuto = true; else { this.rangeAuto = false; this.range = num || this.range; } return null; }
    if (k === 'CALC:AHOL') { if (q) return String(this.ahold); this.ahold = sw(0); return null; }
    if (k === 'CALC:AVER:STAT') { if (q) return String(this.stat); this.stat = sw(0); return null; }
    if (k === 'CALC:SMO' || k === 'CALC:SMO:STAT') { if (q) return String(this.smooth); this.smooth = sw(0); return null; }
    if (k === 'CALC:SMO:RESP') { if (q) return this.smoothR; this.smoothR = a === 'SLOW' ? 'SLOW' : 'FAST'; this.smooth = 1; return null; }
    if (k === 'CALC:LIM:LOW' || k === 'CALC:LIM:UPP') { const i = k.endsWith('LOW') ? 0 : 1; if (q) return nr3(this.limit[i] ?? 9.9e37); this.limit[i] = num; this.limitOn = 1; return null; }
    if (k === 'CALC:LIM:STAT') { if (q) return String(this.limitOn); this.limitOn = sw(0); return null; }
    if (k === 'CALC:LIM:CLE') { this.limit = [null, null]; return null; }
    if (k === 'CALC:LIM:FAIL') return '0';
    if (k === 'RES:NEG') { if (q) return String(this.neg); this.neg = sw(0); return null; }
    if (k === 'RUN') { this.run = true; this.status = 'TD'; this.frozen = null; return null; }
    if (k === 'STOP' || k === 'SING' || k === 'DIG') { this.frozen = this.grab(40000); this.run = false; this.status = 'STOP'; return null; }
    if (k === 'TRIG:STAT') return this.status;
    if (k === 'TIM:SCAL' || k === 'TIM:MAIN:SCAL') { if (q) return nr3(this.ts); this.ts = num; return null; }
    if (k === 'CHAN1:SCAL') { if (q) return nr3(this.vs); this.vs = num; return null; }
    if (k === 'CHAN1:COUP') { if (q) return this.coup; this.coup = a; return null; }
    if (k === 'CHAN1:OFFS') { if (q) return nr3(this.offs); this.offs = num; return null; }
    if (k === 'TRIG:LEV' || k === 'TRIG:EDGE:LEV') { if (q) return nr3(this.tl); this.tl = num; return null; }
    if (k === 'TRIG:SLOP' || k === 'TRIG:EDGE:SLOP') { if (q) return this.slope; this.slope = a.slice(0, 3); return null; }
    if (k === 'TRIG:SWE') { if (q) return this.sweep; this.sweep = a.slice(0, 4); return null; }
    if (k === 'TRIG:SOUR' || k === 'TRIG:EDGE:SOUR') { if (q) return this.src; this.src = a.startsWith('GEN') ? 'GEN' : a.endsWith('2') ? 'CHAN2' : 'CHAN1'; return null; }
    if (k === 'GEN:DISP') { if (q) return String(this.gendisp); this.gendisp = sw(0); return null; }
    if (k === 'GEN:SCAL') { if (q) return nr3(this.gensc); this.gensc = num; return null; }
    if (k === 'ACQ:SRAT') return nr3(this.srate());
    if (k.startsWith('SCOP:MEAS:')) {
      const p = this.gout ? this.gv : 0, x = k.slice(10);
      return nr3(x === 'VPP' ? p + rnd(.01) : x === 'VAVG' ? this.goffs : x === 'VRMS' ? Math.hypot(this.goffs, p / 2.83) : this.gfreq + rnd(.05));
    }
    if (k === 'WAV:SOUR') return q ? 'CHAN1' : null;
    if (k === 'WAV:FORM') { if (q) return this.wform; this.wform = a.slice(0, 4); return null; }
    if (k === 'WAV:POIN') { if (q) return String(this.wpts === 'SCR' ? 400 : 40000); this.wpts = a.startsWith('SC') ? 'SCR' : 'MAX'; return null; }
    if (k === 'WAV:PRE') return this.wpts === 'SCR' ? this.pre(400, 0) : this.pre(40000, 2);
    if (k === 'WAV:DATA') return this.waveBlock();
    if (k === 'SOUR:FUNC') { if (q) return this.gf; this.gf = a.slice(0, 3).replace('RAM', 'RAMP'); return null; }
    if (k === 'SOUR:FREQ') { if (q) return nr3(this.gfreq); this.gfreq = num; return null; }
    if (k === 'SOUR:VOLT') { if (q) return nr3(this.gv); this.gv = num; return null; }
    if (k === 'SOUR:VOLT:OFFS') { if (q) return nr3(this.goffs); this.goffs = a === 'AUTO' ? this.gv / 2 : num; return null; }
    if (k === 'SOUR:FUNC:SQU:DCYC') { if (q) return nr3(this.gduty); this.gduty = num; return null; }
    if (k === 'OUTP') { if (q) return String(this.gout); this.gout = sw(0); return null; }
    if (k === 'MMEM:CAT') return [1048576, 13631488, ...this.files.map(f => `"${f[0]},BIN,${f[1]}"`)].join(',');
    if (k === 'MMEM:DATA') return block(new Uint8Array(0));
    if (k === 'MMEM:DEL') { this.files = this.files.filter(f => !a.includes(f[0])); return null; }
    if (k === 'DEC:PROT') { if (q) return this.dec; this.dec = a.slice(0, 4); return null; }
    if (k === 'DEC:BAUD') { if (q) return this.baud; this.baud = a; return null; }
    if (k === 'DEC:FORM') return q ? '8N1' : null;
    if (k === 'DEC:POL') return q ? 'NORM' : null;
    if (k === 'DEC:THR') return q ? 'AUTO' : null;
    if (k === 'DEC:RATE') return '9600';
    if (k === 'DEC:FRAM') return block(enc.encode('0,-0.00312,MB,01 03 00 00 00 0A C5 CD,OK,REQ 01 03 @0000 n=10\n1,0.00102,MB,01 03 14 00 7B,OK,RSP 01 03 20B req=0\n'));
    if (k === 'LOG:STAT') { if (q) return String(this.logOn); this.logOn = sw(0); return null; }
    if (k === 'INR:COND') return 'OFF';
    if (q) { this.errors.push('-113,"Undefined header"'); return ''; }
    return null;
  }
  setF(a) { const n = a.replace(/^VOLT:DC$/, 'VOLT').replace(/^CURR:DC$/, 'CURR').replace(/^FRES$/, 'RES'); if (SIM_FUNCS[n]) { this.f = n; this.rangeAuto = true; } }
  reading() { return this.ahold && Math.random() < .5 ? SIM_FUNCS[this.f]() : SIM_FUNCS[this.f](); }
  waveBlock() {
    const word = this.wform === 'WORD', n = this.wpts === 'SCR' ? 400 : 40000;
    const v = this.frozen && this.wpts !== 'SCR' ? this.frozen : this.grab(n);
    const yi = this.vs * 8 / (word ? 1024 : 256), yr = word ? 512 : 128, top = word ? 1023 : 255;
    if (word) { const u = new Uint16Array(n); for (let i = 0; i < n; i++) u[i] = clamp(Math.round((v[i] + this.offs) / yi + yr), 0, top); return block(new Uint8Array(u.buffer)); }
    const u = new Uint8Array(n); for (let i = 0; i < n; i++) u[i] = clamp(Math.round((v[i] + this.offs) / yi + yr), 0, top);
    return block(u);
  }
}

/* ---------- LT1: тот же набор команд, что в прошивке fix5 ---------- */
class SimLT1 extends SimBase {
  constructor() {
    super();
    this.mode = 'AUTO'; this.f = 1000; this.l = 0.6; this.circ = 0; this.aver = 2; this.hold = 0; this.ah = 0; this.ahb = 1; this.seq = 0;
    this.sw = { run: 0, done: 0, speed: 1, data: new Float32Array(300) };
    this.dut = { r: 0.32, c: 10e-6, l: 22e-9 }; this.last = null;
  }
  z(f) { const w = 2 * Math.PI * f, d = this.dut; return [d.r + 0.03 * Math.sqrt(1000 / f), w * d.l - 1 / (w * d.c)]; }
  measure() {
    const [re, im] = this.z(this.f), k = 1 / (1 << this.aver * 1), n = Math.hypot(re, im) * 4e-4 * k;
    return [re + rnd(n), im + rnd(n)];
  }
  fetch() {
    if (!this.hold || !this.last) {
      const [re, im] = this.measure();
      this.seq++; this.last = [re, im];
    }
    const [re, im] = this.last;
    return [this.seq, im < 0 ? 2 : 3, this.f, this.l, nr3(re), nr3(im), 1, 1000, this.hold].join(',');
  }
  sweepTick() {
    const s = this.sw;
    if (!s.run) return;
    const per = [260, 110, 45][s.speed] ?? 110;
    const want = Math.min(100, Math.floor((performance.now() - s.t0) / per));
    while (s.done < want) {
      // the 2.2 grid: 1 kHz exactly at point 34, 50 kHz last
      const i = s.done++, f = i <= 34 ? 100 * 10 ** (i / 34) : 1000 * 50 ** ((i - 34) / 65), [re, im] = this.z(f), n = Math.hypot(re, im) * 8e-4 / (s.speed + 1) * (3 - s.speed);
      s.data[i * 3] = f; s.data[i * 3 + 1] = re + rnd(n); s.data[i * 3 + 2] = im + rnd(n);
    }
    if (s.done >= 100) s.run = 0;
  }
  cmd(c) {
    const m = c.match(/^:?(\S+)\s*(.*)$/); if (!m) return null;
    const hd = m[1].toUpperCase(), arg = m[2].trim().toUpperCase(), q = hd.endsWith('?'), k = hd.replace(/\?$/, ''), num = parseFloat(arg);
    if (k === '*IDN') return 'ALIENTEK,ATK-PTLT1,1C2D3E4F5A6B7C8D9E0F1A2B,2.3-fix5';
    if (k === 'SYST:ERR') return '0,"No error"';
    if (k === 'LCR:MODE') { if (q) return this.mode; this.mode = arg; return null; }
    if (k === 'LCR:FREQ') { if (q) return String(this.f); this.f = num; return null; }
    if (k === 'LCR:LEV') { if (q) return String(this.l); this.l = num; return null; }
    if (k === 'LCR:CIRC') { if (q) return String(this.circ); this.circ = num; return null; }
    if (k === 'LCR:AVER') { if (q) return String(this.aver); this.aver = num; return null; }
    if (k === 'LCR:HOLD') { if (q) return String(this.hold); this.hold = num ? 1 : 0; return null; }
    if (k === 'LCR:AHOLD') { if (q) return String(this.ah); this.ah = num; return null; }
    if (k === 'FETC') return this.fetch();
    if (k === 'SWE:SPEED') { if (q) return String(this.sw.speed); this.sw.speed = clamp(num, 0, 2); return null; }
    if (k === 'SWE:START') { Object.assign(this.sw, { run: 1, done: 0, t0: performance.now() }); return null; }
    if (k === 'SWE:STOP') { this.sw.run = 0; return null; }
    if (k === 'SWE:STAT') { this.sweepTick(); return `${this.sw.run},${this.sw.done}`; }
    if (k === 'SWE:DATA') { this.sweepTick(); return block(new Uint8Array(this.sw.data.buffer, 0, this.sw.done * 12)); }
    return q ? '' : null;
  }
}

/* ---------- C2: транспорт-симулятор с бинарными кадрами EE ----------
   Отвечает теми же кадрами, что прошивка 2.5.0, и пропускает их через C2Frame,
   так что в демо работают разбор, C2Link и драйвер целиком. */
class SimC2 extends Emitter {
  constructor(model = 'ATK-C2 Pro') {
    super(); this.kind = 'sim'; this.proto = 'c2'; this.name = 'Демо'; this.model = model;
    this.parser = new C2Frame(); this.t0 = performance.now(); this.pdo = 9000;
  }
  async open() { } async close() { } abort() { this.parser.flush(); }
  async send(b) {
    b = toBytes(b);
    if (b[0] !== 0xEE || b.length < 4 || b[3 + b[2]] !== C2P.cksum(b, 3 + b[2])) return;   // прибор молча игнорирует битый кадр
    const r = b[1] === 1 ? this.info() : b[1] === 22 ? this.record() : null;
    if (r) setTimeout(() => this.parser.feed(r), 2);
  }
  recv(timeout = 3000) { return this.parser.next(timeout); }
  info() {
    const p = new Uint8Array(30);
    p[0] = 1; p[1] = 2; p[2] = 50;                                   // аппаратная 1, прошивка 2.5.0
    const v = new DataView(p.buffer); v.setUint32(7, 0x1C2D3E4F, true); v.setUint32(11, 0x5A6B7C8D, true);
    p.set(enc.encode(this.model).subarray(0, 12), 15);
    p[28] = this.model === 'ATK-C2 Lite' ? 1 : 0;
    return C2P.reply(1, p);
  }
  record() {
    const s = (performance.now() - this.t0) / 1000;
    const step = [5000, 9000, 12000, 15000, 20000][Math.floor(s / 12) % 5];   // переговоры PD: 5, 9, 12, 15, 20 В
    this.pdo += (step - this.pdo) * 0.25;
    const ma = Math.max(0, 1500 + 900 * Math.sin(s * 0.7) + rnd(25));
    const p = new Uint8Array(51), v = new DataView(p.buffer);
    p[2] = 1;
    v.setUint32(3, Math.round(this.pdo - ma * 0.03 + rnd(4)), true);     // мВ, просадка под нагрузкой
    v.setUint32(7, Math.round(ma), true);                                // мА
    v.setUint32(11, Math.round(600 + rnd(8)), true);                     // D+ мВ
    v.setUint32(15, Math.round(Math.max(0, 8 + rnd(6))), true);          // D− мВ
    return C2P.reply(22, p);
  }
}
