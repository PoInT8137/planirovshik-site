// =====================================================================
//  Вкладка «Расписание»: полное расписание на неделю.
//  По умолчанию — моя группа; поиском можно открыть любую группу или преподавателя.
//
//  С сервером (Настройки → Сервер) доступны все группы, преподаватели и любые недели.
//  Без сервера — все группы и преподаватели, но только текущая и следующая неделя
//  (их публикует компьютер).
//
//  Подгруппы: если у группы они есть, над днями появляется переключатель «Все · 1 · 2».
//  У «Моей группы» он совпадает с подгруппой из настроек.
//  Подключается после app.js и пользуется его функциями ($, escapeHtml, settings, data ...).
// =====================================================================

const BROWSE_CACHE_KEY = 'road-to-uni:browse:v1';   // последние открытые недели — чтобы работало без интернета
const BROWSE_CACHE_SIZE = 20;
const DAY_NAMES = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];

// Что показываем: чьё расписание и какую неделю. mine — моя группа (следует за настройками).
// sub — выбранная подгруппа чужой группы ("" — все); lastWeek — последняя показанная неделя (для переключателя подгрупп)
const browse = { mine: true, type: 'group', key: null, name: '', weekStart: null, weeks: null, loadingId: 0, sub: '', lastWeek: null };

// Какую подгруппу показывать: у своей группы — из настроек, у чужой — выбранную здесь
const browseSub = () => (browse.mine ? mySubgroup(settings, browse.key) : browse.sub);


// ---------- Даты ----------

const dateOf = (iso) => new Date(iso + 'T12:00:00');       // полдень — чтобы не споткнуться о часовые пояса
const shiftWeek = (iso, n) => MAU.addDays(iso, 7 * n);

// "21–27 сентября" или "28 сентября – 4 октября"
function weekRange(start) {
  const a = dateOf(start);
  const b = dateOf(MAU.addDays(start, 6));
  const month = (d) => d.toLocaleDateString('ru-RU', { month: 'long', day: 'numeric' }).split(' ')[1];
  return a.getMonth() === b.getMonth()
    ? `${a.getDate()}–${b.getDate()} ${month(b)}`
    : `${a.getDate()} ${month(a)} – ${b.getDate()} ${month(b)}`;
}

// Неделя по умолчанию: текущая, а в воскресенье — уже следующая (сегодня пар всё равно нет)
function defaultWeek() {
  const now = new Date();
  return now.getDay() === 0 ? mondayOf(new Date(now.getTime() + 86400000)) : mondayOf(now);
}


// ---------- Кэш открытых недель (для работы без интернета) ----------

function cacheGet(url) {
  try { return JSON.parse(localStorage.getItem(BROWSE_CACHE_KEY))?.[url] || null; } catch (e) { return null; }
}
function cachePut(url, value) {
  try {
    const cache = JSON.parse(localStorage.getItem(BROWSE_CACHE_KEY)) || {};
    cache[url] = { value, at: Date.now() };
    // Оставляем только самые свежие записи
    const keep = Object.entries(cache).sort((a, b) => b[1].at - a[1].at).slice(0, BROWSE_CACHE_SIZE);
    localStorage.setItem(BROWSE_CACHE_KEY, JSON.stringify(Object.fromEntries(keep)));
  } catch (e) { /* не сохранилось — не страшно */ }
}

// Запрос к серверу. Ошибку сервера (404 и т. п.) превращаем в понятный текст.
async function browseFetch(path) {
  const url = `${API_BASE}/api/${path}`;
  let response;
  try {
    response = await fetch(url);
  } catch (e) {
    const cached = cacheGet(url);
    if (cached) return { ...cached.value, fromCache: cached.at };
    throw new Error('нет связи с сервером');
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `ошибка ${response.status}`);
  cachePut(url, body);
  return body;
}


// Без сервера: файлы, которые опубликовал компьютер (data/...). Тоже сохраняются на телефоне.
async function staticFetch(path) {
  const url = `data/${path}`;
  let response;
  try {
    response = await fetch(url, { cache: 'no-cache' });
  } catch (e) {
    const cached = cacheGet(url);
    if (cached) return { ...cached.value, fromCache: cached.at };
    throw new Error('нет подключения к интернету');
  }
  if (response.status === 404 || !(response.headers.get('content-type') || '').includes('json')) {
    throw new Error('сервер ещё не опубликовал эти данные');
  }
  const body = await response.json();
  cachePut(url, body);
  return body;
}

