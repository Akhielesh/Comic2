// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { callUsage, FLUSH_EVERY_MS, UsageMeter, usageKey, type CarrierRef, type UsageCarrier, type UsageSink } from './usageMeter';
import { addUsage, emptyCounters, sanitizeMonth, type UsageKind } from '../../shared/stream/usage';

const T0 = Date.parse('2026-10-21T20:00:00Z');
const H = FLUSH_EVERY_MS;

/** DO KV storage stand-in that counts every call (rows written = puts + deletes). */
function fakeStorage() {
  const data = new Map<string, unknown>();
  const calls = { get: 0, put: 0, delete: 0 };
  return {
    data,
    calls,
    async get<T>(k: string) {
      calls.get += 1;
      return structuredClone(data.get(k)) as T | undefined;
    },
    async put(k: string, v: unknown) {
      calls.put += 1;
      data.set(k, structuredClone(v));
    },
    async delete(k: string) {
      calls.delete += 1;
      return data.delete(k);
    },
  };
}

function fakeSink() {
  const points: { indexes?: string[]; blobs?: string[]; doubles?: number[] }[] = [];
  const sink: UsageSink = { writeDataPoint: (p) => void points.push(p) };
  return { sink, points };
}

/** A socket attachment as the room keeps it (serializeAttachment = a structured clone). */
function socket(extra: Record<string, unknown> = {}) {
  let stored: UsageCarrier & Record<string, unknown> = { sid: 's', ...extra };
  return {
    get a() {
      return stored;
    },
    ref(): CarrierRef {
      const a = structuredClone(stored);
      return { a, save: () => void (stored = structuredClone(a)) };
    },
    set(next: UsageCarrier) {
      stored = structuredClone(next) as typeof stored;
    },
  };
}

const row = (s: ReturnType<typeof fakeStorage>, ms = T0) => sanitizeMonth(s.data.get(usageKey(new Date(ms).toISOString().slice(0, 7))));

