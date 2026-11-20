'use strict';
/* ALIENTEK EL15 (ATK-EL15), электронная нагрузка 62 В / 12,3 А / 153 Вт, с прошивкой 4.3.1
   (веб-консоль el15.airgo140.ru). Строки SCPI с \r\n: USB CDC (COM-порт, 115200) и BLE UART
   (служба FFF0: уведомления FFF2, запись FFF3). Протокол взят из веб-консоли этой прошивки:
     MEAS:ALL?  24 поля: V, I, P, R, T, Ah, Wh, с, вход, -, режим, уставка, авария, 4W,
                блокировка, вентилятор %, OVP, OCP, OPP, OTP, UVP, Von, DCR мОм, внешний датчик °C
     SYST:SET?  30 полей: уставки CC/CV/CR/CP, таймер, разряд, DCR, DYN, SCAN, LIST, тест БП, экран
     CAL:ADC? n x0,x1,x2,y0,y1,y2 и отрезки; CAL:TRIM n,g,off: таблица = заводская·g + off
     CAL:PNT ch,k,x,y / CAL:PNT ch,n / CAL:PNT? ch (прошивка 4.6.0): до 8 точек на канал
       (0 = U 2W, 1 = U 4W, 2 = I), кусочно-линейная поправка поверх таблиц, хранится в приборе
   До 4.5.2 поправка жила в ОЗУ прибора, и Пульт записывал её снова при каждом подключении.
   С 4.5.2 прибор хранит её сам (заводские таблицы не трогаются), и Пульт её не переписывает.
   Вход в загрузчик (SYST:DFU) и правка заводских таблиц отсюда не посылаются. */

const EL15_BASIC = {
  CC: { cmd: 'CURR', unit: 'A', name: 'Ток', min: 0, max: 12, dec: 3, steps: [1, .1, .01, .001], step: .01, presets: [.1, .25, .5, 1, 2, 3, 5, 10] },
  CV: { cmd: 'VOLT', unit: 'V', name: 'Напряжение', min: .1, max: 60, dec: 3, steps: [1, .1, .01, .001], step: .1, presets: [3.3, 4.2, 5, 9, 12, 15, 20, 24] },
  CR: { cmd: 'RES', unit: 'Ω', name: 'Сопротивление', min: .1, max: 7500, dec: 1, steps: [100, 10, 1, .1], step: 1, presets: [1, 2, 5, 10, 20, 50, 100, 500] },
  CP: { cmd: 'POW', unit: 'W', name: 'Мощность', min: 0, max: 250, dec: 2, steps: [10, 1, .1, .01], step: 1, presets: [1, 5, 10, 25, 50, 100, 150, 200, 250] },
};
const EL15_MODE_NAMES = { CC: 'CC, ток', CV: 'CV, напряжение', CR: 'CR, сопротивление', CP: 'CP, мощность', BAT: 'разряд АКБ', DCR: 'внутреннее сопротивление', DT: 'динамика', PSU: 'тест БП', OCP: 'тест БП', LIST: 'список', SCAN: 'скан', LED: 'LED', MPPT: 'MPPT', TRIP: 'время срабатывания', MENU: 'меню прибора', SET: 'меню прибора', INFO: 'меню прибора' };
const EL15_FAULTS = ['', 'OCP: перегрузка по току', 'OVP: перенапряжение', 'OPP: перегрузка по мощности', 'OTP: перегрев', 'UVP: напряжение отсечки', 'таймер истёк', 'обратная полярность', 'циклы закончились', 'источник ушёл в защиту'];
/* Блоки калибровки АЦП: 8 у первой ревизии платы, 4 у второй. */
const EL15_CAL_BLOCKS = {
  8: ['Напряжение 2W (SC1641)', 'Напряжение 2W, быстрый АЦП', 'Напряжение 4W (SC1641)', 'Напряжение 4W, быстрый АЦП', 'Ток, канал 1 (SC1641)', 'Ток, канал 2 (SC1641)', 'Ток, канал 1, быстрый АЦП', 'Ток, канал 2, быстрый АЦП'],
  4: ['Напряжение 2W', 'Напряжение 4W', 'Ток, канал 1', 'Ток, канал 2'],
};
/* Какой блок калибруется для величины: напряжение 2W, 4W и ток (канал 1). */
const el15CalIdx = (hw, what) => hw === 4 ? { v2: 0, v4: 1, i: 2 }[what] : { v2: 0, v4: 2, i: 4 }[what];
/* Версия прошивки "4.6.0" -> 40600. */
const el15Ver = fw => { const m = String(fw || '').match(/(\d+)\.(\d+)\.(\d+)/); return m ? m[1] * 10000 + m[2] * 100 + +m[3] : 0; };
/* Поправка по точкам [[x, y], ...] (x по возрастанию), как в прошивке 4.6.0: крайние отрезки
   продолжаются, одна точка — сдвиг, ровно 0 остаётся 0, отрицательное — 0. И обратная к ней. */
const EL15_PNT_CH = { v2: 0, v4: 1, i: 2 };
/* 4.7.0: частота АЦП (преобразований в секунду) и сколько это измерений U+I в секунду. */
const EL15_BUF_MAX = 22;
const EL15_RATES = [[40, '40 — 20 изм./с, как с завода'], [90, '90 — 45 изм./с'], [180, '180 — 90 изм./с'], [350, '350 — 175 изм./с'], [660, '660 — 330 изм./с'], [1200, '1200 — 600 изм./с'], [2000, '2000 — 1000 изм./с']];
function el15Pwl(P, v) {
  if (!P?.length || v === 0 || !Number.isFinite(v)) return v;
  if (P.length === 1) return Math.max(0, v + P[0][1] - P[0][0]);
  let k = 0; while (k < P.length - 2 && v >= P[k + 1][0]) k++;
  const [x0, y0] = P[k], [x1, y1] = P[k + 1];
  return Math.max(0, y0 + (v - x0) * (y1 - y0) / (x1 - x0));
}
function el15PwlInv(P, c) {
  if (!P?.length || c === 0 || !Number.isFinite(c)) return c;
  if (P.length === 1) return c - (P[0][1] - P[0][0]);
  let k = 0; while (k < P.length - 2 && c >= P[k + 1][1]) k++;
  const [x0, y0] = P[k], [x1, y1] = P[k + 1];
  return x0 + (c - y0) * (x1 - x0) / (y1 - y0);
}
/* Те же проверки, что делает прибор при CAL:PNT ch,n (иначе он ответит ошибкой -222). */
function el15PntCheck(P, unit) {
  for (let k = 0; k < P.length; k++) {
    const [x, y] = P[k];
    if (!(Math.abs(y - x) <= .05 * Math.abs(x) + .05)) return `точка ${fmtSI(x, unit, 5)}: эталон отличается больше чем на 5 % + 0,05`;
    if (k) {
      const [px, py] = P[k - 1], dx = x - px, s = (y - py) / dx;
      if (!(dx >= .001)) return `точки ${fmtSI(px, unit, 5)} и ${fmtSI(x, unit, 5)} слишком близко (нужно не меньше 0,001)`;
      if (!(s >= .8 && s <= 1.25)) return `между ${fmtSI(px, unit, 5)} и ${fmtSI(x, unit, 5)} наклон ${s.toFixed(3)} (допустимо 0,8…1,25)`;
    }
  }
  return '';
}
const EL15_BAT = { liion: ['Li-ion', 3.0, 4.2], lifepo4: ['LiFePO4', 2.5, 3.65], lihv: ['Li-ion HV', 3.1, 4.35], nimh: ['NiMH', 1.0, 1.42], pb: ['Свинцовый', 1.75, 2.15] };
const el15f = (v, d) => Number.isFinite(v) ? v.toFixed(d) : '–';

