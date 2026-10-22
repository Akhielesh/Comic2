// Page image cache for the reader (reader.md §9.1): fetch → blob → object URL → decode, so a page that
// turns into view paints instantly (no white flash mid-flip) and the ambient palette comes for free.
//
// - Keyed by STORAGE PATH (variant-aware: a 1080w variant and the original are separate entries), never
//   by signed URL, so a re-signed link (relink after expiry) never re-downloads a cached page.
// - Priorities: the current view loads `now`, its neighbours `next`, a few pages ahead `idle` (skipped
//   on Save-Data / 2G). At most 3 downloads run at once, highest priority first.
// - LRU of 10 entries; retained paths (current ±2 views) and paths a mounted page is showing (acquired)
//   are never evicted — evicting a page still on screen would blank it. Eviction revokes the object
//   URL and closes any bitmap.
// - An abort (a preload the reader moved past) only drops a job that hasn't started; a job a mounted page
//   joined is adopted (its abort signal is dropped), so a page never waits on a cancelled preload.
// - A 400/403 means the signed link expired: the entry reports `expired` so the host can relink.
// - CORS/network failure falls back to the plain URL in an <img> (no palette), never a broken page.
// - Any other failure (5xx, 404, an undecodable file) retries a bounded number of times with a growing
//   delay (`retryIn`), so a flaky connection heals by itself and the page can say so honestly.

import { useEffect, useSyncExternalStore } from 'react';
import type { AssetRef } from '../../../shared/comic/doc';
import { paletteFromBlob, type Palette } from './ambient';

export type CachePriority = 'now' | 'next' | 'idle';
export type CacheState = 'loading' | 'ready' | 'error';

export interface CachedPage {
  path: string;
  /** Object URL of the decoded blob (or the plain URL when CORS blocked the fetch). */
  objectUrl: string;
  bitmap?: ImageBitmap;
  w: number;
  h: number;
  palette?: Palette | null;
  state: CacheState;
  /** The signed URL expired (HTTP 400/403): ask the host for a fresh link. */
  expired?: boolean;
  /** CORS fallback: objectUrl is the remote URL itself. */
  direct?: boolean;
  /** URL this entry was loaded from (a different URL after an error retries). */
  url: string;
  /** Failed loads of this URL so far (transient-error retries). */
  attempts?: number;
  /** When the last load failed (ms epoch). */
  failedAt?: number;
}

export interface CacheDeps {
  fetch(url: string, init: RequestInit & { priority?: 'high' | 'low' | 'auto' }): Promise<Response>;
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  /** Decode an image URL; resolves its natural size. */
  decode(url: string): Promise<{ w: number; h: number }>;
  palette(blob: Blob): Promise<Palette | null>;
  /** Run low-priority work when the main thread is idle. */
  idle(fn: () => void): void;
}

const RANK: Record<CachePriority, number> = { now: 0, next: 1, idle: 2 };
/** Delay before retry n (after failure n); the length caps the attempts (1 load + 2 retries). */
export const RETRY_DELAYS_MS = [2000, 6000] as const;
/** After the automatic retries, a fresh request (the reader reopened) may try again this much later. */
export const GIVE_UP_RESET_MS = 15_000;

const defaultDecode = (url: string): Promise<{ w: number; h: number }> =>
  new Promise((resolve, reject) => {
    if (typeof Image === 'undefined') {
      resolve({ w: 0, h: 0 });
      return;
    }
    const img = new Image();
    img.decoding = 'async';
    const done = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => reject(new Error('decode failed'));
    img.src = url;
    if (typeof img.decode === 'function') img.decode().then(done, () => (img.complete && img.naturalWidth ? done() : (img.onload = done)));
    else img.onload = done;
  });

export const defaultCacheDeps = (): CacheDeps => ({
  fetch: (url, init) => fetch(url, init as RequestInit),
  createObjectURL: (b) => URL.createObjectURL(b),
  revokeObjectURL: (u) => {
    try {
      URL.revokeObjectURL(u);
    } catch {
      /* already revoked */
    }
  },
  decode: defaultDecode,
  palette: paletteFromBlob,
  idle: (fn) => {
    const w = typeof window !== 'undefined' ? (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }) : undefined;
    if (w?.requestIdleCallback) w.requestIdleCallback(fn, { timeout: 1500 });
    else setTimeout(fn, 60);
  }
});

