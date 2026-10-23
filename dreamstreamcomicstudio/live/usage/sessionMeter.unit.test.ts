// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UsageMeter, clampClientReport, type MeterStorage, type UsageCarrier } from '../../live-worker/src/usageMeter';
import {
  MIN_REPORT_GAP_MS,
  REPORT_EVERY_MS,
  SessionMeter,
  callPathOf,
  relayBytesFromReport,
  streamPathOf,
  sumTotals,
  totalMs,
  type StatsLike,
  type UseReport,
} from './sessionMeter';

const MIN = 60_000;

/** A fake getStats() report: a transport, its selected pair, and the pair's two candidates. */
function report(o: { local: 'relay' | 'host' | 'srflx'; bytes: number; pair?: string; noTransport?: boolean }): StatsLike {
  const pair = o.pair ?? 'P1';
  const rows: (Record<string, unknown> & { type: string; id: string })[] = [
    ...(o.noTransport ? [] : [{ type: 'transport', id: 'T', selectedCandidatePairId: pair }]),
    { type: 'candidate-pair', id: pair, localCandidateId: `L-${pair}`, remoteCandidateId: `R-${pair}`, bytesReceived: o.bytes, nominated: true, state: 'succeeded', selected: o.noTransport ? true : undefined },
    { type: 'candidate-pair', id: 'OTHER', localCandidateId: 'L-OTHER', bytesReceived: 9e9 },
    { type: 'local-candidate', id: `L-${pair}`, candidateType: o.local },
    { type: 'local-candidate', id: 'L-OTHER', candidateType: 'relay' },
    { type: 'remote-candidate', id: `R-${pair}`, candidateType: 'host' },
  ];
  const byId = new Map(rows.map((r) => [r.id, r]));
  return { forEach: (cb) => rows.forEach(cb), get: (id) => byId.get(id) };
}

