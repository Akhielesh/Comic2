/**
 * One push router for every device kind (ADR 0006 D3, Phase 0 WS-3).
 *
 *   webpush    browsers / PWA       Web Push + VAPID, payload exactly as today
 *   apns       iPhone (and watch)   APNs alert, `mutable-content`, the NSE decrypts `e`
 *   apns-la    iPhone Live Activity ActivityKit push (push-to-start or update)
 *   apns-voip  iPhone calls         PushKit — accepted, dormant until Phase 1.1
 *   fcm        Android and Wear OS  FCM data message; iPhones on the probe fallback get an apns block
 *
 * A room builds one transport-neutral `PushMsg` and calls `deliver(sub, msg, ctx)` per
 * subscription. The answer is `ok | gone | retry`: prune on `gone`, keep on anything else.
 * `deliverReport` says more (which transport, the provider's status and reason, and
 * whether the failure was ours — `fatal`, and `config` when the provider says the token
 * isn't for our app or project).
 *
 * **Only a dead token prunes.** `gone` means the provider said this token is invalid or
 * unregistered. A wrong topic, bundle or Firebase project (`config`), a bad payload or a
 * refused key (`fatal`) would fail the same way for every device, so the token is kept
 * and the router logs one `push_config` / `push_fatal` line per send (`ctx.log`; no token,
 * no uid, no names) — the owner fixes the config and the next alert gets through.
 *
 * **Dormant until native tokens exist.** Native kinds need both a registered token and
 * the provider secrets; without them they answer `retry` with reason `unconfigured`
 * and make no request. The `webpush` path calls `sendWebPush` with the same payload,
 * VAPID subject, urgency, TTL and topic as the rooms do today, so moving a room onto
 * the router changes nothing for browsers.
 *
 * **Privacy.** Apple and Google only ever see: generic words ("DreamStream" /
 * "Nursery alert"), the urgency (`s`), an opaque incident id (`i`), the glance sequence
 * (`q`), timing, and the sealed envelope `e` (RFC 8291 to the device's own key, see
 * envelope.ts). Collapse ids are the incident id or a hash — never a kind or a name.
 * A Live Activity's clear-text state is cut down to the coarse enum D3 allows.
 *
 * **Safety.** An oversize envelope falls back to a smaller one, then to the generic
 * alert — never to nothing. Urgent native alerts get one quick re-send on a transient
 * failure. Nothing here throws into the room's alert path.
 *
 * Wiring (WS-9 MonitorRoom, WS-10 UserLine):
 *
 *   const ctx = routerFromEnv(env, { vapid: () => vapidKeysFor(env.MONITOR_ROOM) });
 *   const msg: PushMsg = { type: 'alert', sev, web: payload, ttlSec, urgency, topic, inc, q };
 *   const { gone } = await deliverAll(subs, (s) => ({ ...msg, inner: { ...payload, act: actFor(s.uid) } }), ctx);
 *   // prune `gone` by subKey(); on acknowledgement: deliverAll(others, replacementOf(msg, text), ctx)
 */
import { isAllowedPushEndpoint, sendWebPush, type PushSubscriptionJSONLike, type VapidKeys } from '../webpush';
import { apnsAlertPayload, apnsConfigFromEnv, apnsLiveActivityPayload, isApnsToken, sendApns, type ApnsConfig, type ApnsEnv, type ApnsResult, type Interruption } from './apns';
import { EnvelopeError, normalizePushKeys, sealForDevice, validPushKeys, type PushInner, type PushKeys } from './envelope';
import { fcmConfigFromEnv, isFcmToken, sendFcm, type FcmConfig, type FcmResult } from './fcm';
import type { SendOutcome } from './types';

export type PushKind = 'webpush' | 'apns' | 'apns-la' | 'apns-voip' | 'fcm';
export const PUSH_KINDS: readonly PushKind[] = ['webpush', 'apns', 'apns-la', 'apns-voip', 'fcm'];