interface Job {
  path: string;
  url: string;
  prio: CachePriority;
  signal?: AbortSignal;
  resolve: (p: CachedPage) => void;
}

export class PageImageCache {
  private entries = new Map<string, CachedPage>();
  private pending = new Map<string, Promise<CachedPage>>();
  private queue: Job[] = [];
  private running = 0;
  private retained = new Set<string>();
  /** Paths a mounted page is showing (ref counts): never evicted while held. */
  private inUse = new Map<string, number>();
  private listeners = new Set<() => void>();
  private lru: string[] = [];
  private version = 0;

  constructor(
    private deps: CacheDeps = defaultCacheDeps(),
    private maxEntries = 10,
    private concurrency = 3,
    private retryDelaysMs: readonly number[] = RETRY_DELAYS_MS
  ) {}

  get(path: string): CachedPage | undefined {
    return this.entries.get(path);
  }

  /** Monotonic counter for useSyncExternalStore. */
  snapshot(): number {
    return this.version;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  retain(paths: string[]): void {
    this.retained = new Set(paths.filter(Boolean));
    this.evict();
  }

  /** A mounted page shows `path`: keep it cached until the returned release runs. */
  acquire(path: string): () => void {
    this.inUse.set(path, (this.inUse.get(path) ?? 0) + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const n = (this.inUse.get(path) ?? 1) - 1;
      if (n > 0) this.inUse.set(path, n);
      else this.inUse.delete(path);
    };
  }

  /**
   * Milliseconds until a failed entry may load again (0 = now), or null when it won't retry on its own:
   * not failed, an expired link (only a fresh URL helps — the host relinks), or out of attempts.
   */
  retryIn(path: string, at: number = Date.now()): number | null {
    const e = this.entries.get(path);
    if (!e || e.state !== 'error' || e.expired) return null;
    const n = e.attempts ?? 1;
    if (n > this.retryDelaysMs.length) return null;
    return Math.max(0, (e.failedAt ?? 0) + this.retryDelaysMs[n - 1] - at);
  }

  /** Held by a mounted page (tests, diagnostics). */
  inUseCount(path: string): number {
    return this.inUse.get(path) ?? 0;
  }

  ensure(path: string, url: string, prio: CachePriority, signal?: AbortSignal): Promise<CachedPage> {
    const existing = this.entries.get(path);
    if (existing && existing.state === 'ready') {
      this.touch(path);
      return Promise.resolve(existing);
    }
    // The same link failed: try again only once its retry delay has passed (never for an expired link).
    // A page out of automatic retries loads again when it is asked for afresh (the reader reopened).
    const retry = existing && existing.state === 'error' && existing.url === url;
    const gaveUp = retry && !existing!.expired && Date.now() - (existing!.failedAt ?? 0) >= GIVE_UP_RESET_MS;
    if (retry && !gaveUp && this.retryIn(path) !== 0) return Promise.resolve(existing);
    const inflight = this.pending.get(path);
    if (inflight) {
      // Upgrade a queued job's priority (a page we were idly preloading is now on screen), and adopt it:
      // a caller without an abort signal needs the image, so the preload's abort no longer applies.
      const job = this.queue.find((j) => j.path === path);
      if (job && RANK[prio] < RANK[job.prio]) job.prio = prio;
      if (job && !signal) job.signal = undefined;
      return inflight;
    }
    const entry: CachedPage = { path, url, objectUrl: '', w: 0, h: 0, state: 'loading', ...(retry && !gaveUp ? { attempts: existing!.attempts } : {}) };
    this.entries.set(path, entry);
    this.touch(path);
    const promise = new Promise<CachedPage>((resolve) => {
      this.queue.push({ path, url, prio, signal, resolve });
    });
    this.pending.set(path, promise);
    this.emit();
    this.pump();
    return promise;
  }

  clear(): void {
    for (const e of this.entries.values()) this.release(e);
    this.entries.clear();
    this.pending.clear();
    this.queue = [];
    this.lru = [];
    this.emit();
  }

  private emit() {
    this.version += 1;
    for (const fn of [...this.listeners]) fn();
  }

  private touch(path: string) {
    this.lru = this.lru.filter((p) => p !== path);
    this.lru.push(path);
  }

  private release(e: CachedPage) {
    if (e.objectUrl && !e.direct) this.deps.revokeObjectURL(e.objectUrl);
    try {
      e.bitmap?.close();
    } catch {
      /* closed */
    }
  }

  private evict() {
    if (this.entries.size <= this.maxEntries) return;
    for (const path of [...this.lru]) {
      if (this.entries.size <= this.maxEntries) break;
      const e = this.entries.get(path);
      if (!e || e.state === 'loading' || this.retained.has(path) || this.inUse.has(path)) continue;
      this.release(e);
      this.entries.delete(path);
      this.lru = this.lru.filter((p) => p !== path);
    }
    this.emit();
  }

  private pump() {
    while (this.running < this.concurrency && this.queue.length) {
      this.queue.sort((a, b) => RANK[a.prio] - RANK[b.prio]);
      const job = this.queue.shift()!;
      if (job.signal?.aborted) {
        this.entries.delete(job.path);
        this.pending.delete(job.path);
        job.resolve({ path: job.path, url: job.url, objectUrl: '', w: 0, h: 0, state: 'error' });
        this.emit();
        continue;
      }
      this.running += 1;
      void this.run(job).finally(() => {
        this.running -= 1;
        this.pump();
      });
    }
  }

  private finish(job: Job, patch: Partial<CachedPage>) {
    const cur = this.entries.get(job.path);
    const failed = patch.state === 'error' ? { attempts: (cur?.attempts ?? 0) + 1, failedAt: Date.now() } : { attempts: undefined, failedAt: undefined };
    const entry: CachedPage = { ...(cur ?? { path: job.path, url: job.url, objectUrl: '', w: 0, h: 0, state: 'loading' }), ...patch, ...failed, url: job.url };
    this.entries.set(job.path, entry);
    this.pending.delete(job.path);
    job.resolve(entry);
    this.emit();
    if (entry.state === 'ready') this.evict();
    return entry;
  }

  private async run(job: Job): Promise<void> {
    let res: Response;
    try {
      // No abort signal on a started download: a page that joins it later must still get its image
      // (only queued jobs are dropped on abort, in pump()).
      res = await this.deps.fetch(job.url, {
        mode: 'cors',
        credentials: 'omit',
        priority: job.prio === 'idle' ? 'low' : 'high'
      });
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') {
        this.entries.delete(job.path);
        this.pending.delete(job.path);
        job.resolve({ path: job.path, url: job.url, objectUrl: '', w: 0, h: 0, state: 'error' });
        this.emit();
        return;
      }
      // CORS or network: let a plain <img> try the URL (no palette).
      let size = { w: 0, h: 0 };
      try {
        size = await this.deps.decode(job.url);
      } catch {
        /* the <img> will show its own error and trigger a relink */
      }
      this.finish(job, { state: 'ready', direct: true, objectUrl: job.url, ...size });
      return;
    }
    if (!res.ok) {
      this.finish(job, { state: 'error', expired: res.status === 400 || res.status === 403 });
      return;
    }
    try {
      const blob = await res.blob();
      const objectUrl = this.deps.createObjectURL(blob);
      let size = { w: 0, h: 0 };
      try {
        size = await this.deps.decode(objectUrl);
      } catch {
        this.deps.revokeObjectURL(objectUrl);
        this.finish(job, { state: 'error' });
        return;
      }
      this.finish(job, { state: 'ready', objectUrl, ...size });
      this.deps.idle(() => {
        void this.deps.palette(blob).then((palette) => {
          const e = this.entries.get(job.path);
          if (!e || e.objectUrl !== objectUrl) return;
          this.entries.set(job.path, { ...e, palette });
          this.emit();
        });
      });
    } catch {
      this.finish(job, { state: 'error' });
    }
  }
}

