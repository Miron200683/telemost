const {
  app, BrowserWindow, Notification, Tray, Menu, shell, session,
  ipcMain, desktopCapturer, dialog, nativeImage, clipboard,
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

const START_URL = 'https://telemost.yandex.ru/';
const APP_NAME = 'Яндекс Телемост';
const YANDEX_HOST = /(^|\.)(yandex\.(ru|com|net|by|kz|uz)|ya\.ru|yandex-team\.ru|yastatic\.net)$/i;

// --- Идентичность приложения: именно по ней KDE группирует уведомления ---
app.setName(APP_NAME);
app.setDesktopName('yandex-telemost.desktop');

// AppImage не может выставить SUID на chrome-sandbox
if (app.isPackaged) app.commandLine.appendSwitch('no-sandbox');
// Wayland/X11 автоопределение + шаринг экрана через PipeWire-портал
app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');

if (!app.requestSingleInstanceLock()) app.quit();

const DEBUG = !!process.env.TELEMOST_DEBUG;
const startHidden = process.argv.includes('--hidden') || process.argv.includes('--minimized');

let win = null;
let tray = null;
let quitting = false;

const iconPath = app.isPackaged
  ? path.join(process.resourcesPath, 'icon.png')
  : path.join(__dirname, 'build', 'icon.png');
const icon = nativeImage.createFromPath(iconPath);

function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function isYandexUrl(u) {
  try { return YANDEX_HOST.test(new URL(u).hostname); } catch { return false; }
}

// Окна входа Яндекса (паспорт/OAuth) оставляем внутри приложения, всё остальное — во внешний браузер
const AUTH_HOST = /(^|\.)(passport|oauth|sso)\.yandex\.[a-z]+$/i;
function isAuthUrl(u) {
  try { return AUTH_HOST.test(new URL(u).hostname); } catch { return false; }
}
function openExternalSafe(u) {
  try {
    const { protocol } = new URL(u);
    if (['http:', 'https:', 'mailto:', 'tel:'].includes(protocol)) shell.openExternal(u);
  } catch { /* битая ссылка */ }
}

function setupSession() {
  const ses = session.defaultSession;

  // Телемосту не нравится "Electron/" в User-Agent
  ses.setUserAgent(
    `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
    `Chrome/${process.versions.chrome} Safari/537.36`
  );

  const allowed = new Set([
    'media', 'mediaKeySystem', 'display-capture', 'notifications',
    'fullscreen', 'clipboard-sanitized-write', 'clipboard-read',
  ]);
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    cb(allowed.has(permission) && isYandexUrl(details.requestingUrl || wc.getURL()));
  });
  ses.setPermissionCheckHandler((wc, permission, origin) =>
    allowed.has(permission) && isYandexUrl(origin || wc.getURL()));

  // Демонстрация экрана
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 },
      });
      if (!sources.length) return callback({});
      let chosen = sources[0];
      // На Wayland выбор делает системный портал и вернётся 1 источник.
      // На X11 источников много — спросим пользователя.
      if (sources.length > 1) {
        const list = sources.slice(0, 8);
        const { response } = await dialog.showMessageBox(win, {
          type: 'question',
          title: 'Демонстрация экрана',
          message: 'Что показать участникам?',
          buttons: [...list.map((s) => s.name.slice(0, 60)), 'Отмена'],
          cancelId: list.length,
        });
        if (response === list.length) return callback({});
        chosen = list[response];
      }
      callback({ video: chosen });
    } catch (e) {
      console.error('display media error', e);
      callback({});
    }
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 800, minHeight: 600,
    title: APP_NAME, icon, autoHideMenuBar: true, show: !startHidden,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false, // чтобы звонок не "засыпал" в фоне
    },
  });

  win.loadURL(START_URL);

  // Ссылки из чатов (target=_blank, ctrl+клик, средняя кнопка) -> внешний браузер
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAuthUrl(url)) return { action: 'allow' };
    openExternalSafe(url);
    return { action: 'deny' };
  });
  // Обычный переход в этом же окне: внутри остаётся только Яндекс (вход, редиректы)
  win.webContents.on('will-navigate', (e, url) => {
    if (!isYandexUrl(url)) { e.preventDefault(); openExternalSafe(url); }
  });

  // Контекстное меню: ссылки + вставка/копирование в поле ввода чата
  win.webContents.on('context-menu', (_e, params) => {
    const items = [];
    if (params.linkURL) {
      items.push(
        { label: 'Открыть ссылку в браузере', click: () => openExternalSafe(params.linkURL) },
        { label: 'Копировать адрес ссылки', click: () => clipboard.writeText(params.linkURL) },
        { type: 'separator' },
      );
    }
    if (params.isEditable) {
      items.push(
        { role: 'undo', label: 'Отменить' }, { role: 'redo', label: 'Повторить' }, { type: 'separator' },
        { role: 'cut', label: 'Вырезать' }, { role: 'copy', label: 'Копировать' },
        { role: 'paste', label: 'Вставить' }, { role: 'selectAll', label: 'Выделить всё' },
      );
    } else if (params.selectionText) {
      items.push({ role: 'copy', label: 'Копировать' });
    }
    while (items.length && items[items.length - 1].type === 'separator') items.pop();
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });

  // Закрытие окна = свернуть в трей, чтобы уведомления продолжали приходить
  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win.hide(); }
  });
  win.on('focus', clearUnread);
  win.on('closed', () => { win = null; });
}

// --- Настройки ---
const settings = { sound: true };
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
function loadSettings() {
  try { Object.assign(settings, JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))); } catch { /* первый запуск */ }
}
function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  } catch (e) { console.error('settings save failed', e); }
}

// --- Скрытое окно-помощник: проигрывает звук и рисует бейдж на иконке ---
let helper = null;
const helperDir = app.isPackaged
  ? path.join(process.resourcesPath, 'sound')
  : path.join(__dirname, 'build', 'sound');
let iconDataUrl = '';

function createHelper() {
  helper = new BrowserWindow({
    show: false, width: 100, height: 100,
    webPreferences: { autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false },
  });
  helper.loadFile(path.join(helperDir, 'helper.html'));
}

// Включён ли режим "Не беспокоить" в KDE (org.freedesktop.Notifications.Inhibited)
function isDnd() {
  return new Promise((resolve) => {
    execFile('busctl', [
      '--user', 'get-property', 'org.freedesktop.Notifications',
      '/org/freedesktop/Notifications', 'org.freedesktop.Notifications', 'Inhibited',
    ], { timeout: 1500 }, (err, out) => resolve(!err && /\btrue\b/.test(String(out))));
  });
}

let lastSound = 0;
async function playSound(force = false) {
  if (!helper || helper.isDestroyed()) return;
  if (!force) {
    if (!settings.sound) return;
    if (Date.now() - lastSound < 800) return; // не трещим при пачке сообщений
    if (await isDnd()) return;
  }
  lastSound = Date.now();
  helper.webContents.executeJavaScript('play(1)').catch(() => {});
}

// --- Непрочитанные: считаем уведомления, пришедшие пока окно не в фокусе ---
let unread = 0;
let badgeSeq = 0;
let unityBus = null;
const DESKTOP_ID = process.env.TELEMOST_DESKTOP_ID || 'yandex-telemost.desktop';

// Бейдж на значке в панели задач Plasma (протокол com.canonical.Unity.LauncherEntry)
function sendLauncherBadge(n) {
  try {
    const dbus = require('dbus-next');
    unityBus = unityBus || dbus.sessionBus();
    unityBus.on('error', () => {});
    unityBus.send(new dbus.Message({
      type: dbus.MessageType.SIGNAL,
      path: '/com/canonical/unity/launcherentry/1',
      interface: 'com.canonical.Unity.LauncherEntry',
      member: 'Update',
      signature: 'sa{sv}',
      body: [`application://${DESKTOP_ID}`, {
        count: new dbus.Variant('x', BigInt(n)),
        'count-visible': new dbus.Variant('b', n > 0),
      }],
    }));
  } catch (e) {
    if (DEBUG) console.log('[badge] dbus failed:', e.message);
  }
}

