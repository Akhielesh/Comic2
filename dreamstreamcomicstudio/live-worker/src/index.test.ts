import { describe, expect, it } from 'vitest';
import liveWorker, { type Env } from './index';

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
