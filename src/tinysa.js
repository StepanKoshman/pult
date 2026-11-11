'use strict';
/* tinySA и tinySA Ultra. Прибор виден как COM-порт (USB CDC) с текстовой оболочкой: команда и \r,
   ответ до приглашения "ch> ". Скан идёт двоичной командой scanraw с любым числом точек,
   экран передаётся снимком (capture) и трансляцией изменившихся областей (refresh on: bulk и fill). */

const SA_W = 480, SA_H = 320;
const SA_PROMPT = [0x63, 0x68, 0x3e, 0x20], SA_BULK = [...enc.encode('bulk\r\n')], SA_FILL = [...enc.encode('fill\r\n')];
const SA_RBW = [['auto', 'Авто'], [850, '850 кГц'], [600, '600 кГц'], [300, '300 кГц'], [100, '100 кГц'], [30, '30 кГц'], [10, '10 кГц'], [3, '3 кГц'], [1, '1 кГц'], [0.2, '200 Гц']];
const SA_POINTS = [101, 290, 450, 1000, 2000, 5000, 10000, 20000, 50000, 100000];
let saLut = null;
function saColors() {                       // RGB565 -> пиксель холста (ABGR в памяти)
  if (saLut) return saLut;
  saLut = new Uint32Array(65536);
  for (let v = 0; v < 65536; v++) { const r = (v >> 11) * 255 / 31 | 0, g = (v >> 5 & 63) * 255 / 63 | 0, b = (v & 31) * 255 / 31 | 0; saLut[v] = (255 << 24 | b << 16 | g << 8 | r) >>> 0; }
  return saLut;
}

/* ---------- разбор потока: текст до "ch> ", области экрана и двоичные ответы ---------- */
class SaParser {
  constructor() { this.buf = new Uint8Array(1 << 17); this.pos = 0; this.len = 0; this.text = ''; this.job = null; this.onRegion = null; this.onText = null; this.rx = 0; }
  flush() { this.pos = this.len = 0; this.text = ''; }
  feed(u) {
    this.rx += u.length;
    if (this.pos && (this.pos === this.len || this.len + u.length > this.buf.length)) { this.buf.copyWithin(0, this.pos, this.len); this.len -= this.pos; this.pos = 0; }
    if (this.len + u.length > this.buf.length) { const n = new Uint8Array(Math.max(this.buf.length * 2, this.len + u.length)); n.set(this.buf.subarray(0, this.len)); this.buf = n; }
    this.buf.set(u, this.len); this.len += u.length;
    try { this.scan(); } catch (e) { console.error(e); this.flush(); }
  }
  find(p, from = this.pos) {
    const b = this.buf, n = p.length, to = this.len - n;
    outer: for (let i = from; i <= to; i++) { for (let k = 0; k < n; k++) if (b[i + k] !== p[k]) continue outer; return i; }
    return -1;
  }
  /* 1: шаблон целиком, 0: пока совпадает, но байт мало, -1: не он */
  at(p) { const n = Math.min(p.length, this.len - this.pos); for (let k = 0; k < n; k++) if (this.buf[this.pos + k] !== p[k]) return -1; return n === p.length ? 1 : 0; }
  scan() {
    for (; ;) {
      const b = this.buf, n = this.len - this.pos, j = this.job;
      if (n <= 0) return;
      if (j && !j.on) {                                   // двоичный ответ начинается после эха команды
        const e = this.find(j.echo);
        if (e < 0) { if (n > 8192) this.pos = this.len - j.echo.length; return; }
        this.pos = e + j.echo.length; j.on = true; this.text = ''; continue;
      }
      if (j && j.kind === 'raw') {
        if (n < j.size) { j.progress(n / j.size); return; }
        this.job = null; const o = b.slice(this.pos, this.pos + j.size); this.pos += j.size; j.done(o); continue;
      }
      if (j) {                                            // scanraw: '{', по 'x' lo hi на точку, '}'
        if (!j.open) { if (b[this.pos] !== 0x7b) { this.job = null; j.done(-1); continue; } j.open = true; this.pos++; continue; }
        let p = this.pos; const out = j.out, end = this.len, z = j.zero;
        while (p + 3 <= end && b[p] === 0x78 && j.n < out.length) { out[j.n++] = (b[p + 1] | b[p + 2] << 8) / 32 - z; p += 3; }
        this.pos = p; j.progress(j.n);
        if (p >= end || (b[p] === 0x78 && j.n < out.length)) return;
        if (b[p] === 0x7d) this.pos++;
        this.job = null; j.done(j.n); continue;       // '}' или чужой байт: скан прерван
      }
      const bulk = this.at(SA_BULK), fill = this.at(SA_FILL);
      if (bulk === 0 || fill === 0) return;
      if (bulk === 1 || fill === 1) {
        if (n < 14) return;
        const dv = new DataView(b.buffer, b.byteOffset + this.pos + 6, 8), x = dv.getInt16(0, true), y = dv.getInt16(2, true), w = dv.getInt16(4, true), hh = dv.getInt16(6, true);
        if (x < 0 || y < 0 || w <= 0 || hh <= 0 || x + w > SA_W || y + hh > SA_H) { this.pos += 6; continue; }
        const size = bulk === 1 ? w * hh * 2 : 2;
        if (n < 14 + size) return;
        this.onRegion?.(bulk === 1, x, y, w, hh, b, this.pos + 14);
        this.pos += 14 + size; continue;
      }
      let cut = this.find(SA_PROMPT), prompt = cut >= 0;
      for (const t of [SA_BULK, SA_FILL]) { const k = this.find(t, this.pos + 1); if (k >= 0 && (cut < 0 || k < cut)) { cut = k; prompt = false; } }
      if (cut < 0) {                                      // ни конца ответа, ни области: копим текст, хвост оставляем
        const keep = Math.max(this.pos, this.len - 5);
        this.text += dec.decode(b.subarray(this.pos, keep)); this.pos = keep; return;
      }
      this.text += dec.decode(b.subarray(this.pos, cut)); this.pos = cut;
      if (prompt) { this.pos += 4; const t = this.text; this.text = ''; this.onText?.(t); }
    }
  }
}