describe('UsageMeter — memory counters and the hourly flush', () => {
  it('writes one row and one Analytics Engine point per kind, then nothing for an hour', async () => {
    const storage = fakeStorage();
    const { sink, points } = fakeSink();
    const m = new UsageMeter({ storage, sink, scope: 'nursery' });
    for (let i = 0; i < 900; i++) m.bump('monitor', 'relayFrames');
    m.add('monitor', { minutes: { server: 2 } });

    expect(await m.flush(T0, { scopeId: 'n1' })).toBe('written');
    expect(storage.calls.put).toBe(1);
    expect(row(storage)?.counters.monitor).toMatchObject({ relayFrames: 900, minutes: { server: 2 } });
    expect(points).toEqual([{ indexes: ['monitor'], blobs: ['nursery', 'n1', '', 'server'], doubles: expect.any(Array) }]);
    expect(points[0].doubles![3]).toBe(2); // minutes.server
    expect(points[0].doubles![5]).toBe(900); // relayFrames

    m.bump('monitor', 'relayFrames', 10);
    const gets = storage.calls.get;
    expect(await m.flush(T0 + 59 * 60_000, { scopeId: 'n1' })).toBe('too_soon');
    expect(storage.calls.get).toBe(gets); // decided from memory: no I/O at all
    expect(await m.flush(T0 + H, { scopeId: 'n1' })).toBe('written');
    expect(row(storage)?.counters.monitor?.relayFrames).toBe(910);
  });

  it('never writes more than one row per hour, however often it is asked (15 s alarm for 3 h)', async () => {
    const storage = fakeStorage();
    const m = new UsageMeter({ storage, scope: 'nursery' });
    for (let t = 0; t <= 3 * H; t += 15_000) {
      for (let i = 0; i < 225; i++) m.bump('monitor', 'relayFrames'); // 15 fps
      await m.flush(T0 + t, { scopeId: 'n1' });
    }
    expect(storage.calls.put).toBeLessThanOrEqual(4); // t = 0, 1 h, 2 h, 3 h
    // Every frame up to the last write is in the row; the rest is still owed, not lost.
    const written = row(storage)!.counters.monitor!.relayFrames;
    expect(written + (m.pendingTotals().get('monitor')?.relayFrames ?? 0)).toBe(225 * (3 * 240 + 1));
  });

  it('keeps the hourly bound after eviction: a fresh meter asks the row when it was written', async () => {
    const storage = fakeStorage();
    await new UsageMeter({ storage, scope: 'nursery' }).flush(T0, { scopeId: 'n1', force: true, carriers: [], collect: () => ({ delta: { monitor: { relayFrames: 1 } }, src: 1 }) });
    const fresh = new UsageMeter({ storage, scope: 'nursery' });
    fresh.bump('monitor', 'relayFrames', 5);
    expect(await fresh.flush(T0 + 10 * 60_000, { scopeId: 'n1' })).toBe('too_soon');
    expect(storage.calls.put).toBe(1);
    expect(fresh.due(T0 + 20 * 60_000)).toBe(false); // remembers the row's time now
    expect(await fresh.flush(T0 + H, { scopeId: 'n1' })).toBe('written');
  });

  it('does nothing when there is nothing to write, or nobody to write it for', async () => {
    const storage = fakeStorage();
    const m = new UsageMeter({ storage, scope: 'nursery' });
    expect(await m.flush(T0, { scopeId: 'n1' })).toBe('empty');
    m.bump('monitor', 'relayFrames');
    expect(await m.flush(T0, { scopeId: '' })).toBe('no_scope');
    expect(storage.calls).toEqual({ get: 0, put: 0, delete: 0 });
  });

  it('fails open: a storage error keeps the counters owed; a broken Analytics Engine binding is ignored', async () => {
    const storage = fakeStorage();
    const m = new UsageMeter({ storage: { ...storage, put: async () => { throw new Error('boom'); } }, scope: 'nursery' });
    m.bump('monitor', 'relayFrames', 3);
    expect(await m.flush(T0, { scopeId: 'n1' })).toBe('error');
    expect(m.pendingTotals().get('monitor')?.relayFrames).toBe(3);

    const ok = new UsageMeter({ storage, sink: { writeDataPoint: () => { throw new Error('no AE'); } }, scope: 'nursery' });
    ok.bump('monitor', 'relayFrames', 3);
    expect(await ok.flush(T0, { scopeId: 'n1' })).toBe('written');
    // …and the hot path never throws, even on junk.
    expect(() => ok.bump('monitor', 'relayFrames', Number.NaN)).not.toThrow();
    expect(() => ok.add('monitor', null as never)).not.toThrow();
  });
});

