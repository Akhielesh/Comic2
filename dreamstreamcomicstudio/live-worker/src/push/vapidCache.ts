/**
 * The VAPID key pair, cached per isolate (ADR 0006 Phase 0, WS-3).
 *
 * The keys live in one Durable Object (`KEY_HOLDER`, monitorRoom.ts) and never leave
 * it except to the rooms that sign Web Push with them (D9 #10: existing browser
 * subscriptions are bound to that public key, so it is never exported or rotated).
 * Until now every MonitorRoom and UserLine asked the key holder once per object wake
 * — a billed DO request each time, and one more hop before the first alert of the
 * night. This module keeps the answer at module scope, so every room in an isolate
 * shares one copy and only a cold isolate asks again.
 *
 * Safety: a failed fetch is never cached. The next alert asks again (and concurrent
 * callers share one in-flight request), so a blip at the key holder can't silence
 * pushes for longer than the blip itself. Push still degrades to in-app alerts, as before.
 */
import type { VapidKeys } from '../webpush';

/** The key holder's name in the MONITOR_ROOM namespace (same string as monitorRoom.ts `KEY_HOLDER`). */
export const VAPID_KEY_HOLDER = '__vapid_keys__';

/** Re-read at most this often even when warm. The keys don't change; this only bounds a stale isolate. */
export const VAPID_CACHE_TTL_MS = 12 * 3600_000;

/** The slice of a DurableObjectNamespace this needs (tests pass a fake). */
export interface KeyHolderNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): { fetch(req: Request): Promise<Response> };
}

let cached: { keys: VapidKeys; at: number } | null = null;
let inflight: Promise<VapidKeys | null> | null = null;
const stats = { fetches: 0, hits: 0, failures: 0 };

/**
 * A minimal shape check on the key holder's answer: a public key, and a private JWK
 * object when one is present. It only stops an error body from being cached as keys.
 */
export function isVapidKeys(v: unknown): v is VapidKeys {
  if (!v || typeof v !== 'object') return false;
  const k = v as Partial<VapidKeys>;
  return typeof k.publicKey === 'string' && k.publicKey.length > 0 && (k.privateJwk === undefined || (typeof k.privateJwk === 'object' && k.privateJwk !== null));
}

/**
 * The VAPID keys, from this isolate's cache or the key holder. `null` when the key
 * holder can't be reached (callers fall back to in-app alerts and ask again next time).
 */
export async function vapidKeysFor(ns: KeyHolderNamespace, now = Date.now()): Promise<VapidKeys | null> {
  if (cached && now - cached.at < VAPID_CACHE_TTL_MS) {
    stats.hits++;
    return cached.keys;
  }
  if (inflight) return inflight;
  inflight = (async () => {
    stats.fetches++;
    try {
      const res = await ns.get(ns.idFromName(VAPID_KEY_HOLDER)).fetch(new Request('https://monitor.internal/vapid'));
      if (!res.ok) throw new Error(`key holder ${res.status}`);
      const keys = await res.json();
      if (!isVapidKeys(keys)) throw new Error('key holder sent no keys');
      cached = { keys, at: now };
      return keys;
    } catch {
      stats.failures++;
      // A stale copy beats none: the pair never changes, so keep pushing with it.
      return cached?.keys ?? null;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** The key holder itself (which reads its own storage) can seed the cache for rooms sharing its isolate. */
export function primeVapidCache(keys: VapidKeys, now = Date.now()): void {
  if (isVapidKeys(keys)) cached = { keys, at: now };
}

/** Tests only. */
export function resetVapidCache(): void {
  cached = null;
  inflight = null;
  stats.fetches = 0;
  stats.hits = 0;
  stats.failures = 0;
}

/** Tests and diagnostics: how often this isolate asked the key holder. */
export function vapidCacheStats(): Readonly<typeof stats> {
  return { ...stats };
}
