// =====================================================================
//  Карточка «Как доехать»: на какую остановку идти, на что садиться и во сколько,
//  с пересадкой, если она нужна. Считает сервер (/api/transport/plan), а без сервера —
//  сам телефон (plan.js) по данным, которые опубликовал компьютер. Всё по расписанию
//  АО «Электротранспорт» — это НЕ данные в реальном времени, о чём честно пишем.
//
//  Откуда: "от меня сейчас" (геопозиция — браузер спросит разрешение) или сохранённый дом.
//  От дома план строится сам при каждой смене пары. Подключается после app.js.
// =====================================================================

const trip = {
  target: null,        // к какой паре едем: { date, classStart, lesson }
  key: '',             // чтобы не пересчитывать одно и то же
  from: null,          // { lat, lon, label }
  result: null,
  loading: false,
  error: '',
};

const KIND_EMOJI = { bus: '🚌', trolleybus: '🚎' };
const KIND_NAME = { bus: 'Автобус', trolleybus: 'Троллейбус' };
const minutesOfDay = (d) => d.getHours() * 60 + d.getMinutes();
const hhmmOf = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

// Вызывается из renderStatus (app.js) каждый раз, когда пересчитывается главный экран
function updateTripTarget(target) {
  trip.target = target;
  // Дом сохранён и сервер есть — считаем сами; иначе ждём нажатия кнопки
  if (!trip.from && settings.home) trip.from = { ...settings.home, label: 'от дома' };
  if (trip.from && target) planTripNow();
  renderTrip();
}

// ---------- Расчёт в телефоне (когда сервера нет, а данные опубликовал компьютер) ----------

const SOURCE = 'Расписание АО «Электротранспорт города Мурманска» и карта OpenStreetMap';
const CAMPUS = { lat: 68.95363, lon: 33.06595, label: 'проспект Кирова 1' };   // главный корпус — если место пары неизвестно
let localTransport = null;                         // { net, places, checkedAt, loadedAt }

// Сеть маршрутов из data/transport.json (~0,5 МБ; держим в памяти, обновляем раз в 12 часов)
async function loadLocalTransport() {
  if (localTransport && Date.now() - localTransport.loadedAt < 12 * 3600 * 1000) return localTransport;
  const get = async (name) => {
    const response = await fetch(`data/${name}`, { cache: 'no-cache' });
    if (!response.ok || !(response.headers.get('content-type') || '').includes('json')) throw new Error('компьютер ещё не опубликовал данные транспорта');
    return response.json();
  };
  const [transport, places] = await Promise.all([get('transport.json'), get('places.json')]);
  // Старая закэшированная разметка может не подключать plan.js — тогда подгружаем его сами
  if (!globalThis.PLAN) {
    await new Promise((resolve, reject) => {
      const script = Object.assign(document.createElement('script'), { src: 'plan.js', onload: resolve, onerror: reject });
      document.head.append(script);
    });
  }
  // Времена в файле сжаты — распаковываем и готовим сеть (plan.js)
  const patterns = transport.patterns.map((p) => ({ ...p, stops: p.stops.map((s) => ({ ...s, times: PLAN.unpackTimes(s.t) })) }));
  localTransport = { net: PLAN.prepareNetwork(patterns), places, checkedAt: transport.checkedAt, loadedAt: Date.now() };
  return localTransport;
}

// То же, что /api/transport/plan на сервере, но прямо в телефоне
async function planLocally({ from, date, by, after, lesson }) {
  const lt = await loadLocalTransport();
  const place = (lesson && lt.places[`${lesson.room || ''}|${lesson.address || ''}`]) || CAMPUS;
  const day = new Date(`${date}T12:00:00`).getDay();
  const result = PLAN.planTrip(lt.net, { from, to: place, day, earliest: toMinutes(after), deadline: toMinutes(by) });
  return { realtime: false, source: SOURCE, checkedAt: lt.checkedAt, place, ...result };
}
const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));


