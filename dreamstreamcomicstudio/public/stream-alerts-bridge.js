/* Stream Studio alerts bridge — served on dreamstreamstudio.ai (public/stream-alerts-bridge.html),
 * loaded in a hidden frame by Stream Studio's own host, https://stream.dreamstreamstudio.ai
 * (live/monitor/push.ts frameBridge). ADR 0006 WS-5; docs/infrastructure/INFRA_MAP.md §2a.
 *
 * Why: alerts turned on at dreamstreamstudio.ai/live belong to this (the apex) origin — its
 * service worker (scope /live) and its push subscription. Once the app lives on its own host,
 * turning alerts on there makes a second subscription: every alert would arrive twice, and
 * signing out there wouldn't stop the old one. The new host asks this page, same site, to
 *   state  → the old subscription's endpoint, the nurseries it alerts for (this origin's
 *            `ds-monitor-push-<nid>` opt-ins), call ringing, and whose data this is;
 *   retire → unsubscribe it (every room drops it at its next alert: the push service answers
 *            410) and clear those opt-ins; scope 'account' also wipes the account's other Stream
 *            Studio data here, exactly as signing out here would have (live/accountPurge.ts).
 * It answers only Stream Studio's host (the message's origin and source are checked), only in a
 * frame, never acts for another account (`uid` must match ds-live-owner), and has no UI.
 */
(function () {
  'use strict';
  var PARENTS = ['https://stream.dreamstreamstudio.ai'];
  var TAG = 'ds-alerts-bridge';
  var LEGACY_SCOPE = '/live';
  var FLAG = /^ds-monitor-push-([0-9a-f-]{36})$/;
  var RING = 'ds-call-ring';
  var OWNER = 'ds-live-owner';
  // What a Stream Studio account leaves on a device — the same lists as live/accountPurge.ts
  // (a test keeps them in step).
  var EXACT = ['ds-live-prefs', 'ds-live-prefs-saved-at', 'ds-live-my-events', 'ds-live-my-recordings', 'ds-call-ring', 'ds-calls-seen', 'ds-live-welcome-ticket', 'ds-live-owner'];
  var PREFIXES = ['ds-monitor-push-', 'ds-monitor-setup-', 'ds-monitor-zones-', 'ds-monitor-stats-', 'ds-monitor-silent-', 'ds-monitor-cam-', 'ds-track-queue-', 'ds-usage-'];

  function storage() {
    try {
      return window.localStorage;
    } catch (e) {
      return null;
    }
  }

  function keys(s) {
    var out = [];
    try {
      for (var i = 0; i < s.length; i++) {
        var k = s.key(i);
        if (k) out.push(k);
      }
    } catch (e) {
      /* storage unavailable */
    }
    return out;
  }

  /** The old Stream Studio worker's subscription — never another registration this site has. */
  async function legacySubscription() {
    var sw = navigator.serviceWorker;
    if (!sw || typeof sw.getRegistration !== 'function') return null;
    var reg = await sw.getRegistration(LEGACY_SCOPE);
    if (!reg || !reg.pushManager || new URL(reg.scope).pathname !== LEGACY_SCOPE) return null;
    return (await reg.pushManager.getSubscription()) || null;
  }

  async function state() {
    var s = storage();
    var nids = [];
    var ring = false;
    var owner = null;
    if (s) {
      keys(s).forEach(function (k) {
        var m = FLAG.exec(k);
        if (m && s.getItem(k) === '1') nids.push(m[1]);
      });
      ring = s.getItem(RING) === '1';
      owner = s.getItem(OWNER) || null;
    }
    var sub = null;
    try {
      sub = await legacySubscription();
    } catch (e) {
      sub = null;
    }
    return { ok: true, endpoint: sub ? sub.endpoint : null, nids: nids, ring: ring, owner: owner };
  }

  async function retire(d) {
    var s = storage();
    var uid = typeof d.uid === 'string' && d.uid ? d.uid : null;
    var owner = s ? s.getItem(OWNER) : null;
    if (!uid) return { ok: false, error: 'no_account' };
    if (owner && owner !== uid) return { ok: false, error: 'other_account' };
    var endpoint = null;
    try {
      var sub = await legacySubscription();
      if (sub) {
        endpoint = sub.endpoint;
        await sub.unsubscribe();
      }
    } catch (e) {
      return { ok: false, error: 'unsubscribe_failed' };
    }
    if (s) {
      var wipeAccount = d.scope === 'account';
      keys(s).forEach(function (k) {
        var alerts = k.indexOf('ds-monitor-push-') === 0 || k === RING;
        var account = wipeAccount && (EXACT.indexOf(k) !== -1 || PREFIXES.some(function (p) { return k.indexOf(p) === 0; }));
        if (alerts || account) {
          try {
            s.removeItem(k);
          } catch (e) {
            /* storage unavailable */
          }
        }
      });
    }
    return { ok: true, endpoint: endpoint };
  }

  window.addEventListener('message', function (e) {
    if (PARENTS.indexOf(e.origin) === -1 || window.parent === window || e.source !== window.parent) return;
    var d = e.data;
    if (!d || d.ds !== TAG || d.v !== 1 || typeof d.id !== 'string' || d.id.length > 64) return;
    var run = d.op === 'state' ? state() : d.op === 'retire' ? retire(d) : Promise.resolve({ ok: false, error: 'unknown_op' });
    run
      .catch(function () {
        return { ok: false, error: 'failed' };
      })
      .then(function (reply) {
        reply.ds = TAG;
        reply.id = d.id;
        e.source.postMessage(reply, e.origin);
      });
  });
})();
