const { contextBridge, ipcRenderer, webFrame } = require('electron');

let seq = Date.now(); // уникально и после перезагрузки страницы
contextBridge.exposeInMainWorld('__tmNative', {
  nextId: () => ++seq,
  notify: (id, opts) => ipcRenderer.send('notify', { id, ...opts }),
  close: (id) => ipcRenderer.send('notify-close', id),
  onEvent: (cb) => ipcRenderer.on('notify-event', (_e, id, type) => cb(id, type)),
});

// Подменяем Notification на странице, чтобы всё шло через Electron -> libnotify/DBus
webFrame.executeJavaScript(`(() => {
  const native = window.__tmNative;
  if (!native) return;
  const live = new Map();

  native.onEvent((id, type) => {
    const n = live.get(id);
    if (!n) return;
    const ev = new Event(type);
    const h = n['on' + type];
    if (typeof h === 'function') { try { h.call(n, ev); } catch (e) { console.error(e); } }
    n.dispatchEvent(ev);
    if (type === 'close') live.delete(id);
  });

  async function prepIcon(src) {
    if (!src) return '';
    let abs;
    try { abs = new URL(src, location.href).href; } catch (e) { return ''; }
    if (abs.startsWith('blob:') || abs.startsWith('data:')) {
      try {
        const blob = await (await fetch(abs)).blob();
        return await new Promise((resolve) => {
          const fr = new FileReader();
          fr.onload = () => resolve(fr.result);
          fr.onerror = () => resolve('');
          fr.readAsDataURL(blob);
        });
      } catch (e) { return ''; }
    }
    return abs;
  }

  class TMNotification extends EventTarget {
    static get permission() { return 'granted'; }
    static get maxActions() { return 0; }
    static requestPermission(cb) {
      if (typeof cb === 'function') cb('granted');
      return Promise.resolve('granted');
    }
    constructor(title, options = {}) {
      super();
      this.title = String(title);
      this.body = options.body || '';
      this.tag = options.tag || '';
      this.data = options.data;
      this.icon = options.icon || '';
      this.silent = !!options.silent;
      this.onclick = this.onclose = this.onshow = this.onerror = null;
      this._id = native.nextId();
      this._closed = false;
      live.set(this._id, this);
      // blob:/data: конвертируем в data-URL прямо на странице, http(s) качает main-процесс
      prepIcon(options.icon || options.image).then((icon) => {
        if (this._closed) return;
        native.notify(this._id, {
          title: this.title, body: this.body, tag: this.tag, silent: this.silent, icon,
        });
      });
      setTimeout(() => {
        const ev = new Event('show');
        if (typeof this.onshow === 'function') this.onshow(ev);
        this.dispatchEvent(ev);
      }, 0);
    }
    close() { this._closed = true; native.close(this._id); }
  }

  Object.defineProperty(window, 'Notification', {
    value: TMNotification, configurable: true, writable: true,
  });

  // На случай, если сайт шлёт уведомления через service worker
  if (window.ServiceWorkerRegistration) {
    ServiceWorkerRegistration.prototype.showNotification = function (title, options) {
      new TMNotification(title, options);
      return Promise.resolve();
    };
  }
})();`);
