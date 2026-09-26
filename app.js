// =====================================================================
//  Планер — логика расчёта времени выхода и интерфейс
// =====================================================================

// Ключ, под которым все настройки лежат в localStorage.
// Версия в имени нужна, чтобы при смене формата данных можно было начать "с чистого листа".
const STORAGE_KEY = 'road-to-uni:v1';

// Каждые сколько миллисекунд пересчитывать экран (по ТЗ — 20–30 секунд).
const REFRESH_MS = 20 * 1000;

// За сколько минут до выхода кольцо начинает "таять" (полное кольцо = 60 минут и больше).
const RING_WINDOW_MIN = 60;

// Когда до выхода осталось столько минут или меньше — кольцо "теплеет" (оранжевеет).
const SOON_MIN = 10;

// Варианты погоды. id — внутреннее имя (для хранения), остальное — то, что видит пользователь.
const WEATHER = [
  { id: 'clear', emoji: '☀️', label: 'Ясно' },
  { id: 'rain',  emoji: '🌧', label: 'Дождь' },
  { id: 'snow',  emoji: '❄️', label: 'Снег' },
  { id: 'ice',   emoji: '🧊', label: 'Гололёд' },
  { id: 'wind',  emoji: '💨', label: 'Ветер' },
];

// Дни недели в порядке Пн → Вс, как привычно в России.
// num — номер дня так, как его возвращает Date.getDay() (0 = воскресенье, 1 = понедельник ...).
const DAYS = [
  { num: 1, full: 'Понедельник' },
  { num: 2, full: 'Вторник' },
  { num: 3, full: 'Среда' },
  { num: 4, full: 'Четверг' },
  { num: 5, full: 'Пятница' },
  { num: 6, full: 'Суббота' },
  { num: 0, full: 'Воскресенье' },
];

// Время первой пары, которое подставляется, когда включаешь день (начало I пары в МАУ).
const DEFAULT_CLASS_TIME = '09:00';

// Настройки по умолчанию — используются при первом запуске.
const DEFAULT_SETTINGS = {
  // Откуда брать расписание: 'group' — с сайта МАУ по группе, 'manual' — введённое вручную.
  source: 'group',
  // Выбранная группа (key — её постоянный id на сайте МАУ; fac/course — институт и курс).
  group: { key: '62be41ac-269e-11f1-bb62-6cb311ac02c6', name: 'АТПП-ПЭСб26о-1', spec: '', fac: '4', course: '1' },
  // Выбранная подгруппа для каждой группы: { "<key группы>": "2" }. Нет записи — все пары группы.
  subgroups: {},
  // Недавние группы — чтобы быстро переключаться между ними.
  recentGroups: [],
  // Выключенные предметы для каждой группы: { "<key группы>": ["Название предмета", ...] }.
  excluded: {},
  // Свои минуты до отдельных корпусов: { "<id корпуса>": { bus: 30, fromStop: 8 } }.
  buildings: {},
  // Свой сервер: адрес (пусто — расписание из файлов, которые выгружает компьютер)
  // и токен для кнопки "Обновить сейчас" (хранится только на этом телефоне).
  server: { url: '', token: '' },
  // Где дом (для расчёта поездки на транспорте): { lat, lon } или null. Хранится только на телефоне.
  home: null,
  // Считать время выхода по расписанию транспорта, когда план поездки построен (иначе — по минутам маршрута ниже)
  useTransport: true,

  // Ручное расписание: время первой пары по дням. Ключ — номер дня из getDay(), значение "ЧЧ:ММ" или "" (пар нет).
  schedule: { 1: '10:45', 2: '10:45', 3: '09:00', 4: '10:45', 5: '09:00', 6: '10:45', 0: '' },
  // Части пути в минутах.
  route: { toStop: 7, wait: 5, bus: 25, fromStop: 5 },
  // Общий запас "на всякий случай".
  buffer: 10,
  // Какая погода выбрана сейчас и сколько минут добавляет каждый вариант.
  weather: 'clear',
  weatherExtra: { clear: 0, rain: 5, snow: 10, ice: 15, wind: 3 },
};


// ---------------------------------------------------------------------
//  ХРАНЕНИЕ: чтение и запись localStorage
// ---------------------------------------------------------------------

function loadSettings() {
  // structuredClone делает полную копию, чтобы случайно не испортить DEFAULT_SETTINGS.
  const defaults = structuredClone(DEFAULT_SETTINGS);
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!saved) return defaults;
    // Сливаем сохранённое поверх значений по умолчанию:
    // если в новой версии приложения появится новое поле, оно возьмётся из defaults.
    return {
      ...defaults,
      ...saved,
      schedule:     { ...defaults.schedule,     ...saved.schedule },
      route:        { ...defaults.route,        ...saved.route },
      weatherExtra: { ...defaults.weatherExtra, ...saved.weatherExtra },
      excluded:     { ...saved.excluded },
      subgroups:    { ...saved.subgroups },
      buildings:    { ...saved.buildings },
      server:       { ...defaults.server,       ...saved.server },
    };
  } catch (e) {
    // localStorage может быть недоступен (приватный режим) или содержать мусор — не падаем.
    return defaults;
  }
}

function saveSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch (e) {
    // Если сохранить не вышло, приложение всё равно работает — просто до перезагрузки.
  }
}


// ---------------------------------------------------------------------
//  РАСЧЁТ — "сердце" приложения. Эта функция не трогает страницу,
//  она только получает данные и возвращает результат. Так её легко проверять.
// ---------------------------------------------------------------------

// Превращает строку "08:30" в объект Date на сегодняшнюю дату. Пустая строка → null.
function timeOnDate(hhmm, date) {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  const result = new Date(date);       // копия, чтобы не менять исходную дату
  result.setHours(h, m, 0, 0);
  return result;
}

/**
 * Первая пара в день date.
 * Возвращает { start: "10:45", lesson } — если пара есть (lesson — подробности, только для режима группы),
 *            null      — если в этот день пар нет,
 *            undefined — если расписания на этот день у нас нет (не выбрана группа или не скачано).
 */
