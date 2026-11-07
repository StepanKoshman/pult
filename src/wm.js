'use strict';
/* Темы, окна, рабочие столы. */

const THEMES = [
  // id, название, группа, цифры, токены: фон стола, панель, приподнятое, линия, текст x3, акцент, на акценте, экран, цифры, сетка, лучи x4
  { id: 'stend', name: 'Стенд', tone: 'dark', t: ['#0E1418', '#162026', '#1F2C34', '#2D3D47', '#E8EEF2', '#A8B8C3', '#74868F', '#F0A63A', '#201505', '#0A0F12', '#FFC46B', '#22313A', '#F2C14E', '#54C6F0', '#F27BB5', '#86DE97'] },
  { id: 'fosfor', name: 'Фосфор', tone: 'dark', t: ['#07110B', '#0D1B12', '#14281B', '#1F3D2A', '#D6F5DF', '#8FC7A2', '#5F9374', '#3FE07F', '#04170A', '#040B06', '#6CFFA3', '#143021', '#6CFFA3', '#F5D76E', '#7FD4FF', '#FF9C9C'], glow: 1 },
  { id: 'yantar', name: 'Янтарь', tone: 'dark', t: ['#120C05', '#1C1309', '#281C0E', '#3F2D16', '#FBE7C6', '#CDAE80', '#957A54', '#FFB000', '#1E1200', '#0B0703', '#FFB84D', '#33240F', '#FFB84D', '#7FD1C7', '#FF8A5C', '#D9E58A'], glow: 1 },
  { id: 'vfd', name: 'Вакуумный дисплей', tone: 'dark', seg: 1, t: ['#091315', '#0F1E21', '#16292D', '#23404A', '#D8F4F2', '#8FBCBC', '#5F8C8E', '#3CE6D2', '#03201C', '#050D0E', '#54F5E0', '#123036', '#54F5E0', '#F7C86B', '#F58BC9', '#A6E77D'], glow: 1 },
  { id: 'nixie', name: 'Никси', tone: 'dark', t: ['#150B0E', '#211216', '#2E1A1F', '#4A2A30', '#F7E4DC', '#C9A39A', '#92716A', '#FF7A3D', '#260E03', '#0D0507', '#FF8C4D', '#361A20', '#FF8C4D', '#6FC8E8', '#EFD46B', '#B79BFF'], glow: 1 },
  { id: 'okean', name: 'Океан', tone: 'dark', t: ['#0A1626', '#102238', '#17304D', '#25466B', '#E3EEFA', '#9DB7D3', '#6A88A8', '#4EB2FF', '#04182B', '#071220', '#7CC6FF', '#1A3350', '#FFD166', '#6FD9FF', '#FF8FA3', '#9BE58C'] },
  { id: 'carbon', name: 'Карбон', tone: 'dark', t: ['#0C0C0D', '#161617', '#202022', '#333336', '#F0F0F1', '#ADADB2', '#77777D', '#FF5A47', '#200503', '#060607', '#FF6B59', '#262628', '#FFD24D', '#5CC8FF', '#FF7AC2', '#7BE08F'] },
  { id: 'lavanda', name: 'Лаванда', tone: 'dark', t: ['#14111F', '#1E1A2E', '#292440', '#40395E', '#ECE8F7', '#B3ABCF', '#8279A3', '#B79BFF', '#180F33', '#0E0B17', '#C9B5FF', '#2B2545', '#FFC96B', '#7FD3FF', '#FF90C2', '#8FE3A8'] },
  { id: 'tayga', name: 'Тайга', tone: 'dark', t: ['#0D1612', '#14211B', '#1C2E26', '#2E473B', '#E4F0E9', '#A2BCAE', '#6F8A7C', '#D7C463', '#1C1704', '#0A120E', '#E6D477', '#21362C', '#E6D477', '#74CFE0', '#F09A8A', '#9BE0A6'] },
  { id: 'led', name: 'Красные сегменты', tone: 'dark', seg: 1, t: ['#120B0B', '#1D1213', '#2A1A1B', '#452B2D', '#F4E3E3', '#C5A2A2', '#8F7172', '#FF4D4D', '#200404', '#0C0505', '#FF5A52', '#2F1C1D', '#FF6B5E', '#62C9EE', '#F4C95D', '#9BDF8B'], glow: 1 },
  { id: 'noch', name: 'Ночное зрение', tone: 'dark', t: ['#090303', '#120606', '#1C0A0A', '#3A1414', '#E68A8A', '#B76060', '#8A4545', '#E05252', '#120000', '#060202', '#E86A6A', '#2A0F0F', '#E86A6A', '#C78A4A', '#B05A8A', '#A08A4A'] },
  { id: 'contrast', name: 'Контраст', tone: 'dark', t: ['#000000', '#000000', '#111111', '#FFFFFF', '#FFFFFF', '#FFFFFF', '#DDDDDD', '#FFE600', '#000000', '#000000', '#FFFFFF', '#555555', '#FFE600', '#00E5FF', '#FF6BD6', '#6BFF6B'] },
  { id: 'lab', name: 'Лаборатория', tone: 'light', t: ['#E7ECEF', '#F7F9FA', '#FFFFFF', '#CBD5DB', '#16222A', '#47585F', '#6A7A82', '#0B6E99', '#FFFFFF', '#FFFFFF', '#0E2A38', '#DCE4E9', '#B97800', '#0B6E99', '#B8327A', '#2E7D32'] },
  { id: 'lcd', name: 'ЖК-индикатор', tone: 'light', seg: 1, t: ['#C9CFC4', '#DDE2D6', '#EBEFE5', '#AEB6A8', '#1E2419', '#47513F', '#626C59', '#3E5C3A', '#F2F6EE', '#B9C4AE', '#20281B', '#A3AF98', '#20281B', '#3E5C8C', '#8C3E6B', '#7A5A1E'] },
  { id: 'bumaga', name: 'Самописец', tone: 'light', t: ['#EFE6DA', '#FBF6EE', '#FFFDF8', '#DCCFBE', '#2A211A', '#5E5145', '#7C6E60', '#B23A48', '#FFF8F2', '#FFFDF8', '#2A211A', '#F0D4CF', '#1D4E89', '#B23A48', '#2E7D5B', '#8A5A00'] },
  { id: 'platina', name: 'Платина', tone: 'light', t: ['#D9DBDE', '#ECEDEF', '#F7F8F9', '#BEC2C7', '#1C1E22', '#4D5157', '#6C7077', '#4A4FC4', '#FFFFFF', '#F7F8F9', '#20222A', '#D5D8DC', '#A85F00', '#2F5FBF', '#AD2F76', '#28783C'] },
];

