// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mintActToken, resetActKeyCache } from './auth/actToken';
import { resetJwksCache } from './auth/jwks';
import { b64url } from './auth/jose';
import liveWorker, { resetHostPasses, type Env } from './index';
import { resetEdgeState, type RateLimiterLike } from './origin';
import { clearMemberCache } from './supabaseAuth';

afterEach(() => resetHostPasses());

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function createSegmentEnv(hostKey = 'good-host-key') {
  const calls = {
    bucketPuts: 0,
    bucketDeletes: 0,
    roomPaths: [] as string[],
    waitUntil: 0,
  };

  const roomStub = {
    fetch: async (req: Request): Promise<Response> => {
      const url = new URL(req.url);
      calls.roomPaths.push(url.pathname);
      const suppliedKey = req.headers.get('x-host-key');

      if (url.pathname === '/auth') {
        return suppliedKey === hostKey ? new Response(null, { status: 204 }) : jsonResponse({ error: 'forbidden' }, 403);
      }

      if (url.pathname === '/ingest') {
        return suppliedKey === hostKey ? jsonResponse({ ok: true }) : jsonResponse({ error: 'forbidden' }, 403);
      }

      return jsonResponse({ error: `unexpected room path ${url.pathname}` }, 500);
    },
  };

  const env = {
    ALLOWED_ORIGINS: '*',
    EVENT_ROOM: {
      idFromName: (id: string) => id,
      get: () => roomStub,
    },
    LIVE_BUCKET: {
      put: async () => {
        calls.bucketPuts += 1;
      },
      delete: async () => {
        calls.bucketDeletes += 1;
      },
    },
  };

  const ctx = {
    waitUntil: () => {
      calls.waitUntil += 1;
    },
    passThroughOnException: () => undefined,
    props: {},
  };

  return { calls, env: env as unknown as Env, ctx: ctx as unknown as ExecutionContext };
}

describe('live worker segment upload auth', () => {
  it('rejects unauthorized segment uploads before writing any bytes to R2', async () => {
    const { env, ctx, calls } = createSegmentEnv();
    const req = new Request('https://worker.example/api/events/abc123/segments?seq=1&ms=3000', {
      method: 'POST',
      headers: {
        'content-type': 'video/webm',
        'x-host-key': 'bad-key',
      },
      body: new Uint8Array([1, 2, 3]),
    });

    const res = await liveWorker.fetch(req, env, ctx);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
    expect(calls.roomPaths).toEqual(['/auth']);
    expect(calls.bucketPuts).toBe(0);
    expect(calls.bucketDeletes).toBe(0);
    expect(calls.waitUntil).toBe(0);
  });

  it('stores and ingests an authorized segment after the cheap host-key gate passes', async () => {
    const { env, ctx, calls } = createSegmentEnv();
    const req = new Request('https://worker.example/api/events/abc123/segments?seq=2&ms=3000', {
      method: 'POST',
      headers: {
        'content-type': 'video/webm',
        'x-host-key': 'good-host-key',
      },
      body: new Uint8Array([4, 5, 6]),
    });

    const res = await liveWorker.fetch(req, env, ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, seq: 2 });
    expect(calls.roomPaths).toEqual(['/auth', '/ingest']);
    expect(calls.bucketPuts).toBe(1);
    expect(calls.bucketDeletes).toBe(0);
  });
});

