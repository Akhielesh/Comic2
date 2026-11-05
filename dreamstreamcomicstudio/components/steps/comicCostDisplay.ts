// What a comic has cost so far, shown the way THIS user should see it (P1-LIMITS / P2-PLATFORM).
//
// GET /api/billing/comic-cost/:comicId answers in two shapes:
//   - admins, exempt accounts, metering off → the dollar report (ComicCostReport);
//   - governed users (the usage budget limits them) → shares of their usage, no money at all
//     (`governed: true`, `usagePct`, per-stage/per-model shares, and how many calls ran on their
//     own key).
// The client adds a second gate: dollars only show when the usage status ALSO positively says no
// limit applies (costContextFromAllowance → governed:false). A dollar-shaped report that reaches a
// governed (or not-yet-known) user — an older backend, a cached response — is shown as a share of
// usage instead, never as dollars.

import type { ComicCostReport } from '../../shared/types/billing';
import type { ProjectReport } from '../../types';
import { formatCostForUser, type CostDisplayContext } from '../../services/costDisplay';

export interface GovernedComicCost {
  comicId: string;
  governed: true;
  /** Share of the user's usage this comic took, 0–100; null when unknown. */
  usagePct: number | null;
  byStage: Record<string, { usagePct: number | null }>;
  byModel: Record<string, { usagePct: number | null }>;
  /** Calls that ran on the user's own API key (billed by their provider, never counted). */
  ownKeyEvents: number;
}

export type ComicCostResponse = ComicCostReport | GovernedComicCost;

export const isGovernedComicCost = (report: unknown): report is GovernedComicCost =>
  !!report && typeof report === 'object' && (report as { governed?: unknown }).governed === true;

const trimZero = (s: string) => s.replace(/\.0$/, '');

/** "≈3% of your usage" from a server-computed share — the same wording as formatCostForUser. */
export const formatUsageShare = (pct: number | null | undefined): string => {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return 'uses a little of your usage';
  if (pct <= 0) return 'none of your usage';
  if (pct < 0.1) return '<0.1% of your usage';
  if (pct < 10) return `≈${trimZero(pct.toFixed(1))}% of your usage`;
  return `≈${Math.round(Math.min(100, pct))}% of your usage`;
};

export interface CostLine {
  key: string;
  /** Display value: "$0.012" or "≈1.2% of your usage". */
  value: string;
  /** Sort weight (dollars or percent — only compared within one report). */
  weight: number;
}

export interface ComicCostView {
  /** True when the view speaks in usage shares (no dollars anywhere). */
  governed: boolean;
  total: string;
  byStage: CostLine[];
  byModel: CostLine[];
  /** Governed users: a note about calls on their own key (they're never counted). */
  ownKeyNote: string | null;
}

const usd = (amount: number, digits: number) => `$${(Number.isFinite(amount) ? amount : 0).toFixed(digits)}`;

const sortLines = (lines: CostLine[]) => lines.filter((l) => l.weight > 0).sort((a, b) => b.weight - a.weight);

/**
 * One view model for the legacy cost chips/cards.
 * `digits` / `lineDigits`: decimal places for dollar totals and per-line amounts (admins only).
 */
