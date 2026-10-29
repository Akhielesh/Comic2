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
/* The app's own pages: under this worker's scope — /live on dreamstreamstudio.ai, everything on
 * Stream Studio's own host (stream.dreamstreamstudio.ai, scope '/'). */
const isAppPage = (u) => new URL(u).pathname.startsWith(new URL(self.registration.scope).pathname);
/* An app screen ('#/monitor') under this worker's scope — /live#… there, /#… on Stream Studio's own
 * host — so tapping a notification only changes the screen of an open app, never reloads it (an open
 * monitor or a ringing call would drop its connection). */
const appUrl = (hash) => new URL(hash, self.registration.scope).href;

/* Signed out on this device (or another account took it over): the alerts on screen go, and an
 * alert that arrived before now can't act any more — its "I'm on it" token speaks for the person
 * who just signed out (live/monitor/push.ts closeAlertNotifications). Kept in Cache Storage, so it
 * holds while this worker is stopped; alerts that arrive after the next sign-in act as normal. */
const SIGNED_OUT_KEY = '/__ds/signed-out';

async function signedOutAt() {
  try {
    const hit = await (await caches.open(STATE_CACHE)).match(SIGNED_OUT_KEY);
    return hit ? Number(await hit.text()) || 0 : 0;
  } catch (e) {
    return 0;
  }
}

self.addEventListener('message', (event) => {
  const d = event.data || {};
  if (d.t === 'ds-signed-out') {
    event.waitUntil(
      (async () => {
        try {
          await (await caches.open(STATE_CACHE)).put(SIGNED_OUT_KEY, new Response(String(Date.now())));
        } catch (e) {
          /* the page closes what it can see too */
        }
        try {
          for (const n of await self.registration.getNotifications()) n.close();
        } catch (e) {
          /* nothing shown */
        }
      })(),
    );
    return;
  }
  if (d.t !== 'ds-camera') return;
  event.waitUntil(
    caches.open(STATE_CACHE).then((c) => (d.on ? c.put(CAMERA_KEY, new Response(String(Date.now()))) : c.delete(CAMERA_KEY))).catch(() => undefined),
  );
});

async function isCameraDevice() {
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (all.some((c) => /#\/monitor\/[0-9a-f-]{36}\/camera/.test(c.url))) return true;
  if (!all.some((c) => isAppPage(c.url))) return false;
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
  call: '📹 ', call_missed: '📵 ', ack: '✅ ',
};

/* "I'm on it" (ADR 0006 WS-5): an alert push that carries an action token (`act`, minted per
 * person by the room — live-worker auth/actToken.ts: `a1.<uid>.<exp>.<mac>`, 30 minutes, single
 * use) gets a button that acknowledges the incident straight from the notification, without
 * opening the app: POST <this origin>/live-api/api/monitor/<nid>/act, `Authorization: DS-Act`.
 * The room records it like an acknowledgement in the app and tells everyone else with a quiet
 * replacement push (same tag, `kind: 'ack'`). If it can't be marked, the alert comes straight
 * back — a parent's tap must never make an alert disappear unhandled. */
const NID_RE = /^[0-9a-f-]{36}$/;
const ACT_RE = /^a1\.[A-Za-z0-9_-]{1,64}\.\d{1,13}\.[A-Za-z0-9_-]{16,128}$/;
const NO_ONIT = new Set(['test', 'ack', 'report', 'insight', 'guest', 'call', 'call_missed']);

/** May this push carry "I'm on it"? */
function canAct(data) {
  const kind = data && data.kind;
  return (
    !!data && !NO_ONIT.has(kind) && typeof data.act === 'string' && ACT_RE.test(data.act) &&
    typeof data.nid === 'string' && NID_RE.test(data.nid) && typeof data.inc === 'string' && !!data.inc && data.inc.length <= 64
  );
}

/** A fresh acknowledgement id: one per ALERT (made when it arrives), reused by every retry. */
const newActId = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
const ACT_ID_RE = /^[0-9a-f]{24}$/;

/**
 * The acknowledgement request for a notification's data, or null when it can't be made. The id is
 * the alert's own (`aid`), so a retry after a lost answer is the same acknowledgement — the room
 * dedupes it ("/act with the same id twice gives one acknowledgement") instead of refusing the
 * now-spent token and telling the parent it failed when everyone else was told they're on it.
 */
function actRequest(d) {
  if (!canAct(d)) return null;
  const id = typeof d.aid === 'string' && ACT_ID_RE.test(d.aid) ? d.aid : newActId();
  return {
    url: new URL(`/live-api/api/monitor/${d.nid}/act`, self.location.origin).href,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `DS-Act ${d.act}` },
      body: JSON.stringify({ a: 'ack', inc: d.inc, id }),
      credentials: 'omit',
      cache: 'no-store',
    },
  };
}

