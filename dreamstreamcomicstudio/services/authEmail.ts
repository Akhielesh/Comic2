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

import { buildApiUrl } from './clientConfig';

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

/** POST /api/auth/email/{kind}. Never throws. */
export async function requestAuthEmail(
  kind: AuthEmailKind,
  body: Record<string, unknown>,
  opts: { accessToken?: string | null; timeoutMs?: number } = {}
): Promise<AuthEmailResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? AUTH_EMAIL_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (opts.accessToken) headers.authorization = `Bearer ${opts.accessToken}`;
    const res = await fetch(buildApiUrl(`/api/auth/email/${kind}`), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(await res.text());
    } catch {
      parsed = null;
    }
    return interpretAuthEmailResponse(res.status, parsed, res.headers.get('retry-after'));
  } catch {
    return UNREACHABLE;
  } finally {
    clearTimeout(timer);
  }
}
