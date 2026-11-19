// Key-shaped text never reaches an error message, a log line or a chat message.
//
// redactSecrets replaces anything that looks like a provider key (or a vendor's masked echo of one)
// with "[key]". It is used on vendor error bodies (ai/providers/errors.ts vendorHttpError, the
// OpenRouter and NVIDIA adapters) and on every string the structured logger writes (lib/logger.ts).
//
// Bounded and linear: the input is capped at REDACT_MAX_CHARS before any pattern runs, and the
// patterns that need to look past a run of characters use an atomic step (a lookahead capture plus a
// back-reference), so no input makes them backtrack. A key cut in half by the cap is dropped rather
// than left behind as a fragment.

export const REDACT_MAX_CHARS = 4000;
export const REDACTED = '[key]';

const MASK = '(?:\\*{3,}|…)';

/** Patterns replaced whole, most specific first. */
const WHOLE: RegExp[] = [
  // JSON web tokens (Supabase access tokens, MiniMax keys).
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\bsk-or-v1-[A-Za-z0-9]{16,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/g,
  /\bxai-[A-Za-z0-9]{16,}/g,
  /\bnvapi-[A-Za-z0-9_-]{16,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  // A masked key on its own ("sk-proj-ab12****wxyz", "sk-ab12…9xyz").
  new RegExp(`\\b(?:sk-|xai-|nvapi-|AIza)(?=([A-Za-z0-9_-]*))\\1${MASK}[A-Za-z0-9_.*…-]*`, 'g')
];

/** Patterns whose leading word is kept: "Bearer [key]", "x-api-key: [key]", "provided: [key]". */
const PREFIXED: [RegExp, string][] = [
  [/(\bBearer|\b[xX]-[aA][pP][iI]-[kK][eE][yY]:?)\s+(?!\[key\])\S+/g, `$1 ${REDACTED}`],
  [new RegExp(`\\b(provided|key)\\s*:\\s*(?=([^\\s*…]*))\\2${MASK}\\S*`, 'gi'), `$1: ${REDACTED}`]
];

/** Space, tab, newline, carriage return, form feed, vertical tab, no-break space. */
const isSpace = (code: number): boolean => code === 32 || (code >= 9 && code <= 13) || code === 160;

/** Replace key-shaped text with "[key]". Caps the input at REDACT_MAX_CHARS (a trailing "…" marks the cut). */
export const redactSecrets = (text: string): string => {
  if (text === undefined || text === null) return '';
  let s = typeof text === 'string' ? text : String(text);
  let cut = false;
  if (s.length > REDACT_MAX_CHARS) {
    let end = REDACT_MAX_CHARS;
    // The cap fell inside a token: drop that token's kept half so no key fragment survives.
    if (!isSpace(s.charCodeAt(end))) while (end > 0 && !isSpace(s.charCodeAt(end - 1))) end -= 1;
    s = s.slice(0, end);
    cut = true;
  }
  for (const re of WHOLE) s = s.replace(re, REDACTED);
  for (const [re, replacement] of PREFIXED) s = s.replace(re, replacement);
  return cut ? `${s}…` : s;
};
