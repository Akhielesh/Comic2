// Key-shaped text never reaches an error message, a log line or a chat message.
//
// redactSecrets replaces anything that looks like a provider key (or a vendor's masked echo of one)
// with "[key]". It is used on vendor error bodies (ai/providers/errors.ts vendorHttpError, the
// OpenRouter and NVIDIA adapters), on every string the structured logger writes (lib/logger.ts) and
// on the central server_error line (middleware/errors.ts).
//
// A key may start right after a word boundary, a JSON escape in raw body text ("\n", "\t",
// "=") or a percent-encoding ("%3D", "%20"): raw bodies are redacted as text, not parsed.
//
// Bounded and linear: the patterns run on at most REDACT_MAX_CHARS + REDACT_LOOKAHEAD characters,
// and the patterns that need to look past a run of characters use an atomic step (a lookahead
// capture plus a back-reference), so no input makes them backtrack. The output keeps at most
// REDACT_MAX_CHARS characters; where that cut (or the end of the look-ahead window) falls inside a
// run of key characters, the run's tail is dropped from its last key prefix, or whole when it is
// short, so no key fragment is left behind; a long run with no key prefix (minified JSON, base64,
// a URL) is cut hard and keeps its first REDACT_MAX_CHARS characters.

export const REDACT_MAX_CHARS = 4000;
/** Characters past the cap that the patterns still see, so a key across the cap is matched whole. */
export const REDACT_LOOKAHEAD = 256;
export const REDACTED = '[key]';

const MASK = '(?:\\*{3,}|…)';
/** Where a key may begin: a word boundary, or just after a JSON escape or a %XX encoding. */
const B = '(?:\\b|(?<=\\\\[nrtbf])|(?<=\\\\u[0-9A-Fa-f]{4})|(?<=%[0-9A-Fa-f]{2}))';
const re = (body: string, flags = 'g'): RegExp => new RegExp(`${B}${body}`, flags);

/** Patterns replaced whole, most specific first. */
const WHOLE: RegExp[] = [
  // JSON web tokens (Supabase access tokens, MiniMax keys).
  re('eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}'),
  re('sk-or-v1-[A-Za-z0-9]{16,}'),
  re('sk-ant-[A-Za-z0-9_-]{16,}'),
  re('sk-(?:proj-)?[A-Za-z0-9_-]{16,}'),
  re('xai-[A-Za-z0-9]{16,}'),
  re('nvapi-[A-Za-z0-9_-]{16,}'),
  re('AIza[0-9A-Za-z_-]{30,}'),
  // Z.AI keys: 32 hex characters, a dot, 16 more.
  re('[0-9a-f]{32}\\.[A-Za-z0-9]{16,}\\b'),
  // A masked key on its own ("sk-proj-ab12****wxyz", "sk-ab12…9xyz").
  re(`(?:sk-|xai-|nvapi-|AIza)(?=([A-Za-z0-9_-]*))\\1${MASK}[A-Za-z0-9_.*…-]*`)
];

/**
 * A bearer value: eight or more characters with a digit or a token symbol in them, or twenty or
 * more of anything, so "the bearer of bad news" stays as written.
 */
const BEARER_VALUE = '(?:(?=[^\\s\\d_.~+/=-]*[\\d_.~+/=-])\\S{8,}|\\S{20,})';

/** Patterns whose leading word is kept: "Bearer [key]", "x-api-key: [key]", "provided: [key]". */
const PREFIXED: [RegExp, string][] = [
  [re(`(bearer)\\s+(?!\\[key\\])${BEARER_VALUE}`, 'gi'), `$1 ${REDACTED}`],
  [re('(x-api-key:?)\\s+(?!\\[key\\])\\S+', 'gi'), `$1 ${REDACTED}`],
  [re(`(provided|key)\\s*:\\s*(?=([^\\s*…]*))\\2${MASK}\\S*`, 'gi'), `$1: ${REDACTED}`]
];

/** Characters a key, a masked key or a JWT is made of. */
const isKeyChar = (code: number): boolean =>
  (code >= 48 && code <= 57) || // 0-9
  (code >= 65 && code <= 90) || // A-Z
  (code >= 97 && code <= 122) || // a-z
  code === 45 || code === 46 || code === 95 || code === 42 || code === 8230; // - . _ * …

const KEY_PREFIX_RE = /sk-|xai-|nvapi-|AIza|eyJ/g;
/** A run this short at the cut is dropped whole; a longer one with no key prefix is cut hard. */
const SHORT_RUN = 64;

/** Drop a possible key fragment from the end of `out`, where a run of key characters was cut. */
const trimCutRun = (out: string): string => {
  let start = out.length;
  while (start > 0 && isKeyChar(out.charCodeAt(start - 1))) start -= 1;
  const run = out.slice(start);
  if (!run) return out;
  let lastPrefix = -1;
  KEY_PREFIX_RE.lastIndex = 0;
  for (let m = KEY_PREFIX_RE.exec(run); m; m = KEY_PREFIX_RE.exec(run)) lastPrefix = m.index;
  if (lastPrefix >= 0) return out.slice(0, start + lastPrefix);
  if (run.length <= SHORT_RUN) return out.slice(0, start);
  return out;
};

/** Preserve a complete input or reply whose size has already been bounded by the conversation API. */
export const redactConversationKeys = (s: string): string => {
  let out = s;
  for (const pattern of WHOLE) out = out.replace(pattern, REDACTED);
  for (const [pattern, replacement] of PREFIXED) out = out.replace(pattern, replacement);
  return out;
};

/** Replace key-shaped text with "[key]". Keeps at most REDACT_MAX_CHARS characters (a trailing "…" marks the cut). */
export const redactSecrets = (text: string): string => {
  if (text === undefined || text === null) return '';
  const s = typeof text === 'string' ? text : String(text);
  if (s.length <= REDACT_MAX_CHARS) return redactConversationKeys(s);
  const windowEnd = REDACT_MAX_CHARS + REDACT_LOOKAHEAD;
  const w = redactConversationKeys(s.slice(0, windowEnd));
  // The first character past the kept text: inside the redacted window, or past the window itself.
  const cutInsideWindow = w.length > REDACT_MAX_CHARS;
  let out = cutInsideWindow ? w.slice(0, REDACT_MAX_CHARS) : w;
  const next = cutInsideWindow ? w.charCodeAt(REDACT_MAX_CHARS) : s.length > windowEnd ? s.charCodeAt(windowEnd) : NaN;
  if (Number.isFinite(next) && isKeyChar(next)) out = trimCutRun(out);
  // Keys shrink to "[key]": when everything fitted after all, nothing was cut and no mark is added.
  const cut = cutInsideWindow || s.length > windowEnd;
  return cut ? `${out}…` : out;
};

/** JSON.stringify replacer: every string (after any toJSON, so Dates stay ISO strings) is redacted. */
export const redactJsonStrings = (_key: string, value: unknown): unknown => (typeof value === 'string' ? redactSecrets(value) : value);
