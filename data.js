// =====================================================================
//  Расписание группы: чтение готовых файлов data/*.json (их публикует
//  сервер на компьютере) или ответов сервера /api/..., и импорт вставленного вручную.
//  Всё скачанное хранится на телефоне (localStorage) — работает без интернета.
//  Подключается в index.html перед app.js — функции отсюда используются там.
// =====================================================================

// Отдельный ключ: настройки пользователя и скачанные данные храним раздельно.
const DATA_KEY = 'road-to-uni:data:v2';

const CHECK_EVERY_MS = 30 * 60 * 1000;         // проверять свежие файлы на сайте раз в 30 минут
const META_TTL_MS = 6 * 60 * 60 * 1000;        // недели, институты, курсы — раз в 6 часов
const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;     // список всех групп — тоже (МАУ может перенумеровать институты)
const KEEP_DAYS = 14;                          // дни старше двух недель удаляем, чтобы не копить
const STALE_SYNC_MS = 2 * 24 * 60 * 60 * 1000; // компьютер не обновлял дольше 2 суток — предупредим

/*
  Как устроены сохранённые данные:
  {
    meta:    { fetchedAt, weeks: [{ id, start, end, kind }], faculties, courses },
    catalog: { fetchedAt, lists: { "3-1": [{ key, name, spec }] }, synced: ["<key>", ...] },
    schedules: {
      "<key группы>": {
        checkedAt,           // когда телефон последний раз проверял файл на сайте
        syncedAt,            // когда компьютер последний раз проверил сайт МАУ
        subgroups: ["1", "2"],  // подгруппы (если есть); у пар подгрупп — поле subs: ["2"]
        weeks: { "2026-09-21": { at, source: "sync" | "paste" } },
        days:  { "2026-09-21": [ { start, end, subject, type, elective, teacher, room, address }, ... ] }
      }
    }
  }
*/

function loadData() {
  try {
    return JSON.parse(localStorage.getItem(DATA_KEY)) || {};
  } catch (e) {
    return {};
  }
}

function saveData(data) {
  try {
    localStorage.setItem(DATA_KEY, JSON.stringify(data));
  } catch (e) {
    // Не сохранилось (нет места или приватный режим) — данные останутся до перезагрузки.
  }
}


// ---------- Даты (по местному времени телефона) ----------

// Date → "2026-09-24"
function isoDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Понедельник той недели, в которую попадает date → "2026-09-21"
function mondayOf(date) {
  const d = new Date(date);
  d.setDate(d.getDate() - (d.getDay() + 6) % 7);   // сколько дней прошло с понедельника (Пн=0 ... Вс=6)
  return isoDate(d);
}

// Какие недели нужны: текущая и следующая (чтобы в воскресенье вечером уже знать понедельник).
function neededWeeks(now = new Date()) {
  const next = new Date(now);
  next.setDate(next.getDate() + 7);
  return [mondayOf(now), mondayOf(next)];
}

// Для группировки маршрутов по корпусам: "пр.Кирова, д.1" и "пр. Кирова,  д.1" — один корпус.
const buildingId = (address) => address.toLowerCase().replace(/[\s.]/g, '');


// ---------- Загрузка файлов с сайта приложения ----------

// Скачать JSON. null — файла нет.
async function getJson(path) {
  if (location.protocol === 'file:') throw new Error('открой приложение с сайта, а не файлом');
  let response;
  try {
    response = await fetch(path, { cache: 'no-cache' });   // no-cache: браузер всё равно спросит сервер, не изменился ли файл
  } catch (e) {
    throw new Error('нет подключения к интернету');
  }
  // Файла нет. (Проверяем и тип: некоторые хостинги вместо 404 отдают главную страницу.)
  if (response.status === 404 || !(response.headers.get('content-type') || '').includes('json')) return null;
  if (!response.ok) throw new Error(`ошибка ${response.status}`);
  return response.json();
}

// ---------- Откуда брать данные: сервер или файлы от компьютера ----------

// Адрес сервера (например "https://1-2-3-4.sslip.io"). Пусто — читаем файлы data/*.json, которые выгружает компьютер.
let API_BASE = '';

// Сменить источник. Сохранённые списки и отметки о проверке сбрасываем, чтобы всё загрузилось заново
// (reset: false — при запуске приложения: источник тот же, что и в прошлый раз, сбрасывать нечего).
function setApiBase(data, url, { reset = true } = {}) {
  const clean = (url || '').trim().replace(/\/+$/, '');
  if (clean === API_BASE) return;
  API_BASE = clean;
  if (!reset) return;
  data.meta = null;
  data.catalog = null;
  for (const group of Object.values(data.schedules || {})) group.checkedAt = 0;
}

