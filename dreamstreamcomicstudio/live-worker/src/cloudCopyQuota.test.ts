// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLOUD_COPY_LIMIT_BYTES,
  CLOUD_COPY_PART_BYTES,
  CLOUD_COPY_WINDOW_MS,
  copyObjectKey,
  freesAt,
  markerBytes,
  markerKey,
  parseMarker,
  partAllowance,
  reservedBytesOf,
} from './cloudCopyQuota';
import liveWorker, { type Env } from './index';
import { clearMemberCache } from './supabaseAuth';

const GB = 1024 ** 3;
const MiB = 1024 ** 2;
const PART = CLOUD_COPY_PART_BYTES;
const UID = '11111111-2222-4333-8444-555555555555';
const NOW = Date.UTC(2026, 9, 22, 12);
const DAY = 24 * 60 * 60_000;

const jsonResponse = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

const NO_SUCH_UPLOAD = () => new Error('The specified multipart upload does not exist. (10024)');

/**
 * Just enough R2 for the quota ledger and multipart uploads, with R2's rules that matter
 * here: an uploadId belongs to one key, an aborted or finished upload is gone, and the
 * finished object's size is the sum of its parts.
 */
type Seed = { key: string; uploaded: number; meta?: Record<string, string>; size?: number };
function fakeBucket(seed: Seed[] = []) {
  const objects = new Map(seed.map((o) => [o.key, { uploaded: o.uploaded, meta: o.meta, size: o.size ?? 0 }]));
  const uploads = new Map<string, { key: string; parts: Map<number, number>; state: 'open' | 'done' | 'aborted' }>();
  const calls = { lists: 0, heads: 0, puts: [] as string[], deletes: [] as string[], multipart: 0, aborts: [] as string[], listFails: false };
  let seq = 0;
  const handle = (key: string, uploadId: string) => {
    const live = () => {
      const u = uploads.get(uploadId);
      if (!u || u.key !== key || u.state !== 'open') throw NO_SUCH_UPLOAD();
      return u;
    };
    return {
      key,
      uploadId,
      uploadPart: async (n: number, body: ArrayBuffer) => {
        live().parts.set(n, body.byteLength);
        return { partNumber: n, etag: `etag-${n}` };
      },
      complete: async (parts: { partNumber: number }[]) => {
        const u = live();
        const size = parts.reduce((s, p) => s + (u.parts.get(p.partNumber) ?? 0), 0);
        u.state = 'done';
        objects.set(key, { uploaded: Date.now(), meta: undefined, size });
        return { key, size };
      },
      abort: async () => {
        live().state = 'aborted';
        calls.aborts.push(uploadId);
      },
    };
  };
  const bucket = {
    list: async ({ prefix }: { prefix: string }) => {
      calls.lists += 1;
      if (calls.listFails) throw new Error('r2 down');
      return {
        objects: [...objects]
          .filter(([k]) => k.startsWith(prefix))
          .map(([key, o]) => ({ key, uploaded: new Date(o.uploaded), customMetadata: o.meta })),
        truncated: false,
      };
    },
    head: async (key: string) => {
      calls.heads += 1;
      const o = objects.get(key);
      return o ? { key, size: o.size } : null;
    },
    put: async (key: string, _v: unknown, opts?: { customMetadata?: Record<string, string> }) => {
      calls.puts.push(key);
      objects.set(key, { uploaded: Date.now(), meta: opts?.customMetadata, size: 0 });
    },
    delete: async (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) {
        calls.deletes.push(k);
        objects.delete(k);
      }
    },
    createMultipartUpload: async (key: string) => {
      calls.multipart += 1;
      const uploadId = `up-${++seq}`;
      uploads.set(uploadId, { key, parts: new Map(), state: 'open' });
      return handle(key, uploadId);
    },
    resumeMultipartUpload: (key: string, uploadId: string) => handle(key, uploadId),
  };
  return { bucket, calls, objects, uploads };
}