function firstClassOn(settings, data, date) {
  if (settings.source === 'manual') {
    const time = settings.schedule[date.getDay()];
    return time ? { start: time, lesson: null } : null;
  }

  if (!settings.group) return undefined;
  const lessons = lessonsOn(data, settings.group.key, isoDate(date), mySubgroup(settings));
  if (!lessons) return undefined;

  // Выключенные пользователем предметы (например, факультатив) не считаем.
  const excluded = settings.excluded[settings.group.key] || [];
  const first = lessons
    .filter((l) => !excluded.includes(l.subject))
    .sort((a, b) => a.start.localeCompare(b.start))[0];   // "09:00" < "10:45" — строки сравниваются как время
  return first ? { start: first.start, lesson: first } : null;
}

// Моя подгруппа в выбранной группе ("" — не выбрана, считаем все пары группы)
function mySubgroup(settings, key = settings.group?.key) {
  const sub = settings.subgroups?.[key] || '';
  return sub && subgroupsOf(data, key).includes(sub) ? sub : '';
}

// Маршрут до конкретного корпуса: общий маршрут + свои минуты для этого корпуса, если заданы.
function routeFor(settings, address) {
  const own = address ? settings.buildings[buildingId(address)] : null;
  return { ...settings.route, ...own };
}

// Сколько длится пара, если время окончания неизвестно (ручное расписание): в МАУ 09:00–10:35.
const PAIR_MINUTES = 95;

// Насколько дней вперёд искать следующий день с парами (завтра, послезавтра, ...).
const LOOK_AHEAD_DAYS = 7;

/**
 * План на день date, в котором первая пара — first (из firstClassOn):
 * когда начало и конец пары, во сколько выходить, какой маршрут.
 */
function planFor(settings, date, first) {
  const lesson = first.lesson;
  const classStart = timeOnDate(first.start, date);
  const classEnd = lesson?.end ? timeOnDate(lesson.end, date) : new Date(classStart.getTime() + PAIR_MINUTES * 60000);

  // Складываем все части пути — с учётом корпуса, где будет пара.
  const route = routeFor(settings, lesson?.address);
  const travel = route.toStop + route.wait + route.bus + route.fromStop;
  const weatherExtra = settings.weatherExtra[settings.weather] || 0;
  const totalMinutes = travel + settings.buffer + weatherExtra;

  // Время выхода = начало пары − (путь + буфер + погода).
  // Работаем в миллисекундах: 1 минута = 60 000 мс.
  let leaveAt = new Date(classStart.getTime() - totalMinutes * 60000);

  // Если есть план поездки на транспорте к этой паре (trip.js) — время выхода берём из него:
  // он учитывает, когда реально ходят автобусы, а запас и погоду уже включил.
  const viaTransport = settings.useTransport ? transportLeave(date, classStart) : null;
  if (viaTransport) leaveAt = viaTransport;

  return { classStart, classEnd, leaveAt, travel, weatherExtra, totalMinutes, lesson, route, viaTransport: Boolean(viaTransport) };
}

// План поездки на транспорте (заполняет trip.js): к какой паре и во сколько выходить.
let transportPlan = null;          // { date: "2026-09-25", classStartMs, leaveAt: "08:19" }

// Время выхода по плану транспорта для пары, начинающейся в classStart (или null)
function transportLeave(date, classStart) {
  const p = transportPlan;
  if (!p || p.date !== isoDate(date) || p.classStartMs !== classStart.getTime()) return null;
  const [h, m] = p.leaveAt.split(':').map(Number);
  const d = new Date(date);
  d.setHours(h, m, 0, 0);
  return d;
}

/**
 * Ближайший следующий день с парами: завтра, а если завтра пар нет — послезавтра и так далее.
 * Возвращает план этого дня + daysAhead (1 = завтра) или null, если расписания дальше нет.
 */
function nextDayPlan(settings, data, now) {
  for (let daysAhead = 1; daysAhead <= LOOK_AHEAD_DAYS; daysAhead++) {
    const date = new Date(now);
    date.setDate(date.getDate() + daysAhead);
    const first = firstClassOn(settings, data, date);
    if (first === undefined) return null;          // дальше расписания нет — не гадаем
    if (first) return { ...planFor(settings, date, first), date, daysAhead };
  }
  return null;
}

/**
 * Считает, когда выходить, и в каком мы сейчас состоянии.
 * @param {object} settings — настройки пользователя
 * @param {Date}   now      — текущий момент (передаём снаружи, чтобы можно было подставить любое время для проверки)
 * @param {object} data     — скачанное расписание групп (см. data.js)
 * @returns {object} state: 'no-data' | 'no-classes' | 'waiting' | 'leave-now' | 'started' | 'day-over'
 *                   next  — план на следующий учебный день (для 'no-classes', 'started', 'day-over')
 */
function calculate(settings, now, data) {
  const first = firstClassOn(settings, data, now);

  if (first === undefined) return { state: 'no-data' };     // не знаем расписание
  if (first === null) return { state: 'no-classes', next: nextDayPlan(settings, data, now) };

  const plan = planFor(settings, now, first);

  // Сколько минут осталось до выхода (может быть отрицательным, если уже опаздываем).
  const minutesToLeave = Math.ceil((plan.leaveAt - now) / 60000);

  // Определяем состояние: порядок проверок важен.
  let state;
  if (now >= plan.classEnd)        state = 'day-over';   // первая пара закончилась — думаем о завтра
  else if (now >= plan.classStart) state = 'started';    // пара уже идёт
  else if (now >= plan.leaveAt)    state = 'leave-now';  // выходить надо было уже — срочно!
  else                             state = 'waiting';    // спокойно ждём

  const next = state === 'started' || state === 'day-over' ? nextDayPlan(settings, data, now) : null;
  return { state, minutesToLeave, ...plan, next };
}


// ---------------------------------------------------------------------
//  ВСПОМОГАТЕЛЬНОЕ
// ---------------------------------------------------------------------

// Короткий помощник: найти элемент по id.
const $ = (id) => document.getElementById(id);

