/**
 * Test kit for MonitorRoom's cost diet (tests only — nothing imports this outside *.test.ts).
 *
 * A Durable Object world that COUNTS what Cloudflare bills, the way Cloudflare bills it
 * (developers.cloudflare.com/durable-objects/platform/pricing, re-read 2026-10-23):
 *   - requests: every alarm invocation, every HTTP request (a socket's upgrade), and incoming
 *     WebSocket messages at 20:1 — counted here INCLUDING the app's `{"t":"ping"}` keepalives the
 *     runtime auto-answers (only protocol-level pings are documented as free; auto-responses are
 *     documented as free of wall-clock time, not of the request) — the conservative reading;
 *   - rows written: every KV put / delete (one per key), every setAlarm, and every SQL row an
 *     INSERT / UPDATE / DELETE touches PLUS one per index entry it touches (Cloudflare counts an
 *     index entry as a row written, D1 and DO SQLite alike);
 *   - wakes: alarm and message deliveries (a duration proxy; auto-answered pings wake nothing).
 * It also hibernates the room on demand — a new MonitorRoom on the same storage and sockets, so
 * everything only in memory is gone, exactly as after eviction with hibernatable sockets.
 */

import type { SqlJsStatic } from 'sql.js';
import { MonitorRoom, type MonEnv } from './monitorRoom';
import { netTag } from './monitorFair';

export interface Counts {
  /** Alarm invocations (each a billed request and a wake). */
  alarms: number;
  /** HTTP requests to the object (socket upgrades). */
  http: number;
  /** Incoming WebSocket messages delivered to the object (each a wake). */
  delivered: number;
  /** Incoming app pings answered by the runtime (no wake; still counted as billed messages here). */
  pings: number;
  kvPuts: number;
  kvDeletes: number;
  setAlarms: number;
  sqlRows: number;
  /** Times the object lost its memory (hibernation / eviction with sockets kept). */
  hibernations: number;
}

export const zeroCounts = (): Counts => ({ alarms: 0, http: 0, delivered: 0, pings: 0, kvPuts: 0, kvDeletes: 0, setAlarms: 0, sqlRows: 0, hibernations: 0 });

/** Billed DO requests: alarms + HTTP + incoming messages (delivered and auto-answered) at 20:1. */
export const billedRequests = (c: Counts): number => c.alarms + c.http + (c.delivered + c.pings) / 20;
/** Rows written: KV puts and deletes, setAlarm calls, SQL rows with their index entries. */
export const rowsWritten = (c: Counts): number => c.kvPuts + c.kvDeletes + c.setAlarms + c.sqlRows;

