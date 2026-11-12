'use strict';
/* Запуск, верхняя панель, диалоги, стартовые столы. */

const WINDOW_GROUPS = [
  ['Любой прибор', [['reading', 'Большое показание', 'Одна величина крупно, статистика'], ['table', 'Таблица величин', 'Много величин, мин, макс, среднее'], ['trend', 'Тренд', 'История на отдельных дорожках'], ['recorder', 'Запись данных', 'Выбранные величины в CSV'], ['console', 'Консоль SCPI', 'Ручные команды и ответы'], ['quantities', 'Величины', 'Добавить, изменить, убрать'], ['settings', 'Настройки прибора', 'Все параметры списком']]],
  ['LT1', [['lt1-lcr', 'Измеритель', 'R, L, C, Z, D, Q, θ и настройки'], ['lt1-sweep', 'АЧХ и ФЧХ', 'Скан на 100 точек']]],
  ['tinySA', [['sa-spectrum', 'Анализатор спектра', 'Скан до 100000 точек, пики, водопад'], ['sa-screen', 'Экран', 'Трансляция экрана и нажатия'], ['sa-settings', 'Настройки', 'Режим, приём, генератор, команды']]],
  ['DM40', [['dm40-dmm', 'Мультиметр', 'Функции, пределы, скорость'], ['dm40-scope', 'Осциллограф', 'Живой сигнал, спектр, курсоры, запись'], ['dm40-gen', 'Генератор', 'Форма, частота, размах'], ['dm40-power', 'Ваттметр', 'P, S, Q, PF, энергия'], ['dm40-stream', 'Поток преобразователя', 'Каждый отсчёт AD1 или AD2'], ['dm40-decode', 'Декодер', 'UART, Modbus, DALI'], ['dm40-inrush', 'Пусковой ток', 'Захват броска тока'], ['dm40-files', 'Файлы', 'Снимки, записи, журналы'], ['dm40-screen', 'Экран прибора', 'Управление касанием через USB']]],
];

const DEFAULT_LAYOUT = () => [
  { name: 'Обзор', wins: [
    { type: 'lt1-lcr', cfg: {}, g: { x: 16, y: 16, w: 568, h: 448 } },
    { type: 'dm40-dmm', cfg: {}, g: { x: 600, y: 16, w: 520, h: 400 } },
    { type: 'trend', cfg: { ids: ['lt1.z', 'dm40.main'], span: 60 }, g: { x: 600, y: 432, w: 520, h: 280 } },
    { type: 'table', cfg: { ids: ['lt1.z', 'lt1.theta', 'lt1.d', 'dm40.main'] }, g: { x: 16, y: 480, w: 568, h: 232 } },
  ] },
  { name: 'Осциллограф', wins: [
    { type: 'dm40-scope', cfg: {}, g: { x: 16, y: 16, w: 864, h: 560 } },
    { type: 'dm40-gen', cfg: {}, g: { x: 896, y: 16, w: 400, h: 336 } },
    { type: 'reading', cfg: { q: 'dm40.freq', digits: 6 }, g: { x: 896, y: 368, w: 400, h: 208 } },
  ] },
  { name: 'АЧХ и ФЧХ', wins: [
    { type: 'lt1-sweep', cfg: {}, g: { x: 16, y: 16, w: 856, h: 560 } },
    { type: 'lt1-lcr', cfg: {}, g: { x: 888, y: 16, w: 440, h: 560 } },
  ] },
  { name: 'Спектр', wins: [
    { type: 'sa-spectrum', cfg: {}, g: { x: 16, y: 16, w: 880, h: 696 } },
    { type: 'sa-screen', cfg: {}, g: { x: 912, y: 16, w: 560, h: 384 } },
    { type: 'sa-settings', cfg: {}, g: { x: 912, y: 416, w: 560, h: 296 } },
  ] },
  { name: 'C2', wins: [
    { type: 'reading', cfg: { q: 'c2.p', digits: 5 }, g: { x: 16, y: 16, w: 400, h: 208 } },
    { type: 'table', cfg: { ids: ['c2.vbus', 'c2.ibus', 'c2.p', 'c2.dp', 'c2.dn'] }, g: { x: 432, y: 16, w: 568, h: 208 } },
    { type: 'trend', cfg: { ids: ['c2.vbus', 'c2.ibus'], span: 60 }, g: { x: 16, y: 240, w: 984, h: 360 } },
  ] },
  { name: 'Данные', wins: [
    { type: 'recorder', cfg: {}, g: { x: 16, y: 16, w: 384, h: 344 } },
    { type: 'console', cfg: {}, g: { x: 416, y: 16, w: 560, h: 344 } },
    { type: 'quantities', cfg: {}, g: { x: 16, y: 376, w: 480, h: 336 } },
    { type: 'dm40-files', cfg: {}, g: { x: 512, y: 376, w: 464, h: 336 } },
  ] },
];

