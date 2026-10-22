/* Stream Studio service worker — baby-monitor alerts and family-call rings only.
 * No fetch handler on purpose: it never caches or intercepts the app or the
 * stream, it only turns Web Push messages into notifications. */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

/* A device running as the nursery camera must never ring: the app tells us when it
 * is (and stops being) the camera; that's kept in Cache Storage so it survives this
 * worker being stopped between pushes. The open camera screen counts too. */
const STATE_CACHE = 'ds-sw-state';
const CAMERA_KEY = '/__ds/camera';
const CAMERA_MAX_MS = 24 * 60 * 60 * 1000;

self.addEventListener('message', (event) => {
  const d = event.data || {};
  if (d.t !== 'ds-camera') return;
  event.waitUntil(
    caches.open(STATE_CACHE).then((c) => (d.on ? c.put(CAMERA_KEY, new Response(String(Date.now()))) : c.delete(CAMERA_KEY))).catch(() => undefined),
  );
});

async function isCameraDevice() {
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (all.some((c) => /#\/monitor\/[0-9a-f-]{36}\/camera/.test(c.url))) return true;
  if (!all.some((c) => new URL(c.url).pathname.startsWith('/live'))) return false;
  try {
    const hit = await (await caches.open(STATE_CACHE)).match(CAMERA_KEY);
    return !!hit && Date.now() - Number(await hit.text()) < CAMERA_MAX_MS;
  } catch (e) {
    return false;
  }
}

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
  // A direct call (anyone on Stream Studio) has no nursery: #/call/d/<call>.
  const url =
    kind === 'call' && data.direct && data.call ? `/live#/call/d/${data.call}`
    : kind === 'call' && data.nid && data.call ? `/live#/call/${data.nid}/${data.call}`
    : isCall ? '/live#/calls'
    : data.nid ? `/live#/monitor/${data.nid}/watch` : '/live#/monitor';
  event.waitUntil(
    (async () => {
      // On the nursery camera a call shows quietly: no sound, no buzz, nothing held on screen.
      const quiet = isCall && (await isCameraDevice());
      const urgent = URGENT.has(kind) && !quiet;
      const opts = {
        body: data.body || (isCall ? 'Tap to answer.' : 'Tap to check in.'),
        // A call's ring and its "missed call" share a tag, so one replaces the other.
        tag: data.tag || `${data.nid || 'monitor'}-${kind}`,
        renotify: !quiet,
        requireInteraction: urgent,
        icon: '/stream-studio.svg',
        badge: '/stream-studio.svg',
        timestamp: data.at || Date.now(),
        data: { url },
        actions: kind === 'call' ? [{ action: 'answer', title: 'Answer' }] : kind === 'call_missed' ? [{ action: 'calls', title: 'Call back' }] : kind !== 'test' ? [{ action: 'watch', title: 'Watch now' }] : [],
      };
      // (A silent notification may not carry a vibration pattern.)
      if (quiet) opts.silent = true;
      else opts.vibrate = VIBRATE[kind] || [200];
      return self.registration.showNotification((TITLES[kind] || '') + (data.title || 'Baby monitor'), opts);
    })(),
  );
});

/* "Answer" on a ringing call picks up as soon as the app opens (one tap, no second
 * ring screen). Only a real tap may do that: the app answers only with a one-time
 * proof left here (Cache Storage, read and deleted by the app's takeAnswerProof),
 * bound to that call and good for 90 s — never because an address says so, since
 * anyone can send a link to #/call/…?answer=1. */
const ANSWER_KEY = '/__ds/answer/';
const ANSWER_PROOF_MS = 90 * 1000;
const CALL_HASH = /#\/call\/([0-9a-f-]{36}|d)\/([0-9a-f]{8,24})$/;

async function answerProof(base) {
  const m = CALL_HASH.exec(base);
  if (!m) return null;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const proof = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  try {
    const cache = await caches.open(STATE_CACHE);
    await cache.put(ANSWER_KEY + proof, new Response(JSON.stringify({ call: m[2], where: m[1], at: Date.now() }), { headers: { 'content-type': 'application/json' } }));
    return proof;
  } catch (e) {
    return null; // no proof: the app opens on the ringing call, one more tap to answer
  }
}

/** Proofs nobody used (the app never opened in time) are cleared. */
async function tidyProofs() {
  try {
    const cache = await caches.open(STATE_CACHE);
    for (const req of await cache.keys()) {
      if (new URL(req.url).pathname.indexOf(ANSWER_KEY) !== 0) continue;
      const hit = await cache.match(req);
      const at = hit ? Number((await hit.json().catch(() => ({}))).at) : 0;
      if (!(Date.now() - at < ANSWER_PROOF_MS)) await cache.delete(req);
    }
  } catch (e) {
    /* nothing to tidy */
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const base = (event.notification.data && event.notification.data.url) || '/live#/monitor';
  event.waitUntil(
    (async () => {
      const proof = event.action === 'answer' ? await answerProof(base) : null;
      const target = new URL(proof ? `${base}?answer=${proof}` : base, self.location.origin);
      const open = async () => {
        const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const c of all) {
          if (new URL(c.url).pathname.startsWith('/live')) {
            await c.focus();
            if ('navigate' in c) return c.navigate(target.href);
            return undefined;
          }
        }
        return self.clients.openWindow(target.href);
      };
      try {
        return await open();
      } finally {
        await tidyProofs();
      }
    })(),
  );
});
