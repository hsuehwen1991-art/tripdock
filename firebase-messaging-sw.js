/* TripDock Service Worker: 離線快取 + Firebase Cloud Messaging 背景推播 */
importScripts('./js/config.js');
importScripts('https://www.gstatic.com/firebasejs/11.6.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/11.6.0/firebase-messaging-compat.js');

const CACHE_NAME = 'tripdock-shell-v3-14';
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
  './icons/loading-cat.webp'
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

const cfg = self.TRIPDOCK_CONFIG && self.TRIPDOCK_CONFIG.firebase;
if (cfg && cfg.apiKey && cfg.apiKey !== 'YOUR_API_KEY') {
  firebase.initializeApp(cfg);
  const messaging = firebase.messaging();
  messaging.onBackgroundMessage((payload) => {
    // 若推播本身已含 notification 欄位，Firebase SDK 會自動顯示系統通知，直接略過避免重複彈出兩則
    if (payload && payload.notification) return;
    const title = (payload && payload.data && payload.data.title) || 'TripDock 通知';
    const body = (payload && payload.data && payload.data.body) || '';
    const link = (payload && payload.data && payload.data.url) || './';
    self.registration.showNotification(title, {
      body,
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      data: { url: link }
    });
  });
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const d = event.notification.data || {};
  const targetUrl = d.url || (d.FCM_MSG && d.FCM_MSG.data && d.FCM_MSG.data.url) || './';
  event.waitUntil(clients.openWindow(targetUrl));
});