const Theme = {
  colors: {}, cur: null, rev: 0,
  apply(id) {
    const th = THEMES.find(t => t.id === id) || THEMES[0], t = th.t, r = document.documentElement;
    const names = ['bg', 'panel', 'raised', 'line', 'ink', 'ink2', 'ink3', 'accent', 'on-accent', 'screen', 'screen-ink', 'grid', 't1', 't2', 't3', 't4'];
    names.forEach((n, i) => r.style.setProperty('--' + n, t[i]));
    r.style.setProperty('color-scheme', th.tone);
    r.dataset.tone = th.tone; r.dataset.seg = th.seg ? '1' : ''; r.dataset.glow = th.glow ? '1' : '';
    const c = {}; names.forEach((n, i) => c[n] = t[i]);
    c.t = [t[12], t[13], t[14], t[15]];
    this.colors = c; this.cur = th; this.rev++;
    Bus.emit('theme');
  },
  pick(id) { store.set('look', id); this.apply(id); },
  start() {
    const saved = store.get('look', null);
    const host = document.documentElement.getAttribute('data-theme');
    const light = host ? host === 'light' : matchMedia?.('(prefers-color-scheme: light)').matches;
    this.apply(saved || (light ? 'lab' : 'stend'));
  },
};
const Bus = new Emitter();

