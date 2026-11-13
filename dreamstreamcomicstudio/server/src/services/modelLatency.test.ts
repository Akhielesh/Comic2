// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ rows: [] as Array<{ metadata: Record<string, unknown> }>, error: false, enabled: true, order: vi.fn(), range: vi.fn() }));
vi.mock('./supabase.js', () => ({
  getSupabaseCapabilityStatus: () => ({ storagePersistenceEnabled: fixture.enabled }),
  getSupabaseAdmin: () => ({ from: () => {
    let from = 0, to = 499;
    const query: any = {
      select: () => query, eq: () => query, gte: () => query,
      order: (...args: unknown[]) => { fixture.order(...args); return query; },
      range: (a: number, b: number) => { from = a; to = b; fixture.range(a, b); return query; },
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: fixture.rows.slice(from, to + 1), error: fixture.error ? {} : null }).then(resolve)
    };
    return query;
  } })
}));
beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); fixture.rows = []; fixture.error = false; fixture.enabled = true; });

describe('measured model response time', () => {
  it('reports the window and sample basis, excluding tools, missing timing and tiny samples', async () => {
    fixture.rows = [100, 300, 200].map((latencyMs) => ({ metadata: { model: 'a', latencyMs, toolCount: 0 } }));
    fixture.rows.push(
      { metadata: { model: 'a', latencyMs: 99999, toolCount: 1 } },
      { metadata: { model: 'a', latencyMs: null } },
      { metadata: { model: 'b', latencyMs: 100 } }
    );
    const { getModelLatencyReport, getModelLatency } = await import('./telemetryAnalytics.js');
    const report = await getModelLatencyReport();
    expect(report).toMatchObject({ models: { a: { p50Ms: 200, samples: 3 } }, windowDays: 7, sampleLimit: 8000, capped: false, status: 'available', sourceScope: 'pooled' });
    expect(report.measuredAt).toBeGreaterThan(0);
    expect(fixture.order).toHaveBeenCalledWith('created_at', { ascending: false });
    expect(await getModelLatency()).toEqual(report.models);
    expect(fixture.range).toHaveBeenCalledTimes(1);
  });

  it('distinguishes an unavailable store from an empty observation window', async () => {
    const { getModelLatencyReport } = await import('./telemetryAnalytics.js');
    fixture.enabled = false;
    expect((await getModelLatencyReport(1)).status).toBe('unavailable');
    fixture.enabled = true;
    expect((await getModelLatencyReport(2)).status).toBe('empty');
    fixture.error = true;
    expect((await getModelLatencyReport(3)).status).toBe('unavailable');
  });

  it('discloses the bounded sample instead of implying complete traffic coverage', async () => {
    fixture.rows = Array.from({ length: 8000 }, () => ({ metadata: { model: 'a', latencyMs: 100 } }));
    const { getModelLatencyReport } = await import('./telemetryAnalytics.js');
    expect(await getModelLatencyReport(90)).toMatchObject({ capped: true, windowDays: 30 });
    expect(fixture.range).toHaveBeenCalledTimes(16);
    expect(fixture.range).toHaveBeenLastCalledWith(7500, 7999);
  });
});
