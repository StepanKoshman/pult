'use strict';
/* Транспорты. Общий контракт:
     open(), close(), send(str|bytes), recv(timeoutMs) -> Uint8Array одного ответа.
   Text и блоки IEEE 488.2 разбираются здесь и в Link, драйверы видят только SCPI. */

const enc = new TextEncoder(), dec = new TextDecoder('latin1');
const toBytes = s => typeof s === 'string' ? enc.encode(s) : s;

class TimeoutError extends Error { constructor(m = 'Прибор не ответил вовремя') { super(m); this.name = 'TimeoutError'; } }

/* ---------- USBTMC поверх WebUSB ---------- */
class UsbTmc extends Emitter {
  static label = 'USB';
  static get available() { return !!navigator.usb; }
  static filters = [
    { vendorId: 0x1209, productId: 0xD040 },       // DM40 с opendm40
    { vendorId: 0x2E3C, productId: 0x5721 },       // LT1 с прошивкой fix5 (2.0)
    { classCode: 0xFE, subclassCode: 3 },          // любой USBTMC-прибор
  ];
  constructor(device) { super(); this.dev = device; this.tag = 1; this.kind = 'usb'; this.name = device?.productName || 'USB'; }
  static async pick() { return new UsbTmc(await navigator.usb.requestDevice({ filters: UsbTmc.filters })); }

  findIface() {
    for (const cfg of this.dev.configurations) for (const i of cfg.interfaces) for (const a of i.alternates)
      if (a.interfaceClass === 0xFE && a.interfaceSubclass === 3) return { cfg, iface: i, alt: a };
    return null;
  }
  async open() {
    const d = this.dev;
    await d.open();
    if (!d.configuration) await d.selectConfiguration(d.configurations[0].configurationValue);
    const f = this.findIface();
    if (!f) throw new Error('У устройства нет интерфейса USBTMC');
    if (d.configuration.configurationValue !== f.cfg.configurationValue) await d.selectConfiguration(f.cfg.configurationValue);
    this.ifn = f.iface.interfaceNumber;
    await d.claimInterface(this.ifn);
    if (f.alt.alternateSetting) await d.selectAlternateInterface(this.ifn, f.alt.alternateSetting);
    for (const e of f.alt.endpoints) {
      if (e.type !== 'bulk') continue;
      if (e.direction === 'in') { this.epIn = e.endpointNumber; this.mpsIn = e.packetSize; }
      else { this.epOut = e.endpointNumber; this.mpsOut = e.packetSize; }
    }
    if (!this.epIn || !this.epOut) throw new Error('Не найдены конечные точки USBTMC');
    await this.clear().catch(() => { });
  }
  async close() { try { await this.dev.releaseInterface(this.ifn); } catch { } try { await this.dev.close(); } catch { } }