// Посчитать план (если что-то поменялось: пара, откуда, погода, запас).
// С сервером — спрашиваем его, без сервера — считаем сами по опубликованным данным.
async function planTripNow({ force = false } = {}) {
  const t = trip.target;
  if (!t || !trip.from) return;
  const now = new Date();
  const isToday = t.date === isoDate(now);
  // Быть у корпуса к началу пары минус запас и добавка на погоду (в снег и гололёд — с запасом побольше);
  // не выходить раньше, чем сейчас (если едем сегодня)
  const weatherExtra = settings.weatherExtra[settings.weather] || 0;
  const by = hhmmOf(Math.max(0, minutesOfDay(t.classStart) - settings.buffer - weatherExtra));
  const after = isToday ? hhmmOf(minutesOfDay(now)) : '00:00';
  const params = new URLSearchParams({
    from: `${trip.from.lat.toFixed(5)},${trip.from.lon.toFixed(5)}`,
    date: t.date, by, after,
    address: t.lesson?.address || '', room: t.lesson?.room || '',
  });
  const key = params.toString();
  // Пока едем сегодня, "сейчас" меняется каждую минуту — но пересчитывать чаще раза в 5 минут незачем
  const sameExceptTime = key.replace(/after=[^&]*/, '') === trip.key.replace(/after=[^&]*/, '');
  if (!force && (trip.loading || (sameExceptTime && Date.now() - (trip.at || 0) < 5 * 60 * 1000))) return;

  trip.key = key;
  trip.at = Date.now();
  trip.loading = true;
  trip.error = '';
  renderTrip();
  try {
    if (API_BASE) {
      const response = await fetch(`${API_BASE}/api/transport/plan?${params}`);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `ошибка ${response.status}`);
      trip.result = body;
    } else {
      trip.result = await planLocally({ from: trip.from, date: t.date, by, after, lesson: t.lesson });
    }
  } catch (e) {
    trip.error = e.message === 'Failed to fetch' ? (API_BASE ? 'нет связи с сервером' : 'нет подключения к интернету') : e.message;
    trip.result = null;
  } finally {
    trip.loading = false;
    // Передаём время выхода главному экрану (app.js), если успеваем к паре
    const best = trip.result?.options?.[0];
    transportPlan = best && !trip.result.late
      ? { date: t.date, classStartMs: t.classStart.getTime(), leaveAt: best.leaveAt }
      : null;
    renderTrip();
    renderStatus();
  }
}


// ---------- Отрисовка ----------

function renderTrip() {
  const body = $('trip-body');
  $('trip-home').hidden = !settings.home || trip.from?.label === 'от дома';
  $('trip-save-home').hidden = !(trip.from && trip.from.label === 'от меня' && !trip.result?.late && trip.result);

  if (!trip.target) {
    body.innerHTML = '<p class="trip-hint">Нет ближайших пар — ехать некуда 🙂</p>';
    return;
  }
  if (!trip.from) {
    body.innerHTML = '<p class="trip-hint">Покажу, на какую остановку идти и на что садиться, чтобы успеть к паре.</p>';
    return;
  }
  if (trip.loading) {
    body.innerHTML = '<p class="trip-hint">Считаю маршрут…</p>';
    return;
  }
  if (trip.error) {
    body.innerHTML = `<p class="trip-hint is-error">Не получилось: ${escapeHtml(trip.error)}.</p>`;
    return;
  }
  const res = trip.result;
  if (!res) return;
  if (!res.options.length) {
    body.innerHTML = '<p class="trip-hint">Подходящих рейсов не нашлось. Возможно, рядом нет остановок наших маршрутов — маршрутки в расписании не учтены.</p>';
    return;
  }

  const [best, ...others] = res.options;
  const when = trip.target.date === isoDate(new Date()) ? '' : ` ${dayPhrase(daysBetween(trip.target.date), new Date(trip.target.date + 'T12:00'))}`;
  body.innerHTML = `
    ${res.late ? '<p class="trip-late">⚠️ К началу пары уже не успеть — вот как добраться быстрее всего</p>' : ''}
    <div class="trip-head">
      <span class="trip-leave">Выйти${escapeHtml(when)} в ${escapeHtml(best.leaveAt)}</span>
      <span class="trip-arrive">у корпуса в ${escapeHtml(best.arriveAt)} · ${escapeHtml(trip.from.label)}</span>
    </div>
    <ol class="trip-steps">${stepsOf(best, res.place).join('')}</ol>
    ${others.length ? `<p class="trip-alt-title">Ещё варианты</p>${others.map((o) => `
      <p class="trip-alt">${escapeHtml(o.leaveAt)} → ${escapeHtml(o.arriveAt)} · ${escapeHtml(summaryOf(o))}</p>`).join('')}` : ''}`;
  $('trip-note').textContent = `${res.realtime ? '' : 'По расписанию, не в реальном времени. '}Источник: ${res.source}.`;
}