async function updateBadge() {
  const n = unread;
  const seq = ++badgeSeq;
  try { app.setBadgeCount(n); } catch { /* только Unity */ }
  sendLauncherBadge(n);
  if (tray) tray.setToolTip(n ? `${APP_NAME} — непрочитанных: ${n}` : APP_NAME);
  try {
    if (!iconDataUrl) iconDataUrl = 'data:image/png;base64,' + fs.readFileSync(iconPath).toString('base64');
    const url = await helper.webContents.executeJavaScript(`drawBadge(${JSON.stringify(iconDataUrl)}, ${n})`);
    if (seq !== badgeSeq || !url) return;
    const img = nativeImage.createFromDataURL(url);
    if (tray) tray.setImage(img.resize({ width: 32, height: 32 }));
    if (win) win.setIcon(img);
  } catch (e) {
    if (DEBUG) console.log('[badge] draw failed:', e.message);
  }
}

function windowActive() {
  return !!win && win.isVisible() && win.isFocused() && !win.isMinimized();
}
function bumpUnread() {
  if (windowActive()) return;
  unread += 1;
  updateBadge();
}
function clearUnread() {
  if (!unread) return;
  unread = 0;
  updateBadge();
}

// --- Автозагрузка (XDG autostart, работает в KDE Plasma) ---
const autostartFile = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
  'autostart', 'yandex-telemost.desktop'
);

