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
   Говорит на родном протоколе прибора (поток 0x04/0x19, триггер 0x05/0x06, прослушка
   CC 0x0D с настоящими переговорами PD в BMC, e-marker, офлайн-записи) и на командах
   Пульта 0x1E. Кадры проходят через C2Frame, так что в демо работает весь путь. */
class SimC2 extends Emitter {
  constructor(model = 'ATK-C2 Pro') {
    super(); this.kind = 'sim'; this.proto = 'c2'; this.name = 'Демо'; this.model = model;
    this.parser = new C2Frame(); this.t0 = performance.now(); this.vset = 5000; this.vnow = 5000; this.ma = 0;
    this.mode = 2; this.stream = false; this.listen = false; this.trig = null; this.acc = 0; this.last19 = 0; this.lastPd = 0; this.msgId = 0;
    this.em = [{ valid: 1, vdo: [0x1C0020C2, 0, 0x00010000, 0x00082642] }, { valid: 0, vdo: [0, 0, 0, 0] }];
    this.avg = 0; this.stage = new Uint8Array(200); this.LOG0 = 0x69c34; this.LOGEND = 0x6a000;
    this.log = new Uint8Array(this.LOGEND - this.LOG0).fill(0xFF); this.free = 0; this.sc = 0; this.uc = 0;
    const t = new Uint8Array(96);
    for (let l = 0; l < 6; l++) for (let i = 0; i < 8; i++) { const w = (300 + 35 * l + 4 * [5, 7, 9, 12, 15, 20, 24, 28][i]) * 10; t[l * 16 + i * 2] = w & 255; t[l * 16 + i * 2 + 1] = w >> 8; }
    this.append(1, t);
  }
  async open() { this.timer = setInterval(() => this.tick(), 50); }
  async close() { clearInterval(this.timer); }
  abort() { this.parser.flush(); }
  recv(timeout = 3000) { return this.parser.next(timeout); }
  out(cmd, p, delay = 3) { const f = C2P.reply(cmd, p); setTimeout(() => this.parser.feed(f), delay); }
  append(type, body) {
    const n = 8 + body.length; if (this.free + n > this.log.length) return 0;
    const r = new Uint8Array(n), v = new DataView(r.buffer); v.setUint32(0, 0x58523243, true); r[4] = type; v.setUint16(6, n, true); r.set(body, 8);
    this.log.set(r, this.free); const a = this.LOG0 + this.free; this.free += n;
    if (type === 1) this.sc = a + 8; else this.uc = body[0] | body[1] ? a : 0;
    return a;
  }
  async send(b) {
    b = toBytes(b);
    if (b[0] !== 0xEE || b.length < 4 || b[3 + b[2]] !== C2P.cksum(b, 3 + b[2])) return;   // прибор молча игнорирует битый кадр
    const cmd = b[1], p = b.slice(3, 3 + b[2]);
    switch (cmd) {
      case 1: this.out(1, this.info()); break;
      case 3: this.mode = p[1] % 7; this.out(3, [this.mode > 4 ? 1 : 0, this.mode, 10, 0]); break;
      case 4: this.stream = p[0] === 1; break;
      case 5: this.trigger(p); break;
      case 6: this.trig = null; this.vset = 5000; break;
      case 8: this.out(8, [1, 0, 0xE8, 3, 0, 0, 23, 0, 0, 0, 23, 0, 0x8F, 0x55, 0xAC, 0x3E, 0x82, 0xF3, 0xE3, 0x3F, 1]); break;
      case 9: {
        const n = p[2] | p[3] << 8, all = new Uint8Array(n * 4), v = new DataView(all.buffer);
        for (let k = 0; k < n; k++) { v.setUint16(k * 4, 5290 + rnd(3) | 0, true); v.setUint16(k * 4 + 2, 50 + 8 * Math.sin(k / 3) | 0, true); }
        for (let o = 0; o < all.length; o += 56) this.out(9, all.subarray(o, o + 56), 3 + o / 56);
        break;
      }
      case 10: break;
      case 12:
        this.listen = p[0] === 1; this.out(12, [p[0], 0, 0xA0, 0x38, 0x39, 0]);
        if (this.listen) { this.out(0x21, [2, 1, 0, 0, 0, 0, 0, 0, 0, 0], 5); this.lastPd = 0; }
        break;
      case 22:
        this.em.forEach((e, i) => { const r = new Uint8Array(51), v = new DataView(r.buffer); r[0] = 5; r[1] = i; r[2] = e.valid; e.vdo.forEach((w, k) => v.setUint32(3 + k * 4, w >>> 0, true)); this.out(22, r, 3 + i); });
        break;
      case 23: { const v = new DataView(p.buffer); this.em[p[1] & 1] = { valid: 1, vdo: [0, 1, 2, 3].map(k => v.getUint32(3 + k * 4, true)) }; this.out(23, [0]); break; }
      case 24:
        if (p[1] === 5) this.em.forEach(e => { e.valid = 0; e.vdo = [0, 0, 0, 0]; }); else this.em[p[1] & 1] = { valid: 0, vdo: [0, 0, 0, 0] };
        this.out(24, [0, p[1]]); break;
      case 0x1E: this.ext(p); break;
    }
  }
  ext(p) {
    const sub = p[0], r = new Uint8Array(58), v = new DataView(r.buffer); r[0] = sub;
    let n = 2;
    if (sub === 0) {
      r[2] = 1; r[5] = this.sc ? 1 : 0; r[6] = 8; r[9] = this.avg;
      v.setUint32(10, this.sc, true); v.setUint32(14, this.uc, true); v.setUint32(18, this.LOG0, true); v.setUint32(22, this.LOG0 + this.free, true); v.setUint32(26, this.LOGEND, true);
      v.setFloat32(30, this.vnow / 1000 * 1.003, true); v.setFloat32(34, this.ma / 1000 * 0.995, true); r[38] = 3; n = 39;
    } else if (sub === 1) {
      const addr = (p[1] | p[2] << 8 | p[3] << 16 | p[4] << 24) >>> 0, len = p[5];
      v.setUint32(2, addr, true);
      for (let k = 0; k < len; k++) { const x = addr + k - this.LOG0; r[6 + k] = x >= 0 && x < this.log.length ? this.log[x] : (addr + k) & 255; }
      n = 6 + len;
    } else if (sub === 4) this.avg = p[1];
    else if (sub === 5) this.stage.set(p.subarray(2), Math.max(0, p[1] - 8));
    else if (sub === 6) { const len = p[2] | p[3] << 8, a = this.append(p[1], this.stage.slice(0, len - 8)); v.setUint32(2, a, true); r[1] = a ? 0 : 3; n = 6; }
    else r[1] = 0xFF;
    this.out(0x1E, r.subarray(0, n));
  }
  trigger(p) {
    if (p[0] === 1) {
      this.trig = p[1];
      if (p[1] !== 0) { this.out(6, [6, 1, ...enc.encode((C2_PROTOS.find(x => x[0] === p[1])?.[1] || '?') + ':  ' + (p[1] < 4 ? 'exist' : 'not exist!'))], 400); return; }
      const ent = [[7, 0, 5000, 5000, 3000], [11, 0, 9000, 9000, 3000], [15, 0, 15000, 15000, 3000], [18, 0, 20000, 20000, 2250], [24, 1, 3300, 11000, 5000], [25, 1, 3300, 21000, 3000]];
      ent.forEach(([n, varb, mn, mx, ma], k) => {
        const r = new Uint8Array(22), v = new DataView(r.buffer);
        v.setUint32(2, 2 ** n, true); v.setUint16(11, mn, true); v.setUint16(13, varb ? 20 : 0, true); v.setUint16(15, mn, true); v.setUint16(17, mx, true); v.setUint16(19, ma, true); r[21] = 0xFF;
        this.out(5, r, 300 + k * 20);
      });
    } else if (p[0] === 2) this.vset = p[3] | p[4] << 8;
  }
  info() {
    const p = new Uint8Array(30);
    p[0] = 10; p[1] = 3; p[2] = 80;
    p.set(enc.encode('DEMO0001'), 7);
    p.set(enc.encode(this.model).subarray(0, 12), 15);
    p[28] = this.model === 'ATK-C2 Lite' ? 1 : 0;
    return p;
  }
  tick() {
    const now = performance.now(), s = (now - this.t0) / 1000;
    this.vnow += (this.vset - this.vnow) * 0.3;
    this.ma = Math.max(0, 900 + 600 * Math.sin(s * 0.5) + rnd(15));
    if (this.stream) {
      const hz = [2, 4, 20, 50, 200, 500, 1000][this.mode], k = this.mode >= 5 ? 4 : 1;
      this.acc += hz * 0.05 / k;
      const nfr = Math.min(20, this.acc | 0); this.acc -= nfr;
      for (let f = 0; f < nfr; f++) {
        const p = new Uint8Array(57);
        const put24 = (o, x) => { x = Math.max(0, Math.round(x)); p[o] = x & 255; p[o + 1] = x >> 8 & 255; p[o + 2] = x >> 16 & 255; };
        const put16 = (o, x) => { x = Math.max(0, Math.round(x)); p[o] = x & 255; p[o + 1] = x >> 8; };
        for (let j = 0; j < 4; j++) {
          const rip = 25 * Math.sin((now + j * 5) * 0.7);
          put24(j * 3, (this.vnow - this.ma * 0.03 + rip + rnd(3)) * 100); put24(12 + j * 3, (this.ma + rnd(4)) * 100);
          put16(24 + j * 2, 600 + rnd(5)); put16(32 + j * 2, 8 + rnd(3)); put16(40 + j * 2, 0); put16(48 + j * 2, 1657 + rnd(4));
        }
        p[56] = 1;
        this.parser.feed(C2P.reply(4, p));
      }
      if (now - this.last19 > 1500) {
        this.last19 = now; const p = new Uint8Array(55);
        p.set(enc.encode(this.trig === 0 ? 'PD3.0' : 'QC3.0'), 0); p.set(enc.encode('---NA---'), 18); p.set(enc.encode('PPS'), 34); p[54] = 29;
        this.parser.feed(C2P.reply(0x19, p));
      }
    }
    if (this.listen) {
      let bits;
      if (now - this.lastPd > 2500) { this.lastPd = now; bits = this.pdBurst(); } else bits = new Uint8Array(59 * 6).fill(0xFF);
      for (let o = 0; o < bits.length; o += 59) {
        const fr = new Uint8Array(59).fill(0xFF); fr.set(bits.subarray(o, o + 59));
        this.parser.feed(C2P.frame(13, fr)); this.parser.feed(new Uint8Array([0]));
      }
    }
  }
  pdBurst() {
    const msg = (type, n, src, objs = []) => {
      const hdr = type | (src ? 1 << 5 : 0) | 2 << 6 | (src ? 1 << 8 : 0) | (this.msgId++ & 7) << 9 | n << 12;
      const b = new Uint8Array(2 + objs.length * 4), v = new DataView(b.buffer); v.setUint16(0, hdr, true); objs.forEach((w, k) => v.setUint32(2 + k * 4, w >>> 0, true));
      return pdEncodeSamples('SOP', b, 12.5, 30);
    };
    const parts = [msg(1, 4, 1, [0x2401912C, 0x0002D12C, 0x0004B12C, 0xC1A4213C]), msg(1, 0, 0), msg(2, 1, 0, [0x2004B12C]), msg(1, 0, 1), msg(3, 0, 1), msg(1, 0, 0), msg(6, 0, 1), msg(1, 0, 0)];
    const len = parts.reduce((a, x) => a + x.length, 0), out = new Uint8Array(len); let o = 0;
    for (const x of parts) { out.set(x, o); o += x.length; }
    return out;
  }
}