/** One SQL row per table row touched, plus one per index entry touched (DO SQLite / D1 billing). */
export function countingSql(SQL: SqlJsStatic, counts: Counts) {
  const db = new SQL.Database() as unknown as {
    prepare(q: string): { bind(v?: unknown[]): boolean; step(): boolean; getAsObject(): Record<string, unknown>; free(): boolean };
    getRowsModified(): number;
  };
  const raw = (q: string, ...b: unknown[]) => {
    const st = db.prepare(q);
    try {
      st.bind(b.map((v) => (v === undefined ? null : v)) as never);
      const rows: Record<string, unknown>[] = [];
      while (st.step()) rows.push(st.getAsObject());
      return rows;
    } finally {
      st.free();
    }
  };
  const indexCache = new Map<string, { cols: Set<string> }[]>();
  const indexesOf = (table: string) => {
    let list = indexCache.get(table);
    if (list) return list;
    const def = String(raw(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`, table)[0]?.sql ?? '');
    const withoutRowid = /WITHOUT\s+ROWID/i.test(def);
    list = raw(`PRAGMA index_list(${table})`)
      // In a WITHOUT ROWID table the primary key IS the table.
      .filter((r) => !(withoutRowid && r.origin === 'pk'))
      .map((r) => ({ cols: new Set(raw(`PRAGMA index_info(${String(r.name)})`).map((c) => String(c.name))) }));
    indexCache.set(table, list);
    return list;
  };
  return {
    exec(q: string, ...b: unknown[]) {
      const rows = raw(q, ...b);
      const kind = /^\s*(INSERT|REPLACE|UPDATE|DELETE)\b/i.exec(q)?.[1]?.toUpperCase();
      if (/^\s*(CREATE|DROP|ALTER)\b/i.test(q)) indexCache.clear();
      if (kind) {
        const n = db.getRowsModified();
        const table = /(?:INTO|UPDATE|FROM)\s+([A-Za-z_][\w]*)/i.exec(q)?.[1] ?? '';
        const idx = table ? indexesOf(table) : [];
        let per = 1 + idx.length;
        if (kind === 'UPDATE') {
          const set = /\bSET\s+([\s\S]+?)\s+WHERE\b/i.exec(q)?.[1] ?? '';
          const cols = new Set(set.split(',').map((s) => s.split('=')[0].trim()));
          per = 1 + idx.filter((i) => [...i.cols].some((c) => cols.has(c))).length;
        }
        counts.sqlRows += n * per;
      }
      return { toArray: () => rows };
    },
  };
}

/** A socket that keeps what it was sent (only the kinds a test asks to keep, so a 12 h night stays small). */
export class KitWS {
  sent: Record<string, unknown>[] = [];
  bin: ArrayBuffer[] = [];
  binBytes = 0;
  /** Message counts by type (everything). */
  types = new Map<string, number>();
  closed: number | null = null;
  /** The runtime's last auto-answered ping (getWebSocketAutoResponseTimestamp). */
  pingedAt: number | null = null;
  private att: unknown = null;
  constructor(private keep: ((t: string) => boolean) | null = null, private keepBin = true) {}
  send(s: string | ArrayBuffer) {
    if (typeof s === 'string') {
      const m = JSON.parse(s) as Record<string, unknown>;
      const t = String(m.t);
      this.types.set(t, (this.types.get(t) ?? 0) + 1);
      if (!this.keep || this.keep(t)) this.sent.push(m);
    } else {
      this.binBytes += s.byteLength;
      if (this.keepBin) this.bin.push(s);
    }
  }
  serializeAttachment(a: unknown) {
    const s = JSON.stringify(a);
    // The runtime refuses attachments over 2 KiB: a room must never rely on a bigger one.
    if (s.length > 2048) throw new Error(`attachment too big: ${s.length} bytes`);
    this.att = JSON.parse(s);
  }
  deserializeAttachment() {
    return this.att == null ? null : structuredClone(this.att);
  }
  close(code: number) {
    this.closed = code;
  }
  msgs(t: string) {
    return this.sent.filter((m) => m.t === t);
  }
  last(t: string) {
    return this.msgs(t).at(-1);
  }
}

export class WSPair {
  constructor(public request: string, public response: string) {}
}

export interface KitOptions {
  SQL: SqlJsStatic;
  nid: string;
  roles: Record<string, { user_id: string; role: string; display_name: string; label: string | null }>;
  /** Which message types sockets keep (default: all). */
  keep?: (t: string) => boolean;
}

/** A MonitorRoom world: counted storage, sockets, alarm, Supabase and the VAPID key holder. */
export function monitorWorld(o: KitOptions) {
  const counts = zeroCounts();
  const store = new Map<string, unknown>([['nid', o.nid]]);
  const sockets: KitWS[] = [];
  let alarm: number | null = null;
  const storage = {
    get: async (k: string) => structuredClone(store.get(k)),
    put: async (k: string | Record<string, unknown>, v?: unknown) => {
      if (typeof k === 'string') {
        counts.kvPuts += 1;
        store.set(k, structuredClone(v));
      } else {
        for (const [kk, vv] of Object.entries(k)) {
          counts.kvPuts += 1;
          store.set(kk, structuredClone(vv));
        }
      }
    },
    delete: async (k: string) => {
      counts.kvDeletes += 1;
      return store.delete(k);
    },
    getAlarm: async () => alarm,
    setAlarm: async (t: number) => {
      counts.setAlarms += 1;
      alarm = t;
    },
    deleteAlarm: async () => {
      alarm = null;
    },
    sql: countingSql(o.SQL, counts),
  };
  const state = {
    storage,
    blockConcurrencyWhile: <T>(fn: () => Promise<T>) => fn(),
    getWebSockets: () => sockets,
    acceptWebSocket: (ws: KitWS) => void sockets.push(ws),
    setWebSocketAutoResponse: () => undefined,
    getWebSocketAutoResponseTimestamp: (ws: KitWS) => (ws.pingedAt == null ? null : new Date(ws.pingedAt)),
  };
  const keyHolder = { fetch: async () => new Response(JSON.stringify({ publicKey: 'pub', privateKey: 'priv' }), { status: 200 }) };
  const env = {
    SUPABASE_URL: 'https://sb.test',
    SUPABASE_PUBLISHABLE_KEY: 'sb_test',
    MONITOR_ROOM: { idFromName: () => 'x', get: () => keyHolder },
  } as unknown as MonEnv;
  const fetchStub = async (_url: string, init: RequestInit) => {
    const token = String((init.headers as Record<string, string>)?.authorization ?? '').replace('Bearer ', '');
    const r = o.roles[token];
    return new Response(JSON.stringify(r ? { ok: true, ...r, nursery_name: 'Nursery', baby_name: 'Aria' } : { ok: false }), { status: 200 });
  };
  let room = new MonitorRoom(state as never, env);
  const w = {
    counts,
    store,
    sockets,
    state,
    env,
    fetchStub,
    get room() {
      return room;
    },
    alarmAt: () => alarm,
    /** Memory gone (hibernation / eviction); storage, sockets and their attachments stay. */
    hibernate() {
      counts.hibernations += 1;
      room = new MonitorRoom(state as never, env);
      return room;
    },
    /** A socket signs in. `ip`: the address it connects from (only its network's hash is kept, as the room does). */
    async join(token: string, mode: 'camera' | 'viewer' | 'line', dev: string, extra: Record<string, unknown> = {}, opts: { ws?: KitWS; ip?: string } = {}) {
      const ws = opts.ws ?? new KitWS(o.keep ?? null);
      counts.http += 1; // the upgrade
      const nt = opts.ip ? await netTag(o.nid, opts.ip) : null;
      ws.serializeAttachment({ sid: `s-${dev}-${counts.http}`, at: Date.now(), authed: false, ...(nt ? { nt } : {}) });
      state.acceptWebSocket(ws);
      await w.deliver(ws, { t: 'auth', token, mode, dev, dn: dev === 'crib' ? 'Crib iPhone' : dev, ...extra });
      return ws;
    },
    async deliver(ws: KitWS, msg: unknown) {
      counts.delivered += 1;
      await room.webSocketMessage(ws as never, typeof msg === 'string' || msg instanceof ArrayBuffer ? msg : JSON.stringify(msg));
    },
    /** An app keepalive the runtime answers by itself (no wake). */
    ping(ws: KitWS) {
      counts.pings += 1;
      ws.pingedAt = Date.now();
    },
    async close(ws: KitWS) {
      sockets.splice(sockets.indexOf(ws), 1);
      await room.webSocketClose(ws as never);
    },
    /** Run the alarm if it is due (the runtime clears it before calling). */
    async runAlarmIfDue(now: number): Promise<boolean> {
      if (alarm == null || alarm > now) return false;
      alarm = null;
      counts.alarms += 1;
      await room.alarm();
      return true;
    },
  };
  return w;
}

export type MonitorWorld = ReturnType<typeof monitorWorld>;