// Путь к данным: name — "meta", "catalog", "schedule/<key>"
const dataPath = (name) => (API_BASE ? `${API_BASE}/api/${name}` : `data/${name}.json`);

// Недели, институты, курсы.
async function getMeta(data) {
  if (data.meta && Date.now() - data.meta.fetchedAt < META_TTL_MS) return data.meta;
  const meta = await getJson(dataPath('meta'));
  if (!meta) throw new Error(API_BASE ? 'сервер ещё не загрузил сайт МАУ' : 'компьютер ещё ни разу не выгружал расписание');
  data.meta = { weeks: meta.weeks, faculties: meta.faculties, courses: meta.courses, fetchedAt: Date.now() };
  saveData(data);
  return data.meta;
}

// Список всех групп + какие из них компьютер обновляет автоматически.
async function getCatalog(data) {
  if (data.catalog && Date.now() - data.catalog.fetchedAt < CATALOG_TTL_MS) return data.catalog;
  let lists, synced;
  if (API_BASE) {
    // Сервер отдаёт всё одним ответом, и обновляет он все группы
    const catalog = await getJson(dataPath('catalog'));
    if (!catalog) throw new Error('сервер ещё загружает список групп');
    ({ lists, synced } = catalog);
  } else {
    const [catalog, syncedFile] = await Promise.all([getJson(dataPath('catalog')), getJson('data/synced.json')]);
    if (!catalog) throw new Error('список групп ещё не выгружен');
    lists = catalog.lists;
    synced = (syncedFile?.groups || []).map((g) => g.key);
  }
  data.catalog = { lists, synced, fetchedAt: Date.now() };
  saveData(data);
  return data.catalog;
}

// Группы института на курсе.
async function getGroupList(data, fac, course) {
  return (await getCatalog(data)).lists[`${fac}-${course}`] || [];
}

// Пора ли снова проверить файл расписания группы?
function scheduleIsStale(data, key) {
  const checkedAt = data.schedules?.[key]?.checkedAt;
  return !checkedAt || Date.now() - checkedAt > CHECK_EVERY_MS;
}

// Записать дни одной недели (7 дат начиная с понедельника start).
function putWeek(group, start, days, at, source) {
  for (let i = 0; i < 7; i++) {
    const date = MAU.addDays(start, i);
    group.days[date] = days[date] || [];
  }
  group.weeks[start] = { at, source };
}

// Удалить старые дни и недели.
function prune(group) {
  const old = new Date();
  old.setDate(old.getDate() - KEEP_DAYS);
  const border = isoDate(old);
  for (const date of Object.keys(group.days)) if (date < border) delete group.days[date];
  for (const start of Object.keys(group.weeks)) if (start < border) delete group.weeks[start];
}

/**
 * Скачать файл расписания группы, который выгрузил компьютер.
 * Если какую-то неделю вставляли вручную позже, чем её проверил компьютер, — оставляем вставленную.
 */
async function refreshSchedule(data, key) {
  data.schedules ||= {};
  const group = (data.schedules[key] ||= { weeks: {}, days: {} });
  group.checkedAt = Date.now();          // отмечаем сразу — чтобы при ошибке не повторять запрос каждые 20 секунд

  const file = await getJson(dataPath(`schedule/${key}`));
  if (!file) {
    saveData(data);
    // Сервер обновляет все группы: если данных нет — он как раз начал их загружать.
    if (API_BASE) throw new Error('сервер загружает расписание этой группы — загляни через минуту');
    const error = new Error('эта группа не обновляется с компьютера');
    error.notSynced = true;
    throw error;
  }

  const syncedAt = Date.parse(file.checkedAt);
  group.syncedAt = syncedAt;
  group.subgroups = file.subgroups || [];
  for (const start of Object.keys(file.weeks)) {
    const mine = group.weeks[start];
    if (!mine || mine.source === 'sync' || mine.at < syncedAt) putWeek(group, start, file.days, syncedAt, 'sync');
  }
  prune(group);
  saveData(data);
}

// ---------- Ручное обновление на сервере (кнопка "Обновить сейчас") ----------

