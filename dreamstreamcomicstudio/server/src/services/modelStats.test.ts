// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ rows: [] as unknown[], ranges: [] as [number, number][], since: '', orders: [] as string[], failAt: -1, malformed: false, configured: true }));
vi.mock('./supabase.js', () => ({
  getSupabaseAdmin: () => {
    if (!fixture.configured) throw new Error('private configuration details');
    return { from: () => {
      let from = 0, to = 499;
      const query: any = {
        select: () => query,
        gte: (_field: string, value: string) => { fixture.since = value; return query; },
        order: (field: string) => { fixture.orders.push(field); return query; },
        range: (a: number, b: number) => { from = a; to = b; fixture.ranges.push([a, b]); return query; },
        then: (resolve: (value: unknown) => unknown) => Promise.resolve({
          data: fixture.malformed ? null : fixture.rows.slice(from, to + 1),
          error: fixture.failAt === from ? { message: 'private database details' } : null
        }).then(resolve)
      };
      return query;
    } };
  }
}));
vi.mock('../lib/logger.js', () => ({ logger: { warn: vi.fn() } }));
import { listMonthlyUsage } from './modelStats.js';

beforeEach(() => {
  fixture.rows = []; fixture.ranges = []; fixture.orders = []; fixture.since = '';
  fixture.failAt = -1; fixture.malformed = false; fixture.configured = true;
});
afterEach(() => vi.useRealTimers());

describe('monthly usage data availability', () => {
  it('returns an empty array only for a successful empty read', async () => {
    expect(await listMonthlyUsage(6)).toEqual([]);
  });

  it.each(['database', 'configuration', 'malformed'])('exposes %s failure as sanitized service unavailability', async (failure) => {
    if (failure === 'database') fixture.failAt = 0;
    if (failure === 'configuration') fixture.configured = false;
    if (failure === 'malformed') fixture.malformed = true;
    await expect(listMonthlyUsage(6)).rejects.toMatchObject({
      status: 503, publicCode: 'MODEL_USAGE_UNAVAILABLE',
      message: 'Monthly model usage is temporarily unavailable.', publicMessage: 'Monthly model usage is temporarily unavailable.'
    });
  });

  it('reads all pages in a stable order instead of silently truncating counts', async () => {
    fixture.rows = Array.from({ length: 1101 }, (_, i) => ({ month: '2026-11', product: 'chat_studio', source: 'openrouter', model: `model-${i}`, requests: '2' }));
    const rows = await listMonthlyUsage(6);
    expect(rows).toHaveLength(1101);
    expect(rows.reduce((n, row) => n + row.requests, 0)).toBe(2202);
    expect(fixture.ranges).toEqual([[0, 499], [500, 999], [1000, 1499]]);
    expect(fixture.orders.slice(0, 4)).toEqual(['month', 'product', 'source', 'model']);
  });

  it('does not return partial totals if a later page fails', async () => {
    fixture.rows = Array.from({ length: 600 }, () => ({ requests: 1 }));
    fixture.failAt = 500;
    await expect(listMonthlyUsage(6)).rejects.toMatchObject({ status: 503 });
  });

  it('uses whole calendar months even on the last day of a longer month', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-31T12:00:00Z'));
    await listMonthlyUsage(2);
    expect(fixture.since).toBe('2026-02');
    await listMonthlyUsage(Number.NaN);
    expect(fixture.since).toBe('2025-10');
  });
});
