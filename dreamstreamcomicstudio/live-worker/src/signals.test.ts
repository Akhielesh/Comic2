// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { flushSignals, makeSignalCounter, signal } from './signals';

const env = () => {
  const points: Array<{ indexes?: string[]; blobs?: string[]; doubles?: number[] }> = [];
  return { points, STREAM_USAGE: { writeDataPoint: (p: (typeof points)[number]) => void points.push(p) } };
};

describe('live Worker signals', () => {
  it('writes a signal to the STREAM_USAGE dataset the rooms already use', () => {
    const e = env();
    signal(e, 'origin_refused', 'edge');
    expect(e.points).toEqual([{ indexes: ['sig'], blobs: ['origin_refused', 'edge', '', ''], doubles: [1] }]);
    // The next one inside the minute waits in memory; a flush writes it.
    signal(e, 'origin_refused', 'edge');
    expect(e.points).toHaveLength(1);
    expect(flushSignals(e)).toBe(1);
    expect(e.points[1].doubles).toEqual([1]);
  });

  it('does nothing without the binding, and never throws', () => {
    expect(() => signal(undefined, 'kick')).not.toThrow();
    expect(() => signal({}, 'kick', 'account')).not.toThrow();
    expect(flushSignals(undefined)).toBe(0);
    expect(flushSignals({})).toBe(0);
  });

  it('a private counter coalesces on its own clock (for room tests)', () => {
    let t = 0;
    const c = makeSignalCounter({ now: () => t, minGapMs: 1000 });
    const e = env();
    c.bump(e.STREAM_USAGE, 'glance_bump');
    c.bump(e.STREAM_USAGE, 'glance_bump');
    t = 1000;
    c.bump(e.STREAM_USAGE, 'glance_bump');
    expect(e.points.map((p) => p.doubles?.[0])).toEqual([1, 2]);
  });
});
