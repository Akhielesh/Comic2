// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventRoom, type EventMeta } from './eventRoom';
import { STUN, includesTurn, resetIceCache } from './ice';

class FakeWS {
  sent: Record<string, unknown>[] = [];
  private att: unknown;
  constructor(att: unknown) {
    this.att = structuredClone(att);
  }
  send(s: string) {
    this.sent.push(JSON.parse(s));
  }
  serializeAttachment(a: unknown) {
    this.att = structuredClone(a);
  }
  deserializeAttachment() {
    return this.att;
  }
  close() {}
  msgs(t: string) {
    return this.sent.filter((m) => m.t === t);
  }
}

/** Just enough DurableObjectState for EventRoom: KV storage (single + batch put) and sockets. */
function setup(env: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>();
  const sockets: FakeWS[] = [];
  const state = {
    storage: {
      get: async (k: string) => structuredClone(store.get(k)),
      put: async (k: string | Record<string, unknown>, v?: unknown) => {
        if (typeof k === 'string') store.set(k, structuredClone(v));
        else for (const [kk, vv] of Object.entries(k)) store.set(kk, structuredClone(vv));
      },
      delete: async (k: string) => store.delete(k),
      setAlarm: async () => undefined,
      getAlarm: async () => null,
    },
    getWebSockets: () => sockets,
    acceptWebSocket: (ws: FakeWS) => void sockets.push(ws),
  };
  const room = new EventRoom(state as never, { ALLOWED_ORIGINS: '*', ...env } as never);
  const join = (role: string, sid = role) => {
    const ws = new FakeWS({ sid, name: role, role });
    sockets.push(ws);
    return ws;
  };
  const say = (ws: FakeWS, msg: Record<string, unknown>) => room.webSocketMessage(ws as never, JSON.stringify(msg));
  const init = (body: Record<string, unknown>) =>
    room.fetch(new Request('https://room.internal/init', { method: 'POST', body: JSON.stringify({ id: 'ev1', title: 'T', ...body }) }));
  return { room, store, sockets, join, say, init, meta: () => store.get('meta') as EventMeta };
}

describe('EventRoom · meeting kind', () => {
  it('stores a meeting as a meeting and logs that nothing is broadcast', async () => {
    const r = setup();
    const res = await r.init({ kind: 'meeting' });
    expect(res.status).toBe(200);
    expect(r.meta().kind).toBe('meeting');
    expect(r.meta().status).toBe('idle');
    const log = r.store.get('log') as { msg: string }[];
    expect(log.at(-1)?.msg).toMatch(/Meeting started/);
  });

  it('defaults anything else to a broadcast (old clients send no kind)', async () => {
    const a = setup();
    await a.init({});
    expect(a.meta().kind).toBe('broadcast');
    const b = setup();
    await b.init({ kind: 'party-mode' });
    expect(b.meta().kind).toBe('broadcast');
  });

  it('ends an idle meeting with a meeting-shaped log line', async () => {
    const r = setup();
    await r.init({ kind: 'meeting' });
    const host = r.join('host');
    await r.say(host, { t: 'state', status: 'ended' });
    expect(r.meta().status).toBe('ended');
    const log = r.store.get('log') as { msg: string }[];
    expect(log.at(-1)?.msg).toMatch(/Meeting ended/);
  });
});

describe('EventRoom · ICE servers over the room socket', () => {
  beforeEach(() => resetIceCache());
  afterEach(() => {
    vi.unstubAllGlobals();
    resetIceCache();
  });

  it('answers host and guests with STUN only when no TURN secrets are set', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const r = setup();
    await r.init({});
    const host = r.join('host');
    const guest = r.join('guest');
    await r.say(host, { t: 'ice' });
    await r.say(guest, { t: 'ice' });
    expect(host.msgs('ice')[0].servers).toEqual(STUN);
    expect(guest.msgs('ice')[0].servers).toEqual(STUN);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('adds Cloudflare TURN when the owner configured it', async () => {
    const turn = { urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u', credential: 'c' };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ iceServers: turn }), { status: 200 })));
    const r = setup({ TURN_KEY_ID: 'k', TURN_KEY_API_TOKEN: 't' });
    await r.init({});
    const host = r.join('host');
    await r.say(host, { t: 'ice' });
    const servers = host.msgs('ice')[0].servers as { urls: string | string[] }[];
    expect(includesTurn(servers)).toBe(true);
    expect(servers.slice(0, STUN.length)).toEqual(STUN);
  });

  it('never hands ICE credentials to viewers or the lobby', async () => {
    const r = setup();
    await r.init({});
    const viewer = r.join('viewer');
    const pending = r.join('pending');
    await r.say(viewer, { t: 'ice' });
    await r.say(pending, { t: 'ice' });
    expect(viewer.msgs('ice')).toHaveLength(0);
    expect(pending.msgs('ice')).toHaveLength(0);
  });
});