function setup(seed: Seed[] = [], hostKey = 'hk') {
  const r2 = fakeBucket(seed);
  const registered: Record<string, unknown>[] = [];
  const room = {
    fetch: async (req: Request) => {
      const path = new URL(req.url).pathname;
      if (path === '/auth') return new Response(null, { status: req.headers.get('x-host-key') === hostKey ? 204 : 403 });
      if (path === '/rec/register') {
        registered.push((await req.json()) as Record<string, unknown>);
        return jsonResponse({ ok: true });
      }
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
  const auth = { authorization: 'Bearer member-token-0123456789', 'x-host-key': hostKey };
  const base = 'https://worker.example/api/events/abc123/recordings';
  const call = (url: string, init: RequestInit) => liveWorker.fetch(new Request(url, init), env, ctx);
  const init = (body: Record<string, unknown>, headers: Record<string, string> = auth) =>
    call(`${base}?op=init`, { method: 'POST', headers, body: JSON.stringify(body) });
  const quota = (headers: Record<string, string> = { authorization: auth.authorization }, bytes?: number) =>
    call(`${base}?op=quota&k=${hostKey}${bytes != null ? `&bytes=${bytes}` : ''}`, { headers });
  const part = (key: string, uploadId: string, n: number, size: number) =>
    call(`${base}?op=part&key=${encodeURIComponent(key)}&uploadId=${encodeURIComponent(uploadId)}&n=${n}`, {
      method: 'PUT',
      headers: { 'x-host-key': hostKey },
      body: new Uint8Array(size),
    });
  const complete = (key: string, uploadId: string, parts: { partNumber: number; etag: string }[], bytes = 0) =>
    call(`${base}?op=complete`, {
      method: 'POST',
      headers: { 'x-host-key': hostKey, 'content-type': 'application/json' },
      body: JSON.stringify({ key, uploadId, parts, file: 'show.webm', bytes, mime: 'video/webm', durMs: 1000 }),
    });
  /** The whole app flow: init, every part at the server's part size, complete. */
  const uploadAll = async (bytes: number, declared = bytes) => {
    const res = await init({ file: 'show.webm', mime: 'video/webm', bytes: declared });
    if (res.status !== 200) return { res, key: '', uploadId: '' };
    const { key, uploadId, partBytes } = (await res.json()) as { key: string; uploadId: string; partBytes: number };
    const parts: { partNumber: number; etag: string }[] = [];
    for (let n = 1; (n - 1) * partBytes < bytes; n++) {
      const p = await part(key, uploadId, n, Math.min(partBytes, bytes - (n - 1) * partBytes));
      expect(p.status).toBe(200);
      parts.push((await p.json()) as { partNumber: number; etag: string });
    }
    return { res: await complete(key, uploadId, parts, declared), key, uploadId };
  };
  return { r2, init, quota, part, complete, uploadAll, supabase, waits, registered };
}

/** A copy counted in the ledger (`finished` → its object exists). */
const counted = (eventId: string, bytes: number, ageMs: number, opts: { finished?: boolean; uploadId?: string } = {}): Seed[] => {
  const started = NOW - ageMs;
  const obj = copyObjectKey(eventId, started, bytes, 'show.webm');
  const marker: Seed = { key: markerKey(UID, eventId, started, bytes), uploaded: started, meta: { obj, up: opts.uploadId ?? `old-${eventId}-${started}` } };
  return opts.finished === false ? [marker] : [marker, { key: obj, uploaded: started, size: bytes }];
};

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
  it('keys a marker by account, event, start and size, and reads them back', () => {
    const k = markerKey(UID, 'abc123', NOW, 3 * GB);
    expect(k).toBe(`quota/rec/${UID}/abc123-${NOW}-${3 * GB}`);
    expect(parseMarker(k)).toEqual({ eventId: 'abc123', startedAt: NOW, bytes: 3 * GB });
    expect(markerBytes(k)).toBe(3 * GB);
    // Markers written before the start time was kept still read.
    expect(parseMarker(`quota/rec/${UID}/abc123-${GB}`)).toEqual({ eventId: 'abc123', startedAt: null, bytes: GB });
    expect(markerBytes(`quota/rec/${UID}/garbage`)).toBeNull();
  });

  it('the copy’s own key carries its reservation, and only this server’s keys read', () => {
    const key = copyObjectKey('abc123', NOW, 20 * MiB, 'my show!.webm');
    expect(key).toBe(`events/abc123/rec/${NOW}-${20 * MiB}/my_show_.webm`);
    expect(reservedBytesOf('abc123', key)).toBe(20 * MiB);
    expect(reservedBytesOf('other1', key)).toBeNull(); // another event's copy
    expect(reservedBytesOf('abc123', `events/abc123/rec/${NOW}-show.webm`)).toBeNull(); // pre-quota key
    expect(reservedBytesOf('abc123', `events/abc123/rec/${NOW}-${11 * GB}/x.webm`)).toBeNull(); // past the allowance
  });

  it('parts can never add up to more than the reservation', () => {
    const reserved = 2 * PART + 5;
    expect([1, 2, 3, 4].map((n) => partAllowance(reserved, n))).toEqual([PART, PART, 5, 0]);
    expect(partAllowance(1, 1)).toBe(1);
    expect(partAllowance(1, 2)).toBe(0);
    expect(partAllowance(GB, 0)).toBe(0);
    expect(partAllowance(GB, 1.5)).toBe(0);
  });

  it('says when enough old copies expire for a new one to fit, or never', () => {
    const ms = [
      { bytes: 4 * GB, at: NOW - 6 * DAY },
      { bytes: 5 * GB, at: NOW - 2 * DAY },
    ];
    // 9 GB used + 3 GB wanted: the 4 GB copy from 6 days ago has to go first.
    expect(freesAt(ms, 9 * GB, 3 * GB, NOW)).toBe(NOW - 6 * DAY + CLOUD_COPY_WINDOW_MS);
    expect(freesAt(ms, 9 * GB, 1 * GB, NOW)).toBe(NOW);
    expect(freesAt(ms, 9 * GB, 11 * GB, NOW)).toBeNull();
  });
});

