/**
 * Test kit for the direct-call Durable Objects (tests only — nothing imports
 * this outside *.test.ts): fake storage, sockets and namespaces, so a
 * caller's line, a call's room and a callee's line can talk to each other
 * the way they do in production, plus a fake Supabase for live_me /
 * monitor_list / monitor_people keyed by token.
 */

import { CallRoom } from './callRoom';
import { userLineName } from './directCalls';
import { UserLine } from './userLine';

export class FakeWS {
  sent: Record<string, unknown>[] = [];
  closed: number | null = null;
  private att: unknown = null;
  constructor(private kit?: DOHarness) {}
  send(s: string | ArrayBuffer) {
    if (this.closed != null) throw new Error('closed');
    if (typeof s === 'string') this.sent.push(JSON.parse(s));
  }
  serializeAttachment(a: unknown) {
    this.att = structuredClone(a);
  }
  deserializeAttachment() {
    return this.att;
  }
  close(code: number) {
    this.closed = code;
    this.kit?.drop(this);
  }
  msgs(t: string) {
    return this.sent.filter((m) => m.t === t);
  }
  last(t: string) {
    return this.msgs(t).at(-1);
  }
}

export class Pair {
  constructor(public request: string, public response: string) {}
}

/** One Durable Object's state: storage (a Map), alarm, hibernatable sockets. */
export class DOHarness {
  store = new Map<string, unknown>();
  sockets: FakeWS[] = [];
  pinged = new Map<FakeWS, number>();
  alarmAt: number | null = null;
  /** Work handed to waitUntil (runs on after the reply). */
  background: Promise<unknown>[] = [];
  state = {
    waitUntil: (p: Promise<unknown>) => void this.background.push(p),
    storage: {
      get: async (k: string) => structuredClone(this.store.get(k)),
      put: async (k: string | Record<string, unknown>, v?: unknown) => {
        if (typeof k === 'string') this.store.set(k, structuredClone(v));
        else for (const [kk, vv] of Object.entries(k)) this.store.set(kk, structuredClone(vv));
      },
      delete: async (k: string) => this.store.delete(k),
      deleteAll: async () => this.store.clear(),
      getAlarm: async () => this.alarmAt,
      setAlarm: async (t: number) => void (this.alarmAt = t),
      deleteAlarm: async () => void (this.alarmAt = null),
    },
    getWebSockets: () => [...this.sockets],
    acceptWebSocket: (ws: FakeWS) => void this.sockets.push(ws),
    setWebSocketAutoResponse: () => undefined,
    getWebSocketAutoResponseTimestamp: (ws: FakeWS) => (this.pinged.has(ws) ? new Date(this.pinged.get(ws)!) : null),
  };
  drop(ws: FakeWS) {
    this.sockets = this.sockets.filter((s) => s !== ws);
  }
  /** A socket as the upgrade would leave it (accepted, not yet authenticated). */
  accept(sid: string): FakeWS {
    const ws = new FakeWS(this);
    ws.serializeAttachment({ sid, at: Date.now(), authed: false });
    this.state.acceptWebSocket(ws);
    return ws;
  }
}

export interface Member {
  uid: string;
  name: string;
  token: string;
  /** Nurseries this member is in: id → { name, baby, people }. */
  nurseries?: { id: string; name: string; baby_name: string | null; people: { user_id: string; label: string | null }[] }[];
  member?: boolean;
}

/** The whole direct-call system in memory: lines and rooms made on first use, as namespaces do. */
export class World {
  lines = new Map<string, { obj: UserLine; h: DOHarness }>();
  rooms = new Map<string, { obj: CallRoom; h: DOHarness }>();
  members = new Map<string, Member>();
  rpcs: { fn: string; token: string }[] = [];
  env: Record<string, unknown>;

