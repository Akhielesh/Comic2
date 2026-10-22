// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLOUD_COPY_LIMIT_BYTES,
  CLOUD_COPY_WINDOW_MS,
  freesAt,
  markerBytes,
  markerKey,
} from './cloudCopyQuota';
import liveWorker, { type Env } from './index';
import { clearMemberCache } from './supabaseAuth';

const GB = 1024 ** 3;
const UID = '11111111-2222-4333-8444-555555555555';
const NOW = Date.UTC(2026, 9, 22, 12);
const DAY = 24 * 60 * 60_000;

const jsonResponse = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

/** Just enough R2 for the quota ledger and the multipart init. */
function fakeBucket(seed: { key: string; uploaded: number }[] = []) {
  const objects = new Map(seed.map((o) => [o.key, o.uploaded]));
  const calls = { lists: 0, puts: [] as string[], deletes: [] as string[], multipart: 0, listFails: false };
  const bucket = {
    list: async ({ prefix }: { prefix: string }) => {
      calls.lists += 1;
      if (calls.listFails) throw new Error('r2 down');
      return {
        objects: [...objects].filter(([k]) => k.startsWith(prefix)).map(([key, uploaded]) => ({ key, uploaded: new Date(uploaded) })),
        truncated: false,
      };
    },
    put: async (key: string) => {
      calls.puts.push(key);
      objects.set(key, NOW);
    },
    delete: async (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) {
        calls.deletes.push(k);
        objects.delete(k);
      }
    },
    createMultipartUpload: async () => {
      calls.multipart += 1;
      return { uploadId: 'up-1' };
    },
  };
  return { bucket, calls, objects };
}

function setup(seed: { key: string; uploaded: number }[] = [], hostKey = 'hk') {
  const r2 = fakeBucket(seed);
  const room = {
    fetch: async (req: Request) => {
      const path = new URL(req.url).pathname;
      if (path === '/auth') return new Response(null, { status: req.headers.get('x-host-key') === hostKey ? 204 : 403 });
      return jsonResponse({ error: `unexpected ${path}` }, 500);
    },
  };
  const env = {
    ALLOWED_ORIGINS: '*',
    SUPABASE_URL: 'https://proj.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
    EVENT_ROOM: { idFromName: (id: string) => id, get: () => room },
    LIVE_BUCKET: r2.bucket,
  } as unknown as Env;
  const waits: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;
  const supabase = vi.fn(async () => jsonResponse({ signed_in: true, member: true, user_id: UID, profile: { display_name: 'Ada' } }));
  vi.stubGlobal('fetch', supabase);
  const init = (body: Record<string, unknown>, headers: Record<string, string> = { authorization: 'Bearer member-token-0123456789', 'x-host-key': hostKey }) =>
    liveWorker.fetch(
      new Request('https://worker.example/api/events/abc123/recordings?op=init', { method: 'POST', headers, body: JSON.stringify(body) }),
      env,
      ctx,
    );
  const quota = (headers: Record<string, string> = { authorization: 'Bearer member-token-0123456789' }) =>
    liveWorker.fetch(new Request(`https://worker.example/api/events/abc123/recordings?op=quota&k=${hostKey}`, { headers }), env, ctx);
  return { r2, init, quota, supabase, waits };
}

const marker = (eventId: string, bytes: number, ageMs: number) => ({ key: markerKey(UID, eventId, bytes), uploaded: NOW - ageMs });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  clearMemberCache();
});

describe('cloud copy quota — ledger helpers', () => {
  it('keys a marker by account, event and size, and reads the size back', () => {
    const k = markerKey(UID, 'abc123', 3 * GB);
    expect(k).toBe(`quota/rec/${UID}/abc123-${3 * GB}`);
    expect(markerBytes(k)).toBe(3 * GB);
    expect(markerBytes(`quota/rec/${UID}/garbage`)).toBeNull();
  });

  it('says when enough old copies expire for a new one to fit, or never', () => {
    const ms = [
      { key: 'a', bytes: 4 * GB, at: NOW - 6 * DAY },
      { key: 'b', bytes: 5 * GB, at: NOW - 2 * DAY },
    ];
    // 9 GB used + 3 GB wanted: the 4 GB copy from 6 days ago has to go first.
    expect(freesAt(ms, 9 * GB, 3 * GB, NOW)).toBe(NOW - 6 * DAY + CLOUD_COPY_WINDOW_MS);
    expect(freesAt(ms, 9 * GB, 1 * GB, NOW)).toBe(NOW);
    expect(freesAt(ms, 9 * GB, 11 * GB, NOW)).toBeNull();
  });
});