/* ---------- драйвер ---------- */
class TinySA extends Device {
  id = 'sa'; title = 'tinySA'; rev = 0; scrRev = 0;
  /* Проверка, что на линии оболочка tinySA. Возвращает null, если это другой прибор. */
  static detect(link) {
    return link.run(async () => {
      const tr = link.tr;
      if (!tr.parser) return null;
      const p = new SaParser(), old = tr.parser; tr.parser = p;
      const ask = (cmd, ms = 800) => new Promise(res => {
        const id = setTimeout(() => { p.onText = null; res(null); }, ms);
        p.onText = t => { t = t.replace(/^[\s\0]+/, ''); if (!t.startsWith(cmd)) return; clearTimeout(id); p.onText = null; res(t.slice(cmd.length).trim()); };
        tr.send(enc.encode(cmd + '\r')).catch(() => { });
      });
      try {
        await tr.send(enc.encode('\rrefresh off\r')); await sleep(200); p.flush();
        const ver = await ask('version');
        if (ver === null || !/tinySA/i.test(ver)) { tr.parser = old; old.flush?.(); return null; }
        const info = await ask('info') || '', model = (info.split(/\r?\n/)[0] || 'tinySA').replace(/,/g, ' ').trim();
        return { p, info, idn: `tinySA,${model},,${ver.split(/\r?\n/)[0]}` };
      } catch (e) { tr.parser = old; return null; }
    });
  }
  sh(cmd, { timeout = 3000, prio = 1 } = {}) {
    return this.link.run(() => new Promise((res, rej) => {
      const p = this.p, l = this.link; l.log?.('tx', cmd);
      const id = setTimeout(() => { p.onText = null; rej(new TimeoutError()); }, timeout);
      p.onText = t => {
        t = t.replace(/^[\s\0]+/, ''); if (!t.startsWith(cmd)) return;
        clearTimeout(id); p.onText = null; l.msgs++; l.bytes = p.rx;
        const r = t.slice(cmd.length).trim(); l.log?.('rx', r); res(r);
      };
      l.tr.send(enc.encode(cmd + '\r')).catch(rej);
    }), prio);
  }
  /* Двоичный ответ. Таймаут считается от последних принятых данных. */
  bin(cmd, job, timeout) {
    return this.link.run(() => new Promise((res, rej) => {
      const p = this.p, l = this.link; let id; l.log?.('tx', cmd);
      const arm = () => { clearTimeout(id); id = setTimeout(() => { p.job = null; rej(new TimeoutError()); }, timeout); };
      p.job = { ...job, echo: [...enc.encode(cmd + '\r\n')], on: false, done: v => { clearTimeout(id); l.msgs++; l.bytes = p.rx; res(v); }, progress: v => { arm(); job.progress?.(v); } };
      arm(); l.tr.send(enc.encode(cmd + '\r')).catch(rej);
    }));
  }
  q(cmd, o) { return /^SYST:ERR\?/i.test(cmd) ? Promise.resolve('0,"No error"') : this.sh(cmd.replace(/\?$/, ''), o); }
  w(cmd) { return this.sh(cmd, { prio: 0 }); }
  windows() { return ['sa-spectrum', 'sa-screen', 'sa-settings', 'console']; }

  async start() {
    const c = this.s;
    Object.assign(c, { start: 0, stop: 800e6, points: 450, rbw: 'auto', att: 'auto', lna: 0, spur: 'auto', hold: false, avg: 0, zero: 174, run: false, n: 0, pps: 0, sweepMs: 0, sweeps: 0, live: false, trace: null, geo: null, peaks: [] }, store.get('sa.cfg', {}));
    this.title = /ultra/i.test(this.model) ? 'tinySA Ultra' : 'tinySA';
    this.screen = new ImageData(SA_W, SA_H); this.px = new Uint32Array(this.screen.data.buffer); this.px.fill(0xff000000);
    this.p.onRegion = (bulk, x, y, w, hh, b, o) => this.region(bulk, x, y, w, hh, b, o);
    Hub.define({ id: 'sa.peak', name: 'Пик спектра', unit: 'dBm', dev: this.id, group: 'tinySA', digits: 4 });
    Hub.define({ id: 'sa.peakf', name: 'Частота пика', unit: 'Hz', dev: this.id, group: 'tinySA', digits: 7 });
    this.restoreCustom();
    this.alive = true;
    try {
      const m = (await this.sh('zero')).match(/(-?\d+)\s*dBm/); if (m) c.zero = Math.abs(+m[1]);
      if (!store.get('sa.cfg', null)) { const s = (await this.sh('sweep')).split(/\s+/).map(Number); if (s[1] > s[0]) { c.start = s[0]; c.stop = s[1]; } }
    } catch (e) { this.fail(e); }
  }
  async stop() { const c = this.s; c.run = false; if (this.alive && c.live) this.link.tr.send(enc.encode('refresh off\r')).catch(() => { }); await super.stop(); }
  save() { const c = this.s; store.set('sa.cfg', { start: c.start, stop: c.stop, points: c.points, rbw: c.rbw, att: c.att, lna: c.lna, spur: c.spur, hold: c.hold, avg: c.avg }); }
  /* Настройка: запоминается и уходит в прибор. Во время скана текущий проход прерывается, следующий идёт уже с ней. */
  async set(k, v) {
    const c = this.s; c[k] = v; this.save(); this.emit('cfg');
    const cmd = { rbw: `rbw ${v}`, att: `attenuate ${v}`, lna: `lna ${+v ? 'on' : 'off'}`, spur: `spur ${v}` }[k];
    if (k === 'hold' || k === 'avg') { this.maxT = this.avgT = null; this.avgK = 0; this.rev++; }
    if (cmd) { if (c.run) { this.pend = (this.pend || []).concat(cmd); this.kick(); } else await this.sh(cmd).catch(e => this.fail(e)); }
  }
  /* Прервать текущий проход, чтобы следующий сразу пошёл с новыми параметрами. */
  kick() { if (this.s.run) this.link.tr.send(enc.encode('resume\r')).catch(() => { }); }
  setRange(a, b) {
    const c = this.s; a = Math.max(0, Math.round(a)); b = Math.round(b);
    if (!(b > a)) return;
    c.start = a; c.stop = b; this.save(); this.emit('cfg'); this.kick();
  }
  setPoints(n) { const c = this.s; c.points = clamp(Math.round(n) || 450, 2, 1000000); this.save(); this.emit('cfg'); this.kick(); }
  /* Частота точки i так, как её считает прошивка: шаг равен целой части span/points в float. */
  fAt(i, g = this.s.geo) { return g.start + Math.floor(Math.fround(g.step * i)); }

