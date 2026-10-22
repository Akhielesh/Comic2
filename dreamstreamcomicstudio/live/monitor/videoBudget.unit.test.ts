// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { RELAY_BACKLOG, RelayMeter, RelayPacer, sceneIntervalMs } from './videoBudget';

describe('sceneIntervalMs (smart vision yields to the video)', () => {
  it('keeps its own pace with one viewer and a relaxed phone', () => {
    expect(sceneIntervalMs(80, 0, 0)).toBe(1000);
    expect(sceneIntervalMs(80, 1, 0)).toBe(1000);
    expect(sceneIntervalMs(200, 1, 0)).toBe(1500);
    expect(sceneIntervalMs(500, 1, 0)).toBe(3000);
  });

  it('halves its rate for two or more viewers, a third under CPU pressure, never slower than 6 s', () => {
    expect(sceneIntervalMs(80, 2, 0)).toBe(2000);
    expect(sceneIntervalMs(80, 5, 0)).toBe(2000);
    expect(sceneIntervalMs(80, 1, 1)).toBe(3000);
    expect(sceneIntervalMs(80, 3, 2)).toBe(6000);
    expect(sceneIntervalMs(500, 3, 1)).toBe(6000);
  });
});

describe('RelayPacer', () => {
  it('starts at 3 fps and climbs to 5 within about four seconds of a clear socket', () => {
    const p = new RelayPacer();
    expect(p.fps).toBe(3);
    expect(p.intervalMs).toBe(333);
    let sends = 0;
    let ms = 0;
    while (p.fps < 5 && ms < 10_000) {
      if (p.tick(0)) sends++;
      ms += p.intervalMs;
    }
    expect(p.fps).toBe(5);
    expect(ms).toBeLessThanOrEqual(4500);
    expect(p.intervalMs).toBe(200);
    for (let i = 0; i < 30; i++) if (p.tick(0)) sends++;
    expect(p.fps).toBe(5);
    expect(sends).toBeGreaterThan(40);
  });

  it('skips (never queues) when the uplink falls behind, stepping down to 2 fps', () => {
    const p = new RelayPacer(2, 5, 5);
    expect(p.tick(RELAY_BACKLOG + 1)).toBe(false);
    expect(p.fps).toBe(4);
    for (let i = 0; i < 5; i++) p.tick(RELAY_BACKLOG * 2);
    expect(p.fps).toBe(2);
    // A half-full socket still sends, but doesn't count toward stepping up.
    for (let i = 0; i < 30; i++) expect(p.tick(40 * 1024)).toBe(true);
    expect(p.fps).toBe(2);
  });

  it('waits for the previous frame to finish encoding', () => {
    const p = new RelayPacer();
    expect(p.tick(0, true)).toBe(false);
  });

  it('turns JPEG quality down for big (grainy, dark) frames and back up for small ones', () => {
    const p = new RelayPacer();
    p.onSent(90 * 1024, 0);
    p.onSent(90 * 1024, 200);
    expect(p.quality).toBe(0.45);
    for (let i = 0; i < 10; i++) p.onSent(70 * 1024, 400 + i);
    expect(p.quality).toBe(0.35);
    for (let i = 0; i < 10; i++) p.onSent(10 * 1024, 500 + i);
    expect(p.quality).toBe(0.6);
  });

  it('reports the rate it really sent', () => {
    const p = new RelayPacer();
    for (let t = 0; t <= 4000; t += 250) p.onSent(30_000, t);
    expect(p.sentFps(4000)).toBe(4);
    expect(p.sentFps(20_000)).toBe(0);
  });
});

describe('RelayMeter', () => {
  it('measures arriving frames and notices when they stop', () => {
    const m = new RelayMeter();
    expect(m.fps(0)).toBe(0);
    expect(m.stale(0)).toBe(false); // nothing yet is "waiting", not "paused"
    for (let t = 0; t <= 6000; t += 333) m.frame(t);
    expect(m.fps(6000)).toBe(3);
    expect(m.stale(9000)).toBe(false);
    expect(m.stale(12_000)).toBe(true);
    expect(m.fps(12_000)).toBe(0);
    m.reset();
    expect(m.last).toBeNull();
  });
});