class EL15 extends Device {
  static probe(idn) { return /EL15/i.test(idn); }
  id = 'el15'; title = 'EL15';
  /* Ответ — следующая строка после запроса. Прибор может прислать строку и сам (ошибку,
     сообщение), поэтому старое из приёмника выбрасываем перед каждым запросом. */
  q(cmd, { timeout = 1500, prio = 1 } = {}) {
    return this.link.run(async () => {
      this.link.tr.abort?.();
      await this.link.tx(cmd + '\r');
      const s = dec.decode(await this.link.rx(timeout)).trim();
      this.link.log?.('rx', s);
      return s;
    }, prio);
  }
  w(cmd) { return this.link.write(cmd + '\r'); }
  async start() {
    const c = this.s;
    Object.assign(c, { pollMs: store.get('el15.poll', 100), live: null, rev: 0, set: {}, stat: {}, log: { en: 0, ms: 1000, n: 0, max: 8000 }, rate: 0, rec: false });
    this.curve = []; this.logPts = null;
    const D = [['v', 'Напряжение', 'V'], ['i', 'Ток', 'A'], ['p', 'Мощность', 'W'], ['r', 'Сопротивление нагрузки', 'Ω'], ['ah', 'Ёмкость', 'Ah'], ['wh', 'Энергия', 'Wh'],
      ['t', 'Температура транзисторов', '°C'], ['ext', 'Внешний датчик', '°C'], ['fan', 'Вентилятор', '%'], ['dcr', 'Внутреннее сопротивление (DCR)', 'Ω'], ['set', 'Уставка', '']];
    for (const [k, name, unit] of D) Hub.define({ id: 'el15.' + k, name, unit, dev: this.id, group: 'Нагрузка', digits: 6 });
    this.restoreCustom();
    this.alive = true;
    await this.readSettings();
    await this.applySavedCal();
    if (this.hasBuf) {
      try {
        c.adcRate = +(await this.q('MEAS:RATE?')) || 40;
        for (let k = 0; k < 60 && (await this.drainBuf(false)) >= EL15_BUF_MAX; k++);
      } catch (e) { this.fail(e); }
    }
    this.loop();
  }
  parseMeas(csv) {
    const f = csv.split(',');
    if (f.length < 23) return null;
    const n = k => parseFloat(f[k]), x = parseFloat(f[23]);
    return {
      v: n(0), i: n(1), p: n(2), r: n(3), t: n(4), ah: n(5), wh: n(6), sec: n(7) | 0, on: +f[8] === 1, mode: (f[10] || 'CC').trim(), setp: n(11), fault: n(12) | 0,
      kelvin: +f[13] === 1, lock: +f[14] === 1, fan: clamp(n(15) || 0, 0, 100), ovp: n(16), ocp: n(17), opp: n(18), otp: n(19), uvp: n(20), von: n(21), dcr: n(22),
      ext: Number.isFinite(x) && x > -100 && x <= 150 ? x : NaN,
    };
  }
  async measure() {
    const L = this.parseMeas(await this.q('MEAS:ALL?', { timeout: 900 }));
    if (!L) return null;
    const c = this.s, now = performance.now();
    c.live = L; c.rev++;
    /* С 4.7.0 U, I и P идут из буфера прибора: каждое измерение со своим временем. */
    if (this.hasBuf) await this.drainBuf(true);
    for (const k of this.hasBuf ? ['ah', 'wh', 't', 'fan'] : ['v', 'i', 'p', 'ah', 'wh', 't', 'fan']) Hub.push('el15.' + k, L[k], now);
    Hub.push('el15.r', L.i > .0005 && L.r < 9999 ? L.r : NaN, now);
    Hub.push('el15.ext', L.ext, now);
    Hub.push('el15.dcr', L.dcr > 0 ? L.dcr / 1000 : NaN, now);
    const sq = Hub.q.get('el15.set'); const b = EL15_BASIC[L.mode]; if (sq) sq.unit = b ? b.unit : '';
    Hub.push('el15.set', L.setp, now);
    if (c.rec && (L.on || c.recAll)) this.curve.push({ t: Date.now(), v: L.v, i: L.i, p: L.p, ah: L.ah, wh: L.wh, r: L.r, temp: L.t });
    if (L.fault && L.fault !== c.lastFault) toast(`EL15: ${EL15_FAULTS[L.fault] || 'авария ' + L.fault}`, 'bad', 7000);
    c.lastFault = L.fault;
    this.emit('live');
    return L;
  }
  async loop() {
    const c = this.s; let n = 0, last = performance.now(), got = 0, special = 0;
    while (this.alive) {
      const t0 = performance.now();
      try {
        if (await this.measure()) got++;
        const m = c.live?.mode;
        if (t0 - special >= 550) { special = t0; await this.pollStat(m); }
        if (++n % 8 === 0) await this.logStat();
        if (this.state !== 'ok') { this.state = 'ok'; this.emit('state'); }
        if (t0 - last >= 1000) { c.rate = got / ((t0 - last) / 1000); c.sps = ((c.bufN || 0) - (c.bufN0 || 0)) / ((t0 - last) / 1000); c.bufN0 = c.bufN || 0; got = 0; last = t0; this.emit('rate'); }
        await this.pollCustom(t0);
      } catch (e) { if (!this.alive) return; this.fail(e); await sleep(400); }
      const min = this.link.tr.kind === 'bt' ? 150 : 0;
      await sleep(Math.max(0, Math.max(min, c.pollMs) - (performance.now() - t0)));
    }
  }
  /* Состояние особых режимов: опрашивается, только пока режим включён в приборе или окне. */
  async pollStat(m) {
    const st = this.s.stat, want = new Set([m, ...(this.watch || [])]);
    const ask = async (k, cmd) => { const r = await this.q(cmd, { timeout: 700 }).catch(() => null); if (r) { st[k] = r.split(',').map(x => x.trim()); this.emit('stat'); } };
    if (want.has('LED')) await ask('led', 'LED:STAT?');
    if (want.has('MPPT')) await ask('mppt', 'MPPT:STAT?');
    if (want.has('TRIP')) await ask('trip', 'TRIP:RES?');
    if (want.has('BAT')) await ask('bat', 'BAT:STAT?');
    if (want.has('PSU') || want.has('OCP')) await ask('ocp', 'OCP:RES?');
  }
  /* Все настройки разом (SYST:SET?, защиты, список) */
  async readSettings() {
    const c = this.s, s = c.set;
    try {
      const f = (await this.q('SYST:SET?')).split(',').map(x => x.trim());
      if (f.length >= 30) {
        const n = k => parseFloat(f[k]);
        Object.assign(s, {
          CC: n(0), CV: n(1), CR: n(2), CP: n(3), timOn: +f[4] === 1, timSec: n(5) | 0, batI: n(6), batCut: n(7), dcrI1: n(8), dcrI2: n(9),
          dynIa: n(10), dynTa: n(11) / 1000, dynIb: n(12), dynTb: n(13) / 1000, dynCyc: n(14) | 0, dynInf: +f[15] === 1,
          scanIl: n(16), scanIh: n(17), scanRise: n(18) | 0, scanFall: n(19) | 0, scanCyc: n(20) | 0, listCyc: n(21) | 0, listInf: +f[22] === 1,
          psuStart: n(23), psuRated: n(24), psuStop: n(25), psuStep: n(26), bright: n(27) | 0, beep: n(28) | 0, scrOff: n(29) | 0,
        });
      }
      await this.measure();
      const one = async (k, cmd, fn) => { const r = await this.q(cmd, { timeout: 800 }).catch(() => null); if (r !== null && r !== '' && !r.startsWith('-')) s[k] = fn(r); };
      await one('crcc', 'SYST:CRCC?', r => +r !== 0);
      await one('eotp', 'PROT:EOTP?', r => parseFloat(r));
      await one('eotpOn', 'PROT:EOTP:STAT?', r => +r === 1);
      await one('soft', 'SYST:SOFT?', r => parseInt(r, 10) || 0);
      await one('wdt', 'SYST:WDT?', r => parseInt(r, 10) || 0);
      const l = await this.q('LIST:ALL?').catch(() => '');
      s.list = [];
      for (const it of l.split(',')) { const [k, en, i, us] = it.split(':'); if (+k >= 0 && +k < 10) s.list[+k] = { en: +en === 1, i: parseFloat(i) || 0, ms: (parseInt(us, 10) || 100000) / 1000 }; }
      for (let k = 0; k < 10; k++) s.list[k] ??= { en: k < 4, i: .5 * (k + 1), ms: 250 };
      await this.psuResult();
      await this.logStat();
      this.emit('set');
    } catch (e) { this.fail(e); }
  }
  async psuResult() {
    const r = await this.q('MEAS:PSU?').catch(() => '');
    const f = r.split(',').map(parseFloat);
    if (f.length >= 8) this.s.stat.psu = f;
    const o = await this.q('OCP:RES?').catch(() => '');
    if (o.split(',').length >= 6) this.s.stat.ocp = o.split(',').map(x => x.trim());
    this.emit('stat');
  }
  async cmd(s) { await this.w(s); }
  /* Основные режимы: уставка и включение */
  async setBasic(m, val) {
    const b = EL15_BASIC[m]; val = clamp(Math.round(val * 1000) / 1000, b.min, b.max);
    this.s.set[m] = val;
    await this.w(this.s.live?.mode === m ? `${b.cmd} ${val.toFixed(b.dec)}` : `FUNC ${m};${b.cmd} ${val.toFixed(b.dec)}`);
    if (this.s.live) this.s.live.mode = m;
  }
  async input(on, mode) {
    if (!on) { await this.w('INP OFF'); return; }
    const m = this.s.live?.mode;
    await this.w(mode && mode !== m ? `FUNC ${mode};INP ON` : 'INP ON');
  }
  /* Журнал прибора */
  async logStat() {
    const r = await this.q('LOG:STAT?', { timeout: 800 }).catch(() => '');
    const f = r.split(',').map(x => parseInt(x, 10));
    if (f.length >= 4) { Object.assign(this.s.log, { en: f[0], ms: f[1] || 1000, n: f[2] || 0, max: f[3] || 8000 }); this.emit('log'); }
  }
  async logPull(progress) {
    await this.logStat();
    const { n, ms } = this.s.log, pts = [];
    for (let off = 0; off < n; off += 16) {
      const take = Math.min(16, n - off), r = await this.q(`LOG:DATA? ${off},${take}`, { timeout: 2000 });
      if (!r) break;
      r.split(';').forEach((x, k) => { const p = x.split(',').map(parseFloat); if (p.length >= 4) pts.push({ t: (off + k) * ms / 1000, v: p[0], i: p[1], p: p[2], temp: p[3] }); });
      progress?.(Math.min(n, off + take), n);
    }
    let ah = 0, wh = 0;
    pts.forEach((x, k) => { if (k) { const a = pts[k - 1], dt = (x.t - a.t) / 3600; ah += (x.i + a.i) / 2 * dt; wh += (x.p + a.p) / 2 * dt; } x.ah = ah; x.wh = wh; x.r = x.i > .0005 ? x.v / x.i : NaN; });
    this.logPts = pts; this.emit('logpts');
    return pts;
  }
  /* Калибровка АЦП */
  async readCal() {
    const st = (await this.q('CAL:STAT?')).split(',').map(Number);
    if (st.length < 7) throw new Error('Прибор не ответил на CAL:STAT?: нужна прошивка 4.3.1');
    const cal = { hw: st[0] || 8, user: !!st[1], kelvin: !!st[2], dual: !!st[3], dacRatio: st[6], act: [], fac: [] };
    const blk = r => { const f = r.split(',').map(Number); return f.length >= 11 ? { idx: f[0], x: [f[1], f[2], f[3]], y: [f[4], f[5], f[6]], off01: f[7], s01: f[8], off12: f[9], s12: f[10] } : null; };
    for (let i = 0; i < cal.hw; i++) { cal.act[i] = blk(await this.q(`CAL:ADC? ${i}`)); cal.fac[i] = blk(await this.q(`CAL:ADC:FACT? ${i}`)); }
    cal.dac = await this.q('CAL:DAC?').catch(() => ''); cal.dacFac = await this.q('CAL:DAC:FACT?').catch(() => '');
    if (this.hasPnt) cal.pnt = await this.readPnts();
    this.cal = cal; this.emit('cal');
    return cal;
  }
  /* Поправка блока относительно заводской таблицы: активная = заводская·g + off. */
  trimOf(i) {
    const a = this.cal?.act[i], f = this.cal?.fac[i];
    if (!a || !f || Math.abs(f.s01) < 1e-9) return [1, 0];
    const g = a.s01 / f.s01; return [g, a.y[0] - f.y[0] * g];
  }
  async setTrim(i, g, off) {
    if (!(g >= .85 && g <= 1.15) || !(Math.abs(off) <= 5)) throw new Error(`Поправка вне допустимого: усиление ${g.toFixed(5)} (0,85…1,15), смещение ${off.toFixed(5)} (±5)`);
    await this.w(`CAL:TRIM ${i},${g.toFixed(6)},${off.toFixed(5)}`);
    const saved = this.savedCal(); saved.trims[i] = [g, off]; saved.at = new Date().toISOString(); store.set(this.calKey, saved);
  }
  get calKey() { return 'el15.cal.' + (this.serial || 'el15'); }
  savedCal() { return store.get(this.calKey, null) || { auto: true, trims: {} }; }
  /* 4.7.0: каждое измерение АЦП попадает в буфер прибора (1024 штуки), MEAS:BUF? отдаёт
     накопленное: seq,n,t0,t1;U,I;U,I... (не больше 22 за ответ, t — мс часов прибора).
     Время точек — часы прибора плюс смещение к часам Пульта, взятое по свежим ответам. */
  get hasBuf() { return el15Ver(this.fw) >= 40700; }
  async drainBuf(push = true) {
    const c = this.s;
    let n = 0;
    for (let k = 0; k < 12; k++) {
      const r = await this.q('MEAS:BUF?', { timeout: 900 }), now = performance.now();
      const [head, ...S] = r.split(';'), h = head.split(',').map(Number), [seq, cnt, t0, t1] = h;
      if (!(cnt >= 0 && cnt <= EL15_BUF_MAX) || S.length !== cnt) throw new Error('MEAS:BUF?: непонятный ответ');
      if (c.bufSeq != null && seq > c.bufSeq) c.bufLost = (c.bufLost || 0) + seq - c.bufSeq;
      c.bufSeq = seq + cnt; n = cnt;
      if (!cnt) return 0;
      const est = now - t1;
      if (cnt < EL15_BUF_MAX) c.tickOff = c.tickOff == null || est < c.tickOff || est - c.tickOff > 500 ? est : c.tickOff + .02 * (est - c.tickOff);
      if (push) {
        const off = c.tickOff ?? est;
        for (let j = 0; j < cnt; j++) {
          const [v, i] = S[j].split(',').map(Number);
          const t = Math.max(off + (cnt > 1 ? t0 + (t1 - t0) * j / (cnt - 1) : t1), (c.bufT || 0) + .01);
          c.bufT = t; c.bufN = (c.bufN || 0) + 1;
          Hub.push('el15.v', v, t); Hub.push('el15.i', i, t); Hub.push('el15.p', v * i, t);
        }
      }
      if (cnt < EL15_BUF_MAX) return cnt;
    }
    return n;
  }
  async setAdcRate(sps) { await this.w(`MEAS:RATE ${sps}`); const r = +(await this.q('MEAS:RATE?')); this.s.adcRate = r; if (r !== +sps) throw new Error(`прибор оставил ${r}`); return r; }
  /* С 4.5.2 поправка хранится в приборе, с 4.6.0 есть 8 точек на канал. */
  get calInFlash() { return el15Ver(this.fw) >= 40502; }
  get hasPnt() { return el15Ver(this.fw) >= 40600; }
  async readPnt(ch) {
    const f = (await this.q(`CAL:PNT? ${ch}`)).split(',').map(Number), n = f[0];
    if (!(n >= 0 && n <= 8) || f.length < 1 + 2 * n) throw new Error(`CAL:PNT? ${ch}: непонятный ответ`);
    return Array.from({ length: n }, (_, k) => [f[1 + 2 * k], f[2 + 2 * k]]);
  }
  async readPnts() { this.pnt = []; for (let ch = 0; ch < 3; ch++) this.pnt[ch] = await this.readPnt(ch); return this.pnt; }
  /* Точки по одной (строка команды в приборе не длиннее 160 символов), затем фиксация:
     прибор сортирует, проверяет, применяет и сохраняет. После каждой — SYST:ERR?. */
  async writePnt(ch, P) {
    const err = async what => { const e = await this.q('SYST:ERR?'); if (!/^[+]?0\b/.test(e)) throw new Error(`${what}: прибор ответил ${e}`); };
    await this.q('SYST:ERR?');
    for (let k = 0; k < P.length; k++) { await this.w(`CAL:PNT ${ch},${k},${P[k][0].toFixed(6)},${P[k][1].toFixed(6)}`); await err(`точка ${k + 1}`); }
    await this.w(`CAL:PNT ${ch},${P.length}`); await err('запись точек');
    const back = await this.readPnt(ch);
    if (back.length !== P.length) throw new Error(`прибор вернул ${back.length} точек вместо ${P.length}`);
    (this.pnt ??= [])[ch] = back;
    const s = this.savedCal(); (s.pnt ??= [])[ch] = back; s.at = new Date().toISOString(); store.set(this.calKey, s);
    return back;
  }
  async applySavedCal() {
    if (this.calInFlash) return;
    const s = store.get(this.calKey, null);
    if (!s?.auto || !Object.keys(s.trims || {}).length) return;
    try {
      for (const [i, [g, off]] of Object.entries(s.trims)) await this.w(`CAL:TRIM ${i},${(+g).toFixed(6)},${(+off).toFixed(5)}`);
      this.calApplied = true;
      toast('EL15: калибровка из Пульта записана в прибор', 'ok');
    } catch (e) { this.fail(e); }
  }
  windows() { return ['el15-main', 'el15-modes', 'el15-curve', 'el15-prot', 'el15-log', 'el15-cal', 'trend', 'console']; }
}

/* ---------- симулятор EL15: лабораторный БП 12 В с защитой 3,2 А, аккумулятор в режиме разряда,
   солнечная панель в MPPT. Свои погрешности измерения, чтобы калибровка в демо что-то меняла. ---------- */
