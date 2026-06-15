// Short-TTL caches for `read_url`, to stop the agent burning time on reads that can't
// succeed. The motivating failure: a flight query produced "Couldn't read etihad.com ×5"
// + "Couldn't read expedia.com" — every one of those re-paid the 9s fetch timeout (~45s
// wasted) on hosts that hard-block automated reads. With a host-block negative cache, the
// FIRST failed read of a host marks it; subsequent reads of ANY page on that host
// fast-fail instantly. A small positive cache also avoids re-fetching a page already read.
//
// In-process, bounded, TTL'd — no external store. Safe to share across turns: a host that
// blocks us now will still block us a minute from now, and a page read seconds ago is
// still fresh. Both are best-effort and self-heal after the TTL.

const HOST_BLOCK_TTL_MS = 120_000; // a host that hard-blocked reads stays skipped 2 min
const PAGE_TTL_MS = 300_000; // a successfully-read page is reused for 5 min
const MAX_ENTRIES = 256; // hard cap per map so memory can't grow unbounded

const blockedHosts = new Map<string, number>(); // host → expiry (ms epoch)
const pageCache = new Map<string, { text: string; expiry: number }>(); // url → {text, expiry}

const prune = (map: Map<string, unknown>): void => {
  if (map.size <= MAX_ENTRIES) return;
  // Map preserves insertion order — evict the oldest until back under the cap.
  for (const key of map.keys()) {
    if (map.size <= MAX_ENTRIES) break;
    map.delete(key);
  }
};

/** True if `host` recently hard-blocked an automated read (skip it, don't re-fetch). */
export const isHostBlocked = (host: string): boolean => {
  if (!host) return false;
  const expiry = blockedHosts.get(host);
  if (expiry === undefined) return false;
  if (expiry < Date.now()) {
    blockedHosts.delete(host);
    return false;
  }
  return true;
};

/** Record that `host` blocked us (fetch error / anti-bot) so the next read fast-fails. */
export const markHostBlocked = (host: string): void => {
  if (!host) return;
  blockedHosts.set(host, Date.now() + HOST_BLOCK_TTL_MS);
  prune(blockedHosts);
};

/** Cached readable text for a URL read recently, or null. */
export const getCachedPage = (url: string): string | null => {
  if (!url) return null;
  const hit = pageCache.get(url);
  if (!hit) return null;
  if (hit.expiry < Date.now()) {
    pageCache.delete(url);
    return null;
  }
  return hit.text;
};

/** Cache a successfully-read page's text. */
export const setCachedPage = (url: string, text: string): void => {
  if (!url || !text) return;
  pageCache.set(url, { text, expiry: Date.now() + PAGE_TTL_MS });
  prune(pageCache);
};

/** Test helper — clear all cached state. */
export const __resetReadCache = (): void => {
  blockedHosts.clear();
  pageCache.clear();
};