// Список групп и преподавателей для поиска без сервера (один файл на всех, загружаем один раз)
let searchIndex = null;
async function staticSearchIndex() {
  searchIndex ||= await staticFetch('search.json');
  return searchIndex;
}


// ---------- Какие недели можно листать ----------

// С сервером — все недели с сайта МАУ (для преподавателя — только те, что есть у всех групп);
// без сервера — текущая и следующая (их публикует компьютер).
async function availableWeeks() {
  if (API_BASE) {
    if (!browse.weeks) browse.weeks = await browseFetch('weeks');
    if (browse.type === 'teacher') return browse.weeks.teacherWeeks.map((start) => ({ start }));
    return browse.weeks.weeks;
  }
  return (await staticSearchIndex()).teacherWeeks.map((start) => ({ start }));
}


// ---------- Загрузка недели ----------

async function loadWeek() {
  const id = ++browse.loadingId;                  // если пользователь быстро листает — показываем только последнюю
  if (browse.mine) {
    browse.type = 'group';
    browse.key = settings.group?.key;
    browse.name = settings.group?.name || '';
  }
  renderHeader();
  $('browse-days').innerHTML = '<p class="browse-empty">Загружаю…</p>';

  let week;
  try {
    week = API_BASE ? await loadWeekFromServer() : await loadWeekStatic();
  } catch (e) {
    if (id !== browse.loadingId) return;
    $('browse-days').innerHTML = `<p class="browse-empty">Не получилось: ${escapeHtml(e.message)}.</p>`;
    renderWeekSwitch(null);
    return;
  }
  if (id !== browse.loadingId) return;
  renderWeek(week);
}

function loadWeekFromServer() {
  const kind = browse.type === 'teacher' ? 'teachers' : 'groups';
  return browseFetch(`${kind}/${browse.key}/week/${browse.weekStart}`);
}

// Без сервера: неделя группы или преподавателя из файла, который опубликовал компьютер
async function loadWeekStatic() {
  const path = browse.type === 'teacher' ? `teachers/${browse.key}.json` : `schedule/${browse.key}.json`;
  let file;
  try {
    file = await staticFetch(path);
  } catch (e) {
    // Своя группа — есть и на телефоне (её расписание приложение хранит всегда)
    if (browse.mine) return loadWeekLocal();
    throw e;
  }
  if (!file.weeks?.[browse.weekStart]) throw new Error('без сервера доступны только текущая и следующая неделя');
  const days = {};
  for (let i = 0; i < 7; i++) {
    const date = MAU.addDays(browse.weekStart, i);
    days[date] = file.days[date] || [];
  }
  return {
    type: browse.type, name: file.name, warning: file.warning, fromCache: file.fromCache, subgroups: file.subgroups,
    week: { start: browse.weekStart, kind: file.weeks[browse.weekStart] }, days,
  };
}

// Своя группа из того, что уже есть на телефоне
function loadWeekLocal() {
  const group = data.schedules?.[browse.key];
  if (!group?.weeks?.[browse.weekStart]) throw new Error('этой недели нет на телефоне');
  const days = {};
  for (let i = 0; i < 7; i++) {
    const date = MAU.addDays(browse.weekStart, i);
    days[date] = group.days[date] || [];
  }
  const kind = data.meta?.weeks.find((w) => w.start === browse.weekStart)?.kind || '';
  return { type: 'group', name: browse.name, subgroups: group.subgroups, week: { start: browse.weekStart, kind }, days };
}


// ---------- Отрисовка ----------

// ---------- Избранное ----------

const isFavorite = (type, key) => settings.favorites.some((f) => f.type === type && f.key === key);

// Добавить или убрать открытое расписание из избранного
function toggleFavorite() {
  if (isFavorite(browse.type, browse.key)) {
    settings.favorites = settings.favorites.filter((f) => !(f.type === browse.type && f.key === browse.key));
  } else {
    settings.favorites = [...settings.favorites, { type: browse.type, key: browse.key, name: browse.name }];
  }
  saveSettings(settings);
  renderHeader();
}

