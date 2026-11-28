// =====================================================================
//  Экран «Главная»: какая пара идёт сейчас (кто ведёт — полное ФИО,
//  сколько до конца), следующая пара в полупрозрачной карточке и все пары дня.
//  Расчёт — общий с «Дорогой»: calculate() и dayLessons() из app.js.
//  Подключается после app.js и trip.js; renderStatus (app.js) вызывает renderHome.
// =====================================================================

// Полное ФИО, если сервер его нашёл, иначе — как в расписании ("Воронин А.В.")
const teacherName = (l) => l.teacherFull || l.teacher || '';

// "2 пара" — номер пары, если он есть
const pairNumber = (l) => (l.number ? `${l.number} пара` : 'Пара');

// Значок человека для строки преподавателя
const ICON_PERSON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.6" fill="none" stroke="currentColor" stroke-width="2"/><path d="M5 20a7 7 0 0 1 14 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

// Строки "кто ведёт" и "где" для карточки
function factsHtml(l) {
  const rows = [];
  if (l.type) rows.push(`<li class="now-type">${escapeHtml(l.type)}${l.subs ? ` · ${escapeHtml(l.subs.join(', '))} п/г` : ''}</li>`);
  if (teacherName(l)) rows.push(`<li>${ICON_PERSON}<span>${escapeHtml(teacherName(l))}</span></li>`);
  const place = lessonPlace(l);
  if (place) rows.push(`<li>${ICON_PIN}<span>${escapeHtml(place)}</span></li>`);
  return rows.join('');
}

// Крупный таймер: число + единица: "42 мин", "14 ч 30 мин", "2 дня"
function timerParts(minutes) {
  if (minutes < 60) return { time: String(minutes), unit: 'мин' };
  if (minutes < 24 * 60) {
    const m = minutes % 60;
    return { time: String(Math.floor(minutes / 60)), unit: m ? `ч ${m} мин` : 'ч' };
  }
  const days = Math.round(minutes / (24 * 60));
  return { time: String(days), unit: plural(days, 'день', 'дня', 'дней') };
}

function setTimer(minutes, label) {
  const { time, unit } = timerParts(Math.max(1, minutes));
  $('now-number').textContent = time;
  $('now-unit').textContent = unit;
  $('now-left-label').textContent = label;
  $('now-timer').hidden = false;
}

function setNowProgress(from, to, fraction) {
  $('now-progress').hidden = false;
  $('now-bar-fill').style.width = `${Math.round(clamp(fraction, 0, 1) * 100)}%`;
  $('now-bar-from').textContent = from;
  $('now-bar-to').textContent = to;
}

// Карточка «Следующая пара». when — "через 25 мин" / "завтра"; prev — пара перед ней (для смены корпуса)
function renderNext(l, label, when, prev = null) {
  $('next-card').hidden = !l;
  if (!l) return;
  $('next-label').textContent = label;
  $('next-when').textContent = when;
  $('next-start').textContent = l.start;
  $('next-end').textContent = l.end || '';
  $('next-subject').innerHTML = `${escapeHtml(subjectOf(l))}${l.subs ? `<span class="badge badge-sub">${escapeHtml(l.subs.join(', '))} п/г</span>` : ''}`;
  $('next-teacher').textContent = [l.type, teacherName(l)].filter(Boolean).join(' · ');
  $('next-teacher').hidden = !$('next-teacher').textContent;
  const place = lessonPlace(l);
  $('next-place').innerHTML = place ? `${ICON_PIN}<span>${escapeHtml(place)}</span>` : '';
  $('next-place').hidden = !place;
  // Следующая пара в другом корпусе — предупреждаем (красным, если на переход 10 минут и меньше)
  const move = prev && !sameBuilding(prev.address, l.address);
  const gap = move ? minutesBetween(prev.endAt, l.startAt) : 0;
  $('next-move').innerHTML = move
    ? `<div class="move-note ${gap <= 10 ? 'is-tight' : ''}">${ICON_WALK}<div><b>Другой корпус${gap <= 10 ? ' — времени мало' : ''}</b><span>${escapeHtml(prev.address)} → ${escapeHtml(l.address)}</span></div></div>`
    : '';
}

// Список пар дня. current — идущая пара (выделяется), прошедшие — бледные
function renderDayList(lessons, title, now, current) {
  $('day-block').hidden = !lessons.length;
  if (!lessons.length) return;
  $('day-title').textContent = title;
  const longest = longestBreak(lessons);
  $('day-list').innerHTML = lessons.map((l, i) => (i ? breakRowHtml(lessons[i - 1], l, longest) : '') + `
      <div class="later-row ${l === current ? 'is-current' : ''} ${now && l.endAt <= now ? 'is-past' : ''}">
        <div class="lesson-card-time"><span>${escapeHtml(l.start)}</span><span>${escapeHtml(l.end || '')}</span></div>
        <div class="lesson-card-body">
          <div class="later-subject">${escapeHtml(subjectOf(l))}${l === current ? '<span class="badge badge-now">идёт</span>' : ''}</div>
          <div class="lesson-card-meta">${escapeHtml([teacherName(l), lessonPlace(l)].filter(Boolean).join(' · '))}</div>
        </div>
      </div>`).join('');
  const last = lessons.reduce((m, l) => (l.endAt > m ? l.endAt : m), lessons[0].endAt);
  $('day-end').textContent = `${lessons.length} ${plural(lessons.length, 'пара', 'пары', 'пар')} · до ${formatTime(last)}`;
}