function clock(start = Date.UTC(2026, 9, 23, 20)) {
  let t = start;
  return { now: () => t, add: (ms: number) => (t += ms) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('paths', () => {
  it('maps the app’s network path to the usage path', () => {
    expect(streamPathOf('lan')).toBe('lan');
    expect(streamPathOf('internet')).toBe('direct');
    expect(streamPathOf('relay')).toBe('turn');
    expect(streamPathOf(null)).toBeNull();
  });

  it('a call is relayed if anyone connected is, Home Wi-Fi only if everyone is, else direct', () => {
    expect(callPathOf([])).toBeNull();
    expect(callPathOf([{ state: 'connecting', path: 'relay' }])).toBeNull();
    expect(callPathOf([{ state: 'connected', path: 'lan' }, { state: 'connected', path: 'lan' }])).toBe('lan');
    expect(callPathOf([{ state: 'connected', path: 'lan' }, { state: 'connected', path: 'internet' }])).toBe('direct');
    expect(callPathOf([{ state: 'connected', path: 'internet' }, { state: 'connected', path: 'relay' }])).toBe('turn');
    // Someone still connecting through a relay isn't carrying media yet.
    expect(callPathOf([{ state: 'connected', path: 'lan' }, { state: 'connecting', path: 'relay' }])).toBe('lan');
  });
});

describe('relay bytes from a stats report', () => {
  it('reads bytesReceived on the selected pair only when OUR candidate is the relay (what Cloudflare bills)', () => {
    expect(relayBytesFromReport(report({ local: 'relay', bytes: 1234 }))).toEqual({ pair: 'P1', bytes: 1234 });
    expect(relayBytesFromReport(report({ local: 'host', bytes: 1234 }))).toBeNull();
    expect(relayBytesFromReport(report({ local: 'srflx', bytes: 1234 }))).toBeNull();
  });

  it('falls back to the selected / nominated pair when there is no transport row (Firefox)', () => {
    expect(relayBytesFromReport(report({ local: 'relay', bytes: 77, noTransport: true }))).toEqual({ pair: 'P1', bytes: 77 });
  });

  it('never throws on a broken report', () => {
    expect(relayBytesFromReport({ forEach: () => { throw new Error('x'); }, get: () => undefined })).toBeNull();
  });
});

describe('SessionMeter', () => {
  it('counts minutes per path from path changes, with no timer of its own', () => {
    vi.useFakeTimers();
    const c = clock();
    const m = new SessionMeter({ now: c.now });
    m.setPath('lan');
    c.add(30 * MIN);
    m.setPath('turn');
    c.add(10 * MIN);
    m.setPath('server');
    c.add(5 * MIN);
    m.setPath(null);
    c.add(60 * MIN); // nothing flowing: not counted
    expect(m.totals().ms).toEqual({ lan: 30 * MIN, direct: 0, turn: 10 * MIN, server: 5 * MIN });
    expect(totalMs(m.totals().ms)).toBe(45 * MIN);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('adds TURN bytes as deltas per connection; a new pair (ICE restart) counts from zero', () => {
    const m = new SessionMeter();
    const pc = {};
    m.observe(report({ local: 'relay', bytes: 1000 }), pc);
    m.observe(report({ local: 'relay', bytes: 4000 }), pc);
    expect(m.totals().turnBytes).toBe(4000);
    m.observe(report({ local: 'relay', bytes: 500, pair: 'P2' }), pc); // restart: a new pair
    expect(m.totals().turnBytes).toBe(4500);
    m.observe(report({ local: 'host', bytes: 1e9, pair: 'P3' }), pc); // went direct: nothing billed
    expect(m.totals().turnBytes).toBe(4500);
    // A second connection keeps its own count.
    const pc2 = {};
    m.observe(report({ local: 'relay', bytes: 300 }), pc2);
    expect(m.totals().turnBytes).toBe(4800);
  });

  it('reports CUMULATIVE totals for the socket: on a path change, every 15 min and on pagehide — never our-server minutes', () => {
    const c = clock();
    const sent: UseReport[] = [];
    const m = new SessionMeter({ now: c.now, send: (r) => sent.push(r) });
    m.connected();
    m.setPath('direct');
    expect(sent).toHaveLength(0); // nothing counted yet: no message
    for (let i = 0; i < (REPORT_EVERY_MS / 5000) - 1; i++) {
      c.add(5000);
      m.tick();
    }
    expect(sent).toHaveLength(0);
    c.add(5000);
    m.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ t: 'use', minutes: { lan: 0, direct: 15, turn: 0 }, turnBytes: 0 });

    // A path change sends what the old path carried (a minute or more after the last report).
    c.add(2 * MIN);
    m.setPath('server');
    expect(sent).toHaveLength(2);
    expect(sent[1].minutes.direct).toBe(17);
    c.add(10 * MIN);
    m.flush(); // pagehide
    // Ten minutes through our server: the room measures those itself, so nothing new to say.
    expect(sent).toHaveLength(2);
    m.setPath('lan');
    c.add(5 * MIN);
    m.flush(); // pagehide
    expect(sent).toHaveLength(3);
    expect(sent[2]).toEqual({ t: 'use', minutes: { lan: 5, direct: 17, turn: 0 }, turnBytes: 0 });
    expect(Object.keys(sent[2].minutes)).not.toContain('server');
    expect(m.totals().ms.server).toBe(10 * MIN); // …but this device's own ledger has them
    // A flush with nothing new sends nothing.
    m.flush();
    expect(sent).toHaveLength(3);
  });

  it('holds a path-change report that comes within a minute of the last one, and the next tick sends it', () => {
    const c = clock();
    const sent: UseReport[] = [];
    const m = new SessionMeter({ now: c.now, send: (r) => sent.push(r) });
    m.connected();
    m.setPath('lan');
    c.add(20_000);
    m.setPath('turn'); // flapping network: held
    c.add(10_000);
    m.setPath('lan');
    expect(sent).toHaveLength(0);
    c.add(MIN_REPORT_GAP_MS - 30_000);
    m.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0].minutes.lan).toBeCloseTo(0.83, 2);
    expect(sent[0].minutes.turn).toBeCloseTo(0.17, 2);
  });

  it('starts a new baseline for each socket (the room counts per socket), and sends nothing while there is none', () => {
    const c = clock();
    const sent: UseReport[] = [];
    const m = new SessionMeter({ now: c.now, send: (r) => sent.push(r) });
    m.setPath('direct');
    c.add(20 * MIN);
    m.flush();
    expect(sent).toHaveLength(0); // no socket yet
    m.connected();
    c.add(5 * MIN);
    m.flush();
    expect(sent.at(-1)?.minutes.direct).toBe(5);
    m.disconnected();
    c.add(5 * MIN);
    m.flush();
    expect(sent).toHaveLength(1);
    m.connected();
    c.add(3 * MIN);
    m.flush();
    expect(sent.at(-1)?.minutes.direct).toBe(3);
    // The session total still has all of it.
    expect(m.totals().ms.direct).toBe(33 * MIN);
  });

  it('doesn’t count time the page was frozen (a locked phone that stopped ticking)', () => {
    const c = clock();
    const m = new SessionMeter({ now: c.now, maxGapMs: 3 * MIN });
    m.setPath('lan');
    for (let i = 0; i < 12; i++) {
      c.add(5000);
      m.tick();
    }
    c.add(60 * MIN); // frozen
    m.tick();
    c.add(5000);
    m.tick();
    expect(m.totals().ms.lan).toBe(65_000);
  });

  it('hands closed stretches to the device ledger at least every 5 minutes', () => {
    const c = clock();
    const seg: [string, number, number][] = [];
    const m = new SessionMeter({ now: c.now, onSegment: (p, a, b) => seg.push([p, a, b]) });
    const t0 = c.now();
    m.setPath('direct');
    for (let i = 0; i < 132; i++) {
      c.add(5000);
      m.tick();
    }
    expect(seg.length).toBe(2);
    expect(seg.every(([p]) => p === 'direct')).toBe(true);
    expect(seg[0][1]).toBe(t0);
    m.setPath(null);
    expect(seg.reduce((s, [, a, b]) => s + b - a, 0)).toBe(11 * MIN);
  });

  it('a throwing sender or ledger never breaks the screen', () => {
    const m = new SessionMeter({
      send: () => { throw new Error('socket gone'); },
      onSegment: () => { throw new Error('storage full'); },
    });
    m.connected();
    m.setPath('turn');
    expect(() => m.flush()).not.toThrow();
  });

  it('adds several meters (one per meeting guest)', () => {
    const c = clock();
    const a = new SessionMeter({ now: c.now });
    const b = new SessionMeter({ now: c.now });
    a.setPath('direct');
    b.setPath('turn');
    c.add(10 * MIN);
    const t = sumTotals([a.totals(), b.totals()]);
    expect(t.ms).toEqual({ lan: 0, direct: 10 * MIN, turn: 10 * MIN, server: 0 });
    expect(sumTotals([]).startedAt).toBe(0);
  });
});

