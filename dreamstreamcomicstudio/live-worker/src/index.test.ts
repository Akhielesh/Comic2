import { afterEach, describe, expect, it, vi } from 'vitest';
import liveWorker, { type Env } from './index';
import { clearMemberCache } from './supabaseAuth';

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