class SimEL15 extends SimBase {
  constructor() {
    super();
    Object.assign(this, { mode: 'CC', on: false, kelvin: 0, lock: 0, fault: 0, ah: 0, wh: 0, sec: 0, temp: 27, fan: 0, last: performance.now(), t0: 0, ext: 24.5, dcr: 0, latch: 0 });
    this.set = { CC: .5, CV: 5, CR: 10, CP: 10 };
    this.prot = { ovp: 62, ocp: 12.3, opp: 255, otp: 90, uvp: 0, von: 0, eotp: 60, eotpOn: 0 };
    this.p = { timOn: 0, timSec: 3600, batI: 1, batCut: 3, batTim: 3600, batTimOn: 0, tail: 0, iend: .1, dcrI1: .1, dcrI2: 1, dynIa: .5, dynTa: 100000, dynIb: 2, dynTb: 100000, dynCyc: 1000, dynInf: 0, scanIl: .5, scanIh: 2, scanRise: 1000, scanFall: 1000, scanCyc: 100, scanInf: 0, listCyc: 100, listInf: 0, psuStart: .2, psuRated: 1, psuStop: 5, psuStep: .1, psuDwell: 250, psuVt: 0, ledVo: 12, ledIo: 1, ledRd: .2, mpptI0: .5, mpptStep: .02, mpptDwell: 200, mpptVmin: 3, tripI: 3, tripVt: 1, tripTmax: 10000, tripBlank: 25, bright: 7, beep: 1, scrOff: 0, crcc: 1, soft: 0, wdt: 0 };
    this.list = Array.from({ length: 10 }, (_, k) => ({ en: k < 4 ? 1 : 0, i: .5 * (k + 1), us: 250000 }));
    this.log = { en: 0, ms: 1000, pts: [], next: 0 };
    this.trim = {}; this.pnt = [[], [], []]; this.pntEdit = [[], [], []]; this.err = 0; this.bat = 0; this.psuTrip = 0; this.mppt = { run: 0, i: .5, pmax: 0, vmp: 0, imp: 0, dir: 1, t: 0, pPrev: 0 }; this.trip = { st: 'IDLE', ms: 0, ip: 0, vt: 0 };
    this.ocp = { st: 0, vnl: 0, ih: 0, vh: 0, it: 0, pm: 0, i: 0, t: 0 }; this.psu = [0, 0, 0, 0, 0, 0, 0, 0];
    this.true = { v: 12, i: 0 };
    SimWorld.el15 = this;
  }
  /* Источник: напряжение на клеммах при токе I. */
  src(I) {
    if (this.mode === 'BAT') { const soc = clamp(1 - this.batAh() / 2.6, 0, 1); return 3.0 + 1.15 * soc ** .8 - .045 * I; }
    if (this.mode === 'MPPT' || this.mode === 'SCAN' && this.p.scanIh < 3) return Math.max(0, 21.4 + 1.7 * Math.log(Math.max(1e-6, 1 - I / 2.6)));
    if (this.psuTrip) return .05;
    return Math.max(0, 12.02 - .085 * I);
  }
  batAh() { return this.ah - this.bat; }
  trueV() { this.step(); return this.true.v; }
  trueI() { this.step(); return this.true.i; }
  solve(fn) {           // ток, при котором fn(I) меняет знак: от 0 до предела источника
    let lo = 0, hi = 12.3;
    if (fn(lo) <= 0) return 0;
    if (fn(hi) > 0) return hi;
    for (let k = 0; k < 40; k++) { const m = (lo + hi) / 2; if (fn(m) > 0) lo = m; else hi = m; }
    return lo;
  }
  want(t) {
    const p = this.p;
    switch (this.mode) {
      case 'CC': return { cc: this.set.CC };
      case 'CV': return { cv: this.set.CV };
      case 'CR': return { cr: this.set.CR };
      case 'CP': return { cp: this.set.CP };
      case 'BAT': return { cc: this.batCv ? Math.max(p.iend, this.batI) : p.batI };
      case 'DT': { const per = (p.dynTa + p.dynTb) / 1e6, ph = (t % per) / per; return { cc: ph < p.dynTa / 1e6 / per ? p.dynIa : p.dynIb }; }
      case 'SCAN': { const per = (p.scanRise + p.scanFall) / 1000, x = t % per, k = x < p.scanRise / 1000 ? x / (p.scanRise / 1000) : 1 - (x - p.scanRise / 1000) / (p.scanFall / 1000); return { cc: p.scanIl + (p.scanIh - p.scanIl) * k }; }
      case 'LIST': { const st = this.list.filter(s => s.en); if (!st.length) return { cc: 0 }; const per = st.reduce((a, s) => a + s.us / 1e6, 0); let x = t % per; for (const s of st) { if (x < s.us / 1e6) return { cc: s.i }; x -= s.us / 1e6; } return { cc: 0 }; }
      case 'LED': { const vf = p.ledVo * (1 - p.ledRd), rd = p.ledRd * p.ledVo / p.ledIo; return { led: [vf, rd] }; }
      case 'MPPT': return { cc: this.mppt.i };
      case 'TRIP': return { cc: p.tripI };
      case 'PSU': case 'OCP': return { cc: this.ocp.i };
      case 'DCR': return { cc: t < .5 ? p.dcrI1 : p.dcrI2 };
      default: return { cc: 0 };
    }
  }
  step() {
    const now = performance.now(), dt = Math.min(1, (now - this.last) / 1000); this.last = now;
    const t = (now - this.t0) / 1000, p = this.p;
    let I = 0, V = this.src(0);
    if (this.on && !this.fault) {
      const w = this.want(t);
      if (w.cc !== undefined) I = Math.min(w.cc, this.solve(i => this.src(i) - .02));
      else if (w.cv !== undefined) I = this.src(0) > w.cv ? this.solve(i => this.src(i) - w.cv) : 0;
      else if (w.cr !== undefined) I = this.solve(i => this.src(i) - i * w.cr);
      else if (w.cp !== undefined) I = this.solve(i => i * this.src(i) < w.cp ? 1 : -1);
      else if (w.led) I = this.solve(i => this.src(i) - (w.led[0] + i * w.led[1]));
      V = this.src(I);
      if (this.mode !== 'BAT' && this.mode !== 'MPPT' && I > 3.2 && !this.psuTrip) { this.overT = (this.overT || 0) + dt; if (this.overT > .05) this.psuTrip = 1; } else this.overT = 0;
      this.sec += dt; this.ah += I * dt / 3600; this.wh += I * V * dt / 3600;
      if (this.mode === 'BAT') {
        if (V < p.batCut && !p.tail) { this.on = false; this.fault = 5; }
        if (p.tail && V < p.batCut) { this.batCv = 1; this.batI = Math.max(0, (this.batI ?? p.batI) - .5 * dt); if (this.batI < p.iend) { this.on = false; this.fault = 5; } }
        if (p.batTimOn && this.sec > p.batTim) { this.on = false; this.fault = 6; }
      }
      if (p.timOn && this.mode in EL15_BASIC && this.sec > p.timSec) { this.on = false; this.fault = 6; }
      if (this.mode === 'DCR' && t > 1) { this.dcr = 85 + rnd(.5); this.on = false; }
      if (V * I > this.prot.opp) { this.on = false; this.fault = 3; }
      if (V > this.prot.ovp) { this.on = false; this.fault = 2; }
      this.mpptTick(V, I, now); this.tripTick(V, I, t); this.ocpTick(V, I, now);
    } else if (!this.on) this.psuTrip = 0;
    const P = V * I;
    this.temp += ((26 + P * .42) - this.temp) * Math.min(1, dt / 25);
    this.fan = clamp(Math.round((this.temp - 35) * 3), 0, 100);
    this.true = { v: V, i: I };
    if (this.log.en && now >= this.log.next && this.log.pts.length < 8000) { this.log.next = now + this.log.ms; this.log.pts.push([V, I, P, this.temp]); }
  }
  mpptTick(V, I, now) {
    const m = this.mppt; if (this.mode !== 'MPPT' || !m.run || now - m.t < this.p.mpptDwell) return;
    m.t = now; const P = V * I;
    if (P < m.pPrev) m.dir = -m.dir;
    m.pPrev = P; m.i = clamp(m.i + m.dir * this.p.mpptStep, 0, 12);
    if (V < this.p.mpptVmin) { m.dir = -1; m.i = Math.max(0, m.i - 2 * this.p.mpptStep); }
    if (P > m.pmax) Object.assign(m, { pmax: P, vmp: V, imp: I });
  }
  tripTick(V, I, t) {
    const r = this.trip; if (this.mode !== 'TRIP' || r.st !== 'RUNNING') return;
    r.ip = Math.max(r.ip, I);
    if (t * 1000 > this.p.tripBlank && V < this.p.tripVt) { Object.assign(r, { st: 'TRIPPED', ms: t * 1000, vt: V }); this.on = false; }
    else if (t * 1000 > this.p.tripTmax) { Object.assign(r, { st: 'TIMEOUT', ms: t * 1000 }); this.on = false; }
  }
  ocpTick(V, I, now) {
    const o = this.ocp, p = this.p; if (o.st !== 1 || now - o.t < p.psuDwell) return;
    o.t = now;
    if (V < Math.max(p.psuVt, .5)) { Object.assign(o, { st: 2, it: o.i }); this.on = false; this.psu = [o.vnl, this.src(p.psuRated), p.psuRated, o.ih, o.vh, o.pm, (o.vnl - this.src(p.psuRated)) / o.vnl * 100, o.it]; return; }
    Object.assign(o, { ih: I, vh: V, pm: Math.max(o.pm, V * I) });
    if (o.i >= p.psuStop) { o.st = 3; this.on = false; this.psu = [o.vnl, this.src(p.psuRated), p.psuRated, o.ih, o.vh, o.pm, (o.vnl - this.src(p.psuRated)) / o.vnl * 100, 0]; return; }
    o.i = Math.min(p.psuStop, o.i + p.psuStep);
  }
  /* Показания с погрешностями прибора и пользовательской поправкой блока. */
  rd(v, blk, gain, off) { const [g, o] = this.trim[blk] || [1, 0]; return (v * gain + off) * g + o; }
  run(m) { this.mode = m; this.on = true; this.fault = 0; this.t0 = performance.now(); this.sec = 0; }
  meas() {
    this.step();
    const { v, i } = this.true, k = this.kelvin;
    const V = el15Pwl(this.pnt[k ? 1 : 0], this.rd(v - (k ? 0 : i * .012), k ? 2 : 0, k ? .9978 : 1.0031, k ? -.002 : .006) + rnd(4e-4)),
      I = el15Pwl(this.pnt[2], this.rd(i, 4, .9952, .0021 * (i > 0)) + rnd(1e-4) * (i > 0)), P = V * I;
    const pr = this.prot;
    return [V, I, P, I > .0005 ? V / I : 9999.9, this.temp, this.ah, this.wh, this.sec | 0, this.on ? 1 : 0, 0, this.mode, this.mode in EL15_BASIC ? this.set[this.mode] : 0, this.fault, k, this.lock, this.fan, pr.ovp, pr.ocp, pr.opp, pr.otp, pr.uvp, pr.von, this.dcr, this.ext + rnd(.05)]
      .map(x => typeof x === 'number' ? +x.toFixed(5) : x).join(',');
  }
  cmd(c) {
    const m = c.match(/^:?(\S+)\s*(.*)$/); if (!m) return null;
    const hd = m[1].toUpperCase(), arg = m[2].trim(), q = hd.endsWith('?'), k = hd.replace(/\?$/, ''), num = parseFloat(arg), a = arg.split(',').map(parseFloat), p = this.p, pr = this.prot;
    const set = (o, key, v = num) => { o[key] = v; return null; };
    switch (k) {
      case '*IDN': return 'ALIENTEK,ATK-EL15,EL15-DEMO-0001,4.7.0';
      case 'MEAS:RATE': if (q) return String(this.adcRate || 40); if (!EL15_RATES.some(([r]) => r === num)) { this.err = -222; return null; } this.adcRate = num; return null;
      case 'MEAS:BUF': {
        /* Измерения с частотой АЦП/2 с момента прошлого запроса, не больше 1024 в запасе. */
        const now = performance.now(), per = 2000 / (this.adcRate || 40);
        this.buf ??= []; this.bufSeq ??= 0; this.bufT ??= now;
        while (this.bufT + per <= now) { this.bufT += per; const m = this.meas().split(','); this.buf.push([this.bufSeq++, Math.round(this.bufT) >>> 0, +m[0], +m[1]]); }
        if (this.buf.length > 1024) this.buf.splice(0, this.buf.length - 1024);
        const b = this.buf.splice(0, EL15_BUF_MAX), seq = b.length ? b[0][0] : this.bufSeq;
        return [[seq, b.length, ...(b.length ? [b[0][1], b[b.length - 1][1]] : [])].join(','), ...b.map(x => `${x[2].toFixed(5)},${x[3].toFixed(5)}`)].join(';');
      }
      case 'SYST:ERR': { const e = this.err; this.err = 0; return e ? `${e},"Error"` : '0,"No error"'; }
      case 'MEAS:ALL': return this.meas();
      case 'FUNC': if (q) return this.mode; this.mode = arg.toUpperCase(); if (this.mode === 'OCP') this.mode = 'PSU'; this.t0 = performance.now(); return null;
      case 'INP': if (/^(ON|1)$/i.test(arg)) { if (!this.on) this.run(this.mode); if (this.mode === 'BAT') { this.bat = this.ah; this.batI = p.batI; this.batCv = 0; } } else { this.on = false; this.mppt.run = 0; if (this.ocp.st === 1) this.ocp.st = 0; } return null;
      case 'CURR': return set(this.set, 'CC'); case 'VOLT': return set(this.set, 'CV'); case 'RES': return set(this.set, 'CR'); case 'POW': return set(this.set, 'CP');
      case 'SYST:SENS': this.kelvin = /4W/i.test(arg) ? 1 : 0; return null;
      case 'SYST:LOCK': this.lock = num ? 1 : 0; return null;
      case 'PROT:CLE': this.fault = 0; this.psuTrip = 0; return null;
      case 'BAT:CLE': this.ah = this.wh = this.sec = 0; return null;
      case 'SYST:SET': return [this.set.CC, this.set.CV, this.set.CR, this.set.CP, p.timOn, p.timSec, p.batI, p.batCut, p.dcrI1, p.dcrI2, p.dynIa, p.dynTa, p.dynIb, p.dynTb, p.dynCyc, p.dynInf, p.scanIl, p.scanIh, p.scanRise, p.scanFall, p.scanCyc, p.listCyc, p.listInf, p.psuStart, p.psuRated, p.psuStop, p.psuStep, p.bright, p.beep, p.scrOff].join(',');
      case 'TIM:STAT': return set(p, 'timOn'); case 'TIM:DUR': return set(p, 'timSec');
      case 'PROT:OVP': return set(pr, 'ovp'); case 'PROT:OCP': return set(pr, 'ocp'); case 'PROT:OPP': return set(pr, 'opp'); case 'PROT:OTP': return set(pr, 'otp');
      case 'PROT:EOTP': if (q) return String(pr.eotp); return set(pr, 'eotp');
      case 'PROT:EOTP:STAT': if (q) return String(pr.eotpOn); return set(pr, 'eotpOn');
      case 'VOLT:UVP': return set(pr, 'uvp'); case 'VOLT:ON': return set(pr, 'von');
      case 'SYST:CRCC': if (q) return String(p.crcc); return set(p, 'crcc');
      case 'SYST:SOFT': if (q) return String(p.soft); return set(p, 'soft');
      case 'SYST:WDT': if (q) return String(p.wdt); return set(p, 'wdt');
      case 'SYST:BRIGHT': return set(p, 'bright'); case 'SYST:BEEP': return set(p, 'beep'); case 'SYST:SCROFF': return set(p, 'scrOff');
      case 'SYST:AHIC': case 'SYST:FAN:MIN': case 'SYST:FAN:TEMP': case 'SYST:SAVE': case 'SYST:BEEP:IMM': return null;
      case 'SYST:REST': this.set = { CC: .5, CV: 5, CR: 10, CP: 10 }; return null;
      case 'BAT:CURR': return set(p, 'batI'); case 'BAT:CUT': return set(p, 'batCut'); case 'BAT:TIM': return set(p, 'batTim'); case 'BAT:TIM:STAT': return set(p, 'batTimOn');
      case 'BAT:TAIL': return set(p, 'tail'); case 'BAT:IEND': return set(p, 'iend');
      case 'BAT:STAT': return `${p.tail},${this.batCv ? 1 : 0},${(this.batI ?? p.batI).toFixed(3)}`;
      case 'DCR:CURR1': return set(p, 'dcrI1'); case 'DCR:CURR2': return set(p, 'dcrI2');
      case 'DCR:RUN': this.run('DCR'); return null;
      case 'DYN:IA': return set(p, 'dynIa'); case 'DYN:TA': return set(p, 'dynTa'); case 'DYN:IB': return set(p, 'dynIb'); case 'DYN:TB': return set(p, 'dynTb'); case 'DYN:CYC': return set(p, 'dynCyc'); case 'DYN:INF': return set(p, 'dynInf');
      case 'SCAN:IL': return set(p, 'scanIl'); case 'SCAN:IH': return set(p, 'scanIh'); case 'SCAN:RISE': return set(p, 'scanRise'); case 'SCAN:FALL': return set(p, 'scanFall'); case 'SCAN:CYC': return set(p, 'scanCyc'); case 'SCAN:INF': return set(p, 'scanInf');
      case 'LIST:STEP': if (a[0] >= 0 && a[0] < 10) this.list[a[0]] = { en: a[1] ? 1 : 0, i: a[2], us: a[3] }; return null;
      case 'LIST:CYC': return set(p, 'listCyc'); case 'LIST:INF': return set(p, 'listInf');
      case 'LIST:ALL': return this.list.map((s, i) => `${i}:${s.en}:${s.i.toFixed(3)}:${s.us}`).join(',');
      case 'LED:VO': return set(p, 'ledVo'); case 'LED:IO': return set(p, 'ledIo'); case 'LED:RD': return set(p, 'ledRd');
      case 'LED:STAT': { const vf = p.ledVo * (1 - p.ledRd), rd = p.ledRd * p.ledVo / p.ledIo; return [p.ledVo, p.ledIo, p.ledRd, vf.toFixed(3), rd.toFixed(3)].join(','); }
      case 'MPPT:ISTART': return set(p, 'mpptI0'); case 'MPPT:ISTEP': return set(p, 'mpptStep'); case 'MPPT:DWELL': return set(p, 'mpptDwell'); case 'MPPT:VMIN': return set(p, 'mpptVmin');
      case 'MPPT:RUN': Object.assign(this.mppt, { run: 1, i: p.mpptI0, pmax: 0, vmp: 0, imp: 0, dir: 1, pPrev: 0 }); this.run('MPPT'); return null;
      case 'MPPT:STOP': this.mppt.run = 0; this.on = false; return null;
      case 'MPPT:STAT': { const x = this.mppt; return `${x.run},${x.i.toFixed(3)},${x.pmax.toFixed(3)},${x.vmp.toFixed(3)},${x.imp.toFixed(3)}`; }
      case 'TRIP:ITEST': return set(p, 'tripI'); case 'TRIP:VTRIG': return set(p, 'tripVt'); case 'TRIP:TMAX': return set(p, 'tripTmax'); case 'TRIP:BLANK': return set(p, 'tripBlank');
      case 'TRIP:RUN': this.trip = { st: 'RUNNING', ms: 0, ip: 0, vt: 0 }; this.run('TRIP'); return null;
      case 'TRIP:STOP': this.trip.st = 'IDLE'; this.on = false; return null;
      case 'TRIP:RES': { const x = this.trip; return `${x.st},${x.ms.toFixed(1)},${x.ip.toFixed(3)},${x.vt.toFixed(3)}`; }
      case 'SHORT:CURR': case 'SHORT:TIME': return null;
      case 'SHORT:RUN': this.trip = { st: 'TRIPPED', ms: 100, ip: 3.2, vt: .05 }; return null;
      case 'PSU:START': return set(p, 'psuStart'); case 'PSU:RATED': return set(p, 'psuRated'); case 'PSU:STOP': return set(p, 'psuStop'); case 'PSU:STEP': return set(p, 'psuStep'); case 'PSU:DWEL': return set(p, 'psuDwell'); case 'PSU:VTRIG': return set(p, 'psuVt');
      case 'PSU:RUN': this.psuTrip = 0; Object.assign(this.ocp, { st: 1, vnl: this.src(0), ih: 0, vh: 0, it: 0, pm: 0, i: p.psuStart, t: performance.now() }); this.run('PSU'); return null;
      case 'OCP:ABORT': this.ocp.st = 0; this.on = false; return null;
      case 'OCP:RES': { const o = this.ocp; return [o.st, o.vnl, o.ih, o.vh, o.it, o.pm].map(x => +(+x).toFixed(4)).join(','); }
      case 'MEAS:PSU': return this.psu.map(x => +(+x).toFixed(4)).join(',');
      case 'LOG:STAT': return `${this.log.en},${this.log.ms},${this.log.pts.length},8000`;
      case 'LOG:STAR': this.log.en = 1; this.log.ms = num || this.log.ms; this.log.next = 0; return null;
      case 'LOG:STOP': this.log.en = 0; return null;
      case 'LOG:INT': this.log.ms = num || 1000; return null;
      case 'LOG:CLE': this.log.pts = []; return null;
      case 'LOG:DATA': return this.log.pts.slice(a[0], a[0] + a[1]).map(x => x.map(v => v.toFixed(4)).join(',')).join(';');
      case 'CAL:STAT': return `8,${Object.keys(this.trim).length || this.pnt.some(P => P.length) ? 1 : 0},${this.kelvin},0,0,0,1.000000`;
      case 'CAL:PNT': {
        const ch = a[0];
        if (!(ch >= 0 && ch < 3)) { this.err = -222; return q ? '' : null; }
        if (q) { const P = this.pnt[ch | 0]; return [P.length, ...P.flat().map(x => x.toFixed(6))].join(','); }
        if (a.length === 4) { if (!(a[1] >= 0 && a[1] < 8)) { this.err = -222; return null; } this.pntEdit[ch | 0][a[1] | 0] = [a[2], a[3]]; return null; }
        if (a.length !== 2 || !(a[1] >= 0 && a[1] <= 8)) { this.err = a.length === 2 ? -222 : -108; return null; }
        const P = this.pntEdit[ch | 0].slice(0, a[1] | 0).map(p => p || [0, 0]).sort((x, y) => x[0] - y[0]);
        if (el15PntCheck(P, '')) { this.err = -222; return null; }
        this.pnt[ch | 0] = P; return null;
      }
      case 'CAL:ADC': case 'CAL:ADC:FACT': {
        const i = a[0] | 0, cur = i >= 4, x = cur ? [0, 2000, 12000] : [0, 6000, 62000], y = x.map(v => v / 1000), [g, o] = k === 'CAL:ADC' && this.trim[i] ? this.trim[i] : [1, 0];
        const yy = y.map(v => v * g + o), s01 = (yy[1] - yy[0]) / (x[1] - x[0]), s12 = (yy[2] - yy[1]) / (x[2] - x[1]);
        return [i, ...x, ...yy, yy[0], s01, yy[1] - s12 * x[1], s12].map(v => +(+v).toFixed(8)).join(',');
      }
      case 'CAL:DAC': case 'CAL:DAC:FACT': return '1.000000,0.00100,1.2000,1000.000,0.00100,12.000,1000.000,0.00500,30.000,500.000,0.00500,30.000,500.000';
      case 'CAL:TRIM': if (a[1] === 1 && a[2] === 0) delete this.trim[a[0] | 0]; else this.trim[a[0] | 0] = [a[1], a[2]]; return null;
      case 'CAL:REST': this.trim = {}; this.pnt = [[], [], []]; return null;
      default: return q ? '' : null;
    }
  }
}

