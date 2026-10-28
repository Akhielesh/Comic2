// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import { b64url, generateVapidKeys, type VapidKeys } from '../webpush';
import { resetApnsTokens, type ApnsConfig } from './apns';
import { openEnvelope } from './envelope';
import { fcmConfigFromEnv, resetFcmTokens, type FcmConfig } from './fcm';
import { resetImportedKeys } from './keys';
import { accepts, coarseLaState, collapseFor, deliver, deliverAll, deliverReport, parsePushSub, replacementOf, routerFromEnv, subKey, type PushFaultLine, type PushMsg, type PushSub, type RouterCtx } from './router';
import { recordingFetch, testDeviceKeys, testP8, testServiceAccount, type FixtureResponse, type RecordedCall } from './testKit';

const NID = '8f14e45f-ceea-467f-a0e6-1b7c2e9d0a11';
const NOW = Date.UTC(2026, 9, 28, 2, 14, 0);
const APNS_TOKEN = 'ab'.repeat(32);
const FCM_TOKEN = 'fGx1Q2s3T4u5V6w7X8y9Z0:APA91bH-test_registration_token_0123456789abcdefghijklmnopqrstuvwxyz';
const OAUTH = { status: 200, body: '{"access_token":"ya29.t","expires_in":3599}' };

/** Today's cry alert, as MonitorRoom.pushAlert builds it. */
const cry = (over: Partial<PushMsg> = {}): PushMsg => ({
  type: 'alert',
  sev: 'urgent',
  web: { title: 'Maya is crying', body: 'Nursery cam · 2:14 AM', kind: 'cry', nid: NID, ref: 'e1', inc: 'a1b2c3d4e5f6', at: NOW },
  ttlSec: 300,
  urgency: 'high',
  topic: `cry${NID.slice(0, 8)}`,
  inc: 'a1b2c3d4e5f6',
  q: 812,
  critical: true,
  ...over,
});

let device: { p256dh: string; auth: string; d: string };
let apns: ApnsConfig;
let fcm: FcmConfig;
let vapid: VapidKeys;
/** What the router logged (ctx.log) in this test. */
let faults: PushFaultLine[];

beforeEach(async () => {
  faults = [];
  resetApnsTokens();
  resetFcmTokens();
  resetImportedKeys();
  device = await testDeviceKeys();
  apns = { keyP8: (await testP8()).p8, keyId: 'KEY1234567', teamId: 'TEAM123456', bundle: 'ai.dreamstreamstudio.streamstudio' };
  fcm = fcmConfigFromEnv({ FCM_SA_JSON: (await testServiceAccount()).json })!;
  vapid = await generateVapidKeys();
});

const enc = () => ({ p256dh: device.p256dh, auth: device.auth });
const subs = {
  web: (): PushSub => ({ kind: 'webpush', uid: 'u1', sub: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: enc() } }),
  apns: (over: Partial<PushSub> = {}): PushSub => ({ kind: 'apns', uid: 'u1', dev: 'devA', token: APNS_TOKEN, enc: enc(), ...over }),
  fcm: (over: Partial<PushSub> = {}): PushSub => ({ kind: 'fcm', uid: 'u2', dev: 'devB', token: FCM_TOKEN, enc: enc(), plat: 'android', ...over }),
  la: (over: Partial<PushSub> = {}): PushSub => ({ kind: 'apns-la', uid: 'u1', token: 'cd'.repeat(32), enc: enc(), ...over }),
  voip: (): PushSub => ({ kind: 'apns-voip', uid: 'u1', token: 'ef'.repeat(32), enc: enc() }),
};

/** Apple and Google, answering `answer` (OAuth always succeeds). */
function providers(answer: (call: RecordedCall, n: number) => FixtureResponse = () => ({ status: 200, headers: { 'apns-id': 'X' }, body: '{"name":"m"}' })) {
  let n = 0;
  return recordingFetch((call) => (call.url.includes('oauth2.googleapis.com') ? OAUTH : answer(call, n++)));
}
const sent = (calls: RecordedCall[]) => calls.filter((c) => !c.url.includes('oauth2'));
const ctxWith = (fetcher: typeof fetch, over: Partial<RouterCtx> = {}): RouterCtx => ({ apns, fcm, vapid: async () => vapid, fetcher, now: () => NOW, sleep: async () => undefined, log: (l) => faults.push(l), ...over });

/** What a provider can read: the request body with the sealed `e` values blanked (ciphertext can contain any letters). */
function expectNoLeaks(body: string, words: string[]): void {
  const clear = body.replace(/"e":"[A-Za-z0-9_-]+"/g, '"e":"<sealed>"');
  for (const w of words) expect(clear.includes(w), `provider can read "${w}"`).toBe(false);
}

