// Pure, dependency-free chat error normalization. Kept standalone (no api/supabase imports)
// so it's trivially testable and safe to import from anywhere.

/**
 * Turn a raw chat failure into a short, actionable, human message. The server now maps
 * upstream timeouts to friendly text, but a bare abort/timeout can still slip through
 * (e.g. a cut SSE connection), and "This operation was aborted" / "Failed to fetch" mean
 * nothing to a user — so we normalize them here too.
 */
export const friendlyChatError = (err: unknown): string => {
  const msg = String((err as Error)?.message || '').trim();
  const lower = msg.toLowerCase();
  if (!msg) return 'The request failed. Please try again.';
  if (
    lower.includes('aborted') ||
    lower.includes('timed out') ||
    lower.includes('timeout') ||
    lower.includes('stopped responding')
  ) {
    return 'The model took too long to respond and the connection timed out. Try again, or switch to a faster model.';
  }
  if (
    lower.includes('failed to fetch') ||
    lower.includes('network error') ||
    lower.includes('networkerror') ||
    lower.includes('load failed') ||
    lower.includes('network connection was lost')
  ) {
    return 'The connection to the AI server was interrupted. Check your internet and try again.';
  }
  // A model that's in the catalog but not enabled on the user's provider account.
  // NVIDIA returns 404 "Function '…': Not found for account '…'"; OpenRouter returns
  // "No endpoints found for <model>". Both mean: this model isn't callable for you.
  if (
    lower.includes('not found for account') ||
    lower.includes('no endpoints found') ||
    (lower.includes('not found') && lower.includes('function'))
  ) {
    return "That model isn't available on your provider account (it's listed in the catalog but your key can't call it). Pick a different model or source.";
  }
  return msg;
};