describe('segment uploads: one host pass per isolate spares the room’s /auth (C10)', () => {
  beforeEach(() => resetHostPasses());
  afterEach(() => vi.restoreAllMocks());

  /** Rooms that know their host key (changeable: a rotation), an R2 that records puts and deletes. */
  function passEnv() {
    const keys = new Map<string, string>();
    const keyOf = (id: string) => keys.get(id) ?? `key-${id}`;
    const calls = { room: [] as string[], puts: [] as string[], deletes: [] as string[] };
    const room = (id: string) => ({
      fetch: async (req: Request): Promise<Response> => {
        const path = new URL(req.url).pathname;
        calls.room.push(`${id}${path}`);
        const ok = req.headers.get('x-host-key') === keyOf(id);
        if (path === '/auth') return ok ? new Response(null, { status: 204 }) : jsonResponse({ error: 'forbidden' }, 403);
        if (path === '/ingest') return ok ? jsonResponse({ ok: true }) : jsonResponse({ error: 'forbidden' }, 403);
        return jsonResponse({ error: `unexpected ${path}` }, 500);
      },
    });
    const pending: Promise<unknown>[] = [];
    const env = {
      ALLOWED_ORIGINS: '*',
      EVENT_ROOM: { idFromName: (id: string) => id, get: (id: string) => room(id) },
      LIVE_BUCKET: { put: async (k: string) => void calls.puts.push(k), delete: async (k: string) => void calls.deletes.push(k) },
    } as unknown as Env;
    const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;
    const upload = async (id: string, key: string | null, seq: number) => {
      const headers: Record<string, string> = { 'content-type': 'video/mp4' };
      if (key != null) headers['x-host-key'] = key;
      const res = await liveWorker.fetch(new Request(`https://w.example/api/events/${id}/segments?seq=${seq}&ms=6000`, { method: 'POST', headers, body: new Uint8Array(10) }), env, ctx);
      await Promise.all(pending.splice(0));
      return res.status;
    };
    const auths = (id: string) => calls.room.filter((p) => p === `${id}/auth`).length;
    return { keys, keyOf, calls, upload, auths };
  }

  it('asks the room once, then one DO request a segment — and the room still checks every segment', async () => {
    const s = passEnv();
    for (let seq = 1; seq <= 600; seq++) expect(await s.upload('ev1', 'key-ev1', seq)).toBe(200);
    expect(s.auths('ev1')).toBe(1);
    expect(s.calls.room.filter((p) => p === 'ev1/ingest')).toHaveLength(600);
    expect(s.calls.puts).toHaveLength(600);
  });

  it('never remembers a refusal: a forged key is asked about every time, never reaches R2, and doesn’t disturb the host', async () => {
    const s = passEnv();
    expect(await s.upload('ev1', 'key-ev1', 1)).toBe(200);
    for (let i = 0; i < 3; i++) expect(await s.upload('ev1', `forged-${i}`, 2)).toBe(403);
    expect(s.auths('ev1')).toBe(1 + 3);
    expect(s.calls.puts).toEqual(['events/ev1/seg/1']);
    expect(s.calls.room.filter((p) => p === 'ev1/ingest')).toHaveLength(1);
    expect(await s.upload('ev1', 'key-ev1', 2)).toBe(200); // the host's pass is untouched
    expect(s.auths('ev1')).toBe(4);
  });

  it('a pass is per event: a key confirmed for one event opens nothing on another', async () => {
    const s = passEnv();
    expect(await s.upload('ev1', 'key-ev1', 1)).toBe(200);
    expect(await s.upload('ev2', 'key-ev1', 1)).toBe(403);
    expect(s.calls.room).toEqual(['ev1/auth', 'ev1/ingest', 'ev2/auth']);
    expect(s.calls.puts).toEqual(['events/ev1/seg/1']);
  });

  it('a key the room stops accepting (a rotation) gets at most one segment into R2 — deleted, never announced — then is refused before R2', async () => {
    const s = passEnv();
    expect(await s.upload('ev1', 'key-ev1', 1)).toBe(200);
    s.keys.set('ev1', 'key-ev1-rotated');
    // This isolate still holds a pass for the old key: the room's /ingest refuses it, the segment is removed.
    expect(await s.upload('ev1', 'key-ev1', 2)).toBe(403);
    expect(s.calls.deletes).toEqual(['events/ev1/seg/2']);
    // The pass is gone: the old key is asked about again, and refused before anything is stored.
    const puts = s.calls.puts.length;
    expect(await s.upload('ev1', 'key-ev1', 3)).toBe(403);
    expect(s.calls.puts).toHaveLength(puts);
    expect(s.calls.room.slice(-1)).toEqual(['ev1/auth']);
    // The new key works, with a pass of its own.
    expect(await s.upload('ev1', 'key-ev1-rotated', 3)).toBe(200);
    expect(await s.upload('ev1', 'key-ev1-rotated', 4)).toBe(200);
    expect(s.calls.room.slice(-3)).toEqual(['ev1/auth', 'ev1/ingest', 'ev1/ingest']);
  });

  it('a pass in use stays; one unused for 10 minutes lapses and the room is asked again', async () => {
    let t = Date.parse('2026-10-23T18:00:00Z');
    vi.spyOn(Date, 'now').mockImplementation(() => t);
    const s = passEnv();
    for (let seq = 1; seq <= 12; seq++) {
      expect(await s.upload('ev1', 'key-ev1', seq)).toBe(200);
      t += 5 * 60_000; // an hour of segments, 5 minutes apart: each /ingest renews the pass
    }
    expect(s.auths('ev1')).toBe(1);
    t += 10 * 60_000;
    expect(await s.upload('ev1', 'key-ev1', 13)).toBe(200);
    expect(s.auths('ev1')).toBe(2);
  });

  it('no key at all: refused without asking any room', async () => {
    const s = passEnv();
    expect(await s.upload('ev1', null, 1)).toBe(403);
    expect(await s.upload('ev1', '', 1)).toBe(403);
    expect(s.calls.room).toEqual([]);
    expect(s.calls.puts).toEqual([]);
  });

  it('keeps at most 512 passes, the least recently confirmed going first', async () => {
    const s = passEnv();
    for (let i = 0; i <= 512; i++) expect(await s.upload(`e${i}`, `key-e${i}`, 1)).toBe(200);
    expect(await s.upload('e512', 'key-e512', 2)).toBe(200);
    expect(s.auths('e512')).toBe(1);
    expect(await s.upload('e0', 'key-e0', 2)).toBe(200); // pushed out by the 513th: asked again
    expect(s.auths('e0')).toBe(2);
  });
});

