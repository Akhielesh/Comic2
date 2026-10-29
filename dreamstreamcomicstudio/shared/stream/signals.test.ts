// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  isSignalName,
  OPS_SIGNALS,
  parseAeSignals,
  SECURITY_SIGNALS,
  SIGNAL_INDEX,
  SIGNAL_LABEL,
  SIGNAL_NAMES,
  SIGNAL_TONE,
  SignalCounter,
  signalPoint,
  signalSurface,
  sumSignal,
  type SignalSink
} from './signals';

const sink = () => {
  const points: Array<{ indexes?: string[]; blobs?: string[]; doubles?: number[] }> = [];
  const s: SignalSink & { points: typeof points } = { points, writeDataPoint: (p) => void points.push(p) };
  return s;
};

describe('signals — contract', () => {
  it('every signal has words, every security signal a tone, and the names never collide', () => {
    expect(new Set(SIGNAL_NAMES).size).toBe(SIGNAL_NAMES.length);
    for (const n of SIGNAL_NAMES) expect(SIGNAL_LABEL[n].length).toBeGreaterThan(5);
    for (const n of SECURITY_SIGNALS) expect(['bad', 'neutral']).toContain(SIGNAL_TONE[n]);
    expect(OPS_SIGNALS).toContain('glance_bump');
    expect(OPS_SIGNALS).toContain('push_sent');
    expect(isSignalName('kick')).toBe(true);
    expect(isSignalName('nope')).toBe(false);
  });

  it('a point is the name, a surface word and a count — nothing else to put an id in', () => {
    expect(signalPoint({ name: 'mfa_refused', surface: 'monitor', count: 3 })).toEqual({
      indexes: [SIGNAL_INDEX],
      blobs: ['mfa_refused', 'monitor', '', ''],
      doubles: [3]
    });
  });

  it('surfaces come from a fixed list; anything id-shaped becomes empty', () => {
    expect(signalSurface('Monitor')).toBe('monitor');
    expect(signalSurface('apns-la')).toBe('apns-la');
    expect(signalSurface('fcm')).toBe('fcm');
    for (const bad of ['11111111-1111-4111-8111-111111111111', 'deadbeef', 'mom@example.com', '203.0.113.7', 'monitor ', 'x'.repeat(40), 7, null]) {
      expect(signalSurface(bad as unknown)).toBe(bad === 'monitor ' ? 'monitor' : '');
    }
  });
});

