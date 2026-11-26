/* TripDock Service Worker: 離線快取 + Firebase Cloud Messaging 背景推播 */
importScripts('./js/config.js');
importScripts('https://www.gstatic.com/firebasejs/11.6.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/11.6.0/firebase-messaging-compat.js');

const CACHE_NAME = 'tripdock-shell-v3-9';
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
  './icons/icon-512.png'
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
    const title = (payload.notification && payload.notification.title) || 'TripDock 通知';
    const body = (payload.notification && payload.notification.body) || '';
    const link = (payload.data && payload.data.url) || './';
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
  const targetUrl = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil(clients.openWindow(targetUrl));
});