// Date → "08:30"
function formatTime(date) {
  return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

// 135 → "2 ч 15 мин", 42 → "42 мин"
function formatDuration(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} мин`;
  return m === 0 ? `${h} ч` : `${h} ч ${m} мин`;
}

// Как назвать день: "завтра" или "в понедельник" (daysAhead — сколько дней вперёд).
const WEEKDAY_IN = ['в воскресенье', 'в понедельник', 'во вторник', 'в среду', 'в четверг', 'в пятницу', 'в субботу'];
function dayPhrase(daysAhead, date) {
  return daysAhead === 1 ? 'завтра' : WEEKDAY_IN[date.getDay()];
}
const capitalize = (s) => s[0].toUpperCase() + s.slice(1);

// Ограничить число диапазоном [min, max].
const clamp = (x, min, max) => Math.min(max, Math.max(min, x));

// Текст с сайта вставляем в HTML только через эту функцию: она превращает "<" в "&lt;" и т. п.,
// чтобы чужой текст не мог "стать" кодом на странице.
function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let settings = loadSettings();
let data = loadData();                          // скачанное расписание (data.js)
setApiBase(data, settings.server.url, { reset: false });   // откуда брать расписание: сервер или файлы компьютера
// Состояние загрузки расписания: идёт ли сейчас, какая была ошибка,
// и не в том ли дело, что компьютер эту группу не обновляет (notSynced).
const sync = { loading: false, error: '', notSynced: false, errorAt: 0 };


// ---------------------------------------------------------------------
//  КОЛЬЦО ПРОГРЕССА
//  Трюк: у кольца задан пунктир (stroke-dasharray) длиной во всю окружность,
//  а сдвиг пунктира (stroke-dashoffset) "прячет" часть дуги.
//  Длина кольца условно равна 100 (pathLength в index.html), поэтому
//  offset = 0 → кольцо полное, offset = 100 → кольца нет.
//  Стартуем с пустого кольца (задано в CSS) — при запуске оно красиво "нарисуется".
// ---------------------------------------------------------------------

const ring = $('ring-progress');

// fraction — доля заполнения от 0 до 1.
function setRing(fraction) {
  ring.style.strokeDashoffset = 100 * (1 - fraction);
  // На нуле скруглённый конец линии всё равно рисует точку — прячем её.
  ring.style.opacity = fraction < 0.005 ? 0 : '';
}


// ---------------------------------------------------------------------
//  ОТРИСОВКА ГЛАВНОГО ЭКРАНА
// ---------------------------------------------------------------------

// Заполнить тексты главного блока одной командой.
function setHero({ state, caption, time, sub, title, subtitle, ring }) {
  $('hero').dataset.state = state;          // по этому атрибуту CSS меняет цвета
  $('ring-caption').textContent = caption;
  $('leave-time').textContent = time;
  $('countdown').textContent = sub;
  $('hero-title').textContent = title;
  $('hero-subtitle').textContent = subtitle;
  setRing(ring);
}

// Показать план на следующий учебный день (завтра или ближайший день с парами).
// today — пара слов о сегодняшнем дне для подзаголовка.
function setHeroNextDay(next, now, today) {
  const day = dayPhrase(next.daysAhead, next.date);
  const minutes = Math.ceil((next.leaveAt - now) / 60000);
  setHero({
    state: 'tomorrow',
    caption: 'Выйти в',
    time: formatTime(next.leaveAt),
    // Меньше суток — показываем отсчёт, иначе просто день ("в понедельник")
    sub: minutes < 24 * 60 ? `${day}, через ${formatDuration(minutes)}` : day,
    title: `${capitalize(day)} пара в ${formatTime(next.classStart)}`,
    subtitle: today,
    ring: 1,
  });
}

// now можно передать для проверки ("а что покажет в 17:00?"); по умолчанию — текущее время.
function renderStatus(now = new Date()) {
  const r = calculate(settings, now, data);
  let shown = r;                                  // чей план показываем в "какая пара" и маршруте

  // Дата в шапке: "четверг, 24 сентября"
  $('today-date').textContent = now.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });

  if ((r.state === 'no-classes' || r.state === 'day-over') && r.next) {
    // Сегодня выходить уже не нужно — показываем, когда выходить в следующий учебный день.
    setHeroNextDay(r.next, now, r.state === 'no-classes' ? 'Сегодня пар нет — можно выдохнуть 🙂' : 'На сегодня выходить уже не нужно');
    shown = r.next;
  } else if (r.state === 'day-over') {
    // Первая пара прошла, а расписания на следующие дни у нас нет.
    setHero({
      state: 'started', caption: 'Сегодня', time: '✓', sub: 'пара прошла',
      title: 'На сегодня выходить уже не нужно', subtitle: 'Расписания на следующие дни пока нет', ring: 0,
    });
    shown = {};
  } else if (r.state === 'no-data') {
    // Расписания на сегодня нет: объясняем почему и что делать.
    let subtitle = 'Выбери группу в настройках';
    if (settings.group) {
      if (sync.loading) subtitle = 'Проверяю обновления…';
      else if (sync.notSynced) subtitle = 'Вставь его в настройках — эта группа не обновляется с компьютера';
      else if (sync.error) subtitle = `Не получилось: ${sync.error}`;
      else subtitle = 'Вставь его в настройках или дождись обновления с компьютера';
    }
    setHero({ state: 'no-data', caption: 'Расписание', time: '…', sub: '', title: 'Нет расписания на сегодня', subtitle, ring: 0 });
  } else if (r.state === 'no-classes') {
    setHero({
      state: 'no-classes', caption: 'Сегодня', time: '—', sub: 'пар нет',
      title: 'Сегодня пар нет', subtitle: 'Можно выдохнуть 🙂', ring: 1,
    });
  } else if (r.state === 'started') {
    // Пара идёт — подсказываем, когда выходить в следующий учебный день.
    const next = r.next;
    setHero({
      state: 'started', caption: 'Пара', time: formatTime(r.classStart), sub: 'уже идёт',
      title: 'Пара уже началась',
      subtitle: next ? `${capitalize(dayPhrase(next.daysAhead, next.date))} выйти в ${formatTime(next.leaveAt)}` : 'Хорошей пары!',
      ring: 0,
    });
  } else if (r.state === 'leave-now') {
    const toClass = Math.ceil((r.classStart - now) / 60000);
    setHero({
      state: 'leave-now', caption: 'Выйти в', time: formatTime(r.leaveAt), sub: 'пора!',
      title: 'Пора выходить!', subtitle: `До пары ${formatDuration(toClass)}`, ring: 1,
    });
  } else {
    // 'waiting': кольцо "тает" за последние RING_WINDOW_MIN минут до выхода.
    // Для плавности считаем по миллисекундам, а не по округлённым минутам.
    const fraction = clamp((r.leaveAt - now) / (RING_WINDOW_MIN * 60000), 0, 1);
    const soon = r.minutesToLeave <= SOON_MIN;
    setHero({
      state: soon ? 'soon' : 'waiting',
      caption: 'Выйти в', time: formatTime(r.leaveAt), sub: `через ${formatDuration(r.minutesToLeave)}`,
      title: soon ? 'Собирайся, скоро выходить' : `Пара в ${formatTime(r.classStart)}`,
      subtitle: soon ? `Пара в ${formatTime(r.classStart)}`
        : r.viaTransport ? 'По расписанию транспорта — см. «Как доехать»'
        : `Дорога с запасом — ${formatDuration(r.totalMinutes)}`,
      ring: fraction,
    });
  }

  // Какая пара и где (только когда расписание с сайта).
  const lesson = shown.lesson;
  $('hero-lesson').hidden = !lesson;
  if (lesson) {
    const place = [lesson.room, lesson.address].filter(Boolean).join(', ');
    $('hero-lesson').textContent = place ? `${lesson.subject} · ${place}` : lesson.subject;
  }

  // Подгруппы есть, а своя не выбрана — подсказка (нажатие открывает настройки)
  const key = settings.source === 'group' ? settings.group?.key : null;
  $('subgroup-hint').hidden = !key || !subgroupsOf(data, key).length || Boolean(mySubgroup(settings));

  renderRoute(shown.route || routeFor(settings, null), lesson?.address);
  // Время выхода посчитано по транспорту — ручной маршрут (минуты) на главном экране не нужен
  $('route-title').hidden = $('route-card').hidden = Boolean(shown.viaTransport);

  // Для карточки «Как доехать» (trip.js): к какой паре едем. Пока пара идёт — уже к следующей.
  let trip = shown.classStart ? { date: isoDate(shown.date || now), classStart: shown.classStart, lesson: shown.lesson } : null;
  if (r.state === 'started') trip = r.next ? { date: isoDate(r.next.date), classStart: r.next.classStart, lesson: r.next.lesson } : null;
  if (typeof updateTripTarget === 'function') updateTripTarget(trip, now);
}

// Маршрут-степпер: узлы (места) и связи между ними (минуты участка).
const STOPS = [
  { emoji: '🏠', label: 'Дом',       tint: 'var(--blue)' },
  { emoji: '🚏', label: 'Остановка', tint: 'var(--orange)' },
  { emoji: '🚌', label: 'Автобус',   tint: 'var(--green)' },
  { emoji: '🚏', label: 'Остановка', tint: 'var(--orange)' },
  { emoji: '🎓', label: 'Универ',    tint: 'var(--purple)' },
];
// Между 5 узлами 4 участка — ровно 4 настройки маршрута, по порядку.
const LEGS = ['toStop', 'wait', 'bus', 'fromStop'];

// route — минуты участков (с учётом корпуса), address — куда едем (может не быть).
function renderRoute(route, address) {
  $('route-dest').hidden = !address;
  $('route-dest').textContent = address ? `До корпуса: ${address}` : '';

  // Собираем HTML строкой: узел, связь, узел, связь, ... узел.
  $('stepper').innerHTML = STOPS.map((stop, i) => {
    const node = `<li class="step" style="--tint:${stop.tint}">${stop.emoji}<span class="step-label">${stop.label}</span></li>`;
    const link = i < LEGS.length
      ? `<li class="link" aria-hidden="true"><span class="link-minutes">${route[LEGS[i]]} мин</span></li>`
      : '';
    return node + link;
  }).join('');

  const travel = LEGS.reduce((sum, key) => sum + route[key], 0);
  const extra = settings.weatherExtra[settings.weather] || 0;
  $('route-formula').textContent = `Дорога ${travel} + запас ${settings.buffer} + погода ${extra}`;
  $('route-total').textContent = formatDuration(travel + settings.buffer + extra);

  // Подпись под погодой
  const w = WEATHER.find((x) => x.id === settings.weather);
  $('weather-note').textContent = extra > 0 ? `${w.label}: +${extra} мин к дороге` : `${w.label}: без добавки ко времени`;
}


// ---------------------------------------------------------------------
//  ПОГОДА: сегмент-контрол
// ---------------------------------------------------------------------

function buildWeatherControl() {
  const control = $('weather-control');

  WEATHER.forEach((w) => {
    const btn = document.createElement('button');
    btn.className = 'segment';
    btn.type = 'button';
    btn.dataset.id = w.id;
    btn.setAttribute('role', 'radio');   // для экранных читалок это группа "выбери один"
    btn.innerHTML = `<span class="segment-emoji">${w.emoji}</span>${w.label}`;
    btn.addEventListener('click', () => {
      settings.weather = w.id;
      saveSettings(settings);
      updateWeatherControl();
      renderStatus();
    });
    control.appendChild(btn);
  });

  updateWeatherControl();
}

// Отметить выбранный вариант и передвинуть под него плашку.
function updateWeatherControl() {
  const index = WEATHER.findIndex((w) => w.id === settings.weather);
  $('weather-control').style.setProperty('--index', index);   // CSS сдвигает плашку на index колонок
  document.querySelectorAll('#weather-control .segment').forEach((btn) => {
    btn.setAttribute('aria-checked', btn.dataset.id === settings.weather);
  });
}


// ---------------------------------------------------------------------
//  НАСТРОЙКИ
// ---------------------------------------------------------------------

// Строки "добавка на погоду" в настройках.
function buildWeatherExtras() {
  $('weather-extras').innerHTML = WEATHER.map((w) => `
    <li class="row">
      <span class="row-icon" style="--tint: var(--fill)">${w.emoji}</span>
      <span class="row-label">${w.label}</span>
      <label class="row-value"><input type="number" inputmode="numeric" min="0" data-setting="weatherExtra.${w.id}"><span>мин</span></label>
    </li>`).join('');
}

// Строки дней недели: название, время первой пары и тумблер "есть пары".
function buildSchedule() {
  const list = $('schedule');

  DAYS.forEach((d) => {
    const row = document.createElement('li');
    row.className = 'row no-icon';
    row.innerHTML = `
      <span class="row-label">${d.full}</span>
      <span class="day-off">нет пар</span>
      <input class="time-input" type="time">
      <input class="switch" type="checkbox" aria-label="Есть пары: ${d.full}">`;
    list.appendChild(row);

    const time = row.querySelector('.time-input');
    const toggle = row.querySelector('.switch');
    const off = row.querySelector('.day-off');

    // Показать либо поле времени, либо надпись "нет пар".
    function sync() {
      const has = Boolean(settings.schedule[d.num]);
      toggle.checked = has;
      time.hidden = !has;
      off.hidden = has;
      if (has) time.value = settings.schedule[d.num];
    }

    // Тумблер: включили — ставим время по умолчанию (или последнее, что было в поле).
    toggle.addEventListener('change', () => {
      settings.schedule[d.num] = toggle.checked ? (time.value || DEFAULT_CLASS_TIME) : '';
      saveSettings(settings);
      sync();
      renderStatus();
    });

    // Изменили время. Если поле очистили — считаем, что пар нет.
    time.addEventListener('change', () => {
      settings.schedule[d.num] = time.value;
      saveSettings(settings);
      sync();
      renderStatus();
    });

    sync();
  });
}

// Все числовые поля настроек помечены атрибутом data-setting="путь.к.полю",
// поэтому одна общая функция умеет и заполнять их, и сохранять — без копипаста на каждое поле.
function bindSettingInputs() {
  document.querySelectorAll('[data-setting]').forEach((input) => {
    const [group, key] = input.dataset.setting.split('.');   // "route.bus" → ["route", "bus"]

    // Заполняем поле текущим значением.
    input.value = key === undefined ? settings[group] : settings[group][key];

    // 'input' срабатывает на каждый ввод символа — пересчёт виден сразу.
    input.addEventListener('input', () => {
      const value = Math.max(0, Number(input.value) || 0);   // пустое или кривое поле = 0
      if (key === undefined) settings[group] = value;
      else settings[group][key] = value;
      saveSettings(settings);
      renderStatus();
    });

    // Тап по строке целиком ставит курсор в поле — как в настройках iPhone.
    input.closest('.row').addEventListener('click', () => input.focus());
  });
}


// ---------------------------------------------------------------------
//  РАСПИСАНИЕ С САЙТА МАУ: источник, выбор группы, предметы, корпуса
// ---------------------------------------------------------------------

const ERROR_RETRY_MS = 5 * 60 * 1000;   // после ошибки загрузки ждём 5 минут до новой автоматической попытки

// Переключатель "Группа МАУ / Вручную".
function bindSourceControl() {
  document.querySelectorAll('#source-control .segment').forEach((btn) => {
    btn.addEventListener('click', () => {
      settings.source = btn.dataset.source;
      saveSettings(settings);
      renderSource();
      renderStatus();
      if (settings.source === 'group') {
        loadPickers();
        updateSchedule();
      }
    });
  });
  renderSource();
}

function renderSource() {
  const isGroup = settings.source === 'group';
  $('source-control').style.setProperty('--index', isGroup ? 0 : 1);
  document.querySelectorAll('#source-control .segment').forEach((btn) => {
    btn.setAttribute('aria-checked', btn.dataset.source === settings.source);
  });
  // Показываем настройки только выбранного режима.
  $('group-settings').hidden = !isGroup;
  $('manual-settings').hidden = isGroup;
}

// Заполнить <select> вариантами: items — [{ value, label }], первая строка — подсказка.
function fillSelect(select, items, selected, placeholder) {
  select.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>` +
    items.map((i) => `<option value="${escapeHtml(i.value)}">${escapeHtml(i.label)}</option>`).join('');
  select.value = items.some((i) => i.value === selected) ? selected : '';
  select.disabled = items.length === 0;
}

