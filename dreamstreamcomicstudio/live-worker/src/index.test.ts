import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import liveWorker, { resetHostPasses, type Env } from './index';
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