// Строка избранного под поиском. Открытое сейчас расписание выделено.
function renderFavorites() {
  const box = $('browse-favs');
  const list = settings.favorites || [];
  box.hidden = !list.length;
  box.innerHTML = list.map((f) => `
    <button class="fav-chip ${f.type === browse.type && f.key === browse.key ? 'is-active' : ''}" type="button"
      data-type="${f.type}" data-key="${escapeHtml(f.key)}" data-name="${escapeHtml(f.name)}">
      <span class="fav-chip-kind">${f.type === 'teacher' ? 'Преп.' : 'Группа'}</span>${escapeHtml(f.type === 'teacher' ? shortName(f.name) : f.name)}
    </button>`).join('');
}

// "Воронин Алексей Викторович" → "Воронин А. В." (в строке избранного места мало)
function shortName(full) {
  const [last, ...rest] = String(full).split(/\s+/);
  return rest.length ? `${last} ${rest.map((w) => `${w[0]}.`).join(' ')}` : full;
}

function renderHeader() {
  $('browse-kind').textContent = browse.mine ? 'Моя группа' : (browse.type === 'teacher' ? 'Преподаватель' : 'Группа');
  $('browse-title').textContent = browse.name || 'Расписание';
  const fav = !browse.mine && browse.key && isFavorite(browse.type, browse.key);
  $('browse-fav').hidden = browse.mine || !browse.key;
  $('browse-fav').setAttribute('aria-pressed', String(Boolean(fav)));
  $('browse-fav').setAttribute('aria-label', fav ? 'Убрать из избранного' : 'В избранное');
  renderFavorites();
  $('browse-mine').hidden = browse.mine || !settings.group;
  $('browse-today').hidden = browse.weekStart === defaultWeek();
  // Без сервера данные публикует компьютер — только текущая и следующая неделя
  $('browse-note').hidden = Boolean(API_BASE);
  $('browse-note').textContent = 'Расписание обновляет сервер: доступны текущая и следующая неделя.';
}

async function renderWeekSwitch(week) {
  $('week-range').textContent = weekRange(browse.weekStart);
  const kind = week?.week?.kind;
  $('week-kind').textContent = kind === 'ч' ? 'чётная неделя' : kind === 'н' ? 'нечётная неделя' : '';
  try {
    const weeks = (await availableWeeks()).map((w) => w.start);
    $('week-prev').disabled = !weeks.some((w) => w < browse.weekStart);
    $('week-next').disabled = !weeks.some((w) => w > browse.weekStart);
  } catch (e) {
    $('week-prev').disabled = $('week-next').disabled = false;
  }
}

// Переключатель подгрупп «Все · 1 · 2» (только если у группы есть подгруппы)
function renderSubgroupSwitch(subgroups) {
  const box = $('browse-subgroups');
  box.hidden = !subgroups.length;
  if (!subgroups.length) return;
  const options = ['', ...subgroups];
  const current = options.includes(browseSub()) ? browseSub() : '';
  box.style.setProperty('--count', options.length);
  box.style.setProperty('--index', options.indexOf(current));
  box.innerHTML = '<span class="segmented-thumb" aria-hidden="true"></span>' + options.map((s) => `
    <button class="segment" type="button" role="radio" data-sub="${s}" aria-checked="${s === current}">
      ${s ? `${s} п/г` : 'Все'}
    </button>`).join('');
}