describe('event creation requires a Stream Studio member', () => {
  const makeEnv = (initCalls: Record<string, unknown>[]) => {
    const roomStub = {
      fetch: async (req: Request): Promise<Response> => {
        const url = new URL(req.url);
        if (url.pathname === '/init') {
          initCalls.push((await req.json()) as Record<string, unknown>);
          return jsonResponse({ hostKey: 'hk-123' });
        }
        return jsonResponse({ error: 'unexpected' }, 500);
      },
    };
    return {
      ALLOWED_ORIGINS: '*',
      SUPABASE_URL: 'https://proj.supabase.co',
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
      EVENT_ROOM: { idFromName: (id: string) => id, get: () => roomStub },
      MONITOR_ROOM: { idFromName: (id: string) => id, get: () => roomStub },
      LIVE_BUCKET: {},
    } as unknown as Env;
  };
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;

  afterEach(() => {
    vi.unstubAllGlobals();
    clearMemberCache();
  });

  it('rejects anonymous creates without touching a room', async () => {
    const init: Record<string, unknown>[] = [];
    const res = await liveWorker.fetch(
      new Request('https://worker.example/api/events', { method: 'POST', body: JSON.stringify({ title: 'x' }) }),
      makeEnv(init),
      ctx,
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe('sign_in_required');
    expect(init).toHaveLength(0);
  });

  it('rejects a signed-in account that never redeemed the welcome code', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ signed_in: true, member: false, needs_code: true }));
    vi.stubGlobal('fetch', fetchMock);
    const init: Record<string, unknown>[] = [];
    const res = await liveWorker.fetch(
      new Request('https://worker.example/api/events', {
        method: 'POST',
        headers: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.not-a-member-token.sig' },
        body: JSON.stringify({ title: 'x' }),
      }),
      makeEnv(init),
      ctx,
    );
    expect(res.status).toBe(401);
    expect(init).toHaveLength(0);
    const [url, opts] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://proj.supabase.co/rest/v1/rpc/live_me');
    expect((opts.headers as Record<string, string>).authorization).toBe('Bearer eyJhbGciOiJIUzI1NiJ9.not-a-member-token.sig');
  });

  it('creates the event for a verified member and records the owner', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ signed_in: true, member: true, user_id: 'u-1', profile: { display_name: 'Akhil' } })));
    const init: Record<string, unknown>[] = [];
    const res = await liveWorker.fetch(
      new Request('https://worker.example/api/events', {
        method: 'POST',
        headers: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.member-token-abc.sig' },
        body: JSON.stringify({ title: 'Launch day' }),
      }),
      makeEnv(init),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; hostKey: string };
    expect(body.hostKey).toBe('hk-123');
    expect(init[0]).toMatchObject({ title: 'Launch day', host: 'Akhil', ownerId: 'u-1' });
  });
});

describe('monitor routes', () => {
  it('refuses malformed nursery ids', async () => {
    const env = { ALLOWED_ORIGINS: '*', MONITOR_ROOM: { idFromName: () => 'x', get: () => ({ fetch: async () => new Response('should not be called', { status: 500 }) }) } } as unknown as Env;
    const ctx = { waitUntil: () => undefined } as unknown as ExecutionContext;
    const res = await liveWorker.fetch(new Request('https://worker.example/api/monitor/not-a-uuid-at-all-but-36-chars-long!/ws'), env, ctx);
    expect(res.status).toBe(404);
  });

  it('only ever returns the VAPID public key', async () => {
    const keyHolder = { fetch: async () => jsonResponse({ publicKey: 'BPUB', privateJwk: { d: 'SECRET' } }) };
    const env = { ALLOWED_ORIGINS: '*', MONITOR_ROOM: { idFromName: () => 'k', get: () => keyHolder } } as unknown as Env;
    const ctx = { waitUntil: () => undefined } as unknown as ExecutionContext;
    const res = await liveWorker.fetch(new Request('https://worker.example/live-api/api/monitor/vapid'), env, ctx);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ publicKey: 'BPUB' });
    expect(text).not.toContain('SECRET');
  });

  it('passes a signed-in guest’s own token (and only the room’s headers) to the share-link join', async () => {
    const seen: Request[] = [];
    const room = { fetch: async (req: Request) => (seen.push(req), jsonResponse({ ok: true })) };
    const env = { ALLOWED_ORIGINS: '*', MONITOR_ROOM: { idFromName: () => 'n', get: () => room } } as unknown as Env;
    const ctx = { waitUntil: () => undefined } as unknown as ExecutionContext;
    const nid = '11111111-2222-4333-8444-555555555555';
    await liveWorker.fetch(
      new Request(`https://worker.example/api/monitor/${nid}/guest`, {
        method: 'POST',
        body: JSON.stringify({ code: 'c', pass: 'p', name: 'Jo' }),
        headers: { authorization: 'Bearer tok-0123456789abcdefghij', cookie: 'x=1', 'cf-connecting-ip': '1.2.3.4' },
      }),
      env,
      ctx,
    );
    expect(seen).toHaveLength(1);
    expect(new URL(seen[0].url).pathname).toBe('/guest');
    expect(seen[0].headers.get('authorization')).toBe('Bearer tok-0123456789abcdefghij');
    expect(seen[0].headers.get('cf-connecting-ip')).toBe('1.2.3.4');
    expect(seen[0].headers.get('cookie')).toBeNull();
  });
});