/* ---------- семисегментные цифры ---------- */
const SEG = { 0: 'abcdef', 1: 'bc', 2: 'abdeg', 3: 'abcdg', 4: 'bcfg', 5: 'acdfg', 6: 'acdefg', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg', '-': 'g', ' ': '', O: 'abcdef', L: 'def', E: 'adefg', r: 'eg' };
const SEG_PATH = {
  a: 'M2 1h16l-3 3H5z', b: 'M19 2v15l-3-2.2V5z', c: 'M19 19v15l-3-3V21.2z', d: 'M2 35h16l-3-3H5z', e: 'M1 19v15l3-3V21.2z', f: 'M1 2v15l3-2.2V5z', g: 'M2.5 18l2.5-2h10l2.5 2-2.5 2H5z',
};
function segSvg(text) {
  let x = 0, out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '.' || ch === ',') { out += `<circle cx="${x - 1.2}" cy="33.6" r="1.7"/>`; x += 2.2; continue; }
    const on = SEG[ch] ?? '';
    for (const s of 'abcdefg') out += `<path transform="translate(${x})" d="${SEG_PATH[s]}"${on.includes(s) ? '' : ' class="off"'}/>`;
    x += 24;
  }
  return `<svg class="segs" viewBox="0 0 ${x} 36" aria-hidden="true">${out}</svg>`;
}

/* ---------- окна ---------- */
const GRID = 8;
const snap = v => Math.round(v / GRID) * GRID;

class Win {
  constructor(desk, type, cfg, geom) {
    this.desk = desk; this.type = type; this.cfg = cfg || {}; this.def = WM.types[type]; this.subs = [];
    const g = this.geom = { x: 16, y: 16, w: this.def.w || 360, h: this.def.h || 240, ...geom };
    this.titleEl = h('span', { class: 'win-title', text: this.def.title });
    this.lamp = h('i', { class: 'lamp' });
    this.toolbar = h('span', { class: 'win-tools' });
    const bar = h('div', { class: 'win-bar', ondblclick: e => { if (!e.target.closest('button,select,input')) this.toggleMax(); } }, this.lamp, this.titleEl, this.toolbar,
      h('button', { class: 'wbtn', title: 'Развернуть', 'aria-label': 'Развернуть окно', onclick: () => this.toggleMax() }, '▢'),
      h('button', { class: 'wbtn', title: 'Закрыть', 'aria-label': 'Закрыть окно', onclick: () => WM.close(this) }, '×'));
    this.body = h('div', { class: 'win-body' });
    this.el = h('section', { class: 'win', 'aria-label': this.def.title }, bar, this.body);
    for (const d of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) this.el.append(h('b', { class: 'rz rz-' + d, 'data-d': d }));
    this.place();
    this.el.addEventListener('pointerdown', () => WM.front(this), true);
    bar.addEventListener('pointerdown', e => this.startMove(e));
    this.el.addEventListener('pointerdown', e => { if (e.target.classList.contains('rz')) this.startResize(e); });
    this.mount();
  }
  sub(em, ev, fn) { this.subs.push(em.on(ev, fn)); }
  mount() {
    this.teardown();
    const d = this.def, build = () => {
      this.body.replaceChildren(); this.toolbar.replaceChildren();
      if (d.dev) {
        const dev = Devices.get(this.cfg.dev || d.dev);
        this.dev = dev;
        if (!dev) { this.lamp.className = 'lamp'; this.body.append(noDevice(d)); return; }
        this.lamp.className = 'lamp ok';
        this.sub(dev, 'state', () => { this.lamp.className = 'lamp ' + dev.state; });
      }
      this.api = d.make(this, this.dev, this.cfg) || {};
    };
    this.rebuild = () => { this.teardown(); build(); };
    build();
    this.devsub = Devices.on('change', () => {
      if (!d.dev) return;
      const dev = Devices.get(this.cfg.dev || d.dev);
      if (dev !== this.dev) this.rebuild();
    });
  }
  teardown() { this.api?.dispose?.(); this.api = null; for (const s of this.subs) s(); this.subs = []; }
  destroy() { this.teardown(); this.devsub?.(); this.el.remove(); }
  place() { const g = this.geom, s = this.el.style; s.left = g.x + 'px'; s.top = g.y + 'px'; s.width = g.w + 'px'; s.height = g.h + 'px'; }
  title(t) { this.titleEl.textContent = t; }
  toggleMax() {
    if (this.prev) { this.geom = this.prev; this.prev = null; this.el.classList.remove('max'); }
    else { this.prev = { ...this.geom }; const b = this.desk.el; this.geom = { x: b.scrollLeft, y: b.scrollTop, w: b.clientWidth, h: b.clientHeight }; this.el.classList.add('max'); }
    this.place(); WM.save();
  }
  startMove(e) {
    if (e.button || e.target.closest('button,select,input') || WM.narrow()) return;
    e.preventDefault();
    const g = this.geom, x0 = e.clientX, y0 = e.clientY, gx = g.x, gy = g.y, t = e.currentTarget;
    t.setPointerCapture(e.pointerId);
    const mv = ev => { g.x = Math.max(0, snap(gx + ev.clientX - x0)); g.y = Math.max(0, snap(gy + ev.clientY - y0)); this.place(); };
    const up = () => { t.removeEventListener('pointermove', mv); t.removeEventListener('pointerup', up); WM.save(); };
    t.addEventListener('pointermove', mv); t.addEventListener('pointerup', up);
  }
  startResize(e) {
    if (WM.narrow()) return;
    e.preventDefault(); e.stopPropagation();
    const d = e.target.dataset.d, g = this.geom, s = { ...g }, x0 = e.clientX, y0 = e.clientY, t = e.target;
    const minW = 200, minH = 110;
    t.setPointerCapture(e.pointerId);
    const mv = ev => {
      const dx = ev.clientX - x0, dy = ev.clientY - y0;
      if (d.includes('e')) g.w = Math.max(minW, snap(s.w + dx));
      if (d.includes('s')) g.h = Math.max(minH, snap(s.h + dy));
      if (d.includes('w')) { const w = Math.max(minW, snap(s.w - dx)); g.x = Math.max(0, s.x + s.w - w); g.w = w; }
      if (d.includes('n')) { const hh = Math.max(minH, snap(s.h - dy)); g.y = Math.max(0, s.y + s.h - hh); g.h = hh; }
      this.place();
    };
    const up = () => { t.removeEventListener('pointermove', mv); t.removeEventListener('pointerup', up); WM.save(); };
    t.addEventListener('pointermove', mv); t.addEventListener('pointerup', up);
  }
}

