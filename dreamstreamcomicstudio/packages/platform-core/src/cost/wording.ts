/**
 * Usage wording (plan §5.6). Governed users (everyone on the shared included usage: not an admin, not on their own
 * key) never see a dollar sign: what is left reads "93% usage left", a price reads "≈2% of your usage". Admins and
 * own-key calls see dollars. Server-to-server costs travel only as `X-Platform-Cost-Micros`.
 *
 * `costLabel` is DreamStream's own `formatCostForUser` (services/costDisplay.ts) word for word, and `formatUsd` its
 * `formatUsd` (shared/comic/models.ts), so a chip, a card and a sentence agree; src/cost/wording.test.ts checks the
 * parity over 1,000 seeded amounts and every kind of share. A property test runs the same amounts (negative, zero,
 * tiny, huge, NaN, Infinity) through every governed path and finds no `$`.
 */

/** How to word money for one user. `pctPerUsd`: percent of their usage one provider-cost dollar takes. */
export interface UsageView {
  governed: boolean;
  pctPerUsd?: number | null;
}

/** "about 55 standard comic pages": the friendly unit the host counts in. */
export interface UsageUnits {
  count: number;
  /** Plural noun phrase ("standard comic pages"). */
  label: string;
}

export interface UsageLabelInput {
  governed: boolean;
  /** Share of the allowance left, 0–1; `null`/absent when unknown (or, for an ungoverned user, unlimited). */
  fractionLeft?: number | null;
  units?: UsageUnits;
}

/** The response header that carries a server-to-server cost (millionths of a dollar). */
export const COST_MICROS_HEADER = 'X-Platform-Cost-Micros';

const finite = (v: unknown): v is number => typeof v === 'number' && isFinite(v);

const trimZero = (s: string): string => s.replace(/\.0$/, '');

/** Remove every dollar sign (and the amount glued to it) from text a governed user will read. */
const noDollars = (text: string): string => text.replace(/[≈~]?\s?<?\$\s?[\d.,]*/g, '').replace(/\$/g, '').replace(/\s{2,}/g, ' ').trim();

/** "93% usage left", "Less than 1% usage left", "No usage left", "Usage left unknown". Never contains `$`. */
export const usageLabel = (input: UsageLabelInput): string => {
  const governed = !!(input && input.governed);
  const f = input ? input.fractionLeft : undefined;
  let label: string;
  if (!finite(f)) label = governed ? 'Usage left unknown' : 'No usage limit';
  else if (f <= 0) label = 'No usage left';
  else if (f * 100 < 1) label = 'Less than 1% usage left';
  else label = `${Math.floor(Math.min(1, f) * 100)}% usage left`;
  const u = input ? input.units : undefined;
  if (u && finite(u.count) && u.count >= 0 && typeof u.label === 'string' && u.label.trim() && finite(f) && f > 0) {
    const noun = noDollars(u.label).slice(0, 80);
    if (noun) label += ` — about ${Math.floor(u.count)} ${noun}`;
  }
  return governed ? noDollars(label) : label;
};

/** "$1250.50" / "<$0.01" / "$0.00" (two decimals, the host's `formatUsd`). Only ever for ungoverned users. */
export const formatUsd = (usd: number): string => {
  if (!finite(usd) || usd <= 0) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
};

/** What a governed price reads while the user's share is unknown (fail closed): the host's `UNKNOWN_USAGE_SHARE`. */
export const UNKNOWN_USAGE_SHARE = 'uses a little of your usage';

/** The same inside a sentence ("costs a little of your usage"): the host's `amountInSentence` noun phrase. */
export const UNKNOWN_USAGE_SHARE_IN_SENTENCE = 'a little of your usage';

/**
 * A price for this user, exactly as the host's `formatCostForUser` words it: "≈2% of your usage" / "<0.1% of your
 * usage" / "Free" / `UNKNOWN_USAGE_SHARE` when governed; "$0.05" / "$0.00" otherwise.
 */
export const costLabel = (usd: number, view: UsageView): string => {
  const amount = finite(usd) && usd > 0 ? usd : 0;
  if (!view || !view.governed) return formatUsd(amount);
  if (amount === 0) return 'Free';
  const perUsd = view.pctPerUsd;
  if (!(typeof perUsd === 'number' && perUsd > 0)) return UNKNOWN_USAGE_SHARE;
  const pct = amount * perUsd;
  if (pct < 0.1) return '<0.1% of your usage';
  if (pct < 10) return `≈${trimZero(pct.toFixed(1))}% of your usage`;
  return `≈${Math.round(pct)}% of your usage`;
};

const DOLLARS = /(?:[≈~]\s?)?(<)?\$\s?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)/g;

/**
 * The safety net under every governed text: each dollar amount becomes usage words, and any `$` left (a stray sign,
 * a malformed amount) is removed. An ungoverned view returns the text unchanged.
 */
export const governText = (text: string, view: UsageView): string => {
  if (typeof text !== 'string') return '';
  if (!view || !view.governed || text.indexOf('$') === -1) return text;
  const worded = text.replace(DOLLARS, (_m: string, lt: string | undefined, num: string) => {
    const label = costLabel(lt ? 0.005 : Number(num.replace(/,/g, '')), view);
    return label === UNKNOWN_USAGE_SHARE ? UNKNOWN_USAGE_SHARE_IN_SENTENCE : label; // it reads inside a sentence
  });
  return worded.replace(/\$/g, '');
};

/** USD → whole millionths (never negative; non-finite → 0). */
export const usdToMicros = (usd: number): number => (finite(usd) && usd > 0 ? Math.min(Number.MAX_SAFE_INTEGER, Math.round(usd * 1000000)) : 0);

export const microsToUsd = (micros: number): number => (finite(micros) && micros > 0 ? micros / 1000000 : 0);