describe('UsageMeter — attachments survive hibernation without double counting', () => {
  it('rebuilds what is owed from attachments after memory is dropped', async () => {
    const storage = fakeStorage();
    const viewer = socket();
    let m = new UsageMeter({ storage, scope: 'nursery' });

    // 30 relay minutes ride the viewer's attachment.
    const r1 = viewer.ref();
    m.addTo(r1.a, 'monitor', { minutes: { server: 30 } });
    r1.save();
    expect(await m.flush(T0, { scopeId: 'n1', carriers: [viewer.ref()] })).toBe('written');
    expect(row(storage)?.counters.monitor?.minutes.server).toBe(30);

    // 20 more minutes, then the room hibernates (memory gone; the attachment stays).
    const r2 = viewer.ref();
    m.addTo(r2.a, 'monitor', { minutes: { server: 20 } });
    r2.save();
    m = new UsageMeter({ storage, scope: 'nursery' });

    // Woken: the new meter writes exactly the 20 still owed — not 50.
    expect(await m.flush(T0 + H, { scopeId: 'n1', carriers: [viewer.ref()] })).toBe('written');
    expect(row(storage)?.counters.monitor?.minutes.server).toBe(50);
    // Nothing owed any more: another flush an hour later writes nothing.
    expect(await m.flush(T0 + 2 * H, { scopeId: 'n1', carriers: [viewer.ref()] })).toBe('empty');
  });

  it('stashes memory into a socket, and gives a closing socket’s part back to memory', async () => {
    const storage = fakeStorage();
    const m = new UsageMeter({ storage, scope: 'nursery' });
    const cam = socket();
    m.bump('monitor', 'relayFrames', 40);
    const ref = cam.ref();
    expect(m.stash(ref.a)).toBe(true);
    ref.save();
    expect(m.pendingTotals().size).toBe(0);
    expect(m.pendingTotals([cam.ref()]).get('monitor')?.relayFrames).toBe(40);

    const closing = cam.ref().a;
    m.release(closing);
    expect(closing.u).toBeUndefined();
    expect(m.pendingTotals().get('monitor')?.relayFrames).toBe(40);
    expect(await m.flush(T0, { scopeId: 'n1' })).toBe('written');
    expect(row(storage)?.counters.monitor?.relayFrames).toBe(40);
  });

  it('keeps client reports monotonic, so a resend never double counts', async () => {
    const storage = fakeStorage();
    const m = new UsageMeter({ storage, scope: 'nursery' });
    const s = socket();
    const r = s.ref();
    m.report(r.a, 'monitor', { minutes: { lan: 60 }, turnBytes: 1000 });
    m.report(r.a, 'monitor', { minutes: { lan: 60 }, turnBytes: 1000 }); // resend
    m.report(r.a, 'monitor', { minutes: { lan: 55 } }); // late, older report
    r.save();
    await m.flush(T0, { scopeId: 'n1', carriers: [s.ref()] });
    expect(row(storage)?.counters.monitor).toMatchObject({ minutes: { lan: 60 }, turnBytes: 1000 });
    const r2 = s.ref();
    m.report(r2.a, 'monitor', { minutes: { lan: 75 }, turnBytes: 1000 });
    r2.save();
    await m.flush(T0 + H, { scopeId: 'n1', carriers: [s.ref()] });
    expect(row(storage)?.counters.monitor).toMatchObject({ minutes: { lan: 75 }, turnBytes: 1000 });
  });

  it('reads the month as written plus what is still owed (the parents’ usage query), without writing', async () => {
    const storage = fakeStorage();
    const m = new UsageMeter({ storage, scope: 'nursery' });
    m.bump('monitor', 'relayFrames', 7);
    await m.flush(T0, { scopeId: 'n1' });
    m.add('monitor', { minutes: { server: 3 } });
    const puts = storage.calls.put;
    const month = await m.month(T0 + 60_000);
    expect(month.counters.monitor).toMatchObject({ relayFrames: 7, minutes: { server: 3 } });
    expect(storage.calls.put).toBe(puts);
  });
});

