// Calm, honest failure copy for render tiles (reliability.md §3; the 2026-10-22 incident).
// A failed tile says WHEN it failed and a short reason ("failed 16:52 · rate limited"), so a
// stale failure from an earlier outage is recognisable at a glance; the provider's exact
// words stay one tap away ("Details"). Pure: no clock reads except through `now`.
// `failureFacts` reads the optional `RenderState.errorDetail` (sanitized provider facts and the
// exact failure time) when the server sets it, and falls back to `error` + `updatedAt`.

export type FailureKind = 'rate_limited' | 'busy' | 'timeout' | 'safety' | 'declined' | 'network' | 'key' | 'limit' | 'stopped' | 'unknown';

// Order matters: the studio's own sentences come first (server imageClient/billing copy — e.g.
// "took longer than 120s and was stopped" is a timeout, not a stop; "at capacity … add your own
// key" is a busy service, not a key problem), then generic provider vocabulary.
const RULES: [FailureKind, RegExp][] = [
  ['stopped', /^\s*cancel(?:l)?ed\b|\b(?:cancel(?:l)?ed|stopped|aborted) by (?:the )?user\b/i],
  ['timeout', /time[sd]?[ -]?out|timeout|deadline|took (?:too )?long(?:er)?\b/i],
  ['safety', /safety|content[ _-]?policy|content rules|prohibited|moderation|not allowed|pg-?13|\bblocked\b/i],
  ['limit', /used (?:all of )?(?:your|this month['’]s)\b|generation limit|usage limit|overage cap|included (?:credits|generation allowance)|enough credits|payment method/i],
  ['rate_limited', /\b429\b|rate[ -]?limit|too many requests|throttl|resource[_ ]exhausted|cool(?:ing)?[ -]?down/i],
  ['busy', /\b50[0234]\b|overload|unavailable|(?:not|n['’]t) available|busy|capacity|upstream|provider (?:error|down)|bad gateway|temporar|couldn['’]t check/i],
  ['key', /\b40[123]\b|api key|\bkey\b.*(?:invalid|rejected|missing|quota|credits|limit)|rejected (?:the |your )?(?:platform )?key|unauthori[sz]ed|billing|credits?\b|insufficient|payment/i],
  ['rate_limited', /quota/i],
  ['declined', /refus|declin|could not (?:comply|generate)|no image (?:was )?returned|without (?:a |an )?(?:picture|image)|empty (?:image|response)|rejected the request/i],
  ['network', /network|fetch failed|econn|socket|connection|offline|dns/i]
];

/** Classify a raw render error (the provider's words, or ours) into a short reason. */
export const failureKind = (error?: string | null): FailureKind => {
  const text = (error || '').trim();
  if (!text) return 'unknown';
  for (const [kind, re] of RULES) if (re.test(text)) return kind;
  return 'unknown';
};

const REASON: Record<FailureKind, string> = {
  rate_limited: 'rate limited',
  busy: 'provider busy',
  timeout: 'timed out',
  safety: 'held by the safety check',
  declined: 'the model declined',
  network: 'connection dropped',
  key: 'key or billing issue',
  limit: 'usage limit reached',
  stopped: 'stopped',
  unknown: 'didn’t finish'
};

/** "rate limited", "provider busy", … (lower case; reads after "failed 16:52 · "). */
export const failureReason = (error?: string | null): string => REASON[failureKind(error)];

/** Retrying is worth offering (a stop or a policy hold usually needs a change first). */
export const isTransientFailure = (error?: string | null): boolean => {
  const k = failureKind(error);
  return k === 'rate_limited' || k === 'busy' || k === 'timeout' || k === 'network' || k === 'unknown' || k === 'declined';
};

const pad = (n: number) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * When it failed, in the viewer's local time: "16:52" today, "yesterday 16:52", "Oct 20, 16:52"
 * otherwise. 24-hour clock on purpose — short and unambiguous in a 92 px tile caption.
 */
export const formatFailedAt = (at: number | undefined, now: number = Date.now()): string | undefined => {
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return undefined;
  const d = new Date(at);
  const today = new Date(now);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, today)) return time;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sameDay(d, yesterday)) return `yesterday ${time}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${time}`;
};

/** "failed 16:52 · rate limited" (or "failed · rate limited" when the time is unknown). */
export const failureCaption = (error: string | undefined, at: number | undefined, now: number = Date.now()): string => {
  const when = formatFailedAt(at, now);
  return `failed${when ? ` ${when}` : ''} · ${failureReason(error)}`;
};

/** What a failed render says about itself, from whichever fields the server filled. */
export interface FailureFacts {
  /** The words to classify and show under "Details" (the render's error, else the detail text). */
  error?: string;
  /** When it failed: errorDetail.at when present (exact), else the render's last update. */
  at?: number;
  /** Sanitized provider facts, one line ("OpenRouter · 429 · upstream Google"). Never a body or a key. */
  facts?: string;
  attempts?: number;
}

const MAX_FACTS = 120;
const str = (v: unknown, max = 400): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const finite = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);

/**
 * Read a render's failure, tolerating both shapes of `errorDetail` the contract may carry
 * (wm-plan: `{ code, provider?, at, text }`; the P1-JOBS amendment: a ≤120-char string) and
 * old docs without it. Only for `status === 'failed'` renders; pure.
 */
export const failureFacts = (render: { error?: string; updatedAt?: number; attempts?: number } | undefined | null): FailureFacts => {
  if (!render) return {};
  const detail = (render as { errorDetail?: unknown }).errorDetail;
  let facts = '';
  let at = finite(render.updatedAt);
  let code = '';
  let text = '';
  if (typeof detail === 'string') {
    facts = str(detail, MAX_FACTS);
  } else if (detail && typeof detail === 'object') {
    const d = detail as { code?: unknown; provider?: unknown; at?: unknown; text?: unknown };
    code = str(d.code, 40);
    text = str(d.text);
    facts = [str(d.provider, 40), code].filter(Boolean).join(' · ').slice(0, MAX_FACTS);
    at = finite(d.at) ?? at;
  }
  const own = str(render.error, 2000);
  // Classify on the provider code too, so "429" in the detail reads "rate limited" even when the
  // user-facing error is a softer sentence.
  const error = [own || text, own && text && !own.includes(text) ? text : '', code && !(own || text).includes(code) ? code : '']
    .filter(Boolean)
    .join(' — ');
  const attempts = finite(render.attempts);
  return {
    ...(error ? { error } : {}),
    ...(at ? { at } : {}),
    ...(facts ? { facts } : {}),
    ...(attempts ? { attempts } : {})
  };
};