// Запрос к защищённой части сервера. Ошибки превращаем в понятный текст.
async function adminRequest(token, path, options = {}) {
  let response;
  try {
    response = await fetch(`${API_BASE}/api/admin/${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    throw new Error('сервер недоступен');
  }
  const body = await response.json().catch(() => ({}));
  if (response.status === 401) throw new Error('неверный токен');
  if (!response.ok) throw new Error(body.error || `ошибка ${response.status}`);
  return body;
}

/**
 * Попросить сервер обновить группу прямо сейчас и дождаться результата.
 * onProgress(text) — чтобы показывать, что происходит.
 * Возвращает { run, changes } — запись журнала и найденные изменения.
 */
async function adminRefreshGroup(token, key, onProgress = () => {}) {
  const startedAt = new Date().toISOString();
  const { runId } = await adminRequest(token, 'refresh', { method: 'POST', body: JSON.stringify({ group: key }) });
  onProgress('Сервер скачивает расписание с сайта МАУ…');
  for (let i = 0; i < 60; i++) {                      // ждём не больше ~2 минут
    await new Promise((r) => setTimeout(r, 2000));
    const status = await adminRequest(token, `status?group=${key}`);
    const run = status.runs.find((r) => r.id === runId);
    if (run && run.status !== 'running') {
      return { run, changes: status.changes.filter((c) => c.detected_at >= startedAt) };
    }
    if (status.queue.pending > 1) onProgress(`В очереди к сайту МАУ: ${status.queue.pending}…`);
  }
  throw new Error('сервер долго не отвечает — проверь позже');
}

/**
 * Сохранить расписание, вставленное вручную (результат MAU.parsePasted).
 * Возвращает число найденных пар.
 */
function importPasted(data, key, parsed) {
  data.schedules ||= {};
  const group = (data.schedules[key] ||= { weeks: {}, days: {} });
  putWeek(group, parsed.weekStart, parsed.days, Date.now(), 'paste');
  prune(group);
  saveData(data);
  return Object.values(parsed.days).reduce((n, lessons) => n + lessons.length, 0);
}


// ---------- Чтение сохранённого расписания ----------

// Пары группы на дату. undefined — этого дня нет в данных; [] — пар нет.
// sub — номер подгруппы: тогда пары других подгрупп отбрасываются ("" — все пары группы).
function lessonsOn(data, key, date, sub = '') {
  const lessons = data.schedules?.[key]?.days?.[date];
  return lessons && sub ? lessons.filter((l) => forSubgroup(l, sub)) : lessons;
}

// Пара для этой подгруппы? Без subs — для всей группы.
const forSubgroup = (lesson, sub) => !sub || !lesson.subs || lesson.subs.includes(sub);

// Подгруппы группы (по последнему скачанному расписанию): ["1", "2"] или []
function subgroupsOf(data, key) {
  return data.schedules?.[key]?.subgroups || [];
}

// Все предметы группы: сначала факультативы, потом по алфавиту.
function subjectsOf(data, key) {
  const map = new Map();
  for (const lessons of Object.values(data.schedules?.[key]?.days || {})) {
    for (const l of lessons) map.set(l.subject, { name: l.subject, elective: l.elective });
  }
  return [...map.values()].sort((a, b) => (b.elective - a.elective) || a.name.localeCompare(b.name, 'ru'));
}

// Все корпуса (адреса), где у группы есть пары.
function buildingsOf(data, key) {
  const map = new Map();
  for (const lessons of Object.values(data.schedules?.[key]?.days || {})) {
    for (const l of lessons) if (l.address && !map.has(buildingId(l.address))) map.set(buildingId(l.address), l.address);
  }
  return [...map.entries()]
    .map(([id, address]) => ({ id, address }))
    .sort((a, b) => a.address.localeCompare(b.address, 'ru'));
}

// Откуда и когда взяты недели, которые нужны сейчас: { syncedAt, pastedAt, missing: [недели без данных] }.
function scheduleInfo(data, key) {
  const group = data.schedules?.[key];
  const weeks = neededWeeks().map((start) => ({ start, info: group?.weeks?.[start] }));
  const pasted = weeks.filter((w) => w.info?.source === 'paste').map((w) => w.info.at);
  return {
    syncedAt: group?.syncedAt || null,
    syncIsOld: Boolean(group?.syncedAt) && Date.now() - group.syncedAt > STALE_SYNC_MS,
    pastedAt: pasted.length ? Math.max(...pasted) : null,
    missing: weeks.filter((w) => !w.info).map((w) => w.start),
  };
}
