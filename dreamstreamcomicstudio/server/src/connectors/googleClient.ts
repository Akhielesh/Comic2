// ============================================================================
// Centralized authenticated Google API client
// ============================================================================
//
// Every Google connector makes its REST calls through googleApiFetch so that auth
// injection, timeouts, rate limiting, exponential backoff (honoring Retry-After) and
// quota/error shaping are uniform and tested in one place.
//
//   * 401  → ConnectorAuthError('unauthorized')   (caller marks "reconnect")
//   * 403 with a rateLimit/quota reason, or 429 → backoff + retry, then
//            ConnectorRateLimitError if still failing (runner re-queues with backoff)
//   * 5xx  → backoff + retry
//
// A light per-host min-interval throttle keeps us a good API citizen across
// concurrent connections without a heavyweight limiter.
// ============================================================================

import { ConnectorAuthError, ConnectorRateLimitError } from './types.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 4;
const MIN_HOST_INTERVAL_MS = 40; // ~25 rps/host ceiling; well under Google defaults

const lastCallByHost = new Map<string, number>();

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return 'googleapis.com';
  }
};

/** Space out same-host calls so bursts don't trip per-second quotas. */
const throttleHost = async (host: string, signal?: AbortSignal): Promise<void> => {
  const now = Date.now();
  const last = lastCallByHost.get(host) ?? 0;
  const wait = last + MIN_HOST_INTERVAL_MS - now;
  if (wait > 0) await sleep(wait, signal);
  lastCallByHost.set(host, Date.now());
};

const parseRetryAfterMs = (res: Response): number | undefined => {
  const h = res.headers.get('retry-after');
  if (!h) return undefined;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(h);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : undefined;
};

const isQuotaError = (status: number, body: string): boolean => {
  if (status === 429) return true;
  // Google returns 403 for both permission AND rate/quota; disambiguate via the body.
  if (status === 403) return /rateLimitExceeded|userRateLimitExceeded|quotaExceeded|dailyLimitExceeded/i.test(body);
  return false;
};

export interface GoogleFetchOptions {
  accessToken: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  /** Query params appended to the URL (undefined values are skipped). */
  query?: Record<string, string | number | boolean | undefined>;
  /** JSON body (object) — serialized + Content-Type set automatically. */
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxRetries?: number;
}

const buildUrl = (url: string, query?: GoogleFetchOptions['query']): string => {
  if (!query) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  }
  return u.toString();
};

/**
 * Make one authenticated Google API request with retries/backoff. Returns parsed
 * JSON (or `{}` for empty 2xx bodies, e.g. 204).
 */
export const googleApiFetch = async <T = unknown>(
  url: string,
  opts: GoogleFetchOptions
): Promise<T> => {
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const host = hostOf(url);
  const fullUrl = buildUrl(url, opts.query);
  let lastErr: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await throttleHost(host, opts.signal);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    let res: Response;
    try {
      res = await fetch(fullUrl, {
        method: opts.method || 'GET',
        headers: {
          Authorization: `Bearer ${opts.accessToken}`,
          Accept: 'application/json',
          ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(opts.headers || {})
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal
      });
    } catch (err) {
      // Network error or timeout → retry with backoff (unless it was a caller abort).
      if ((err as Error)?.name === 'AbortError' && opts.signal?.aborted) throw err;
      lastErr = err;
      if (attempt < maxRetries) {
        await sleep(backoffMs(attempt), opts.signal);
        continue;
      }
      throw new Error(`Google API request to ${host} failed: ${(err as Error)?.message || err}`);
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }

    if (res.status === 401) {
      // Token is invalid/expired/revoked — surface so the caller refreshes or prompts reconnect.
      throw new ConnectorAuthError('unauthorized', 'Google API returned 401 (token invalid or revoked)');
    }

    if (res.ok) {
      if (res.status === 204) return {} as T;
      const text = await res.text();
      if (!text) return {} as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new Error(`Google API ${host} returned an invalid (non-JSON) response`);
      }
    }

    const body = await res.text().catch(() => '');
    if (isQuotaError(res.status, body)) {
      const retryAfter = parseRetryAfterMs(res);
      if (attempt < maxRetries) {
        await sleep(retryAfter ?? backoffMs(attempt), opts.signal);
        continue;
      }
      throw new ConnectorRateLimitError(`Google API ${host} rate limited (${res.status})`, retryAfter);
    }

    if (res.status >= 500 && attempt < maxRetries) {
      await sleep(backoffMs(attempt), opts.signal);
      continue;
    }

    // Other 4xx/5xx — non-retryable (or out of retries). Shape a clear error.
    const reason = extractGoogleError(body) || `HTTP ${res.status}`;
    // A 403 for missing/insufficient OAuth scope is fixable by re-consenting, so surface it
    // as an auth error → the connection is marked "reconnect" (actionable) rather than a dead
    // "error". Quota 403s were already handled above; an API-disabled 403 (admin must enable
    // it in Cloud Console) has no "insufficient scope" wording, so it stays a hard error.
    if (res.status === 403 && /insufficient.{0,20}(scope|permission|authentication)|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(body)) {
      throw new ConnectorAuthError('unauthorized', `Reconnect needed — additional Google permission required: ${reason}`);
    }
    // A 403 because the API itself isn't enabled for the project is an admin toggle in the
    // Cloud Console (reconnecting won't help) — keep it a hard error, but replace Google's
    // wall of text with a concise, actionable message that preserves the enable link.
    if (res.status === 403 && /accessNotConfigured|SERVICE_DISABLED|has not been used in project|\bis disabled\b/i.test(body)) {
      const enableUrl = (body.match(/https:\/\/console\.[^\s"'\\]+/) || [])[0];
      throw new Error(
        `${host} isn't enabled for this Google Cloud project — enable the API${enableUrl ? ` at ${enableUrl}` : ''}, wait ~1 minute, then Sync.`
      );
    }
    throw new Error(`Google API ${host} error: ${reason}`);
  }

  throw lastErr instanceof Error ? lastErr : new Error(`Google API ${host} failed`);
};

/** Decorrelated exponential backoff with jitter: ~0.5s, 1s, 2s, 4s (+jitter), capped. */
const backoffMs = (attempt: number): number => {
  const base = Math.min(8000, 500 * 2 ** attempt);
  return base + Math.floor(Math.random() * 250);
};

const extractGoogleError = (body: string): string | null => {
  try {
    const json = JSON.parse(body) as { error?: { message?: string } | string };
    if (typeof json.error === 'string') return json.error;
    return json.error?.message || null;
  } catch {
    return null;
  }
};