describe('direct call routes', () => {
  const UID = '11111111-2222-4333-8444-555555555555';
  const setup = () => {
    const hits: { ns: string; name: string; url: string }[] = [];
    const ns = (label: string) => ({
      idFromName: (n: string) => n,
      get: (name: string) => ({
        fetch: async (req: Request) => {
          hits.push({ ns: label, name, url: req.url });
          return jsonResponse({ ok: true });
        },
      }),
    });
    const env = { ALLOWED_ORIGINS: '*', USER_LINE: ns('line'), CALL_ROOM: ns('room') } as unknown as Env;
    const ctx = { waitUntil: () => undefined } as unknown as ExecutionContext;
    const go = (path: string, init?: RequestInit) => liveWorker.fetch(new Request(`https://worker.example${path}`, init), env, ctx);
    return { hits, go };
  };

  it('a member’s line socket goes to the line named after them', async () => {
    const { hits, go } = setup();
    expect((await go(`/live-api/api/calls/u/${UID}/ws`)).status).toBe(200);
    expect(hits).toEqual([{ ns: 'line', name: `u:${UID}`, url: `https://line.internal/ws?uid=${UID}` }]);
  });

  it('a call’s socket goes to its room', async () => {
    const { hits, go } = setup();
    expect((await go('/api/calls/c/0123456789abcdef/ws')).status).toBe(200);
    expect(hits).toEqual([{ ns: 'room', name: '0123456789abcdef', url: 'https://call.internal/ws?id=0123456789abcdef' }]);
  });

  it('never routes the internal endpoints, or anything malformed', async () => {
    const { hits, go } = setup();
    for (const path of [
      `/api/calls/u/${UID}/x/ring`,
      `/api/calls/u/${UID}/x/log`,
      '/api/calls/c/0123456789abcdef/x/init',
      '/api/calls/u/not-a-uuid-but-exactly-36-characters!/ws',
      '/api/calls/u/11111111-2222-4333-8444-55555555555g/ws',
      '/api/calls/c/0123456789ABCDEF/ws',
      '/api/calls/c/0123456789abcde/ws',
      '/api/calls/c/0123456789abcdef/ws/extra',
    ]) {
      const post = path.includes('/x/');
      const res = await go(path, { method: post ? 'POST' : 'GET', body: post ? '{}' : undefined });
      expect(res.status, path).toBe(404);
    }
    expect(hits).toEqual([]);
  });
});

/* ============================================================ ADR 0006 WS-7 */

const NID = '11111111-2222-4333-8444-555555555555';
const ME = '0a0a0a0a-1111-4222-8333-444455556666';
const VIEWER = '0c0c0c0c-1111-4222-8333-444455556666';
const OURS = 'https://stream.dreamstreamstudio.ai';
const ACT_KEY = 'act-token-key-0123456789abcdefghij';

/** A legacy (HS256) Supabase token: verified by asking Supabase (`live_me`), which the stub answers. */
const tokenFor = (sub: string) =>
  `${b64url(new TextEncoder().encode('{"alg":"HS256","typ":"JWT"}'))}.${b64url(new TextEncoder().encode(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 600 })))}.${b64url(new Uint8Array(32))}`;
const subOf = (bearer: string | null) => {
  try {
    return JSON.parse(atob((bearer ?? '').replace(/^Bearer /, '').split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub as string;
  } catch {
    return null;
  }
};

/** Node's Response can't be a 101; the Workers runtime makes one for every upgrade. */
function socketWorld() {
  const closes: [number, string][] = [];
  const Real = Response;
  vi.stubGlobal(
    'Response',
    class extends Real {
      constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: unknown }) {
        super(body, init?.status === 101 ? { ...init, status: 200 } : init);
        if (init?.status === 101) Object.defineProperty(this, 'status', { get: () => 101 });
      }
    },
  );
  class Sock {
    accept() {}
    send() {}
    close(code: number, reason: string) {
      closes.push([code, reason]);
    }
  }
  vi.stubGlobal(
    'WebSocketPair',
    class {
      0 = new Sock();
      1 = new Sock();
    },
  );
  return { closes };
}

/** A rate limiter that counts per key like the binding (limit per period, period never ends here). */
function counter(limit: number) {
  const n = new Map<string, number>();
  const rl: RateLimiterLike = {
    limit: async ({ key }) => {
      const v = (n.get(key) ?? 0) + 1;
      n.set(key, v);
      return { success: v <= limit };
    },
  };
  return { rl, n };
}

/**
 * The live Worker's bindings with rooms that implement the WS-9/WS-10 side of the contracts:
 * glance with an ETag, act idempotent by `id` and role-gated, `/x/kick`, `/x/members`.
 */
