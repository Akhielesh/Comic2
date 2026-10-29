/**
 * Routes for our own machinery, not for apps (ADR 0006 §1):
 *
 *   POST /api/ops/apns-probe[?host=production]    x-ops-key: <OPS_KEY>
 *     The Phase 0 APNs HTTP/2 probe from production (push/probe.ts handleApnsProbe): its answer
 *     decides whether iPhones get APNs directly or FCM (D3). Fails closed without OPS_KEY.
 *
 *   POST /x/user/:uid/notify      x-ds-signature: t=<unix s>,v1=<hex HMAC-SHA256(secret, "<t>.<p>")>
 *        body {"p": "<payload JSON, as a string>"}
 *     A security notice for one person's other devices — the push mirror of the new-sign-in
 *     email, a device added or revoked — forwarded to their call line (UserLine `/x/notify`,
 *     ADR 0006 WS-10), which knows their devices. Signed exactly as the Supabase hook signs the
 *     email Worker's /security (live_security_v2.sql live__send_signin_alert), with the same
 *     SECURITY_HOOK_SECRET (`old|new` while rotating), so the same sender can post to both.
 *     ±5 minutes; each signature works once per isolate; the payload's uid must be the path's.
 *     Without the secret every call is refused (403): dormant, never open.
 *
 *   POST /x/user/:uid/kick        signed the same way
 *        p = {"v": 1, "kind": "kick", "uid": "<uid>", "why": "secured", "nids": [<nursery ids>], "at": <ms>}
 *     "Not you? Secure my account" (server/src/services/liveKick.ts, ADR 0006 WS-5). The backend
 *     has just ended every session of the account (live_secure_account), so the account's own
 *     tokens can't list its nurseries any more — the backend names them, from the membership
 *     table, with its own signed credential. Runs the same fan-out as /api/me/kick (kick.ts
 *     kickEverywhere): every named nursery's room, the call line and the direct calls it names
 *     close the account's sockets and drop its push targets.
 *     → 200 `{ok, rooms, calls, closed, unconfirmed}`, `ok` only when every one confirmed.
 */

import { MemoryNonceStore } from './auth/deviceToken';
import { kickEverywhere, MAX_ROOMS, methodNotAllowed, readBody, reply, tellLine, UUID_RE, type KickEnv, type KickWhy } from './kick';
import { handleApnsProbe } from './push/probe';

export interface OpsEnv extends KickEnv {
  /** Secret: the x-ops-key for /api/ops/*. */
  OPS_KEY?: string;
  /** Secret, shared with the email Worker and Supabase Vault. */
  SECURITY_HOOK_SECRET?: string;
}

export interface OpsOptions {
  fetcher?: typeof fetch;
  now?: number;
}

/* ------------------------------------------------------------- apns probe */

/** POST /api/ops/apns-probe. */
export function handleOps(req: Request, env: OpsEnv, sub: string, opts: OpsOptions = {}): Promise<Response> | Response {
  if (sub === 'apns-probe') return handleApnsProbe(req, env.OPS_KEY, { fetcher: opts.fetcher });
  return reply({ ok: false, error: 'not_found' }, 404);
}

/* --------------------------------------------------------- hook signature */

/** The signature's freshness window (the email Worker's SECURITY_TOLERANCE_SECONDS). */
export const HOOK_TOLERANCE_S = 300;
const MAX_PAYLOAD_BYTES = 8 * 1024;
const enc = new TextEncoder();

const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type HookVerdict = { ok: true; sig: string; t: number } | { ok: false; reason: 'no-secret' | 'missing-signature' | 'too-large' | 'bad-timestamp' | 'stale-timestamp' | 'bad-signature' };

