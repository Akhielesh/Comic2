// Shared, typed provider errors.
//
// A model-call timeout is an UPSTREAM / model condition (the chosen model was too slow),
// NOT a server bug. Surfacing it as a generic 500 INTERNAL_ERROR mislabels it in the
// logs and masks the actionable message in production. This tags it as a 504 with a
// user-safe message so the API answers with GATEWAY_TIMEOUT / MODEL_TIMEOUT and the
// "pick a faster model" guidance reaches the user instead of "Unexpected server error".

import { redactSecrets } from '../../lib/redact.js';

export type TaggedError = Error & {
  status?: number;
  publicCode?: string;
  /** A message that is safe to show the user even in production (not masked as a 5xx). */
  publicMessage?: string;
  /** The vendor's own HTTP status (vendorHttpError); `status` is what our API answers. */
  vendorStatus?: number;
};

// Build a tagged 504 timeout error. `message` is kept for logs; `publicMessage`
// (defaults to `message`) is what the user sees — keep it free of internal labels.
export const makeTimeoutError = (message: string, publicMessage?: string): TaggedError => {
  const err = new Error(message) as TaggedError;
  err.status = 504;
  err.publicCode = 'MODEL_TIMEOUT';
  err.publicMessage = publicMessage ?? message;
  return err;
};

export const modelTimeoutError = (timeoutMs: number): TaggedError => {
  const seconds = Math.round(timeoutMs / 1000);
  return makeTimeoutError(`The model took too long to respond (timed out after ${seconds}s). Please try again, or pick a faster model.`);
};

// Map an upstream provider HTTP failure to a tagged error that carries a server-safe status
// and a user-safe publicMessage. Without this, a provider 403/402/4xx/5xx is thrown as a bare
// Error with no `.status`, so the error handler defaults it to 500 "Unexpected server error"
// (mislabeling it in server_error telemetry) and the raw provider JSON can leak via the SSE
// path. The original `logMessage` is preserved as the Error message for logs AND so the
// existing message-based retriable checks (which look for "404"/"429"/"rate limit") still work.
export const makeProviderError = (status: number, logMessage: string): TaggedError => {
  const err = new Error(logMessage) as TaggedError;
  const lower = logMessage.toLowerCase();
  // Shared-key spend cap (OpenRouter 403 "Key limit exceeded (total limit)") → capacity, not a bug.
  if (status === 403 && /key limit|limit exceeded|quota|insufficient/.test(lower)) {
    err.status = 503;
    err.publicCode = 'PROVIDER_CAPACITY';
    err.publicMessage =
      'The shared AI service is at capacity right now. Try again shortly, switch to a free model, or add your own API key in Settings.';
    return err;
  }
  // Out of credits (402 "requires more credits, or fewer max_tokens").
  if (status === 402 || /requires more credits|insufficient credits|payment required/.test(lower)) {
    err.status = 503;
    err.publicCode = 'PROVIDER_CAPACITY';
    err.publicMessage =
      'The shared AI service is temporarily out of credits. Switch to a free model or add your own API key in Settings.';
    return err;
  }
  // Rate limited.
  if (status === 429 || /rate.?limit|too many requests/.test(lower)) {
    err.status = 429;
    err.publicCode = 'RATE_LIMITED';
    err.publicMessage = 'Too many requests right now — wait a moment and try again, or switch to a different model.';
    return err;
  }
  // A bad/unknown model id passed through to the provider (e.g. an image model on the chat path).
  if (status === 400 && /not a valid model|valid model id|unknown model|no such model/.test(lower)) {
    err.status = 400;
    err.publicCode = 'MODEL_NOT_FOUND';
    err.publicMessage = "That model isn't available. Pick another model from the Model Library, or use Auto.";
    return err;
  }
  // Upstream 5xx is the provider's fault, not ours → 502 Bad Gateway with a safe message.
  if (status >= 500) {
    err.status = 502;
    err.publicCode = 'BAD_GATEWAY';
    err.publicMessage = 'The AI provider had a temporary problem. Please try again.';
    return err;
  }
  // Other 4xx: preserve the status but don't expose the raw body.
  err.status = status;
  return err;
};

// A failed vendor HTTP call, made with a person's key or the platform's. The message keeps the
// shape the rest of the server reads ("<Label> <path> failed: <status> …": comic/llm.ts statusOf,
// the fallback and retry checks that look for 404/429/503) and the vendor's short error code (so
// words like content_policy_violation still reach the safety classifiers), but never the raw body:
// the detail is the vendor's own error message, redacted (lib/redact.ts) and capped, because some
// vendors echo the key they refused.
//
// The vendor's status is kept as `.vendorStatus` (and in the message); `.status` is what our own
// API answers, mapped like makeProviderError: a vendor 401 passed through would read as "your
// session expired" in the app, a 403 as "check your plan", a 404 as "the app may be mid-deploy",
// and a vendor 4xx would drop out of the server_error telemetry.
const VENDOR_CODE_RE = /^[A-Za-z0-9_.-]{1,48}$/;
const VENDOR_DETAIL_MAX = 160;
const VENDOR_STATUS_TEXT_MAX = 60;
/** Bodies past this size are not parsed as JSON; their first characters are the detail. */
const VENDOR_JSON_MAX = 65_536;

const vendorCode = (...candidates: unknown[]): string | undefined => {
  for (const c of candidates) {
    if (typeof c !== 'string' && typeof c !== 'number') continue;
    const s = String(c);
    // A numeric code only repeats the HTTP status (OpenRouter, Gemini); a word says more.
    if (/^\d+$/.test(s)) continue;
    // A "code" shaped like a key is dropped, never printed: the code is not redacted otherwise.
    if (VENDOR_CODE_RE.test(s) && redactSecrets(s) === s) return s;
  }
  return undefined;
};

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};