const App = {
  dlg(title, body, wide) {
    const d = h('dialog', { 'aria-label': title }, h('div', { class: 'dlg-head' }, h('h3', { text: title }), h('button', { class: 'wbtn', 'aria-label': 'Закрыть', onclick: () => d.close() }, '×')), h('div', { class: 'dlg-body' }, body));
    d.addEventListener('close', () => d.remove());
    d.addEventListener('click', e => { if (e.target === d) d.close(); });
    document.body.append(d); d.showModal();
    return d;
  },
  async connect(fn) {
    try {
      const tr = await fn();
      const dev = await Devices.attach(tr);
      toast(`Подключён ${dev.title}: ${dev.transport}. ${dev.fw}`, 'ok');
      return dev;
    } catch (e) {
      if (e.name === 'NotFoundError' || /cancel/i.test(e.message)) return null;
      if (e.name === 'SecurityError') toast('Браузер запретил доступ к устройству на этой странице. Откройте файл pult.html напрямую в Chrome или Edge.', 'bad', 9000);
      else if (e.name === 'NetworkError' || /Access denied|Unable to claim|Failed to open/i.test(e.message)) toast('Не удалось занять интерфейс USB. В Windows нужен драйвер WinUSB (см. справку в окне подключения), либо устройство занято другой программой.', 'bad', 9000);
      else toast(e.message, 'bad', 7000);
      return null;
    }
  },
  connectDialog() {
    const card = (cls, title, desc, fn) => h('button', { class: 'card', disabled: !cls, onclick: () => { d.close(); this.connect(fn); } }, h('b', { text: title }), h('small', { text: cls ? desc : 'Этот браузер не умеет работать с таким подключением. Нужны Chrome или Edge, страница открыта файлом или по https.' }));
    const wsUrl = h('input', { value: store.get('wsUrl', 'ws://localhost:8765'), 'aria-label': 'Адрес моста' });
    const baud = select([[115200, '115200'], [921600, '921600'], [230400, '230400'], [57600, '57600'], [9600, '9600']], 115200, () => { }, 'Скорость порта');
    const body = h('div', { class: 'col' },
      h('div', { class: 'cards' },
        card(UsbTmc.available, 'USB-кабель', 'USBTMC: LT1, DM40 и другие SCPI-приборы. Самая высокая скорость.', () => UsbTmc.pick()),
        card(SerialLink.available, 'COM-порт и Bluetooth SPP', 'tinySA по USB (виртуальный COM-порт). DM40 по классическому Bluetooth: сначала сопрягите его в системе. Подходит и для адаптеров USB-UART.', () => SerialLink.pick(+baud.value)),
        card(BleLink.available, 'Bluetooth LE', 'Прямое подключение без сопряжения. Канал обмена ищется автоматически.', () => BleLink.pick()),
        card(UsbVendor.available, 'C2 по USB', 'ALIENTEK C2 Lite, Std, Pro. Bulk 64 байта с непрерывным чтением: самая высокая скорость. Драйвер WinUSB Windows ставит сама.', () => UsbVendor.pick()),
        card(BleLink.available, 'C2 по Bluetooth LE', 'C2 Std и Pro без сопряжения. В C2 Lite Bluetooth нет.', async () => { const t = await BleLink.pick(); t.proto = 'c2'; return t; }),
        card(SerialLink.available, 'C2 через COM или SPP', 'Классический Bluetooth C2 после сопряжения в системе или адаптер USB-UART.', async () => { const t = await SerialLink.pick(+baud.value); t.proto = 'c2'; return t; }),
        h('button', { class: 'card', onclick: () => { d.close(); store.set('wsUrl', wsUrl.value); this.connect(async () => new WsLink(wsUrl.value)); } }, h('b', { text: 'Мост WebSocket' }), h('small', { text: 'Для Firefox и Safari: прибор подключается через bridge.py.' })),
        h('button', { class: 'card', onclick: () => { d.close(); this.startDemo(); } }, h('b', { text: 'Демо' }), h('small', { text: 'Симуляторы LT1, DM40, tinySA и C2 со случайными данными.' }))),
      h('div', { class: 'row wrap' }, field('Скорость COM-порта', baud), field('Адрес моста', wsUrl)),
      h('details', {}, h('summary', { text: 'DM40 не появляется в списке USB (Windows)' }),
        h('p', { text: 'Windows не содержит драйвера USBTMC, поэтому браузер не может открыть этот интерфейс. Сборка opendm40 с поддержкой этой программы подключает WinUSB сама. На более старых сборках установите WinUSB один раз через Zadig: Options > List All Devices, выберите интерфейс USBTMC устройства DM40 (не mass storage), WinUSB, Install Driver. Диск при этом продолжит работать.' })),
      h('details', {}, h('summary', { text: 'Какие браузеры подходят' }),
        h('p', { text: 'USB, COM-порт и Bluetooth работают в Chrome, Edge и Opera на Windows, macOS, Linux и ChromeOS. На Android работают USB и Bluetooth LE. Firefox и Safari этих функций не имеют, для них есть мост. В Linux для USB нужно правило udev для 1209:d040, 2e3c:5721 и 2e88:c2c2 (C2).' })));
    const d = this.dlg('Подключить прибор', body);
  },
  windowsDialog() {
    const body = h('div', { class: 'col' });
    for (const [g, items] of WINDOW_GROUPS) {
      body.append(h('h4', { text: g }), h('div', { class: 'cards' }, ...items.map(([t, name, desc]) => h('button', { class: 'card', onclick: () => { WM.open(t); d.close(); } }, h('b', { text: name }), h('small', { text: desc })))));
    }
    const d = this.dlg('Добавить окно', body);
  },
  themeDialog() {
    const grid = h('div', { class: 'themes' });
    const fill = () => {
      grid.replaceChildren(...THEMES.map(t => {
        const [bg, panel, , line, ink, , , , , screen, sink, , a, b, c, e] = t.t;
        return h('button', { class: 'th' + (Theme.cur.id === t.id ? ' on' : ''), style: { background: panel, color: ink, borderColor: Theme.cur.id === t.id ? '' : line }, onclick: () => { Theme.pick(t.id); fill(); } },
          h('span', { class: 'th-view', style: { background: screen, color: sink } }, '1.234', h('i', {}, ...[a, b, c, e].map(x => h('u', { style: { background: x } })))), h('span', { class: 'th-name', text: t.name }));
      }));
    };
    fill();
    const units = seg([['1', 'Русские: кОм, мкФ'], ['0', 'Латинские: kΩ, µF']], opts.ruUnits ? '1' : '0', v => { opts.ruUnits = v === '1'; store.set('ruUnits', opts.ruUnits); Hub.list().forEach(q => { q.cnt = q.cnt; }); Theme.rev++; }, 'Единицы');
    const scale = h('input', { type: 'range', min: '.8', max: '1.6', step: '.05', value: store.get('ui', 1), 'aria-label': 'Масштаб интерфейса', oninput: () => { document.documentElement.style.setProperty('--ui', scale.value); store.set('ui', +scale.value); } });
    this.dlg('Оформление', h('div', { class: 'col' }, grid, field('Единицы', units), field('Масштаб интерфейса', scale)));
  },
  layoutDialog() {
    const area = h('textarea', { rows: 8, style: { width: '100%', fontFamily: 'var(--f-mono)' }, 'aria-label': 'Раскладка' });
    const name = h('input', { placeholder: 'Название нового стола', 'aria-label': 'Название стола' });
    const body = h('div', { class: 'col' },
      h('div', { class: 'row wrap' }, name, h('button', { class: 'btn', onclick: () => { WM.addDesk(name.value.trim() || `Стол ${WM.desks.length + 1}`); Bus.emit('desks'); WM.show(WM.desks.length - 1); WM.save(); d.close(); } }, 'Добавить стол'),
        h('button', { class: 'btn', onclick: () => { WM.removeDesk(WM.cur); Bus.emit('desks'); d.close(); } }, 'Удалить текущий стол')),
      h('div', { class: 'row wrap' }, h('button', { class: 'btn', onclick: () => saveFile(`pult-layout-${stamp()}.json`, JSON.stringify(WM.layout(), null, 1), 'application/json') }, 'Сохранить раскладку в файл'),
        h('button', { class: 'btn', onclick: () => { area.value = JSON.stringify(WM.layout()); area.select(); } }, 'Показать как текст'),
        h('button', { class: 'btn', onclick: () => { try { WM.load(JSON.parse(area.value)); WM.save(); d.close(); } catch { toast('В поле не раскладка', 'bad'); } } }, 'Применить из поля'),
        h('button', { class: 'btn', onclick: () => { WM.load(DEFAULT_LAYOUT()); WM.save(); d.close(); } }, 'Вернуть стандартную')), area);
    const d = this.dlg('Рабочие столы', body);
  },
  drawDevs() {
    const box = $('#devs');
    box.replaceChildren(...Devices.list.map(d => {
      const lamp = h('i', { class: 'lamp ' + d.state });
      d.on('state', () => { lamp.className = 'lamp ' + d.state; lamp.title = d.lastErr; });
      return h('span', { class: 'devchip', title: d.idn }, lamp, h('b', { text: d.title }), d.demo ? h('span', { class: 'tag', text: 'ДЕМО' }) : h('small', { text: d.transport }),
        h('button', { class: 'wbtn', 'aria-label': `Отключить ${d.title}`, title: 'Отключить', onclick: () => Devices.remove(d) }, '×'));
    }));
    $('#connect').classList.toggle('primary', !Devices.list.some(d => !d.demo));
  },
  drawTabs() {
    const t = $('#tabs');
    t.replaceChildren(...WM.desks.map((d, i) => h('button', { class: i === WM.cur ? 'on' : '', 'aria-current': i === WM.cur ? 'page' : null, onclick: () => WM.show(i) }, d.name)));
  },
  async startDemo() {
    for (const Sim of [SimLT1, SimDM40]) {
      const tr = new SimLink(new Sim());
      await Devices.attach(tr).catch(e => toast(e.message, 'bad'));
    }
    await Devices.attach(new SimSaLink()).catch(e => toast(e.message, 'bad'));
    await Devices.attach(new SimC2()).catch(e => toast(e.message, 'bad'));
  },
  addCalc(c, keep) {
    const q = Hub.define({ id: c.id, name: c.name, unit: c.unit, dev: 'calc', group: 'Формулы', digits: 5 });
    q.calc = true; c.fn = Calc.compile(c.expr);
    if (!keep) { Calc.items.push({ id: c.id, name: c.name, unit: c.unit, expr: c.expr }); Calc.save(); }
    this.calcs.push(c);
  },
  calcs: [],
  frame(now) {
    for (const w of WM.desk?.wins || []) { try { w.api?.tick?.(now); } catch (e) { console.error(e); } }
    requestAnimationFrame(t => this.frame(t));
  },
  calcTick() {
    for (const c of this.calcs) {
      if (!Hub.q.has(c.id)) continue;
      try { const v = c.fn(id => Hub.q.get(id)?.last ?? NaN); if (Number.isFinite(v)) Hub.push(c.id, v); } catch { }
    }
  },
  async autoReconnect() {
    try {
      const pick = d => UsbVendor.match(d) ? new UsbVendor(d) : new UsbTmc(d);
      for (const d of (await navigator.usb?.getDevices()) || []) await this.connect(async () => pick(d));
      navigator.usb?.addEventListener('connect', e => this.connect(async () => pick(e.device)));
      navigator.usb?.addEventListener('disconnect', e => { const d = Devices.list.find(x => x.link.tr.dev === e.device); if (d) { toast(`${d.title}: кабель отключён`, 'warn'); Devices.remove(d); } });
    } catch { }
  },
  async start() {
    Theme.start();
    document.documentElement.style.setProperty('--ui', store.get('ui', 1));
    if (!navigator.usb && !navigator.serial && !navigator.bluetooth) setTimeout(() => toast('В этом окне браузер не даёт доступа к USB и Bluetooth. Работают демо-приборы. Для настоящих приборов откройте pult.html в Chrome или Edge.', 'warn', 12000), 800);
    $('#connect').addEventListener('click', () => this.connectDialog());
    $('#addwin').addEventListener('click', () => this.windowsDialog());
    $('#theme').addEventListener('click', () => this.themeDialog());
    $('#layout').addEventListener('click', () => this.layoutDialog());
    Devices.on('change', () => this.drawDevs());
    Bus.on('desk', () => this.drawTabs()); Bus.on('desks', () => this.drawTabs());
    await this.startDemo();
    for (const c of Calc.items) { try { this.addCalc({ ...c }, true); } catch { } }
    WM.load(store.get('layout', null) || DEFAULT_LAYOUT());
    setInterval(() => this.calcTick(), 100);
    requestAnimationFrame(t => this.frame(t));
    this.autoReconnect();
    addEventListener('keydown', e => {
      if (e.target.closest('input,textarea,select')) return;
      if (e.key >= '1' && e.key <= '9' && !e.ctrlKey && !e.metaKey) { const i = +e.key - 1; if (i < WM.desks.length) WM.show(i); }
    });
  },
};
App.start();
