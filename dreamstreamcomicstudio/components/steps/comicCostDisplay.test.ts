import { describe, expect, it } from 'vitest';
import type { ComicCostReport } from '../../shared/types/billing';
import { DOLLAR_CONTEXT, costContextFromAllowance } from '../../services/costDisplay';
import type { AllowanceStatus } from '../../services/usageAllowance';
import {
  comicCostView,
  costSummaryForExport,
  formatUsageShare,
  isGovernedComicCost,
  localCostLabel,
  type GovernedComicCost
} from './comicCostDisplay';

const DOLLARS: ComicCostReport = {
  comicId: 'c1',
  totalEstimatedCt: 0,
  totalActualCt: 1300,
  totalBillableUsd: 0.13,
  totalProviderCostUsd: 0.1,
  byStage: { generation: { ct: 1170, usd: 0.117 }, planning: { ct: 130, usd: 0.013 }, idle: { ct: 0, usd: 0 } },
  byModel: { 'nano-banana': { ct: 1300, usd: 0.13 } },
  events: []
};

const GOVERNED: GovernedComicCost = {
  comicId: 'c1',
  governed: true,
  usagePct: 1.24,
  byStage: { planning: { usagePct: 0.04 }, generation: { usagePct: 1.2 } },
  byModel: { 'nano-banana': { usagePct: 1.24 } },
  ownKeyEvents: 2
};

const status = (over: Partial<AllowanceStatus> = {}): AllowanceStatus => ({
  enabled: true,
  governed: true,
  pctUsed: 40,
  pctLeft: 60,
  exhausted: false,
  crossed: [30],
  resetsAt: null,
  friendlyUnits: { standardPages: 150, draftPages: 300, pctPerStandardPage: 0.5, label: 'about 150 standard comic pages left' },
  usePlatformAllowance: true,
  byokFallbackMode: 'ask',
  byokAvailable: false,
  ...over
});

const GOVERNED_CTX = costContextFromAllowance(status());
const noDollars = (view: ReturnType<typeof comicCostView>) =>
  [view.total, ...view.byStage.map((l) => l.value), ...view.byModel.map((l) => l.value), view.ownKeyNote || ''].join(' ');

describe('formatUsageShare', () => {
  it('reads like formatCostForUser and never shows dollars', () => {
    expect(formatUsageShare(null)).toBe('uses a little of your usage');
    expect(formatUsageShare(0)).toBe('none of your usage');
    expect(formatUsageShare(0.04)).toBe('<0.1% of your usage');
    expect(formatUsageShare(1.24)).toBe('≈1.2% of your usage');
    expect(formatUsageShare(3)).toBe('≈3% of your usage');
    expect(formatUsageShare(42.6)).toBe('≈43% of your usage');
    expect(formatUsageShare(250)).toBe('≈100% of your usage');
  });
});

describe('comicCostView', () => {
  it('governed server report → shares, own-key note, sorted lines', () => {
    expect(isGovernedComicCost(GOVERNED)).toBe(true);
    const view = comicCostView(GOVERNED, DOLLAR_CONTEXT);
    expect(view.governed).toBe(true);
    expect(view.total).toBe('≈1.2% of your usage');
    expect(view.byStage.map((l) => l.key)).toEqual(['generation', 'planning']);
    expect(view.byStage[1].value).toBe('<0.1% of your usage');
    expect(view.ownKeyNote).toBe('2 calls ran on your own API key (not counted).');
    expect(noDollars(view)).not.toContain('$');
  });

  it('admin (positive "no limit" answer) + dollar report → the dollar view, unchanged formatting', () => {
    const view = comicCostView(DOLLARS, costContextFromAllowance(status({ governed: false })), { digits: 4, lineDigits: 3 });
    expect(view.governed).toBe(false);
    expect(view.total).toBe('$0.1300');
    expect(view.byStage).toEqual([
      { key: 'generation', value: '$0.117', weight: 0.117 },
      { key: 'planning', value: '$0.013', weight: 0.013 }
    ]);
    expect(view.ownKeyNote).toBeNull();
  });

  it('own key (BYOK context) sees real prices', () => {
    expect(comicCostView(DOLLARS, costContextFromAllowance(status(), { byok: true })).total).toBe('$0.13');
  });

  it('dollar report reaching a governed user (older backend) → shares, never dollars', () => {
    const view = comicCostView(DOLLARS, GOVERNED_CTX, { digits: 4 });
    expect(view.governed).toBe(true);
    // $0.10 provider cost at 0.5% per Standard page (provider $0.146/page) → ≈0.3%.
    expect(view.total).toMatch(/% of your usage$/);
    expect(noDollars(view)).not.toContain('$');
  });

  it('status not known yet → treated as governed (no dollars until a positive answer)', () => {
    const view = comicCostView(DOLLARS, costContextFromAllowance(null));
    expect(view.total).toBe('uses a little of your usage');
    expect(noDollars(view)).not.toContain('$');
  });
});

describe('local estimate + export', () => {
  const summary = {
    currency: 'USD',
    totalCost: 0.25,
    estimatedArtifactCount: 3,
    byModel: { m: { tokens: 100, cost: 0.2 } },
    byStage: { s: { tokens: 50, cost: 0.05 } },
    byType: { image: { tokens: 150, cost: 0.25 } }
  };

  it('localCostLabel: dollars for admins, a share for governed users', () => {
    expect(localCostLabel({ cost_summary: summary }, DOLLAR_CONTEXT)).toBe('$0.2500');
    expect(localCostLabel({ cost_summary: summary }, GOVERNED_CTX)).not.toContain('$');
  });

  it('costSummaryForExport keeps the dollar summary for admins and strips every amount for governed users', () => {
    expect(costSummaryForExport(summary, DOLLAR_CONTEXT)).toBe(summary);
    const governed = costSummaryForExport(summary, GOVERNED_CTX) as Record<string, unknown>;
    expect(JSON.stringify(governed)).not.toMatch(/cost"|usd|currency/i);
    expect(governed).toMatchObject({ estimatedArtifactCount: 3, byModel: { m: { tokens: 100 } }, byType: { image: { tokens: 150 } } });
  });
});