/** One place a person's device receives pushes. */
export interface PushSub {
  kind: PushKind;
  uid: string;
  /** The registering device's id (devId); absent for legacy web subscriptions. */
  dev?: string | null;
  /** webpush: the browser's subscription. */
  sub?: PushSubscriptionJSONLike;
  /** Native: APNs device/activity token (hex) or FCM registration token. */
  token?: string;
  /** Native: the RFC 8291 key pair the device generated for the envelope. Without it the device gets generic text only. */
  enc?: PushKeys | null;
  /** APNs: the environment that minted the token (debug builds: sandbox). */
  env?: ApnsEnv;
  /** fcm: the platform behind the token (`ios` = an iPhone on the FCM fallback). apns: `watchos` = straight to the watch. */
  plat?: 'ios' | 'android' | 'wearos' | 'watchos';
  /** apns-la: a push-to-start token, or one activity's update token (default). */
  la?: 'start' | 'update';
  /** apns-la on the FCM fallback: the iPhone's FCM registration token. */
  fcm?: string;
  /** Registered at (ms). A 410 that APNs dates before this doesn't prune it. */
  at?: number;
}

export type Sev = 'urgent' | 'warn' | 'info' | 'care';

/** What to say, transport-neutral. Build one per alert (or per recipient, for `act`). */
export interface PushMsg {
  type: 'alert' | 'call' | 'la';
  sev: Sev;
  /** The Web Push payload, sent exactly as given (the service worker's contract). */
  web?: Record<string, unknown>;
  /** What native devices decrypt (names are fine here — it's sealed). Defaults to `web`. */
  inner?: PushInner;
  /** How long providers keep trying (s). */
  ttlSec: number;
  /** Web Push urgency (default: high for urgent, normal otherwise). */
  urgency?: 'very-low' | 'low' | 'normal' | 'high';
  /** Web Push topic. Native providers only ever see a hash of it. */
  topic?: string;
  /** Incident id (opaque): the APNs collapse id, the FCM collapse key, `i`. */
  inc?: string | null;
  /** Glance sequence (`q`). */
  q?: number;
  /** The acknowledgement replacement ("Dad's on it"): quiet, same collapse id / tag. */
  replace?: boolean;
  /** APNs category (default DS_URGENT / DS_WARN by severity; viewers: DS_URGENT_VIEW). */
  category?: string;
  /** Opaque notification thread (never a name). */
  thread?: string;
  /** Qualifies for a Critical Alert (smoke/CO, glass, crib exit, unanswered cry) — used only once entitled. */
  critical?: boolean;
  /** type 'la': the Live Activity event. `state` is reduced to the coarse enum unless sealed state is on. */
  la?: { event: 'start' | 'update' | 'end'; state: Record<string, unknown>; staleSec?: number; dismissAt?: number; alert?: boolean };
  /** type 'call'. */
  call?: { id: string };
}

export interface RouterCtx {
  /** VAPID keys (push/vapidCache.ts `vapidKeysFor`). */
  vapid?: () => Promise<VapidKeys | null>;
  vapidSubject?: string;
  apns?: ApnsConfig | null;
  fcm?: FcmConfig | null;
  /** The recorded APNs probe decision: `direct` (default) or `fcm` (iPhones register FCM tokens). */
  iosVia?: 'direct' | 'fcm';
  /** Critical Alerts entitlement granted (plan as if never). */
  critical?: boolean;
  /** Spike S3 passed: Live Activity state may be sealed. */
  laSealed?: boolean;
  /** Phase 1.1: VoIP pushes on (the app must report every one to CallKit at once). */
  voip?: boolean;
  fetcher?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Quick re-sends for an urgent native alert after a transient failure (default 1). */
  urgentRetries?: number;
  /** Where a failure of ours (`fatal` / `config`) is reported. Default: one JSON `console.error` line. */
  log?: (line: PushFaultLine) => void;
}

/** What the router logs when a send failed on our side. Never a token, uid, name or payload. */
export interface PushFaultLine {
  /** `push_config`: the token isn't for our topic/project (fix APNS_BUNDLE / FCM_SA_JSON). `push_fatal`: our request or key. */
  evt: 'push_config' | 'push_fatal';
  kind: PushKind;
  transport: DeliverReport['transport'];
  status?: number;
  reason?: string;
  plat?: PushSub['plat'];
  env?: ApnsEnv;
  /** The bundle id we sent as (APNs), or the Firebase project (FCM): what to compare with the app. */
  bundle?: string;
  project?: string;
}

export type DeliverOutcome = 'ok' | 'gone' | 'retry';