describe('POST recordings?op=init — 10 GB of 7-day copies per account', () => {
  it('starts the upload and counts it when it fits', async () => {
    const { r2, init } = setup([marker('old1', 2 * GB, 3 * DAY)]);
    const res = await init({ file: 'show.webm', mime: 'video/webm', bytes: 3 * GB });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { key: string; uploadId: string; quota: Record<string, unknown> };
    expect(body.uploadId).toBe('up-1');
    expect(body.quota).toEqual({ usedBytes: 5 * GB, limitBytes: CLOUD_COPY_LIMIT_BYTES, copies: 2, nextFreeAt: NOW - 3 * DAY + CLOUD_COPY_WINDOW_MS });
    expect(r2.calls.puts).toEqual([markerKey(UID, 'abc123', 3 * GB)]);
    expect(r2.calls.multipart).toBe(1);
    expect(JSON.stringify(body.quota)).not.toContain(UID);
  });

  it('refuses honestly when the allowance is full — nothing stored, nothing started', async () => {
    const { r2, init } = setup([marker('old1', 4 * GB, 6 * DAY), marker('old2', 5 * GB, 1 * DAY)]);
    const res = await init({ file: 'show.webm', mime: 'video/webm', bytes: 3 * GB });
    expect(res.status).toBe(413);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ error: 'cloud_copy_full', usedBytes: 9 * GB, limitBytes: CLOUD_COPY_LIMIT_BYTES, wantedBytes: 3 * GB, freesAt: NOW - 6 * DAY + CLOUD_COPY_WINDOW_MS });
    expect(String(body.message)).toMatch(/Your 10 GB of 7-day copies is full \(9\.0 GB used; this recording is 3\.0 GB\)/);
    expect(String(body.message)).toMatch(/Google Drive \(free, yours to keep\)/);
    expect(r2.calls.multipart).toBe(0);
    expect(r2.calls.puts).toEqual([]);
  });

  it('a retry of the same recording never counts twice', async () => {
    const { r2, init } = setup([marker('abc123', 3 * GB, 60_000), marker('old', 6 * GB, DAY)]);
    const res = await init({ file: 'show.webm', bytes: 3 * GB });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { quota: { usedBytes: number } }).quota.usedBytes).toBe(9 * GB);
    expect(r2.calls.multipart).toBe(1);
  });

  it('copies older than 7 days stop counting and their markers are cleaned up', async () => {
    const { r2, init, waits } = setup([marker('gone', 9 * GB, 7 * DAY + 1), marker('kept', 1 * GB, DAY)]);
    const res = await init({ file: 'show.webm', bytes: 5 * GB });
    expect(res.status).toBe(200);
    await Promise.all(waits);
    expect(r2.calls.deletes).toEqual([markerKey(UID, 'gone', 9 * GB)]);
  });

  it('a recording bigger than the whole allowance is pointed to Drive or the device', async () => {
    const { r2, init } = setup();
    const res = await init({ file: 'marathon.webm', bytes: 11 * GB });
    expect(res.status).toBe(413);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('cloud_copy_too_big');
    expect(String(body.message)).toMatch(/bigger than the 10 GB allowance/);
    expect(r2.calls.lists + r2.calls.multipart).toBe(0);
  });

  it('needs the host’s own sign-in (no token → no R2 work)', async () => {
    const { r2, init, supabase } = setup();
    const res = await init({ file: 'show.webm', bytes: GB }, { 'x-host-key': 'hk' });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe('sign_in_required');
    expect(supabase).not.toHaveBeenCalled();
    expect(r2.calls.lists + r2.calls.multipart).toBe(0);
  });

  it('needs the size (old app builds are told to reload)', async () => {
    const { r2, init } = setup();
    const res = await init({ file: 'show.webm' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('bad_size');
    expect(r2.calls.multipart).toBe(0);
  });

  it('the host-key gate still runs first', async () => {
    const { r2, init, supabase } = setup();
    const res = await init({ file: 'show.webm', bytes: GB }, { authorization: 'Bearer member-token-0123456789', 'x-host-key': 'nope' });
    expect(res.status).toBe(403);
    expect(supabase).not.toHaveBeenCalled();
    expect(r2.calls.lists).toBe(0);
  });

  it('fails closed (and says so) when the ledger can’t be read', async () => {
    const { r2, init } = setup();
    r2.calls.listFails = true;
    const res = await init({ file: 'show.webm', bytes: GB });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe('quota_unavailable');
    expect(r2.calls.multipart).toBe(0);
  });
});

describe('GET recordings?op=quota', () => {
  it('returns the caller’s own numbers only', async () => {
    const { quota } = setup([marker('a', 2 * GB, 2 * DAY), marker('b', GB, DAY)]);
    const res = await quota();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ usedBytes: 3 * GB, limitBytes: CLOUD_COPY_LIMIT_BYTES, copies: 2, nextFreeAt: NOW - 2 * DAY + CLOUD_COPY_WINDOW_MS });
    expect(text).not.toContain(UID);
    expect(text).not.toContain('quota/rec');
  });

  it('is sign-in gated', async () => {
    const { quota } = setup();
    expect((await quota({})).status).toBe(401);
  });
});