function noDevice(def) {
  return h('div', { class: 'nodev' }, h('p', { text: `${def.devName || def.dev.toUpperCase()} не подключён.` }), h('button', { class: 'btn', onclick: () => App.connectDialog() }, 'Подключить прибор'));
}

const WM = {
  types: {}, desks: [], cur: 0, z: 10,
  define(t, d) { this.types[t] = d; },
  narrow() { return innerWidth < 720; },
  get desk() { return this.desks[this.cur]; },
  open(type, cfg, geom) {
    const d = this.desk;
    if (!this.types[type]) return null;
    const def = this.types[type], area = d.el, n = d.wins.length;
    const g = geom || { x: snap(16 + (n % 7) * 32 + area.scrollLeft), y: snap(16 + (n % 7) * 32 + area.scrollTop), w: def.w || 360, h: def.h || 240 };
    const w = new Win(d, type, cfg, g);
    d.wins.push(w); area.append(w.el); this.front(w); this.save();
    return w;
  },
  close(w) { w.destroy(); const d = w.desk; d.wins = d.wins.filter(x => x !== w); this.save(); },
  front(w) { if (w.el.style.zIndex !== String(this.z)) w.el.style.zIndex = ++this.z; },
  addDesk(name, layout = []) {
    const d = { name, wins: [], el: h('div', { class: 'desk', hidden: true }) };
    $('#desks').append(d.el);
    this.desks.push(d);
    const keep = this.cur; this.cur = this.desks.length - 1;
    for (const l of layout) if (this.types[l.type]) { const w = new Win(d, l.type, l.cfg, l.g); d.wins.push(w); d.el.append(w.el); }
    this.cur = keep;
    return d;
  },
  show(i) {
    this.cur = clamp(i, 0, this.desks.length - 1);
    this.desks.forEach((d, k) => { d.el.hidden = k !== this.cur; });
    Bus.emit('desk');
    store.set('desk', this.cur);
  },
  removeDesk(i) {
    if (this.desks.length < 2) return;
    const [d] = this.desks.splice(i, 1);
    for (const w of d.wins) w.destroy();
    d.el.remove();
    this.show(Math.min(this.cur, this.desks.length - 1)); this.save();
  },
  layout() { return this.desks.map(d => ({ name: d.name, wins: d.wins.map(w => ({ type: w.type, cfg: w.cfg, g: w.prev || w.geom })) })); },
  save() { if (this.loading) return; clearTimeout(this.t); this.t = setTimeout(() => store.set('layout', this.layout()), 200); },
  load(list) {
    this.loading = true;
    for (const d of [...this.desks]) { for (const w of d.wins) w.destroy(); d.el.remove(); }
    this.desks = [];
    for (const d of list) this.addDesk(d.name, d.wins);
    this.loading = false;
    this.show(clamp(store.get('desk', 0), 0, this.desks.length - 1));
    Bus.emit('desks');
  },
};

