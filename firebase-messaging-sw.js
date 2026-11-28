/* TripDock Service Worker v3.17: 離線快取 + Firebase Cloud Messaging 背景推播 + 桌面角標同步 */
importScripts('./js/config.js');
importScripts('https://www.gstatic.com/firebasejs/11.6.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/11.6.0/firebase-messaging-compat.js');

const CACHE_NAME = 'tripdock-shell-v3-17';
const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './js/config.js',
  './js/firebase.js',
  './js/engines.js',
  './js/app.js',
  './docs/USER_GUIDE.md',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/loading-cat.webp',
  './icons/cat-concierge.webp'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});

function updateBackgroundAppBadge(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === '') return Promise.resolve();
  const count = Number(rawValue);
  if (!Number.isFinite(count)) return Promise.resolve();
  try {
    if (count > 0 && self.navigator && typeof self.navigator.setAppBadge === 'function') {
      return self.navigator.setAppBadge(count).catch(() => {});
    }
    if (count <= 0 && self.navigator) {
      if (typeof self.navigator.clearAppBadge === 'function') {
        return self.navigator.clearAppBadge().catch(() => {});
      }
      if (typeof self.navigator.setAppBadge === 'function') {
        return self.navigator.setAppBadge(0).catch(() => {});
      }
    }
  } catch (e) {}
  return Promise.resolve();
}

const cfg = self.TRIPDOCK_CONFIG && self.TRIPDOCK_CONFIG.firebase;
if (cfg && cfg.apiKey && cfg.apiKey !== 'YOUR_API_KEY') {
  firebase.initializeApp(cfg);
  const messaging = firebase.messaging();
  messaging.onBackgroundMessage((payload) => {
    const data = (payload && payload.data) || {};
    const tasks = [];

    // 1. 無論 App 是否開啟，收到背景推播即同步更新桌面圖示未讀數字（iOS 16.4+ PWA / 支援 Badging API 裝置）
    const rawBadge = data.badgeCount !== undefined ? data.badgeCount : data.unreadCount;
    tasks.push(updateBackgroundAppBadge(rawBadge));

    // 2. 若推播已含 notification 欄位則由 Firebase SDK 自動顯示，避免重複跳兩則；data-only 封包則由 SW 統一顯示單則系統通知
    if (!payload || !payload.notification) {
      const title = data.title || 'TripDock 通知';
      const body = data.body || '';
      const link = data.url || './';
      const notifOpts = {
        body,
        icon: './icons/icon-192.png',
        badge: './icons/icon-192.png',
        data: {
          url: link,
          targetType: data.targetType || '',
          tripId: data.tripId || '',
          notifId: data.notifId || ''
        }
      };
      if (data.notifId) {
        notifOpts.tag = data.notifId;
      }
      tasks.push(self.registration.showNotification(title, notifOpts));
    }

    return Promise.all(tasks);
  });
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const d = event.notification.data || {};
  const targetUrl = d.url || (d.FCM_MSG && d.FCM_MSG.data && d.FCM_MSG.data.url) || './';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (let i = 0; i < windowClients.length; i++) {
        const client = windowClients[i];
        if (client.url && client.url.indexOf(self.location.origin) === 0) {
          return client
            .navigate(targetUrl)
            .then((navigated) => (navigated ? navigated.focus() : client.focus()))
            .catch(() => clients.openWindow(targetUrl));
        }
      }
      return clients.openWindow(targetUrl);
    })
  );
});