// Списки институтов и курсов (из data/meta.json, его выгружает компьютер), затем групп.
async function loadPickers() {
  const g = settings.group || {};
  try {
    const meta = await getMeta(data);
    // Где на самом деле числится сохранённая группа: МАУ может перенумеровать институты
    const place = g.key ? await findGroupPlace(g.key, g.fac, g.course) : null;
    if (place && (place.fac !== g.fac || place.course !== g.course)) {
      settings.group = { ...g, fac: place.fac, course: place.course };
      saveSettings(settings);
    }
    fillSelect($('fac-select'), meta.faculties.map((f) => ({ value: f.id, label: f.name })), place?.fac ?? g.fac, 'Выбери');
    fillSelect($('course-select'), meta.courses.map((c) => ({ value: c.id, label: c.name })), place?.course ?? g.course, 'Выбери');
    await loadGroupOptions();
  } catch (e) {
    // Списки не загрузились (нет интернета) — показываем хотя бы текущую группу.
    fillSelect($('fac-select'), [], '', '—');
    fillSelect($('course-select'), [], '', '—');
    fillSelect($('group-select'), g.key ? [{ value: g.key, label: g.name }] : [], g.key, '—');
  }
}

// В каком институте и на каком курсе группа (сначала проверяем сохранённые, потом ищем по всем спискам)
async function findGroupPlace(key, fac, course) {
  const { lists } = await getCatalog(data);
  if ((lists[`${fac}-${course}`] || []).some((gr) => gr.key === key)) return { fac, course };
  const id = Object.keys(lists).find((k) => lists[k].some((gr) => gr.key === key));
  if (!id) return null;
  const [f, c] = id.split('-');
  return { fac: f, course: c };
}

