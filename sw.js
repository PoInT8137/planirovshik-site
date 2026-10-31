// =====================================================================
//  Service worker — "посредник" между приложением и сетью.
//  Он сохраняет файлы приложения в кэш, чтобы оно открывалось без интернета.
//  Все расчёты локальные, так что офлайн приложение работает полностью.
// =====================================================================

// Имя кэша с версией. УВЕЛИЧИВАЙ НОМЕР ПРИ КАЖДОМ ИЗМЕНЕНИИ файлов приложения:
// только тогда телефоны скачают новую версию (все файлы сразу), а старый кэш удалится.
const CACHE_NAME = 'road-to-uni-v31';

// Отдельный маленький кэш для отметки «подписка на уведомления сменилась — нужен новый код».
// Его НЕ удаляем при смене версии (см. activate), иначе отметка потеряется при обновлении.
const PUSH_STATE_CACHE = 'push-state';
const PUSH_STATE_URL = 'push-state.json';
// Там же notify.js запоминает ключ, которым подписался (нужен при переподписке, см. pushsubscriptionchange)
const PUSH_KEY_URL = 'push-key.json';

// Файлы, которые кладём в кэш сразу при установке.
const APP_FILES = [
  './',
  './index.html',
  './style.css',
  './mau.js',
  './data.js',
  './app.js',
  './browse.js',
  './plan.js',
  './trip.js',
  './home.js',
  './notify.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/badge-96.png',
];

// 1. УСТАНОВКА: скачиваем и сохраняем все файлы приложения.
self.addEventListener('install', (event) => {
  // waitUntil — "не считай установку завершённой, пока не выполнится это обещание"
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Это обновление (у телефона уже есть рабочая старая версия) или самая первая установка?
    const isUpdate = Boolean(self.registration.active);
    const missing = [];
    // Кэшируем файлы ПО ОДНОМУ, недокачанный файл пробуем ещё раз. Дальше по-разному:
    //  • первая установка — пропуски допустимы: иначе service worker не установится вовсе
    //    (а без него не работают уведомления). Пропущенный файл потом возьмёт из сети fetch (ниже);
    //  • обновление — если не скачался основной файл (HTML/JS/CSS/manifest), установка падает:
    //    тогда остаётся старая рабочая версия со всеми файлами, а новую браузер попробует позже.
    //    Иначе activate удалил бы старый кэш, и без интернета приложение не открылось бы.
    //    Пропускать можно только иконки и картинки.
    await Promise.all(APP_FILES.map(async (url) => {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          // cache: 'reload' — мимо HTTP-кэша браузера: иначе можно получить старый index.html
          // вместе с новыми скриптами, и приложение сломается на смеси версий
          const response = await fetch(new Request(url, { cache: 'reload' }));
          if (response.ok) {
            await cache.put(url, response);
            return;
          }
        } catch (e) {
          // нет сети — пробуем ещё раз
        }
      }
      console.warn('Не удалось сохранить в кэш:', url);
      missing.push(url);
    }));
    const essentialMissing = missing.filter((url) => !/\.(png|jpe?g|svg|webp|ico)$/.test(url));
    if (isUpdate && essentialMissing.length) {
      throw new Error(`Обновление не установлено, не скачались: ${essentialMissing.join(', ')}`);
    }
    await self.skipWaiting();   // новая версия начинает работать сразу, не дожидаясь закрытия вкладок
  })());
});

// 2. АКТИВАЦИЯ: удаляем кэши старых версий, чтобы не копить мусор.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((name) => name !== CACHE_NAME && name !== PUSH_STATE_CACHE).map((name) => caches.delete(name))
      ))
      .then(() => self.clients.claim())  // берём под контроль уже открытые страницы
  );
});

// PUSH-УВЕДОМЛЕНИЯ: сервер прислал сообщение (например, об изменении расписания).
//    Срабатывает, даже когда приложение закрыто. На iPhone уведомление обязано быть показано:
//    если хоть раз его не показать, iOS может отключить уведомления этому приложению.
self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    // Разбираем данные ВНУТРИ waitUntil и так, чтобы любая ошибка не помешала показать уведомление
    let data = {};
    try {
      data = event.data ? event.data.json() : {};
    } catch (e) {
      try { data = { body: event.data ? event.data.text() : '' }; } catch (e2) { data = {}; }
    }
    // JSON может оказаться не объектом: строка — это просто текст уведомления,
    // а null, число и т.п. — пустые данные (иначе data.title упал бы с ошибкой)
    if (typeof data === 'string') data = { body: data };
    if (!data || typeof data !== 'object') data = {};
    const title = String(data.title || 'МАУ Расписание');
    const body = String(data.body || '');
    try {
      await self.registration.showNotification(title, {
        body,
        tag: data.tag ? String(data.tag) : undefined,   // одинаковый tag — новое уведомление заменяет старое
        renotify: Boolean(data.tag),                    // …но всё равно звучит и вибрирует, а не заменяет молча
        icon: 'icons/icon-192.png',
        badge: 'icons/badge-96.png',                    // Android: одноцветный значок в строке состояния
        vibrate: [120, 80, 120],                        // Android: короткая двойная вибрация
        data: { url: typeof data.url === 'string' ? data.url : './' },
      });
    } catch (e) {
      // Какой-то браузер не принял параметры — показываем хотя бы самое простое уведомление
      await self.registration.showNotification(title, { body, data: { url: './' } });
    }
  })());
});