function edgeWorld(over: Partial<Env> = {}) {
  const hits: { ns: string; name: string; path: string; headers: Headers; body: string }[] = [];
  const roleOf: Record<string, 'parent' | 'viewer'> = { [ME]: 'parent', [VIEWER]: 'viewer' };
  let q = 7;
  const acts = new Map<string, unknown>();
  const done: string[] = [];
  const sockets = new Map<string, string[]>([[NID, [ME, VIEWER]], [`u:${ME}`, [ME]]]);
  const ns = (label: string) => ({
    idFromName: (n: string) => n,
    get: (name: string) => ({
      fetch: async (req: Request) => {
        const url = new URL(req.url);
        const body = req.method === 'GET' ? '' : await req.text();
        hits.push({ ns: label, name, path: url.pathname, headers: req.headers, body });
        const who = req.headers.get('authorization')?.startsWith('DS-Act ') ? ME : subOf(req.headers.get('authorization'));
        switch (url.pathname) {
          case '/ws':
          case '/guest':
            return new Response('room answered', { status: 200 });
          case '/glance': {
            if (!who || !roleOf[who]) return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
            const etag = `"${q}.${roleOf[who] === 'parent' ? 127 : 20}"`;
            if (req.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: { etag } });
            return Response.json({ g: { v: 1, n: NID, q } }, { headers: { etag } });
          }
          case '/act': {
            const a = JSON.parse(body) as { a: string; id: string };
            if (!who || roleOf[who] !== 'parent') return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
            if (acts.has(a.id)) return Response.json({ ...(acts.get(a.id) as object), dup: true });
            done.push(a.a);
            q += 1;
            const answer = { ok: true, g: { v: 1, n: NID, q } };
            acts.set(a.id, answer);
            return Response.json(answer);
          }
          case '/peek':
            return Response.json({ ok: false, error: 'not_yet' }, { status: 501 });
          case '/x/kick':
          case '/x/members': {
            const b = JSON.parse(body) as { uid?: string; removed?: string[] };
            const out = url.pathname === '/x/kick' ? [b.uid] : (b.removed ?? []);
            const open = sockets.get(name) ?? [];
            sockets.set(name, open.filter((u) => !out.includes(u)));
            return Response.json({ closed: open.length - (sockets.get(name) ?? []).length, turn: [] });
          }
        }
        return Response.json({ error: 'not found' }, { status: 404 });
      },
    }),
  });
  const env = {
    ALLOWED_ORIGINS: 'https://dreamstreamstudio.ai,https://stream.dreamstreamstudio.ai,https://comic2.pages.dev',
    SUPABASE_URL: 'https://proj.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
    ACT_TOKEN_KEY: ACT_KEY,
    MONITOR_ROOM: ns('monitor'),
    USER_LINE: ns('line'),
    CALL_ROOM: ns('call'),
    EVENT_ROOM: ns('event'),
    LIVE_BUCKET: {},
    ...over,
  } as unknown as Env;
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;
  const go = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) => liveWorker.fetch(new Request(`${OURS}${path}`, init), env, ctx);
  return { env, hits, go, done, sockets, roomHits: (path: string) => hits.filter((h) => h.path === path) };
}

/** Supabase for the account routes: every token's owner is a member; the parent may change members. */
function stubSupabase() {
  const rpcs: { fn: string; sub: string | null; args: Record<string, unknown> }[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const fn = String(input).match(/\/rpc\/(\w+)$/)?.[1] ?? '';
    const sub = subOf((init?.headers as Record<string, string>)?.authorization ?? null);
    const args = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    rpcs.push({ fn, sub, args });
    if (fn === 'live_me') return Response.json({ signed_in: true, member: true, user_id: sub });
    if (fn === 'monitor_list') return Response.json({ ok: true, nurseries: [{ id: NID }] });
    if (fn === 'monitor_remove_member') return Response.json(sub === ME ? { ok: true, removed: [args.p_user], changed: [args.p_user] } : { ok: false, error: 'forbidden' });
    return Response.json({}, { status: 404 });
  });
  return rpcs;
}

