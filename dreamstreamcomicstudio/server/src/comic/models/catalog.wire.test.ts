// @vitest-environment node
// The catalog wire types are ONE contract (shared/comic/modelCatalog.ts): the server's names are
// re-exports of the shared ones, so the picker / Insights UIs import them instead of mirroring them.
// The type assertions are checked by the server typecheck (npm run build:server compiles this file).
import { describe, expect, expectTypeOf, it } from 'vitest';
import type * as Shared from '../../../../shared/comic/modelCatalog.js';
import type * as SharedIndex from '../../../../shared/comic/index.js';
import type { CatalogEndpoint, CatalogPrice, ModelCatalogDetail, ModelCatalogRow, ModelTrends, PriceBasis, TrendRange } from './catalog.js';
import { TREND_RANGES } from './catalog.js';
import type { QualityBoard, QualityEntry, QualityHistoryPoint, RankMove } from './quality.js';
import { QUALITY_BOARDS } from './quality.js';
import type { MonthlyUsageRow, ObservedEntry, ObservedKind, ReliabilityEntry } from './observed.js';
import { RELIABILITY_WINDOW_H } from './observed.js';

describe('model catalog wire types', () => {
  it('the server names are the shared types (nothing renamed, nothing mirrored)', () => {
    expectTypeOf<ModelCatalogRow>().toEqualTypeOf<Shared.ModelCatalogRow>();
    expectTypeOf<ModelCatalogDetail>().toEqualTypeOf<Shared.ModelCatalogDetail>();
    expectTypeOf<ModelTrends>().toEqualTypeOf<Shared.ModelTrends>();
    expectTypeOf<CatalogPrice>().toEqualTypeOf<Shared.CatalogPrice>();
    expectTypeOf<CatalogEndpoint>().toEqualTypeOf<Shared.CatalogEndpoint>();
    expectTypeOf<PriceBasis>().toEqualTypeOf<Shared.PriceBasis>();
    expectTypeOf<TrendRange>().toEqualTypeOf<Shared.TrendRange>();
    expectTypeOf<QualityBoard>().toEqualTypeOf<Shared.QualityBoard>();
    expectTypeOf<QualityEntry>().toEqualTypeOf<Shared.QualityEntry>();
    expectTypeOf<QualityHistoryPoint>().toEqualTypeOf<Shared.QualityHistoryPoint>();
    expectTypeOf<RankMove>().toEqualTypeOf<Shared.RankMove>();
    expectTypeOf<ObservedEntry>().toEqualTypeOf<Shared.ObservedEntry>();
    expectTypeOf<ObservedKind>().toEqualTypeOf<Shared.ObservedKind>();
    expectTypeOf<ReliabilityEntry>().toEqualTypeOf<Shared.ReliabilityEntry>();
    expectTypeOf<MonthlyUsageRow>().toEqualTypeOf<Shared.MonthlyUsageRow>();
    // …and reachable from the shared index the client imports.
    expectTypeOf<SharedIndex.ModelCatalogRow>().toEqualTypeOf<Shared.ModelCatalogRow>();
    expectTypeOf<SharedIndex.ModelTrends>().toEqualTypeOf<Shared.ModelTrends>();
  });

  it('carries the fields stage B reads (current, qualityStale, priceVsCurrent, t3.note, history names)', () => {
    const row: Pick<Shared.ModelCatalogRow, 'current' | 'qualityStale' | 'priceVsCurrent'> = {
      current: false,
      qualityStale: true,
      priceVsCurrent: { currentId: 'nano-banana-2.1', ratio: 4, res: '1K' }
    };
    const note: Shared.ModelTrends['t3']['note'] = null;
    const point: Shared.QualityHistoryPoint = { asOf: '2026-10-27', rank: 3, score: 1210, name: 'gemini-3-pro-image' };
    expect(row.priceVsCurrent?.ratio).toBe(4);
    expect(note).toBeNull();
    expect(point.name).toBe('gemini-3-pro-image');
  });

  it('the server constants agree with the shared unions', () => {
    const ranges: readonly Shared.TrendRange[] = TREND_RANGES;
    const boards: readonly Shared.QualityBoard[] = QUALITY_BOARDS;
    const windowH: Shared.ReliabilityEntry['windowH'] = RELIABILITY_WINDOW_H;
    expect(ranges).toEqual(['30d', '90d']);
    expect(boards).toHaveLength(6);
    expect(windowH).toBe(24);
  });
});