  /* USBTMC INITIATE_CLEAR + CHECK_CLEAR_STATUS: сбрасывает хвосты прошлой сессии. */
  async clear() {
    const setup = (request, length) => ({ requestType: 'class', recipient: 'interface', request, value: 0, index: this.ifn });
    await this.dev.controlTransferIn(setup(5), 1);
    for (let i = 0; i < 20; i++) {
      const r = await this.dev.controlTransferIn(setup(6), 2);
      const s = r.data?.getUint8(0);
      if (s === 1) break;
      if (s !== 2) break;
      await sleep(5);
    }
    await this.dev.clearHalt('out', this.epOut).catch(() => { });
    await this.dev.clearHalt('in', this.epIn).catch(() => { });
    this.tag = 1;
  }
  nextTag() { const t = this.tag; this.tag = t === 255 ? 1 : t + 1; return t; }
  async send(data) {
    const b = toBytes(data), t = this.nextTag();
    const pad = (4 - (b.length & 3)) & 3;
    const m = new Uint8Array(12 + b.length + pad), v = new DataView(m.buffer);
    m[0] = 1; m[1] = t; m[2] = ~t & 255; v.setUint32(4, b.length, true); m[8] = 1;
    m.set(b, 12);
    await this.dev.transferOut(this.epOut, m);
  }
  async recv(timeout = 3000) {
    const parts = []; let total = 0, eom = false;
    const deadline = performance.now() + timeout;
    while (!eom) {
      const t = this.nextTag(), rq = new Uint8Array(12), v = new DataView(rq.buffer);
      const want = 1 << 16;
      rq[0] = 2; rq[1] = t; rq[2] = ~t & 255; v.setUint32(4, want, true);
      await this.dev.transferOut(this.epOut, rq);
      let need = -1, got = 0, first = true, pad = 0;
      while (need < 0 || got < need) {
        const left = deadline - performance.now();
        if (left <= 0) { await this.abort(); throw new TimeoutError(); }
        // Заголовок читаем одним пакетом, остальное точным числом байт: ответ кратной
        // длины не обязан заканчиваться коротким пакетом, и transferIn иначе зависнет.
        const size = first ? this.mpsIn : Math.max(this.mpsIn, Math.ceil((need - got + pad) / this.mpsIn) * this.mpsIn);
        const r = await withTimeout(this.dev.transferIn(this.epIn, size), left).catch(async e => { await this.abort(); throw e; });
        if (r.status !== 'ok') { await this.dev.clearHalt('in', this.epIn).catch(() => { }); throw new Error('USB: ' + r.status); }
        let u = new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
        if (first) {
          if (u.length < 12 || u[0] !== 2 || u[1] !== t) continue;   // хвост прошлого ответа
          const dv = new DataView(u.buffer, u.byteOffset, 12);
          need = dv.getUint32(4, true); eom = !!(u[8] & 1); first = false; pad = (4 - (need & 3)) & 3;
          u = u.subarray(12);
        }
        if (got + u.length > need) u = u.subarray(0, need - got);
        if (u.length) { parts.push(u.slice()); got += u.length; total += u.length; }
        if (need === 0) break;
      }
    }
    return joinBytes(parts, total);
  }
  async abort() { try { await this.clear(); } catch { } }
}

function joinBytes(parts, total) {
  if (parts.length === 1) return parts[0];
  const o = new Uint8Array(total); let p = 0;
  for (const x of parts) { o.set(x, p); p += x.length; }
  return o;
}
function withTimeout(promise, ms) {
  let id;
  return Promise.race([promise, new Promise((_, rej) => { id = setTimeout(() => rej(new TimeoutError()), ms); })]).finally(() => clearTimeout(id));
}

/* ---------- поток байт -> ответы (строка до \n или блок #N) ---------- */
class StreamParser {
  constructor() { this.buf = new Uint8Array(1 << 16); this.len = 0; this.wait = null; }
  feed(u) {
    if (this.len + u.length > this.buf.length) {
      const n = new Uint8Array(Math.max(this.buf.length * 2, this.len + u.length)); n.set(this.buf.subarray(0, this.len)); this.buf = n;
    }
    this.buf.set(u, this.len); this.len += u.length;
    if (this.wait) { const w = this.wait; this.wait = null; w(); }
  }
  flush() { this.len = 0; }
  take() {
    const b = this.buf, n = this.len;
    if (!n) return null;
    if (b[0] === 0x23) {                                  // #<d><len><data>\n
      if (n < 2) return null;
      const d = b[1] - 48;
      if (d === 0) { let i = 2; while (i < n && b[i] !== 10) i++; if (i >= n) return null; return this.cut(i + 1); }
      if (n < 2 + d) return null;
      const size = parseInt(dec.decode(b.subarray(2, 2 + d)), 10);
      const end = 2 + d + size;
      if (n < end) return null;
      return this.cut(n > end && b[end] === 10 ? end + 1 : end);
    }
    const i = b.subarray(0, n).indexOf(10);
    return i < 0 ? null : this.cut(i + 1);
  }
  cut(k) { const o = this.buf.slice(0, k); this.buf.copyWithin(0, k, this.len); this.len -= k; return o; }
  async next(timeout) {
    const end = performance.now() + timeout;
    for (; ;) {
      const m = this.take();
      if (m) return m;
      const left = end - performance.now();
      if (left <= 0) throw new TimeoutError();
      await new Promise(r => { const id = setTimeout(() => { this.wait = null; r(); }, left); this.wait = () => { clearTimeout(id); r(); }; });
    }
  }
}