describe('POST recordings?op=init — 10 GB of 7-day copies per account', () => {
  it('starts the upload, counts it, and tells the app the part size', async () => {
    const { r2, init } = setup(counted('old1', 2 * GB, 3 * DAY));
    const res = await init({ file: 'show.webm', mime: 'video/webm', bytes: 3 * GB });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { key: string; uploadId: string; partBytes: number; quota: Record<string, unknown> };
    expect(body.uploadId).toBe('up-1');
    expect(body.partBytes).toBe(PART);
    expect(reservedBytesOf('abc123', body.key)).toBe(3 * GB);
    expect(body.quota).toEqual({ usedBytes: 5 * GB, limitBytes: CLOUD_COPY_LIMIT_BYTES, copies: 2, nextFreeAt: NOW - 3 * DAY + CLOUD_COPY_WINDOW_MS, retryBytes: 0 });
    expect(r2.calls.puts).toEqual([markerKey(UID, 'abc123', NOW, 3 * GB)]);
    expect(r2.objects.get(markerKey(UID, 'abc123', NOW, 3 * GB))?.meta).toEqual({ obj: body.key, up: 'up-1' });
    expect(r2.calls.multipart).toBe(1);
    expect(JSON.stringify(body.quota)).not.toContain(UID);
  });

  it('refuses honestly when the allowance is full — nothing stored, nothing started', async () => {
    const { r2, init } = setup([...counted('old1', 4 * GB, 6 * DAY), ...counted('old2', 5 * GB, 1 * DAY)]);
    const res = await init({ file: 'show.webm', mime: 'video/webm', bytes: 3 * GB });
    expect(res.status).toBe(413);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ error: 'cloud_copy_full', usedBytes: 9 * GB, limitBytes: CLOUD_COPY_LIMIT_BYTES, wantedBytes: 3 * GB, freesAt: NOW - 6 * DAY + CLOUD_COPY_WINDOW_MS });
    expect(String(body.message)).toMatch(/Your 10 GB of 7-day copies is full \(9\.0 GB used; this recording is 3\.0 GB\)/);
    expect(String(body.message)).toMatch(/Google Drive \(free, yours to keep\)/);
    expect(r2.calls.multipart).toBe(0);
    expect(r2.calls.puts).toEqual([]);
  });

  it('a retry of an unfinished upload never counts twice — and the abandoned try can’t be finished later', async () => {
    const { r2, init, part, waits } = setup([...counted('abc123', 3 * GB, 60_000, { finished: false, uploadId: 'up-old' }), ...counted('old', 6 * GB, DAY)]);
    const oldKey = copyObjectKey('abc123', NOW - 60_000, 3 * GB, 'show.webm');
    r2.uploads.set('up-old', { key: oldKey, parts: new Map([[1, PART]]), state: 'open' });
    const res = await init({ file: 'show.webm', bytes: 3 * GB });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { quota: { usedBytes: number } }).quota.usedBytes).toBe(9 * GB);
    await Promise.all(waits);
    expect(r2.calls.aborts).toEqual(['up-old']);
    expect(r2.calls.deletes).toContain(markerKey(UID, 'abc123', NOW - 60_000, 3 * GB));
    expect((await part(oldKey, 'up-old', 2, PART)).status).toBe(500); // R2: no such upload
  });

  it('two finished copies of the same recording both count (each is stored)', async () => {
    const { uploadAll, quota } = setup();
    const size = 20 * MiB;
    expect((await uploadAll(size)).res.status).toBe(200);
    vi.setSystemTime(NOW + 60_000);
    expect((await uploadAll(size)).res.status).toBe(200);
    expect(((await (await quota()).json()) as { usedBytes: number; copies: number })).toMatchObject({ usedBytes: 2 * size, copies: 2 });
  });

  it('a replaced try that finished in the meantime keeps counting', async () => {
    const { r2, init, waits } = setup(counted('abc123', 3 * GB, 60_000, { finished: false, uploadId: 'up-old' }));
    const oldKey = copyObjectKey('abc123', NOW - 60_000, 3 * GB, 'show.webm');
    // It has no object when the new try starts; it finishes before the abort lands.
    r2.uploads.set('up-old', { key: oldKey, parts: new Map(), state: 'done' });
    const head = r2.bucket.head;
    let first = true;
    r2.bucket.head = async (key: string) => {
      if (key === oldKey && first) {
        first = false;
        return null;
      }
      return key === oldKey ? { key, size: 3 * GB } : head(key);
    };
    expect((await init({ file: 'show.webm', bytes: 3 * GB })).status).toBe(200);
    await Promise.all(waits);
    expect(r2.calls.deletes).not.toContain(markerKey(UID, 'abc123', NOW - 60_000, 3 * GB));
  });

  it('copies older than 7 days stop counting and their markers are cleaned up', async () => {
    const { r2, init, waits } = setup([...counted('gone', 9 * GB, 7 * DAY + 1, { finished: false }), ...counted('kept', 1 * GB, DAY)]);
    const res = await init({ file: 'show.webm', bytes: 5 * GB });
    expect(res.status).toBe(200);
    await Promise.all(waits);
    expect(r2.calls.deletes).toEqual([markerKey(UID, 'gone', NOW - 7 * DAY - 1, 9 * GB)]);
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

  it('a token Supabase rejects is “sign in again”', async () => {
    const { r2, init, supabase } = setup();
    supabase.mockImplementation(async () => jsonResponse({ message: 'JWT expired' }, 401));
    const res = await init({ file: 'show.webm', bytes: GB });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe('sign_in_required');
    expect(r2.calls.multipart).toBe(0);
  });

  it('a Supabase outage is “try again in a moment”, never “sign in again”', async () => {
    for (const fail of [() => jsonResponse({}, 503), () => jsonResponse({}, 500), () => Promise.reject(new TypeError('fetch failed'))]) {
      clearMemberCache();
      const { r2, init, quota, supabase } = setup();
      supabase.mockImplementation(async () => fail());
      for (const res of [await init({ file: 'show.webm', bytes: GB }), await quota()]) {
        expect(res.status).toBe(503);
        const body = (await res.json()) as { error: string; message: string };
        expect(body.error).toBe('quota_unavailable');
        expect(body.message).toMatch(/try again in a moment/);
        expect(body.message).not.toMatch(/sign in again/i);
      }
      expect(r2.calls.lists + r2.calls.multipart).toBe(0);
    }
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

  it('fails closed when the ledger is longer than one check reads', async () => {
    const { r2, init } = setup();
    r2.bucket.list = async () => ({ objects: [], truncated: true, cursor: 'more' }) as never;
    const res = await init({ file: 'show.webm', bytes: GB });
    expect(res.status).toBe(503);
    expect(r2.calls.multipart).toBe(0);
  });
});

describe('server truth: parts and the finished object are held to the reservation', () => {
  it('a client that declares 1 byte can’t upload more than 1 byte', async () => {
    const { init, part, r2 } = setup();
    const res = await init({ file: 'show.webm', bytes: 1 });
    const { key, uploadId } = (await res.json()) as { key: string; uploadId: string };
    expect((await part(key, uploadId, 1, MiB)).status).toBe(413);
    expect((await part(key, uploadId, 2, 1)).status).toBe(413);
    expect((await part(key, uploadId, 1, 1)).status).toBe(200);
    expect([...r2.uploads.get(uploadId)!.parts.values()]).toEqual([1]);
  });

  it('parts past the reservation are refused — before their body is read', async () => {
    const { init, part } = setup();
    const res = await init({ file: 'show.webm', bytes: 20 * MiB });
    const { key, uploadId } = (await res.json()) as { key: string; uploadId: string };
    expect((await part(key, uploadId, 1, PART + 1)).status).toBe(413); // bigger than a part
    expect((await part(key, uploadId, 2, 4 * MiB + 1)).status).toBe(413); // past the end
    expect((await part(key, uploadId, 3, 1)).status).toBe(413); // a part that can't exist
    expect((await part(key, uploadId, 10_000, 1)).status).toBe(413);
  });

  it('a key from before the quota (no reservation in it) can’t take parts or finish', async () => {
    const { part, complete, r2 } = setup();
    const legacy = `events/abc123/rec/${NOW}-show.webm`;
    r2.uploads.set('up-legacy', { key: legacy, parts: new Map(), state: 'open' });
    const p = await part(legacy, 'up-legacy', 1, MiB);
    expect(p.status).toBe(409);
    expect(((await p.json()) as { error: string }).error).toBe('upload_outdated');
    expect((await complete(legacy, 'up-legacy', [])).status).toBe(409);
  });

  it('what gets registered is R2’s real size, not what the app says', async () => {
    const { uploadAll, registered } = setup();
    const { res, key } = await uploadAll(20 * MiB);
    expect(res.status).toBe(200);
    expect(registered).toEqual([expect.objectContaining({ key, bytes: 20 * MiB })]);
  });

  it('an object that came out bigger than its reservation is deleted, not kept', async () => {
    const { init, complete, r2, registered } = setup();
    const res = await init({ file: 'show.webm', bytes: 20 * MiB });
    const { key, uploadId } = (await res.json()) as { key: string; uploadId: string };
    // Parts that got in some other way (the part route can't produce this).
    r2.uploads.get(uploadId)!.parts.set(1, PART).set(2, PART);
    const done = await complete(key, uploadId, [{ partNumber: 1, etag: 'e1' }, { partNumber: 2, etag: 'e2' }]);
    expect(done.status).toBe(413);
    expect(((await done.json()) as { error: string }).error).toBe('cloud_copy_mismatch');
    expect(r2.objects.has(key)).toBe(false);
    expect(registered).toEqual([]);
  });

  it('finishing an upload a newer try replaced says so honestly', async () => {
    const { complete } = setup();
    const res = await complete(copyObjectKey('abc123', NOW, MiB, 'show.webm'), 'up-gone', []);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { message: string }).message).toMatch(/start it again/);
  });
});

