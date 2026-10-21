// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import type { MonQuery } from './query';
import type { TrackItem } from './trackTypes';
import { newTrackId, TrackerSync } from './trackerSync';

const NID = 'n-1';
const bottle = (id: string, ml: number, start = 1000): TrackItem => ({ id, kind: 'bottle', start, end: start, by: 'Me', data: { ml } });
const fakeQuery = (reply: unknown) => ({ ask: async () => reply }) as unknown as MonQuery;

beforeEach(() => localStorage.clear());

describe('TrackerSync', () => {
  it('shows a save at once and keeps it queued while offline — even across a reload', () => {
    const s = new TrackerSync(NID);
    s.put(bottle('b1', 120));
    expect(s.snapshot().items.map((i) => i.id)).toEqual(['b1']);
    expect(s.snapshot().pending).toBe(1);
    const again = new TrackerSync(NID);
    expect(again.snapshot().items.map((i) => i.data.ml)).toEqual([120]);
    expect(again.snapshot().pending).toBe(1);
  });

  it('sends the queue when the room says hello, and clears it once the room echoes', () => {
    const s = new TrackerSync(NID);
    s.put(bottle('b1', 120));
    s.del('gone1');
    const sent: Record<string, unknown>[] = [];
    s.attach((m) => sent.push(m), fakeQuery(null), { running: [{ id: 'nap', kind: 'sleep', start: 5, end: null, by: 'Dad', data: {} }] });
    expect(sent.map((m) => m.t)).toEqual(['track_put', 'track_del']);
    expect(s.snapshot().running.map((r) => r.id)).toEqual(['nap']);
    s.handle({ t: 'track', item: { ...bottle('b1', 120), by: 'Alice (Mom)' } });
    s.handle({ t: 'track_del', id: 'gone1' });
    expect(s.snapshot().pending).toBe(0);
    expect(s.snapshot().items.find((i) => i.id === 'b1')?.by).toBe('Alice (Mom)');
    expect(localStorage.getItem(`ds-track-queue-${NID}`)).toBeNull();
  });

  it('undoes a change the room refuses and says why', () => {
    const s = new TrackerSync(NID);
    s.attach(() => undefined, fakeQuery(null));
    s.handle({ t: 'track', item: bottle('b1', 90) });
    let err = '';
    s.onError = (m) => (err = m);
    s.put(bottle('b1', 9000));
    s.put(bottle('b2', 50));
    s.handle({ t: 'track_err', id: 'b1', msg: 'Nope' });
    s.handle({ t: 'track_err', id: 'b2', msg: 'Viewers can’t log' });
    expect(s.snapshot().items.map((i) => [i.id, i.data.ml])).toEqual([['b1', 90]]);
    expect(err).toMatch(/Viewers/);
  });

  it('loads a window from the room without losing unsent edits', async () => {
    const s = new TrackerSync(NID);
    s.put(bottle('mine', 60, 2000));
    s.attach(() => undefined, fakeQuery({ items: [bottle('theirs', 100, 1500)], auto: [{ id: 'ms-1', kind: 'sleep', start: 0, end: 900, by: 'Camera', data: {}, src: 'monitor' }] }));
    await s.load(0, 10_000);
    expect(s.snapshot().items.map((i) => i.id)).toEqual(['theirs', 'mine']);
    expect(s.snapshot().auto.map((i) => i.id)).toEqual(['ms-1']);
  });

  it('makes URL-safe ids', () => {
    for (let i = 0; i < 20; i++) expect(newTrackId()).toMatch(/^[A-Za-z0-9_-]{12}$/);
  });
});