// Какой экран открыть по адресу из уведомления: './#schedule' → 'schedule'
const viewFromUrl = (url) => new URL(url).hash.slice(1);

// Нажали на уведомление — открываем приложение (или переключаемся на уже открытое)
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const scope = self.registration.scope;
  let url = scope;
  try { url = new URL(event.notification.data?.url || './', scope).href; } catch (e) { /* кривой адрес — откроем главную */ }
  if (!url.startsWith(scope)) url = scope;          // чужие адреса не открываем
  event.waitUntil((async () => {
    // Только окна НАШЕГО приложения (в браузере могут быть открыты и другие страницы сайта)
    const windows = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
      .filter((w) => w.url.startsWith(scope));
    const w = windows.find((x) => x.focused) || windows[0];
    if (w) {
      // Сообщаем открытому окну, какой экран показать. Через адрес (#schedule) это не всегда
      // работает: если там уже #schedule, браузер не считает это переходом и ничего не делает.
      try { w.postMessage({ open: viewFromUrl(url) }); } catch (e) { /* окно не принимает сообщения */ }
      // Если окно открыто на другой странице сайта (например, check.html) — переходим на нужную
      let target = w;
      if (new URL(w.url).pathname !== new URL(url).pathname && 'navigate' in w) {
        // navigate возвращает окно после перехода (или null, если оно ушло на чужой сайт)
        try { target = (await w.navigate(url)) || w; } catch (e) { /* navigate не удался — просто покажем окно */ }
      }
      try {
        return await target.focus();
      } catch (e) {
        // фокус не дали — откроем новое окно ниже
      }
    }
    return self.clients.openWindow(url);
  })());
});

// Ключ сервера (base64url) → байты: так его ждёт pushManager.subscribe (то же, что в notify.js)
function keyBytes(base64url) {
  const b64 = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

// Браузер сам сменил подписку (старая устарела или её отозвал сервис доставки).
// Сервер про новую подписку не знает, поэтому: переподписываемся тем же ключом и ставим
// отметку «нужен новый код» — приложение покажет предупреждение (notify.js, renderPush).
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    let endpoint = event.newSubscription?.endpoint || null;
    try {
      if (!event.newSubscription) {
        // Ключ берём у старой подписки; если его нет — тот, которым подписывалось приложение
        // (notify.js сохраняет его в push-state: со своим сервером ключ берётся у сервера, а не из файла);
        // в крайнем случае — из опубликованного файла data/push.json
        let key = event.oldSubscription?.options?.applicationServerKey;
        if (!key) {
          const saved = await (await caches.open(PUSH_STATE_CACHE)).match(PUSH_KEY_URL);
          const publicKey = saved ? (await saved.json()).publicKey : '';
          if (publicKey) key = keyBytes(publicKey);
        }
        if (!key) {
          const response = await fetch('data/push.json', { cache: 'no-cache' });
          key = keyBytes((await response.json()).publicKey);
        }
        const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
        endpoint = sub.endpoint;
      }
    } catch (e) {
      // Не вышло (нет сети, нет разрешения) — приложение предложит включить уведомления заново
    }
    const cache = await caches.open(PUSH_STATE_CACHE);
    await cache.put(PUSH_STATE_URL, new Response(JSON.stringify({ changedAt: Date.now(), endpoint }),
      { headers: { 'Content-Type': 'application/json' } }));
  })());
});

// 3. ЗАПРОСЫ: "сначала кэш этой версии".
//    Файлы приложения отдаём из кэша — быстро и без интернета. Обновляются они только все
//    вместе: новая версия приложения = новое имя кэша (CACHE_NAME), и при установке нового
//    service worker все файлы скачиваются заново. Раньше файлы обновлялись по одному, и телефон
//    мог получить новый app.js со старым index.html — приложение ломалось на смеси версий.
self.addEventListener('fetch', (event) => {
  const request = event.request;

  const url = new URL(request.url);

  // Трогаем только GET-запросы к нашему же сайту — всё остальное пропускаем как есть.
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Расписание (data/... от компьютера и /api/... от сервера) не кэшируем здесь: приложению нужны
  // свежие данные, а на случай без интернета оно само хранит последнее скачанное расписание (data.js).
  if (url.pathname.includes('/data/') || url.pathname.includes('/api/')) return;

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      // ignoreSearch: "index.html?x=1" найдёт закэшированный "index.html"
      const cached = await cache.match(request, { ignoreSearch: true });
      if (cached) return cached;

      // В кэше нет (файл не из списка APP_FILES) — берём из сети и запоминаем.
      // Если и сети нет, а это открытие страницы, отдаём главную.
      // Файл приложения (из APP_FILES), который не скачался при установке, берём мимо HTTP-кэша
      // (cache: 'reload'), чтобы не получить старую версию вперемешку с новыми файлами.
      const isAppFile = APP_FILES.some((f) => new URL(f, self.registration.scope).href === url.origin + url.pathname);
      const response = await (isAppFile ? fetch(url.href, { cache: 'reload' }) : fetch(request)).catch(() => null);
      if (response?.ok) {
        cache.put(request, response.clone());
        return response;
      }
      if (response) return response;
      if (request.mode === 'navigate') return cache.match('./index.html');
      return Response.error();
    })
  );
});