describe('GET recordings?op=quota', () => {
  it('returns the caller’s own numbers only', async () => {
    const { quota } = setup([...counted('a', 2 * GB, 2 * DAY), ...counted('b', GB, DAY)]);
    const res = await quota();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ usedBytes: 3 * GB, limitBytes: CLOUD_COPY_LIMIT_BYTES, copies: 2, nextFreeAt: NOW - 2 * DAY + CLOUD_COPY_WINDOW_MS, retryBytes: 0 });
    expect(text).not.toContain(UID);
    expect(text).not.toContain('quota/rec');
    expect(text).not.toContain('events/');
  });

  it('with the recording’s size, says what its unfinished earlier try holds (a retry replaces it)', async () => {
    // 6 GB of other copies + an unfinished 3 GB try of this recording: the retry fits (6 + 3 ≤ 10).
    const { quota } = setup([...counted('abc123', 3 * GB, 60_000, { finished: false }), ...counted('old', 6 * GB, DAY)]);
    expect((await (await quota(undefined, 3 * GB)).json()) as Record<string, number>).toMatchObject({ usedBytes: 9 * GB, retryBytes: 3 * GB });
    // A finished copy of it is a real object: a second copy counts on top.
    const done = setup([...counted('abc123', 3 * GB, 60_000), ...counted('old', 6 * GB, DAY)]);
    expect((await (await done.quota(undefined, 3 * GB)).json()) as Record<string, number>).toMatchObject({ usedBytes: 9 * GB, retryBytes: 0 });
  });

  it('is sign-in gated', async () => {
    const { quota } = setup();
    expect((await quota({})).status).toBe(401);
  });
});