/** Check `x-ds-signature` over the payload string `p` (mirrors email-worker securityAlert.ts verifySecuritySignature). */
export async function verifyHookSignature(secret: string | undefined, header: string | null, p: string, nowMs = Date.now()): Promise<HookVerdict> {
  const secrets = String(secret || '')
    .split('|')
    .map((s) => s.trim())
    .filter((s) => s.length >= 16);
  if (!secrets.length) return { ok: false, reason: 'no-secret' };
  if (!header) return { ok: false, reason: 'missing-signature' };
  if (enc.encode(p).length > MAX_PAYLOAD_BYTES) return { ok: false, reason: 'too-large' };
  const fields = new Map<string, string[]>();
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    fields.set(k, [...(fields.get(k) ?? []), part.slice(i + 1).trim()]);
  }
  const t = fields.get('t')?.[0] ?? '';
  if (!/^\d{9,11}$/.test(t)) return { ok: false, reason: 'bad-timestamp' };
  if (Math.abs(Math.floor(nowMs / 1000) - Number(t)) > HOOK_TOLERANCE_S) return { ok: false, reason: 'stale-timestamp' };
  const given = (fields.get('v1') ?? []).filter((v) => /^[0-9a-f]{64}$/.test(v));
  for (const s of secrets) {
    const key = await crypto.subtle.importKey('raw', enc.encode(s), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const want = hex(await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${p}`)));
    const hit = given.find((g) => timingSafeEqual(g, want));
    if (hit) return { ok: true, sig: hit, t: Number(t) };
  }
  return { ok: false, reason: 'bad-signature' };
}

/** Sign a payload the way the hook does (tests, and any of our own senders). */
export async function signHookPayload(secret: string, p: string, nowMs = Date.now()): Promise<string> {
  const t = Math.floor(nowMs / 1000);
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `t=${t},v1=${hex(await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${p}`)))}`;
}

/* ------------------------------------------------------------ user notify */

/** What a notice may say. Anything else in the payload stays behind (no addresses, no user agents). */
export const NOTICE_KINDS = ['sign_in', 'device_added', 'device_revoked', 'secured'] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

let seenSignatures = new MemoryNonceStore(5_000);

const short = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max) : undefined);

type Signed = { ok: true; id: string; payload: Record<string, unknown>; now: number } | { ok: false; res: Response };

/**
 * A signed `/x/user/:uid/...` request: POST, the `{"p": "<payload>"}` body, a valid signature
 * (never twice per isolate inside its window: a captured one can't be replayed), and a JSON
 * payload whose `uid` is the path's.
 */
async function readSigned(req: Request, env: OpsEnv, uid: string, use: string, opts: OpsOptions): Promise<Signed> {
  if (req.method !== 'POST') return { ok: false, res: methodNotAllowed('POST') };
  const id = uid.toLowerCase();
  if (!UUID_RE.test(id)) return { ok: false, res: reply({ ok: false, error: 'not_found' }, 404) };
  const raw = await readBody(req, 16 * 1024);
  if (raw == null) return { ok: false, res: reply({ ok: false, error: 'bad_request' }, 413) };
  let p: unknown;
  try {
    p = (JSON.parse(raw) as { p?: unknown }).p;
  } catch {
    p = undefined;
  }
  if (typeof p !== 'string') return { ok: false, res: reply({ ok: false, error: 'bad_request' }, 400) };
  const now = opts.now ?? Date.now();
  const v = await verifyHookSignature(env.SECURITY_HOOK_SECRET, req.headers.get('x-ds-signature'), p, now);
  if (v.ok === false) return { ok: false, res: reply({ ok: false, error: 'forbidden' }, 403) };
  if (seenSignatures.checkAndSet(`${use}:${v.sig}`, (v.t + HOOK_TOLERANCE_S + 1) * 1000, now)) return { ok: false, res: reply({ ok: false, error: 'replay' }, 409) };

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(p) as Record<string, unknown>;
  } catch {
    return { ok: false, res: reply({ ok: false, error: 'bad_request' }, 400) };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || String(payload.uid ?? '').toLowerCase() !== id) {
    return { ok: false, res: reply({ ok: false, error: 'bad_request' }, 400) };
  }
  return { ok: true, id, payload, now };
}

/** POST /x/user/:uid/notify (see the top of the file). */
export async function handleUserNotify(req: Request, env: OpsEnv, uid: string, opts: OpsOptions = {}): Promise<Response> {
  const s = await readSigned(req, env, uid, 'n', opts);
  if (s.ok === false) return s.res;
  const { id, payload, now } = s;
  const kind = payload.kind as NoticeKind;
  if (!NOTICE_KINDS.includes(kind)) return reply({ ok: false, error: 'bad_request' }, 400);
  const notice = {
    uid: id,
    kind,
    at: typeof payload.at === 'number' && Number.isFinite(payload.at) ? payload.at : now,
    ...(short(payload.device, 60) ? { device: short(payload.device, 60) } : {}),
    ...(short(payload.name, 40) ? { name: short(payload.name, 40) } : {}),
    ...(short(payload.platform, 16) ? { platform: short(payload.platform, 16) } : {}),
  };
  const told = await tellLine(env, id, '/x/notify', notice);
  return reply({ ok: told.ok, told: told.ok }, told.ok ? 200 : told.status === 404 ? 501 : 502);
}

/** Nursery ids a signed kick may name (the backend sends at most 50; beyond MAX_ROOMS is reported unconfirmed). */
const MAX_KICK_NIDS = MAX_ROOMS * 4;

/** POST /x/user/:uid/kick (see the top of the file). */
export async function handleUserKick(req: Request, env: OpsEnv, ctx: Pick<ExecutionContext, 'waitUntil'>, uid: string, opts: OpsOptions = {}): Promise<Response> {
  const s = await readSigned(req, env, uid, 'k', opts);
  if (s.ok === false) return s.res;
  const { id, payload, now } = s;
  if (payload.kind !== 'kick' || !Array.isArray(payload.nids) || payload.nids.length > MAX_KICK_NIDS) return reply({ ok: false, error: 'bad_request' }, 400);
  const nids = payload.nids.map((n) => String(n ?? '').toLowerCase());
  if (nids.some((n) => !UUID_RE.test(n))) return reply({ ok: false, error: 'bad_request' }, 400);
  const why: KickWhy = payload.why === 'signout' ? 'signout' : 'secure';
  const report = await kickEverywhere(env, ctx, id, nids, why, { fetcher: opts.fetcher, now });
  if (!report.ok) console.warn(JSON.stringify({ evt: 'kick_partial', via: 'signed', rooms: report.rooms, calls: report.calls, unconfirmed: report.unconfirmed }));
  return reply(report);
}

/** Test hook. */
export function resetOpsState(): void {
  seenSignatures = new MemoryNonceStore(5_000);
}