describe('UsageMeter — durable sources with a watermark in the row (EventRoom)', () => {
  it('counts only what changed since the watermark, and survives a deferred flush', async () => {
    const storage = fakeStorage();
    const m = new UsageMeter({ storage, scope: 'event' });
    let segBytes = 1_000;
    const collect = (prev: unknown) => {
      const before = (prev as { seg?: number } | null)?.seg ?? 0;
      return { delta: { broadcast: { segBytes: segBytes - before, segCount: 1 } }, src: { seg: segBytes } };
    };
    expect(await m.flush(T0, { scopeId: 'ev1', account: 'u1', collect })).toBe('written');
    segBytes = 5_000; // more segments; the end-of-event flush is inside the hour → put off
    expect(await m.flush(T0 + 10 * 60_000, { scopeId: 'ev1', collect })).toBe('too_soon');
    // A fresh object (evicted meanwhile) picks it up later, exactly once.
    const later = new UsageMeter({ storage, scope: 'event' });
    expect(await later.flush(T0 + 24 * H, { scopeId: 'ev1', collect })).toBe('written');
    expect(row(storage, T0 + 24 * H)?.counters.broadcast?.segBytes).toBe(5_000);
  });

  it('finds the watermark across idle months — an event reopened in November after a quiet October counts only what is new', async () => {
    /** Adds the DO storage `list` the meter uses when it is there (sorted keys, prefix, end, reverse, limit). */
    const withList = (st: ReturnType<typeof fakeStorage>) =>
      Object.assign(st, {
        async list<T>(o: { prefix?: string; end?: string; reverse?: boolean; limit?: number } = {}) {
          let keys = [...st.data.keys()].filter((k) => k.startsWith(o.prefix ?? '') && (o.end == null || k < o.end)).sort();
          if (o.reverse) keys.reverse();
          if (o.limit != null) keys = keys.slice(0, o.limit);
          return new Map(keys.map((k) => [k, structuredClone(st.data.get(k)) as T]));
        },
      });
    for (const storage of [withList(fakeStorage()), fakeStorage()]) {
      let segCount = 600;
      const collect = (prev: unknown) => ({ delta: { broadcast: { segCount: segCount - ((prev as { seg?: number } | null)?.seg ?? 0) } }, src: { seg: segCount } });
      const sep = Date.parse('2026-09-20T20:00:00Z');
      const nov = Date.parse('2026-11-05T20:00:00Z');
      await new UsageMeter({ storage, scope: 'event' }).flush(sep, { scopeId: 'ev1', collect });
      segCount = 601; // one more segment, two months later
      expect(await new UsageMeter({ storage, scope: 'event' }).flush(nov, { scopeId: 'ev1', collect })).toBe('written');
      expect(row(storage, nov)?.counters.broadcast?.segCount).toBe(1); // not 601
    }
  });

  it('carries the watermark across a month boundary', async () => {
    const storage = fakeStorage();
    const m = new UsageMeter({ storage, scope: 'event' });
    let seg = 100;
    const collect = (prev: unknown) => ({ delta: { broadcast: { segBytes: seg - ((prev as { seg?: number } | null)?.seg ?? 0) } }, src: { seg } });
    const oct31 = Date.parse('2026-10-31T23:00:00Z');
    await m.flush(oct31, { scopeId: 'ev1', collect });
    seg = 160;
    await m.flush(oct31 + H, { scopeId: 'ev1', collect });
    expect(row(storage, oct31)?.counters.broadcast?.segBytes).toBe(100);
    expect(row(storage, oct31 + H)?.counters.broadcast?.segBytes).toBe(60);
  });
});

describe('UsageMeter — retention and calls', () => {
  it('prunes the row that aged out (13 months) only when it exists', async () => {
    const storage = fakeStorage();
    const m = new UsageMeter({ storage, scope: 'nursery' });
    expect(await m.prune(T0)).toBe(false);
    expect(storage.calls.delete).toBe(0);
    storage.data.set(usageKey('2025-09'), { month: '2025-09' });
    expect(await m.prune(T0)).toBe(true);
    expect(storage.data.has(usageKey('2025-09'))).toBe(false);
  });

  it('turns a finished call into minutes per participant on the path they reported', () => {
    const c = callUsage({ secs: 600, stats: [{ path: 'relay' }, { path: 'internet' }, { path: null }] });
    expect(c.minutes).toEqual({ lan: 0, direct: 10, turn: 10, server: 0 });
    expect(callUsage({ secs: 0, stats: [{ path: 'relay' }] })).toEqual(emptyCounters());
  });

  it('writes a call’s point at once, against the caller’s account, with no storage', () => {
    const storage = fakeStorage();
    const { sink, points } = fakeSink();
    const m = new UsageMeter({ storage, sink, scope: 'nursery' });
    m.point('call' as UsageKind, 'account', 'caller-uid', 'caller-uid', addUsage(emptyCounters(), { minutes: { turn: 3 } }));
    m.point('call', 'account', 'caller-uid', 'caller-uid', emptyCounters());
    expect(points).toEqual([{ indexes: ['call'], blobs: ['account', 'caller-uid', 'caller-uid', 'turn'], doubles: expect.any(Array) }]);
    expect(storage.calls).toEqual({ get: 0, put: 0, delete: 0 });
  });
});
