// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { listValueUsd } from '@/shared/stream/usage';
import { broadcastRecap } from './recap';

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 23, 18);

describe('the recap’s Delivery figures (≈, from what /stats already returns)', () => {
  it('a 1 h 02 m 720p stream with 20 viewers: stored from the encoder’s own samples, delivered from the room’s viewer-minutes', () => {
    const r = broadcastRecap({
      startedAt: T0,
      endedAt: T0 + 62 * MIN,
      quality: '720p',
      segMs: 6000,
      peakViewers: 20,
      curve: Array.from({ length: 124 }, (_, i) => ({ at: T0 + i * 30_000, n: 20 })),
      healthCurve: Array.from({ length: 124 }, (_, i) => ({ at: T0 + i * 30_000, enc: 2_500_000 })),
      use: { viewerMinutes: 1200, doRequestsEst: 124, rowsWrittenEst: 248 },
    })!;
    expect(r.durMs).toBe(62 * MIN);
    // 2.5 Mbps for 62 minutes ≈ 1.16 GB.
    expect(r.storedBytes / 1e9).toBeCloseTo(1.1625, 3);
    // The room's viewer-minutes win over the curve; delivered = viewer-minutes × the average rate.
    expect(r.viewerMinutes).toBe(1200);
    expect(r.deliveredBytes / 1e9).toBeCloseTo((1200 * 2.5e6 * 60) / 8 / 1e9, 3);
    expect(r.broadcast.segCount).toBe(620);
    expect(r.broadcast.doRequestsEst).toBe(620 * 2 + 124);
    expect(r.broadcast.rowsWrittenEst).toBe(620 + 248);
    expect(r.cloudCopy).toBeNull();
    // At list price this is about a cent (feature doc §2.2 row 9: $0.009–0.014 for 1 h, 20 viewers).
    const usd = listValueUsd(r.broadcast, 'broadcast').usd;
    expect(usd).toBeGreaterThan(0.005);
    expect(usd).toBeLessThan(0.02);
  });

  it('without encoder samples or room totals: the preset and the viewer curve', () => {
    const r = broadcastRecap({
      startedAt: T0,
      endedAt: T0 + 60 * MIN,
      quality: '720p',
      peakViewers: 4,
      curve: [{ at: T0, n: 4 }, { at: T0 + 30_000, n: 2 }],
      cloudCopyBytes: 2.9e9,
    })!;
    expect(r.storedBytes / 1e9).toBeCloseTo(1.168, 3); // (2.5 Mbps + 96 kbps) × 1 h
    expect(r.viewerMinutes).toBe(3);
    expect(r.cloudCopy?.cloudCopyBytes).toBe(2.9e9);
    expect(r.broadcast.segCount).toBe(600);
  });

  it('never on air: no Delivery figures; still live: counted up to now', () => {
    expect(broadcastRecap({ startedAt: null, endedAt: null, quality: '720p', peakViewers: 0, curve: [] })).toBeNull();
    expect(broadcastRecap({ startedAt: T0, endedAt: T0, quality: '720p', peakViewers: 0, curve: [] })).toBeNull();
    expect(broadcastRecap({ startedAt: T0, endedAt: null, quality: 'x', peakViewers: 1, curve: [] }, T0 + 10 * MIN)?.durMs).toBe(10 * MIN);
  });
});