export interface DeliverReport {
  outcome: DeliverOutcome;
  transport: 'webpush' | 'apns' | 'fcm' | 'none';
  /** Provider HTTP status (0 = no answer). */
  status?: number;
  /** Provider reason / error code, or ours: unconfigured, dormant, not_applicable, no_vapid, endpoint_not_allowed, bad_message, internal. */
  reason?: string;
  /** Our side was wrong: the request, the credentials or the config (kept, never pruned). */
  fatal?: boolean;
  /** The provider says the token isn't for our app or project — a wrong bundle id or Firebase project. Kept, never pruned, logged as `push_config`. */
  config?: boolean;
  /** The device got the sealed envelope (false = generic text only). */
  sealed?: boolean;
  /** Provider requests made (1 + quick re-sends). */
  tries?: number;
}

export const VAPID_SUBJECT = 'https://dreamstreamstudio.ai';
/** Visible words when a device can't decrypt (D3). */
export const FALLBACK_TITLE = 'DreamStream';
const FALLBACK: Record<'alert' | 'update' | 'call' | 'la_start', string> = {
  alert: 'Nursery alert',
  update: 'Nursery update',
  call: 'Incoming call',
  la_start: 'Nursery monitor is on',
};

// --------------------------------------------------------------- config
export interface PushEnv {
  APNS_KEY_P8?: string;
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  APNS_BUNDLE?: string;
  FCM_SA_JSON?: string;
  /** `fcm` once the probe fails (D3); `direct` otherwise. */
  PUSH_IOS_VIA?: string;
  /** `1` once Apple grants Critical Alerts. */
  PUSH_CRITICAL_ALERTS?: string;
  /** `1` once spike S3 shows the widget can decrypt. */
  PUSH_LA_SEALED?: string;
  /** `1` in Phase 1.1. */
  PUSH_VOIP?: string;
}

let envMemo: { key: string; apns: ApnsConfig | null; fcm: FcmConfig | null } | null = null;

/** Router settings from Worker secrets/vars. Every native transport is off until its secrets exist. */
export function routerFromEnv(env: PushEnv, extra: Partial<RouterCtx> = {}): RouterCtx {
  const key = [env.APNS_KEY_P8, env.APNS_KEY_ID, env.APNS_TEAM_ID, env.APNS_BUNDLE, env.FCM_SA_JSON].join('\u0000');
  if (!envMemo || envMemo.key !== key) envMemo = { key, apns: apnsConfigFromEnv(env), fcm: fcmConfigFromEnv(env) };
  return {
    apns: envMemo.apns,
    fcm: envMemo.fcm,
    iosVia: env.PUSH_IOS_VIA === 'fcm' ? 'fcm' : 'direct',
    critical: env.PUSH_CRITICAL_ALERTS === '1',
    laSealed: env.PUSH_LA_SEALED === '1',
    voip: env.PUSH_VOIP === '1',
    ...extra,
  };
}

// ------------------------------------------------------------ helpers
/** Prune key: the endpoint for web, kind + token for native. */
export function subKey(s: PushSub): string {
  return s.kind === 'webpush' ? `webpush:${s.sub?.endpoint ?? ''}` : `${s.kind}:${s.token ?? ''}`;
}

/** Does this subscription take this message at all? (`deliver` on one that doesn't is a no-op `retry`.) */
export function accepts(s: PushSub, m: PushMsg): boolean {
  switch (s.kind) {
    case 'webpush':
      return (m.type === 'alert' || m.type === 'call') && !!m.web;
    case 'apns':
    case 'fcm':
      return m.type === 'alert' || m.type === 'call';
    case 'apns-voip':
      return m.type === 'call';
    case 'apns-la':
      return m.type === 'la' && !!m.la && (m.la.event === 'start') === (s.la === 'start');
  }
}

const SEV_CODE: Record<Sev, 'u' | 'w' | 'i'> = { urgent: 'u', warn: 'w', info: 'i', care: 'i' };
const MOODS = new Set(['calm', 'stirring', 'awake', 'noisy', 'fussing', 'crying', 'offline', 'unknown']);
const SLEEP_PHASES = new Set(['idle', 'settling', 'asleep', 'awake']);
const ALERT_STATES = new Set(['open', 'acked', 'resolved']);

