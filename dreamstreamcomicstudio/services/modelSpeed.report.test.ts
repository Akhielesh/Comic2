import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./apiClient', () => ({ get: vi.fn() }));
import { get } from './apiClient';

beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());
describe('model speed report freshness', () => {
  it('retains provenance, shares the picker cache, and revalidates after two minutes', async () => {
    const report = { models: { a: { p50Ms: 200, samples: 4 } }, measuredAt: 123, windowDays: 7, sampleLimit: 8000, capped: true, status: 'available', measurement: 'chat_turn_latency_without_tools', sourceScope: 'pooled' };
    vi.mocked(get).mockResolvedValue(report);
    const { fetchModelSpeedReport, fetchModelSpeed } = await import('./modelSpeed');
    expect(await fetchModelSpeedReport()).toEqual(report);
    expect(await fetchModelSpeed()).toEqual(report.models);
    expect(get).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(120_001);
    await fetchModelSpeedReport();
    expect(get).toHaveBeenCalledTimes(2);
    await fetchModelSpeedReport({ refresh: true });
    expect(get).toHaveBeenCalledTimes(3);
  });
  it('does not cache network failures as a measured empty result', async () => {
    vi.mocked(get).mockRejectedValue(new Error('offline'));
    const { fetchModelSpeedReport } = await import('./modelSpeed');
    expect(await fetchModelSpeedReport()).toMatchObject({ status: 'unavailable', measuredAt: null, models: {} });
    await fetchModelSpeedReport();
    expect(get).toHaveBeenCalledTimes(2);
  });
});