  async run(single) {
    const c = this.s;
    if (c.run) return;
    c.run = true; this.emit('scan');
    const live = c.live;
    try {
      if (live) await this.sh('refresh off');
      do {
        for (const cmd of this.pend || []) await this.sh(cmd); this.pend = null;
        const n = c.points, step = Math.fround(Math.floor((c.stop - c.start) / n));
        if (!(step >= 1)) throw new Error('Точек больше, чем герц в полосе. Уменьшите число точек или расширьте полосу.');
        const g = c.geo, same = g && c.trace && g.start === c.start && g.n === n && g.step === step;
        if (!same) { c.trace = new Float32Array(n).fill(NaN); c.geo = { start: c.start, stop: c.stop, n, step }; this.maxT = this.avgT = null; this.avgK = 0; c.peaks = []; }
        c.n = 0; const t0 = performance.now(); this.emit('scan');
        const got = await this.bin(`scanraw ${c.start} ${c.stop} ${n}`, { kind: 'scan', out: c.trace, zero: c.zero, n: 0, progress: k => { c.n = k; this.rev++; } }, 30000);
        if (got < 0) throw new Error('Прибор отклонил параметры скана.');
        c.n = got; c.sweepMs = performance.now() - t0; c.pps = got / c.sweepMs * 1000; this.rev++;
        if (got === n) { c.sweeps++; this.afterSweep(); this.emit('sweep'); } else await sleep(150);
        await sleep(0);
      } while (c.run && !single && this.alive);
    } catch (e) { if (this.alive) { this.fail(e); toast(`${this.title}: ${e.message}`, 'bad'); } }
    c.run = false;
    if (this.alive) { await this.sh('resume').catch(() => { }); if (live) await this.sh('refresh on').catch(() => { }); }
    this.emit('scan');
  }
  /* Остановка: команда с приоритетом прерывает scanraw в приборе, приём завершается на её эхе. */
  halt() { const c = this.s; if (!c.run) return; c.run = false; this.link.tr.send(enc.encode('resume\r')).catch(() => { }); }
  afterSweep() {
    const c = this.s, t = c.trace, n = t.length;
    if (c.hold) { if (!this.maxT || this.maxT.length !== n) this.maxT = Float32Array.from(t); else { const m = this.maxT; for (let i = 0; i < n; i++) if (t[i] > m[i]) m[i] = t[i]; } }
    if (c.avg) {                                           // усреднение по мощности
      if (!this.avgT || this.avgT.length !== n) { this.avgT = Float32Array.from(t); this.avgK = 1; }
      else { const a = this.avgT, k = this.avgK = Math.min(this.avgK + 1, c.avg), w = 1 / k; for (let i = 0; i < n; i++) a[i] = 10 * Math.log10((1 - w) * 10 ** (a[i] / 10) + w * 10 ** (t[i] / 10)); }
    }
    const v = c.avg && this.avgT ? this.avgT : t, s = [];
    for (let i = 0, d = Math.max(1, n / 800 | 0); i < n; i += d) s.push(v[i]);
    s.sort((a, b) => a - b); const floor = s[s.length >> 1], guard = Math.max(2, n / 40 | 0), peaks = [], used = [];
    for (let k = 0; k < 6; k++) {
      let bi = -1, bv = -Infinity;
      for (let i = 0; i < n; i++) { if (v[i] > bv) { let ok = true; for (const u of used) if (Math.abs(u - i) < guard) { ok = false; break; } if (ok) { bv = v[i]; bi = i; } } }
      if (bi < 0 || (k && bv < floor + 8)) break;
      used.push(bi); peaks.push({ i: bi, f: this.fAt(bi), v: bv });
    }
    c.peaks = peaks; c.floor = floor;
    if (peaks[0]) { Hub.push('sa.peak', peaks[0].v); Hub.push('sa.peakf', peaks[0].f); }
  }

