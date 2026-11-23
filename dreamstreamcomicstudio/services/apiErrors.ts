// Turn an API failure into a short, plain-language message the user can act on — and decide
// whether retrying is worth it. Pure and dependency-free (it duck-types the error, so it does NOT
// import apiClient/supabase) so it is reusable on every surface and unit-testable in isolation.
//
// Two consumers with two different jobs:
//   - classifyApiError → the human-facing { title, detail, retryable } shown in the UI.
//   - isRetryableError → the stricter predicate the network layer uses to AUTO-retry (a 404 is
//     "try again" for a human but should not be hammered automatically).

export interface FriendlyError {
  /** A short headline, e.g. "Can't reach the server". */
  title: string;
  /** One calm, actionable sentence — no codes, no stack traces. */
  detail: string;
  /** Whether a manual "Try again" is a reasonable next step. */
  retryable: boolean;
}

interface ApiErrorLike {
  status?: number;
  message?: string;
  name?: string;
}

const asApiError = (err: unknown): ApiErrorLike =>
  err && typeof err === 'object' ? (err as ApiErrorLike) : {};

/** Bare HTTP status texts apiClient falls back to when the body had no message. */
const STATUS_TEXT_RE =
  /^(bad request|unauthorized|payment required|forbidden|not found|conflict|unprocessable (entity|content)|too many requests|internal server error|not implemented|bad gateway|service unavailable|gateway timeout)$/i;
/** Text that reads like a stack, a driver/transport error or markup — never shown to a user. */
const TECHNICAL_RE =
  /(\b(TypeError|ReferenceError|SyntaxError|RangeError|AbortError|DOMException|Exception|ECONN[A-Z]+|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|fetch failed|Failed to fetch|NetworkError|Load failed|status code|Unexpected token|violates|constraint|stack trace|undefined|NaN|postgres|PGRST\w*|supabase|jwt|bearer|is not a function|is not defined|Cannot read propert(y|ies)|JSON)\b|\bError:|<\/?[a-z!][^>]*>|[{}]|\n\s+at\s)/i;

/**
 * True when a server message is calm, human copy the studio may show verbatim (the studio
 * routes send user-safe `userMessage`s). Bare codes, status texts, stack-ish or driver text,
 * markup and very long strings are not — the caller shows its own copy instead.
 */
export const isFriendlyMessage = (text: unknown): text is string => {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  if (t.length < 4 || t.length > 280) return false;
  if (/^[A-Z0-9_.:-]+$/.test(t)) return false; // a bare code ("NOT_AVAILABLE")
  if (STATUS_TEXT_RE.test(t)) return false;
  return !TECHNICAL_RE.test(t);
};

/** Use the caller's task-specific instructions when a failure contains technical or private detail. */
export const userFacingErrorMessage = (err: unknown, fallback: string): string => {
  const { message, status } = asApiError(err);
  if ((status !== undefined && status >= 500) || !isFriendlyMessage(message) || /https?:\/\/|\bsk-[a-z0-9_-]{8,}/i.test(message)) return fallback;
  return message.trim();
};

/** Map any thrown error to a friendly, actionable description for the UI. */
export const classifyApiError = (err: unknown): FriendlyError => {
  const e = asApiError(err);
  const status = typeof e.status === 'number' ? e.status : undefined;

  if (e.name === 'AbortError') {
    return { title: 'Cancelled', detail: 'The request was cancelled.', retryable: false };
  }
  // safeFetch tags transport failures (CORS block, wrong API URL, server asleep/down) as status 0:
  // the request never reached the server.
  if (status === 0) {
    return {
      title: "Can't reach the AI server",
      detail:
        'The server didn’t respond — it may be waking up from idle, or your connection dropped. This usually clears on its own; try again in a moment.',
      retryable: true
    };
  }
  if (status === 401) {
    return { title: 'Sign-in needed', detail: 'Your session expired — sign in again to continue.', retryable: false };
  }
  if (status === 403) {
    return { title: 'Not allowed', detail: 'You don’t have access for this action. Check your plan or permissions.', retryable: false };
  }
  if (status === 404) {
    return { title: 'Not found yet', detail: 'That endpoint wasn’t found — the app may be mid-deploy. Try again shortly.', retryable: true };
  }
  if (status === 429) {
    return { title: 'One moment', detail: 'Too many requests in a short time. Wait a few seconds and try again.', retryable: true };
  }
  if (status === 408 || status === 504) {
    return { title: 'The server took too long', detail: 'The request timed out — often a cold start or a heavy step. Trying again usually works.', retryable: true };
  }
  if (status === 502 || status === 503) {
    return { title: 'Server is waking up', detail: 'The AI server is starting or briefly unavailable. Give it a moment and retry.', retryable: true };
  }
  if (status !== undefined && status >= 500) {
    return { title: 'Server error', detail: (e.message || '').trim() || 'Something went wrong on the server. Trying again may help.', retryable: true };
  }

  const msg = (e.message || '').trim();
  return {
    title: 'Something went wrong',
    detail: msg || 'An unexpected error occurred.',
    retryable: false
  };
};

/** A compact one-line message ("Title — detail") for log lines / banners. */
export const describeApiError = (err: unknown): string => {
  const f = classifyApiError(err);
  return `${f.title} — ${f.detail}`;
};

// Statuses worth retrying AUTOMATICALLY at the network layer: transport failure (0), timeouts,
// too-early/rate-limit, and gateway/server errors. Deliberately NOT 404 (don't hammer a wrong
// path) and NOT 401/403 (a retry with the same token won't help).
const AUTO_RETRY_STATUS = new Set([0, 408, 425, 429, 500, 502, 503, 504]);

/** Stricter predicate for the network layer's automatic retry policy. */
export const isRetryableError = (err: unknown): boolean => {
  const e = asApiError(err);
  if (e.name === 'AbortError') return false;
  const status = typeof e.status === 'number' ? e.status : undefined;
  if (status === undefined) return false;
  return AUTO_RETRY_STATUS.has(status) || status >= 500;
};