/* ---------- окна EL15 ---------- */
const elIn = (value, on, o = {}) => {
  const e = h('input', { type: 'number', step: o.step ?? 'any', min: o.min, max: o.max, value: value ?? '', style: { width: (o.w || 84) + 'px' }, 'aria-label': o.label, onchange: () => on?.(parseFloat(String(e.value).replace(',', '.'))) });
  return e;
};
const elField = (label, input, unit) => field(label, h('span', { class: 'row' }, input, unit ? h('span', { class: 'note', text: unit }) : null));
const elStat = pairs => { const box = h('div', { class: 'stats' }), cells = {}; for (const [k, n] of pairs) { cells[k] = h('b', { text: '–' }); box.append(h('div', {}, h('span', { text: n }), cells[k])); } box.cells = cells; return box; };
const elHms = s => { s = Math.max(0, s | 0); return [s / 3600 | 0, (s % 3600) / 60 | 0, s % 60].map(n => String(n).padStart(2, '0')).join(':'); };

/* Форма параметров: [ключ, подпись, единица, {step, min, max, int}] в объекте obj. */
function elForm(defs, obj, onchange) {
  const box = h('div', { class: 'ctl-grid' }), ins = {};
  for (const [k, label, unit, o = {}] of defs) {
    ins[k] = elIn(obj[k], v => { if (!Number.isFinite(v)) return; obj[k] = o.int ? Math.round(v) : v; onchange?.(k); }, { ...o, label });
    box.append(elField(label, ins[k], unit));
  }
  box.set = () => { for (const [k] of defs) if (document.activeElement !== ins[k]) ins[k].value = obj[k] ?? ''; };
  return box;
}

/* ---------- Нагрузка: показания, режимы CC/CV/CR/CP, уставка, вход ---------- */
WM.define('el15-main', {
  title: 'EL15: нагрузка', dev: 'el15', devName: 'EL15', w: 600, h: 620,
  make(win, dev, cfg) {
    const c = dev.s, set = c.set;
    const cells = {}, big = h('div', { class: 'c2-big' });
    for (const [k, n] of [['v', 'Напряжение'], ['i', 'Ток'], ['p', 'Мощность']]) { cells[k] = h('b', { class: 'digits' }); big.append(h('div', { class: 'c2-cell' }, h('span', { text: n }), cells[k])); }
    const stats = elStat([['r', 'R'], ['t', 'Транзисторы'], ['ext', 'Датчик'], ['ah', 'Ёмкость'], ['wh', 'Энергия'], ['sec', 'Время'], ['fan', 'Вентилятор'], ['dcr', 'DCR'], ['rate', 'Опрос']]);
    const modeChip = h('span', { class: 'chip' }), faultChip = h('span', { class: 'chip bad', hidden: true });
    const sense = h('button', { class: 'btn', title: 'Где измерять напряжение: на клеммах (2W) или по отдельным проводам XT30 (4W)', onclick: () => dev.w(`SYST:SENS ${c.live?.kelvin ? '2W' : '4W'}`).catch(errToast) });
    const lock = h('button', { class: 'btn', title: 'Кнопки на самом приборе', onclick: () => dev.w(`SYST:LOCK ${c.live?.lock ? 0 : 1}`).catch(errToast) });
    cfg.mode ??= EL15_BASIC[c.live?.mode] ? c.live.mode : 'CC';
    const spec = () => EL15_BASIC[cfg.mode];
    const modeSeg = seg(Object.keys(EL15_BASIC).map(m => [m, m, EL15_BASIC[m].name]), cfg.mode, m => { cfg.mode = m; WM.save(); fill(); dev.w(`FUNC ${m}`).catch(errToast); }, 'Режим');
    const val = h('input', { type: 'number', step: 'any', class: 'el-set', 'aria-label': 'Уставка', onkeydown: e => { if (e.key === 'Enter') apply(); }, onchange: () => apply() });
    const unit = h('span', { class: 'note' });
    let step = null, timer = null, touched = 0;
    const steps = h('span', { class: 'row' }), presets = h('div', { class: 'row wrap' });
    const apply = () => { touched = performance.now(); const v = parseFloat(String(val.value).replace(',', '.')); if (Number.isFinite(v)) dev.setBasic(cfg.mode, v).catch(errToast); };
    const nudge = d => { touched = performance.now(); const s = spec(), v = clamp((parseFloat(val.value) || 0) + d * step, s.min, s.max); val.value = v.toFixed(s.dec); clearTimeout(timer); timer = setTimeout(apply, 150); };
    function fill() {
      const s = spec(); step = cfg.step?.[cfg.mode] ?? s.step;
      val.min = s.min; val.max = s.max; val.value = (set[cfg.mode] ?? s.min).toFixed(s.dec); unit.textContent = `${s.unit}, ${s.min}…${s.max}`;
      steps.replaceChildren(h('button', { class: 'btn', 'aria-label': 'Меньше', onclick: () => nudge(-1) }, '−'),
        seg(s.steps.map(x => [x, String(x).replace('.', ',')]), step, x => { step = +x; cfg.step = { ...cfg.step, [cfg.mode]: step }; WM.save(); }, 'Шаг'),
        h('button', { class: 'btn', 'aria-label': 'Больше', onclick: () => nudge(1) }, '+'));
      presets.replaceChildren(...s.presets.map(x => h('button', { class: 'tbtn', onclick: () => { val.value = x.toFixed(s.dec); apply(); } }, `${String(x).replace('.', ',')} ${s.unit}`)));
    }
    fill();
    val.addEventListener('wheel', e => { if (document.activeElement !== val) return; e.preventDefault(); nudge(e.deltaY < 0 ? 1 : -1); }, { passive: false });
    const onBtn = h('button', { class: 'btn primary el-on', onclick: () => { const on = !c.live?.on; dev.input(on, EL15_BASIC[c.live?.mode] ? cfg.mode : on ? cfg.mode : undefined).catch(errToast); } });
    const timOn = toggle('Таймер', !!set.timOn, v => { set.timOn = v; dev.w(`TIM:STAT ${v ? 1 : 0}`).catch(errToast); });
    const timSec = elIn(set.timSec || 3600, v => { if (v >= 1) { set.timSec = v | 0; dev.w(`TIM:DUR ${v | 0}`).catch(errToast); } }, { min: 1, max: 359999, step: 1, label: 'Время таймера', w: 90 });
    win.body.append(h('div', { class: 'col pad scroll' },
      h('div', { class: 'row wrap' }, modeChip, faultChip, h('span', { style: { flex: 1 } }), sense, lock),
      big, stats,
      h('div', { class: 'row wrap' }, modeSeg, h('span', { class: 'row' }, val, unit)),
      h('div', { class: 'row wrap' }, steps, onBtn), presets,
      h('div', { class: 'row wrap' }, timOn, timSec, h('span', { class: 'note', text: 'с, затем вход выключается' }), h('span', { style: { flex: 1 } }),
        h('button', { class: 'btn', onclick: () => dev.w('PROT:CLE').catch(errToast) }, 'Сбросить аварию'),
        h('button', { class: 'btn', onclick: () => dev.w('BAT:CLE').catch(errToast) }, 'Обнулить Ah и Wh')),
      h('p', { class: 'note', text: 'Колесо мыши над полем уставки меняет её на выбранный шаг. Особые режимы (разряд, список, MPPT и другие) в окне «Режимы EL15».' })));
    win.sub(dev, 'set', () => { if (document.activeElement !== val) fill(); timOn.set(!!set.timOn); timSec.value = set.timSec || 3600; });
    let rev = -1;
    return {
      tick() {
        const L = c.live; if (!L || rev === c.rev) return; rev = c.rev;
        cells.v.textContent = el15f(L.v, 4) + ' V'; cells.i.textContent = el15f(L.i, 4) + ' A'; cells.p.textContent = el15f(L.p, 3) + ' W';
        const s = stats.cells;
        s.r.textContent = L.i > .0005 && L.r < 9999 ? fmtSI(L.r, 'Ω', 4) : '∞'; s.t.textContent = el15f(L.t, 1) + ' °C'; s.ext.textContent = Number.isFinite(L.ext) ? el15f(L.ext, 1) + ' °C' : 'нет';
        s.ah.textContent = el15f(L.ah, 4) + ' Ah'; s.wh.textContent = el15f(L.wh, 3) + ' Wh'; s.sec.textContent = elHms(L.sec); s.fan.textContent = L.fan + ' %';
        s.dcr.textContent = L.dcr > 0 ? el15f(L.dcr, 1) + ' мОм' : '–'; s.rate.textContent = c.rate.toFixed(1) + '/с' + (dev.hasBuf ? `, измерений ${(c.sps || 0).toFixed(0)}/с${c.bufLost ? `, потеряно ${c.bufLost}` : ''}` : '');
        modeChip.textContent = `${EL15_MODE_NAMES[L.mode] || L.mode}${EL15_BASIC[L.mode] ? `, уставка ${L.setp} ${EL15_BASIC[L.mode].unit}` : ''}`;
        faultChip.hidden = !L.fault; faultChip.textContent = EL15_FAULTS[L.fault] || 'авария ' + L.fault;
        sense.textContent = L.kelvin ? 'Измерение 4W' : 'Измерение 2W'; lock.textContent = L.lock ? 'Кнопки заблокированы' : 'Кнопки свободны';
        onBtn.textContent = L.on ? 'Выключить вход' : 'Включить вход'; onBtn.classList.toggle('danger', L.on);
        if (EL15_BASIC[L.mode] && L.mode !== cfg.mode && document.activeElement !== val) { cfg.mode = L.mode; modeSeg.set(L.mode); fill(); }
        if (EL15_BASIC[L.mode] && document.activeElement !== val && performance.now() - touched > 1500 && Math.abs((set[L.mode] ?? NaN) - L.setp) > 5e-4) { set[L.mode] = L.setp; fill(); }
      },
    };
  },
});