describe('WS-7 routing: glance, act and peek go to the nursery’s room', () => {
  beforeEach(() => {
    resetActKeyCache();
    resetJwksCache();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('GET /glance: 200 with an ETag, then 304 when unchanged — only the caller’s credentials and the proof path reach the room', async () => {
    const w = edgeWorld();
    const auth = `Bearer ${tokenFor(ME)}`;
    const first = await w.go(`/live-api/api/monitor/${NID}/glance?v=1`, { headers: { authorization: auth, cookie: 'sb=secret', 'ds-proof': 'v1.proof', 'x-ds-path': '/forged' } });
    expect(first.status).toBe(200);
    const etag = first.headers.get('etag')!;
    expect(etag).toBe('"7.127"');
    expect(first.headers.get('cache-control')).toBe('private, no-cache');
    expect(await first.json()).toEqual({ g: { v: 1, n: NID, q: 7 } });
    const h = w.roomHits('/glance')[0].headers;
    expect(h.get('authorization')).toBe(auth);
    expect(h.get('ds-proof')).toBe('v1.proof');
    // The path a DS-Proof signs, as routed (no /live-api) — set by the Worker, never by the client.
    expect(h.get('x-ds-path')).toBe(`/api/monitor/${NID}/glance?v=1`);
    expect(h.get('cookie')).toBeNull();
    const again = await w.go(`/api/monitor/${NID}/glance`, { headers: { authorization: auth, 'if-none-match': etag } });
    expect(again.status).toBe(304);
    expect(again.headers.get('etag')).toBe(etag);
    expect(await again.text()).toBe('');
  });

  it('a role change is never hidden behind a 304 (the ETag carries what this caller may do)', async () => {
    const w = edgeWorld();
    const parent = await w.go(`/api/monitor/${NID}/glance`, { headers: { authorization: `Bearer ${tokenFor(ME)}` } });
    const viewer = await w.go(`/api/monitor/${NID}/glance`, { headers: { authorization: `Bearer ${tokenFor(VIEWER)}`, 'if-none-match': parent.headers.get('etag')! } });
    expect(viewer.status).toBe(200);
  });

  it('no credentials: refused without waking the room', async () => {
    const w = edgeWorld();
    expect((await w.go(`/api/monitor/${NID}/glance`)).status).toBe(401);
    expect((await w.go(`/api/monitor/${NID}/peek`)).status).toBe(401);
    expect((await w.go(`/api/monitor/${NID}/act`, { method: 'POST', body: JSON.stringify({ a: 'ack', id: crypto.randomUUID() }) })).status).toBe(401);
    expect(w.hits).toEqual([]);
  });

  it('POST /act with the same id twice acts once; the second answer is the first, marked dup', async () => {
    const w = edgeWorld();
    const id = crypto.randomUUID();
    const body = JSON.stringify({ a: 'ack', inc: 'inc_42', id });
    const auth = { authorization: `Bearer ${tokenFor(ME)}`, 'content-type': 'application/json' };
    const one = (await (await w.go(`/api/monitor/${NID}/act`, { method: 'POST', body, headers: auth })).json()) as Record<string, unknown>;
    const two = (await (await w.go(`/api/monitor/${NID}/act`, { method: 'POST', body, headers: auth })).json()) as Record<string, unknown>;
    expect(one).toEqual({ ok: true, g: { v: 1, n: NID, q: 8 } });
    expect(two).toEqual({ ...one, dup: true });
    expect(w.done).toEqual(['ack']);
    // The room got the exact bytes the client signed (a DS-Proof covers them).
    expect(w.roomHits('/act').map((x) => x.body)).toEqual([body, body]);
  });

  it('role-gated in the room: a viewer can’t act; junk never reaches it', async () => {
    const w = edgeWorld();
    const viewer = await w.go(`/api/monitor/${NID}/act`, { method: 'POST', body: JSON.stringify({ a: 'soothe', id: crypto.randomUUID() }), headers: { authorization: `Bearer ${tokenFor(VIEWER)}` } });
    expect([viewer.status, await viewer.json()]).toEqual([403, { ok: false, error: 'forbidden' }]);
    const before = w.hits.length;
    for (const body of ['{', JSON.stringify({ a: 'ack' }), JSON.stringify({ a: 'dance', id: crypto.randomUUID() }), JSON.stringify({ a: 'resolve', id: crypto.randomUUID() })]) {
      const res = await w.go(`/api/monitor/${NID}/act`, { method: 'POST', body, headers: { authorization: `Bearer ${tokenFor(ME)}` } });
      expect(res.status, body).toBe(400);
    }
    expect((await w.go(`/api/monitor/${NID}/act`, { method: 'POST', body: 'x'.repeat(3000), headers: { authorization: `Bearer ${tokenFor(ME)}` } })).status).toBe(413);
    expect(w.hits.length).toBe(before);
  });

  it('“I’m on it” from a notification: a valid DS-Act token reaches the room; a forged, misdirected or overreaching one doesn’t', async () => {
    const w = edgeWorld();
    const t = await mintActToken({ ACT_TOKEN_KEY: ACT_KEY }, { nid: NID, inc: 'inc_42', uid: ME });
    const send = (token: string, body: Record<string, unknown>) =>
      w.go(`/api/monitor/${NID}/act`, { method: 'POST', body: JSON.stringify({ id: crypto.randomUUID(), ...body }), headers: { authorization: `DS-Act ${token}` } });
    expect((await send(t!.token, { a: 'ack', inc: 'inc_42' })).status).toBe(200);
    expect(w.roomHits('/act')[0].headers.get('authorization')).toBe(`DS-Act ${t!.token}`);
    expect((await send(t!.token, { a: 'soothe', inc: 'inc_42' })).status).toBe(403); // it only ever acknowledges
    expect((await send(t!.token, { a: 'ack' })).status).toBe(403); // and only its own incident
    expect((await send(t!.token, { a: 'ack', inc: 'inc_43' })).status).toBe(401);
    const forged = await mintActToken({ ACT_TOKEN_KEY: 'another-key-0123456789abcdefghijk' }, { nid: NID, inc: 'inc_42', uid: ME });
    expect((await send(forged!.token, { a: 'ack', inc: 'inc_42' })).status).toBe(401);
    expect(w.roomHits('/act')).toHaveLength(1);
  });

  it('before the room serves these (WS-9), a watch hears “not available yet”, never “nursery gone”', async () => {
    const w = edgeWorld();
    const auth = { authorization: `Bearer ${tokenFor(ME)}` };
    const peek = await w.go(`/api/monitor/${NID}/peek`, { headers: auth });
    expect([peek.status, await peek.json()]).toEqual([501, { ok: false, error: 'not_yet' }]); // the room's own answer passes through
    const old = edgeWorld({
      MONITOR_ROOM: { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json({ error: 'not found' }, { status: 404 }) }) },
    } as unknown as Partial<Env>);
    const glance = await old.go(`/api/monitor/${NID}/glance`, { headers: auth });
    expect([glance.status, await glance.json()]).toEqual([501, { ok: false, error: 'not_enabled' }]);
  });

  it('wrong methods and malformed nursery ids are refused at the edge', async () => {
    const w = edgeWorld();
    expect((await w.go(`/api/monitor/${NID}/glance`, { method: 'POST', body: '{}' })).status).toBe(405);
    expect((await w.go(`/api/monitor/${NID}/act`)).status).toBe(405);
    expect((await w.go(`/api/monitor/${NID}/members`)).status).toBe(405);
    expect((await w.go(`/api/monitor/${NID}/export`, { method: 'POST', body: '{}' })).status).toBe(405);
    expect((await w.go('/api/monitor/vapid/glance')).status).toBe(404);
    expect((await w.go(`/api/monitor/${NID.slice(0, -1)}g/glance`)).status).toBe(404);
    expect((await w.go('/api/monitor/------------------------------------/glance')).status).toBe(404);
    expect(w.hits).toEqual([]);
  });
});

