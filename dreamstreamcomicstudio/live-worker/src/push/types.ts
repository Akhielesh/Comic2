/**
 * What every push transport reports, and the small helpers they share.
 *
 *  - `ok`     delivered to the provider.
 *  - `gone`   this token is dead for good (uninstalled, expired, invalid): the caller
 *             prunes it. Only an answer about the token itself is `gone`.
 *  - `retry`  not delivered now, but nothing is wrong with the token (provider busy,
 *             network, throttled): keep it.
 *  - `fatal`  our request or our credentials are wrong (bad payload, bad key): keep the
 *             token, log it, fix the code or the secret. Never prunes.
 *  - `config` the provider says the token and our app or project don't match (APNs topic,
 *             FCM sender project). A wrong `APNS_BUNDLE` or a service account from another
 *             Firebase project looks exactly like this, for every device at once, so it is
 *             our deployment, not the token: keep it, raise an alert, fix the config.
 *             Never prunes.
 */
export type SendOutcome = 'ok' | 'gone' | 'retry' | 'fatal' | 'config';

export interface SendOpts {
  /** Injected for tests; the Worker's global `fetch` otherwise. */
  fetcher?: typeof fetch;
  /** ms since epoch. */
  now?: number;
  /** Give up on one provider request after this long (default 10 s), so a stuck provider can't hold a room. */
  timeoutMs?: number;
}

export const DEFAULT_SEND_TIMEOUT_MS = 10_000;

/** An abort signal that fires after `ms`, where the runtime has one. */
export function timeoutSignal(ms: number): AbortSignal | undefined {
  try {
    return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(ms) : undefined;
  } catch {
    return undefined;
  }
}

/** `Retry-After` in seconds (delta-seconds or an HTTP date), if present and sane. */
export function retryAfterSec(h: Headers, now = Date.now()): number | undefined {
  const v = h.get('retry-after');
  if (!v) return undefined;
  if (/^\d+$/.test(v.trim())) return Math.min(Number(v), 86_400);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, Math.min(Math.round((at - now) / 1000), 86_400)) : undefined;
}

/** Short, log-safe text for a thrown error (never the request, which may hold a token). */
export function errText(err: unknown): string {
  const s = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return s.slice(0, 160);
}