async function onIt(n) {
  const d = (n && n.data) || {};
  const out = await signedOutAt();
  if (out && !(typeof d.got === 'number' && d.got > out)) {
    // Signed out here since this alert arrived: never act for whoever signed out.
    return self.registration.showNotification('Baby monitor', {
      tag: n.tag || d.tag,
      icon: '/stream-studio.svg',
      badge: '/stream-studio.svg',
      timestamp: Date.now(),
      renotify: false,
      silent: true,
      requireInteraction: false,
      body: 'You’re signed out on this device — sign in to check the monitor.',
      data: { url: d.url },
      actions: [],
    });
  }
  const req = actRequest(d);
  let status = 0;
  let body = null;
  if (req) {
    try {
      const res = await fetch(req.url, req.init);
      status = res.status;
      body = await res.json().catch(() => null);
    } catch (e) {
      status = 0;
    }
  }
  const ok = status >= 200 && status < 300 && !!body && body.ok !== false;
  const base = { tag: n.tag || d.tag, icon: '/stream-studio.svg', badge: '/stream-studio.svg', timestamp: Date.now(), renotify: false, silent: true };
  if (ok) {
    return self.registration.showNotification('✅ You’re on it', {
      ...base,
      body: `${d.title || 'Alert'} — marked as yours. Tap to check in.`,
      requireInteraction: false,
      data: { url: d.url },
      actions: [{ action: 'watch', title: 'Watch now' }],
    });
  }
  // Not marked: the alert is shown again, as it was, with the reason.
  const handled = !!body && typeof body.error === 'string' && /resolved|ended|closed/.test(body.error);
  const why = !req
    ? 'Couldn’t mark this from here — open the monitor.'
    : status === 0
      ? 'Couldn’t reach the monitor to mark this — check your connection or open it.'
      : handled
        ? 'This alert was already handled.'
        : status === 401 || status === 403
          ? 'This alert can’t be marked from here any more — open the monitor.'
          : 'Couldn’t mark this — open the monitor to check in.';
  return self.registration.showNotification(d.fullTitle || 'Baby monitor', {
    ...base,
    body: d.body ? `${why} ${d.body}` : why,
    requireInteraction: !!d.urgent && !handled,
    data: d,
    // Only a connection failure is worth another tap: the token is spent or refused otherwise.
    actions: status === 0 && req ? [{ action: 'onit', title: 'I’m on it' }, { action: 'watch', title: 'Watch now' }] : [{ action: 'watch', title: 'Watch now' }],
  });
}
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
    kind === 'call' && data.direct && data.call ? appUrl(`#/call/d/${data.call}`)
    : kind === 'call' && data.nid && data.call ? appUrl(`#/call/${data.nid}/${data.call}`)
    : isCall ? appUrl('#/calls')
    : data.nid ? appUrl(`#/monitor/${data.nid}/watch`) : appUrl('#/monitor');
  event.waitUntil(
    (async () => {
      // "Dad's on it": the quiet replacement for an alert someone acknowledged (same tag, so it
      // replaces the alert here) — no sound, no buzz, nothing held on screen.
      const replacement = kind === 'ack' || data.replace === true;
      // On the nursery camera a call shows quietly: no sound, no buzz, nothing held on screen.
      const quiet = replacement || (isCall && (await isCameraDevice()));
      const urgent = URGENT.has(kind) && !quiet;
      const title = (TITLES[kind] || '') + (data.title || 'Baby monitor');
      const body = data.body || (isCall ? 'Tap to answer.' : 'Tap to check in.');
      const tag = data.tag || `${data.nid || 'monitor'}-${replacement && data.of ? data.of : kind}`;
      const onit = !replacement && canAct(data);
      const opts = {
        body,
        // A call's ring and its "missed call" share a tag, so one replaces the other; an alert and
        // its acknowledgement do too.
        tag,
        renotify: !quiet,
        requireInteraction: urgent,
        icon: '/stream-studio.svg',
        badge: '/stream-studio.svg',
        timestamp: data.at || Date.now(),
        // What "I'm on it" needs to acknowledge — and to put the alert back if it can't.
        // `aid`: this alert's one acknowledgement id (every retry reuses it); `got`: when it
        // arrived, so a sign-out after it switches its button off.
        data: onit
          ? { url, nid: data.nid, inc: data.inc, act: data.act, aid: newActId(), got: Date.now(), kind, tag, title: data.title || 'Baby monitor', fullTitle: title, body, urgent }
          : { url },
        actions:
          kind === 'call' ? [{ action: 'answer', title: 'Answer' }]
          : kind === 'call_missed' ? [{ action: 'calls', title: 'Call back' }]
          : onit ? [{ action: 'onit', title: 'I’m on it' }, { action: 'watch', title: 'Watch now' }]
          : kind !== 'test' ? [{ action: 'watch', title: 'Watch now' }] : [],
      };
      // (A silent notification may not carry a vibration pattern.)
      if (quiet) opts.silent = true;
      else opts.vibrate = VIBRATE[kind] || [200];
      return self.registration.showNotification(title, opts);
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
  // "I'm on it": acknowledged from here, the app stays closed.
  if (event.action === 'onit') {
    event.waitUntil(onIt(event.notification));
    return;
  }
  const base = (event.notification.data && event.notification.data.url) || appUrl('#/monitor');
  event.waitUntil(
    (async () => {
      const proof = event.action === 'answer' ? await answerProof(base) : null;
      const target = new URL(proof ? `${base}?answer=${proof}` : base, self.location.origin);
      const open = async () => {
        const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const c of all) {
          if (isAppPage(c.url)) {
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