export const comicCostView = (
  report: ComicCostResponse,
  ctx: CostDisplayContext,
  opts: { digits?: number; lineDigits?: number } = {}
): ComicCostView => {
  const digits = opts.digits ?? 2;
  const lineDigits = opts.lineDigits ?? digits;

  if (isGovernedComicCost(report)) {
    const lines = (bucket: Record<string, { usagePct: number | null }> | undefined) =>
      sortLines(
        Object.entries(bucket || {}).map(([key, v]) => ({
          key,
          value: formatUsageShare(v?.usagePct),
          weight: typeof v?.usagePct === 'number' && Number.isFinite(v.usagePct) ? v.usagePct : 0
        }))
      );
    const own = Math.max(0, Math.floor(Number(report.ownKeyEvents) || 0));
    return {
      governed: true,
      total: formatUsageShare(report.usagePct),
      byStage: lines(report.byStage),
      byModel: lines(report.byModel),
      ownKeyNote: own > 0 ? `${own} call${own === 1 ? '' : 's'} ran on your own API key (not counted).` : null
    };
  }

  const billable = Number(report.totalBillableUsd) || 0;
  const provider = Number(report.totalProviderCostUsd) || 0;
  const dollarLines = (bucket: Record<string, { ct: number; usd: number }> | undefined, toValue: (amount: number) => string) =>
    sortLines(
      Object.entries(bucket || {}).map(([key, v]) => ({ key, value: toValue(Number(v?.usd) || 0), weight: Number(v?.usd) || 0 }))
    );

  if (!ctx.governed) {
    return {
      governed: false,
      total: usd(billable > 0 ? billable : provider, digits),
      byStage: dollarLines(report.byStage, (a) => usd(a, lineDigits)),
      byModel: dollarLines(report.byModel, (a) => usd(a, lineDigits)),
      ownKeyNote: null
    };
  }

  // Dollar-shaped report, but this user is (or may be) governed: show shares, never dollars.
  // Usage counts real provider cost; the per-line amounts are billable (with the platform markup).
  const share = (amount: number, includesMarkup: boolean) => formatCostForUser(amount, ctx, { includesMarkup });
  return {
    governed: true,
    total: provider > 0 ? share(provider, false) : share(billable, true),
    byStage: dollarLines(report.byStage, (a) => share(a, true)),
    byModel: dollarLines(report.byModel, (a) => share(a, true)),
    ownKeyNote: null
  };
};

/** The local (artifact-based) estimate, for when the ledger report is unavailable. */
export const localCostLabel = (report: Pick<ProjectReport, 'cost_summary'>, ctx: CostDisplayContext, digits = 4): string => {
  const total = Number(report.cost_summary?.totalCost) || 0;
  return ctx.governed ? formatCostForUser(total, ctx) : usd(total, digits);
};

/**
 * The export ZIP's report/cost_summary.json. Governed users get token counts only — the dollar
 * estimate fields are left out (they never see dollars for their usage, in the app or the export).
 */
export const costSummaryForExport = (summary: ProjectReport['cost_summary'], ctx: CostDisplayContext): unknown => {
  if (!ctx.governed) return summary;
  const tokensOnly = (bucket: Record<string, { tokens: number; cost: number }> | undefined) =>
    Object.fromEntries(Object.entries(bucket || {}).map(([key, v]) => [key, { tokens: Number(v?.tokens) || 0 }]));
  return {
    note: 'Shown as token counts: your DreamStream usage is measured as a share of your included usage, not in dollars.',
    estimatedArtifactCount: summary?.estimatedArtifactCount ?? 0,
    byModel: tokensOnly(summary?.byModel),
    byStage: tokensOnly(summary?.byStage),
    byType: tokensOnly(summary?.byType)
  };
};

/**
 * The export ZIP's report/ai_usage.json. It carries the same local dollar estimates as the cost
 * summary (per model/stage/type, and a `cost` on every artifact row), so governed users get it
 * without them: token counts and artifact details stay, every dollar field is left out.
 */
export const aiUsageForExport = (usage: ProjectReport['ai_usage'], ctx: CostDisplayContext): unknown => {
  if (!ctx.governed || !usage) return usage;
  const tokensOnly = (bucket: Record<string, { tokens: number; cost: number }> | undefined) =>
    Object.fromEntries(Object.entries(bucket || {}).map(([key, v]) => [key, { tokens: Number(v?.tokens) || 0 }]));
  return {
    totalArtifacts: usage.totalArtifacts ?? 0,
    totalTokens: usage.totalTokens ?? 0,
    byModel: tokensOnly(usage.byModel),
    byStage: tokensOnly(usage.byStage),
    byType: tokensOnly(usage.byType),
    artifacts: (usage.artifacts || []).map(({ cost: _cost, ...artifact }) => artifact)
  };
};

/** The export ZIP's artifacts/artifacts.json: governed users get every record without its `cost`. */
export const artifactsForExport = <T extends { cost?: unknown }>(artifacts: T[] | undefined, ctx: CostDisplayContext): unknown => {
  if (!ctx.governed || !Array.isArray(artifacts)) return artifacts;
  return artifacts.map((artifact) => {
    if (!artifact || typeof artifact !== 'object') return artifact;
    const { cost: _cost, ...rest } = artifact;
    return rest;
  });
};
