// Client feature module: Cost and model insights (models.md §4 — Overview · Pages · Models · Trends; owner
// M1-INSIGHTS-UI).
//
// Registers nothing on purpose: §4.1 adds nothing to the header and no new card or tab — the insights live
// INSIDE the existing cost surfaces. The breakdown card's Cost view renders <CostInsights/> (L1 rows + the L2
// tabs, inline for Pro, "More details" for Easy), and the header's Spending sheet and the board's Story tab read
// the same spend summary (spendSummary + SpendByKindList). An empty module contributes nothing to the registries.
//
// Numbers come from shared/comic/modelInsights.ts (per comic, over the doc), the registry's dated price list and
// /api/comic/models/{catalog,trends} (live, fetched when a tab opens — never on a timer).

import type { FeatureModule } from '../extensions';

export const feature: FeatureModule = {};

export { CostInsights, InsightsTabs, INSIGHTS_TABS } from './CostInsights';
export type { CostInsightsProps, InsightsTabsProps, InsightsTabId } from './CostInsights';
export { OverviewTab, SpendByKindList } from './OverviewTab';
export type { OverviewTabProps, SpendByKindListProps } from './OverviewTab';
export { PagesTab, insightsPriceBook } from './PagesTab';
export { ModelsTab } from './ModelsTab';
export { TrendsTab } from './TrendsTab';
export { Sparkline, StackedBars } from './Sparkline';
export { useInsightsCatalog, useInsightsTrends, useHeldCatalog, INSIGHTS_FRESH_MS } from './useInsights';
export type { Loadable } from './useInsights';
export { fetchInsightsCatalog, fetchInsightsTrends, CATALOG_PATH, TRENDS_PATH } from './insightsApi';
export { insightsMoney, preciseUsd, spendSummary, spendKindLabel, pageRealCost, sizeCosts, spendSeries, OBSERVED_MIN_N } from './insightsModel';
export type { InsightsMoney, SpendSummary, SpendSummaryKind } from './insightsModel';
export * as insightsCopy from './copy';
