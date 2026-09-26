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
      ? 'Уведомления запрещены. Разреши их: Настройки iPhone → Уведомления → «Планер».'
      : 'Уведомления запрещены в настройках браузера для этого сайта.';
  }
  return '';
}

async function currentSubscription() {
  if (pushBlocker()) return null;
  const reg = await navigator.serviceWorker.ready;
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

function setPushStatus(text, kind = '') {
  $('push-status').textContent = text;
  $('push-status').className = `group-footer${kind ? ` is-${kind}` : ''}`;
}

// Публичный ключ для подписки: у сервера — /api/push/key, без сервера — файл, который опубликовал компьютер
async function pushPublicKey() {
  if (API_BASE) return (await pushApi('key')).publicKey;
  const response = await fetch('data/push.json', { cache: 'no-cache' });
  if (!response.ok || !(response.headers.get('content-type') || '').includes('json')) {
    throw new Error('компьютер ещё не опубликовал ключ уведомлений');
  }
  return (await response.json()).publicKey;
}

// Что сохранить на сервере: подписка, группа и подгруппа (уведомления только о своих парах)
const subscriptionBody = (sub) => ({ subscription: sub.toJSON(), group: settings.group.key, subgroup: mySubgroup(settings) });

// Код для переноса подписки на компьютер: base64url от { subscription, group, sub }
function subscriptionCode(sub) {
  const json = JSON.stringify({ subscription: sub.toJSON(), group: settings.group.key, sub: mySubgroup(settings) || undefined });
  return btoa(unescape(encodeURIComponent(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Показать, включены ли уведомления, и подписать кнопки
async function renderPush() {
  const blocker = pushBlocker();
  const sub = blocker ? null : await currentSubscription().catch(() => null);
  const showCode = Boolean(sub && !API_BASE);
  $('push-toggle').disabled = Boolean(blocker);
  $('push-toggle').textContent = sub ? 'Выключить уведомления' : 'Включить уведомления об изменениях';
  $('push-test-row').hidden = !sub || !API_BASE;           // пробное без сервера отправляют с компьютера
  if ($('push-code-row')) {                       // в старой закэшированной разметке этих строк может не быть
    $('push-code-row').hidden = $('push-copy-row').hidden = !showCode;
    if (showCode) $('push-code').value = subscriptionCode(sub);
  }

  if (blocker) setPushStatus(blocker);
  else if (showCode) {
    setPushStatus('Осталось один раз передать подписку компьютеру: скопируй код, отправь его себе на компьютер ' +
      '(например, в «Избранное» Telegram) и выполни в папке server:\nnpm run cli -- push-add <код>\n' +
      'Проверить: npm run cli -- push-test. Уведомления приходят, пока компьютер включён.', 'ok');
  } else if (sub) setPushStatus(`Включены: если у ${settings.group?.name || 'группы'} поменяется время, аудитория или пара отменится — придёт уведомление.`, 'ok');
  else setPushStatus(API_BASE
    ? 'Сервер проверяет сайт МАУ днём каждые 30 минут и ночью — и сразу сообщит, если что-то изменилось.'
    : 'Уведомления рассылает компьютер, пока он включён: проверяет сайт МАУ каждые 30 минут и сообщает об изменениях.');
}

// Подписаться: разрешение → подписка у сервиса доставки → сохранить на сервере
async function enablePush() {
  // Разрешение спрашиваем первым делом: iOS разрешает это только сразу после нажатия
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    setPushStatus('Без разрешения уведомления не придут.', 'error');
    return;
  }
  const reg = await navigator.serviceWorker.ready;
  const publicKey = await pushPublicKey();
  let sub = await reg.pushManager.getSubscription();
  // Подписка со старым ключом сервера не подойдёт (ключи поменяли) — делаем новую
  const oldKey = sub?.options?.applicationServerKey;
  if (sub && oldKey && toBase64url(oldKey) !== publicKey) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  // С сервером — отправляем подписку ему; без сервера renderPush покажет код для компьютера
  if (API_BASE) await pushApi('subscribe', subscriptionBody(sub));
}

async function disablePush() {
  const sub = await currentSubscription();
  if (!sub) return;
  if (API_BASE) await pushApi('unsubscribe', { endpoint: sub.endpoint }).catch(() => {});   // сервер недоступен — всё равно отписываемся
  await sub.unsubscribe();                         // без сервера компьютер сам удалит подписку, когда Apple ответит «такой больше нет»
}

// Сменили группу или подгруппу в настройках — уведомления должны приходить уже по ним
async function pushGroupChanged(what = 'Группа изменилась') {
  const sub = await currentSubscription().catch(() => null);
  if (sub && settings.group && API_BASE) await pushApi('subscribe', subscriptionBody(sub)).catch(() => {});
  await renderPush();
  // Без сервера новый код нужно снова передать компьютеру (renderPush уже показал его и инструкцию)
  if (sub && !API_BASE) setPushStatus(`${what} — передай компьютеру новый код (команда та же: npm run cli -- push-add <код>).`, 'ok');
}

// Скопировать код подписки
$('push-copy')?.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('push-code').value);
    $('push-copy').textContent = 'Скопировано ✓';
  } catch (e) {
    $('push-code').select();                       // буфер обмена недоступен — выделяем, чтобы скопировать вручную
    $('push-copy').textContent = 'Выдели и скопируй код вручную';
  }
  setTimeout(() => { $('push-copy').textContent = 'Скопировать код'; }, 2500);
});

$('push-toggle').addEventListener('click', async () => {
  const button = $('push-toggle');
  button.disabled = true;
  try {
    if (await currentSubscription()) {
      await disablePush();
      setPushStatus('Уведомления выключены.');
    } else {
      await enablePush();
    }
  } catch (e) {
    setPushStatus(`Не получилось: ${e.message}.`, 'error');
    button.disabled = false;
    return;
  }
  renderPush();
});

$('push-test').addEventListener('click', async () => {
  try {
    const sub = await currentSubscription();
    await pushApi('test', { endpoint: sub.endpoint });
    setPushStatus('Пробное уведомление отправлено — оно появится через несколько секунд.', 'ok');
  } catch (e) {
    setPushStatus(`Не получилось: ${e.message}.`, 'error');
  }
});

renderPush();

// Нажали на уведомление — приложение открывается на вкладке «Расписание» (адрес ...#schedule).
// Этот файл подключается последним, поэтому здесь уже есть всё, что нужно вкладке.
function openFromHash() {
  if (location.hash === '#schedule') document.querySelector('[data-view="view-schedule"]').click();
}
openFromHash();
window.addEventListener('hashchange', openFromHash);