  region(bulk, x, y, w, hh, b, o) {
    const px = this.px, L = saColors();
    if (bulk) for (let r = 0; r < hh; r++) { let i = (y + r) * SA_W + x; for (let k = 0; k < w; k++, o += 2) px[i++] = L[b[o] << 8 | b[o + 1]]; }
    else { const v = L[b[o] << 8 | b[o + 1]]; for (let r = 0; r < hh; r++) px.fill(v, (y + r) * SA_W + x, (y + r) * SA_W + x + w); }
    this.scrRev++;
  }
  async grab(progress) { this.region(true, 0, 0, SA_W, SA_H, await this.bin('capture', { kind: 'raw', size: SA_W * SA_H * 2, progress }, 6000), 0); }
  async capture(progress) {
    const c = this.s;
    if (c.run) throw new Error('Идёт скан с компьютера. Остановите его, чтобы снять экран.');
    if (c.live) await this.sh('refresh off');
    try { await this.grab(progress); } finally { if (c.live) await this.sh('refresh on').catch(() => { }); }
  }
  async mirror(on) {
    const c = this.s;
    if (on && c.run) throw new Error('Идёт скан с компьютера. Трансляция включится после остановки.');
    if (on) { await this.grab(); await this.sh('refresh on'); } else await this.sh('refresh off');
    c.live = on; this.emit('screen');
  }
  touch(x, y) { if (!this.s.run) this.sh(`touch ${x} ${y}`, { prio: 0 }).catch(() => { }); }
  release() { if (!this.s.run) this.sh('release', { prio: 0 }).catch(() => { }); }
}

/* ---------- симулятор tinySA ---------- */
class SimSaLink extends Emitter {
  constructor() { super(); this.kind = 'sim'; this.name = 'Демо'; this.parser = { feed() { }, flush() { } }; this.line = ''; this.tok = 0; this.live = false; this.k = 0; }
  async open() { } abort() { }
  async close() { this.tok++; clearInterval(this.timer); }
  out(x) { this.parser.feed(typeof x === 'string' ? enc.encode(x) : x); }
  async send(data) {
    const s = typeof data === 'string' ? data : dec.decode(data);
    for (const ch of s) { if (ch === '\r') { const l = this.line; this.line = ''; this.exec(l.trim()); } else if (ch >= ' ') this.line += ch; }
  }
  regionMsg(kind, x, y, w, hh, body) {
    const o = new Uint8Array(14 + body.length + 4); o.set(enc.encode(kind + '\r\n')); new DataView(o.buffer).setInt16(6, x, true);
    const dv = new DataView(o.buffer); dv.setInt16(8, y, true); dv.setInt16(10, w, true); dv.setInt16(12, hh, true);
    o.set(body, 14); o.set(SA_PROMPT, 14 + body.length); this.out(o);
  }
  level(f) {
    let p = 10 ** (-10.6 + rnd(.25));
    for (const [fc, lv, bw] of [[98.5e6, -48, 3e5], [433.92e6, -36, 2e5], [868.3e6, -62, 2e5], [1.5754e9, -92, 2e6], [2.412e9, -58, 9e6], [2.437e9, -66, 9e6], [5.2e9, -71, 2e7]]) { const d = (f - fc) / Math.max(bw, this.rbw); p += 10 ** (lv / 10) * Math.exp(-d * d * 2); }
    return 10 * Math.log10(p);
  }
  frame() {
    const o = new Uint8Array(SA_W * SA_H * 2), put = (x, y, c) => { if (x >= 0 && x < SA_W && y >= 0 && y < SA_H) { o[(y * SA_W + x) * 2] = c >> 8; o[(y * SA_W + x) * 2 + 1] = c & 255; } };
    for (let y = 8; y < 296; y++) for (let x = 30; x < 480; x++) if ((x - 30) % 45 === 0 || (y - 8) % 32 === 0) put(x, y, 0x4208);
    this.rbw = 6e5;
    for (let x = 30; x < 480; x++) { const v = this.level((x - 30) / 450 * 800e6), y = Math.round(8 + (-v - 10) * 2.9); for (let k = y; k < Math.min(296, y + 2); k++) put(x, k, 0xffe0); }
    return o;
  }
  async exec(l) {
    const a = l.split(/\s+/), tok = ++this.tok;
    this.out(l + '\r\n');
    if (a[0] === 'version') this.out('tinySA4_v1.4-demo\r\nHW Version:V0.5.4 (demo)\r\n');
    else if (a[0] === 'info') this.out('tinySA ULTRA+ ZS407\r\nСимулятор Пульта\r\n');
    else if (a[0] === 'zero') this.out('usage: zero {level}\r\n174dBm\r\n');
    else if (a[0] === 'sweep' && a.length === 1) this.out('0 800000000 450\r\n');
    else if (a[0] === 'vbat') this.out('4150 mV\r\n');
    else if (a[0] === 'rbw' && a[1]) this.rbwSet = a[1] === 'auto' ? 0 : +a[1] * 1000;
    else if (a[0] === 'refresh') {
      this.live = a[1] === 'on'; clearInterval(this.timer);
      if (this.live) this.timer = setInterval(() => {
        const b = new Uint8Array(60 * 12 * 2); for (let i = 0; i < b.length; i += 2) { const on = ((i / 2 % 60) + this.k) % 12 < 6; b[i] = on ? 0x07 : 0; b[i + 1] = on ? 0xe0 : 0; }
        this.k++; this.regionMsg('bulk', 410, 300, 60, 12, b); this.regionMsg('fill', 2, 300, 8, 8, this.k & 1 ? [0xf8, 0] : [0, 0x1f]);
      }, 300);
    } else if (a[0] === 'touch' && this.live) this.regionMsg('fill', clamp(+a[1] - 3, 0, SA_W - 6), clamp(+a[2] - 3, 0, SA_H - 6), 6, 6, [0xff, 0xff]);
    else if (a[0] === 'capture') { await sleep(120); this.out(this.frame()); }
    else if (a[0] === 'scanraw') {
      const f0 = +a[1], f1 = +a[2], n = +a[3] || 450, step = Math.fround(Math.floor((f1 - f0) / n));
      this.rbw = this.rbwSet || Math.max(200, Math.min(850e3, step * 2));
      const perTick = Math.max(1, Math.round(16 / (.28 + 2000 / this.rbw)));              // как у прибора: с узким RBW точка идёт дольше
      this.out('{');
      for (let i = 0; i < n;) {
        const m = Math.min(perTick, n - i), o = new Uint8Array(m * 3);
        for (let k = 0; k < m; k++, i++) { const v = Math.round((this.level(f0 + Math.floor(Math.fround(step * i))) + 174) * 32); o[k * 3] = 0x78; o[k * 3 + 1] = v & 255; o[k * 3 + 2] = v >> 8; }
        this.out(o); await sleep(16);
        if (tok !== this.tok) return;                    // пришла другая команда: скан прерван
      }
      this.out('}');
    }
    this.out('ch> ');
  }
}

