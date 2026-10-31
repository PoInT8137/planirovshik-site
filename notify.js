// =====================================================================
//  Push-уведомления об изменениях расписания: включить, выключить, проверить.
//  Сервер (push/push.js) сам присылает уведомление, когда находит изменение
//  у группы, — даже если приложение закрыто. Подключается после app.js.
//
//  На iPhone push работает только в приложении, добавленном на экран «Домой»
//  (iOS 16.4 и новее), и разрешение можно запросить только по нажатию кнопки.
//
//  Без хостинга уведомления рассылает сервер на компьютере. Телефон не может сам
//  передать ему подписку, поэтому показывает код: его один раз переносят на компьютер
//  и выполняют  npm run cli -- push-add <код>  (в папке server).
// =====================================================================

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

// Можно ли здесь включить уведомления? Если нет — объяснение почему.
function pushBlocker() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || typeof Notification === 'undefined') {
    return isIOS && !isStandalone()
      ? 'На iPhone уведомления работают только в приложении с экрана «Домой» (iOS 16.4 и новее). Открой его с иконки.'
      : 'Этот браузер не умеет получать push-уведомления.';
  }
  if (Notification.permission === 'denied') {
    return isIOS
      ? 'Уведомления запрещены. Разреши их: Настройки iPhone → Уведомления → «МАУ Расписание».'
      : 'Уведомления запрещены в настройках браузера для этого сайта.';
  }
  return '';
}

// Сколько ждать service worker (sw.js). Если он не установился (например, при первом открытии
// пропал интернет), navigator.serviceWorker.ready не выполнится НИКОГДА — и кнопка зависла бы.
const SW_WAIT_MS = 8000;
const SW_NOT_READY = 'Приложение ещё не готово — открой его заново, когда будет интернет';

// Готовый service worker, но ждём не дольше SW_WAIT_MS
function swReady() {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(SW_NOT_READY)), SW_WAIT_MS);
  });
  return Promise.race([navigator.serviceWorker.ready, timeout]).finally(() => clearTimeout(timer));
}

async function currentSubscription() {
  if (pushBlocker()) return null;
  const reg = await swReady();
  return reg.pushManager.getSubscription();
}