// Шаги поездки: пешком → транспорт → (пересадка → транспорт) → пешком
function stepsOf(o, place) {
  const step = (icon, html) => `<li class="trip-step"><span class="trip-icon">${icon}</span><span>${html}</span></li>`;
  const e = escapeHtml;
  if (o.walkOnly) return [step('🚶', `Пешком <b>${o.walkTo} мин</b> до корпуса (${e(place.label)})`)];
  const out = [];
  const first = o.legs[0];
  out.push(step('🚶', `${o.walkTo ? `${o.walkTo} мин пешком` : 'Ты уже'} до остановки <b>«${e(first.from.name)}»</b>`));
  o.legs.forEach((l, i) => {
    if (i > 0) out.push(step('🔁', `Пересадка: ${o.transfer.walk} мин пешком${o.transfer.wait ? `, ждать ${o.transfer.wait} мин` : ''} — остановка <b>«${e(l.from.name)}»</b>`));
    out.push(step(KIND_EMOJI[l.kind] || '🚌',
      `${KIND_NAME[l.kind] || 'Автобус'} <b>${e(l.ref)}</b> в <b>${e(l.departAt)}</b> → «${e(l.to.name)}» в ${e(l.arriveAt)}` +
      `<span class="trip-sub">${e(l.direction)} · ${l.stops} ост.</span>`));
  });
  out.push(step('🏫', `${o.walkFrom} мин пешком до корпуса (${e(place.label)})`));
  return out;
}

// Коротко для списка вариантов: "3Т → троллейбус 3" или "пешком"
function summaryOf(o) {
  if (o.walkOnly) return `пешком ${o.walkTo} мин`;
  return o.legs.map((l) => `${KIND_NAME[l.kind]?.toLowerCase() || 'автобус'} ${l.ref} от «${l.from.name}»`).join(' → ');
}

function daysBetween(dateIso) {
  const a = new Date(isoDate(new Date()) + 'T12:00'), b = new Date(dateIso + 'T12:00');
  return Math.round((b - a) / 86400000);
}


// ---------- Кнопки ----------

$('trip-here').addEventListener('click', () => {
  if (!navigator.geolocation) {
    trip.error = 'этот браузер не умеет определять местоположение';
    renderTrip();
    return;
  }
  trip.loading = true;
  renderTrip();
  $('trip-body').innerHTML = '<p class="trip-hint">Определяю, где ты…</p>';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      trip.loading = false;
      trip.from = { lat: pos.coords.latitude, lon: pos.coords.longitude, label: 'от меня' };
      planTripNow({ force: true });
    },
    (err) => {
      trip.loading = false;
      trip.error = err.code === err.PERMISSION_DENIED
        ? 'нет доступа к геопозиции — разреши его в настройках iPhone (Конфиденциальность → Службы геолокации → Safari)'
        : 'не удалось определить местоположение';
      renderTrip();
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
  );
});

$('trip-home').addEventListener('click', () => {
  trip.from = { ...settings.home, label: 'от дома' };
  planTripNow({ force: true });
});

// Запомнить текущее место как дом — чтобы вечером видеть план на завтра без геопозиции
$('trip-save-home').addEventListener('click', () => {
  settings.home = { lat: trip.from.lat, lon: trip.from.lon };
  saveSettings(settings);
  trip.from = { ...settings.home, label: 'от дома' };
  renderTrip();
});

// Настройка: считать время выхода по расписанию транспорта
$('use-transport').checked = settings.useTransport;
$('use-transport').addEventListener('change', (e) => {
  settings.useTransport = e.target.checked;
  saveSettings(settings);
  renderStatus();
});

// Первая отрисовка (renderStatus уже отработал до загрузки этого файла)
renderStatus();