/* ---------- окна ---------- */
const fmtHz = f => fmtSI(f, 'Hz', 7).replace(/\.?0+ /, ' ');
const SA_PAL = palLut([[0, [6, 8, 40]], [.3, [20, 70, 190]], [.55, [30, 190, 190]], [.75, [240, 220, 60]], [1, [235, 50, 40]]]);

WM.define('sa-spectrum', {
  title: 'Анализатор спектра tinySA', dev: 'sa', devName: 'tinySA', w: 920, h: 600,
  make(win, dev, cfg) {
    const c = dev.s;
    cfg.top ??= -10; cfg.div ??= 10; cfg.wf ??= true; cfg.marks ??= true;
    const box = h('div', { class: 'chart' }), tip = h('div', { class: 'tip', hidden: true }), prog = h('i', { class: 'fill' }), status = h('span', { class: 'note' }), hint = h('span', { class: 'note' });
    const freqIn = (k, label) => { const i = h('input', { class: 'sa-f', 'aria-label': label, spellcheck: 'false', onchange: () => { const v = parseSI(i.value); if (Number.isFinite(v)) k === 'start' ? dev.setRange(v, c.stop) : dev.setRange(c.start, v); ui(); } }); return i; };
    const fa = freqIn('start', 'Начальная частота'), fb = freqIn('stop', 'Конечная частота');
    const ptsList = h('datalist', { id: 'saPts' + Math.random().toString(36).slice(2, 7) }, ...SA_POINTS.map(n => h('option', { value: n })));
    const pts = h('input', { class: 'sa-n', type: 'number', min: 2, max: 1000000, list: ptsList.id, 'aria-label': 'Число точек', onchange: () => { dev.setPoints(+pts.value); ui(); } });
    const rbw = select(SA_RBW, c.rbw, v => dev.set('rbw', v), 'Полоса RBW');
    const att = select([['auto', 'Авто'], ...[0, 5, 10, 15, 20, 25, 30].map(v => [v, v + ' дБ'])], c.att, v => dev.set('att', v), 'Аттенюатор');
    const lna = toggle('МШУ', !!c.lna, v => dev.set('lna', v ? 1 : 0));
    const go = h('button', { class: 'btn primary', onclick: () => c.run ? dev.halt() : dev.run(false) });
    const one = h('button', { class: 'btn', onclick: () => dev.run(true) }, 'Один проход');
    const hold = toggle('Макс', !!c.hold, v => dev.set('hold', v));
    const avg = select([[0, 'Без усреднения'], [4, 'Среднее 4'], [16, 'Среднее 16'], [64, 'Среднее 64']], c.avg, v => dev.set('avg', +v), 'Усреднение');
    const wfB = toggle('Водопад', cfg.wf, v => { cfg.wf = v; dirty = true; WM.save(); });
    const mkB = toggle('Пики', cfg.marks, v => { cfg.marks = v; dirty = true; WM.save(); });
    const top = stepper(cfg.top, v => v + ' dBm', d => { cfg.top = clamp(cfg.top + d * cfg.div, -150, 30); top.set(cfg.top); dirty = true; WM.save(); }, 'Верх шкалы');
    const div = select(DB_DIV.map(v => [v, v + ' дБ/дел']), cfg.div, v => { cfg.div = +v; dirty = true; WM.save(); }, 'Цена деления');
    const full = h('button', { class: 'btn', title: 'Вернуть прежнюю полосу', onclick: () => { const b = backs.pop(); if (b) { dev.setRange(b[0], b[1]); ui(); } } }, 'Назад');
    const csv = h('button', { class: 'btn', onclick: saveCsv }, 'CSV');
    win.body.append(h('div', { class: 'col' },
      h('div', { class: 'row wrap pad' }, go, one, field('От', fa), field('До', fb), field('Точек', pts, ptsList), field('RBW', rbw), field('Аттенюатор', att), lna, hold, avg, wfB, mkB, field('Верх', top), div, full, csv),
      h('div', { class: 'bargraph thin' }, prog), h('div', { class: 'row wrap pad', style: { paddingTop: 0, paddingBottom: 0 } }, status, hint), h('div', { class: 'chart-wrap' }, box, tip)));
    const p = new Plot(box); let dirty = true, seen = -1, hover = null, drag = null, wfSeen = -1; const backs = [];
    const wf = h('canvas', { width: 1024, height: 240 }), wg = wf.getContext('2d'), wrow = wg.createImageData(1024, 1), w32 = new Uint32Array(wrow.data.buffer);
    wg.fillStyle = '#060828'; wg.fillRect(0, 0, 1024, 240);
    function ui() {
      go.textContent = c.run ? 'Стоп' : 'Пуск'; go.classList.toggle('danger', c.run); one.disabled = c.run;
      if (document.activeElement !== fa) fa.value = fmtHz(c.start); if (document.activeElement !== fb) fb.value = fmtHz(c.stop);
      if (document.activeElement !== pts) pts.value = c.points;
      rbw.value = c.rbw; att.value = c.att; lna.set(!!c.lna); hold.set(!!c.hold); avg.value = c.avg;
      const step = Math.floor((c.stop - c.start) / c.points);
      hint.textContent = c.rbw === 'auto' && step < 150e3 ? 'RBW «Авто» при шаге ' + fmtHz(step) + ' выбирает узкий фильтр, и скан идёт медленно. Для скорости задайте RBW 850 или 600 кГц.' : '';
      dirty = true;
    }
    function stat() {
      const g = c.geo; prog.style.width = c.run && g ? c.n / g.n * 100 + '%' : '0';
      status.textContent = g ? `Точек ${c.n} из ${g.n} · шаг ${fmtHz(g.step)} · проход ${(c.sweepMs / 1000).toFixed(c.sweepMs < 10000 ? 2 : 0)} с · ${Math.round(c.pps)} точек/с · проходов ${c.sweeps}` : 'Нажмите «Пуск».';
    }
    ui(); win.sub(dev, 'cfg', ui); win.sub(dev, 'scan', ui); win.sub(Bus, 'theme', () => { dirty = true; });
    function saveCsv() {
      const g = c.geo, t = c.trace; if (!g) return;
      const r = ['Частота, Гц;Уровень, dBm' + (dev.maxT ? ';Макс, dBm' : '') + (dev.avgT ? ';Среднее, dBm' : '')];
      for (let i = 0; i < g.n; i++) if (!Number.isNaN(t[i])) r.push(dev.fAt(i, g) + ';' + t[i].toFixed(2) + (dev.maxT ? ';' + dev.maxT[i].toFixed(2) : '') + (dev.avgT ? ';' + dev.avgT[i].toFixed(2) : ''));
      saveFile(`tinysa-${stamp()}.csv`, '﻿' + r.join('\n'), 'text/csv');
    }
    const L = 54, R = 10, T = 6, B = 20;
    const geom = () => { const W = p.w, H = p.h, ph = cfg.wf ? Math.round((H - T - B) * .62) : H - T - B; return { W, H, pw: Math.max(10, W - L - R), ph, wy: T + ph + B, wh: Math.max(0, H - T - ph - B - 4) }; };
    const fOfX = x => { const g = c.geo || c, q = geom(); return g.start + (x - L) / q.pw * ((c.geo ? g.step * g.n : c.stop - c.start)); };
    box.addEventListener('pointermove', e => { const r = box.getBoundingClientRect(); hover = { x: e.clientX - r.left, y: e.clientY - r.top }; dirty = true; });
    box.addEventListener('pointerleave', () => { hover = null; tip.hidden = true; dirty = true; });
    box.addEventListener('pointerdown', e => { if (!c.geo) return; const r = box.getBoundingClientRect(); drag = { x0: e.clientX - r.left }; box.setPointerCapture(e.pointerId); });
    box.addEventListener('pointerup', e => {
      if (!drag) return; const r = box.getBoundingClientRect(), x1 = e.clientX - r.left, x0 = drag.x0; drag = null; dirty = true;
      if (Math.abs(x1 - x0) < 12) return;
      const a = fOfX(clamp(Math.min(x0, x1), L, p.w - R)), b = fOfX(clamp(Math.max(x0, x1), L, p.w - R));
      if (b - a >= c.points) { backs.push([c.start, c.stop]); dev.setRange(a, b); ui(); }
    });
    box.addEventListener('dblclick', () => full.click());
    function cols(t, n, pw, cnt = n) {                     // максимум в каждом столбце пикселей
      const o = new Float32Array(pw).fill(NaN);
      for (let i = 0; i < cnt; i++) { const v = t[i]; if (v !== v) continue; const k = Math.min(pw - 1, i * pw / n | 0); if (!(o[k] >= v)) o[k] = v; }
      return o;
    }
    function line(g, o, Y, color, wdt) {
      g.strokeStyle = color; g.lineWidth = wdt; g.lineJoin = 'round'; g.beginPath(); let pen = false;
      for (let k = 0; k < o.length; k++) { const v = o[k]; if (v !== v) { continue; } const y = Y(v); if (pen) g.lineTo(L + k + .5, y); else g.moveTo(L + k + .5, y); pen = true; }
      g.stroke();
    }
    function draw() {
      const g = p.g, col = Theme.colors, q = geom(), { W, H, pw, ph } = q, lo = cfg.top - cfg.div * 10;
      g.clearRect(0, 0, W, H); g.font = FONT(10);
      const Y = v => T + clamp((cfg.top - v) / (cfg.top - lo), 0, 1) * ph;
      for (let d = 0; d <= 10; d++) { const y = Math.round(T + d / 10 * ph) + .5; g.strokeStyle = col.grid; g.beginPath(); g.moveTo(L, y); g.lineTo(L + pw, y); g.stroke(); g.fillStyle = col.ink3; g.textAlign = 'right'; g.fillText(String(cfg.top - d * cfg.div), L - 5, y + 3); }
      const geo = c.geo, f0 = geo ? geo.start : c.start, f1 = geo ? geo.start + geo.step * geo.n : c.stop, X = f => L + (f - f0) / (f1 - f0) * pw;
      g.textAlign = 'center';
      for (const f of niceTicks(f0, f1, Math.max(3, pw / 110 | 0))) { const x = Math.round(X(f)) + .5; if (x < L || x > L + pw) continue; g.strokeStyle = col.grid; g.beginPath(); g.moveTo(x, T); g.lineTo(x, T + ph); g.stroke(); g.fillStyle = col.ink3; g.fillText(fmtHz(f), clamp(x, L + 30, L + pw - 30), T + ph + 14); }
      g.strokeStyle = col.line; g.strokeRect(L + .5, T + .5, pw, ph);
      if (!geo || !c.trace) { g.fillStyle = col.ink3; g.textAlign = 'left'; g.font = FONT(12); g.fillText('Задайте полосу и число точек, затем «Пуск»', L + 12, T + 24); return; }
      g.save(); g.beginPath(); g.rect(L, T, pw, ph); g.clip();
      const cur = cols(c.trace, geo.n, pw);
      if (dev.maxT) line(g, cols(dev.maxT, geo.n, pw), Y, col.t[1], 1);
      line(g, cur, Y, dev.avgT ? col.ink3 : col.t[0], dev.avgT ? 1 : 1.5);
      if (dev.avgT) line(g, cols(dev.avgT, geo.n, pw), Y, col.t[0], 1.5);
      if (c.run && c.n < geo.n) { const x = L + c.n / geo.n * pw; g.strokeStyle = col.accent; g.lineWidth = 1; g.beginPath(); g.moveTo(x + .5, T); g.lineTo(x + .5, T + ph); g.stroke(); }
      if (drag && hover) { g.fillStyle = col.accent; g.globalAlpha = .18; g.fillRect(Math.min(drag.x0, hover.x), T, Math.abs(hover.x - drag.x0), ph); g.globalAlpha = 1; }
      g.restore();
      if (cfg.marks && c.peaks.length) {
        g.font = FONT(10, 600); g.textAlign = 'center';
        c.peaks.forEach((m, k) => { const x = X(m.f), y = Y(m.v); g.fillStyle = col.t[2] || col.accent; g.beginPath(); g.moveTo(x, y - 3); g.lineTo(x - 4, y - 10); g.lineTo(x + 4, y - 10); g.fill(); g.fillText(String(k + 1), x, Math.max(T + 9, y - 13)); });
        g.textAlign = 'right'; g.font = FONT(11);
        c.peaks.forEach((m, k) => { g.fillStyle = col.ink2; g.fillText(`${k + 1}  ${fmtHz(m.f)}  ${m.v.toFixed(1)} dBm`, L + pw - 8, T + 16 + k * 14); });
      }
      if (cfg.wf && q.wh > 20) {
        if (wfSeen !== c.sweeps && c.sweeps) {
          wfSeen = c.sweeps; wg.drawImage(wf, 0, 1);
          const o = cols(dev.avgT || c.trace, geo.n, 1024);
          for (let k = 0; k < 1024; k++) w32[k] = SA_PAL[clamp(Math.round((o[k] - lo) / (cfg.top - lo) * 255), 0, 255) || 0];
          wg.putImageData(wrow, 0, 0);
        }
        g.imageSmoothingEnabled = false; g.drawImage(wf, 0, 0, 1024, Math.min(240, q.wh), L, q.wy, pw, q.wh); g.strokeStyle = col.line; g.strokeRect(L + .5, q.wy + .5, pw, q.wh);
      }
      if (hover && !drag && hover.x >= L && hover.x <= L + pw && hover.y < T + ph) {
        const k = clamp(Math.round(hover.x - L), 0, pw - 1), v = cur[k], f = fOfX(hover.x);
        g.strokeStyle = col.ink3; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(hover.x + .5, T); g.lineTo(hover.x + .5, T + ph); g.stroke(); g.setLineDash([]);
        tip.replaceChildren(h('div', {}, 'Частота', h('b', { text: fmtHz(Math.round(f)) })), h('div', {}, 'Уровень', h('b', { text: v === v ? v.toFixed(1) + ' dBm' : 'нет данных' })));
        tip.hidden = false; tip.style.left = Math.min(hover.x + 12, W - 190) + 'px'; tip.style.top = Math.min(hover.y + 10, H - 60) + 'px';
      } else tip.hidden = true;
    }
    return { tick() { if (seen !== dev.rev) { seen = dev.rev; dirty = true; stat(); } if (dirty) { dirty = false; draw(); } }, dispose() { p.dispose(); } };
  },
});

