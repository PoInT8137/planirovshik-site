// =====================================================================
//  Разбор страниц сайта МАУ (mauniver.ru). Один и тот же код работает:
//   • на сервере — server/src/mau/updater.js (обходит сайт МАУ);
//   • на телефоне — когда расписание вставляют вручную из буфера обмена.
//
//  Это обычный скрипт (не модуль): так он подключается в index.html даже при
//  открытии файла напрямую. Всё нужное он кладёт в один объект — globalThis.MAU.
//
//  Почему регулярные выражения, а не DOMParser: на компьютере (в Node.js) нет
//  браузерного DOM. Страницы простые и однотипные, регулярок хватает.
//  Если сайт поменяет вёрстку — чинить здесь, проверять командой  npm test
// =====================================================================
(function () {
  const ORIGIN = 'https://mauniver.ru';
  const TIMETABLE_URL = `${ORIGIN}/student/timetable/`;
  const NEW_URL = `${TIMETABLE_URL}new/`;

  const WEEKDAYS = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
  const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

  // ---------- Адреса страниц ----------

  // Список групп института (fac) на курсе (course). pers — номер недели из списка на сайте.
  function groupsUrl(fac, course, pers) {
    return `${NEW_URL}?mode=1&pers=${pers}&facs=${fac}&courses=${course}`;
  }

  // Расписание группы на неделю. kind — "ч" (чётная) или "н" (нечётная).
  // Без start сайт сам показывает текущую неделю.
  function scheduleUrl(key, start, kind, page = 'schedule.php') {
    if (!start) return `${NEW_URL}${page}?key=${key}`;
    return `${NEW_URL}${page}?key=${key}&perstart=${start}&perend=${addDays(start, 6)}&perkind=${encodeURIComponent(kind)}`;
  }

  // Расписание преподавателя на неделю: та же таблица, только в 4-й колонке — группы
  const teacherScheduleUrl = (key, start, kind) => scheduleUrl(key, start, kind, 'schedule2.php');

  // ---------- Даты ----------

  // "2026-09-21" + 3 дня → "2026-09-24". Считаем в UTC, чтобы часовой пояс не сдвигал дату.
  function addDays(iso, days) {
    const d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  // "21.09.2026" → "2026-09-21"
  const ruToIso = (s) => s.split('.').reverse().join('-');

  /**
   * "понедельник, 21 сентября" → понедельник этой недели ("2026-09-21").
   * Года в заголовке нет — берём тот, при котором дата ближе всего к сегодняшней.
   */
  function weekStartFromTitle(title, now = new Date()) {
    const m = title.toLowerCase().match(/^(\S+),\s*(\d{1,2})\s+(\S+)/);
    const dayIndex = m ? WEEKDAYS.indexOf(m[1]) : -1;
    const month = m ? MONTHS.indexOf(m[3]) : -1;
    if (dayIndex < 0 || month < 0) return null;
    const year = now.getFullYear();
    const candidates = [year - 1, year, year + 1].map((y) => new Date(Date.UTC(y, month, Number(m[2]))));
    const date = candidates.sort((a, b) => Math.abs(a - now) - Math.abs(b - now))[0];
    return addDays(date.toISOString().slice(0, 10), -dayIndex);
  }

  // ---------- Текст из HTML ----------

  // Заменяем HTML-сущности (&nbsp; &quot; &#171; ...) на обычные символы.
  function decodeEntities(s) {
    const named = { nbsp: ' ', amp: '&', quot: '"', lt: '<', gt: '>', laquo: '«', raquo: '»', mdash: '—', ndash: '–', apos: "'" };
    return s
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
      .replace(/&([a-z]+);/gi, (m, name) => named[name.toLowerCase()] ?? m);
  }

  // HTML → чистый текст: убираем теги, сущности и лишние пробелы.
  function textOf(html) {
    return decodeEntities(html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  }

  // Все <option value="...">текст</option> внутри <select name="name">.
  function selectOptions(html, name) {
    const select = html.match(new RegExp(`<select[^>]*name="${name}"[^>]*>([\\s\\S]*?)</select>`, 'i'));
    if (!select) return [];
    return [...select[1].matchAll(/<option[^>]*value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/gi)]
      .map(([, value, label]) => ({ value, label: textOf(label) }))
      .filter((o) => o.value !== '0' && o.value !== '');     // "Выберите ..." пропускаем
  }

  // ---------- Разбор страниц ----------

  /**
   * Главная страница расписаний → недели ("21.09.2026-27.09.2026 (н/н)"), институты, курсы
   * и updatedAt — строка "Время обновления: 2026-09-24 16:58:40" (по ней видно, менялось ли расписание).
   */
  function parseMeta(html) {
    const weeks = selectOptions(html, 'pers').map((o) => {
      const m = o.label.match(/(\d{2}\.\d{2}\.\d{4})\s*-\s*(\d{2}\.\d{2}\.\d{4})\s*\((ч|н)\/н\)/);
      return m && { id: o.value, start: ruToIso(m[1]), end: ruToIso(m[2]), kind: m[3] };
    }).filter(Boolean);
    const faculties = selectOptions(html, 'facs').map((o) => ({ id: o.value, name: o.label }));
    const courses = selectOptions(html, 'courses').map((o) => ({ id: o.value, name: o.label }));
    const updatedAt = html.match(/Время обновления:\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/)?.[1] || null;
    return { weeks, faculties, courses, updatedAt };
  }

  /**
   * Результат поиска преподавателей → [{ key, name, short }].
   * Пустой поиск на сайте отдаёт сразу всех. short — "Воронин А.В.", как в расписании групп.
   */
  function parseTeachers(html) {
    const byKey = new Map();
    for (const [, key, text] of html.matchAll(/<a[^>]*href="[^"]*schedule2\.php\?key=([0-9a-f-]{36})[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)) {
      const name = textOf(text);
      if (!/[А-ЯЁа-яё]{2}/.test(name) || byKey.has(key)) continue;   // пропускаем мусор вроде "-", "--"
      byKey.set(key, { key, name, short: shortName(name) });
    }
    return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  }

  // "Воронин Алексей Викторович" → "Воронин А.В."
  function shortName(full) {
    const [last, ...rest] = full.trim().split(/\s+/);
    return rest.length ? `${last} ${rest.map((p) => p[0] + '.').join('')}` : last;
  }

  /** Список групп → [{ key, name, spec }]. У каждой группы две ссылки: название и направление. */
  function parseGroups(html) {
    const byKey = new Map();
    for (const [, key, text] of html.matchAll(/<a[^>]*href="[^"]*schedule\.php\?key=([0-9a-f-]{36})[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)) {
      const label = textOf(text);
      if (!label) continue;
      const group = byKey.get(key);
      if (!group) byKey.set(key, { key, name: label, spec: '' });
      else if (!group.spec) group.spec = label;
    }
    return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  }

  /** "201 (Ленина, 57)" → { room: "201", address: "Ленина, 57" }; "территория:" в адресе убираем. */
  function parseRoom(text) {
    const m = text.match(/^(.*)\(([^()]*)\)\s*$/);   // берём последние скобки в строке
    // У англоязычных групп — без скобок: "Lenina str, 57, room 308"
    const en = !m && text.match(/^(.+?),\s*room\s+(\S+)\s*$/i);
    if (en) return { room: en[2], address: en[1].trim() };
    if (!m) return { room: text, address: '' };
    return { room: m[1].trim(), address: m[2].replace(/^территория\s*:\s*/i, '').trim() };
  }

  // Собрать одну пару из уже очищенных частей.
  function makeLesson(number, start, end, subject, type, teacher, roomText) {
    const { room, address } = parseRoom(roomText);
    return {
      number: Number(number) || null,
      start: start.padStart(5, '0'),
      end: end.padStart(5, '0'),
      subject,
      type,
      elective: /\(фак\.?\)/i.test(subject),                // факультатив помечен "(фак.)"
      teacher: teacher.replace(/^—$/, ''),
      room,
      address,
    };
  }

  // Пустая неделя: все 7 дат с пустыми списками (пустой список = пар нет).
  function emptyWeek(weekStart) {
    const days = {};
    for (let i = 0; i < 7; i++) days[addDays(weekStart, i)] = [];
    return days;
  }

  // Название группы из заголовка "Расписание группы АТПП-ПЭСб26о-1 с 21 сентября ..."
  function groupNameOf(text) {
    return text.match(/Расписание группы\s+(\S+)/)?.[1] || '';
  }

  /**
   * HTML страницы расписания группы → { group, weekStart, days: { "2026-09-21": [пары...], ... } }.
   * weekStart можно не передавать — тогда он определяется по заголовкам дней.
   * Подходит и для HTML, скопированного из Safari: классы таблиц не требуются.
   */
  function parseSchedule(html, weekStart) {
    const tables = [...html.matchAll(/<table[\s\S]*?<\/table>/gi)].map((m) => m[0])
      .map((table) => ({ table, title: textOf(table.match(/<th[^>]*>([\s\S]*?)<\/th>/i)?.[1] || '').toLowerCase() }))
      .filter((t) => WEEKDAYS.some((w) => t.title.startsWith(w)));   // только таблицы дней недели

    weekStart ||= tables.length ? weekStartFromTitle(tables[0].title) : null;
    if (!weekStart) return { group: groupNameOf(textOf(html)), weekStart: null, days: {} };

    const days = emptyWeek(weekStart);
    for (const { table, title } of tables) {
      const date = addDays(weekStart, WEEKDAYS.findIndex((w) => title.startsWith(w)));
      for (const [, row] of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
        const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
        const time = textOf(cells[1] || '').match(/(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/);
        if (!time) continue;                                   // пустая строка — пары нет

        const subjectCell = cells[2] || '';
        // Название — в <b>, тип занятия — в <small>(Практ.)</small>
        const bold = [...subjectCell.matchAll(/<b[^>]*>([\s\S]*?)<\/b>/gi)].map((m) => textOf(m[1]));
        const subject = bold.length ? bold.join(' / ') : textOf(subjectCell);
        // Тип у группы — в <small>, у преподавателя — просто текстом после названия
        const small = subjectCell.match(/<small[^>]*>([\s\S]*?)<\/small>/i)?.[1];
        const typeText = small ?? (bold.length ? subjectCell.replace(/<b[^>]*>[\s\S]*?<\/b>/gi, '') : '');
        const type = textOf(typeText).replace(/^\((.*)\)$/, '$1');
        days[date].push(makeLesson(textOf(cells[0] || ''), time[1], time[2], subject, type, textOf(cells[3] || ''), textOf(cells[4] || '')));
      }
    }
    return { group: groupNameOf(textOf(html)), weekStart, days };
  }

  /**
   * Обычный текст страницы (если при копировании HTML не сохранился) → то же, что parseSchedule.
   * Ожидаем строки вида:  "понедельник, 21 сентября"  и  "2 <Tab> 10:45 - 12:20 <Tab> Предмет (Практ.) <Tab> Преподаватель <Tab> 201 (Ленина, 57)"
   */
  function parseScheduleText(text) {
    let weekStart = null;
    let date = null;
    let days = {};
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      const low = line.toLowerCase();
      if (WEEKDAYS.some((w) => low.startsWith(w + ','))) {
        if (!weekStart) {
          weekStart = weekStartFromTitle(low);
          if (weekStart) days = emptyWeek(weekStart);
        }
        date = weekStart && addDays(weekStart, WEEKDAYS.findIndex((w) => low.startsWith(w + ',')));
        continue;
      }
      const m = line.match(/^(\d)\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s+(.+)$/);
      if (!m || !date) continue;
      // Ячейки разделены табуляцией. Последняя — аудитория, перед ней — преподаватель,
      // всё остальное — название предмета с типом занятия.
      const parts = m[4].split('\t').map((s) => s.trim()).filter(Boolean);
      const roomText = parts.length >= 3 ? parts.pop() : '';
      const teacher = parts.length >= 2 ? parts.pop() : '';
      const subjectRaw = parts.join(' ').replace(/\s+/g, ' ');
      // Тип занятия — последние скобки вида "(Практ.)", "(Лек./Лаб.)" — но не "(фак.)"
      const typeMatch = subjectRaw.match(/\s*\(((?!фак)[А-Яа-яЁё./]+\.)\)\s*$/);
      const subject = typeMatch ? subjectRaw.slice(0, typeMatch.index).trim() : subjectRaw;
      days[date].push(makeLesson(m[1], m[2], m[3], subject, typeMatch?.[1] || '', teacher, roomText));
    }
    return { group: groupNameOf(text), weekStart, days };
  }

  // Для телефона: вставленное содержимое — HTML или обычный текст? Пробуем оба способа.
  function parsePasted(html, text) {
    if (html) {
      const res = parseSchedule(html);
      if (res.weekStart && Object.values(res.days).some((d) => d.length)) return res;
    }
    return parseScheduleText(text || textOf(html || ''));
  }

  globalThis.MAU = {
    ORIGIN, TIMETABLE_URL, groupsUrl, scheduleUrl, teacherScheduleUrl, addDays, weekStartFromTitle,
    decodeEntities, textOf, parseMeta, parseGroups, parseTeachers, shortName, parseRoom, parseSchedule, parseScheduleText, parsePasted,
  };
})();
