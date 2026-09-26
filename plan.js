// =====================================================================
//  Планировщик поездки: откуда (геопозиция или дом) → корпус первой пары.
//  Прямой рейс или с одной пересадкой, по РАСПИСАНИЮ перевозчика
//  (данных о транспорте в реальном времени нет).
//
//  Один и тот же код работает на сервере (server/src/transport/plan.js)
//  и в телефоне (trip.js, когда сервера нет, а данные опубликовал компьютер).
//  Обычный скрипт (не модуль): всё нужное кладёт в globalThis.PLAN.
//
//  Время везде — минуты от полуночи (08:20 → 500).
// =====================================================================
(function () {
  const WALK_M_PER_MIN = 75;        // ~4.5 км/ч
  const DETOUR = 1.25;              // по прямой короче, чем по улицам
  const MAX_WALK_M = 1000;          // до остановки и от остановки — не дальше
  const MAX_TRANSFER_M = 350;       // пешком между остановками при пересадке
  const MIN_TRANSFER_WAIT = 1;      // хотя бы минута на пересадку
  const WALK_ONLY_M = 2000;         // ближе этого — предлагаем дойти пешком

  // Расстояние между точками в метрах (формула гаверсинусов)
  function distanceM(a, b) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  const walkMinutes = (a, b) => Math.ceil((distanceM(a, b) * DETOUR) / WALK_M_PER_MIN);
  const hhmm = (min) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

  /**
   * Подготовить сеть маршрутов (делаем один раз и держим в памяти).
   * patterns — направления маршрутов: [{ id, ref, kind, name, stops: [{ name, lat, lon, times }] }],
   * times — { "1": [минуты...], ..., "0": [...] } по дням недели.
   * Заранее находим пересадки: остановки разных маршрутов в пределах MAX_TRANSFER_M друг от друга.
   */
  function prepareNetwork(patterns) {
    const located = patterns.flatMap((p) => p.stops.filter((s) => s.lat != null).map((s) => ({ p, s })));
    for (const a of located) {
      a.s.transfers = located
        .filter((b) => b.p.ref !== a.p.ref || b.p.kind !== a.p.kind)
        .map((b) => ({ p: b.p, s: b.s, m: distanceM(a.s, b.s) }))
        .filter((b) => b.m <= MAX_TRANSFER_M);
    }
    return { patterns };
  }

  // Первый элемент отсортированного массива, который ≥ x (двоичный поиск)
  function firstAtLeast(arr, x) {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < x) lo = mid + 1; else hi = mid; }
    return lo;
  }

  /**
   * Во сколько автобус, ушедший с остановки i в момент t, будет на остановке j.
   * У перевозчика времена даны по каждой остановке отдельно, рейсы не связаны. Поэтому
   * считаем обычное время в пути от i до j (см. typicalRide) и ищем на j время рядом с t + это время.
   * Если такого нет — наш рейс, видимо, укороченный и до j не доезжает.
   */
  function arrivalAt(p, i, j, t, day, cache) {
    const typical = typicalRide(p, i, j, day, cache);
    if (!Number.isFinite(typical)) return null;
    const tj = p.stops[j].times[day] || [];
    const target = t + typical;
    let best = null;
    for (let k = firstAtLeast(tj, target - 2); k < tj.length && tj[k] <= target + 3; k++) {
      if (best == null || Math.abs(tj[k] - target) < Math.abs(best - target)) best = tj[k];
    }
    return best;
  }

  /**
   * Обычное время в пути от остановки i до j = сумма времён между соседними остановками.
   * Между соседними ехать 1–4 минуты — меньше интервала между автобусами, поэтому сдвиг
   * находится надёжно: тот, при котором больше всего времён на двух остановках совпадает.
   */
  function typicalRide(p, i, j, day, cache) {
    let total = 0;
    for (let s = i; s < j; s++) {
      const key = `${p.id}:${s}:${day}`;
      if (!cache.has(key)) cache.set(key, adjacentRide(p.stops[s].times[day] || [], p.stops[s + 1].times[day] || []));
      total += cache.get(key);
    }
    return total;
  }

  function adjacentRide(ti, tj) {
    if (!ti.length || !tj.length) return Infinity;
    const set = new Set(tj);
    let bestD = Infinity, bestScore = 0;
    for (let d = 0; d <= 15; d++) {
      const score = ti.reduce((n, x) => n + (set.has(x + d) ? 1 : 0), 0);
      if (score > bestScore) { bestScore = score; bestD = d; }
    }
    // Совпало слишком мало рейсов — не уверены
    return bestScore >= Math.min(3, ti.length) ? bestD : Infinity;
  }

  const stopInfo = (s) => ({ name: s.name, lat: s.lat, lon: s.lon });
  const legOf = (p, i, j, dep, arr) => ({
    ref: p.ref, kind: p.kind, direction: p.name,
    from: stopInfo(p.stops[i]), departAt: hhmm(dep),
    to: stopInfo(p.stops[j]), arriveAt: hhmm(arr), stops: j - i,
  });

  /**
   * Найти варианты поездки.
   * @param {object} net      prepareNetwork()
   * @param {object} q
   * @param {{lat,lon}} q.from, q.to
   * @param {number} q.day      день недели (0 — воскресенье)
   * @param {number} q.earliest не выходить раньше (минуты; для "прямо сейчас" — текущее время)
   * @param {number} q.deadline быть у корпуса не позже (минуты)
   * @returns {{ options: Array, late: boolean }}
   *   options — лучшие варианты: сначала те, где можно выйти позже всего и всё равно успеть.
   *   late = true — успеть к deadline нельзя; тогда варианты с самым ранним прибытием.
   */
  function planTrip(net, { from, to, day, earliest, deadline }) {
    const cache = new Map();
    const near = (point) => net.patterns.map((p) => p.stops
      .map((s, i) => (s.lat != null ? { i, walk: walkMinutes(point, s), m: distanceM(point, s) } : null))
      .filter((x) => x && x.m <= MAX_WALK_M));
    const origins = near(from);
    const dests = near(to);

    const found = [];      // все подходящие варианты
    const consider = (opt) => { if (opt.leaveAt >= earliest) found.push(opt); };

    // Для каждого направления маршрута: откуда сесть (i) и где выйти (j), i < j
    net.patterns.forEach((p, pi) => {
      for (const o of origins[pi]) {
        for (const d of dests[pi]) {
          if (o.i >= d.i) continue;
          const deps = p.stops[o.i].times[day] || [];
          for (let k = firstAtLeast(deps, earliest + o.walk); k < deps.length; k++) {
            const arr = arrivalAt(p, o.i, d.i, deps[k], day, cache);
            if (arr == null) continue;
            consider({
              leaveAt: deps[k] - o.walk, arriveAt: arr + d.walk, walkTo: o.walk, walkFrom: d.walk,
              legs: [legOf(p, o.i, d.i, deps[k], arr)],
            });
          }
        }
      }
    });

    // С одной пересадкой: p1 от i до k, пешком до остановки m маршрута p2, p2 от m до j
    net.patterns.forEach((p1, pi1) => {
      if (!origins[pi1].length) return;
      for (const o of origins[pi1]) {
        for (let k = o.i + 1; k < p1.stops.length; k++) {
          for (const tr of p1.stops[k].transfers || []) {
            const p2 = tr.p;
            const pi2 = net.patterns.indexOf(p2);
            const m = p2.stops.indexOf(tr.s);
            for (const d of dests[pi2]) {
              if (m >= d.i) continue;
              const transferWalk = Math.ceil((tr.m * DETOUR) / WALK_M_PER_MIN);
              const deps1 = p1.stops[o.i].times[day] || [];
              // Не перебираем весь день: достаточно нескольких рейсов после earliest и перед deadline
              const from1 = firstAtLeast(deps1, earliest + o.walk);
              const to1 = Math.min(deps1.length, firstAtLeast(deps1, deadline) + 1);
              for (let a = from1; a < to1 && a < from1 + 40; a++) {
                const arr1 = arrivalAt(p1, o.i, k, deps1[a], day, cache);
                if (arr1 == null) continue;
                const deps2 = p2.stops[m].times[day] || [];
                const b = firstAtLeast(deps2, arr1 + transferWalk + MIN_TRANSFER_WAIT);
                if (b >= deps2.length) continue;
                const arr2 = arrivalAt(p2, m, d.i, deps2[b], day, cache);
                if (arr2 == null) continue;
                consider({
                  leaveAt: deps1[a] - o.walk, arriveAt: arr2 + d.walk, walkTo: o.walk, walkFrom: d.walk,
                  transfer: { walk: transferWalk, wait: deps2[b] - arr1 - transferWalk },
                  legs: [legOf(p1, o.i, k, deps1[a], arr1), legOf(p2, m, d.i, deps2[b], arr2)],
                });
              }
            }
          }
        }
      }
    });

    // Пешком, если близко
    if (distanceM(from, to) <= WALK_ONLY_M) {
      const walkAll = walkMinutes(from, to);
      const leave = Math.max(earliest, deadline - walkAll);
      found.push({ leaveAt: leave, arriveAt: leave + walkAll, walkTo: walkAll, walkFrom: 0, legs: [], walkOnly: true });
    }

    // Лучшие: успеваем к deadline и выходим как можно позже. Лишняя ходьба и пересадки немного
    // "штрафуются", чтобы ради пары минут не предлагать идти через полгорода.
    const cost = (o) => -o.leaveAt + 0.3 * (o.walkTo + o.walkFrom) + 3 * Math.max(0, o.legs.length - 1);
    const onTime = found.filter((o) => o.arriveAt <= deadline).sort((a, b) => cost(a) - cost(b));
    let options = pickDistinct(onTime);
    let late = false;
    if (!options.length) {
      // Не успеть — показываем, как добраться побыстрее
      late = true;
      options = pickDistinct(found.sort((a, b) => a.arriveAt - b.arriveAt || b.leaveAt - a.leaveAt));
    }
    return {
      options: options.map((o) => ({ ...o, leaveAt: hhmm(o.leaveAt), arriveAt: hhmm(o.arriveAt) })),
      late,
    };
  }

  // До трёх вариантов с разными маршрутами — а не один и тот же автобус с посадкой на соседних остановках.
  // Список уже отсортирован, поэтому для каждого направления маршрута остаётся лучший вариант.
  function pickDistinct(list) {
    const seen = new Set();
    const out = [];
    for (const o of list) {
      const key = o.walkOnly ? 'walk' : o.legs.map((l) => `${l.ref}/${l.kind}/${l.direction}`).join('+');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(o);
      if (out.length === 3) break;
    }
    return out;
  }

  /**
   * Распаковать времена остановки из опубликованного файла transport.json (сжимает их packTimes на сервере):
   *   [ [[1,2,3,4,5], [380, 12, 18]], [[6,0], [...]] ]  →  { "1": [380, 392, 410], ..., "6": [...], "0": [...] }
   */
  function unpackTimes(packed) {
    const times = {};
    for (const [days, deltas] of packed) {
      const list = [];
      deltas.forEach((d, i) => list.push(i ? list[i - 1] + d : d));
      for (const day of days) times[day] = list;
    }
    return times;
  }

  globalThis.PLAN = { distanceM, walkMinutes, hhmm, prepareNetwork, planTrip, unpackTimes };
})();
