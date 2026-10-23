/**
 * Test kit for the Stream Studio rail (tests only — nothing imports this outside *.test.ts): the real
 * Worker and real EventRooms over fake bindings that count what Cloudflare bills —
 *   - Durable Object requests: every Worker → room fetch (a WebSocket upgrade too), every alarm, and
 *     incoming WebSocket messages at 20:1 (outgoing messages are free);
 *   - SQLite rows written: every key put or deleted, every setAlarm / deleteAlarm, every key a deleteAll removes;
 * plus an R2 bucket, the edge cache, a clock, and hibernation (a fresh object over the same storage and sockets).
 */
import { expect, vi } from 'vitest';
import * as live from './index';
import { EventRoom } from './eventRoom';

const liveWorker = live.default;
export const T0 = Date.parse('2026-10-23T18:00:00Z');

/** One server-side socket as the hibernation API hands it to the room. */
export class SimWS {
  sent: Record<string, unknown>[] = [];
  closed: number | null = null;
  private att: unknown = null;
  constructor(readonly h: RoomHarness | null) {}
  accept() {}
  send(s: string) {
    if (this.closed != null) throw new Error('closed');
    this.sent.push(JSON.parse(s));
  }
  serializeAttachment(a: unknown) {
    const s = JSON.stringify(a);
    if (s.length > 2048) throw new Error(`attachment over 2 KB (${s.length})`);
    this.att = JSON.parse(s);
  }
  deserializeAttachment() {
    return this.att == null ? null : structuredClone(this.att);
  }
  close(code: number) {
    if (this.closed != null) return;
    this.closed = code;
    this.h?.drop(this);
  }
  msgs(t: string) {
    return this.sent.filter((m) => m.t === t);
  }
}

/** One EventRoom's Durable Object state: KV storage that counts rows, the alarm, hibernatable sockets. */
export class RoomHarness {
  store = new Map<string, unknown>();
  sockets: SimWS[] = [];
  alarmAt: number | null = null;
  rows = 0;
  rowsBy = new Map<string, number>();
  lastAccepted: SimWS | null = null;
  room: EventRoom;
  readonly state = {
    storage: {
      get: async (k: string) => structuredClone(this.store.get(k)),
      put: async (k: string | Record<string, unknown>, v?: unknown) => {
        const entries = typeof k === 'string' ? [[k, v] as const] : Object.entries(k);
        for (const [kk, vv] of entries) {
          this.row(kk);
          this.store.set(kk, structuredClone(vv));
        }
      },
      delete: async (k: string | string[]) => {
        let n = 0;
        for (const kk of Array.isArray(k) ? k : [k]) {
          if (this.store.delete(kk)) {
            this.row(kk);
            n++;
          }
        }
        return Array.isArray(k) ? n : n > 0;
      },
      deleteAll: async () => {
        for (const k of this.store.keys()) this.row(k);
        this.store.clear();
      },
      list: async (o: { prefix?: string; end?: string; reverse?: boolean; limit?: number } = {}) => {
        let keys = [...this.store.keys()].filter((k) => (!o.prefix || k.startsWith(o.prefix)) && (!o.end || k < o.end)).sort();
        if (o.reverse) keys.reverse();
        if (o.limit) keys = keys.slice(0, o.limit);
        return new Map(keys.map((k) => [k, structuredClone(this.store.get(k))]));
      },
      getAlarm: async () => this.alarmAt,
      setAlarm: async (t: number | Date) => {
        this.row('(alarm)');
        this.alarmAt = Number(t);
      },
      deleteAlarm: async () => {
        if (this.alarmAt != null) this.row('(alarm)');
        this.alarmAt = null;
      },
    },
    getWebSockets: () => [...this.sockets],
    acceptWebSocket: (ws: SimWS) => {
      this.sockets.push(ws);
      this.lastAccepted = ws;
    },
  };
  constructor(private readonly env: unknown) {
    this.room = new EventRoom(this.state as never, env as never);
  }
  private row(k: string) {
    this.rows++;
    const key = k.startsWith('use:') ? 'use:*' : k;
    this.rowsBy.set(key, (this.rowsBy.get(key) ?? 0) + 1);
  }
  drop(ws: SimWS) {
    this.sockets = this.sockets.filter((s) => s !== ws);
  }
  /** Hibernation (or an eviction that kept the sockets): memory is gone, storage and attachments stay. */
  hibernate(): EventRoom {
    this.room = new EventRoom(this.state as never, this.env as never);
    return this.room;
  }
  /** An eviction that also dropped every socket (a deploy). */
  evict(): EventRoom {
    this.sockets = [];
    return this.hibernate();
  }
  rowsOf(key: string): number {
    return this.rowsBy.get(key) ?? 0;
  }
}