// Список групп для выбранных института и курса.
let groupOptionsLoad = 0;                           // если быстро переключать институт — показываем только последний выбор
async function loadGroupOptions() {
  const id = ++groupOptionsLoad;
  const fac = $('fac-select').value;
  const course = $('course-select').value;
  if (!fac || !course) {
    fillSelect($('group-select'), [], '', 'Сначала институт и курс');
    return;
  }
  // Список уже на телефоне — показываем сразу, без мигания "Загружаю…"
  if (!data.catalog) fillSelect($('group-select'), [], '', 'Загружаю…');
  try {
    const groups = await getGroupList(data, fac, course);
    if (id !== groupOptionsLoad) return;
    // Обычно компьютер обновляет все группы. Если какой-то нет в его списке — подписываем:
    // её расписание придётся вставлять вручную.
    const synced = data.catalog?.synced || [];
    const options = groups.map((gr) => ({ value: gr.key, label: synced.length && !synced.includes(gr.key) ? `${gr.name} (вручную)` : gr.name }));
    fillSelect($('group-select'), options, settings.group?.key, 'Выбери группу');
    $('group-select').dataset.fac = fac;          // запомним, к какому институту/курсу относится список
    $('group-select').dataset.course = course;
    $('group-select')._groups = groups;
  } catch (e) {
    if (id === groupOptionsLoad) fillSelect($('group-select'), [], '', 'Не загрузилось');
  }
}