/* ---------- Особые режимы ---------- */
const EL15_PANES = [['LIST', 'Список'], ['DT', 'Динамика'], ['SCAN', 'Скан'], ['BAT', 'Разряд АКБ'], ['DCR', 'DCR'], ['LED', 'LED'], ['MPPT', 'MPPT'], ['TRIP', 'Срабатывание'], ['PSU', 'Тест БП']];
WM.define('el15-modes', {
  title: 'EL15: режимы', dev: 'el15', devName: 'EL15', w: 640, h: 600,
  make(win, dev, cfg) {
    const c = dev.s, s = c.set;
    cfg.pane ??= 'LIST';
    cfg.loc ??= {};
    const L = cfg.loc;
    Object.entries({ ledVo: 12, ledIo: 1, ledRd: .2, mpptI0: .5, mpptStep: .02, mpptDwell: 200, mpptVmin: 3, tripI: 3, tripVt: 1, tripTmax: 10000, tripBlank: 25, shortI: 5, shortMs: 100,
      psuDwell: 250, psuVt: 0, batTim: 3600, batTimOn: 0, batTail: 0, batIend: .1, batChem: 'liion', batCells: 1, batRated: 2.5, scanInf: 0 }).forEach(([k, v]) => { L[k] ??= v; });
    const save = () => WM.save();
    const run = (cmds, rec) => { if (rec) { c.rec = true; dev.emit('rec'); } return dev.w(cmds).catch(errToast); };
    const panes = {};
    const tabs = seg(EL15_PANES, cfg.pane, k => { cfg.pane = k; save(); show(); }, 'Режим');
    const body = h('div', { class: 'col pad scroll' });
    win.body.append(h('div', { class: 'col' }, h('div', { class: 'row wrap pad' }, tabs), body));
    const bt = (t, fn, cls = 'btn') => h('button', { class: cls, onclick: fn }, t);
    const stopBtn = cmd => bt('Стоп', () => dev.w(cmd || 'INP OFF').catch(errToast), 'btn primary danger');
    const make = {
      LIST() {
        s.list ??= Array.from({ length: 10 }, (_, k) => ({ en: k < 4, i: .5 * (k + 1), ms: 250 }));
        const rows = h('tbody');
        const draw = () => rows.replaceChildren(...s.list.map((st, k) => h('tr', {},
          h('td', { text: 'Шаг ' + (k + 1) }), h('td', {}, h('input', { type: 'checkbox', checked: st.en, 'aria-label': `Шаг ${k + 1} включён`, onchange: e => { st.en = e.target.checked; } })),
          h('td', {}, elIn(st.i, v => { st.i = clamp(v || 0, 0, 12); }, { min: 0, max: 12, step: .001, label: `Ток шага ${k + 1}` })),
          h('td', {}, elIn(st.ms, v => { st.ms = clamp(v || .1, .1, 60000); }, { min: .1, max: 60000, step: .1, label: `Время шага ${k + 1}` })))));
        draw();
        const PRE = { 'Лесенка 0,5…5 А': [Array.from({ length: 10 }, (_, k) => .5 + .5 * k), Array(10).fill(500)], 'Пусковой бросок': [[8, ...Array(9).fill(1.5)], [50, ...Array(9).fill(500)]], 'Синус': [[.5, 1.28, 2.25, 3.22, 4, 4, 3.22, 2.25, 1.28, .5], Array(10).fill(200)], 'Стартер': [[.5, 9, 6.5, 5, 5.5, 4.5, 2.5, 1, .5, .5], [200, 80, 300, 250, 250, 250, 200, 300, 500, 500]] };
        const f = elForm([['listCyc', 'Циклов', '', { min: 1, step: 1, int: true }]], s);
        const inf = toggle('Без конца', !!s.listInf, v => { s.listInf = v; });
        const upload = async () => { for (let k = 0; k < 10; k++) { const st = s.list[k]; await dev.w(`LIST:STEP ${k},${st.en ? 1 : 0},${st.i},${Math.max(100, Math.round(st.ms * 1000))}`); await sleep(15); } };
        return {
          el: h('div', { class: 'col' }, h('p', { class: 'note', text: 'До 10 шагов тока, каждый со своим временем; включённые шаги идут по кругу заданное число циклов.' }),
            h('div', { class: 'row wrap' }, ...Object.entries(PRE).map(([n, [I, T]]) => bt(n, () => { s.list.forEach((st, k) => Object.assign(st, { en: true, i: I[k], ms: T[k] })); draw(); }, 'tbtn'))),
            h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, h('th', { text: '' }), h('th', { text: 'Вкл' }), h('th', { text: 'Ток, A' }), h('th', { text: 'Время, мс' }))), rows),
            h('div', { class: 'row wrap' }, f, inf),
            h('div', { class: 'row wrap' }, bt('Записать в прибор', () => dev.w('INP OFF').then(upload).then(() => dev.w(`LIST:CYC ${s.listCyc | 0};LIST:INF ${s.listInf ? 1 : 0};FUNC LIST`)).then(() => toast('Список записан', 'ok')).catch(errToast)),
              bt('Запустить', () => dev.w('INP OFF').then(upload).then(() => run(`LIST:CYC ${s.listCyc | 0};LIST:INF ${s.listInf ? 1 : 0};FUNC LIST;INP ON`, true)).catch(errToast), 'btn primary'), stopBtn(),
              bt('Прочитать из прибора', () => dev.readSettings().then(draw)))),
          upd() { f.set(); inf.set(!!s.listInf); },
        };
      },
      DT() {
        const f = elForm([['dynIa', 'Ток A', 'A', { min: 0, max: 12 }], ['dynTa', 'Время A', 'мс', { min: .1 }], ['dynIb', 'Ток B', 'A', { min: 0, max: 12 }], ['dynTb', 'Время B', 'мс', { min: .1 }], ['dynCyc', 'Циклов', '', { min: 1, int: true }]], s);
        const inf = toggle('Без конца', !!s.dynInf, v => { s.dynInf = v; });
        const cmd = () => `INP OFF;DYN:IA ${s.dynIa};DYN:TA ${Math.max(100, Math.round(s.dynTa * 1000))};DYN:IB ${s.dynIb};DYN:TB ${Math.max(100, Math.round(s.dynTb * 1000))};DYN:CYC ${s.dynCyc | 0};DYN:INF ${s.dynInf ? 1 : 0};FUNC DT`;
        return { el: h('div', { class: 'col' }, h('p', { class: 'note', text: 'Импульсная нагрузка: ток A на время A, затем ток B на время B, по кругу. Проверяет реакцию источника на скачок нагрузки.' }), f, inf,
          h('div', { class: 'row wrap' }, bt('Запустить', () => run(cmd() + ';INP ON', true), 'btn primary'), bt('Только настроить', () => run(cmd())), stopBtn())), upd() { f.set(); inf.set(!!s.dynInf); } };
      },
      SCAN() {
        const f = elForm([['scanIl', 'Ток от', 'A', { min: 0, max: 12 }], ['scanIh', 'Ток до', 'A', { min: 0, max: 12 }], ['scanRise', 'Подъём', 'мс', { min: 10, int: true }], ['scanFall', 'Спуск', 'мс', { min: 10, int: true }], ['scanCyc', 'Циклов', '', { min: 1, int: true }]], s);
        const inf = toggle('Без конца', !!L.scanInf, v => { L.scanInf = v; save(); });
        const cmd = () => `INP OFF;SCAN:IL ${s.scanIl};SCAN:IH ${s.scanIh};SCAN:RISE ${s.scanRise | 0};SCAN:FALL ${s.scanFall | 0};SCAN:CYC ${s.scanCyc | 0};SCAN:INF ${L.scanInf ? 1 : 0};FUNC SCAN`;
        return { el: h('div', { class: 'col' }, h('p', { class: 'note', text: 'Ток плавно растёт и спадает между двумя значениями. Нагрузочная кривая источника видна в окне «Кривые EL15» (I от V).' }), f, inf,
          h('div', { class: 'row wrap' }, bt('Запустить', () => run(cmd()).then(() => sleep(60)).then(() => run('INP ON', true)), 'btn primary'), stopBtn(), bt('Открыть кривые', () => WM.open('el15-curve', { kind: 'iv' })))), upd() { f.set(); } };
      },
      BAT() {
        const chem = select([...Object.entries(EL15_BAT).map(([k, v]) => [k, v[0]]), ['custom', 'Своё напряжение']], L.batChem, v => { L.batChem = v; cut(); save(); }, 'Химия');
        const cells = select(Array.from({ length: 16 }, (_, k) => [k + 1, `${k + 1}S`]), L.batCells, v => { L.batCells = +v; cut(); save(); }, 'Банок');
        const f = elForm([['batI', 'Ток разряда', 'A', { min: .001, max: 12 }], ['batCut', 'Отсечка', 'V', { min: .1, max: 60 }]], s, () => dev.w(`BAT:CURR ${s.batI};BAT:CUT ${s.batCut}`).catch(errToast));
        const g = elForm([['batTim', 'Предел времени', 'с', { min: 1, int: true }], ['batIend', 'Конец хвоста CV', 'A', { min: .01, max: 5 }], ['batRated', 'Ёмкость по паспорту', 'Ah', { min: .001 }]], L, save);
        const timOn = toggle('Предел времени', !!L.batTimOn, v => { L.batTimOn = v; save(); }), tail = toggle('Хвост CC→CV', !!L.batTail, v => { L.batTail = v; save(); });
        const res = elStat([['phase', 'Фаза'], ['ah', 'Отдано'], ['wh', 'Энергия'], ['t', 'Время'], ['soc', 'Заряд (по напряжению)'], ['soh', 'Ёмкость к паспорту'], ['eta', 'До конца']]);
        function cut() { const e = EL15_BAT[L.batChem]; if (!e) return; s.batCut = Math.min(60, Math.round(L.batCells * e[1] * 1000) / 1000); f.set(); dev.w(`BAT:CUT ${s.batCut}`).catch(errToast); }
        const cmd = () => `INP OFF;BAT:CURR ${s.batI};BAT:CUT ${s.batCut};BAT:TIM ${L.batTim | 0};BAT:TIM:STAT ${L.batTimOn ? 1 : 0};BAT:TAIL ${L.batTail ? 1 : 0};BAT:IEND ${(+L.batIend).toFixed(3)};FUNC BAT;INP ON`;
        return {
          el: h('div', { class: 'col' }, h('p', { class: 'note', text: 'Разряд постоянным током до напряжения отсечки. С хвостом CC→CV нагрузка у отсечки держит напряжение и снижает ток до конечного: так снимается полная ёмкость.' }),
            h('div', { class: 'row wrap' }, field('Химия', chem), field('Банок', cells)), f, g, h('div', { class: 'row wrap' }, timOn, tail),
            h('div', { class: 'row wrap' }, bt('Начать разряд', () => run(cmd(), true), 'btn primary'), stopBtn(), bt('Обнулить Ah и Wh', () => dev.w('BAT:CLE').catch(errToast)), bt('Кривая разряда', () => WM.open('el15-curve', { kind: 'vah' }))), res),
          upd() {
            f.set(); g.set(); const Lv = c.live; if (!Lv) return; const r = res.cells, st = c.stat.bat;
            r.phase.textContent = Lv.mode !== 'BAT' ? 'не идёт' : st && +st[1] === 1 ? 'хвост CV' : Lv.on ? 'ток CC' : 'остановлен';
            r.ah.textContent = el15f(Lv.ah, 4) + ' Ah'; r.wh.textContent = el15f(Lv.wh, 3) + ' Wh'; r.t.textContent = elHms(Lv.sec);
            const e = EL15_BAT[L.batChem], n = L.batCells || 1;
            if (e && Lv.v > .05) { const vc = Lv.v / n + (Lv.on ? Math.min(.25, Lv.i * .035) : 0), soc = clamp((vc - e[1]) / (e[2] - e[1]), 0, 1); r.soc.textContent = `~${Math.round(soc * 100)} % (${el15f(Lv.v / n, 3)} V на банку)`; r.eta.textContent = Lv.on && Lv.i > .001 ? elHms(soc * L.batRated / Lv.i * 3600) : '–'; }
            else { r.soc.textContent = '–'; r.eta.textContent = '–'; }
            r.soh.textContent = L.batRated > 0 ? `${(Lv.ah / L.batRated * 100).toFixed(1)} %` : '–';
          },
        };
      },
      DCR() {
        const f = elForm([['dcrI1', 'Ток 1', 'A', { min: 0, max: 12 }], ['dcrI2', 'Ток 2', 'A', { min: 0, max: 12 }]], s);
        const res = elStat([['dcr', 'Внутреннее сопротивление']]);
        return { el: h('div', { class: 'col' }, h('p', { class: 'note', text: 'Два шага тока; сопротивление = ΔV / ΔI. Для точного результата включите измерение 4W и подключите провода XT30 прямо к клеммам источника.' }), f,
          h('div', { class: 'row wrap' }, bt('Измерить', () => run(`INP OFF;DCR:CURR1 ${s.dcrI1};DCR:CURR2 ${s.dcrI2};DCR:RUN`), 'btn primary')), res),
          upd() { f.set(); const d = c.live?.dcr; res.cells.dcr.textContent = d > 0 ? el15f(d, 2) + ' мОм' : '–'; } };
      },
      LED() {
        const f = elForm([['ledVo', 'Напряжение светодиодов Vo', 'V', { min: 1, max: 60 }], ['ledIo', 'Ток Io', 'A', { min: .01, max: 12 }], ['ledRd', 'Коэффициент', '', { min: .05, max: .8, step: .01 }]], L, () => { save(); calc(); });
        const res = elStat([['vf', 'Vf'], ['rd', 'Rd'], ['st', 'Состояние'], ['i', 'Ток']]);
        const send = () => dev.w(`LED:VO ${(+L.ledVo).toFixed(3)};LED:IO ${(+L.ledIo).toFixed(3)};LED:RD ${(+L.ledRd).toFixed(2)}`);
        function calc() { res.cells.vf.textContent = el15f(L.ledVo * (1 - L.ledRd), 3) + ' V'; res.cells.rd.textContent = el15f(L.ledRd * L.ledVo / L.ledIo, 3) + ' Ω'; }
        calc();
        return { el: h('div', { class: 'col' }, h('p', { class: 'note', text: 'Нагрузка ведёт себя как цепочка светодиодов: Vf = Vo·(1 − коэф.), Rd = коэф.·Vo / Io. Ток идёт, только когда напряжение выше Vf. Так проверяют драйверы светодиодов.' }), f,
          h('div', { class: 'row wrap' }, bt('Включить', () => send().then(() => run('FUNC LED;INP ON', true)).catch(errToast), 'btn primary'), bt('Только настроить', () => send().catch(errToast)), stopBtn()), res),
          upd() { f.set(); const st = c.stat.led, Lv = c.live; if (st?.length >= 5) { res.cells.vf.textContent = el15f(+st[3], 3) + ' V'; res.cells.rd.textContent = el15f(+st[4], 3) + ' Ω'; } if (Lv) { res.cells.st.textContent = Lv.mode !== 'LED' ? 'не включён' : Lv.on && Lv.v > (+st?.[3] || 0) ? 'проводит' : 'заперт (V < Vf)'; res.cells.i.textContent = el15f(Lv.i, 3) + ' A'; } } };
      },
      MPPT() {
        const f = elForm([['mpptI0', 'Начальный ток', 'A', { min: .01, max: 12 }], ['mpptStep', 'Шаг тока', 'A', { min: .001, max: 2 }], ['mpptDwell', 'Шаг раз в', 'мс', { min: 50, max: 5000, int: true }], ['mpptVmin', 'Не ниже', 'V', { min: .5, max: 60 }]], L, save);
        const res = elStat([['st', 'Состояние'], ['i', 'Ток сейчас'], ['pmax', 'Pmax'], ['vmp', 'Vmp'], ['imp', 'Imp']]);
        const send = () => dev.w(`MPPT:ISTART ${(+L.mpptI0).toFixed(3)};MPPT:ISTEP ${(+L.mpptStep).toFixed(3)};MPPT:DWELL ${L.mpptDwell | 0};MPPT:VMIN ${(+L.mpptVmin).toFixed(3)}`);
        return { el: h('div', { class: 'col' }, h('p', { class: 'note', text: 'Поиск точки максимальной мощности солнечной панели методом «возмущение и наблюдение». Кривая P от V в окне «Кривые EL15».' }), f,
          h('div', { class: 'row wrap' }, bt('Запустить', () => send().then(() => run('MPPT:RUN', true)).catch(errToast), 'btn primary'), stopBtn('MPPT:STOP'), bt('Открыть кривые', () => WM.open('el15-curve', { kind: 'pv' }))), res),
          upd() { f.set(); const p = c.stat.mppt; if (!p || p.length < 5) return; const r = res.cells; r.st.textContent = +p[0] ? 'ищет' : 'стоит'; r.i.textContent = el15f(+p[1], 3) + ' A'; r.pmax.textContent = el15f(+p[2], 2) + ' W'; r.vmp.textContent = el15f(+p[3], 3) + ' V'; r.imp.textContent = el15f(+p[4], 3) + ' A'; } };
      },
      TRIP() {
        const f = elForm([['tripI', 'Испытательный ток', 'A', { min: .01, max: 12 }], ['tripVt', 'Срабатывание, если V ниже', 'V', { min: .1, max: 60 }], ['tripTmax', 'Ждать не дольше', 'мс', { min: 10, max: 60000, int: true }], ['tripBlank', 'Не смотреть первые', 'мс', { min: 1, max: 1000, int: true }]], L, save);
        const g = elForm([['shortI', 'Ток короткого импульса', 'A', { min: .01, max: 12 }], ['shortMs', 'Длительность', 'мс', { min: 1, max: 1000, int: true }]], L, save);
        const res = elStat([['st', 'Итог'], ['ms', 'Время срабатывания'], ['ip', 'Пиковый ток'], ['vt', 'Напряжение при срабатывании']]), soa = h('span', { class: 'note' });
        const send = () => dev.w(`TRIP:ITEST ${(+L.tripI).toFixed(3)};TRIP:VTRIG ${(+L.tripVt).toFixed(3)};TRIP:TMAX ${L.tripTmax | 0};TRIP:BLANK ${L.tripBlank | 0}`);
        const shortI = () => Math.min(12, L.shortI, 130 / Math.max(.1, c.live?.v || .1));
        const ST = { IDLE: 'не запускался', RUNNING: 'идёт', TRIPPED: 'сработала', TIMEOUT: 'не сработала за отведённое время' };
        return { el: h('div', { class: 'col' }, h('p', { class: 'note', text: 'Сколько времени защита источника (или предохранитель) держит ток перегрузки, пока напряжение не упадёт ниже порога.' }), f,
          h('div', { class: 'row wrap' }, bt('Запустить', () => send().then(() => run('TRIP:RUN')).catch(errToast), 'btn primary'), stopBtn('TRIP:STOP')), res,
          h('h4', { text: 'Короткий импульс тока' }), h('p', { class: 'note', text: 'Безопасное «короткое замыкание»: ток ограничен так, чтобы мощность не превышала 130 Вт.' }), g,
          h('div', { class: 'row wrap' }, bt('Импульс', async () => { try { await dev.w(`SHORT:CURR ${shortI().toFixed(3)};SHORT:TIME ${L.shortMs | 0};SHORT:RUN`); await sleep((L.shortMs | 0) + 40); dev.watch = ['TRIP']; } catch (e) { errToast(e); } }), soa)),
          upd() { f.set(); g.set(); soa.textContent = `при ${el15f(c.live?.v || 0, 1)} V ток будет не больше ${shortI().toFixed(3)} A`; const p = c.stat.trip; if (!p || p.length < 2) return; let [st, ms, ip, vt] = p; if (!isNaN(parseFloat(st))) [ms, st] = [st, ms]; const r = res.cells; r.st.textContent = ST[st] || st; r.ms.textContent = +ms > 0 ? el15f(+ms, 1) + ' мс' : '–'; r.ip.textContent = el15f(+ip, 3) + ' A'; r.vt.textContent = el15f(+vt, 3) + ' V'; } };
      },
      PSU() {
        const f = elForm([['psuStart', 'Ток от', 'A', { min: 0, max: 12 }], ['psuRated', 'Номинальный ток БП', 'A', { min: 0, max: 12 }], ['psuStop', 'Ток до', 'A', { min: 0, max: 12 }], ['psuStep', 'Шаг', 'A', { min: .001, max: 2 }]], s);
        const g = elForm([['psuDwell', 'Шаг раз в', 'мс', { min: 10, int: true }], ['psuVt', 'Срабатывание, если V ниже', 'V', { min: 0, max: 60 }]], L, save);
        const res = elStat([['st', 'Состояние'], ['vnl', 'Без нагрузки'], ['hold', 'Держит'], ['trip', 'Защита при'], ['pmax', 'Наибольшая мощность'], ['vr', 'При номинальном токе'], ['reg', 'Просадка']]);
        const ST = ['не запускался', 'идёт', 'защита сработала', 'дошёл до конца без срабатывания'];
        return { el: h('div', { class: 'col' }, h('p', { class: 'note', text: 'Ток растёт ступенями, пока блок питания не уйдёт в защиту: находит порог OCP / OPP, напряжение без нагрузки и просадку при номинальном токе.' }), f, g,
          h('div', { class: 'row wrap' }, bt('Запустить', () => run(`PSU:START ${s.psuStart};PSU:RATED ${s.psuRated};PSU:STOP ${s.psuStop};PSU:STEP ${s.psuStep};PSU:DWEL ${L.psuDwell | 0};PSU:VTRIG ${L.psuVt};PSU:RUN`, true), 'btn primary'),
            stopBtn('OCP:ABORT;INP OFF'), bt('Прочитать итог', () => dev.psuResult().catch(errToast))), res),
          upd() {
            f.set(); g.set(); const o = c.stat.ocp, p = c.stat.psu, r = res.cells;
            if (o?.length >= 6) { const st = +o[0]; r.st.textContent = ST[st] ?? st; if (+o[1] > 0) r.vnl.textContent = el15f(+o[1], 4) + ' V'; r.hold.textContent = +o[2] > 0 ? `${el15f(+o[2], 3)} A при ${el15f(+o[3], 2)} V` : '–'; r.trip.textContent = st === 2 || +o[4] > 0 ? el15f(+o[4], 3) + ' A' : '–'; r.pmax.textContent = +o[5] > 0 ? el15f(+o[5], 2) + ' W' : '–'; if (this.st === 1 && st > 1) dev.psuResult(); this.st = st; }
            if (p?.length >= 8 && p[1] > 0) { r.vr.textContent = `${el15f(p[1], 4)} V при ${el15f(p[2], 2)} A`; r.reg.textContent = p[0] > 0 ? el15f(p[6], 2) + ' %' : '–'; }
          },
        };
      },
    };
    let cur = null;
    function show() {
      const k = cfg.pane;
      panes[k] ??= make[k]();
      cur = panes[k]; body.replaceChildren(cur.el); dev.watch = [k === 'PSU' ? 'PSU' : k]; cur.upd();
    }
    show();
    win.sub(dev, 'set', () => cur?.upd());
    let rev = -1;
    return { tick() { if (rev !== c.rev) { rev = c.rev; cur?.upd(); } }, dispose() { dev.watch = []; } };
  },
});

