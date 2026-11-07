'use strict';
/* Пульт: общие помощники, хранилище настроек, шина величин. Без зависимостей. */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'value') e.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'hidden') e[k] = !!v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
}

const store = {
  get(k, d) { try { const v = localStorage.getItem('pult.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('pult.' + k, JSON.stringify(v)); } catch { /* приватное окно */ } },
};

class Emitter {
  constructor() { this.l = new Map(); }
  on(ev, fn) { if (!this.l.has(ev)) this.l.set(ev, new Set()); this.l.get(ev).add(fn); return () => this.l.get(ev).delete(fn); }
  emit(ev, ...a) { const s = this.l.get(ev); if (s) for (const f of [...s]) { try { f(...a); } catch (e) { console.error(e); } } }
}

/* ---------- единицы и числа ---------- */
const UNIT_RU = { V: 'В', A: 'А', 'Ω': 'Ом', F: 'Ф', H: 'Гн', Hz: 'Гц', W: 'Вт', VA: 'ВА', var: 'вар', Wh: 'Вт·ч', s: 'с' };
const PREFIX_RU = { G: 'Г', M: 'М', k: 'к', '': '', m: 'м', 'µ': 'мк', n: 'н', p: 'п' };
const opts = { ruUnits: store.get('ruUnits', true) };

function unitText(prefix, unit) {
  if (!opts.ruUnits) return prefix + unit;
  const base = UNIT_RU[unit];
  return base === undefined ? prefix + unit : (PREFIX_RU[prefix] ?? prefix) + base;
}

const SI = [[1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p']];
const NO_PREFIX = new Set(['°C', '°F', '°', '%', '', 'Wh', 'PF']);

/* Разбивает число на мантиссу и приставку. digits: значащих цифр. */
function siParts(v, unit, digits = 6) {
  if (v === null || v === undefined || Number.isNaN(v)) return { text: '-----', unit: unitText('', unit), over: false, none: true };
  if (!Number.isFinite(v) || Math.abs(v) >= 9.8e37) return { text: 'OL', unit: unitText('', unit), over: true };
  if (NO_PREFIX.has(unit)) {
    const a = Math.abs(v), dec = a >= 1000 ? 1 : a >= 100 ? 2 : a >= 10 ? 3 : 4;
    return { text: v.toFixed(Math.max(0, Math.min(dec, digits - 1))), unit };
  }
  const a = Math.abs(v);
  let m = 1, p = '';
  if (a !== 0) { for (const [f, s] of SI) { if (a >= f * 0.99999) { m = f; p = s; break; } m = f; p = s; } }
  const x = v / m, ax = Math.abs(x);
  const lead = ax >= 100 ? 3 : ax >= 10 ? 2 : 1;
  return { text: x.toFixed(Math.max(0, digits - lead)), unit: unitText(p, unit) };
}
function fmtSI(v, unit = '', digits = 5) { const p = siParts(v, unit, digits); return p.unit ? p.text + ' ' + p.unit : p.text; }

/* Шаг 1-2-5 вокруг значения. */
function step125(v, dir, lo = 1e-12, hi = 1e12) {
  const e = Math.floor(Math.log10(v) + 1e-9), m = v / 10 ** e;
  const list = [1, 2, 5, 10];
  let i = list.findIndex(x => m <= x * 1.0001);
  if (i < 0) i = 3;
  if (Math.abs(m - list[i]) > 0.001 * m && dir > 0) i -= 1;
  const n = list[i + dir] ?? (dir > 0 ? 20 : 0.5);
  return clamp(n * 10 ** e, lo, hi);
}

function niceTicks(lo, hi, n = 5) {
  if (!(hi > lo)) { hi = lo + 1; lo -= 1; }
  const span = hi - lo, raw = span / n, mag = 10 ** Math.floor(Math.log10(raw));
  const nice = [1, 2, 2.5, 5, 10].find(x => x * mag >= raw) * mag;
  const start = Math.ceil(lo / nice - 1e-9) * nice, out = [];
  for (let v = start; v <= hi + nice * 1e-6; v += nice) out.push(Math.abs(v) < nice * 1e-9 ? 0 : v);
  return out;
}

function logTicks(lo, hi) {
  const out = [];
  for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) for (const m of [1, 2, 5]) {
    const v = m * 10 ** e;
    if (v >= lo * 0.999 && v <= hi * 1.001) out.push({ v, major: m === 1 });
  }
  return out;
}

function saveFile(name, data, type = 'text/plain') {
  const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function stamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function toast(text, kind = 'info', ms = 4200) {
  const box = $('#toasts');
  if (!box) return;
  const t = h('div', { class: 'toast ' + kind, role: 'status' }, text);
  box.append(t);
  setTimeout(() => t.remove(), ms);
}

/* ---------- величины ---------- */
const HIST = 40000;

class Quantity {
  constructor(def) {
    Object.assign(this, { id: def.id, name: def.name, unit: def.unit ?? '', dev: def.dev ?? '', group: def.group ?? '', hint: def.hint ?? '', digits: def.digits ?? 6, full: def.full ?? 0, custom: def.custom });
    this.t = new Float64Array(HIST); this.v = new Float64Array(HIST);
    this.n = 0; this.head = 0; this.last = NaN; this.lastT = 0; this.flags = '';
    this.resetStats();
  }
  resetStats() { this.cnt = 0; this.min = Infinity; this.max = -Infinity; this.mean = 0; this.m2 = 0; }
  push(v, t) {
    this.t[this.head] = t; this.v[this.head] = v;
    this.head = (this.head + 1) % HIST; if (this.n < HIST) this.n++;
    this.last = v; this.lastT = t;
    if (Number.isFinite(v) && Math.abs(v) < 9e37) {
      this.cnt++; if (v < this.min) this.min = v; if (v > this.max) this.max = v;
      const d = v - this.mean; this.mean += d / this.cnt; this.m2 += d * (v - this.mean);
    }
  }
  get sd() { return this.cnt > 1 ? Math.sqrt(this.m2 / (this.cnt - 1)) : 0; }
  at(i) { const k = (this.head - this.n + i + HIST * 2) % HIST; return [this.t[k], this.v[k]]; }
  clear() { this.n = 0; this.head = 0; this.last = NaN; this.resetStats(); }
}

const Hub = new (class extends Emitter {
  constructor() { super(); this.q = new Map(); this.rev = 0; }
  define(def) {
    let q = this.q.get(def.id);
    if (q) { Object.assign(q, { name: def.name ?? q.name, unit: def.unit ?? q.unit, full: def.full ?? q.full, hint: def.hint ?? q.hint }); return q; }
    q = new Quantity(def); this.q.set(def.id, q); this.rev++; this.emit('defs'); return q;
  }
  remove(id) { if (this.q.delete(id)) { this.rev++; this.emit('defs'); } }
  removeDev(dev) { for (const q of [...this.q.values()]) if (q.dev === dev) this.q.delete(q.id); this.rev++; this.emit('defs'); }
  push(id, v, t = performance.now()) { const q = this.q.get(id); if (q) { q.push(v, t); this.emit('sample', q, v, t); } }
  list() { return [...this.q.values()]; }
})();

/* ---------- вычисляемые величины: x = выражение от других ---------- */
const Calc = {
  items: store.get('calc', []),
  compile(expr) {
    if (!/^[\w\s.+\-*/()%^,:]*$/.test(expr)) throw new Error('В выражении есть недопустимые символы');
    const names = [...new Set(expr.match(/[a-zA-Z_][\w.]*:?[\w.]*/g) || [])].filter(n => !Object.getOwnPropertyNames(Math).includes(n));
    const body = expr.replace(/\^/g, '**').replace(/[a-zA-Z_][\w.]*:?[\w.]*/g, m => names.includes(m) ? `g(${JSON.stringify(m)})` : `Math.${m}`);
    return new Function('g', `return (${body});`);
  },
  save() { store.set('calc', this.items); },
};