// Подгруппы выбранной группы: строка видна, только если они есть
function renderSubgroupPicker() {
  const key = settings.group?.key;
  const subs = key ? subgroupsOf(data, key) : [];
  $('subgroup-row').hidden = !subs.length;
  if (!subs.length) return;
  fillSelect($('subgroup-select'), subs.map((s) => ({ value: s, label: `${s}-я подгруппа` })), mySubgroup(settings), 'Все пары группы');
}

// Сделать группу текущей.
function selectGroup(group) {
  settings.group = group;
  // Недавние: выбранная — первой, без повторов, не больше 5.
  settings.recentGroups = [group, ...settings.recentGroups.filter((g) => g.key !== group.key)].slice(0, 5);
  saveSettings(settings);
  sync.error = '';
  sync.notSynced = false;
  sync.errorAt = 0;
  $('paste-status').textContent = '';
  renderGroupDetails();
  renderSyncStatus();
  renderPasteLinks();
  renderStatus();
  updateSchedule({ force: true });
  if (typeof pushGroupChanged === 'function') pushGroupChanged();   // notify.js: уведомления — по новой группе
}

function bindGroupPickers() {
  $('fac-select').addEventListener('change', loadGroupOptions);
  $('course-select').addEventListener('change', loadGroupOptions);

  // Подсказка на главном экране: открыть настройки на строке «Подгруппа»
  $('subgroup-hint').addEventListener('click', () => {
    document.querySelector('[data-view="view-settings"]').click();
    $('subgroup-row').scrollIntoView({ block: 'center' });
  });

  $('subgroup-select').addEventListener('change', (e) => {
    const key = settings.group.key;
    if (e.target.value) settings.subgroups[key] = e.target.value;
    else delete settings.subgroups[key];
    saveSettings(settings);
    renderStatus();
    if (typeof onSubgroupChanged === 'function') onSubgroupChanged();   // browse.js: вкладка «Расписание»
    if (typeof pushGroupChanged === 'function') pushGroupChanged('Подгруппа изменилась');   // notify.js
  });

  $('group-select').addEventListener('change', (e) => {
    const select = e.target;
    const found = (select._groups || []).find((g) => g.key === select.value);
    if (found) selectGroup({ ...found, fac: select.dataset.fac, course: select.dataset.course });
  });

  $('refresh-button').addEventListener('click', () => {
    data.meta = null;                               // заодно перечитать недели и список групп
    data.catalog = null;
    loadPickers();
    updateSchedule({ force: true });
  });

  // Вставка расписания. Берём HTML из буфера (в нём сохраняются таблицы), а если его нет — текст.
  $('paste-box').addEventListener('paste', (e) => {
    e.preventDefault();
    importFromClipboard(e.clipboardData.getData('text/html'), e.clipboardData.getData('text/plain'));
  });
  // Запасной случай: текст попал в поле без события paste (например, через диктовку или автозаполнение).
  $('paste-box').addEventListener('input', (e) => {
    if (e.target.value.length > 40) importFromClipboard('', e.target.value);
  });

  // Тап по недавней группе — переключиться на неё.
  $('recent-groups').addEventListener('click', (e) => {
    const row = e.target.closest('[data-key]');
    const group = row && settings.recentGroups.find((g) => g.key === row.dataset.key);
    if (!group) return;
    selectGroup(group);
    loadPickers();                                  // обновить выпадающие списки под эту группу
  });

  // Тумблеры предметов: выключенный предмет попадает в список excluded.
  $('subjects').addEventListener('change', (e) => {
    const name = e.target.dataset.subject;
    if (name === undefined) return;
    const key = settings.group.key;
    const list = new Set(settings.excluded[key] || []);
    if (e.target.checked) list.delete(name);
    else list.add(name);
    settings.excluded[key] = [...list];
    saveSettings(settings);
    renderStatus();
  });

  // Минуты до корпуса. Пустое поле — берём значение из общего маршрута.
  $('buildings').addEventListener('input', (e) => {
    const { building, field } = e.target.dataset;
    if (!building) return;
    const own = { ...settings.buildings[building] };
    if (e.target.value === '') delete own[field];
    else own[field] = Math.max(0, Number(e.target.value) || 0);
    if (Object.keys(own).length) settings.buildings[building] = own;
    else delete settings.buildings[building];
    saveSettings(settings);
    renderStatus();
  });
}