WM.define('sa-screen', {
  title: 'Экран tinySA', dev: 'sa', devName: 'tinySA', w: 560, h: 460,
  make(win, dev, cfg) {
    const c = dev.s;
    const cv = h('canvas', { width: SA_W, height: SA_H, class: 'lcd', title: 'Нажатия и перетаскивание передаются на экран прибора', style: { touchAction: 'none' } }), ctx = cv.getContext('2d');
    const bar = h('i', { class: 'fill' }), note = h('p', { class: 'note' });
    const live = toggle('Трансляция', c.live, v => dev.mirror(v).catch(e => { errToast(e); live.set(c.live); }));
    const shot = h('button', { class: 'btn', onclick: () => dev.capture(f => { bar.style.width = f * 100 + '%'; }).catch(errToast).finally(() => { bar.style.width = '0'; }) }, 'Снимок');
    const png = h('button', { class: 'btn', onclick: () => cv.toBlob(b => saveFile(`tinysa-${stamp()}.png`, b, 'image/png')) }, 'PNG');
    const xy = e => { const r = cv.getBoundingClientRect(); return [clamp(Math.round((e.clientX - r.left) / r.width * SA_W), 0, SA_W - 1), clamp(Math.round((e.clientY - r.top) / r.height * SA_H), 0, SA_H - 1)]; };
    let down = false, last = 0;
    cv.addEventListener('pointerdown', e => { down = true; cv.setPointerCapture(e.pointerId); dev.touch(...xy(e)); last = performance.now(); });
    cv.addEventListener('pointermove', e => { if (down && performance.now() - last > 60) { last = performance.now(); dev.touch(...xy(e)); } });
    const up = () => { if (down) { down = false; dev.release(); } };
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
    const ui = () => { live.set(c.live); note.textContent = c.run ? 'Идёт скан с компьютера: трансляция и нажатия приостановлены до его остановки.' : c.live ? 'Прибор присылает только изменившиеся области экрана.' : 'Включите трансляцию или снимите один кадр.'; };
    ui(); win.sub(dev, 'screen', ui); win.sub(dev, 'scan', ui);
    win.body.append(h('div', { class: 'col pad' }, h('div', { class: 'row wrap' }, live, shot, png), h('div', { class: 'bargraph thin' }, bar), note, h('div', { class: 'lcd-wrap' }, cv)));
    let seen = -1;
    return { tick() { if (seen !== dev.scrRev) { seen = dev.scrRev; ctx.putImageData(dev.screen, 0, 0); } } };
  },
});