/* ---------- холст с учётом плотности экрана ---------- */
class Plot {
  constructor(box, cls = '') {
    this.c = h('canvas', { class: 'plot ' + cls }); box.append(this.c);
    this.g = this.c.getContext('2d', { alpha: true });
    this.w = 0; this.h = 0; this.dirty = true;
    this.ro = new ResizeObserver(() => this.fit()); this.ro.observe(box); this.box = box;
    this.fit();
  }
  fit() {
    const r = this.box.getBoundingClientRect(), d = devicePixelRatio || 1;
    const w = Math.max(10, Math.round(r.width)), hh = Math.max(10, Math.round(r.height));
    if (w === this.w && hh === this.h) return;
    this.w = w; this.h = hh; this.c.width = w * d; this.c.height = hh * d; this.c.style.width = w + 'px'; this.c.style.height = hh + 'px';
    this.g.setTransform(d, 0, 0, d, 0, 0); this.dirty = true; this.onresize?.();
  }
  dispose() { this.ro.disconnect(); }
}
const pad = n => String(n).padStart(2, '0');
const fmtClock = ms => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const FONT = (s, w = 400) => `${w} ${s}px ${getComputedStyle(document.documentElement).getPropertyValue('--f-mono') || 'monospace'}`;

/* ---------- мелкие элементы управления ---------- */
function seg(options, value, onchange, label) {
  const box = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': label });
  const btns = [];
  for (const [v, text, title] of options) {
    const b = h('button', { role: 'radio', title, onclick: () => { set(v); onchange(v); } }, text);
    b.dataset.v = v; btns.push(b); box.append(b);
  }
  function set(v) { for (const b of btns) { const on = b.dataset.v === String(v); b.classList.toggle('on', on); b.setAttribute('aria-checked', on); } }
  set(value); box.set = set; box.btns = btns;
  return box;
}
function field(label, ...kids) { return h('label', { class: 'field' }, h('span', { text: label }), ...kids); }
function select(options, value, onchange, label) {
  const s = h('select', { 'aria-label': label, onchange: () => onchange(s.value) });
  for (const [v, t] of options) s.append(h('option', { value: v, text: t }));
  s.value = value; return s;
}
function toggle(text, on, onchange) {
  const b = h('button', { class: 'tgl', 'aria-pressed': on ? 'true' : 'false', onclick: () => { const v = b.getAttribute('aria-pressed') !== 'true'; b.setAttribute('aria-pressed', v); onchange(v); } }, text);
  b.set = v => b.setAttribute('aria-pressed', v ? 'true' : 'false');
  return b;
}
/* Числовое поле с шагом 1-2-5 или любым. */
function stepper(value, fmt, onstep, label) {
  const v = h('output', { class: 'st-val', text: fmt(value) });
  const box = h('div', { class: 'stepper', role: 'group', 'aria-label': label },
    h('button', { 'aria-label': label + ' меньше', onclick: () => onstep(-1) }, '−'), v, h('button', { 'aria-label': label + ' больше', onclick: () => onstep(1) }, '+'));
  box.set = x => { v.textContent = fmt(x); };
  return box;
}