// Ключ сервера (base64url) → байты: так его ждёт pushManager.subscribe
function keyBytes(base64url) {
  const b64 = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

// Байты → base64url (обратно) — чтобы сравнить ключ подписки с ключом сервера
function toBase64url(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Одинаковые ли ключи: '=' в конце base64 — лишь «добивка», её не учитываем
const sameKey = (a, b) => String(a).replace(/=+$/, '') === String(b).replace(/=+$/, '');

async function pushApi(path, body) {
  const response = await fetch(`${API_BASE}/api/push/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `ошибка ${response.status}`);
  return data;
}

// kind: 'ok' — зелёный текст, 'error' — красный, 'warn' — заметное оранжевое предупреждение
function setPushStatus(text, kind = '') {
  $('push-status').textContent = text;
  $('push-status').className = `group-footer${kind ? ` is-${kind}` : ''}`;
}

// Публичный ключ для подписки: у сервера — /api/push/key, без сервера — файл, который опубликовал компьютер
async function pushPublicKey() {
  if (API_BASE) return (await pushApi('key')).publicKey;
  const response = await fetch('data/push.json', { cache: 'no-cache' });
  if (!response.ok || !(response.headers.get('content-type') || '').includes('json')) {
    throw new Error('сервер ещё не опубликовал ключ уведомлений');
  }
  return (await response.json()).publicKey;
}

// Ключ загружаем заранее — при открытии экрана, а не по нажатию кнопки: после нажатия
// первым делом нужно спросить разрешение (иначе iPhone окно разрешения не покажет).
let pushKey = '';                                   // последний загруженный ключ ('' — ещё не знаем)
function preloadPushKey() {
  return pushPublicKey().then((key) => { pushKey = key || ''; return pushKey; }).catch(() => pushKey);
}

// Отметка от sw.js «браузер сменил подписку — нужен новый код» (кэш 'push-state', см. pushsubscriptionchange)
async function pushChangedFlag() {
  try {
    if (!('caches' in window)) return null;
    const response = await (await caches.open('push-state')).match('push-state.json');
    return response ? await response.json() : null;
  } catch (e) {
    return null;
  }
}
// Запомнить ключ, которым подписались: sw.js переподпишется им же, если браузер сменит подписку
async function savePushKey(publicKey) {
  try {
    if ('caches' in window) {
      await (await caches.open('push-state')).put('push-key.json', new Response(JSON.stringify({ publicKey }),
        { headers: { 'Content-Type': 'application/json' } }));
    }
  } catch (e) {
    // не сохранилось — sw.js возьмёт ключ из data/push.json
  }
}
async function clearPushChangedFlag() {
  try {
    if ('caches' in window) await (await caches.open('push-state')).delete('push-state.json');
  } catch (e) {
    // не страшно: в худшем случае предупреждение покажется ещё раз
  }
}

// Подгруппа для кода подписки:
//   'N' — выбрана подгруппа N;  '' — все пары группы;  null — пока неизвестно (расписание группы
//   ещё не загружено, и нельзя понять, есть ли у неё подгруппы). Тогда код давать нельзя:
//   он ушёл бы без подгруппы, и приходили бы уведомления о чужих парах.
function pushSubgroup() {
  const key = settings.group?.key;
  if (!key) return null;
  if (data.schedules?.[key]) return mySubgroup(settings);   // расписание есть — проверенная подгруппа
  const saved = settings.subgroups?.[key] || '';
  if (saved) return saved;                                   // расписания нет, но подгруппу выбирали раньше
  return settings.source === 'group' ? null : '';            // ручное расписание — подгрупп не бывает
}

// Что сохранить на сервере: подписка, группа и подгруппа (уведомления только о своих парах)
const subscriptionBody = (sub) => ({ subscription: sub.toJSON(), group: settings.group.key, subgroup: pushSubgroup() || '' });

// Код для переноса подписки на компьютер: base64url от { subscription, group, sub }.
// Без группы кода нет ('') — серверу не по чему присылать уведомления.
function subscriptionCode(sub) {
  if (!settings.group?.key) return '';
  const json = JSON.stringify({ subscription: sub.toJSON(), group: settings.group.key, sub: pushSubgroup() || undefined });
  return btoa(unescape(encodeURIComponent(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Для какой подписки, группы и подгруппы код уже отправлен (отмечается по «Скопировать код»).
// Пока не совпадает с текущими — показываем предупреждение, что нужен новый код.
const codeSentFor = (sub) => ({ endpoint: sub.endpoint, group: settings.group?.key || '', sub: pushSubgroup() || '' });
function codeIsSent(sub) {
  const sent = settings.pushSent;
  const now = codeSentFor(sub);
  return Boolean(sent && sent.endpoint === now.endpoint && sent.group === now.group && (sent.sub || '') === now.sub);
}

// Открыто в Android-приложении «МАУ Расписание» (APK): уведомления присылает само приложение,
// а не браузер. Объект PlanerApp даёт приложение (android/src/ru/planer/mau/MainActivity.java, класс Bridge).
const APP = window.PlanerApp || null;

// Установлено ли на этом телефоне Android-приложение (APK). Узнать можно только в Chrome
// на Android (navigator.getInstalledRelatedApps) и только если приложение указано в manifest.json
// (related_applications). Если APK установлен, а включены ещё и веб-уведомления — придут двойные.
const APK_ID = 'ru.planer.mau';
let apkInstalled = false;
const apkCheck = (!APP && 'getInstalledRelatedApps' in navigator)
  ? navigator.getInstalledRelatedApps()
    .then((apps) => { apkInstalled = apps.some((a) => a.id === APK_ID); })
    .catch(() => {})
  : Promise.resolve();

// Блок уведомлений в APK: включены ли, кнопки «Включить», «Пробное» и «Работа в фоне»
function renderAppPush() {
  const on = APP.notificationsState() === 'on';
  $('push-toggle').disabled = false;
  $('push-toggle').textContent = on ? 'Уведомления включены ✓' : 'Включить уведомления';
  $('push-test-row').hidden = !on;
  $('push-app-row').hidden = false;
  if ($('push-code-row')) $('push-code-row').hidden = $('push-copy-row').hidden = true;
  if ($('push-apk-note')) $('push-apk-note').hidden = true;   // подпись «есть приложение» — только для сайта
  const last = Number(APP.lastCheck());
  const lastText = last ? `Последняя проверка: ${formatUpdated(last)}.` : 'Первая проверка — в ближайшие минуты.';
  if (on) {
    setPushStatus(`Включены: приложение само проверяет расписание ${settings.group?.name || 'группы'} каждые 30 минут ` +
      `и сообщит, если пары перенесут или отменят. ${lastText}\n` +
      'Если уведомления не приходят (бывает на Xiaomi, Huawei, Honor), нажми «Работа в фоне» и разреши ' +
      '«Автозапуск», а в «Контроле активности» выбери «Нет ограничений».', 'ok');
  } else {
    setPushStatus('Уведомления выключены. Нажми «Включить уведомления» и разреши их — ' +
      'если окно не появится, откроются настройки: включи там «Показывать уведомления».', 'error');
  }
}

// Состояние, которое запомнил renderPush. Обработчик нажатия берёт его отсюда сразу,
// без await: так разрешение на уведомления спрашивается самым первым действием.
//   mode: 'off' — не подписаны, 'on' — подписаны, 'stale' — подписка со старым ключом (нужно обновить),
//         'unknown' — ещё не проверили / service worker не готов
let pushView = { mode: 'unknown', sub: null };
// Идёт включение/выключение (togglePush) — renderPush в это время не трогает кнопку и pushView
let pushBusy = false;

// Service worker «в пути» (ещё устанавливается) или так и не установился?
async function swInstalling() {
  const reg = await navigator.serviceWorker.getRegistration().catch(() => null);
  return Boolean(reg && (reg.installing || reg.waiting || reg.active));
}

// Показать, включены ли уведомления, и подписать кнопки.
// reason — что случилось (например, «Группа изменилась»): добавляется к просьбе отправить новый код.
async function renderPush(reason = '') {
  if (APP) return renderAppPush();
  if ($('push-apk-note')) $('push-apk-note').hidden = false;
  const blocker = pushBlocker();
  let sub = null;
  let notReady = false;
  let preparing = false;                            // service worker ещё устанавливается (обычно при первом открытии)
  if (!blocker) {
    // Пока ждём service worker — спокойное «Подготавливаю…», а не ошибка
    if (pushView.mode === 'unknown' && !navigator.serviceWorker.controller) setPushStatus('Подготавливаю уведомления…');
    try {
      sub = await currentSubscription();
    } catch (e) {
      notReady = true;                              // service worker за 8 секунд не стал готов
      preparing = await swInstalling();             // …но ещё ставится — это не ошибка, просто подождём
      // Если он всё-таки установится позже — сразу обновим блок (один раз, без повторных подписок)
      if (!renderPush.waitingSw) {
        renderPush.waitingSw = true;
        navigator.serviceWorker.ready.then(() => { renderPush.waitingSw = false; renderPush(); });
      }
    }
  }
  // Ключ сервера и отметку sw.js проверяем вместе (ключ скачивается заранее — см. preloadPushKey)
  const [publishedKey, changed] = sub ? await Promise.all([preloadPushKey(), pushChangedFlag()]) : [pushKey, null];
  await apkCheck;

  // Подписка устарела: её ключ не совпадает с опубликованным (на сервере сменили ключи) —
  // нужно переподписаться. Если же браузер сам заменил подписку (sw.js, pushsubscriptionchange),
  // подписка уже новая, но сервер о ней не знает — нужен новый код.
  const subKey = sub?.options?.applicationServerKey;
  const keyMismatch = Boolean(sub && subKey && publishedKey && !sameKey(toBase64url(subKey), publishedKey));
  let resubscribed = false;
  if (sub && changed && API_BASE && !keyMismatch) {
    // Со своим сервером новую подписку отправляем сами — пользователю ничего делать не надо
    resubscribed = await pushApi('subscribe', subscriptionBody(sub)).then(clearPushChangedFlag).then(() => true, () => false);
  }

  if (!pushBusy) pushView = { mode: notReady ? 'unknown' : keyMismatch ? 'stale' : sub ? 'on' : 'off', sub };

  // Подписались ещё до появления отметки «код отправлен» (pushSent) — значит, код уже отправляли.
  // Один раз тихо отмечаем это, чтобы не пугать старых подписчиков оранжевым «отправь код».
  // Тем, кто подпишется позже, отметка не ставится: у них при первом запуске подписки ещё нет.
  if (!settings.pushMigrated && !pushBusy && !notReady && (!sub || pushSubgroup() !== null)) {
    if (sub && !settings.pushSent && !keyMismatch) settings.pushSent = codeSentFor(sub);
    settings.pushMigrated = true;
    saveSettings(settings);
  }

  const subgroup = sub ? pushSubgroup() : '';
  const showCode = Boolean(sub && !API_BASE && !keyMismatch && settings.group && subgroup !== null);
  if (!pushBusy) $('push-toggle').disabled = Boolean(blocker);   // при «не готово» кнопку не блокируем: нажатие — повторная попытка
  $('push-toggle').textContent = keyMismatch ? 'Подписка устарела — обновить'
    : sub ? 'Выключить уведомления' : 'Включить уведомления об изменениях';
  // Пробное уведомление в браузере не показываем: без сервера его отправляют с компьютера
  // (npm run cli -- push-test <заметка>), а сервер принимает /api/push/test только с токеном администратора
  $('push-test-row').hidden = true;
  if ($('push-code-row')) {                       // в старой закэшированной разметке этих строк может не быть
    $('push-code-row').hidden = $('push-copy-row').hidden = !showCode;
    if (showCode) $('push-code').value = subscriptionCode(sub);
  }

  // Предупреждение о двойных уведомлениях — только если веб-уведомления включены
  const apkWarning = apkInstalled && sub
    ? '\nУ тебя установлено приложение «МАУ Расписание» — уведомления придут из него, веб-уведомления лучше выключить (иначе будут приходить дважды).'
    : '';
  const groupName = settings.group?.name || 'группы';

  if (blocker) setPushStatus(blocker);
  else if (notReady && preparing) setPushStatus('Подготавливаю уведомления… При первом открытии это может занять до минуты.');
  else if (notReady) setPushStatus(`${SW_NOT_READY}.`, 'error');
  else if (keyMismatch) {
    setPushStatus('Подписка устарела — нажми кнопку выше, чтобы обновить её, и отправь автору приложения новый код. ' +
      'Пока не обновишь, уведомления не придут.' + apkWarning, 'warn');
  } else if (sub && !settings.group) {
    setPushStatus('Выбери свою группу выше — без неё сервер не знает, о каких парах сообщать.', 'warn');
  } else if (sub && changed && API_BASE && !resubscribed) {
    setPushStatus('Подписка устарела, а сервер сейчас недоступен. Открой приложение позже, когда будет интернет, — ' +
      'подписка обновится сама.' + apkWarning, 'warn');
  } else if (sub && !API_BASE && subgroup === null) {
    // Код покажем, когда станет ясно, есть ли у группы подгруппы (app.js вызовет renderPush после загрузки)
    setPushStatus(sync.error
      ? `Не удалось загрузить расписание ${groupName}, поэтому код пока не готов: нужен номер подгруппы. Проверь интернет.`
      : `Загружаю расписание ${groupName}, чтобы узнать подгруппу, — код появится через несколько секунд.`, 'warn');
  } else if (showCode && changed) {
    setPushStatus('Подписка устарела — браузер обновил её сам. Скопируй новый код и отправь его автору приложения, ' +
      'иначе уведомления перестанут приходить.' + apkWarning, 'warn');
  } else if (showCode && !codeIsSent(sub)) {
    const what = reason ? `${reason} — нужен новый код. ` : '';
    const subHint = subgroupsOf(data, settings.group.key).length && !subgroup
      ? '\nПодгруппа не выбрана — будут приходить уведомления обо всех парах группы.' : '';
    setPushStatus(`${what}Остался один шаг: скопируй код и отправь его автору приложения — он подключит уведомления ` +
      'на сервере. Код нужен один раз (и снова — если сменишь группу или подгруппу). ' +
      'Уже отправлял этот код? Просто нажми «Скопировать код» — предупреждение исчезнет.' + subHint + apkWarning, 'warn');
  } else if (showCode) {
    setPushStatus(`Код для ${groupName}${subgroup ? ` (${subgroup}-я подгруппа)` : ''} отправлен автору. Когда он подключит его, ` +
      'придут уведомления об изменениях. Сменишь группу или подгруппу — понадобится новый код.' + apkWarning, 'ok');
  } else if (sub) setPushStatus(`Включены: если у ${groupName} поменяется время, аудитория или пара отменится — придёт уведомление.` + apkWarning, 'ok');
  else setPushStatus((API_BASE
    ? 'Сервер проверяет сайт МАУ днём каждые 30 минут и ночью — и сразу сообщит, если что-то изменилось.'
    : 'Сервер проверяет сайт МАУ днём каждые 30 минут и ночью — и сообщит, если у твоих пар что-то изменится.') + apkWarning);
}

// Спросить разрешение. Вызывать СИНХРОННО в начале обработчика нажатия (до любого await):
// iPhone показывает окно разрешения только сразу после нажатия. Старый Safari вместо
// обещания (Promise) вызывает функцию-callback — поддерживаем оба варианта.
function askPermission() {
  return new Promise((resolve) => {
    const result = Notification.requestPermission(resolve);
    if (result && typeof result.then === 'function') result.then(resolve, () => resolve('default'));
  });
}

// Подписаться: разрешение → подписка у сервиса доставки → сохранить на сервере.
// permissionAsked — обещание от askPermission(), если разрешение спросили в обработчике нажатия.
async function enablePush(permissionAsked) {
  const permission = permissionAsked ? await permissionAsked : Notification.permission;
  if (permission !== 'granted') {
    setPushStatus('Без разрешения уведомления не придут.', 'error');
    return false;
  }
  const reg = await swReady();
  const publicKey = pushKey || await preloadPushKey();
  if (!publicKey) throw new Error('сервер ещё не опубликовал ключ уведомлений — попробуй позже');
  let sub = await reg.pushManager.getSubscription();
  // Подписка со старым ключом сервера не подойдёт (ключи поменяли) — делаем новую
  const oldKey = sub?.options?.applicationServerKey;
  if (sub && oldKey && !sameKey(toBase64url(oldKey), publicKey)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  await clearPushChangedFlag();                    // подписка свежая — старое предупреждение sw.js больше не нужно
  await savePushKey(publicKey);
  // С сервером — отправляем подписку ему; без сервера renderPush покажет код для компьютера
  if (API_BASE) await pushApi('subscribe', subscriptionBody(sub));
  return true;
}

async function disablePush(sub) {
  if (!sub) return;
  // Сервер отписывает только с ключом этой подписки (endpoint + keys.auth) — передаём её целиком.
  // Сервер недоступен — всё равно отписываемся.
  if (API_BASE) await pushApi('unsubscribe', { subscription: sub.toJSON() }).catch(() => {});
  await sub.unsubscribe();                         // без сервера компьютер сам удалит подписку, когда Apple ответит «такой больше нет»
  await clearPushChangedFlag();
}

// Сменили группу или подгруппу в настройках — уведомления должны приходить уже по ним
async function pushGroupChanged(what = 'Группа изменилась') {
  const sub = await currentSubscription().catch(() => null);
  if (sub && settings.group && API_BASE) await pushApi('subscribe', subscriptionBody(sub)).catch(() => {});
  // Без сервера renderPush увидит, что код отправлен для другой группы, и попросит новый
  await renderPush(what);
}

// Код скопирован (или выделен для ручного копирования) — запоминаем, для чего он отправлен
function markCodeSent() {
  const sub = pushView.sub;
  if (!sub) return;
  settings.pushSent = codeSentFor(sub);
  saveSettings(settings);
  clearPushChangedFlag().then(() => renderPush());
}

// Скопировать код подписки
$('push-copy')?.addEventListener('click', async () => {
  const box = $('push-code');
  if (!box.value) return;
  try {
    await navigator.clipboard.writeText(box.value);
    $('push-copy').textContent = 'Скопировано ✓';
  } catch (e) {
    // Буфер обмена недоступен — выделяем код, чтобы скопировать вручную.
    // На iPhone select() не выделяет текст в поле «только для чтения» (readonly),
    // поэтому на время снимаем readonly и выделяем через setSelectionRange.
    box.readOnly = false;
    box.focus();
    box.select();
    box.setSelectionRange(0, box.value.length);
    let copied = false;
    try { copied = document.execCommand('copy'); } catch (e2) { /* старый способ тоже не сработал */ }
    box.readOnly = true;                           // выделение при этом остаётся
    if (!copied) {
      // Не скопировалось — код не считаем отправленным, предупреждение остаётся
      $('push-copy').textContent = 'Код выделен — скопируй его вручную';
      setTimeout(() => { $('push-copy').textContent = 'Скопировать код'; }, 2500);
      return;
    }
    $('push-copy').textContent = 'Скопировано ✓';
  }
  markCodeSent();
  setTimeout(() => { $('push-copy').textContent = 'Скопировать код'; }, 2500);
});

$('push-toggle').addEventListener('click', () => {
  // В APK: разрешение или настройки уведомлений телефона (там же их можно выключить)
  if (APP) {
    APP.enableNotifications();
    return;
  }
  // Без группы включать нечего: сервер не будет знать, о каких парах сообщать
  if (!settings.group && pushView.mode !== 'on') {
    setPushStatus('Сначала выбери свою группу выше — уведомления приходят об изменениях в её расписании.', 'error');
    return;
  }
  // САМОЕ ПЕРВОЕ действие — запрос разрешения, до любого await (иначе iPhone откажет молча).
  // Разрешение «ещё не спрашивали» (default) бывает, только если подписки нет.
  const permissionAsked = !pushBlocker() && pushView.mode !== 'on' && Notification.permission === 'default'
    ? askPermission() : null;
  togglePush(permissionAsked);
});

async function togglePush(permissionAsked) {
  const button = $('push-toggle');
  button.disabled = true;
  pushBusy = true;
  let ok = true;
  try {
    if (pushView.mode === 'on') {
      await disablePush(pushView.sub);
      setPushStatus('Уведомления выключены.');
    } else {
      // Подписываемся сейчас — код точно ещё не отправлен, «миграция» старых подписчиков не нужна.
      // Ставим отметку до любого await, чтобы параллельный renderPush не принял новую подписку за старую.
      if (!settings.pushMigrated) {
        settings.pushMigrated = true;
        saveSettings(settings);
      }
      ok = await enablePush(permissionAsked);       // 'off', 'stale' (обновить подписку) и 'unknown' (повторная попытка)
    }
  } catch (e) {
    setPushStatus(`Не получилось: ${e.message}.`, 'error');
    ok = false;
  } finally {
    pushBusy = false;
    button.disabled = Boolean(pushBlocker());      // кнопку не оставляем выключенной — можно попробовать снова
  }
  if (ok) await renderPush();                      // при ошибке оставляем её текст на экране
}

// В APK: открыть страницу приложения в настройках телефона (автозапуск, работа в фоне)
$('push-app')?.addEventListener('click', () => APP?.openAppSettings());

// Вернулись в приложение (например, из настроек телефона) — обновить состояние
document.addEventListener('visibilitychange', () => { if (APP && !document.hidden) renderPush(); });

// Открыли «Настройки» — заранее обновляем ключ и состояние подписки (чтобы нажатие сработало сразу)
document.querySelector('[data-view="view-settings"]')?.addEventListener('click', () => { if (!APP) renderPush(); });

$('push-test').addEventListener('click', async () => {
  if (APP) {
    APP.testNotification();
    setPushStatus('Пробное уведомление отправлено — посмотри в шторке уведомлений.', 'ok');
    return;
  }
  try {
    const sub = await currentSubscription();
    await pushApi('test', { endpoint: sub.endpoint });
    setPushStatus('Пробное уведомление отправлено — оно появится через несколько секунд.', 'ok');
  } catch (e) {
    setPushStatus(`Не получилось: ${e.message}.`, 'error');
  }
});

if (!APP && !pushBlocker()) preloadPushKey();
renderPush();

// Нажали на уведомление — приложение открывается на вкладке «Расписание» (адрес ...#schedule).
// Этот файл подключается последним, поэтому здесь уже есть всё, что нужно вкладке.
// Так же открываются ярлыки иконки на Android (долгое нажатие): ./#schedule, ./#settings
function openFromHash() {
  const view = { '#home': 'view-home', '#schedule': 'view-schedule', '#road': 'view-today', '#settings': 'view-settings', '#server': 'view-settings' }[location.hash];
  if (location.hash === '#server') renderServerControls();       // показать спрятанный блок «Сервер»
  if (view) document.querySelector(`[data-view="${view}"]`).click();
}
openFromHash();
window.addEventListener('hashchange', openFromHash);

// Повторное нажатие на уведомление: адрес уже ...#schedule, и hashchange не срабатывает.
// Поэтому sw.js ещё и присылает сообщение { open: 'schedule' } — открываем вкладку по нему.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    const open = event.data?.open;
    if (typeof open !== 'string') return;
    const view = { home: 'view-home', schedule: 'view-schedule', road: 'view-today', settings: 'view-settings' }[open];
    if (view) document.querySelector(`[data-view="${view}"]`)?.click();
  });
}
