// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { STATUS_KEEPALIVE_MS, STATUS_MINOR_MS, StatusCadence } from './statusCadence';

const calm = { state: 'calm', sound: null, model: 'ready', paused: null, battery: 100, charging: true, enc: { lim: 'none', relay: 0 } };

/** Tick every 2 s for `ms`, as the camera does; count what went to the room. */
function run(c: StatusCadence, ms: number, st: (t: number) => Record<string, unknown> = () => calm, from = 0): { sent: number[]; end: number } {
  const sent: number[] = [];
  let t = from;
  for (; t < from + ms; t += 2000) if (c.due(st(t), t)) sent.push(t);
  return { sent, end: t };
}

describe('statusCadence: the camera tells the room only what is news (ADR 0006 WS-6)', () => {
  it('idle: at most 30 statuses an hour once the room says nobody needs them live', () => {
    const c = new StatusCadence();
    expect(c.due(calm, 0)).toBe(true); // a new connection: at once
    c.setLive(false);
    const { sent } = run(c, 60 * 60_000, () => calm, 2000);
    expect(sent.length).toBeLessThanOrEqual(30);
    expect(sent[0]).toBe(STATUS_KEEPALIVE_MS);
  });

  it('every 2 s until the room says otherwise — and again after a reconnect (rooms before this change need it)', () => {
    const c = new StatusCadence();
    expect(run(c, 20_000).sent).toHaveLength(10);
    c.setLive(false);
    expect(run(c, 20_000, () => calm, 20_000).sent).toHaveLength(0);
    c.reset();
    expect(run(c, 20_000, () => calm, 40_000).sent).toHaveLength(10);
  });

  it('live again while someone watches without the camera’s data channel', () => {
    const c = new StatusCadence();
    c.setLive(false);
    c.due(calm, 0);
    c.setLive(true);
    expect(run(c, 10_000, () => calm, 2000).sent).toHaveLength(5);
  });

  it('the baby’s state changing goes at once; levels moving never do', () => {
    const c = new StatusCadence();
    c.due(calm, 0);
    c.setLive(false);
    expect(c.due({ ...calm, level: 40, motion: 80 } as never, 2000)).toBe(false);
    expect(c.due({ ...calm, state: 'crying', sound: 'cry' }, 4000)).toBe(true);
    expect(c.due({ ...calm, state: 'calm' }, 6000)).toBe(true);
    expect(c.due({ ...calm, paused: 'privacy' }, 8000)).toBe(true);
  });

  it('minor news (a TV flicking between voices and music) goes at most every 10 s', () => {
    const c = new StatusCadence();
    c.due(calm, 0);
    c.setLive(false);
    const { sent } = run(c, 60_000, (t) => ({ ...calm, sound: (t / 2000) % 2 ? 'voices' : 'music' }), 2000);
    expect(sent.length).toBeLessThanOrEqual(60_000 / STATUS_MINOR_MS);
    expect(sent.length).toBeGreaterThan(0);
    // A battery step is news too — within 10 s.
    const d = new StatusCadence();
    d.due(calm, 0);
    d.setLive(false);
    expect(d.due({ ...calm, battery: 94 }, 2000)).toBe(false);
    expect(d.due({ ...calm, battery: 94 }, STATUS_MINOR_MS)).toBe(true);
  });
});
