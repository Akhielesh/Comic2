// How the SERVER words a price for this user (P2-SERVER; the twin of services/costDisplay.ts).
//
// Governed users (everyone on the included DreamStream usage: not an admin, not on their own
// key) never see dollars in director or job text — a quote reads as a share of their usage,
// "≈2% of your usage". Admins and calls on the user's own key see real prices ("$0.05").
//
// The share is computed from public registry prices and StudioCaps.usage.pctPerStandardPage
// (how much of the usage one Standard comic page takes) — the same formula as the client, so a
// chip, a gate card and the director's sentence always say the same number. Every amount the
// server words is a CHARGED amount (provider cost × the platform markup for platform keys);
// usage counts provider cost, so the markup is taken back out first.

import type { StudioCaps } from '../../../shared/comic/capabilities.js';
import { PLAN_USD_PER_PAGE, PLATFORM_MARKUP, formatUsd, tierPagePrice } from '../../../shared/comic/models.js';

export interface CostView {
  /** Word prices as a share of the user's usage instead of dollars. */
  governed: boolean;
  /** Percent of the user's usage one provider-cost dollar takes (null when unknown). */
  pctPerUsd: number | null;
}

/** Admin / own-key / legacy context: real prices. */
export const DOLLAR_VIEW: CostView = Object.freeze({ governed: false, pctPerUsd: null });

/** Provider cost of one Standard comic page (the formula behind pctPerStandardPage). */
export const standardPageProviderUsd = (): number => tierPagePrice('standard', true) + PLAN_USD_PER_PAGE;

/**
 * The view for a request's caps. Dollars need a POSITIVE answer that no limit applies (admin,
 * own key, or a usage status that says ungoverned); an unknown usage status keeps a governed
 * user in usage terms. No caps at all (tests, legacy callers with no request) ⇒ dollars.
 */
export function costViewFor(caps?: StudioCaps | null): CostView {
  if (!caps) return DOLLAR_VIEW;
  if (caps.admin || caps.byok || caps.usage?.governed === false) return DOLLAR_VIEW;
  const perPage = caps.usage?.pctPerStandardPage;
  const pageUsd = standardPageProviderUsd();
  return { governed: true, pctPerUsd: typeof perPage === 'number' && perPage > 0 && pageUsd > 0 ? perPage / pageUsd : null };
}

const trimZero = (s: string) => s.replace(/\.0$/, '');

/** "≈2% of your usage" / "<0.1% of your usage" / "free" for a governed user; null for a dollar view. */
const usageWords = (chargedUsd: number, view: CostView): string | null => {
  if (!view.governed) return null;
  const amount = Number.isFinite(chargedUsd) && chargedUsd > 0 ? chargedUsd : 0;
  if (amount === 0) return 'free';
  const perUsd = view.pctPerUsd;
  if (!(typeof perUsd === 'number' && perUsd > 0)) return 'a little of your usage';
  const pct = (amount / PLATFORM_MARKUP) * perUsd;
  if (pct < 0.1) return '<0.1% of your usage';
  if (pct < 10) return `≈${trimZero(pct.toFixed(1))}% of your usage`;
  return `≈${Math.round(pct)}% of your usage`;
};

/** A formatter bound to one user: `fmt(usd)` = "$0.05" | "≈2% of your usage"; `fmt.approx(usd)` = "≈ $0.05" | "≈2% of your usage". */
export interface CostFormatter {
  (chargedUsd: number): string;
  approx(chargedUsd: number): string;
  readonly governed: boolean;
  readonly view: CostView;
}

export function costFormatter(view: CostView = DOLLAR_VIEW): CostFormatter {
  const fmt = ((usd: number) => usageWords(usd, view) ?? formatUsd(usd)) as CostFormatter;
  fmt.approx = (usd: number) => usageWords(usd, view) ?? `≈ ${formatUsd(usd)}`;
  Object.defineProperty(fmt, 'governed', { value: view.governed });
  Object.defineProperty(fmt, 'view', { value: view });
  return fmt;
}

/** The formatter for a studio context (its caps). */
export const costFormatterFor = (ctx: { caps?: StudioCaps | null }): CostFormatter => costFormatter(costViewFor(ctx.caps));

// "≈ $1.23", "~$0.70", "<$0.01", "$0.00", "$0", "($0.05)" — any dollar amount a template or a model wrote.
const DOLLARS_RE = /(?:[≈~]\s?)?(<)?\$(\d+(?:[.,]\d+)?)/g;

/**
 * The safety net under every governed text the server commits (director replies, job
 * completions): any dollar amount left in it — a template that predates the cost view, or a
 * figure the model wrote — becomes usage words. A dollar view returns the text unchanged.
 */
export function governDollars(text: string, view: CostView): string {
  if (!view.governed || !text || !text.includes('$')) return text;
  return text.replace(DOLLARS_RE, (_m, lt: string | undefined, num: string) => {
    // "<$0.01" is a sub-cent amount: word it as half a cent (never "free").
    const usd = lt ? 0.005 : Number(num.replace(',', '.'));
    return usageWords(Number.isFinite(usd) ? usd : 0, view) ?? _m;
  });
}