/** Lets a 101 through Node's Response (the Workers runtime allows it for WebSocket upgrades). */
export class Response101 extends Response {
  constructor(body?: BodyInit | null, init?: ResponseInit) {
    const upgrade = init?.status === 101;
    super(body, upgrade ? { ...init, status: 200 } : init);
    if (upgrade) Object.defineProperty(this, 'status', { get: () => 101 });
  }
}

/** The whole rail in memory: the Worker's bindings (rooms, R2, the edge cache), a clock, and the meters. */
export class Sim {
  now = T0;
  rooms = new Map<string, RoomHarness>();
  /** Worker → room fetches by path (each is a billed DO request). */
  fetches = new Map<string, number>();
  alarms = 0;
  wsIn = 0;
  workerRequests = 0;
  r2 = new Map<string, { body: Uint8Array; type: string }>();
  r2Puts = 0;
  /** Make R2 list/delete throw (an outage). */
  r2Down = false;
  edge = new Map<string, { body: Uint8Array; headers: [string, string][] }>();
  points: unknown[] = [];
  private pending: Promise<unknown>[] = [];
  private upgrading: RoomHarness | null = null;
  readonly env: live.Env;
  readonly ctx: ExecutionContext;

  constructor(extraEnv: Record<string, unknown> = {}) {
    vi.spyOn(Date, 'now').mockImplementation(() => this.now);
    const sim = this;
    vi.stubGlobal('Response', Response101);
    vi.stubGlobal(
      'WebSocketPair',
      class {
        0 = new SimWS(null);
        1 = new SimWS(sim.upgrading);
      },
    );
    vi.stubGlobal('caches', {
      default: {
        match: async (req: Request) => {
          const hit = sim.edge.get(req.url);
          return hit ? new Response(hit.body.slice(), { headers: hit.headers }) : undefined;
        },
        put: async (req: Request, res: Response) => {
          sim.edge.set(req.url, { body: new Uint8Array(await res.arrayBuffer()), headers: [...res.headers] });
        },
      },
    });
    // Supabase: the host is a signed-in member (event creation only).
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ signed_in: true, member: true, user_id: 'owner-uid', profile: { display_name: 'Host' } }), { status: 200 }));
    const bucket = {
      put: async (key: string, value: ArrayBuffer, opts?: { httpMetadata?: { contentType?: string } }) => {
        sim.r2Puts++;
        sim.r2.set(key, { body: new Uint8Array(value), type: opts?.httpMetadata?.contentType ?? '' });
        return { key, size: value.byteLength };
      },
      get: async (key: string) => {
        const o = sim.r2.get(key);
        return o ? { body: o.body.slice(), size: o.body.byteLength, httpMetadata: { contentType: o.type } } : null;
      },
      head: async (key: string) => (sim.r2.has(key) ? { key } : null),
      delete: async (keys: string | string[]) => {
        if (sim.r2Down) throw new Error('R2 unavailable');
        for (const k of Array.isArray(keys) ? keys : [keys]) sim.r2.delete(k);
      },
      list: async (o: { prefix?: string; limit?: number; cursor?: string }) => {
        if (sim.r2Down) throw new Error('R2 unavailable');
        // R2's cursor is a position in key order (deleting what a page returned doesn't skip anything).
        const all = [...sim.r2.keys()].filter((k) => k.startsWith(o.prefix ?? '') && (!o.cursor || k > o.cursor)).sort();
        const page = all.slice(0, o.limit ?? 1000);
        const truncated = page.length < all.length;
        return { objects: page.map((key) => ({ key })), truncated, cursor: truncated ? page.at(-1) : undefined };
      },
    };
    this.env = {
      ALLOWED_ORIGINS: '*',
      SUPABASE_URL: 'https://sb.test',
      SUPABASE_PUBLISHABLE_KEY: 'sb_test',
      LIVE_BUCKET: bucket,
      STREAM_USAGE: { writeDataPoint: (p: unknown) => void sim.points.push(p) },
      EVENT_ROOM: {
        idFromName: (n: string) => n,
        get: (id: string) => ({
          fetch: async (req: Request) => {
            const path = new URL(req.url).pathname;
            sim.fetches.set(path, (sim.fetches.get(path) ?? 0) + 1);
            const h = sim.room(id);
            sim.upgrading = h;
            try {
              return await h.room.fetch(req);
            } finally {
              sim.upgrading = null;
            }
          },
        }),
      },
      ...extraEnv,
    } as unknown as live.Env;
    this.ctx = { waitUntil: (p: Promise<unknown>) => void this.pending.push(p), passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;
  }

  room(id: string): RoomHarness {
    let h = this.rooms.get(id);
    if (!h) this.rooms.set(id, (h = new RoomHarness(this.env)));
    return h;
  }

  /** DO requests as billed: fetches + alarms + incoming WebSocket messages at 20:1. */
  doRequests(): number {
    let n = this.alarms + Math.ceil(this.wsIn / 20);
    for (const v of this.fetches.values()) n += v;
    return n;
  }

  rows(): number {
    let n = 0;
    for (const h of this.rooms.values()) n += h.rows;
    return n;
  }

  async worker(path: string, init?: RequestInit): Promise<Response> {
    this.workerRequests++;
    const res = await liveWorker.fetch(new Request(`https://stream.example/live-api${path}`, init), this.env, this.ctx);
    await this.settle();
    return res;
  }

  async settle(): Promise<void> {
    while (this.pending.length) await Promise.all(this.pending.splice(0));
  }

  /** Move the clock to `t`, firing the room's alarm (a billed request) whenever it comes due on the way. */
  async advanceTo(t: number): Promise<void> {
    for (;;) {
      const due = [...this.rooms.values()].filter((h) => h.alarmAt != null && h.alarmAt <= t).sort((a, b) => a.alarmAt! - b.alarmAt!)[0];
      if (!due) break;
      this.now = Math.max(this.now, due.alarmAt!);
      due.alarmAt = null; // the runtime clears it before the handler runs
      this.alarms++;
      await due.room.alarm();
      await this.settle();
    }
    this.now = Math.max(this.now, t);
  }

  async open(id: string, query: string): Promise<SimWS> {
    const res = await this.worker(`/api/events/${id}/ws?${query}`, { headers: { Upgrade: 'websocket' } });
    expect(res.status).toBe(101);
    const ws = this.room(id).lastAccepted!;
    return ws;
  }

  async say(id: string, ws: SimWS, msg: Record<string, unknown>): Promise<void> {
    this.wsIn++;
    await this.room(id).room.webSocketMessage(ws as never, JSON.stringify(msg));
    await this.settle();
  }

  async leave(id: string, ws: SimWS): Promise<void> {
    const h = this.room(id);
    h.drop(ws);
    ws.closed = 1001;
    await h.room.webSocketClose(ws as never);
    await this.settle();
  }
}