/* ---------- Кривые: V от Ah (разряд), I от V (скан, LED), P от V (MPPT) ---------- */
const EL15_CURVES = { vah: ['Разряд: V от Ah', 'ah', 'Ah', 'v', 'V', true], iv: ['I от V', 'v', 'V', 'i', 'A', false], pv: ['P от V', 'v', 'V', 'p', 'W', false], vt: ['V и I от времени', 't', 's', 'v', 'V', true] };
WM.define('el15-curve', {
  title: 'EL15: кривые', dev: 'el15', devName: 'EL15', w: 720, h: 480,
  make(win, dev, cfg) {
    const c = dev.s;
    cfg.kind ??= 'vah'; cfg.src ??= 'live';
    let ref = null, hover = null, dirty = true;
    const box = h('div', { class: 'chart' }), tip = h('div', { class: 'tip', hidden: true }), note = h('span', { class: 'note' });
    const kind = seg(Object.entries(EL15_CURVES).map(([k, v]) => [k, v[0]]), cfg.kind, v => { cfg.kind = v; dirty = true; WM.save(); }, 'Кривая');
    const src = seg([['live', 'Запись Пульта'], ['log', 'Журнал прибора']], cfg.src, v => { cfg.src = v; dirty = true; WM.save(); }, 'Данные');
    const rec = toggle('Запись', c.rec, v => { c.rec = v; dirty = true; });
    const all = toggle('И при выключенном входе', !!c.recAll, v => { c.recAll = v; });
    win.body.append(h('div', { class: 'col' }, h('div', { class: 'row wrap pad' }, kind, src),
      h('div', { class: 'row wrap pad' }, rec, all, h('button', { class: 'btn', onclick: () => { dev.curve = []; dirty = true; } }, 'Очистить'),
        h('button', { class: 'btn', onclick: () => { ref = pts().slice(); dirty = true; } }, 'Запомнить как опорную'), h('button', { class: 'btn', onclick: csv }, 'CSV'), note),
      h('div', { class: 'chart-wrap' }, box, tip)));
    win.sub(dev, 'rec', () => rec.set(c.rec)); win.sub(dev, 'logpts', () => { dirty = true; }); win.sub(Bus, 'theme', () => { dirty = true; });
    const p = new Plot(box);
    function pts() {
      const a = cfg.src === 'log' ? dev.logPts || [] : dev.curve, t0 = a[0]?.t || 0;
      return cfg.src === 'log' ? a : a.map(x => ({ ...x, t: (x.t - t0) / 1000 }));
    }
    function csv() {
      const a = pts(); if (!a.length) { toast('Нет точек', 'warn'); return; }
      saveFile(`el15-${stamp()}.csv`, '﻿Время, с;Напряжение, V;Ток, A;Мощность, W;Ёмкость, Ah;Энергия, Wh;Температура, °C\n' + a.map(x => [x.t, x.v, x.i, x.p, x.ah, x.wh, x.temp].map(v => Number.isFinite(v) ? +v.toPrecision(7) : '').join(';')).join('\n'), 'text/csv');
    }
    box.addEventListener('pointermove', e => { const r = box.getBoundingClientRect(); hover = { x: e.clientX - r.left, y: e.clientY - r.top }; dirty = true; });
    box.addEventListener('pointerleave', () => { hover = null; tip.hidden = true; dirty = true; });
    function range(a, k) { let lo = Infinity, hi = -Infinity; for (const x of a) { const v = x[k]; if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } } if (!(hi > lo)) { hi = (lo === Infinity ? 1 : lo) + 1; lo = hi - 2; } const m = (hi - lo) * .05; return [lo - m, hi + m]; }
    function draw() {
      const g = p.g, W = p.w, H = p.h, col = Theme.colors, Lm = 62, B = 26, T = 10, R = 14, [, xk, xu, yk, yu, line] = EL15_CURVES[cfg.kind], a = pts();
      g.clearRect(0, 0, W, H);
      note.textContent = `${a.length} точек`;
      if (a.length < 2) { g.fillStyle = col.ink3; g.font = FONT(12); g.fillText(cfg.src === 'log' ? 'Заберите журнал в окне «Журнал EL15»' : 'Включите запись и вход нагрузки: точки добавляются при каждом измерении', Lm, 30); return; }
      const [x0, x1] = range(ref ? a.concat(ref) : a, xk), [y0, y1] = range(ref ? a.concat(ref) : a, yk);
      const X = v => Lm + (v - x0) / (x1 - x0) * (W - Lm - R), Y = v => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
      g.font = FONT(10); g.lineWidth = 1;
      for (const v of niceTicks(x0, x1, Math.max(3, W / 90 | 0))) { const x = X(v); g.strokeStyle = col.grid; g.beginPath(); g.moveTo(x + .5, T); g.lineTo(x + .5, H - B); g.stroke(); g.fillStyle = col.ink3; g.textAlign = 'center'; g.fillText(fmtSI(v, xu, 3), x, H - 8); }
      for (const v of niceTicks(y0, y1, Math.max(3, H / 40 | 0))) { const y = Y(v); g.strokeStyle = col.grid; g.beginPath(); g.moveTo(Lm, y + .5); g.lineTo(W - R, y + .5); g.stroke(); g.fillStyle = col.ink3; g.textAlign = 'right'; g.fillText(fmtSI(v, yu, 3), Lm - 6, y + 3); }
      g.strokeStyle = col.line; g.strokeRect(Lm + .5, T + .5, W - Lm - R, H - T - B);
      const plot = (arr, color, dash, k = yk) => {
        g.save(); g.beginPath(); g.rect(Lm, T, W - Lm - R, H - T - B); g.clip();
        if (line) { g.strokeStyle = color; g.lineWidth = 2; g.setLineDash(dash ? [5, 4] : []); g.beginPath(); let pen = false; for (const x of arr) { const u = x[xk], v = x[k]; if (!Number.isFinite(u) || !Number.isFinite(v)) { pen = false; continue; } if (pen) g.lineTo(X(u), Y(v)); else g.moveTo(X(u), Y(v)); pen = true; } g.stroke(); }
        else { g.fillStyle = color; for (const x of arr) { const u = x[xk], v = x[k]; if (Number.isFinite(u) && Number.isFinite(v)) g.fillRect(X(u) - 1.5, Y(v) - 1.5, 3, 3); } }
        g.restore();
      };
      if (ref) plot(ref, col.ink3, true);
      plot(a, col.t[0], false);
      g.textAlign = 'left'; g.fillStyle = col.ink2; g.font = FONT(11, 600); g.fillText(`${{ v: 'U', i: 'I', p: 'P' }[yk]}, ${yu}`, Lm + 8, T + 16);
      if (hover && hover.x > Lm) {
        let best = null, d = 1e9; for (const x of a) { const e = Math.hypot(X(x[xk]) - hover.x, Y(x[yk]) - hover.y); if (e < d) { d = e; best = x; } }
        if (best) {
          g.fillStyle = col.t[0]; g.strokeStyle = col.panel; g.lineWidth = 2; g.beginPath(); g.arc(X(best[xk]), Y(best[yk]), 4, 0, 6.3); g.fill(); g.stroke();
          tip.replaceChildren(...[['Время', fmtSI(best.t, 's', 4)], ['Напряжение', fmtSI(best.v, 'V', 5)], ['Ток', fmtSI(best.i, 'A', 5)], ['Мощность', fmtSI(best.p, 'W', 4)], ['Ёмкость', fmtSI(best.ah, 'Ah', 4)]].map(([n, v]) => h('div', {}, n, h('b', { text: v }))));
          tip.hidden = false; tip.style.left = Math.min(X(best[xk]) + 12, W - 180) + 'px'; tip.style.top = Math.min(Y(best[yk]) + 10, H - 120) + 'px';
        }
      }
    }
    let n = -1;
    return { tick() { const k = dev.curve.length; if (k !== n) { n = k; dirty = true; } if (dirty) { dirty = false; draw(); } }, dispose() { p.dispose(); } };
  },
});