describe('WS-7 routing: the account routes and the internal ones', () => {
  beforeEach(() => resetJwksCache());
  afterEach(() => vi.unstubAllGlobals());

  it('sign out everywhere through the router: every room and the line close the caller’s sockets', async () => {
    stubSupabase();
    const w = edgeWorld();
    const res = await w.go('/live-api/api/me/kick', { method: 'POST', body: '{}', headers: { authorization: `Bearer ${tokenFor(ME)}`, Origin: OURS } });
    expect(await res.json()).toEqual({ ok: true, rooms: 1, closed: 2, unconfirmed: 0 });
    expect(res.headers.get('access-control-allow-origin')).toBe(OURS);
    expect(w.sockets.get(NID)).toEqual([VIEWER]);
    expect(w.sockets.get(`u:${ME}`)).toEqual([]);
  });

  it('removing a member through the router: Supabase, then the room closes their sockets', async () => {
    const rpcs = stubSupabase();
    const w = edgeWorld();
    const res = await w.go(`/api/monitor/${NID}/members`, { method: 'POST', body: JSON.stringify({ op: 'remove', user: VIEWER }), headers: { authorization: `Bearer ${tokenFor(ME)}` } });
    expect(await res.json()).toEqual({ ok: true, changed: [VIEWER], removed: [VIEWER], told: true });
    expect(rpcs.find((r) => r.fn === 'monitor_remove_member')).toMatchObject({ sub: ME, args: { p_nursery: NID, p_user: VIEWER } });
    expect(w.sockets.get(NID)).toEqual([ME]);
    expect(w.roomHits('/x/members')[0].body).toContain(`"removed":["${VIEWER}"]`);
  });

  it('devices are dormant without their key; ops answer only to the ops key and never to a browser', async () => {
    const w = edgeWorld();
    const enroll = await w.go('/api/devices/enroll', { method: 'POST', body: '{}', headers: { authorization: `Bearer ${tokenFor(ME)}` } });
    expect([enroll.status, await enroll.json()]).toEqual([501, { ok: false, error: 'not_enabled' }]);
    expect((await w.go(`/api/devices/${ME}`, { method: 'DELETE' })).status).toBe(401);
    const probe = await w.go('/api/ops/apns-probe', { method: 'POST', headers: { Origin: OURS } });
    expect(probe.status).toBe(403);
    expect(probe.headers.get('access-control-allow-origin')).toBeNull();
    expect((await w.go('/api/ops/anything', { method: 'POST' })).status).toBe(404);
  });

  it('the rooms’ /x/ endpoints are never routed from outside — only the signed notify, which refuses unsigned calls', async () => {
    const w = edgeWorld();
    for (const path of ['/x/kick', `/x/members`, `/x/user/${ME}/kick`, '/x/push-reg', `/api/monitor/${NID}/x/kick`, `/live-api/x/user/${ME}/notify/extra`]) {
      const res = await w.go(path, { method: 'POST', body: JSON.stringify({ uid: ME }) });
      expect(res.status, path).toBe(404);
    }
    expect((await w.go(`/live-api/x/user/${ME}/notify`, { method: 'POST', body: JSON.stringify({ p: '{}' }) })).status).toBe(403);
    expect(w.hits).toEqual([]);
  });
});

