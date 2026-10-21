/* Stream Studio service worker — baby-monitor alerts only.
 * No fetch handler on purpose: it never caches or intercepts the app or the
 * stream, it only turns Web Push messages into notifications. */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

const TITLES = {
  cry: '👶 ', fuss: '👶 ', cough: '🤧 ', alarm: '🚨 ', crash: '💥 ', glass: '💥 ', zone: '🚨 ', cat: '🐈 ', loud: '🔊 ', noise: '🔊 ',
  camera: '📷 ', offline: '⚠️ ', battery: '🔋 ', report: '🌙 ', insight: '💡 ', test: '✅ ',
};
// Wake the phone and keep the notification up until it's handled.
const URGENT = new Set(['cry', 'alarm', 'zone', 'glass', 'offline']);
const VIBRATE = {
  alarm: [600, 200, 600, 200, 600, 200, 600],
  zone: [600, 200, 600, 200, 600, 200, 600],
  glass: [300, 120, 300, 120, 600],
  cry: [300, 120, 300, 120, 600],
  offline: [300, 120, 300, 120, 600],
  report: [80],
  insight: [80],
};

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'Baby monitor', body: event.data ? event.data.text() : '' };
  }
  const kind = data.kind || 'alert';
  const url = data.nid ? `/live#/monitor/${data.nid}/watch` : '/live#/monitor';
  const urgent = URGENT.has(kind);
  event.waitUntil(
    self.registration.showNotification((TITLES[kind] || '') + (data.title || 'Baby monitor'), {
      body: data.body || 'Tap to check in.',
      tag: `${data.nid || 'monitor'}-${kind}`,
      renotify: true,
      requireInteraction: urgent,
      vibrate: VIBRATE[kind] || [200],
      icon: '/stream-studio.svg',
      badge: '/stream-studio.svg',
      timestamp: data.at || Date.now(),
      data: { url },
      actions: kind !== 'test' ? [{ action: 'watch', title: 'Watch now' }] : [],
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || '/live#/monitor', self.location.origin);
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of all) {
        if (new URL(c.url).pathname.startsWith('/live')) {
          await c.focus();
          if ('navigate' in c) return c.navigate(target.href);
          return undefined;
        }
      }
      return self.clients.openWindow(target.href);
    })(),
  );
});