/* ---------- Web Serial: кабельный COM-порт и Bluetooth SPP ---------- */
const SPP_UUID = '00001101-0000-1000-8000-00805f9b34fb';

class SerialLink extends Emitter {
  static label = 'COM / Bluetooth SPP';
  static get available() { return !!navigator.serial; }
  constructor(port, baud = 115200) { super(); this.port = port; this.baud = baud; this.parser = new StreamParser(); this.kind = 'serial'; this.name = 'COM-порт'; }
  static async pick(baud) {
    const o = {};
    try { o.allowedBluetoothServiceClassIds = [SPP_UUID]; return new SerialLink(await navigator.serial.requestPort(o), baud); }
    catch (e) { if (e.name === 'TypeError') return new SerialLink(await navigator.serial.requestPort(), baud); throw e; }
  }
  async open() {
    await this.port.open({ baudRate: this.baud, bufferSize: 1 << 16 });
    this.writer = this.port.writable.getWriter();
    this.alive = true;
    this.pump();
    const info = this.port.getInfo?.() || {};
    if (info.bluetoothServiceClassId) { this.name = 'Bluetooth SPP'; this.kind = 'bt'; }
    await this.send('\n');
    await sleep(60); this.parser.flush();
  }
  async pump() {
    while (this.alive && this.port.readable) {
      this.reader = this.port.readable.getReader();
      try {
        for (; ;) { const { value, done } = await this.reader.read(); if (done) break; if (value) this.parser.feed(value); }
      } catch (e) { if (this.alive) this.emit('lost', e); break; } finally { this.reader.releaseLock(); }
    }
  }
  async close() {
    this.alive = false;
    try { await this.reader?.cancel(); } catch { }
    try { this.writer?.releaseLock(); } catch { }
    try { await this.port.close(); } catch { }
  }
  async send(data) { const s = typeof data === 'string' && !data.endsWith('\n') ? data + '\n' : data; await this.writer.write(toBytes(s)); }
  recv(timeout = 3000) { return this.parser.next(timeout); }
  abort() { this.parser.flush(); }
}

/* ---------- Web Bluetooth: BLE-канал модуля. Служба заранее не задокументирована,
   поэтому перебираем известные UART-службы и берём характеристики по их свойствам. */
const BLE_SERVICES = [
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e',            // Nordic UART
  0xFFE0, 0xFFF0, 0xFF00, 0xFF10, 0xFFE5, 0xAE00, 0xAE30, 0xFEE7, 0xFFB0, 0xFFC0, 0xFFD0, 0xFD00, 0x18F0,
  '49535343-fe7d-4ae5-8fa9-9fafd205e455',            // ISSC/Microchip
  '0000fff0-0000-1000-8000-00805f9b34fb',
];

class BleLink extends Emitter {
  static label = 'Bluetooth LE';
  static get available() { return !!navigator.bluetooth; }
  constructor(device) { super(); this.dev = device; this.parser = new StreamParser(); this.kind = 'bt'; this.name = device?.name || 'BLE'; this.mtu = 20; }
  static async pick() {
    return new BleLink(await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'DM40' }, { namePrefix: 'C-1-ATK' }, { namePrefix: 'LT1' }, { namePrefix: 'ATK' }],
      optionalServices: BLE_SERVICES,
    }));
  }
  async open() {
    this.dev.addEventListener('gattserverdisconnected', () => this.emit('lost', new Error('Bluetooth отключился')));
    const srv = await this.dev.gatt.connect();
    const services = await srv.getPrimaryServices();
    for (const s of services) {
      let tx = null, rx = null;
      for (const c of await s.getCharacteristics()) {
        if (!rx && (c.properties.notify || c.properties.indicate)) rx = c;
        if (!tx && (c.properties.writeWithoutResponse || c.properties.write)) tx = c;
      }
      if (tx && rx) { this.tx = tx; this.rx = rx; this.service = s.uuid; break; }
    }
    if (!this.tx) throw new Error('В приборе не найден канал обмена BLE. Подключитесь через Bluetooth SPP.');
    this.rx.addEventListener('characteristicvaluechanged', e => { const d = e.target.value; this.parser.feed(new Uint8Array(d.buffer, d.byteOffset, d.byteLength)); });
    await this.rx.startNotifications();
  }
  async close() { try { await this.rx?.stopNotifications(); } catch { } try { this.dev.gatt.disconnect(); } catch { } }
  async send(data) {
    const b = toBytes(typeof data === 'string' && !data.endsWith('\n') ? data + '\n' : data);
    for (let i = 0; i < b.length; i += this.mtu) {
      const part = b.subarray(i, i + this.mtu);
      if (this.tx.properties.writeWithoutResponse) await this.tx.writeValueWithoutResponse(part); else await this.tx.writeValue(part);
    }
  }
  recv(timeout = 4000) { return this.parser.next(timeout); }
  abort() { this.parser.flush(); }
}