describe('WS-7 edge gates: Origin allowlist and rate limits on sockets', () => {
  beforeEach(() => resetEdgeState());
  afterEach(() => vi.unstubAllGlobals());

  const upgrade = (origin?: string, ip = '203.0.113.9') => ({ headers: { Upgrade: 'websocket', 'cf-connecting-ip': ip, ...(origin ? { Origin: origin } : {}) } });

  it('sockets from our sites, the API’s own origin and native apps (no Origin) reach the room; another site’s don’t', async () => {
    socketWorld();
    const w = edgeWorld();
    for (const o of ['https://dreamstreamstudio.ai', OURS, undefined]) expect((await w.go(`/api/monitor/${NID}/ws`, upgrade(o))).status).toBe(200);
    for (const path of [`/api/monitor/${NID}/ws`, `/api/calls/u/${ME}/ws`, '/api/calls/c/0123456789abcdef/ws', '/api/events/abc123/ws']) {
      const res = await w.go(path, upgrade('https://evil.example'));
      expect([path, res.status]).toEqual([path, 403]);
    }
    expect(w.hits.map((h) => h.path)).toEqual(['/ws', '/ws', '/ws']);
  });

  it('too many upgrades from one address: refused with close code 4008 before any room is woken', async () => {
    const { closes } = socketWorld();
    const keys: string[] = [];
    const w = edgeWorld({ RL_WS: { limit: async ({ key }) => (keys.push(key), { success: false }) } });
    for (const path of [`/api/monitor/${NID}/ws`, `/api/calls/u/${ME}/ws`, '/api/calls/c/0123456789abcdef/ws']) {
      expect((await w.go(path, upgrade(OURS))).status).toBe(101);
    }
    expect(closes).toEqual([
      [4008, 'rate_limited'],
      [4008, 'rate_limited'],
      [4008, 'rate_limited'],
    ]);
    expect(keys).toEqual(['edge:4:203.0.113.9', 'edge:4:203.0.113.9', 'edge:4:203.0.113.9']);
    expect(w.hits).toEqual([]);
    // A Stream Studio audience behind one venue address is never cut off by it.
    expect((await w.go('/api/events/abc123/ws', upgrade(OURS))).status).toBe(200);
  });

  it('50 unauthenticated sockets from one address don’t stop a member connecting from theirs', async () => {
    socketWorld();
    const c = counter(60);
    const w = edgeWorld({ RL_WS: c.rl });
    // The flood: 70 upgrades from one IPv6 subscriber, rotating through its /64.
    const flood: number[] = [];
    for (let i = 0; i < 70; i++) flood.push((await w.go(`/api/monitor/${NID}/ws`, upgrade(undefined, `2001:db8:5:6::${(i + 1).toString(16)}`))).status);
    expect(flood.filter((s) => s === 200)).toHaveLength(60);
    expect(flood.filter((s) => s === 101)).toHaveLength(10); // refused, 4008
    // The family's phone, on its own address, still gets through to the room (which keeps
    // unauthenticated sockets out of the members' slots — ADR 0006 WS-9).
    expect((await w.go(`/api/monitor/${NID}/ws`, upgrade(OURS, '198.51.100.20'))).status).toBe(200);
    expect(c.n.get('edge:4:198.51.100.20')).toBe(1);
  });

  it('share-link joins: per address and per nursery, answered in the app’s own words, the room never woken', async () => {
    for (const which of ['RL_GUEST', 'RL_GUEST_NID'] as const) {
      const keys: string[] = [];
      const no: RateLimiterLike = { limit: async ({ key }) => (keys.push(key), { success: false }) };
      const yes: RateLimiterLike = { limit: async ({ key }) => (keys.push(key), { success: true }) };
      const w = edgeWorld({ RL_GUEST: which === 'RL_GUEST' ? no : yes, RL_GUEST_NID: which === 'RL_GUEST_NID' ? no : yes });
      const res = await w.go(`/api/monitor/${NID}/guest`, { method: 'POST', body: '{}', headers: { 'cf-connecting-ip': '203.0.113.9' } });
      expect(res.status).toBe(429);
      expect(res.headers.get('retry-after')).toBe('60');
      expect(await res.json()).toMatchObject({ ok: false, reason: 'slow_down', left: null });
      expect(keys.sort()).toEqual(['edge:ip:4:203.0.113.9', `edge:n:${NID}`]);
      expect(w.hits).toEqual([]);
    }
    // Under the limits (or with no binding at all), the room answers as before.
    const open = edgeWorld();
    expect((await open.go(`/api/monitor/${NID}/guest`, { method: 'POST', body: '{}' })).status).toBe(200);
  });

  it('creating events is braked per account', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ signed_in: true, member: true, user_id: ME, profile: { display_name: 'Akhil' } }));
    clearMemberCache();
    const keys: string[] = [];
    const w = edgeWorld({ RL_EVENT: { limit: async ({ key }) => (keys.push(key), { success: false }) } });
    const res = await w.go('/api/events', { method: 'POST', body: '{}', headers: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.event-host-token.sig' } });
    expect(res.status).toBe(429);
    expect(keys).toEqual([`edge:ev:${ME}`]);
    expect(w.hits).toEqual([]);
    clearMemberCache();
  });
});