/**
 * The only Live Activity state that may travel in clear (D3): mood, mood-since, sleep
 * phase, alert state. No names, no ids, no numbers beyond a timestamp.
 */
export function coarseLaState(state: Record<string, unknown>): { m: string; ms: number; sl?: { p: string }; al?: { st: string } } {
  const m = typeof state.m === 'string' && MOODS.has(state.m) ? state.m : 'unknown';
  const ms = typeof state.ms === 'number' && Number.isFinite(state.ms) ? Math.floor(state.ms) : 0;
  const out: { m: string; ms: number; sl?: { p: string }; al?: { st: string } } = { m, ms };
  const sl = state.sl as { p?: unknown } | null | undefined;
  if (sl && typeof sl.p === 'string' && SLEEP_PHASES.has(sl.p)) out.sl = { p: sl.p };
  const al = state.al as { st?: unknown } | null | undefined;
  if (al && typeof al.st === 'string' && ALERT_STATES.has(al.st)) out.al = { st: al.st };
  return out;
}

const te = new TextEncoder();

/** The provider-visible collapse id: the incident id, the call id, or a hash of the topic — never a kind. */
export async function collapseFor(m: PushMsg): Promise<string | undefined> {
  if (m.inc) return m.inc.slice(0, 64);
  if (m.call?.id) return `c${m.call.id}`.slice(0, 64);
  if (!m.topic) return undefined;
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(`ds-collapse|${m.topic}`)));
  return `h${Array.from(h.slice(0, 10), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function fallbackBody(m: PushMsg): string {
  if (m.type === 'call') return FALLBACK.call;
  if (m.replace || m.sev === 'info' || m.sev === 'care') return FALLBACK.update;
  return FALLBACK.alert;
}

function innerOf(m: PushMsg): PushInner {
  const base: PushInner = m.inner ?? { title: String(m.web?.title ?? ''), body: String(m.web?.body ?? ''), ...(m.web ?? {}) };
  return m.replace ? { ...base, replace: true } : base;
}

/**
 * `e` for this device, or none (no key, bad key, or still too big without the glance).
 * Too big first retries without `g` — the text still reaches the device sealed.
 */
async function envelopeFor(s: PushSub, inner: unknown): Promise<string | undefined> {
  if (!s.enc || !validPushKeys(s.enc)) return undefined;
  try {
    return (await sealForDevice(s, inner)).e;
  } catch (err) {
    if (err instanceof EnvelopeError && err.code === 'too_large' && inner && typeof inner === 'object' && 'g' in inner) {
      const { g: _g, ...slim } = inner as Record<string, unknown>;
      try {
        return (await sealForDevice(s, slim)).e;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

function interruptionOf(m: PushMsg, ctx: RouterCtx): Interruption {
  if (m.replace) return 'passive';
  if (m.type === 'call') return 'time-sensitive';
  if (m.sev === 'urgent') return ctx.critical && m.critical ? 'critical' : 'time-sensitive';
  if (m.sev === 'warn') return 'active';
  return 'passive';
}

function categoryOf(m: PushMsg): string | undefined {
  if (m.replace) return undefined;
  if (m.type === 'call') return m.category ?? 'DS_CALL';
  if (m.sev === 'urgent') return m.category ?? 'DS_URGENT';
  if (m.sev === 'warn') return m.category ?? 'DS_WARN';
  return m.category;
}

/** Wakes the phone now (10) or when power allows (5). */
function apnsPriorityOf(m: PushMsg): 10 | 5 {
  return m.sev === 'info' || m.sev === 'care' ? (m.replace ? 10 : 5) : 10;
}

/** A transient failure worth one quick re-send for an urgent alert. */
function transient(r: { outcome: string; status: number; retryAfterSec?: number }): boolean {
  return r.outcome === 'retry' && (r.retryAfterSec == null || r.retryAfterSec <= 2);
}

// ------------------------------------------------------------- deliver
/** Deliver one message to one subscription: `ok | gone | retry`. Never throws. */
export async function deliver(s: PushSub, m: PushMsg, ctx: RouterCtx = {}): Promise<DeliverOutcome> {
  return (await deliverReport(s, m, ctx)).outcome;
}

/** `deliver`, with the details a room logs. Never throws. */
export async function deliverReport(s: PushSub, m: PushMsg, ctx: RouterCtx = {}): Promise<DeliverReport> {
  if (!accepts(s, m)) return { outcome: 'retry', transport: 'none', reason: 'not_applicable' };
  let rep: DeliverReport;
  try {
    rep = await dispatch(s, m, ctx);
  } catch {
    // A bug here must never take the alert path down with it.
    return { outcome: 'retry', transport: 'none', reason: 'internal' };
  }
  if (rep.fatal) logFault(s, rep, ctx);
  return rep;
}

function dispatch(s: PushSub, m: PushMsg, ctx: RouterCtx): Promise<DeliverReport> {
  switch (s.kind) {
    case 'webpush':
      return viaWebPush(s, m, ctx);
    case 'apns':
      return viaApnsAlert(s, m, ctx);
    case 'apns-voip':
      return viaApnsVoip(s, m, ctx);
    case 'apns-la':
      return viaLiveActivity(s, m, ctx);
    case 'fcm':
      return viaFcm(s, m, ctx);
  }
}

/** One log line for a failure of ours: what failed and against which bundle/project — never the token or who it belongs to. */
function logFault(s: PushSub, rep: DeliverReport, ctx: RouterCtx): void {
  const line: PushFaultLine = { evt: rep.config ? 'push_config' : 'push_fatal', kind: s.kind, transport: rep.transport };
  if (rep.status != null) line.status = rep.status;
  if (rep.reason) line.reason = rep.reason;
  if (s.plat) line.plat = s.plat;
  if (s.env) line.env = s.env;
  if (rep.transport === 'apns' && ctx.apns) line.bundle = ctx.apns.bundle;
  if (rep.transport === 'fcm' && ctx.fcm) line.project = ctx.fcm.projectId;
  try {
    (ctx.log ?? ((l: PushFaultLine) => console.error(JSON.stringify(l))))(line);
  } catch {
    /* logging must never break delivery */
  }
}

/** Deliver to many: per-subscription reports plus the ones to prune. Subscriptions that don't take the message are skipped. */
export async function deliverAll(
  subs: PushSub[],
  msg: PushMsg | ((s: PushSub) => PushMsg | Promise<PushMsg>),
  ctx: RouterCtx = {},
): Promise<{ reports: { sub: PushSub; report: DeliverReport }[]; gone: PushSub[] }> {
  const reports = await Promise.all(
    subs.map(async (sub) => {
      let m: PushMsg;
      try {
        m = typeof msg === 'function' ? await msg(sub) : msg;
      } catch {
        // A per-recipient builder that fails (say, minting an action token) skips that one device only.
        return { sub, report: { outcome: 'retry', transport: 'none', reason: 'internal' } as DeliverReport };
      }
      return accepts(sub, m) ? { sub, report: await deliverReport(sub, m, ctx) } : null;
    }),
  );
  const done = reports.filter((r): r is { sub: PushSub; report: DeliverReport } => r !== null);
  return { reports: done, gone: done.filter((r) => r.report.outcome === 'gone').map((r) => r.sub) };
}

// ------------------------------------------------------------ transports
async function viaWebPush(s: PushSub, m: PushMsg, ctx: RouterCtx): Promise<DeliverReport> {
  if (!s.sub || !isAllowedPushEndpoint(s.sub.endpoint)) return { outcome: 'retry', transport: 'webpush', reason: 'endpoint_not_allowed' };
  const keys = ctx.vapid ? await ctx.vapid() : null;
  if (!keys) return { outcome: 'retry', transport: 'webpush', reason: 'no_vapid' };
  const out = await sendWebPush(
    s.sub,
    m.web,
    keys,
    { subject: ctx.vapidSubject ?? VAPID_SUBJECT, urgency: m.urgency ?? (m.sev === 'urgent' ? 'high' : 'normal'), ttlSec: m.ttlSec, topic: m.topic },
    ctx.fetcher ?? fetch,
  );
  return { outcome: out === 'sent' ? 'ok' : out === 'gone' ? 'gone' : 'retry', transport: 'webpush', sealed: true, tries: 1 };
}

/** Run a native send, with one quick re-send for urgent alerts on a transient failure. */
async function withUrgentRetry<R extends { outcome: string; status: number; retryAfterSec?: number }>(m: PushMsg, ctx: RouterCtx, send: () => Promise<R>): Promise<{ res: R; tries: number }> {
  let res = await send();
  let tries = 1;
  const budget = m.sev === 'urgent' && !m.replace ? (ctx.urgentRetries ?? 1) : 0;
  while (tries <= budget && transient(res)) {
    await (ctx.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))))(Math.max(300, (res.retryAfterSec ?? 0) * 1000));
    res = await send();
    tries++;
  }
  return { res, tries };
}

function fromApns(r: ApnsResult, s: PushSub, tries: number, sealed: boolean): DeliverReport {
  const rep: DeliverReport = { outcome: 'retry', transport: 'apns', status: r.status, tries, sealed };
  if (r.reason) rep.reason = r.reason;
  if (r.outcome === 'ok') rep.outcome = 'ok';
  else if (r.outcome === 'gone') {
    // Re-registered after APNs last saw the token dead: it's a live token now, keep it.
    rep.outcome = s.at != null && r.invalidSince != null && s.at > r.invalidSince ? 'retry' : 'gone';
  } else markOurs(rep, r.outcome);
  return rep;
}

function fromFcm(r: FcmResult, tries: number, sealed: boolean): DeliverReport {
  const rep: DeliverReport = { outcome: r.outcome === 'ok' ? 'ok' : r.outcome === 'gone' ? 'gone' : 'retry', transport: 'fcm', status: r.status, tries, sealed };
  if (r.errorCode) rep.reason = r.errorCode;
  markOurs(rep, r.outcome);
  return rep;
}

/** `fatal` and `config` are ours: kept (outcome stays `retry`), flagged, logged by `deliverReport`. */
function markOurs(rep: DeliverReport, o: SendOutcome): void {
  if (o === 'fatal' || o === 'config') rep.fatal = true;
  if (o === 'config') rep.config = true;
}

const unconfigured = (transport: DeliverReport['transport'], reason = 'unconfigured'): DeliverReport => ({ outcome: 'retry', transport, reason });

/** The visible APNs alert payload (generic words + envelope) for this message. */
async function apnsAlertFor(s: PushSub, m: PushMsg, ctx: RouterCtx): Promise<{ payload: Record<string, unknown>; collapseId?: string; sealed: boolean }> {
  const e = await envelopeFor(s, innerOf(m));
  const collapseId = await collapseFor(m);
  const interruption = interruptionOf(m, ctx);
  const payload = apnsAlertPayload({
    title: FALLBACK_TITLE,
    body: fallbackBody(m),
    interruption,
    category: categoryOf(m),
    thread: m.thread,
    sound: interruption !== 'passive',
    e,
    s: SEV_CODE[m.sev],
    i: m.inc ?? undefined,
    q: m.q != null ? String(m.q) : undefined,
  });
  return { payload, collapseId, sealed: !!e };
}

async function viaApnsAlert(s: PushSub, m: PushMsg, ctx: RouterCtx): Promise<DeliverReport> {
  if (!ctx.apns) return unconfigured('apns');
  // On the FCM fallback iPhones register FCM tokens; a bare APNs token can't ride FCM.
  if (ctx.iosVia === 'fcm') return unconfigured('apns', 'ios_via_fcm');
  if (!s.token || !isApnsToken(s.token)) return { outcome: 'gone', transport: 'apns', reason: 'MalformedToken' };
  const apns = ctx.apns;
  const now = (ctx.now ?? Date.now)();
  const { payload, collapseId, sealed } = await apnsAlertFor(s, m, ctx);
  const topic = s.plat === 'watchos' ? `${apns.bundle}.watchkitapp` : undefined;
  const { res, tries } = await withUrgentRetry(m, ctx, () =>
    sendApns(
      { token: s.token!, type: 'alert', topic, priority: apnsPriorityOf(m), collapseId, expiration: Math.floor(now / 1000) + m.ttlSec, payload, env: s.env },
      apns,
      { fetcher: ctx.fetcher, now },
    ),
  );
  return fromApns(res, s, tries, sealed);
}

async function viaApnsVoip(s: PushSub, m: PushMsg, ctx: RouterCtx): Promise<DeliverReport> {
  // A VoIP push the app doesn't hand to CallKit at once gets the app's VoIP pushes cut off: off until Phase 1.1.
  if (!ctx.voip) return unconfigured('apns', 'dormant');
  if (!ctx.apns || ctx.iosVia === 'fcm') return unconfigured('apns');
  if (!s.token || !isApnsToken(s.token)) return { outcome: 'gone', transport: 'apns', reason: 'MalformedToken' };
  // A call message without a call id is our bug, not the token's: keep the token, flag it (logged as push_fatal).
  const callId = m.call?.id;
  if (typeof callId !== 'string' || !callId) return { outcome: 'retry', transport: 'apns', reason: 'bad_message', fatal: true };
  const now = (ctx.now ?? Date.now)();
  // The call id (to fetch the call) and, sealed, who is calling — CallKit needs a name at once.
  const e = await envelopeFor(s, innerOf(m));
  const payload: Record<string, unknown> = { call: callId };
  if (e) payload.e = e;
  const res = await sendApns({ token: s.token, type: 'voip', priority: 10, collapseId: await collapseFor(m), expiration: Math.floor(now / 1000) + m.ttlSec, payload, env: s.env }, ctx.apns, { fetcher: ctx.fetcher, now });
  return fromApns(res, s, 1, !!e);
}

async function viaLiveActivity(s: PushSub, m: PushMsg, ctx: RouterCtx): Promise<DeliverReport> {
  const la = m.la!;
  if (!s.token || !isApnsToken(s.token)) return { outcome: 'gone', transport: 'apns', reason: 'MalformedToken' };
  const now = (ctx.now ?? Date.now)();
  const nowSec = Math.floor(now / 1000);
  let contentState: Record<string, unknown> = coarseLaState(la.state);
  let sealed = false;
  if (ctx.laSealed) {
    const e = await envelopeFor(s, la.state);
    if (e) {
      contentState = { e };
      sealed = true;
    }
  }
  const payload = apnsLiveActivityPayload({
    event: la.event,
    timestamp: nowSec,
    contentState,
    staleDate: la.staleSec != null ? nowSec + la.staleSec : undefined,
    dismissalDate: la.dismissAt != null ? Math.floor(la.dismissAt / 1000) : undefined,
    // Push-to-start requires an alert (generic words only); an update may light the screen for an alert.
    alert: la.event === 'start' ? { title: FALLBACK_TITLE, body: FALLBACK.la_start } : la.alert ? { title: FALLBACK_TITLE, body: fallbackBody(m) } : undefined,
  });
  const priority: 10 | 5 = m.sev === 'urgent' || la.event === 'start' ? 10 : 5;

  if (ctx.apns && ctx.iosVia !== 'fcm') {
    const res = await sendApns({ token: s.token, type: 'liveactivity', priority, expiration: nowSec + m.ttlSec, payload, env: s.env }, ctx.apns, { fetcher: ctx.fetcher, now });
    return fromApns(res, s, 1, sealed);
  }
  if (ctx.fcm && s.fcm && isFcmToken(s.fcm)) {
    const res = await sendFcm({ token: s.fcm, apns: { headers: { 'apns-priority': String(priority) }, payload, liveActivityToken: s.token } }, ctx.fcm, { fetcher: ctx.fetcher, now });
    // A dead FCM token or activity token: either way this registration can't be reached.
    return fromFcm(res, 1, sealed);
  }
  return unconfigured('apns');
}

async function viaFcm(s: PushSub, m: PushMsg, ctx: RouterCtx): Promise<DeliverReport> {
  if (!ctx.fcm) return unconfigured('fcm');
  if (!s.token || !isFcmToken(s.token)) return { outcome: 'gone', transport: 'fcm', reason: 'MalformedToken' };
  const now = (ctx.now ?? Date.now)();
  if (s.plat === 'ios') {
    // An iPhone on the FCM fallback: the same APNs alert, carried by FCM.
    const { payload, collapseId, sealed } = await apnsAlertFor(s, m, ctx);
    const headers: Record<string, string> = { 'apns-push-type': 'alert', 'apns-priority': String(apnsPriorityOf(m)), 'apns-expiration': String(Math.floor(now / 1000) + m.ttlSec) };
    if (collapseId) headers['apns-collapse-id'] = collapseId;
    const { res, tries } = await withUrgentRetry(m, ctx, () => sendFcm({ token: s.token!, apns: { headers, payload } }, ctx.fcm!, { fetcher: ctx.fetcher, now }));
    return fromFcm(res, tries, sealed);
  }
  // Android / Wear OS: data only — the app decrypts `e` and builds the notification itself.
  const e = await envelopeFor(s, innerOf(m));
  const data: Record<string, string> = { s: SEV_CODE[m.sev] };
  if (e) data.e = e;
  if (m.inc) data.i = m.inc;
  if (m.q != null) data.q = String(m.q);
  const collapseKey = await collapseFor(m);
  const loud = m.type === 'call' || m.replace || m.sev === 'urgent' || m.sev === 'warn';
  const { res, tries } = await withUrgentRetry(m, ctx, () =>
    sendFcm({ token: s.token!, data, androidPriority: loud ? 'high' : 'normal', ttl: m.ttlSec, collapseKey }, ctx.fcm!, { fetcher: ctx.fetcher, now }),
  );
  return fromFcm(res, tries, !!e);
}

// ------------------------------------------------------- the replacement
/**
 * The quiet replacement sent to everyone else when someone acknowledges ("Dad's on it"):
 * same incident (APNs collapse id, FCM collapse key), same Web Push topic and tag, so it
 * replaces the alert on every device — and an alert not yet delivered is superseded.
 * No action token; never loud. The web `kind` becomes `ack` so even a service worker that
 * predates `replace` shows it without the urgent treatment.
 */
export function replacementOf(orig: PushMsg, text: { title: string; body: string }): PushMsg {
  const web = orig.web
    ? (() => {
        const { act: _act, ...rest } = orig.web!;
        return { ...rest, title: text.title, body: text.body, tag: orig.web!.tag ?? `${orig.web!.nid ?? 'monitor'}-${orig.web!.kind ?? 'alert'}`, kind: 'ack', of: orig.web!.kind ?? null, replace: true };
      })()
    : undefined;
  const { act: _a, ...inner } = innerOf(orig);
  return {
    type: 'alert',
    sev: 'info',
    web,
    inner: { ...inner, title: text.title, body: text.body, replace: true },
    ttlSec: orig.ttlSec,
    urgency: 'normal',
    topic: orig.topic,
    inc: orig.inc,
    q: orig.q,
    replace: true,
    thread: orig.thread,
  };
}

// ------------------------------------------------------- registration
/**
 * Validate a registration (from `/api/devices/push` → the room's `/x/push-reg`) into a
 * `PushSub`, or null. Native tokens must match their kind; the envelope keys, when given,
 * must be a usable RFC 8291 pair (a device without them gets generic text only).
 */
export function parsePushSub(raw: unknown, who: { uid: string; dev?: string | null }, now = Date.now()): PushSub | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const kind = r.kind as PushKind;
  if (!PUSH_KINDS.includes(kind)) return null;
  const base: PushSub = { kind, uid: who.uid, at: now };
  if (who.dev) base.dev = who.dev;
  if (kind === 'webpush') {
    const sub = r.sub as PushSubscriptionJSONLike | undefined;
    const keys = sub ? normalizePushKeys(sub.keys) : null;
    if (!sub || typeof sub.endpoint !== 'string' || !isAllowedPushEndpoint(sub.endpoint) || !keys) return null;
    return { ...base, sub: { endpoint: sub.endpoint, keys } };
  }
  const token = r.token;
  if (kind === 'fcm' ? !isFcmToken(token) : !isApnsToken(token)) return null;
  const out: PushSub = { ...base, token: token as string };
  if (r.enc != null) {
    const keys = normalizePushKeys(r.enc);
    if (!keys) return null;
    out.enc = keys;
  }
  if (kind !== 'fcm' && (r.env === 'sandbox' || r.env === 'production')) out.env = r.env;
  if (r.plat === 'ios' || r.plat === 'android' || r.plat === 'wearos' || r.plat === 'watchos') out.plat = r.plat;
  if (kind === 'apns-la') {
    out.la = r.la === 'start' ? 'start' : 'update';
    if (r.fcm != null) {
      if (!isFcmToken(r.fcm)) return null;
      out.fcm = r.fcm;
    }
  }
  return out;
}