/** The shared reader cache. */
export const pageImageCache = new PageImageCache();

// ── Variants ─────────────────────────────────────────────────────────────────

export interface VariantPick {
  path: string;
  /** Width of the chosen variant (undefined = the original). */
  w?: number;
}

/**
 * The smallest stored variant at least `cssWidth × min(dpr, 2)` wide, else the original. Under
 * Save-Data the reader at fit is capped at the 1080w variant; `original` (guided zoom > 1.6) always
 * takes the full image.
 */
export const pickVariant = (asset: AssetRef, cssWidth: number, opts: { dpr?: number; saveData?: boolean; original?: boolean } = {}): VariantPick => {
  const variants = (asset.variants || []).filter((v) => v && v.path && v.w > 0).sort((a, b) => a.w - b.w);
  if (opts.original || !variants.length || !(cssWidth > 0)) return { path: asset.path };
  const target = cssWidth * Math.min(Math.max(1, opts.dpr ?? 1), 2);
  const pick = variants.find((v) => v.w >= (opts.saveData ? Math.min(target, 1080) : target));
  if (pick && (!asset.w || pick.w < asset.w)) return { path: pick.path, w: pick.w };
  if (opts.saveData) {
    const capped = [...variants].reverse().find((v) => v.w <= 1080);
    if (capped) return { path: capped.path, w: capped.w };
  }
  return { path: asset.path };
};