/**
 * Target (feature doc Phase B verification): the room's view of what a viewer reported is within
 * ±5% of what the viewer measured, over a whole night of path changes, reconnects and resends —
 * through the room's own clamp and per-socket dedupe (live-worker/src/usageMeter.ts).
 */
describe('night simulation: client reports → room totals', () => {
  const memStorage = (): MeterStorage => {
    const m = new Map<string, unknown>();
    return {
      get: async <T,>(k: string) => m.get(k) as T | undefined,
      put: async (k: string, v: unknown) => void m.set(k, v),
    } as MeterStorage;
  };

  type Plan = [Parameters<SessionMeter['setPath']>[0], number][];
  const NIGHT: Plan = [['lan', 180], ['turn', 45], ['lan', 120], ['server', 20], ['direct', 95], ['turn', 1], ['direct', 39], ['lan', 100]];

  /** One viewer's night, ticking every 5 s like the screen does; `dropsAt`: minutes when the socket drops and comes back. */
  function night(plan: Plan, dropsAt: number[] = []) {
    const room = new UsageMeter({ storage: memStorage(), scope: 'nursery' });
    const c = clock();
    let socket: UsageCarrier = {};
    let socketAt = c.now();
    const sockets: UsageCarrier[] = [socket];
    let messages = 0;
    const m = new SessionMeter({
      now: c.now,
      maxGapMs: 3 * MIN,
      send: (r) => {
        messages += 1;
        const msg = r as unknown as Record<string, unknown>;
        room.report(socket, 'monitor', clampClientReport(msg, c.now() - socketAt));
        // A resend of the same totals never double counts.
        room.report(socket, 'monitor', clampClientReport(msg, c.now() - socketAt));
      },
    });
    const pc = {};
    let bytes = 0;
    m.connected();
    let minute = 0;
    for (const [path, mins] of plan) {
      m.setPath(path);
      for (let s = 0; s < mins * 12; s++) {
        c.add(5000);
        if (path === 'turn') {
          bytes += (0.69e6 / 8) * 5; // a relayed picture at the relay cap
          if (s % 4 === 3) m.observe(report({ local: 'relay', bytes }), pc); // the 20 s path check
        }
        m.tick();
        if (s % 12 === 11 && dropsAt.includes(++minute)) {
          // The socket drops and comes back: a new attachment, a new baseline.
          m.disconnected();
          socket = {};
          socketAt = c.now();
          sockets.push(socket);
          m.connected();
        }
      }
    }
    m.setPath(null);
    m.flush(); // pagehide
    const roomMin = (k: 'lan' | 'direct' | 'turn') => sockets.reduce((s, a) => s + Number(a.u?.monitor?.c?.minutes?.[k] ?? 0), 0);
    const roomBytes = sockets.reduce((s, a) => s + Number(a.u?.monitor?.c?.turnBytes ?? 0), 0);
    return { dev: m.totals(), roomMin, roomBytes, sockets, messages };
  }

  it('a 10 h night of path changes: room minutes per path and relay bytes within ±5% of the device’s; ~4 messages an hour', () => {
    const r = night(NIGHT);
    for (const k of ['lan', 'direct', 'turn'] as const) {
      const devMin = r.dev.ms[k] / MIN;
      expect(Math.abs(r.roomMin(k) - devMin)).toBeLessThanOrEqual(devMin * 0.05);
    }
    expect(r.dev.turnBytes).toBeGreaterThan(0);
    expect(Math.abs(r.roomBytes - r.dev.turnBytes)).toBeLessThanOrEqual(r.dev.turnBytes * 0.05);
    // Never our-server minutes from a client.
    expect(r.sockets.every((a) => !a.u?.monitor?.c?.minutes?.server)).toBe(true);
    // ~4 an hour (the 15-minute reports) plus the night's few path changes, held ≥ 1 min apart.
    expect(r.messages / 10).toBeLessThanOrEqual(5);
  });

  it('with the socket dropping twice: never more than the device measured, at most the unsent ≤ 15 min lost per drop, total within ±5%', () => {
    const r = night(NIGHT, [300, 470]);
    let devAll = 0;
    let roomAll = 0;
    for (const k of ['lan', 'direct', 'turn'] as const) {
      const devMin = r.dev.ms[k] / MIN;
      devAll += devMin;
      roomAll += r.roomMin(k);
      expect(r.roomMin(k)).toBeLessThanOrEqual(devMin + 0.01);
      expect(devMin - r.roomMin(k)).toBeLessThanOrEqual(2 * 15);
    }
    expect(Math.abs(roomAll - devAll)).toBeLessThanOrEqual(devAll * 0.05);
    expect(r.sockets).toHaveLength(3);
  });
});
