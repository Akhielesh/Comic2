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