  constructor(extra: Record<string, unknown> = {}) {
    const ns = (get: (name: string) => { fetch: (r: Request) => Promise<Response> }) => ({ idFromName: (n: string) => n, get: (id: string) => ({ fetch: (r: Request) => get(id).fetch(r) }) });
    const keyHolder = { fetch: async () => new Response(JSON.stringify({ publicKey: 'BPUB', privateJwk: {} }), { status: 200 }) };
    this.env = {
      SUPABASE_URL: 'https://sb.test',
      SUPABASE_PUBLISHABLE_KEY: 'sb_test',
      MONITOR_ROOM: { idFromName: () => 'k', get: () => keyHolder },
      USER_LINE: ns((n) => this.line(n).obj),
      CALL_ROOM: ns((n) => this.room(n).obj),
      ...extra,
    };
  }

  line(name: string) {
    let x = this.lines.get(name);
    if (!x) {
      const h = new DOHarness();
      x = { h, obj: new UserLine(h.state as never, this.env as never) };
      this.lines.set(name, x);
    }
    return x;
  }

  /** Let every object's after-the-reply work (waitUntil) finish — including work it starts in turn. */
  async settle(): Promise<void> {
    for (let i = 0; i < 20; i++) {
      const all = [...this.lines.values(), ...this.rooms.values()].flatMap((x) => x.h.background.splice(0));
      if (!all.length) return;
      await Promise.all(all);
    }
  }

  lineOf(uid: string) {
    return this.line(userLineName(uid));
  }

  room(id: string) {
    let x = this.rooms.get(id);
    if (!x) {
      const h = new DOHarness();
      x = { h, obj: new CallRoom(h.state as never, this.env as never) };
      this.rooms.set(id, x);
    }
    return x;
  }

  add(m: Member) {
    this.members.set(m.token, m);
    return m;
  }

  /** Supabase: live_me / monitor_list / monitor_people answer for the token's member. */
  fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const token = String((init.headers as Record<string, string>).authorization).replace('Bearer ', '');
    const fn = String(url).split('/rpc/')[1];
    this.rpcs.push({ fn, token });
    const m = this.members.get(token);
    const ok = (d: unknown) => new Response(JSON.stringify(d), { status: 200 });
    if (!m) return new Response('{}', { status: 401 });
    if (fn === 'live_me') return ok({ signed_in: true, member: m.member !== false, user_id: m.uid, profile: { display_name: m.name } });
    if (fn === 'monitor_list') return ok({ ok: true, nurseries: (m.nurseries ?? []).map(({ id, name, baby_name }) => ({ id, name, baby_name })) });
    if (fn === 'monitor_people') {
      const nid = JSON.parse(String(init.body)).p_nursery;
      const n = (m.nurseries ?? []).find((x) => x.id === nid);
      return ok({ ok: !!n, people: (n?.people ?? []).map((p) => ({ ...p, is_me: p.user_id === m.uid })) });
    }
    return new Response('{}', { status: 404 });
  };

  /** Open an app on a member's line: the socket the upgrade would accept, then the auth frame. */
  async app(m: Member, dev: string, token = m.token): Promise<FakeWS> {
    const { h, obj } = this.lineOf(m.uid);
    if (!h.store.has('uid')) h.store.set('uid', m.uid);
    const ws = h.accept(`l-${dev}`);
    await obj.webSocketMessage(ws as never, JSON.stringify({ t: 'auth', token, dev, dn: dev }));
    return ws;
  }

  async say(m: Member, ws: FakeWS, msg: unknown) {
    await this.lineOf(m.uid).obj.webSocketMessage(ws as never, JSON.stringify(msg));
  }

  /** Join a call's room with a ticket. */
  async enter(id: string, ticket: string, dev: string): Promise<FakeWS> {
    const { h, obj } = this.room(id);
    const ws = h.accept(`c-${dev}`);
    await obj.webSocketMessage(ws as never, JSON.stringify({ t: 'auth', ticket, dev }));
    return ws;
  }

  async in(id: string, ws: FakeWS, msg: unknown) {
    await this.room(id).obj.webSocketMessage(ws as never, JSON.stringify(msg));
  }

  async leave(id: string, ws: FakeWS) {
    this.room(id).h.drop(ws);
    await this.room(id).obj.webSocketClose(ws as never);
  }
}