// Предметы, корпуса и недавние группы — всё, что зависит от скачанного расписания.
function renderGroupDetails() {
  const key = settings.group?.key;
  renderSubgroupPicker();

  // Предметы
  const subjects = key ? subjectsOf(data, key) : [];
  const excluded = (key && settings.excluded[key]) || [];
  $('subjects').innerHTML = subjects.length
    ? subjects.map((s) => `
      <li class="row no-icon">
        <span class="row-label wrap">${escapeHtml(s.name.replace(/\s*\(фак\.?\)/i, ''))}${s.elective ? '<span class="badge">фак.</span>' : ''}</span>
        <input class="switch" type="checkbox" data-subject="${escapeHtml(s.name)}" ${excluded.includes(s.name) ? '' : 'checked'}
               aria-label="Учитывать: ${escapeHtml(s.name)}">
      </li>`).join('')
    : '<li class="row no-icon empty-row">Появятся после загрузки расписания</li>';

  // Корпуса
  const buildings = key ? buildingsOf(data, key) : [];
  $('buildings').innerHTML = buildings.length
    ? buildings.map((b) => {
      const own = settings.buildings[b.id] || {};
      const input = (field) => `<input type="number" inputmode="numeric" min="0" data-building="${b.id}" data-field="${field}"
                                   value="${own[field] ?? ''}" placeholder="${settings.route[field]}">`;
      return `
      <li class="row no-icon">
        <span class="row-label wrap">${escapeHtml(b.address)}</span>
        <label class="mini" title="В автобусе, мин">🚌${input('bus')}</label>
        <label class="mini" title="От остановки до корпуса, мин">🚶${input('fromStop')}</label>
      </li>`;
    }).join('')
    : '<li class="row no-icon empty-row">Появятся после загрузки расписания</li>';

  // Недавние группы (показываем, когда есть из чего выбирать)
  $('recent-block').hidden = settings.recentGroups.length < 2;
  $('recent-groups').innerHTML = settings.recentGroups.map((g) => `
    <li class="row no-icon clickable ${g.key === key ? 'is-current' : ''}" data-key="${escapeHtml(g.key)}">
      <span class="row-label">${escapeHtml(g.name)}<span class="row-sub">${escapeHtml(g.spec || '')}</span></span>
      <span class="row-check">✓</span>
    </li>`).join('');
}

// "сегодня в 12:40" / "23 сентября в 18:05"
function formatUpdated(ts) {
  const d = new Date(ts);
  const day = isoDate(d) === isoDate(new Date()) ? 'сегодня' : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  return `${day} в ${formatTime(d)}`;
}

// Подпись под выбором группы: откуда расписание и насколько оно свежее.
function renderSyncStatus() {
  const box = $('sync-status');
  $('refresh-button').disabled = sync.loading;
  box.className = 'group-footer';
  if (!settings.group) { box.textContent = ''; return; }

  const info = scheduleInfo(data, settings.group.key);
  const lines = [];
  if (sync.loading) lines.push('Проверяю обновления…');
  else if (sync.notSynced && info.pastedAt) lines.push('Эта группа не обновляется с компьютера — используется вставленное вручную.');
  else if (sync.notSynced) {
    lines.push(`Расписание ${settings.group.name} не обновляется с компьютера. Вставь его вручную ниже ` +
               `или добавь группу на компьютере: node tools/sync.mjs --add ${settings.group.name}`);
  } else if (sync.error) {
    lines.push(`Не удалось проверить обновления: ${sync.error}.`);
    box.classList.add('is-error');
  }
  if (info.syncedAt) {
    const who = API_BASE ? 'Сервер' : 'Компьютер';
    lines.push(`${who} проверял сайт МАУ ${formatUpdated(info.syncedAt)}.` +
               (info.syncIsOld ? ` Давно — возможно, ${API_BASE ? 'сервер не работает' : 'компьютер выключен'}. Если расписание могло поменяться, вставь его вручную.` : ''));
  }
  if (info.pastedAt) lines.push(`Вставлено вручную ${formatUpdated(info.pastedAt)}.`);
  box.textContent = lines.join('\n');           // каждая мысль — с новой строки (см. white-space в CSS)
}

// Ссылки на страницу группы на сайте МАУ: текущая неделя и (если знаем её чётность) следующая.
function renderPasteLinks() {
  const key = settings.group?.key;
  $('mau-link').href = key ? MAU.scheduleUrl(key) : MAU.TIMETABLE_URL;
  const next = neededWeeks()[1];
  const week = data.meta?.weeks.find((w) => w.start === next);
  $('mau-link-next-row').hidden = !(key && week);
  if (key && week) $('mau-link-next').href = MAU.scheduleUrl(key, week.start, week.kind);
}