/* ---------- Защиты и настройки ---------- */
WM.define('el15-prot', {
  title: 'EL15: защиты и настройки', dev: 'el15', devName: 'EL15', w: 600, h: 600,
  make(win, dev, cfg) {
    const c = dev.s, s = c.set;
    const P = { ovp: 62, ocp: 12.3, opp: 255, otp: 90, uvp: 0, von: 0, eotp: s.eotp ?? 60 };
    const fromLive = () => { const L = c.live; if (L) for (const k of ['ovp', 'ocp', 'opp', 'otp', 'uvp', 'von']) if (Number.isFinite(L[k])) P[k] = L[k]; P.eotp = s.eotp ?? P.eotp; };
    fromLive();
    const prot = elForm([['ovp', 'Перенапряжение OVP', 'V', { min: 0, max: 62 }], ['ocp', 'Перегрузка по току OCP', 'A', { min: 0, max: 12.3 }], ['opp', 'Перегрузка по мощности OPP', 'W', { min: 0, max: 255 }], ['otp', 'Перегрев транзисторов OTP', '°C', { min: 40, max: 100, int: true }], ['eotp', 'Перегрев по внешнему датчику', '°C', { min: 40, max: 125 }]], P);
    const eotpOn = toggle('Защита по внешнему датчику', !!s.eotpOn, v => { s.eotpOn = v; });
    const volt = elForm([['uvp', 'Отключить ниже (UVP)', 'V', { min: 0, max: 60 }], ['von', 'Включаться от (Von)', 'V', { min: 0, max: 60 }]], P, k => dev.w(`${k === 'uvp' ? 'VOLT:UVP' : 'VOLT:ON'} ${P[k]}`).catch(errToast));
    const pick = (opts, v, cmd, label, key) => select(opts.map(x => Array.isArray(x) ? x : [x, String(x)]), v, x => { if (key) s[key] = +x; dev.w(`${cmd} ${x}`).catch(errToast); }, label);
    const soft = pick([[0, 'Выкл'], [10, '10 мс'], [50, '50 мс'], [100, '100 мс'], [200, '200 мс'], [500, '0,5 с'], [1000, '1 с'], [2000, '2 с'], [5000, '5 с']], s.soft ?? 0, 'SYST:SOFT', 'Плавный старт', 'soft');
    const crcc = pick([[1, 'Вкл'], [0, 'Выкл']], s.crcc === false ? 0 : 1, 'SYST:CRCC', 'Без «икания» в CR и CP', 'crcc');
    const ahic = pick([['', '—'], [1, 'Вкл'], [0, 'Выкл']], '', 'SYST:AHIC', 'Без «икания» с БП в CC');
    const wdt = pick([[0, 'Выкл'], [2, '2 с'], [5, '5 с'], [10, '10 с'], [30, '30 с'], [60, '1 мин'], [300, '5 мин']], s.wdt ?? 0, 'SYST:WDT', 'Сторожевой таймер связи', 'wdt');
    const F = { fanMin: 0, fanTemp: 45 };
    const fan = elForm([['fanMin', 'Вентилятор не меньше', '%', { min: 0, max: 100, int: true }], ['fanTemp', 'Полные обороты с', '°C', { min: 35, max: 80, int: true }]], F, k => dev.w(k === 'fanMin' ? `SYST:FAN:MIN ${F.fanMin}` : `SYST:FAN:TEMP ${F.fanTemp}`).catch(errToast));
    const bright = pick(Array.from({ length: 10 }, (_, k) => k + 1), s.bright || 7, 'SYST:BRIGHT', 'Яркость', 'bright');
    const beep = pick([[0, 'Выкл'], [1, 'Тихо'], [2, 'Средне'], [3, 'Громко']], s.beep ?? 1, 'SYST:BEEP', 'Звук', 'beep');
    const scr = pick([[0, 'Никогда'], [300, '5 мин'], [600, '10 мин'], [1800, '30 мин']], !s.scrOff || s.scrOff > 1800 ? 0 : s.scrOff <= 450 ? 300 : s.scrOff <= 1200 ? 600 : 1800, 'SYST:SCROFF', 'Гасить экран', 'scrOff');
    const poll = select([[50, '50 мс'], [100, '100 мс'], [200, '200 мс'], [500, '0,5 с'], [1000, '1 с']], c.pollMs, v => { c.pollMs = +v; store.set('el15.poll', +v); }, 'Опрос');
    win.body.append(h('div', { class: 'col pad scroll' },
      h('h4', { text: 'Защиты' }), prot, h('div', { class: 'row wrap' }, eotpOn,
        h('button', { class: 'btn primary', onclick: () => dev.w(`PROT:OVP ${P.ovp};PROT:OCP ${P.ocp};PROT:OPP ${P.opp};PROT:OTP ${P.otp | 0};PROT:EOTP ${P.eotp};PROT:EOTP:STAT ${s.eotpOn ? 1 : 0}`).then(() => toast('Защиты записаны', 'ok')).catch(errToast) }, 'Записать защиты'),
        h('button', { class: 'btn', onclick: () => { fromLive(); prot.set(); volt.set(); } }, 'Прочитать')),
      h('p', { class: 'note', text: 'Внешний датчик DS18B20 подпаивается к площадкам G (земля), C (данные) и V (+3,3 В) с резистором 4,7 кОм между C и V. Площадки D и R не трогать: R сбрасывает процессор.' }),
      h('h4', { text: 'Напряжение' }), volt,
      h('h4', { text: 'Поведение' }),
      h('div', { class: 'ctl-grid' }, field('Плавный старт тока', soft), field('Без «икания» в CR и CP', crcc), field('Без «икания» с БП в CC', ahic), field('Сторожевой таймер связи', wdt)),
      h('p', { class: 'note', text: 'Сторожевой таймер выключает вход, если Пульт не обращался к прибору дольше заданного. Состояние «без икания с БП» прибор не сообщает, поэтому поле пустое, пока его не выбрать.' }),
      h('h4', { text: 'Вентилятор' }), fan,
      h('h4', { text: 'Прибор' }),
      h('div', { class: 'ctl-grid' }, field('Яркость', bright), field('Звук', beep), field('Гасить экран', scr), field('Опрос Пультом', poll)),
      dev.hasBuf ? h('div', { class: 'col' },
        h('div', { class: 'ctl-grid' }, field('Частота АЦП, преобр./с', select(EL15_RATES, c.adcRate || 40, async v => {
          try { const r = await dev.setAdcRate(v); toast(`EL15: АЦП ${r} преобр./с, около ${Math.round(r / 2)} измерений в секунду`, 'ok'); } catch (e) { errToast(e); }
        }, 'Частота АЦП'))),
        h('p', { class: 'note', text: 'АЦП по очереди меряет напряжение и ток (при токе больше 1,2 А — ещё второй канал тока), поэтому измерений в секунду вдвое-втрое меньше, чем преобразований. Чем выше частота, тем больше шум в последних знаках; калибровка сделана на 40, после смены частоты сверьте показания с эталоном. Прибор запоминает частоту; в сервисном режиме всегда 40.' })) : '',
      h('div', { class: 'row wrap' }, h('button', { class: 'btn', onclick: () => dev.w('SYST:BEEP:IMM').catch(errToast) }, 'Пискнуть'),
        h('button', { class: 'btn', onclick: () => dev.w('SYST:SAVE').then(() => toast('Настройки сохранены во флеш прибора', 'ok')).catch(errToast) }, 'Сохранить во флеш прибора'),
        h('button', { class: 'btn', onclick: async () => { if (await c2Ask('Вернуть все настройки EL15 к заводским? Вход будет выключен.')) { await dev.w('INP OFF;SYST:REST').catch(errToast); await dev.readSettings(); } } }, 'Заводские настройки'),
        h('button', { class: 'btn', onclick: () => dev.readSettings() }, 'Перечитать всё'))));
    win.sub(dev, 'set', () => { fromLive(); prot.set(); volt.set(); eotpOn.set(!!s.eotpOn); });
    return {};
  },
});

/* ---------- Журнал прибора: до 8000 точек, пишется и без компьютера ---------- */
WM.define('el15-log', {
  title: 'EL15: журнал прибора', dev: 'el15', devName: 'EL15', w: 520, h: 320,
  make(win, dev) {
    const c = dev.s, st = h('b'), prog = h('span', { class: 'note' });
    const ms = select([[100, '0,1 с'], [500, '0,5 с'], [1000, '1 с'], [5000, '5 с'], [10000, '10 с']], c.log.ms, v => dev.w(`LOG:INT ${v}`).catch(errToast), 'Интервал');
    const go = h('button', { class: 'btn primary', onclick: () => dev.w(c.log.en ? 'LOG:STOP' : `LOG:STAR ${ms.value}`).then(() => dev.logStat()).catch(errToast) });
    const ui = () => { const l = c.log; st.textContent = `${l.en ? 'пишет' : 'стоит'}, ${l.n} из ${l.max} точек, раз в ${l.ms / 1000} с (хватит на ${elHms((l.max - l.n) * l.ms / 1000)})`; go.textContent = l.en ? 'Остановить запись' : 'Начать запись'; go.classList.toggle('danger', !!l.en); if (document.activeElement !== ms) ms.value = l.ms; };
    async function pull(toCsv) {
      try {
        const pts = await dev.logPull((k, n) => { prog.textContent = `${k} из ${n}`; });
        prog.textContent = `забрано ${pts.length} точек`;
        if (toCsv) saveFile(`el15-zhurnal-${stamp()}.csv`, '﻿Время, с;Напряжение, V;Ток, A;Мощность, W;Температура, °C;Ёмкость, Ah;Энергия, Wh\n' + pts.map(x => [x.t, x.v, x.i, x.p, x.temp, x.ah, x.wh].map(v => +(+v).toPrecision(7)).join(';')).join('\n'), 'text/csv');
        else { const w = WM.desk.wins.find(x => x.type === 'el15-curve'); if (w) { w.cfg.src = 'log'; w.rebuild(); } else WM.open('el15-curve', { src: 'log', kind: 'vt' }); }
      } catch (e) { errToast(e); }
    }
    win.body.append(h('div', { class: 'col pad' }, h('p', { class: 'note', text: 'Прибор пишет V, I, P и температуру сам, без компьютера: можно оставить многочасовой разряд и забрать результат потом.' }),
      st, h('div', { class: 'row wrap' }, field('Интервал', ms), go, h('button', { class: 'btn', onclick: async () => { if (await c2Ask('Стереть журнал в приборе?')) dev.w('LOG:CLE').then(() => dev.logStat()).catch(errToast); } }, 'Стереть')),
      h('div', { class: 'row wrap' }, h('button', { class: 'btn', onclick: () => pull(false) }, 'Забрать в кривые'), h('button', { class: 'btn', onclick: () => pull(true) }, 'Забрать в CSV'), prog)));
    ui(); win.sub(dev, 'log', ui);
    return {};
  },
});

/* ---------- Калибровка по DM40: напряжение 2W и 4W, ток.
   Прошивка 4.6.0 и новее: до 8 точек на величину, кусочно-линейная поправка (CAL:PNT), прибор
   хранит её сам. Показание EL15 при снятии точки пересчитывается обратно через действующие
   точки, поэтому старую поправку снимать не нужно, и прибор не меняется до «Записать».
   Прошивка старше: точки сводятся к прямой и пишутся поправкой CAL:TRIM поверх заводской
   таблицы; до 4.5.2 прибор держал её в ОЗУ, и Пульт записывал её снова при каждом подключении. ---------- */
/* Калибровка по эталону, как у C2: величина, эталон, точки, запись. Напряжение калибруется
   отдельно для измерения 2W и 4W (свои блоки АЦП), ток — по сумме каналов. */