describe('signals — SignalCounter', () => {
  it('writes the first occurrence at once, adds up the next minute, then writes the sum with the next one', () => {
    let t = 0;
    const c = new SignalCounter({ now: () => t });
    const s = sink();
    c.bump(s, 'rate_limited', 'edge');
    expect(s.points).toHaveLength(1);
    for (let i = 0; i < 499; i++) {
      t += 100;
      c.bump(s, 'rate_limited', 'edge');
    }
    expect(s.points).toHaveLength(1); // a flood is one point a minute, not one per request
    expect(c.pendingTotal()).toBe(499);
    t = 61_000;
    c.bump(s, 'rate_limited', 'edge');
    expect(s.points).toHaveLength(2);
    expect(s.points[1].doubles).toEqual([500]);
    expect(c.pendingTotal()).toBe(0);
  });

  it('keys by name and surface, and flush() writes what is still in memory', () => {
    let t = 0;
    const c = new SignalCounter({ now: () => t });
    const s = sink();
    c.bump(s, 'push_sent', 'webpush');
    c.bump(s, 'push_sent', 'apns');
    c.bump(s, 'push_sent', 'webpush', 2);
    c.bump(s, 'push_sent', 'apns');
    expect(s.points.map((p) => p.blobs?.[1])).toEqual(['webpush', 'apns']);
    t += 1000;
    expect(c.flush(s)).toBe(2);
    expect(s.points.slice(2).map((p) => [p.blobs?.[1], p.doubles?.[0]])).toEqual([
      ['webpush', 2],
      ['apns', 1]
    ]);
    expect(c.flush(s)).toBe(0);
  });

  it('never throws and never counts junk: no binding, unknown names, bad counts, a sink that throws', () => {
    const c = new SignalCounter({ now: () => 0 });
    expect(() => c.bump(undefined, 'kick')).not.toThrow();
    expect(() => c.bump(null, 'kick')).not.toThrow();
    const s = sink();
    c.bump(s, 'not_a_signal' as never);
    c.bump(s, 'kick', 'monitor', 0);
    c.bump(s, 'kick', 'monitor', -3);
    c.bump(s, 'kick', 'monitor', Number.NaN);
    expect(s.points).toHaveLength(0);
    const throwing: SignalSink = { writeDataPoint: vi.fn(() => { throw new Error('quota'); }) };
    expect(() => c.bump(throwing, 'kick')).not.toThrow();
    expect(() => c.flush(throwing)).not.toThrow();
  });

  it('an id passed as the surface is dropped, never written', () => {
    const c = new SignalCounter({ now: () => 0 });
    const s = sink();
    c.bump(s, 'guest_lockout', '11111111-1111-4111-8111-111111111111');
    expect(s.points[0].blobs).toEqual(['guest_lockout', '', '', '']);
  });

  it('stays bounded in memory: too many keys flush the pending ones first', () => {
    let t = 0;
    const c = new SignalCounter({ now: () => t, maxKeys: 2 });
    const s = sink();
    // First occurrences write at once; second occurrences in the window wait.
    c.bump(s, 'kick', 'monitor');
    c.bump(s, 'kick', 'line');
    t = 10;
    c.bump(s, 'kick', 'monitor');
    c.bump(s, 'kick', 'line');
    expect(c.pendingTotal()).toBe(2);
    c.bump(s, 'kick', 'call'); // a third key: the two pending are written first
    expect(c.pendingTotal()).toBe(0);
    expect(s.points).toHaveLength(5);
  });
});

describe('signals — reading the usage query answer', () => {
  it('keeps only known signal rows, re-checks the surface and sums by day', () => {
    const json = {
      data: [
        { day: '2026-10-27 00:00:00', kind: 'sig', scope: 'mfa_refused', scope_id: 'monitor', account: '', d1: '4' },
        { day: '2026-10-28 00:00:00', kind: 'sig', scope: 'mfa_refused', scope_id: '11111111-1111-4111-8111-111111111111', account: '', d1: 2 },
        { day: '2026-10-28 00:00:00', kind: 'sig', scope: 'glance_bump', scope_id: '', account: '', d1: 57 },
        { day: '2026-10-28 00:00:00', kind: 'sig', scope: 'made_up', scope_id: '', account: '', d1: 9 },
        { day: '2026-10-28 00:00:00', kind: 'monitor', scope: 'nursery', scope_id: 'n', account: '', d1: 9 },
        { day: 'garbage', kind: 'sig', scope: 'kick', scope_id: '', account: '', d1: 1 },
        { day: '2026-10-28 00:00:00', kind: 'sig', scope: 'kick', scope_id: '', account: '', d1: 0 }
      ]
    };
    const rows = parseAeSignals(json);
    expect(rows).toEqual([
      { day: '2026-10-27', name: 'mfa_refused', surface: 'monitor', count: 4 },
      { day: '2026-10-28', name: 'mfa_refused', surface: '', count: 2 },
      { day: '2026-10-28', name: 'glance_bump', surface: '', count: 57 }
    ]);
    expect(sumSignal(rows, 'mfa_refused')).toBe(6);
    expect(sumSignal(rows, 'mfa_refused', (d) => d === '2026-10-28')).toBe(2);
    expect(sumSignal(rows, 'mfa_refused', undefined, 'monitor')).toBe(4);
    expect(parseAeSignals(null)).toEqual([]);
    expect(parseAeSignals({ data: 'x' })).toEqual([]);
  });
});
