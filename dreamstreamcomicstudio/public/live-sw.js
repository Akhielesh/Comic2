/* Stream Studio service worker — baby-monitor alerts and family-call rings only.
 * No fetch handler on purpose: it never caches or intercepts the app or the
 * stream, it only turns Web Push messages into notifications. */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

const TITLES = {
  cry: '👶 ', fuss: '👶 ', cough: '🤧 ', alarm: '🚨 ', crash: '💥 ', glass: '💥 ', zone: '🚨 ', cat: '🐈 ', loud: '🔊 ', noise: '🔊 ',
  camera: '📷 ', offline: '⚠️ ', battery: '🔋 ', report: '🌙 ', insight: '💡 ', guest: '🔗 ', test: '✅ ',
  call: '📹 ', call_missed: '📵 ',
};
// Wake the phone and keep the notification up until it's handled.
const URGENT = new Set(['cry', 'alarm', 'zone', 'glass', 'offline', 'call']);
const VIBRATE = {
  alarm: [600, 200, 600, 200, 600, 200, 600],
  zone: [600, 200, 600, 200, 600, 200, 600],
  glass: [300, 120, 300, 120, 600],
  cry: [300, 120, 300, 120, 600],
  offline: [300, 120, 300, 120, 600],
  report: [80],
  insight: [80],
  guest: [80, 60, 80],
  call: [500, 250, 500, 250, 500, 250, 500, 250, 500],
  call_missed: [120],
};

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'Baby monitor', body: event.data ? event.data.text() : '' };
  }
  const kind = data.kind || 'alert';
  const isCall = kind === 'call' || kind === 'call_missed';
  // A ringing call opens the app on it (it rings on top); a missed one opens Calls.
  const url = kind === 'call' && data.nid && data.call ? `/live#/call/${data.nid}/${data.call}` : isCall ? '/live#/calls' : data.nid ? `/live#/monitor/${data.nid}/watch` : '/live#/monitor';
  const urgent = URGENT.has(kind);
  event.waitUntil(
    self.registration.showNotification((TITLES[kind] || '') + (data.title || 'Baby monitor'), {
      body: data.body || (isCall ? 'Tap to answer.' : 'Tap to check in.'),
      // A call's ring and its "missed call" share a tag, so one replaces the other.
      tag: data.tag || `${data.nid || 'monitor'}-${kind}`,
      renotify: true,
      requireInteraction: urgent,
      vibrate: VIBRATE[kind] || [200],
      icon: '/stream-studio.svg',
      badge: '/stream-studio.svg',
      timestamp: data.at || Date.now(),
      data: { url },
      actions: kind === 'call' ? [{ action: 'answer', title: 'Answer' }] : kind === 'call_missed' ? [{ action: 'calls', title: 'Call back' }] : kind !== 'test' ? [{ action: 'watch', title: 'Watch now' }] : [],
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const base = (event.notification.data && event.notification.data.url) || '/live#/monitor';
  // "Answer" on a ringing call picks up as soon as the app opens (one tap, no second ring screen).
  const url = event.action === 'answer' && base.indexOf('#/call/') !== -1 ? `${base}?answer=1` : base;
  const target = new URL(url, self.location.origin);
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