const EL15_CAL_T = {
  v2: { name: 'Напряжение 2W', q: 'el15.v', unit: 'V', sense: '2W', dm: 'VOLT' },
  v4: { name: 'Напряжение 4W', q: 'el15.v', unit: 'V', sense: '4W', dm: 'VOLT' },
  i: { name: 'Ток', q: 'el15.i', unit: 'A', dm: 'CURR' },
};
WM.define('el15-cal', {
  title: 'EL15: калибровка', dev: 'el15', devName: 'EL15', w: 760, h: 620,
  make(win, dev, cfg) {
    const c = dev.s;
    cfg.t ??= 'v2'; cfg.ref ??= 'dm40';
    const pts = { v2: [], v4: [], i: [] }, T = () => EL15_CAL_T[cfg.t];
    const st = h('p', { class: 'note' }), ptBody = h('tbody'), live = elStat([['el', 'EL15'], ['ref', 'Эталон'], ['d', 'Разница']]);
    const tSel = seg(Object.entries(EL15_CAL_T).map(([k, v]) => [k, v.name]), cfg.t, v => { cfg.t = v; WM.save(); sense(); drawPts(); }, 'Что калибруем');
    const refSel = select([['dm40', 'DM40 (основное показание)'], ['manual', 'Ввести вручную']], cfg.ref, v => { cfg.ref = v; WM.save(); sense(); }, 'Эталон');
    const manual = h('input', { type: 'number', step: 'any', placeholder: 'эталон', style: { width: '110px' } });
    const auto = toggle('Записывать в EL15 при каждом подключении', dev.savedCal().auto, v => { const s = dev.savedCal(); s.auto = v; store.set(dev.calKey, s); });
    const fileIn = h('input', { type: 'file', accept: '.json', hidden: true, onchange: async e => { try { await restore(JSON.parse(await e.target.files[0].text())); } catch { toast('Это не файл калибровки EL15', 'bad'); } e.target.value = ''; } });
    const mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);
    const idx = () => el15CalIdx(dev.cal?.hw || 8, cfg.t);
    const elNow = () => Hub.q.get(T().q)?.last;
    /* Показание EL15 без 8-точечной поправки этой величины (её точки известны из прибора). */
    const chOf = () => EL15_PNT_CH[cfg.t];
    const elRaw = () => { const v = elNow(); return dev.hasPnt ? el15PwlInv(dev.pnt?.[chOf()] || [], v) : v; };
    const refNow =() => cfg.ref === 'manual' ? parseFloat(String(manual.value).replace(',', '.')) : Devices.get('dm40') ? Hub.q.get('dm40.main')?.last : NaN;
    /* EL15 переключается на нужное измерение (2W или 4W), DM40 — на V⎓ или A⎓ сами. */
    const dmOk = () => { const d = Devices.get('dm40'); return cfg.ref === 'manual' || !!d && (d.s.func === T().dm || d.s.func === T().dm + ':AUTO'); };
    async function sense() {
      const want = T().sense, d = Devices.get('dm40');
      try {
        if (want && !!c.live?.kelvin !== (want === '4W')) { await dev.w(`SYST:SENS ${want}`); toast(`EL15: измерение ${want}`, 'info'); }
        if (cfg.ref === 'dm40' && d && !dmOk()) { await d.setFunc(T().dm); toast(`DM40: ${T().dm === 'VOLT' ? 'V⎓' : 'A⎓'}`, 'info'); }
      } catch (e) { errToast(e); }
    }
    async function read() {
      try {
        const cal = await dev.readCal();
        if (dev.hasPnt) {
          const n = cal.pnt.map(P => P.length);
          st.textContent = `Прошивка ${dev.fw}: поправка хранится в EL15. Точек: напряжение 2W — ${n[0]}, 4W — ${n[1]}, ток — ${n[2]}${cal.user && !n.some(Boolean) ? '; действует поправка CAL:TRIM' : ''}. Измерение ${cal.kelvin ? '4W' : '2W'}.`;
        } else st.textContent = `В EL15 ${cal.user ? 'действует поправка' : 'заводская калибровка'}, измерение ${cal.kelvin ? '4W' : '2W'}.${dev.calApplied ? ' Поправка из Пульта записана при подключении.' : ''}${dev.calInFlash ? ' Прибор хранит поправку сам.' : ''}`;
        if (!store.get('el15.calbak.' + dev.serial, null)) store.set('el15.calbak.' + dev.serial, backup());
      } catch (e) { st.textContent = 'Таблицы калибровки не прочитаны: ' + e.message; }
    }
    /* Точка: среднее обоих приборов за 2 с. */
    async function addPoint() {
      if (pts[cfg.t].length >= 8) { toast('Не больше 8 точек на величину', 'bad'); return; }
      if (T().sense && c.live?.on) { toast('Выключите вход нагрузки: напряжение калибруется без тока', 'bad'); return; }
      if (!dmOk()) { toast(`DM40 не в режиме ${T().dm === 'VOLT' ? 'V⎓' : 'A⎓'}`, 'bad'); sense(); return; }
      if (T().sense && !!c.live?.kelvin !== (T().sense === '4W')) { toast(`EL15 ещё не в режиме ${T().sense}`, 'bad'); sense(); return; }
      if (dev.hasPnt && !dev.pnt) await read();
      const a = { el: [], ref: [] }, t0 = performance.now();
      while (performance.now() - t0 < 2000) { const e = elRaw(), r = refNow(); if (Number.isFinite(e)) a.el.push(e); if (Number.isFinite(r)) a.ref.push(r); await sleep(200); }
      if (!a.el.length || !a.ref.length) { toast('Нет показаний эталона или EL15', 'bad'); return; }
      pts[cfg.t].push({ el: mean(a.el), ref: mean(a.ref) }); pts[cfg.t].sort((x, y) => x.el - y.el); drawPts();
    }
    /* ref = a·el + b по точкам; одна точка — только усиление (у нуля — смещение). */
    function solve(P) {
      if (!P.length) return null;
      if (P.length === 1) { const p = P[0]; return Math.abs(p.el) >= (cfg.t === 'i' ? .05 : .5) ? { a: p.ref / p.el, b: 0 } : { a: 1, b: p.ref - p.el }; }
      const mx = mean(P.map(p => p.el)), my = mean(P.map(p => p.ref)); let sxy = 0, sxx = 0;
      for (const p of P) { sxy += (p.el - mx) * (p.ref - my); sxx += (p.el - mx) ** 2; }
      if (sxx < 1e-12) return { a: 1, b: my - mx };
      const a = sxy / sxx; return { a, b: my - a * mx };
    }
    function drawPts() {
      const P = pts[cfg.t], u = T().unit;
      ptBody.replaceChildren(...P.map((p, k) => h('tr', {}, h('td', { class: 'num', text: fmtSI(p.el, u, 6) }), h('td', { class: 'num', text: fmtSI(p.ref, u, 6) }), h('td', { class: 'num', text: p.el ? ((p.ref / p.el - 1) * 100).toFixed(3) + ' %' : '–' }),
        h('td', {}, h('button', { class: 'wbtn', 'aria-label': 'Убрать точку', onclick: () => { P.splice(k, 1); drawPts(); } }, '×')))));
    }
    async function write() {
      if (dev.hasPnt) return writePnt();
      const f = solve(pts[cfg.t]);
      if (!f) { toast('Сначала добавьте точки', 'bad'); return; }
      try {
        if (!dev.cal) await read();
        if (!dev.cal) throw new Error('Таблицы калибровки не прочитаны');
        if (Math.abs(f.a - 1) > .02 && !(await c2Ask(`Поправка ${((f.a - 1) * 100).toFixed(2)} % — это много. Проверьте подключение эталона. Всё равно записать?`))) return;
        const i = idx(), [g0, o0] = dev.trimOf(i);
        await dev.setTrim(i, f.a * g0, f.a * o0 + f.b);
        toast(`${T().name}: калибровка записана в EL15`, 'ok'); pts[cfg.t] = []; drawPts(); await read();
      } catch (e) { errToast(e); }
    }
    /* 8 точек: прибор сам сортирует, проверяет и сохраняет; здесь те же проверки заранее. */
    async function writePnt() {
      const P = pts[cfg.t].map(p => [p.el, p.ref]).sort((x, y) => x[0] - y[0]);
      if (!P.length) { toast('Сначала добавьте точки', 'bad'); return; }
      const bad = el15PntCheck(P, T().unit);
      if (bad) { toast(`Не записано: ${bad}`, 'bad'); return; }
      const worst = Math.max(0, ...P.filter(([x]) => Math.abs(x) > .01).map(([x, y]) => Math.abs(y / x - 1)));
      if (worst > .02 && !(await c2Ask(`Поправка до ${(worst * 100).toFixed(2)} % — это много. Проверьте подключение эталона. Всё равно записать?`))) return;
      try {
        await dev.writePnt(chOf(), P);
        toast(`${T().name}: ${P.length} ${P.length === 1 ? 'точка записана' : P.length < 5 ? 'точки записаны' : 'точек записано'} в EL15`, 'ok');
        pts[cfg.t] = []; drawPts(); await read();
      } catch (e) { errToast(e); }
    }
    async function reset() {
      if (!(await c2Ask(`Убрать поправку «${T().name}»? Останется заводская калибровка.`))) return;
      try {
        const i = idx(), s = dev.savedCal();
        if (dev.hasPnt) { await dev.w(`CAL:PNT ${chOf()},0`); (dev.pnt ??= [])[chOf()] = []; if (s.pnt) s.pnt[chOf()] = []; }
        await dev.w(`CAL:TRIM ${i},1.000000,0.00000`); delete s.trims[i]; store.set(dev.calKey, s);
        toast('Поправка убрана', 'ok'); await read();
      } catch (e) { errToast(e); }
    }
    function backup() { return { model: 'ATK-EL15', serial: dev.serial, fw: dev.fw, at: new Date().toISOString(), hw: dev.cal?.hw, trims: dev.savedCal().trims, pnt: dev.cal?.pnt, act: dev.cal?.act, fac: dev.cal?.fac }; }
    async function restore(j) {
      j ??= dev.savedCal();
      const trims = j.trims || {}, pnt = dev.hasPnt && Array.isArray(j.pnt) ? j.pnt : [];
      if (!Object.keys(trims).length && !pnt.some(P => P?.length)) { toast('В копии нет поправок', 'bad'); return; }
      try {
        for (const [i, [g, o]] of Object.entries(trims)) await dev.setTrim(+i, +g, +o);
        for (let ch = 0; ch < 3; ch++) if (pnt[ch]?.length) await dev.writePnt(ch, pnt[ch]);
        toast('Калибровка восстановлена в EL15', 'ok'); await read();
      } catch (e) { errToast(e); }
    }
    async function factory() {
      if (!(await c2Ask('Вернуть заводскую калибровку EL15? Поправки, которые хранит Пульт, будут забыты.'))) return;
      try { await dev.w('CAL:REST'); dev.pnt = [[], [], []]; store.set(dev.calKey, { ...dev.savedCal(), trims: {}, pnt: [] }); toast('В EL15 заводская калибровка', 'ok'); await read(); } catch (e) { errToast(e); }
    }
    win.body.append(h('div', { class: 'col pad scroll' }, st,
      h('h4', { text: 'Напряжение и ток по эталону' }),
      h('p', { class: 'note', text: 'Напряжение: вход нагрузки выключен, эталон (DM40 в V⎓) подключён туда же, куда EL15 меряет: для 2W к клеммам входа, для 4W к точке, куда идут провода разъёма измерения. EL15 переключается на 2W или 4W сам. Ток: эталон (DM40 в A⎓) в разрыв провода, ток задайте в окне «Нагрузка» в режиме CC. Нажмите «Добавить точку», повторите для 2–8 значений по рабочему диапазону, затем «Записать в прибор».' }),
      h('div', { class: 'row wrap' }, tSel, field('Эталон', refSel), manual), live,
      h('div', { class: 'row wrap' }, h('button', { class: 'btn primary', onclick: addPoint }, 'Добавить точку'), h('button', { class: 'btn', onclick: write }, 'Записать в прибор'), h('button', { class: 'btn', onclick: reset }, 'Сбросить в приборе')),
      h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, ...['EL15 без поправки', 'Эталон', 'Поправка', ''].map(t => h('th', { text: t })))), ptBody),
      h('h4', { text: 'Резервная копия' }),
      h('p', { class: 'note', text: dev.hasPnt ? 'Заводские таблицы EL15 не меняются. Поправка (до 8 точек на величину) хранится в самом приборе и действует после выключения; «Вернуть заводскую» стирает её. Копия в файле или в Пульте нужна на случай перепрошивки.'
        : dev.calInFlash ? 'Заводские таблицы EL15 не меняются. Поправка хранится в самом приборе и действует после выключения. Копия в файле или в Пульте нужна на случай перепрошивки.'
        : 'Заводские таблицы EL15 не меняются: поправка лежит в его памяти до выключения. Пульт хранит её для каждого прибора и записывает снова при подключении.' }),
      dev.calInFlash ? '' : h('div', { class: 'row wrap' }, auto),
      h('div', { class: 'row wrap' }, h('button', { class: 'btn', onclick: () => saveFile(`el15-calibrovka-${dev.serial || ''}-${stamp()}.json`, JSON.stringify(backup()), 'application/json') }, 'Сохранить копию в файл'), h('button', { class: 'btn', onclick: () => restore() }, 'Восстановить из Пульта'), h('button', { class: 'btn', onclick: () => fileIn.click() }, 'Восстановить из файла'), h('button', { class: 'btn', onclick: factory }, 'Вернуть заводскую'), fileIn)));
    drawPts(); read(); sense();
    let tLast = 0;
    return {
      tick(now) {
        if (now - tLast < 300) return; tLast = now;
        const u = T().unit, el = elNow(), ref = refNow(), r = live.cells, d = el - ref;
        r.el.textContent = fmtSI(el, u, 6); r.ref.textContent = Number.isFinite(ref) ? fmtSI(ref, u, 6) : cfg.ref === 'dm40' && !Devices.get('dm40') ? 'нет DM40' : '–';
        r.d.textContent = Number.isFinite(d) ? `${fmtSI(d, u, 3)}${ref ? ` (${(d / ref * 100).toFixed(3)} %)` : ''}` : '–';
      },
    };
  },
});

/* Подписка на новые столы для тех, у кого раскладка сохранена до появления EL15. */
const EL15_DESKS = () => [
  { name: 'EL15', wins: [
    { type: 'el15-main', cfg: {}, g: { x: 16, y: 16, w: 576, h: 616 } },
    { type: 'trend', cfg: { ids: ['el15.v', 'el15.i', 'el15.p'], span: 120 }, g: { x: 608, y: 16, w: 784, h: 304 } },
    { type: 'el15-modes', cfg: {}, g: { x: 608, y: 336, w: 784, h: 296 } },
  ] },
  { name: 'EL15: сервис', wins: [
    { type: 'el15-cal', cfg: {}, g: { x: 16, y: 16, w: 784, h: 640 } },
    { type: 'el15-prot', cfg: {}, g: { x: 816, y: 16, w: 576, h: 416 } },
    { type: 'el15-log', cfg: {}, g: { x: 816, y: 448, w: 576, h: 208 } },
  ] },
];
