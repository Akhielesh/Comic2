// Shared, typed provider errors.
//
// A model-call timeout is an UPSTREAM / model condition (the chosen model was too slow),
// NOT a server bug. Surfacing it as a generic 500 INTERNAL_ERROR mislabels it in the
// logs and masks the actionable message in production. This tags it as a 504 with a
// user-safe message so the API answers with GATEWAY_TIMEOUT / MODEL_TIMEOUT and the
// "pick a faster model" guidance reaches the user instead of "Unexpected server error".

export type TaggedError = Error & {
  status?: number;
  publicCode?: string;
  /** A message that is safe to show the user even in production (not masked as a 5xx). */
  publicMessage?: string;
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