// Ссылка на «Дорогу»: когда выходить (только пока сегодня или завтра надо куда-то ехать)
function renderRoadLink(r, now) {
  let plan = null, day = '';
  if (r.state === 'waiting' || r.state === 'leave-now') plan = r;
  else if (r.next) { plan = r.next; day = `${dayPhrase(r.next.daysAhead, r.next.date)} `; }
  $('road-link').hidden = !plan;
  if (!plan) return;
  $('road-link-title').textContent = r.state === 'leave-now' ? 'Пора выходить!' : `Выйти ${day}в ${formatTime(plan.leaveAt)}`;
  $('road-link-sub').textContent = plan.viaTransport ? 'по расписанию транспорта · как доехать' : 'сколько ехать и как доехать';
  $('road-link').classList.toggle('is-urgent', r.state === 'leave-now');
}

function renderHome(r, now = new Date()) {
  if (!$('now-card')) return;                      // старая закэшированная разметка без «Главной»
  $('home-date').textContent = now.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
  const card = $('now-card');
  $('now-progress').hidden = true;
  $('now-timer').hidden = true;
  $('now-facts').innerHTML = '';
  const nextDay = r.next ? dayLessons(settings, data, r.next.date) : [];
  const nextDayTitle = r.next ? `Пары ${dayPhrase(r.next.daysAhead, r.next.date)}` : '';

  if (r.state === 'in-class') {
    // Идёт пара: что, кто ведёт, где и сколько до конца
    const c = r.current;
    card.dataset.state = 'class';
    $('now-label').textContent = `Сейчас · ${pairNumber(c)}`;
    $('now-subject').textContent = subjectOf(c);
    $('now-facts').innerHTML = factsHtml(c);
    setTimer(Math.ceil((c.endAt - now) / 60000), r.upcoming ? `до конца пары · перерыв в ${c.end}` : `до конца пары · последняя сегодня`);
    setNowProgress(c.start, c.end, (now - c.startAt) / (c.endAt - c.startAt));
    renderNext(r.upcoming, 'Следующая пара', r.upcoming ? `через ${formatDuration(Math.max(1, Math.ceil((r.upcoming.startAt - now) / 60000)))}` : '', c);
    renderDayList(r.lessons, 'Пары сегодня', now, c);
  } else if (r.state === 'break') {
    // Перерыв (или окно): сколько до следующей пары
    const n = r.upcoming;
    const from = r.prev ? r.prev.endAt : r.classStart;
    const total = minutesBetween(from, n.startAt);
    card.dataset.state = 'break';
    $('now-label').textContent = total >= 60 ? 'Сейчас · окно' : 'Сейчас · перерыв';
    $('now-subject').textContent = total >= 60 ? `Окно ${formatDuration(total)}` : `Перерыв ${formatDuration(total)}`;
    setTimer(Math.ceil((n.startAt - now) / 60000), `до следующей пары · начало в ${n.start}`);
    setNowProgress(formatTime(from), n.start, (now - from) / (n.startAt - from));
    renderNext(n, 'Следующая пара', `через ${formatDuration(Math.max(1, Math.ceil((n.startAt - now) / 60000)))}`, r.prev);
    renderDayList(r.lessons, 'Пары сегодня', now, null);
  } else if (r.state === 'waiting' || r.state === 'leave-now') {
    // Пары сегодня ещё не начались
    const first = r.lessons[0];
    card.dataset.state = 'before';
    $('now-label').textContent = 'Сегодня';
    $('now-subject').textContent = `Первая пара в ${first.start}`;
    setTimer(Math.ceil((first.startAt - now) / 60000), 'до начала пар');
    renderNext(first, 'Первая пара', pairNumber(first).toLowerCase());
    renderDayList(r.lessons, 'Пары сегодня', now, null);
  } else if (r.state === 'no-data') {
    card.dataset.state = 'none';
    $('now-label').textContent = 'Расписание';
    $('now-subject').textContent = 'Нет расписания на сегодня';
    $('now-facts').innerHTML = `<li class="now-type">${escapeHtml($('hero-subtitle').textContent || 'Выбери группу в настройках')}</li>`;
    renderNext(null);
    renderDayList([], '', null, null);
  } else {
    // Пар сегодня нет или они закончились — показываем ближайший учебный день
    card.dataset.state = 'free';
    $('now-label').textContent = r.state === 'day-over' ? 'Сегодня' : 'Сегодня пар нет';
    $('now-subject').textContent = r.state === 'day-over' ? 'Пары закончились' : 'Можно выдохнуть';
    if (r.next) {
      const first = nextDay[0];
      setTimer(Math.ceil((r.next.classStart - now) / 60000), `до пар ${dayPhrase(r.next.daysAhead, r.next.date)}`);
      renderNext(first, `Первая пара ${dayPhrase(r.next.daysAhead, r.next.date)}`, first ? `в ${first.start}` : '');
    } else {
      $('now-facts').innerHTML = '<li class="now-type">Расписания на следующие дни пока нет</li>';
      renderNext(null);
    }
    renderDayList(nextDay, nextDayTitle, null, null);
  }
  renderRoadLink(r, now);
}

$('day-week').addEventListener('click', () => document.querySelector('[data-view="view-schedule"]').click());
$('road-link').addEventListener('click', () => document.querySelector('[data-view="view-today"]').click());

renderStatus();
