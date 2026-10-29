/**
 * The Phase 0 APNs HTTP/2 probe (ADR 0006 D3).
 *
 * APNs only speaks HTTP/2. workerd has no HTTP/2 client, but in production a Worker's
 * `fetch` leaves through Cloudflare's proxy, which reportedly upgrades (workerd#4841).
 * This settles it from where it matters — production — with no Apple account:
 *
 *   POST https://api.sandbox.push.apple.com/3/device/<64 hex>   (no provider token)
 *
 *  - **pass**: APNs' JSON error (`{"reason":"MissingProviderToken"}`, 403) **with an
 *    `apns-id` header** — only an HTTP/2 response from APNs carries one. Decision:
 *    send to APNs directly.
 *  - **fail**: no answer (APNs answers an HTTP/1.x request with HTTP/2 frames and a
 *    GOAWAY, which surfaces as an error), or any response without `apns-id`. Decision:
 *    iPhones use FCM HTTP v1 with an `apns` block (router `PUSH_IOS_VIA=fcm`).
 *
 * Where it runs: `POST /api/ops/apns-probe` on the live Worker (WS-7's ops.ts calls
 * `handleApnsProbe`), or the throwaway `probeWorker.ts` that the "APNs HTTP/2 probe"
 * GitHub workflow deploys, calls and deletes (`live-worker/scripts/apnsProbe.mjs`
 * records the result). Both need the `x-ops-key` header to match a secret.
 */
import { APNS_HOSTS, type ApnsEnv } from './apns';
import { errText, timeoutSignal } from './types';

/** A syntactically valid device token that belongs to no one. */
export const PROBE_DEVICE_TOKEN = '0'.repeat(64);

export type ProbeVerdict = 'pass' | 'fail';
export type ProbeDecision = 'apns-direct' | 'fcm-for-ios';

/** `{status, apnsId, body}` is the frozen contract (wire.ts `ApnsProbeResult`); the rest explains it. */
export interface ApnsProbeResult {
  /** HTTP status; 0 when no response came back. */
  status: number;
  apnsId: string | null;
  /** The response body (≤ 512 chars). */
  body: string;
  reason: string | null;
  verdict: ProbeVerdict;
  decision: ProbeDecision;
  detail: string;
  host: ApnsEnv;
  /** ISO time the probe ran. */
  at: string;
  /** Round trip, ms. */
  ms: number;
  error?: string;
  /** Cloudflare data centre that ran it (when known). */
  colo?: string;
}

/** Classify what came back. Pure: shared by the Worker and (mirrored) by scripts/apnsProbe.mjs. */
export function classifyApnsProbe(r: { status: number; apnsId: string | null; body: string; error?: string }): { verdict: ProbeVerdict; reason: string | null; detail: string } {
  let reason: string | null = null;
  try {
    const j = JSON.parse(r.body) as { reason?: unknown };
    if (typeof j?.reason === 'string') reason = j.reason;
  } catch {
    /* not JSON */
  }
  if (r.error && !r.status) return { verdict: 'fail', reason, detail: `No HTTP/2 answer from APNs (${r.error}).` };
  const id = r.apnsId?.trim() || null;
  if (id && (reason || r.status === 200)) {
    return { verdict: 'pass', reason, detail: `APNs answered over HTTP/2: ${r.status}${reason ? ` ${reason}` : ''} with apns-id ${id}.` };
  }
  if (!id) return { verdict: 'fail', reason, detail: `HTTP ${r.status} without an apns-id header — not an APNs HTTP/2 response.` };
  return { verdict: 'fail', reason, detail: `HTTP ${r.status} with apns-id but no APNs reason in the body.` };
}

/** Run the probe from wherever this code runs. Never throws. */
export async function probeApns(opts: { host?: ApnsEnv; fetcher?: typeof fetch; timeoutMs?: number; now?: () => number } = {}): Promise<ApnsProbeResult> {
  const host = opts.host ?? 'sandbox';
  const fetcher = opts.fetcher ?? fetch;
  const now = opts.now ?? Date.now;
  const t0 = now();
  let status = 0;
  let apnsId: string | null = null;
  let body = '';
  let error: string | undefined;
  try {
    const res = await fetcher(`${APNS_HOSTS[host]}/3/device/${PROBE_DEVICE_TOKEN}`, {
      method: 'POST',
      headers: { 'apns-push-type': 'alert', 'apns-priority': '5', 'content-type': 'application/json' },
      body: '{"aps":{}}',
      signal: timeoutSignal(opts.timeoutMs ?? 10_000),
    });
    status = res.status;
    apnsId = res.headers.get('apns-id');
    body = (await res.text()).slice(0, 512);
  } catch (err) {
    error = errText(err);
  }
  const c = classifyApnsProbe({ status, apnsId, body, error });
  const out: ApnsProbeResult = {
    status,
    apnsId,
    body,
    reason: c.reason,
    verdict: c.verdict,
    decision: c.verdict === 'pass' ? 'apns-direct' : 'fcm-for-ios',
    detail: c.detail,
    host,
    at: new Date(t0).toISOString(),
    ms: Math.max(0, now() - t0),
  };
  if (error) out.error = error;
  return out;
}

/** The line to paste under ADR 0006 D3 ("record the result in this ADR's D3"). */
export function probeAdrLine(r: ApnsProbeResult, where = 'Cloudflare production'): string {
  const day = r.at.slice(0, 10);
  const from = r.colo ? `${where}, ${r.colo}` : where;
  return r.verdict === 'pass'
    ? `- **APNs probe ${day} (${from}, ${r.host}): pass** — HTTP ${r.status} \`${r.reason ?? ''}\` with \`apns-id\` ${r.apnsId}. Decision: **send to APNs directly**.`
    : `- **APNs probe ${day} (${from}, ${r.host}): fail** — ${r.detail} Decision: **FCM for iOS** (set \`PUSH_IOS_VIA=fcm\`; VoIP via the Container).`;
}

const enc = new TextEncoder();

/** Constant-time comparison of a presented key with the secret (hash both, compare all bytes). */
export async function opsKeyMatches(given: string, secret: string | undefined): Promise<boolean> {
  if (!secret || secret.length < 16 || !given) return false;
  const [a, b] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(given)), crypto.subtle.digest('SHA-256', enc.encode(secret))]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/**
 * The HTTP handler: `POST` with `x-ops-key: <secret>`, optional `?host=production`.
 * Answers the probe result as JSON (no-store). Fails closed without a configured secret.
 */
export async function handleApnsProbe(req: Request, secret: string | undefined, opts: { fetcher?: typeof fetch } = {}): Promise<Response> {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405, headers: { allow: 'POST' } });
  if (!(await opsKeyMatches(req.headers.get('x-ops-key') ?? '', secret))) return new Response('forbidden', { status: 403 });
  const host: ApnsEnv = new URL(req.url).searchParams.get('host') === 'production' ? 'production' : 'sandbox';
  const result = await probeApns({ host, fetcher: opts.fetcher });
  const colo = (req as Request & { cf?: { colo?: unknown } }).cf?.colo;
  if (typeof colo === 'string' && /^[A-Z]{3}$/.test(colo)) result.colo = colo;
  return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
