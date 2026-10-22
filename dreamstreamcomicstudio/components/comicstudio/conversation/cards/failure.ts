// Calm, honest failure copy for render tiles (reliability.md §3; the 2026-10-22 incident).
// A failed tile says WHEN it failed and a short reason ("failed 16:52 · rate limited"), so a
// stale failure from an earlier outage is recognisable at a glance; the provider's exact
// words stay one tap away ("Details"). Pure: no clock reads except through `now`.

export type FailureKind = 'rate_limited' | 'busy' | 'timeout' | 'safety' | 'declined' | 'network' | 'key' | 'stopped' | 'unknown';

const RULES: [FailureKind, RegExp][] = [
  ['stopped', /\b(cancel(?:l?ed)?|stopped|aborted by (?:the )?user)\b/i],
  ['rate_limited', /\b429\b|rate[ -]?limit|too many requests|throttl|quota|resource[_ ]exhausted|cool(?:ing)?[ -]?down/i],
  ['key', /\b40[123]\b|api key|\bkey\b.*(?:invalid|rejected|missing)|unauthori[sz]ed|billing|credits?\b|insufficient|payment/i],
  ['safety', /safety|content[ _-]?policy|prohibited|blocked|moderation|not allowed|pg-?13/i],
  ['declined', /refus|declin|could not (?:comply|generate)|no image (?:was )?returned|empty (?:image|response)/i],
  ['timeout', /time[sd]?[ -]?out|timeout|deadline|took too long/i],
  ['busy', /\b50[0234]\b|overload|unavailable|busy|capacity|upstream|provider (?:error|down)|bad gateway/i],
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