/** The vendor's error code and message from an OpenAI, Anthropic, Gemini or OpenRouter style body. */
const readVendorBody = (bodyText: string): { code?: string; message?: string } => {
  if (!bodyText || bodyText.length > VENDOR_JSON_MAX) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return {};
  }
  const root = (Array.isArray(parsed) ? parsed[0] : parsed) as Record<string, unknown> | null;
  if (!root || typeof root !== 'object') return {};
  const inner = root.error;
  if (typeof inner === 'string') return { code: vendorCode(root.code, root.type, root.status), message: inner };
  const e = (inner && typeof inner === 'object' ? inner : root) as Record<string, unknown>;
  const message = [e.message, root.message, root.detail, root.error_description].find((m): m is string => typeof m === 'string' && m.trim() !== '');
  return { code: vendorCode(e.code, e.type, e.status), message };
};

/** A spend cap or an empty balance, in a vendor's words (a 403 that is not a refused key). */
const VENDOR_CAPACITY_RE = /key limit|limit exceeded|spending limit|quota|insufficient|credit|billing|balance/i;
/** A refusal of the content rather than of the key. */
const VENDOR_SAFETY_RE = /content.?policy|safety|moderation|flagged|prohibited/i;

/** Our status, public code and user-safe sentence for a vendor's HTTP failure. */
const mapVendorStatus = (
  label: string,
  status: number,
  text: string,
  byok: boolean
): { status: number; publicCode: string; publicMessage: string } => {
  if (status === 402 || (status === 403 && VENDOR_CAPACITY_RE.test(text))) {
    return {
      status: 503,
      publicCode: 'PROVIDER_CAPACITY',
      publicMessage: byok
        ? `Your ${label} key is out of credit or over its spending limit. Top it up or raise the limit, then try again.`
        : 'The AI service is out of credit right now. Try again later, or add your own key in Settings → API keys.'
    };
  }
  // A 403 for the content (a safety filter) is not a refused key: it takes the generic sentence.
  if (status === 401 || (status === 403 && !VENDOR_SAFETY_RE.test(text))) {
    return {
      status: 502,
      publicCode: 'PROVIDER_KEY_REJECTED',
      publicMessage: byok
        ? `Your ${label} key was refused. Check it in Settings → API keys.`
        : 'The AI service refused the request. Please try again later.'
    };
  }
  if (status === 404) {
    return { status: 502, publicCode: 'MODEL_NOT_FOUND', publicMessage: `That model isn't available from ${label} right now. Pick another model.` };
  }
  if (status === 429) {
    return { status: 429, publicCode: 'RATE_LIMITED', publicMessage: `${label} is busy right now (too many requests). Wait a moment and try again.` };
  }
  if (status >= 500) {
    return { status: 502, publicCode: 'BAD_GATEWAY', publicMessage: `${label} had a temporary problem. Please try again.` };
  }
  // Any other vendor 4xx (400, 413, 422 …) is a request the vendor turned down: still the
  // upstream's answer, not a bad request from our client, and worth a server_error row. Its own
  // code (not BAD_GATEWAY) so comic/llm.ts keeps treating it as a refusal, not a blip to retry.
  return { status: 502, publicCode: 'PROVIDER_REJECTED', publicMessage: `${label} couldn't take this request. Try again, rephrase it, or pick another model.` };
};

export const vendorHttpError = (
  label: string,
  path: string,
  status: number,
  statusText: string,
  bodyText: string,
  opts: { byok?: boolean } = {}
): TaggedError => {
  const body = typeof bodyText === 'string' ? bodyText : '';
  const { code, message } = readVendorBody(body);
  // A non-JSON (or message-less) body gives its first characters. Redaction runs before the clip
  // (redactSecrets caps its own input and drops a token the cap cuts), so no key fragment is kept.
  const detail = clip(redactSecrets(message ?? body), VENDOR_DETAIL_MAX);
  const reason = clip(redactSecrets(String(statusText || '')), VENDOR_STATUS_TEXT_MAX);
  const parts = [`${label} ${path} failed: ${status}`];
  if (reason) parts.push(reason);
  if (code) parts.push(`(${code})`);
  if (detail) parts.push(detail);
  const err = new Error(parts.join(' ')) as TaggedError;
  err.vendorStatus = status;
  const mapped = mapVendorStatus(label, status, `${code ?? ''} ${detail}`, Boolean(opts.byok));
  err.status = mapped.status;
  err.publicCode = mapped.publicCode;
  err.publicMessage = mapped.publicMessage;
  return err;
};

// Produce a message that is always safe to show the user (used on the SSE error path, which
// bypasses the Express error handler). Prefers an explicit publicMessage; otherwise passes
// through only short, detail-free upstream phrasings and falls back to a generic line — so raw
// provider JSON, SQL, or stack text never reaches the chat transcript.
export const safeClientMessage = (error: unknown, fallback = 'The request failed. Please try again.'): string => {
  const e = error as TaggedError | undefined;
  if (e && typeof e.publicMessage === 'string' && e.publicMessage.trim()) return e.publicMessage;
  const msg = String((e as Error)?.message || '').trim();
  // Allow only clean, actionable phrasings with no internal markers (no JSON, "failed:", codes, SQL).
  if (
    msg &&
    msg.length <= 180 &&
    !/[{}]|failed:|status|syntax|constraint|schema cache|http|\b\d{3}\b/i.test(msg) &&
    /no response|too long|timed out|no endpoints|not available|try again|faster model/i.test(msg)
  ) {
    return msg;
  }
  return fallback;
};