function renderWeek(week) {
  browse.lastWeek = week;
  renderWeekSwitch(week);
  const subgroups = week.type === 'group' ? week.subgroups || [] : [];
  renderSubgroupSwitch(subgroups);
  const sub = subgroups.includes(browseSub()) ? browseSub() : '';
  const notes = [];
  if (week.spec) notes.push(week.spec);
  if (week.warning) notes.push(`⚠️ ${week.warning}`);
  if (week.fromCache) notes.push(`Нет связи — показано сохранённое (${new Date(week.fromCache).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })})`);
  $('browse-sub').textContent = notes.join('\n');

  const today = isoDate(new Date());
  const excluded = (browse.mine && settings.excluded[browse.key]) || [];
  const html = Object.entries(week.days).map(([date, lessons]) => {
    // Пары другой подгруппы не прячем, а показываем бледными: на сайте МАУ они есть на странице
    // группы (без пометки, чьи они), и без них расписание "не сходится" с официальным
    const d = dateOf(date);
    if (d.getDay() === 0 && !lessons.length) return '';        // пустое воскресенье не показываем
    const title = `${DAY_NAMES[d.getDay()]}, ${d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}`;

    // Мои пары (своя подгруппа, не выключенные) — для сводки дня. Перерывы показывает только «Главная»
    const mine = lessons.filter((l) => forSubgroup(l, sub) && !excluded.includes(l.subject))
      .sort((a, b) => a.start.localeCompare(b.start));
    const rows = lessons.length
      ? lessons.map((l) => lessonRow(l, week.type, excluded.includes(l.subject), !forSubgroup(l, sub))).join('')
      : '<li class="lesson lesson-none">Пар нет</li>';
    // Сводка дня: "3 пары · 10:45–16:20"
    const summary = mine.length ? `${mine.length} ${plural(mine.length, 'пара', 'пары', 'пар')} · ${mine[0].start}–${mine.reduce((m, l) => (l.end > m ? l.end : m), '')}` : '';
    return `
      <article class="day-card ${date === today ? 'is-today' : ''} ${date < today ? 'is-past' : ''}">
        <h3 class="day-title"><span>${title}${date === today ? '<span class="badge badge-today">сегодня</span>' : ''}</span>${summary ? `<span class="day-summary">${escapeHtml(summary)}</span>` : ''}</h3>
        <ul class="lessons">${rows}</ul>
      </article>`;
  }).join('');
  $('browse-days').innerHTML = html || '<p class="browse-empty">На этой неделе пар нет.</p>';
}

// 1 пара, 2 пары, 5 пар
function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

// Одна пара: время слева, предмет и подробности справа.
// isOther — пара другой подгруппы (не моей выбранной): бледная, с пометкой
function lessonRow(l, type, isExcluded, isOther = false) {
  const subject = l.subject.replace(/\s*\(фак\.?\)/i, '');
  // У группы показываем преподавателя, у преподавателя — группы
  const who = type === 'teacher' ? (l.groups || []).join(', ') : (l.teacherFull || l.teacher);
  const place = [l.room, l.address].filter(Boolean).join(' · ');
  return `
    <li class="lesson ${isExcluded || isOther ? 'is-excluded' : ''}">
      <div class="lesson-time"><span>${escapeHtml(l.start)}</span><span>${escapeHtml(l.end)}</span></div>
      <div class="lesson-body">
        <div class="lesson-subject">${escapeHtml(subject)}${l.elective ? '<span class="badge">фак.</span>' : ''}${l.subs ? `<span class="badge badge-sub">${isOther ? 'только ' : ''}${escapeHtml(l.subs.join(', '))} п/г</span>` : ''}</div>
        <div class="lesson-meta">${[l.type, who].filter(Boolean).map(escapeHtml).join(' · ')}</div>
        ${place ? `<div class="lesson-meta">${escapeHtml(place)}</div>` : ''}
        ${isOther ? '<div class="lesson-meta">пара другой подгруппы — не учитывается при расчёте выхода</div>'
          : isExcluded ? '<div class="lesson-meta">не учитывается при расчёте выхода</div>' : ''}
      </div>
    </li>`;
}


// ---------- Поиск ----------

let searchTimer = null;

async function runSearch(q) {
  const box = $('browse-results');
  if (q.trim().length < 2) {
    box.hidden = true;
    return;
  }
  let found;
  try {
    found = API_BASE ? await browseFetch(`search?q=${encodeURIComponent(q.trim())}`) : searchLocally(await staticSearchIndex(), q);
  } catch (e) {
    box.hidden = false;
    box.innerHTML = `<p class="footnote">Поиск не удался: ${escapeHtml(e.message)}.</p>`;
    return;
  }
  if ($('browse-search').value !== q) return;       // пока ждали ответа, запрос уже поменяли
  const section = (title, items, type) => (items.length ? `
    <h2 class="group-header">${title}</h2>
    <ul class="group">${items.map((it) => `
      <li class="row no-icon clickable" data-type="${type}" data-key="${escapeHtml(it.key)}" data-name="${escapeHtml(it.name)}">
        <span class="row-label">${escapeHtml(it.name)}${it.spec ? `<span class="row-sub">${escapeHtml(it.spec)}</span>` : ''}</span>
        <span class="row-check" style="color: var(--label-3)">›</span>
      </li>`).join('')}
    </ul>` : '');
  box.hidden = false;
  box.innerHTML = section('Группы', found.groups, 'group') + section('Преподаватели', found.teachers, 'teacher') ||
    '<p class="footnote">Ничего не нашлось.</p>';
}

