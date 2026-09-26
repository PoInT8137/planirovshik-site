// =====================================================================
//  Service worker — "посредник" между приложением и сетью.
//  Он сохраняет файлы приложения в кэш, чтобы оно открывалось без интернета.
//  Все расчёты локальные, так что офлайн приложение работает полностью.
// =====================================================================

// Имя кэша с версией. УВЕЛИЧИВАЙ НОМЕР ПРИ КАЖДОМ ИЗМЕНЕНИИ файлов приложения:
// только тогда телефоны скачают новую версию (все файлы сразу), а старый кэш удалится.
const CACHE_NAME = 'road-to-uni-v17';

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
  './notify.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

// 1. УСТАНОВКА: скачиваем и сохраняем все файлы приложения.
self.addEventListener('install', (event) => {
  // waitUntil — "не считай установку завершённой, пока не выполнится это обещание"
  event.waitUntil(
    caches.open(CACHE_NAME)
      // cache: 'reload' — мимо HTTP-кэша браузера: иначе можно получить старый index.html
      // вместе с новыми скриптами, и приложение сломается на смеси версий
      .then((cache) => cache.addAll(APP_FILES.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())   // новая версия начинает работать сразу, не дожидаясь закрытия вкладок
  );
});

// 2. АКТИВАЦИЯ: удаляем кэши старых версий, чтобы не копить мусор.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
      ))
      .then(() => self.clients.claim())  // берём под контроль уже открытые страницы
  );
});

// PUSH-УВЕДОМЛЕНИЯ: сервер прислал сообщение (например, об изменении расписания).
//    Срабатывает, даже когда приложение закрыто. На iPhone уведомление обязано быть показано.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(self.registration.showNotification(data.title || 'Планер', {
    body: data.body || '',
    tag: data.tag,                                  // одинаковый tag — новое уведомление заменяет старое
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    data: { url: data.url || './' },
  }));
});

// Нажали на уведомление — открываем приложение (или переключаемся на уже открытое)
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || './', self.registration.scope).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of windows) {
      if ('focus' in w) {
        if ('navigate' in w) await w.navigate(url);
        return w.focus();
      }
    }
    return self.clients.openWindow(url);
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
      const response = await fetch(request).catch(() => null);
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