/** Network hints (Save-Data, slow connections) — preloads stay polite. */
export const connectionHints = (): { saveData: boolean; slow: boolean } => {
  try {
    const c = (typeof navigator !== 'undefined' ? (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection : undefined) || undefined;
    return { saveData: !!c?.saveData, slow: c?.effectiveType === '2g' || c?.effectiveType === 'slow-2g' };
  } catch {
    return { saveData: false, slow: false };
  }
};

// ── React binding ────────────────────────────────────────────────────────────

export interface CachedImage {
  src?: string;
  state: CacheState | 'waiting';
  w: number;
  h: number;
  palette?: Palette | null;
  expired?: boolean;
  /** A transient failure that will be retried on its own shortly. */
  retrying?: boolean;
}

/** Subscribe to the cache (re-renders when any entry changes; cheap — entries are few). */
export const useCacheVersion = (cache: PageImageCache = pageImageCache): number =>
  useSyncExternalStore(
    (fn) => cache.subscribe(fn),
    () => cache.snapshot(),
    () => 0
  );

/**
 * One cached page image: kicks off the load and returns the object URL once decoded. The page holds
 * its entry while mounted (never evicted under it), and a vanished entry is requested again.
 */
export function useCachedImage(path: string | undefined, url: string | undefined, prio: CachePriority, cache: PageImageCache = pageImageCache): CachedImage {
  useCacheVersion(cache);
  useEffect(() => (path ? cache.acquire(path) : undefined), [path, cache]);
  const e = path ? cache.get(path) : undefined;
  const missing = !!path && !e;
  useEffect(() => {
    if (path && url) void cache.ensure(path, url, prio);
  }, [path, url, prio, cache, missing]);
  // A transient failure: load again after its retry delay (bounded; an expired link waits for the host).
  const failedAt = e?.state === 'error' ? e.failedAt : undefined;
  const retrying = !!path && failedAt !== undefined && cache.retryIn(path) !== null;
  useEffect(() => {
    if (!path || !url || !retrying) return;
    const t = setTimeout(() => void cache.ensure(path, url, prio), cache.retryIn(path) ?? 0);
    return () => clearTimeout(t);
  }, [path, url, prio, cache, retrying, failedAt]);
  if (!e) return { state: 'waiting', w: 0, h: 0 };
  return { src: e.state === 'ready' ? e.objectUrl : undefined, state: e.state, w: e.w, h: e.h, palette: e.palette, expired: e.expired, retrying };
}
