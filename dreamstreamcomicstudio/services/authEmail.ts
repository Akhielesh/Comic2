/**
 * Auth emails through our backend (POST /api/auth/email/*) — shared by the main app and the
 * live app. Supabase's built-in mailer allows ~2 emails/hour for the whole project, so
 * sign-up confirmations, resends, password resets and magic links are sent by the backend
 * (GoTrue admin generateLink + our email Worker) instead.
 *
 * Callers fall back to their old direct supabase.auth call ONLY on `{ status: 'unreachable' }`:
 * the backend isn't there (network error, 20 s timeout, 404/405, a non-JSON body such as a
 * Pages HTML page, or a 502/503/504 without a route code) or says it can't send right now
 * (`fallback: true`). Every other answer — 429 included — is final: falling back would only
 * run into Supabase's limit, and the captcha token may already be spent.
 */

import { STREAM_HOST_ON, isStreamHost } from '../shared/streamHost';
import { buildApiUrl } from './clientConfig';
import { SIGN_IN_NONCE_PARAM, newSignInNonce, recordSignInStarted } from './pendingSignIn';

export type AuthEmailKind = 'signup' | 'resend' | 'recovery' | 'magiclink';

export type AuthEmailResult =
  | { status: 'ok'; data: Record<string, unknown> }
  | { status: 'error'; code: string; message: string; retryAfterS?: number; httpStatus: number }
  | { status: 'unreachable' };

/** Generous: the backend container may be waking from sleep (cold start). */
export const AUTH_EMAIL_TIMEOUT_MS = 20_000;

const UNREACHABLE: AuthEmailResult = { status: 'unreachable' };

const positiveSeconds = (value: unknown): number | undefined => {
  const n = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.ceil(n) : undefined;
};

/**
 * Pure: an HTTP status + parsed JSON body (null when the body wasn't JSON) → result.
 * Route errors are `{ ok:false, code, message, retryAfterS? }`; the global IP limiter and
 * Express' error handler answer `{ error: { code, message, details } }` — both are read.
 */
export const interpretAuthEmailResponse = (
  httpStatus: number,
  body: unknown,
  retryAfterHeader?: string | null
): AuthEmailResult => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return UNREACHABLE;
  if (httpStatus === 404 || httpStatus === 405) return UNREACHABLE;
  const b = body as Record<string, unknown>;
  const nested = b.error && typeof b.error === 'object' ? (b.error as Record<string, unknown>) : null;
  const code = typeof b.code === 'string' ? b.code : typeof nested?.code === 'string' ? nested.code : '';
  // A route answer is top-level `{ ok:false, code }`. Anything else at 401/403 is a backend
  // without these routes yet (its auth wall), and anything else at 5xx-gateway is the proxy
  // or a container that's still starting — the old Supabase call is the right move for both.
  const routeAnswer = b.ok === false && typeof b.code === 'string';
  if ((httpStatus === 401 || httpStatus === 403) && !routeAnswer) return UNREACHABLE;
  if ((httpStatus === 502 || httpStatus === 503 || httpStatus === 504) && (!routeAnswer || b.fallback === true)) return UNREACHABLE;
  if (httpStatus >= 200 && httpStatus < 300 && b.ok === true) return { status: 'ok', data: b };

  const details = nested?.details && typeof nested.details === 'object' ? (nested.details as Record<string, unknown>) : null;
  const retryAfterS =
    positiveSeconds(b.retryAfterS) ??
    positiveSeconds(typeof details?.retryAfterMs === 'number' ? details.retryAfterMs / 1000 : undefined) ??
    (httpStatus === 429 ? positiveSeconds(retryAfterHeader) : undefined);
  let message = typeof b.message === 'string' ? b.message : typeof nested?.message === 'string' ? nested.message : '';
  if (code === 'RATE_LIMITED' || (!message && httpStatus === 429)) {
    message = `Too many requests — please wait ${retryAfterS ?? 60} seconds and try again.`;
  }
  return {
    status: 'error',
    code: code || `http_${httpStatus}`,
    message: message || 'Something went wrong — please try again.',
    httpStatus,
    ...(retryAfterS ? { retryAfterS } : {})
  };
};

/** Shown when our email service can't be reached. We never fall back to Supabase's own
 *  mailer: its mail isn't from dreamstreamstudio.ai and it allows ~2 emails/hour. */
export const EMAIL_SERVICE_DOWN = 'We couldn’t reach our email service just now — please try again in a minute.';

/**
 * Does a link for `app` ('main' | 'live', the request's `app` field) open on THIS origin
 * (`hostname`)? Main-app links — password reset, magic link, main sign-up — always land on the
 * main app (its /auth/callback). Stream Studio's land at /live on the apex while STREAM_HOST_ON is
 * off, and on its own host once it is on (server/src/services/authEmailLinks.ts). A sign-in intent
 * is recorded only where the link lands: another origin has its own storage and could never see
 * it, while a record left here would be a standing pass for any link opened here.
 */
export const authLinkLandsHere = (app: unknown, hostname: string | null | undefined, streamHostOn: boolean = STREAM_HOST_ON): boolean => {
  const onStream = isStreamHost(hostname);
  if (app === 'live') return streamHostOn ? onStream : !onStream;
  return !onStream;
};

/**
 * POST /api/auth/email/{kind}. Never throws.
 *
 * Every kind sends a link that signs a browser in when it comes back (sign-up confirmation,
 * resend, password reset, magic link). The request carries a fresh nonce (`sn`) that our backend
 * puts in the link, and a sent email records it here (services/pendingSignIn) — when the link
 * lands on this origin (authLinkLandsHere): opened in this browser, that link — and only that
 * link — completes without a "Finish signing in?" step. A link for the other origin asks once.
 */
export async function requestAuthEmail(
  kind: AuthEmailKind,
  body: Record<string, unknown>,
  opts: { accessToken?: string | null; timeoutMs?: number } = {}
): Promise<AuthEmailResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? AUTH_EMAIL_TIMEOUT_MS);
  const nonce = newSignInNonce();
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (opts.accessToken) headers.authorization = `Bearer ${opts.accessToken}`;
    const res = await fetch(buildApiUrl(`/api/auth/email/${kind}`), {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...body, [SIGN_IN_NONCE_PARAM]: nonce }),
      signal: controller.signal
    });
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(await res.text());
    } catch {
      parsed = null;
    }
    const result = interpretAuthEmailResponse(res.status, parsed, res.headers.get('retry-after'));
    if (result.status === 'ok' && authLinkLandsHere(body.app, typeof location !== 'undefined' ? location.hostname : null)) {
      recordSignInStarted(kind, nonce, Date.now(), typeof body.email === 'string' ? body.email : undefined);
    }
    return result;
  } catch {
    return UNREACHABLE;
  } finally {
    clearTimeout(timer);
  }
}