/* ---------- мост WebSocket: для браузеров без WebUSB/Web Serial (tools/bridge.py) ---------- */
class WsLink extends Emitter {
  static label = 'Мост WebSocket';
  static get available() { return true; }
  constructor(url) { super(); this.url = url; this.parser = new StreamParser(); this.kind = 'ws'; this.name = url; }
  open() {
    return new Promise((res, rej) => {
      const w = this.ws = new WebSocket(this.url); w.binaryType = 'arraybuffer';
      w.onopen = () => res(); w.onerror = () => rej(new Error('Мост не отвечает: ' + this.url));
      w.onclose = () => this.emit('lost', new Error('Мост закрыт'));
      w.onmessage = e => this.parser.feed(typeof e.data === 'string' ? enc.encode(e.data) : new Uint8Array(e.data));
    });
  }
  async close() { try { this.ws.close(); } catch { } }
  async send(data) { this.ws.send(toBytes(typeof data === 'string' && !data.endsWith('\n') ? data + '\n' : data)); }
  recv(timeout = 3000) { return this.parser.next(timeout); }
  abort() { this.parser.flush(); }
}

/* ---------- Link: очередь запросов с приоритетом, счётчики, разбор блоков ---------- */
class Link extends Emitter {
  constructor(tr) {
    super(); this.tr = tr; this.q = [[], []]; this.running = false;
    this.bytes = 0; this.msgs = 0; this.errors = 0; this.log = null;
    tr.on?.('lost', e => this.emit('lost', e));
  }
  run(fn, prio = 1) {
    return new Promise((res, rej) => { this.q[prio].push({ fn, res, rej }); this.pump(); });
  }
  async pump() {
    if (this.running) return;
    this.running = true;
    for (; ;) {
      const j = this.q[0].shift() || this.q[1].shift();
      if (!j) break;
      try { j.res(await j.fn()); } catch (e) { this.errors++; j.rej(e); }
    }
    this.running = false;
  }
  tx(cmd) { this.log?.('tx', cmd); return this.tr.send(cmd); }
  async rx(timeout) {
    const b = await this.tr.recv(timeout);
    this.bytes += b.length; this.msgs++;
    return b;
  }
  write(cmd, prio = 0) { return this.run(() => this.tx(cmd), prio); }
  query(cmd, { timeout = 3000, prio = 1 } = {}) {
    return this.run(async () => {
      await this.tx(cmd);
      const s = dec.decode(await this.rx(timeout)).trim();
      this.log?.('rx', s);
      return s;
    }, prio);
  }
  /* Ответ-блок: возвращает только данные. */
  block(cmd, { timeout = 5000, prio = 1 } = {}) {
    return this.run(async () => {
      await this.tx(cmd);
      const b = await this.rx(timeout);
      this.log?.('rx', `[блок ${b.length} байт]`);
      return parseBlock(b);
    }, prio);
  }
  async num(cmd, o) { return parseFloat(await this.query(cmd, o)); }
}

function parseBlock(b) {
  if (b[0] !== 0x23) return new Uint8Array(0);
  const d = b[1] - 48;
  if (d <= 0) return new Uint8Array(0);
  const size = parseInt(dec.decode(b.subarray(2, 2 + d)), 10);
  return b.subarray(2 + d, 2 + d + size);
}
