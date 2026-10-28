// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import { KEY_HOLDER } from '../monitorRoom';
import { primeVapidCache, resetVapidCache, VAPID_CACHE_TTL_MS, VAPID_KEY_HOLDER, vapidCacheStats, vapidKeysFor, type KeyHolderNamespace } from './vapidCache';

const KEYS = { publicKey: 'BPUBLICKEY', privateJwk: { kty: 'EC', crv: 'P-256', d: 'd', x: 'x', y: 'y' } };

/** A fake MONITOR_ROOM namespace whose key holder answers with `answer()`; counts requests per name. */
function holder(answer: () => Promise<Response> | Response) {
  const asked: string[] = [];
  const ns: KeyHolderNamespace = {
    idFromName: (name: string) => ({ name, toString: () => name, equals: () => false }) as unknown as DurableObjectId,
    get: (id: DurableObjectId) => ({
      fetch: async (req: Request) => {
        asked.push(`${(id as unknown as { name: string }).name} ${new URL(req.url).pathname}`);
        return answer();
      },
    }),
  };
  return { ns, asked };
}

describe('vapidCache', () => {
  beforeEach(() => resetVapidCache());

  it('names the same key holder as MonitorRoom', () => {
    expect(VAPID_KEY_HOLDER).toBe(KEY_HOLDER);
  });

  it('asks the key holder once per isolate, however many rooms ask', async () => {
    const { ns, asked } = holder(() => Response.json(KEYS));
    const rooms = await Promise.all(Array.from({ length: 20 }, () => vapidKeysFor(ns, 1_000)));
    expect(rooms.every((k) => k?.publicKey === 'BPUBLICKEY')).toBe(true);
    // Later wakes of other rooms in the same isolate: still no request.
    expect((await vapidKeysFor(ns, 1_000 + 3600_000))?.publicKey).toBe('BPUBLICKEY');
    expect(asked).toEqual(['__vapid_keys__ /vapid']);
    expect(vapidCacheStats()).toMatchObject({ fetches: 1, failures: 0 });
  });

  it('never caches a failure: the next alert asks again', async () => {
    let up = false;
    const { ns, asked } = holder(() => (up ? Response.json(KEYS) : new Response('down', { status: 503 })));
    expect(await vapidKeysFor(ns, 1_000)).toBeNull();
    up = true;
    expect((await vapidKeysFor(ns, 1_001))?.publicKey).toBe('BPUBLICKEY');
    expect(asked).toHaveLength(2);
  });

  it('does not cache an error body as keys, or a throw', async () => {
    const bad = holder(() => Response.json({ error: 'nope' }));
    expect(await vapidKeysFor(bad.ns, 1)).toBeNull();
    const boom = holder(() => {
      throw new Error('isolate reset');
    });
    expect(await vapidKeysFor(boom.ns, 2)).toBeNull();
    expect(vapidCacheStats().failures).toBe(2);
  });

  it('re-reads after the TTL, and keeps the old pair if that read fails', async () => {
    let up = true;
    const { ns, asked } = holder(() => (up ? Response.json(KEYS) : new Response('', { status: 500 })));
    await vapidKeysFor(ns, 0);
    up = false;
    expect((await vapidKeysFor(ns, VAPID_CACHE_TTL_MS + 1))?.publicKey).toBe('BPUBLICKEY');
    expect(asked).toHaveLength(2);
  });

  it('can be primed by the key holder itself', async () => {
    primeVapidCache(KEYS, 5);
    const { ns, asked } = holder(() => Response.json(KEYS));
    expect((await vapidKeysFor(ns, 6))?.publicKey).toBe('BPUBLICKEY');
    expect(asked).toHaveLength(0);
  });
});