describe('webpush: unchanged behaviour through the router', () => {
  it('sends the same payload, urgency, TTL and topic the room passes today', async () => {
    const { fetcher, calls } = recordingFetch(() => ({ status: 201 }));
    expect(await deliver(subs.web(), cry(), ctxWith(fetcher))).toBe('ok');
    expect(calls).toHaveLength(1);
    const c = calls[0];
    expect(c.url).toBe('https://fcm.googleapis.com/fcm/send/abc');
    expect(c.headers).toMatchObject({ ttl: '300', urgency: 'high', topic: `cry${NID.slice(0, 8)}`, 'content-encoding': 'aes128gcm' });
    expect(c.headers.authorization).toMatch(/^vapid t=.+, k=/);
  });

  it('the browser decrypts exactly the web payload (names included — Web Push is already end to end)', async () => {
    const seen: Uint8Array[] = [];
    const fetcher = (async (_u: string, init: RequestInit) => {
      seen.push(init.body as Uint8Array);
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;
    await deliver(subs.web(), cry(), ctxWith(fetcher));
    expect(await openEnvelope(b64url(seen[0]), device)).toEqual(cry().web);
  });

  it('410 → gone; 5xx → retry; no VAPID keys or a foreign endpoint → retry with no request', async () => {
    expect(await deliver(subs.web(), cry(), ctxWith(recordingFetch(() => ({ status: 410 })).fetcher))).toBe('gone');
    expect(await deliver(subs.web(), cry(), ctxWith(recordingFetch(() => ({ status: 502 })).fetcher))).toBe('retry');
    const { fetcher, calls } = recordingFetch(() => ({ status: 201 }));
    expect(await deliverReport(subs.web(), cry(), ctxWith(fetcher, { vapid: async () => null }))).toMatchObject({ outcome: 'retry', reason: 'no_vapid' });
    const evil = { ...subs.web(), sub: { endpoint: 'https://169.254.169.254/latest', keys: enc() } };
    expect(await deliverReport(evil, cry(), ctxWith(fetcher))).toMatchObject({ outcome: 'retry', reason: 'endpoint_not_allowed' });
    expect(calls).toHaveLength(0);
  });
});

describe('dormant until native tokens and secrets exist', () => {
  it('native kinds make no request and keep the token while the secrets are unset', async () => {
    const { fetcher, calls } = providers();
    const ctx: RouterCtx = { fetcher, vapid: async () => vapid };
    for (const s of [subs.apns(), subs.fcm(), subs.voip()]) expect(await deliverReport(s, s.kind === 'apns-voip' ? { ...cry(), type: 'call', call: { id: 'c1' } } : cry(), ctx), s.kind).toMatchObject({ outcome: 'retry' });
    expect(await deliverReport(subs.la(), { type: 'la', sev: 'info', ttlSec: 60, la: { event: 'update', state: { m: 'calm', ms: 1 } } }, ctx)).toMatchObject({ outcome: 'retry', reason: 'unconfigured' });
    expect(calls).toHaveLength(0);
  });

  it('routerFromEnv: nothing native without secrets; flags read from vars', async () => {
    expect(routerFromEnv({})).toMatchObject({ apns: null, fcm: null, iosVia: 'direct', critical: false, laSealed: false, voip: false });
    const sa = (await testServiceAccount()).json;
    const r = routerFromEnv({ APNS_KEY_P8: apns.keyP8, APNS_KEY_ID: 'KEY1234567', APNS_TEAM_ID: 'TEAM123456', FCM_SA_JSON: sa, PUSH_IOS_VIA: 'fcm', PUSH_CRITICAL_ALERTS: '1' });
    expect(r.apns?.teamId).toBe('TEAM123456');
    expect(r.fcm?.projectId).toBe('dreamstream-test');
    expect(r).toMatchObject({ iosVia: 'fcm', critical: true });
  });

  it('VoIP stays off until Phase 1.1 even with keys', async () => {
    const { fetcher, calls } = providers();
    expect(await deliverReport(subs.voip(), { ...cry(), type: 'call', call: { id: 'c1' } }, ctxWith(fetcher))).toMatchObject({ outcome: 'retry', reason: 'dormant' });
    expect(calls).toHaveLength(0);
    expect(await deliver(subs.voip(), { ...cry(), type: 'call', call: { id: 'c1' } }, ctxWith(fetcher, { voip: true }))).toBe('ok');
    const body = JSON.parse(sent(calls)[0].body);
    expect(body.call).toBe('c1');
    expect(sent(calls)[0].headers['apns-push-type']).toBe('voip');
  });
});

describe('a message-shape bug of ours never prunes a token', () => {
  it('a call message with no call id keeps the VoIP token, sends nothing and logs push_fatal', async () => {
    const { fetcher, calls } = providers();
    const webOnly: PushMsg = { type: 'call', sev: 'urgent', web: { kind: 'call', call: 'c1', title: 'Mom is calling' }, ttlSec: 30 };
    expect(accepts(subs.voip(), webOnly)).toBe(true);
    expect(await deliverReport(subs.voip(), webOnly, ctxWith(fetcher, { voip: true }))).toMatchObject({ outcome: 'retry', transport: 'apns', reason: 'bad_message', fatal: true });
    expect(await deliverReport(subs.voip(), { ...webOnly, call: { id: '' } }, ctxWith(fetcher, { voip: true }))).toMatchObject({ outcome: 'retry', reason: 'bad_message' });
    const { gone } = await deliverAll([subs.voip(), subs.voip()], webOnly, ctxWith(fetcher, { voip: true }));
    expect(gone).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(faults.map((f) => `${f.evt}:${f.kind}:${f.reason}`)).toEqual(Array(4).fill('push_fatal:apns-voip:bad_message'));
  });

  it('a VoIP token that is itself malformed still prunes', async () => {
    const { fetcher, calls } = providers();
    expect(await deliver({ ...subs.voip(), token: 'zz' }, { ...cry(), type: 'call', call: { id: 'c1' } }, ctxWith(fetcher, { voip: true }))).toBe('gone');
    expect(calls).toHaveLength(0);
  });
});

describe('APNs alerts', () => {
  it('Apple sees generic words, the urgency, an opaque incident id and ciphertext — the device sees everything', async () => {
    const { fetcher, calls } = providers();
    const rep = await deliverReport(subs.apns(), cry(), ctxWith(fetcher));
    expect(rep).toMatchObject({ outcome: 'ok', transport: 'apns', sealed: true });
    const c = sent(calls)[0];
    expect(c.headers).toMatchObject({ 'apns-push-type': 'alert', 'apns-priority': '10', 'apns-collapse-id': 'a1b2c3d4e5f6', 'apns-expiration': String(NOW / 1000 + 300) });
    const p = JSON.parse(c.body);
    expect(p.aps).toEqual({ alert: { title: 'DreamStream', body: 'Nursery alert' }, 'interruption-level': 'time-sensitive', 'mutable-content': 1, category: 'DS_URGENT', sound: 'default' });
    expect(p).toMatchObject({ s: 'u', i: 'a1b2c3d4e5f6', q: '812' });
    // The raw payload names no one and nothing (outside the ciphertext).
    expectNoLeaks(c.body, ['Maya', 'crying', 'cry', NID, 'Nursery cam']);
    expect(await openEnvelope(p.e, device)).toMatchObject({ title: 'Maya is crying', body: 'Nursery cam · 2:14 AM', kind: 'cry' });
  });

  it('severity → interruption level, category, sound and priority', async () => {
    const shape = async (m: PushMsg, ctx: Partial<RouterCtx> = {}) => {
      const { fetcher, calls } = providers();
      await deliver(subs.apns(), m, ctxWith(fetcher, ctx));
      const c = sent(calls)[0];
      return { aps: JSON.parse(c.body).aps, priority: c.headers['apns-priority'] };
    };
    expect(await shape(cry({ critical: false }), { critical: true })).toMatchObject({ aps: { 'interruption-level': 'time-sensitive' } });
    expect(await shape(cry(), { critical: true })).toMatchObject({ aps: { 'interruption-level': 'critical', sound: { critical: 1 } } });
    expect(await shape(cry({ category: 'DS_URGENT_VIEW' }))).toMatchObject({ aps: { category: 'DS_URGENT_VIEW' } });
    expect(await shape(cry({ sev: 'warn', critical: false }))).toMatchObject({ aps: { 'interruption-level': 'active', category: 'DS_WARN', sound: 'default' }, priority: '10' });
    const info = await shape(cry({ sev: 'info', critical: false }));
    expect(info).toMatchObject({ aps: { 'interruption-level': 'passive', alert: { body: 'Nursery update' } }, priority: '5' });
    expect(info.aps.sound).toBeUndefined();
    expect(info.aps.category).toBeUndefined();
  });

  it('without an incident the collapse id is a hash of the topic, never the kind', async () => {
    const id = await collapseFor(cry({ inc: null }));
    expect(id).toMatch(/^h[0-9a-f]{20}$/);
    expect(id).toBe(await collapseFor(cry({ inc: null })));
    expect(id).not.toBe(await collapseFor(cry({ inc: null, topic: `noise${NID.slice(0, 8)}` })));
  });

  it('a device with no envelope key still gets the generic alert (never nothing)', async () => {
    const { fetcher, calls } = providers();
    const rep = await deliverReport(subs.apns({ enc: null }), cry(), ctxWith(fetcher));
    expect(rep).toMatchObject({ outcome: 'ok', sealed: false });
    const p = JSON.parse(sent(calls)[0].body);
    expect(p.e).toBeUndefined();
    expect(p.aps['mutable-content']).toBeUndefined();
    expect(p.aps.alert.body).toBe('Nursery alert');
  });

  it('an oversize envelope drops the glance first, then falls back to generic — still delivered', async () => {
    const big = cry({ inner: { title: 'Maya is crying', body: 'x', g: { pad: 'g'.repeat(1200) } } });
    const { fetcher, calls } = providers();
    expect(await deliverReport(subs.apns(), big, ctxWith(fetcher))).toMatchObject({ outcome: 'ok', sealed: true });
    expect(await openEnvelope(JSON.parse(sent(calls)[0].body).e, device)).toEqual({ title: 'Maya is crying', body: 'x' });
    const huge = cry({ inner: { title: 't'.repeat(2000), body: 'x' } });
    expect(await deliverReport(subs.apns(), huge, ctxWith(fetcher))).toMatchObject({ outcome: 'ok', sealed: false });
  });

  it('urgent alerts get one quick re-send on a transient failure; others do not', async () => {
    const flaky = () => providers((_c, n) => (n === 0 ? { status: 503, headers: { 'apns-id': 'A' }, body: '{"reason":"ServiceUnavailable"}' } : { status: 200, headers: { 'apns-id': 'B' } }));
    let p = flaky();
    expect(await deliverReport(subs.apns(), cry(), ctxWith(p.fetcher))).toMatchObject({ outcome: 'ok', tries: 2 });
    p = flaky();
    expect(await deliverReport(subs.apns(), cry({ sev: 'warn' }), ctxWith(p.fetcher))).toMatchObject({ outcome: 'retry', tries: 1, status: 503 });
  });

  it('gone prunes; a token re-registered after APNs saw it dead is kept; our own errors never prune', async () => {
    const dead = () => providers(() => ({ status: 410, headers: { 'apns-id': 'A' }, body: '{"reason":"Unregistered","timestamp":1761600000000}' })).fetcher;
    expect(await deliver(subs.apns({ at: 1761500000000 }), cry(), ctxWith(dead()))).toBe('gone');
    expect(await deliver(subs.apns({ at: 1761700000000 }), cry(), ctxWith(dead()))).toBe('retry');
    const ours = providers(() => ({ status: 400, headers: { 'apns-id': 'A' }, body: '{"reason":"BadCollapseId"}' })).fetcher;
    expect(await deliverReport(subs.apns(), cry(), ctxWith(ours))).toMatchObject({ outcome: 'retry', fatal: true, reason: 'BadCollapseId' });
  });

  it('a watch token goes to the watch app topic', async () => {
    const { fetcher, calls } = providers();
    await deliver(subs.apns({ plat: 'watchos' }), cry(), ctxWith(fetcher));
    expect(sent(calls)[0].headers['apns-topic']).toBe('ai.dreamstreamstudio.streamstudio.watchkitapp');
  });

  it('on the FCM fallback a bare APNs token is kept but not sent', async () => {
    const { fetcher, calls } = providers();
    expect(await deliverReport(subs.apns(), cry(), ctxWith(fetcher, { iosVia: 'fcm' }))).toMatchObject({ outcome: 'retry', reason: 'ios_via_fcm' });
    expect(calls).toHaveLength(0);
  });
});

describe('config errors never prune: one wrong secret or var must not wipe the registry', () => {
  it('APNs DeviceTokenNotForTopic (a wrong APNS_BUNDLE) keeps every iPhone and watch token, and logs push_config', async () => {
    const { fetcher, calls } = providers(() => ({ status: 400, headers: { 'apns-id': 'A' }, body: '{"reason":"DeviceTokenNotForTopic"}' }));
    const three = [subs.apns(), subs.apns({ token: 'cd'.repeat(32), dev: 'devC' }), subs.apns({ token: 'ef'.repeat(32), dev: 'devW', plat: 'watchos' })];
    const { reports, gone } = await deliverAll(three, cry(), ctxWith(fetcher, { apns: { ...apns, bundle: 'ai.dreamstream.typo' } }));
    expect(sent(calls)).toHaveLength(3);
    expect(gone).toHaveLength(0);
    for (const r of reports) expect(r.report).toMatchObject({ outcome: 'retry', transport: 'apns', status: 400, reason: 'DeviceTokenNotForTopic', fatal: true, config: true });
    // One line per device, saying which bundle we sent as — and nothing that identifies the device or the family.
    expect(faults).toHaveLength(3);
    const line = { evt: 'push_config', kind: 'apns', transport: 'apns', status: 400, reason: 'DeviceTokenNotForTopic', bundle: 'ai.dreamstream.typo' };
    expect(faults.filter((f) => !f.plat)).toEqual([line, line]);
    expect(faults.filter((f) => f.plat)).toEqual([{ ...line, plat: 'watchos' }]);
    const logged = JSON.stringify(faults);
    for (const secret of [APNS_TOKEN, 'cd'.repeat(32), 'ef'.repeat(32), 'u1', 'devC', 'devW', 'Maya']) expect(logged.includes(secret), secret).toBe(false);
  });

  it('FCM SENDER_ID_MISMATCH (a service account from another Firebase project) keeps every Android and Wear token, and logs push_config', async () => {
    const other = fcmConfigFromEnv({ FCM_SA_JSON: (await testServiceAccount('other-project')).json })!;
    const { fetcher, calls } = providers(() => ({
      status: 403,
      body: '{"error":{"code":403,"message":"SenderId mismatch","status":"PERMISSION_DENIED","details":[{"@type":"type.googleapis.com/google.firebase.fcm.v1.FcmError","errorCode":"SENDER_ID_MISMATCH"}]}}',
    }));
    const two = [subs.fcm(), subs.fcm({ token: `${FCM_TOKEN}x`, dev: 'devWear', plat: 'wearos' })];
    const { reports, gone } = await deliverAll(two, cry(), ctxWith(fetcher, { fcm: other }));
    expect(sent(calls)).toHaveLength(2);
    expect(gone).toHaveLength(0);
    for (const r of reports) expect(r.report).toMatchObject({ outcome: 'retry', transport: 'fcm', status: 403, reason: 'SENDER_ID_MISMATCH', fatal: true, config: true });
    expect(faults.map((f) => `${f.evt}:${f.project}:${f.plat}`).sort()).toEqual(['push_config:other-project:android', 'push_config:other-project:wearos']);
    expect(JSON.stringify(faults).includes(FCM_TOKEN)).toBe(false);
  });

  it('an iPhone Live Activity on the FCM fallback: a sender mismatch keeps it too', async () => {
    const { fetcher } = providers(() => ({
      status: 403,
      body: '{"error":{"code":403,"status":"PERMISSION_DENIED","details":[{"@type":"type.googleapis.com/google.firebase.fcm.v1.FcmError","errorCode":"SENDER_ID_MISMATCH"}]}}',
    }));
    const rep = await deliverReport(subs.la({ fcm: FCM_TOKEN }), { type: 'la', sev: 'info', ttlSec: 60, la: { event: 'update', state: { m: 'calm', ms: 1 } } }, ctxWith(fetcher, { iosVia: 'fcm' }));
    expect(rep).toMatchObject({ outcome: 'retry', transport: 'fcm', config: true });
  });

  it('a Live Activity token and a topic mismatch: kept too', async () => {
    const { fetcher } = providers(() => ({ status: 400, headers: { 'apns-id': 'A' }, body: '{"reason":"TopicDisallowed"}' }));
    const rep = await deliverReport(subs.la(), { type: 'la', sev: 'info', ttlSec: 60, la: { event: 'update', state: { m: 'calm', ms: 1 } } }, ctxWith(fetcher));
    expect(rep).toMatchObject({ outcome: 'retry', config: true, reason: 'TopicDisallowed' });
    expect(faults.map((f) => `${f.evt}:${f.kind}`)).toEqual(['push_config:apns-la']);
  });

  it('with no ctx.log, a fault is one JSON console.error line', async () => {
    const { fetcher } = providers(() => ({ status: 400, headers: { 'apns-id': 'A' }, body: '{"reason":"DeviceTokenNotForTopic"}' }));
    const lines: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void lines.push(a.map(String).join(' '));
    try {
      expect(await deliver(subs.apns(), cry(), ctxWith(fetcher, { log: undefined }))).toBe('retry');
    } finally {
      console.error = orig;
    }
    expect(lines.map((l) => JSON.parse(l))).toEqual([{ evt: 'push_config', kind: 'apns', transport: 'apns', status: 400, reason: 'DeviceTokenNotForTopic', bundle: 'ai.dreamstreamstudio.streamstudio' }]);
  });

  it('a logger that throws never breaks delivery', async () => {
    const { fetcher } = providers(() => ({ status: 400, headers: { 'apns-id': 'A' }, body: '{"reason":"BadTopic"}' }));
    const rep = await deliverReport(subs.apns(), cry(), ctxWith(fetcher, { log: () => { throw new Error('log sink down'); } }));
    expect(rep).toMatchObject({ outcome: 'retry', config: true, reason: 'BadTopic' });
  });

  it('our request errors are logged as push_fatal (kept, not config); dead tokens, busy providers and dormant kinds log nothing', async () => {
    const ours = providers(() => ({ status: 400, headers: { 'apns-id': 'A' }, body: '{"reason":"BadCollapseId"}' })).fetcher;
    expect(await deliverReport(subs.apns(), cry(), ctxWith(ours))).toMatchObject({ outcome: 'retry', fatal: true, reason: 'BadCollapseId' });
    expect((await deliverReport(subs.apns(), cry(), ctxWith(ours))).config).toBeUndefined();
    expect(faults.map((f) => f.evt)).toEqual(['push_fatal', 'push_fatal']);
    faults = [];
    const dead = providers(() => ({ status: 410, headers: { 'apns-id': 'A' }, body: '{"reason":"Unregistered"}' })).fetcher;
    expect(await deliver(subs.apns(), cry(), ctxWith(dead))).toBe('gone');
    const busy = providers(() => ({ status: 503, headers: { 'apns-id': 'A' }, body: '{"reason":"ServiceUnavailable"}' })).fetcher;
    expect(await deliver(subs.apns(), cry(), ctxWith(busy))).toBe('retry');
    expect(await deliver(subs.fcm(), cry(), { fetcher: busy, log: (l) => faults.push(l) })).toBe('retry');
    expect(faults).toEqual([]);
  });
});

describe('FCM', () => {
  it('Android/Wear: data only {e, s, i, q}, high priority, TTL and collapse key — Google sees no text', async () => {
    const { fetcher, calls } = providers();
    expect(await deliverReport(subs.fcm(), cry(), ctxWith(fetcher))).toMatchObject({ outcome: 'ok', transport: 'fcm', sealed: true });
    const msg = JSON.parse(sent(calls)[0].body).message;
    expect(Object.keys(msg.data).sort()).toEqual(['e', 'i', 'q', 's']);
    expect(msg.data).toMatchObject({ s: 'u', i: 'a1b2c3d4e5f6', q: '812' });
    expect(msg.android).toEqual({ priority: 'HIGH', ttl: '300s', collapse_key: 'a1b2c3d4e5f6' });
    expect(msg.notification).toBeUndefined();
    expectNoLeaks(sent(calls)[0].body, ['Maya', 'cry', NID]);
    expect(await openEnvelope(msg.data.e, device)).toMatchObject({ title: 'Maya is crying' });
  });

  it('routine updates go at normal priority', async () => {
    const { fetcher, calls } = providers();
    await deliver(subs.fcm(), cry({ sev: 'care', critical: false }), ctxWith(fetcher));
    expect(JSON.parse(sent(calls)[0].body).message.android.priority).toBe('NORMAL');
  });

  it('an iPhone on the FCM fallback gets the same APNs alert inside an apns block', async () => {
    const { fetcher, calls } = providers();
    await deliver(subs.fcm({ plat: 'ios' }), cry(), ctxWith(fetcher, { iosVia: 'fcm' }));
    const msg = JSON.parse(sent(calls)[0].body).message;
    expect(msg.android).toBeUndefined();
    expect(msg.apns.headers).toMatchObject({ 'apns-push-type': 'alert', 'apns-priority': '10', 'apns-collapse-id': 'a1b2c3d4e5f6' });
    expect(msg.apns.payload.aps).toMatchObject({ alert: { title: 'DreamStream', body: 'Nursery alert' }, 'mutable-content': 1, category: 'DS_URGENT' });
    expect(await openEnvelope(msg.apns.payload.e, device)).toMatchObject({ title: 'Maya is crying' });
  });

  it('UNREGISTERED prunes', async () => {
    const { fetcher } = providers(() => ({ status: 404, body: '{"error":{"code":404,"status":"NOT_FOUND","details":[{"@type":"type.googleapis.com/google.firebase.fcm.v1.FcmError","errorCode":"UNREGISTERED"}]}}' }));
    expect(await deliverReport(subs.fcm(), cry(), ctxWith(fetcher))).toMatchObject({ outcome: 'gone', reason: 'UNREGISTERED' });
  });
});

describe('Live Activities', () => {
  const state = { m: 'crying', ms: NOW - 20_000, nm: "Maya's room", n: NID, sl: { p: 'awake', s: 1, min: 3, w: 2 }, al: { id: 'a1b2c3d4e5f6', k: 'cry', st: 'open', by: 'Dad' }, db: 61 };

  it('in clear, only the coarse enum leaves: mood, since, sleep phase, alert state', async () => {
    expect(coarseLaState(state)).toEqual({ m: 'crying', ms: NOW - 20_000, sl: { p: 'awake' }, al: { st: 'open' } });
    expect(coarseLaState({ m: 'evil', ms: 'x', sl: { p: 'zz' } })).toEqual({ m: 'unknown', ms: 0 });
    const { fetcher, calls } = providers();
    await deliver(subs.la(), { type: 'la', sev: 'urgent', ttlSec: 600, la: { event: 'update', state, staleSec: 900, alert: true } }, ctxWith(fetcher));
    const c = sent(calls)[0];
    expect(c.headers).toMatchObject({ 'apns-push-type': 'liveactivity', 'apns-priority': '10', 'apns-topic': 'ai.dreamstreamstudio.streamstudio.push-type.liveactivity' });
    const aps = JSON.parse(c.body).aps;
    expect(aps).toEqual({ timestamp: NOW / 1000, event: 'update', 'content-state': coarseLaState(state), 'stale-date': NOW / 1000 + 900, alert: { title: 'DreamStream', body: 'Nursery alert' } });
    // (The mood word itself is the coarse enum D3 allows in clear; the alert kind is not.)
    expectNoLeaks(c.body, ['Maya', NID, 'Dad', 'a1b2c3d4e5f6', '"k"', '"db"', '"nm"']);
  });

  it('sealed state once spike S3 passes', async () => {
    const { fetcher, calls } = providers();
    expect(await deliverReport(subs.la(), { type: 'la', sev: 'info', ttlSec: 600, la: { event: 'update', state } }, ctxWith(fetcher, { laSealed: true }))).toMatchObject({ sealed: true });
    const cs = JSON.parse(sent(calls)[0].body).aps['content-state'];
    expect(Object.keys(cs)).toEqual(['e']);
    expect(await openEnvelope(cs.e, device)).toEqual(state);
    expect(sent(calls)[0].headers['apns-priority']).toBe('5');
  });

  it('push-to-start goes only to start tokens, with attributes and the generic alert iOS requires', async () => {
    const start: PushMsg = { type: 'la', sev: 'info', ttlSec: 600, la: { event: 'start', state } };
    expect(accepts(subs.la(), start)).toBe(false);
    expect(accepts(subs.la({ la: 'start' }), start)).toBe(true);
    const { fetcher, calls } = providers();
    await deliver(subs.la({ la: 'start' }), start, ctxWith(fetcher));
    expect(JSON.parse(sent(calls)[0].body).aps).toMatchObject({ event: 'start', 'attributes-type': 'NurseryAttributes', attributes: {}, alert: { title: 'DreamStream', body: 'Nursery monitor is on' } });
  });

  it('rides FCM (live_activity_token) when iPhones are on the fallback', async () => {
    const { fetcher, calls } = providers();
    const rep = await deliverReport(subs.la({ fcm: FCM_TOKEN }), { type: 'la', sev: 'info', ttlSec: 600, la: { event: 'update', state } }, ctxWith(fetcher, { iosVia: 'fcm' }));
    expect(rep).toMatchObject({ outcome: 'ok', transport: 'fcm' });
    const msg = JSON.parse(sent(calls)[0].body).message;
    expect(msg).toMatchObject({ token: FCM_TOKEN, apns: { live_activity_token: 'cd'.repeat(32), headers: { 'apns-priority': '5' } } });
    expect(msg.apns.payload.aps['content-state']).toEqual(coarseLaState(state));
  });
});

describe('the acknowledgement replacement', () => {
  const ack = () => replacementOf(cry({ web: { ...cry().web, act: 'secret-act' }, inner: { title: 'Maya is crying', body: 'x', act: 'secret-act' } }), { title: 'Dad is on it', body: 'Maya is crying · 2:14 AM' });

  it('web: same topic and tag, no action token, a non-urgent kind, marked replace', async () => {
    const m = ack();
    expect(m).toMatchObject({ replace: true, sev: 'info', urgency: 'normal', topic: `cry${NID.slice(0, 8)}`, inc: 'a1b2c3d4e5f6' });
    expect(m.web).toMatchObject({ title: 'Dad is on it', tag: `${NID}-cry`, kind: 'ack', of: 'cry', replace: true });
    expect(m.web!.act).toBeUndefined();
    expect(m.inner!.act).toBeUndefined();
    const { fetcher, calls } = recordingFetch(() => ({ status: 201 }));
    await deliver(subs.web(), m, ctxWith(fetcher));
    expect(calls[0].headers).toMatchObject({ topic: `cry${NID.slice(0, 8)}`, urgency: 'normal' });
  });

  it('APNs: passive, silent, same collapse id; FCM: same collapse key', async () => {
    const a = providers();
    await deliver(subs.apns(), ack(), ctxWith(a.fetcher));
    const c = sent(a.calls)[0];
    expect(c.headers['apns-collapse-id']).toBe('a1b2c3d4e5f6');
    const p = JSON.parse(c.body);
    expect(p.aps).toMatchObject({ 'interruption-level': 'passive', alert: { body: 'Nursery update' } });
    expect(p.aps.sound).toBeUndefined();
    expect(p.aps.category).toBeUndefined();
    expect(await openEnvelope(p.e, device)).toMatchObject({ title: 'Dad is on it', replace: true });
    const f = providers();
    await deliver(subs.fcm(), ack(), ctxWith(f.fetcher));
    expect(JSON.parse(sent(f.calls)[0].body).message.android).toMatchObject({ collapse_key: 'a1b2c3d4e5f6', priority: 'HIGH' });
  });
});

describe('deliverAll', () => {
  it('fans out by kind, skips subscriptions that do not take the message, and lists the ones to prune', async () => {
    const { fetcher } = recordingFetch((call) => {
      if (call.url.includes('oauth2')) return OAUTH;
      if (call.url.includes('api.push.apple.com')) return { status: 410, headers: { 'apns-id': 'A' }, body: '{"reason":"Unregistered"}' };
      if (call.url.includes('fcm.googleapis.com/v1')) return { status: 200, body: '{"name":"m"}' };
      return { status: 201 };
    });
    const all = [subs.web(), subs.apns(), subs.fcm(), subs.la(), subs.voip()];
    const { reports, gone } = await deliverAll(all, cry(), ctxWith(fetcher));
    expect(reports.map((r) => `${r.sub.kind}:${r.report.outcome}`)).toEqual(['webpush:ok', 'apns:gone', 'fcm:ok']);
    expect(gone.map(subKey)).toEqual([`apns:${APNS_TOKEN}`]);
  });

  it('builds a message per recipient when given a function (per-person action tokens)', async () => {
    const { fetcher, calls } = providers();
    await deliverAll([subs.apns(), subs.fcm()], (s) => cry({ inner: { title: 'Maya is crying', body: 'x', act: `act-for-${s.uid}` } }), ctxWith(fetcher));
    const opened = await Promise.all(sent(calls).map(async (c) => {
      const b = JSON.parse(c.body);
      return (await openEnvelope(b.e ?? b.message.data.e, device)) as { act: string };
    }));
    expect(opened.map((o) => o.act).sort()).toEqual(['act-for-u1', 'act-for-u2']);
  });

  it('a per-recipient builder that throws skips only that device', async () => {
    const { fetcher } = providers();
    const { reports } = await deliverAll([subs.apns(), subs.fcm()], (s) => {
      if (s.uid === 'u1') throw new Error('no act key');
      return cry();
    }, ctxWith(fetcher));
    expect(reports.map((r) => `${r.sub.uid}:${r.report.outcome}`)).toEqual(['u1:retry', 'u2:ok']);
  });

  it('never throws into the alert path', async () => {
    const boom = (async () => {
      throw new Error('boom');
    }) as unknown as typeof fetch;
    const { reports } = await deliverAll([subs.web(), subs.apns(), subs.fcm()], cry(), ctxWith(boom));
    expect(reports.every((r) => r.report.outcome === 'retry')).toBe(true);
  });
});

describe('parsePushSub (registration)', () => {
  it('accepts well-formed registrations of every kind', () => {
    expect(parsePushSub({ kind: 'apns', token: APNS_TOKEN, enc: enc(), env: 'sandbox', plat: 'ios' }, { uid: 'u', dev: 'd' }, 5)).toEqual({ kind: 'apns', uid: 'u', dev: 'd', at: 5, token: APNS_TOKEN, enc: enc(), env: 'sandbox', plat: 'ios' });
    expect(parsePushSub({ kind: 'fcm', token: FCM_TOKEN, enc: enc(), plat: 'wearos' }, { uid: 'u' })).toMatchObject({ kind: 'fcm', plat: 'wearos' });
    expect(parsePushSub({ kind: 'apns-la', token: APNS_TOKEN, la: 'start', fcm: FCM_TOKEN }, { uid: 'u' })).toMatchObject({ la: 'start', fcm: FCM_TOKEN });
    expect(parsePushSub({ kind: 'webpush', sub: { endpoint: 'https://web.push.apple.com/x', keys: enc() } }, { uid: 'u' })).toMatchObject({ kind: 'webpush' });
  });

  it('stores padded base64url keys in canonical form, so they work on every alert', async () => {
    const padded = { p256dh: `${device.p256dh}=`, auth: `${device.auth}==` };
    const web = parsePushSub({ kind: 'webpush', sub: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: padded } }, { uid: 'u1' })!;
    expect(web.sub!.keys).toEqual(enc());
    const native = parsePushSub({ kind: 'apns', token: APNS_TOKEN, enc: padded }, { uid: 'u1' })!;
    expect(native.enc).toEqual(enc());
    const { fetcher, calls } = providers();
    expect(await deliver(web, cry(), ctxWith(fetcher))).toBe('ok');
    expect(await deliverReport(native, cry(), ctxWith(fetcher))).toMatchObject({ outcome: 'ok', sealed: true });
    expect(calls).toHaveLength(2);
  });

  it('refuses tokens of the wrong shape, bad keys, foreign endpoints and unknown kinds', () => {
    expect(parsePushSub({ kind: 'apns', token: FCM_TOKEN }, { uid: 'u' })).toBeNull();
    expect(parsePushSub({ kind: 'fcm', token: 'short' }, { uid: 'u' })).toBeNull();
    expect(parsePushSub({ kind: 'apns', token: APNS_TOKEN, enc: { p256dh: 'x', auth: 'y' } }, { uid: 'u' })).toBeNull();
    expect(parsePushSub({ kind: 'webpush', sub: { endpoint: 'https://evil.example/x', keys: enc() } }, { uid: 'u' })).toBeNull();
    expect(parsePushSub({ kind: 'sms', token: APNS_TOKEN }, { uid: 'u' })).toBeNull();
    expect(parsePushSub(null, { uid: 'u' })).toBeNull();
  });

  it('a stored sub with a bad token prunes itself instead of failing forever', async () => {
    const { fetcher, calls } = providers();
    expect(await deliver(subs.apns({ token: 'zz' }), cry(), ctxWith(fetcher))).toBe('gone');
    expect(calls).toHaveLength(0);
  });
});