WM.define('sa-settings', {
  title: 'Настройки tinySA', dev: 'sa', devName: 'tinySA', w: 440, h: 560,
  make(win, dev, cfg) {
    const c = dev.s, log = h('div', { class: 'cons-log', role: 'log', style: { flex: 'none', height: '5.6em', overflow: 'auto' } });
    const add = (cls, t) => { log.append(h('div', { class: cls, text: t })); log.scrollTop = 1e9; while (log.childElementCount > 200) log.firstChild.remove(); };
    const send = cmd => { if (c.run) dev.halt(); add('c-in', cmd); return dev.sh(cmd).then(r => { add(r ? 'c-rx' : 'c-ok', r || 'выполнено'); return r; }).catch(e => add('c-err', e.message)); };
    const btn = (t, cmd, title) => h('button', { class: 'btn', title, onclick: () => send(typeof cmd === 'function' ? cmd() : cmd) }, t);
    const num = (label, def, mk, hint) => { const i = h('input', { class: 'sa-n', value: def, title: hint, 'aria-label': label, onchange: () => { const v = parseSI(i.value); if (Number.isFinite(v)) send(mk(v)); } }); return field(label, i); };
    const sel = (label, list, mk, get) => { const s = select(list, get ? get() : list[0][0], v => { const cmd = mk(v); if (cmd) send(cmd); }, label); if (get) win.sub(dev, 'cfg', () => { s.value = get(); }); return field(label, s); };
    const own = (k, f = v => v) => v => { dev.set(k, f(v)); add('c-in', `${k === 'att' ? 'attenuate' : k} ${v}`); return null; };
    const sec = (title, ...kids) => h('fieldset', { class: 'sa-set' }, h('legend', { text: title }), h('div', { class: 'row wrap' }, ...kids));
    const inp = h('input', { class: 'cons-in', style: { flex: 'none' }, placeholder: 'Команда оболочки, например help', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Команда tinySA', onkeydown: e => { if (e.key === 'Enter' && inp.value.trim()) { send(inp.value.trim()); inp.value = ''; } } });
    win.body.append(h('div', { class: 'col pad' }, h('div', { class: 'scroll' },
      sec('Режим', sel('Работа', [['low input', 'Анализатор'], ['low output', 'Генератор']], v => 'mode ' + v), btn('Пауза', 'pause'), btn('Продолжить', 'resume'), btn('Полоса как в Пульте', () => `sweep ${c.start} ${c.stop}`, 'Задать на экране прибора ту же полосу')),
      sec('Приём', sel('RBW', SA_RBW, own('rbw'), () => c.rbw), sel('Аттенюатор', [['auto', 'Авто'], ...[0, 5, 10, 15, 20, 25, 30].map(v => [v, v + ' дБ'])], own('att'), () => c.att),
        sel('МШУ', [['off', 'Выкл'], ['on', 'Вкл']], own('lna', v => v === 'on' ? 1 : 0), () => c.lna ? 'on' : 'off'), sel('Подавление помех', [['auto', 'Авто'], ['on', 'Вкл'], ['off', 'Выкл']], own('spur'), () => c.spur),
        num('Время прохода, с', '0', v => 'sweeptime ' + v, '0.003..60'), num('Внешнее усиление, дБ', '0', v => 'ext_gain ' + v, '-100..100'), sel('Калибратор', [['off', 'Выкл'], [30, '30 МГц'], [15, '15 МГц'], [10, '10 МГц'], [4, '4 МГц'], [3, '3 МГц'], [2, '2 МГц'], [1, '1 МГц']], v => 'caloutput ' + v)),
      sec('Генератор', sel('Выход', [['off', 'Выкл'], ['on', 'Вкл']], v => 'output ' + v), num('Частота', '10M', v => 'freq ' + Math.round(v)), num('Уровень, dBm', '-30', v => 'level ' + v), sel('Модуляция', [['off', 'Нет'], ['am', 'AM'], ['nfm', 'Узкая FM'], ['wfm', 'Широкая FM']], v => 'modulation ' + v)),
      sec('Память и прибор', sel('Загрузить набор', [0, 1, 2, 3, 4].map(v => [v, v ? 'Набор ' + v : 'Стартовый']), v => 'load ' + v), sel('Сохранить набор', [0, 1, 2, 3, 4].map(v => [v, v ? 'Набор ' + v : 'Стартовый']), v => 'save ' + v), btn('Батарея', 'vbat'), btn('Версия', 'version'), btn('Самопроверка', 'selftest 0', 'Соедините вход с калибратором'), btn('Перезагрузка', 'reset')),
        h('p', { class: 'note', text: 'Остальные меню прибора доступны в окне «Экран tinySA» с трансляцией. Команда из этого окна останавливает скан с компьютера.' })), log, inp));
    return {};
  },
});