function isAutostart() {
  return fs.existsSync(autostartFile);
}

function setAutostart(enable) {
  try {
    if (!enable) { fs.rmSync(autostartFile, { force: true }); return; }
    // Для AppImage реальный путь лежит в $APPIMAGE, а не в process.execPath
    const exe = (process.env.APPIMAGE || process.env.TELEMOST_LAUNCHER || process.execPath).replace(/(["`$\\])/g, '\\$1');
    fs.mkdirSync(path.dirname(autostartFile), { recursive: true });
    fs.writeFileSync(autostartFile, [
      '[Desktop Entry]',
      'Type=Application',
      `Name=${APP_NAME}`,
      'Comment=Видеовстречи Яндекс Телемост',
      `Exec="${exe}" --hidden`,
      'Icon=yandex-telemost',
      'Terminal=false',
      'X-GNOME-Autostart-enabled=true',
      '',
    ].join('\n'));
  } catch (e) {
    dialog.showErrorBox(APP_NAME, `Не удалось изменить автозагрузку:\n${e.message}`);
  }
}

// Перезапуск. В AppImage app.relaunch() не годится (см. restart.js): запускаем сам файл
// $APPIMAGE с очищенным окружением после выхода текущего процесса.
async function restartApp() {
  try { await session.defaultSession.cookies.flushStore(); } catch { /* не критично */ }
  quitting = true;
  const args = process.argv.slice(1).filter((a) => a !== '--hidden' && a !== '--minimized');
  if (process.env.APPIMAGE) {
    require('./restart').relaunchAppImage(process.env.APPIMAGE, args, process.pid);
  } else {
    app.relaunch({ args });
  }
  app.quit();
}

function buildTrayMenu() {
  const items = [
    { label: 'Открыть Телемост', click: showWindow },
    {
      label: 'Звук уведомлений',
      type: 'checkbox',
      checked: settings.sound,
      click: (item) => { settings.sound = item.checked; saveSettings(); },
    },
    { label: 'Проверить звук', click: () => playSound(true) },
    {
      label: 'Тестовое уведомление',
      click: () => {
        new Notification({ title: APP_NAME, body: 'Проверка уведомлений', icon }).show();
        playSound();
      },
    },
  ];
  if (app.isPackaged || process.env.TELEMOST_LAUNCHER) {
    items.push({
      label: 'Запускать при входе в систему',
      type: 'checkbox',
      checked: isAutostart(),
      click: (item) => { setAutostart(item.checked); buildTrayMenu(); },
    });
  }
  items.push(
    { type: 'separator' },
    { label: 'Перезапустить', click: restartApp },
    { label: 'Выход', click: () => { quitting = true; app.quit(); } },
  );
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

function createTray() {
  tray = new Tray(icon.resize({ width: 22, height: 22 }));
  tray.setToolTip(APP_NAME);
  buildTrayMenu();
  tray.on('click', () => (win && win.isVisible() && win.isFocused() ? win.hide() : showWindow()));
}

// --- Уведомления: страница -> нативный DBus-нотификатор (KDE Plasma) ---
const live = new Map();      // id -> Notification
const byTag = new Map();     // tag -> id
const cancelled = new Set(); // закрыты до показа (пока грузилась аватарка)
const pending = new Set();   // ждут загрузки аватарки
const avatarCache = new Map(); // url -> NativeImage

// Загружает аватарку (https:// или data:) и возвращает NativeImage либо null
async function loadAvatar(src) {
  if (!src || typeof src !== 'string') return null;
  if (avatarCache.has(src)) return avatarCache.get(src);
  let img = null;
  try {
    let buf = null;
    if (src.startsWith('data:')) {
      const m = /^data:[^;,]*(;base64)?,(.*)$/s.exec(src);
      if (m) buf = m[1] ? Buffer.from(m[2], 'base64') : Buffer.from(decodeURIComponent(m[2]));
    } else if (src.startsWith('https://')) {
      const res = await session.defaultSession.fetch(src, {
        credentials: 'include',
        signal: AbortSignal.timeout(4000),
      });
      const type = res.headers.get('content-type') || '';
      if (res.ok && /^image\//i.test(type)) {
        const ab = await res.arrayBuffer();
        if (ab.byteLength > 0 && ab.byteLength < 3 * 1024 * 1024) buf = Buffer.from(ab);
      }
    }
    if (buf) {
      const candidate = nativeImage.createFromBuffer(buf);
      if (!candidate.isEmpty()) {
        const { width, height } = candidate.getSize();
        // KDE показывает иконку небольшой — не таскаем огромные картинки
        img = Math.max(width, height) > 256
          ? candidate.resize(width >= height ? { width: 256 } : { height: 256 })
          : candidate;
      }
    }
  } catch (e) {
    if (DEBUG) console.log('[avatar] failed:', src, e.message);
  }
  if (avatarCache.size > 60) avatarCache.delete(avatarCache.keys().next().value);
  avatarCache.set(src, img);
  return img;
}

ipcMain.on('notify', async (event, { id, title, body, tag, silent, icon: iconSrc }) => {
  if (!Notification.isSupported()) {
    if (DEBUG) console.log('[notify] Notification.isSupported() = false');
    return;
  }
  if (DEBUG) console.log('[notify]', 'received');
  if (DEBUG) console.log('[notify]', JSON.stringify({ id, title, body, tag, icon: String(iconSrc || '').slice(0, 200) }));

  pending.add(id);
  const avatar = await loadAvatar(iconSrc);
  pending.delete(id);
  if (cancelled.delete(id)) return;

  if (tag && byTag.has(tag)) {            // заменяем уведомление с тем же tag
    const prev = live.get(byTag.get(tag));
    if (prev) prev.close();
  }

  const n = new Notification({
    title: String(title || APP_NAME),
    body: String(body || ''),
    icon: avatar || icon,                  // аватарка, а если её нет — иконка приложения
    silent: !!silent,
    urgency: 'normal',
  });
  live.set(id, n);
  if (tag) byTag.set(tag, id);

  const send = (type) => { if (!event.sender.isDestroyed()) event.sender.send('notify-event', id, type); };
  n.on('click', () => { showWindow(); send('click'); });
  n.on('close', () => {
    live.delete(id);
    if (tag && byTag.get(tag) === id) byTag.delete(tag);
    send('close');
  });
  try { n.show(); if (DEBUG) console.log('[notify] shown', id); }
  catch (e) { console.error('[notify] show failed:', e); }
  if (!silent) playSound();
  bumpUnread();
});

ipcMain.on('notify-close', (_e, id) => {
  const n = live.get(id);
  if (n) n.close();
  else if (pending.has(id)) cancelled.add(id); // иначе номер навсегда остаётся в cancelled
});

app.on('second-instance', showWindow);
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { /* живём в трее */ });

app.whenReady().then(() => {
  loadSettings();
  setupSession();
  createHelper();
  createWindow();
  createTray();
});