// Поиск без сервера — по списку из search.json, так же как на сервере: без регистра и без разницы е/ё
function searchLocally(index, q) {
  const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е');
  const needle = norm(q.trim());
  return {
    groups: index.groups.filter((g) => norm(g.name).includes(needle) || norm(g.spec).includes(needle)).slice(0, 20),
    teachers: index.teachers.filter((t) => norm(t.name).includes(needle)).slice(0, 20),
  };
}

// Открыть чужое расписание (или вернуться к своему)
function openSchedule(type, key, name) {
  browse.mine = type === 'group' && key === settings.group?.key;
  browse.sub = '';                                   // у чужой группы по умолчанию — все подгруппы
  browse.type = type;
  browse.key = key;
  browse.name = name;
  // У преподавателей не все недели доступны — если текущей в списке нет, открываем неделю по умолчанию
  const teacherWeeks = (API_BASE ? browse.weeks : searchIndex)?.teacherWeeks;
  if (type === 'teacher' && teacherWeeks && !teacherWeeks.includes(browse.weekStart)) browse.weekStart = defaultWeek();
  $('browse-search').value = '';
  $('browse-results').hidden = true;
  $('browse-search').blur();
  window.scrollTo(0, 0);
  loadWeek();
}


// ---------- Кнопки ----------

function bindBrowse() {
  $('browse-search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runSearch(e.target.value), 250);   // ждём, пока человек допечатает
  });
  $('browse-results').addEventListener('click', (e) => {
    const row = e.target.closest('[data-key]');
    if (row) openSchedule(row.dataset.type, row.dataset.key, row.dataset.name);
  });
  $('browse-favs').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-key]');
    if (chip) openSchedule(chip.dataset.type, chip.dataset.key, chip.dataset.name);
  });
  $('browse-fav').addEventListener('click', toggleFavorite);
  $('week-prev').addEventListener('click', () => { browse.weekStart = shiftWeek(browse.weekStart, -1); loadWeek(); });
  $('week-next').addEventListener('click', () => { browse.weekStart = shiftWeek(browse.weekStart, 1); loadWeek(); });
  $('browse-today').addEventListener('click', () => { browse.weekStart = defaultWeek(); loadWeek(); });
  // Переключатель подгрупп. У своей группы выбор сохраняется в настройках (от него зависит время выхода).
  $('browse-subgroups').addEventListener('click', (e) => {
    const button = e.target.closest('[data-sub]');
    if (!button || !browse.lastWeek) return;
    if (browse.mine) {
      if (button.dataset.sub) settings.subgroups[browse.key] = button.dataset.sub;
      else delete settings.subgroups[browse.key];
      saveSettings(settings);
      renderStatus();
      renderSubgroupPicker();
      if (typeof pushGroupChanged === 'function') pushGroupChanged('Подгруппа изменилась');   // notify.js
    } else {
      browse.sub = button.dataset.sub;
    }
    renderWeek(browse.lastWeek);
  });
  $('browse-mine').addEventListener('click', () => {
    browse.mine = true;
    openSchedule('group', settings.group.key, settings.group.name);
  });
}

// Подгруппу поменяли в настройках — перерисовать свою группу
function onSubgroupChanged() {
  if (browse.mine && browse.lastWeek) renderWeek(browse.lastWeek);
}

// Вызывается из app.js при открытии вкладки
function openBrowse() {
  browse.weekStart ||= defaultWeek();
  browse.weeks = null;                               // список недель мог обновиться
  searchIndex = null;                                // и опубликованный список групп — тоже
  loadWeek();
}

bindBrowse();