// Разобрать вставленное расписание и сохранить его для текущей группы.
function importFromClipboard(html, text) {
  const status = $('paste-status');
  const box = $('paste-box');
  const parsed = MAU.parsePasted(html, text);
  const count = parsed.weekStart ? Object.values(parsed.days).reduce((n, l) => n + l.length, 0) : 0;
  box.value = '';
  box.blur();

  if (!parsed.weekStart || count === 0) {
    status.className = 'group-footer is-error';
    status.textContent = 'Не нашёл в скопированном пар. Скопируй всю страницу расписания группы (с заголовками дней) и вставь ещё раз.';
    return;
  }
  // Скопировали расписание другой группы? Предупреждаем, но не мешаем.
  if (parsed.group && settings.group && parsed.group !== settings.group.name) {
    if (!confirm(`Это расписание группы ${parsed.group}, а выбрана ${settings.group.name}. Всё равно сохранить?`)) return;
  }

  importPasted(data, settings.group.key, parsed);
  const from = new Date(parsed.weekStart + 'T00:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  status.className = 'group-footer is-ok';
  status.textContent = `Готово: неделя с ${from}, пар — ${count}.`;
  renderGroupDetails();
  renderSyncStatus();
  renderStatus();
}

// Проверить, не выгрузил ли компьютер свежее расписание (не чаще раза в 30 минут, или сразу, если force).
async function updateSchedule({ force = false } = {}) {
  if (settings.source !== 'group' || !settings.group || sync.loading) return;
  if (!force && !scheduleIsStale(data, settings.group.key)) return;
  if (!force && sync.errorAt && Date.now() - sync.errorAt < ERROR_RETRY_MS) return;   // не долбим сайт после ошибки

  const key = settings.group.key;
  sync.loading = true;
  renderSyncStatus();
  renderStatus();
  try {
    await refreshSchedule(data, key);
    sync.error = '';
    sync.notSynced = false;
    sync.errorAt = 0;
  } catch (e) {
    sync.error = e.message;
    sync.notSynced = Boolean(e.notSynced);
    sync.errorAt = Date.now();
  } finally {
    sync.loading = false;
    renderSyncStatus();
    renderPasteLinks();
    renderGroupDetails();
    renderStatus();
  }
  // Пока качали, могли выбрать другую группу — тогда загрузим и её.
  if (settings.group && settings.group.key !== key) updateSchedule();
}


// ---------------------------------------------------------------------
//  СЕРВЕР: адрес, токен и кнопка "Обновить расписание сейчас"
// ---------------------------------------------------------------------

function setServerStatus(text, kind = '') {
  $('server-status').textContent = text;
  $('server-status').className = `group-footer${kind ? ` is-${kind}` : ''}`;
}

// Кнопка активна, только когда есть адрес сервера, токен и выбранная группа.
function renderServerControls() {
  const { url, token } = settings.server;
  $('server-url').value = url;
  $('server-token').value = token;
  $('admin-refresh').disabled = !(url && token && settings.group);
}

function bindServerSettings() {
  $('server-url').addEventListener('change', (e) => {
    const url = e.target.value.trim().replace(/\/+$/, '');
    if (url && !/^https?:\/\/\S+$/.test(url)) {
      setServerStatus('Адрес должен начинаться с https:// (или http:// для проверки на своём компьютере).', 'error');
      return;
    }
    settings.server.url = url;
    saveSettings(settings);
    setApiBase(data, url);                          // data.js: теперь данные берём с сервера (или снова из файлов)
    saveData(data);
    setServerStatus(url ? 'Сервер подключён — расписание берётся с него.' : 'Сервер отключён — расписание снова из файлов компьютера.');
    renderServerControls();
    loadPickers();
    updateSchedule({ force: true });
    if (typeof renderPush === 'function') renderPush();          // notify.js: уведомления зависят от сервера
  });

  $('server-token').addEventListener('change', (e) => {
    settings.server.token = e.target.value.trim();
    saveSettings(settings);
    renderServerControls();
  });

  $('admin-refresh').addEventListener('click', async () => {
    const button = $('admin-refresh');
    button.disabled = true;
    setServerStatus('Отправляю запрос на сервер…');
    try {
      const { run, changes } = await adminRefreshGroup(settings.server.token, settings.group.key, (t) => setServerStatus(t));
      if (run.status === 'error') {
        setServerStatus(`Сервер не смог обновить: ${run.error || 'ошибка'}.`, 'error');
      } else if (changes.length) {
        setServerStatus(`Готово, изменений: ${changes.length}\n${changes.map((c) => `• ${c.text}`).join('\n')}`, 'ok');
      } else {
        setServerStatus(`Готово: расписание проверено, изменений нет (${formatTime(new Date())}).`, 'ok');
      }
      await updateSchedule({ force: true });        // забрать свежие данные с сервера
    } catch (e) {
      setServerStatus(`Не получилось: ${e.message}.`, 'error');
    } finally {
      renderServerControls();
    }
  });

  renderServerControls();
}


// ---------------------------------------------------------------------
//  ТАБ-БАР: переключение экранов "Сегодня" / "Настройки"
// ---------------------------------------------------------------------

function bindTabs() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t === tab));
      document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== tab.dataset.view; });
      window.scrollTo(0, 0);
      // При возврате на главный экран кольцо снова "дорисуется" с нуля — приятная мелочь.
      if (tab.dataset.view === 'view-today') {
        ring.style.transition = 'none';
        setRing(0);
        ring.getBoundingClientRect();        // заставляем браузер применить "пустое" кольцо...
        ring.style.transition = '';          // ...и уже потом анимируем к настоящему значению
        renderStatus();
      }
      // Вкладка «Расписание» (browse.js) загружает неделю при открытии
      if (tab.dataset.view === 'view-schedule') openBrowse();
    });
  });
}


// ---------------------------------------------------------------------
//  ЗАПУСК
// ---------------------------------------------------------------------

// Группа по умолчанию сразу попадает в "недавние".
if (settings.group && settings.recentGroups.length === 0) settings.recentGroups = [settings.group];

buildWeatherControl();
buildWeatherExtras();
buildSchedule();
bindSettingInputs();   // после build*, чтобы найти и созданные динамически поля
bindTabs();
bindSourceControl();
bindGroupPickers();
renderGroupDetails();
renderSyncStatus();
renderPasteLinks();
bindServerSettings();

// Сначала просим браузер "зафиксировать" пустое кольцо из CSS, и только потом рисуем —
// тогда кольцо красиво заполнится с анимацией, а не появится сразу целиком.
getComputedStyle(ring).strokeDashoffset;
renderStatus();

// Расписание группы: заполняем списки и скачиваем свежие данные (если устарели).
if (settings.source === 'group') {
  loadPickers();
  updateSchedule();
}

// Обратный отсчёт: обновляем экран каждые 20 секунд без перезагрузки страницы.
// Заодно проверяем, не пора ли обновить расписание (само обновление — не чаще раза в час).
setInterval(() => {
  renderStatus();
  updateSchedule();
}, REFRESH_MS);

// Телефон мог "усыпить" вкладку. Когда приложение снова на экране — сразу пересчитываем,
// не дожидаясь очередного тика таймера.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    renderStatus();
    updateSchedule();
  }
});

// Появился интернет — пробуем обновиться сразу, не дожидаясь 5 минут после ошибки.
window.addEventListener('online', () => {
  sync.errorAt = 0;
  updateSchedule();
});

// Service worker (sw.js) кэширует файлы, чтобы приложение открывалось без интернета.
// Проверяем поддержку: в старых браузерах его нет. А при открытии файла напрямую
// (file://) браузер его не зарегистрирует — это нормально, приложение работает и так.
if ('serviceWorker' in navigator) {
  const hadController = Boolean(navigator.serviceWorker.controller);
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => {
      console.info('Service worker не зарегистрирован (офлайн-режим недоступен):', err.message);
    });
  });
  // iPhone держит приложение в памяти днями — при каждом возвращении на экран проверяем, нет ли новой версии
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') navigator.serviceWorker.getRegistration().then((reg) => reg?.update()).catch(() => {});
  });
  // Новая версия установилась и взяла страницу под контроль — перезагружаемся, чтобы все файлы были из одной версии.
  // (При самой первой установке перезагружать незачем: страница уже новая.)
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });
}
